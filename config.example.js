'use strict'

// Copy to config.js outside version control, or bind a private config.js into
// /app/config.js. Production credentials are never part of the image context.
function required(name) {
  if (!process.env[name]) throw new Error('Missing configuration: ' + name)
  return process.env[name]
}

module.exports = {
  APP_PORT: Number(process.env.APP_PORT || 4000),
  STR_WIDTH: 70,
  STR_HEIGHT: 17,
  DEBUG: false,
  MONGO_ADDR: required('MONGO_ADDR'),
  MONGO_DB: process.env.MONGO_DB || 'emailtrek',
  MAIL_STATUS: { NOT_EXISTS: 'not_exists', VERIFIED: 'verified', SENT: 'sent' },
  SMTP_CONF: {
    host: required('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: required('SMTP_USER'), pass: required('SMTP_PASS') },
  },
  VERIFIER: {
    port: 25,
    timeout: 15000,
    fqdn: required('SMTP_HELO'),
    sender: required('MAIL_FROM_ADDRESS'),
  },
  MAILOPTIONS: { from: required('MAIL_FROM'), subject: 'Email Trek' },
}
