'use strict'

// One durable gate for actual delivery calls, independent of RCPT exploration.
// Pending reservations consume budget; neither startup nor cleanup replays them.
const nativeFs = require('fs')
const path = require('path')
const crypto = require('crypto')
const childProcess = require('child_process')
const GAP = 5 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000
const OUTCOMES = ['pending', 'sent', 'failed', 'uncertain']
const AUTO_OUTCOMES = ['pending', 'sent', 'rejected', 'smtp-failed', 'verification-unavailable', 'budget-unavailable', 'cancelled', 'quota-denied', 'record-unconfirmed']

function unavailable() {
  const error = new Error('Mail is temporarily unavailable.')
  error.code = 'SMTP_BUDGET_UNAVAILABLE'; error.status = 503
  return error
}
module.exports = function createSmtpBudget(options = {}) {
  const fs = options.fileSystem || nativeFs
  const directory = options.directory || '/app/maintenance-state'
  const now = options.now || Date.now
  const filename = path.join(directory, 'smtp-budget.json')
  const marker = path.join(directory, 'smtp-budget.initialized')
  const lockname = path.join(directory, 'smtp-budget.lock')
  const flags = fs.constants
  let broken = false

  function checkDirectory() {
    if (options.requireMount !== false) {
      const mounted = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => {
        const field = line.split(' ')[4]
        return field && field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))) === directory
      })
      if (!mounted) throw unavailable()
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw unavailable()
  }
  function write(state) {
    const body = JSON.stringify(state) + '\n'
    if (Buffer.byteLength(body) > 65536) throw unavailable()
    const temp = filename + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
    let fd, dirfd
    try {
      fd = fs.openSync(temp, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW, 0o600)
      fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      fs.renameSync(temp, filename)
      dirfd = fs.openSync(directory, flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW)
      fs.fsyncSync(dirfd)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
      if (dirfd !== undefined) fs.closeSync(dirfd)
      try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
  }
  function read() {
    const hasState = fs.existsSync(filename), hasMarker = fs.existsSync(marker)
    if (!hasState && !hasMarker) {
      const state = { version: 1, lastTime: now(), attempts: [], runs: {} }
      write(state)
      const fd = fs.openSync(marker, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW, 0o600)
      try { fs.writeFileSync(fd, 'smtp-budget-v1\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      const dirfd = fs.openSync(directory, flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW)
      try { fs.fsyncSync(dirfd) } finally { fs.closeSync(dirfd) }
    } else if (!hasState || !hasMarker) throw unavailable()
    const markerStat = fs.lstatSync(marker)
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o077)) throw unavailable()
    let fd
    try {
      fd = fs.openSync(filename, flags.O_RDONLY | flags.O_NOFOLLOW)
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 65536) throw unavailable()
      const state = JSON.parse(fs.readFileSync(fd, 'utf8'))
      if (state.version !== 1 || !Number.isSafeInteger(state.lastTime) || state.lastTime < 0 ||
          !Array.isArray(state.attempts) || state.attempts.length > 100 ||
          !state.runs || typeof state.runs !== 'object' || Array.isArray(state.runs) || Object.keys(state.runs).length > 64) throw unavailable()
      const seen = new Set()
      for (const entry of state.attempts) {
        if (!entry || !/^[a-f0-9]{32}$/.test(entry.id) || seen.has(entry.id) ||
            !Number.isSafeInteger(entry.at) || entry.at < 0 || !['automatic', 'manual'].includes(entry.source) || !OUTCOMES.includes(entry.outcome)) throw unavailable()
        seen.add(entry.id)
      }
      for (const [key, run] of Object.entries(state.runs)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !run || typeof run.once !== 'boolean' || typeof run.used !== 'boolean' ||
            typeof run.paused !== 'boolean' || !Number.isSafeInteger(run.at) || run.at < 0 || !AUTO_OUTCOMES.includes(run.outcome)) throw unavailable()
      }
      return state
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  function locked(action) {
    if (broken) throw unavailable()
    let fd
    try {
      checkDirectory()
      fd = fs.openSync(lockname, flags.O_RDWR | flags.O_CREAT | flags.O_NOFOLLOW, 0o600)
      if (!fs.fstatSync(fd).isFile()) throw unavailable()
      fs.fchmodSync(fd, 0o600)
      // Inherited descriptor keeps the kernel lock after the helper exits.
      const locked = options.lock ? options.lock(fd) : childProcess.spawnSync('/usr/bin/flock', ['-x', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 1500
      })
      if (!locked || locked.error || locked.status !== 0) throw unavailable()
      for (const name of fs.readdirSync(directory)) {
        if (!/^smtp-budget\.json\.\d+\.[a-f0-9]{16}\.tmp$/.test(name)) continue
        const stale = path.join(directory, name)
        if (fs.lstatSync(stale).isFile()) fs.unlinkSync(stale)
      }
      const state = read()
      const time = Math.max(now(), state.lastTime)
      state.lastTime = time
      state.attempts = state.attempts.filter(entry => entry.at > time - DAY)
      return action(state, time)
    } catch (_) { broken = true; throw unavailable() } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  const keyFor = id => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id)) throw unavailable()
    return crypto.createHash('sha256').update(id).digest('hex')
  }
  function status(state, time) {
    if (state.attempts.length >= 100) return { allowed: false, retryAfter: Math.max(1, Math.ceil((Math.min(...state.attempts.map(e => e.at)) + DAY - time) / 1000)) }
    const last = state.attempts.length ? Math.max(...state.attempts.map(e => e.at)) : 0
    if (state.attempts.length && last + GAP > time) return { allowed: false, retryAfter: Math.ceil((last + GAP - time) / 1000) }
    return { allowed: true }
  }
  return {
    reserve(source) {
      if (!['automatic', 'manual'].includes(source)) throw unavailable()
      return locked((state, time) => {
        const ready = status(state, time)
        if (!ready.allowed) return ready
        const id = crypto.randomBytes(16).toString('hex')
        state.attempts.push({ id, at: time, source, outcome: 'pending' })
        write(state)
        return { allowed: true, id }
      })
    },
    finish(id, outcome) {
      if (!OUTCOMES.includes(outcome) || outcome === 'pending') throw unavailable()
      return locked(state => {
        const entry = state.attempts.find(item => item.id === id)
        if (!entry) throw unavailable()
        entry.outcome = outcome; write(state); return true
      })
    },
    beginAutomatic(id, once) {
      const key = keyFor(id)
      return locked((state, time) => {
        const run = state.runs[key]
        if (run && (run.once !== once || run.paused || run.outcome === 'pending' || (run.once && run.used))) return { allowed: false, disabled: true }
        const ready = status(state, time)
        if (!ready.allowed) return ready
        if (!run && Object.keys(state.runs).length >= 64) throw unavailable()
        // Consume an automatic test BEFORE verification, even if it later fails.
        state.runs[key] = { once: !!once, used: true, paused: false, at: time, outcome: 'pending' }
        write(state); return { allowed: true }
      })
    },
    finishAutomatic(id, outcome) {
      const key = keyFor(id)
      if (!AUTO_OUTCOMES.includes(outcome) || outcome === 'pending') throw unavailable()
      return locked(state => {
        const run = state.runs[key]
        if (!run) throw unavailable()
        run.outcome = outcome
        // Known errors pause this explicit run; no automatic error retry.
        run.paused = !['sent', 'cancelled', 'quota-denied'].includes(outcome)
        write(state); return true
      })
    }
  }
}
