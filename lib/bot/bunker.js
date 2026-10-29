'use strict'

const { SHELTER, chooseShelter, babyFlag, upBuildMs, downBuildMs, expireConfirmed, bunkerSummary } = require('../shelter')
const { claimDig, releaseDig, soleClaim } = require('./dig-lock')
const { digLock } = require('./dig-lock')

let bot, BUNKER_REARM_HP, reflexes, emitEvent, takeLegs, BUNKER_HEIGHT, BUNKER_HALTS, AGGRO_CONFIRMED, CONFIRMED_MS, liveEntities, mobClass, entityPerceptible, CONFIRMED_HORIZON, entityEngageable, shared, liquidProblem, pillarHeight, BUNKER_MAX_HEIGHT, digInProblem, pillarProblem, bodyTouches, knownCell, digMs, BUNKER_DIG_MS, bunkerHolds, BUNKER_HP, fight, bunker, guardState, BUNKER_WALK, safeStop, stopFollow, jobs, centerOnCell, digIn, pillarShell, xyz, legs

// bunker: below BUNKER_HP within 15 s of a mob's hit, the body builds the bunker that holds against the mobs near it.
const bunkerReflex = {
  name: 'bunker', on: true, active: false, _spent: false,
  check (bot) {
    // No build or flee while the buried self-rescue digs.
    if (soleClaim()) return false
    if (this._spent && bot.health >= BUNKER_REARM_HP) this._spent = false
    const next = bunkerReflexDecide()
    if (next && next.flee) {
      reflexes.find(r => r.name === 'combat').fleeFrom(bot, next.flee, next.why, 'emergency')
      return false
    }
    return !!(next && next.build)
  },
  async act (bot) {
    this._spent = true
    emitEvent('bunker', `HP ${Math.round(bot.health * 10) / 10} after a mob's hit, building a bunker`)
    takeLegs('bunker', 'build a bunker')
    const built = await buildBunker('auto', BUNKER_HEIGHT)
    emitEvent('bunker', bunkerSummary(built))
    const cause = built.error || (BUNKER_HALTS.includes(built.stopped) ? null : built.stopped)
    const near = cause && shelterInputs('auto').threats[0]
    if (near) reflexes.find(r => r.name === 'combat').fleeFrom(bot, near.entity, `${cause}, fleeing from ${near.name}`, 'emergency')
  }
}

function wireThreatReset () {
  bot.on('death', resetThreatState)
  bot.on('spawn', resetThreatState)
}

// The chooseShelter input for requested where the body stands. Threats come nearest first, each with
// its entity.
function shelterInputs (requested, height = BUNKER_HEIGHT) {
  const here = bot.entity.position
  const now = Date.now()
  const combat = reflexes.find(r => r.name === 'combat')
  const threats = []
  // entityEngageable reads this map too.
  expireConfirmed(AGGRO_CONFIRMED, now, CONFIRMED_MS)
  for (const e of liveEntities()) {
    if (!e.position) continue
    const cls = mobClass(e)
    const confirmed = AGGRO_CONFIRMED.has(e.id)
    if (!(['hostile', 'creeper', 'heavy'].includes(cls) || (cls === 'provokable' && confirmed))) continue
    // A mob that has not hit the body counts only while perceived, at its live position.
    if (!confirmed && e.position.distanceTo(here) > SHELTER.HORIZON) continue
    const seen = entityPerceptible(e, combat.fairFill(bot))
    if (!confirmed && !seen) continue
    // One that hit the body counts out of sight where the body last perceived it, and not at all if it never did.
    const at = combat.perceivedAt(e, seen)
    if (!at) continue
    const dist = at.distanceTo(here)
    if (dist > (confirmed ? CONFIRMED_HORIZON : SHELTER.HORIZON) || !entityEngageable(e)) continue
    const data = shared.mcData && shared.mcData.entitiesByName[e.name]
    threats.push({ name: e.name, baby: babyFlag(e.metadata, data && data.metadataKeys), dist, entity: e })
  }
  threats.sort((a, b) => a.dist - b.dist)
  const liquid = liquidProblem()
  const up = pillarHeight(height)
  const tall = up.height > BUNKER_MAX_HEIGHT && `the pillar takes ${up.height}, more than ${BUNKER_MAX_HEIGHT}`
  const problems = { down: liquid || digInProblem(), up: liquid || tall || pillarProblem(up.height) }
  if (problems.up && !liquid && up.height > height) problems.up += ` (${up.why})`
  const shaft = []
  for (let dy = 1; dy <= SHELTER.SAFE_DEPTH; dy++) shaft.push(bot.blockAt(here.floored().offset(0, -dy, 0)))
  const cellMs = (b) => (bodyTouches(b.position) || knownCell(b.position) ? digMs(b) : BUNKER_DIG_MS)
  const buildMs = { down: problems.down === null ? downBuildMs(shaft.map(cellMs)) : Infinity, up: upBuildMs(up.safe) }
  return { requested, threats, problems, buildMs, up }
}

// The bunker reflex's next step: { build: true }, { flee, why } from the nearest threat, or null.
function bunkerReflexDecide () {
  const combat = reflexes.find(r => r.name === 'combat')
  const reflex = reflexes.find(r => r.name === 'bunker')
  const now = Date.now()
  const playerFlee = combat._fleeCls === 'player' && now - combat._fleeT < 15000
  if (bunkerHolds() || reflex._spent || playerFlee || bot.health >= BUNKER_HP) return null
  if (now - fight.lastHit.t >= 15000 || !['hostile', 'creeper', 'heavy', 'provokable'].includes(fight.lastHit.cls)) return null
  const input = shelterInputs('auto')
  if (!input.threats.length) return null
  const pick = chooseShelter(input)
  if (pick.mode) return { build: true }
  const near = input.threats[0]
  return { flee: near.entity, why: `no bunker at HP ${Math.round(bot.health * 10) / 10} (${pick.refuse}), fleeing from ${near.name}` }
}

// Clears the threat state a death or a dimension change leaves behind.
function resetThreatState () {
  const combat = reflexes.find(r => r.name === 'combat')
  AGGRO_CONFIRMED.clear()
  combat._fleeT = 0
  combat._fleeCls = null
  combat._fleeUntil = 0
  combat._coverUntil = 0
  combat._holdUntil = 0
  fight.lastHit = { dmg: 0, t: 0 }
  reflexes.find(r => r.name === 'bunker')._spent = false
  bunker.cell = null
  guardState.set(false, 'for a death or a dimension change')
  guardState.pilot = false
}

// Builds the bunker chooseShelter picks for mode once the combat reflex has let go. The result names
// its cell, its gaps and the cells to dig to leave, or carries error.
async function buildBunker (mode, height) {
  if (bunker.building) return { error: 'a bunker is already being built' }
  const rescue = soleClaim()
  if (rescue) return { error: `no bunker possible while ${rescue.what} runs` }
  const liquid = liquidProblem()
  if (liquid) return { error: `no bunker possible here (${liquid})` }
  const earlier = bunker.cell
  bunker.building = true
  bunker.stop = null
  bunker.mode = null
  bunker.reached = 0
  let claim = null
  // The dig guard keeps mineflayer's stop on a death off the build's own dig.
  const onDeath = () => {
    bunker.stop = 'the body died'
    if (bot.targetDigBlock && bot.targetDigBlock === claim.block) digLock.rawStop()
  }
  bot.once('death', onDeath)
  const halted = () => ({ mode: bunker.mode, stopped: bunker.stop, reached: bunker.reached, ...(bunker.mode === 'up' && { height }) })
  // Until the build ends, any goal but null is refused, goto included.
  const { setGoal, goto, setMovements } = bot.pathfinder
  bot.pathfinder.setGoal = (goal, dynamic) => {
    if (goal) throw new Error(BUNKER_WALK)
    setGoal(goal, dynamic)
  }
  bot.pathfinder.goto = async () => { throw new Error(BUNKER_WALK) }
  // setMovements clears the control states. Movements set during the build apply when it ends.
  let movements = null
  bot.pathfinder.setMovements = (m) => { movements = m }
  let r = null
  try {
    // Every other dig refuses busy until the build ends.
    claim = claimDig('the bunker build', true)
    claim.sole = true
    claim.stop = () => { bunker.stop = `${claim.takenBy} took over` }
    safeStop()
    // safeStop's stop lands at the next path node, clearing the goal lands it now.
    bot.pathfinder.setGoal(null)
    stopFollow()
    jobs.stopAll()
    bot.stopDigging()
    bot.clearControlStates()
    const combat = reflexes.find(r => r.name === 'combat')
    // A flee or cover move stopped above holds no latch.
    combat._fleeUntil = 0
    combat._coverUntil = 0
    for (let i = 0; i < 60 && combat.active; i++) await bot.waitForTicks(1)
    // A down pick centres the body and picks again. Nothing waits between the last pick and the build.
    let pick = null
    let input = null
    for (const centre of [false, true]) {
      const centred = !centre || await centerOnCell()
      if (BUNKER_HALTS.includes(bunker.stop)) return halted()
      input = shelterInputs(mode, height)
      if (!centred) input.problems.down = 'cannot stand in the middle of the cell'
      pick = chooseShelter(input)
      if (pick.mode !== 'down') break
    }
    height = input.up.height
    const { down, up } = input.problems
    console.log(`[bunker] ${pick.mode ? `mode ${pick.mode}` : `refused: ${pick.refuse}`}, pillar height ${height}, ${input.up.why}, down ${down || 'buildable'}, up ${up || 'buildable'}`)
    if (pick.refuse) return { error: `no bunker possible here (${pick.refuse})` }
    bunker.mode = pick.mode
    r = pick.mode === 'down' ? await digIn(claim) : await pillarShell(height)
    if (r.stopped && BUNKER_HALTS.includes(bunker.stop)) r.stopped = bunker.stop
    return {
      mode: pick.mode,
      at: xyz(r.at),
      sealed: !r.stopped && r.gaps.length === 0,
      dug: r.dug || 0,
      placed: r.placed,
      ...(pick.mode === 'up' && { height }),
      gaps: (r.gaps || []).map(xyz),
      exit: (r.exit || []).map(xyz),
      stopped: r.stopped,
      ...(r.ended && { ended: r.ended })
    }
  } catch (e) {
    if (BUNKER_HALTS.includes(bunker.stop)) return halted()
    return { error: `the bunker failed: ${e.message}` }
  } finally {
    bot.pathfinder.setGoal = setGoal
    bot.pathfinder.goto = goto
    bot.pathfinder.setMovements = setMovements
    bot.removeListener('death', onDeath)
    bunker.building = false
    bunker.stop = null
    releaseDig(claim)
    // Follow waits out the quiet after a build as after a reflex take.
    legs.take('bunker', 'build a bunker')
    // A refusal, a throw or a stop leaves no cell of this build. An earlier bunker's cell stays.
    if (bunker.cell !== earlier) {
      if (!r || r.stopped) bunker.cell = null
    }
    try { bot.clearControlStates() } catch (e) {}
    if (movements) setMovements(movements)
  }
}

function createBunker (ctx) {
  Object.assign(ctx, { bunkerReflex, shelterInputs, bunkerReflexDecide, resetThreatState, buildBunker })
}

function bindBunker (ctx) {
  ({ bot, BUNKER_REARM_HP, reflexes, emitEvent, takeLegs, BUNKER_HEIGHT, BUNKER_HALTS, AGGRO_CONFIRMED, CONFIRMED_MS, liveEntities, mobClass, entityPerceptible, CONFIRMED_HORIZON, entityEngageable, shared, liquidProblem, pillarHeight, BUNKER_MAX_HEIGHT, digInProblem, pillarProblem, bodyTouches, knownCell, digMs, BUNKER_DIG_MS, bunkerHolds, BUNKER_HP, fight, bunker, guardState, BUNKER_WALK, safeStop, stopFollow, jobs, centerOnCell, digIn, pillarShell, xyz, legs } = ctx)
}

module.exports = { createBunker, bindBunker, wireThreatReset }
