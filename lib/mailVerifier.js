'use strict'

const path = require('path')
const { Worker } = require('worker_threads')

function create(options = {}) {
  const WorkerType = options.Worker || Worker
  const timeout = options.timeout || 20000
  let worker = null, nextID = 0
  const pending = new Map()

  function failed(code) {
    const error = new Error('Address verification is temporarily unavailable')
    error.code = code
    return error
  }

  function stop(code) {
    const old = worker
    worker = null
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(failed(code))
    }
    pending.clear()
    if (old) old.terminate().catch(() => {})
  }

  function start() {
    if (worker) return
    const current = new WorkerType(path.join(__dirname, 'verifyWorker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
      stdout: true, stderr: true,
    })
    // Library diagnostics can contain mailbox addresses; do not forward them.
    if (current.stdout) current.stdout.resume()
    if (current.stderr) current.stderr.resume()
    worker = current
    current.on('message', message => {
      if (worker !== current) return
      const item = pending.get(message.id)
      if (!item) return
      clearTimeout(item.timer)
      pending.delete(message.id)
      if (message.error) item.reject(failed(message.error))
      else item.resolve(message.info)
    })
    current.on('error', () => { if (worker === current) stop('VERIFY_WORKER_ERROR') })
    current.on('exit', () => { if (worker === current) stop('VERIFY_WORKER_EXIT') })
    current.unref()
  }

  function verify(address, settings) {
    if (pending.size >= 3) return Promise.reject(failed('VERIFY_BUSY'))
    return new Promise((resolve, reject) => {
      try {
        start()
        const id = ++nextID
        const timer = setTimeout(() => stop('VERIFY_TIMEOUT'), timeout)
        pending.set(id, { resolve, reject, timer })
        worker.postMessage({ id, address, settings: Object.assign({}, settings,
          { timeout: Math.min(Number(settings.timeout) || 15000, 15000) }) })
      } catch (error) {
        stop('VERIFY_WORKER_ERROR')
        reject(failed('VERIFY_WORKER_ERROR'))
      }
    })
  }

  return { verify, close: () => stop('VERIFY_CLOSED') }
}

const instance = create()
module.exports = instance
module.exports.create = create
