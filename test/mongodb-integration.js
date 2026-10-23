'use strict'

// Explicit opt-in, loopback-only fixture. It never loads app.js, private config,
// SMTP, Socket.IO, or production collections. Only its generated database is
// created/dropped. Run separately for each supported server version.
const assert = require('assert')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { MongoClient, ObjectId } = require('mongodb')
const bounded = require('../lib/boundedStore')
const exec = promisify(execFile)
const uri = process.env.EMAILTREK_TEST_MONGO_URI || ''
const safeUri = /^mongodb:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(uri)
if (!safeUri || Number(safeUri[1]) > 65535 || process.env.EMAILTREK_TEST_MONGO_ALLOW_WRITES !== 'fixture-only') {
  console.error('Set a loopback-only EMAILTREK_TEST_MONGO_URI and EMAILTREK_TEST_MONGO_ALLOW_WRITES=fixture-only; no connection made')
  process.exit(1)
}
const child = process.argv.includes('--recover-only')
const databaseName = child ? process.env.EMAILTREK_TEST_MONGO_CHILD_DB : 'emailtrek_driver_fixture_' + crypto.randomBytes(10).toString('hex')
if (!/^emailtrek_driver_fixture_[a-f0-9]{20}$/.test(databaseName || '')) throw new Error('Invalid fixture database name')
const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000, socketTimeoutMS: 60000, monitorCommands: true })
const results = [], wire = []
let checkWrites = false, db, version, databaseCreated = false
client.on('commandStarted', event => {
  if (checkWrites && event.databaseName === databaseName && ['insert', 'update', 'findAndModify'].includes(event.commandName)) {
    wire.push({ name: event.commandName, writeConcern: event.command.writeConcern })
  }
})
const item = (n, status = 'verified') => ({ _id: new ObjectId(n.toString(16).padStart(24, '0')),
  created_at: new Date(1700000000000 + n), to: `fixture${n}@example.test`, status })
const count = () => db.collection(bounded.NAMES.recent).countDocuments({})
const totals = () => db.collection(bounded.NAMES.stats).findOne({ _id: 'totals' })
async function prepare(base = bounded.empty(), records = []) {
  checkWrites = false
  await db.dropDatabase()
  await db.createCollection(bounded.NAMES.recent, { capped: true, max: bounded.MAX, size: bounded.SIZE })
  await db.collection(bounded.NAMES.stats).insertOne({ _id: 'totals', version: 1, mode: 'active',
    counts: { ...base }, newCounts: bounded.empty() }, bounded.WRITE)
  if (records.length) await db.collection(bounded.NAMES.recent).insertMany(records, bounded.WRITE)
  checkWrites = true
}
function failures(point, after) {
  let armed = false
  const wrapped = {
    listCollections: (...args) => db.listCollections(...args),
    collection(name) {
      const collection = db.collection(name)
      return new Proxy(collection, {
        get(target, property) {
          const value = target[property]
          if (typeof value !== 'function') return value
          if (!['updateOne', 'findOneAndUpdate'].includes(property)) return value.bind(target)
          return async (...args) => {
            const label = name + (property === 'findOneAndUpdate' ? '.commit' : '.update')
            if (armed && label === point && !after) { armed = false; throw new Error('fixture interruption') }
            const result = await value.apply(target, args)
            if (armed && label === point && after) { armed = false; throw new Error('fixture interruption') }
            return result
          }
        },
      })
    },
  }
  return { db: wrapped, arm: () => { armed = true } }
}
async function naturalHash() {
  const hash = crypto.createHash('sha256')
  const cursor = db.collection(bounded.NAMES.recent).find({}).sort({ $natural: 1 }).batchSize(2000)
  for await (const row of cursor) hash.update(JSON.stringify([String(row._id), row.created_at.toISOString(), row.to, row.status]) + '\n')
  return hash.digest('hex')
}
async function test(name, fn) {
  const started = Date.now()
  await fn()
  results.push({ name, passed: true, durationMs: Date.now() - started })
}
async function main() {
  await client.connect()
  db = client.db(databaseName)
  if (child) {
    const store = await bounded.create(db)
    console.log(JSON.stringify({ counts: await store.getTotal(), recentCount: await count(), pending: Boolean((await totals()).pending) }))
    return
  }
  const existing = await client.db('admin').command({ listDatabases: 1, nameOnly: true, filter: { name: databaseName } })
  assert.strictEqual(existing.databases.length, 0, 'Generated fixture database already exists; preserve it')
  await db.createCollection('__fixture_owner')
  databaseCreated = true
  version = (await db.admin().command({ buildInfo: 1 })).version
  if (process.env.EMAILTREK_TEST_MONGO_VERSION) assert.strictEqual(version, process.env.EMAILTREK_TEST_MONGO_VERSION)

  await test('existing historical counters survive a new full-address detail and exact journalled commit', async () => {
    const base = { not_exists: 90000000, verified: 9249394, sent: 2 }
    await prepare(base)
    const store = await bounded.create(db), event = { ...item(1, 'sent'), to: 'name&tag@example.test' }
    const result = await store.insertOne(event)
    assert.strictEqual(String(result.insertedId), String(event._id))
    assert.deepStrictEqual(await store.getTotal(), { ...base, sent: 3 })
    assert.deepStrictEqual((await totals()).newCounts, { not_exists: 0, verified: 0, sent: 1 })
    assert.strictEqual((await store.getLimit(1))[0].to, event.to)
    assert(!(await totals()).pending)
  })

  await test('one application writer serializes 100 concurrent inserts with authoritative statistics', async () => {
    await prepare()
    const store = await bounded.create(db), updates = []
    store.onStats(value => updates.push(Object.values(value).reduce((a, b) => a + b, 0)))
    const records = Array.from({ length: 100 }, (_, n) => item(n + 1, bounded.KEYS[n % 3]))
    await Promise.all(records.map(row => store.insertOne(row)))
    assert.deepStrictEqual(await store.getTotal(), { not_exists: 34, verified: 33, sent: 33 })
    assert.deepStrictEqual((await totals()).newCounts, { not_exists: 34, verified: 33, sent: 33 })
    assert.deepStrictEqual(updates, Array.from({ length: 100 }, (_, n) => n + 1))
    assert.strictEqual(await count(), 100)
    assert.deepStrictEqual((await store.getLimit(3, 2)).map(row => String(row._id)), [98, 97, 96].map(n => String(item(n)._id)))
  })

  for (const [point, after] of [
    ['mail_totals_v1.commit', false], ['mail_totals_v1.commit', true],
    ['mail_recent_v1.update', false], ['mail_recent_v1.update', true],
    ['mail_totals_v1.update', false], ['mail_totals_v1.update', true],
  ]) {
    await test(`durable recovery ${after ? 'after' : 'before'} ${point}`, async () => {
      await prepare()
      const failing = failures(point, after), store = await bounded.create(failing.db)
      failing.arm()
      await assert.rejects(store.insertOne(item(1)), /fixture interruption/)
      const expected = point === 'mail_totals_v1.commit' && !after ? 0 : 1
      for (let n = 0; n < 2; n++) {
        const recovered = await bounded.create(db)
        assert.strictEqual((await recovered.getTotal()).verified, expected)
        assert.strictEqual((await totals()).newCounts.verified, expected)
        assert.strictEqual(await count(), expected)
        assert(!(await totals()).pending)
      }
    })
  }

  await test('committed pending event recovers once in a separate Node process', async () => {
    await prepare()
    const failing = failures('mail_totals_v1.commit', true), store = await bounded.create(failing.db)
    failing.arm()
    await assert.rejects(store.insertOne(item(1)), /fixture interruption/)
    assert((await totals()).pending)
    assert.strictEqual(await count(), 0)
    const response = await exec(process.execPath, [__filename, '--recover-only'], { env: { ...process.env,
      EMAILTREK_TEST_MONGO_CHILD_DB: databaseName }, timeout: 30000, maxBuffer: 16384 })
    const result = JSON.parse(response.stdout)
    assert.deepStrictEqual(result, { counts: { not_exists: 0, verified: 1, sent: 0 }, recentCount: 1, pending: false })
    assert.strictEqual((await totals()).newCounts.verified, 1)
  })

  await test('unmatched atomic commit returns null and cannot falsely acknowledge a write', async () => {
    await prepare()
    const rival = item(900), stats = db.collection(bounded.NAMES.stats)
    const wrapped = { listCollections: (...args) => db.listCollections(...args), collection(name) {
      const collection = db.collection(name)
      if (name !== bounded.NAMES.stats) return collection
      return new Proxy(collection, { get(target, property) {
        if (property === 'findOneAndUpdate') return async (...args) => {
          await stats.updateOne({ _id: 'totals' }, { $set: { pending: rival } }, bounded.WRITE)
          return target.findOneAndUpdate(...args)
        }
        return typeof target[property] === 'function' ? target[property].bind(target) : target[property]
      } })
    } }
    const store = await bounded.create(wrapped)
    await assert.rejects(store.insertOne(item(1)), /Another database writer is active/)
    assert.deepStrictEqual((await totals()).counts, bounded.empty())
    assert.strictEqual(await count(), 0)
    assert.strictEqual(String((await totals()).pending._id), String(rival._id))
  })

  await test('100000 cap, natural order, idempotent replay and last SVG page survive eviction', async () => {
    await prepare({ not_exists: 0, verified: 100000, sent: 0 })
    checkWrites = false
    for (let start = 1; start <= bounded.MAX; start += 2000) {
      await db.collection(bounded.NAMES.recent).insertMany(Array.from({ length: 2000 }, (_, n) => item(start + n)), bounded.WRITE)
    }
    checkWrites = true
    assert.strictEqual(await count(), bounded.MAX)
    const info = await db.listCollections({ name: bounded.NAMES.recent }).next()
    assert.strictEqual(info.options.capped, true)
    assert.strictEqual(info.options.max, bounded.MAX)
    assert.strictEqual(info.options.size, bounded.SIZE)
    const hash = await naturalHash()
    await db.collection(bounded.NAMES.stats).updateOne({ _id: 'totals' }, { $set: { pending: item(100000) } }, bounded.WRITE)
    let store = await bounded.create(db)
    assert.strictEqual(await naturalHash(), hash)
    assert.strictEqual((await store.getTotal()).verified, 100000)
    await store.insertOne(item(100001))
    assert.strictEqual(await count(), 100000)
    assert.strictEqual((await store.getTotal()).verified, 100001)
    assert.strictEqual((await totals()).newCounts.verified, 1)
    const first = await db.collection(bounded.NAMES.recent).find({}).sort({ $natural: 1 }).limit(1).next()
    const last = await db.collection(bounded.NAMES.recent).find({}).sort({ $natural: -1 }).limit(1).next()
    assert.strictEqual(String(first._id), String(item(2)._id))
    assert.strictEqual(String(last._id), String(item(100001)._id))
    const lastPage = await store.getLimit(2000, 98000)
    assert.strictEqual(lastPage.length, 2000)
    assert.strictEqual(lastPage[0].to, item(2001).to)
    assert.strictEqual(lastPage[1999].to, item(2).to)
    const after = await naturalHash()
    await db.collection(bounded.NAMES.stats).updateOne({ _id: 'totals' }, { $set: { pending: item(100001) } }, bounded.WRITE)
    store = await bounded.create(db)
    assert.strictEqual(await naturalHash(), after)
    assert.strictEqual((await store.getTotal()).verified, 100001)
    assert(!(await totals()).pending)
  })

  await test('all observed application commits, detail upserts and pending clears use w1+journal', async () => {
    assert(wire.length >= 300)
    assert(wire.some(entry => entry.name === 'findAndModify'))
    assert(wire.some(entry => entry.name === 'update'))
    for (const command of wire) assert.deepStrictEqual(command.writeConcern, { w: 1, j: true })
  })
}

;(async () => {
  let passed = false, failure, removed = false
  try { await main(); passed = true }
  catch (error) { failure = { name: error.name, code: error.code || null, message: error instanceof assert.AssertionError ? error.message : 'Fixture operation failed; inspect the isolated test locally' } }
  finally {
    if (!child && db && databaseCreated) {
      try { await db.dropDatabase(); removed = true }
      catch (_) { passed = false; failure = { name: 'CleanupError', message: 'Generated fixture database cleanup failed' } }
    }
    await client.close()
  }
  if (!child) console.log(JSON.stringify({ passed, node: process.version, driver: require('mongodb/package.json').version,
    server: version, fixtureDatabaseCreated: databaseCreated, fixtureDatabaseRemoved: removed, smtpCalls: 0, productionConnections: 0,
    observedJournalledWriteCommands: wire.length, results, failure }, null, 2))
  if (!passed) process.exitCode = 1
})()
