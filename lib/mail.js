const {
  SMTP_CONF,
  VERIFIER,
  MAIL_STATUS,
  MAILOPTIONS,
  APIKEY,
} = require('../config')
const appDebug = require('debug')('app:debug')
const appError = require('debug')('app:error')
const nodemailer = require('nodemailer')
//const SIB = require('sib-api-v3-sdk')
const mailContent = require('./mail-content')
const AddrGenerator = require('./mail-address-generator')
const boundedVerifier = require('./mailVerifier')
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
  constructor(db) {
    this.db = db
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

  async sendMail(mAddr) {
    let result = { success: false, error: null }
    const { success, mailAddr } = await this.checkMail(mAddr, false)
    if (success) {
      try {
        await transporter.sendMail({
          ...MAILOPTIONS,
          to: mailAddr, // list of receivers
          html: mailContent, // html body
        })
        result.success = true
      } catch (err) {
        result.error = err.message
      }
    } else {
      result.error = 'Something Wrong, Please Check Your Input!'
    }
    // One attempt has one final status. Never count the preliminary accepted
    // verification and the successful send as two independent attempts.
    await this.db.insertOne({ created_at: new Date(), to: mailAddr,
      status: result.success ? MAIL_STATUS.SENT : success ? MAIL_STATUS.VERIFIED : MAIL_STATUS.NOT_EXISTS })
    return result
  }
}
