'use strict'
// A collect that makes no progress or runs over its budget ends, and mine and tidy say why.
const test = require('node:test')
const assert = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const gotoGoal = require('mineflayer-pathfinder/lib/goto')
const { goals } = require('mineflayer-pathfinder')
const { CollectBlock } = require('mineflayer-collectblock/lib/CollectBlock')
const { Targets } = require('mineflayer-collectblock/lib/Targets')
const { guardWork } = require('../lib/walk')
const { createJobs } = require('../lib/jobs')
const { deathLedger } = require('../lib/deaths')
const { entityInCell } = require('../lib/shelter')
const { HUNG, awaitRoute, botConstant, claimRescue, fakeClock, loadBotFunctions, routeHandler, runRoute, timed, waitFor } = require('./helpers')

// The collect plugin switches on the class names.
class Block {
  constructor (name, position, type = 1) { Object.assign(this, { name, type, position }) }
}
class Entity {
  constructor (position) { Object.assign(this, { position, isValid: true }) }
}

class Movements {
  constructor () { this.openable = new Set() }
  getBlock () { return {} }
  safeToBreak () { return true }
}

// The fake pathfinder reaches a goal at once when reach(goal) holds, otherwise it plans plan(goal) and never walks it.
function collector (t, { blocks, reach, plan = () => ({ status: 'success', path: [new Vec3(1, 64, 0)] }), drifting = false, holdDig = false }) {
  blocks = { ...blocks }
  const bot = new EventEmitter()
  let x = 0
  bot.entity = { width: 0.6, height: 1.8, get position () { return new Vec3(drifting ? x++ : 0, 64, 0) } }
  bot.blockAt = (p) => blocks[`${p.x},${p.y},${p.z}`] || null
  const pockets = []
  bot.inventory = { items: () => pockets, emptySlotCount: () => 36 }
  bot.waitForTicks = () => new Promise(setImmediate)
  bot.tool = { equipForBlock: async () => {} }
  bot.heldItem = null
  bot.targetDigBlock = null
  const seen = { digs: 0, planned: 0, followed: 0, stops: 0, drops: [] }
  bot.stopDigging = () => { if (seen.abortDig) seen.abortDig(new Error('Digging aborted')) }
  bot.dig = async (b) => {
    seen.digs++
    if (holdDig) {
      bot.targetDigBlock = b
      try {
        await new Promise((resolve, reject) => { Object.assign(seen, { finishDig: resolve, abortDig: reject }) })
      } finally {
        bot.targetDigBlock = null
      }
    }
    blocks[`${b.position.x},${b.position.y},${b.position.z}`] = new Block('air', b.position, 0)
    seen.drops.push(new Entity(b.position.offset(0.5, 0.5, 0.5)))
    bot.emit('itemDrop', seen.drops[seen.drops.length - 1])
  }
  let ticking = true
  const tick = () => {
    if (!ticking) return
    bot.emit('physicsTick')
    setImmediate(tick)
  }
  t.after(() => { ticking = false })
  setImmediate(tick)
  bot.pathfinder = {
    goal: null,
    thinkTimeout: 10000,
    movements: null,
    setMovements (m) { this.movements = m },
    isMoving: () => false,
    stop () { seen.stops++ },
    setGoal (g) {
      this.goal = g
      bot.emit('goal_updated', g)
      if (!g) return
      if (g instanceof goals.GoalFollow) seen.followed++
      setImmediate(() => {
        if (this.goal !== g) return
        if (reach(g)) {
          this.goal = null
          bot.emit('goal_reached', g)
        } else {
          seen.planned++
          bot.emit('path_update', plan(g))
        }
      })
    }
  }
  bot.collectBlock = Object.assign(Object.create(CollectBlock.prototype), { bot, targets: new Targets(bot), chestLocations: [], itemFilter: () => true, movements: null })
  const clock = fakeClock()
  const env = {
    bot,
    require,
    goals,
    shared: { mcData: { blocksArray: [], blocks: { 1: { name: 'iron_ore', drops: [903] } }, items: { 903: { name: 'raw_iron' } }, itemsByName: { raw_iron: {}, iron_ore: {} } } },
    Movements,
    navPlaced: [],
    collectLock: botConstant('collectLock'),
    digLock: botConstant('digLock'),
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    guardWork: (work, o) => guardWork(work, { ...o, clock }),
    watchScope: new AsyncLocalStorage(),
    Vec3,
    cellKnown: () => true,
    console: { log: () => {} },
    resolveBlockIds: () => [1],
    nearestVisible: () => blocks['1,64,0'],
    holdCollectTool: async () => {}
  }
  // collectSafely hands abandonCollect on uncalled, so the route loader would not find it.
  const { watchGoto } = loadBotFunctions(['abandonCollect', 'watchGoto'], env)
  // The goto bot.js installs at spawn.
  bot.pathfinder.goto = watchGoto((g) => gotoGoal(bot, g))
  return { bot, env, clock, seen, blocks, pockets }
}

const ORE = { '1,64,0': new Block('iron_ore', new Vec3(1, 64, 0)) }

// The reply, or HUNG when it has not come within 2 s.
const within = async (reply) => (await timed(reply, 2000)).out

test('mine returns with stalled when the path to the block never gets anywhere', async (t) => {
  const c = collector(t, { blocks: ORE, reach: () => false })
  const reply = awaitRoute('/mine', { name: 'iron_ore', count: '2', radius: '8' }, c.env)
  assert.ok(await waitFor(() => c.seen.planned > 0, 2000), 'control: the walk to the block planned')
  c.clock.advance(botConstant('COLLECT_STALL_MS') + 500)
  assert.deepStrictEqual(await within(reply), { mined: 0, requested: 2, gathered: 0, reason: 'stalled' })
  assert.strictEqual(c.bot.pathfinder.goal, null, 'the walk is stopped')
})

test('mine counts the dug block and returns with stalled when its drop is never picked up, and the next collect starts afresh', async (t) => {
  const c = collector(t, { blocks: ORE, reach: () => true })
  for (const round of [1, 2]) {
    c.blocks['1,64,0'] = ORE['1,64,0']
    const reply = awaitRoute('/mine', { name: 'iron_ore' }, c.env)
    assert.ok(await waitFor(() => c.seen.followed === round, 2000), `round ${round}: control, the body went to the drop`)
    if (round === 2) {
      // The first drop goes, and the given-up first collect wakes while the second one runs.
      c.bot.emit('entityGone', c.seen.drops[0])
      await new Promise(setImmediate)
      assert.strictEqual(c.seen.followed, 2, 'the first collect walks nowhere')
    }
    c.clock.advance(botConstant('COLLECT_STALL_MS') + 500)
    assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 0, reason: 'stalled' })
    assert.strictEqual(c.seen.digs, round)
  }
})

test('mine counts the drop that reached the pockets, raw_iron from iron_ore, and not what they held before', async (t) => {
  const c = collector(t, { blocks: ORE, reach: () => true })
  c.pockets.push({ name: 'raw_iron', count: 2 })
  const reply = awaitRoute('/mine', { name: 'iron_ore' }, c.env)
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the drop')
  c.pockets[0] = { name: 'raw_iron', count: 3 }
  c.bot.emit('entityGone', c.seen.drops[0])
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 1, reason: null })
})

test('mine ends the walk to a drop at its pickup, so a planner timeout or a stall after it leaves the reply and the goal clean', async (t) => {
  // What follows the pickup while the walk to the drop has not arrived.
  const after = {
    timeout: (c) => c.bot.emit('path_update', { status: 'timeout', path: [new Vec3(1, 64, 0)] }),
    stall: (c) => c.clock.advance(botConstant('COLLECT_STALL_MS') + 500)
  }
  for (const [what, then] of Object.entries(after)) {
    const c = collector(t, { blocks: ORE, reach: (g) => !(g instanceof goals.GoalFollow) })
    const reply = awaitRoute('/mine', { name: 'iron_ore' }, c.env)
    assert.ok(await waitFor(() => c.seen.followed === 1, 2000), `${what}: control, the body went to the drop`)
    c.pockets.push({ name: 'raw_iron', count: 1 })
    c.bot.emit('entityGone', c.seen.drops[0])
    await new Promise(setImmediate)
    then(c)
    assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 1, reason: null }, what)
    assert.strictEqual(c.bot.pathfinder.goal, null, what)
  }
})

test('mine clears the goal when the drop goes, and does not stop the pathfinder, which would zero a jump in flight', async (t) => {
  const c = collector(t, { blocks: ORE, reach: (g) => !(g instanceof goals.GoalFollow) })
  const goals_ = []
  c.bot.on('goal_updated', (g) => goals_.push(g))
  const reply = awaitRoute('/mine', { name: 'iron_ore' }, c.env)
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the drop')
  c.pockets.push({ name: 'raw_iron', count: 1 })
  const before = goals_.length
  c.bot.emit('entityGone', c.seen.drops[0])
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.strictEqual(c.seen.stops, 0, 'the pathfinder was not stopped')
  assert.ok(goals_.slice(before).includes(null), 'the walk ended through setGoal(null)')
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

const air = (x, y, z) => Object.assign(new Block('air', new Vec3(x, y, z), 0), { boundingBox: 'empty' })

test('mine stops its walk to the block when the walk finds no path', async (t) => {
  const c = collector(t, {
    blocks: { ...ORE, '1,65,0': air(1, 65, 0), '1,66,0': air(1, 66, 0) },
    reach: () => false,
    plan: () => ({ status: 'noPath', path: [new Vec3(0, 64, 0)] })
  })
  const { handle, res } = routeHandler('/mine', c.env)
  assert.notStrictEqual(await within(handle({ query: { name: 'iron_ore' } }, res)), HUNG, 'the /mine replied')
  assert.strictEqual(res.error && res.error.name, 'NoPath')
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('mine stops its walk to the block when the walk ends on an empty path and the dig would bring gravel down', async (t) => {
  const c = collector(t, {
    blocks: { ...ORE, '1,65,0': new Block('gravel', new Vec3(1, 65, 0), 13) },
    reach: () => false,
    plan: () => ({ status: 'noPath', path: [] })
  })
  Object.assign(c.env, { knownCell: () => true, entityInCell })
  // No face of the ore is in sight from where the walk ended.
  c.bot.world = { raycast: () => null }
  c.bot.pathfinder.startCell = (p) => p.floored()
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.match(reply.reason, /^refusing to dig iron_ore at 1,64,0: gravel at 1,65,0 would fall on me\b/)
  assert.strictEqual(c.seen.digs, 0)
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('mine returns with budget when the walk moves but never arrives', async (t) => {
  const c = collector(t, { blocks: ORE, reach: () => false, drifting: true })
  const reply = awaitRoute('/mine', { name: 'iron_ore' }, c.env)
  assert.ok(await waitFor(() => c.seen.planned > 0, 2000), 'control: the walk to the block planned')
  c.clock.advance(botConstant('COLLECT_BUDGET_MS') - 500)
  c.clock.advance(1000)
  assert.deepStrictEqual(await within(reply), { mined: 0, requested: 1, gathered: 0, reason: 'budget' })
})

test('tidy stops at a stalled reclaim, keeps the rest queued and says why', async (t) => {
  const scaffold = (x) => new Block('cobblestone', new Vec3(x, 64, 0))
  const c = collector(t, { blocks: { '1,64,0': scaffold(1), '2,64,0': scaffold(2) }, reach: () => false })
  c.env.navPlaced.push({ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 })
  const reply = awaitRoute('/tidy', {}, c.env)
  assert.ok(await waitFor(() => c.seen.planned > 0, 2000), 'control: the walk to the first block planned')
  c.clock.advance(botConstant('COLLECT_STALL_MS') + 500)
  assert.deepStrictEqual(await within(reply), { reclaimed: 0, alreadyGone: 0, failed: 1, remaining: 2, reason: 'stalled' })
  assert.deepStrictEqual(c.env.navPlaced.map((p) => p.x).sort(), [1, 2])
})

const RESCUE_BUSY = /^busy: the buried self-rescue is running\b/

test('mine during the buried self-rescue answers busy naming it, and names it as the reason when the rescue starts before its collect, digging nothing', async (t) => {
  const at = collector(t, { blocks: ORE, reach: () => true })
  claimRescue(at.env.digLock)
  const { handle, res } = routeHandler('/mine', at.env)
  assert.notStrictEqual(await within(handle({ query: { name: 'iron_ore' } }, res)), HUNG, 'the /mine replied')
  assert.strictEqual(res.error && res.error.reason, 'busy')
  assert.match(res.error.message, RESCUE_BUSY)
  assert.deepStrictEqual([at.seen.digs, at.seen.planned, at.bot.pathfinder.goal], [0, 0, null])

  const mid = collector(t, { blocks: ORE, reach: () => true })
  mid.env.nearestVisible = () => { claimRescue(mid.env.digLock); return mid.blocks['1,64,0'] }
  const { reason, ...counts } = await within(awaitRoute('/mine', { name: 'iron_ore' }, mid.env))
  assert.deepStrictEqual(counts, { mined: 0, requested: 1, gathered: 0 })
  assert.match(reason, RESCUE_BUSY)
  assert.deepStrictEqual([mid.seen.digs, mid.seen.planned, mid.bot.pathfinder.goal], [0, 0, null])
})

test('tidy during the buried self-rescue answers busy naming it, and names it as the reason when the rescue starts mid-reclaim, keeping the queue', async (t) => {
  const scaffold = (x) => new Block('cobblestone', new Vec3(x, 64, 0))
  const rig = () => {
    const c = collector(t, { blocks: { '1,64,0': scaffold(1), '2,64,0': scaffold(2) }, reach: () => true })
    c.env.navPlaced.push({ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 })
    return c
  }
  const at = rig()
  claimRescue(at.env.digLock)
  const { handle, res } = routeHandler('/tidy', at.env)
  assert.notStrictEqual(await within(handle({ query: {} }, res)), HUNG, 'the /tidy replied')
  assert.strictEqual(res.error && res.error.reason, 'busy')
  assert.match(res.error.message, RESCUE_BUSY)
  assert.deepStrictEqual([at.env.navPlaced.length, at.seen.digs, at.seen.planned], [2, 0, 0])

  const mid = rig()
  mid.env.seenNow = () => { claimRescue(mid.env.digLock); return true }
  const { reason, ...counts } = await within(awaitRoute('/tidy', {}, mid.env))
  assert.deepStrictEqual(counts, { reclaimed: 0, alreadyGone: 0, failed: 1, remaining: 2 })
  assert.match(reason, RESCUE_BUSY)
  assert.deepStrictEqual([mid.seen.digs, mid.seen.planned], [0, 0])
})

test('tidy counts a scaffold block as gone only when the body sees it gone', async (t) => {
  // seen sets whether the body sees the cell where the removed block stood.
  const tidy = async (seen) => {
    const c = collector(t, { blocks: {}, reach: () => false })
    c.env.seenNow = () => seen
    c.env.navPlaced.push({ x: 1, y: 64, z: 0 })
    return { reply: await within(awaitRoute('/tidy', {}, c.env)), queued: c.env.navPlaced }
  }
  assert.deepStrictEqual((await tidy(true)).reply, { reclaimed: 0, alreadyGone: 1, failed: 0, remaining: 0, reason: null }, 'control: seen gone')
  const unseen = await tidy(false)
  assert.deepStrictEqual(unseen.reply, { reclaimed: 0, alreadyGone: 0, failed: 0, remaining: 1, reason: null })
  assert.deepStrictEqual(unseen.queued, [{ x: 1, y: 64, z: 0 }])
})

// A collector for test t that runs gather jobs, wired to stop as bot.js wires them, and answers /stop.
function jobRig (t) {
  const c = collector(t, { blocks: ORE, reach: () => true, holdDig: true })
  c.bot.findBlocks = () => [new Vec3(1, 64, 0)]
  c.bot.world = { raycast: () => ({ position: new Vec3(1, 64, 0) }) }
  c.bot.clearControlStates = () => {}
  Object.assign(c.env, {
    seesLit: () => true,
    emitEvent: () => {},
    // The ore sits level with the feet.
    GATHER_MAX_DROP: 0,
    GATHER_MAX_RISE: 0,
    bunker: {},
    legs: { take: () => {} },
    stopFollow: () => {},
    clearLane: () => {},
    guardState: { hand: null }
  })
  const fns = loadBotFunctions(['stopCollect', 'stopPath'], c.env)
  c.env.jobs = createJobs({ stop: () => { fns.stopPath(); fns.stopCollect() }, emit: () => {}, deaths: deathLedger() })
  return c
}

async function gatherDigging (c) {
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '1' }, c.env)
  assert.ok(await waitFor(() => c.seen.finishDig, 2000), 'control: the gather job digs')
  return () => c.env.jobs.get(job)
}

test('a /mine while a gather job collects is refused busy and the job still gathers its block', async (t) => {
  const c = jobRig(t)
  const job = await gatherDigging(c)
  const plugin = c.bot.collectBlock
  const before = { cage: plugin.movements, legs: c.bot.pathfinder.movements, targets: plugin.targets, listed: [...plugin.targets.targets] }
  const { handle, res } = routeHandler('/mine', c.env)
  assert.notStrictEqual((await timed(handle({ query: { name: 'iron_ore' } }, res), 2000)).out, HUNG, 'the /mine replied')
  assert.strictEqual(res.error && res.error.reason, 'busy')
  assert.match(res.error.message, /gather iron_ore x1/)
  assert.strictEqual(plugin.movements, before.cage)
  assert.strictEqual(c.bot.pathfinder.movements, before.legs)
  assert.strictEqual(plugin.targets, before.targets)
  assert.deepStrictEqual(plugin.targets.targets, before.listed)
  assert.strictEqual(c.seen.digs, 1)
  c.seen.finishDig()
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the drop')
  c.pockets.push({ name: 'raw_iron', count: 1 })
  c.bot.emit('entityGone', c.seen.drops[0])
  assert.ok(await waitFor(() => job().status !== 'running', 2000), 'the job ended')
  assert.strictEqual(job().status, 'done')
  assert.strictEqual(job().result.gathered, 1)
})

test('a gather whose digs land nothing in the pockets gathers zero and fails', async (t) => {
  const c = jobRig(t)
  const job = await gatherDigging(c)
  c.seen.finishDig()
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the drop')
  c.bot.emit('entityGone', c.seen.drops[0])
  assert.ok(await waitFor(() => job().status !== 'running', 2000), 'the job ended')
  const { gathered, dug, ok, reason } = job().result
  assert.deepStrictEqual([gathered, dug, ok], [0, 1, false])
  assert.strictEqual(typeof reason, 'string')
})

test('/stop ends the collect of a gather job at once and frees the collect for the next caller', async (t) => {
  const c = jobRig(t)
  const job = await gatherDigging(c)
  assert.deepStrictEqual(runRoute('/stop', {}, c.env), { stopped: true, jobsCancelled: 1 })
  assert.ok(await waitFor(() => job().status !== 'running', 2000), 'the job ended')
  assert.strictEqual(job().status, 'cancelled')
  const { handle, res } = routeHandler('/mine', c.env)
  handle({ query: { name: 'iron_ore' } }, res)
  assert.ok(await waitFor(() => c.seen.digs === 2, 2000), 'the next /mine digs')
  assert.strictEqual(res.error, undefined)
})

test('a wood gather that replaces a running one keeps its forestry movements until it ends itself', async (t) => {
  const c = jobRig(t)
  c.blocks['1,64,0'] = new Block('oak_log', new Vec3(1, 64, 0))
  const considerateMoves = new Movements()
  const forestryMoves = new Movements()
  Object.assign(c.env.shared, {
    mcData: { blocksArray: [], blocks: { 1: { name: 'oak_log', drops: [900] } }, items: { 900: { name: 'oak_log' } }, itemsByName: { oak_log: {} } },
    considerateMoves,
    forestryMoves,
    thinkTimeout: 10000
  })
  const set = []
  const setMovements = c.bot.pathfinder.setMovements
  c.bot.pathfinder.setMovements = function (m) {
    if (m === forestryMoves || m === considerateMoves) set.push(m)
    setMovements.call(this, m)
  }
  const gather = () => runRoute('/gather', { resource: 'oak_log', amount: '1' }, c.env).job
  const first = gather()
  assert.ok(await waitFor(() => c.seen.digs === 1, 2000), 'control: the first gather digs')
  const second = gather()
  assert.ok(await waitFor(() => c.seen.digs === 2, 2000), 'the second gather digs')
  assert.ok(await waitFor(() => c.env.jobs.get(first).status !== 'running', 2000), 'the first gather ended')
  assert.strictEqual(c.env.jobs.get(first).status, 'cancelled')
  assert.strictEqual(c.env.jobs.get(second).status, 'running', 'control: the second gather still runs')
  assert.strictEqual(set.at(-1), forestryMoves, 'the second gather keeps the forestry movements')
  assert.strictEqual(c.bot.pathfinder.thinkTimeout, 3000, 'the second gather keeps the short planner timeout')
  c.seen.finishDig()
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the drop')
  c.pockets.push({ name: 'oak_log', count: 1 })
  c.bot.emit('entityGone', c.seen.drops[0])
  assert.ok(await waitFor(() => !c.env.jobs.running(), 2000), 'the second gather ended')
  assert.strictEqual(c.env.jobs.get(second).status, 'done')
  assert.strictEqual(set.at(-1), considerateMoves)
  assert.strictEqual(c.bot.pathfinder.thinkTimeout, 10000)
})

const realHoldCollectTool = (bot) => loadBotFunctions(['holdCollectTool'], {
  bot,
  PICK_TIER: botConstant('PICK_TIER'),
  DIG_TOOL: botConstant('DIG_TOOL'),
  LEGACY_HAND_DIG: botConstant('LEGACY_HAND_DIG'),
  LEGACY_1710: false
}).holdCollectTool
const pickBlock = (name, x, harvestable) => Object.assign(new Block(name, new Vec3(x, 64, 0)), {
  digTime: () => 1000,
  material: 'mineable/pickaxe',
  ...(harvestable ? {} : { harvestTools: { 1: true }, canHarvest: () => false })
})

test('mine keeps the count of its digs when a later block has no carried tool that harvests it', async (t) => {
  const c = collector(t, { blocks: { '1,64,0': pickBlock('iron_ore', 1, true) }, reach: () => true })
  const unharvestable = c.blocks['2,64,0'] = pickBlock('iron_ore', 2, false)
  c.env.nearestVisible = () => c.seen.digs ? unharvestable : c.blocks['1,64,0']
  c.env.holdCollectTool = realHoldCollectTool(c.bot)
  const reply = awaitRoute('/mine', { name: 'iron_ore', count: '5' }, c.env)
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the first drop')
  c.pockets.push({ name: 'raw_iron', count: 1 })
  c.bot.emit('entityGone', c.seen.drops[0])
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 5, gathered: 1, reason: 'no carried tool harvests iron_ore' })
  assert.strictEqual(c.seen.digs, 1)
})

test('tidy keeps the scaffold blocks no carried tool harvests queued, tries their name once and says why', async (t) => {
  const c = collector(t, { blocks: { '1,64,0': pickBlock('cobblestone', 1, false), '2,64,0': pickBlock('cobblestone', 2, false) }, reach: () => true })
  c.env.holdCollectTool = realHoldCollectTool(c.bot)
  c.env.seenNow = () => true
  c.env.navPlaced.push({ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 })
  assert.deepStrictEqual(await within(awaitRoute('/tidy', {}, c.env)), { reclaimed: 0, alreadyGone: 0, failed: 1, remaining: 2, reason: 'no carried tool harvests cobblestone' })
  assert.deepStrictEqual(c.env.navPlaced.map((p) => p.x).sort(), [1, 2])
  assert.strictEqual(c.seen.digs, 0)
})

test('tidy reclaims the dirt around cobblestone no carried tool harvests', async (t) => {
  const dirt = (x) => Object.assign(new Block('dirt', new Vec3(x, 64, 0)), { digTime: () => 750, material: 'mineable/shovel' })
  const c = collector(t, { blocks: { '1,64,0': pickBlock('cobblestone', 1, false), '2,64,0': dirt(2), '3,64,0': pickBlock('cobblestone', 3, false), '4,64,0': dirt(4) }, reach: () => true })
  c.env.holdCollectTool = realHoldCollectTool(c.bot)
  c.env.seenNow = () => true
  for (const x of [1, 2, 3, 4]) c.env.navPlaced.push({ x, y: 64, z: 0 })
  const reply = awaitRoute('/tidy', {}, c.env)
  for (const k of [1, 2]) {
    assert.ok(await waitFor(() => c.seen.followed === k, 2000), `control: the body went to dirt drop ${k}`)
    c.bot.emit('entityGone', c.seen.drops[k - 1])
  }
  assert.deepStrictEqual(await within(reply), { reclaimed: 2, alreadyGone: 0, failed: 1, remaining: 2, reason: 'no carried tool harvests cobblestone' })
  assert.deepStrictEqual(c.env.navPlaced.map((p) => p.x).sort(), [1, 3])
  assert.strictEqual(c.seen.digs, 2)
})

const STONE_SILK = (b) => `refusing to dig ${b.name}: the stone_pickaxe with silk touch does not harvest it`
// A holdCollectTool that only does the silk refusal.
const silkEquip = (env) => async (b, silk) => {
  const noSilk = silk && env.silkRefusal(b)
  if (noSilk) throw Object.assign(new Error(noSilk), { name: 'NoSilk', reason: noSilk })
}

test('mine with silk refuses a block the silk touch pick does not harvest before it walks there', async (t) => {
  const goalsSet = []
  const c = collector(t, { blocks: ORE, reach: (g) => { goalsSet.push(g); return true } })
  c.env.silkRefusal = (b) => b ? STONE_SILK(b) : null
  c.env.holdCollectTool = silkEquip(c.env)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', silk: '1' }, c.env))
  assert.deepStrictEqual(reply, { mined: 0, requested: 1, gathered: 0, reason: STONE_SILK(ORE['1,64,0']) })
  assert.strictEqual(goalsSet.length, 0, 'no walk')
})

// The diamond ore is the nearer of the two.
function silkGatherRig (t, refusal) {
  const c = jobRig(t)
  const diamond = new Block('diamond_ore', new Vec3(1, 64, 0))
  const coal = new Block('coal_ore', new Vec3(0, 64, 2))
  Object.assign(c.blocks, { '1,64,0': diamond, '0,64,2': coal })
  c.bot.findBlocks = () => [diamond.position, coal.position]
  // The first non-air block on the ray.
  c.bot.world.raycast = (from, dir, range) => {
    for (let d = 0; d <= range; d += 0.05) {
      const p = from.plus(dir.scaled(d)).floored()
      if (c.blocks[`${p.x},${p.y},${p.z}`]?.type) return { position: p }
    }
    return null
  }
  const walked = []
  const setGoal = c.bot.pathfinder.setGoal
  c.bot.pathfinder.setGoal = function (g) {
    if (g) walked.push(g.pos || new Vec3(g.x, g.y, g.z))
    return setGoal.call(this, g)
  }
  c.env.silkRefusal = refusal
  c.env.holdCollectTool = silkEquip(c.env)
  const toDiamond = () => walked.filter((p) => p.distanceTo(diamond.position) < 1).length
  return { c, toDiamond }
}

test('a gather with silk skips a block the silk touch pick does not harvest before it walks there and digs the next', async (t) => {
  const { c, toDiamond } = silkGatherRig(t, (b) => b && b.name === 'diamond_ore' ? STONE_SILK(b) : null)
  const { job } = runRoute('/gather', { resource: 'ore', amount: '1', silk: '1' }, c.env)
  assert.ok(await waitFor(() => c.seen.finishDig, 2000), 'the gather digs')
  c.seen.finishDig()
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the drop')
  c.pockets.push({ name: 'raw_iron', count: 1 })
  c.bot.emit('entityGone', c.seen.drops[0])
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  assert.strictEqual(c.env.jobs.get(job).result.gathered, 1)
  assert.strictEqual(c.blocks['0,64,2'].name, 'air', 'the coal ore is dug')
  assert.strictEqual(toDiamond(), 0, 'no walk to the diamond ore')
})

test('a gather with silk whose silk touch pick harvests no candidate says so', async (t) => {
  const { c } = silkGatherRig(t, (b) => b ? STONE_SILK(b) : null)
  const { job } = runRoute('/gather', { resource: 'ore', amount: '1', silk: '1' }, c.env)
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  const { gathered, reason } = c.env.jobs.get(job).result
  assert.deepStrictEqual([gathered, reason], [0, STONE_SILK(c.blocks['0,64,2'])])
  assert.strictEqual(c.seen.digs, 0)
})

test('a gather with silk stops before it walks once no silk touch pick is carried', async (t) => {
  let asked = 0
  const { c, toDiamond } = silkGatherRig(t, (b) => asked++ ? `refusing to dig${b ? ` ${b.name}` : ''}: no silk touch pick carried` : null)
  const { job } = runRoute('/gather', { resource: 'ore', amount: '1', silk: '1' }, c.env)
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  const { gathered, reason } = c.env.jobs.get(job).result
  assert.deepStrictEqual([gathered, reason], [0, 'refusing to dig diamond_ore: no silk touch pick carried'])
  assert.strictEqual(toDiamond(), 0, 'no walk to the diamond ore')
  assert.strictEqual(c.seen.digs, 0)
})
