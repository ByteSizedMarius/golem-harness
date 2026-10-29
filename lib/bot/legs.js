'use strict'

const { Movements, goals } = require('mineflayer-pathfinder')
const { AsyncLocalStorage } = require('async_hooks')
const { Vec3 } = require('vec3')
const { standCell, resolveTarget, crumbCentre, arrivedAt, walkAttempt, routeDeadline, guardWork } = require('../walk')
const { summarizePlan, planRisk, inCreeperZone, zoneCrossed } = require('../plan')
const { isDoor, doorStep, panelAcross, doorCrossing, PLATE_WAIT_TICKS } = require('../doors')
const { noJumpReason, passedNodes, step: nodeStep } = require('../sprint')
const { legLedger, takenText } = require('../leg-ledger')
const { BUNKER_WALK } = require('./lane')
const { entityInCell } = require('../shelter')
const { sameVein } = require('../wake')
const { LEGACY_1710 } = require('./config')
const { LEGACY_DOOR_TOGGLE_MS } = require('./legacy-1710')
const { digBusy } = require('./dig-lock')

let bot, shared, seenNow, ck, knownCell, yieldJob, floodPassable, airFlood, emitEvent, bodyTouches, reflexes, waypoints, playerEntity, playerCrumbs, entityPerceptible, nametagVisible, nearestVisible, findVisible, resolveBlockIds, cellKnown, round, compass, bunker, gridWalk, lineCell, oreIds, holdCollectTool, digToolFor

const navPlaced = []   // blocks the pathfinder placed as scaffolding, awaiting /tidy cleanup

// ---- collectBlock cage (07-20): mineflayer-collectblock's collect() installs ITS OWN default
// Movements (canDig=true, dontCreateFlow=false!) into the shared pathfinder and NEVER restores
// ours — every /mine, /tidy, and table-reclaim silently swapped my legs for wall-eating legs,
// and every walk afterward could carve through builds (the house-hole culprit — found because
// the helmsman kept finding fresh holes). Its target gate needs canDig=true (safeToBreak
// hard-returns false otherwise), so it can't just wear the considerate profile: hand it
// disposable legs that may break ONLY the target's block type (+ leaves, for canopy
// approaches), and ALWAYS give the pathfinder back the legs it was wearing before.
// A second collect throws busy, or with wait queues behind the running one until it ends or stopCollect refuses it.
async function collectSafely (block, what, { wait = false, silk = false } = {}) {
  digBusy()
  const stops = collectLock.stops
  const stopped = () => Object.assign(new Error('stopped'), { reason: 'stopped' })
  while (collectLock.done) {
    if (!wait) throw collectBusy()
    await collectLock.done
    if (collectLock.stops !== stops) throw stopped()
  }
  const prev = bot.pathfinder.movements   // considerate normally; forestry mid-/gather
  const cage = knownMoves(new Movements(bot))
  cage.canDig = true
  cage.maxDropDown = 4   // the feet drop at most 3 blocks
  cage.liquidCost = 15
  cage.allow1by1towers = false
  cage.allowParkour = true
  cage.scafoldingBlocks = []
  const cant = new Set()
  for (const blk of shared.mcData.blocksArray) {
    if (blk.id === block.type) continue
    if (/_leaves$/.test(blk.name)) continue
    cant.add(blk.id)
  }
  cage.blocksCantBreak = cant
  shared.mcData.blocksArray.forEach(b => { if (b.name.endsWith('_door') && !b.name.includes('iron')) cage.openable.add(b.id) })
  cage.canOpenDoors = true
  bot.collectBlock.movements = cage
  const { equipForBlock } = bot.tool
  const { bestHarvestTool } = bot.pathfinder
  bot.tool.equipForBlock = (b) => holdCollectTool(b, silk)
  bot.pathfinder.bestHarvestTool = (b) => digToolFor(b, { silk: silk && b.type === block.type })
  let release
  collectLock.what = what
  collectLock.done = new Promise((resolve) => { release = resolve })
  try {
    const r = await watchedWork(() => bot.collectBlock.collect(block), abandonCollect)
      .catch((e) => { if (collectLock.stops === stops) throw e })
    if (collectLock.stops !== stops) throw stopped()
    return r
  } finally {
    bot.collectBlock.movements = null   // no stale cage lingering inside the plugin
    bot.tool.equipForBlock = equipForBlock
    bot.pathfinder.bestHarvestTool = bestHarvestTool
    if (prev) bot.pathfinder.setMovements(prev)
    collectLock.what = collectLock.done = null
    release()
  }
}
// The running collect (who runs it and a promise that settles when it ends) and the count of stopCollect calls.
const collectLock = { what: null, done: null, stops: 0 }
function collectBusy () {
  return Object.assign(new Error(`busy: ${collectLock.what} is collecting`), { reason: 'busy' })
}
// Ends the running collect and refuses the ones waiting for it.
function stopCollect () {
  collectLock.stops++
  if (collectLock.done) abandonCollect()
}
// How long one collect or approach may stand without progress, and how long it may take at most.
const COLLECT_STALL_MS = 4500
const COLLECT_BUDGET_MS = 60000
// True inside a watchedWork, whose gotos need no watch of their own.
const watchScope = new AsyncLocalStorage()
// Runs work under a stall watch and the budget of one collect, and stop ends it when either trips.
// A dig counts as progress.
function watchedWork (work, stop) {
  return guardWork(() => watchScope.run(true, work), {
    position: () => bot.entity.position,
    onPathUpdate: (fn) => {
      bot.on('path_update', fn)
      return () => bot.removeListener('path_update', fn)
    },
    busy: () => !!bot.targetDigBlock,
    stop,
    stallMs: COLLECT_STALL_MS,
    thinkTimeout: bot.pathfinder.thinkTimeout,
    budgetMs: COLLECT_BUDGET_MS
  }).catch((e) => {
    if (e.reason !== 'stalled') throw e
    const text = stallText()
    console.log('[path] ' + text)
    throw Object.assign(new Error(text), { reason: 'stalled' })
  })
}
function stallText () {
  const p = bot.entity.position
  const feet = p.floored()
  const at = `stalled at ${feet.x},${feet.y},${feet.z}`
  const ahead = (dy) => new Vec3(Math.floor(p.x - Math.sin(bot.entity.yaw)), feet.y + dy, Math.floor(p.z - Math.cos(bot.entity.yaw)))
  for (const c of [ahead(0), ahead(1)]) {
    const b = bot.blockAt(c)
    if (b && b.boundingBox === 'block' && seenNow(c)) return `${at} against ${b.name} at ${c.x},${c.y},${c.z}`
  }
  return at
}
function watchGoto (goto) {
  return (goal) => watchScope.getStore() ? goto(goal) : watchedWork(() => goto(goal), stopPath)
}
// A goal for a body in bed leaves the bed first. The server ignores a sleeper's movement.
function leaveBedFirst (setGoal) {
  return (goal, dynamic) => {
    if (goal && bot.isSleeping) bot.wake().catch((e) => console.log(`[bed] leaving the bed failed: ${e.message}`))
    return setGoal(goal, dynamic)
  }
}
function walkGaveUp (e) {
  return e.reason ? { reason: e.reason, hint: e.message } : null
}
// Ends a collect the watch gave up on: its walk, its dig and its wait for a drop pickup.
function abandonCollect () {
  stopPath()
  if (bot.targetDigBlock) bot.stopDigging()
  // A pickup wait that resumes later finds its list cleared and ends.
  const Targets = bot.collectBlock.targets.constructor
  bot.collectBlock.targets.clear()
  bot.collectBlock.targets = new Targets(bot)
}

// knownCell of each cell knownMoves read this physics tick, by ck key.
const PLAN_KNOWN = new Map()
function wirePlanKnownReset () {
  bot.on('physicsTick', () => PLAN_KNOWN.clear())
}
// Makes m read a cell knownCell rejects as an unloaded one.
function knownMoves (m) {
  const getBlock = m.getBlock.bind(m)
  m.getBlock = (pos, dx, dy, dz) => {
    const b = getBlock(pos, dx, dy, dz)
    // An unloaded cell keeps the pathfinder's reading, neither floor nor way.
    if (!b.position) return b
    const p = b.position
    const k = ck(p.x, p.y, p.z)
    let known = PLAN_KNOWN.get(k)
    if (known === undefined) PLAN_KNOWN.set(k, known = knownCell(p))
    if (known) return b
    return { position: p, type: null, name: 'unknown', safe: false, physical: false, replaceable: false, liquid: false, climbable: false, canFall: false, openable: false, height: p.y + 1 }
  }
  return swimCosts(m)
}
// Makes m charge liquidCost for a move into deep water (water with water above it or no full collision box below) from a cell that is not liquid.
function swimCosts (m) {
  const getNeighbors = m.getNeighbors
  m.getNeighbors = (node) => {
    const moves = getNeighbors.call(m, node)
    if (m.getBlock(node, 0, 0, 0).liquid) return moves
    for (const move of moves) {
      if (m.getBlock(move, 0, 0, 0).name !== 'water') continue
      if (m.getBlock(move, 0, 1, 0).name === 'water' || m.getBlock(move, 0, -1, 0).boundingBox !== 'block') move.cost += m.liquidCost
    }
    return moves
  }
  return m
}

// Each take of the legs ends every walk route begun before it.
const legs = legLedger()

// A reflex takes the legs from every walk route and from the running job.
function takeLegs (reflex, why) {
  legs.take(reflex, why)
  yieldJob(reflex, why)
}

// ---- reachability pre-check for /goto over knownCell cells.
function airPrecheck(dest, range = 1) {
  try {
    const t0 = Date.now()
    const d0 = dest.floored()
    if (!bot.blockAt(d0)) return { verdict: 'inconclusive', why: 'goal chunk not loaded' }
    const r = Math.max(1, Math.min(3, range))
    const targets = new Set()
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const p = d0.offset(dx, dy, dz)
      if (!knownCell(p)) return { verdict: 'inconclusive', why: 'cells around the goal are unknown' }
      if (floodPassable(bot.blockAt(p), true)) targets.add(ck(p.x, p.y, p.z))
    }
    if (!targets.size) return { verdict: 'sealed', ms: Date.now() - t0 }
    const span = Math.ceil(bot.entity.position.distanceTo(d0)) + 24
    const fill = airFlood({ radius: Math.min(span, 64), cap: 15000, targets, known: knownCell, knownOnly: true, keepWalls: true, body: true })
    if (fill.reached) return { verdict: 'connected', cells: fill.cells.size, ms: Date.now() - t0 }
    if (fill.capped || fill.cut) return { verdict: 'inconclusive', cells: fill.cells.size, ms: Date.now() - t0 }
    if (fill.unknown) {
      let edge = null
      let best = Infinity
      for (const w of fill.walls.values()) {
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
          const n = w.offset(dx, dy, dz)
          const d = n.distanceTo(d0)
          if (d < best && fill.cells.has(ck(n.x, n.y, n.z)) && !knownCell(w)) { best = d; edge = n }
        }
      }
      return { verdict: 'unseen', edge, cells: fill.cells.size, ms: Date.now() - t0 }
    }
    return { verdict: 'walled', cells: fill.cells.size, ms: Date.now() - t0 }
  } catch (e) { return { verdict: 'inconclusive', why: e.message } }
}

// ---- GATE MANNERS (07-15, built the day the chickens fled): the pathfinder and the unstuck reflex
// open doors/gates and never close them — pen integrity and safe retreat both die on that habit.
// Every opener routes through bot.activateBlock (pathfinder index.js useOne + reflex + verbs), so ONE
// wrap sees every door I open. Post-toggle it reads the real state (/blockat ethic: verify, don't
// assume): opened → remembered in PENDING_DOORS; closed → forgotten. closeDoorsBehind shuts each
// remembered door once I went through it and stand clear, per doorStep, and the wrap's own
// post-read then self-cleans the list. The helmsman's doors are untouched — only MY opens are remembered.
// If I overshoot reach before it shuts (sprint/fall), it says so ONCE — an honest handoff, no lie.
const PENDING_DOORS = []
const isManneredDoor = (b) => b && /(_door|_fence_gate)$/.test(b.name) && b.name !== 'iron_door'
function wireGateManners () {
  bot.once('spawn', () => {
    try {
      const origActivate = bot.activateBlock.bind(bot)
      // Pending 1.7.10 toggles, keyed by the door's lower half or the gate's cell.
      const toggling = new Map()
      bot.activateBlock = async (block, ...a) => {
        if (!isManneredDoor(block)) return origActivate(block, ...a)
        if (!LEGACY_1710) return mannered(block, a)
        // A click on either half of a 1.7.10 door toggles the lower half.
        const upper = (block.getProperties?.() || {}).half === 'upper'
        const door = (upper ? block.position.offset(0, -1, 0) : block.position).toString()
        // A second click would toggle the door back.
        if (!toggling.has(door)) toggling.set(door, mannered(block, a).finally(() => toggling.delete(door)))
        return toggling.get(door)
      }
      const mannered = async (block, a) => {
        const openAt = (b) => !!(b && b.getProperties && (b.getProperties() || {}).open)
        const key = block.position.toString()
        const event = `blockUpdate:${key}`
        let listener = null
        let timer = null
        let settle = null
        try {
          // On 1.7.10 a clicked upper half first echoes its old state.
          const toggled = LEGACY_1710 && new Promise((resolve) => {
            settle = resolve
            const was = openAt(bot.blockAt(block.position))
            // A world switch sends a null block.
            listener = (old, now) => { if (!now || openAt(now) !== was) resolve() }
            bot.on(event, listener)
          })
          const r = await origActivate(block, ...a)
          // The click is written after mineflayer's look, which can outlast the deadline.
          if (toggled) timer = setTimeout(settle, LEGACY_DOOR_TOGGLE_MS)
          try {
            if (toggled) await toggled
            else await bot.waitForTicks(2)
            const open = openAt(bot.blockAt(block.position))
            const idx = PENDING_DOORS.findIndex(d => d.key === key)
            if (open && idx < 0) PENDING_DOORS.push({ key, pos: block.position.clone(), t: Date.now(), warned: false })
            else if (!open && idx >= 0) { PENDING_DOORS.splice(idx, 1); console.log('[bot] manners: closed behind me at ' + key) }
          } catch (e) {}
          return r
        } finally {
          if (listener) bot.removeListener(event, listener)
          clearTimeout(timer)
        }
      }
    } catch (e) { console.log('[bot] gate-manners wrap skipped: ' + e.message) }
  })
}
// Runs every physics tick, as a sprint crosses the reach band in about 0.3 s.
function closeDoorsBehind () {
  if (!PENDING_DOORS.length) return
  const now = Date.now()
  for (let i = PENDING_DOORS.length - 1; i >= 0; i--) {
    const d = PENDING_DOORS[i]
    const act = doorStep(d, bot.entity.position, now)
    if (act === 'wait') continue
    const b = bot.blockAt(d.pos)
    if (!isManneredDoor(b) || !(b.getProperties() || {}).open) { PENDING_DOORS.splice(i, 1); continue }
    if (act === 'close') {
      // The server's block update outlasts the wrap's post-read.
      if (now < (d.retryAt || 0)) continue
      d.retryAt = now + 1000
      bot.activateBlock(b).catch(() => {})                       // wrapped call — its post-read cleans the list
    } else if (!d.warned) { d.warned = true; emitEvent('manners', 'door left OPEN at ' + d.key + ' — out of reach, pilot decide') }
    else if (now - d.t > 60000) PENDING_DOORS.splice(i, 1)
  }
}

// ---- no-legal-move check: a canDig=false walker boxed in (e.g. self-trapped in its own dig) has
// NO first move, and the pathfinder rejects with a cryptic "Path was stopped". Detect it and say it.
function hasLegalMove() {
  try {
    const o = bot.entity.position.floored()
    // With no move found, an unknown neighbour cell makes the answer true.
    let unknown = false
    const known = (x, y, z) => {
      const p = new Vec3(x, y, z)
      if (knownCell(p) || bodyTouches(p)) return true
      unknown = true
      return false
    }
    const at = (x, y, z) => (known(x, y, z) ? bot.blockAt(new Vec3(x, y, z)) : null)
    const open = (x, y, z) => { const b = at(x, y, z); return b && floodPassable(b, true) }
    const solid = (x, y, z) => { const b = at(x, y, z); return b && b.boundingBox === 'block' }
    const wet = (x, y, z) => { const b = at(x, y, z); return b && b.name.includes('water') }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = o.x + dx, z = o.z + dz
      if (open(x, o.y, z) && open(x, o.y + 1, z)) {           // walk flat / step or swim down (≤3)
        if (wet(x, o.y, z)) return true
        for (let dy = 0; dy >= -3 && known(x, o.y + dy - 1, z); dy--) if (solid(x, o.y + dy - 1, z)) return true
      }
      // step UP 1: tread ahead solid, its feet+head open, and my own launch headroom open
      if (solid(x, o.y, z) && open(x, o.y + 1, z) && open(x, o.y + 2, z) && open(o.x, o.y + 2, o.z)) return true
    }
    return unknown
  } catch (e) { return true }                                  // uncertain -> don't block the attempt
}

// pathfinder.stop() while the pathfinder is IDLE latches a pending stop that silently aborts the
// NEXT path ("Path was stopped before it could be completed" on a perfectly good goal — the
// long-mysterious "stale latch"). Only ever stop a pathfinder that actually has a goal or motion.
function safeStop () {
  try { if (bot.pathfinder.goal || bot.pathfinder.isMoving()) bot.pathfinder.stop() } catch (e) {}
}
// Stops the pathfinder at once. A goal set right after it stands, while safeStop() alone latches a
// stop that cancels the next goal.
function stopPath () {
  safeStop()
  bot.pathfinder.setGoal(null)
}

// Ends every walk route, job and movement for an unexplained hit, a path still being planned included.
function freezeBody () {
  takeLegs('hurt', 'freeze after an unexplained hit')
  stopPath()
  try { bot.clearControlStates() } catch (e) {}
}

// When the drown rescue lets go of jump.
let swimUpUntil = 0
// Holds jump for ms to surface.
function swimUp (ms) {
  swimUpUntil = Date.now() + ms
  bot.setControlState('jump', true)
  setTimeout(() => { try { if (Date.now() >= swimUpUntil) bot.setControlState('jump', false) } catch (e) {} }, ms)
}

// The pathfinder's own path array, which it shifts as the feet reach each node.
let livePath = []
function wireLivePath () {
  bot.on('path_update', (r) => { livePath = r.path })
}
// True from a sprint jump's take-off until the body stands on the ground short of the next node.
let hopping = false
// The step of the straight run the last sprint jump took off along.
let hopDir = null
// True while sprintTick holds jump.
let jumpHeld = false
// Ticks off the path nodes a hop passed.
function skipPassedNodes () {
  if (!hopping || !bot.pathfinder.isMoving()) return
  const passed = passedNodes(livePath, bot.entity.position, hopDir)
  livePath.splice(0, passed)
  if (!passed && bot.entity.onGround) hopping = false
}
// Lets go of a sprint jump the pathfinder no longer steers. Its resets on a block update, a chunk load and a
// moved goal keep the control states it set.
function releaseJump () {
  if (!hopping && !jumpHeld) return
  hopping = false
  jumpHeld = false
  for (const c of ['jump', 'sprint', 'forward']) bot.setControlState(c, false)
}
// The last [sprint] line, the goal of its walk and its time.
let sprintSaid = { line: null, goal: null, at: 0 }
// Holds jump on top of the pathfinder's sprint along a straight, flat stretch.
function sprintTick () {
  if (!bot.pathfinder.isMoving()) return releaseJump()
  const combat = reflexes.find(r => r.name === 'combat')
  const why = !bot.getControlState('sprint') ? 'not sprinting' : noJumpReason({
    path: livePath,
    pos: bot.entity.position,
    onGround: bot.entity.onGround,
    blockAt: (p) => bot.blockAt(p),
    inWater: bot.entity.isInWater,
    food: bot.food,
    fighting: combat.active || Date.now() < combat._fleeUntil
  })
  // A new goal logs at once, a changed decision at most every 5 s, and 'off the ground' never logs.
  const line = why ? `no jump: ${why}` : 'jump held'
  const goal = bot.pathfinder.goal
  if (why !== 'off the ground' && (goal !== sprintSaid.goal || (line !== sprintSaid.line && Date.now() - sprintSaid.at >= 5000))) {
    sprintSaid = { line, goal, at: Date.now() }
    const p = bot.entity.position.floored()
    console.log(`[sprint] ${line} at ${p.x} ${p.y} ${p.z}`)
  }
  jumpHeld = !why
  if (jumpHeld) {
    bot.setControlState('jump', true)
    hopping = true
    hopDir = nodeStep(livePath[0], livePath[1])
  }
}

// Ahead of the pathfinder's listener, so it never steers back to a node a hop passed.
function beforePathfinder () {
  if (!shared.ready || !bot.entity) return
  try { skipPassedNodes() } catch (e) { console.log('[sprint] ' + e.message) }
}
// After the pathfinder's listener, so these act on the control states it just set.
function afterPathfinder () {
  if (!shared.ready || !bot.entity) return
  try { sprintTick() } catch (e) { console.log('[sprint] ' + e.message) }
  try { closeDoorsBehind() } catch (e) { console.log('[doors] ' + e.message) }
}
// The plugin loader adds the pathfinder's listener on inject_allowed, after bot.js has run.
function wirePathfinderTicks () {
  bot.prependListener('physicsTick', beforePathfinder)
  bot.once('inject_allowed', () => bot.on('physicsTick', afterPathfinder))
  bot.on('path_reset', () => { try { releaseJump() } catch (e) { console.log('[sprint] ' + e.message) } })
}

// The status of the last path_update.
let lastPathStatus = null
// One bot.log line per pathfinder event, and per planning for its partial updates.
function wirePathLog () {
  bot.on('goal_reached', () => console.log('[path] goal reached'))
  bot.on('path_update', (r) => {
    if (r.status !== 'partial' || lastPathStatus !== 'partial') console.log(`[path] update ${r.status}, ${r.path.length} nodes`)
    lastPathStatus = r.status
  })
  bot.on('path_reset', (reason) => console.log(`[path] reset ${reason}`))
  bot.on('path_stop', () => console.log('[path] stop'))
}

// maxY is exclusive.
function worldColumn () {
  return { minY: bot.game.minY, maxY: bot.game.minY + bot.game.height }
}

// What resolveTarget reads, gated by what the bot perceives.
function walkSources () {
  let fill = null
  return {
    blockAt: (p) => bot.blockAt(p),
    column: worldColumn(),
    waypoint: (name) => waypoints.get(name),
    player: (name) => playerEntity(name),
    crumb: (name) => {
      const c = playerCrumbs[name]
      return c ? { pos: c.pos, nametag: c.nametag, agoSec: Math.round((Date.now() - c.t) / 1000) } : null
    },
    known: (en) => entityPerceptible(en, fill ??= reflexes.find(r => r.name === 'combat').fairFill(bot)),
    nametag: nametagVisible,
    visibleBlock: (name) => nearestVisible(resolveBlockIds(name), 64),
    cellKnown
  }
}

// Whether the feet stand where a walk to the waypoint arrives.
function standsAtWaypoint (name) {
  const r = resolveTarget({ waypoint: name }, walkSources())
  return !!r.goal && arrivedAt(r.goal, bot.entity.position)
}

const WALK_HINTS = {
  'no-path': 'no known way there. A walk crosses only the open surface and cells I have seen, so unseen ground may still hold one. Look or light the way, pick an open point, or dig with /dig_stair or /dig_tunnel',
  walled: 'reachable only by digging. Decide if a /dig_stair or /dig_tunnel is worth it, or pick an open point',
  sealed: 'pick an open cell, or carve to it deliberately with /dig_stair or /dig_tunnel, your call',
  stalled: 'goal is likely unreachable without digging. Decide if it is worth a /dig_stair or /dig_tunnel, or pick a reachable point',
  'not-reached': 'call /goto again, or pick a reachable point',
  stopped: 'check /jobs, wait a beat, try again',
  bunker: BUNKER_WALK,
  'boxed-in': 'dig out deliberately (/dig_stair toward open space), the pathfinder cannot help from here',
  'no-floor': 'nothing to stand on in that column, pick another point',
  budget: 'try again to continue, or shorten the goal',
  risky: 'risk says what is wrong and plan holds the numbers. Pick another point, or walk it anyway with accept',
  unresolved: 'the target is unloaded or out of sight from here, so there is no plan yet. Walk toward it first',
  'unseen-way': 'the way there runs through cells I have not seen. Walk to edge, look or light the way, then try again',
  // Follows "the cell is <block>: ".
  solid: 'a goto names the feet cell, pick the open cell beside it'
}
// The reply reason for each way a walk attempt ends short of the goal.
const WALK_FAILED = { done: 'not-reached', emptied: 'not-reached', stalled: 'stalled', 'no-path': 'no-path', timeout: 'no-path', stopped: 'stopped' }

// edge is the cell an unseen way runs out at.
function walkReply (r, reason, edge) {
  const me = bot.entity.position
  const inside = (reason === 'stalled' || reason === 'boxed-in') && insideBlock()
  const way = (reason === 'no-path' || reason === 'unseen-way') && wayHint(r, edge)
  const solid = reason === 'solid' && `the cell is ${r.solid}: ${WALK_HINTS.solid}`
  const hint = inside ? `I am inside the ${inside.name} at ${inside.x},${inside.y},${inside.z}: step or dig out of it` : solid || way || (reason && WALK_HINTS[reason]) || null
  const reply = { arrived: !reason, kind: r.kind, target: r.target, pos: round(me), dist: null, reason: reason || null, hint }
  if (r.agoSec !== undefined) reply.agoSec = r.agoSec
  // Adjacent: the feet end outside the goal cell, within 1.5 of its floor centre.
  if (r.cell && !r.nametag) {
    const c = r.cell
    const near = Math.hypot(c.x + 0.5 - me.x, c.y - me.y, c.z + 0.5 - me.z) <= 1.5
    if (near && !arrivedAt(new goals.GoalBlock(c.x, c.y, c.z), me)) reply.adjacent = true
  }
  // A nametag target is aimed at from the centre of its 5-block cube.
  const aim = r.nametag ? crumbCentre(r.cell) : r.cell ? { x: r.cell.x + 0.5, z: r.cell.z + 0.5 } : r.toward
  if (!aim) return reply
  const dist = Math.hypot(aim.x - me.x, aim.z - me.z)
  if (!r.nametag) return { ...reply, dist: +dist.toFixed(1) }
  return { ...reply, dist: Math.round(dist / 5) * 5, bearing: compass(aim.x - me.x, aim.z - me.z) }
}

// The ore a walk passes in lit sight, within 4 of a cell it stands in.
function oreSight () {
  // Two past WAY, for the cells a walk passes between two sweeps.
  const SWEEP_RADIUS = 6
  const SWEEP_MS = 250
  const WAY = 4
  // The eye to block centre distance /digat digs from without walking.
  const DIG_REACH = 4.2
  const VEINS = 8
  const KEPT = 256
  const way = new Map()
  const ores = new Map()
  let swept = null
  let sweptAt = -Infinity
  const sweep = (k) => {
    swept = k
    sweptAt = Date.now()
    const here = bot.entity.position
    const eye = here.offset(0, 1.62, 0)
    try {
      for (const [at, o] of ores) if (here.distanceTo(o.pos) <= SWEEP_RADIUS && seenNow(o.pos) && bot.blockAt(o.pos)?.name !== o.name) ores.delete(at)
      for (const { pos } of findVisible(oreIds(), SWEEP_RADIUS, 32)) {
        const at = ck(pos.x, pos.y, pos.z)
        const reached = eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= DIG_REACH
        const b = bot.blockAt(pos)
        if (ores.has(at)) ores.get(at).reached ||= reached
        else if (b) {
          ores.set(at, { name: b.name, pos, reached })
          if (ores.size > KEPT) {
            const count = new Map()
            for (const o of ores.values()) count.set(o.name, (count.get(o.name) || 0) + 1)
            const most = [...count].reduce((a, c) => c[1] > a[1] ? c : a)[0]
            const far = [...ores].filter(([, o]) => o.name === most).reduce((a, c) => here.distanceTo(c[1].pos) > here.distanceTo(a[1].pos) ? c : a)
            ores.delete(far[0])
          }
        }
      }
    } catch (e) { console.log(`[ores] sweep failed: ${e.message}`) }
  }
  const stand = () => {
    const feet = bot.entity.position.floored()
    const k = ck(feet.x, feet.y, feet.z)
    way.set(k, feet)
    return k
  }
  const step = () => {
    const k = stand()
    if (k !== swept && Date.now() - sweptAt >= SWEEP_MS) sweep(k)
  }
  // { ores, oresMore } for a walk that left its first cell and saw ore, else {}.
  const tally = () => {
    const k = stand()
    if (way.size < 2) return {}
    if (k !== swept) sweep(k)
    const cells = [...way.values()]
    const onWay = (p) => cells.some((c) => Math.min(p.distanceTo(c), p.distanceTo(c.offset(0, 1, 0))) <= WAY)
    // An ore out of sight now counts as it was last seen.
    const stands = (o) => !seenNow(o.pos) || bot.blockAt(o.pos)?.name === o.name
    const veins = []
    for (const [at, o] of ores) {
      if (!onWay(o.pos) || !stands(o)) continue
      const joined = veins.filter((v) => sameVein(v, o.name, o.pos))
      const vein = joined[0] || new Map()
      if (!joined.length) veins.push(vein)
      for (const other of joined.slice(1)) {
        for (const [key, ore] of other) vein.set(key, ore)
        veins.splice(veins.indexOf(other), 1)
      }
      vein.set(at, o)
    }
    if (!veins.length) return {}
    const here = bot.entity.position
    const gap = (o) => here.distanceTo(o.pos.offset(0.5, 0.5, 0.5))
    // A vein is named by its nearest reached block, else its nearest block.
    const named = veins.map((v) => {
      const best = [...v.values()].sort((a, b) => (b.reached - a.reached) || (gap(a) - gap(b)))[0]
      return { ...best, n: v.size, d: gap(best) }
    }).sort((a, b) => a.d - b.d)
    // Each ore name's nearest vein gets a slot before any name gets a second.
    const names = new Set()
    const first = []
    for (const v of named) if (!names.has(v.name)) { names.add(v.name); first.push(v) }
    const picked = new Set(first.slice(0, VEINS))
    for (const v of named) if (picked.size < VEINS) picked.add(v)
    const text = ({ name, n, pos, reached }) => `${name}${n > 1 ? ' x' + n : ''} ${pos.x},${pos.y},${pos.z}${reached ? '' : ' unreached'}`
    const out = { ores: named.filter((v) => picked.has(v)).map(text) }
    if (named.length > picked.size) out.oresMore = named.length - picked.size
    return out
  }
  const report = () => {
    try { return tally() } catch (e) {
      console.log(`[ores] report failed: ${e.message}`)
      return {}
    }
  }
  step()
  return { step, report }
}

// With ores, end() returns oreSight's report of the walk.
function walkRoute ({ ores = false } = {}) {
  const mark = legs.mark()
  const route = { goal: null, taken: false, mark }
  const onGoal = (g) => { if (g && g !== route.goal) route.taken = true }
  const deadline = routeDeadline({ onExpire: () => releaseGoal(route) })
  let last = bot.entity.position.clone()
  let walked = 0
  const seen = ores ? oreSight() : null
  const onMove = () => {
    const p = bot.entity.position
    const stride = Math.hypot(p.x - last.x, p.z - last.z)
    // A server teleport is no walk.
    if (stride < 4) walked += stride
    last = p.clone()
    if (seen) seen.step()
  }
  bot.on('goal_updated', onGoal)
  bot.on('move', onMove)
  route.expired = deadline.expired
  route.left = deadline.left
  route.stopped = () => route.taken || legs.mark() !== mark
  // The horizontal distance the body moved during the route.
  route.walked = () => Math.round(walked * 10) / 10
  route.end = () => {
    deadline.cancel()
    bot.removeListener('goal_updated', onGoal)
    bot.removeListener('move', onMove)
    releaseGoal(route)
    return seen ? seen.report() : undefined
  }
  return route
}

// A stopped reply names the reflex that took the legs since mark, a legs.mark().
function namedStop (reply, mark) {
  const taken = reply.reason === 'stopped' ? legs.takenSince(mark) : null
  return taken ? { ...reply, takenBy: takenText(taken) } : reply
}

// Clears the route's own goal, never one someone else set.
function releaseGoal (route) {
  if (route.goal && bot.pathfinder.goal === route.goal) stopPath()
}

// Why the route is over, or null.
function routeEnd (route) {
  if (bunker.building) return 'bunker'
  if (route.expired()) return 'budget'
  if (route.stopped()) return 'stopped'
  return null
}

function pause (route, ms) {
  return new Promise(resolve => setTimeout(resolve, Math.min(ms, route.left())))
}

// Resolves once quietMs pass without a position packet from the server, at the latest after maxMs.
function serverSettled (quietMs = 250, maxMs = 1000) {
  return new Promise((resolve) => {
    let quiet = null
    const done = () => {
      clearTimeout(quiet)
      clearTimeout(cap)
      bot.removeListener('forcedMove', rearm)
      resolve()
    }
    const rearm = () => {
      clearTimeout(quiet)
      quiet = setTimeout(done, quietMs)
    }
    const cap = setTimeout(done, maxMs)
    bot.on('forcedMove', rearm)
    rearm()
  })
}

// An arrival counts where the server puts the body, after its corrections.
async function walkOnce (goal, route, stallMs) {
  if (routeEnd(route)) return routeEnd(route)
  route.goal = goal
  const how = await walkAttempt(bot, goal, { stallMs, thinkTimeout: bot.pathfinder.thinkTimeout })
  if (how === 'done') await serverSettled()
  if (how === 'changed') route.taken = true
  if (routeEnd(route)) return routeEnd(route)
  if (['stalled', 'timeout', 'no-path', 'emptied'].includes(how)) releaseGoal(route)
  return how
}

// Returns null after a block of progress, else why it made none or why the route ended.
// With guard, a hop walks nothing when its plan finds no path, and a risky one returns { plan, risk }.
async function hopToward (dest, route, { stallMs, segLen, guard, afloat }) {
  const from = bot.entity.position.clone()
  const dx = dest.x - from.x
  const dz = dest.z - from.z
  const t = Math.min(1, segLen / Math.max(Math.hypot(dx, dz), 1e-6))
  const hx = from.x + dx * t
  const hz = from.z + dz * t
  const hy = dest.y == null ? from.y : from.y + (dest.y - from.y) * t
  const cell = standCell((p) => bot.blockAt(p), hx, hz, hy, worldColumn(), knownCell)
  const goal = cell && typeof cell === 'object' ? new goals.GoalNear(cell.x, cell.y, cell.z, 2) : new goals.GoalNearXZ(hx, hz, 2)
  if (guard) {
    const planned = await planPath(goal, route)
    if (!planned) return routeEnd(route)
    if (planned.status === 'noPath') return 'no-path'
    const plan = summarizePlan(bot.entity.position, planned, knownCell, (p) => bot.blockAt(p), afloat)
    const risk = planRisk(plan, null)
    if (risk) return { plan, risk }
  }
  const how = await walkOnce(goal, route, stallMs)
  if (routeEnd(route)) return routeEnd(route)
  if (how === 'stopped') return 'stopped'
  if (bot.entity.position.distanceTo(from) >= 1) return null
  return how === 'no-path' ? 'no-path' : 'stalled'
}

function flatTo (p) {
  return Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z)
}

async function drillDoorway (route) {
  await pause(route, 700)
  try { return await doorwayCommit(route) } catch (e) { console.log('[doorway] commit failed: ' + e.message); return null }
}

// The pathfinder's plan for goal from where the body stands, worked out a slice per tick without walking.
// Null once the route ended.
async function planPath (goal, route) {
  const search = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, bot.entity.position, goal)
  for (;;) {
    const { result } = search.next().value
    if (result.status !== 'partial') return result
    await bot.waitForTicks(1)
    if (routeEnd(route)) return null
  }
}

// Makes bot.pathfinder.movements drop every move landing in the zone of a creeper the combat reflex watches,
// while zones.on and until the route ends or zones.restore runs. Null when it watches none.
function creeperZones (route) {
  const combat = reflexes.find(x => x.name === 'combat')
  // A creeper's bound is its radius, or the body's distance to it when the goto first saw it if nearer.
  const bounds = new Map()
  const list = () => {
    const watched = combat && combat.watchedCreepers ? combat.watchedCreepers() : []
    for (const z of watched) if (!bounds.has(z.id)) bounds.set(z.id, Math.min(z.radius, bot.entity.position.distanceTo(z.at)))
    return watched
  }
  if (!list().length) return null
  const m = bot.pathfinder.movements
  const own = Object.hasOwn(m, 'getNeighbors')
  const getNeighbors = m.getNeighbors
  const zones = { on: true, done: false, bounds, list }
  const zoned = (node) => {
    const moves = getNeighbors.call(m, node)
    if (zones.done || !zones.on || routeEnd(route)) return moves
    const watched = list()
    return moves.filter((move) => !watched.some((z) => inCreeperZone(z, move, bounds.get(z.id))))
  }
  m.getNeighbors = zoned
  // A wrapper under a newer one stays installed and passes every move through.
  zones.restore = () => {
    zones.done = true
    if (m.getNeighbors !== zoned) return
    if (own) m.getNeighbors = getNeighbors
    else delete m.getNeighbors
  }
  return zones
}

// Hops toward a target it cannot resolve yet, then walks onto it, retrying a path stop, a stall and a planning timeout once each.
// The walk and each hop are planned first and refused when planRisk objects, unless accept or the target is a nametag. preview answers the plan and walks nothing.
// Unless accept, the plan and the walk keep out of the zones of the creepers the combat reflex watches.
async function stagedGoto (q, route, { stallMs = 4500, segLen = 18, preview = false, accept = false } = {}) {
  const opts = { stallMs, segLen }
  if (q.block !== undefined && !resolveBlockIds(q.block).length) return walkReply({ kind: 'block', target: { block: q.block } }, 'unknown')
  let r = resolveTarget(q, walkSources())
  if (r.reason) return walkReply(r, r.reason)
  if (!hasLegalMove()) return walkReply(r, 'boxed-in')
  // A plan toward a nametag would end in the player's cube.
  if (preview && (r.toward || r.nametag)) return { ...walkReply(r, 'unresolved'), plan: null }
  const zones = accept || r.nametag ? null : creeperZones(route)
  // A goto begun in water swims out unrefused until one of its plans reaches dry feet.
  const feet = bot.entity.position.floored()
  const afloat = { on: knownCell(feet) && bot.blockAt(feet)?.name === 'water' }
  try {
    // A stalled hop gets the doorway drill again once the bot has moved a block since the last one.
    let drilledAt = null
    let stuck = null
    const drill = async () => {
      const out = await drillDoorway(route)
      stuck = out && out.through === false ? out : null
    }
    const gaveUp = (reason) => {
      if (reason?.risk) return { ...walkReply(r, 'risky'), plan: reason.plan, risk: reason.risk }
      if (reason !== 'stalled' || !stuck) return walkReply(r, reason)
      const { door: d, why } = stuck
      return { ...walkReply(r, 'door'), hint: `the ${d.name} at ${d.x},${d.y},${d.z} ${why}. Open or close it with activate and walk again, or pick another way` }
    }
    // A player known now by the nametag is walked toward in hops, each aimed at the cube the nametag shows in.
    while (r.toward || (r.live && flatTo(r.cell) > segLen)) {
      // A coordinate edge names only the axes the query gave.
      if (r.toward && flatTo(r.toward) <= 2) {
        const edge = r.kind === 'coordinate' ? r.target : round(r.toward)
        return { ...walkReply(r, 'unseen-way', edge), edge }
      }
      const stop = await hopToward(r.toward || r.cell, route, { ...opts, guard: !accept && !r.nametag, afloat })
      if (stop === 'stalled' && !(drilledAt && bot.entity.position.distanceTo(drilledAt) < 1)) {
        drilledAt = bot.entity.position.clone()
        await drill()
      } else if (stop) return gaveUp(stop)
      r = resolveTarget(q, walkSources())
      if (r.reason) return walkReply(r, r.reason)
    }
    // A nametag target's cell is unseen.
    if (!r.nametag) {
      const pre = airPrecheck(r.cell, q.range ?? 0)
      if (pre.verdict === 'sealed' || pre.verdict === 'walled') return walkReply(r, pre.verdict)
      if (pre.verdict === 'unseen') {
        const edge = round(pre.edge)
        return { ...walkReply(r, 'unseen-way', edge), edge }
      }
    }
    if (preview || (!accept && !r.nametag)) {
      let planned = await planPath(r.goal, route)
      if (routeEnd(route)) return walkReply(r, routeEnd(route))
      // With no way round the zones, a way through one is blocked by its creeper.
      if (zones && planned.status === 'noPath') {
        zones.on = false
        planned = await planPath(r.goal, route)
        zones.on = true
        if (routeEnd(route)) return walkReply(r, routeEnd(route))
        const crossed = planned.status === 'success' && zoneCrossed(zones.list(), planned.path, zones.bounds)
        if (crossed) {
          const { x, y, z } = crossed.cell
          const blocked = { ...walkReply(r, 'creeper'), hint: `a creeper at ${x},${y},${z} blocks the way: wait for it to move, pick another point, or walk anyway with accept` }
          return preview ? { ...blocked, plan: null } : blocked
        }
      }
      const plan = summarizePlan(bot.entity.position, planned, knownCell, (p) => bot.blockAt(p), afloat)
      if (preview) return { ...walkReply(r, null), arrived: false, plan }
      const askedY = q.waypoint !== undefined ? (waypoints.get(q.waypoint) || {}).y : q.y
      const risk = planRisk(plan, askedY, q.range ?? 0)
      if (risk) return { ...walkReply(r, 'risky'), plan, risk }
    }
    let retried = false
    let drilled = false
    let marched = false
    for (;;) {
      const how = await walkOnce(r.goal, route, stallMs)
      if (routeEnd(route)) return walkReply(r, routeEnd(route))
      if (arrivedAt(r.goal, bot.entity.position)) return walkReply(r, null)
      if ((how === 'stopped' || how === 'done') && !retried) {
        retried = true
        await pause(route, 350)
      } else if (how === 'stalled' && !drilled) {
        drilled = true
        await drill()
      } else if (how === 'timeout' && !marched) {
        marched = true
        while (flatTo({ x: r.cell.x + 0.5, z: r.cell.z + 0.5 }) > 2) {
          const stop = await hopToward(r.cell, route, { ...opts, guard: !accept && !r.nametag, afloat })
          if (stop) return gaveUp(stop)
        }
      } else return gaveUp(WALK_FAILED[how])
    }
  } finally {
    if (zones) zones.restore()
  }
}

// Keeps only the target forms the pilot may name, never drop.
function gotoQuery (query) {
  const q = {}
  for (const k of ['x', 'y', 'z']) if (query[k] !== undefined) q[k] = parseFloat(query[k])
  for (const k of ['waypoint', 'player', 'block']) if (query[k] !== undefined) q[k] = query[k]
  if (query.range !== undefined) q.range = parseInt(query.range)
  return q
}

// The nearest door or gate the bot sees now within 2 of its feet, or null.
function doorBeside () {
  const feet = bot.entity.position.floored()
  let best = null
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, 1]) {
    const p = feet.offset(dx, dy, dz)
    const b = bot.blockAt(p)
    if (!b || !isDoor(b.name) || !seenNow(p)) continue
    const d = Math.hypot(dx, dz)
    if (best && best.d <= d) continue
    const props = b.getProperties() || {}
    // A door is named by its lower half.
    best = { d, name: b.name, x: p.x, y: props.half === 'upper' ? p.y - 1 : p.y, z: p.z, open: !!props.open }
  }
  if (!best) return null
  const { d, ...door } = best
  return door
}

// What blocks a walk that found no way, from the cells round the feet and the first cells toward edge, r.cell or r.toward.
// Null when the bot sees nothing to name.
function wayHint (r, edge) {
  const me = bot.entity.position
  const feet = me.floored()
  const hints = []
  const door = doorBeside()
  if (door && door.open && !knownCell(pastDoor(door))) hints.push(`the way runs through the door at ${door.x},${door.y},${door.z}: gaze through it`)
  const goalY = (r.cell || r.toward || {}).y
  if (goalY == null || goalY >= feet.y + 2) {
    const ladder = findVisible(resolveBlockIds('ladder'), 16, 256).filter((v) => v.pos.y >= feet.y).sort((a, b) => a.dist - b.dist)[0]
    if (ladder) hints.push(`ladder at ${ladder.pos.x},${ladder.pos.y},${ladder.pos.z}: walk to it and climb it`)
  }
  const near = !edge || Math.hypot(edge.x + 0.5 - me.x, edge.y == null ? 0 : edge.y - me.y, edge.z + 0.5 - me.z) <= 6
  const lamp = near && darkEdge(edge || r.cell || r.toward)
  if (lamp) hints.push(`too dark for me past ${lamp.x},${lamp.y},${lamp.z}: a torch there would light the way`)
  return hints.length ? hints.join('. ') : null
}

// The cell past door on its passage axis, on the far side from the feet.
function pastDoor (door) {
  const at = new Vec3(door.x, door.y, door.z)
  const props = bot.blockAt(seenNow(at) ? at : at.offset(0, 1, 0)).getProperties()
  // A side is open unless the bot sees it blocked now.
  const open = (dx, dz) => [0, 1].every((dy) => {
    const p = at.offset(dx, dy, dz)
    const b = bot.blockAt(p)
    return !(seenNow(p) && b && b.boundingBox !== 'empty')
  })
  const { side } = doorCrossing(props, at, bot.entity.position, open)
  return at.offset(-side[0], 0, -side[1])
}

// The torch cell short of the dark cell nearest aim, among the cells round the feet and the first 6 toward aim, or null.
// With an aim, only cells nearer it than the feet count.
function darkEdge (aim) {
  const me = bot.entity.position
  const feet = me.floored()
  const eye = me.offset(0, 1.62, 0)
  const columns = []
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) columns.push([feet.x + dx, feet.z + dz])
  const to = aim && { x: Math.floor(aim.x), y: aim.y == null ? null : Math.floor(aim.y), z: Math.floor(aim.z) }
  const len = to ? Math.hypot(to.x + 0.5 - me.x, to.z + 0.5 - me.z) : 0
  for (let i = 1; i <= 6 && len >= 1; i++) {
    columns.push([Math.floor(me.x + (to.x + 0.5 - me.x) * i / len), Math.floor(me.z + (to.z + 0.5 - me.z) * i / len)])
  }
  const toAim = (p) => Math.hypot(p.x - to.x, to.y == null ? 0 : p.y - to.y, p.z - to.z)
  const tried = new Set()
  let best = null
  for (const [x, z] of columns) for (let dy = -1; dy <= 2; dy++) {
    const c = new Vec3(x, feet.y + dy, z)
    if (tried.has(c.toString())) continue
    tried.add(c.toString())
    if (knownCell(c) || bodyTouches(c)) continue
    const d = to ? toAim(c) : c.distanceTo(feet)
    if ((to && d >= toAim(feet)) || (best && best.d <= d)) continue
    const lamp = lampBefore(eye, c)
    if (lamp) best = { d, lamp }
  }
  return best && best.lamp
}

// The last cell on the line from the eye to dark cell c where a torch can stand, null when a cell short of c is unknown or
// the line is blocked.
function lampBefore (eye, c) {
  const centre = c.offset(0.5, 0.5, 0.5)
  const way = []
  const unknown = gridWalk(eye, centre, (cell) => {
    if (cell.equals(c)) return false
    way.push(cell)
    return !(knownCell(cell) || bodyTouches(cell))
  })
  if (unknown || !lineCell(eye, centre, c, true)) return null
  return way.reverse().find((p) => holdsTorch(p)) || null
}

// An air cell the bot sees now and the body is clear of, with a full block it sees now below or beside it.
function holdsTorch (p) {
  if (!seenNow(p) || entityInCell(p, [bot.entity])) return false
  const b = bot.blockAt(p)
  if (!b || (b.name !== 'air' && b.name !== 'cave_air')) return false
  return [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => {
    const n = p.offset(dx, dy, dz)
    const b = seenNow(n) && bot.blockAt(n)
    return !!b && b.shapes.length === 1 && b.shapes[0].join() === '0,0,0,1,1,1'
  })
}

// The block whose collision box the body is inside by more than 1e-3 on every axis, or null.
function insideBlock () {
  const p = bot.entity.position
  const lo = [p.x - 0.3, p.y, p.z - 0.3]
  const hi = [p.x + 0.3, p.y + 1.8, p.z + 0.3]
  // A wall or fence below reaches 1.5 up.
  for (let x = Math.floor(lo[0]); x <= Math.floor(hi[0]); x++) for (let y = Math.floor(lo[1]) - 1; y <= Math.floor(hi[1]); y++) for (let z = Math.floor(lo[2]); z <= Math.floor(hi[2]); z++) {
    const c = new Vec3(x, y, z)
    if (!(bodyTouches(c) || seenNow(c))) continue
    const b = bot.blockAt(c)
    if (!b) continue
    const at = [x, y, z]
    const inside = (s) => [0, 1, 2].every((i) => Math.min(hi[i], at[i] + s[i + 3]) - Math.max(lo[i], at[i] + s[i]) > 1e-3)
    if (b.shapes.some(inside)) return { name: b.name, x, y, z }
  }
  return null
}

// Shared STEP primitive — physics-walk the bot one cell instead of asking the pathfinder to plan
// it. Under canDig=false the pathfinder REFUSES the tight 1-block move into a just-carved mining
// cell (stalls "Path was stopped before"): climbing a 1-wide step, dropping into a descend cell, or
// advancing a fresh tunnel face. So we face the target and hold forward (+ jump when climbing),
// polling until the bot is actually in the cell and grounded. The undug wall beyond stops overshoot.
// climbing=true → ascending (mount +1); false → level/descending (walk or fall into the cell).
async function nudgeInto (target, climbing, timeoutMs = 3000, route = null) {
  // A bunker build owns the control states, also one that began mid-nudge.
  const cut = () => (route ? routeEnd(route) : bunker.building)
  if (cut()) return false
  const Vec3 = require('vec3').Vec3
  try {
    await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5), true)
    if (cut()) return false
    bot.setControlState('forward', true)
    if (climbing) bot.setControlState('jump', true)
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs && !cut()) {
      await new Promise(r => setTimeout(r, 60))
      const p = bot.entity.position.floored()
      const yOk = climbing ? p.y >= target.y : p.y <= target.y
      // cut power the moment we ENTER the target column — do NOT wait for onGround with controls
      // held: a held jump keeps the bot airborne at poll time, so it blows straight through the
      // cell and sprints on (the 07-11 open-terrain overshoot to x-35). Settle+verify AFTER.
      if (p.x === target.x && p.z === target.z && yOk) break
    }
  } finally {
    if (!bunker.building) {
      bot.setControlState('forward', false)
      // A drown rescue keeps its jump.
      if (Date.now() >= swimUpUntil) bot.setControlState('jump', false)
    }
  }
  if (route && routeEnd(route)) return false
  await new Promise(r => setTimeout(r, 250))   // let physics settle (land + shed momentum), then verify
  const p = bot.entity.position.floored()
  return (p.x === target.x && p.z === target.z && Math.abs(p.y - target.y) <= 1)
}

// "you gotta commit that one straight ahead block walk before turning when going through." The pathfinder cuts doorways diagonally and clips the jamb.
// Null when it found no door or was cut off, else the door and whether the body got through, with why not.
async function doorwayCommit (route = null) {
  const cut = () => (route ? routeEnd(route) : bunker.building)
  if (cut()) return null
  const me = bot.entity.position.floored()
  // nearest door/gate within ~3.5 — check the walk plane and one up (upper door half)
  const ids = Object.values(shared.mcData.blocksByName)
    .filter(b => /(_door|_fence_gate)$/.test(b.name) && b.name !== 'iron_door').map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: 4, count: 8 })
    .map(p => bot.blockAt(p)).filter(Boolean)
    .filter(b => { const h = (b.getProperties() || {}).half; return h !== 'upper' })  // feet cell only
    .filter(b => seenNow(b.position))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  if (!found) return null
  const D = found.position
  const props = found.getProperties() || {}
  // A cell the bot has not seen counts as blocked.
  const walkable = (dx, dz) => [0, 1].every(dy => {
    const p = D.offset(dx, dy, dz)
    const b = bot.blockAt(p)
    return !!b && cellKnown(p) && b.boundingBox === 'empty'
  })
  const { axis, side } = doorCrossing(props, D, bot.entity.position, walkable)
  const nearC = D.offset(side[0], 0, side[1]), farC = D.offset(-side[0], 0, -side[1])
  const from = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' }[side.join()]
  console.log(`[doorway] commit via ${found.name} at ${D} facing=${props.facing} half=${props.half} hinge=${props.hinge} open=${props.open} axis=${axis} near=${nearC} far=${farC}`)
  const door = { name: found.name, x: D.x, y: D.y, z: D.z }
  const failed = (why) => { console.log(`[doorway] ${found.name} ${why}`); return { door, through: false, why } }
  const across = () => { const b = bot.blockAt(D); return !!b && isDoor(b.name) && panelAcross(b.name, b.getProperties() || {}, axis) }
  const unpressedPlate = (feet) => {
    const b = bot.blockAt(feet)
    if (!b || !b.name.endsWith('_pressure_plate')) return false
    const p = b.getProperties() || {}
    // A weighted plate reports power as a string.
    return !(p.powered === true || Number(p.power) > 0)
  }
  const toggle = async () => {
    try { await bot.activateBlock(bot.blockAt(D)) } catch (e) { console.log('[doorway] activate failed: ' + e.message) }
    await bot.waitForTicks(3)
  }
  const TRIES = 2
  for (let tries = 1; tries <= TRIES; tries++) {
    const p0 = bot.entity.position.floored()
    if (p0.x !== nearC.x || p0.z !== nearC.z) {
      const goal = new goals.GoalBlock(nearC.x, nearC.y, nearC.z)
      const how = route ? await walkOnce(goal, route, 4500) : await walkAttempt(bot, goal, { stallMs: 4500, thinkTimeout: bot.pathfinder.thinkTimeout })
      if (cut() || how === 'changed') return null
      if (bot.pathfinder.goal === goal) stopPath()
      const p = bot.entity.position.floored()
      if (p.x !== nearC.x || p.z !== nearC.z) return failed(`could not be reached on its ${from} side (${how})`)
    }
    const feet = bot.entity.position.floored()
    for (let t = 0; unpressedPlate(feet) && t < PLATE_WAIT_TICKS && !cut(); t++) await bot.waitForTicks(1)
    if (cut()) return null
    // The server and this client can disagree on whether the door is open.
    if (tries > 1) await toggle()
    if (across()) {
      // A plate or another player can open the door during the turn.
      await bot.lookAt(D.offset(0.5, 0.5, 0.5))
      if (across()) await toggle()
    }
    console.log(`[doorway] panel across=${across()} shapes=${JSON.stringify((bot.blockAt(D) || {}).shapes)}`)
    if (across()) return failed('stayed shut')
    if (cut()) return null
    if (!await nudgeInto(D, false, 3000, route)) {
      if (cut()) return null
      console.log(`[doorway] stuck entering the threshold, try ${tries}`)
      continue
    }
    if (cut()) return null
    if (!await nudgeInto(farC, false, 3000, route)) {
      if (cut()) return null
      console.log(`[doorway] crossed the door cell but not beyond, try ${tries}`)
      continue
    }
    console.log('[doorway] through clean')
    return { door, through: true }
  }
  return failed(`did not let me through from the ${from} after ${TRIES} tries`)
}

function createLegs (ctx) {
  Object.assign(ctx, { navPlaced, collectSafely, collectLock, collectBusy, stopCollect, COLLECT_STALL_MS, COLLECT_BUDGET_MS, watchScope, watchedWork, watchGoto, leaveBedFirst, walkGaveUp, abandonCollect, PLAN_KNOWN, knownMoves, legs, takeLegs, airPrecheck, PENDING_DOORS, isManneredDoor, closeDoorsBehind, hasLegalMove, safeStop, stopPath, freezeBody, swimUp, skipPassedNodes, sprintTick, beforePathfinder, afterPathfinder, standsAtWaypoint, WALK_HINTS, WALK_FAILED, walkReply, walkRoute, namedStop, routeEnd, pause, walkOnce, planPath, stagedGoto, gotoQuery, doorBeside, wayHint, insideBlock, nudgeInto, doorwayCommit })
}

function bindLegs (ctx) {
  ({ bot, shared, seenNow, ck, knownCell, yieldJob, floodPassable, airFlood, emitEvent, bodyTouches, reflexes, waypoints, playerEntity, playerCrumbs, entityPerceptible, nametagVisible, nearestVisible, findVisible, resolveBlockIds, cellKnown, round, compass, bunker, gridWalk, lineCell, oreIds, holdCollectTool, digToolFor } = ctx)
}

module.exports = { createLegs, bindLegs, wirePlanKnownReset, wireGateManners, wireLivePath, wirePathfinderTicks, wirePathLog }
