'use strict'

const MAX_EXPORT_RECORDS = 100000
const REQUEST_PAGE_SIZE = 2000
const SVG_NS = 'http://www.w3.org/2000/svg'
let exportRecords = []
let exportBusy = false
let exportUrls = []
const originalPageNotice = $('#pages-limitation').html()

function showExportMessage(message, error) {
  $('#pages-limitation').text(message).attr('role', error ? 'alert' : 'status').show()
}
function setExportBusy(busy, action) {
  exportBusy = busy
  $('#request_button,#generate_button,#limit-select,.limit-options input').prop('disabled', busy)
  $('#request_button').text(busy && action === 'request' ? 'Requesting…' : 'Request')
  $('#generate_button').text(busy && action === 'generate' ? 'Generating…' : 'Generate')
  $('.progress').css('visibility', busy ? 'visible' : 'hidden').attr('aria-busy', String(busy))
}
function clearDownloads() {
  exportUrls.forEach(url => URL.revokeObjectURL(url))
  exportUrls = []
  $('#downloads').empty()
  $('#svg').empty()
}
function pause() { return new Promise(resolve => setTimeout(resolve, 0)) }
function requestPageOnce(limit, skip) {
  return new Promise((resolve, reject) => {
    $.ajax({type: 'POST', url: '/get-data', contentType: 'application/json',
      data: JSON.stringify({limit, skip}), timeout: 30000})
      .done(response => {
        if (!response || response.success !== true || !Array.isArray(response.data)) {
          reject(new Error('Data temporarily unavailable. Please try again.'))
        } else resolve(response.data)
      })
      .fail(xhr => {
        const error = new Error(xhr.status === 429 ? 'Too many requests. Please wait and try again.' : 'Data temporarily unavailable. Please try again.')
        error.status = xhr.status
        error.retryAfter = (xhr.responseJSON || {}).retryAfter || xhr.getResponseHeader('Retry-After')
        reject(error)
      })
  })
}
async function requestPage(limit, skip) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    try { return await requestPageOnce(limit, skip) } catch (error) {
      if (error.status !== 429 || attempt === 3) throw error
      let seconds = Number(error.retryAfter)
      if (!Number.isFinite(seconds) && error.retryAfter) seconds = Math.ceil((Date.parse(error.retryAfter) - Date.now()) / 1000)
      if (!Number.isFinite(seconds) || seconds <= 0) seconds = Math.pow(2, attempt)
      // Respect long server cooldowns by stopping, not retrying before they end.
      if (seconds > 30) throw error
      seconds = Math.max(1, Math.ceil(seconds))
      showExportMessage('Waiting ' + seconds + ' second' + (seconds === 1 ? '' : 's') + ' before retrying this page…', false)
      await new Promise(resolve => setTimeout(resolve, seconds * 1000))
    }
  }
}
async function requestData(limit) {
  const list = []
  const seen = new Set()
  for (let skip = 0; skip < limit; skip += REQUEST_PAGE_SIZE) {
    const size = Math.min(REQUEST_PAGE_SIZE, limit - skip)
    const page = await requestPage(size, skip)
    if (page.length > size) throw new Error('Unexpected data response. Please try again.')
    page.forEach(record => {
      if (!record || typeof record.to !== 'string' || record.to.length > 254 ||
          !['not_exists', 'verified', 'sent'].includes(record.status)) {
        throw new Error('Unexpected data response. Please try again.')
      }
      // The live collection may grow between pages. Do not duplicate a record.
      if (record._id && seen.has(String(record._id))) return
      if (record._id) seen.add(String(record._id))
      list.push({to: record.to, status: record.status})
    })
    $('#progress').css('width', Math.round(Math.min(skip + size, limit) / limit * 100) + '%')
    if (page.length < size) break
  }
  return list
}
function settings() {
  const fields = {width: '#svg-width', height: '#svg-height', padding: '#svg-padding',
    fontSize: '#svg-font-size', lineHeight: '#svg-lineheight'}
  const value = {}
  Object.keys(fields).forEach(key => { value[key] = Number($(fields[key]).val()) })
  if (!Object.keys(value).every(key => Number.isFinite(value[key])) ||
      value.width < 1 || value.width > 20000 || value.height < 1 || value.height > 20000 ||
      value.padding < 0 || value.fontSize < 1 || value.fontSize > 500 ||
      value.lineHeight < 1 || value.lineHeight > 10 ||
      value.width - 2 * value.padding < value.fontSize ||
      value.height - 2 * value.padding < value.fontSize * value.lineHeight) {
    throw new Error('Increase the page size or reduce padding and font size. Line height must be 1–10.')
  }
  return value
}
function svgElement(name, attributes) {
  const element = document.createElementNS(SVG_NS, name)
  Object.keys(attributes || {}).forEach(key => element.setAttribute(key, attributes[key]))
  return element
}
async function generateSVG(records, options) {
  if (document.fonts && document.fonts.load) await document.fonts.load(options.fontSize + 'px "Menlo Regular"')
  const width = options.width - 2 * options.padding
  const height = options.height - 2 * options.padding
  const rowHeight = options.fontSize * options.lineHeight
  const fontStyle = "font-family:'Menlo Regular',Menlo,monospace;font-size:" + options.fontSize + 'px;dominant-baseline:hanging;'
  const measureSvg = svgElement('svg', {width: 0, height: 0})
  const measureText = svgElement('text', {style: fontStyle, 'xml:space': 'preserve'})
  measureSvg.appendChild(measureText)
  document.getElementById('svg').appendChild(measureSvg)
  const widths = new Map()
  function measure(text, bold) {
    const key = (bold ? 'b:' : 'n:') + text
    if (widths.has(key)) return widths.get(key)
    measureText.setAttribute('font-weight', bold ? 'bold' : 'normal')
    measureText.textContent = text
    const result = measureText.getComputedTextLength()
    if (!Number.isFinite(result) || (text && result <= 0)) throw new Error('The export font is not ready. Please try again.')
    widths.set(key, result)
    return result
  }
  let index = 0
  let remainder = ''
  let pageNumber = 0
  try {
    while (index < records.length || remainder) {
      const svg = svgElement('svg', {version: '1.2', xmlns: SVG_NS,
        width: options.width + 'px', height: options.height + 'px',
        viewBox: '0 0 ' + options.width + ' ' + options.height, 'xml:space': 'preserve'})
      svg.appendChild(svgElement('rect', {x: 0, y: 0, width: options.width, height: options.height, fill: 'none'}))
      const text = svgElement('text', {transform: 'translate(' + options.padding + ',' + options.padding + ')', style: fontStyle})
      svg.appendChild(text)
      let x = 0
      let y = 0
      let emitted = 0
      while (index < records.length && y + rowHeight <= height) {
        const record = records[index]
        const bold = record.status === 'sent'
        let content = remainder || record.to
        if (!content) { index++; continue }
        const prefix = x === 0 ? '' : ' '
        if (measure(prefix + content, bold) > width - x && x > 0) { x = 0; y += rowHeight; continue }
        if (measure(content, bold) > width) {
          // Wrap a long shadow across rows instead of hanging or losing it.
          let low = 1, high = content.length
          while (low < high) {
            const mid = Math.ceil((low + high) / 2)
            if (measure(content.slice(0, mid), bold) <= width) low = mid
            else high = mid - 1
          }
          if (measure(content.slice(0, low), bold) > width) throw new Error('Increase page width or reduce font size.')
          remainder = content.slice(low)
          content = content.slice(0, low)
        } else remainder = ''
        const span = svgElement('tspan', {x: x, y: y,
          fill: bold ? 'black' : 'rgb(137,137,137)', 'font-weight': bold ? 'bold' : 'normal'})
        span.textContent = prefix + content
        text.appendChild(span)
        x += measure(prefix + content, bold)
        emitted++
        if (!remainder) index++
        else { x = 0; y += rowHeight }
      }
      if (!emitted && index < records.length) throw new Error('Increase page height or reduce font size.')
      if (!emitted) break
      const serialized = new XMLSerializer().serializeToString(svg)
      const url = URL.createObjectURL(new Blob([serialized], {type: 'image/svg+xml;charset=utf-8'}))
      exportUrls.push(url)
      const link = document.createElement('a')
      pageNumber++
      link.href = url
      link.download = 'records' + pageNumber + '.svg'
      link.textContent = 'down' + pageNumber
      link.setAttribute('aria-label', 'Download SVG page ' + pageNumber)
      document.getElementById('downloads').appendChild(link)
      $('#progress').css('width', Math.round(index / records.length * 100) + '%')
      await pause()
    }
    return pageNumber
  } finally { measureSvg.remove() }
}

$(function () {
  $('#limit-select').on('click', function (event) {
    event.preventDefault()
    if (exportBusy) return
    $('.limit-options').toggle()
    $(this).attr('aria-expanded', String($('.limit-options').is(':visible')))
  })
  $('.limit-options input').on('click', function (event) {
    event.preventDefault()
    if (exportBusy) return
    $('#limit-input').val($(this).val())
    $('.limit-options').hide()
    $('#limit-select').attr('aria-expanded', 'false')
  }).on('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $(this).trigger('click') }
  })
  $('#request_button').on('click', async function (event) {
    event.preventDefault()
    if (exportBusy) return
    const input = String($('#limit-input').val()).trim()
    const limit = Number(input)
    if (!/^[0-9]+$/.test(input) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPORT_RECORDS) {
      $('#limit-input').attr('aria-invalid', 'true')
      showExportMessage('Enter a record count from 1 to 100000.', true)
      return
    }
    $('#limit-input').removeAttr('aria-invalid')
    setExportBusy(true, 'request')
    $('#progress').css('width', '0%')
    try {
      const list = await requestData(limit)
      clearDownloads()
      exportRecords = list
      $('#records').text(list.length)
      $('#data-count').css('visibility', 'visible')
      $('.step2').toggle(list.length > 0)
      $('#pages-limitation').html(originalPageNotice).show()
      if (!list.length) showExportMessage('No records are available yet. Please try again later.', false)
    } catch (error) { showExportMessage(error.message || 'Request failed. Please try again.', true) }
    finally { setExportBusy(false) }
  })
  $('#generate_button').on('click', async function (event) {
    event.preventDefault()
    if (exportBusy || !exportRecords.length) return
    let options
    try { options = settings() } catch (error) { showExportMessage(error.message, true); return }
    clearDownloads()
    setExportBusy(true, 'generate')
    $('#progress').css('width', '0%')
    try {
      const pages = await generateSVG(exportRecords, options)
      showExportMessage(pages + ' SVG page' + (pages === 1 ? '' : 's') + ' ready. Use the links below to save each file.', false)
    } catch (error) { clearDownloads(); showExportMessage(error.message || 'Export failed. Please try again.', true) }
    finally { setExportBusy(false) }
  })
})
window.addEventListener('pagehide', clearDownloads)
