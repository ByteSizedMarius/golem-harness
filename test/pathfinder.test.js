'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Physics } = require('prismarine-physics')
const { GRAVESTONE } = require('../lib/server-overrides')
const { botConstant, groundMemory, loadBotFunctions } = require('./helpers')

const WALL_ARM = ['cobblestone_wall', { up: 'false', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }]
const WALL_POST = ['cobblestone_wall', { up: 'true', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }]
const door = (half) => ['oak_door', { facing: 'east', half, hinge: 'left', open: 'false', powered: 'false' }]

// A body at pos under the real pathfinder, on a stone floor at y 63 with the blocks in cells ('x,y,z' -> [name, properties]).
async function body (pos, cells) {
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
  bot.registry.blocksArray.forEach((b) => { if (b.name.endsWith('_door') && !b.name.includes('iron')) moves.openable.add(b.id) })
  moves.canOpenDoors = true
  moves.canDig = false
  // One call finishes the search, so a loaded machine cannot cut the first tick short into 'partial'.
  const plan = (goal) => {
    bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
    return bot.pathfinder.getPathFromTo(moves, bot.entity.position, goal).next().value.result
  }
  return { bot, plan, moves }
}

function wallLine (x, at) {
  const cells = {}
  for (let z = -2; z <= 2; z++) cells[`${x},64,${z}`] = at(z)
  return cells
}

test('a path through a door aims at the centre of the door cell and of every cell after it', async () => {
  const cells = {}
  for (let z = -2; z <= 2; z++) {
    cells[`2,64,${z}`] = z === 0 ? door('lower') : ['stone', {}]
    cells[`2,65,${z}`] = z === 0 ? door('upper') : ['stone', {}]
  }
  const { plan } = await body(new Vec3(0.5, 64, 0.5), cells)
  const result = plan(new goals.GoalBlock(5, 64, 0))
  assert.strictEqual(result.status, 'success')
  const at = result.path.findIndex((n) => n.toPlace.length > 0)
  assert.deepStrictEqual(result.path.slice(at).map((n) => [n.x, n.y, n.z]), [[2.5, 64, 0.5], [3.5, 64, 0.5], [4.5, 64, 0.5], [5.5, 64, 0.5]])
})

test('a body flush against a wall plans from the free cell it stands in, not from inside the wall', async () => {
  for (const [label, middle] of [['against an arm', WALL_ARM], ['into a post', WALL_POST]]) {
    const { plan } = await body(new Vec3(0.0125, 64, 0.5), wallLine(0, (z) => (z === 0 ? middle : WALL_ARM)))
    const result = plan(new goals.GoalBlock(2, 64, 0))
    assert.strictEqual(result.status, 'success', label)
    assert.ok(Math.floor(result.path[0].x) < 0, `${label}: the first step stays west of the wall`)
    assert.ok(result.path.some((n) => Math.abs(Math.floor(n.z)) > 2), `${label}: the path rounds the wall's end`)
  }
})

test('a stop beside a wall leaves the body flush instead of centring it into the wall', async () => {
  const { bot } = await body(new Vec3(0.0125, 64, 0.5), wallLine(0, () => WALL_ARM))
  bot.pathfinder.setGoal(new goals.GoalBlock(0, 64, 0))
  bot.emit('physicsTick')
  assert.strictEqual(bot.pathfinder.goal, null, 'control: the goal was reached and the body stopped')
  assert.deepStrictEqual([bot.entity.position.x, bot.entity.position.z], [0.0125, 0.5])
})

// The real pathfinder's first-tick control states from x 0 towards x 6.
async function firstTick (cells) {
  const { bot, moves } = await body(new Vec3(0.5, 64, 0.5), cells)
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  Object.assign(bot.entity, { yaw: 0, pitch: 0, effects: {}, attributes: {} })
  Object.assign(bot, {
    physics: Physics(bot.registry, { getBlock: (p) => bot.blockAt(p) }),
    jumpTicks: 0,
    jumpQueued: false,
    controlState: controls,
    setControlState (k, v) { controls[k] = v },
    look: async () => {},
    inventory: { items: () => [], slots: [] }
  })
  bot.pathfinder.setMovements(moves)
  bot.pathfinder.setGoal(new goals.GoalBlock(6, 64, 0))
  bot.emit('physicsTick')
  return controls
}

const STONE = ['stone', {}]
const FARMLAND = ['farmland', { moisture: 7 }]
const WHEAT = ['wheat', { age: 7 }]

function step (top) {
  const cells = {}
  for (let z = -8; z <= 8; z++) cells[`1,64,${z}`] = top
  return cells
}

const START = new Vec3(0.5, 64, 0.5)
// The nodes of path the body jumps to: jump landings and steps up.
const jumps = (path) => path.filter((n, i) => n.parkour || n.y - (i ? path[i - 1] : START).y > 0.5)
const rounds = (path) => path.some((n) => Math.abs(Math.floor(n.z)) > 8)

test('the pathfinder jumps up a step of farmland like one of stone', async () => {
  for (const [label, top] of [['stone', STONE], ['farmland', FARMLAND]]) {
    const { plan } = await body(START, step(top))
    const result = plan(new goals.GoalBlock(6, 64, 0))
    assert.ok(jumps(result.path)[0] === result.path[0] && !rounds(result.path), `${label}: a jump straight up the step`)
    assert.strictEqual((await firstTick(step(top))).jump, true, `${label}: the body jumps`)
  }
})

// A field at x 1 to 6 across z -8 to 8, a block below the start's floor, with a stone strip at its level along z 9.
function ledge (floor) {
  const cells = {}
  for (let x = 1; x <= 6; x++) {
    for (let z = -8; z <= 9; z++) {
      cells[`${x},63,${z}`] = ['air', {}]
      cells[`${x},62,${z}`] = z <= 8 ? floor : STONE
    }
  }
  return cells
}

// The nodes of path the body falls to, and the name of the floor under a node.
const drops = (path) => path.filter((n, i) => (i ? path[i - 1] : START).y - n.y > 0.5)
const floorAt = (cells, n) => {
  const y = Math.ceil(n.y) - 1
  return (cells[`${Math.floor(n.x)},${y},${Math.floor(n.z)}`] || [y <= 63 ? 'stone' : 'air'])[0]
}

test('the pathfinder walks round to drop onto stone rather than onto a field, and walks onto the field from its level', async () => {
  const stone = await body(START, ledge(STONE))
  const drop = stone.plan(new goals.GoalBlock(6, 63, 0))
  assert.ok(drops(drop.path)[0] === drop.path[0] && !rounds(drop.path), 'control: a drop straight onto the stone')
  const cells = ledge(FARMLAND)
  const { plan } = await body(START, cells)
  const result = plan(new goals.GoalBlock(6, 63, 0))
  assert.strictEqual(result.status, 'success')
  assert.deepStrictEqual(drops(result.path).map((n) => floorAt(cells, n)), ['stone'])
  assert.ok(rounds(result.path), 'the path rounds the field to the strip')
})

test('a body that can dig digs down beside a field rather than onto it', async () => {
  // Dirt round the start keeps the search for a dig short.
  const dirt = {}
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) dirt[`${x},63,${z}`] = ['dirt', {}]
  const stone = await body(START, dirt)
  stone.moves.canDig = true
  const down = stone.plan(new goals.GoalBlock(0, 63, 0))
  assert.deepStrictEqual(down.path.map((n) => [n.x, n.y, n.z, n.toBreak.length]), [[0, 63, 0, 1]], 'control: a dig straight down')
  const cells = { ...dirt, '0,62,0': FARMLAND }
  const { plan, moves } = await body(START, cells)
  moves.canDig = true
  const result = plan(new goals.GoalBlock(0, 63, 0))
  assert.strictEqual(result.status, 'success')
  assert.ok(result.path.length > 1 && drops(result.path).every((n) => floorAt(cells, n) !== 'farmland'))
})

test('the pathfinder walks straight across a field', async () => {
  const cells = {}
  for (const x of [1, 2, 4]) cells[`${x},63,0`] = FARMLAND
  cells['2,64,0'] = cells['4,64,0'] = WHEAT
  const { plan } = await body(START, cells)
  const result = plan(new goals.GoalBlock(6, 64, 0))
  assert.deepStrictEqual(result.path.map((n) => [Math.floor(n.x), Math.floor(n.z), !!n.parkour]),
    [1, 2, 3, 4, 5, 6].map((x) => [x, 0, false]))
  const controls = await firstTick(cells)
  assert.deepStrictEqual([controls.forward, controls.jump], [true, false])
})

// body() over stone with air where open(p) holds and sky light 15 where sky(p) holds, planning through
// bot.js's knownMoves for a bot that has seen the cells seen(p) holds.
async function knowing (pos, { open, sky = () => false, seen }) {
  const b = await body(pos, {})
  const Block = require('prismarine-block')(b.bot.registry)
  b.bot.blockAt = (p) => {
    const c = p.floored()
    const block = Block.fromProperties(open(c) ? 'air' : 'stone', {}, 0)
    block.position = c
    block.skyLight = sky(c) ? 15 : 0
    return block
  }
  const env = { bot: b.bot, Vec3, cellKnown: seen, heldLight: (p, block) => block, ck: (x, y, z) => `${x},${y},${z}`, PLAN_KNOWN: new Map(), ...groundMemory() }
  loadBotFunctions(['knownMoves'], env).knownMoves(b.moves)
  return b
}
const cellsOf = (path) => path.map((n) => [Math.floor(n.x), Math.floor(n.y), Math.floor(n.z)])

test('the pathfinder never plans through a cave the bot has not seen, so an open one plans like a sealed one', async () => {
  // Two rooms in stone at x 0 to 2 and 6 to 8, joined by a tunnel at x 3 to 5 when it is open.
  const tunnel = (p) => p.x >= 3 && p.x <= 5 && p.z === 0 && (p.y === 64 || p.y === 65)
  const room = (p) => p.x >= 0 && p.x <= 8 && p.z === 0 && (p.y === 64 || p.y === 65) && !tunnel(p)
  const planFor = async (open, seen) => {
    const { plan } = await knowing(START, { open: (p) => room(p) || (open && tunnel(p)), seen })
    const r = plan(new goals.GoalBlock(7, 64, 0))
    return { status: r.status, cells: cellsOf(r.path) }
  }
  assert.strictEqual((await planFor(true, () => true)).status, 'success', 'control: a tunnel in sight')
  const unseen = (p) => !tunnel(p)
  const open = await planFor(true, unseen)
  assert.deepStrictEqual(open, await planFor(false, unseen))
  assert.strictEqual(open.status, 'noPath')
})

test('the pathfinder never plans across or down into a pit whose floor the bot has not seen', async () => {
  // A corridor at x 0 to 8 over a pit at x 3 to 5 that reaches down to y 34.
  const corridor = (p) => p.z === 0 && p.x >= 0 && p.x <= 8 && (p.y === 64 || p.y === 65)
  const pit = (p) => p.z === 0 && p.x >= 3 && p.x <= 5 && p.y >= 34 && p.y <= 63
  const across = new goals.GoalBlock(7, 64, 0)
  const statusOf = async (open, seen, goal) => (await knowing(START, { open, seen })).plan(goal).status
  assert.strictEqual(await statusOf(corridor, () => true, across), 'success', 'control: the corridor over solid floor')
  for (const top of [63, 62]) {
    const open = (p) => corridor(p) || pit(p)
    const seen = (p) => !(pit(p) && p.y <= top)
    assert.strictEqual(await statusOf(open, seen, across), 'noPath', `pit unseen from y ${top}: across`)
    assert.strictEqual(await statusOf(open, seen, new goals.GoalBlock(4, 63, 0)), 'noPath', `pit unseen from y ${top}: down`)
  }
})

test('the pathfinder plans over open ground the bot has not seen', async () => {
  // Stone up to y 63 under open sky with a hill at x 3 to 5, and the bot has seen nothing past x 1.
  const hill = (p) => p.x >= 3 && p.x <= 5 && p.z >= -1 && p.z <= 1 && p.y <= 65
  const open = (p) => p.y > 63 && !hill(p)
  const { plan } = await knowing(START, { open, sky: open, seen: (p) => p.x <= 1 })
  assert.strictEqual(plan(new goals.GoalBlock(8, 64, 0)).status, 'success')
})

test('the pathfinder never plans along a sky-lit ravine floor 20 under the ground that the bot has not seen', async () => {
  // Stone up to y 63 under open sky, cut by a ravine at x -2 to 40, z -1 to 1 down to its floor at y floor, the body on
  // that floor having seen nothing past x 1.
  const statusOf = async (floor) => {
    const open = (p) => p.y > 63 || (p.x >= -2 && p.x <= 40 && p.z >= -1 && p.z <= 1 && p.y > floor)
    const { plan } = await knowing(new Vec3(0.5, floor + 1, 0.5), { open, sky: open, seen: (p) => p.x <= 1 })
    return plan(new goals.GoalBlock(8, floor + 1, 0)).status
  }
  assert.strictEqual(await statusOf(53), 'success', 'control: a floor 10 under the ground')
  assert.strictEqual(await statusOf(43), 'noPath')
})

// A one-wide corridor at z 40 from x -36 with stairs, a slab, gaps, a ladder, roofed water, a door and a fence gate, floored at y0, over stone
// up to y top, as cells in build order.
function course (y0, top) {
  const x0 = -36
  const z = 40
  const xEnd = x0 + 69
  const build = []
  const box = (xa, ya, za, xb, yb, zb, block) => {
    for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) for (let zz = za; zz <= zb; zz++) build.push([`${x},${y},${zz}`, block])
  }
  box(x0 - 1, y0 - 5, z - 1, xEnd, y0 + 10, z - 1, STONE)
  box(x0 - 1, y0 - 5, z + 1, xEnd, y0 + 10, z + 1, STONE)
  box(x0 - 1, y0 - 5, z, x0 - 1, y0 + 10, z, STONE)
  box(xEnd, y0 - 5, z, xEnd, y0 + 10, z, STONE)
  box(x0, y0 - 5, z, xEnd - 1, y0 - 5, z, STONE)
  for (const [first, last, height] of [[0, 4, 0], [5, 5, 1], [6, 6, 2], [7, 9, 3], [10, 10, 2], [11, 11, 1], [12, 18, 0], [19, 23, 1], [25, 29, 1], [33, 40, 1], [41, 45, 5], [46, 49, 4], [50, 68, 5]]) {
    box(x0 + first, y0, z, x0 + last, y0 + height, z, STONE)
  }
  for (const [column, height, facing] of [[4, 1, 'east'], [5, 2, 'east'], [6, 3, 'east'], [10, 3, 'west'], [11, 2, 'west'], [12, 1, 'west']]) {
    build.push([`${x0 + column},${y0 + height},${z}`, ['oak_stairs', { facing, half: 'bottom', shape: 'straight', waterlogged: 'false' }]])
  }
  build.push([`${x0 + 18},${y0 + 1},${z}`, ['stone_slab', { type: 'bottom', waterlogged: 'false' }]])
  for (let height = 2; height <= 5; height++) build.push([`${x0 + 40},${y0 + height},${z}`, ['ladder', { facing: 'west', waterlogged: 'false' }]])
  box(x0 + 46, y0 + 5, z, x0 + 49, y0 + 5, z, ['water', { level: '0' }])
  box(x0 + 45, y0 + 8, z, x0 + 50, y0 + 8, z, STONE)
  build.push([`${x0 + 57},${y0 + 6},${z}`, door('lower')], [`${x0 + 57},${y0 + 7},${z}`, door('upper')])
  build.push([`${x0 + 64},${y0 + 6},${z}`, ['oak_fence_gate', { facing: 'east', in_wall: 'false', open: 'false', powered: 'false' }]])
  const ground = (c) => [c.y <= top ? 'stone' : 'air', {}]
  return { build, ground }
}

// The real pathfinder through bot.js's knownMoves, sight and light over a world whose cells hold the blocks cells
// has, else ground(p), and the sky light sky(p) a client got with its chunks, for a body at pos at noon.
async function lit (pos, cells, ground, sky) {
  const b = await body(pos, {})
  const Block = require('prismarine-block')(b.bot.registry)
  b.bot.blockAt = (p) => {
    const c = p.floored()
    const [name, props] = cells.get(`${c.x},${c.y},${c.z}`) || ground(c)
    const block = Block.fromProperties(name, props, 0)
    block.position = c
    block.light = 0
    block.skyLight = block.boundingBox === 'empty' ? sky(c) : 0
    return block
  }
  b.bot.time = { timeOfDay: 6000 }
  b.moves.allowParkour = true
  b.moves.allow1by1towers = false
  b.moves.maxDropDown = 3
  b.moves.scafoldingBlocks = []
  const env = {
    bot: b.bot,
    Vec3,
    ck: (x, y, z) => `${x},${y},${z}`,
    PLAN_KNOWN: new Map(),
    SEEN: new Set(),
    ESTIMATED_LIGHT: new Map(),
    SIGHT_MEMO: { t: 0, cells: new Map() },
    SIGHT_MS: botConstant('SIGHT_MS'),
    GRAVESTONE,
    ...groundMemory()
  }
  const fns = loadBotFunctions(['knownMoves', 'lightChanged'], env)
  fns.knownMoves(b.moves)
  // Lays block at key as a blockUpdate does: the light estimate first, then the cached ground top above it goes.
  const place = (key, block) => {
    const p = new Vec3(...key.split(',').map(Number))
    const old = b.bot.blockAt(p)
    cells.set(key, block)
    fns.lightChanged(old, b.bot.blockAt(p))
    if (p.y >= env.GROUND_TOP.get(p.x + ',' + p.z)) env.GROUND_TOP.delete(p.x + ',' + p.z)
  }
  return { ...b, place }
}

test('a corridor built in the air on a modern server, which sends no sky light that high, walks up its stairs', async () => {
  // A 1.21.11 server sends sky light only up to the section above a column's highest block and no light update
  // after a block change, so the client holds 0 in every section above the ground at y 120.
  const { build, ground } = course(200, 120)
  const { plan, place } = await lit(new Vec3(-34.5, 201, 40.5), new Map(), ground, (p) => (p.y < 144 ? 15 : 0))
  for (const [key, block] of build) place(key, block)
  const result = plan(new goals.GoalBlock(-27, 204, 40))
  assert.strictEqual(result.status, 'success', `${result.path.length} nodes`)
})

test('a corridor built in the air on a modern server walks from its ladder top through the roofed water past it', async () => {
  const statusOf = async (sky) => {
    const { build, ground } = course(200, 120)
    const { plan, place } = await lit(new Vec3(8.5, 206, 40.5), new Map(), ground, sky)
    for (const [key, block] of build) place(key, block)
    return plan(new goals.GoalBlock(17, 206, 40)).status
  }
  assert.strictEqual(await statusOf(() => 15), 'success', 'control: sky light held at every height')
  assert.strictEqual(await statusOf((p) => (p.y < 144 ? 15 : 0)), 'success')
})

test('a corridor built in the air on a 1.7.10 server walks to the foot of its ladder', async () => {
  // A 1.7.10 server sends light only with a chunk, so the client keeps the open-sky light of the empty air the
  // corridor was built in, with bot.js's estimates for the blocks laid since.
  const { build, ground } = course(150, 70)
  const cells = new Map()
  const { plan, place } = await lit(new Vec3(0.5, 152, 40.5), cells, ground, (p) => (p.y > 70 ? 15 : 0))
  for (const [key, block] of build) place(key, block)
  const result = plan(new goals.GoalBlock(4, 152, 40))
  assert.strictEqual(result.status, 'success', `${result.path.length} nodes`)
})

test('a corridor built in the air walks from past its door straight through its closed fence gate', async () => {
  for (const [server, y0, top, sky] of [['1.7.10', 150, 70, (p) => (p.y > 70 ? 15 : 0)], ['modern', 200, 120, (p) => (p.y < 144 ? 15 : 0)]]) {
    const { build, ground } = course(y0, top)
    const { plan, place } = await lit(new Vec3(24.5, y0 + 6, 40.5), new Map(), ground, sky)
    for (const [key, block] of build) place(key, block)
    const result = plan(new goals.GoalBlock(31, y0 + 6, 40))
    assert.deepStrictEqual(cellsOf(result.path), [25, 26, 27, 28, 29, 30, 31].map((x) => [x, y0 + 6, 40]), `${server}: ${result.status}`)
  }
})
