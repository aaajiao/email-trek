const LoopQueue = require('./singleQueue')
const { clientIP, publicResult } = require('./publicSafety')

module.exports = (io, db, mailHandler, options = {}) => {
  const clients = new Map()
  let history = null
  let statsRequest = null
  const q = new LoopQueue(async cb => cb(null, await mailHandler.checkMail()),
    (error, result) => { if (!error && result) io.emit('append', publicResult(result)) },
    options.retryMs === undefined ? 1000 : options.retryMs)

  function updateStats() {
    if (!clients.size || statsRequest) return
    statsRequest = db.getTotal().then(total => {
      if (total) io.emit('stats', { total })
    }).catch(() => {}).finally(() => { statsRequest = null })
  }
  const onStats = total => io.emit('stats', { total })
  if (db.onStats) db.onStats(onStats)
  const timer = setInterval(updateStats, 5000)
  timer.unref()

  io.on('connection', client => {
    const ip = clientIP(client.request || {})
    const forIP = Array.from(clients.values()).filter(value => value === ip).length
    if (!ip || clients.size >= 32 || forIP >= 5) {
      client.disconnect(true)
      return
    }
    clients.set(client.id, ip)
    // Register before any await so a visitor leaving during initialization is seen.
    client.on('disconnect', () => {
      clients.delete(client.id)
      if (!clients.size) q.stop()
    })
    q.start()
    updateStats()
    if (!history) {
      history = Promise.resolve().then(() => db.genAscii()).catch(() => [])
        .finally(() => { history = null })
    }
    history.then(maskAscii => {
      if (!client.connected || !clients.has(client.id)) return
      client.emit('init', { total: null, maskAscii, statisticsLoading: true })
      // A ready cache is cheap; statistics never gate initial display or the queue.
      return db.getTotal().then(total => {
        if (total && client.connected) client.emit('stats', { total })
      })
    }).catch(() => {})
  })
  return { queue: q, close() {
    q.stop(); clearInterval(timer)
    if (db.offStats) db.offStats(onStats)
  } }
}
