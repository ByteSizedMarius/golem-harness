'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { performance } = require('node:perf_hooks')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { goals, Movements, pathfinder } = require('mineflayer-pathfinder')
const { createConnection, bindConnection, wireConnectionSpawn } = require('../lib/bot/connection')
const { standCell, resolveTarget, crumbCentre, arrivedAt, walkAttempt, routeDeadline } = require('../lib/walk')
const { playerNamed } = require('../lib/players')
const { summarizePlan, planRisk, inCreeperZone, zoneCrossed } = require('../lib/plan')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { loadBotFunctions, botConstant, walkingBody, awaitRoute } = require('./helpers')

const block = (name, boundingBox, height) => ({ name, boundingBox, shapes: height ? [[0, 0, 0, 1, height, 1]] : [] })
const AIR = block('air', 'empty')
const STONE = block('stone', 'block', 1)
const WATER = block('water', 'empty')

// Stone up to y 63, with water from above floorY up to 63 between x0 and x1 in each pool, unloaded past x 40.
function terrain (...pools) {
  return (p) => {
    if (p.x > 40) return null
    const pool = pools.find(([x0, x1]) => p.x >= x0 && p.x <= x1)
    if (p.y > 63) return AIR
    return pool && p.y > pool[2] ? WATER : STONE
  }
}

const pathNode = (x, y, z) => new Vec3(x + 0.5, y, z + 0.5)

// Runs a timer 1000 times sooner than asked, with now() scaled to match.
const FAST = {
  now: () => performance.now() * 1000,
  setInterval: (fn, ms) => setInterval(fn, Math.max(1, ms / 1000)),
  clearInterval: (h) => clearInterval(h),
  setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, ms / 1000)),
  clearTimeout: (h) => clearTimeout(h)
}

// The fake walk reaches every goal with a y and finds no path to the others. planned replaces every plan.
async function swimGoto (q, walkOpts, { blockAt, start = new Vec3(0.5, 64, 0.5), known = () => true, planned }) {
  const set = []
  const bot = new EventEmitter()
  bot.entity = { position: start }
  bot.game = { minY: -64, height: 384 }
  bot.players = {}
  bot.entities = {}
  bot.blockAt = blockAt
  bot.pathfinder = {
    goal: null,
    thinkTimeout: 10000,
    setGoal (g) {
      this.goal = g
      bot.emit('goal_updated', g)
      if (!g) return
      set.push(g)
      setImmediate(() => {
        if (g.y === undefined) return bot.emit('path_update', { status: 'noPath', path: [] })
        bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5)
        bot.emit('goal_reached', g)
      })
    }
  }
  const feet = (x) => ((blockAt(new Vec3(x, 63, 0)) || AIR).name === 'water' ? 63 : 64)
  const planPath = async (g) => {
    if (planned) return planned
    const path = []
    for (let x = Math.floor(bot.entity.position.x) + 1; x <= g.x; x++) path.push(pathNode(x, feet(x), 0))
    return { status: 'success', path }
  }
  const ctx = loadBotFunctions(['walkRoute', 'stagedGoto'], { ...gotoEnv(bot), planPath, knownCell: known })
  const route = ctx.walkRoute()
  try {
    return { r: JSON.parse(JSON.stringify(await ctx.stagedGoto(q, route, walkOpts))), walks: set.length }
  } finally { route.end() }
}

// What stagedGoto reaches besides planPath, for a bot that has seen every cell.
function gotoEnv (bot) {
  return {
    bot,
    bunker: { building: false },
    console,
    setTimeout: (fn) => setImmediate(fn),
    clearTimeout: (h) => clearImmediate(h),
    goals,
    standCell,
    resolveTarget,
    arrivedAt,
    walkAttempt: (b, g, o) => walkAttempt(b, g, { ...o, clock: FAST }),
    routeDeadline,
    legs: legLedger(),
    WALK_HINTS: {},
    wayHint: () => null,
    insideBlock: () => null,
    WALK_FAILED: botConstant('WALK_FAILED'),
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    waypoints: { get: () => null },
    playerCrumbs: {},
    playerNamed,
    staleEntities: new Set(),
    crumbCentre,
    entityPerceptible: () => true,
    nametagVisible: () => false,
    reflexes: [{ name: 'combat', fairFill: () => ({}) }],
    nearestVisible: () => null,
    resolveBlockIds: () => [1],
    cellKnown: () => true,
    knownCell: () => true,
    hasLegalMove: () => true,
    airPrecheck: () => ({ verdict: 'connected' }),
    doorwayCommit: async () => false,
    stopPath () { bot.pathfinder.setGoal(null) },
    summarizePlan,
    planRisk,
    inCreeperZone,
    zoneCrossed
  }
}

// The goto hops toward x 100 because it lies past the loaded area.
const FAR = { x: 100, z: 0 }

test('a far goto refuses a hop that swims more than 3 blocks of deep water, without a step, walks it with accept, and walks a ford', async () => {
  const lake = terrain([5, 10, 60])
  const refused = await swimGoto(FAR, {}, { blockAt: lake })
  assert.deepStrictEqual([refused.walks, refused.r.reason, refused.r.risk, refused.r.plan.swim], [0, 'risky', 'it swims 6 blocks of deep water', 6])
  const accepted = await swimGoto(FAR, { accept: true }, { blockAt: lake })
  assert.deepStrictEqual([accepted.walks, accepted.r.reason], [3, 'no-path'], 'the hops run up to the unloaded edge')
  const ford = await swimGoto(FAR, {}, { blockAt: terrain([5, 10, 62]) })
  assert.deepStrictEqual([ford.walks, ford.r.reason], [3, 'no-path'], 'a ford is walked without a refusal')
})

test('a far goto whose hop plan finds no path walks nothing and replies no-path, and one whose plan timed out walks', async () => {
  const timedOut = await swimGoto(FAR, {}, { blockAt: terrain(), planned: { status: 'timeout', path: [] } })
  assert.deepStrictEqual([timedOut.walks, timedOut.r.reason], [3, 'no-path'], 'control: the hops run up to the unloaded edge')
  const r = await swimGoto(FAR, {}, { blockAt: terrain(), planned: { status: 'noPath', path: [] } })
  assert.deepStrictEqual([r.walks, r.r.reason], [0, 'no-path'])
})

test('a plan counts the lower layer of a 2-deep pond as deep water', () => {
  const pond = terrain([1, 4, 61])
  const path = [1, 2, 3, 4].map((x) => pathNode(x, 62, 0))
  const plan = summarizePlan(new Vec3(0.5, 64, 0.5), { status: 'success', path }, () => true, pond)
  assert.strictEqual(plan.swim, 4)
})

test('a goto that starts afloat swims out to the bank unrefused, and is refused for a later swim', async () => {
  const start = new Vec3(0.5, 63, 0.5)
  const out = await swimGoto({ x: 12, z: 0 }, {}, { blockAt: terrain([-10, 4, 60]), start })
  assert.deepStrictEqual([out.walks, out.r.arrived], [1, true])
  const again = await swimGoto({ x: 14, z: 0 }, {}, { blockAt: terrain([-10, 4, 60], [7, 11, 60]), start })
  assert.deepStrictEqual([again.walks, again.r.reason, again.r.plan.swim], [0, 'risky', 5])
})

test('a goto that starts afloat swims out over a sandbar unrefused, and is refused for a swim on a hop after it left the water', async () => {
  const start = new Vec3(0.5, 63, 0.5)
  // Deep water west of x 4 and from x 5 to 8, with a sandbar at x 4.
  const out = await swimGoto({ x: 12, z: 0 }, {}, { blockAt: terrain([-10, 3, 60], [4, 4, 62], [5, 8, 60]), start })
  assert.deepStrictEqual([out.walks, out.r.arrived], [1, true])
  // The first hop reaches land at x 5 and ends 3 cells into the lake from x 16.
  const later = await swimGoto(FAR, {}, { blockAt: terrain([-10, 4, 60], [16, 38, 60]), start })
  assert.deepStrictEqual([later.walks, later.r.reason, later.r.plan.swim], [1, 'risky', 18])
})

test('a far goto whose first hop ends 3 cells into a lake is refused on the hop that swims on', async () => {
  const r = await swimGoto(FAR, {}, { blockAt: terrain([16, 38, 60]) })
  assert.deepStrictEqual([r.walks, r.r.reason, r.r.plan.swim], [1, 'risky', 18])
})

test('a night swim counts the seen surface of a lake whose lower layer and bed are unseen as deep water', async () => {
  const known = (p) => !(p.x >= 5 && p.x <= 10 && p.y < 63)
  const r = await swimGoto(FAR, {}, { blockAt: terrain([5, 10, 60]), known })
  const { reason, plan } = r.r
  assert.deepStrictEqual([r.walks, reason, plan.swim], [0, 'risky', 6])
  assert.deepStrictEqual([plan.unseen, plan.end], [true, { x: 4, y: 64, z: 0 }], 'the rest of the plan stops where the seen cells end')
})

test('a ford with a seen bed counts no swim, and one whose bed is unseen counts as deep water', () => {
  const path = [1, 2, 3, 4, 5].map((x) => pathNode(x, x < 5 ? 63 : 64, 0))
  const swim = (known) => summarizePlan(new Vec3(0.5, 64, 0.5), { status: 'success', path }, known, terrain([1, 4, 62])).swim
  assert.deepStrictEqual([swim(() => true), swim((p) => p.y !== 62)], [undefined, 4])
})

test('water in cells the bot has not seen leaves the preview and the risky reply as they are without it', async () => {
  const scenes = [
    // Above a ford before a lake.
    { world: terrain([1, 3, 62], [5, 10, 60]), hidden: (p) => p.x >= 1 && p.x <= 3 && p.y === 64, swim: 6 },
    // In the cell the bot stands in and the one above it, beside a lake.
    { world: terrain([1, 4, 60]), hidden: (p) => p.x === 0 && (p.y === 63 || p.y === 64), start: new Vec3(0.5, 63, 0.5), swim: 4 }
  ]
  for (const { world, hidden, start, swim } of scenes) {
    const known = (p) => !hidden(p)
    const air = (p) => (hidden(p) ? AIR : world(p))
    const water = (p) => (hidden(p) ? WATER : world(p))
    for (const [q, opts] of [[{ x: 12, y: 64, z: 0 }, { preview: true }], [FAR, {}]]) {
      const control = await swimGoto(q, opts, { blockAt: air, known, start })
      assert.strictEqual(control.r.plan.swim, swim, 'control: the plan swims the lake')
      assert.deepStrictEqual(await swimGoto(q, opts, { blockAt: water, known, start }), control)
    }
  }
})

const ck = (x, y, z) => x + ',' + y + ',' + z
const knownMoves = () => loadBotFunctions(['knownMoves'], { ck, knownCell: () => true, PLAN_KNOWN: new Map() }).knownMoves

// Water at the heights ys for x x0 to x0 + 3 and z -50 to 50, with a causeway of floor across at z gap.
function pool (ys, gap, x0 = 3) {
  const cells = {}
  for (let z = -50; z <= 50; z++) for (let x = x0; x <= x0 + 3; x++) if (z !== gap) for (const y of ys) cells[ck(x, y, z)] = ['water', {}]
  return cells
}
const ORIGIN = new Vec3(0.5, 64, 0.5)
const SHORE = new goals.GoalBlock(10, 64, 0)
// The causeway at z 36 costs more than the swim and less than the swim plus one water cost.
const LAKE = pool([63, 64], 36)

function crossing (bot, plan, moves) {
  const result = plan(SHORE, moves)
  return [result.status, summarizePlan(bot.entity.position, result, () => true, (p) => bot.blockAt(p)).swim ?? 0]
}

test('the walk and a collect take a causeway over a swim that is shorter only without the cost of the step in', async (t) => {
  const { bot, plan, shared } = await walkingBody(t, ORIGIN, LAKE)
  const cages = []
  bot.collectBlock = { movements: null, async collect () { cages.push(this.movements) } }
  bot.tool = { equipForBlock: async () => {} }
  for (const legs of [(m) => m, knownMoves()]) {
    const env = { bot, collectLock: botConstant('collectLock'), knownMoves: legs, Movements, shared, watchedWork: (work) => work(), abandonCollect () {} }
    await loadBotFunctions(['collectSafely'], env).collectSafely({ type: bot.registry.blocksByName.iron_ore.id }, 'iron_ore')
  }
  const control = [crossing(bot, plan, shared.considerateMoves), crossing(bot, plan, cages[0])]
  assert.deepStrictEqual(control, [['success', 4], ['success', 4]], 'control: both swim')
  knownMoves()(shared.considerateMoves)
  assert.deepStrictEqual([crossing(bot, plan, shared.considerateMoves), crossing(bot, plan, cages[1])], [['success', 0], ['success', 0]])
})

// stagedGoto with the real planPath on walkingBody's bot, whose feet hold the cells within 24 columns along x.
// Each walk answers with the real planner's path to its goal and puts the feet at the path's end.
async function bodyGoto (bot, q) {
  const held = bot.blockAt
  bot.blockAt = (p) => (Math.abs(Math.floor(p.x) - Math.floor(bot.entity.position.x)) > 24 ? null : held(p))
  bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
  const start = bot.entity.position
  const walked = []
  const walk = (g) => {
    if (!g) return
    setImmediate(() => {
      const result = bot.pathfinder.getPathTo(bot.pathfinder.movements, g)
      bot.emit('path_update', result)
      if (result.status !== 'success' || !result.path.length) return
      walked.push(result.path)
      const end = result.path.at(-1)
      bot.entity.position = new Vec3(Math.floor(end.x) + 0.5, end.y, Math.floor(end.z) + 0.5)
      bot.emit('goal_reached', g)
    })
  }
  bot.on('goal_updated', walk)
  const ctx = loadBotFunctions(['walkRoute', 'stagedGoto'], gotoEnv(bot))
  const route = ctx.walkRoute()
  try {
    return { r: JSON.parse(JSON.stringify(await ctx.stagedGoto(q, route))), walked }
  } finally {
    route.end()
    bot.removeListener('goal_updated', walk)
    bot.blockAt = held
    bot.entity.position = start
  }
}

// Two lakes east of the origin, at x 3 to 6 and 22 to 25, each with a causeway at z 36.
const LAKES = { ...pool([63, 64], 36), ...pool([63, 64], 36, 22) }

// The path's nodes on a causeway cell, with water north and south of it, and its nodes with the feet in water.
function lakeNodes (path) {
  const cells = path.map((n) => [Math.floor(n.x), Math.floor(n.y), Math.floor(n.z)])
  const causeway = cells.filter(([x, y, z]) => LAKES[ck(x, y, z - 1)] && LAKES[ck(x, y, z + 1)]).length
  return [causeway, cells.filter(([x, y, z]) => LAKES[ck(x, y, z)]).length]
}

test('a far goto crosses two lakes on their causeways, and is refused for the swim without the water cost of the step in', async (t) => {
  const { bot, shared } = await walkingBody(t, ORIGIN, LAKES)
  const q = { x: 30, y: 64, z: 0 }
  const control = await bodyGoto(bot, q)
  assert.deepStrictEqual([control.r.reason, control.r.plan.swim, control.walked.length], ['risky', 4, 0], 'control: the first hop swims')
  knownMoves()(shared.considerateMoves)
  const { r, walked } = await bodyGoto(bot, q)
  assert.deepStrictEqual([r.arrived, r.reason], [true, null])
  assert.deepStrictEqual(walked.map(lakeNodes), [[4, 0], [4, 0]], 'the hop and the last leg each walk a causeway')
})

// East of a bot at the origin a pool 2 long whose surface is level with the feet, west one cell whose surface lies 1 below them.
const ENTRIES = Object.fromEntries([[1, 64], [1, 63], [2, 64], [2, 63], [-1, 63], [-1, 62]].map(([x, y]) => [ck(x, y, 0), ['water', {}]]))
// The costs of the step east into the pool, the drop west into the lower water cell, and the step on from the pool's first cell.
function entryCosts (m) {
  const cost = (from, x, y) => m.getNeighbors({ x: from, y: 64, z: 0, remainingBlocks: 0 }).find((move) => move.x === x && move.y === y && move.z === 0).cost
  return [cost(0, 1, 64), cost(0, -1, 62), cost(1, 2, 64)]
}
const extra = (costs, control) => costs.map((c, i) => c - control[i])

test('a step and a drop into deep water pay the water cost, and a step on through it pays it once', async (t) => {
  const { shared } = await walkingBody(t, ORIGIN, ENTRIES)
  const paid = [shared.considerateMoves, shared.forestryMoves].map((m) => {
    const control = entryCosts(m)
    knownMoves()(m)
    return extra(entryCosts(m), control)
  })
  const c = shared.considerateMoves.liquidCost
  const f = shared.forestryMoves.liquidCost
  assert.deepStrictEqual(paid, [[c, c, 0], [f, f, 0]])
})

test('a ford plans as it does without the water cost', async (t) => {
  const { bot, plan, shared } = await walkingBody(t, ORIGIN, pool([64]))
  const wade = () => {
    const result = plan(SHORE)
    return [result.status, result.cost, result.path.filter((n) => bot.blockAt(n).name === 'water').length]
  }
  const control = wade()
  assert.strictEqual(control[2], 4, 'control: the plan wades')
  knownMoves()(shared.considerateMoves)
  assert.deepStrictEqual(wade(), control)
})

test('a creeper zone laid over the water cost keeps it, and leaves it in place when it ends', async (t) => {
  const { bot, shared } = await walkingBody(t, ORIGIN, ENTRIES)
  const m = shared.considerateMoves
  const control = entryCosts(m)
  knownMoves()(m)
  const env = {
    bot: { entity: bot.entity, pathfinder: { movements: m } },
    reflexes: [{ name: 'combat', watchedCreepers: () => [{ id: 9, at: new Vec3(0, 64, 40), radius: 3 }] }],
    routeEnd: () => null,
    inCreeperZone
  }
  const zones = loadBotFunctions(['creeperZones'], env).creeperZones({})
  const zoned = extra(entryCosts(m), control)
  zones.restore()
  const c = m.liquidCost
  assert.deepStrictEqual([zoned, extra(entryCosts(m), control)], [[c, c, 0], [c, c, 0]])
})

const FULL_REFLEX = ['stopDigging', 'takeLegs', ['setGoal', null], 'swimUp', 'drowning']
const START = 1e6

// A submerged body on the real connection wiring, beside a /pillar sharing its legs and perch.
// rig.log holds [ms since START, call], an oxygen alarm as 'drowning <oxygen>'.
async function drowningBody (t) {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.write = () => {}
  client.end = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  bot.loadPlugin(pathfinder)
  await once(bot, 'inject_allowed')
  Object.assign(bot, { version: '1.21.11', entity: { position: new Vec3(0.5, 63, 0.5) }, clearControlStates () {}, async placeBlock () {} })
  const rig = { log: [], perch: { cell: null, rose: 0 } }
  const mark = (call) => rig.log.push([Date.now() - START, call])
  const legs = legLedger()
  const ctx = {
    bot,
    knownMoves: (m) => m,
    navPlaced: [],
    startReflexes () {},
    vecStr: () => '',
    emitEvent: (kind, text, data) => mark(data.oxygen === undefined ? kind : `${kind} ${data.oxygen}`),
    waterState: () => ({ submerged: true }),
    takeLegs: (reflex, why) => { mark('takeLegs'); legs.take(reflex, why) },
    swimUp: () => mark('swimUp'),
    perch: rig.perch
  }
  createConnection(ctx)
  bindConnection(ctx)
  wireConnectionSpawn()
  // A mocked setInterval keeps the spawn's mob scan from ever running.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: START })
  bot.emit('spawn')
  bot.stopDigging = () => mark('stopDigging')
  bot.pathfinder.setGoal = (g) => mark(['setGoal', g])
  rig.fired = (ms) => FULL_REFLEX.map((call) => [ms, call])
  // Advances the clock by ms, then emits a breath reading of oxygen o2.
  rig.breathe = (ms, o2) => {
    t.mock.timers.setTime(Date.now() + ms)
    bot.oxygenLevel = o2
    bot.emit('breath')
  }
  // A /pillar of levels.length levels, level i emitting the readings levels[i] as [ms, o2] before it places.
  rig.pillar = (levels) => {
    const entity = { position: new Vec3(0.5, 63, 0.5) }
    let level = 0
    return awaitRoute('/pillar', { height: String(levels.length) }, {
      bot: { entity, blockAt: (p) => ({ name: 'stone', boundingBox: 'block', position: p }) },
      bunker: { building: false },
      legs,
      takenText,
      perch: rig.perch,
      claimLane: () => ({}),
      releaseLane () {},
      fillers: () => [{ name: 'dirt', count: 64 }],
      pillarHeight: (height) => ({ height, safe: 2, why: 'flat ground' }),
      BUNKER_MAX_HEIGHT: 6,
      knownCell: () => false,
      Date,
      jumpPlace: async () => {
        for (const [ms, o2] of levels[level++]) rig.breathe(ms, o2)
        entity.position = entity.position.offset(0, 1, 0)
        return true
      }
    })
  }
  return rig
}

const DROWN_STOP = takenText({ reflex: 'drown', why: 'swim up' })
const RISING = [[[1000, 6]], [[1000, 6]], [[1000, 6]]]

test('breath readings falling 0.75 s apart under water bring the full drown reflex from the first at or below 8, alarm and reflex each at most once per 3 s', async (t) => {
  const rig = await drowningBody(t)
  for (let o2 = 11; o2 >= 0; o2--) rig.breathe(o2 === 11 ? 0 : 750, o2)
  assert.deepStrictEqual(rig.log, [[0, 'drowning 11'], ...rig.fired(2250), [3000, 'drowning 7'], ...rig.fired(5250), [6000, 'drowning 3'], ...rig.fired(8250)])
})

test('a pillar rising out of water keeps its legs from the drown reflex at oxygen 6, and from its start at oxygen 8', async (t) => {
  const rig = await drowningBody(t)
  assert.deepStrictEqual(await rig.pillar(RISING), { placed: 3, rose: 3, y: 66 })
  assert.deepStrictEqual(await rig.pillar([[[1000, 8]], [[1000, 7]], [[1000, 6]]]), { placed: 3, rose: 3, y: 66 }, 'oxygen 8 on the first level')
  assert.deepStrictEqual(rig.log, [[1000, 'drowning 6'], [4000, 'drowning 8']])
})

test('oxygen 3 brings the full drown reflex back while the pillar rises, within 3 s of the last alarm', async (t) => {
  const rig = await drowningBody(t)
  assert.deepStrictEqual(await rig.pillar([[[750, 6], [750, 5]], [[750, 4], [750, 3]], []]), { placed: 2, rose: 2, stopped: DROWN_STOP })
  assert.deepStrictEqual(rig.log, [[750, 'drowning 6'], ...rig.fired(3000)])
})

test('a pillar whose last level is over 3 s old gets the full drown reflex on the next reading', async (t) => {
  const rig = await drowningBody(t)
  assert.deepStrictEqual(await rig.pillar([[], [[1000, 6], [2500, 6]], []]), { placed: 2, rose: 2, stopped: DROWN_STOP })
  assert.deepStrictEqual(rig.log, [[1000, 'drowning 6'], ...rig.fired(3500)])
})

test('the drown reflex runs in full once the pillar has ended', async (t) => {
  const rig = await drowningBody(t)
  assert.deepStrictEqual(await rig.pillar(RISING), { placed: 3, rose: 3, y: 66 }, 'control: the pillar rose')
  rig.breathe(1000, 6)
  assert.deepStrictEqual(rig.log, [[1000, 'drowning 6'], [4000, 'drowning 6'], ...rig.fired(4000)])
})
