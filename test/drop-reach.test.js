'use strict'
// The routes pick up every drop of their own digs that a player in an open cell of the site would, and nothing more.
const test = require('node:test')
const assert = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const gotoGoal = require('mineflayer-pathfinder/lib/goto')
const { goals } = require('mineflayer-pathfinder')
const { Physics, PlayerState } = require('prismarine-physics')
const { CollectBlock } = require('mineflayer-collectblock/lib/CollectBlock')
const { Targets } = require('mineflayer-collectblock/lib/Targets')
const walk = require('../lib/walk')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { awaitRoute, botConstant, loadBotFunctions, timed, walkingBody } = require('./helpers')

const { resolveTarget, guardWork } = walk

// The 1.7.10 server's pickup: the body's box grown by 1, 0.5 and 1 overlaps the 0.25 item box, whose y is its bottom.
const picksUp = (feet, item) => Math.abs(item.x - feet.x) < 1.425 && Math.abs(item.z - feet.z) < 1.425 && item.y + 0.25 > feet.y - 0.5 && item.y < feet.y + 2.3

let ids = 1000
const STONE = ['stone', {}]
const AIR = ['air', {}]

// Each tick the fake server picks up every item the body reaches at e.server, else at e.position.
async function site (t, pos, cells) {
  const { bot } = await walkingBody(t, pos, cells)
  const world = { getBlock: (p) => bot.blockAt(p) }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const look = async (yaw, pitch) => { Object.assign(bot.entity, { yaw, pitch }) }
  Object.assign(bot.entity, { yaw: 0, pitch: 0, effects: {}, attributes: {}, isCollidedHorizontally: false })
  const picked = []
  Object.assign(bot, {
    physics: Physics(bot.registry, world),
    jumpTicks: 0,
    jumpQueued: false,
    food: 20,
    controlState: controls,
    setControlState (k, v) { controls[k] = v },
    getControlState: (k) => controls[k],
    sprintFacing: () => true,
    clearControlStates () { for (const k in controls) controls[k] = false },
    faceWalk () {},
    look,
    lookAt: (p) => {
      const d = p.minus(bot.entity.position.offset(0, 1.62, 0))
      return look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)))
    },
    inventory: { items: () => [], slots: [] },
    waitForTicks: (n) => new Promise((resolve) => {
      let left = n
      const on = () => {
        if (--left > 0) return
        bot.removeListener('physicsTick', on)
        resolve()
      }
      bot.on('physicsTick', on)
    })
  })
  let running = true
  const tick = () => {
    if (!running) return
    bot.physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot)
    for (const e of Object.values(bot.entities)) {
      if (!picksUp(bot.entity.position, e.server ?? e.position)) continue
      delete bot.entities[e.id]
      picked.push(e)
      bot.emit('playerCollect', bot.entity, e)
      bot.emit('entityGone', e)
    }
    bot.emit('physicsTick')
    setImmediate(tick)
  }
  const stop = () => { running = false }
  t.after(stop)
  setImmediate(tick)
  return { bot, picked, stop }
}

function itemAt (bot, x, y, z) {
  const e = { id: ++ids, name: 'item', position: new Vec3(x, y, z), isValid: true }
  bot.entities[e.id] = e
  return e
}

// bot.pathfinder.goto as lib/bot/connection.js installs it, over the real pathfinder.
function legsOn (bot) {
  const env = {
    bot,
    require,
    goals,
    Vec3,
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    guardWork,
    GoalPickup: walk.GoalPickup,
    pickupCovers: walk.pickupCovers,
    pickupStep: walk.pickupStep,
    PICKUP_STEP_TICKS: botConstant('PICKUP_STEP_TICKS'),
    PICKUP_STEP_MARGIN: botConstant('PICKUP_STEP_MARGIN'),
    PICKUP_WAIT_TICKS: botConstant('PICKUP_WAIT_TICKS'),
    watchScope: new AsyncLocalStorage(),
    cellKnown: () => true,
    console: { log: () => {} },
    reflexes: [{ name: 'unstuck', active: false }],
    litFuse: () => null
  }
  const { watchGoto } = loadBotFunctions(['watchGoto', 'stopPath'], env)
  return watchGoto((g) => gotoGoal(bot, g))
}

// collectblock's walk to drop: 'resolved' or the error name, and whether the server picked drop up.
async function collectWalk (s, drop) {
  const goto = legsOn(s.bot)
  const { out } = await timed(goto(new goals.GoalFollow(drop, 0)).then(() => 'resolved', (e) => e.name), 8000)
  s.stop()
  return { out, picked: s.picked.includes(drop), at: s.bot.entity.position.toString() }
}

const SIDES = { 'x+': [1, 0], 'z+': [0, 1], 'x-': [-1, 0], 'z-': [0, -1] }

// A 3-high stone block the body can't climb, with a closed 1-wide corridor on side of 0,64,0 and that cell dug out.
function niche ([sx, sz]) {
  const cells = {}
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = 64; y <= 66; y++) cells[`${x},${y},${z}`] = STONE
  for (let k = -3; k <= 3; k++) {
    for (let y = 64; y <= 66; y++) cells[sx ? `${sx},${y},${k}` : `${k},${y},${sz}`] = AIR
  }
  cells['0,64,0'] = AIR
  return cells
}

// The niche's drop as the live run left it: 0.19 from the niche's back wall, 0.78 along the corridor.
const nicheDrop = (bot, [sx, sz]) => itemAt(bot, sx ? 0.5 - 0.31 * sx : 0.78, 63.97, sz ? 0.5 - 0.31 * sz : 0.78)

test('collectblock\'s walk to a drop in a 1-high niche beside a corridor ends where the body picks it up, on every side', async (t) => {
  for (const [label, side] of Object.entries(SIDES)) {
    const [sx, sz] = side
    // Two cells along the corridor from the niche.
    const s = await site(t, sx ? new Vec3(sx + 0.5, 64, 2.5) : new Vec3(2.5, 64, sz + 0.5), niche(side))
    const r = await collectWalk(s, nicheDrop(s.bot, side))
    assert.deepStrictEqual([r.out, r.picked], ['resolved', true], `${label}: the body ended at ${r.at}`)
  }
})

test('collectblock\'s walk to a niche drop from a body stopped 1.50 off it on one axis, in a cell that reaches it, steps in and picks it up', async (t) => {
  // The edge of the corridor cell 0,64,1 where the gather walks of the live run stopped.
  const s = await site(t, new Vec3(0.78, 64, 1.69), niche([0, 1]))
  const drop = nicheDrop(s.bot, [0, 1])
  assert.ok(!picksUp(s.bot.entity.position, drop.position), 'control: the body starts outside the pickup box')
  const r = await collectWalk(s, drop)
  assert.deepStrictEqual([r.out, r.picked], ['resolved', true], `the body ended at ${r.at}`)
  const feet = s.bot.entity.position.floored()
  assert.deepStrictEqual([feet.x, feet.z], [0, 1], `the step stays inside the cell, at ${r.at}`)
})

test('collectblock\'s walk to a niche drop the server holds 0.1 further off than the client shows steps to the point of its cell nearest the drop and picks it up', async (t) => {
  const s = await site(t, new Vec3(0.78, 64, 1.69), niche([0, 1]))
  const drop = nicheDrop(s.bot, [0, 1])
  // The 1.7.10 server sends an item's move once it adds up to 4/32 of a block.
  drop.server = drop.position.offset(0, 0, -0.1)
  const r = await collectWalk(s, drop)
  assert.deepStrictEqual([r.out, r.picked], ['resolved', true], `the body ended at ${r.at}`)
})

test('collectblock\'s walk to a drop the client still shows where it spawned, which the server has out of reach, ends out of reach', async (t) => {
  const s = await site(t, new Vec3(0.5, 64, 0.5), {})
  const drop = itemAt(s.bot, 1.5, 64.4, 0.5)
  drop.server = new Vec3(3.7, 63.97, 0.5)
  const r = await collectWalk(s, drop)
  assert.deepStrictEqual([r.out, r.picked], ['OutOfReach', false], `the body ended at ${r.at}`)
})

test('collectblock\'s walk to a drop in a pocket only a wall corner joins to the corridor finds no path and leaves it', async (t) => {
  // A closed corridor at z 1 from x -3 to 0 and the pocket 1,64,0, diagonal from its end cell.
  const cells = niche([0, 1])
  for (let x = 1; x <= 3; x++) for (let y = 64; y <= 66; y++) cells[`${x},${y},1`] = STONE
  cells['0,64,0'] = STONE
  cells['1,64,0'] = AIR
  const s = await site(t, new Vec3(-1.5, 64, 1.5), cells)
  const drop = itemAt(s.bot, 1.2, 63.97, 0.8)
  assert.ok(picksUp(new Vec3(0.7, 64, 1.3), drop.position), 'control: the box reaches it from the corridor\'s end cell')
  assert.deepStrictEqual(await collectWalk(s, drop), { out: 'NoPath', picked: false, at: s.bot.entity.position.toString() })
})

// The pathfinder's search from inside the room ends in an empty path, which resolves goto where the body stands.
test('collectblock\'s walk to a drop on a column top above the pickup box from every cell around it ends out of reach and leaves it', async (t) => {
  const cells = {}
  // A room 5 wide, its 3-high walls out of the body's reach, with a 4-high stone column in the middle.
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 64; y <= 66; y++) if (Math.max(Math.abs(x), Math.abs(z)) === 3) cells[`${x},${y},${z}`] = STONE
  for (let y = 64; y <= 67; y++) cells[`0,${y},0`] = STONE
  const s = await site(t, new Vec3(-1.5, 64, 0.5), cells)
  const drop = itemAt(s.bot, 0.5, 67.97, 0.5)
  assert.deepStrictEqual(await collectWalk(s, drop), { out: 'OutOfReach', picked: false, at: s.bot.entity.position.toString() })
})

// ---- the drop chase's target ----

const block = (name, boundingBox, height) => ({ name, boundingBox, shapes: height ? [[0, 0, 0, 1, height, 1]] : [] })
const solid = block('stone', 'block', 1)
const open = block('air', 'empty')

// blockAt over the niche of side, unloaded past 8.
function nicheAt (side) {
  const cells = niche(side)
  return (p) => {
    if (Math.max(Math.abs(p.x), Math.abs(p.z)) > 8) return null
    const c = cells[`${p.x},${p.y},${p.z}`]
    return c ? (c[0] === 'stone' ? solid : open) : p.y <= 63 ? solid : open
  }
}

const sourcesAt = (side, here, over = {}) => ({
  blockAt: nicheAt(side),
  column: { minY: 50, maxY: 80 },
  waypoint: () => null,
  player: () => null,
  crumb: () => null,
  known: () => true,
  nametag: () => false,
  visibleBlock: () => null,
  cellKnown: () => true,
  seenNow: () => true,
  feetY: here.y,
  here,
  ...over
})

test('a niche drop resolves to a goal that ends in the corridor cell beside it, and not on the wall top over it', () => {
  const side = [0, 1]
  const drop = { position: new Vec3(0.78, 63.97, 0.19) }
  const r = resolveTarget({ drop }, sourcesAt(side, new Vec3(2.5, 64, 1.5)))
  assert.ok(r.goal, `no goal: ${JSON.stringify(r)}`)
  assert.ok(r.goal.isEnd(new Vec3(0, 64, 1)), 'the corridor cell beside the niche')
  assert.ok(!r.goal.isEnd(new Vec3(0, 67, 0)), 'the wall top over the niche')
  assert.deepStrictEqual(r.target, { x: 1, y: 64, z: 1 }, 'the end cell nearest the body')
})

test('the pickup goal ends in a cell whose body, kept 0.3 inside it, comes within 1.325 of the item on x and z, and within the box\'s height', () => {
  const blockAt = (p) => (p.y <= 63 ? solid : open)
  const ends = (x, y, z) => new walk.GoalPickup({ position: new Vec3(x, y, z) }, { blockAt }).isEnd(new Vec3(0, 64, 0))
  assert.deepStrictEqual([ends(2.02, 63.97, 0.5), ends(2.03, 63.97, 0.5)], [true, false], 'x past the cell')
  assert.deepStrictEqual([ends(0.5, 63.97, -1.02), ends(0.5, 63.97, -1.03)], [true, false], 'z before the cell')
  assert.ok(ends(2.02, 63.97, 2.02), 'both axes at once, 2.0 off on the diagonal')
  assert.deepStrictEqual([ends(0.5, 66.19, 0.5), ends(0.5, 66.21, 0.5)], [true, false], 'up to 2.325 over the feet')
  assert.deepStrictEqual([ends(0.5, 63.36, 0.5), ends(0.5, 63.34, 0.5)], [true, false], 'down to 0.525 under the feet')
})

test('a drop the eye ray misses counts as seen when the route says it watched it break', () => {
  const side = [0, 1]
  const drop = { position: new Vec3(0.78, 63.97, 0.19) }
  const blind = sourcesAt(side, new Vec3(2.5, 64, 1.5), { known: () => false })
  assert.strictEqual(resolveTarget({ drop }, blind).reason, 'unseen', 'control: unseen without the route')
  assert.ok(resolveTarget({ drop, watched: () => true }, blind).goal)
  assert.strictEqual(resolveTarget({ drop, watched: () => false }, blind).reason, 'unseen')
})

// ---- /mine over collectblock with a fake pathfinder and dig ----

// The collect plugin switches on the class names.
class Block {
  constructor (name, position, type = 1) { Object.assign(this, { name, type, position, shapes: type ? [[0, 0, 0, 1, 1, 1]] : [] }) }
}
class Entity {
  constructor (position) { Object.assign(this, { id: ++ids, name: 'item', position, isValid: true }) }
  getDroppedItem () { return { name: 'raw_iron', count: 1 } }
}
class Movements {
  constructor () { Object.assign(this, { openable: new Set(), exclusionAreasBreak: [] }) }
  getBlock () { return {} }
  safeToBreak () { return true }
}

// The body never moves. Every collect walk to a drop finds no path, every other walk arrives, and each dig spawns its
// drop at the block's centre. chase(drop) answers a chase. Time runs 50 ms a tick.
function mineRig (t, { blocks, chase }) {
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8 }
  bot.blockAt = (p) => blocks[`${p.x},${p.y},${p.z}`] || null
  bot.world = { raycast: () => null }
  bot.entities = {}
  bot.on('entityGone', (e) => { delete bot.entities[e.id] })
  const pockets = []
  bot.inventory = { items: () => pockets, emptySlotCount: () => 36 }
  bot.waitForTicks = () => new Promise(setImmediate)
  bot.tool = { equipForBlock: async () => {} }
  bot.heldItem = null
  bot.targetDigBlock = null
  bot.digTime = () => 0
  const seen = { drops: [], chases: [] }
  bot.dig = async (b) => {
    const k = `${b.position.x},${b.position.y},${b.position.z}`
    const air = blocks[k] = new Block('air', b.position, 0)
    bot.emit('diggingCompleted', air)
    setImmediate(() => bot.emit(`blockUpdate:${b.position}`, air, blocks[k]))
    const drop = new Entity(b.position.offset(0.5, 0.5, 0.5))
    seen.drops.push(drop)
    bot.entities[drop.id] = drop
    bot.emit('itemDrop', drop)
  }
  const clock = { now: 0 }
  let ticking = true
  const tick = () => {
    if (!ticking) return
    clock.now += 50
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
    stop () {},
    setGoal (g) {
      this.goal = g
      bot.emit('goal_updated', g)
      if (!g) return
      setImmediate(() => {
        if (this.goal !== g) return
        if (g instanceof goals.GoalFollow) return void bot.emit('path_update', { status: 'noPath', path: [new Vec3(1, 64, 0)] })
        this.goal = null
        bot.emit('goal_reached', g)
      })
    }
  }
  bot.collectBlock = Object.assign(Object.create(CollectBlock.prototype), { bot, targets: new Targets(bot), chestLocations: [], itemFilter: () => true, movements: null })
  const digLock = botConstant('digLock')
  loadBotFunctions(['wireDigGuard'], { bot, digLock }).wireDigGuard()
  bot.emit('spawn')
  const env = {
    bot,
    require,
    goals,
    Date: { now: () => clock.now },
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
    stagedGoto: async (q) => {
      const { drop } = q
      seen.chases.push({ drop, at: drop.position.clone(), watched: q.watched ? q.watched(drop) : null })
      if (!chase(drop)) return { arrived: false, reason: 'no-path' }
      pockets.push({ name: 'raw_iron', count: 1 })
      bot.emit('playerCollect', bot.entity, drop)
      setImmediate(() => bot.emit('entityGone', drop))
      return { arrived: true, reason: null }
    },
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    guardWork: (work, o) => guardWork(work, { ...o, clock: { now: () => clock.now, setInterval: () => null, clearInterval () {}, setTimeout: () => null, clearTimeout () {} } }),
    GoalPickup: walk.GoalPickup,
    overPickup: walk.overPickup,
    watchScope: new AsyncLocalStorage(),
    Vec3,
    ck: (x, y, z) => x + ',' + y + ',' + z,
    cellKnown: () => true,
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    console: { log: () => {} },
    resolveBlockIds: () => [1],
    nearestVisible: () => Object.values(blocks).find((b) => b.type) || null,
    leafInTheWay: () => null,
    holdCollectTool: async () => {},
    reflexes: [{ name: 'unstuck', active: false }],
    litFuse: () => null
  }
  // The loader misses abandonCollect, which collectSafely passes without calling.
  const { watchGoto } = loadBotFunctions(['abandonCollect', 'watchGoto'], env)
  bot.pathfinder.goto = watchGoto((g) => gotoGoal(bot, g))
  return { bot, env, seen, clock }
}

const ore = (x, y, z) => ({ [`${x},${y},${z}`]: new Block('iron_ore', new Vec3(x, y, z)) })
const mine = (rig, query) => timed(awaitRoute('/mine', query, rig.env), 4000).then((r) => r.out)

test('mine chases the drop of its last dig that collectblock could not reach, and picks it up', async (t) => {
  const rig = mineRig(t, { blocks: ore(1, 64, 0), chase: () => true })
  const reply = await mine(rig, { name: 'iron_ore' })
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual(rig.seen.chases.map((c) => c.drop), [rig.seen.drops[0]])
})

test('mine chases its own drop as watched while it lies within 1 of the dug cell, and as unwatched once it rolled further', async (t) => {
  for (const [label, rest, watched] of [['beside the cell', new Vec3(2.2, 63.97, 0.5), true], ['1.5 past the cell', new Vec3(3.5, 63.97, 0.5), false]]) {
    const rig = mineRig(t, { blocks: ore(1, 64, 0), chase: () => true })
    rig.bot.once('itemDrop', (d) => setImmediate(() => {
      d.position = rest
      rig.bot.emit('entityMoved', d)
    }))
    await mine(rig, { name: 'iron_ore' })
    assert.deepStrictEqual(rig.seen.chases.map((c) => [c.at.x, c.watched]), [[rest.x, watched]], label)
  }
})

test('mine chases the drop of a log dug 4 over the feet only once it has come down to rest', async (t) => {
  const rig = mineRig(t, { blocks: ore(1, 68, 0), chase: () => true })
  const ground = new Vec3(2.8, 63.97, 1.4)
  // The server's position updates of the falling drop.
  rig.bot.once('itemDrop', (d) => {
    const at = rig.clock.now
    const fall = (ms, p) => {
      const on = () => {
        if (rig.clock.now - at < ms) return
        rig.bot.removeListener('physicsTick', on)
        d.position = p
        rig.bot.emit('entityMoved', d)
      }
      rig.bot.on('physicsTick', on)
    }
    fall(1000, new Vec3(2.2, 67.0, 0.9))
    fall(1500, ground)
  })
  const reply = await mine(rig, { name: 'iron_ore' })
  assert.deepStrictEqual(reply, { mined: 1, requested: 1, gathered: 1, reason: null })
  assert.deepStrictEqual(rig.seen.chases.map((c) => c.at), [ground])
})
