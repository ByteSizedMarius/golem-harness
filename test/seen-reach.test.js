'use strict'
// A walk goal into reach of a block reads only the cells the body has seen.
const test = require('node:test')
const assert = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const gotoGoal = require('mineflayer-pathfinder/lib/goto')
const { goals, Movements } = require('mineflayer-pathfinder')
const WorldSync = require('prismarine-world/src/worldsync')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const { guardWork } = require('../lib/walk')
const { entityInCell } = require('../lib/shelter')
const { botConstant, fakeClock, loadBotFunctions, timed, waitFor } = require('./helpers')

const key = (p) => `${p.x},${p.y},${p.z}`

// Stone under y 64 and air above, with the named blocks at their 'x,y,z' cells and the feet at feet.
// The body has not seen the cells in unseen and knows those in shapes only as solid.
function field (blocks, { feet = new Vec3(0.5, 64, 0.5), unseen = [], shapes = [] } = {}) {
  const cells = new Map(Object.entries(blocks))
  const blockAt = (p) => {
    const c = p.floored()
    const name = cells.get(key(c)) || (c.y < 64 ? 'stone' : 'air')
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState, 0), { position: c })
  }
  const bot = Object.assign(new EventEmitter(), {
    registry,
    entity: { position: feet, width: 0.6, height: 1.8 },
    blockAt,
    // mineflayer's world reads every loaded cell.
    world: { raycast: (...ray) => WorldSync.prototype.raycast.apply({ getBlock: blockAt }, ray) },
    pathfinder: {}
  })
  const view = { unseen: new Set(unseen), shapes: new Set(shapes) }
  const PLAN_KNOWN = new Map()
  const planKnown = (p) => !view.unseen.has(key(p)) && (view.shapes.has(key(p)) ? 'solid' : true)
  bot.pathfinder.movements = loadBotFunctions(['knownMoves'], { bot, ck: (x, y, z) => `${x},${y},${z}`, PLAN_KNOWN, planKnown }).knownMoves(new Movements(bot))
  const learn = (k) => {
    view.unseen.delete(k)
    PLAN_KNOWN.clear()
  }
  const digs = []
  bot.dig = async (b) => {
    digs.push(key(b.position))
    cells.set(key(b.position), 'air')
  }
  bot.digTime = () => 0
  const env = { bot, goals, Vec3, entityInCell, CHEST_REACH: botConstant('CHEST_REACH') }
  return { bot, env, learn, digs, cells }
}

// The look from the feet at 0,64,0 to 3,65,0 crosses 2,65,0.
const TARGET = new Vec3(3, 65, 0)
const HERE = new Vec3(0, 64, 0)
const BLOCKED = { '3,65,0': 'stone', '2,65,0': 'stone' }

test('the walk goals into reach of a block read an unseen block on the look ray as open air', () => {
  const f = field(BLOCKED, { unseen: ['2,65,0'] })
  const { collectWalkGoal, chestWalkGoal } = loadBotFunctions(['collectWalkGoal', 'chestWalkGoal'], f.env)
  assert.strictEqual(collectWalkGoal(TARGET).isEnd(HERE), true, 'collect')
  assert.strictEqual(chestWalkGoal(TARGET).isEnd(HERE), true, 'chest')
  const seen = field(BLOCKED)
  const control = loadBotFunctions(['collectWalkGoal', 'chestWalkGoal'], seen.env)
  assert.deepStrictEqual([control.collectWalkGoal(TARGET).isEnd(HERE), control.chestWalkGoal(TARGET).isEnd(HERE)], [false, false], 'control: a seen block hides the target')
})

test('the walk goals into reach of a block stay met on the block once it left sight', () => {
  const f = field(BLOCKED, { unseen: ['2,65,0', '3,65,0'] })
  const { collectWalkGoal, chestWalkGoal } = loadBotFunctions(['collectWalkGoal', 'chestWalkGoal'], f.env)
  assert.strictEqual(collectWalkGoal(TARGET).isEnd(HERE), true, 'collect')
  assert.strictEqual(chestWalkGoal(TARGET).isEnd(HERE), true, 'chest')
})

// clearLeaves over f, whose block sight finds a leaf only at the cells in sightLeaves.
function leafClearer (f, sightLeaves = []) {
  Object.assign(f.env, {
    LEGACY_1710: false,
    digLock: botConstant('digLock'),
    leafInTheWay: () => sightLeaves.map((k) => f.bot.blockAt(new Vec3(...k.split(',').map(Number)))).find((b) => b.name === 'oak_leaves') || null,
    stopPath () {},
    stepOffDig: async () => false,
    refuseWhileFighting () {},
    holdHand: () => ({ renew: () => true }),
    endHand () {},
    holdDigTool: async () => {}
  })
  return loadBotFunctions(['collectWalkGoal', 'clearLeaves'], f.env)
}

test('a cell known only by its shape blocks the look as that shape, and clearLeaves digs no leaves it holds and names it by the shape', async () => {
  const alone = field({ '3,65,0': 'stone', '2,65,0': 'oak_leaves' }, { shapes: ['2,65,0'] })
  const { collectWalkGoal, clearLeaves } = leafClearer(alone)
  const goal = collectWalkGoal(TARGET)
  assert.strictEqual(goal.isEnd(HERE), false)
  assert.strictEqual(await clearLeaves(alone.bot.blockAt(TARGET), 'gather stone', goal), null, 'nothing to clear')
  assert.deepStrictEqual(alone.digs, [])
  // A leaf at 1,65,0 stands in front of the shape-only cell.
  const behind = field({ '3,65,0': 'stone', '2,65,0': 'oak_leaves', '1,65,0': 'oak_leaves' }, { shapes: ['2,65,0'] })
  const clearer = leafClearer(behind, ['1,65,0'])
  assert.strictEqual(await clearer.clearLeaves(behind.bot.blockAt(TARGET), 'gather stone'), 'solid at 2,65,0 is in the way of stone at 3,65,0')
  assert.deepStrictEqual(behind.digs, ['1,65,0'])
})

// A fake pathfinder that walks the body from -3,64,0 to each of ends, one per goal set.
// On arriving at an end the body sees the cells arrive names for it.
function walker (t, f, ends, arrive = {}) {
  const { bot } = f
  bot.entity.position = new Vec3(-2.5, 64, 0.5)
  const seen = { sets: [], ticks: 0, arrivals: 0 }
  let planned = false
  let path = []
  Object.assign(bot.pathfinder, {
    goal: null,
    thinkTimeout: 10000,
    isMoving: () => path.length > 0,
    stop () {
      this.goal = null
      path = []
      bot.emit('path_stop')
    },
    setGoal (g) {
      this.goal = g
      path = []
      planned = false
      if (g) seen.sets.push(g)
      bot.emit('goal_updated', g)
    }
  })
  let running = true
  const tick = () => {
    if (!running) return
    seen.ticks++
    const goal = bot.pathfinder.goal
    const reached = () => {
      bot.pathfinder.goal = null
      bot.emit('goal_reached', goal)
    }
    if (goal && !planned) {
      planned = true
      const end = ends.shift()
      if (end) {
        path = [end]
        bot.emit('path_update', { status: 'success', path: [{ x: end.x, y: end.y, z: end.z }] })
      }
    } else if (path.length) {
      const end = path.shift()
      bot.entity.position = end.offset(0.5, 0, 0.5)
      seen.arrivals++
      for (const k of arrive[key(end)] || []) f.learn(k)
      if (goal.isEnd(end) || goal.isEnd(end.offset(0, 1, 0))) reached()
    } else if (goal && goal.isEnd(bot.entity.position.floored())) reached()
    bot.emit('physicsTick')
    setImmediate(tick)
  }
  t.after(() => { running = false })
  setImmediate(tick)
  const clock = fakeClock()
  Object.assign(f.env, {
    require,
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    guardWork: (work, o) => guardWork(work, { ...o, clock }),
    watchScope: new AsyncLocalStorage(),
    cellKnown: () => true,
    console: { log () {} },
    reflexes: [{ name: 'unstuck', active: false }],
    litFuse: () => null
  })
  const { watchGoto, stopPath } = loadBotFunctions(['watchGoto', 'stopPath'], f.env)
  bot.pathfinder.goto = watchGoto((g) => gotoGoal(bot, g))
  // Settles on 'arrived' or the walk's error once the body stood still for 20 ticks after its last arrival and the stall watch ran out.
  const settle = async (walk) => {
    let done = false
    const out = walk.then(() => 'arrived', (e) => ({ reason: e.reason }))
    out.then(() => { done = true })
    let last = -1
    let still = 0
    await waitFor(() => {
      if (seen.arrivals !== last) [last, still] = [seen.arrivals, seen.ticks]
      return done || (last > 0 && seen.ticks - still > 20)
    }, 2000)
    // The watch's first check moves its anchor to where the walks left the body.
    clock.advance(botConstant('COLLECT_STALL_MS') + 1000)
    return (await timed(out, 2000)).out
  }
  return { seen, settle, stopPath }
}

// collectblock's own walk goal for a block.
const collectGoal = (f) => new goals.GoalLookAtBlock(TARGET, f.bot.world)
// The stone on the target hides its top from the cells above the walks' ends.
const WALKED = { ...BLOCKED, '3,66,0': 'stone' }

test('a goto swaps collectblock\'s look goal over the whole world for one over the cells the body has seen', async (t) => {
  const f = field(WALKED, { unseen: ['2,65,0'] })
  const w = walker(t, f, [HERE])
  const asked = new goals.GoalLookAtBlock(TARGET, f.bot.world, { reach: 3.9, entityHeight: 1.5 })
  assert.strictEqual(await w.settle(f.bot.pathfinder.goto(asked)), 'arrived')
  const [set] = w.seen.sets
  assert.ok(set instanceof goals.GoalLookAtBlock && set !== asked && set.world !== f.bot.world, 'the walk went to a look goal of its own')
  assert.deepStrictEqual([set.pos, set.reach, set.entityHeight], [asked.pos, asked.reach, asked.entityHeight])
})

// From 3,64,2 the body sees the target's south face.
const SOUTH = new Vec3(3, 64, 2)

test('a goto whose walk ends where a block seen on arrival hides the target plans once more and arrives', async (t) => {
  const f = field(WALKED, { unseen: ['2,65,0'] })
  const w = walker(t, f, [HERE, SOUTH], { '0,64,0': ['2,65,0'] })
  const goal = collectGoal(f)
  assert.strictEqual(await w.settle(f.bot.pathfinder.goto(goal)), 'arrived')
  assert.strictEqual(w.seen.sets.length, 2, 'the goto set its goal and set it once more')
  assert.strictEqual(w.seen.sets[0], w.seen.sets[1])
  assert.deepStrictEqual(f.bot.entity.position.floored(), SOUTH)
})

test('a goto plans once more only once, and a second walk that ends out of sight of the target stalls', async (t) => {
  const f = field({ ...WALKED, '3,65,1': 'stone' }, { unseen: ['2,65,0', '3,65,1'] })
  const w = walker(t, f, [HERE, SOUTH], { '0,64,0': ['2,65,0'], '3,64,2': ['3,65,1'] })
  const ticks = f.bot.listenerCount('physicsTick')
  assert.deepStrictEqual(await w.settle(f.bot.pathfinder.goto(collectGoal(f))), { reason: 'stalled' })
  assert.strictEqual(w.seen.sets.length, 2)
  assert.deepStrictEqual(f.bot.entity.position.floored(), SOUTH)
  // The stall's stop ends the pathfinder's goto a timer turn after the walk rejected.
  assert.ok(await waitFor(() => f.bot.listenerCount('physicsTick') === ticks, 2000), 'the goto stopped listening to physicsTick')
})

test('a goto ended by stopPath stops listening to physicsTick', async (t) => {
  const f = field(WALKED, { unseen: ['2,65,0'] })
  const w = walker(t, f, [])
  const ticks = f.bot.listenerCount('physicsTick')
  const walk = f.bot.pathfinder.goto(collectGoal(f)).then(() => 'arrived', (e) => e.name)
  await waitFor(() => w.seen.ticks > 2, 2000)
  assert.strictEqual(f.bot.listenerCount('physicsTick'), ticks + 1, 'control: the walk listens while it runs')
  w.stopPath()
  assert.strictEqual((await timed(walk, 2000)).out, 'PathStopped')
  assert.strictEqual(f.bot.listenerCount('physicsTick'), ticks)
})
