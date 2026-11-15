'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Physics } = require('prismarine-physics')
const WorldSync = require('prismarine-world/src/worldsync')
const { GRAVESTONE } = require('../lib/server-overrides')
const { panelAcross } = require('../lib/doors')
const { CREEPER_ZONE_SLACK, inCreeperZone, zoneCrossed, summarizePlan } = require('../lib/plan')
const { botConstant, groundMemory, blockWorld, loadBotFunctions, walkingBody } = require('./helpers')
const { SWING_REACH } = require('../lib/combat-rules')
const { HITBOX_1710, LEGACY_SNEAK_EYE } = require('../lib/bot/legacy-1710')

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
    sprintFacing: () => true,
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

// Three walled terraces one block apart along x, farmland between stone paths at x 0, 5 and 8, and a stone row at z 61 when stairs is set.
function terraces (stairs) {
  const cells = {}
  for (let z = -1; z <= 62; z++) {
    for (let x = -1; x <= 9; x++) {
      if (x === -1 || x === 9 || z === -1 || z === 62) {
        cells[`${x},64,${z}`] = cells[`${x},65,${z}`] = STONE
        continue
      }
      const floor = x < 3 ? 63 : x < 6 ? 62 : 61
      for (let y = floor + 1; y <= 63; y++) cells[`${x},${y},${z}`] = ['air', {}]
      cells[`${x},${floor},${z}`] = [0, 5, 8].includes(x) || (stairs && z === 61) ? STONE : FARMLAND
    }
  }
  return cells
}

// The bottom level's path beside its beds.
const BOTTOM = new goals.GoalBlock(8, 62, 0)
const farmlandLandings = (cells, path) => path.filter((n) => drops(path).includes(n) || n.parkour).filter((n) => floorAt(cells, n) === 'farmland').map((n) => n.hash)

async function legsOf (t, pos, cells) {
  const b = await walkingBody(t, pos, cells)
  let cage = null
  b.bot.collectBlock = { movements: null, async collect () { cage = this.movements } }
  b.bot.tool = { equipForBlock: async () => {} }
  const env = { bot: b.bot, collectLock: botConstant('collectLock'), digLock: botConstant('digLock'), knownMoves: b.farmlandRule, Movements, shared: b.shared, watchedWork: (work) => work(), pastUnstuck: (walk) => walk(), abandonCollect () {} }
  await loadBotFunctions(['collectSafely'], env).collectSafely({ type: b.bot.registry.blocksByName.iron_ore.id, shapes: [[0, 0, 0, 1, 1, 1]] }, 'iron_ore')
  return { ...b, legs: { default: b.bot.pathfinder.movements, forestry: b.shared.forestryMoves, collect: cage } }
}

test('a walk down three terraces lands no drop or jump on farmland in any legs, where a goal marked to trample does', async (t) => {
  const cells = terraces(true)
  const { bot, plan, legs, trampleGoal } = await legsOf(t, START, cells)
  for (const [name, moves] of Object.entries(legs)) {
    const r = plan(BOTTOM, moves)
    assert.deepStrictEqual([r.status, farmlandLandings(cells, r.path)], ['success', []], name)
  }
  const goal = trampleGoal(new goals.GoalBlock(8, 62, 0))
  bot.pathfinder.setGoal(goal)
  assert.ok(farmlandLandings(cells, plan(goal).path).length > 0, 'control: the cheaper way drops onto the beds')
})

test('a walk to a level reached only by drops onto farmland finds no path in any legs, and one across a bed on its level is planned', async (t) => {
  const cells = terraces(false)
  const { plan, legs } = await legsOf(t, START, cells)
  for (const [name, moves] of Object.entries(legs)) {
    assert.strictEqual(plan(new goals.GoalBlock(2, 64, 30), moves).status, 'success', `${name}: across the top bed`)
    const r = plan(BOTTOM, moves)
    assert.deepStrictEqual([r.status, farmlandLandings(cells, r.path)], ['noPath', []], name)
  }
})

test('a goal marked to trample walks a strand of farmland drops in its walk and its planPath, and no other search does', async (t) => {
  const cells = terraces(false)
  const { bot, plan, TRAMPLE, trampleGoal } = await legsOf(t, START, cells)
  const { planPath } = loadBotFunctions(['planPath'], { bot, TRAMPLE, routeEnd: () => null })
  bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
  const marked = trampleGoal(new goals.GoalBlock(8, 62, 0))
  const plain = new goals.GoalBlock(8, 62, 0)
  assert.strictEqual((await planPath(marked)).status, 'success', 'planPath before the walk')
  bot.pathfinder.setGoal(marked)
  const walk = plan(marked)
  assert.ok(walk.status === 'success' && farmlandLandings(cells, walk.path).length > 0, 'the walk')
  assert.strictEqual((await planPath(plain)).status, 'noPath', 'planPath for another goal during the walk')
  bot.pathfinder.setGoal(null)
  assert.strictEqual(plan(marked).status, 'noPath', 'a search with no walk set')
})

test('a reach walk stranded only by farmland drops is not counted as a way through unseen cells', async (t) => {
  const { bot } = await walkingBody(t, START, terraces(false))
  bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
  const env = { bot, Vec3, Movements, goals, shared: {}, LEGACY_1710: false, HITBOX_1710, LEGACY_SNEAK_EYE, SWING_REACH, UNSEEN_PLAN_MS: botConstant('UNSEEN_PLAN_MS') }
  const { unseenWay } = loadBotFunctions(['unseenWay'], env)
  const zombie = (x, y) => ({ id: 3, name: 'zombie', width: 0.6, height: 1.95, position: new Vec3(x, y, 20.5) })
  assert.strictEqual(await unseenWay(zombie(1.5, 64)), 'success', 'control: a zombie on the top bed')
  assert.strictEqual(await unseenWay(zombie(8.5, 62)), 'noPath')
})

test('a strand probe names the bed the first farmland drop of a way down the terraces lands on, and nothing for a goal no way reaches', async (t) => {
  const cells = terraces(false)
  const { bot, plan, TRAMPLE } = await walkingBody(t, START, cells)
  const { farmlandStrand } = loadBotFunctions(['farmlandStrand'], { bot, TRAMPLE, routeEnd: () => null })
  bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
  const { farmland: bed } = await farmlandStrand(BOTTOM, null, null)
  assert.deepStrictEqual([cells[`${bed.x},${bed.y},${bed.z}`][0], bed.y], ['farmland', 62], `the middle terrace's bed, ${JSON.stringify(bed)}`)
  assert.strictEqual(await farmlandStrand(new goals.GoalBlock(4, 70, 30), null, null), null, 'a goal in the air')
  assert.strictEqual(plan(BOTTOM).status, 'noPath', 'the goal stays unmarked')
})

test('a strand probe maps a jump over a bed to that bed and a drop onto a bed to the bed under the landing', async (t) => {
  const Move = require('mineflayer-pathfinder/lib/move')
  const cells = { '1,63,0': FARMLAND, '-1,63,0': ['air', {}], '-1,62,0': FARMLAND }
  const { bot, TRAMPLE, trampleGoal } = await walkingBody(t, START, cells)
  const probe = trampleGoal(new goals.GoalBlock(5, 64, 0))
  const landed = new Map()
  TRAMPLE.probes.set(probe, landed)
  TRAMPLE.search = probe
  let moves
  try { moves = bot.pathfinder.movements.getNeighbors(new Move(0, 64, 0, 0, 0)) } finally { TRAMPLE.search = null }
  const at = (x, y, z, parkour) => moves.find((m) => m.x === x && m.y === y && m.z === z && !!m.parkour === parkour)
  const bed = (move) => { const b = landed.get(move); return b && [b.x, b.y, b.z] }
  assert.deepStrictEqual([bed(at(2, 64, 0, true)), bed(at(-1, 63, 0, false))], [[1, 63, 0], [-1, 62, 0]])
  assert.strictEqual(landed.has(at(1, 64, 0, false)), false, 'a step onto the bed on its level')
  assert.strictEqual(landed.size, 2)
})

async function knowing (pos, { open, sky = () => false, seen, solid = () => 'stone' }) {
  const b = await body(pos, {})
  const Block = require('prismarine-block')(b.bot.registry)
  b.bot.blockAt = (p) => {
    const c = p.floored()
    const block = Block.fromProperties(open(c) ? 'air' : solid(c), {}, 0)
    block.position = c
    block.skyLight = sky(c) ? 15 : 0
    return block
  }
  const TRAMPLE = botConstant('TRAMPLE')
  const env = { bot: b.bot, Vec3, cellKnown: seen, heldLight: (p, block) => block, ck: (x, y, z) => `${x},${y},${z}`, PLAN_KNOWN: new Map(), TRAMPLE, ...groundMemory() }
  loadBotFunctions(['knownMoves'], blockWorld(env)).knownMoves(b.moves)
  return { ...b, TRAMPLE }
}
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

test('the walk legs leave out a drop onto farmland the bot has seen', async () => {
  // A room 2 high over x and z -5 to 5 with a trench at z 0 from x 1 to 4, its floor at y 62.
  const trench = (p) => p.z === 0 && p.x >= 1 && p.x <= 4
  const open = (p) => (Math.abs(p.x) <= 5 && Math.abs(p.z) <= 5 && (p.y === 64 || p.y === 65)) || (trench(p) && p.y === 63)
  const statusOf = async (floor) => {
    const { plan } = await knowing(START, { open, sky: open, seen: () => true, solid: (p) => (trench(p) && p.y === 62 ? floor : 'stone') })
    return plan(new goals.GoalBlock(4, 63, 0)).status
  }
  assert.strictEqual(await statusOf('stone'), 'success', 'control: a stone floor')
  assert.strictEqual(await statusOf('farmland'), 'noPath')
})

test('a strand probe on the walk legs names only farmland the bot has seen', async () => {
  // From x 17 on the corridor lies past the 16 blocks the eye makes out shapes in.
  const corridor = (p) => p.z === 0 && p.x >= 0 && p.x <= 22 && p.y >= 64 && p.y <= 66
  const strand = async ({ open = corridor, farmland, seen, goal }) => {
    const { bot, moves, TRAMPLE } = await knowing(START, { open, seen, solid: (p) => (farmland(p) ? 'farmland' : 'stone') })
    bot.pathfinder.setMovements(moves)
    bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
    const { farmlandStrand } = loadBotFunctions(['farmlandStrand'], { bot, TRAMPLE, routeEnd: () => null })
    const r = await farmlandStrand(goal, null, null)
    return r && [r.farmland.x, r.farmland.y, r.farmland.z]
  }
  // A pit 1 deep at x 19 to 21 with a floor of farmland.
  const pitFloor = (p) => p.z === 0 && p.x >= 19 && p.x <= 21 && p.y === 62
  const pit = { open: (p) => corridor(p) || pitFloor(p.offset(0, -1, 0)), farmland: pitFloor, goal: new goals.GoalBlock(20, 63, 0) }
  assert.deepStrictEqual(await strand({ ...pit, seen: () => true }), [19, 62, 0], 'the pit floor in sight')
  // The way jumps over the unseen bed at x 19 onto the one at x 20.
  const beds = (p) => p.z === 0 && p.y === 63 && (p.x === 19 || p.x === 20)
  const jump = await strand({ farmland: beds, seen: (p) => !(p.x === 19 && p.y === 63 && p.z === 0), goal: new goals.GoalBlock(22, 64, 0) })
  assert.deepStrictEqual(jump, [20, 63, 0])
})

// Terraces down along z in a walled box over x 0 to 6, paths at z 0, 3 and 6 each a block lower, beds over x 2 to 5 at z 1, 2, 4 and 5.
const STEP_FLOOR = [63, 63, 63, 62, 62, 62, 61]
function steps (over = () => null) {
  const inside = (p) => p.x >= 0 && p.x <= 6 && p.z >= 0 && p.z <= 6
  const bed = (p) => p.x >= 2 && p.x <= 5 && [1, 2, 4, 5].includes(p.z)
  const own = (p) => !inside(p) || p.y > 66 ? 'stone' : p.y > STEP_FLOOR[p.z] ? 'air' : bed(p) && p.y === STEP_FLOOR[p.z] ? 'farmland' : 'stone'
  const at = (p) => over(p) ?? own(p)
  return { at, open: (p) => at(p) === 'air', solid: at }
}
const cellIs = (x, y, z) => (p) => p.x === x && p.y === y && p.z === z
const STEP_DROPS = ['3,63,3', '4,63,3', '2,63,3']
// The walk legs' moves from the node at from, searching for goal marked to trample when one is given.
async function stepMoves (over, from, goal = null) {
  const Move = require('mineflayer-pathfinder/lib/move')
  const { moves, TRAMPLE } = await knowing(START, { ...steps(over), seen: () => true })
  if (goal) TRAMPLE.goals.add(goal)
  TRAMPLE.search = goal
  try {
    return moves.getNeighbors(new Move(...from, 0, 0)).map((m) => ({ key: `${m.x},${m.y},${m.z}`, cost: m.cost }))
  } finally {
    TRAMPLE.search = null
  }
}
const keysOf = (moves) => moves.map((m) => m.key)

test('the walk legs drop onto a 1-wide path with a seen bed beyond it, straight and diagonal', async () => {
  const keys = keysOf(await stepMoves(() => null, [3, 64, 2]))
  assert.deepStrictEqual(STEP_DROPS.filter((k) => keys.includes(k)), STEP_DROPS)
})

test('the walk legs leave out a jump up out of water onto a seen bed, and plan it from dry ground', async () => {
  const pool = (block) => (p) => (cellIs(3, 63, 1)(p) ? block : null)
  const wet = keysOf(await stepMoves(pool('water'), [3, 63, 1]))
  assert.deepStrictEqual([wet.includes('4,64,1'), wet.includes('3,64,0')], [false, true], 'onto the bed, and onto the top path')
  assert.strictEqual(keysOf(await stepMoves(pool('air'), [3, 63, 1])).includes('4,64,1'), true, 'from a dry hole')
})

test('a goal marked to trample plans the jump out of water onto a bed for farmlandCost more', async () => {
  const goal = new goals.GoalBlock(3, 62, 6)
  const cost = async (over, from, key) => (await stepMoves(over, from, goal)).find((m) => m.key === key).cost
  const pool = (p) => (cellIs(3, 63, 1)(p) ? 'water' : null)
  const pathPool = (p) => pool(p) ?? (cellIs(4, 63, 1)(p) ? 'stone' : null)
  assert.strictEqual(await cost(pool, [3, 63, 1], '4,64,1') - await cost(pathPool, [3, 63, 1], '4,64,1'), 50, 'out of the water')
})

test('a strand probe names the bed a jump out of water lands on', async () => {
  // The only way out of this walled pool is a jump up onto the bed at 4,63,1.
  const walls = [[2, 1], [3, 0], [3, 2], [4, 0], [4, 2]]
  const pool = (p) => (cellIs(3, 63, 1)(p) ? 'water' : walls.some(([x, z]) => p.x === x && p.z === z && (p.y === 64 || p.y === 65)) ? 'stone' : null)
  const { bot, moves, TRAMPLE } = await knowing(new Vec3(3.5, 63, 1.5), { ...steps(pool), seen: () => true })
  bot.pathfinder.setMovements(moves)
  bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
  const { farmlandStrand } = loadBotFunctions(['farmlandStrand'], { bot, TRAMPLE, routeEnd: () => null })
  const r = await farmlandStrand(new goals.GoalBlock(6, 64, 1), null, null)
  assert.deepStrictEqual(r && [r.farmland.x, r.farmland.y, r.farmland.z], [4, 63, 1])
})

test('a walk down the terraces finds a way to each lower path that comes down on no seen bed, also where the beds run wall to wall', async () => {
  const wide = (p) => ([1, 2, 4, 5].includes(p.z) && p.y === STEP_FLOOR[p.z] && p.x >= 0 && p.x <= 6 ? 'farmland' : null)
  // A path node's y is the top of the block it stands on, a fraction below the feet cell on farmland.
  const feet = (n) => new Vec3(Math.floor(n.x), Math.ceil(n.y), Math.floor(n.z))
  for (const [name, over] of [['paths at x 0, 1 and 6', () => null], ['wall to wall', wide]]) {
    const { at, open, solid } = steps(over)
    const trampled = (path) => path.map(feet).filter((n, i, cells) => {
      const p = i ? cells[i - 1] : START.floored()
      return (n.y < p.y || (n.y > p.y && at(p) === 'water')) && at(n.offset(0, -1, 0)) === 'farmland'
    }).map((n) => n.toString())
    for (const goal of [new goals.GoalBlock(3, 63, 3), new goals.GoalBlock(3, 62, 6)]) {
      const r = (await knowing(START, { open, solid, seen: () => true })).plan(goal)
      assert.deepStrictEqual([r.status, trampled(r.path)], ['success', []], `${name}: ${goal.x},${goal.y},${goal.z}`)
    }
  }
})

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
