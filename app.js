const path = require('path')
const express = require('express')
const app = express()
const bodyParser = require('body-parser')
const server = require('http').createServer(app)
const io = require('socket.io')(server)

app.use(express.static('public'))
app.use(bodyParser.json({ limit: '8kb' }))
app.use(bodyParser.urlencoded({ extended: false, limit: '8kb', parameterLimit: 16 }))
const setExpressRouter = require('./lib/setExpressRouter')
const setIOEvents = require('./lib/setIOEvents')

const Mail = require('./lib/mail')
const DataBaseHandler = require('./lib/mongo')
const { APP_PORT } = require('./config')
const appDebug = require('debug')('app:debug')
//
//const MAIL_STATUS = {
//  NOT_EXISTS: 'not_exists',
//  VERIFIED: 'verified',
//  SENT: 'sent',
//}

//const verifier = require('email-verify')
//const db = new DB()

//db.setup(checkInternet)

async function startApp() {
  const db = await DataBaseHandler()
  const mailHandler = new Mail(db, io)
  // DNS/SMTP outages belong to individual bounded verifier requests, not HTTP startup.
  setExpressRouter(app, db, mailHandler)
  setIOEvents(io, db, mailHandler)
  server.listen(APP_PORT, function () {
    const port = server.address().port
    appDebug("[INFO APP] 'APP' 运行于 (localhost:%s)", port)
  })
}

;(async () => {
  await startApp().catch(() => { process.exitCode = 1; process.exit(1) })
})()
