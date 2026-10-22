'use strict'
let strWidth = 70
let strHeight = 17
let socket = io()
//let socket = io.connect('localhost:4000');
let staticMailList = []
let activeMailList = ''
let curCtx = ''
let statisticsReady = false
let COUNT = {
  TOTAL: 0,
  NOT_EXISTS: 0,
  VERIFIED: 0,
  SENT: 0,
}

function updateCount() {
  $('#total').text(statisticsReady ? COUNT.TOTAL : '…')
  $('#not_exists').text(statisticsReady ? COUNT.NOT_EXISTS : '…')
  $('#verified').text(statisticsReady ? COUNT.VERIFIED : '…')
  $('#sent').text(statisticsReady ? COUNT.SENT : '…')
}

function updateMailList(mailAddress) {
  if (!mailAddress) {
    activeMailList += ''
  } else {
    let spc = activeMailList == '' ? '' : ' '
    if (activeMailList.length + mailAddress.length + 2 < strWidth) {
      let fst = mailAddress.slice(-1)
      switch (fst) {
        case '▓':
          activeMailList += spc + mailAddress + '▓'
          break
        case '░':
          activeMailList += spc + mailAddress + '░'
          break
        case '█':
          activeMailList += spc + mailAddress + '█'
          break
        default:
          activeMailList += spc + mailAddress + ';'
      }
      //activeMailList+=spc+mailAddress+";";
    } else {
      activeMailList += ' ' + '█'.repeat(Math.max(0, strWidth - activeMailList.length - 1))
      staticMailList.pop()
      staticMailList.unshift(activeMailList)
      let fst = mailAddress.slice(-1)
      switch (fst) {
        case '▓':
          activeMailList = mailAddress + '▓'
          break
        case '░':
          activeMailList = mailAddress + '░'
          break
        case '█':
          activeMailList = mailAddress + '█'
          break
        default:
          activeMailList = mailAddress + ';'
      }
      //activeMailList = mailAddress+";";
    }
  }
  curCtx = activeMailList + ' '.repeat(Math.max(0, strWidth - activeMailList.length)) + '\n'
  for (let i = 0; i < staticMailList.length; i++) {
    let linebreak = i < staticMailList.length - 1 ? '\n' : ''
    curCtx += staticMailList[i] + linebreak
  }
  $('#data>pre').text(curCtx)
}

function applyStatistics(total) {
  statisticsReady = !!total
  if (total) {
    COUNT.NOT_EXISTS = total.not_exists
    COUNT.VERIFIED = total.verified
    COUNT.SENT = total.sent
    COUNT.TOTAL = COUNT.NOT_EXISTS + COUNT.VERIFIED + COUNT.SENT
  }
  updateCount()
}

// Register immediately: live events can precede the history/statistics query.
socket.on('append', function (data) {
  if (!data || typeof data.mailAddr !== 'string') return
  let content = data.mailAddr
  switch (data.status) {
    case 'not_exists': content = mask('░', content.length); break
    case 'verified': content = mask('▓', content.length); break
    case 'sent': content = mask('█', content.length); break
    default: content = mask('█', content.length)
  }
  // Long valid user addresses cannot make String.repeat receive a negative size.
  while (content.length >= strWidth - 1) {
    updateMailList(content.slice(0, strWidth - 2))
    content = content.slice(strWidth - 2)
  }
  if (content) updateMailList(content)
})
socket.on('stats', function ({ total }) { applyStatistics(total) })
socket.on('init', function ({ total, maskAscii }) {
  if (total) applyStatistics(total)
  staticMailList = (Array.isArray(maskAscii) ? maskAscii : []).slice(0, strHeight - 1).map(line => String(line).slice(0, strWidth).padEnd(strWidth, ' '))
  while (staticMailList.length < strHeight - 1) staticMailList.push(' '.repeat(strWidth))
  updateMailList()
})
applyStatistics(null)

function printArray(array) {
  for (let i = 0; i < array.length; i++) {
    console.log(array[i])
  }
}

function mask(mark, count) {
  'use strict'
  if (mark == null) {
    throw new TypeError("can't convert " + mark + ' to object')
  }
  let str = '' + mark
  count = +count
  if (count !== count) {
    count = 0
  }
  if (count < 0) {
    throw new RangeError('repeat count must be non-negative')
  }
  if (count === Infinity) {
    throw new RangeError('repeat count must be less than infinity')
  }
  count = Math.floor(count)
  if (str.length === 0 || count === 0) {
    return ''
  }
  // Ensuring count is a 31-bit integer allows us to heavily optimize the
  // main part. But anyway, most current (August 2014) browsers can't handle
  // strings 1 << 28 chars or longer, so:
  if (str.length * count >= 1 << 28) {
    throw new RangeError('repeat count must not overflow maximum string size')
  }
  let rpt = ''
  for (;;) {
    if ((count & 1) === 1) {
      rpt += str
    }
    count >>>= 1
    if (count === 0) {
      break
    }
    str += str
  }
  return rpt
}
