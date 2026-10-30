'use strict'
const { Vec3 } = require('vec3')
const { GoalBlock, GoalNear, GoalGetToBlock } = require('mineflayer-pathfinder/lib/goals')

// The 1.21 overworld (maxY exclusive), for a caller that passes no column.
const OVERWORLD = { minY: -64, maxY: 320 }
const ROUTE_MS = 280000
// A nametag crumb holds only the centre of the CRUMB_CELL cube the player stood in.
const CRUMB_CELL = 5
// The least range of a walk to a nametag cube, which takes in every cell of it.
const CRUMB_RANGE = 4
// How far from the y hint a stand cell may lie and still count as the floor asked for.
const HINT_SLACK = 2
const UNLOADED = Symbol('unloaded')
const UNKNOWN = Symbol('unknown')
const FORMS = ['waypoint', 'player', 'block', 'drop']
const AVOID = new Set(['fire', 'lava', 'cobweb', 'web'])

const REAL_CLOCK = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h)
}

// Floor and passable mirror the rules of the pathfinder's Movements.
const height = (b) => (b.shapes.length ? b.shapes[0][4] : 0)
const isFloor = (b) => b.boundingBox === 'block' && height(b) <= 1
const isPassable = (b) => (b.boundingBox === 'empty' || b.name === 'ladder' || (b.shapes.length > 0 && height(b) < 0.1)) && !AVOID.has(b.name)

function readColumn (blockAt, x, z, { minY, maxY }) {
  const floor = []
  const pass = []
  for (let y = minY; y < maxY; y++) {
    const b = blockAt(new Vec3(x, y, z))
    if (!b) return null
    floor.push(isFloor(b))
    pass.push(isPassable(b))
  }
  return { floor, pass }
}

// The feet cell nearest yHint (below wins a tie), or without yHint the surface cell.
// With known, candidates are judged on known cells only. A cell past an unsettled one stands only within HINT_SLACK of the hint, else UNKNOWN.
function standCell (blockAt, x, z, yHint, column = OVERWORLD, known = null) {
  x = Math.floor(x)
  z = Math.floor(z)
  const col = readColumn(blockAt, x, z, column)
  if (!col) return UNLOADED
  const { minY, maxY } = column
  const floor = (y) => col.floor[y - minY]
  const pass = (y) => col.pass[y - minY]
  const standable = (y) => floor(y - 1) && pass(y) && pass(y + 1)
  if (yHint == null) {
    let top = maxY - 1
    while (top >= minY && pass(top)) top--
    return standable(top + 1) ? new Vec3(x, top + 1, z) : null
  }
  const knownAt = []
  const isKnown = (y) => (knownAt[y - minY] ??= known(new Vec3(x, y, z)))
  const verdict = (y) => {
    if (!known) return standable(y)
    if (y - 1 < minY || y + 1 >= maxY) return false
    const feetSeen = isKnown(y)
    const cells = [
      [feetSeen, pass(y)],
      [isKnown(y + 1), pass(y + 1)],
      // An open feet cell in sight shows the floor under it, ladders included.
      [isKnown(y - 1) || (feetSeen && pass(y)), floor(y - 1)]
    ]
    if (cells.some(([seen, fits]) => seen && !fits)) return false
    return cells.every(([seen]) => seen) ? true : UNKNOWN
  }
  const h = Math.min(Math.max(Math.floor(yHint), minY), maxY - 1)
  const span = Math.max(h - minY, maxY - h)
  let unsettled = false
  for (let d = 0; d <= span; d++) {
    for (const y of d ? [h - d, h + d] : [h]) {
      const v = verdict(y)
      if (v === UNKNOWN) unsettled = true
      else if (v) return !unsettled || Math.abs(y - h) <= HINT_SLACK ? new Vec3(x, y, z) : UNKNOWN
    }
  }
  return unsettled ? UNKNOWN : null
}

// The one target form a query names (x and z with an optional y count as one), or null.
function targetKind (q) {
  const kinds = FORMS.filter((k) => q[k] !== undefined)
  const coordinate = ['x', 'y', 'z'].some((k) => q[k] !== undefined)
  if (coordinate) kinds.push('coordinate')
  if (kinds.length !== 1) return null
  if (coordinate && (q.x === undefined || q.z === undefined)) return null
  return kinds[0]
}

function askedFor (kind, q) {
  if (kind === 'coordinate') return q.y === undefined ? { x: q.x, z: q.z } : { x: q.x, y: q.y, z: q.z }
  if (kind === 'drop') return null
  return { [kind]: q[kind] }
}

function locate (kind, q, src) {
  if (kind === 'coordinate') return { at: { x: q.x, y: q.y, z: q.z } }
  if (kind === 'waypoint') {
    const wp = src.waypoint(q.waypoint)
    return wp ? { at: wp } : { reason: 'unknown' }
  }
  if (kind === 'player') {
    const live = src.player(q.player)
    if (live && src.known(live)) return { at: live.position }
    if (live && src.nametag(live)) return { at: crumbCentre(live.position), nametag: true, live: true }
    const crumb = src.crumb(q.player)
    if (!crumb) return { reason: 'unseen' }
    return { at: crumb.pos, nametag: crumb.nametag, agoSec: crumb.agoSec }
  }
  return src.known(q.drop) ? { at: q.drop.position } : { reason: 'unseen' }
}

function columnKnown (src, x, z) {
  const { minY, maxY } = src.column || OVERWORLD
  for (let y = minY; y < maxY; y++) if (!src.cellKnown(new Vec3(Math.floor(x), y, Math.floor(z)))) return false
  return true
}

// What fills cell at when the bot knows it holds a collision box, else null. Only a block in sight now is named.
function solidCell (src, at) {
  const p = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
  const b = src.blockAt(p)
  if (!b || b.boundingBox !== 'block' || !src.cellKnown(p)) return null
  return src.seenNow(p) ? b.name : 'a solid block out of sight now'
}

// src: { blockAt, column, waypoint, player, crumb, known, nametag, visibleBlock, cellKnown, seenNow }.
// crumb(name) gives { pos, nametag, agoSec } or null. toward is where to walk before resolving again.
// live marks a player known now by the nametag alone.
function resolveTarget (q, src) {
  const kind = targetKind(q)
  if (!kind) throw new Error('need exactly one target: x and z, waypoint, player, block or drop')
  const asked = askedFor(kind, q)
  if (kind === 'block') {
    const b = src.visibleBlock(q.block)
    if (!b) return { kind, target: asked, reason: 'unseen' }
    const p = b.position
    return { kind, target: { x: p.x, y: p.y, z: p.z }, goal: new GoalGetToBlock(p.x, p.y, p.z), cell: p }
  }
  const { at, reason, nametag, live, agoSec } = locate(kind, q, src)
  if (reason) return { kind, target: asked, reason }
  const base = { kind, target: asked, ...(agoSec !== undefined && { agoSec }) }
  const range = q.range ?? 0
  if (nametag) {
    const goal = nametagGoal(at, range)
    return { ...base, goal, cell: new Vec3(goal.x, goal.y, goal.z), nametag, ...(live && { live }) }
  }
  const cell = standCell(src.blockAt, at.x, at.z, at.y, src.column, src.cellKnown)
  const toward = copy(at)
  if (cell === UNLOADED) return { ...base, toward }
  if (cell === UNKNOWN || !cell) {
    if (!cell && columnKnown(src, at.x, at.z)) return { ...base, reason: 'no-floor' }
    const solid = kind === 'coordinate' && q.y !== undefined && solidCell(src, at)
    return solid ? { ...base, reason: 'solid', solid } : { ...base, toward }
  }
  const goal = range ? new GoalNear(cell.x, cell.y, cell.z, range) : new GoalBlock(cell.x, cell.y, cell.z)
  const target = src.cellKnown(cell) ? { x: cell.x, y: cell.y, z: cell.z } : asked
  return { ...base, target, goal, cell }
}

// The pathfinder's own arrival test, which covers feet sunk into farmland, slabs and soul sand.
function arrivedAt (goal, feet) {
  const p = new Vec3(Math.floor(feet.x), Math.floor(feet.y), Math.floor(feet.z))
  return goal.isEnd(p) || goal.isEnd(p.offset(0, 1, 0))
}

function crumbCentre (p) {
  const centre = (v) => Math.floor(v / CRUMB_CELL) * CRUMB_CELL + CRUMB_CELL / 2
  return new Vec3(centre(p.x), centre(p.y), centre(p.z))
}

// The goal of a walk toward a player known by the nametag at p: the centre of their cube, reaching all of it.
function nametagGoal (p, range = 0) {
  const c = crumbCentre(p)
  return new GoalNear(c.x, c.y, c.z, Math.max(CRUMB_RANGE, range))
}

const copy = (p) => ({ x: p.x, y: p.y, z: p.z })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// The stall clock pauses while the pathfinder plans, from the start (with planning) or a partial path_update to the next other one.
// A check that finds busy() true counts as progress, planning included.
function watchProgress ({ position, onPathUpdate, stallMs, thinkTimeout, onStall, onThinkTimeout, planning = true, busy = () => false, clock = REAL_CLOCK, checkMs = 400 }) {
  let anchor = copy(position())
  let anchorT = clock.now()
  let planStart = planning ? anchorT : null
  let done = false
  const unsubscribe = onPathUpdate((r) => {
    const t = clock.now()
    if (r.status === 'partial') {
      if (planStart === null) planStart = t
    } else if (planStart !== null) {
      anchorT += t - Math.max(planStart, anchorT)
      planStart = null
    }
  })
  const timer = clock.setInterval(check, checkMs)
  function check () {
    const t = clock.now()
    const p = position()
    if (distance(p, anchor) >= 1) {
      anchor = copy(p)
      anchorT = t
    }
    if (busy()) {
      anchorT = t
      if (planStart !== null) planStart = t
    }
    if (planStart !== null) {
      if (t - planStart > thinkTimeout) finish(onThinkTimeout)
    } else if (t - anchorT > stallMs) finish(onStall)
  }
  function finish (fn) {
    stop()
    fn()
  }
  function stop () {
    if (done) return
    done = true
    clock.clearInterval(timer)
    unsubscribe()
  }
  return { stop }
}

// The physics ticks between two due() checks of a walk attempt.
const DUE_TICKS = 10

// The goal stays set after the attempt ends. A due() check that holds ends it as 'hungry'.
function walkAttempt (bot, goal, { stallMs, thinkTimeout, due = null, clock = REAL_CLOCK }) {
  return new Promise((resolve) => {
    let ended = false
    let ticks = 0
    const on = {
      goal_reached: () => end('done'),
      path_update: (r) => {
        if (r.status === 'noPath') end('no-path')
        else if (r.status === 'timeout') end('timeout')
        else if (r.status !== 'partial' && r.path.length === 0) end('emptied')
      },
      goal_updated: (g) => { if (g !== goal) end('changed') },
      path_stop: () => end('stopped'),
      ...(due && { physicsTick: () => { if (++ticks % DUE_TICKS === 0 && due()) end('hungry') } })
    }
    function end (how) {
      if (ended) return
      ended = true
      dog.stop()
      for (const [ev, fn] of Object.entries(on)) bot.removeListener(ev, fn)
      resolve(how)
    }
    for (const [ev, fn] of Object.entries(on)) bot.on(ev, fn)
    const dog = watchProgress({
      position: () => bot.entity.position,
      onPathUpdate: (fn) => {
        bot.on('path_update', fn)
        return () => bot.removeListener('path_update', fn)
      },
      stallMs,
      thinkTimeout,
      onStall: () => end('stalled'),
      onThinkTimeout: () => end('timeout'),
      clock
    })
    bot.pathfinder.setGoal(goal)
  })
}

// Calls onExpire once, ms after the route starts or at the first expired() past that.
function routeDeadline ({ onExpire, ms = ROUTE_MS, clock = REAL_CLOCK }) {
  const end = clock.now() + ms
  let fired = false
  let cancelled = false
  const fire = () => {
    if (fired || cancelled) return
    fired = true
    clock.clearTimeout(timer)
    onExpire()
  }
  const timer = clock.setTimeout(fire, ms)
  return {
    expired () {
      if (clock.now() >= end) fire()
      return fired
    },
    left () {
      return Math.max(0, end - clock.now())
    },
    cancel () {
      cancelled = true
      clock.clearTimeout(timer)
    }
  }
}

// Settles as work() settles, unless the body stalls or budgetMs runs out first.
// Then stop() runs and it rejects with an error whose reason is 'stalled' or 'budget'.
function guardWork (work, { position, onPathUpdate, busy, stop, stallMs, thinkTimeout, budgetMs, clock = REAL_CLOCK }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn) => {
      if (settled) return
      settled = true
      dog.stop()
      deadline.cancel()
      fn()
    }
    const halt = (reason, message) => settle(() => {
      stop()
      reject(Object.assign(new Error(message), { reason }))
    })
    const onStall = () => halt('stalled', `stalled, no progress for ${stallMs / 1000} s`)
    const onThinkTimeout = () => halt('stalled', `stalled, still planning after ${thinkTimeout / 1000} s`)
    const dog = watchProgress({ position, onPathUpdate, busy, stallMs, thinkTimeout, onStall, onThinkTimeout, planning: false, clock })
    const deadline = routeDeadline({ onExpire: () => halt('budget', `over the budget of ${budgetMs / 1000} s`), ms: budgetMs, clock })
    let running
    try { running = work() } catch (e) { running = Promise.reject(e) }
    running.then((v) => settle(() => resolve(v)), (e) => settle(() => reject(e)))
  })
}

module.exports = { AVOID, UNLOADED, UNKNOWN, standCell, targetKind, resolveTarget, crumbCentre, nametagGoal, arrivedAt, watchProgress, walkAttempt, routeDeadline, guardWork }
