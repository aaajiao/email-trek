'use strict'

// No network: exercise the pinned driver's parser/command builder and the
// application's state machine against synthetic records and injected failures.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const { MongoClient, ObjectId, WriteConcern } = require('mongodb')
const driverRoot = path.dirname(require.resolve('mongodb/package.json'))
const { FindOneAndUpdateOperation } = require(path.join(driverRoot, 'lib/operations/find_and_modify'))
const bounded = require('../lib/boundedStore')
const fake = require('./fake-mongo')
const tests = []
const test = (name, fn) => tests.push({ name, fn })
const item = (index, status = 'verified') => ({
  _id: new ObjectId(index.toString(16).padStart(24, '0')),
  created_at: new Date(1700000000000 + index), to: `fixture${index}@example.test`, status,
})
function database(recent = [], overrides = {}) {
  const db = fake.create({
    mail_recent_v1: recent,
    mail_totals_v1: [{ _id: 'totals', version: 1, mode: 'active', counts: bounded.empty(), newCounts: bounded.empty(), ...overrides }],
  })
  db.options.set(bounded.NAMES.recent, { capped: true, max: bounded.MAX, size: bounded.SIZE })
  return db
}
function loadMongo(db, debug) {
  let client, options
  const logs = []
  class FixtureClient extends MongoClient {
    constructor(uri, opts) { super(uri, opts); client = this; options = opts }
    async connect() { return this }
    db() { return db }
  }
  const filename = path.join(__dirname, '../lib/mongo.js'), module = { exports: {} }
  const realRequire = createRequire(filename)
  const mocks = {
    '../config': { MONGO_ADDR: 'mongodb://127.0.0.1:1', MONGO_DB: 'unused', STR_WIDTH: 70, STR_HEIGHT: 17, DEBUG: debug },
    mongodb: { MongoClient: FixtureClient },
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: name => mocks[name] || realRequire(name),
    console: { log: (...args) => logs.push(args.join(' ')), error: () => {} },
    process: { exit: () => { throw new Error('Unexpected fixture startup failure') } },
  }, { filename })
  return { start: module.exports, client, options, logs }
}

test('driver 7.7 connection options parse without connecting and retain pool size five', async () => {
  assert.strictEqual(require('mongodb/package.json').version, '7.7.0')
  for (const debug of [false, true]) {
    const fixture = loadMongo(database(), debug)
    await fixture.start()
    assert.strictEqual(fixture.client.options.maxPoolSize, 5)
    assert.strictEqual(fixture.options.monitorCommands, debug)
    assert(!Object.hasOwn(fixture.options, 'useNewUrlParser'))
    assert(!Object.hasOwn(fixture.options, 'useUnifiedTopology'))
    await fixture.client.close()
  }
})

test('debug command monitoring logs names without document contents or addresses', async () => {
  const fixture = loadMongo(database(), true)
  await fixture.start()
  fixture.client.emit('commandStarted', { commandName: 'find', command: { filter: { to: 'private@example.test' } } })
  assert.deepStrictEqual(fixture.logs, ['MONGO DB REQUEST 1: find'])
  await fixture.client.close()
})

test('all durable state-machine writes keep journal acknowledgement in driver 7 options', async () => {
  const db = database(), store = await bounded.create(db)
  await store.insertOne(item(1))
  assert.strictEqual(db.calls.length, 3)
  for (const call of db.calls) {
    const concern = WriteConcern.fromOptions(call.options)
    assert(concern, call.method + ' lost its explicit write concern')
    assert.deepStrictEqual(WriteConcern.apply({}, concern), { writeConcern: { w: 1, j: true } })
  }
  // Regression proof: the old top-level options silently lose this setting.
  assert.strictEqual(WriteConcern.fromOptions({ w: 1, j: true }), undefined)
})

test('real driver builds one atomic counters/pending command and returns document or null', async () => {
  const db = database(), store = await bounded.create(db)
  await store.insertOne(item(2, 'sent'))
  const call = db.calls.find(entry => entry.method === 'findOneAndUpdate')
  const client = new MongoClient('mongodb://127.0.0.1:1', { maxPoolSize: 1 })
  try {
    const operation = new FindOneAndUpdateOperation(client.db('fixture').collection(bounded.NAMES.stats), call.query, call.update, call.options)
    const command = operation.buildCommand({}, undefined)
    assert.deepStrictEqual(command.writeConcern, { w: 1, j: true })
    assert.strictEqual(command.new, true)
    assert.strictEqual(command.upsert, false)
    assert.deepStrictEqual(command.query.pending, { $exists: false })
    assert.deepStrictEqual(command.update.$inc, { 'counts.sent': 1, 'newCounts.sent': 1 })
    assert.strictEqual(String(command.update.$set.pending._id), String(item(2)._id))
    assert.deepStrictEqual(command.fields, { _id: 1 })
    assert.strictEqual(call.options.includeResultMetadata, false)
    assert.deepStrictEqual(operation.handleOk({ toObject: () => ({ ok: 1, value: { _id: 'totals' } }) }), { _id: 'totals' })
    assert.strictEqual(operation.handleOk({ toObject: () => ({ ok: 1, value: null }) }), null)
  } finally { await client.close() }
})

test('no matching atomic commit rejects without a false success or detail insert', async () => {
  const db = database(), original = db.collection.bind(db)
  db.collection = name => {
    const collection = original(name)
    if (name === bounded.NAMES.stats) collection.findOneAndUpdate = async () => null
    return collection
  }
  const store = await bounded.create(db)
  let notifications = 0
  store.onStats(() => { notifications++ })
  await assert.rejects(store.insertOne(item(3)), /Another database writer is active/)
  assert.deepStrictEqual(await store.getTotal(), bounded.empty())
  assert.strictEqual((await store.getLimit()).length, 0)
  assert.strictEqual(notifications, 0)
})

test('pending replay at the cap neither evicts an old row nor increments totals twice', async () => {
  const first = item(10), pending = item(11)
  const db = database([first, pending], { counts: { not_exists: 0, verified: 2, sent: 0 }, newCounts: { not_exists: 0, verified: 2, sent: 0 }, pending })
  db.capOverride = 2
  const before = db.rows.get(bounded.NAMES.recent).map(row => String(row._id))
  for (let n = 0; n < 3; n++) {
    const store = await bounded.create(db)
    assert.strictEqual((await store.getTotal()).verified, 2)
    assert.deepStrictEqual(db.rows.get(bounded.NAMES.recent).map(row => String(row._id)), before)
  }
  assert(!db.rows.get(bounded.NAMES.stats)[0].pending)
})

test('pending identity conflict fails closed without replacing a stored address', async () => {
  const pending = item(12), different = { ...pending, to: 'different@example.test' }
  const db = database([different], { counts: { not_exists: 0, verified: 1, sent: 0 }, pending })
  await assert.rejects(bounded.create(db), /Pending record identity conflict/)
  assert.strictEqual(db.rows.get(bounded.NAMES.recent)[0].to, different.to)
  assert(db.rows.get(bounded.NAMES.stats)[0].pending)
})

test('100 concurrent calls on the one writer retain exact counts and newest-first pagination', async () => {
  const db = database(), store = await bounded.create(db), notified = []
  db.capOverride = 7
  store.onStats(value => notified.push(value.verified))
  await Promise.all(Array.from({ length: 100 }, (_, n) => store.insertOne(item(n + 100))))
  assert.strictEqual((await store.getTotal()).verified, 100)
  assert.deepStrictEqual(notified, Array.from({ length: 100 }, (_, n) => n + 1))
  assert.strictEqual(db.rows.get(bounded.NAMES.stats)[0].newCounts.verified, 100)
  assert.strictEqual(db.rows.get(bounded.NAMES.recent).length, 7)
  assert.deepStrictEqual((await store.getLimit(3, 2)).map(row => String(row._id)), [197, 196, 195].map(n => String(item(n)._id)))
  assert(!db.rows.get(bounded.NAMES.stats)[0].pending)
})

test('incorrect collection bounds or inactive cumulative state refuse startup', async () => {
  for (const change of [{ capped: false }, { max: 99999 }, { size: bounded.SIZE - 1 }]) {
    const db = database()
    Object.assign(db.options.get(bounded.NAMES.recent), change)
    await assert.rejects(bounded.create(db), /not prepared/)
  }
  await assert.rejects(bounded.create(database([], { mode: 'preparing' })), /not active/)
})

test('modern BSON IDs and database wrapper preserve masked ASCII dimensions', async () => {
  const fixture = loadMongo(database([item(21), { ...item(22), to: 'x'.repeat(254) }]), false)
  const store = await fixture.start(), ascii = await store.genAscii()
  assert(ascii.length > 0 && ascii.length <= 16)
  assert(ascii.every(line => line.length === 69 && !line.includes('@') && /^[░▓█]+$/.test(line)))
  const page = await store.getLimit(1)
  assert.strictEqual(page[0].to, 'x'.repeat(254)) // SVG still receives the full address.
  assert(page[0]._id instanceof ObjectId)
  await fixture.client.close()
})

;(async () => {
  const results = []
  for (const entry of tests) {
    try { await entry.fn(); results.push({ name: entry.name, passed: true }) }
    catch (error) { results.push({ name: entry.name, passed: false, error: error.message }); break }
  }
  const passed = results.length === tests.length && results.every(row => row.passed)
  console.log(JSON.stringify({ passed, driver: require('mongodb/package.json').version, node: process.version,
    databaseConnections: 0, smtpCalls: 0, results }, null, 2))
  if (!passed) process.exitCode = 1
})().catch(() => { console.error('MongoDB offline fixture failed'); process.exitCode = 1 })
