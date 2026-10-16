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
const { HUNG, awaitRoute, botConstant, fakeClock, loadBotFunctions, timed, waitFor } = require('./helpers')

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

// The body's pathfinder arrives at once when reach(goal) holds, else plans a path it never walks.
function collector ({ blocks, reach, drifting = false, holdDig = false }) {
  blocks = { ...blocks }
  const bot = new EventEmitter()
  let x = 0
  bot.entity = { get position () { return new Vec3(drifting ? x++ : 0, 64, 0) } }
  bot.blockAt = (p) => blocks[`${p.x},${p.y},${p.z}`] || null
  bot.inventory = { items: () => [], emptySlotCount: () => 36 }
  bot.tool = { equipForBlock: async () => {} }
  bot.heldItem = null
  bot.targetDigBlock = null
  const seen = { digs: 0, planned: 0, followed: 0, drops: [], watches: 0, logs: [] }
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
  setImmediate(tick)
  bot.pathfinder = {
    goal: null,
    thinkTimeout: 10000,
    movements: null,
    setMovements (m) { this.movements = m },
    isMoving: () => false,
    stop () {},
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
          bot.emit('path_update', { status: 'success', path: [new Vec3(1, 64, 0)] })
        }
      })
    },
    goto (g) { return gotoGoal(bot, g) }
  }
  bot.collectBlock = Object.assign(Object.create(CollectBlock.prototype), { bot, targets: new Targets(bot), chestLocations: [], itemFilter: () => true, movements: null })
  const clock = fakeClock()
  const env = {
    bot,
    require,
    mcData: { blocksArray: [] },
    Movements,
    navPlaced: [],
    collectLock: botConstant('collectLock'),
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    guardWork: (work, o) => {
      seen.watches++
      return guardWork(work, { ...o, clock })
    },
    watchScope: new AsyncLocalStorage(),
    Vec3,
    cellKnown: () => true,
    console: { log: (line) => seen.logs.push(line) },
    resolveBlockIds: () => [1],
    nearestVisible: () => blocks['1,64,0']
  }
  // collectSafely hands abandonCollect on uncalled, so the route loader would not find it.
  loadBotFunctions(['abandonCollect'], env)
  return { bot, env, clock, seen, blocks, stop: () => { ticking = false } }
}

const ORE = { '1,64,0': new Block('iron_ore', new Vec3(1, 64, 0)) }

// The reply, or HUNG when it has not come within 2 s.
const within = async (reply) => (await timed(reply, 2000)).out

test('mine returns with stalled when the path to the block never gets anywhere', async (t) => {
  const c = collector({ blocks: ORE, reach: () => false })
  t.after(c.stop)
  const reply = awaitRoute('/mine', { name: 'iron_ore', count: '2', radius: '8' }, c.env)
  assert.ok(await waitFor(() => c.seen.planned > 0, 2000), 'control: the walk to the block planned')
  c.clock.advance(botConstant('COLLECT_STALL_MS') + 500)
  assert.deepStrictEqual(await within(reply), { mined: 0, requested: 2, inventoryMatching: 0, reason: 'stalled' })
  assert.strictEqual(c.bot.pathfinder.goal, null, 'the walk is stopped')
})

test('a collect walks under one stall watch, the gotos of the collect plugin included', async (t) => {
  const c = collector({ blocks: ORE, reach: () => false })
  t.after(c.stop)
  const { watchGoto } = loadBotFunctions(['watchGoto', 'stopPath'], c.env)
  c.bot.pathfinder.goto = watchGoto((g) => gotoGoal(c.bot, g))
  const reply = awaitRoute('/mine', { name: 'iron_ore' }, c.env)
  assert.ok(await waitFor(() => c.seen.planned > 0, 2000), 'control: the walk to the block planned')
  assert.strictEqual(c.seen.watches, 1)
  c.clock.advance(botConstant('COLLECT_STALL_MS') + 500)
  assert.deepStrictEqual(await within(reply), { mined: 0, requested: 1, inventoryMatching: 0, reason: 'stalled' })
  assert.deepStrictEqual(c.seen.logs, ['[path] stalled at 0,64,0'])
})

test('mine counts the dug block and returns with stalled when its drop is never picked up, and the next collect starts afresh', async (t) => {
  const c = collector({ blocks: ORE, reach: () => true })
  t.after(c.stop)
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
    assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, inventoryMatching: 0, reason: 'stalled' })
    assert.strictEqual(c.seen.digs, round)
  }
})

test('a dig that outlasts the stall window is progress', async (t) => {
  const c = collector({ blocks: ORE, reach: () => true, holdDig: true })
  t.after(c.stop)
  const reply = awaitRoute('/mine', { name: 'iron_ore' }, c.env)
  assert.ok(await waitFor(() => c.seen.finishDig, 2000), 'control: the dig started')
  c.clock.advance(botConstant('COLLECT_STALL_MS') * 2)
  assert.strictEqual((await timed(reply, 100)).out, HUNG, 'the collect ended during the dig')
  c.seen.finishDig()
  assert.ok(await waitFor(() => c.seen.followed === 1, 2000), 'control: the body went to the drop')
  c.clock.advance(botConstant('COLLECT_STALL_MS') + 500)
  assert.deepStrictEqual(await within(reply), { mined: 1, requested: 1, inventoryMatching: 0, reason: 'stalled' })
})

test('mine returns with budget when the walk moves but never arrives', async (t) => {
  const c = collector({ blocks: ORE, reach: () => false, drifting: true })
  t.after(c.stop)
  const reply = awaitRoute('/mine', { name: 'iron_ore' }, c.env)
  assert.ok(await waitFor(() => c.seen.planned > 0, 2000), 'control: the walk to the block planned')
  c.clock.advance(botConstant('COLLECT_BUDGET_MS') - 500)
  c.clock.advance(1000)
  assert.deepStrictEqual(await within(reply), { mined: 0, requested: 1, inventoryMatching: 0, reason: 'budget' })
})

test('tidy stops at a stalled reclaim, keeps the rest queued and says why', async (t) => {
  const scaffold = (x) => new Block('cobblestone', new Vec3(x, 64, 0))
  const c = collector({ blocks: { '1,64,0': scaffold(1), '2,64,0': scaffold(2) }, reach: () => false })
  t.after(c.stop)
  c.env.navPlaced.push({ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 })
  const reply = awaitRoute('/tidy', {}, c.env)
  assert.ok(await waitFor(() => c.seen.planned > 0, 2000), 'control: the walk to the first block planned')
  c.clock.advance(botConstant('COLLECT_STALL_MS') + 500)
  assert.deepStrictEqual(await within(reply), { reclaimed: 0, alreadyGone: 0, failed: 1, remaining: 2, reason: 'stalled' })
  assert.deepStrictEqual(c.env.navPlaced.map((p) => p.x).sort(), [1, 2])
})
