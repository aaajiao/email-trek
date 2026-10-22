'use strict'

// Local compatibility patch of email-verify 0.2.1 (ISC); see adjacent LICENSE.
// Keep its validation, domain/MX selection, and SMTP command sequence.
// Parse complete SMTP replies strictly and expose whether RCPT was reached.

let validator = require('module').createRequire(require.resolve('email-verify'))('validator').isEmail,
    dns = require('dns'),
    net = require('net'),
    logger = { info() {}, error() {}, server() {}, client() {} }

const defaultOptions = {
  port: 25,
  sender: 'name@example.org',
  timeout: 0,
  fqdn: 'mail.example.org',
  ignore: false
}

const errors = {
  missing: {
    email: 'Missing email parameter',
    options: 'Missing options parameter',
    callback: 'Missing callback function'
  },
  invalid: {
    email: 'Invalid Email Structure'
  },
  exception: {

  }
}

const infoCodes = {
    finishedVerification: 1,
    invalidEmailStructure: 2,
    noMxRecords: 3,
    SMTPConnectionTimeout: 4,
    domainNotFound: 5,
    SMTPConnectionError: 6
}

function optionsDefaults(options) {
  if( !options ) options = {}
  Object.keys(defaultOptions).forEach(function(key){
    if(options && !options[key]) options[key] = defaultOptions[key]
  })
  return options
}

function dnsConfig(options){
  try {
    if( Array.isArray(options.dns) ) dns.setServers(options.dns)
    else dns.setServers([options.dns])
  }
  catch(e){
    throw new Error('Invalid DNS Options');
  }
}

/*
  Ideally you give the arguments as in the function signature. However, other valid signatures would include:

  email,callback (using default options, not advised)

  options,callback (using options.email for the email)

  This is supporting the legacy (email,options,callback) as well as the (options,callback) that is promisify compatible

*/

module.exports.verify = function verify(email,options,callback){
  let params = {}
  let args = (arguments.length === 1 ? [arguments[0]] : Array.apply(null, arguments))

  args.forEach(function(arg){
    if( typeof arg === 'string' ){
      params.email = arg
    }
    else if( typeof arg === 'object' ){
      params.options = arg
    }
    else if( typeof arg === 'function' ){
      params.callback = arg
    }
  })

  if( !params.email && params.options.email && typeof params.options.email === 'string' ) params.email = params.options.email
  params.options = optionsDefaults(params.options)

  if( !params.email ) throw new Error(errors.missing.email)
  if( !params.options ) throw new Error(errors.missing.options)
  if( !params.callback ) throw new Error(errors.missing.callback)

  if( !validator(params.email) ) return params.callback(null, { success: false, info: 'Invalid Email Structure', addr: email, params: params, code: infoCodes.invalidEmailStructure })

  if( params.options.dns ) dnsConfig(params.options)

  logger.info("# Veryfing " + params.email)

  startDNSQueries(params)

}

module.exports.verifyCodes = infoCodes;

function startDNSQueries(params){
  let domain = params.email.split(/[@]/).splice(-1)[0].toLowerCase()

  logger.info("Resolving DNS... " + domain)
  dns.resolveMx(domain,(err,addresses) => {
    if (err || (typeof addresses === 'undefined')) {
      params.callback(err, { success: false, info: 'Domain not found', code: infoCodes.domainNotFound });
    }
    else if (addresses && addresses.length <= 0) {
      params.callback(null, { success: false, info: 'No MX Records', code: infoCodes.noMxRecords });
    }
    else{
      params.addresses = addresses

      // Find the lowest priority mail server
      let priority = 10000,
          lowestPriorityIndex = 0

      for (let i = 0 ; i < addresses.length ; i++) {
        if (addresses[i].priority < priority) {
            priority = addresses[i].priority
            lowestPriorityIndex = i
            logger.info('MX Records ' + JSON.stringify(addresses[i]))
        }
      }

      params.options.smtp = addresses[lowestPriorityIndex].exchange
      logger.info("Choosing " + params.options.smtp + " for connection")
      beginSMTPQueries(params)
    }


  })
}

function beginSMTPQueries(params) {
  let stage = 0, ended = false, success = false, rcptReplyCode = null
  let buffer = '', replyCode = null
  const phases = ['greeting', 'ehlo', 'mail_from', 'rcpt', 'quit']
  const socket = net.createConnection(params.options.port, params.options.smtp)

  function finish(error, code, temporary = false) {
    if (ended) return
    ended = true
    params.callback(error, { success, code, tryagain: temporary,
      stage: phases[stage], rcptReplyCode })
  }
  function protocolFailure() {
    finish(null, infoCodes.finishedVerification, true)
    socket.destroy()
  }
  function send(text, nextStage) {
    stage = nextStage
    socket.write(text)
  }
  function reply(code) {
    if (ended) return
    if (stage === 0) {
      if (code === 220) send('EHLO ' + params.options.fqdn + '\r\n', 1)
      else { finish(null, infoCodes.finishedVerification, true); socket.end() }
    } else if (stage === 1) {
      if (code === 250) send('MAIL FROM:<' + params.options.sender + '>\r\n', 2)
      else { finish(null, infoCodes.finishedVerification, true); socket.end() }
    } else if (stage === 2) {
      if (code === 250) send('RCPT TO:<' + params.email + '>\r\n', 3)
      else { finish(null, infoCodes.finishedVerification, true); socket.end() }
    } else if (stage === 3) {
      rcptReplyCode = code
      success = code === 250
      // A 4xx response is temporary; a 5xx response is rejection, not proof
      // that the mailbox does not exist. The UI retains its historical glyph.
      send('QUIT\r\n', 4)
    } else socket.end()
  }

  if (params.options.timeout > 0) socket.setTimeout(params.options.timeout, () => {
    finish(null, infoCodes.SMTPConnectionTimeout, true)
    socket.destroy()
  })
  socket.on('data', data => {
    if (ended) return
    buffer += data.toString()
    if (buffer.length > 65536) return protocolFailure()
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1 && !ended) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line)
      if (!match) return protocolFailure()
      const code = Number(match[1])
      if (replyCode !== null && replyCode !== code) return protocolFailure()
      replyCode = code
      // A hyphen continues a multiline reply; wait for the same code + space.
      if (match[2] !== '-') { replyCode = null; reply(code) }
    }
  })
  socket.once('error', error => finish(error, infoCodes.SMTPConnectionError, true))
  socket.once('end', () => {
    if (buffer || replyCode !== null) return protocolFailure()
    finish(null, infoCodes.finishedVerification,
      rcptReplyCode === null || (rcptReplyCode >= 400 && rcptReplyCode < 500))
  })
  socket.once('close', () => {
    // Some failures close without end/error; never leave the queue pending.
    if (!ended) finish(null, infoCodes.SMTPConnectionError, true)
  })
}
