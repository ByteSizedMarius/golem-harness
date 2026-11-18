'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const WorldSync = require('prismarine-world/src/worldsync')
const { GRAVESTONE } = require('../lib/server-overrides')
const { panelAcross } = require('../lib/doors')
const { GoalPickup } = require('../lib/walk')
const { CREEPER_ZONE_SLACK, inCreeperZone, zoneCrossed, summarizePlan } = require('../lib/plan')
const { botConstant, groundMemory, blockWorld, loadBotFunctions, farmlandTop } = require('./helpers')
const { body, knowing, legsOf, START, STONE, fieldPlanCases, fieldMoveCases } = require('./farmland-plan-cases')

const WALL_ARM = ['cobblestone_wall', { up: 'false', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }]
const WALL_POST = ['cobblestone_wall', { up: 'true', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }]
const door = (half) => ['oak_door', { facing: 'east', half, hinge: 'left', open: 'false', powered: 'false' }]

test('farmland is the version data\'s 0.9375 high in this file, no shapes override applied', () => {
  assert.strictEqual(farmlandTop(), 0.9375)
})

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

test('a body with no blocks to place finds no path across a pit past a door rather than one that bridges it', async () => {
  // A walled corridor at z 0 from x 0 to 9, a door at x 2 and a pit at x 4 to 8, too wide to jump and too deep to drop into.
  const cells = {}
  for (let x = -1; x <= 10; x++) {
    for (const y of [64, 65]) {
      for (const z of [-1, 1]) cells[`${x},${y},${z}`] = ['stone', {}]
      if (x === -1 || x === 10) cells[`${x},${y},0`] = ['stone', {}]
    }
  }
  cells['2,64,0'] = door('lower')
  cells['2,65,0'] = door('upper')
  for (let x = 4; x <= 8; x++) for (let y = 50; y <= 63; y++) cells[`${x},${y},0`] = ['air', {}]
  const { plan } = await body(new Vec3(0.5, 64, 0.5), cells)
  const result = plan(new goals.GoalBlock(9, 64, 0))
  const placed = result.path.flatMap((n) => n.toPlace.filter((p) => !p.useOne).map((p) => [p.x, p.y, p.z]))
  assert.deepStrictEqual({ status: result.status, placed }, { status: 'noPath', placed: [] })
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

fieldPlanCases()

const cellsOf = (path) => path.map((n) => [Math.floor(n.x), Math.floor(n.y), Math.floor(n.z)])

test('the pathfinder never plans through a cave the bot has not seen past 16 blocks, so an open one plans like a sealed one', async () => {
  // Two rooms in stone at x 0 to 17 and 21 to 23, joined by a tunnel at x 18 to 20 when it is open.
  const tunnel = (p) => p.x >= 18 && p.x <= 20 && p.z === 0 && (p.y === 64 || p.y === 65)
  const room = (p) => p.x >= 0 && p.x <= 23 && p.z === 0 && (p.y === 64 || p.y === 65) && !tunnel(p)
  const planFor = async (open, seen) => {
    const { plan } = await knowing(START, { open: (p) => room(p) || (open && tunnel(p)), seen })
    const r = plan(new goals.GoalBlock(22, 64, 0))
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

fieldMoveCases()

test('the pathfinder never plans along a sky-lit ravine floor 20 under the ground that the bot has not seen', async () => {
  // The goal at x 20 lies past the 16 blocks the eye makes out shapes in.
  const statusOf = async (floor) => {
    const open = (p) => p.y > 63 || (p.x >= -2 && p.x <= 40 && p.z >= -1 && p.z <= 1 && p.y > floor)
    const { plan } = await knowing(new Vec3(0.5, floor + 1, 0.5), { open, sky: open, seen: (p) => p.x <= 1 })
    return plan(new goals.GoalBlock(20, floor + 1, 0)).status
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
    LEGACY_1710: false,
    panelAcross,
    ...groundMemory()
  }
  const fns = loadBotFunctions(['knownMoves', 'lightChanged', 'airPrecheck', 'planKnown', 'planBlock'], blockWorld(env))
  fns.knownMoves(b.moves)
  // Lays block at key as a blockUpdate does: the light estimate first, then the cached ground top above it goes.
  const place = (key, block) => {
    const p = new Vec3(...key.split(',').map(Number))
    const old = b.bot.blockAt(p)
    cells.set(key, block)
    fns.lightChanged(old, b.bot.blockAt(p))
    if (p.y >= env.GROUND_TOP.get(p.x + ',' + p.z)) env.GROUND_TOP.delete(p.x + ',' + p.z)
  }
  return { ...b, place, fns, env }
}

test('a corridor built in the air on a 1.21.11 server, which sends no sky light that high, walks up its stairs', async () => {
  // A 1.21.11 server sends sky light only up to the section above a column's highest block and no light update
  // after a block change, so the client holds 0 in every section above the ground at y 120.
  const { build, ground } = course(200, 120)
  const { plan, place } = await lit(new Vec3(-34.5, 201, 40.5), new Map(), ground, (p) => (p.y < 144 ? 15 : 0))
  for (const [key, block] of build) place(key, block)
  const result = plan(new goals.GoalBlock(-27, 204, 40))
  assert.strictEqual(result.status, 'success', `${result.path.length} nodes`)
})

test('a corridor built in the air on a 1.21.11 server walks from its ladder top through the roofed water past it', async () => {
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
  for (const [server, y0, top, sky] of [['1.7.10', 150, 70, (p) => (p.y > 70 ? 15 : 0)], ['1.21.11', 200, 120, (p) => (p.y < 144 ? 15 : 0)]]) {
    const { build, ground } = course(y0, top)
    const { plan, place } = await lit(new Vec3(24.5, y0 + 6, 40.5), new Map(), ground, sky)
    for (const [key, block] of build) place(key, block)
    const result = plan(new goals.GoalBlock(31, y0 + 6, 40))
    assert.deepStrictEqual(cellsOf(result.path), [25, 26, 27, 28, 29, 30, 31].map((x) => [x, y0 + 6, 40]), `${server}: ${result.status}`)
  }
})

const AIR = ['air', {}]
const WATER = ['water', { level: '0' }]
const cave = (c) => (c.x >= -3 && c.x <= 8 && c.y >= 64 && c.y <= 66 && Math.abs(c.z) <= 3 ? AIR : STONE)
// lit() at midnight with no sky light, over ground with the blocks in cells ('x,y,z' -> [name, properties]).
async function midnight (pos, cells = {}, ground = cave) {
  const r = await lit(pos, new Map(Object.entries(cells)), ground, () => 0)
  r.bot.time.timeOfDay = 18000
  return r
}
// Water under the cave from x -3 to the shore at x shore, 2 deep, and 1 deep at x shore - 1.
function lake (shore) {
  const cells = {}
  for (let x = -3; x < shore; x++) for (let z = -3; z <= 3; z++) for (const y of x < shore - 1 ? [62, 63] : [63]) cells[`${x},${y},${z}`] = WATER
  return cells
}
const seeAll = (env, [x0, y0, z0], [x1, y1, z1]) => {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) env.SEEN.add(`${x},${y},${z}`)
}

test('a goto out of a dark lake at midnight plans to the shore 3 and 4 blocks out', async () => {
  for (const x of [3, 4]) {
    const seen = await midnight(new Vec3(0.5, 63, 0.5), lake(3))
    seeAll(seen.env, [-3, 61, -3], [8, 66, 3])
    assert.strictEqual(seen.plan(new goals.GoalBlock(x, 64, 0)).status, 'success', `control: every cell seen, the shore at x ${x}`)
    const { plan } = await midnight(new Vec3(0.5, 63, 0.5), lake(3))
    assert.strictEqual(plan(new goals.GoalBlock(x, 64, 0)).status, 'success', `the shore at x ${x}`)
  }
})

test('a plan in the dark takes no shore and no pit floor past 16 blocks', async () => {
  const long = (c) => (c.x >= -3 && c.x <= 20 && c.y >= 64 && c.y <= 66 && Math.abs(c.z) <= 3 ? AIR : STONE)
  const far = async (seen) => {
    const r = await midnight(new Vec3(0.5, 63, 0.5), lake(18), long)
    if (seen) seeAll(r.env, [17, 61, -3], [20, 66, 3])
    return r.plan(new goals.GoalBlock(18, 64, 0)).status
  }
  assert.strictEqual(await far(true), 'success', 'control: the far shore seen')
  assert.strictEqual(await far(false), 'noPath')
  // The pit floor lies 16.2 blocks from the eye and its open top 15.9.
  const pit = {}
  for (let x = 16; x <= 18; x++) for (let z = -1; z <= 1; z++) for (const y of [62, 63]) pit[`${x},${y},${z}`] = AIR
  const down = async (seen) => {
    const r = await midnight(new Vec3(0.2, 64, 0.5), pit, long)
    if (seen) seeAll(r.env, [16, 61, -1], [18, 63, 1])
    return r.plan(new goals.GoalBlock(16, 62, 0)).status
  }
  assert.strictEqual(await down(true), 'success', 'control: the pit floor seen')
  assert.strictEqual(await down(false), 'noPath')
})

test('the goto precheck makes out a dark corridor 16 blocks out and names its edge there', async () => {
  const corridor = (c) => (c.z === 0 && c.x >= 0 && c.x <= 30 && (c.y === 64 || c.y === 65) ? AIR : STONE)
  const { fns, env } = await midnight(START, {}, corridor)
  seeAll(env, [19, 63, -1], [21, 65, 1])
  const { verdict, edge } = fns.airPrecheck(new Vec3(20, 64, 0), 0)
  assert.deepStrictEqual([verdict, edge && edge.toString()], ['unseen', '(16, 64, 0)'])
})

test('a closed door made out in the dark walls the plan, and the goto precheck calls the way past it unseen', async () => {
  const corridor = (c) => (c.z === 0 && c.x >= 0 && c.x <= 30 && (c.y === 64 || c.y === 65) ? AIR : STONE)
  const both = async (doorSeen) => {
    const { plan, fns, env } = await midnight(START, { '6,64,0': door('lower'), '6,65,0': door('upper') }, corridor)
    // The door stands past the 4 blocks a dark cell shows in.
    seeAll(env, [6, 63, 0], [6, 63, 0])
    seeAll(env, [7, 63, -1], [12, 66, 1])
    if (doorSeen) seeAll(env, [6, 64, 0], [6, 65, 0])
    return [plan(new goals.GoalBlock(11, 64, 0)).status, fns.airPrecheck(new Vec3(11, 64, 0), 0).verdict]
  }
  assert.deepStrictEqual(await both(true), ['success', 'connected'], 'control: the door seen')
  assert.deepStrictEqual(await both(false), ['noPath', 'unseen'])
})

test('a goto climbs a ladder made out in the dark within 16 blocks, as one seen', async () => {
  // A ladder shaft at 3,64..73,0 in stone under a corridor at y 74 and 75 from x 3 to 8, the body at its foot.
  const shaft = (c) => (c.z === 0 && c.x >= 3 && c.x <= 8 && (c.y === 74 || c.y === 75) ? AIR : STONE)
  const ladder = Object.fromEntries([64, 65, 66, 67, 68, 69, 70, 71, 72, 73].map((y) => [`3,${y},0`, ['ladder', { facing: 'west', waterlogged: 'false' }]]))
  const both = async (ladderSeen) => {
    const { plan, fns, env } = await midnight(new Vec3(3.5, 64, 0.5), ladder, shaft)
    // The rungs from y 70 lie 4.4 blocks and more from the eye, past the 4 blocks a dark cell shows in.
    seeAll(env, [3, 74, 0], [3, 75, 0])
    seeAll(env, [4, 73, -1], [8, 76, 1])
    if (ladderSeen) seeAll(env, [3, 64, 0], [3, 73, 0])
    return [plan(new goals.GoalBlock(6, 74, 0)).status, fns.airPrecheck(new Vec3(6, 74, 0), 0).verdict]
  }
  assert.deepStrictEqual(await both(true), ['success', 'connected'], 'control: the ladder seen')
  assert.deepStrictEqual(await both(false), ['success', 'connected'])
})

const GRASS = ['grass_block', { snowy: 'false' }]
const LOG = ['spruce_log', { axis: 'y' }]
// Grass at y 64 and on a step at x 3 and east of it at y 65, with a trench in the step at x 3 from z 0 to 2 open at 3,65,1.
const trench = (c) => {
  if (c.y <= 63) return STONE
  if (c.x === 3 && ((c.y === 64 && c.z >= 0 && c.z <= 2) || (c.y === 65 && c.z === 1))) return AIR
  return c.y === 64 || (c.y === 65 && c.x >= 3) ? GRASS : AIR
}
const TRENCH_FEET = new Vec3(2.5, 65, 1.5)
const TRENCH_DROP = new Vec3(3.81, 63.84, 1.75)
const TRENCH_END = new Vec3(3, 64, 1)
// The precheck's verdicts with and without the pickup goal, for a body at feet at noon with the cells round end seen.
async function pickupVerdicts ({ feet = TRENCH_FEET, drop = TRENCH_DROP, end = TRENCH_END, ground = trench, cells = { '3,66,1': LOG }, forestry = false, unknown = () => false, outline = () => false, stale = null, entities = {} } = {}) {
  const { bot, moves, fns, env } = await lit(feet, new Map(Object.entries(cells)), ground, () => 15)
  seeAll(env, [end.x - 2, end.y - 3, end.z - 2], [end.x + 2, end.y + 3, end.z + 2])
  if (forestry) {
    moves.canDig = true
    moves.blocksCantBreak = new Set(bot.registry.blocksArray.filter((b) => !/(_log|_wood|_leaves)$/.test(b.name)).map((b) => b.id))
  }
  bot.pathfinder.setMovements(moves)
  if (stale) moves.entityIntersections[stale] = 1
  Object.assign(bot.entities, entities)
  const planKnown = fns.planKnown
  fns.planKnown = (p) => (unknown(p) ? null : outline(p) ? 'air' : planKnown(p))
  const goal = new GoalPickup({ position: drop }, { blockAt: (p) => bot.blockAt(p), known: () => true })
  assert.ok(goal.isEnd(end), 'control: the end cell is a pickup end')
  return { verdicts: [fns.airPrecheck(end, 0, goal).verdict, fns.airPrecheck(end, 0).verdict], moves, goal }
}

test('the goto precheck refuses a pickup walk into a trench whose only opening lies under a log the legs cannot break', async () => {
  const { verdicts } = await pickupVerdicts()
  assert.deepStrictEqual(verdicts, ['no-path', 'connected'])
})

test('the goto precheck refuses a pickup walk into a trench closed by a block no body stands in that is no full cube', async () => {
  for (const [name, over] of [['a bottom slab', ['stone_slab', { type: 'bottom', waterlogged: 'false' }]], ['a fence', ['oak_fence', { east: 'false', north: 'false', south: 'false', west: 'false', waterlogged: 'false' }]]]) {
    const { verdicts } = await pickupVerdicts({ cells: { '3,66,1': over } })
    assert.deepStrictEqual(verdicts, ['no-path', 'connected'], name)
  }
})

// A body 2.8 flat from the centre of the pickup cell, whose start cell the pickup goal estimates at 0.
const MARCH_FEET = new Vec3(1.5, 65, 3.5)

test('the goto precheck refuses a pickup walk into the trench with its closing cells unknown to the planner for a body on the rim, not for one that can march', async () => {
  const closing = (p) => (p.x === 3 && p.y === 66 && p.z === 1) || (p.x === 3 && p.y === 65 && p.z !== 1)
  const rim = await pickupVerdicts({ unknown: closing })
  assert.strictEqual(rim.moves.getBlock(new Vec3(3, 66, 1), 0, 0, 0).name, 'unknown', 'control: the log reads unknown')
  assert.deepStrictEqual(rim.verdicts, ['no-path', 'inconclusive'], 'on the rim')
  assert.deepStrictEqual((await pickupVerdicts({ feet: MARCH_FEET, unknown: closing })).verdicts, ['inconclusive', 'inconclusive'], 'more than 2 flat from the pickup cell')
})

test('the goto precheck leaves a pickup walk into the trench to the plan when the way in runs through a cell the planner makes out as air, for a body on the rim', async () => {
  const { verdicts, moves, goal } = await pickupVerdicts({ outline: (p) => p.x === 3 && p.y === 66 && p.z === 1 })
  const cell = moves.getBlock(new Vec3(3, 66, 1), 0, 0, 0)
  assert.deepStrictEqual([cell.type, cell.name, cell.safe], [null, 'air', true], 'control: the log reads as the outline air')
  assert.strictEqual(goal.heuristic(new Vec3(2, 65, 1)), 0, 'control: the start cell estimate')
  assert.notStrictEqual(verdicts[0], 'no-path')
})

const buried = (p) => trench(p) !== AIR

test('the goto precheck refuses a pickup walk into the trench with its ground unknown to the planner for a body on the rim', async () => {
  const { verdicts, goal } = await pickupVerdicts({ unknown: buried })
  assert.strictEqual(goal.heuristic(new Vec3(2, 65, 1)), 0, 'control: the start cell estimate')
  assert.deepStrictEqual(verdicts, ['no-path', 'inconclusive'])
})

test('the goto precheck leaves a pickup walk into the trench with its ground unknown to the planner to the plan for a body more than 2 flat from the pickup cell', async () => {
  const { verdicts, goal } = await pickupVerdicts({ feet: MARCH_FEET, unknown: buried })
  assert.strictEqual(goal.heuristic(new Vec3(1, 65, 3)), 0, 'control: the start cell estimate')
  assert.deepStrictEqual(verdicts, ['inconclusive', 'inconclusive'])
})

test('the goto precheck leaves a pickup walk into the trench with its ground unknown to the planner to the plan for a start cell the goal estimates above 0', async () => {
  // A stone pillar beside the trench, the body on top of it.
  const { verdicts, goal } = await pickupVerdicts({ feet: new Vec3(2.5, 67, 1.5), cells: { '3,66,1': LOG, '2,65,1': STONE, '2,66,1': STONE }, unknown: buried })
  assert.ok(goal.heuristic(new Vec3(2, 67, 1)) > 0, 'control: the start cell estimate')
  assert.deepStrictEqual(verdicts, ['inconclusive', 'inconclusive'])
})

test('the goto precheck leaves a pickup walk into the trench to the plan under legs that may break the log', async () => {
  assert.deepStrictEqual((await pickupVerdicts({ forestry: true })).verdicts, ['connected', 'connected'])
})

test('the goto precheck reads the entities over the log as they stand now, under legs that may break it', async () => {
  assert.deepStrictEqual((await pickupVerdicts({ forestry: true, stale: '3,67,1' })).verdicts, ['connected', 'connected'], 'an entity the index holds that has gone')
  const zombie = { id: 7, name: 'zombie', position: new Vec3(3.5, 67, 1.5), width: 0.6, height: 1.95 }
  assert.deepStrictEqual((await pickupVerdicts({ forestry: true, entities: { 7: zombie } })).verdicts, ['no-path', 'connected'], 'control: an entity standing on the log')
})

test('the goto precheck leaves a pickup walk to the plan for a body whose head cell holds stone, a step from the drop', async () => {
  // A closed corridor at z 0 from x 0 to 2 with stone in the body's head cell.
  const corridor = (c) => (c.z === 0 && c.x >= 0 && c.x <= 2 && (c.y === 64 || c.y === 65) && !(c.x === 0 && c.y === 65) ? AIR : STONE)
  const { verdicts } = await pickupVerdicts({ feet: new Vec3(0.5, 64, 0.5), drop: new Vec3(2.6, 63.9, 0.5), end: new Vec3(1, 64, 0), ground: corridor, cells: {} })
  assert.deepStrictEqual(verdicts, ['connected', 'connected'])
})

test('the goto precheck leaves a pickup walk to the plan for a body already in a pickup end cell of the trench', async () => {
  assert.deepStrictEqual((await pickupVerdicts({ feet: new Vec3(3.5, 64, 1.5) })).verdicts, ['connected', 'connected'])
})

test('the goto precheck leaves a pickup walk to a drop on open ground 12 blocks away to the plan', async () => {
  const flat = (c) => (c.y <= 63 ? STONE : AIR)
  const { verdicts } = await pickupVerdicts({ feet: START, drop: new Vec3(12.5, 63.9, 0.5), end: new Vec3(12, 64, 0), ground: flat, cells: {} })
  assert.deepStrictEqual(verdicts, ['connected', 'connected'])
})

// The plan to 7,64,0 past block in cells, the floor and x 7 to 8 seen, digging only coal ore with cage.
async function planPast (cells, block, { cage = false, seen = [] } = {}) {
  const { plan, moves, fns, env } = await midnight(START, Object.fromEntries(cells.map((k) => [k, block])))
  seeAll(env, [6, 63, -1], [6, 63, 1])
  seeAll(env, [7, 63, -1], [8, 65, 1])
  for (const k of seen) env.SEEN.add(k)
  if (cage) {
    moves.canDig = true
    moves.blocksCantBreak = new Set(moves.bot.registry.blocksArray.filter((b) => b.name !== 'coal_ore').map((b) => b.id))
  }
  const r = plan(new goals.GoalBlock(7, 64, 0))
  const broken = r.path.flatMap((n) => n.toBreak.map((p) => [p.x, p.y, p.z]))
  return { status: r.status, cost: r.cost, cells: cellsOf(r.path), broken, plan: summarizePlan(START, r, fns.planKnown, fns.planBlock) }
}

test('a body that may dig coal plans no dig through a wall made out in the dark, whatever the wall is', async () => {
  // The wall at x 6, past the 4 blocks a dark cell shows in.
  const wall = []
  for (let y = 64; y <= 66; y++) for (let z = -3; z <= 3; z++) wall.push(`6,${y},${z}`)
  const seen = await planPast(wall, ['coal_ore', {}], { cage: true, seen: wall })
  assert.deepStrictEqual([seen.status, seen.broken.length > 0], ['success', true], 'control: a dig through the coal in sight')
  const stone = await planPast(wall, STONE, { cage: true })
  assert.deepStrictEqual(stone.broken, [])
  for (const block of [['coal_ore', {}], ['cactus', { age: 0 }]]) assert.deepStrictEqual(await planPast(wall, block, { cage: true }), stone, block[0])
})

test('a plan reads cobweb, kelp and tall grass made out in the dark as unknown cells', async () => {
  // At x 6, past the 4 blocks a dark cell shows in.
  const { moves } = await midnight(START, { '6,64,1': ['cobweb', {}], '6,64,0': ['kelp', { age: 0 }], '6,64,-1': ['tall_grass', { half: 'lower' }] })
  const name = (x, y, z) => moves.getBlock(new Vec3(x, y, z), 0, 0, 0).name
  assert.deepStrictEqual([name(6, 65, 0), name(6, 63, 0)], ['air', 'solid'], 'control: an open and a solid shape')
  assert.deepStrictEqual([name(6, 64, 1), name(6, 64, 0), name(6, 64, -1)], ['unknown', 'unknown', 'unknown'])
})

test('a plan sees a block in the dark across three cells of water, makes out one past 4 blocks, and not across four', async () => {
  // A room flooded at x -3 to 2, y 64 to 67 and z -3 to 3, the eye in its water.
  const room = (c) => (c.x >= -3 && c.x <= 2 && c.y >= 64 && c.y <= 67 && Math.abs(c.z) <= 3 ? WATER : STONE)
  const { moves } = await midnight(START, {}, room)
  const name = (x, y, z) => moves.getBlock(new Vec3(x, y, z), 0, 0, 0).name
  assert.deepStrictEqual([name(3, 65, 0), name(3, 65, 2)], ['stone', 'unknown'])
  // The east wall at x 5 lies 4.5 blocks from the eye.
  const wall = async (flooded) => {
    const { moves } = await midnight(START, {}, (c) => (c.x >= -3 && c.x <= 4 && c.y >= 64 && c.y <= 67 && Math.abs(c.z) <= 3 ? (c.x <= flooded ? WATER : AIR) : STONE))
    return moves.getBlock(new Vec3(5, 65, 0), 0, 0, 0).name
  }
  assert.deepStrictEqual([await wall(2), await wall(4)], ['solid', 'unknown'])
})

const pillar = (height) => Object.fromEntries(Array.from({ length: height }, (_, i) => [`0,${64 + i},0`, STONE]))

test('the walk and a collect drop 3 blocks off a pillar and not 4, the forestry legs 2 and not 3', async (t) => {
  const ground = new goals.GoalBlock(3, 64, 0)
  const statuses = []
  for (const height of [2, 3, 4]) {
    const { plan, legs } = await legsOf(t, new Vec3(0.5, 64 + height, 0.5), pillar(height))
    statuses.push([height, plan(ground, legs.default).status, plan(ground, legs.collect).status, plan(ground, legs.forestry).status])
  }
  assert.deepStrictEqual(statuses, [
    [2, 'success', 'success', 'success'],
    [3, 'success', 'success', 'noPath'],
    [4, 'noPath', 'noPath', 'noPath']
  ])
})

// body() whose moves keep out of the zone of a creeper at `at` that the combat reflex watches, through bot.js's creeperZones.
async function zonedBody (pos, cells, at, radius) {
  const b = await body(pos, cells)
  const zone = { id: 9, at, radius }
  const env = {
    bot: { entity: b.bot.entity, pathfinder: { movements: b.moves } },
    reflexes: [{ name: 'combat', watchedCreepers: () => [zone] }],
    routeEnd: () => null,
    inCreeperZone
  }
  const zones = loadBotFunctions(['creeperZones'], env).creeperZones({})
  return { ...b, zones, crossed: (path) => zoneCrossed([zone], path, zones.bounds) }
}

// The plan for goal with the zones off, then on.
function bothWays (b, goal) {
  b.zones.on = false
  const open = b.plan(goal)
  b.zones.on = true
  return { open, zoned: b.plan(goal) }
}

test('a walk past a creeper zone routes round it on flat ground, across a parkour gap and past a drop that lands in it', async () => {
  const flat = await zonedBody(START, {}, new Vec3(5.5, 64, 0.5), 3)
  const plain = bothWays(flat, new goals.GoalBlock(10, 64, 0))
  assert.ok(flat.crossed(plain.open.path), 'control: the straight way runs through the zone')
  assert.deepStrictEqual([plain.zoned.status, flat.crossed(plain.zoned.path)], ['success', null], 'flat ground')
  // A trench at x 3 too deep to drop into.
  const trench = {}
  for (let z = -10; z <= 10; z++) for (let y = 40; y <= 63; y++) trench[`3,${y},${z}`] = ['air', {}]
  const gap = await zonedBody(START, trench, new Vec3(4.5, 64, 0.5), 3)
  gap.moves.allowParkour = true
  const jump = bothWays(gap, new goals.GoalBlock(8, 64, 0))
  assert.ok(gap.crossed(jump.open.path), 'control: the jump straight across lands in the zone')
  assert.deepStrictEqual([jump.zoned.status, gap.crossed(jump.zoned.path), jump.zoned.path.some((n) => n.parkour)], ['success', null, true], 'the gap')
  // A ledge 3 high at x 2 and west of it.
  const ledge = {}
  for (let x = -5; x <= 2; x++) for (let z = -10; z <= 10; z++) for (let y = 64; y <= 66; y++) ledge[`${x},${y},${z}`] = STONE
  const high = await zonedBody(new Vec3(0.5, 67, 0.5), ledge, new Vec3(4.5, 64, 0.5), 3)
  const drop = bothWays(high, new goals.GoalBlock(8, 64, 0))
  assert.ok(high.crossed(drop.open.path), 'control: the drop straight off the ledge lands in the zone')
  assert.deepStrictEqual([drop.zoned.status, high.crossed(drop.zoned.path)], ['success', null], 'the drop')
})

test('a walk that passes a creeper at fleeDist + 1 runs through its zone and is no way', async () => {
  const fleeDist = 8
  // A sealed corridor at z 0 from x 0 to 20 that passes 9 from the creeper.
  const cells = {}
  for (let x = -1; x <= 21; x++) {
    for (const y of [64, 65]) {
      for (const z of [-1, 1]) cells[`${x},${y},${z}`] = STONE
      if (x === -1 || x === 21) cells[`${x},${y},0`] = STONE
    }
  }
  const b = await zonedBody(START, cells, new Vec3(10.5, 64, 9.5), fleeDist + CREEPER_ZONE_SLACK)
  const { open, zoned } = bothWays(b, new goals.GoalBlock(20, 64, 0))
  assert.deepStrictEqual([open.status, zoned.status], ['success', 'noPath'])
})

const LookBlock = require('prismarine-block')(require('prismarine-registry')('1.21.11'))
const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]]

// Named cells ('x,y,z' -> name) over stone at y 63 and below.
function lookWorld (cells) {
  const getBlock = (p) => {
    const c = p.floored()
    const b = LookBlock.fromProperties(cells[`${c.x},${c.y},${c.z}`] || (c.y <= 63 ? 'stone' : 'air'), {}, 0)
    b.position = c
    return b
  }
  const world = { rays: 0, raycast: (...ray) => { world.rays++; return WorldSync.prototype.raycast.apply({ getBlock }, ray) } }
  return world
}

test('a block in the wall of a 1-wide corridor is in reach from the corridor cell beside it, on every side', () => {
  const missed = SIDES.filter(([sx, sz]) => {
    // Stone 3 high round the ore, with an open-top corridor through the cell on side sx, sz.
    const cells = {}
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 64; y <= 66; y++) cells[`${x},${y},${z}`] = 'stone'
    for (let k = -3; k <= 3; k++) for (let y = 64; y <= 66; y++) cells[sx ? `${sx},${y},${k}` : `${k},${y},${sz}`] = 'air'
    cells['0,64,0'] = 'coal_ore'
    return !new goals.GoalLookAtBlock(new Vec3(0, 64, 0), lookWorld(cells)).isEnd(new Vec3(sx, 64, sz))
  })
  assert.deepStrictEqual(missed, [])
})

test('a log 3 or 4 above the feet on a stone column is in reach from the ground beside the column', () => {
  for (const up of [3, 4]) {
    const cells = { [`0,${64 + up},0`]: 'oak_log' }
    for (let y = 64; y < 64 + up; y++) cells[`0,${y},0`] = 'stone'
    const goal = new goals.GoalLookAtBlock(new Vec3(0, 64 + up, 0), lookWorld(cells))
    assert.deepStrictEqual(SIDES.filter(([sx, sz]) => !goal.isEnd(new Vec3(sx, 64, sz))), [], `log ${up} up`)
  }
})

test('a look at a floor block whose centre lies 4.52 from the eye is no end and casts no ray, while one cell nearer is an end', () => {
  const world = lookWorld({})
  const goal = new goals.GoalLookAtBlock(new Vec3(0, 63, 0), world)
  assert.ok(goal.isEnd(new Vec3(3, 64, 0)), 'control: 3 out')
  world.rays = 0
  assert.strictEqual(goal.isEnd(new Vec3(4, 64, 0)), false)
  assert.strictEqual(world.rays, 0)
})
