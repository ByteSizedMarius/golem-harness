'use strict'

// How long follow waits after a reflex took the legs before it walks again.
const QUIET_MS = 3000
// The wait after the hurt freeze or a lava take.
const LONG_QUIET_MS = 5000
const LONG_QUIET = ['hurt', 'lava_watch']

// Who took the legs last. A take with no reflex, the pilot's stop, names nobody.
function legLedger () {
  let seq = 0
  let last = null
  let lastAt = 0
  return {
    take (reflex, why = null, now = Date.now()) {
      seq++
      last = reflex ? { reflex, why } : null
      lastAt = now
    },
    mark () {
      return seq
    },
    // The take after mark, or null.
    takenSince (m) {
      return seq > m ? last : null
    },
    // When the quiet after the last reflex take ends, 0 when none.
    quietUntil () {
      if (!last) return 0
      return lastAt + (LONG_QUIET.includes(last.reflex) ? LONG_QUIET_MS : QUIET_MS)
    }
  }
}

function takenText ({ reflex, why }) {
  return `the ${reflex} reflex took the legs${why ? ` to ${why}` : ''}`
}

// klass: 'discretionary' | 'interrupt' | 'emergency'. A running job keeps the legs from all but
// emergencies until a threat stands in melee range. A perch keeps them from all but an emergency
// whose threat is in melee reach with health under the disengage line.
function laneBlocks ({ klass, bunker, perch, hpMelee, laneHeld, hard, jobRunning, meleeThreat }) {
  if (bunker) return true
  if (perch && !(klass === 'emergency' && hpMelee)) return true
  if (klass === 'emergency') return false
  if (jobRunning && !meleeThreat) return true
  if (!laneHeld) return false
  if (klass === 'interrupt') return hard
  return true
}

module.exports = { QUIET_MS, LONG_QUIET_MS, legLedger, takenText, laneBlocks }
