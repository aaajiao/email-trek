'use strict'

// Explicit maintenance CLI only. It NEVER drops or modifies the legacy mail
// collection. prepare may run while the old app writes AFTER the agreed cutoff.
// finalize requires the old writer stopped and stays offline until verification.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { MongoClient, ObjectId } = require('mongodb')
const { MONGO_ADDR, MONGO_DB } = require('../config')
const store = require('./boundedStore')
const LOCK = '/app/maintenance-state/storage-migration.lock'
const OLD = 'mail'

function digestRow(hash, row) {
  hash.update(JSON.stringify([String(row._id), new Date(row.created_at).toISOString(), row.to, row.status]) + '\n')
}
async function aggregate(collection, match) {
  const counts = store.empty()
  let recordCount = 0, unknownStatusCount = 0
  const rows = await collection.aggregate([
    { $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } },
  ], { maxTimeMS: 600000, allowDiskUse: false }).toArray()
  for (const row of rows) {
    recordCount += row.count
    if (store.KEYS.includes(row._id)) counts[row._id] = row.count
    else unknownStatusCount += row.count
  }
  store.counts(counts)
  return { counts, recordCount, unknownStatusCount }
}

function validateSummary(summary, cutoff) {
  const size = Buffer.byteLength(JSON.stringify(summary))
  if (size > 1024 * 1024 || summary.version !== 1 || summary.sourceCollection !== OLD ||
      summary.cutoff !== String(cutoff) || !Array.isArray(summary.groups) || summary.groups.length > 10000) {
    throw new Error('Invalid external summary identity')
  }
  const fields = ['recordCount', 'unknownStatusCount', 'invalidIdCount', 'invalidToCount', 'invalidDateCount']
  for (const field of fields) if (!Number.isSafeInteger(summary[field]) || summary[field] < 0) throw new Error('Invalid external summary count')
  store.counts(summary.counts)
  const expected = { recordCount: 0, unknownStatusCount: 0, invalidIdCount: 0, invalidToCount: 0, invalidDateCount: 0 }
  const counts = store.empty(), seen = new Set()
  for (const group of summary.groups) {
    if (!/^(\d{4}-\d{2}|INVALID_DATE)$/.test(group.month) ||
        ![...store.KEYS, 'INVALID_STATUS'].includes(group.status)) throw new Error('Invalid external summary group')
    const key = group.month + ':' + group.status
    if (seen.has(key)) throw new Error('Invalid duplicate summary group')
    seen.add(key)
    for (const field of ['count', 'invalidId', 'invalidTo', 'invalidDate']) {
      if (!Number.isSafeInteger(group[field]) || group[field] < 0 || group[field] > group.count) throw new Error('Invalid external group count')
    }
    expected.recordCount += group.count
    expected.invalidIdCount += group.invalidId
    expected.invalidToCount += group.invalidTo
    expected.invalidDateCount += group.invalidDate
    if (group.status === 'INVALID_STATUS') expected.unknownStatusCount += group.count
    else counts[group.status] += group.count
  }
  for (const field of fields) if (summary[field] !== expected[field]) throw new Error('Invalid summary group total')
  for (const key of store.KEYS) if (summary.counts[key] !== counts[key]) throw new Error('Invalid summary status total')
  return summary
}
const sum = value => Object.values(value).reduce((a, b) => a + b, 0)

async function hashWindow(collection) {
  const hash = crypto.createHash('sha256')
  let count = 0, first = null, last = null, firstCreatedAt = null, lastCreatedAt = null, maxAddressBytes = 0
  const cursor = collection.find({}, { projection: { _id: 1, created_at: 1, to: 1, status: 1 } })
    .sort({ _id: 1 }).batchSize(500).maxTimeMS(60000)
  while (await cursor.hasNext()) {
    const row = store.record(await cursor.next())
    digestRow(hash, row); count++
    if (!first) { first = row._id; firstCreatedAt = row.created_at.toISOString() }
    last = row._id; lastCreatedAt = row.created_at.toISOString()
    maxAddressBytes = Math.max(maxAddressBytes, Buffer.byteLength(row.to))
  }
  return { count, sha256: hash.digest('hex'), maxAddressBytes,
    firstRecordCreatedAt: firstCreatedAt, lastRecordCreatedAt: lastCreatedAt,
    earliestObjectIdTime: first ? first.getTimestamp().toISOString() : null,
    latestObjectIdTime: last ? last.getTimestamp().toISOString() : null }
}

async function prepare(db, cutoff, summary, summarySha256) {
  validateSummary(summary, cutoff)
  const stats = db.collection(store.NAMES.stats)
  if (await stats.findOne({ _id: 'totals' })) throw new Error('Migration already prepared; inspect it before retrying')
  const digest = summarySha256 || crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex')
  await stats.insertOne({ _id: 'totals', version: 1, mode: 'prepared', cutoff,
    baseCounts: summary.counts, baselineCount: summary.recordCount,
    baselineUnknownStatusCount: summary.unknownStatusCount,
    baselineAudit: summary, baselineSummarySha256: digest, preparedAt: new Date() }, store.WRITE)
  return { phase: 'prepared', cutoff: String(cutoff), counts: summary.counts,
    total: sum(summary.counts), recordCount: summary.recordCount,
    unknownStatusCount: summary.unknownStatusCount, summarySha256: digest,
    fullScanPerformed: false, oldCollectionModified: false }
}

async function finalize(db, cutoff, writersStopped) {
  if (!writersStopped) throw new Error('Stop the legacy writer before finalize; require --writers-stopped')
  const stats = db.collection(store.NAMES.stats)
  const state = await stats.findOne({ _id: 'totals', mode: 'prepared', cutoff })
  if (!state) throw new Error('Matching prepared cutoff not found')
  if ((await db.listCollections({ name: store.NAMES.recent }).toArray()).length) {
    throw new Error('New detail collection already exists; inspect partial migration, do not overwrite it')
  }
  const old = db.collection(OLD)
  const sourceLast = await old.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next()
  const sourceLastId = sourceLast ? String(sourceLast._id) : null
  const tail = await aggregate(old, { _id: { $gte: cutoff } })
  const counts = store.empty()
  for (const key of store.KEYS) counts[key] = state.baseCounts[key] + tail.counts[key]
  store.counts(counts)
  const metadataCount = await old.estimatedDocumentCount({ maxTimeMS: 10000 })
  if (state.baselineCount + tail.recordCount !== metadataCount) throw new Error('Old collection count differs from baseline plus tail; stop and investigate')

  await db.createCollection(store.NAMES.recent, { capped: true, size: store.SIZE, max: store.MAX })
  const recent = db.collection(store.NAMES.recent)
  let lower = await old.find({}, { projection: { _id: 1 } }).sort({ _id: -1 })
    .skip(store.MAX - 1).limit(1).maxTimeMS(10000).next()
  if (!lower) lower = await old.find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(1).next()
  const hash = crypto.createHash('sha256')
  let copied = 0, batch = []
  if (lower) {
    const cursor = old.find({ _id: { $gte: lower._id } }, {
      projection: { _id: 1, created_at: 1, to: 1, status: 1 },
    }).sort({ _id: 1 }).batchSize(500).maxTimeMS(60000)
    while (await cursor.hasNext()) {
      const row = store.record(await cursor.next())
      digestRow(hash, row); copied++; batch.push(row)
      if (batch.length === 250) { await recent.insertMany(batch, store.WRITE); batch = [] }
    }
    if (batch.length) await recent.insertMany(batch, store.WRITE)
  }
  const sourceHash = hash.digest('hex')
  const window = await hashWindow(recent)
  if (copied !== Math.min(metadataCount, store.MAX) || window.count !== copied || window.sha256 !== sourceHash) {
    throw new Error('Recent window verification failed; legacy collection remains untouched')
  }
  const countAfterCopy = await old.estimatedDocumentCount({ maxTimeMS: 10000 })
  if (countAfterCopy !== metadataCount) throw new Error('Legacy writer changed data during finalize')
  await stats.updateOne({ _id: 'totals', mode: 'prepared', cutoff }, {
    $set: { mode: 'active', counts, legacyCounts: counts, newCounts: store.empty(),
      legacyUnknownStatusCount: state.baselineUnknownStatusCount + tail.unknownStatusCount,
      legacySemantics: 'Historical SMTP observations; verified is acceptance, not ownership/delivery; not_exists includes historical unknown failures. New negatives represent RCPT rejection only.',
      migratedAt: new Date(), tailCounts: tail.counts, tailRecordCount: tail.recordCount,
      legacyCount: metadataCount, sourceLastId, migrationWindow: window },
  }, store.WRITE)
  return { phase: 'active', cutoff: String(cutoff), counts, total: sum(counts), legacyCounts: counts, tailCounts: tail.counts,
    legacyUnknownStatusCount: state.baselineUnknownStatusCount + tail.unknownStatusCount,
    sourceLastId, metadataCount, tailRecordCount: tail.recordCount, tailUnknownStatusCount: tail.unknownStatusCount,
    window, oldCollectionModified: false, oldCollectionDropped: false }
}

async function verify(db) {
  const state = await db.collection(store.NAMES.stats).findOne({ _id: 'totals' })
  if (!state || state.mode !== 'active') throw new Error('Migration not active')
  store.counts(state.counts)
  store.counts(state.legacyCounts)
  store.counts(state.newCounts)
  for (const key of store.KEYS) if (state.counts[key] !== state.legacyCounts[key] + state.newCounts[key]) {
    throw new Error('Invalid cumulative legacy/new count sum')
  }
  const details = await db.listCollections({ name: store.NAMES.recent }).toArray()
  const window = await hashWindow(db.collection(store.NAMES.recent))
  const options = details[0] && details[0].options
  if (!options || !options.capped || options.max !== store.MAX || options.size !== store.SIZE || window.count > store.MAX) {
    throw new Error('Bounded collection validation failed')
  }
  return { phase: state.mode, counts: state.counts, legacyCounts: state.legacyCounts,
    newCounts: state.newCounts, legacyUnknownStatusCount: state.legacyUnknownStatusCount,
    total: sum(state.counts), sourceLastId: state.sourceLastId, legacyCount: state.legacyCount,
    window, pending: !!state.pending, options, oldCollectionDropped: false }
}

async function main() {
  const command = process.argv[2]
  const cutoffText = process.argv[process.argv.indexOf('--cutoff') + 1]
  if (!['prepare', 'finalize', 'verify'].includes(command)) throw new Error('Use prepare/finalize/verify')
  if (command !== 'verify' && !/^[a-f0-9]{24}$/i.test(cutoffText || '')) throw new Error('Provide --cutoff ObjectId hex')
  fs.mkdirSync(path.dirname(LOCK), { recursive: true, mode: 0o700 })
  let summary, summarySha256
  if (command === 'prepare') {
    const index = process.argv.indexOf('--summary-file')
    if (index < 0 || !process.argv[index + 1]) throw new Error('Provide --summary-file from the single archival scan')
    const filename = process.argv[index + 1]
    if (fs.statSync(filename).size > 1024 * 1024) throw new Error('Invalid external summary size')
    const bytes = fs.readFileSync(filename)
    summary = JSON.parse(bytes)
    summarySha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  }
  const lock = fs.openSync(LOCK, 'wx', 0o600)
  fs.writeSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command }))
  const client = new MongoClient(MONGO_ADDR, { useNewUrlParser: true, useUnifiedTopology: true })
  try {
    await client.connect()
    const db = client.db(MONGO_DB)
    const result = command === 'verify' ? await verify(db) : command === 'prepare' ?
      await prepare(db, new ObjectId(cutoffText), summary, summarySha256) :
      await finalize(db, new ObjectId(cutoffText), process.argv.includes('--writers-stopped'))
    console.log(JSON.stringify(result, null, 2))
  } finally { await client.close(); fs.closeSync(lock); fs.unlinkSync(LOCK) }
}

module.exports = { prepare, finalize, verify, aggregate, hashWindow, validateSummary }
if (require.main === module) main().catch(error => {
  // Only known maintenance errors; never include Mongo URI or record content.
  console.error(JSON.stringify({ success: false, code: error.code || 'MIGRATION_FAILED',
    message: /^(Migration|Matching|New detail|Recent window|Legacy writer|Old collection|Unknown historical|Cumulative|Bounded|Invalid|Stop the|Provide|Use )/.test(error.message) ? error.message : 'Migration failed; inspect locally without exposing records' }))
  process.exitCode = 1
})
