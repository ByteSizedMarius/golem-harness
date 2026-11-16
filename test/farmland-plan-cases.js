'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Physics } = require('prismarine-physics')
const { botConstant, groundMemory, blockWorld, loadBotFunctions, walkingBody } = require('./helpers')
const { SWING_REACH } = require('../lib/combat-rules')
const { HITBOX_1710, LEGACY_SNEAK_EYE } = require('../lib/bot/legacy-1710')

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

// Registers the farmland cases on the default and job legs. differ holds the expectations that change with farmland's collision height.
function fieldPlanCases (differ = {}) {
  // overBed: the bed the probe gives the jump to x 2, null when there is no such jump. landings: how many moves the probe maps.
  const expect = { overBed: [1, 63, 0], landings: 2, ...differ }
  test('the pathfinder jumps up a step of farmland like one of stone', async () => {
    for (const [label, top] of [['stone', STONE], ['farmland', FARMLAND]]) {
      const { plan } = await body(START, step(top))
      const result = plan(new goals.GoalBlock(6, 64, 0))
      assert.ok(jumps(result.path)[0] === result.path[0] && !rounds(result.path), `${label}: a jump straight up the step`)
      assert.strictEqual((await firstTick(step(top))).jump, true, `${label}: the body jumps`)
    }
  })

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

  test('a reach walk whose only way is a jump up out of water onto farmland is not counted as a way through unseen cells', async (t) => {
    const statusOf = async (ring) => {
      const cells = { '0,63,0': ['water', {}] }
      for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (x || z) cells[`${x},63,${z}`] = ring
      const { bot } = await walkingBody(t, new Vec3(0.5, 63, 0.5), cells)
      bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
      const env = { bot, Vec3, Movements, goals, shared: {}, LEGACY_1710: false, HITBOX_1710, LEGACY_SNEAK_EYE, SWING_REACH, UNSEEN_PLAN_MS: botConstant('UNSEEN_PLAN_MS') }
      const { unseenWay } = loadBotFunctions(['unseenWay'], env)
      return unseenWay({ id: 3, name: 'zombie', width: 0.6, height: 1.95, position: new Vec3(5.5, 64, 0.5) })
    }
    assert.strictEqual(await statusOf(STONE), 'success', 'control: a ring of stone')
    assert.strictEqual(await statusOf(FARMLAND), 'noPath')
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
    if (expect.overBed) assert.deepStrictEqual(bed(at(2, 64, 0, true)), expect.overBed)
    else assert.strictEqual(at(2, 64, 0, true), undefined, 'no jump over the bed on the start\'s level')
    assert.deepStrictEqual(bed(at(-1, 63, 0, false)), [-1, 62, 0])
    assert.strictEqual(landed.has(at(1, 64, 0, false)), false, 'a step onto the bed on its level')
    assert.strictEqual(landed.size, expect.landings)
  })
}

// Registers the farmland cases on the walk legs over known cells.
function fieldMoveCases () {
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
}

module.exports = { body, knowing, legsOf, steps, stepMoves, START, STONE, fieldPlanCases, fieldMoveCases }
