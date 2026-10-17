'use strict'

const { goals } = require('mineflayer-pathfinder')
const { crumbCentre, nametagGoal } = require('../walk')

let bot, playerEntity, playerSighting, reflexes, ck, bunkerHolds, pilotLane, jobs, verbs, legs, stopPath, emitEvent, walkRoute, doorwayCommit

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
  try { clearInterval(follow.followState.timer) } catch (e) {}
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
function armFollow (st, t) {
  st.aim = followAim(t)
  st.goal = t.tier === 'seen' ? new goals.GoalFollow(t.ent, st.range) : nametagGoal(t.ent.position, st.range)
  bot.pathfinder.setGoal(st.goal, true)
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
  // FOLLOW YIELDS TO COMBAT (07-21: the wedge drill held the legs still on a live creeper
  // fuse, 9.4 through armor).
  if (followHeld(now)) return rest()
  const t = followTarget(st)
  if (!t) {
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
  Object.assign(ctx, { follow, stopFollow, followTarget, followAim, armFollow, followHeld, followTick })
}

function bindFollow (ctx) {
  ({ bot, playerEntity, playerSighting, reflexes, ck, bunkerHolds, pilotLane, jobs, verbs, legs, stopPath, emitEvent, walkRoute, doorwayCommit } = ctx)
}

module.exports = { createFollow, bindFollow }
