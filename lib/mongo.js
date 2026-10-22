const {
  MONGO_ADDR,
  MONGO_DB,
  MAIL_STATUS,
  STR_WIDTH,
  STR_HEIGHT,
  DEBUG = false,
} = require('../config')
const { Logger, MongoClient, ObjectId } = require('mongodb')
const { maskAddress } = require('./publicSafety')

if (DEBUG) {
  let logCount = 0
  Logger.setCurrentLogger((msg, state) => {
    console.log(`MONGO DB REQUEST ${++logCount}: ${msg}`)
  })
  Logger.setLevel('debug')
  Logger.filter('class', ['Cursor'])
}

const client = new MongoClient(MONGO_ADDR, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
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

