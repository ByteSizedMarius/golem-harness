'use strict'

// Who took the legs last. A take with no reflex, the pilot's stop, names nobody.
function legLedger () {
  let seq = 0
  let last = null
  return {
    take (reflex, why = null) {
      seq++
      last = reflex ? { reflex, why } : null
    },
    mark () {
      return seq
    },
    // The take after mark, or null.
    takenSince (m) {
      return seq > m ? last : null
    }
  }
}

function takenText ({ reflex, why }) {
  return `the ${reflex} reflex took the legs${why ? ` to ${why}` : ''}`
}

// klass: 'discretionary' | 'interrupt' | 'emergency'. A running job keeps the legs from all but
// emergencies until a threat stands in melee range.
function laneBlocks ({ klass, bunker, laneHeld, hard, jobRunning, meleeThreat }) {
  if (bunker) return true
  if (klass === 'emergency') return false
  if (jobRunning && !meleeThreat) return true
  if (!laneHeld) return false
  if (klass === 'interrupt') return hard
  return true
}

module.exports = { legLedger, takenText, laneBlocks }
