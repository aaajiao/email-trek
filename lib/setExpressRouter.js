const path = require('path')
const safety = require('./publicSafety')
const createMailQuota = require('./mailQuota')

module.exports = (app, db, mailHandler, options = {}) => {
  const quota = options.quota || createMailQuota()
  app.post('/get-data', async (req, res) => {
    try {
      const limit = safety.pageNumber(req.body && req.body.limit, 1, 2000)
      const skip = safety.pageNumber(req.body && req.body.skip, 0, 98000)
      if (limit !== null && skip !== null) {
        const list = await db.getLimit(limit, skip)
        //        console.log(list)
        res.send({ success: true, data: list.map(safety.exportRecord) })
      } else {
        return res.status(400).send({ success: false, error: 'Invalid pagination.' })
      }
    } catch (err) {
      res.status(503).send({ success: false, error: 'Data temporarily unavailable.' })
    }
  })

  app.post('/mail-you-send', async (req, res) => {
    const mailAddress = safety.mailAddress(req.body && req.body.data)
    if (!mailAddress) {
      return res.status(400).send({ success: false, error: 'Input one valid email address please!' })
    }
    const ip = safety.clientIP(req)
    if (!ip) return res.status(503).send({ success: false, error: 'Please try again later.' })
    let ticket
    try {
      ticket = quota.reserve(ip, mailAddress)
      if (!ticket.allowed) {
        res.set('Retry-After', String(ticket.retryAfter))
        return res.status(429).send({ success: false, error: 'Please wait before trying again.',
          retryAfter: ticket.retryAfter })
      }
      const result = await mailHandler.sendMail(mailAddress)
      if (result.rateLimited) {
        res.set('Retry-After', String(result.retryAfter))
        return res.status(429).send({ success: false, error: 'Please wait before trying again.', retryAfter: result.retryAfter })
      }
      return res.send(result.success ? { success: true, error: null } :
        { success: false, error: 'Unable to send. Please check your address and try later.' })
    } catch (error) {
      return res.status(503).send({ success: false, error: 'Mail temporarily unavailable. Please try later.' })
    } finally {
      if (ticket && ticket.allowed) ticket.release()
    }
  })

  app.get('/svg', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../public/svg.html'))
  })

  app.get('/mail-you', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../public/mail-you.html'))
  })
}
