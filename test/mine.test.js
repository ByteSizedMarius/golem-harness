'use strict'
// A collect that makes no progress or runs over its budget ends, and mine and tidy say why.
const test = require('node:test')
const assert = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const gotoGoal = require('mineflayer-pathfinder/lib/goto')
const { goals } = require('mineflayer-pathfinder')
const registry = require('prismarine-registry')('1.21.11')
const PBlock = require('prismarine-block')(registry)
const { CollectBlock } = require('mineflayer-collectblock/lib/CollectBlock')
const { Targets } = require('mineflayer-collectblock/lib/Targets')
const { guardWork } = require('../lib/walk')
const { createJobs } = require('../lib/jobs')
const { deathLedger } = require('../lib/deaths')
const { entityInCell } = require('../lib/shelter')
const { GRAVESTONE } = require('../lib/server-overrides')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { HUNG, awaitRoute, botConstant, claimRescue, fakeClock, loadBotFunctions, routeHandler, runRoute, timed, waitFor } = require('./helpers')

// The collect plugin switches on the class names.
class Block {
  constructor (name, position, type = 1) { Object.assign(this, { name, type, position, shapes: type ? [[0, 0, 0, 1, 1, 1]] : [] }) }
}
let entityIds = 0
class Entity {
  constructor (position, count = 1) { Object.assign(this, { id: ++entityIds, position, isValid: true, count }) }
  getDroppedItem () { return { name: 'raw_iron', count: this.count } }
}

class Movements {
  constructor () { Object.assign(this, { openable: new Set(), exclusionAreasBreak: [] }) }
  getBlock () { return {} }
  safeToBreak () { return true }
}

// A fake pathfinder and dig: reach(goal) settles a walk, drop(block) places a dig's drop, revert(block) answers it with the block, answerTicks delays the answer, chase(drop) settles a drop walk.
function collector (t, { blocks, reach, plan = () => ({ status: 'success', path: [new Vec3(1, 64, 0)] }), drifting = false, holdDig = false, drop: dropAt = (b) => b.position.offset(0.5, 0.5, 0.5), revert = () => false, chase = () => true, answerTicks = 0 }) {
  blocks = { ...blocks }
  const bot = new EventEmitter()
  let x = 0
  bot.entity = { width: 0.6, height: 1.8, get position () { return new Vec3(drifting ? x++ : 0, 64, 0) } }
  bot.blockAt = (p) => blocks[`${p.x},${p.y},${p.z}`] || null
  bot.entities = {}
  bot.on('entityGone', (e) => { delete bot.entities[e.id] })
  const pockets = []
  bot.inventory = { items: () => pockets, emptySlotCount: () => 36 }
  bot.waitForTicks = () => new Promise(setImmediate)
  bot.tool = { equipForBlock: async () => {} }
  bot.heldItem = null
  bot.targetDigBlock = null
  bot.digTime = () => 0
  const seen = { digs: 0, planned: 0, followed: 0, stops: 0, drops: [], chases: [] }
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
    const k = `${b.position.x},${b.position.y},${b.position.z}`
    const air = blocks[k] = new Block('air', b.position, 0)
    bot.emit('diggingCompleted', air)
    const back = revert(b)
    const answer = () => {
      if (back) blocks[k] = b
      bot.emit(`blockUpdate:${b.position}`, air, blocks[k])
    }
    if (!answerTicks) setImmediate(answer)
    else {
      let ticks = 0
      const onTick = () => {
        if (++ticks < answerTicks) return
        bot.removeListener('physicsTick', onTick)
        answer()
      }
      bot.on('physicsTick', onTick)
    }
    const at = back ? null : dropAt(b)
    if (!at) return
    const drop = new Entity(at)
    seen.drops.push(drop)
    bot.entities[drop.id] = drop
    bot.emit('itemDrop', drop)
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
    isMining: () => false,
    stop () { seen.stops++ },
    setGoal (g) {
      this.goal = g
      bot.emit('goal_updated', g)
      if (!g) return
      if (g instanceof goals.GoalFollow) seen.followed++
      const settle = () => {
        if (this.goal !== g) return
        if (this.isMining()) return void setImmediate(settle)
        if (reach(g) && (!(g instanceof goals.GoalFollow) || g.isEnd(new Vec3(g.x, 64, g.z)))) {
          this.goal = null
          bot.emit('goal_reached', g)
        } else {
          seen.planned++
          bot.emit('path_update', plan(g))
        }
      }
      setImmediate(settle)
    }
  }
  bot.collectBlock = Object.assign(Object.create(CollectBlock.prototype), { bot, targets: new Targets(bot), chestLocations: [], itemFilter: () => true, movements: null })
  const clock = fakeClock()
  const digLock = botConstant('digLock')
  // The dig guard bot.js installs at spawn.
  loadBotFunctions(['wireDigGuard'], { bot, digLock }).wireDigGuard()
  bot.emit('spawn')
  const env = {
    bot,
    require,
    goals,
    shared: { mcData: { blocksArray: [], blocks: { 1: { name: 'iron_ore', drops: [903], states: [] } }, items: { 903: { name: 'raw_iron' } }, itemsByName: { raw_iron: {}, iron_ore: {} } } },
    Movements,
    navPlaced: [],
    collectLock: botConstant('collectLock'),
    digLock,
    LEGACY_DIG_CONFIRM_MS: botConstant('LEGACY_DIG_CONFIRM_MS'),
    digScope: new AsyncLocalStorage(),
    walkRoute: () => ({ end () {} }),
    routeEnd: () => null,
    legs: legLedger(),
    takenText,
    bunker: {},
    stagedGoto: async ({ drop }) => {
      seen.chases.push(drop)
      if (!chase(drop)) return { arrived: false, reason: 'no-path' }
      pockets.push({ name: drop.getDroppedItem().name, count: 1 })
      bot.emit('playerCollect', bot.entity, drop)
      setImmediate(() => bot.emit('entityGone', drop))
      return { arrived: true, reason: null }
    },
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    guardWork: (work, o) => guardWork(work, { ...o, clock }),
    watchScope: new AsyncLocalStorage(),
    Vec3,
    ck: (x, y, z) => x + ',' + y + ',' + z,
    cellKnown: () => true,
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    console: { log: () => {} },
    resolveBlockIds: () => [1],
    nearestVisible: () => blocks['1,64,0'],
    leafInTheWay: () => null,
    holdCollectTool: async () => {},
    reflexes: [{ name: 'unstuck', active: false }],
    litFuse: () => null
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

test('mine counts the dug block and returns with stalled when its drop is never picked up, lists that drop, and the next collect starts afresh', async (t) => {
  const c = collector(t, { blocks: ORE, reach: () => true, chase: () => false })
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
    assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 0, reason: 'stalled', unreached: [{ item: 'raw_iron', count: 1, pos: { x: 1.5, y: 64.5, z: 0.5 } }] })
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

// The walk to each of the first out drops ends in a plan with status, and later drops are picked up on arrival.
function unreachedRig (t, { status = 'noPath', out = 1, ores = 2, rig = collector, ...opts } = {}) {
  const blocks = {}
  for (let x = 1; x <= ores; x++) blocks[`${x},64,0`] = new Block('iron_ore', new Vec3(x, 64, 0))
  const lost = (g) => g instanceof goals.GoalFollow && c.seen.drops.indexOf(g.entity) < out
  const c = rig(t, { blocks, reach: (g) => !lost(g), plan: () => ({ status, path: [new Vec3(1, 64, 0)] }), ...opts })
  c.bot.on('goal_reached', (g) => {
    if (!(g instanceof goals.GoalFollow)) return
    c.pockets.push({ name: 'raw_iron', count: 1 })
    setImmediate(() => c.bot.emit('entityGone', g.entity))
  })
  c.env.nearestVisible = () => Object.values(c.blocks).find((b) => b.type) || null
  return c
}

test('mine counts a dug block whose drop walk finds no path or no plan in time, walks to that drop once after the next dig, lists it and mines on', async (t) => {
  for (const status of ['noPath', 'timeout']) {
    const c = unreachedRig(t, { status, chase: () => false })
    const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
    assert.deepStrictEqual(reply, { mined: 2, requested: 2, gathered: 1, reason: null, unreached: [{ item: 'raw_iron', count: 1, pos: { x: 1.5, y: 64.5, z: 0.5 } }] }, status)
    assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]], status)
    assert.strictEqual(c.bot.pathfinder.goal, null, status)
  }
})

test('mine stops after two drops in a row whose walks fail again after a later dig, naming both, and leaves no walk to them', async (t) => {
  const c = unreachedRig(t, { out: 4, ores: 4, chase: () => false })
  const { reason, ...counts } = await within(awaitRoute('/mine', { name: 'iron_ore', count: '4' }, c.env))
  const at = (x) => ({ item: 'raw_iron', count: 1, pos: { x, y: 64.5, z: 0.5 } })
  assert.deepStrictEqual(counts, { mined: 3, requested: 4, gathered: 0, unreached: [at(1.5), at(2.5), at(3.5)] })
  assert.strictEqual(reason, 'two drops in a row out of reach: raw_iron at 1.5,64.5,0.5 and raw_iron at 2.5,64.5,0.5')
  const [a, b] = c.seen.drops
  assert.deepStrictEqual(c.seen.chases, [a, a, b])
  assert.strictEqual(c.seen.digs, 3)
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('mine walks again to a drop collectblock could not reach once its next dig is confirmed, picks it up and digs all 3', async (t) => {
  // The first drop lies under the second ore with no head room until that ore is dug.
  const c = unreachedRig(t, { out: 1, ores: 3, chase: () => !c.blocks['2,64,0'].type })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '3' }, c.env))
  assert.deepStrictEqual(reply, { mined: 3, requested: 3, gathered: 3, reason: null })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
})

test('mine does not stop for two drops in a row collectblock could not reach once both are picked up after the next digs', async (t) => {
  // Each drop lies under the next ore with no head room until that ore is dug, as a log's drop lies under the next log.
  const c = unreachedRig(t, { out: 2, ores: 3, chase: (d) => !c.blocks[`${Math.floor(d.position.x) + 1},64,0`].type })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '3' }, c.env))
  assert.deepStrictEqual(reply, { mined: 3, requested: 3, gathered: 3, reason: null })
  assert.deepStrictEqual(c.seen.chases, c.seen.drops.slice(0, 2))
})

test('mine lists an unreached drop where it lies at the reply, not where it was when its walk failed', async (t) => {
  const c = unreachedRig(t, { chase: () => false })
  // The first drop lands while the second block is dug.
  c.bot.on('itemDrop', (d) => { if (d === c.seen.drops[1]) c.seen.drops[0].position = new Vec3(1.5, 63.97, 0.5) })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.deepStrictEqual(reply, { mined: 2, requested: 2, gathered: 1, reason: null, unreached: [{ item: 'raw_iron', count: 1, pos: { x: 1.5, y: 63.97, z: 0.5 } }] })
})

test('mine leaves out an unreached drop that is gone by the reply', async (t) => {
  const c = unreachedRig(t)
  c.bot.on('itemDrop', (d) => { if (d === c.seen.drops[1]) c.bot.emit('entityGone', c.seen.drops[0]) })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.deepStrictEqual(reply, { mined: 2, requested: 2, gathered: 1, reason: null })
})

test('mine lists the unreached drop of a dug block after the pathfinder dropped every dig listener', async (t) => {
  const c = unreachedRig(t, { ores: 1 })
  // The pathfinder's resetPath during one of its own digs removes every diggingCompleted listener.
  c.bot.on('goal_updated', (g) => { if (g instanceof goals.GoalLookAtBlock) c.bot.removeAllListeners('diggingCompleted') })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 0, reason: null, unreached: [{ item: 'raw_iron', count: 1, pos: { x: 1.5, y: 64.5, z: 0.5 } }] })
})

// Digs block on the next tick as the pathfinder does, with isMining set from the call until the dig ends.
function pathfinderDig (c, block) {
  c.bot.pathfinder.isMining = () => true
  c.bot.once('physicsTick', () => {
    c.bot.dig(block).finally(() => { c.bot.pathfinder.isMining = () => false })
  })
}

// The first collect walk digs the ore at cell as the pathfinder does. Returns a getter for the count of collect walks.
function cageDig (c, cell = '2,64,0') {
  let walks = 0
  c.bot.on('goal_updated', (g) => {
    if (!(g instanceof goals.GoalLookAtBlock) || walks++) return
    pathfinderDig(c, c.blocks[cell])
  })
  return () => walks
}

// Runs the route's clock on c's physics ticks, 50 ms a tick.
function tickTime (c) {
  const clock = { now: 0 }
  c.bot.on('physicsTick', () => { clock.now += 50 })
  c.env.Date = { now: () => clock.now }
  return clock
}

// A 1.7.10 drop spot 0.6 from the cell centre, out of collectblock's 0.5.
const OFF_CENTRE = (b) => b.position.offset(0.85, 0.15, 0.85)

test('mine counts the ore the collect walk digs on its way and digs no more than asked', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 3 })
  const walks = cageDig(c)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '3' }, c.env))
  assert.deepStrictEqual(reply, { mined: 3, requested: 3, gathered: 3, reason: null })
  assert.deepStrictEqual([c.seen.digs, walks()], [3, 2])
})

test('mine stops at the count when the collect walk digs an ore on its way', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 3 })
  cageDig(c)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.deepStrictEqual(reply, { mined: 2, requested: 2, gathered: 2, reason: null })
  assert.strictEqual(c.seen.digs, 2)
  assert.strictEqual(c.blocks['3,64,0'].name, 'iron_ore')
})

test('mine walks to a drop of its dig that came to rest off the cell centre and picks it up', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1, drop: OFF_CENTRE })
  // The drop settles 0.27 into the floor cell.
  c.bot.once('itemDrop', (d) => setImmediate(() => { d.position = new Vec3(1.85, 63.73, 0.85) }))
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
})

test('mine leaves out of unreached a drop the server says was picked up while it still lies in the entity list', async (t) => {
  const c = unreachedRig(t, { ores: 1 })
  // The collect packet and the slot update come as the walk to the drop fails, and the entity goes after the reply.
  c.bot.on('goal_updated', (g) => {
    if (!(g instanceof goals.GoalFollow)) return
    c.pockets.push({ name: 'raw_iron', count: 1 })
    c.bot.emit('playerCollect', c.bot.entity, g.entity)
  })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.ok(c.bot.entities[c.seen.drops[0].id], 'control: the drop still lies in the entity list at the reply')
  c.bot.emit('entityGone', c.seen.drops[0])
})

test('mine walks to a drop its walk cannot reach once after each later dig, mines on and lists it at the end', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 3, drop: (b) => b.position.x === 1 ? OFF_CENTRE(b) : b.position.offset(0.5, 0.5, 0.5), chase: () => false })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '3' }, c.env))
  assert.deepStrictEqual(reply, { mined: 3, requested: 3, gathered: 2, reason: null, unreached: [{ item: 'raw_iron', count: 1, pos: { x: 1.85, y: 64.15, z: 0.85 } }] })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0], c.seen.drops[0], c.seen.drops[0]])
})

test('mine walks to the drop of its own dig and not to a drop that lands in the next cell', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1, drop: OFF_CENTRE })
  // A co-player's drop spawns 0.15 into the cell east of the dug one.
  const other = new Entity(new Vec3(2.15, 64.5, 0.5))
  c.bot.once('itemDrop', () => {
    c.bot.entities[other.id] = other
    c.bot.emit('itemDrop', other)
  })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
  assert.ok(c.bot.entities[other.id], 'control: the other drop still lies there')
})

test('mine does not count a dig the server answers with the block back', async (t) => {
  // The answer comes after collectblock's 10-tick wait for drops.
  const c = unreachedRig(t, { out: 0, ores: 1, revert: () => true, answerTicks: 12 })
  tickTime(c)
  c.blocks['1,64,0'].digTime = () => 0
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 0, requested: 1, gathered: 0, reason: null })
  assert.strictEqual(c.seen.digs, 1)
})

// The server answers the dig at 1,64,0 with the ore, and with breaks set breaks it breaks ms later.
function resentRig (t, { breaks = null, toolMs = 0, handMs = toolMs, rig = unreachedRig } = {}) {
  const c = rig(t, { out: 0, ores: 1, revert: () => true })
  const clock = tickTime(c)
  c.bot.digTime = () => toolMs
  c.blocks['1,64,0'].digTime = () => handMs
  c.bot.once(`blockUpdate:${new Vec3(1, 64, 0)}`, () => {
    if (breaks === null) return
    const at = clock.now + breaks
    const onTick = () => {
      if (clock.now < at) return
      c.bot.removeListener('physicsTick', onTick)
      const ore = c.blocks['1,64,0']
      const air = c.blocks['1,64,0'] = new Block('air', ore.position, 0)
      c.bot.emit(`blockUpdate:${ore.position}`, ore, air)
      const drop = new Entity(ore.position.offset(0.5, 0.5, 0.5))
      c.seen.drops.push(drop)
      c.bot.entities[drop.id] = drop
      c.bot.emit('itemDrop', drop)
    }
    c.bot.on('physicsTick', onTick)
  })
  return { c, clock }
}

test('mine walks to the drop of a dig the server first answered with the block and broke over 1000 ms later', async (t) => {
  const { c } = resentRig(t, { breaks: 1250 })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
})

test('mine waits for the break of a dig the server answered with the block no longer than the held tool takes to dig it', async (t) => {
  const { c, clock } = resentRig(t, { toolMs: 2000, handMs: 250000 })
  let dugAt = null
  c.bot.once('ownDigStart', () => { dugAt = clock.now })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 0, requested: 1, gathered: 0, reason: null })
  assert.ok(clock.now - dugAt <= 2000 + botConstant('LEGACY_DIG_CONFIRM_MS') + 500, `replied ${clock.now - dugAt} ms after the dig began`)
})

test('/stop ends the wait of a mine for the break of a dig the server answered with the block', async (t) => {
  const { c, clock } = resentRig(t, { toolMs: 250000, rig: (t, o) => unreachedRig(t, { ...o, rig: jobRig }) })
  // The stop comes on the first tick after the collect returned.
  let stoppedAt = null
  const { collectSafely } = loadBotFunctions(['collectSafely'], c.env)
  c.env.collectSafely = async (...a) => {
    const r = await collectSafely(...a)
    c.bot.once('physicsTick', () => {
      stoppedAt = clock.now
      runRoute('/stop', {}, c.env)
    })
    return r
  }
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.strictEqual(reply.reason, 'stopped')
  assert.ok(stoppedAt !== null && clock.now - stoppedAt <= 200, `replied ${clock.now - stoppedAt} ms after the stop`)
})

test('mine walks to a drop that spawns after the collect returned on its last pass', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1, drop: () => null })
  const { collectSafely } = loadBotFunctions(['collectSafely'], c.env)
  c.env.collectSafely = async (...a) => {
    const r = await collectSafely(...a)
    // The drop spawns on the next tick in the dug cell.
    c.bot.once('physicsTick', () => {
      const drop = new Entity(new Vec3(1.5, 64.5, 0.5))
      c.seen.drops.push(drop)
      c.bot.entities[drop.id] = drop
      c.bot.emit('itemDrop', drop)
    })
    return r
  }
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
})

test('mine does not count a direct dig of a block of its kind during its collect walk', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2 })
  // Another route digs the ore at 2,64,0 from a tick, not through the pathfinder.
  const onGoal = (g) => {
    if (!(g instanceof goals.GoalLookAtBlock)) return
    c.bot.removeListener('goal_updated', onGoal)
    c.bot.once('physicsTick', () => { c.bot.dig(c.blocks['2,64,0']) })
  }
  c.bot.on('goal_updated', onGoal)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.strictEqual(c.blocks['2,64,0'].name, 'air', 'control: the other dig took the ore')
  assert.deepStrictEqual(c.seen.chases, [])
})

test('a dig ledger does not count a pathfinder dig whose goal was set outside its run', async (t) => {
  const counted = async (outside) => {
    const c = collector(t, { blocks: { '1,64,0': new Block('iron_ore', new Vec3(1, 64, 0)), '2,64,0': new Block('iron_ore', new Vec3(2, 64, 0)) }, reach: () => false })
    const ledger = loadBotFunctions(['digLedger'], c.env).digLedger([1])
    t.after(() => ledger.stop())
    let release
    const work = ledger.run(() => {
      c.bot.pathfinder.setGoal(new goals.GoalLookAtBlock(new Vec3(1, 64, 0), c.bot.world))
      return new Promise((resolve) => { release = resolve })
    })
    if (outside) c.bot.once('physicsTick', () => c.bot.pathfinder.setGoal(new goals.GoalNear(5, 64, 0, 1)))
    await new Promise(setImmediate)
    pathfinderDig(c, c.blocks['2,64,0'])
    assert.ok(await waitFor(() => c.blocks['2,64,0'].name === 'air', 2000), 'control: the pathfinder dug')
    await ledger.settled()
    release()
    await work
    return ledger.mined()
  }
  assert.strictEqual(await counted(false), 1, 'control: a dig under the run\'s own goal counts')
  assert.strictEqual(await counted(true), 0)
})

test('mine walks to no further drop after a /stop during the pickup wait of a drop that still gets picked up', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2, drop: OFF_CENTRE, rig: jobRig })
  cageDig(c)
  // The walk arrives, a /stop comes during the wait, and the drop is picked up after it.
  c.env.stagedGoto = async ({ drop }) => {
    c.seen.chases.push(drop)
    c.bot.once('physicsTick', () => {
      runRoute('/stop', {}, c.env)
      c.pockets.push({ name: 'raw_iron', count: 1 })
      c.bot.emit('playerCollect', c.bot.entity, drop)
      c.bot.emit('entityGone', drop)
    })
    return { arrived: true, reason: null }
  }
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.strictEqual(reply.reason, 'stopped')
  assert.strictEqual(c.seen.drops.length, 2, 'control: two drops lay')
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
})

test('mine lists a drop of its dig that lies beyond the radius from the start', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1, drop: OFF_CENTRE })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', radius: '1' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 0, reason: null, unreached: [{ item: 'raw_iron', count: 1, pos: { x: 1.85, y: 64.15, z: 0.85 } }] })
  assert.deepStrictEqual(c.seen.chases, [])
})

test('mine ends on the fuse with its count and lists the drop whose walk a lit fuse refused', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1, drop: OFF_CENTRE })
  c.env.stagedGoto = async ({ drop }) => {
    c.seen.chases.push(drop)
    throw Object.assign(new Error('refused: a creeper swells E ~4 and this walk closes on it, the guard stays up. Walk away from it, or walk again once the fuse is out.'), { reason: 'fuse' })
  }
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 0, reason: 'fuse', unreached: [{ item: 'raw_iron', count: 1, pos: { x: 1.85, y: 64.15, z: 0.85 } }] })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0], c.seen.drops[0]])
})

test('mine lists a drop whose collect packet came and that still lies 6 ticks later', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1, drop: OFF_CENTRE })
  tickTime(c)
  // A partial pickup: the collect packet and a slot update come, and the entity stays with the rest.
  c.env.stagedGoto = async ({ drop }) => {
    c.seen.chases.push(drop)
    c.pockets.push({ name: 'raw_iron', count: 1 })
    c.bot.emit('playerCollect', c.bot.entity, drop)
    return { arrived: true, reason: null }
  }
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply.unreached, [{ item: 'raw_iron', count: 1, pos: { x: 1.85, y: 64.15, z: 0.85 } }])
  assert.ok(c.bot.entities[c.seen.drops[0].id], 'control: the drop still lies at the reply')
})

test('mine walks again to a drop it could not reach once its next dig is confirmed, counts no miss for it and digs all 3', async (t) => {
  // Each drop lies under the next ore with no head room until that ore is dug, as a log's drop lies under the next log.
  const c = unreachedRig(t, { out: 0, ores: 3, drop: OFF_CENTRE, chase: (d) => !c.blocks[`${Math.floor(d.position.x) + 1},64,0`]?.type })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '3' }, c.env))
  assert.deepStrictEqual(reply, { mined: 3, requested: 3, gathered: 3, reason: null })
  const [a, b, d] = c.seen.drops
  assert.deepStrictEqual(c.seen.chases, [a, a, b, b, d])
})

test('mine lists a drop that took in another of its drops with the merged count, and not the drop that went without a pickup', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2, drop: OFF_CENTRE })
  // The server merges the first drop into the second, with no collect packet.
  c.bot.on('itemDrop', (d) => {
    if (d !== c.seen.drops[1]) return
    d.count = 2
    c.bot.emit('entityGone', c.seen.drops[0])
  })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2', radius: '1' }, c.env))
  assert.deepStrictEqual(reply, { mined: 2, requested: 2, gathered: 0, reason: null, unreached: [{ item: 'raw_iron', count: 2, pos: { x: 2.85, y: 64.15, z: 0.85 } }] })
})

// The first collect walk of c takes the legs for reflex.
function takeOnCollect (c, reflex, why) {
  const take = (g) => {
    if (!(g instanceof goals.GoalLookAtBlock)) return
    c.bot.removeListener('goal_updated', take)
    c.env.legs.take(reflex, why)
  }
  c.bot.on('goal_updated', take)
}

test('mine carries on to its count after the unstuck reflex took the legs during a collect', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2 })
  takeOnCollect(c, 'unstuck', 'free the body from a wedge')
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.deepStrictEqual(reply, { mined: 2, requested: 2, gathered: 2, reason: null })
})

test('mine stops when another reflex took the legs during a collect and names it', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2 })
  takeOnCollect(c, 'combat', 'fight the zombie')
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 2, gathered: 1, reason: 'stopped', takenBy: 'the combat reflex took the legs to fight the zombie' })
})

test('mine counts the ore the collect walk digs on its way after the unstuck reflex set the walk\'s goal again', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 3 })
  let walks = 0
  c.bot.on('goal_updated', (g) => {
    if (!(g instanceof goals.GoalLookAtBlock) || walks++) return
    // The unstuck ladder sets the same goal again from a tick, and the walk then digs through the cage.
    c.bot.once('physicsTick', () => c.bot.pathfinder.setGoal(g))
    pathfinderDig(c, c.blocks['2,64,0'])
  })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '3' }, c.env))
  assert.deepStrictEqual(reply, { mined: 3, requested: 3, gathered: 3, reason: null })
  assert.strictEqual(c.seen.digs, 3)
})

test('mine counts an ore its own walk to the block digs on the way and stops at the count', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2 })
  // Open sky over the first ore sends mine on its own walk before the collect.
  Object.assign(c.blocks, { '1,65,0': air(1, 65, 0), '1,66,0': air(1, 66, 0) })
  cageDig(c)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.deepStrictEqual(reply, { mined: 2, requested: 2, gathered: 2, reason: null })
  assert.strictEqual(c.seen.digs, 2)
})

test('mine lists a drop that sank into water 2 deep and does not walk to it', async (t) => {
  const water = (y) => new Block('water', new Vec3(1, y, 0), 0)
  const c = unreachedRig(t, { out: 0, ores: 1, drop: OFF_CENTRE })
  Object.assign(c.blocks, { '1,63,0': water(63), '1,62,0': water(62) })
  c.bot.once('itemDrop', (d) => setImmediate(() => { d.position = new Vec3(1.85, 62.3, 0.85) }))
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 0, reason: null, unreached: [{ item: 'raw_iron', count: 1, pos: { x: 1.85, y: 62.3, z: 0.85 } }] })
  assert.deepStrictEqual(c.seen.chases, [])
})

test('mine counts a dig the server answers after its collect threw, and walks to its drop', async (t) => {
  // The answer comes after collectblock's 10-tick wait for drops.
  const c = unreachedRig(t, { out: 0, ores: 1, drop: OFF_CENTRE, answerTicks: 12 })
  const { collectSafely } = loadBotFunctions(['collectSafely'], c.env)
  c.env.collectSafely = async (...a) => {
    await collectSafely(...a)
    throw Object.assign(new Error('stalled, no progress for 4.5 s'), { reason: 'stalled' })
  }
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: 'stalled' })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
})

test('a gather walks again to a drop whose walk the unstuck reflex ended and gathers on', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2, drop: OFF_CENTRE, rig: jobRig })
  const left = () => Object.values(c.blocks).filter((b) => b.type)
  c.bot.findBlocks = () => left().map((b) => b.position)
  c.bot.world = { raycast: () => ({ position: left()[0]?.position }) }
  // A walk route ends once the legs were taken since it began.
  Object.assign(c.env, { walkRoute: () => ({ mark: c.env.legs.mark(), end () {} }), routeEnd: (route) => c.env.legs.mark() !== route.mark ? 'stopped' : null })
  const stagedGoto = c.env.stagedGoto
  c.env.stagedGoto = async (goal, route) => {
    if (c.seen.chases.length) return stagedGoto(goal, route)
    c.seen.chases.push(goal.drop)
    c.env.legs.take('unstuck', 'free the body from a wedge')
    return { arrived: false, reason: 'stopped' }
  }
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '2' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 2, dug: 2, requested: 2, inventoryMatching: 2 })
  const [a, b] = c.seen.drops
  assert.deepStrictEqual(c.seen.chases, [a, a, b])
})

test('mine with no path to the block it would dig replies with the NoPath error and digs nothing', async (t) => {
  const c = collector(t, { blocks: ORE, reach: () => false, plan: () => ({ status: 'noPath', path: [new Vec3(0, 64, 0)] }) })
  const { handle, res } = routeHandler('/mine', c.env)
  assert.notStrictEqual(await within(handle({ query: { name: 'iron_ore' } }, res)), HUNG, 'the /mine replied')
  assert.strictEqual(res.error && res.error.name, 'NoPath')
  assert.strictEqual(c.seen.digs, 0)
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('a goto through the watch clears its own goal when it finds no path or no plan in time', async (t) => {
  for (const [status, name] of [['noPath', 'NoPath'], ['timeout', 'Timeout']]) {
    const c = collector(t, { blocks: ORE, reach: () => false, plan: () => ({ status, path: [new Vec3(0, 64, 0)] }) })
    await assert.rejects(c.bot.pathfinder.goto(new goals.GoalBlock(5, 64, 0)), { name })
    assert.strictEqual(c.bot.pathfinder.goal, null, status)
  }
})

test('a goto through the watch that finds no path leaves the goal another caller set before it rejected', async (t) => {
  const c = collector(t, { blocks: ORE, reach: () => false, plan: () => ({ status: 'noPath', path: [new Vec3(0, 64, 0)] }) })
  const other = new goals.GoalBlock(9, 64, 0)
  const walk = c.bot.pathfinder.goto(new goals.GoalBlock(5, 64, 0))
  c.bot.once('path_update', () => c.bot.pathfinder.setGoal(other))
  await assert.rejects(walk, { name: 'NoPath' })
  assert.strictEqual(c.bot.pathfinder.goal, other)
})

test('a goto through the watch that the goal change ends leaves its own goal set again by another caller', async (t) => {
  const c = collector(t, { blocks: ORE, reach: () => false })
  const goal = new goals.GoalBlock(5, 64, 0)
  const walk = c.bot.pathfinder.goto(goal)
  // The unstuck ladder stops the walk and sets the same goal again.
  setImmediate(() => {
    c.bot.pathfinder.setGoal(null)
    c.bot.pathfinder.setGoal(goal)
  })
  await assert.rejects(walk, { name: 'GoalChanged' })
  assert.strictEqual(c.bot.pathfinder.goal, goal)
})

test('mine clears the goal of a collect walk that ended on an empty path', async (t) => {
  const c = collector(t, { blocks: ORE, reach: () => false, plan: () => ({ status: 'noPath', path: [] }), drop: () => null })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 0, reason: null })
  assert.strictEqual(c.seen.digs, 1)
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

// The unstuck ladder on the first takes walks to a goal of kind: on the next turn it takes the legs and stops the walk,
// stays active for ticks physics ticks, calls during(i) on each and sets the walk's goal again before it ends, as
// replanWatch does. Counts the walks to goals of kind and those set while it was active, its own set left out.
function unstuckLadder (c, kind, { takes = 1, ticks = 3, during = () => {} } = {}) {
  const unstuck = c.env.reflexes.find((r) => r.name === 'unstuck')
  const seen = { walks: 0, whileActive: 0 }
  let replan = false
  c.bot.on('goal_updated', (g) => {
    if (replan || !(g instanceof kind)) return
    seen.walks++
    if (unstuck.active) seen.whileActive++
    if (seen.walks > takes) return
    setImmediate(async () => {
      unstuck.active = true
      c.env.legs.take('unstuck', 'free the body from a wedge')
      c.bot.pathfinder.setGoal(null)
      for (let i = 0; i < ticks; i++) {
        await new Promise((resolve) => c.bot.once('physicsTick', resolve))
        during(i)
      }
      replan = true
      c.bot.pathfinder.setGoal(g)
      replan = false
      unstuck.active = false
    })
  })
  return seen
}

const COMBAT_TAKEN = 'the combat reflex took the legs to fight the zombie'

test('mine digs the block after the unstuck reflex stopped its collect walk, walking again only once the reflex ended', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2 })
  const ladder = unstuckLadder(c, goals.GoalLookAtBlock, { ticks: 6 })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.deepStrictEqual(reply, { mined: 2, requested: 2, gathered: 2, reason: null })
  assert.deepStrictEqual([c.seen.digs, ladder.walks, ladder.whileActive], [2, 3, 0])
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('mine digs the block after an unstuck rescue of its collect walk that outlasts the stall watch', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1 })
  const ladder = unstuckLadder(c, goals.GoalLookAtBlock, { ticks: 6, during: (i) => { if (i === 2) c.clock.advance(botConstant('COLLECT_STALL_MS') + 500) } })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual([c.seen.digs, ladder.walks], [1, 2])
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('mine walks to the block only once the unstuck reflex freeing the body from an earlier walk ended, and digs it', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1 })
  const unstuck = c.env.reflexes.find((r) => r.name === 'unstuck')
  // The ladder stops a walk to the block set while it runs.
  let whileActive = 0
  c.bot.on('goal_updated', (g) => {
    if (!(g instanceof goals.GoalLookAtBlock) || !unstuck.active) return
    whileActive++
    setImmediate(() => c.bot.pathfinder.setGoal(null))
  })
  const { collectSafely } = loadBotFunctions(['collectSafely'], c.env)
  c.env.collectSafely = (...a) => {
    // The ladder of a walk before the collect runs 6 more ticks and then sets that walk's goal again.
    unstuck.active = true
    c.env.legs.take('unstuck', 'free the body from a wedge')
    ;(async () => {
      for (let i = 0; i < 6; i++) await new Promise((resolve) => c.bot.once('physicsTick', resolve))
      c.bot.pathfinder.setGoal(new goals.GoalBlock(0, 64, 3))
      unstuck.active = false
    })()
    return collectSafely(...a)
  }
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual([c.seen.digs, whileActive], [1, 0])
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('mine digs the block after the unstuck reflex stopped its own walk to the block', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1 })
  // Open sky over the ore sends mine on its own walk before the collect.
  Object.assign(c.blocks, { '1,65,0': air(1, 65, 0), '1,66,0': air(1, 66, 0) })
  const ladder = unstuckLadder(c, goals.GoalLookAtBlock)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual([c.seen.digs, ladder.whileActive], [1, 0])
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('mine stops when another reflex takes the legs while the unstuck reflex frees the body, names it and walks no more', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2 })
  const ladder = unstuckLadder(c, goals.GoalLookAtBlock, { during: (i) => { if (i === 1) c.env.legs.take('combat', 'fight the zombie') } })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.deepStrictEqual(reply, { mined: 0, requested: 2, gathered: 0, reason: 'stopped', takenBy: COMBAT_TAKEN })
  assert.deepStrictEqual([c.seen.digs, ladder.walks], [0, 1])
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('/stop while the unstuck reflex frees the body during a mine collect stops the mine and walks no more', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2, rig: jobRig })
  const ladder = unstuckLadder(c, goals.GoalLookAtBlock, { during: (i) => { if (i === 1) runRoute('/stop', {}, c.env) } })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '2' }, c.env))
  assert.deepStrictEqual(reply, { mined: 0, requested: 2, gathered: 0, reason: 'stopped' })
  assert.deepStrictEqual([c.seen.digs, ladder.walks], [0, 1])
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('mine does not walk back to the dug block after the unstuck reflex stopped the walk to its drop', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1 })
  let blockWalks = 0
  c.bot.on('goal_updated', (g) => { if (g instanceof goals.GoalLookAtBlock) blockWalks++ })
  unstuckLadder(c, goals.GoalFollow)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  // The walk to the drop the ladder set again picks it up.
  assert.deepStrictEqual(c.seen.chases, [])
  assert.strictEqual(blockWalks, 1)
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('mine stops as stalled, naming the unstuck reflex, after that reflex stopped its collect walk 4 times', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1 })
  const ladder = unstuckLadder(c, goals.GoalLookAtBlock, { takes: 4 })
  const { collectSafely } = loadBotFunctions(['collectSafely'], c.env)
  let thrown = null
  c.env.collectSafely = (...a) => collectSafely(...a).catch((e) => {
    thrown = e
    throw e
  })
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore' }, c.env))
  assert.deepStrictEqual(reply, { mined: 0, requested: 1, gathered: 0, reason: 'stalled' })
  assert.strictEqual(thrown.message, 'the unstuck reflex took the legs to free the body from a wedge')
  assert.deepStrictEqual([c.seen.digs, ladder.walks], [0, 4])
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('tidy reclaims a scaffold block whose collect walk the unstuck reflex stopped and counts no failure', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 1 })
  c.blocks['1,64,0'] = new Block('cobblestone', new Vec3(1, 64, 0))
  c.env.seenNow = () => true
  c.env.navPlaced.push({ x: 1, y: 64, z: 0 })
  unstuckLadder(c, goals.GoalLookAtBlock)
  assert.deepStrictEqual(await within(awaitRoute('/tidy', {}, c.env)), { reclaimed: 1, alreadyGone: 0, failed: 0, remaining: 0, reason: null })
  assert.strictEqual(c.seen.digs, 1)
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

// A gather rig over unreachedRig with opts whose search finds the ores still standing.
function gatherOres (t, ores, opts = {}) {
  const c = unreachedRig(t, { out: 0, ores, rig: jobRig, ...opts })
  const left = () => Object.values(c.blocks).filter((b) => b.type)
  c.bot.findBlocks = () => left().map((b) => b.position)
  c.bot.world = { raycast: () => ({ position: left()[0]?.position }) }
  c.bot.pathfinder.startCell = (p) => p.floored()
  return c
}

test('a gather digs the block after the unstuck reflex stopped its walk to the block', async (t) => {
  const c = gatherOres(t, 1)
  const ladder = unstuckLadder(c, goals.GoalNear)
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '1' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1 })
  assert.deepStrictEqual([ladder.walks, ladder.whileActive], [2, 0])
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('a gather starts its collect with no walk left after the unstuck reflex stopped its walk to a block out of the world for a while', async (t) => {
  // The walk the ladder sets again goes on while the ore's cell is out of the world.
  const c = gatherOres(t, 1, { status: 'success', reach: (g) => !(g instanceof goals.GoalNear) || !!c.blocks['1,64,0'] })
  c.bot.world = { raycast: () => ({ position: new Vec3(1, 64, 0) }) }
  const ore = c.blocks['1,64,0']
  unstuckLadder(c, goals.GoalNear, { during: (i) => { if (i === 0) delete c.blocks['1,64,0'] } })
  const { collectSafely } = loadBotFunctions(['collectSafely'], c.env)
  let atCollect
  c.env.collectSafely = (...a) => {
    atCollect = c.bot.pathfinder.goal
    // The cell comes back with its chunk.
    c.blocks['1,64,0'] = ore
    return collectSafely(...a)
  }
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '1' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1 })
  assert.strictEqual(atCollect, null)
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

test('a gather is cancelled for another reflex taking the legs while the unstuck reflex frees the body, and digs no block', async (t) => {
  const c = gatherOres(t, 2)
  const { takeLegs } = loadBotFunctions(['takeLegs'], c.env)
  const ladder = unstuckLadder(c, goals.GoalNear, { during: (i) => { if (i === 1) takeLegs('combat', 'fight the zombie') } })
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '2' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 0, dug: 0, requested: 2, inventoryMatching: 0, ok: false, reason: 'cancelled' })
  assert.deepStrictEqual(c.env.jobs.list().find((j) => j.id === job), { id: job, name: 'gather iron_ore x2', status: 'cancelled', note: 'cancelled', cancelled: true, takenBy: COMBAT_TAKEN })
  assert.deepStrictEqual([c.seen.digs, ladder.walks], [0, 1])
  assert.strictEqual(c.bot.pathfinder.goal, null)
})

const air = (x, y, z) => Object.assign(new Block('air', new Vec3(x, y, z), 0), { boundingBox: 'empty' })

// The cells of the blocks c's route hands to collectSafely, in order.
function collectCells (c) {
  const { collectSafely } = loadBotFunctions(['collectSafely'], c.env)
  const cells = []
  c.env.collectSafely = (b, ...a) => {
    cells.push(`${b.position.x},${b.position.y},${b.position.z}`)
    return collectSafely(b, ...a)
  }
  return cells
}

test('mine takes the next block when the block changes during its own walk to it, and runs no collect on it', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2 })
  // Open sky over the first ore sends mine on its own walk before the collect.
  Object.assign(c.blocks, { '1,65,0': air(1, 65, 0), '1,66,0': air(1, 66, 0) })
  // Another player digs the first ore as the walk to it starts.
  const onGoal = (g) => {
    if (!(g instanceof goals.GoalLookAtBlock)) return
    c.bot.removeListener('goal_updated', onGoal)
    c.blocks['1,64,0'] = air(1, 64, 0)
  }
  c.bot.on('goal_updated', onGoal)
  const collects = collectCells(c)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '1' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual(collects, ['2,64,0'])
  assert.strictEqual(c.seen.digs, 1)
})

test('mine takes the next block when the block changes during collectblock\'s walk to it, and counts that collect as no fruitless one', async (t) => {
  const c = unreachedRig(t, { out: 0, ores: 2 })
  // Another player digs the first ore as collectblock's walk to it starts.
  const onGoal = (g) => {
    if (!(g instanceof goals.GoalLookAtBlock)) return
    c.bot.removeListener('goal_updated', onGoal)
    c.blocks['1,64,0'] = air(1, 64, 0)
  }
  c.bot.on('goal_updated', onGoal)
  const collects = collectCells(c)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '1' }, c.env))
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual(collects, ['1,64,0', '2,64,0'])
  assert.strictEqual(c.seen.digs, 1)
})

test('a gather whose block changes during its walk runs no collect on it, takes the next and takes the block again once it is back', async (t) => {
  // Two ores out of reach of the body's start, the one at 4,64,0 nearer.
  const near = new Block('iron_ore', new Vec3(4, 64, 0))
  let gone = false
  const c = unreachedRig(t, {
    ores: 0,
    rig: jobRig,
    // The walk toward 4,64,0 ends where the body stands while another player digs that ore. Every other walk to a block arrives beside it.
    reach: (g) => {
      if (!(g instanceof goals.GoalNear)) return true
      if (g.x === 4 && !gone) {
        gone = true
        c.blocks['4,64,0'] = air(4, 64, 0)
        return true
      }
      c.bot.entity.position = new Vec3(g.x, 64, g.z + 1)
      return true
    }
  })
  Object.assign(c.blocks, { '4,64,0': near, '-5,64,0': new Block('iron_ore', new Vec3(-5, 64, 0)) })
  c.bot.entity = { width: 0.6, height: 1.8, position: new Vec3(0, 64, 0) }
  const standing = () => Object.values(c.blocks).filter((b) => b.type)
  c.bot.findBlocks = () => standing().map((b) => b.position)
  c.bot.world = { raycast: (from) => ({ position: standing().sort((a, b) => from.distanceTo(a.position) - from.distanceTo(b.position))[0]?.position }) }
  c.bot.pathfinder.startCell = (p) => p.floored()
  // The ore comes back with the dig of the other one.
  c.bot.once('diggingCompleted', () => { c.blocks['4,64,0'] = near })
  const collects = collectCells(c)
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '2' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 2, dug: 2, requested: 2, inventoryMatching: 2 })
  assert.deepStrictEqual(collects, ['-5,64,0', '4,64,0'])
})

test('mine counts its collect as fruitless when the server answers the collect\'s dig after the ledger stopped waiting, and digs no other block', async (t) => {
  // The answer comes 2000 ms after the dig, past its 1500 ms confirm window.
  const c = unreachedRig(t, { out: 0, ores: 2, answerTicks: 40 })
  tickTime(c)
  const reply = await within(awaitRoute('/mine', { name: 'iron_ore', count: '1' }, c.env))
  assert.deepStrictEqual(reply, { mined: 0, requested: 1, gathered: 1, reason: null })
  assert.strictEqual(c.seen.digs, 1)
  assert.strictEqual(c.blocks['2,64,0'].name, 'iron_ore')
})

// A gather rig over ores at x on the row level with the feet at 0,64,0. The walk toward the ore at 4,64,0 digs it as the forestry movements do and ends where the body stands, and every other walk to a block arrives beside it.
function walkDigRig (t, xs) {
  const c = unreachedRig(t, {
    ores: 0,
    rig: jobRig,
    reach: (g) => {
      if (g instanceof goals.GoalNear && g.x !== 4) c.bot.entity.position = new Vec3(g.x, 64, g.z + 1)
      return true
    }
  })
  for (const x of xs) c.blocks[`${x},64,0`] = new Block('iron_ore', new Vec3(x, 64, 0))
  c.bot.on('goal_updated', (g) => {
    if (g instanceof goals.GoalNear && g.x === 4 && c.blocks['4,64,0'].type) pathfinderDig(c, c.blocks['4,64,0'])
  })
  c.bot.entity = { width: 0.6, height: 1.8, position: new Vec3(0, 64, 0) }
  const standing = () => Object.values(c.blocks).filter((b) => b.type)
  c.bot.findBlocks = () => standing().map((b) => b.position)
  c.bot.world = { raycast: (from) => ({ position: standing().sort((a, b) => from.distanceTo(a.position) - from.distanceTo(b.position))[0]?.position }) }
  c.bot.pathfinder.startCell = (p) => p.floored()
  return c
}

test('a gather whose walk digs the block picks up its drop and counts that pass as progress', async (t) => {
  const c = walkDigRig(t, [4])
  // The first two searches find cells that changed since, two passes with nothing gathered. A third would end the gather as tapped out.
  const findBlocks = c.bot.findBlocks
  let searches = 0
  c.bot.findBlocks = (o) => ++searches <= 2 ? [new Vec3(searches + 1, 64, 0)] : findBlocks(o)
  const collects = collectCells(c)
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '2' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 1, dug: 1, requested: 2, inventoryMatching: 1, reason: 'no reachable iron_ore left (gathered 1/2)' })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
  assert.deepStrictEqual(collects, [])
  assert.strictEqual(searches, 4)
})

test('a gather searches again from where the walk to the drops of a block its walk dug left the body', async (t) => {
  // The walk-dug ore at 4,64,0 lies nearest the start, and the drop walk ends at 8,64,0, nearer the ore at 9,64,0 than the one at -5,64,0.
  const c = walkDigRig(t, [4, -5, 9])
  const stagedGoto = c.env.stagedGoto
  c.env.stagedGoto = async (goal, route) => {
    c.bot.entity.position = new Vec3(8, 64, 0)
    return stagedGoto(goal, route)
  }
  const collects = collectCells(c)
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '2' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 2, dug: 2, requested: 2, inventoryMatching: 2 })
  assert.deepStrictEqual(collects, ['9,64,0'])
})

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

test('tidy keeps a scaffold block whose walk a lit fuse refused queued and reclaims the next one of its kind', async (t) => {
  const scaffold = (x) => new Block('cobblestone', new Vec3(x, 64, 0))
  // The walks to the blocks arrive, the walks to their drops find no path.
  const c = collector(t, {
    blocks: { '1,64,0': scaffold(1), '2,64,0': scaffold(2) },
    reach: (g) => !(g instanceof goals.GoalFollow),
    plan: () => ({ status: 'noPath', path: [new Vec3(1, 64, 0)] })
  })
  c.env.navPlaced.push({ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 })
  let refusals = 0
  Object.assign(c.env, {
    seenNow: () => true,
    litFuse: () => (refusals ? null : { at: new Vec3(3.5, 64, 0.5), e: null }),
    planPath: async () => ({ status: 'success', path: [new Vec3(1, 64, 0)] }),
    closesOnFuse: () => true,
    fuseRefusal () {
      refusals++
      return Object.assign(new Error('refused: a fuse hissed'), { reason: 'fuse' })
    }
  })
  assert.deepStrictEqual(await within(awaitRoute('/tidy', {}, c.env)), { reclaimed: 1, alreadyGone: 0, failed: 1, remaining: 1, reason: 'fuse' })
  assert.deepStrictEqual(c.env.navPlaced, [{ x: 1, y: 64, z: 0 }])
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

test('tidy counts a dug scaffold block whose drop it cannot reach as reclaimed and drops it from the queue', async (t) => {
  const c = collector(t, {
    blocks: { '1,64,0': new Block('cobblestone', new Vec3(1, 64, 0)) },
    reach: (g) => !(g instanceof goals.GoalFollow),
    plan: () => ({ status: 'noPath', path: [new Vec3(1, 64, 0)] })
  })
  c.env.seenNow = () => true
  c.env.navPlaced.push({ x: 1, y: 64, z: 0 })
  assert.deepStrictEqual(await within(awaitRoute('/tidy', {}, c.env)), { reclaimed: 1, alreadyGone: 0, failed: 0, remaining: 0, reason: null })
  assert.strictEqual(c.seen.digs, 1)
})

// A collector for test t over the rig options that runs gather jobs, wired to stop as bot.js wires them, and answers /stop.
function jobRig (t, rig = { blocks: ORE, reach: () => true, holdDig: true }) {
  const c = collector(t, rig)
  c.bot.findBlocks = () => [new Vec3(1, 64, 0)]
  c.bot.world = { raycast: () => ({ position: new Vec3(1, 64, 0) }) }
  c.bot.clearControlStates = () => {}
  Object.assign(c.env, {
    seesLit: () => true,
    emitEvent: () => {},
    // The ore sits level with the feet.
    GATHER_MAX_DROP: 0,
    GATHER_MAX_RISE: 0,
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

test('a gather counts a dug block whose drop it cannot reach', async (t) => {
  const c = unreachedRig(t, { ores: 1, rig: jobRig })
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '1' }, c.env)
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  const { dug, gathered } = c.env.jobs.get(job).result
  assert.deepStrictEqual([dug, gathered], [1, 0])
})

test('a gather walks again to a drop collectblock could not reach once its next dig is confirmed and gathers it', async (t) => {
  const c = unreachedRig(t, { out: 1, ores: 2, rig: jobRig, chase: () => !c.blocks['2,64,0'].type })
  const left = () => Object.values(c.blocks).filter((b) => b.type)
  c.bot.findBlocks = () => left().map((b) => b.position)
  c.bot.world = { raycast: () => ({ position: left()[0]?.position }) }
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '2' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 2, dug: 2, requested: 2, inventoryMatching: 2 })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
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
  c.blocks['1,65,0'] = new Block('oak_leaves', new Vec3(1, 65, 0), 2)
  const considerateMoves = new Movements()
  const forestryMoves = new Movements()
  Object.assign(c.env.shared, {
    mcData: { blocksArray: [], blocks: { 1: { name: 'oak_log', drops: [900], states: [] } }, items: { 900: { name: 'oak_log' } }, itemsByName: { oak_log: {} } },
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

test('tidy tries the next block of a name again after a passing equip failure', async (t) => {
  const pick = { name: 'stone_pickaxe', type: 7, count: 1 }
  const stone = (x) => Object.assign(pickBlock('cobblestone', x, false), { canHarvest: (type) => type === 7 })
  const c = collector(t, { blocks: { '1,64,0': stone(1), '2,64,0': stone(2) }, reach: () => true })
  c.pockets.push(pick)
  let equips = 0
  c.bot.equip = async (item) => {
    if (++equips <= 3) throw new Error('equip failed')
    c.bot.heldItem = item
  }
  c.env.holdCollectTool = realHoldCollectTool(c.bot)
  c.env.seenNow = () => true
  c.env.navPlaced.push({ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 })
  const reply = awaitRoute('/tidy', {}, c.env)
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the second block drop')
  c.bot.emit('entityGone', c.seen.drops[0])
  assert.deepStrictEqual(await within(reply), { reclaimed: 1, alreadyGone: 0, failed: 1, remaining: 1, reason: 'refusing to dig cobblestone: the stone_pickaxe did not go into my hand (holding nothing)' })
  assert.deepStrictEqual(c.env.navPlaced.map((p) => p.x), [1])
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

const realBlock = (name, x, y, z, properties = {}) => Object.assign(PBlock.fromProperties(registry.blocksByName[name].id, properties, 0), { position: new Vec3(x, y, z) })

// Potatoes of [x, z, age] on farmland beside the body at 0,64,0 on rig, walks ending at the nearest cell their goal accepts.
function potatoRig (t, field, rig = collector) {
  const blocks = {}
  const potatoes = field.map(([x, z, age]) => {
    blocks[`${x},63,${z}`] = realBlock('farmland', x, 63, z, { moisture: '7' })
    return (blocks[`${x},64,${z}`] = realBlock('potatoes', x, 64, z, { age: String(age) })).position
  })
  const reach = (g) => {
    const here = c.bot.entity.position
    if (g instanceof goals.GoalFollow || g.isEnd(here.floored())) return true
    const ends = []
    for (let x = -3; x <= 45; x++) for (let z = -6; z <= 6; z++) if (g.isEnd(new Vec3(x, 64, z))) ends.push(new Vec3(x + 0.5, 64, z + 0.5))
    const end = ends.sort((a, b) => here.distanceTo(a) - here.distanceTo(b))[0]
    if (end) c.bot.entity.position = end
    return !!end
  }
  const c = rig(t, { blocks, reach })
  c.bot.entity = { width: 0.6, height: 1.8, position: new Vec3(0, 64, 0) }
  const at = (p) => {
    const b = c.blocks[`${p.x},${p.y},${p.z}`]
    return b && b.name !== 'air' ? b : realBlock(p.y >= 64 ? 'air' : 'dirt', p.x, p.y, p.z)
  }
  c.bot.blockAt = (p) => at(p.floored())
  c.bot.world = {
    raycast (from, dir, range) {
      for (let d = 0; d <= range; d += 0.02) {
        const p = from.plus(dir.scaled(d)).floored()
        if (at(p).shapes.length) return { position: p, face: 1 }
      }
      return null
    }
  }
  // mineflayer's search, nearest first, gated by the palette states, which have no position.
  c.bot.findBlocks = ({ matching, count = 1 }) => {
    const matches = Array.isArray(matching) ? (b) => !!b && matching.includes(b.type) : matching
    const here = c.bot.entity.position
    const cells = potatoes.filter((p) => at(p).name === 'potatoes').sort((a, b) => here.distanceTo(a) - here.distanceTo(b))
    if (![...new Set(cells.map((p) => at(p).stateId))].some((s) => matches(PBlock.fromStateId(s, 0)))) return []
    return cells.filter((p) => matches(at(p))).slice(0, count)
  }
  // Every potato shows a lit face, leaving findVisible's cap of 256 sight lines as the only filter.
  const findVisible = (matching, radius, count) => c.bot.findBlocks({ matching, count: 4096 }).slice(0, 256).slice(0, count)
    .map((pos) => ({ pos, dist: pos.distanceTo(c.bot.entity.position) }))
  c.env.shared.mcData = registry
  Object.assign(c.env, {
    resolveBlockIds: () => [registry.blocksByName.potatoes.id],
    findVisible,
    nearestVisible: (matching, radius) => {
      const v = findVisible(matching, radius, 1)
      return v.length ? at(v[0].pos) : null
    },
    seesLit: () => true,
    seenNow: () => true,
    entityInCell
  })
  return c
}

// Potatoes of the given ages from x 1 along x.
const row = (...ages) => ages.map((age, i) => [i + 1, 0, age])

// 280 unripe potatoes at x 1 to 40 and z -3 to 3, nearer the body than one ripe potato at 41,64,0.
const PAST_UNRIPE = [...Array(40).keys()].flatMap((i) => [-3, -2, -1, 0, 1, 2, 3].map((z) => [i + 1, z, 3])).concat([[41, 0, 7]])

// Picks up the first drop as potato.
async function pickUpPotato (c) {
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), `the body went to the drop of a dug potato (${c.seen.digs} digs, ${c.seen.planned} walks planned short of their goal)`)
  c.pockets.push({ name: 'potato', count: 1 })
  c.bot.emit('entityGone', c.seen.drops[0])
}

// The result of a potato gather job on c with query, its drop picked up unless dug is false.
async function potatoGather (c, query = {}, dug = true) {
  const { job } = runRoute('/gather', { resource: 'potatoes', amount: '1', ...query }, c.env)
  if (dug) await pickUpPotato(c)
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  return { ...c.env.jobs.get(job).result }
}

test('mine digs ripe potatoes on farmland and picks up the drop', async (t) => {
  const c = potatoRig(t, row(7))
  const reply = awaitRoute('/mine', { name: 'potatoes' }, c.env)
  await pickUpPotato(c)
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 1, reason: null })
})

test('a gather digs ripe potatoes on farmland and picks up the drop', async (t) => {
  const c = potatoRig(t, row(7), jobRig)
  assert.deepStrictEqual(await potatoGather(c), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1 })
})

test('mine skips an unripe potato, counts it and digs the ripe one beside it', async (t) => {
  const c = potatoRig(t, row(3, 7))
  const reply = awaitRoute('/mine', { name: 'potatoes' }, c.env)
  await pickUpPotato(c)
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 1, reason: null, unripe: 1 })
  assert.deepStrictEqual([c.bot.blockAt(new Vec3(1, 64, 0)).name, c.bot.blockAt(new Vec3(2, 64, 0)).name], ['potatoes', 'air'])
})

test('a gather skips an unripe potato, counts it and digs the ripe one beside it', async (t) => {
  const c = potatoRig(t, row(3, 7), jobRig)
  assert.deepStrictEqual(await potatoGather(c), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1, unripe: 1 })
  assert.deepStrictEqual([c.bot.blockAt(new Vec3(1, 64, 0)).name, c.bot.blockAt(new Vec3(2, 64, 0)).name], ['potatoes', 'air'])
})

test('mine digs a ripe potato past more unripe ones than it has sight lines for', async (t) => {
  const c = potatoRig(t, PAST_UNRIPE)
  const reply = awaitRoute('/mine', { name: 'potatoes' }, c.env)
  await pickUpPotato(c)
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 1, reason: null, unripe: 280 })
  assert.strictEqual(c.bot.blockAt(new Vec3(41, 64, 0)).name, 'air')
})

test('a gather digs a ripe potato past more unripe ones than one pass of candidates holds', async (t) => {
  const c = potatoRig(t, PAST_UNRIPE, jobRig)
  assert.deepStrictEqual(await potatoGather(c, { radius: '64' }), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1, unripe: 280 })
  assert.strictEqual(c.bot.blockAt(new Vec3(41, 64, 0)).name, 'air')
})

test('mine with only unripe potatoes in sight says none is ripe', async (t) => {
  const c = potatoRig(t, row(3, 3))
  const reply = await within(awaitRoute('/mine', { name: 'potatoes' }, c.env))
  assert.deepStrictEqual(reply, { mined: 0, requested: 1, gathered: 0, reason: 'no ripe potatoes left, 2 unripe', unripe: 2 })
  assert.strictEqual(c.seen.digs, 0)
})

test('a gather with only unripe potatoes in sight says none is ripe', async (t) => {
  const c = potatoRig(t, row(3, 3), jobRig)
  assert.deepStrictEqual(await potatoGather(c, {}, false), { gathered: 0, dug: 0, requested: 1, inventoryMatching: 0, unripe: 2, ok: false, reason: 'no ripe potatoes left, 2 unripe (gathered 0/1)' })
  assert.strictEqual(c.seen.digs, 0)
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
  assert.deepStrictEqual([gathered, reason], [0, `${STONE_SILK(c.blocks['0,64,2'])}, 2 refused for silk touch (gathered 0/1)`])
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

test('a gather with silk whose silk touch pick is gone after the walk stops at the block it walked to', async (t) => {
  // The silk touch pick wears out on the walk to the diamond ore.
  const { c, toDiamond } = silkGatherRig(t, (b) => toDiamond() ? `refusing to dig${b ? ` ${b.name}` : ''}: no silk touch pick carried` : null)
  const { job } = runRoute('/gather', { resource: 'ore', amount: '1', silk: '1' }, c.env)
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  const { gathered, reason } = c.env.jobs.get(job).result
  assert.deepStrictEqual([gathered, reason], [0, 'refusing to dig diamond_ore: no silk touch pick carried'])
  assert.ok(toDiamond() > 0, 'control: the body walked to the diamond ore')
  assert.strictEqual(c.seen.digs, 0)
})

// 1.21.11 blocks from cells beside the body at 0.5,64,0.5 on rig, all lit and known but the hidden ones, walks as in potatoRig.
function woodRig (t, cells, { hidden = [], rig = collector, plan } = {}) {
  const props = (name) => name.endsWith('_log') ? { axis: 'y' } : name.endsWith('_leaves') ? { distance: '1', persistent: 'false', waterlogged: 'false' } : {}
  const blocks = {}
  for (const [k, name] of Object.entries(cells)) blocks[k] = realBlock(name, ...k.split(',').map(Number), props(name))
  const reach = (g) => {
    const here = c.bot.entity.position
    if (g instanceof goals.GoalFollow || g.isEnd(here.floored())) return true
    const ends = []
    for (let x = -12; x <= 24; x++) for (let z = -6; z <= 6; z++) if (g.isEnd(new Vec3(x, 64, z))) ends.push(new Vec3(x + 0.5, 64, z + 0.5))
    const end = ends.sort((a, b) => here.distanceTo(a) - here.distanceTo(b))[0]
    if (end) c.bot.entity.position = end
    return !!end
  }
  const c = rig(t, { blocks, reach, ...(plan && { plan }) })
  c.bot.entity = { width: 0.6, height: 1.8, position: new Vec3(0.5, 64, 0.5) }
  const at = (p) => {
    const b = c.blocks[`${p.x},${p.y},${p.z}`]
    return b && b.name !== 'air' ? b : realBlock(p.y >= 64 ? 'air' : 'dirt', p.x, p.y, p.z)
  }
  c.bot.blockAt = (p) => at(p.floored())
  // A drop falls onto the first block with a shape under it before collectblock walks to it.
  c.bot.on('itemDrop', (d) => setImmediate(() => {
    const { x, z } = d.position
    let y = Math.floor(d.position.y) - 1
    while (!at(new Vec3(Math.floor(x), y, Math.floor(z))).shapes.length) y--
    d.position = new Vec3(x, y + 1, z)
  }))
  c.bot.world = {
    raycast (from, dir, range) {
      for (let d = 0; d <= range; d += 0.02) {
        const p = from.plus(dir.scaled(d)).floored()
        if (at(p).shapes.length) return { position: p, face: 1 }
      }
      return null
    }
  }
  c.bot.findBlocks = ({ matching, maxDistance = 16, count = 1, point = c.bot.entity.position }) => {
    const matches = Array.isArray(matching) ? (b) => !!b && matching.includes(b.type) : matching
    const o = point.floored()
    return Object.keys(c.blocks).map((k) => new Vec3(...k.split(',').map(Number)))
      .filter((p) => p.distanceTo(o) <= maxDistance && matches(at(p)))
      .sort((a, b) => a.distanceTo(o) - b.distanceTo(o)).slice(0, count)
  }
  c.env.shared.mcData = registry
  delete c.env.nearestVisible
  Object.assign(c.env, {
    resolveBlockIds: (name) => [registry.blocksByName[name].id],
    cellKnown: (p) => !hidden.includes(`${p.x},${p.y},${p.z}`),
    sightFace: () => true,
    eyeDist: () => 0,
    lightReach: () => 15,
    seesLit: () => true,
    seenNow: () => true,
    entityInCell
  })
  return c
}

// Picks up drop k (from 1) of a dug log.
async function pickUpLog (c, k = 1) {
  assert.ok(await waitFor(() => c.seen.followed === k, 2000), `the body went to drop ${k} of a dug log (${c.seen.digs} digs)`)
  c.pockets.length = 0
  c.pockets.push({ name: 'oak_log', count: k })
  c.bot.emit('entityGone', c.seen.drops[k - 1])
}

const SKIP_HINT = 'built logs touch a build block, unclear ones show no leaves in sight or join more than 128 logs. Look at an unclear tree\'s crown, or natural: false takes every log'
// An oak pillar under nothing beside oak planks at x 3, and an oak tree with its crown at x -5.
const PILLAR_AND_TREE = {
  '3,64,0': 'oak_log', '3,65,0': 'oak_log', '3,64,1': 'oak_planks', '3,65,1': 'oak_planks',
  '-5,64,0': 'oak_log', '-5,65,0': 'oak_log', '-5,66,0': 'oak_leaves', '-4,65,0': 'oak_leaves', '-6,65,0': 'oak_leaves'
}

test('mine passes over a pillar log beside planks, counts it built, takes the tree log beyond it, and natural 0 takes the pillar', async (t) => {
  const c = woodRig(t, PILLAR_AND_TREE)
  const reply = awaitRoute('/mine', { name: 'oak_log' }, c.env)
  await pickUpLog(c)
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 1, reason: null, skipped: { built: 2, unclear: 0 }, hint: SKIP_HINT })
  assert.deepStrictEqual(['3,64,0', '-5,64,0'].map((k) => c.bot.blockAt(new Vec3(...k.split(',').map(Number))).name), ['oak_log', 'air'])

  const any = woodRig(t, PILLAR_AND_TREE)
  const all = awaitRoute('/mine', { name: 'oak_log', natural: '0' }, any.env)
  await pickUpLog(any)
  assert.deepStrictEqual(await within(all), { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.strictEqual(any.bot.blockAt(new Vec3(3, 64, 0)).name, 'air')
})

test('mine passes over a tree whose crown it has not seen, counts its logs unclear and says no natural log is left', async (t) => {
  const tree = { '2,64,0': 'oak_log', '2,65,0': 'oak_log', '2,66,0': 'oak_leaves' }
  const c = woodRig(t, tree, { hidden: ['2,66,0'] })
  const reply = await within(awaitRoute('/mine', { name: 'oak_log' }, c.env))
  assert.deepStrictEqual(reply, { mined: 0, requested: 1, gathered: 0, reason: 'no natural oak_log left, skipped 0 built and 2 unclear', skipped: { built: 0, unclear: 2 }, hint: SKIP_HINT })
  assert.strictEqual(c.seen.digs, 0)
})

test('mine takes logs only within radius of where it started, though the body walked on toward more', async (t) => {
  const c = woodRig(t, { '6,64,0': 'oak_log', '6,65,0': 'oak_leaves', '10,64,0': 'oak_log', '10,65,0': 'oak_leaves' })
  const reply = awaitRoute('/mine', { name: 'oak_log', count: '2', radius: '8' }, c.env)
  await pickUpLog(c)
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 2, gathered: 1, reason: 'no oak_log in sight within 8 of the start' })
  assert.ok(c.bot.entity.position.floored().distanceTo(new Vec3(10, 64, 0)) <= 8, 'control: the second log lies within radius of the body')
  assert.strictEqual(c.bot.blockAt(new Vec3(10, 64, 0)).name, 'oak_log')
})

test('mine takes next the log nearest the body among those within radius of where it started', async (t) => {
  // Trees at x 7, then at -8,0 (nearer the start) and 8,4 (nearer where the walk to the first one ends).
  const c = woodRig(t, {
    '7,64,0': 'oak_log', '7,65,0': 'oak_leaves', '-8,64,0': 'oak_log', '-8,65,0': 'oak_leaves', '8,64,4': 'oak_log', '8,65,4': 'oak_leaves'
  })
  const reply = awaitRoute('/mine', { name: 'oak_log', count: '2', radius: '10' }, c.env)
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the first drop')
  const body = c.bot.entity.position.floored()
  await pickUpLog(c)
  assert.ok(body.distanceTo(new Vec3(8, 64, 4)) < body.distanceTo(new Vec3(-8, 64, 0)), 'control: the body stands nearer the tree at 8,4')
  await pickUpLog(c, 2)
  assert.deepStrictEqual(await within(reply), { mined: 2, requested: 2, gathered: 2, reason: null })
  assert.deepStrictEqual(['8,64,4', '-8,64,0'].map((k) => c.bot.blockAt(new Vec3(...k.split(',').map(Number))).name), ['air', 'oak_log'])
})

test('a gather passes over a pillar log beside planks, counts it built and gathers the tree log beyond it', async (t) => {
  const c = woodRig(t, PILLAR_AND_TREE, { rig: jobRig })
  const { job } = runRoute('/gather', { resource: 'oak_log', amount: '1' }, c.env)
  await pickUpLog(c)
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c.env.jobs.get(job).result)), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1, skipped: { built: 2, unclear: 0 }, hint: SKIP_HINT })
  assert.strictEqual(c.bot.blockAt(new Vec3(3, 64, 0)).name, 'oak_log')
})

test('a wood gather keeps built logs out of its collect walk and of the forestry walk while it holds the forestry movements, and natural 0 lets them be cut', async (t) => {
  // The gather digs the tree log at 1,64,0, and a pillar log beside planks stands at 1,64,3.
  const run = async (query) => {
    const c = jobRig(t)
    Object.assign(c.blocks, {
      '1,64,0': new Block('oak_log', new Vec3(1, 64, 0)),
      '1,65,0': new Block('oak_leaves', new Vec3(1, 65, 0), 2),
      '1,64,3': new Block('oak_log', new Vec3(1, 64, 3)),
      '1,64,4': new Block('oak_planks', new Vec3(1, 64, 4), 3)
    })
    const forestryMoves = new Movements()
    Object.assign(c.env.shared, {
      mcData: { blocksArray: [], blocks: { 1: { name: 'oak_log', drops: [900], states: [] } }, items: { 900: { name: 'oak_log' } }, itemsByName: { oak_log: {} } },
      considerateMoves: new Movements(),
      forestryMoves,
      thinkTimeout: 10000
    })
    const { job } = runRoute('/gather', { resource: 'oak_log', amount: '1', ...query }, c.env)
    assert.ok(await waitFor(() => c.seen.finishDig, 2000), 'control: the gather digs')
    const weigh = (list) => Array.from(list, (entry) => ['1,64,3', '1,64,0', '1,65,0'].map((k) => entry(c.bot.blockAt(new Vec3(...k.split(',').map(Number))))))
    const weights = weigh(forestryMoves.exclusionAreasBreak)
    const cage = weigh(c.bot.collectBlock.movements.exclusionAreasBreak)
    c.seen.finishDig()
    assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the drop')
    c.pockets.push({ name: 'oak_log', count: 1 })
    c.bot.emit('entityGone', c.seen.drops[0])
    assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
    return { weights, cage, after: forestryMoves.exclusionAreasBreak.length }
  }
  assert.deepStrictEqual(await run({}), { weights: [[100, 0, 0]], cage: [[100, 0, 0]], after: 0 })
  assert.deepStrictEqual(await run({ natural: '0' }), { weights: [], cage: [], after: 0 })
})

// The result of gather job on c once it ended, as the client receives it.
async function jobResult (c, job) {
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  assert.strictEqual(c.env.jobs.get(job).error, null)
  return JSON.parse(JSON.stringify(c.env.jobs.get(job).result))
}

// A gather job rig over woodRig whose oak log drops are picked up once collectblock's walk reaches them.
function logJob (t, cells, { forestry = false } = {}) {
  const c = woodRig(t, cells, { rig: jobRig })
  c.bot.prependListener('itemDrop', (d) => { d.getDroppedItem = () => ({ name: 'oak_log' }) })
  c.bot.on('goal_reached', (g) => {
    if (!(g instanceof goals.GoalFollow)) return
    c.pockets.push({ name: 'oak_log', count: 1 })
    setImmediate(() => c.bot.emit('entityGone', g.entity))
  })
  if (forestry) Object.assign(c.env.shared, { considerateMoves: new Movements(), forestryMoves: new Movements(), thinkTimeout: 10000 })
  return c
}

// The gather's first walk breaks the log at cell from a tick, as the pathfinder digs.
function breakOnWalk (c, cell) {
  const walk = { moves: null }
  const onGoal = (g) => {
    if (!(g instanceof goals.GoalNear)) return
    c.bot.removeListener('goal_updated', onGoal)
    walk.moves = c.bot.pathfinder.movements
    pathfinderDig(c, c.blocks[cell])
  }
  c.bot.on('goal_updated', onGoal)
  return walk
}

// Two oaks, the one at 3,64,0 nearer the body.
const TWO_OAKS = { '3,64,0': 'oak_log', '3,65,0': 'oak_leaves', '5,64,2': 'oak_log', '5,65,2': 'oak_leaves' }

test('a gather counts a pickup whose slot update lands after its wait for one, and gives no reason once the amount is met', async (t) => {
  const c = jobRig(t, { blocks: ORE, reach: () => true })
  // The server takes the drop on arrival, and its slot update comes during the next search.
  c.bot.on('goal_reached', (g) => {
    if (!(g instanceof goals.GoalFollow)) return
    c.bot.emit('playerCollect', c.bot.entity, g.entity)
    setImmediate(() => c.bot.emit('entityGone', g.entity))
  })
  const findBlocks = c.bot.findBlocks
  let searches = 0
  c.bot.findBlocks = (o) => {
    if (++searches === 2) c.pockets.push({ name: 'raw_iron', count: 1 })
    return findBlocks(o)
  }
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '1' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1 })
  assert.ok(searches >= 2, 'control: the slot update came after the wait')
})

test('a gather waits at its end for the pickup of a drop of its dig that lies within reach of the body', async (t) => {
  const c = jobRig(t, { blocks: ORE, reach: () => true, drop: () => null })
  const drop = new Entity(new Vec3(1.2, 64.1, 0.3))
  const findBlocks = c.bot.findBlocks
  let searches = 0
  c.bot.findBlocks = (o) => {
    // The drop of the dig spawns late, during the next search, beside the body.
    if (++searches === 2) {
      c.bot.entities[drop.id] = drop
      c.bot.emit('itemDrop', drop)
    }
    return findBlocks(o)
  }
  const waitForTicks = c.bot.waitForTicks
  let waits = 0
  c.bot.waitForTicks = (n) => {
    // The server collects it on the second tick the job waits after its last search.
    if (searches === 3 && ++waits === 2) {
      c.pockets.push({ name: 'raw_iron', count: 1 })
      c.bot.emit('playerCollect', c.bot.entity, drop)
      c.bot.emit('entityGone', drop)
    }
    return waitForTicks(n)
  }
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '1' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1 })
  assert.strictEqual(searches, 3, 'control: the job searched once more after the dig, and once to find nothing')
})

test('a gather walks to a drop that spawns after the collect returned', async (t) => {
  const c = jobRig(t, { blocks: ORE, reach: () => true, drop: () => null })
  const { collectSafely } = loadBotFunctions(['collectSafely'], c.env)
  c.env.collectSafely = async (...a) => {
    const r = await collectSafely(...a)
    // The drop spawns on the next tick in the dug cell.
    c.bot.once('physicsTick', () => {
      const drop = new Entity(new Vec3(1.5, 64.5, 0.5))
      c.seen.drops.push(drop)
      c.bot.entities[drop.id] = drop
      c.bot.emit('itemDrop', drop)
    })
    return r
  }
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '1' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1 })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
})

test('a wood gather counts a log its forestry walk breaks and walks to that log\'s drop', async (t) => {
  const c = logJob(t, TWO_OAKS, { forestry: true })
  const walk = breakOnWalk(c, '5,64,2')
  const { job } = runRoute('/gather', { resource: 'oak_log', amount: '2' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 2, dug: 2, requested: 2, inventoryMatching: 2 })
  assert.strictEqual(walk.moves, c.env.shared.forestryMoves, 'control: the walk that broke the log is the forestry walk')
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
})

test('a gather walks to the drop of its dig that came to rest on the floor off the cell centre and gathers it', async (t) => {
  const c = logJob(t, { '3,64,0': 'oak_log', '3,65,0': 'oak_leaves' })
  // A 1.7.10 drop spot 0.6 from the cell centre, out of collectblock's 0.5.
  c.bot.prependListener('itemDrop', (d) => { d.position = d.position.offset(0.35, -0.35, 0.35) })
  const { job } = runRoute('/gather', { resource: 'oak_log', amount: '1' }, c.env)
  assert.deepStrictEqual(await jobResult(c, job), { gathered: 1, dug: 1, requested: 1, inventoryMatching: 1 })
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
  assert.strictEqual(c.seen.drops[0].position.y, 64, 'control: the drop rests on the floor')
})

test('a gather does not count a dig made outside its own work', async (t) => {
  const c = jobRig(t, { blocks: ORE, reach: () => true })
  // Another route's dig, under a ledger of its own, takes the ore as collectblock walks to it.
  const other = loadBotFunctions(['digLedger'], c.env).digLedger([1])
  t.after(() => other.stop())
  const onGoal = (g) => {
    if (!(g instanceof goals.GoalLookAtBlock)) return
    c.bot.removeListener('goal_updated', onGoal)
    other.run(() => c.bot.dig(c.blocks['1,64,0']))
  }
  c.bot.on('goal_updated', onGoal)
  const { job } = runRoute('/gather', { resource: 'iron_ore', amount: '1' }, c.env)
  const { dug, gathered } = await jobResult(c, job)
  assert.strictEqual(other.mined(), 1, 'control: the other dig took the ore')
  assert.deepStrictEqual([dug, gathered], [0, 0])
})

test('a job stop during the walk to a drop of a gather ends its walks to drops', async (t) => {
  const c = logJob(t, TWO_OAKS, { forestry: true })
  breakOnWalk(c, '5,64,2')
  // The log at 3,64,0 drops off the cell centre too.
  c.bot.prependListener('itemDrop', (d) => { if (d.position.x < 5) d.position = d.position.offset(0.35, -0.35, 0.35) })
  c.env.stagedGoto = async ({ drop }) => {
    c.seen.chases.push(drop)
    runRoute('/stop', {}, c.env)
    return { arrived: false, reason: 'stopped' }
  }
  const { job } = runRoute('/gather', { resource: 'oak_log', amount: '2' }, c.env)
  await jobResult(c, job)
  assert.strictEqual(c.env.jobs.get(job).status, 'cancelled')
  assert.deepStrictEqual(c.seen.chases, [c.seen.drops[0]])
  assert.strictEqual(c.seen.drops.length, 2, 'control: two drops lay')
})

test('a wood gather leaves a drop whose walk a lit fuse refused for a later walk, and names the fuse when nothing else is left', async (t) => {
  const FUSE = 'refused: a creeper swells E ~4 and this walk closes on it, the guard stays up. Walk away from it, or walk again once the fuse is out.'
  // refuses(n) tells whether the nth walk to a drop is refused for the fuse.
  const run = async (refuses) => {
    const c = logJob(t, TWO_OAKS, { forestry: true })
    breakOnWalk(c, '5,64,2')
    const stagedGoto = c.env.stagedGoto
    let n = 0
    c.env.stagedGoto = async (q, route) => {
      if (!refuses(n++)) return stagedGoto(q, route)
      c.seen.chases.push(q.drop)
      throw Object.assign(new Error(FUSE), { reason: 'fuse' })
    }
    const { job } = runRoute('/gather', { resource: 'oak_log', amount: '2' }, c.env)
    return { c, result: await jobResult(c, job) }
  }
  const later = await run((n) => n === 0)
  assert.deepStrictEqual(later.result, { gathered: 2, dug: 2, requested: 2, inventoryMatching: 2 })
  assert.deepStrictEqual(later.c.seen.chases, [later.c.seen.drops[0], later.c.seen.drops[0]])
  const held = await run(() => true)
  assert.deepStrictEqual([held.result.gathered, held.result.reason, held.result.unreached.length], [1, `${FUSE} (gathered 1/2)`, 1])
})

// woodRig over the real sight functions at noon, listing each leaf dug in leafDigs with the log digs before it.
function leafyRig (t, cells, opts) {
  const c = woodRig(t, cells, { ...opts, plan: () => ({ status: 'noPath', path: [new Vec3(0, 64, 0)] }) })
  for (const stub of ['sightFace', 'eyeDist', 'lightReach', 'seesLit', 'leafInTheWay']) delete c.env[stub]
  const blockAt = c.bot.blockAt
  c.bot.blockAt = (p) => {
    const b = blockAt(p)
    if (b.name === 'air' || b.name.endsWith('_leaves')) b.skyLight = 15
    return b
  }
  Object.assign(c.bot, { game: { dimension: 'overworld', minY: -64, height: 384 }, time: { timeOfDay: 6000 }, registry, digTime: (b) => b.digTime(null, false, false, false) })
  c.leafDigs = []
  const dig = c.bot.dig
  c.bot.dig = async (b) => {
    if (!b.name.endsWith('_leaves')) return dig(b)
    const k = `${b.position.x},${b.position.y},${b.position.z}`
    c.leafDigs.push([k, c.seen.digs])
    delete c.blocks[k]
  }
  Object.assign(c.env, {
    ESTIMATED_LIGHT: new Map(),
    GRAVESTONE,
    LEGACY_1710: false,
    DIG_TOOL: botConstant('DIG_TOOL'),
    reflexes: [],
    guardState: { hand: null },
    setTimeout: c.clock.setTimeout,
    clearTimeout: c.clock.clearTimeout
  })
  return c
}

// An oak 2.5 blocks east of the body, its logs at x 3 from y 64 to 66, leaves on the four sides of the upper two and on top.
const LEAFY_OAK = {
  '3,64,0': 'oak_log', '3,65,0': 'oak_log', '3,66,0': 'oak_log', '3,67,0': 'oak_leaves',
  ...Object.fromEntries([65, 66].flatMap((y) => [[2, 0], [4, 0], [3, 1], [3, -1]].map(([x, z]) => [`${x},${y},${z}`, 'oak_leaves'])))
}

test('mine takes the logs of a tree seen through its leaves, digging only the leaves in the way, at most 2 a log', async (t) => {
  for (const natural of ['1', '0']) {
    const c = leafyRig(t, LEAFY_OAK)
    const reply = awaitRoute('/mine', { name: 'oak_log', count: '3', natural }, c.env)
    for (const k of [1, 2, 3]) await pickUpLog(c, k)
    assert.deepStrictEqual(await within(reply), { mined: 3, requested: 3, gathered: 3, reason: null }, `natural ${natural}`)
    assert.deepStrictEqual(c.leafDigs, [['2,65,0', 1]], `natural ${natural}`)
  }
})

test('a gather takes the logs of a tree seen through its leaves', async (t) => {
  const c = leafyRig(t, LEAFY_OAK, { rig: jobRig })
  const { job } = runRoute('/gather', { resource: 'oak_log', amount: '3' }, c.env)
  for (const k of [1, 2, 3]) await pickUpLog(c, k)
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  assert.deepStrictEqual(JSON.parse(JSON.stringify(c.env.jobs.get(job).result)), { gathered: 3, dug: 3, requested: 3, inventoryMatching: 3 })
  assert.deepStrictEqual(c.leafDigs, [['2,65,0', 0]], 'only the leaf over the bottom log, which hides it from within 2 blocks')
})

test('a gather digs the leaf that blocks collectblock\'s look at a log it sees in plain sight from within 2 blocks', async (t) => {
  // From 2,64,1 the look reaches only the log's west face, past the leaf at 2,65,0, while the eye sees its south face.
  const c = leafyRig(t, { '3,65,0': 'oak_log', '3,66,0': 'oak_leaves', '2,65,0': 'oak_leaves', '3,65,-1': 'oak_leaves' }, { rig: jobRig })
  c.bot.entity.position = new Vec3(2.5, 64, 1.5)
  const { job } = runRoute('/gather', { resource: 'oak_log', amount: '1' }, c.env)
  await pickUpLog(c)
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  assert.strictEqual(c.env.jobs.get(job).result.gathered, 1)
  assert.deepStrictEqual(c.leafDigs, [['2,65,0', 0]])
})

test('mine digs a leaf that blocks collectblock\'s look from the body\'s cell once the eye sees the log past the leaves', async (t) => {
  // From the eye at z 0.05 the log at 3,65,1 shows past 2,65,0, and the look from the cell's centre also meets 1,65,1.
  const c = leafyRig(t, { '3,65,1': 'oak_log', '3,65,0': 'oak_leaves', '2,65,0': 'oak_leaves', '1,65,1': 'oak_leaves' })
  c.bot.entity.position = new Vec3(0.5, 64, 0.05)
  const reply = awaitRoute('/mine', { name: 'oak_log' }, c.env)
  await pickUpLog(c)
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual(c.leafDigs, [['2,65,0', 0], ['1,65,1', 0]])
})

// A log in dirt at 4,66,0 behind three leaves on the line from the eye, and a clear oak at x -5.
const BURIED_LOG = {
  '4,66,0': 'oak_log', '4,67,0': 'oak_leaves', '4,65,0': 'dirt', '5,66,0': 'dirt', '4,66,1': 'dirt', '4,66,-1': 'dirt',
  '2,65,0': 'oak_leaves', '2,66,0': 'oak_leaves', '3,66,0': 'oak_leaves',
  '-5,64,0': 'oak_log', '-5,65,0': 'oak_leaves'
}

test('mine passes a log it cannot clear within 2 leaves, digging 2 for it once, takes the next and says why it stopped', async (t) => {
  const c = leafyRig(t, BURIED_LOG)
  const reply = awaitRoute('/mine', { name: 'oak_log', count: '2' }, c.env)
  await pickUpLog(c)
  assert.deepStrictEqual(await within(reply), {
    mined: 1, requested: 2, gathered: 1, reason: 'no oak_log in sight within 64 of the start, and 1 behind leaves I could not clear: more than 2 leaves in the way of oak_log at 4,66,0'
  })
  assert.deepStrictEqual(c.leafDigs, [['2,65,0', 0], ['2,66,0', 0]])
  assert.deepStrictEqual(['4,66,0', '-5,64,0'].map((k) => c.bot.blockAt(new Vec3(...k.split(',').map(Number))).name), ['oak_log', 'air'])
})

// A log under dirt at 3,64,0 that 2,64,1 sees only past two leaves, and a clear oak at x -5.
const LEAF_WALLED_LOG = {
  '3,64,0': 'oak_log', '3,65,0': 'dirt', '2,64,0': 'dirt', '3,65,1': 'oak_leaves', '3,64,1': 'oak_leaves', '2,65,0': 'oak_leaves',
  '-5,64,0': 'oak_log', '-5,65,0': 'oak_leaves'
}

test('a gather passes a log it cannot clear within 2 leaves, digging 2 for it once, and takes the next', async (t) => {
  const c = leafyRig(t, LEAF_WALLED_LOG, { rig: jobRig })
  c.bot.entity.position = new Vec3(2.5, 64, 1.5)
  const { job } = runRoute('/gather', { resource: 'oak_log', amount: '1' }, c.env)
  await pickUpLog(c)
  assert.ok(await waitFor(() => c.env.jobs.get(job).status !== 'running', 2000), 'the job ended')
  assert.strictEqual(c.env.jobs.get(job).result.gathered, 1)
  assert.deepStrictEqual(c.leafDigs, [['3,65,1', 0], ['3,64,1', 0]])
  assert.deepStrictEqual(['3,64,0', '-5,64,0'].map((k) => c.bot.blockAt(new Vec3(...k.split(',').map(Number))).name), ['oak_log', 'air'])
})

test('mine with no block of the name in sight says so', async (t) => {
  const c = woodRig(t, { '20,64,0': 'oak_log', '20,65,0': 'oak_leaves' })
  assert.deepStrictEqual(await within(awaitRoute('/mine', { name: 'oak_log', radius: '8' }, c.env)), { mined: 0, requested: 1, gathered: 0, reason: 'no oak_log in sight within 8 of the start' })
})
