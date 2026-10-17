'use strict'

const { laneBlocks: legsLaneBlocks } = require('../legs')

let bot, hpMelee, jobs, meleeThreat, emitEvent

// ---- PILOT LANE: a soft lane defers discretionary reflex goals, a hard one (/brace, /hold) passes only emergencies.
// token is the claim releaseLane may clear.
const pilotLane = { until: 0, why: null, hard: false, narrated: 0, token: null }
// on while /hold runs. The combat reflex leaves every threat but a creeper to it.
const holdRun = { on: false }
// The lane token of the running /strike, null when none runs. The combat reflex only flees while it runs.
const strikeRun = { lane: null }
// Returns the token of this claim.
function claimLane (why, ms, hard = false) {
  pilotLane.until = Date.now() + ms
  pilotLane.why = why
  pilotLane.hard = hard
  pilotLane.token = {}
  return pilotLane.token
}
// Clears the lane only while token is still its claim.
function releaseLane (token) {
  if (token && pilotLane.token === token) clearLane()
}
function clearLane () {
  pilotLane.until = 0
  pilotLane.hard = false
  pilotLane.token = null
}
// The bunker being built, and the cell of the last one the body reached. stop is why the build
// has to end early, set by /stop, by a death and by a mob's hit. mode is the mode being built, and
// reached the blocks the body has risen or sunk so far.
const bunker = { building: false, stop: null, cell: null, mode: null, reached: 0 }
// Stops that end a build and leave the body where it is.
const BUNKER_HALTS = ['stopped by the pilot', 'the body died']
// What a route that walks or digs answers while a bunker is built.
const BUNKER_WALK = 'refused while a bunker is being built, the stop tool ends the build'
// Throws BUNKER_WALK while a bunker is built, unless own marks a step of the build itself.
function refuseWhileBuilding (own = false) {
  if (bunker.building && !own) throw new Error(BUNKER_WALK)
}
// True while a bunker is built or the body still stands in its cell. Flees, cover moves and chases wait then.
function bunkerHolds () {
  if (bunker.building) return true
  if (!bunker.cell) return false
  if (bot.entity && bot.entity.position.floored().equals(bunker.cell)) return true
  bunker.cell = null
  return false
}
// The cell on top of the last pillar the pilot built.
const perch = { cell: null }
function perchHolds () {
  if (!perch.cell) return false
  const at = bot.entity && bot.entity.position.floored()
  // A jump or a knock-up leaves the pillar top straight up.
  if (at && at.x === perch.cell.x && at.z === perch.cell.z && (at.y === perch.cell.y || (!bot.entity.onGround && at.y > perch.cell.y))) return true
  perch.cell = null
  return false
}

const laneBlocks = (klass) => legsLaneBlocks({
  klass,
  bunker: bunkerHolds(),
  perch: perchHolds(),
  hpMelee: hpMelee(),
  laneHeld: Date.now() < pilotLane.until,
  hard: pilotLane.hard,
  jobRunning: jobs.running(),
  meleeThreat: meleeThreat()
})
const laneNarrate = (what) => {
  if (bunkerHolds() || perchHolds()) return
  if (Date.now() - pilotLane.narrated < 6000) return
  pilotLane.narrated = Date.now()
  if (Date.now() >= pilotLane.until && jobs.running()) emitEvent('combat', `${what} deferred, the running job keeps the legs`)
  else emitEvent('combat', `${what} deferred — pilot lane held (${pilotLane.why})`)
}

function createLane (ctx) {
  Object.assign(ctx, { pilotLane, holdRun, strikeRun, claimLane, releaseLane, clearLane, bunker, BUNKER_HALTS, BUNKER_WALK, refuseWhileBuilding, bunkerHolds, perch, perchHolds, laneBlocks, laneNarrate })
}

function bindLane (ctx) {
  ({ bot, hpMelee, jobs, meleeThreat, emitEvent } = ctx)
}

module.exports = { createLane, bindLane }
