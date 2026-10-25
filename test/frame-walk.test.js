'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Physics, PlayerState } = require('prismarine-physics')
const rules = require('../lib/combat-rules')
const { HITBOX_1710, LEGACY_SNEAK_EYE } = require('../lib/bot/legacy-1710')
const { loadBotFunctions, delay } = require('./helpers')

// A body with its feet at pos under the real pathfinder, on a stone floor at y 63 with the blocks in cells
// ('x,y,z' -> [name, properties]), and the bot.js inMeleeReach, meleeReachGoal and names over it and more.
async function body (pos, cells = {}, names = [], more = {}) {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.write = () => {}
  client.end = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  bot.loadPlugin(pathfinder)
  await once(bot, 'inject_allowed')
  const Block = require('prismarine-block')(bot.registry)
  Object.assign(bot, {
    entity: { position: pos, velocity: new Vec3(0, 0, 0), width: 0.6, height: 1.8, onGround: true },
    entities: {},
    game: { minY: -64, height: 384, dimension: 'overworld' },
    inventory: { items: () => [] },
    clearControlStates () {},
    blockAt (p) {
      const c = p.floored()
      const [name, props] = cells[`${c.x},${c.y},${c.z}`] || [c.y <= 63 ? 'stone' : 'air', {}]
      const b = Block.fromProperties(name, props, 0)
      b.position = c
      return b
    }
  })
  const moves = new Movements(bot)
  moves.canDig = false
  // The bot's walker opens wooden doors.
  bot.registry.blocksArray.forEach((b) => { if (b.name.endsWith('_door') && !b.name.includes('iron')) moves.openable.add(b.id) })
  moves.canOpenDoors = true
  // One call finishes the search, so a loaded machine cannot cut the first tick short into 'partial'.
  const plan = (goal) => {
    bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
    return bot.pathfinder.getPathFromTo(moves, bot.entity.position, goal).next().value.result
  }
  const env = { bot, Vec3, goals, shared: {}, LEGACY_1710: false, HITBOX_1710, LEGACY_SNEAK_EYE, SWING_REACH: rules.SWING_REACH, ...more }
  return { bot, moves, plan, ...loadBotFunctions(['inMeleeReach', 'meleeReachGoal', ...names], env) }
}

// A frame spawned at the corner of cell x,y,z, facing objectData.
const frame = (objectData, x, y, z) => ({ id: 20, name: 'item_frame', width: 0.5, height: 0.5, position: new Vec3(x, y, z), objectData })

// The pathfinder stops a walk up to 0.2 off the centre of its last cell per axis.
const stops = (n) => [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([dx, dz]) => new Vec3(Math.floor(n.x) + 0.5 + dx * 0.2, n.y, Math.floor(n.z) + 0.5 + dz * 0.2))

// The plan to frame f from pos, and the stops at its end node out of swing reach.
async function walkTo (f, pos, cells) {
  const b = await body(pos, cells)
  const result = b.plan(b.meleeReachGoal(f, 0.6))
  const end = result.path[result.path.length - 1]
  return { result, b, short: end ? stops(end).filter((p) => !b.inMeleeReach(f, 0.6, p)).map((p) => p.toArray()) : null }
}

test('a frame walk from off the centre of a cell whose centre has the frame in swing reach leaves that cell for one in reach', async () => {
  const f = frame(4, 3, 65, 0)
  const { result, b, short } = await walkTo(f, new Vec3(1.05, 64, -0.95))
  assert.deepStrictEqual([b.inMeleeReach(f, 0.6), b.inMeleeReach(f, 0.6, new Vec3(1.5, 64, -0.5))], [false, true], 'control: the body is out of reach and its cell centre in reach')
  assert.strictEqual(result.status, 'success')
  assert.ok(result.path.length > 0, 'the walk ends where it starts')
  assert.deepStrictEqual(short, [])
})

test('a frame walk from the top of a slab judges the start by the eye over the slab, half a block below the start node', async () => {
  const f = frame(0, 3, 67, 0)
  const slab = { '0,64,0': ['smooth_stone_slab', { type: 'bottom', waterlogged: 'false' }] }
  const { result, b, short } = await walkTo(f, new Vec3(0.5, 64.5, 0.5), slab)
  assert.deepStrictEqual([b.inMeleeReach(f, 0.6), b.inMeleeReach(f, 0.6, new Vec3(0.5, 65, 0.5))], [false, true], 'control: the body is out of reach and the start node in reach')
  assert.strictEqual(result.status, 'success')
  assert.ok(result.path.length > 0, 'the walk ends where it starts')
  assert.deepStrictEqual(short, [])
})

test('a frame walk at a slant ends on a cell whose every stop puts the frame in swing reach', async () => {
  // A frame 3 above the floor on a wall at x 4.
  const f = frame(4, 3, 67, 0)
  const wall = {}
  for (let y = 64; y <= 68; y++) for (let z = -9; z <= 9; z++) wall[`4,${y},${z}`] = ['stone', {}]
  for (const [x, z] of [[-4.5, -7.5], [-3.5, 7.5], [-6.5, -6.5]]) {
    const { result, short } = await walkTo(f, new Vec3(x, 64, z), wall)
    assert.strictEqual(result.status, 'success', `from ${x},${z}`)
    assert.deepStrictEqual(short, [], `from ${x},${z}, the end ${result.path.at(-1)}`)
  }
})

const SLAB = ['smooth_stone_slab', { type: 'bottom', waterlogged: 'false' }]

test('a frame walk over a slab floor ends on a cell whose every stop on the slab puts the frame in swing reach', async () => {
  // A frame on a wall at x 4, its face centre 3 above the slab tops.
  const f = frame(4, 3, 67, 0)
  const room = {}
  for (let x = -10; x <= 3; x++) for (let z = -9; z <= 9; z++) room[`${x},64,${z}`] = SLAB
  for (let y = 64; y <= 70; y++) for (let z = -9; z <= 9; z++) room[`4,${y},${z}`] = ['stone', {}]
  for (const [x, z] of [[-4.5, -2.5], [0.5, -6.5]]) {
    const { result, short } = await walkTo(f, new Vec3(x, 64.5, z), room)
    assert.strictEqual(result.status, 'success', `from ${x},${z}`)
    assert.deepStrictEqual(short, [], `from ${x},${z}, the end ${result.path.at(-1)}`)
  }
})

test('a frame walk over a slab floor reaches a frame low on the far wall of a chasm from its edge', async () => {
  // A frame with its face centre level with the slab tops, on the far wall of a two wide chasm too deep to drop into.
  const f = frame(4, 4, 64, 0)
  const room = {}
  for (let x = -10; x <= 2; x++) for (let z = -9; z <= 9; z++) room[`${x},64,${z}`] = SLAB
  for (let x = 3; x <= 4; x++) for (let y = 40; y <= 64; y++) for (let z = -9; z <= 9; z++) room[`${x},${y},${z}`] = ['air', {}]
  for (let y = 40; y <= 70; y++) for (let z = -9; z <= 9; z++) room[`5,${y},${z}`] = ['stone', {}]
  const { result, b, short } = await walkTo(f, new Vec3(-1.5, 64.5, 0.5), room)
  assert.ok(b.inMeleeReach(f, 0.6, new Vec3(2.5, 64.5, 0.5)), 'control: the frame is in reach from the chasm edge')
  assert.strictEqual(result.status, 'success')
  assert.deepStrictEqual(short, [])
})

test('a frame walk from against a fence post judges the start by the body, not by the free column the pathfinder starts from', async () => {
  // The body's box touches the post in its floored column x 1, and the pathfinder starts from column x 0.
  const f = frame(5, -2, 66, 0)
  const cells = { '1,64,0': ['oak_fence', { east: 'false', north: 'false', south: 'false', west: 'false', waterlogged: 'false' }] }
  for (let y = 64; y <= 70; y++) for (let z = -9; z <= 9; z++) cells[`-3,${y},${z}`] = ['stone', {}]
  const { result, b, short } = await walkTo(f, new Vec3(1.075, 64, 0.5), cells)
  assert.deepStrictEqual([b.inMeleeReach(f, 0.6), stops({ x: 0.5, y: 64, z: 0.5 }).every((p) => b.inMeleeReach(f, 0.6, p))], [false, true], 'control: the body is out of reach and every stop in column x 0 in reach')
  assert.strictEqual(result.status, 'success')
  assert.ok(result.path.length > 0, 'the walk ends where it starts')
  assert.deepStrictEqual(short, [])
})

test('a frame walk goal judges by the body only the start column of the body that built it', async () => {
  const f = frame(4, 3, 65, 0)
  const b = await body(new Vec3(-5.5, 64, 0.5))
  const goal = b.meleeReachGoal(f, 0.6)
  b.bot.entity.position = new Vec3(1.79, 64, -1.21)
  assert.deepStrictEqual([b.inMeleeReach(f, 0.6), stops({ x: 1, y: 64, z: -2 }).every((p) => b.inMeleeReach(f, 0.6, p))], [true, false], 'control: the moved body is in reach and a stop in its column out of reach')
  assert.deepStrictEqual([goal.isEnd(new Vec3(-6, 64, 0)), goal.isEnd(new Vec3(1, 64, -2))], [false, false])
})

test('a frame walk goal judges its start column by the reach of the body that built it, after the body walked off', async () => {
  const f = frame(4, 3, 65, 0)
  const b = await body(new Vec3(1.79, 64, -1.21))
  const built = b.inMeleeReach(f, 0.6)
  const goal = b.meleeReachGoal(f, 0.6)
  b.bot.entity.position = new Vec3(-5.5, 64, 0.5)
  assert.deepStrictEqual([built, b.inMeleeReach(f, 0.6), stops({ x: 1, y: 64, z: -2 }).every((p) => b.inMeleeReach(f, 0.6, p))], [true, false, false], 'control: the body in reach at build, out of reach after, and a stop in the start column out of reach')
  assert.strictEqual(goal.isEnd(new Vec3(1, 64, -2)), true)
})

// body() with the bot.js walkToFrame over more, its legs moved by prismarine-physics one step() at a time.
async function framer (pos, cells, more = {}) {
  const b = await body(pos, cells, ['walkToFrame'], { setTimeout, clearTimeout, ...more })
  const { bot } = b
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const world = { getBlock: (p) => bot.blockAt(p) }
  Object.assign(bot.entity, { yaw: 0, pitch: 0, effects: {}, attributes: {}, isCollidedHorizontally: false })
  Object.assign(bot, {
    version: '1.21.11',
    physics: Physics(bot.registry, world),
    jumpTicks: 0,
    jumpQueued: false,
    controlState: controls,
    setControlState (k, v) { controls[k] = v },
    clearControlStates () { for (const k in controls) controls[k] = false },
    look: async (yaw, pitch) => { Object.assign(bot.entity, { yaw, pitch }) },
    inventory: { items: () => [], slots: [] }
  })
  bot.pathfinder.setMovements(b.moves)
  b.step = () => {
    bot.physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot)
    bot.emit('physicsTick')
  }
  return b
}

test('a frame walk whose first search slice comes back partial with no steps walks on into swing reach', async () => {
  const f = frame(4, 3, 67, 0)
  const wall = {}
  for (let y = 64; y <= 68; y++) for (let z = -9; z <= 9; z++) wall[`4,${y},${z}`] = ['stone', {}]
  const b = await framer(new Vec3(-4.5, 64, -7.5), wall)
  const { bot } = b
  const updates = []
  bot.on('path_update', (r) => {
    updates.push([r.status, r.path.length > 0])
    r.context.tickTimeout = bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
  })
  // A negative tickTimeout ends the first slice before it takes a node.
  bot.pathfinder.tickTimeout = -1
  let out = null
  b.walkToFrame('frame', f, 20000, () => false).then((v) => { out = v }, (e) => { out = e })
  // Each step waits out goto's zero-delay resolve.
  for (let t = 0; t < 600 && out === null; t++) {
    b.step()
    await delay(0)
  }
  assert.deepStrictEqual(updates[0], ['partial', false], 'control: a partial first slice with no steps')
  assert.strictEqual(out, true)
  assert.ok(b.inMeleeReach(f, 0.6), `the body at ${bot.entity.position}`)
})

test('a frame walk whose time runs out in swing reach on a stop that recentres the body out of reach runs out of time', async () => {
  // A walk along z 0.5 to a frame on a wall at x 4, whose time runs out on the first tick in reach.
  const f = frame(4, 3, 65, 0)
  const wall = {}
  for (let y = 64; y <= 68; y++) for (let z = -9; z <= 9; z++) wall[`4,${y},${z}`] = ['stone', {}]
  let deadline = null
  const b = await framer(new Vec3(-4.5, 64, 0.5), wall, { setTimeout: (fn) => { deadline = fn }, clearTimeout () {} })
  const { bot } = b
  let out = null
  b.walkToFrame('frame', f, 20000, () => false).then((v) => { out = v }, (e) => { out = e })
  for (let t = 0; t < 600 && out === null && !b.inMeleeReach(f, 0.6); t++) {
    b.step()
    await delay(0)
  }
  const at = bot.entity.position.clone()
  const centre = new Vec3(Math.floor(at.x) + 0.5, at.y, at.z)
  assert.deepStrictEqual([out, b.inMeleeReach(f, 0.6), at.z, at.x - centre.x > 0.2, b.inMeleeReach(f, 0.6, centre)], [null, true, 0.5, true, false], `control: the walk in reach at ${at} more than 0.2 past its cell centre, which is out of reach`)
  deadline()
  await delay(0)
  assert.match(String(out?.message ?? out), /ran out of time/)
  assert.deepStrictEqual(bot.entity.position.toArray(), centre.toArray())
})

test('a frame walk over a full snow floor judges each stop by the eye over the snow', async () => {
  // A frame low on a wall at x 4, over snow 7/8 deep everywhere but the frame's cell.
  const f = frame(4, 3, 64, 0)
  const room = {}
  for (let x = -10; x <= 3; x++) for (let z = -9; z <= 9; z++) room[`${x},64,${z}`] = ['snow', { layers: '8' }]
  delete room['3,64,0']
  for (let y = 64; y <= 70; y++) for (let z = -9; z <= 9; z++) room[`4,${y},${z}`] = ['stone', {}]
  const { result, short } = await walkTo(f, new Vec3(-4.5, 64.875, -2.5), room)
  assert.strictEqual(result.status, 'success')
  assert.deepStrictEqual(short, [], `the end ${result.path.at(-1)}`)
})

test('a frame walk over a slab floor ends where the pathfinder judges the floored feet in the slab arrived', async () => {
  // A frame on a wall at x 4, its face centre 3 above the slab tops.
  const f = frame(4, 3, 67, 0)
  const room = {}
  for (let x = -10; x <= 3; x++) for (let z = -9; z <= 9; z++) room[`${x},64,${z}`] = SLAB
  for (let y = 64; y <= 70; y++) for (let z = -9; z <= 9; z++) room[`4,${y},${z}`] = ['stone', {}]
  const { result, b } = await walkTo(f, new Vec3(-4.5, 64.5, -2.5), room)
  const end = result.path.at(-1)
  assert.strictEqual(result.status, 'success')
  assert.ok(b.meleeReachGoal(f, 0.6).isEnd(new Vec3(end.x, end.y, end.z).floored()), `the end ${end}`)
})

test('a frame walk through an open door judges a stop in the doorway from the floor', async () => {
  // A two high wall at x 1 with an open door at z 0, and a frame high on a wall at x 4.
  const f = frame(4, 3, 67, 0)
  const room = {}
  for (let y = 64; y <= 65; y++) for (let z = -9; z <= 9; z++) room[`1,${y},${z}`] = ['stone', {}]
  for (let y = 64; y <= 70; y++) for (let z = -9; z <= 9; z++) room[`4,${y},${z}`] = ['stone', {}]
  for (const half of ['lower', 'upper']) room[`1,${half === 'lower' ? 64 : 65},0`] = ['oak_door', { facing: 'east', half, hinge: 'left', open: 'true', powered: 'false' }]
  const { result, short } = await walkTo(f, new Vec3(-3.5, 64, 0.5), room)
  assert.strictEqual(result.status, 'success')
  assert.deepStrictEqual(short, [], `the end ${result.path.at(-1)}`)
})
