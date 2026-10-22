'use strict'

const net = require('net')
const { domainToASCII } = require('url')

function normalizeIP(value) {
  if (typeof value !== 'string') return null
  let ip = value.trim()
  if (ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7)
  if (!net.isIP(ip)) return null
  // WHATWG URL canonicalizes equivalent IPv6 spellings for quota keys.
  if (net.isIP(ip) === 6) ip = new URL('http://[' + ip + ']/').hostname.slice(1, -1)
  return ip.toLowerCase()
}

function clientIP(req) {
  const peer = normalizeIP(req.socket && req.socket.remoteAddress)
  const trusted = (process.env.EMAILTREK_TRUSTED_PROXY_IPS || '')
    .split(',').map(normalizeIP).filter(Boolean)
  // No wildcard trust and never use X-Forwarded-For. Deployment supplies only
  // the exact host/bridge peer through which Nginx reaches this container.
  if (peer && trusted.includes(peer)) {
    return normalizeIP(req.headers && req.headers['x-real-ip'])
  }
  return peer
}

function mailAddress(value) {
  if (typeof value !== 'string' || value.length > 254) return null
  const input = value.trim()
  if (!input || /[\s\x00-\x1f\x7f,;<>"\\]/.test(input)) return null
  const parts = input.split('@')
  if (parts.length !== 2 || Buffer.byteLength(parts[0], 'utf8') > 64) return null
  const local = parts[0]
  if (!local || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null
  if (!/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~\u0080-\uffff]+$/.test(local)) return null
  const domain = domainToASCII(parts[1]).toLowerCase()
  const labels = domain.split('.')
  if (labels.length < 2 || labels.some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
  const result = local + '@' + domain
  return Buffer.byteLength(result, 'utf8') <= 254 ? result : null
}

function pageNumber(value, min, max) {
  if (typeof value !== 'number' &&
      !(typeof value === 'string' && /^(0|[1-9][0-9]{0,5})$/.test(value))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null
}

function maskAddress(value, status) {
  const marker = { not_exists: '░', verified: '▓', sent: '█' }[status] || '█'
  return marker.repeat(typeof value === 'string' ? Math.min(value.length, 254) : 0)
}

function exportRecord(record) {
  return {
    _id: record._id,
    created_at: record.created_at,
    // The artwork SVG intentionally exports complete addresses.
    to: record.to,
    status: record.status,
  }
}

function publicResult(result) {
  return { success: result.success === true,
    mailAddr: maskAddress(result.mailAddr, result.status), status: result.status }
}

module.exports = { clientIP, mailAddress, pageNumber, maskAddress, exportRecord, publicResult }
