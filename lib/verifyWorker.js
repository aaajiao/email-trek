'use strict'

const { parentPort } = require('worker_threads')
const verifier = require('./legacySmtpVerifier')

parentPort.on('message', ({ id, address, settings }) => {
  let finished = false
  function done(error, info) {
    if (finished) return
    finished = true
    if (error || !info || typeof info.success !== 'boolean') {
      parentPort.postMessage({ id, error: 'VERIFY_FAILED' })
    } else if ([4, 6].includes(info.code) || info.tryagain ||
        !(info.success === true && info.rcptReplyCode === 250) &&
        !(info.success === false && info.rcptReplyCode >= 500 && info.rcptReplyCode <= 599)) {
      // A transport failure is not evidence that a mailbox does not exist.
      parentPort.postMessage({ id, error: 'VERIFY_TEMPORARY_FAILURE' })
    } else {
      parentPort.postMessage({ id, info: { success: info.success, code: info.code, stage: info.stage, rcptReplyCode: info.rcptReplyCode } })
    }
  }
  try {
    const result = verifier.verify(address, settings, done)
    // The installed callback API returns undefined; guard a future async throw.
    if (result && typeof result.catch === 'function') result.catch(error => done(error))
  } catch (error) { done(error) }
})
