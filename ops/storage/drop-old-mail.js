'use strict'

// Deliberately restricted one-time retirement of emailtrek.mail. The reviewed
// archive contains samples/statistics, not a full restorable detail backup.
// Default invocation prints a plan only and never loads config or connects.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const EXPECTED = Object.freeze(require('./drop-old-mail-expected.json'))
const KEYS = ['not_exists', 'verified', 'sent']
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fail = code => { const error = new Error(code); error.safeCode = code; throw error }
const ensure = (ok, code) => { if (!ok) fail(code) }
const equalCounts = (a, b) => KEYS.every(k => a && b && a[k] === b[k])
const sum = a => KEYS.reduce((n, k) => n + a[k], 0)

function counts(value) {
  ensure(value && KEYS.every(k => Number.isSafeInteger(value[k]) && value[k] >= 0), 'INVALID_COUNTERS')
  ensure(Number.isSafeInteger(sum(value)), 'COUNTERS_OVERFLOW')
}
function uuid(info) {
  ensure(info && info.info && info.info.uuid && Buffer.isBuffer(info.info.uuid.buffer), 'COLLECTION_UUID_UNAVAILABLE')
  return digest(info.info.uuid.buffer)
}
async function info(db, name) {
  const rows = await db.listCollections({ name }, { nameOnly: false }).toArray()
  ensure(rows.length === 1, 'REQUIRED_COLLECTION_MISSING')
  return rows[0]
}
async function lastId(collection) {
  const row = await collection.find({}, { projection: { _id: 1 } })
    .sort({ _id: -1 }).limit(1).maxTimeMS(10000).next()
  ensure(row && /^[a-f0-9]{24}$/.test(String(row._id)), 'INVALID_LAST_ID')
  return String(row._id)
}
async function sourceHeader(db, expected) {
  const meta = await info(db, expected.collection)
  const statistics = await db.command({ collStats: expected.collection, maxTimeMS: 10000 })
  const last = await lastId(db.collection(expected.collection))
  ensure(statistics.count === expected.legacyCount, 'OLD_COUNT_CHANGED')
  ensure(last === expected.lastId, 'OLD_LAST_ID_CHANGED')
  return { uuid: uuid(meta), count: statistics.count, lastId: last }
}
async function activeState(db, expected) {
  const projection = { version: 1, mode: 1, cutoff: 1, baseCounts: 1, baselineCount: 1,
    baselineSummarySha256: 1, baselineUnknownStatusCount: 1, legacyUnknownStatusCount: 1,
    legacyCounts: 1, legacyCount: 1, counts: 1, newCounts: 1, sourceLastId: 1,
    tailCounts: 1, tailRecordCount: 1, migrationWindow: 1, 'pending._id': 1 }
  let state
  for (let attempt = 0; attempt < 8; attempt++) {
    state = await db.collection(expected.stats).findOne({ _id: 'totals' }, { projection })
    if (state && !state.pending) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  ensure(state && state.version === 1 && state.mode === 'active' && !state.pending, 'NEW_STORE_NOT_STABLE_ACTIVE')
  ensure(String(state.cutoff) === expected.cutoff && state.baselineSummarySha256 === expected.summaryHash, 'BASELINE_IDENTITY_CHANGED')
  ensure(state.baselineCount === expected.legacyCount && state.legacyCount === expected.legacyCount, 'BASELINE_COUNT_CHANGED')
  ensure(equalCounts(state.baseCounts, expected.legacyCounts) && equalCounts(state.legacyCounts, expected.legacyCounts), 'LEGACY_COUNTERS_CHANGED')
  ensure(state.baselineUnknownStatusCount === 0 && state.legacyUnknownStatusCount === 0, 'LEGACY_ANOMALIES_PRESENT')
  ensure(state.tailRecordCount === 0 && equalCounts(state.tailCounts, { not_exists: 0, verified: 0, sent: 0 }), 'TAIL_CHANGED')
  ensure(state.sourceLastId === expected.lastId, 'MIGRATION_LAST_ID_CHANGED')
  ensure(state.migrationWindow && state.migrationWindow.count === expected.windowCount && state.migrationWindow.sha256 === expected.windowHash, 'MIGRATION_WINDOW_CHANGED')
  counts(state.counts); counts(state.newCounts)
  ensure(KEYS.every(k => state.counts[k] === expected.legacyCounts[k] + state.newCounts[k]), 'CUMULATIVE_SUM_MISMATCH')
  ensure(sum(state.newCounts) > 0, 'NEW_WRITER_NOT_YET_PROVEN')
  const recent = await info(db, expected.recent)
  const stats = await info(db, expected.stats)
  ensure(recent.options && recent.options.capped === true && recent.options.max === expected.windowCount && recent.options.size === expected.windowBytes, 'RECENT_OPTIONS_CHANGED')
  const recentMeta = await db.command({ collStats: expected.recent, maxTimeMS: 10000 })
  ensure(recentMeta.count === expected.windowCount, 'RECENT_COUNT_UNEXPECTED')
  ensure(await lastId(db.collection(expected.recent)) > expected.lastId, 'RECENT_NEW_RECORD_MISSING')
  return { recentUuid: uuid(recent), statsUuid: uuid(stats), newCounts: state.newCounts, total: sum(state.counts) }
}
async function oldWindowHash(db, expected) {
  const old = db.collection(expected.collection)
  const lower = await old.find({}, { projection: { _id: 1 } }).hint('_id_')
    .sort({ _id: -1 }).skip(expected.windowCount - 1).limit(1).maxTimeMS(10000).next()
  ensure(lower, 'OLD_WINDOW_LOWER_BOUND_MISSING')
  const hash = crypto.createHash('sha256')
  const cursor = old.find({ _id: { $gte: lower._id } }, { projection: { _id: 1, created_at: 1, to: 1, status: 1 } })
    .hint('_id_').sort({ _id: 1 }).limit(expected.windowCount + 1).batchSize(250).maxTimeMS(60000)
  let count = 0
  try {
    while (await cursor.hasNext()) {
      const row = await cursor.next()
      ensure(/^[a-f0-9]{24}$/.test(String(row._id)) && row.created_at instanceof Date && Number.isFinite(row.created_at.getTime()) &&
        typeof row.to === 'string' && Buffer.byteLength(row.to) <= 254 && KEYS.includes(row.status), 'OLD_WINDOW_ROW_INVALID')
      hash.update(JSON.stringify([String(row._id), row.created_at.toISOString(), row.to, row.status]) + '\n')
      count++
    }
  } finally { await cursor.close() }
  const sha256 = hash.digest('hex')
  ensure(count === expected.windowCount && sha256 === expected.windowHash, 'OLD_WINDOW_HASH_MISMATCH')
  return { count, sha256 }
}

async function inspect(db, expected = EXPECTED) {
  ensure(db.databaseName === expected.database, 'WRONG_DATABASE')
  ensure(expected.collection === 'mail' && expected.recent === 'mail_recent_v1' && expected.stats === 'mail_totals_v1', 'TARGET_NOT_ALLOWED')
  const before = await sourceHeader(db, expected)
  const active = await activeState(db, expected)
  const window = await oldWindowHash(db, expected)
  const after = await sourceHeader(db, expected)
  ensure(JSON.stringify(before) === JSON.stringify(after), 'OLD_SOURCE_CHANGED_DURING_CHECK')
  return { target: expected.database + '.mail', source: after, active, window }
}

async function retire(db, options = {}) {
  const expected = options.expected || EXPECTED
  const checked = await inspect(db, expected)
  if (!options.execute) return { passed: true, checkOnly: true, dropped: false, checked }
  ensure(options.onlyBoundedWriterActive && options.node24LiveQaPassed && options.confirmTarget === 'emailtrek.mail', 'EXECUTION_ACKNOWLEDGEMENTS_MISSING')
  // One last header/active check immediately before dropping the exact old name.
  const active = await activeState(db, expected)
  ensure(active.recentUuid === checked.active.recentUuid && active.statsUuid === checked.active.statsUuid &&
    KEYS.every(k => active.newCounts[k] >= checked.active.newCounts[k]), 'NEW_STORE_CHANGED_OR_REWOUND')
  ensure(JSON.stringify(await sourceHeader(db, expected)) === JSON.stringify(checked.source), 'OLD_SOURCE_CHANGED_BEFORE_DROP')
  options.progress.dropAttempted = true
  const result = await db.command({ drop: 'mail', writeConcern: { w: 1, j: true } })
  ensure(result.ok === 1, 'DROP_NOT_CONFIRMED')
  options.progress.dropped = true
  ensure((await db.listCollections({ name: 'mail' }).toArray()).length === 0, 'OLD_COLLECTION_STILL_PRESENT')
  const after = await activeState(db, expected)
  ensure(after.recentUuid === checked.active.recentUuid && after.statsUuid === checked.active.statsUuid &&
    KEYS.every(k => after.newCounts[k] >= active.newCounts[k]), 'POST_DROP_NEW_STORE_CHECK_FAILED')
  return { passed: true, dropped: true, target: 'emailtrek.mail', oldCount: expected.legacyCount,
    preservedRecentCollection: expected.recent, preservedTotalsCollection: expected.stats,
    totalBefore: checked.active.total, totalAfter: after.total, newCountersMonotonic: true }
}

function validateProof(filename, expected = EXPECTED) {
  ensure(filename && fs.statSync(filename).size <= 256 * 1024, 'ARCHIVE_PROOF_REQUIRED')
  const bytes = fs.readFileSync(filename)
  ensure(digest(bytes) === expected.proofHash, 'ARCHIVE_PROOF_HASH_MISMATCH')
  const proof = JSON.parse(bytes)
  ensure(proof.passed === true && proof.readOnly === true && proof.rawAddressesPrinted === false &&
    Object.values(proof.checks).every(value => value === true), 'ARCHIVE_PROOF_FAILED')
  ensure(proof.sourceCollection === 'mail' && proof.baselineCount === expected.legacyCount && proof.tailCount === 0 && proof.sampleCount === 10453 &&
    proof.sourceLastId === expected.lastId && proof.migrationWindow.sha256 === expected.windowHash &&
    Object.keys(expected.archiveHashes).every(name => proof.hashes[name] === expected.archiveHashes[name]), 'ARCHIVE_PROOF_IDENTITY_MISMATCH')
}

async function main(argv = process.argv.slice(2)) {
  const allowed = new Set(['--check', '--execute', '--archive-proof', '--confirm-target', '--only-bounded-writer-active', '--node24-live-qa-passed'])
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; ensure(allowed.has(arg) && !Object.prototype.hasOwnProperty.call(flags, arg), 'UNKNOWN_OR_DUPLICATE_ARGUMENT')
    if (arg === '--archive-proof' || arg === '--confirm-target') { ensure(argv[i + 1] && !argv[i + 1].startsWith('--'), 'ARGUMENT_VALUE_REQUIRED'); flags[arg] = argv[++i] }
    else flags[arg] = true
  }
  ensure(!(flags['--check'] && flags['--execute']), 'CHOOSE_CHECK_OR_EXECUTE')
  if (!flags['--check'] && !flags['--execute']) {
    console.log(JSON.stringify({ planOnly: true, target: 'emailtrek.mail', legacyRecords: EXPECTED.legacyCount,
      checks: ['pinned local archival proof', 'Node24 and exact bounded-writer source', 'active immutable migration baseline', 'unchanged old count/lastID/UUID', 'bounded old last100k canonical hash', 'new capped store/counters/accepted writes'],
      executionRequires: '--execute --archive-proof PRIVATE_PROOF_JSON --confirm-target emailtrek.mail --only-bounded-writer-active --node24-live-qa-passed',
      warning: 'Permanent retirement: samples and totals do not restore all legacy details. Never restart the legacy writer. No deletion is performed by this default plan.' }, null, 2))
    return
  }
  validateProof(flags['--archive-proof'])
  ensure(process.version === 'v24.22.1', 'UNVERIFIED_NODE_RUNTIME')
  for (const relative of Object.keys(EXPECTED.sourceHashes)) {
    ensure(digest(fs.readFileSync(path.join('/app', relative))) === EXPECTED.sourceHashes[relative], 'BOUNDED_WRITER_SOURCE_HASH_MISMATCH')
  }
  if (flags['--execute']) ensure(flags['--only-bounded-writer-active'] && flags['--node24-live-qa-passed'] && flags['--confirm-target'] === 'emailtrek.mail', 'EXECUTION_ACKNOWLEDGEMENTS_MISSING')
  const cfg = require('/app/config')
  ensure(cfg.MONGO_DB === 'emailtrek', 'WRONG_DATABASE_CONFIGURATION')
  const { MongoClient } = require('/app/node_modules/mongodb')
  const client = new MongoClient(cfg.MONGO_ADDR, { useNewUrlParser: true, useUnifiedTopology: true, poolSize: 1, serverSelectionTimeoutMS: 10000, socketTimeoutMS: 90000 })
  const progress = { dropAttempted: false, dropped: false }
  try {
    await client.connect()
    const result = await retire(client.db('emailtrek'), { execute: !!flags['--execute'], onlyBoundedWriterActive: !!flags['--only-bounded-writer-active'],
      node24LiveQaPassed: !!flags['--node24-live-qa-passed'], confirmTarget: flags['--confirm-target'], progress })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    error.progress = progress; throw error
  } finally { await client.close() }
}

module.exports = { inspect, retire, validateProof, main, EXPECTED }
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ success: false, code: error.safeCode || 'GATE_FAILED_REVIEW_PRIVATELY',
    progress: error.progress || { dropAttempted: false, dropped: false },
    retryPolicy: 'No automatic retry after a drop attempt; inspect collection existence and protected stores read-only first.' }))
  process.exitCode = 1
})
