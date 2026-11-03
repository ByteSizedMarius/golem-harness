'use strict'

const { goals } = require('mineflayer-pathfinder')
const { PlayerState } = require('prismarine-physics')
const { crumbCentre, nametagGoal } = require('../walk')

let bot, playerEntity, playerSighting, reflexes, ck, bunkerHolds, pilotLane, jobs, verbs, legs, stopPath, emitEvent, walkRoute, doorwayCommit, wayHint, WALK_HINTS, planKnown

// How long the followed player stands still near the body before follow says so.
const FOLLOW_STILL_MS = 5000
// How far the followed player moves before their stillness counts from zero.
const FOLLOW_STILL_SPAN = 1.5
// How long the body stays in a cell no search started from before follow searches again from it.
const FOLLOW_SEARCH_GAP_MS = 500
// How long follow waits after a failed search before it searches again from the same cell.
const FOLLOW_RETRY_MS = 2000
// How many times follow searches again from such a cell before it says no way was found.
const FOLLOW_EMPTY_TRIES = 2
// How far from its cell's edge an edge step stops the body.
const FOLLOW_EDGE_GAP = 0.2
// How long an edge step may last.
const FOLLOW_STEP_MS = 2000

// continuous follow via pathfinder's dynamic GoalFollow (auto-repaths as target moves).
// SUPERVISED since 07-16: bare GoalFollow had no stall recovery — it wedged at the east door
// twice (once mid-emergency; "you do tarry") while /goto's wedge drill sat one verb over.
// A 400ms watcher now runs the same drill (stop → 700ms → doorwayCommit → re-arm) whenever the
// bot stops progressing while the target is beyond range, and quietly re-acquires the target
// entity when it drops out of tracking (one honest event, no alarm spam).
const follow = {}
follow.followState = null
function stopFollow () {
  if (!follow.followState) return
  follow.followState.step?.end()
  try { clearInterval(follow.followState.timer) } catch (e) {}
  bot.removeListener('path_update', follow.followState.onPath)
  follow.followState = null
}
// The followed player's entity and its sighting tier while the bot sees it or its nametag, else null.
function followTarget (st) {
  const ent = playerEntity(st.name)
  const s = ent && playerSighting(ent, reflexes.find(r => r.name === 'combat').fairFill(bot))
  return s ? { ent, tier: s.tier } : null
}
// What the follow goal aims at: the entity in sight, else the cell of its nametag cube centre.
function followAim (t) {
  if (t.tier === 'seen') return t.ent
  const c = crumbCentre(t.ent.position)
  return ck(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z))
}
// st.pathStatus is the status of the last path_update for the goal it set, st.searchT its time.
function armFollow (st, t) {
  st.aim = followAim(t)
  st.goal = t.tier === 'seen' ? new goals.GoalFollow(t.ent, st.range) : nametagGoal(t.ent.position, st.range)
  st.pathStatus = null
  if (!st.onPath) {
    st.onPath = (r) => {
      if (bot.pathfinder.goal !== st.goal) return
      st.pathStatus = r.status
      st.searchT = Date.now()
      searchedFrom(st)
    }
    bot.on('path_update', st.onPath)
  }
  bot.pathfinder.setGoal(st.goal, true)
}
// st.tried holds the cells follow searched from since the goal's target last changed cell.
function searchedFrom (st) {
  const g = st.goal
  const target = ck(g.x, g.y, g.z)
  if (st.tried?.goal !== g || st.tried.target !== target) st.tried = { goal: g, target, from: new Set(), empty: 0, stepped: new Set(), stepT: 0 }
  const p = bot.entity.position.floored()
  st.tried.from.add(ck(p.x, p.y, p.z))
}
// True while follow searches again or waits to.
function searchAgain (st, now) {
  if (st.step) return true
  const p = bot.entity.position.floored()
  const cell = ck(p.x, p.y, p.z)
  const fresh = !st.tried.from.has(cell)
  if (!fresh && !st.tried.stepped.has(cell) && bot.entity.onGround) {
    st.tried.stepped.add(cell)
    if (edgeStep(st, p)) return true
  }
  if (!fresh && st.tried.empty >= FOLLOW_EMPTY_TRIES) return false
  if (fresh ? now - st.cellT < FOLLOW_SEARCH_GAP_MS : now - st.searchT < FOLLOW_RETRY_MS || now - st.tried.stepT < FOLLOW_SEARCH_GAP_MS) return true
  st.tried.empty = fresh ? 0 : st.tried.empty + 1
  st.pathStatus = null
  console.log(`[follow] searching again from ${p.x},${p.y},${p.z}`)
  bot.pathfinder.setGoal(st.goal, true)
  return true
}
// The clear cell within 2 of c and level with it, above an unknown floor within the pathfinder's drop, nearest the goal, or null.
function lipCell (st, c) {
  // True for a cell known to hold nothing the body bumps into or stands on.
  const clear = (p) => {
    const k = planKnown(p)
    if (k !== true) return k === 'air' || k === 'water'
    const b = bot.blockAt(p)
    return b.shapes.length === 0 && !b.name.includes('lava')
  }
  // The first unknown cell below p within the pathfinder's drop, or null when a known floor comes first.
  const hiddenFloor = (p) => {
    for (let d = 1; d <= bot.pathfinder.movements.maxDropDown; d++) {
      const q = p.offset(0, -d, 0)
      if (!planKnown(q)) return q
      if (!clear(q)) return null
    }
    return null
  }
  const g = st.goal
  const goal = { x: g.x + 0.5, y: g.y + 0.5, z: g.z + 0.5 }
  let best = null
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const p = c.offset(dx, 0, dz)
      if ((!dx && !dz) || !clear(p) || !clear(p.offset(0, 1, 0))) continue
      const floor = hiddenFloor(p)
      if (!floor) continue
      const d = p.offset(0.5, 0.5, 0.5).distanceTo(goal)
      if (!best || d < best.d) best = { p, floor, d }
    }
  }
  return best
}
// Starts a walk to FOLLOW_EDGE_GAP from c's edge toward the lip. False when there is no lip or the body is already there.
function edgeStep (st, c) {
  const lip = lipCell(st, c)
  if (!lip) return false
  const f = lip.p
  const p = bot.entity.position.clone()
  const sx = Math.sign(f.x - c.x)
  const sz = Math.sign(f.z - c.z)
  const stop = (s, at, low) => {
    const line = low + 0.5 + s * (0.5 - FOLLOW_EDGE_GAP)
    return s > 0 ? Math.max(at, line) : s < 0 ? Math.min(at, line) : at
  }
  const to = { x: stop(sx, p.x, c.x), z: stop(sz, p.z, c.z) }
  const dist = (q) => Math.hypot(to.x - q.x, to.z - q.z)
  if (dist(p) < 0.05) return false
  const inside = (q) => q.x >= c.x && q.x < c.x + 1 && q.z >= c.z && q.z < c.z + 1 && sx * (q.x - to.x) <= 1e-9 && sz * (q.z - to.z) <= 1e-9
  const world = { getBlock: (b) => bot.blockAt(b, false) }
  const idle = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  // Where the body comes to rest with press held for the next tick only.
  const rest = (press) => {
    const s = new PlayerState(bot, { ...idle, ...press })
    for (let i = 0; i < 40 && (i === 0 || Math.hypot(s.vel.x, s.vel.z) > 1e-3); i++) {
      bot.physics.simulatePlayer(s, world)
      s.control = idle
    }
    return s
  }
  const y = p.y
  const until = Date.now() + FOLLOW_STEP_MS
  const step = {}
  // The controls the step set last.
  let held = idle
  const tick = () => {
    if (follow.followState !== st || bot.pathfinder.goal !== st.goal || bot.pathfinder.isMoving() || followHeld(Date.now()) || Date.now() > until) return step.end()
    const coast = dist(rest({}).pos)
    let best = null
    for (const press of [{ forward: true }, { forward: true, sneak: true }]) {
      const s = rest(press)
      const d = dist(s.pos)
      if (s.onGround && s.pos.y === y && inside(s.pos) && d < coast - 1e-3 && (!best || d < best.d)) best = { press, d }
    }
    held = { ...idle, ...best?.press }
    bot.setControlState('forward', held.forward)
    bot.setControlState('sneak', held.sneak)
    if (!best && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 1e-3) step.end()
  }
  step.end = () => {
    bot.removeListener('physicsTick', tick)
    // Controls changed since the step's last tick belong to whoever took the legs.
    if (!bot.pathfinder.isMoving() && Object.keys(idle).every((k) => !!bot.getControlState(k) === held[k])) {
      bot.setControlState('forward', false)
      bot.setControlState('sneak', false)
    }
    st.step = null
    st.tried.stepT = Date.now()
    const q = bot.entity.position
    console.log(`[follow] edge step toward ${f.x},${f.y},${f.z} ended at ${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}`)
  }
  st.step = step
  console.log(`[follow] edge step from ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} toward ${f.x},${f.y},${f.z}`)
  bot.setControlState('sprint', false)
  bot.look(Math.atan2(p.x - to.x, p.z - to.z), Math.atan2(lip.floor.y + 0.5 - (y + 1.62), Math.hypot(lip.floor.x + 0.5 - p.x, lip.floor.z + 0.5 - p.z)))
  bot.on('physicsTick', tick)
  return true
}
// True while something else owns the legs.
function followHeld (now) {
  const cr = reflexes.find(r => r.name === 'combat')
  if (cr && (cr.active || now < cr._fleeUntil || now < cr._coverUntil)) return true
  if (reflexes.some(r => r.name === 'unstuck' && r.active)) return true
  return bunkerHolds() || now < pilotLane.until || jobs.running() || verbs.running(now) > 0 || now < legs.quietUntil()
}
// The supervisor's 400 ms check. Only unfollow and stop end a follow: arriving, a stall, a fight or a
// lost sight hold it, and it re-arms its goal once the legs are free. st is the follow it belongs to.
async function followTick (st) {
  if (follow.followState !== st || st.drilling) return
  const now = Date.now()
  const rest = () => { st.lastPos = bot.entity.position.clone(); st.lastT = now }
  const c = bot.entity.position.floored()
  if (ck(c.x, c.y, c.z) !== st.cell) {
    st.cell = ck(c.x, c.y, c.z)
    st.cellT = now
  }
  // FOLLOW YIELDS TO COMBAT (07-21: the wedge drill held the legs still on a live creeper
  // fuse, 9.4 through armor).
  if (followHeld(now)) {
    st.stillPos = undefined
    return rest()
  }
  const t = followTarget(st)
  if (!t) {
    st.stillPos = undefined
    // The goal would walk to where the bot cannot see the player.
    if (st.goal && bot.pathfinder.goal === st.goal) stopPath()
    if (!st.lostT) st.lostT = now
    else if (!st.told && now - st.lostT > 12000) {
      st.told = true
      emitEvent('follow', `lost sight of ${st.name}, still following and going on once they show again`)
    }
    return rest()
  }
  if (st.lostT) {
    if (st.told) emitEvent('follow', `${st.name} is back in view, following again`)
    st.lostT = 0
    st.told = false
  }
  const goal = bot.pathfinder.goal
  // A cleared goal re-arms, and so does one whose aim changed: an entity the server replaced, a new nametag cube or tier.
  if (!goal || (goal === st.goal && followAim(t) !== st.aim)) {
    armFollow(st, t)
    return rest()
  }
  // Another walk owns the legs until it clears its goal.
  if (goal !== st.goal) return rest()
  const p = bot.entity.position
  // A body at rest is parked, not wedged: GoalFollow plans again only once the player moves past range.
  const near = t.tier === 'seen' ? t.ent.position.distanceTo(p) <= st.range + 1.5 : goal.isEnd(p.floored())
  // The nametag's 5-block cube is too coarse to tell a stop.
  if (t.tier !== 'seen') st.stillPos = undefined
  else {
    const at = t.ent.position
    if (st.toldPos && at.distanceTo(st.toldPos) > FOLLOW_STILL_SPAN) st.toldPos = undefined
    if (!near) st.stillPos = undefined
    else if (!st.stillPos || at.distanceTo(st.stillPos) > FOLLOW_STILL_SPAN) {
      st.stillPos = at.clone()
      st.stillT = now
    } else if (!st.toldPos && now - st.stillT >= FOLLOW_STILL_MS) {
      st.toldPos = at.clone()
      emitEvent('follow', `${st.name} stopped near you, still following`)
    }
  }
  // After a failed search the pathfinder plans again only once the player moves.
  if (!near && !bot.pathfinder.isMoving() && (st.pathStatus === 'noPath' || st.pathStatus === 'timeout')) {
    if (st.pathStatus === 'noPath' && searchAgain(st, now)) return rest()
    if (now - st.warnT > 30000) {
      st.warnT = now
      const r = t.tier === 'seen' ? { cell: t.ent.position.floored() } : { toward: crumbCentre(t.ent.position) }
      emitEvent('follow', `no way found to ${st.name}: ${wayHint(r) || WALK_HINTS['no-path']}`)
    }
    return rest()
  }
  if (!bot.pathfinder.isMoving() || p.distanceTo(st.lastPos) >= 1.0 || near) return rest()
  if (now - st.lastT < 4500) return       // same patience as stagedGoto (doors-v2 lesson)
  st.drilling = true                      // wedged while the target walks away — the drill
  console.log('[follow] wedged — running the doorway drill')
  try {
    // HARD goal clear, not safeStop: GoalFollow is DYNAMIC — a stop leaves it set and the
    // pathfinder resumes re-planning toward the target DURING the drill, fighting nudgeInto
    // for the control states every tick (found live 07-16: same door, same drill — goto's
    // drill crossed clean, follow's lost the threshold 3x. The legs need ONE owner.)
    try { bot.pathfinder.setGoal(null) } catch (e) {}
    try { bot.clearControlStates() } catch (e) {}
    await new Promise(r => setTimeout(r, 700))
    if (follow.followState !== st || followHeld(Date.now())) return
    // The drill ends with this follow, and when a reflex or another walk takes the legs.
    const route = walkRoute()
    const taken = route.stopped
    route.stopped = () => taken() || follow.followState !== st
    let crossed = false
    try { crossed = !!((await doorwayCommit(route)) || {}).through } catch (e) { console.log('[follow] drill error: ' + e.message) } finally { route.end() }
    if (follow.followState !== st) return
    const live = !followHeld(Date.now()) && followTarget(st)
    if (live) armFollow(st, live)
    st.lastPos = bot.entity.position.clone(); st.lastT = Date.now()
    if (crossed) console.log('[follow] through clean — following resumed')
    else if (Date.now() - st.warnT > 30000) {    // drill keeps retrying ~5s; the EVENT stays rare
      st.warnT = Date.now()
      emitEvent('follow', `wedged following ${st.name} and the doorway drill did not clear it — may need help`)
    }
  } finally { st.drilling = false }
}

function createFollow (ctx) {
  Object.assign(ctx, { follow, stopFollow, followTarget, armFollow, followTick })
}

function bindFollow (ctx) {
  ({ bot, playerEntity, playerSighting, reflexes, ck, bunkerHolds, pilotLane, jobs, verbs, legs, stopPath, emitEvent, walkRoute, doorwayCommit, wayHint, WALK_HINTS, planKnown } = ctx)
}

module.exports = { createFollow, bindFollow }
