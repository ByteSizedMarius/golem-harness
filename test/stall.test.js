'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const gotoGoal = require('mineflayer-pathfinder/lib/goto')
const { goals } = require('mineflayer-pathfinder')
const { guardWork } = require('../lib/walk')
const { awaitRoute, botConstant, fakeClock, loadBotFunctions, reflexIn, timed, waitFor } = require('./helpers')

const AIR = { name: 'air', boundingBox: 'empty' }
const solid = (name) => ({ name, boundingBox: 'block' })

// The body faces oak planks to the west and never moves, and its pathfinder resets as stuck every third tick.
function stuckBot ({ known = true } = {}) {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: Math.PI / 2 }
  bot.blockAt = (p) => (p.y < 64 ? solid('stone') : p.x === -1 && p.y === 64 && p.z === 0 ? solid('oak_planks') : AIR)
  const placed = []
  bot.placeBlock = async (ref, face) => { placed.push(ref.position.plus(face)) }
  bot.inventory = { items: () => [{ name: 'cobblestone', count: 64 }, { name: 'oak_planks', count: 64 }] }
  let path = []
  let ticks = 0
  const seen = { resets: 0, placed, logs: [] }
  bot.pathfinder = {
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
      bot.emit('goal_updated', g)
    }
  }
  let running = true
  const tick = () => {
    if (!running) return
    if (bot.pathfinder.goal && !path.length) {
      path = [new Vec3(-1, 64, 0)]
      bot.emit('path_update', { status: 'success', path })
    } else if (path.length && ++ticks % 3 === 0) {
      bot.emit('path_reset', 'stuck')
      path = []
      seen.resets++
    }
    setImmediate(tick)
  }
  setImmediate(tick)
  const clock = fakeClock()
  const env = {
    bot,
    require,
    goals,
    Vec3,
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    guardWork: (work, o) => guardWork(work, { ...o, clock }),
    watchScope: new AsyncLocalStorage(),
    cellKnown: () => known,
    console: { log: (line) => seen.logs.push(line) }
  }
  const { watchGoto } = loadBotFunctions(['watchGoto', 'stopPath'], env)
  bot.pathfinder.goto = watchGoto((g) => gotoGoal(bot, g))
  return { bot, env, clock, seen, stop: () => { running = false } }
}

async function stallOut (s) {
  assert.ok(await waitFor(() => s.seen.resets >= 3, 2000), 'control: the pathfinder resets as stuck')
  s.clock.advance(botConstant('COLLECT_STALL_MS') + 500)
}

const outcome = (p) => p.then(() => 'arrived', (e) => ({ reason: e.reason, message: e.message }))

test('a goto stuck in a replan loop rejects as stalled, naming where the body stands and the block it presses against', async (t) => {
  const s = stuckBot()
  t.after(s.stop)
  const walk = outcome(s.bot.pathfinder.goto(new goals.GoalNear(-5, 64, 0, 1)))
  await stallOut(s)
  const stall = 'stalled at 0,64,0 against oak_planks at -1,64,0'
  assert.deepStrictEqual((await timed(walk, 2000)).out, { reason: 'stalled', message: stall })
  assert.strictEqual(s.bot.pathfinder.goal, null, 'the walk is stopped')
  assert.deepStrictEqual(s.seen.logs, [`[path] ${stall}`])
})

test('the stall names no block the bot does not know', async (t) => {
  const s = stuckBot({ known: false })
  t.after(s.stop)
  const walk = outcome(s.bot.pathfinder.goto(new goals.GoalNear(-5, 64, 0, 1)))
  await stallOut(s)
  assert.deepStrictEqual((await timed(walk, 2000)).out, { reason: 'stalled', message: 'stalled at 0,64,0' })
})

test('walls stops at a stalled walk and says so instead of placing as if it arrived', async (t) => {
  const s = stuckBot()
  t.after(s.stop)
  const reply = awaitRoute('/walls', { x: '-4', z: '-1', w: '3', d: '3', h: '1', base: '64' }, s.env)
  await stallOut(s)
  assert.deepStrictEqual((await timed(reply, 2000)).out, {
    placed: 0, skipped: 0, failed: 0, size: '3x3', height: 1, door: 'west',
    reason: 'stalled', hint: 'stalled at 0,64,0 against oak_planks at -1,64,0'
  })
  assert.deepStrictEqual(s.seen.placed, [])
})

// Returns the first t in ms at which the unstuck reflex fires on a still body, or null if it never does by 40 s.
function unstuckFiresAt (events) {
  let t = 0
  let path = [new Vec3(1, 64, 0)]
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  bot.pathfinder = { goal: {}, isMoving: () => path.length > 0 }
  const r = reflexIn('unstuck', { Date: { now: () => t } })
  const gap = (p) => {
    path = p
    return r.check(bot)
  }
  r.check(bot)
  bot.emit('path_update', { status: 'success', path })
  for (t = 300; t <= 40000; t += 300) {
    if (events(bot, t, gap) || r.check(bot)) return t
  }
  return null
}

test('the unstuck reflex acts on a stuck replan loop within about 10 s, and still gives a planning walk 30 s', () => {
  const node = [new Vec3(1, 64, 0)]
  const stuckLoop = (bot, t, gap) => {
    if (t % 3600 !== 0) return false
    bot.emit('path_reset', 'stuck')
    // The reflex can check in the tick between the reset and its replan.
    const fired = gap([])
    gap(node)
    bot.emit('path_update', { status: 'success', path: node })
    return fired
  }
  const at = unstuckFiresAt(stuckLoop)
  assert.ok(at !== null && at <= 11000, `fired at ${at}`)
  const planning = (bot, t) => {
    if (t % 1200 === 0) bot.emit('path_update', { status: 'partial', path: node })
    return false
  }
  assert.ok(unstuckFiresAt(planning) >= 30000, 'control: a planner that keeps updating gets its 30 s')
})
