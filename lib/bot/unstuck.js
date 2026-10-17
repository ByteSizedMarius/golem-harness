'use strict'

const { Vec3 } = require('vec3')

let bot, legs, emitEvent, centerOnCell, cellText, OPENABLE, stopPath, cellKnown, CONTAINERS, NEIGHBOURS, equipPickFor, placeFiller

// unstuck: watch for the PATHFINDER wedging — isMoving() true but the bot isn't actually advancing.
// Conservative by design: gated on isMoving() so it never touches legitimate slow mining (which isn't
// pathfinder movement).
const unstuckReflex = {
  name: 'unstuck', on: true, active: false,
  _lastPos: null, _stallStart: 0,
  // The cells the walk made progress in, oldest first.
  _crumbs: [],
  check (bot) {
    if (!this._hooked) {                                        // planner heartbeat hookup (07-22)
      try {
        // True from a stuck reset until the goal changes, another reset comes or a replan finds no path.
        bot.on('path_reset', (reason) => { this._stuckLoop = reason === 'stuck' })
        bot.on('goal_updated', (g, dynamic) => {
          this._stuckLoop = false
          this._dynamic = !!dynamic
        })
        // A replan after a stuck reset is no heartbeat.
        bot.on('path_update', (r) => {
          if (r.path.length === 0) this._stuckLoop = false
          if (!this._stuckLoop) this._lastPathUpdate = Date.now()
        })
        this._hooked = true
      } catch (e) {}
    }
    let moving = false
    // The path stays empty for a tick between a stuck reset and its replan.
    try { moving = bot.pathfinder.isMoving() || (!!this._stuckLoop && !!bot.pathfinder.goal) } catch (e) {}
    if (!moving) { this._stallStart = 0; this._lastPos = null; this._crumbs = []; return false }
    const p = bot.entity.position
    if (!this._lastPos) { this._lastPos = p.clone(); this._stallStart = 0; return false }
    const advanced = p.distanceTo(this._lastPos) >= 0.35
    this._lastPos = p.clone()
    if (advanced) {                                             // still making progress
      const c = p.floored()
      const last = this._crumbs[this._crumbs.length - 1]
      if (!last || !last.equals(c)) this._crumbs = [...this._crumbs.slice(-7), c]
      this._stallStart = 0
      return false
    }
    if (!this._stallStart) { this._stallStart = Date.now(); return false }
    const stalled = Date.now() - this._stallStart
    // A long-goal path COMPUTATION is indistinguishable from a wedge out here (isMoving true,
    // zero movement). While the planner still emits path_update heartbeats, give it 30s
    // before declaring wedged — 10s patience was murdering healthy 400-block treks (07-22).
    if (Date.now() - (this._lastPathUpdate || 0) < 8000 && stalled < 30000) return false
    return stalled > 10000                                      // wedged >10s while pathing
  },
  async act () {
    this._stallStart = 0
    this._lastPos = null
    const crumbs = this._crumbs
    this._crumbs = []
    await climbLadder(crumbs, !!this._dynamic)
  }
}

// How long the ladder watches a replanned walk for progress.
const UNSTUCK_WATCH_TICKS = 100

// Frees a wedged body by replan, step back, open or jump, then break, and stops the walk if none works.
async function climbLadder (crumbs, dynamic) {
  const goal = bot.pathfinder.goal
  if (!goal) return
  const stuckAt = bot.entity.position.clone()
  legs.take('unstuck', 'free the body from a wedge')
  const mark = legs.mark()
  const tried = []
  let step = headingStep()
  // True once the ladder is done: the body is free or the walk went to someone else.
  const rung = async (name, what, event) => {
    tried.push(name)
    const how = await replanWatch(goal, dynamic, stuckAt, mark)
    console.log(`[unstuck] ${name} ${what}: ${how}`)
    if (how === 'freed' && event) emitEvent('reflex', 'unstuck: ' + event)
    if (how === 'stuck') step = headingStep()
    return how !== 'stuck'
  }
  const elsewhere = (name) => {
    if (legs.mark() === mark) return false
    console.log(`[unstuck] ${name}: the legs went elsewhere`)
    return true
  }

  await idleLegs()
  const wedge = bodyOverlap()
  const free = wedge && nearestStandable()
  if (free) await centerOnCell(free)
  else if (!wedge) await centerOnCell()
  const from = cellText(bot.entity.position.floored())
  const inside = !wedge ? '' : free ? `, out of the ${wedge.name}` : ` inside the ${wedge.name}`
  if (await rung('replan', `from ${from}${inside}`, `replanned the walk from ${from}`)) return

  if (elsewhere('step back')) return
  const here = bot.entity.position.floored()
  const back = crumbs.slice().reverse().find((c) => !c.equals(here) && c.y === here.y && Math.hypot(c.x - here.x, c.z - here.z) <= 3 && standable(c))
  if (!back) console.log('[unstuck] step back: no earlier free cell')
  else {
    await idleLegs()
    if (await centerOnCell(back)) {
      if (await rung('step back', `to ${cellText(back)}`, `stepped back to ${cellText(back)}`)) return
    } else {
      tried.push('step back')
      console.log(`[unstuck] step back to ${cellText(back)}: did not get there`)
    }
  }

  if (elsewhere('open or jump')) return
  const front = bot.entity.position.floored().plus(step)
  const door = [front, front.offset(0, 1, 0)].map((c) => bot.blockAt(c))
    .find((b) => b && OPENABLE.test(b.name) && !b.name.startsWith('iron_') && unstuckKnows(b.position) && !b.getProperties().open)
  if (door) {
    const what = `the ${door.name} at ${cellText(door.position)}`
    await idleLegs()
    const failed = await tryStep(() => bot.activateBlock(door))
    if (failed) {
      tried.push('open')
      console.log(`[unstuck] open ${what}: ${failed}`)
    } else if (await rung('open', what, `opened ${what}`)) return
  } else if (canJumpOnto(front)) {
    const what = `the ${bot.blockAt(front).name} at ${cellText(front)}`
    await idleLegs()
    if (await jumpOnto(front)) {
      if (await rung('jump', `onto ${what}`, `jumped onto ${what}`)) return
    } else {
      tried.push('jump')
      console.log(`[unstuck] jump onto ${what}: did not get up`)
    }
  } else console.log('[unstuck] open or jump: no door or step in front')

  if (elsewhere('break')) return
  const start = bot.entity.position.floored()
  const plan = breakPlan(start.plus(step))
  if (plan.refusal) {
    tried.push(`break refused (${plan.refusal})`)
    console.log(`[unstuck] break refused: ${plan.refusal}`)
  } else {
    await idleLegs()
    const out = await breakThrough(plan.cells, start, step)
    const names = (list) => list.map((b) => `${b.name} at ${cellText(b.cell)}`).join(' and ')
    tried.push('break')
    if (out.broken.length) {
      const fate = out.left.length ? `could not put back ${names(out.left)}` : out.broken.length > 1 ? 'put them back' : 'put it back'
      emitEvent('reflex', `unstuck: broke ${names(out.broken)} to get through${out.through ? '' : ' but the way on was blocked'}, ${fate}`)
    }
    const what = names(out.broken.length ? out.broken : plan.cells)
    if (out.through) {
      if (await rung('break', what, null)) return
    } else console.log(`[unstuck] break ${what}: not through${out.error ? ` (${out.error})` : ''}`)
  }

  if (elsewhere('stop')) return
  await idleLegs()
  const text = stuckText(tried, step)
  console.log('[unstuck] stop ' + text)
  emitEvent('reflex', 'unstuck: ' + text)
}

// Waits 2 ticks after the stop for the server to correct the position.
async function idleLegs () {
  stopPath()
  bot.clearControlStates()
  await bot.waitForTicks(2)
}

// 'freed' once the body reaches the goal or is 1.5 from stuckAt and nearer the goal, 'ended' if the goal or legs went elsewhere, else 'stuck'.
async function replanWatch (goal, dynamic, stuckAt, mark) {
  bot.pathfinder.setGoal(goal, dynamic)
  const h0 = goal.heuristic(stuckAt.floored())
  for (let t = 0; t < UNSTUCK_WATCH_TICKS; t += 5) {
    await bot.waitForTicks(5)
    const p = bot.entity.position
    if (goal.isEnd(p.floored())) return 'freed'
    if (bot.pathfinder.goal !== goal || legs.mark() !== mark) return 'ended'
    if (p.distanceTo(stuckAt) >= 1.5 && goal.heuristic(p.floored()) < h0) return 'freed'
  }
  return 'stuck'
}

async function tryStep (fn) {
  try {
    await fn()
    return null
  } catch (e) {
    return e.message
  }
}

function headingStep () {
  const dx = -Math.sin(bot.entity.yaw)
  const dz = -Math.cos(bot.entity.yaw)
  return Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
}

// The cells the body's box touches and the row beneath them.
function bodyCells () {
  const p = bot.entity.position
  const cells = []
  for (let x = Math.floor(p.x - 0.3); x <= Math.floor(p.x + 0.3); x++) {
    for (let y = Math.floor(p.y) - 1; y <= Math.floor(p.y + 1.8); y++) {
      for (let z = Math.floor(p.z - 0.3); z <= Math.floor(p.z + 0.3); z++) cells.push(new Vec3(x, y, z))
    }
  }
  return cells
}

// The first block whose collision box the body's box overlaps, or null.
function bodyOverlap () {
  const p = bot.entity.position
  const E = 1e-3
  for (const c of bodyCells()) {
    const b = bot.blockAt(c)
    for (const s of (b && b.shapes) || []) {
      if (p.x + 0.3 > c.x + s[0] + E && p.x - 0.3 < c.x + s[3] - E && p.y + 1.8 > c.y + s[1] + E && p.y < c.y + s[4] - E &&
        p.z + 0.3 > c.z + s[2] + E && p.z - 0.3 < c.z + s[5] - E) return b
    }
  }
  return null
}

function unstuckKnows (p) {
  return bodyCells().some((c) => c.equals(p)) || cellKnown(p)
}

function passable (p) {
  const b = bot.blockAt(p)
  return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name)
}

function standable (c) {
  const floor = bot.blockAt(c.offset(0, -1, 0))
  return [c, c.offset(0, 1, 0), c.offset(0, -1, 0)].every(unstuckKnows) && passable(c) && passable(c.offset(0, 1, 0)) &&
    !!floor && floor.boundingBox === 'block'
}

function nearestStandable () {
  const p = bot.entity.position
  const feet = p.floored()
  const cells = []
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cells.push(feet.offset(dx, 0, dz))
  const dist = (c) => Math.hypot(c.x + 0.5 - p.x, c.z + 0.5 - p.z)
  return cells.sort((a, b) => dist(a) - dist(b)).find(standable) || null
}

function canJumpOnto (front) {
  const b = bot.blockAt(front)
  const above = front.offset(0, 1, 0)
  const lift = bot.entity.position.floored().offset(0, 2, 0)
  return !!b && b.boundingBox === 'block' && Math.max(...b.shapes.map((s) => s[4])) <= 1 &&
    [front, above, above.offset(0, 1, 0), lift].every(unstuckKnows) &&
    passable(above) && passable(above.offset(0, 1, 0)) && passable(lift)
}

async function jumpOnto (front) {
  const up = () => {
    const p = bot.entity.position
    return p.y >= front.y + 1 && Math.floor(p.x) === front.x && Math.floor(p.z) === front.z
  }
  await bot.lookAt(new Vec3(front.x + 0.5, bot.entity.position.y + 1.62, front.z + 0.5), true)
  try {
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    for (let i = 0; i < 20 && !up(); i++) await bot.waitForTicks(1)
  } finally {
    bot.setControlState('jump', false)
    bot.setControlState('forward', false)
  }
  return up()
}

// The blocks at front and above it to break and put back, or why none may be broken.
function breakPlan (front) {
  const cells = [front, front.offset(0, 1, 0)].filter((c) => {
    const b = bot.blockAt(c)
    return !!b && b.boundingBox === 'block'
  })
  if (!cells.length) return { refusal: 'nothing solid in front' }
  if (!cells.every(unstuckKnows)) return { refusal: 'the block in front is unseen' }
  const need = {}
  for (const c of cells) {
    const b = bot.blockAt(c)
    const why = keepWhole(b, c)
    if (why) return { refusal: `the ${b.name} at ${cellText(c)} ${why}` }
    need[b.name] = (need[b.name] || 0) + 1
  }
  for (const [name, n] of Object.entries(need)) {
    const have = bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0)
    if (have < n) return { refusal: `no ${name} in pockets to put back` }
  }
  const floor = front.offset(0, -1, 0)
  const fb = bot.blockAt(floor)
  if (!unstuckKnows(floor) || !fb || fb.boundingBox !== 'block') return { refusal: `no floor to walk on at ${cellText(floor)}` }
  return { cells: cells.map((c) => ({ cell: c, name: bot.blockAt(c).name })) }
}

// Why the block b at c stays whole, or null.
function keepWhole (b, c) {
  if (!b.diggable || b.name === 'bedrock') return 'cannot be broken'
  if (CONTAINERS.test(b.name)) return 'is a container'
  if (OPENABLE.test(b.name)) return 'is a door'
  if (/(^|_)bed$/.test(b.name)) return 'is a bed'
  const wet = (p) => unstuckKnows(p) && /water|lava/.test((bot.blockAt(p) || {}).name || '')
  if ((b.getProperties() || {}).waterlogged || NEIGHBOURS.some(([dx, dy, dz]) => wet(c.offset(dx, dy, dz)))) return 'holds back liquid'
  return null
}

// Breaks cells, walks through and puts the same blocks back, from start if the way on is blocked.
async function breakThrough (cells, start, step) {
  let broken = []
  let error = null
  for (const { cell, name } of [...cells].reverse()) {
    await equipPickFor(name)
    error = await tryStep(() => bot.dig(bot.blockAt(cell)))
    if (error || !passable(cell)) break
    broken.push({ cell, name })
  }
  broken = broken.sort((a, b) => a.cell.y - b.cell.y)
  const front = start.plus(step)
  const past = front.plus(step)
  let through = false
  if (broken.length === cells.length && standable(past)) {
    error = (await tryStep(async () => { through = await centerOnCell(front) && await centerOnCell(past) })) || error
  }
  if (!through) error = (await tryStep(() => centerOnCell(start))) || error
  const left = []
  for (const b of broken) {
    const item = bot.inventory.items().find((i) => i.name === b.name)
    if (item) error = (await tryStep(() => placeFiller(b.cell, item))) || error
    if (bot.blockAt(b.cell).name !== b.name) left.push(b)
  }
  return { through, broken, left, error }
}

function stuckText (tried, step) {
  const feet = bot.entity.position.floored()
  const front = feet.plus(step)
  const wall = [front, front.offset(0, 1, 0)].find((c) => {
    const b = bot.blockAt(c)
    return !!b && b.boundingBox === 'block' && unstuckKnows(c)
  })
  const at = `stuck at ${cellText(feet)}` + (wall ? ` against ${bot.blockAt(wall).name} at ${cellText(wall)}` : '')
  return `${at}, tried ${tried.join(', ')}`
}

function createUnstuck (ctx) {
  Object.assign(ctx, { unstuckReflex, UNSTUCK_WATCH_TICKS, climbLadder, idleLegs, replanWatch, tryStep, headingStep, bodyCells, bodyOverlap, unstuckKnows, passable, standable, nearestStandable, canJumpOnto, jumpOnto, breakPlan, keepWhole, breakThrough, stuckText })
}

function bindUnstuck (ctx) {
  ({ bot, legs, emitEvent, centerOnCell, cellText, OPENABLE, stopPath, cellKnown, CONTAINERS, NEIGHBOURS, equipPickFor, placeFiller } = ctx)
}

module.exports = { createUnstuck, bindUnstuck }
