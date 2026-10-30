'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { performance } = require('perf_hooks')
const { Physics, PlayerState } = require('prismarine-physics')
const { planFlee, creeperCover, routeWithin, walkersTo, groundCell } = require('../lib/flee')
const { isDoor } = require('../lib/doors')
const { legLedger, takenText } = require('../lib/leg-ledger')
const rules = require('../lib/combat-rules')
const { MIN_FOOD } = require('../lib/sprint')
const { LEGACY_HIT_MS, RUN_COAST } = require('../lib/bot/legacy-1710')
const { walkingBody, loadBotFunctions, combatReflexIn, botConstant } = require('./helpers')

// A sprint ends after STALL_TICKS ticks that move the body less than MIN_STEP blocks a tick horizontally on average.
const STALL_TICKS = 4
const MIN_STEP = 0.1

// A body at pos facing yaw under the real pathfinder and prismarine-physics, which alone collides with the unplanned blocks ('x,y,z' -> name).
async function tickedBody (t, pos, yaw, cells, unplanned = {}) {
  const { bot } = await walkingBody(t, pos, cells)
  const Block = require('prismarine-block')(bot.registry)
  const world = {
    getBlock (p) {
      const c = p.floored()
      const name = unplanned[`${c.x},${c.y},${c.z}`]
      if (!name) return bot.blockAt(c)
      const b = Block.fromProperties(name, {}, 0)
      b.position = c
      return b
    }
  }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  // sprints holds each change of the sprint state as [tick, state], steps the horizontal distance of each tick.
  const body = { bot, world, controls, tick: 0, sprints: [], steps: [], cells: new Set() }
  const look = async (yaw, pitch) => { Object.assign(bot.entity, { yaw, pitch }) }
  Object.assign(bot.entity, { yaw, pitch: 0, effects: {}, attributes: {}, isCollidedHorizontally: false })
  Object.assign(bot, {
    physics: Physics(bot.registry, world),
    jumpTicks: 0,
    jumpQueued: false,
    food: 20,
    controlState: controls,
    setControlState (k, v) {
      if (controls[k] === v) return
      controls[k] = v
      if (k === 'sprint') body.sprints.push([body.tick, v])
    },
    getControlState: (k) => controls[k],
    clearControlStates () { for (const k in controls) bot.setControlState(k, false) },
    look,
    lookAt: (p, force) => {
      const d = p.minus(bot.entity.position.offset(0, 1.62, 0))
      return look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)), force)
    },
    inventory: { items: () => [], slots: [] },
    waitForTicks: async (n) => { for (let i = 0; i < n; i++) step(body) }
  })
  body.step = () => step(body)
  return body
}

// One physics tick, then the bot's physicsTick listeners.
function step (body) {
  const { bot } = body
  const from = bot.entity.position.clone()
  bot.physics.simulatePlayer(new PlayerState(bot, body.controls), body.world).apply(bot)
  body.tick++
  const p = bot.entity.position
  body.steps.push(Math.hypot(p.x - from.x, p.z - from.z))
  body.cells.add(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
  bot.emit('physicsTick')
}

// The first sprint end after tick from (at) and how many ticks it came after the last tick of MIN_STEP progress (late).
function stallEnd (body, from = 0) {
  const off = body.sprints.find(([t, on]) => !on && t > from)
  if (!off) return null
  let last = off[0]
  while (last > from && body.steps[last - 1] < MIN_STEP) last--
  return { at: off[0], late: off[0] - last }
}

// A sprint held on the standing body until it ends, then 20 ticks of standing.
function oldStall (body) {
  body.bot.setControlState('sprint', true)
  for (let i = 0; i < 2 * STALL_TICKS && body.controls.sprint; i++) body.step()
  assert.ok(!body.controls.sprint, 'control: the sprint ended')
  for (let i = 0; i < 20; i++) body.step()
  assert.ok(body.bot.pathfinder.sprintBlocked, 'control: sprint stays blocked')
}

// The storage room the walk stalled in, with the chest facings and the cells the body never saw guessed.
const chest = (type) => ['chest', { facing: 'east', type, waterlogged: 'false' }]
const CHESTS = { '754,57': 'left', '754,58': 'right', '754,60': 'left', '754,61': 'right', '755,55': 'left', '755,56': 'right' }
function storageRoom (key) {
  const [x, y, z] = key.split(',').map(Number)
  if (y === 62) return ['oak_planks', {}]
  if (y < 62 || y > 65 || x <= 752 || x >= 758 || z <= 54 || z >= 67) return ['stone', {}]
  const type = CHESTS[`${x},${z}`]
  return type ? chest(type) : ['air', {}]
}
const STORAGE = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? storageRoom(k) : undefined) })
const STALLED_AT = new Vec3(754.8, 63, 62.3)
const STALLED_YAW = 6.1
// The walk a withdraw from the chest at 755 63 56 takes.
const TO_CHEST = () => new goals.GoalNear(755, 63, 56, 2)

const storageBody = (t, unplanned) => tickedBody(t, STALLED_AT.clone(), STALLED_YAW, STORAGE, unplanned)

test('a walk from where the body stalled beside the chest stack passes 755 63 59 to the chest it withdraws from', async (t) => {
  const body = await storageBody(t)
  body.bot.pathfinder.setGoal(TO_CHEST())
  while (body.bot.pathfinder.goal && body.tick < 100) body.step()
  assert.strictEqual(body.bot.pathfinder.goal, null, `the goal is still set after ${body.tick} ticks at ${body.bot.entity.position}`)
  assert.ok(body.cells.has('755,63,59'), `cells walked: ${[...body.cells].join(' ')}`)
})

test('a sprint held against a box the pathfinder walks through ends within 4 ticks and stays off until the body moved a block', async (t) => {
  const unplanned = { '755,63,60': 'stone', '755,64,60': 'stone' }
  const body = await storageBody(t, unplanned)
  body.bot.pathfinder.setGoal(TO_CHEST())
  for (let i = 0; i < 40; i++) body.step()
  assert.ok(body.sprints.length > 0 && body.sprints[0][1], `control: the walk sprints, ${JSON.stringify(body.sprints)}`)
  assert.ok(body.controls.forward, 'control: the pathfinder still holds forward into the box')
  const end = stallEnd(body)
  assert.ok(end, `sprint stays on while the body stands at ${body.bot.entity.position}, ${JSON.stringify(body.sprints)}`)
  assert.ok(end.late <= STALL_TICKS, `sprint ended ${end.late} ticks after the last progress`)
  assert.strictEqual(body.sprints.length, 2, `sprint flips while the body stands, ${JSON.stringify(body.sprints)}`)
  const stood = body.bot.entity.position.clone()
  delete unplanned['755,63,60']
  delete unplanned['755,64,60']
  while (body.sprints.length === 2 && body.bot.pathfinder.goal && body.tick < 120) body.step()
  assert.strictEqual(body.sprints.length, 3, `no sprint once the way opened, ${JSON.stringify(body.sprints)}`)
  const moved = Math.hypot(body.bot.entity.position.x - stood.x, body.bot.entity.position.z - stood.z)
  assert.ok(moved >= 1, `sprint came back after ${moved.toFixed(2)} blocks`)
})

// A stone floor with a trench at x 3-5 that only a sprint jump crosses.
const TRENCH = new Proxy({}, {
  get (_, k) {
    if (typeof k !== 'string') return undefined
    const [x, y] = k.split(',').map(Number)
    return [y <= 63 && (x < 3 || x > 5) ? 'stone' : 'air', {}]
  }
})

test('a walk whose sprint stalled within a block of a sprint-only gap crosses the gap after the stuck reset', async (t) => {
  // A box over the trench's near edge stops the body where it jumps from.
  const unplanned = { '3,64,0': 'stone', '3,65,0': 'stone' }
  const body = await tickedBody(t, new Vec3(0.5, 64, 0.5), -Math.PI / 2, TRENCH, unplanned)
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const tick = () => { now += 50; body.step() }
  const stuck = []
  body.bot.on('path_reset', (reason) => { if (reason === 'stuck') stuck.push(body.tick) })
  body.bot.pathfinder.setGoal(new goals.GoalBlock(8, 64, 0))
  for (let i = 0; i < 20; i++) tick()
  assert.ok(body.sprints.length > 0 && body.sprints[0][1], `control: the walk sprints, ${JSON.stringify(body.sprints)}`)
  assert.ok(stallEnd(body), `control: the box ends the sprint, ${JSON.stringify(body.sprints)}`)
  assert.ok(body.bot.pathfinder.sprintBlocked, 'control: sprint stays blocked at the edge')
  delete unplanned['3,64,0']
  delete unplanned['3,65,0']
  while (body.bot.pathfinder.goal && body.tick < 400) tick()
  assert.ok(stuck.length > 0, `control: the walk crossed before a stuck reset, ${JSON.stringify(body.sprints)}`)
  assert.strictEqual(body.bot.pathfinder.goal, null, `the goal is still set after ${body.tick} ticks at ${body.bot.entity.position}, stuck resets at ticks ${stuck}`)
})

// The real combat reflex over body, as the flee tests run it.
function fleeReflex (body) {
  const { bot } = body
  bot.food = 20
  const legs = legLedger()
  const env = {
    bot,
    Vec3,
    goals,
    ck: (x, y, z) => x + ',' + y + ',' + z,
    planFlee,
    creeperCover,
    routeWithin,
    walkersTo,
    groundCell,
    isDoor,
    WALK_MEMO: botConstant('WALK_MEMO'),
    WALK_STEPS: botConstant('WALK_STEPS'),
    WALK_CAP: botConstant('WALK_CAP'),
    CREEPER_DROP: botConstant('CREEPER_DROP'),
    RANGED: botConstant('RANGED'),
    AGGRO_CONFIRMED: new Map(),
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    fight: { stance: 'guard' },
    shared: { mcData: bot.registry },
    console: { log () {} },
    setTimeout () {},
    cellKnown: () => true,
    reflexes: [{ name: 'flee_to_player', on: true, ally: () => null }],
    nearHostiles: () => [],
    airFlood: () => ({}),
    knownCell: () => true,
    mobClass: () => 'hostile',
    laneBlocks: () => false,
    laneNarrate () {},
    entityPerceptible: () => true,
    takenText,
    takeLegs: (reflex, why) => legs.take(reflex, why),
    stopPath () { bot.pathfinder.setGoal(null) },
    emitEvent () {},
    LEGACY_1710: true,
    MIN_FOOD
  }
  loadBotFunctions(['fleeWorld', 'fleeLog', 'threatWhy', 'creeperSwelling', 'walksToBody', 'rangedInSight'], env)
  return { combat: combatReflexIn(env), env }
}

test('a flee sprint the pathfinder finds no path for ends within 4 ticks while the body stands', async (t) => {
  const body = await tickedBody(t, new Vec3(0.5, 64, 0.5), 0, {})
  // The pathfinder finds no move from the body's cell, as it does where the cells round it are unseen.
  body.bot.pathfinder.movements.getNeighbors = () => []
  const zombie = { id: 9, name: 'zombie', type: 'mob', position: new Vec3(4.5, 64, 0.5), height: 1.95, width: 0.6 }
  body.bot.entities[zombie.id] = zombie
  const { combat, env } = fleeReflex(body)
  env.AGGRO_CONFIRMED.set(zombie.id, { t: Date.now() })
  combat._seenAt.set(zombie.id, zombie.position.clone())
  // The body stood before the zombie came.
  for (let i = 0; i < 3; i++) body.step()
  const fledAt = body.tick
  combat.fleeFrom(body.bot, zombie, null, 'emergency')
  assert.ok(body.bot.pathfinder.goal, 'control: the flee set a goal')
  assert.ok(body.controls.sprint, 'control: the flee sprints')
  for (let i = 0; i < 40; i++) body.step()
  assert.ok(!body.bot.pathfinder.isMoving(), 'control: the pathfinder has no path')
  const end = stallEnd(body, fledAt)
  assert.ok(end, `sprint stays on while the body stands, ${JSON.stringify(body.sprints)}`)
  assert.ok(end.late <= STALL_TICKS, `sprint ended ${end.late} ticks after the flee`)
  assert.strictEqual(body.sprints.length, 2, `sprint flips while the body stands, ${JSON.stringify(body.sprints)}`)
})

test('a flee started long after a sprint stalled sprints at once', async (t) => {
  const body = await tickedBody(t, new Vec3(0.5, 64, 0.5), 0, {})
  const zombie = { id: 9, name: 'zombie', type: 'mob', position: new Vec3(4.5, 64, 0.5), height: 1.95, width: 0.6 }
  body.bot.entities[zombie.id] = zombie
  const { combat, env } = fleeReflex(body)
  env.AGGRO_CONFIRMED.set(zombie.id, { t: Date.now() })
  combat._seenAt.set(zombie.id, zombie.position.clone())
  oldStall(body)
  combat.fleeFrom(body.bot, zombie, null, 'emergency')
  assert.ok(body.bot.pathfinder.goal, 'control: the flee set a goal')
  assert.ok(body.controls.sprint, `the flee runs no sprint, ${JSON.stringify(body.sprints)}`)
})

// The 1.7.10 opener over body, run at a zombie 6 blocks east of x 0.5 z 0.25.
function openerIn (body) {
  const zombie = { id: 9, name: 'zombie', type: 'mob', position: new Vec3(6.5, 64, 0.25), height: 1.95, width: 0.6 }
  body.bot.entities[zombie.id] = zombie
  body.bot.attack = () => {}
  const env = {
    bot: body.bot,
    Vec3,
    fight: { lastAttackT: 0 },
    LEGACY_HIT_MS,
    RUN_COAST,
    RUN_MAX: rules.RUN_MAX,
    RUN_TICKS: rules.RUN_TICKS,
    JUMP_TICKS: rules.JUMP_TICKS,
    JUMP_FALL_TICKS: rules.JUMP_FALL_TICKS,
    runCells: rules.runCells,
    noRunReason: rules.noRunReason,
    noCritReason: rules.noCritReason,
    mobHurt: { wait: () => 0 },
    inMeleeReach: () => false,
    meleeAim: (e) => e.position.offset(0, 1.2, 0),
    knownCell: () => true,
    perched: () => false,
    console: { log () {} }
  }
  return { zombie, ...loadBotFunctions(['meleeSwing', 'sprintBlock'], env) }
}

test('a 1.7.10 sprint opener into a pillar beside its checked line ends its sprint within 4 ticks, and so does the next one', async (t) => {
  // The body's side overlaps the z -1 column, where the pillar stands, and the run line keeps to z 0.
  const cells = { '3,64,-1': ['stone', {}], '3,65,-1': ['stone', {}] }
  const body = await tickedBody(t, new Vec3(0.5, 64, 0.25), -Math.PI / 2, cells)
  const { zombie, meleeSwing, sprintBlock } = openerIn(body)
  assert.strictEqual(sprintBlock(zombie), null, 'control: the run line is clear')
  await meleeSwing(zombie, { run: true })
  assert.ok(body.sprints.length > 0 && body.sprints[0][1], `control: the opener sprints, ${JSON.stringify(body.sprints)}`)
  assert.ok(body.bot.entity.position.x < 2.8, `control: the pillar stops the body, at ${body.bot.entity.position}`)
  const end = stallEnd(body)
  assert.ok(end, `no sprint end, ${JSON.stringify(body.sprints)}`)
  assert.ok(end.late <= STALL_TICKS, `sprint ended ${end.late} ticks after the body hit the pillar, ${JSON.stringify(body.sprints)}`)
  assert.strictEqual(body.sprints.length, 2, `sprint flips during the run, ${JSON.stringify(body.sprints)}`)
  const second = body.tick
  await meleeSwing(zombie, { run: true })
  assert.ok(body.sprints.length > 2 && body.sprints[2][1], `the second opener runs no sprint, ${JSON.stringify(body.sprints)}`)
  const again = stallEnd(body, second)
  assert.ok(again && again.at - second <= STALL_TICKS, `the second opener's sprint ended ${again && again.at - second} ticks after it started`)
  assert.strictEqual(body.sprints.length, 4, `sprint flips during the second run, ${JSON.stringify(body.sprints)}`)
})

test('a 1.7.10 sprint opener started long after a sprint stalled runs at a sprint', async (t) => {
  const body = await tickedBody(t, new Vec3(0.5, 64, 0.25), -Math.PI / 2, {})
  const { zombie, meleeSwing } = openerIn(body)
  oldStall(body)
  const from = body.tick
  await meleeSwing(zombie, { run: true })
  assert.ok(body.sprints.some(([t, on]) => on && t >= from), `the opener runs no sprint, ${JSON.stringify(body.sprints)}`)
  assert.ok(body.bot.entity.position.x > 3, `the opener ran to x ${body.bot.entity.position.x.toFixed(2)}`)
})

test('a sprint the server pulls back 0.3 blocks every other tick ends within 4 ticks of its last gain', async (t) => {
  const body = await tickedBody(t, new Vec3(0.5, 64, 0.5), 0, {})
  const { bot } = body
  bot.setControlState('forward', true)
  bot.setControlState('sprint', true)
  for (let i = 0; i < 10; i++) body.step()
  assert.ok(body.controls.sprint, 'control: the sprint over open ground runs on')
  const from = body.tick
  const home = bot.entity.position.clone()
  for (let i = 0; i < 4 * STALL_TICKS && body.controls.sprint; i++) {
    // The body gains 0.3 blocks, and the next tick a correction puts it back.
    bot.entity.position = home.offset(0, 0, i % 2 ? 0 : -0.3)
    body.tick++
    bot.emit('physicsTick')
  }
  const end = body.sprints.find(([t, on]) => !on && t > from)
  assert.ok(end, `sprint stays on while the body gets nowhere, ${JSON.stringify(body.sprints)}`)
  assert.ok(end[0] - from <= STALL_TICKS, `sprint ended ${end[0] - from} ticks after the last gain`)
})
