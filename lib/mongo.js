const {
  MONGO_ADDR,
  MONGO_DB,
  STR_WIDTH,
  STR_HEIGHT,
  DEBUG = false,
} = require('../config')
const { MongoClient } = require('mongodb')
const { maskAddress } = require('./publicSafety')

const client = new MongoClient(MONGO_ADDR, {
  // Preserve the old driver's five-connection bound on the small VPS.
  maxPoolSize: 5,
  monitorCommands: DEBUG,
})
  .on('serverOpening', function (event) {
    console.log('received serverOpening')
    console.log(JSON.stringify(event, null, 2))
  })
  .on('serverClosed', function (event) {
    console.log('received serverClosed')
    console.log(JSON.stringify(event, null, 2))
  })
  .on('error', function (error) {
    console.error(error)
  })

if (DEBUG) {
  let logCount = 0
  // Command payloads can contain complete addresses; log only the command name.
  client.on('commandStarted', event => {
    console.log(`MONGO DB REQUEST ${++logCount}: ${event.commandName}`)
  })
}

function genAsciiLines(items) {
  const lines = []
  const width = STR_WIDTH - 1
  let line = ''
  for (const item of items) {
    const masked = maskAddress(item.to, item.status)
    let content = masked + (masked.slice(-1) || '█')
    if (line && line.length + 1 + content.length <= width) line += ' '
    else if (line) { lines.push(line.padEnd(width, '█')); line = '' }
    while (content.length > width) {
      lines.push(content.slice(0, width)); content = content.slice(width)
      if (lines.length >= STR_HEIGHT - 1) return lines.slice(0, STR_HEIGHT - 1)
    }
    line += content
    if (lines.length >= STR_HEIGHT - 1) break
  }
  if (line && lines.length < STR_HEIGHT - 1) lines.push(line.padEnd(width, '█'))
  return lines.slice(0, STR_HEIGHT - 1)
}

module.exports = async () => {
  try {
    await client.connect()
    const store = await require('./boundedStore').create(client.db(MONGO_DB))
    return { ...store, genAscii: async () => genAsciiLines(await store.getLimit()) }

  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

