'use strict'
// Read-only exact small tail, after root has stopped the legacy writer.
const { MongoClient, ObjectId } = require('/app/node_modules/mongodb')
const crypto = require('crypto')
const KEYS = ['not_exists', 'verified', 'sent']
async function extract(db, options) {
  if (!options.writersStopped || !/^[a-f0-9]{24}$/i.test(options.cutoff || '')) throw new Error('Stopped writer and coordinated cutoff required')
  const maxRecords = options.maxRecords || 10000
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000) throw new Error('Bound outside allowed range')
  const collectionName = options.collection || 'mail'
  if (collectionName !== 'mail' && !/^maintenance_fixture_[a-z0-9_]+$/.test(collectionName)) throw new Error('Unexpected collection')
  const col = db.collection(collectionName), cutoff = new ObjectId(options.cutoff)
  const metadata = await db.command({ collStats: collectionName, maxTimeMS: 10000 })
  const last = await col.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).hint('_id_').limit(1).maxTimeMS(10000).next()
  if (last && !(last._id instanceof ObjectId)) throw new Error('Unexpected newest source ID type')
  const rows = await col.find({ _id: { $gte: cutoff } }, { projection: { _id: 1, created_at: 1, to: 1, status: 1 } })
    .sort({ _id: 1 }).hint('_id_').limit(maxRecords + 1).maxTimeMS(60000).toArray()
  if (rows.length > maxRecords) throw new Error('Tail exceeds approved bound; no output produced')
  const counts = { not_exists: 0, verified: 0, sent: 0 }, hash = crypto.createHash('sha256')
  let unknownStatusCount = 0
  for (const row of rows) {
    if (!(row._id instanceof ObjectId) || !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime()) ||
        typeof row.to !== 'string' || Buffer.byteLength(row.to) > 254 || !row.to.length || /[\r\n\0]/.test(row.to)) {
      throw new Error('Malformed tail row requires review')
    }
    if (KEYS.includes(row.status)) counts[row.status]++
    else unknownStatusCount++
    hash.update(JSON.stringify([String(row._id), row.created_at.toISOString(), row.to, row.status]) + '\n')
  }
  const after = await db.command({ collStats: collectionName, maxTimeMS: 10000 })
  const lastAfter = await col.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).hint('_id_').limit(1).maxTimeMS(10000).next()
  const lastId = last ? String(last._id) : null
  if (metadata.count !== after.count || lastId !== (lastAfter ? String(lastAfter._id) : null)) throw new Error('Source changed while writer was claimed stopped')
  return { statistics: { version: 1, sourceCollection: collectionName, cutoff: String(cutoff), recordCount: rows.length,
      counts, unknownStatusCount, sourceMetadataCount: metadata.count, sourceLastId: lastId,
      firstTailId: rows.length ? String(rows[0]._id) : null, lastTailId: rows.length ? String(rows[rows.length - 1]._id) : null,
      canonicalRowsSha256: hash.digest('hex'), archivedAt: new Date().toISOString(), maxRecords,
      writerStopRequired: true, observedStableMetadataAndLastId: true,
      method: 'Exact indexed small tail at _id>=original cutoff, after stopping the only writer; no full collection scan. Count/lastId stability is checked but external updates must remain prohibited.',
    }, records: rows }
}
async function main() {
  if (process.env.EMAIL_TAIL_EXECUTE !== '1') throw new Error('Explicit execution required')
  const options = JSON.parse(process.env.EMAIL_TAIL_OPTIONS || '{}'), cfg = require('/app/config')
  const client = new MongoClient(cfg.MONGO_ADDR, {
    maxPoolSize: 1, serverSelectionTimeoutMS: 10000, socketTimeoutMS: 90000 })
  try { await client.connect(); process.stdout.write(JSON.stringify(await extract(client.db(cfg.MONGO_DB), options)) + '\n') }
  finally { await client.close() }
}
module.exports = { extract, main }
