'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { performance } = require('node:perf_hooks')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const walk = require('../lib/walk')
const { loadBotFunctions, botConstant, startApp } = require('./helpers')
const { legLedger } = require('../lib/legs')

const { UNLOADED, UNKNOWN, standCell, targetKind, resolveTarget, crumbCentre, arrivedAt, watchProgress, walkAttempt, routeDeadline } = walk

const block = (name, boundingBox, height) => ({ name, boundingBox, shapes: height ? [[0, 0, 0, 1, height, 1]] : [] })
const AIR = block('air', 'empty')
const STONE = block('stone', 'block', 1)
const FARMLAND = block('farmland', 'block', 0.9375)

const ground = (top, cells = {}) => (y) => cells[y] || (y <= top ? STONE : AIR)
const rock = () => STONE
const air = (...ys) => Object.fromEntries(ys.map((y) => [y, AIR]))

// columns: { 'x,z': (y) => block }. Every other column is unloaded.
function world (columns) {
  return (p) => {
    const col = columns[`${p.x},${p.z}`]
    return col ? col(p.y) : null
  }
}

const cellOf = (v) => v && { x: v.x, y: v.y, z: v.z }

function fakeClock () {
  let t = 0
  let seq = 0
  const timers = new Map()
  const add = (fn, ms, every) => {
    timers.set(++seq, { fn, at: t + ms, every: every ? ms : 0 })
    return seq
  }
  return {
    now: () => t,
    setInterval: (fn, ms) => add(fn, ms, true),
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearInterval: (id) => timers.delete(id),
    clearTimeout: (id) => timers.delete(id),
    advance (ms) {
      const end = t + ms
      for (;;) {
        let next = null
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x]
        if (!next) break
        const [id, x] = next
        t = x.at
        if (x.every) x.at += x.every
        else timers.delete(id)
        x.fn()
      }
      t = end
    }
  }
}

test('standCell puts a drop resting on its floor block onto the cell above it', () => {
  const blockAt = world({ '0,0': ground(63) })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0.4, 0.6, 63.85)), { x: 0, y: 64, z: 0 })
})

test('standCell keeps a feet y that already stands', () => {
  const blockAt = world({ '0,0': ground(63) })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0, 0, 64)), { x: 0, y: 64, z: 0 })
})

test('standCell finds a floor 3 below the hint, and below wins a tie with a ledge 3 above', () => {
  const blockAt = world({ '0,0': ground(63, { 69: STONE }) })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0, 0, 67)), { x: 0, y: 64, z: 0 })
})

test('standCell picks the nearer of two stacked tunnels 3 apart', () => {
  const blockAt = world({ '0,0': ground(100, air(40, 41, 43, 44)) })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0, 0, 41)), { x: 0, y: 40, z: 0 })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0, 0, 42)), { x: 0, y: 43, z: 0 })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0, 0, 44)), { x: 0, y: 43, z: 0 })
})

test('standCell stands on farmland from feet sunk into it', () => {
  const blockAt = world({ '0,0': ground(62, { 63: FARMLAND }) })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0.5, 0.5, 63.94)), { x: 0, y: 64, z: 0 })
})

test('standCell returns null for a loaded column of solid rock', () => {
  const pocket = world({ '0,0': ground(100, air(50, 51)) })
  assert.deepStrictEqual(cellOf(standCell(pocket, 0, 0, 30)), { x: 0, y: 50, z: 0 }, 'control: a pocket in the rock')
  assert.strictEqual(standCell(world({ '0,0': rock }), 0, 0, 30), null)
})

test('standCell without y stands on the surface of a hill, not in the cave under it', () => {
  const blockAt = world({ '0,0': ground(70, air(50, 51)) })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0, 0)), { x: 0, y: 71, z: 0 })
})

test('standCell marks an unloaded column, with and without y', () => {
  const blockAt = world({ '0,0': ground(63) })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0, 0, 64)), { x: 0, y: 64, z: 0 }, 'control: the loaded column')
  assert.strictEqual(standCell(blockAt, 16, 0, 64), UNLOADED)
  assert.strictEqual(standCell(blockAt, 16, 0), UNLOADED)
})

test('standCell with known answers UNKNOWN for a hidden cavity, and still stands a drop on a seen floor and a ladder foot', () => {
  const cave = world({ '0,0': ground(100, air(40, 41)) })
  const surface = (p) => p.y >= 90
  assert.deepStrictEqual(cellOf(standCell(cave, 0, 0, 41)), { x: 0, y: 40, z: 0 }, 'control: without known')
  assert.strictEqual(standCell(cave, 0, 0, 41, undefined, surface), UNKNOWN)
  const top = world({ '0,0': ground(63) })
  assert.deepStrictEqual(cellOf(standCell(top, 0.4, 0.6, 63.73, undefined, (p) => p.y >= 63)), { x: 0, y: 64, z: 0 })
  const LADDER = block('ladder', 'block', 1)
  const ladder = world({ '0,0': ground(63, { 64: LADDER, 65: LADDER }) })
  assert.deepStrictEqual(cellOf(standCell(ladder, 0, 0, 64, undefined, (p) => p.y >= 64)), { x: 0, y: 64, z: 0 }, 'a ladder foot whose floor is out of sight')
})

test('standCell with known skips a candidate it cannot settle for a known floor within 2 of the hint, never further', () => {
  const flat = world({ '10,10': ground(63) })
  const sky = (p) => p.y >= 63
  for (const hint of [64, 63, 62]) {
    assert.deepStrictEqual(cellOf(standCell(flat, 10, 10, hint, undefined, sky)), { x: 10, y: 64, z: 10 }, `hint ${hint}`)
  }
  assert.strictEqual(standCell(flat, 10, 10, 61, undefined, sky), UNKNOWN)
  assert.strictEqual(standCell(flat, 10, 10, 40, undefined, sky), UNKNOWN, 'a known surface far above an unseen hint')
  assert.deepStrictEqual(cellOf(standCell(flat, 10, 10, 40, undefined, () => true)), { x: 10, y: 64, z: 10 }, 'a fully known column')
})

test('standCell with known answers UNKNOWN when it settles no stand cell, and null when every cell is known', () => {
  assert.strictEqual(standCell(world({ '0,0': ground(63) }), 0, 0, 40, undefined, () => false), UNKNOWN)
  assert.strictEqual(standCell(world({ '0,0': rock }), 0, 0, 40, undefined, () => true), null)
})

test('standCell clamps an absurd y hint into the column', () => {
  const blockAt = world({ '0,0': ground(63) })
  const t0 = performance.now()
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0, 0, 1e9)), { x: 0, y: 64, z: 0 })
  assert.deepStrictEqual(cellOf(standCell(blockAt, 0, 0, -1e9)), { x: 0, y: 64, z: 0 })
  assert.ok(performance.now() - t0 < 250, `${Math.round(performance.now() - t0)} ms`)
})

test('arrivedAt counts feet sunk into farmland as standing on the cell above it', () => {
  const goal = new goals.GoalBlock(0, 64, 0)
  assert.strictEqual(arrivedAt(goal, { x: 0.5, y: 63.94, z: 0.5 }), true)
  assert.strictEqual(arrivedAt(goal, { x: 1.5, y: 63.94, z: 0.5 }), false, 'a cell to the side')
})

test('targetKind accepts exactly one target form', () => {
  assert.strictEqual(targetKind({ x: 1, z: 2 }), 'coordinate')
  assert.strictEqual(targetKind({ x: 1, y: 64, z: 2, range: 3 }), 'coordinate')
  assert.strictEqual(targetKind({ waypoint: 'home', range: 2 }), 'waypoint')
  assert.strictEqual(targetKind({ block: 'chest' }), 'block')
  assert.strictEqual(targetKind({ x: 1, z: 2, waypoint: 'home' }), null, 'two forms')
  assert.strictEqual(targetKind({ x: 1, y: 64 }), null, 'x without z')
  assert.strictEqual(targetKind({ range: 2 }), null, 'no form')
})

function sources (over = {}) {
  return {
    blockAt: world({ '0,0': ground(63), '5,5': ground(63), '9,9': ground(100, air(40, 41, 43, 44)) }),
    waypoint: () => null,
    player: () => null,
    crumb: () => null,
    known: () => true,
    nametag: () => false,
    visibleBlock: () => null,
    cellKnown: () => true,
    ...over
  }
}

test('a coordinate walks onto its stand cell with GoalBlock at range 0 and GoalNear at range N', () => {
  const on = resolveTarget({ x: 5.5, z: 5.5 }, sources())
  assert.strictEqual(on.kind, 'coordinate')
  assert.ok(on.goal instanceof goals.GoalBlock)
  assert.deepStrictEqual([on.goal.x, on.goal.y, on.goal.z], [5, 64, 5])
  assert.deepStrictEqual(on.target, { x: 5, y: 64, z: 5 })
  const near = resolveTarget({ x: 5, y: 64, z: 5, range: 3 }, sources())
  assert.ok(near.goal instanceof goals.GoalNear)
  assert.deepStrictEqual([near.goal.x, near.goal.y, near.goal.z, near.goal.rangeSq], [5, 64, 5, 9])
})

test('the reply echoes the stand cell only when the bot knows it, else the asked coordinate', () => {
  assert.deepStrictEqual(resolveTarget({ x: 5, z: 5 }, sources()).target, { x: 5, y: 64, z: 5 }, 'control: a known cell')
  const hidden = resolveTarget({ x: 5, z: 5 }, sources({ cellKnown: () => false }))
  assert.deepStrictEqual(hidden.target, { x: 5, z: 5 })
  assert.deepStrictEqual(cellOf(hidden.cell), { x: 5, y: 64, z: 5 })
})

test('a waypoint walks to the stand cell nearest its stored feet y, and an unknown name is unknown', () => {
  const stored = { home: { x: 9, y: 43, z: 9 } }
  const r = resolveTarget({ waypoint: 'home' }, sources({ waypoint: (n) => stored[n] || null }))
  assert.strictEqual(r.kind, 'waypoint')
  assert.ok(r.goal instanceof goals.GoalBlock)
  assert.deepStrictEqual(cellOf(r.cell), { x: 9, y: 43, z: 9 })
  assert.deepStrictEqual(resolveTarget({ waypoint: 'away' }, sources({ waypoint: (n) => stored[n] || null })),
    { kind: 'waypoint', target: { waypoint: 'away' }, reason: 'unknown' })
})

test('a player walks to the live position in sight, near it by the nametag, else to the last-seen crumb', () => {
  const steve = { position: { x: 5.3, y: 64, z: 5.7 } }
  const crumb = { pos: { x: 0.5, y: 64, z: 0.5 }, nametag: false, agoSec: 12 }
  const live = resolveTarget({ player: 'Steve' }, sources({ player: () => steve, crumb: () => crumb }))
  assert.deepStrictEqual(cellOf(live.cell), { x: 5, y: 64, z: 5 })
  const tag = resolveTarget({ player: 'Steve', range: 1 }, sources({ player: () => steve, crumb: () => crumb, known: () => false, nametag: () => true }))
  assert.strictEqual(tag.nametag, true)
  assert.ok(tag.goal instanceof goals.GoalNear)
  assert.strictEqual(tag.goal.rangeSq, 4, 'range 1 is raised to 2')
  assert.deepStrictEqual(tag.target, { player: 'Steve' })
  const hidden = resolveTarget({ player: 'Steve' }, sources({ player: () => steve, crumb: () => crumb, known: () => false }))
  assert.deepStrictEqual(cellOf(hidden.cell), { x: 0, y: 64, z: 0 })
  assert.strictEqual(hidden.agoSec, 12)
})

test('a y inside hidden rock is walked toward, never resolved to a cavity the bot has not seen', () => {
  const surface = sources({ cellKnown: (p) => p.y >= 90 })
  assert.ok(resolveTarget({ x: 9, y: 41, z: 9 }, sources()).goal, 'control: the tunnel in sight')
  assert.deepStrictEqual(resolveTarget({ x: 9, y: 41, z: 9 }, surface),
    { kind: 'coordinate', target: { x: 9, y: 41, z: 9 }, toward: { x: 9, y: 41, z: 9 } })
})

test('a block walks next to the nearest visible one with GoalGetToBlock', () => {
  const chest = { name: 'chest', position: { x: 5, y: 64, z: 5 } }
  const r = resolveTarget({ block: 'chest' }, sources({ visibleBlock: (n) => (n === 'chest' ? chest : null) }))
  assert.strictEqual(r.kind, 'block')
  assert.ok(r.goal instanceof goals.GoalGetToBlock)
  assert.deepStrictEqual([r.goal.x, r.goal.y, r.goal.z], [5, 64, 5])
})

test('a known drop walks onto the stand cell under it', () => {
  const drop = { position: { x: 5.2, y: 63.73, z: 5.9 } }
  const r = resolveTarget({ drop }, sources())
  assert.strictEqual(r.kind, 'drop')
  assert.ok(r.goal instanceof goals.GoalBlock)
  assert.deepStrictEqual([r.goal.x, r.goal.y, r.goal.z], [5, 64, 5])
})

test('a hidden player, drop or block resolves to unseen, naming only what was asked', () => {
  const steve = { position: { x: 5.3, y: 64, z: 5.7 } }
  const drop = { position: { x: 5.2, y: 63.73, z: 5.9 } }
  const chest = { name: 'chest', position: { x: 5, y: 64, z: 5 } }
  const seen = sources({ player: () => steve, visibleBlock: () => chest })
  for (const q of [{ player: 'Steve' }, { drop }, { block: 'chest' }]) {
    assert.ok(resolveTarget(q, seen).goal, `control: ${Object.keys(q)[0]} in sight`)
  }
  const hidden = sources({ player: () => steve, known: () => false })
  assert.deepStrictEqual(resolveTarget({ player: 'Steve' }, hidden), { kind: 'player', target: { player: 'Steve' }, reason: 'unseen' })
  assert.deepStrictEqual(resolveTarget({ drop }, hidden), { kind: 'drop', target: null, reason: 'unseen' })
  assert.deepStrictEqual(resolveTarget({ block: 'chest' }, hidden), { kind: 'block', target: { block: 'chest' }, reason: 'unseen' })
})

test('a column without a stand cell is no-floor only when the bot knows every cell, else it is walked toward', () => {
  const blockAt = world({ '0,0': ground(63), '5,5': rock })
  const src = sources({ blockAt })
  assert.ok(resolveTarget({ x: 0, z: 0 }, src).goal, 'control: a column with a floor')
  assert.deepStrictEqual(resolveTarget({ x: 5, z: 5 }, src), { kind: 'coordinate', target: { x: 5, z: 5 }, reason: 'no-floor' })
  const hidden = sources({ blockAt, cellKnown: (c) => c.y !== 10 })
  assert.deepStrictEqual(resolveTarget({ x: 5, z: 5 }, hidden), { kind: 'coordinate', target: { x: 5, z: 5 }, toward: { x: 5, y: undefined, z: 5 } })
  assert.deepStrictEqual(resolveTarget({ x: 300, y: 70, z: -40 }, src),
    { kind: 'coordinate', target: { x: 300, y: 70, z: -40 }, toward: { x: 300, y: 70, z: -40 } }, 'an unloaded column')
})

function watched (clock) {
  const pos = { x: 0.5, y: 64, z: 0.5 }
  const pathfinder = new EventEmitter()
  const ended = []
  const dog = watchProgress({
    position: () => pos,
    onPathUpdate: (fn) => {
      pathfinder.on('path_update', fn)
      return () => pathfinder.off('path_update', fn)
    },
    stallMs: 4500,
    thinkTimeout: 10000,
    onStall: () => ended.push('stall'),
    onThinkTimeout: () => ended.push('think'),
    clock
  })
  const update = (status) => pathfinder.emit('path_update', { status, path: [] })
  return { pos, pathfinder, ended, dog, update }
}

test('planning with partial path updates does not count as a stall', () => {
  const clock = fakeClock()
  const w = watched(clock)
  for (let t = 0; t < 8000; t += 400) {
    w.update('partial')
    clock.advance(400)
  }
  assert.deepStrictEqual(w.ended, [], '8 s of planning without a step')
  w.update('success')
  clock.advance(4000)
  assert.deepStrictEqual(w.ended, [], 'control: 4 s after the path arrived')
  clock.advance(1000)
  assert.deepStrictEqual(w.ended, ['stall'])
})

test('a path that emptied without goal_reached ends the attempt as a stall', () => {
  const clock = fakeClock()
  const w = watched(clock)
  w.update('success')
  for (let i = 0; i < 3; i++) {
    w.pos.x += 1
    clock.advance(400)
  }
  clock.advance(4000)
  assert.deepStrictEqual(w.ended, [], 'control: 4 s after the last step')
  clock.advance(1000)
  assert.deepStrictEqual(w.ended, ['stall'])
  assert.strictEqual(w.pathfinder.listenerCount('path_update'), 0, 'the ended watchdog unsubscribes')
  clock.advance(20000)
  assert.deepStrictEqual(w.ended, ['stall'], 'it ends the attempt once')
})

test('a block of progress resets the stall clock', () => {
  const clock = fakeClock()
  const w = watched(clock)
  w.update('success')
  for (let i = 0; i < 10; i++) {
    clock.advance(3000)
    w.pos.z += 1
  }
  assert.deepStrictEqual(w.ended, [], 'a block every 3 s for 30 s')
  for (let i = 0; i < 10; i++) {
    clock.advance(3000)
    w.pos.z += 0.3
  }
  assert.deepStrictEqual(w.ended, ['stall'], 'creeping 0.3 per 3 s')
})

test('a re-plan pauses the stall clock without resetting it', () => {
  const clock = fakeClock()
  const w = watched(clock)
  w.update('success')
  clock.advance(3000)
  for (let t = 0; t < 6000; t += 400) {
    w.update('partial')
    clock.advance(400)
  }
  w.update('success')
  clock.advance(1200)
  assert.deepStrictEqual(w.ended, [], 'control: 4.2 s without progress outside planning')
  clock.advance(800)
  assert.deepStrictEqual(w.ended, ['stall'])
})

test('planning past thinkTimeout ends the attempt as a think timeout, not a stall', () => {
  const clock = fakeClock()
  const w = watched(clock)
  clock.advance(9600)
  assert.deepStrictEqual(w.ended, [], 'control: 9.6 s of planning')
  clock.advance(800)
  assert.deepStrictEqual(w.ended, ['think'])
})

test('stop ends the watch without a verdict', () => {
  const clock = fakeClock()
  const w = watched(clock)
  w.update('success')
  w.dog.stop()
  clock.advance(60000)
  assert.deepStrictEqual(w.ended, [])
  assert.strictEqual(w.pathfinder.listenerCount('path_update'), 0)
})

// A bot whose pathfinder answers each goal it is given with answer(bot, goal).
function fakeWalker (answer) {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  bot.pathfinder = {
    goal: null,
    thinkTimeout: 10000,
    setGoal (g) {
      this.goal = g
      bot.emit('goal_updated', g)
      if (g) setImmediate(() => answer(bot, g))
    }
  }
  return bot
}

const update = (status, path = []) => (bot) => bot.emit('path_update', { status, path })

test('walkAttempt ends on the pathfinder event that settles the walk', async () => {
  const rows = [
    ['done', (bot) => bot.emit('goal_reached')],
    ['no-path', update('noPath')],
    ['timeout', update('timeout')],
    ['emptied', update('success')],
    ['stopped', (bot) => bot.emit('path_stop')],
    ['changed', (bot) => bot.pathfinder.setGoal(null)]
  ]
  for (const [how, answer] of rows) {
    const bot = fakeWalker(answer)
    assert.strictEqual(await walkAttempt(bot, new goals.GoalBlock(5, 64, 5), { stallMs: 4500, thinkTimeout: 10000 }), how)
    for (const ev of ['goal_reached', 'path_update', 'goal_updated', 'path_stop']) assert.strictEqual(bot.listenerCount(ev), 0, `${how}: ${ev} listener left`)
  }
})

test('walkAttempt outlasts an empty partial path and ends a path that empties without goal_reached as a stall', async () => {
  const clock = fakeClock()
  const bot = fakeWalker((b) => {
    update('partial')(b)
    update('success', [{ x: 1, y: 64, z: 0 }])(b)
  })
  let how = null
  walkAttempt(bot, new goals.GoalBlock(5, 64, 5), { stallMs: 4500, thinkTimeout: 10000, clock }).then((h) => { how = h })
  await new Promise(setImmediate)
  clock.advance(4000)
  await new Promise(setImmediate)
  assert.strictEqual(how, null, 'control: 4 s after the plan')
  clock.advance(1000)
  await new Promise(setImmediate)
  assert.strictEqual(how, 'stalled')
})

// Runs a timer 1000 times sooner than asked, with now() scaled to match.
const FAST = {
  now: () => performance.now() * 1000,
  setInterval: (fn, ms) => setInterval(fn, Math.max(1, ms / 1000)),
  clearInterval: (h) => clearInterval(h),
  setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, ms / 1000)),
  clearTimeout: (h) => clearTimeout(h)
}

// A fake bot over flat stone up to y 63, with bot.js's walking functions loaded into env.
function walkBot ({ answer = () => {}, setup = () => {}, over = {} } = {}) {
  const env = {}
  const bot = fakeWalker((b, g) => answer(b, g, env))
  bot.game = { minY: -64, height: 384 }
  bot.players = {}
  bot.blockAt = (p) => (p.y <= 63 ? STONE : AIR)
  setup(bot)
  Object.assign(env, {
    bot,
    bunker: { building: false },
    console,
    setTimeout: (fn) => setImmediate(fn),
    goals,
    UNLOADED,
    standCell,
    resolveTarget,
    arrivedAt,
    walkAttempt: (b, g, o) => walkAttempt(b, g, { ...o, clock: FAST }),
    routeDeadline,
    legs: legLedger(),
    WALK_HINTS: {},
    WALK_FAILED: botConstant('WALK_FAILED'),
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    waypoints: { get: () => null },
    playerCrumbs: {},
    entityPerceptible: () => true,
    nametagVisible: () => false,
    airFlood: () => ({}),
    nearestVisible: () => null,
    resolveBlockIds: () => [1],
    cellKnown: () => true,
    hasLegalMove: () => true,
    airPrecheck: () => ({ verdict: 'connected' }),
    doorwayCommit: async () => false,
    stopPath () { bot.pathfinder.setGoal(null) },
    ...over
  })
  return { env, bot, ctx: loadBotFunctions(['walkRoute', 'stagedGoto', 'collectDrops'], env) }
}

async function goto (q, opts) {
  const { ctx } = walkBot(opts)
  const route = ctx.walkRoute()
  try {
    return JSON.parse(JSON.stringify(await ctx.stagedGoto(q, route)))
  } finally { route.end() }
}

const arrive = (bot, g) => {
  bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5)
  bot.emit('goal_reached', g)
}

async function assertGaveUp (rows) {
  for (const [reason, opts] of rows) {
    const r = await goto({ x: 5, z: 5 }, opts)
    assert.deepStrictEqual([r.arrived, r.reason, r.target, r.dist], [false, reason, { x: 5, y: 64, z: 5 }, 7.1], reason)
  }
}

test('the /goto walk replies arrived on the stand cell, or how the walk gave up', async () => {
  assert.deepStrictEqual(await goto({ x: 5, z: 5 }, { answer: arrive }),
    { arrived: true, kind: 'coordinate', target: { x: 5, y: 64, z: 5 }, pos: { x: 5.5, y: 64, z: 5.5 }, dist: 0, reason: null, hint: null })
  await assertGaveUp([
    ['no-path', { answer: update('noPath') }],
    ['stalled', { answer: update('success', [{ x: 1, y: 64, z: 0 }]) }],
    ['not-reached', { answer: update('success') }],
    ['stopped', { answer: (bot) => bot.emit('path_stop') }]
  ])
})

test('the /goto walk replies the reason it did not start', async () => {
  await assertGaveUp([
    ['walled', { over: { airPrecheck: () => ({ verdict: 'walled' }) } }],
    ['sealed', { over: { airPrecheck: () => ({ verdict: 'sealed' }) } }],
    ['boxed-in', { over: { hasLegalMove: () => false } }],
    ['bunker', { over: { bunker: { building: true } } }],
    ['budget', { over: { routeDeadline: () => ({ expired: () => true, left: () => 0, cancel () {} }) } }]
  ])
  const pillar = (bot) => { bot.blockAt = (p) => (p.y <= 63 || (p.x === 5 && p.z === 5) ? STONE : AIR) }
  assert.deepStrictEqual(await goto({ x: 5, z: 5 }, { setup: pillar }),
    { arrived: false, kind: 'coordinate', target: { x: 5, z: 5 }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: null, reason: 'no-floor', hint: null })
  assert.deepStrictEqual(await goto({ waypoint: 'home' }),
    { arrived: false, kind: 'waypoint', target: { waypoint: 'home' }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: null, reason: 'unknown', hint: null })
  assert.deepStrictEqual(await goto({ block: 'chset' }, { over: { resolveBlockIds: () => [] } }),
    { arrived: false, kind: 'block', target: { block: 'chset' }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: null, reason: 'unknown', hint: null })
})

test('a hidden player stays hidden in the /goto reply, and one known by the nametag gets only a bearing and a rough distance', async () => {
  const setup = (bot) => { bot.players.Steve = { entity: { position: new Vec3(13.3, 64, -2.6) } } }
  assert.deepStrictEqual(await goto({ player: 'Steve' }, { setup, over: { entityPerceptible: () => false } }),
    { arrived: false, kind: 'player', target: { player: 'Steve' }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: null, reason: 'unseen', hint: null })
  const tagged = { arrived: false, kind: 'player', target: { player: 'Steve' }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: 15, reason: 'no-path', hint: null, bearing: 'E' }
  assert.deepStrictEqual(await goto({ player: 'Steve' }, { setup, over: { entityPerceptible: () => false, nametagVisible: () => true }, answer: update('noPath') }), tagged)
  const walled = { entityPerceptible: () => false, nametagVisible: () => true, airPrecheck: () => ({ verdict: 'walled' }) }
  assert.deepStrictEqual(await goto({ player: 'Steve' }, { setup, over: walled, answer: update('noPath') }), tagged, 'no precheck reads the hidden cell')
})

test('a player known last by the nametag stays a bearing and a rough distance, and a crumb reply carries its age', async () => {
  const crumbs = (nametag) => ({ Steve: { pos: new Vec3(13.3, 64, -2.6), t: Date.now() - 7000, nametag } })
  const seen = await goto({ player: 'Steve' }, { over: { playerCrumbs: crumbs(false) }, answer: update('noPath') })
  assert.deepStrictEqual([seen.target, seen.dist, seen.agoSec], [{ x: 13, y: 64, z: -3 }, 13.3, 7], 'control: a crumb from sight')
  assert.deepStrictEqual(await goto({ player: 'Steve' }, { over: { playerCrumbs: crumbs(true) }, answer: update('noPath') }),
    { arrived: false, kind: 'player', target: { player: 'Steve' }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: 15, reason: 'no-path', hint: null, bearing: 'E', agoSec: 7 })
})

test('a pilot stop ends the walk, and the retry that would arrive never starts', async () => {
  for (const pilot of [false, true]) {
    const set = []
    const answer = (bot, g, env) => {
      set.push(g)
      if (set.length > 1) return arrive(bot, g)
      if (pilot) env.legs.take(null)
      bot.emit('path_stop')
    }
    const r = await goto({ x: 5, z: 5 }, { answer })
    if (!pilot) {
      assert.deepStrictEqual([r.arrived, set.length], [true, 2], 'control: a path stop without the pilot is retried')
      continue
    }
    assert.deepStrictEqual([r.arrived, r.reason, set.length], [false, 'stopped', 1])
  }
})

test('a reflex freeze ends the walk, mid-attempt or in the retry pause, and no walk follows', async () => {
  for (const during of ['none', 'attempt', 'pause']) {
    const set = []
    const answer = (bot, g, env) => {
      set.push(g)
      if (set.length > 1) return arrive(bot, g)
      if (during === 'attempt') env.legs.take('hurt')
      bot.emit('path_stop')
    }
    const { env, ctx } = walkBot({ answer })
    // The freeze stops the pathfinder, which sends no goal_updated.
    if (during === 'pause') env.setTimeout = (fn) => { env.legs.take('hurt'); setImmediate(fn) }
    const route = ctx.walkRoute()
    let r
    try { r = await ctx.stagedGoto({ x: 5, z: 5 }, route) } finally { route.end() }
    if (during === 'none') {
      assert.deepStrictEqual([r.arrived, set.length], [true, 2], 'control: a path stop without a freeze is retried')
      continue
    }
    assert.deepStrictEqual([r.arrived, r.reason, set.length], [false, 'stopped', 1], during)
  }
})

test('a pilot stop while the walk is wedged ends it without the doorway drill', async () => {
  for (const pilot of [false, true]) {
    let drills = 0
    const answer = (bot, g, env) => {
      if (pilot) env.legs.take(null)
      update('success', [{ x: 1, y: 64, z: 0 }])(bot)
    }
    const r = await goto({ x: 5, z: 5 }, { answer, over: { doorwayCommit: async () => { drills++; return false } } })
    assert.deepStrictEqual([r.reason, drills], pilot ? ['stopped', 0] : ['stalled', 1])
  }
})

test('a reflex that takes the legs ends the route as stopped and keeps its goal, mid-hop and mid-walk', async () => {
  const flee = new goals.GoalNear(-20, 64, 0, 2)
  for (const x of [100, 5]) {
    let walker = null
    let walks = 0
    const answer = (bot, g, env) => {
      if (g === flee) return
      walks++
      bot.entity.position = bot.entity.position.offset(3, 0, 0)
      env.stopPath()
      bot.pathfinder.setGoal(flee)
    }
    // Columns past x 40 are unloaded.
    const setup = (bot) => {
      walker = bot
      const flat = bot.blockAt
      bot.blockAt = (p) => (p.x > 40 ? null : flat(p))
    }
    const r = await goto({ x, z: 0 }, { answer, setup })
    assert.deepStrictEqual([r.reason, walks, walker.pathfinder.goal], ['stopped', 1, flee], `x ${x}`)
  }
})

test('a walk toward a target out of sight runs the doorway drill on a stalled hop, again only after it moved', async () => {
  let drills = 0
  let walker = null
  const doorwayCommit = async () => {
    if (++drills === 1) walker.entity.position = walker.entity.position.offset(3, 0, 0)
    return drills === 1
  }
  const r = await goto({ x: 12, y: 64, z: 0 }, {
    answer: update('success', [{ x: 1, y: 64, z: 0 }]),
    setup: (bot) => { walker = bot },
    over: { doorwayCommit, cellKnown: (p) => p.x < 10 }
  })
  assert.deepStrictEqual([r.reason, r.target, drills], ['stalled', { x: 12, y: 64, z: 0 }, 2])
})

test('a route clears its own goal when it ends', async () => {
  let walker = null
  const r = await goto({ x: 5, z: 5 }, { answer: arrive, setup: (bot) => { walker = bot } })
  assert.strictEqual(r.arrived, true)
  assert.strictEqual(walker.pathfinder.goal, null)
})

test('an early /goto reply leaves a goal someone else set alone', async () => {
  const follow = new goals.GoalNear(3, 64, 3, 2)
  let walker = null
  let stops = 0
  const setup = (bot) => {
    walker = bot
    bot.pathfinder.goal = follow
    bot.players.Steve = { entity: { position: new Vec3(13.3, 64, -2.6) } }
  }
  const r = await goto({ player: 'Steve' }, { setup, over: { entityPerceptible: () => false, stopPath () { stops++ } } })
  assert.deepStrictEqual([r.reason, stops, walker.pathfinder.goal], ['unseen', 0, follow])
})

test('a pilot stop while a drop is being picked up ends /collect before the next drop', async () => {
  for (const pilot of [false, true]) {
    const drops = [1, 2].map((id) => ({ id, name: 'item', position: new Vec3(id * 3 + 0.5, 63.85, 0.5) }))
    const walked = []
    const answer = (b, g) => {
      walked.push(g)
      arrive(b, g)
    }
    const setup = (b) => { b.entities = Object.fromEntries(drops.map((d) => [d.id, d])) }
    const nearestDrop = (radius, skip) => drops.find((d) => !skip.has(d.id)) || null
    const { env, bot, ctx } = walkBot({ answer, setup, over: { nearestDrop } })
    bot.waitForTicks = async () => { if (pilot) env.legs.take(null) }
    const route = ctx.walkRoute()
    let done
    try { done = await ctx.collectDrops(16, route) } finally { route.end() }
    if (!pilot) {
      assert.deepStrictEqual([done.reason, done.missed.length, walked.length], [null, 2, 2], 'control: both drops walked, neither picked up')
      continue
    }
    assert.deepStrictEqual([done.reason, done.missed.length, walked.length], ['stopped', 0, 1])
  }
})

test('a nudge ends when its route does and lets go of the controls', async () => {
  const controls = {}
  const env = {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, lookAt: async () => {}, setControlState: (k, v) => { controls[k] = v } },
    bunker: { building: false },
    swimUpUntil: 0,
    require,
    setTimeout
  }
  const { nudgeInto } = loadBotFunctions(['nudgeInto'], env)
  const t0 = performance.now()
  const route = { expired: () => performance.now() - t0 > 100, stopped: () => false }
  assert.strictEqual(await nudgeInto(new Vec3(5, 64, 0), true, 3000, route), false)
  assert.ok(performance.now() - t0 < 1000, `the nudge ran ${Math.round(performance.now() - t0)} ms past a 100 ms route`)
  assert.deepStrictEqual(controls, { forward: false, jump: false })
})

test('a retry pause never outlasts the route deadline', async () => {
  const asked = []
  const { pause } = loadBotFunctions(['pause'], { setTimeout: (fn, ms) => { asked.push(ms); setImmediate(fn) } })
  await pause({ left: () => 120 }, 350)
  await pause({ left: () => 280000 }, 350)
  assert.deepStrictEqual(asked, [120, 350])
})

test('airPrecheck calls a goal walled only when every cell its flood read is known', () => {
  // Two air rooms 2 blocks apart in stone: the bot stands in the first, the goal is in the second.
  const room = (p) => (p.y === 64 || p.y === 65) && p.z === 0 && ((p.x >= 0 && p.x <= 2) || (p.x >= 5 && p.x <= 7))
  const env = {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: (p) => (room(p) ? AIR : STONE) },
    cellKnown: () => true,
    ck: (x, y, z) => x + ',' + y + ',' + z,
    Vec3
  }
  const { airPrecheck } = loadBotFunctions(['airPrecheck'], env)
  assert.strictEqual(airPrecheck(new Vec3(6, 64, 0), 0).verdict, 'walled', 'control: every cell known')
  env.cellKnown = (p) => !(p.x === 3 && p.y === 64 && p.z === 0)
  assert.strictEqual(airPrecheck(new Vec3(6, 64, 0), 0).verdict, 'inconclusive')
})

test('a nametag shows only for a player who neither sneaks nor is invisible, within 64 blocks', () => {
  const { nametagVisible } = loadBotFunctions(['nametagVisible'], { bot: { entity: { position: new Vec3(0, 64, 0) } } })
  const player = (over) => ({ position: new Vec3(30, 64, 0), crouching: false, metadata: [0], ...over })
  assert.strictEqual(nametagVisible(player()), true, 'control')
  assert.strictEqual(nametagVisible(player({ crouching: true })), false, 'sneaking')
  assert.strictEqual(nametagVisible(player({ metadata: [0x20] })), false, 'invisible')
  assert.strictEqual(nametagVisible(player({ position: new Vec3(65, 64, 0) })), false, 'past 64')
})

test('a crumb records whether the player was in sight or known only by the nametag', () => {
  const env = {
    bot: { username: 'Claude', players: { Steve: { entity: { position: new Vec3(5, 64, 5) } } } },
    playerCrumbs: {},
    airFlood: () => ({}),
    entityPerceptible: () => true,
    nametagVisible: () => true,
    crumbCentre
  }
  const { recordCrumbs } = loadBotFunctions(['recordCrumbs'], env)
  recordCrumbs()
  assert.strictEqual(env.playerCrumbs.Steve.nametag, false, 'control: in sight')
  env.entityPerceptible = () => false
  recordCrumbs()
  assert.strictEqual(env.playerCrumbs.Steve.nametag, true)
})

test('a nametag crumb tells no two spots in one 5-block cube apart, from wherever the bot asks', () => {
  const env = { bot: { username: 'Claude', players: {} }, playerCrumbs: {}, airFlood: () => ({}), nametagVisible: () => true, crumbCentre }
  const { recordCrumbs, crumbFix } = loadBotFunctions(['recordCrumbs', 'crumbFix'], env)
  const fixes = (spot, inSight) => {
    env.bot.players.Steve = { entity: { position: spot } }
    env.entityPerceptible = () => inSight
    recordCrumbs()
    const c = env.playerCrumbs.Steve
    const out = []
    for (let x = -30; x <= 30; x += 3.7) for (let z = -30; z <= 30; z += 4.1) for (const y of [50, 64, 81]) {
      // Objects from the bot.js context carry its own Object prototype.
      const fix = JSON.parse(JSON.stringify(crumbFix(c, new Vec3(x, y, z))))
      delete fix.agoSec
      out.push(fix)
    }
    return out
  }
  const a = new Vec3(5.2, 64.9, 5.9)
  const b = new Vec3(9.8, 60.1, 5.1)
  assert.notDeepStrictEqual(fixes(a, true), fixes(b, true), 'control: crumbs from sight')
  assert.deepStrictEqual(fixes(a, false), fixes(b, false))
  assert.deepStrictEqual(cellOf(env.playerCrumbs.Steve.pos), { x: 7.5, y: 62.5, z: 7.5 })
})

test('a walk to a nametag crumb ends anywhere in its 5-block cube', () => {
  const crumb = { pos: crumbCentre(new Vec3(5.2, 64.9, 5.9)), nametag: true, agoSec: 3 }
  const r = resolveTarget({ player: 'Steve' }, sources({ crumb: () => crumb }))
  assert.ok(r.goal instanceof goals.GoalNear)
  for (let x = 5; x <= 9; x++) for (let y = 60; y <= 64; y++) for (let z = 5; z <= 9; z++) {
    assert.ok(r.goal.isEnd(new Vec3(x, y, z)), `${x},${y},${z}`)
  }
  assert.ok(!r.goal.isEnd(new Vec3(12, 62, 7)), 'control: a cell past the cube')
})

test('the last-seen fields of a nametag crumb give only a bearing and a distance rounded to 5', () => {
  const { crumbFix } = loadBotFunctions(['crumbFix'], {})
  const me = new Vec3(0.5, 64, 0.5)
  const crumb = (nametag) => ({ pos: new Vec3(13.3, 64, -2.6), t: Date.now() - 7000, nametag })
  // Objects from the bot.js context carry its own Object prototype.
  const fix = (c) => JSON.parse(JSON.stringify(crumbFix(c, me)))
  assert.deepStrictEqual(fix(crumb(false)), { lastSeen: { x: 13, y: 64, z: -3 }, agoSec: 7, dist: 13, bearing: 'E' }, 'control: a crumb from sight')
  assert.deepStrictEqual(fix(crumb(true)), { agoSec: 7, dist: 15, bearing: 'E' })
})

test('crumbs are dropped when the bot enters another dimension', () => {
  const env = { bot: { game: { dimension: 'overworld' }, entities: {} }, playerCrumbs: {}, crumbDimension: null, staleEntities: new Set(), resetThreatState () {} }
  const { forgetCrumbsElsewhere } = loadBotFunctions(['forgetCrumbsElsewhere'], env)
  forgetCrumbsElsewhere()
  env.playerCrumbs.Steve = { pos: new Vec3(5, 64, 5), t: Date.now() }
  forgetCrumbsElsewhere()
  assert.ok(env.playerCrumbs.Steve, 'control: a respawn in the same dimension')
  env.bot.game.dimension = 'the_nether'
  forgetCrumbsElsewhere()
  assert.deepStrictEqual(Object.keys(env.playerCrumbs), [])
})

test('/goto refuses a coordinate past the world border or outside the build height', async (t) => {
  const s = await startApp(t)
  const fine = ['x=29999999.5&z=-30000000', 'x=1&y=-64&z=1', 'x=1&y=319.9&z=1', 'x=1e-7&z=1']
  for (const q of fine) assert.strictEqual((await s.get('/goto?' + q)).status, 200, `control: ${q}`)
  for (const q of ['x=30000000&z=1', 'x=1&z=-30000001', 'x=1&y=320&z=1', 'x=1&y=-64.5&z=1', 'x=1&y=1e9&z=1', 'x=NaN&z=1', 'x=0x10&z=1', 'x=1&x=2&z=1']) {
    assert.strictEqual((await s.get('/goto?' + q)).status, 400, q)
  }
  assert.strictEqual(s.routeHits('/goto').length, fine.length)
})

test('the route deadline fires its stop once at 280 s', () => {
  const clock = fakeClock()
  let stops = 0
  const deadline = routeDeadline({ onExpire: () => stops++, clock })
  clock.advance(279999)
  assert.strictEqual(deadline.expired(), false, 'control: 1 ms before the deadline')
  assert.strictEqual(stops, 0)
  clock.advance(1)
  assert.strictEqual(stops, 1)
  assert.strictEqual(deadline.expired(), true)
  clock.advance(60000)
  assert.strictEqual(stops, 1)
})

test('a cancelled route deadline never fires', () => {
  const clock = fakeClock()
  let stops = 0
  const deadline = routeDeadline({ onExpire: () => stops++, clock })
  deadline.cancel()
  clock.advance(600000)
  assert.strictEqual(stops, 0)
  assert.strictEqual(deadline.expired(), false)
})
