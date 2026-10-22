// One real verification at a time, including across disconnect/reconnect races.
class SingleLoopQueue {
  constructor(worker, doneCB, retryMs = 1000) {
    this.worker = worker
    this.doneCB = doneCB
    this.retryMs = retryMs
    this._stop = true
    this.running = 0
    this.generation = 0
    this.scheduled = null
    this.retry = null
  }

  start() {
    if (!this._stop) return
    this._stop = false
    this.generation++
    this.run()
  }

  stop() {
    this._stop = true
    this.generation++
    if (this.scheduled) clearImmediate(this.scheduled)
    if (this.retry) clearTimeout(this.retry)
    this.scheduled = this.retry = null
    // Do not reset running: an existing verification is still in flight.
  }

  run() {
    if (this._stop || this.running || this.scheduled || this.retry) return
    this.scheduled = setImmediate(() => {
      this.scheduled = null
      if (this._stop) return
      const generation = this.generation
      this.running = 1
      let settled = false
      const done = (error, result) => {
        if (settled) return
        settled = true
        this.running = 0
        if (!this._stop && generation === this.generation) {
          try { this.doneCB(error, result) } catch (err) { error = err }
        }
        if (this._stop) return
        if (error) {
          this.retry = setTimeout(() => { this.retry = null; this.run() }, this.retryMs)
        } else this.run()
      }
      try {
        const result = this.worker(done)
        if (result && typeof result.catch === 'function') result.catch(done)
      } catch (error) { done(error) }
    })
  }
}

module.exports = SingleLoopQueue
