'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Physics } = require('prismarine-physics')
const { groundMemory, loadBotFunctions } = require('./helpers')

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
    game: { minY: -64, height: 384 },
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
