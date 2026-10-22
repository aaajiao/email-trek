'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const root = process.env.EMAILTREK_CANDIDATE_ROOT || path.resolve(__dirname, '..')
const createBudget = require(path.join(root, 'lib/smtpBudget'))
const safety = require(path.join(root, 'lib/publicSafety'))
const temporary = [], tests = [], results = []
const test = (name, run) => tests.push({ name, run })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(5) } throw new Error('Fixture timeout') }
function budgetFixture(start = 1700000000000) {
  let time = start
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-budget-fixture-')); temporary.push(directory)
  const options = { directory, requireMount: false, now: () => time }
  if (process.env.REAL_FLOCK !== '1') options.lock = () => ({ status: 0 })
  return { directory, options, budget: createBudget(options), now: options.now, advance: ms => { time += ms },
    fresh: extra => createBudget({ ...options, ...extra }), state: () => JSON.parse(fs.readFileSync(path.join(directory, 'smtp-budget.json'), 'utf8')) }
}
function load(relative, mocks) {
  const filename = path.join(root, relative), realRequire = createRequire(filename), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : realRequire(name),
    Buffer, URL, process, console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    __filename: filename, __dirname: path.dirname(filename) }, { filename })
  return module.exports
}
function mailFixture(extra = {}) {
  const f = budgetFixture(), inserted = [], delivered = []
  let verification = { success: true }, smtpError = false, writeError = false, verifyCalls = 0
  const Mail = load('lib/mail.js', {
    '../config': { SMTP_CONF: {}, VERIFIER: {}, MAIL_STATUS: { VERIFIED: 'verified', NOT_EXISTS: 'not_exists', SENT: 'sent' }, MAILOPTIONS: extra.mailOptions || { subject: 'preserved-synthetic-subject' } },
    debug: () => () => {},
    nodemailer: { createTransport: () => ({ sendMail: async data => { delivered.push(data); if (smtpError) throw new Error('synthetic failure') } }) },
    './mail-content': 'synthetic body', './mail-address-generator': { gen: () => 'random@example.invalid' },
    './mailVerifier': { verify: async () => { verifyCalls++; if (verification instanceof Error) throw verification; return typeof verification === 'function' ? verification() : verification } }
  })
  const db = { insertOne: async row => { if (writeError) throw new Error('synthetic db failure'); inserted.push(row) } }
  const policy = { enabled: true, mode: 'test-once', runId: 'fixture-test-1', allowlist: ['owner@example.invalid'] }
  const options = { smtpBudget: f.budget, now: f.now, autoConfig: policy, ...extra }
  const mail = new Mail(db, options)
  return { ...f, mail, options, Mail, db, inserted, delivered, policy,
    setVerification: value => { verification = value }, setSmtpError: value => { smtpError = value },
    setWriteError: value => { writeError = value }, verifyCalls: () => verifyCalls,
    restart: config => new Mail(db, { ...options, smtpBudget: f.fresh(), autoConfig: config || options.autoConfig }) }
}

test('global five-minute boundary includes timestamp zero and survives restart', () => {
  const f = budgetFixture(0)
  assert(f.budget.reserve('manual').allowed)
  f.advance(299999); assert.strictEqual(f.fresh().reserve('automatic').allowed, false)
  f.advance(1); assert(f.fresh().reserve('automatic').allowed)
  assert.strictEqual(f.state().attempts.length, 2)
})
test('rolling 24-hour cap allows 100 attempts and denies 101 until expiry', () => {
  const f = budgetFixture()
  for (let i = 0; i < 100; i++) { assert(f.budget.reserve(i % 2 ? 'manual' : 'automatic').allowed); f.advance(300000) }
  assert.strictEqual(f.budget.reserve('manual').allowed, false)
  f.advance(86400000 - 100 * 300000); assert(f.budget.reserve('manual').allowed)
  assert.strictEqual(f.state().attempts.length, 100)
})
test('separate budget objects reload the locked file instead of using stale allowances', () => {
  const f = budgetFixture(), second = f.fresh()
  assert(f.budget.reserve('automatic').allowed)
  assert.strictEqual(second.reserve('manual').allowed, false)
})
test('pending SMTP is spent after restart; clock rollback does not reset spacing', () => {
  const f = budgetFixture(); f.budget.reserve('manual'); f.advance(-100000)
  assert.strictEqual(f.fresh().reserve('manual').allowed, false)
  assert.strictEqual(f.state().attempts[0].outcome, 'pending')
})
test('automatic pending/test markers survive restarts and expiry; only new explicit ID rearms', () => {
  const f = budgetFixture(); assert(f.budget.beginAutomatic('one-test', true).allowed)
  f.advance(2 * 86400000)
  assert(f.fresh().beginAutomatic('one-test', true).disabled)
  assert(f.fresh().beginAutomatic('one-test', false).disabled)
  assert(f.fresh().beginAutomatic('explicit-new-test', true).allowed)
  assert(f.fresh().beginAutomatic('explicit-new-test', true).disabled)
})
test('automatic registry stays bounded without evicting still-spent IDs', () => {
  const f = budgetFixture()
  for (let i = 0; i < 64; i++) assert(f.budget.beginAutomatic('fixture-' + i, true).allowed)
  assert.throws(() => f.budget.beginAutomatic('fixture-65', true), e => e.code === 'SMTP_BUDGET_UNAVAILABLE')
  assert.strictEqual(Object.keys(f.state().runs).length, 64)
})
test('missing or corrupt existing budget fails closed', () => {
  const a = budgetFixture(); a.budget.reserve('manual'); fs.unlinkSync(path.join(a.directory, 'smtp-budget.json'))
  assert.throws(() => a.fresh().reserve('manual'), e => e.code === 'SMTP_BUDGET_UNAVAILABLE')
  const b = budgetFixture(); b.budget.reserve('manual'); fs.writeFileSync(path.join(b.directory, 'smtp-budget.json'), '{broken')
  assert.throws(() => b.fresh().reserve('manual'), e => e.code === 'SMTP_BUDGET_UNAVAILABLE')
})
test('durability and lock failures refuse SMTP reservations', () => {
  const f = budgetFixture(); f.budget.reserve('manual'); f.advance(300000)
  const failing = Object.create(fs); failing.renameSync = () => { throw new Error('synthetic rename failure') }
  assert.throws(() => f.fresh({ fileSystem: failing }).reserve('manual'), e => e.code === 'SMTP_BUDGET_UNAVAILABLE')
  assert.throws(() => f.fresh({ lock: () => ({ status: 1 }) }).reserve('manual'), e => e.code === 'SMTP_BUDGET_UNAVAILABLE')
  assert.strictEqual(f.state().attempts.length, 1)
})
test('files remain private and store neither email addresses nor literal run IDs', () => {
  const f = budgetFixture(); f.budget.beginAutomatic('private-fixture-id', true); f.budget.reserve('automatic')
  const body = fs.readFileSync(path.join(f.directory, 'smtp-budget.json'), 'utf8')
  assert(!body.includes('@')); assert(!body.includes('private-fixture-id'))
  for (const name of ['smtp-budget.json', 'smtp-budget.initialized', 'smtp-budget.lock']) assert.strictEqual(fs.statSync(path.join(f.directory, name)).mode & 0o077, 0)
})
test('disabled and invalid allowlists retain exploration with zero automatic SMTP', async () => {
  for (const config of [{ enabled: false }, { enabled: true, mode: 'test-once', runId: 'x', allowlist: [] }, { enabled: true, mode: 'test-once', runId: 'x', allowlist: ['a@example.invalid,b@example.invalid'] }]) {
    const f = mailFixture({ autoConfig: config }); assert.strictEqual(await f.mail.tryAutomatic(() => true), null)
    await f.mail.checkMail(); assert.strictEqual(f.inserted.length, 1); assert.strictEqual(f.delivered.length, 0)
  }
})
test('automatic delivery uses only actual allowlisted recipient once and homepage masks it', async () => {
  const f = mailFixture(), result = await f.mail.tryAutomatic(() => true)
  assert(result.success && result.recorded); assert.strictEqual(f.delivered.length, 1); assert.strictEqual(f.inserted.length, 1)
  assert.strictEqual(f.delivered[0].to, 'owner@example.invalid'); assert.strictEqual(f.inserted[0].to, 'owner@example.invalid')
  assert.strictEqual(f.delivered[0].subject, 'preserved-synthetic-subject'); assert.strictEqual(f.inserted[0].status, 'sent')
  assert(!safety.publicResult(result).mailAddr.includes('@'))
  f.advance(2 * 86400000); await f.restart().tryAutomatic(() => true); assert.strictEqual(f.delivered.length, 1)
  await assert.rejects(f.mail.sendMail('stranger@example.invalid', { automatic: true, shouldSend: () => true }))
})
test('automatic and MailYou share one delivery slot under concurrent verification', async () => {
  const f = mailFixture()
  const result = await Promise.all([f.mail.tryAutomatic(() => true), f.mail.sendMail('manual@example.invalid')])
  assert.strictEqual(f.delivered.length, 1); assert.strictEqual(f.inserted.length, 1)
  assert(result.some(r => r && r.rateLimited)); assert.strictEqual(f.state().attempts.length, 1)
})
test('SMTP error remains uncertain, counts only verified once and never retries test', async () => {
  const f = mailFixture(); f.setSmtpError(true)
  const result = await f.mail.tryAutomatic(() => true)
  assert.strictEqual(result.success, false); assert.strictEqual(f.inserted.length, 1); assert.strictEqual(f.inserted[0].status, 'verified')
  assert.strictEqual(f.state().attempts[0].outcome, 'uncertain')
  assert.strictEqual(result.deliveryUnconfirmed, true); assert.strictEqual(result.error, 'SMTP delivery could not be confirmed.')
  assert.strictEqual(Object.values(f.state().runs)[0].outcome, 'record-unconfirmed')
  f.advance(300000); await f.restart().tryAutomatic(() => true); assert.strictEqual(f.delivered.length, 1)
})
test('real MIME composer envelope has exactly the allowlisted recipient despite inherited options', async () => {
  const f = mailFixture({ mailOptions: { from: 'Artwork <sender@example.invalid>', subject: 'unchanged subject',
    cc: 'cc@example.invalid', bcc: 'bcc@example.invalid', envelope: { from: 'wrong@example.invalid', to: ['outside@example.invalid'] },
    headers: { Bcc: 'header@example.invalid' } } })
  await f.mail.tryAutomatic(() => true)
  const data = f.delivered[0]
  assert.strictEqual(data.cc, undefined); assert.strictEqual(data.bcc, undefined)
  const MailComposer = require('nodemailer/lib/mail-composer')
  const envelope = new MailComposer(data).compile().getEnvelope()
  assert.deepStrictEqual(envelope.to, ['owner@example.invalid'])
  assert.strictEqual(envelope.from, 'sender@example.invalid'); assert.strictEqual(data.subject, 'unchanged subject')
})
test('RCPT rejection and unknown verification consume test but never claim delivery', async () => {
  for (const value of [{ success: false }, new Error('synthetic verification timeout')]) {
    const f = mailFixture(); f.setVerification(value); await f.mail.tryAutomatic(() => true)
    assert.strictEqual(f.delivered.length, 0); assert.strictEqual(f.state().attempts.length, 0)
    assert.strictEqual(f.inserted.length, value instanceof Error ? 0 : 1)
    if (f.inserted.length) assert.strictEqual(f.inserted[0].status, 'not_exists')
    f.advance(86400000); await f.restart().tryAutomatic(() => true); assert.strictEqual(f.verifyCalls(), 1)
  }
})
test('visitor cancellation after verification prevents a new SMTP call', async () => {
  const f = mailFixture(); let visiting = true, resolve
  f.setVerification(() => new Promise(r => { resolve = r }))
  const promise = f.mail.tryAutomatic(() => visiting); await waitFor(() => !!resolve)
  visiting = false; resolve({ success: true }); const result = await promise
  assert(result.cancelled); assert.strictEqual(f.delivered.length, 0); assert.strictEqual(f.inserted[0].status, 'verified')
})
test('continuous allowlist mode pauses on failure across restart, not automatic retransmit', async () => {
  const f = mailFixture({ autoConfig: { enabled: true, mode: 'allowlist', runId: 'explicit-run', allowlist: ['owner@example.invalid'] } })
  f.setSmtpError(true); await f.mail.tryAutomatic(() => true); f.advance(86400000)
  await f.restart().tryAutomatic(() => true); assert.strictEqual(f.delivered.length, 1)
})
test('DB result failure does not retransmit after a known SMTP acceptance', async () => {
  const f = mailFixture(); f.setWriteError(true)
  const result = await f.mail.tryAutomatic(() => true)
  assert(!result.recorded); assert.strictEqual(f.delivered.length, 1); assert.strictEqual(f.state().attempts[0].outcome, 'sent')
  f.advance(300000); await f.restart().tryAutomatic(() => true); assert.strictEqual(f.delivered.length, 1)
})
test('budget persist failure yields zero new SMTP calls after verification', async () => {
  const f = mailFixture(); f.budget.reserve('manual'); f.advance(300000)
  const failing = Object.create(fs); failing.fsyncSync = () => { throw new Error('synthetic fsync failure') }
  const mail = new f.Mail(f.db, { ...f.options, smtpBudget: f.fresh({ fileSystem: failing }) })
  await assert.rejects(mail.sendMail('manual@example.invalid')); assert.strictEqual(f.delivered.length, 0)
})
test('MailYou global pacing returns 429/Retry-After while keeping per-IP reservation', async () => {
  const routes = {}; let reserved = 0, released = 0
  load('lib/setExpressRouter.js', {})({ post: (route, fn) => { routes[route] = fn }, get: () => {} }, {},
    { sendMail: async () => ({ success: false, rateLimited: true, retryAfter: 299 }) },
    { quota: { reserve: () => { reserved++; return { allowed: true, release: () => { released++ } } } } })
  const response = { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this }, status(code) { this.code = code; return this }, send(body) { this.body = body } }
  await routes['/mail-you-send']({ body: { data: 'manual@example.invalid' }, socket: { remoteAddress: '203.0.113.19' }, headers: {} }, response)
  assert.strictEqual(response.code, 429); assert.strictEqual(response.headers['Retry-After'], '299')
  assert.strictEqual(response.body.success, false); assert.strictEqual(reserved, 1); assert.strictEqual(released, 1)
})
test('no visitors consume nothing; successful allowlist mode remains paced without catch-up', async () => {
  const f = mailFixture({ autoConfig: { enabled: true, mode: 'allowlist', runId: 'visitor-run', allowlist: ['owner@example.invalid'] } })
  assert.strictEqual(await f.mail.tryAutomatic(() => false), null)
  assert.strictEqual(fs.existsSync(path.join(f.directory, 'smtp-budget.json')), false)
  await f.mail.tryAutomatic(() => true); f.advance(299999); await f.mail.tryAutomatic(() => true)
  assert.strictEqual(f.delivered.length, 1)
  f.advance(86400000); await f.mail.tryAutomatic(() => false); assert.strictEqual(f.delivered.length, 1)
  await f.mail.tryAutomatic(() => true); assert.strictEqual(f.delivered.length, 2)
})
test('many visitors and disconnect/reconnect cannot revive old automatic generation', async () => {
  const f = mailFixture(); let resolve, checks = 0
  f.setVerification(() => new Promise(r => { if (!resolve) resolve = r }))
  const originalCheck = f.mail.checkMail.bind(f.mail)
  f.mail.checkMail = (address, persist) => address ? originalCheck(address, persist) : (checks++, new Promise(() => {}))
  let connect; const output = []
  const io = { on: (_, fn) => { connect = fn }, emit: (e, value) => output.push({ e, value }) }
  const db = { genAscii: async () => [], getTotal: async () => ({ not_exists: 0, verified: 0, sent: 0 }) }
  const controller = require(path.join(root, 'lib/setIOEvents'))(io, db, f.mail)
  const client = (id, ip) => { const events = {}; const c = { id, connected: true, request: { socket: { remoteAddress: ip }, headers: {} },
    on: (e, fn) => { events[e] = fn }, emit: () => {}, disconnect: () => { c.connected = false; if (events.disconnect) events.disconnect() } }; return c }
  const a = client('a', '203.0.113.10'), b = client('b', '203.0.113.11')
  connect(a); connect(b); await waitFor(() => !!resolve)
  assert.strictEqual(f.verifyCalls(), 1); a.disconnect(); b.disconnect()
  const c = client('c', '203.0.113.12'); connect(c); resolve({ success: true })
  await waitFor(() => checks === 1); assert.strictEqual(f.delivered.length, 0)
  assert(!output.some(x => x.e === 'append' && x.value.status === 'sent'))
  c.disconnect(); controller.close()
})

async function main() {
  try {
    for (const entry of tests) { await entry.run(); results.push({ name: entry.name, passed: true }) }
    console.log(JSON.stringify({ passed: true, tests: results, actualSmtpCalls: 0, actualDatabaseCalls: 0,
      kernelLockExercised: process.env.REAL_FLOCK === '1', runtime: process.version }, null, 2))
  } catch (error) {
    results.push({ name: tests[results.length].name, passed: false, error: error.code || error.message })
    console.log(JSON.stringify({ passed: false, tests: results }, null, 2)); process.exitCode = 1
  } finally { for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true }) }
}
main()
