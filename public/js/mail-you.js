'use strict'
let mailRequestPending = false
let retryUntil = 0
const $address = $('#address-input')
const $send = $('#address-submit')
const $feedback = $('#mail-feedback')
function mailFeedback(message, error) {
  $feedback.text(message).attr('role', error ? 'alert' : 'status')
}
function isEmail(value) {
  // Match the server's single-address scope; definitive validation stays there.
  if (typeof value !== 'string' || value.length > 254 || /[\s\x00-\x1f\x7f,;<>"\\]/.test(value)) return false
  const parts = value.split('@')
  return parts.length === 2 && parts[0].length > 0 && parts[0].length <= 64 &&
    !parts[0].startsWith('.') && !parts[0].endsWith('.') && !parts[0].includes('..') &&
    parts[1].split('.').length >= 2 && parts[1].split('.').every(label => label.length > 0)
}
function sendMailYou() {
  if (mailRequestPending) return
  if (Date.now() < retryUntil) {
    mailFeedback('Please wait ' + Math.ceil((retryUntil - Date.now()) / 1000) + ' seconds before trying again.', true)
    return
  }
  const address = String($address.val()).trim()
  if (!isEmail(address)) {
    $address.attr('aria-invalid', 'true')
    mailFeedback('Input one valid email address please!', true)
    $address.trigger('focus')
    return
  }
  $address.removeAttr('aria-invalid')
  mailRequestPending = true
  $send.attr({'aria-disabled': 'true', 'aria-busy': 'true'}).text('Sending…')
  mailFeedback('Sending…', false)
  $.ajax({type: 'POST', url: '/mail-you-send', data: {data: address}, timeout: 30000})
    .done(function (response) {
      if (response && response.success === true) {
        mailFeedback('OK! Message sent.', false)
        // Do not erase a new address that was typed while the request ran.
        if (String($address.val()).trim() === address) $address.val('')
      } else mailFeedback(response && response.error || 'Unable to send. Please try again later.', true)
    })
    .fail(function (xhr, status) {
      const response = xhr.responseJSON || {}
      if (xhr.status === 429) {
        const seconds = Number(response.retryAfter || xhr.getResponseHeader('Retry-After'))
        if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) retryUntil = Date.now() + seconds * 1000
      }
      mailFeedback(response.error || (status === 'timeout' ? 'The request timed out. Please try again later.' : 'Please try again later.'), true)
    })
    .always(function () {
      mailRequestPending = false
      $send.attr({'aria-disabled': 'false', 'aria-busy': 'false'}).text('Mail You')
    })
}
$send.on('click', sendMailYou).on('keydown', function (event) {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sendMailYou() }
})
$address.on('keydown', function (event) {
  if (event.key === 'Enter') { event.preventDefault(); sendMailYou() }
}).on('input', function () { $address.removeAttr('aria-invalid') })
