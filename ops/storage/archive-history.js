'use strict'
// Read-only archival extraction. One native full scan produces both the
// migration baseline and created_at-month/status audit. Samples are bounded.
const { MongoClient, ObjectId } = require('/app/node_modules/mongodb')
const STATUS = ['not_exists', 'verified', 'sent']
const projection = { _id: 1, created_at: 1, to: 1, status: 1 }

function pipeline(cutoff, now) {
  return [
    // Non-ObjectId rows are explicitly included for anomaly accounting. The
    // migration must refuse them rather than silently exclude unknown types.
    { $match: { $expr: { $or: [
      { $ne: [{ $type: '$_id' }, 'objectId'] }, { $lt: ['$_id', cutoff] },
    ] } } },
    { $project: { _id: 1, created_at: 1, status: 1,
      idOK: { $eq: [{ $type: '$_id' }, 'objectId'] },
      toTypeOK: { $eq: [{ $type: '$to' }, 'string'] },
      safeTo: { $cond: [{ $eq: [{ $type: '$to' }, 'string'] }, '$to', ''] },
      dateOK: { $and: [
        { $eq: [{ $type: '$created_at' }, 'date'] },
        { $gte: ['$created_at', new Date('1970-01-01T00:00:00Z')] },
        { $lte: ['$created_at', new Date(now.getTime() + 86400000)] },
      ] },
    } },
    { $project: { _id: 1, created_at: 1, idOK: 1, dateOK: 1,
      status: { $cond: [{ $in: ['$status', STATUS] }, '$status', 'INVALID_STATUS'] },
      month: { $cond: ['$dateOK', { $dateToString: { date: '$created_at', format: '%Y-%m', timezone: 'UTC' } }, 'INVALID_DATE'] },
      toOK: { $and: ['$toTypeOK', { $gt: [{ $strLenBytes: '$safeTo' }, 0] },
        { $lte: [{ $strLenBytes: '$safeTo' }, 254] },
        { $regexMatch: { input: '$safeTo', regex: '^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$' } },
      ] },
    } },
    { $group: { _id: { month: '$month', status: '$status' }, count: { $sum: 1 },
      invalidTo: { $sum: { $cond: ['$toOK', 0, 1] } },
      invalidDate: { $sum: { $cond: ['$dateOK', 0, 1] } },
      invalidId: { $sum: { $cond: ['$idOK', 0, 1] } },
      firstId: { $min: '$_id' }, lastId: { $max: '$_id' },
      earliestCreatedAt: { $min: { $cond: ['$dateOK', '$created_at', null] } },
      latestCreatedAt: { $max: { $cond: ['$dateOK', '$created_at', null] } },
    } },
    { $sort: { '_id.month': 1, '_id.status': 1 } },
  ]
}

async function extract(db, options = {}) {
  const collectionName = options.collection || 'mail'
  if (collectionName !== 'mail' && !/^maintenance_fixture_[a-z0-9_]+$/.test(collectionName)) throw new Error('Unexpected collection')
  const col = db.collection(collectionName), now = new Date()
  const cutoff = options.cutoff ? new ObjectId(options.cutoff) : ObjectId.createFromTime(Math.floor(now.getTime() / 1000) - 2)
  const maxTimeMS = options.maxTimeMS || 1800000
  const metadata = await db.command({ collStats: collectionName, maxTimeMS: 10000 })
  // Only this operation scans the complete baseline. Group count is bounded by
  // UTC months since1970, four normalized status buckets, plus invalid dates.
  const started = Date.now()
  const rawGroups = await col.aggregate(pipeline(cutoff, now), {
    allowDiskUse: false, maxTimeMS, comment: 'email-trek-single-pass-archive-baseline-v1',
  }).toArray()
  const groups = rawGroups.map(({ _id, ...g }) => ({ month: _id.month, status: _id.status, ...g }))
  const counts = { not_exists: 0, verified: 0, sent: 0 }
  let recordCount = 0, unknownStatusCount = 0, invalidIdCount = 0, invalidToCount = 0, invalidDateCount = 0
  for (const g of groups) {
    recordCount += g.count
    if (STATUS.includes(g.status)) counts[g.status] += g.count
    else unknownStatusCount += g.count
    invalidIdCount += g.invalidId; invalidToCount += g.invalidTo; invalidDateCount += g.invalidDate
  }
  const statistics = { version: 1, sourceCollection: collectionName, cutoff: String(cutoff),
    recordCount, counts, unknownStatusCount, invalidIdCount, invalidToCount, invalidDateCount,
    groups, startedAt: now.toISOString(), completedAt: new Date().toISOString(),
    fullScanDurationMs: Date.now() - started,
    metadataCountBeforeScan: metadata.count,
    method: {
      fullScanCount: 1, cutoffPredicate: 'All ObjectIds below fixed cutoff, plus non-ObjectId anomalies; append-only source required.',
      grouping: 'UTC calendar month of original created_at, not ObjectId time; status normalized into three original labels plus INVALID_STATUS.',
      boundarySamples: 'Minimum and maximum _id per created_at-month/status group; insertion boundaries within each month, not necessarily chronological event boundaries.',
      validId: 'BSON ObjectId', validDate: 'BSON Date in1970-01-01 through audit time plus1day; other dates bucketed INVALID_DATE and counted.',
      validTo: 'String,1..254UTF8bytes,basic one-at-sign and dotted-domain shape without whitespace/angle brackets; not full RFC or delivery validation.',
      consistency: 'Source append-only; future writes normally fall beyond cutoff. No source updates/deletes may run until migration finalized.',
      limitations: 'Historical labels retained verbatim; VERIFIED is not proof of mailbox existence or delivery. Non-ObjectId or unknown-status rows require manual review before migration.',
    },
  }
  const samples = new Map(), memberships = []
  const key = id => id && id._bsontype === 'ObjectID' ? 'oid:' + id.toHexString() : typeof id + ':' + JSON.stringify(id)
  function add(row, method, group) {
    if (Buffer.byteLength(JSON.stringify(row)) > 32768) throw new Error('Oversized historical sample; review before export')
    const id = key(row._id)
    if (!samples.has(id)) samples.set(id, row)
    memberships.push({ id, method, ...(group ? { group } : {}) })
  }
  const ids = Array.from(new Map(groups.flatMap(g => [g.firstId, g.lastId]).map(id => [key(id), id])).values())
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await col.find({ _id: { $in: ids.slice(i, i + 200) } }, { projection })
      .hint('_id_').limit(200).maxTimeMS(10000).toArray()
    for (const row of rows) add(row, 'created_at_month_status_id_boundaries')
  }
  const requested = Math.min(options.sampleSize === undefined ? 10000 : options.sampleSize, metadata.count)
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > 10000) throw new Error('Invalid sample size')
  // First-stage $sample can use Mongo random cursor for small samples (<5%) on
  // this large collection. It is a bounded additional query, not another group.
  const random = requested ? await col.aggregate([
    { $sample: { size: requested } }, { $match: { _id: { $lt: cutoff } } }, { $project: projection },
  ], { maxTimeMS: 60000, allowDiskUse: false, comment: 'email-trek-bounded-archive-sample-v1' }).toArray() : []
  for (const row of random) add(row, 'mongodb_first_stage_sample_then_cutoff')
  return { statistics,
    sampleArchive: { version: 1, createdAt: new Date().toISOString(), cutoff: String(cutoff),
      fieldEncoding: 'Original four fields only: ObjectId encoded hex, BSON Date encoded ISO8601 by Mongo driver JSON serialization. Raw address values are private archive material.',
      sampling: { monthlyBoundaryIdCount: ids.length, requestedMongoSample: requested,
        actualMongoSampleAfterCutoff: random.length, uniqueRecords: samples.size,
        method: 'Monthly/status insertion-boundary samples plus first-stage Mongo $sample, followed by fixed-cutoff filtering. Not claimed uniformly random; groups are intentionally oversampled for historical coverage.',
        limitations: 'Representative subset, not a full record backup; data outside this subset cannot be reconstructed from counters. All dates/statuses retained as originally stored.' },
      memberships, records: Array.from(samples.values()),
    },
  }
}

async function main() {
  if (process.env.EMAIL_ARCHIVE_EXECUTE !== '1') throw new Error('Explicit execution switch required; full scan was not started')
  const cfg = require('/app/config')
  const client = new MongoClient(cfg.MONGO_ADDR, { useNewUrlParser: true, useUnifiedTopology: true,
    poolSize: 1, serverSelectionTimeoutMS: 10000, socketTimeoutMS: 1860000 })
  try {
    const options = JSON.parse(process.env.EMAIL_ARCHIVE_OPTIONS || '{}')
    if (!/^[a-f0-9]{24}$/i.test(options.cutoff || '')) throw new Error('An explicitly coordinated cutoff is required')
    if (new ObjectId(options.cutoff).getTimestamp().getTime() >= Date.now() - 1000) throw new Error('Coordinated cutoff must already be in the past')
    await client.connect()
    const result = await extract(client.db(cfg.MONGO_DB), options)
    process.stdout.write(JSON.stringify(result) + '\n')
  } finally { await client.close() }
}
// The runner calls main explicitly: Node14's stdin execution does not provide
// the same require.main identity as a file executed by path.
module.exports = { pipeline, extract, main }
