'use strict'
const { Vec3 } = require('vec3')
const { GoalBlock, GoalNear, GoalGetToBlock, GoalFollow } = require('mineflayer-pathfinder/lib/goals')

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
// How far from the body's centre a 1.7.10 player picks up an item's centre: on x and z each, and below and above the feet.
const PICKUP = { reach: 1.425, below: 0.625, above: 2.425 }
// An item's centre lies this far over its position.
const ITEM_HALF = 0.125
// The body's centre keeps this far from the sides of its feet cell.
const BODY_HALF = 0.3
// How far inside the pickup box an end cell of a pickup walk keeps the item.
const PICKUP_MARGIN = 0.1
// How far a drop moves before a pickup walk aims at it afresh.
const PICKUP_MOVED = 0.05
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

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

// The feet cell nearest yHint (below wins a tie).
// With known, candidates are judged on known cells only. A cell past an unsettled one stands only within slack of the hint, else UNKNOWN.
// With strictLeaves, a cell on leaves past an unsettled one is UNKNOWN at any slack.
function standCell (blockAt, x, z, yHint, column = OVERWORLD, known = null, { slack = HINT_SLACK, strictLeaves = false } = {}) {
  x = Math.floor(x)
  z = Math.floor(z)
  const col = readColumn(blockAt, x, z, column)
  if (!col) return UNLOADED
  const { minY, maxY } = column
  const floor = (y) => col.floor[y - minY]
  const pass = (y) => col.pass[y - minY]
  const standable = (y) => floor(y - 1) && pass(y) && pass(y + 1)
  const onLeaves = (y) => blockAt(new Vec3(x, y - 1, z)).name.endsWith('_leaves')
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
      else if (v) return unsettled && (Math.abs(y - h) > slack || (strictLeaves && onLeaves(y))) ? UNKNOWN : new Vec3(x, y, z)
    }
  }
  return unsettled ? UNKNOWN : null
}

// Whether a body with its feet at body picks up an item at item.
function pickupCovers (body, item) {
  const up = item.y + ITEM_HALF - body.y
  return Math.abs(item.x - body.x) < PICKUP.reach && Math.abs(item.z - body.z) < PICKUP.reach && up > -PICKUP.below && up < PICKUP.above
}

// Whether an item at item lies above the pickup box of a body with its feet at body.
function overPickup (body, item) {
  return item.y + ITEM_HALF - body.y >= PICKUP.above
}

// How far v lies past the span the body's centre covers in the cell at c.
function bodyGap (v, c) {
  return Math.max(0, c + BODY_HALF - v, v - (c + 1 - BODY_HALF))
}

// The point nearest item that the body's centre reaches in its feet cell.
function pickupStep (body, item) {
  const inside = (v, c) => Math.min(Math.max(v, c + BODY_HALF), c + 1 - BODY_HALF)
  return new Vec3(inside(item.x, Math.floor(body.x)), body.y, inside(item.z, Math.floor(body.z)))
}

// Ends in a feet cell that reaches the item PICKUP_MARGIN inside the pickup box, with open cells leading to it.
class GoalPickup extends GoalFollow {
  constructor (entity, { blockAt, known = null }) {
    super(entity, 0)
    this.blockAt = blockAt
    this.known = known
    this.aim()
  }

  aim () {
    const p = this.entity.position
    this.at = new Vec3(p.x, p.y, p.z)
    Object.assign(this, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
    // An item resting on a floor can report a y inside the floor block.
    const c = new Vec3(this.x, Math.floor(p.y + ITEM_HALF), this.z)
    this.cell = this.blockAt(c)?.boundingBox === 'block' ? c.offset(0, 1, 0) : c
    this.ends = new Map()
  }

  heuristic (node) {
    const gap = (d) => Math.max(0, Math.abs(d) - 2.5)
    const dx = gap(this.at.x - node.x - 0.5)
    const dz = gap(this.at.z - node.z - 0.5)
    return Math.abs(dx - dz) + Math.min(dx, dz) * Math.SQRT2 + gap(this.at.y - node.y)
  }

  isEnd (node) {
    const k = `${node.x},${node.y},${node.z}`
    if (!this.ends.has(k)) this.ends.set(k, this.reaches(new Vec3(node.x, node.y, node.z)))
    return this.ends.get(k)
  }

  reaches (feet) {
    const reach = PICKUP.reach - PICKUP_MARGIN
    const up = this.at.y + ITEM_HALF - feet.y
    if (bodyGap(this.at.x, feet.x) >= reach || bodyGap(this.at.z, feet.z) >= reach) return false
    if (up <= PICKUP_MARGIN - PICKUP.below || up >= PICKUP.above - PICKUP_MARGIN) return false
    return this.openWay(feet)
  }

  // Whether open cells inside the box around the body's two cells and the item's cell join them.
  openWay (feet) {
    const to = this.cell
    const lo = feet.min(to)
    const hi = feet.offset(0, 1, 0).max(to)
    const open = (p) => {
      const b = this.blockAt(p)
      return !!b && isPassable(b) && (!this.known || this.known(p))
    }
    const queue = [feet, feet.offset(0, 1, 0)]
    const met = new Set(queue.map(String))
    while (queue.length) {
      const p = queue.shift()
      if (p.equals(to)) return true
      for (const [dx, dy, dz] of FACES) {
        const n = p.offset(dx, dy, dz)
        if (n.x < lo.x || n.y < lo.y || n.z < lo.z || n.x > hi.x || n.y > hi.y || n.z > hi.z || met.has(String(n))) continue
        met.add(String(n))
        if (n.equals(to) || open(n)) queue.push(n)
      }
    }
    return false
  }

  hasChanged () {
    const p = this.entity.position
    if (Math.max(Math.abs(p.x - this.at.x), Math.abs(p.y - this.at.y), Math.abs(p.z - this.at.z)) <= PICKUP_MOVED) return false
    this.aim()
    return true
  }
}

// The end cell nearest src.here, else UNLOADED or UNKNOWN for a missing column in reach, else null.
function pickupCell (goal, src) {
  const { at } = goal
  const reach = PICKUP.reach - PICKUP_MARGIN
  const off = (c) => c.offset(0.5, 0, 0.5).distanceTo(src.here)
  let best = null
  let missing = null
  for (let x = Math.floor(at.x) - 2; x <= Math.floor(at.x) + 2; x++) {
    for (let z = Math.floor(at.z) - 2; z <= Math.floor(at.z) + 2; z++) {
      if (bodyGap(at.x, x) >= reach || bodyGap(at.z, z) >= reach) continue
      const cell = standCell(src.blockAt, x, z, at.y + ITEM_HALF, src.column, src.cellKnown)
      if (cell === UNLOADED || cell === UNKNOWN) missing = cell
      else if (cell && goal.isEnd(cell) && (!best || off(cell) < off(best))) best = cell
    }
  }
  return best || missing
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
  return q.watched?.(q.drop) || src.known(q.drop) ? { at: q.drop.position } : { reason: 'unseen' }
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

// src: { blockAt, column, waypoint, player, crumb, known, nametag, visibleBlock, cellKnown, seenNow, feetY, here }.
// crumb(name) gives { pos, nametag, agoSec } or null. toward is where to walk before resolving again.
// live marks a player known now by the nametag alone. A drop counts as seen when q.watched(drop) is true.
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
  if (kind === 'drop') {
    const goal = new GoalPickup(q.drop, { blockAt: src.blockAt, known: src.cellKnown })
    const cell = pickupCell(goal, src)
    if (cell === null) return { ...base, reason: 'no-floor' }
    if (!(cell instanceof Vec3)) return { ...base, toward: copy(at) }
    return { ...base, target: copy(cell), goal, cell }
  }
  const cell = at.y == null
    ? standCell(src.blockAt, at.x, at.z, src.feetY, src.column, src.cellKnown, { slack: Infinity, strictLeaves: true })
    : standCell(src.blockAt, at.x, at.z, at.y, src.column, src.cellKnown)
  const toward = copy(at)
  if (cell === UNLOADED) return { ...base, toward }
  if (cell === UNKNOWN || !cell) {
    if (!cell && columnKnown(src, at.x, at.z)) return { ...base, reason: 'no-floor' }
    const solid = kind === 'coordinate' && q.y !== undefined && solidCell(src, at)
    return solid ? { ...base, reason: 'solid', solid } : { ...base, toward }
  }
  const goal = range ? new GoalNear(cell.x, cell.y, cell.z, range) : new GoalBlock(cell.x, cell.y, cell.z)
  return { ...base, target: { x: cell.x, y: cell.y, z: cell.z }, goal, cell }
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

// The goal stays set after the attempt ends. A due() check that returns a reason ends it with that reason.
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
      ...(due && { physicsTick: () => { if (++ticks % DUE_TICKS === 0) { const why = due(); if (why) end(why) } } })
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
    const halt = (reason, message, marks = {}) => settle(() => {
      stop()
      reject(Object.assign(new Error(message), { reason }, marks))
    })
    const onStall = () => halt('stalled', `stalled, no progress for ${stallMs / 1000} s`)
    const onThinkTimeout = () => halt('stalled', `stalled, still planning after ${thinkTimeout / 1000} s`, { planning: true })
    const dog = watchProgress({ position, onPathUpdate, busy, stallMs, thinkTimeout, onStall, onThinkTimeout, planning: false, clock })
    const deadline = routeDeadline({ onExpire: () => halt('budget', `over the budget of ${budgetMs / 1000} s`), ms: budgetMs, clock })
    let running
    try { running = work() } catch (e) { running = Promise.reject(e) }
    running.then((v) => settle(() => resolve(v)), (e) => settle(() => reject(e)))
  })
}

module.exports = { AVOID, UNLOADED, UNKNOWN, standCell, pickupCovers, overPickup, pickupStep, GoalPickup, targetKind, resolveTarget, crumbCentre, nametagGoal, arrivedAt, watchProgress, walkAttempt, routeDeadline, guardWork }
