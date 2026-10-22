'use strict'

// MongoDB standalone has no cross-collection transactions. The singleton owns
// both the permanent counters and exactly one durable pending detail. Commit
// them in one atomic document update; replay the detail idempotently before
// accepting another event. This module is used by ONE PM2 process, not a cluster.
const { ObjectId } = require('mongodb')
const { EventEmitter } = require('events')
const KEYS = ['not_exists', 'verified', 'sent']
const NAMES = { recent: 'mail_recent_v1', stats: 'mail_totals_v1' }
const MAX = 100000
const SIZE = 128 * 1024 * 1024
const WRITE = { w: 1, j: true }

function empty() { return { not_exists: 0, verified: 0, sent: 0 } }
function counts(value) {
  const result = empty()
  for (const key of KEYS) {
    if (!value || !Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('Invalid cumulative statistics')
    result[key] = value[key]
  }
  if (!Number.isSafeInteger(Object.values(result).reduce((a, b) => a + b, 0))) throw new Error('Statistics overflow')
  return result
}
function record(data) {
  if (!data || !KEYS.includes(data.status) || typeof data.to !== 'string' ||
      Buffer.byteLength(data.to) > 254 || !data.to.length || /[\r\n\0]/.test(data.to)) {
    throw new Error('Invalid verification record')
  }
  if (data._id && !(data._id instanceof ObjectId)) throw new Error('Invalid verification ID')
  const date = data.created_at instanceof Date ? data.created_at : new Date(data.created_at)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid verification date')
  return { _id: data._id || new ObjectId(), created_at: date, to: data.to, status: data.status }
}

async function create(db) {
  const info = await db.listCollections({ name: NAMES.recent }).toArray()
  if (info.length !== 1 || !info[0].options.capped || info[0].options.max !== MAX ||
      info[0].options.size !== SIZE) throw new Error('Bounded detail collection is not prepared')
  const recent = db.collection(NAMES.recent)
  const stats = db.collection(NAMES.stats)
  const events = new EventEmitter()
  let serialTail = Promise.resolve()
  const serial = fn => { const next = serialTail.then(fn); serialTail = next.catch(() => {}); return next }

  async function state() {
    const value = await stats.findOne({ _id: 'totals', version: 1, mode: 'active' },
      { projection: { counts: 1, pending: 1 } })
    if (!value) throw new Error('Cumulative statistics migration is not active')
    counts(value.counts)
    return value
  }

  async function recover() {
    const value = await state()
    if (!value.pending) return value
    const pending = record(value.pending)
    // MongoDB 4.4 capped insert can evict an old row even when a duplicate
    // _id subsequently fails. A $setOnInsert upsert is a no-op on replay.
    await recent.updateOne({ _id: pending._id }, { $setOnInsert: pending },
      { ...WRITE, upsert: true })
    const existing = await recent.findOne({ _id: pending._id })
    if (!existing || existing.status !== pending.status || existing.to !== pending.to ||
        new Date(existing.created_at).getTime() !== pending.created_at.getTime()) {
      throw new Error('Pending record identity conflict')
    }
    await stats.updateOne({ _id: 'totals', 'pending._id': pending._id },
      { $unset: { pending: '' } }, WRITE)
    return state()
  }

  await recover()

  function insertOne(data) {
    const item = record(data)
    return serial(async () => {
      const before = await recover()
      if (Object.values(before.counts).reduce((a, b) => a + b, 0) >= Number.MAX_SAFE_INTEGER - 1) throw new Error('Statistics overflow')
      const result = await stats.findOneAndUpdate(
        { _id: 'totals', version: 1, mode: 'active', pending: { $exists: false } },
        { $inc: { ['counts.' + item.status]: 1, ['newCounts.' + item.status]: 1 }, $set: { pending: item, updatedAt: new Date() } },
        { ...WRITE, returnOriginal: false, projection: { _id: 1 } })
      if (!result.value) throw new Error('Another database writer is active')
      const committed = await recover()
      events.emit('stats', counts(committed.counts))
      return { insertedId: item._id }
    })
  }

  return {
    insertOne,
    getTotal: () => serial(async () => counts((await recover()).counts)),
    getLimit: (limit = 100, skip = 0) => recent.find({}, {
      projection: { _id: 1, created_at: 1, to: 1, status: 1 },
    }).sort({ _id: -1 }).limit(limit).skip(skip).maxTimeMS(10000).toArray(),
    onStats: fn => events.on('stats', fn),
    offStats: fn => events.removeListener('stats', fn),
  }
}

module.exports = { create, KEYS, NAMES, MAX, SIZE, WRITE, empty, counts, record }
