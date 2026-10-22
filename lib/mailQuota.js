'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const DAY = 24 * 60 * 60 * 1000
const DEFAULTS = { ipBurst: 3, ipBurstMs: 15 * 60 * 1000, ipDay: 20,
  recipientGapMs: 10 * 60 * 1000, recipientDay: 5,
  globalHour: 30, globalDay: 100, concurrent: 2 }

function unavailable() {
  const error = new Error('Mail is temporarily unavailable. Please try again later.')
  error.status = 503
  return error
}

module.exports = function createMailQuota(options = {}) {
  const dir = options.directory || '/app/maintenance-state'
  const now = options.now || Date.now
  const limits = Object.assign({}, DEFAULTS, options.limits)
  const filename = path.join(dir, 'mail-quota.json')
  let state, secret, active = 0, broken = false
  let newSecret = false

  function persist() {
    const temp = filename + '.' + process.pid + '.tmp'
    let fd
    try {
      fd = fs.openSync(temp, 'w', 0o600)
      fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, JSON.stringify(state))
      fs.fsyncSync(fd)
      fs.closeSync(fd); fd = undefined
      fs.renameSync(temp, filename)
      const directoryFD = fs.openSync(dir, 'r')
      try { fs.fsyncSync(directoryFD) } finally { fs.closeSync(directoryFD) }
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
      try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
  }

  function load() {
    if (state) return
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const secretPath = path.join(dir, 'quota-hmac.key')
    try { secret = fs.readFileSync(secretPath) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // Never silently replace the key while quota history already exists.
      if (fs.existsSync(filename)) throw unavailable()
      secret = crypto.randomBytes(32)
      newSecret = true
      const fd = fs.openSync(secretPath, 'wx', 0o600)
      try { fs.writeFileSync(fd, secret); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    }
    if (secret.length !== 32) throw unavailable()
    fs.chmodSync(secretPath, 0o600)
    try {
      if (fs.statSync(filename).size > 128 * 1024) throw unavailable()
      state = JSON.parse(fs.readFileSync(filename, 'utf8'))
      if (state.version !== 1 || !Array.isArray(state.global) ||
          !state.keys || typeof state.keys !== 'object' || Array.isArray(state.keys) ||
          !Number.isFinite(state.lastTime) || Object.keys(state.keys).length > 400 ||
          state.global.length > 200) throw unavailable()
      for (const [key, times] of Object.entries(state.keys)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(times) || times.length > 100) throw unavailable()
      }
      for (const times of [state.global, ...Object.values(state.keys)]) {
        if (times.some(t => !Number.isFinite(t) || t < 0)) throw unavailable()
      }
      fs.chmodSync(filename, 0o600)
    } catch (error) {
      state = undefined
      if (error.code !== 'ENOENT' || !newSecret) throw unavailable()
      state = { version: 1, global: [], keys: {}, lastTime: now() }
    }
  }

  function hash(kind, value) {
    return crypto.createHmac('sha256', secret).update(kind + ':' + value.toLowerCase()).digest('hex')
  }

  function denied(retryMs) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(retryMs / 1000)) }
  }

  return {
    reserve(ip, recipient) {
      if (broken) throw unavailable()
      try {
        load()
        // Clock rollback cannot immediately reset budgets already committed.
        const time = Math.max(now(), state.lastTime)
        state.lastTime = time
        state.global = state.global.filter(t => t > time - DAY)
        for (const key of Object.keys(state.keys)) {
          state.keys[key] = state.keys[key].filter(t => t > time - DAY)
          if (!state.keys[key].length) delete state.keys[key]
        }
        if (active >= limits.concurrent) return denied(30)
        const ipKey = hash('ip', ip), recipientKey = hash('recipient', recipient)
        const ipTimes = state.keys[ipKey] || [], recipientTimes = state.keys[recipientKey] || []
        const checks = [
          [ipTimes.filter(t => t > time - limits.ipBurstMs), limits.ipBurst, limits.ipBurstMs],
          [ipTimes, limits.ipDay, DAY], [recipientTimes, limits.recipientDay, DAY],
          [state.global.filter(t => t > time - 3600000), limits.globalHour, 3600000],
          [state.global, limits.globalDay, DAY],
        ]
        for (const [times, max, window] of checks) {
          if (times.length >= max) return denied(Math.min(...times) + window - time)
        }
        if (recipientTimes.length) {
          const remaining = Math.max(...recipientTimes) + limits.recipientGapMs - time
          if (remaining > 0) return denied(remaining)
        }
        // Reserve BEFORE verification/SMTP; failed attempts also consume budget.
        // One existing PM2 process serializes this synchronous critical section.
        state.keys[ipKey] = ipTimes.concat(time)
        state.keys[recipientKey] = recipientTimes.concat(time)
        state.global.push(time)
        persist()
        active++
        let released = false
        return { allowed: true, release() { if (!released) { released = true; active-- } } }
      } catch (error) {
        broken = true
        throw unavailable()
      }
    },
  }
}
