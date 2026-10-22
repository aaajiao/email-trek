'use strict'
// Preserve the original desktop/mobile scale while restoring user zoom.
const viewport = document.querySelector('meta[name="viewport"]')
if (viewport) {
  const width = window.screen.width || window.innerWidth
  viewport.setAttribute('content', 'width=device-width, initial-scale=' + (width > 600 ? '1' : '0.5'))
}
document.addEventListener('DOMContentLoaded', function () {
  const readmeSwitch = document.querySelector('#readme_switch p')
  const readme = document.getElementById('readme')
  if (readmeSwitch && readme) {
    readmeSwitch.setAttribute('role', 'button')
    readmeSwitch.setAttribute('tabindex', '0')
    readmeSwitch.setAttribute('aria-controls', 'readme')
    function state() { readmeSwitch.setAttribute('aria-expanded', String(getComputedStyle(readme).display !== 'none')) }
    state()
    new MutationObserver(state).observe(readme, {attributes: true, attributeFilter: ['style']})
    readmeSwitch.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); readmeSwitch.click() }
    })
  }
  document.querySelectorAll('.limit-options input').forEach(function (input) {
    input.setAttribute('role', 'button')
    input.setAttribute('aria-label', input.value + ' records')
  })
})
