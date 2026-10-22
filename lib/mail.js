const {
  SMTP_CONF,
  VERIFIER,
  MAIL_STATUS,
  MAILOPTIONS,
  APIKEY,
  AUTO_SEND,
} = require('../config')
const appDebug = require('debug')('app:debug')
const appError = require('debug')('app:error')
const nodemailer = require('nodemailer')
//const SIB = require('sib-api-v3-sdk')
const mailContent = require('./mail-content')
const AddrGenerator = require('./mail-address-generator')
const boundedVerifier = require('./mailVerifier')
const createSmtpBudget = require('./smtpBudget')
const { mailAddress: normalizeAddress } = require('./publicSafety')
//const moment = require('moment')
//require('moment-range')

const transporter = nodemailer.createTransport({ ...SMTP_CONF,
  connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000 })

//const SibApiV3 = require('sib-api-v3-sdk')
//const defaultClient = SibApiV3.ApiClient.instance
//const apiKey = defaultClient.authentications['api-key']
//apiKey.apiKey = APIKEY
//
//const accountsAPI = new SibApiV3.AccountApi()
//const CampaignsAPI = new SibApiV3.EmailCampaignsApi()

async function verify(mailAddress) {
  return boundedVerifier.verify(mailAddress, VERIFIER)
}

module.exports = class Mail {
  constructor(db, options = {}) {
    this.db = db
    this.smtpBudget = options.smtpBudget || createSmtpBudget()
    const automatic = options.autoConfig || AUTO_SEND
    this.autoPolicy = null
    this.autoStopped = false
    this.nextAutomaticAt = 0
    this.now = options.now || Date.now
    if (automatic && automatic.enabled === true && ['test-once', 'allowlist'].includes(automatic.mode) &&
        typeof automatic.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(automatic.runId) &&
        Array.isArray(automatic.allowlist) && automatic.allowlist.length > 0 && automatic.allowlist.length <= 10) {
      const addresses = automatic.allowlist.map(normalizeAddress)
      if (addresses.every(Boolean)) this.autoPolicy = { runId: automatic.runId,
        once: automatic.mode === 'test-once', addresses: Array.from(new Set(addresses)) }
    }
    this.autoIndex = 0
    //    this.io = io
    return this
  }

  async checkMail(mAddr, persist = true) {
    const mailAddress = mAddr || AddrGenerator.gen()
    const vInfo = await verify(mailAddress)
    if (!vInfo || typeof vInfo.success !== 'boolean') throw new Error('Verification unavailable')
    if (persist) await this.db.insertOne({
      created_at: new Date(),
      to: mailAddress,
      status: vInfo.success ? MAIL_STATUS.VERIFIED : MAIL_STATUS.NOT_EXISTS,
    })
    return {
      success: vInfo.success,
      mailAddr: mailAddress,
      status: vInfo.success ? MAIL_STATUS.VERIFIED : MAIL_STATUS.NOT_EXISTS,
    }
  }

  async tryAutomatic(shouldSend) {
    if (!this.autoPolicy || this.autoStopped || this.now() < this.nextAutomaticAt || !shouldSend()) return null
    const policy = this.autoPolicy
    this.nextAutomaticAt = this.now() + 5 * 60 * 1000
    let ticket
    try { ticket = this.smtpBudget.beginAutomatic(policy.runId, policy.once) } catch (_) {
      this.autoStopped = true; return { recorded: false, automaticUnavailable: true }
    }
    if (!ticket.allowed) {
      if (ticket.disabled) this.autoStopped = true
      if (ticket.retryAfter) this.nextAutomaticAt = this.now() + ticket.retryAfter * 1000
      return null
    }
    const recipient = policy.addresses[this.autoIndex++ % policy.addresses.length]
    let result, outcome
    try {
      result = await this.sendMail(recipient, { automatic: true, shouldSend })
      outcome = result.rateLimited ? 'quota-denied' : result.cancelled ? 'cancelled' :
        result.success ? 'sent' : result.deliveryUnconfirmed ? 'record-unconfirmed' : result.smtpAttempted ? 'smtp-failed' : 'rejected'
    } catch (error) {
      outcome = error.smtpAttempted ? 'record-unconfirmed' :
        error.code === 'SMTP_BUDGET_UNAVAILABLE' ? 'budget-unavailable' : 'verification-unavailable'
      result = { recorded: false, automaticUnavailable: true }
    }
    try { this.smtpBudget.finishAutomatic(policy.runId, outcome) } catch (_) { this.autoStopped = true }
    if (policy.once || !['sent', 'cancelled', 'quota-denied'].includes(outcome)) this.autoStopped = true
    return result
  }

  async sendMail(mAddr, options = {}) {
    if (options.automatic && (!this.autoPolicy || !this.autoPolicy.addresses.includes(normalizeAddress(mAddr)))) {
      throw new Error('Automatic recipient is not permitted')
    }
    let result = { success: false, error: null }
    const { success, mailAddr } = await this.checkMail(mAddr, false)
    result.mailAddr = mailAddr
    result.smtpAttempted = false
    if (success) {
      if (options.automatic && (!options.shouldSend || !options.shouldSend())) {
        result.cancelled = true
        result.error = 'No active visitor for this automatic attempt.'
      } else {
        // This shared persistent reservation is immediately before delivery,
        // after verification. RCPT exploration is not a delivery attempt.
        const ticket = this.smtpBudget.reserve(options.automatic ? 'automatic' : 'manual')
        if (!ticket.allowed) return { ...result, recorded: false, rateLimited: true, retryAfter: ticket.retryAfter }
        result.smtpAttempted = true
        try {
          // Explicit SMTP envelope prevents inherited cc/bcc/envelope/header
          // recipients from bypassing the single validated destination.
          const delivery = { ...MAILOPTIONS, to: mailAddr, html: mailContent,
            envelope: { from: MAILOPTIONS.from, to: [mailAddr] } }
          delete delivery.cc
          delete delivery.bcc
          await transporter.sendMail(delivery)
          result.success = true
        } catch (_) {
          // A connection can fail after DATA was accepted. Without a confirmed
          // response, preserve uncertainty and never infer non-delivery/retry.
          result.deliveryUnconfirmed = true
          result.error = 'SMTP delivery could not be confirmed.'
        }
        try { this.smtpBudget.finish(ticket.id, result.success ? 'sent' : 'uncertain') } catch (_) {
          // Reservation remains spent even when recording the delivery outcome
          // fails. Do not retransmit; preserve any known SMTP result below.
          appError('SMTP_BUDGET_FINALIZE_FAILED')
        }
      }
    } else {
      result.error = 'Something Wrong, Please Check Your Input!'
    }
    // One attempt has one final status. Never count the preliminary accepted
    // verification and the successful send as two independent attempts.
    result.status = result.success ? MAIL_STATUS.SENT : success ? MAIL_STATUS.VERIFIED : MAIL_STATUS.NOT_EXISTS
    try { await this.db.insertOne({ created_at: new Date(), to: mailAddr, status: result.status }) } catch (_) {
      const error = new Error('Record outcome unavailable; do not resend automatically.')
      error.smtpAttempted = result.smtpAttempted; throw error
    }
    result.recorded = true
    return result
  }
}
