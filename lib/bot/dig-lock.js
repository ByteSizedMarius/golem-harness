'use strict'

// The claim of the running dig, null when none runs.
const digLock = { holder: null }

function claimDig (what, take = false) {
  const held = digLock.holder
  if (held && !take) throw Object.assign(new Error(`busy: ${held.what} is running, nothing dug`), { reason: 'busy' })
  if (held) {
    held.takenBy = what
    if (held.stop) held.stop()
  }
  digLock.holder = { what, takenBy: null, stop: null }
  return digLock.holder
}

function releaseDig (claim) {
  if (claim && digLock.holder === claim) digLock.holder = null
}

module.exports = { digLock, claimDig, releaseDig }
