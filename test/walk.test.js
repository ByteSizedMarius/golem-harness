'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { performance } = require('node:perf_hooks')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const walk = require('../lib/walk')
const { playerNamed, playersAround } = require('../lib/players')
const { summarizePlan, planRisk } = require('../lib/plan')
const { legLedger } = require('../lib/leg-ledger')
const { createDescribe } = require('../lib/bot/describe')
const { loadBotFunctions, botConstant, startApp, fakeClock } = require('./helpers')

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

test('a player walks to the live position in sight, to the centre of the nametag cube by the nametag, else to the last-seen crumb', () => {
  const steve = { position: { x: 5.3, y: 64, z: 5.7 } }
  const crumb = { pos: { x: 0.5, y: 64, z: 0.5 }, nametag: false, agoSec: 12 }
  const live = resolveTarget({ player: 'Steve' }, sources({ player: () => steve, crumb: () => crumb }))
  assert.deepStrictEqual(cellOf(live.cell), { x: 5, y: 64, z: 5 })
  const byTag = (player) => resolveTarget({ player: 'Steve', range: 1 }, sources({ player: () => player, crumb: () => crumb, known: () => false, nametag: () => true }))
  const tag = byTag(steve)
  assert.strictEqual(tag.nametag, true)
  assert.ok(tag.goal instanceof goals.GoalNear)
  assert.deepStrictEqual([tag.goal.x, tag.goal.y, tag.goal.z], [7, 62, 7], 'the cube centre, not the player\'s cell 5,64,5')
  assert.strictEqual(tag.goal.rangeSq, 16, 'range 1 is raised to reach every cell of the cube')
  const sameCube = byTag({ position: { x: 9.8, y: 61.2, z: 8.9 } })
  assert.deepStrictEqual([sameCube.goal.x, sameCube.goal.y, sameCube.goal.z, cellOf(sameCube.cell)], [7, 62, 7, cellOf(tag.cell)])
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

test('guarded work that throws at once rejects and leaves no watch, interval or deadline behind', async () => {
  const clock = fakeClock()
  const pathfinder = new EventEmitter()
  let stops = 0
  const thrown = new Error('thrown')
  const out = walk.guardWork(() => { throw thrown }, {
    position: () => ({ x: 0.5, y: 64, z: 0.5 }),
    onPathUpdate: (fn) => {
      pathfinder.on('path_update', fn)
      return () => pathfinder.off('path_update', fn)
    },
    stop: () => stops++,
    stallMs: 4500,
    thinkTimeout: 10000,
    budgetMs: 60000,
    clock
  })
  await assert.rejects(out, (e) => e === thrown)
  assert.strictEqual(pathfinder.listenerCount('path_update'), 0)
  assert.strictEqual(clock.pending(), 0)
  clock.advance(120000)
  assert.strictEqual(stops, 0, 'neither the stall watch nor the deadline stops later work')
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
  bot.entities = {}
  bot.blockAt = (p) => (p.y <= 63 ? STONE : AIR)
  setup(bot)
  Object.assign(env, {
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
    // A plan straight onto the goal cell.
    planPath: async (g) => ({ status: 'success', path: [new Vec3(g.x + 0.5, g.y, g.z + 0.5)] }),
    summarizePlan,
    planRisk,
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

test('a /goto that ends beside a goal cell a mob stands on replies adjacent, not arrived', async () => {
  // The mob on the goal cell keeps the body one block west of it.
  const pushed = (bot, g) => {
    bot.entity.position = new Vec3(g.x - 0.5, g.y, g.z + 0.5)
    bot.emit('goal_reached', g)
  }
  const r = await goto({ x: 5, z: 5 }, { answer: pushed })
  assert.deepStrictEqual([r.arrived, r.reason, r.adjacent, r.target], [false, 'not-reached', true, { x: 5, y: 64, z: 5 }])
  assert.strictEqual((await goto({ x: 5, z: 5 }, { answer: arrive })).adjacent, undefined, 'control: on the goal cell')
})

test('the /goto walk replies the position the server corrects the body to after arrival', async () => {
  const corrected = (bot, g) => {
    arrive(bot, g)
    setImmediate(() => {
      bot.entity.position = new Vec3(g.x + 0.2, g.y, g.z + 0.8)
      bot.emit('forcedMove')
    })
  }
  const r = await goto({ x: 5, z: 5 }, { answer: corrected })
  assert.deepStrictEqual([r.arrived, r.target, r.pos], [true, { x: 5, y: 64, z: 5 }, { x: 5.2, y: 64, z: 5.8 }])
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

// A player entity the server tracks, which bot.players does not list.
const steveAt = (position) => (bot) => { bot.entities[7] = { id: 7, type: 'player', username: 'Steve', position } }

test('a hidden player stays hidden in the /goto reply, and one known by the nametag gets only a bearing and a rough distance', async () => {
  const setup = steveAt(new Vec3(13.3, 64, -2.6))
  assert.deepStrictEqual(await goto({ player: 'Steve' }, { setup, over: { entityPerceptible: () => false } }),
    { arrived: false, kind: 'player', target: { player: 'Steve' }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: null, reason: 'unseen', hint: null })
  const tagged = { arrived: false, kind: 'player', target: { player: 'Steve' }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: 10, reason: 'no-path', hint: null, bearing: 'E' }
  assert.deepStrictEqual(await goto({ player: 'Steve' }, { setup, over: { entityPerceptible: () => false, nametagVisible: () => true }, answer: update('noPath') }), tagged)
  const walled = { entityPerceptible: () => false, nametagVisible: () => true, airPrecheck: () => ({ verdict: 'walled' }) }
  assert.deepStrictEqual(await goto({ player: 'Steve' }, { setup, over: walled, answer: update('noPath') }), tagged, 'no precheck reads the hidden cell')
})

test('a player known last by the nametag stays a bearing and a rough distance, and a crumb reply carries its age', async () => {
  const crumbs = (nametag) => ({ Steve: { pos: new Vec3(13.3, 64, -2.6), t: Date.now() - 7000, nametag } })
  const seen = await goto({ player: 'Steve' }, { over: { playerCrumbs: crumbs(false) }, answer: update('noPath') })
  assert.deepStrictEqual([seen.target, seen.dist, seen.agoSec], [{ x: 13, y: 64, z: -3 }, 13.3, 7], 'control: a crumb from sight')
  assert.deepStrictEqual(await goto({ player: 'Steve' }, { over: { playerCrumbs: crumbs(true) }, answer: update('noPath') }),
    { arrived: false, kind: 'player', target: { player: 'Steve' }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: 10, reason: 'no-path', hint: null, bearing: 'E', agoSec: 7 })
})

test('a walk toward a nametag aims each hop at the cube the nametag shows in now, and ends at its centre', async () => {
  const tagOnly = { entityPerceptible: () => false, nametagVisible: () => true }
  const goals_ = []
  let player = null
  const answer = (bot, g) => {
    goals_.push({ x: g.x, z: g.z })
    // The player walks south while the first hop runs.
    if (goals_.length === 1) player.position = new Vec3(60.5, 64, 40.5)
    arrive(bot, g)
  }
  const setup = (bot) => {
    steveAt(new Vec3(60.5, 64, 0.5))(bot)
    player = bot.entities[7]
  }
  const r = await goto({ player: 'Steve' }, { setup, answer, over: tagOnly })
  assert.strictEqual(r.arrived, true)
  assert.ok(goals_.length >= 3, `${goals_.length} goals`)
  assert.ok(Math.abs(goals_[0].z) < 1, 'control: the first hop heads east')
  assert.ok(goals_[1].z > 5, `the second hop turns toward the player, z ${goals_[1].z}`)
  assert.deepStrictEqual(goals_[goals_.length - 1], { x: 62, z: 42 }, 'the cube centre, not the player at 60,40')
  assert.deepStrictEqual(Object.keys(r).sort(), ['arrived', 'bearing', 'dist', 'hint', 'kind', 'pos', 'reason', 'target'])
  assert.deepStrictEqual(r.target, { player: 'Steve' })
})

test('the reply about a player known now by the nametag tells no two spots in one 5-block cube apart', async () => {
  const tagOnly = { entityPerceptible: () => false, nametagVisible: () => true }
  const replyFor = async (spot) => {
    const r = await goto({ player: 'Steve' }, { setup: steveAt(spot), over: tagOnly, answer: update('noPath') })
    return [r.dist, r.bearing, r.target]
  }
  assert.notDeepStrictEqual(await replyFor(new Vec3(5.2, 64, 5.9)), await replyFor(new Vec3(12.2, 64, 12.9)), 'control: two cubes')
  assert.deepStrictEqual(await replyFor(new Vec3(5.2, 64, 5.9)), await replyFor(new Vec3(9.8, 64, 5.1)))
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

test('a walk wedged at a door the drill could not cross replies door, naming the door and why', async () => {
  const stuck = { door: { name: 'oak_door', x: -308, y: 63, z: 81 }, through: false, why: 'did not let me through from the west after 2 tries' }
  const answer = update('success', [{ x: 1, y: 64, z: 0 }])
  const r = await goto({ x: 5, z: 5 }, { answer, over: { doorwayCommit: async () => stuck } })
  assert.strictEqual(r.reason, 'door')
  assert.match(r.hint, /oak_door at -308,63,81 did not let me through from the west after 2 tries/)
  const through = await goto({ x: 5, z: 5 }, { answer, over: { doorwayCommit: async () => ({ ...stuck, through: true }) } })
  assert.strictEqual(through.reason, 'stalled', 'control: a door the drill crossed')
})

const HINTS = { 'no-path': 'no known way there', 'unseen-way': 'the way there runs through cells I have not seen', stalled: 'goal is likely unreachable without digging', 'boxed-in': 'dig out deliberately' }

test('a /goto that found no way replies what blocks it, else the general hint', async () => {
  const dark = 'too dark for me past 2,64,0: a torch there would light the way'
  const asked = []
  const wayHint = (r, edge) => { asked.push(edge && { ...edge }); return dark }
  const noPath = (over) => goto({ x: 5, z: 5 }, { answer: update('noPath'), over: { WALK_HINTS: HINTS, ...over } })
  assert.strictEqual((await noPath({})).hint, HINTS['no-path'], 'control: nothing to name')
  assert.strictEqual((await noPath({ wayHint })).hint, dark)
  const pillar = (bot) => { bot.blockAt = (p) => (p.y <= 63 || (p.x === 1 && p.z === 0) ? STONE : AIR) }
  const unseen = (over) => goto({ x: 1, y: 40, z: 0 }, { setup: pillar, over: { WALK_HINTS: HINTS, cellKnown: (p) => p.y >= 60, ...over } })
  assert.strictEqual((await unseen({})).hint, HINTS['unseen-way'], 'control: nothing to name')
  const r = await unseen({ wayHint })
  assert.deepStrictEqual([r.reason, r.hint, asked[asked.length - 1]], ['unseen-way', dark, r.edge])
})

test('a stalled or boxed-in /goto whose body is inside a block names it', async () => {
  const insideBlock = () => ({ name: 'cobblestone_wall', x: 0, y: 64, z: 0 })
  const inside = 'I am inside the cobblestone_wall at 0,64,0: step or dig out of it'
  const stalled = (over) => goto({ x: 5, z: 5 }, { answer: update('success', [{ x: 1, y: 64, z: 0 }]), over: { WALK_HINTS: HINTS, ...over } })
  const boxed = (over) => goto({ x: 5, z: 5 }, { over: { WALK_HINTS: HINTS, hasLegalMove: () => false, ...over } })
  assert.deepStrictEqual([(await stalled({})).hint, (await boxed({})).hint], [HINTS.stalled, HINTS['boxed-in']], 'control: free of blocks')
  assert.deepStrictEqual([(await stalled({ insideBlock })).hint, (await boxed({ insideBlock })).hint], [inside, inside])
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
    steveAt(new Vec3(13.3, 64, -2.6))(bot)
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

test('the goto precheck calls a goal walled only when every cell its flood read is known, else names the unseen edge', () => {
  // Two air rooms in stone, joined at x 3 and 4 by a tunnel when open.
  const tunnel = (p) => (p.x === 3 || p.x === 4) && p.z === 0 && (p.y === 64 || p.y === 65)
  const room = (p) => (p.y === 64 || p.y === 65) && p.z === 0 && ((p.x >= 0 && p.x <= 2) || (p.x >= 5 && p.x <= 7))
  let open = false
  const env = {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: (p) => (room(p) || (open && tunnel(p)) ? AIR : STONE) },
    cellKnown: () => true,
    heldLight: (p, b) => b,
    ck: (x, y, z) => x + ',' + y + ',' + z,
    Vec3
  }
  const { airPrecheck } = loadBotFunctions(['airPrecheck'], env)
  const precheck = () => {
    const { verdict, edge, cells } = airPrecheck(new Vec3(6, 64, 0), 0)
    return { verdict, edge: edge && edge.toString(), cells }
  }
  assert.strictEqual(precheck().verdict, 'walled', 'control: every cell known')
  env.cellKnown = (p) => !(p.x === 3 && p.y === 64 && p.z === 0)
  const pre = precheck()
  assert.deepStrictEqual([pre.verdict, pre.edge], ['unseen', '(2, 64, 0)'])
  env.cellKnown = (p) => !tunnel(p)
  const sealed = precheck()
  open = true
  assert.deepStrictEqual(precheck(), sealed, 'an unseen tunnel reads the same open or sealed')
  env.cellKnown = () => true
  assert.strictEqual(precheck().verdict, 'connected', 'control: an open tunnel in sight')
})

test('a /goto whose known way leaves the precheck radius is walked, not refused as walled', async () => {
  // Corridors in stone: west from the bot along z 0, back east along z 2 to the goal, joined at x -31 when open.
  // The precheck floods 30 blocks round the bot.
  const corridor = (p) => (p.y === 64 || p.y === 65) && ((p.z === 0 && p.x >= -30 && p.x <= 0) || (p.z === 2 && p.x >= -31 && p.x <= 6))
  const joint = (p) => p.x === -31 && (p.y === 64 || p.y === 65) && p.z >= 0 && p.z <= 1
  const replyFor = (open) => {
    let precheck = null
    const setup = (bot) => {
      bot.blockAt = (p) => (corridor(p) || (open && joint(p)) ? AIR : STONE)
      precheck = loadBotFunctions(['airPrecheck'], { bot, cellKnown: () => true, heldLight: (p, b) => b, ck: (x, y, z) => x + ',' + y + ',' + z, Vec3 }).airPrecheck
    }
    return goto({ x: 6, y: 64, z: 2 }, { setup, answer: open ? arrive : update('noPath'), over: { cellKnown: () => true, airPrecheck: (...a) => precheck(...a) } })
  }
  assert.strictEqual((await replyFor(false)).reason, 'walled', 'control: the west corridor ends in known stone at the radius')
  assert.strictEqual((await replyFor(true)).arrived, true)
})

test('a /goto walks past open ground it has not seen, and the same way under rock replies unseen-way', async () => {
  // The bot has seen the ground round itself at x -2 to 1 and round the goal at x 5 to 8. A hill stands beside the way at x 2 to 4.
  const hill = (p) => p.x >= 2 && p.x <= 4 && p.z >= 2 && p.z <= 4 && p.y <= 66
  const cellKnown = (p) => Math.abs(p.z) <= 2 && p.y >= 63 && p.y <= 67 && ((p.x >= -2 && p.x <= 1) || (p.x >= 5 && p.x <= 8))
  const replyFor = (underRock) => {
    const solid = (p) => p.y <= 63 || hill(p) || (underRock && p.y >= 66)
    let precheck = null
    const setup = (bot) => {
      bot.blockAt = (p) => ({ ...(solid(p) ? STONE : AIR), skyLight: underRock || solid(p) ? 0 : 15 })
      precheck = loadBotFunctions(['airPrecheck'], { bot, cellKnown, heldLight: (p, b) => b, ck: (x, y, z) => x + ',' + y + ',' + z, Vec3 }).airPrecheck
    }
    return goto({ x: 6, y: 64, z: 0 }, { setup, answer: arrive, over: { cellKnown, airPrecheck: (...a) => precheck(...a) } })
  }
  assert.strictEqual((await replyFor(false)).arrived, true)
  const buried = await replyFor(true)
  assert.deepStrictEqual([buried.arrived, buried.reason, buried.edge], [false, 'unseen-way', { x: 1, y: 64, z: 0 }])
})

test('a /goto into a rock column beside the bot replies no-floor only when it knows the column, else unseen-way with the target as edge', async () => {
  const pillar = (bot) => { bot.blockAt = (p) => (p.y <= 63 || (p.x === 1 && p.z === 0) ? STONE : AIR) }
  const known = await goto({ x: 1, y: 40, z: 0 }, { setup: pillar })
  assert.strictEqual(known.reason, 'no-floor', 'control: every cell of the column known')
  const unseen = await goto({ x: 1, y: 40, z: 0 }, { setup: pillar, over: { cellKnown: (p) => p.y >= 60 } })
  assert.deepStrictEqual([unseen.arrived, unseen.reason, unseen.edge], [false, 'unseen-way', { x: 1, y: 40, z: 0 }])
})

test('a /goto to x and z beside a column it has not seen names that column as edge, without a y', async () => {
  const describe = {}
  createDescribe(describe)
  const pillar = (bot) => { bot.blockAt = (p) => (p.y <= 63 || (p.x === 1 && p.z === 0) ? STONE : AIR) }
  const known = await goto({ x: 1, z: 0 }, { setup: pillar, over: { round: describe.round } })
  assert.strictEqual(known.reason, 'no-floor', 'control: every cell of the column known')
  const unseen = await goto({ x: 1, z: 0 }, { setup: pillar, over: { cellKnown: (p) => p.y >= 60, round: describe.round } })
  assert.deepStrictEqual([unseen.reason, unseen.target, unseen.edge], ['unseen-way', { x: 1, z: 0 }, { x: 1, z: 0 }])
})

test('a nametag shows only for a player who neither sneaks nor is invisible, within 64 blocks', () => {
  const { nametagVisible } = loadBotFunctions(['nametagVisible'], { bot: { entity: { position: new Vec3(0, 64, 0) } } })
  const player = (over) => ({ position: new Vec3(30, 64, 0), crouching: false, metadata: [0], ...over })
  assert.strictEqual(nametagVisible(player()), true, 'control')
  assert.strictEqual(nametagVisible(player({ crouching: true })), false, 'sneaking')
  assert.strictEqual(nametagVisible(player({ metadata: [0x20] })), false, 'invisible')
  assert.strictEqual(nametagVisible(player({ position: new Vec3(65, 64, 0) })), false, 'past 64')
})

test('an invisible player in plain sight is not seen', () => {
  const fill = { cells: new Set(['3,64,0']) }
  const env = { bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: () => null }, touchesFill: () => false, ck: (x, y, z) => x + ',' + y + ',' + z }
  const { entityPerceptible } = loadBotFunctions(['entityPerceptible'], env)
  const at = (over) => ({ type: 'player', username: 'Steve', position: new Vec3(3.5, 64, 0.5), metadata: [0], ...over })
  assert.strictEqual(entityPerceptible(at(), fill), true, 'control: shared air')
  assert.strictEqual(entityPerceptible(at({ metadata: [0x20] }), fill), false)
})

const steve = (position) => ({ id: 7, type: 'player', username: 'Steve', position })

// recordCrumbs over bot.entities, with bot.players empty.
const crumbEnv = (over) => ({ bot: { username: 'Claude', players: {}, entities: {} }, playerCrumbs: {}, playersAround, staleEntities: new Set(), reflexes: [{ name: 'combat', fairFill: () => ({}) }], crumbCentre, ...over })

test('a crumb records whether the player was in sight or known only by the nametag', () => {
  const env = {
    bot: { username: 'Claude', players: {}, entities: { 7: steve(new Vec3(5, 64, 5)) } },
    playerCrumbs: {},
    playersAround,
    staleEntities: new Set(),
    reflexes: [{ name: 'combat', fairFill: () => ({}) }],
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
  const env = crumbEnv({ nametagVisible: () => true })
  const { recordCrumbs, crumbFix } = loadBotFunctions(['recordCrumbs', 'crumbFix'], env)
  const fixes = (spot, inSight) => {
    env.bot.entities[7] = steve(spot)
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

test('after a dimension change, a player entity the server has not updated since leaves no crumb', () => {
  const env = crumbEnv({ bot: { username: 'Claude', players: {}, entities: { 7: steve(new Vec3(5, 64, 5)) }, game: { dimension: 'overworld' } }, crumbDimension: null, entityPerceptible: () => true, nametagVisible: () => true, resetThreatState () {} })
  const { recordCrumbs, forgetCrumbsElsewhere } = loadBotFunctions(['recordCrumbs', 'forgetCrumbsElsewhere'], env)
  env.crumbDimension = 'overworld'
  recordCrumbs()
  assert.ok(env.playerCrumbs.Steve, 'control: a player in the same dimension')
  env.bot.game.dimension = 'the_nether'
  forgetCrumbsElsewhere()
  recordCrumbs()
  assert.deepStrictEqual(Object.keys(env.playerCrumbs), [])
  // An entity update from the server marks it current again.
  env.staleEntities.delete(7)
  recordCrumbs()
  assert.ok(env.playerCrumbs.Steve)
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

// stagedGoto with its walk options, counting the goals the walk set.
async function plannedGoto (q, walkOpts, opts = {}) {
  const set = []
  const answer = opts.answer || (() => {})
  const { ctx } = walkBot({ ...opts, answer: (b, g, env) => { set.push(g); answer(b, g, env) } })
  const route = ctx.walkRoute()
  try {
    return { r: JSON.parse(JSON.stringify(await ctx.stagedGoto(q, route, walkOpts))), walks: set.length }
  } finally { route.end() }
}

test('a preview answers the plan and walks nothing', async () => {
  const { r, walks } = await plannedGoto({ x: 5, z: 5 }, { preview: true })
  assert.strictEqual(walks, 0)
  assert.deepStrictEqual(r, {
    arrived: false, kind: 'coordinate', target: { x: 5, y: 64, z: 5 }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: 7.1, reason: null, hint: null,
    plan: { reaches: true, length: 7.1, rise: 0, drop: 0, end: { x: 5, y: 64, z: 5 }, unseen: false }
  })
  const unloaded = (bot) => { bot.blockAt = (p) => (p.x > 40 ? null : p.y <= 63 ? STONE : AIR) }
  const far = await plannedGoto({ x: 300, y: 70, z: -40 }, { preview: true }, { setup: unloaded })
  assert.deepStrictEqual([far.walks, far.r.reason, far.r.plan], [0, 'unresolved', null], 'an unloaded target has no plan yet')
})

test('a goto refuses a plan that ends far from the y asked or drops more than 3, without a step, and accept walks it', async () => {
  const cliff = async (g) => ({ status: 'success', path: [new Vec3(1.5, 64, 0.5), new Vec3(2.5, 59, 0.5), new Vec3(g.x + 0.5, g.y, g.z + 0.5)] })
  const refused = await plannedGoto({ x: 5, z: 5 }, {}, { over: { planPath: cliff }, answer: arrive })
  assert.deepStrictEqual([refused.walks, refused.r.arrived, refused.r.reason, refused.r.risk, refused.r.plan.drop], [0, false, 'risky', 'it drops 5 blocks at once', 5])
  const high = await plannedGoto({ x: 5, y: 70, z: 5 }, {}, { answer: arrive })
  assert.deepStrictEqual([high.walks, high.r.reason, high.r.risk], [0, 'risky', 'it ends 6 below the y asked'], 'the floor of that column lies 6 under the y asked')
  const near = await plannedGoto({ x: 5, y: 66, z: 5 }, {}, { answer: arrive })
  assert.deepStrictEqual([near.walks, near.r.arrived], [1, true], 'control: 2 above the floor')
  let planned = 0
  const accepted = await plannedGoto({ x: 5, z: 5 }, { accept: true }, { over: { planPath: async (g) => { planned++; return cliff(g) } }, answer: arrive })
  assert.deepStrictEqual([accepted.walks, accepted.r.arrived, planned], [1, true, 0])
})

test('a preview through terrain the bot has not seen reports only the part it knows', async () => {
  // The plan steps east, then drops 5 into a cave the bot never saw from x 3 on.
  const cave = async () => ({ status: 'success', path: [1, 2, 3, 4, 5].map((x) => new Vec3(x + 0.5, x < 3 ? 64 : 59, 0.5)) })
  const seen = { cellKnown: (p) => p.x < 3, knownCell: (p) => p.x < 3 }
  const { r, walks } = await plannedGoto({ x: 5, z: 0 }, { preview: true }, { over: { planPath: cave, ...seen } })
  assert.strictEqual(walks, 0)
  assert.deepStrictEqual(r.target, { x: 5, z: 0 }, 'the target cell is unseen')
  assert.deepStrictEqual(r.plan, { reaches: null, length: 2, rise: 0, drop: 0, end: { x: 2, y: 64, z: 0 }, unseen: true })
  assert.ok(!JSON.stringify(r).includes('59'), 'the cave floor stays hidden')
  const walked = await plannedGoto({ x: 5, z: 0 }, {}, { over: { planPath: cave, ...seen }, answer: arrive })
  assert.deepStrictEqual([walked.walks, walked.r.reason], [1, null], 'the hidden drop raises no refusal')
})

test('a preview of a failed search leaves reaches unknown, since unseen terrain may still hold a way', async () => {
  const failed = async () => ({ status: 'noPath', path: [new Vec3(1.5, 64, 0.5), new Vec3(2.5, 64, 0.5)] })
  const { r } = await plannedGoto({ x: 5, z: 0 }, { preview: true }, { over: { planPath: failed, cellKnown: (p) => p.x < 3 } })
  assert.deepStrictEqual(r.plan, { reaches: null, length: 2, rise: 0, drop: 0, end: { x: 2, y: 64, z: 0 }, unseen: false })
})

test('a player known only by the nametag gets no plan, so neither a preview nor a refusal shows where they stand', async () => {
  const setup = steveAt(new Vec3(13.3, 64, -2.6))
  let planned = 0
  const planPath = async (g) => { planned++; return { status: 'success', path: [new Vec3(g.x + 0.5, g.y, g.z + 0.5)] } }
  const seen = await plannedGoto({ player: 'Steve' }, { preview: true }, { setup, over: { planPath } })
  assert.deepStrictEqual([seen.r.plan.end, planned], [{ x: 13, y: 64, z: -3 }, 1], 'control: a player in sight')
  const tagged = { entityPerceptible: () => false, nametagVisible: () => true, planPath }
  const { r } = await plannedGoto({ player: 'Steve' }, { preview: true }, { setup, over: tagged })
  assert.deepStrictEqual(r, { arrived: false, kind: 'player', target: { player: 'Steve' }, pos: { x: 0.5, y: 64, z: 0.5 }, dist: 10, reason: 'unresolved', hint: r.hint, bearing: 'E', plan: null })
  const walked = await plannedGoto({ player: 'Steve' }, {}, { setup, over: tagged, answer: update('noPath') })
  assert.deepStrictEqual([walked.r.reason, planned], ['no-path', 1], 'the walk toward a nametag plans nothing up front')
})
