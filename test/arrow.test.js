'use strict'
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const { Vec3 } = require('vec3')
const { loadBotFunctions, botConstant } = require('./helpers')

// Facing west, toward a body at the origin from the east.
const WEST = Math.PI / 2
const skeleton = (x, yaw, seen) => ({ id: 5, name: 'skeleton', height: 1.99, yaw, seen, position: new Vec3(x, 64, 0.5) })
const pillager = (seen) => ({ id: 7, name: 'pillager', height: 1.95, yaw: -WEST, seen, position: new Vec3(-19.5, 64, 0.5) })

// The bot.js arrow functions for a body at the origin among mobs, after the arrows in flown, each with the point it
// appeared at (from), its spawn time 500 and its vanish time 1000. arrowSeen says whether the body saw the arrow.
function arrowFunctions (mobs, arrowSeen = false, flown = []) {
  const fill = { cells: new Set() }
  const env = {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) } },
    reflexes: [{ name: 'combat', fairFill: () => fill }],
    liveEntities: () => mobs,
    entityPerceptible: (e, f) => {
      assert.strictEqual(f, fill, 'entityPerceptible got another fill')
      return e.seen ?? arrowSeen
    },
    arrows: new Map(flown.map((from, i) => [100 + i, { e: { position: from }, from, t: 500, gone: 1000 }])),
    ...Object.fromEntries(['SHOOTERS', 'ARROWS', 'ARROW_RANGE', 'ARROW_LOOSE', 'ARROW_FLIGHT_MS', 'ARROW_HIT_MS', 'SWING_FACING']
      .map(name => [name, botConstant(name)]))
  }
  return loadBotFunctions(['arrowAttrib', 'arrowHitOf'], env)
}

// arrowAttrib of an arrow hit that appeared at from, cause being the shooter the server named.
function arrowHit (mobs, arrowSeen = false, cause, from = new Vec3(10.5, 65.5, 0.5)) {
  const arrow = { e: { position: new Vec3(4.5, 65, 0.5) }, from }
  return arrowFunctions(mobs, arrowSeen).arrowAttrib(arrow, 1000, cause)
}

// The arrow attribution of a sourceless hit at 1000 among mobs after the arrows that appeared at the points in flown.
const sourcelessHit = (mobs, flown) => arrowFunctions(mobs, false, flown).arrowHitOf(1000, true, null, null)

test('an arrow hit names the shooter the server gives only when the body perceives it', () => {
  const named = arrowHit([pillager(true)], false, pillager(true))
  assert.deepStrictEqual({ desc: named.desc, id: named.entity && named.entity.id, ranged: named.ranged },
    { desc: 'pillager W ~20 (arrow)', id: 7, ranged: true })
  const unseen = arrowHit([pillager(false)], false, pillager(false))
  assert.deepStrictEqual({ desc: unseen.desc, entity: unseen.entity }, { desc: 'hit by an arrow', entity: null })
  assert.strictEqual(arrowHit([skeleton(10.5, WEST, true)], false, pillager(false)).desc, 'skeleton E ~10 (arrow)')
})

test('a hit by a spectral arrow counts as an arrow hit, a hit by another projectile does not', () => {
  const { arrowHitOf } = arrowFunctions([pillager(true)])
  const shot = (name) => arrowHitOf(1000, false, { id: 9, name, position: new Vec3(3.5, 65, 0.5) }, pillager(true))
  assert.strictEqual(shot('spectral_arrow').desc, 'pillager W ~20 (arrow)')
  assert.strictEqual(shot('trident'), null)
})

test('an arrow hit names a skeleton in sight that faces the body within 15, never an unseen one', () => {
  const seen = arrowHit([skeleton(10.5, WEST, true)])
  assert.strictEqual(seen.desc, 'skeleton E ~10 (arrow)')
  assert.strictEqual(seen.entity.id, 5)
  assert.strictEqual(seen.ranged, true)
  for (const [label, mobs] of [
    ['an unseen skeleton', [skeleton(10.5, WEST, false)]],
    ['a skeleton facing away', [skeleton(10.5, -WEST, true)]],
    ['a skeleton beyond 15', [skeleton(16.5, WEST, true)]]
  ]) {
    const r = arrowHit(mobs)
    assert.deepStrictEqual({ desc: r.desc, entity: r.entity, ranged: r.ranged }, { desc: 'hit by an arrow', entity: null, ranged: true }, label)
  }
})

test('an arrow hit names the nearest of the skeletons it could have left, and none beyond 15 of the body', () => {
  const atEye = (x) => new Vec3(x, 65.69, 0.5)
  assert.strictEqual(arrowHit([skeleton(15.5, WEST, true)], false, null, atEye(15.5)).desc, 'skeleton E ~15 (arrow)')
  assert.strictEqual(arrowHit([skeleton(16, WEST, true)], false, null, atEye(16)).desc, 'hit by an arrow')
  const pair = [{ ...skeleton(11.5, WEST, true), id: 6 }, skeleton(10.5, WEST, true)]
  const r = arrowHit(pair, false, null, atEye(11))
  assert.deepStrictEqual({ desc: r.desc, id: r.entity && r.entity.id }, { desc: 'skeleton E ~10 (arrow)', id: 5 })
})

test('an arrow hit with no shooter in sight gives a bearing only when the body saw the arrow', () => {
  assert.strictEqual(arrowHit([skeleton(10.5, WEST, false)], true).desc, 'hit by an arrow from E')
  assert.strictEqual(arrowHit([], false).desc, 'hit by an arrow')
})

test('a sourceless hit names a skeleton in sight facing the body when the vanished arrow appeared at its eye', () => {
  const r = sourcelessHit([skeleton(10.5, WEST, true)], [new Vec3(10, 65.6, 0.5)])
  assert.deepStrictEqual({ desc: r && r.desc, id: r && r.entity.id, ranged: r && r.ranged },
    { desc: 'skeleton E ~10 (arrow)', id: 5, ranged: true })
})

test('a vanished arrow that appeared out of range leaves a sourceless hit to melee', () => {
  assert.strictEqual(sourcelessHit([skeleton(12.5, WEST, true)], [new Vec3(20.5, 65.6, 0.5)]), null)
})

test('a sourceless hit by an in-range arrow with no shooter in sight reads as an unnamed arrow hit', () => {
  for (const [label, mobs] of [
    ['a skeleton in sight the arrow did not leave', [skeleton(12.5, WEST, true)]],
    ['an unseen skeleton at the arrow', [skeleton(10.5, WEST, false)]]
  ]) {
    const from = mobs[0].seen ? new Vec3(10.5, 65.6, 8.5) : new Vec3(10, 65.6, 0.5)
    const r = sourcelessHit(mobs, [from])
    assert.deepStrictEqual(r && { desc: r.desc, entity: r.entity, ranged: r.ranged },
      { desc: 'hit by an arrow', entity: null, ranged: true }, label)
  }
})

// The attribution of a sourceless hit at the last of swings, the times player Steve, 2 east of a body at the origin,
// swung his arm facing yaw, with a zombie at hostileX on the body's row. seen says whether the body perceives Steve.
// tracked is when his entity appeared, null for never. burning sets the body's on-fire flag. fight holds the attribution before the hit.
// cells holds the blocks in the body's feet and head cells. respawn respawns the body before the hit, after a death at
// health 0, after a dimension change above it, out of the End with leftEnd. aggro gets the confirmed attackers.
// others are more hostiles. beforeHit(bot, body) runs 50 ms before the hit. duringWait(bot, body) runs while the
// attribution waits for a swing, an arrow or a knockback. With later, a list of [ms, step], each step(bot, body) runs
// ms after the hit instead, the waits' timers firing at their times.
async function swingHit ({ yaw = WEST, swings = [9600, 10000], hostileX = -2.5, seen = true, tracked = 0, burning = false,
  fight = { damageTypes: ['generic'], lastAttrib: null }, cells = {}, respawn = false, leftEnd = false, health = 20, aggro = new Map(),
  others = [], beforeHit = null, duringWait = () => {}, later = null } = {}) {
  const clock = { now: 0 }
  const body = { id: 1, position: new Vec3(0.5, 64, 0.5), metadata: [burning ? 0x01 : 0] }
  const steve = { id: 2, type: 'player', username: 'Steve', yaw, position: new Vec3(2.5, 64, 0.5) }
  const zombie = { id: 3, name: 'zombie', position: new Vec3(hostileX, 64, 0.5) }
  const blockAt = (p) => (p.x === 0 && p.z === 0 && { 64: cells.feet, 65: cells.head }[p.y]) || null
  const game = { dimension: leftEnd ? 'the_end' : 'overworld' }
  const bot = Object.assign(new EventEmitter(), { entity: body, entities: {}, _client: new EventEmitter(), blockAt, health, game })
  const fill = { cells: new Set() }
  const timers = []
  const ctx = loadBotFunctions(['wireArmSwings', 'wireDamageAttribution'], {
    bot,
    fight,
    Date: { now: () => clock.now },
    setTimeout: (fn, ms) => {
      if (later) return timers.push({ at: clock.now + ms, fn })
      duringWait(bot, body)
      fn()
    },
    console: { log () {} },
    liveEntities: () => [steve, zombie, ...others],
    mobClass: (e) => (e.type === 'player' ? 'player' : 'hostile'),
    reflexes: [{ name: 'combat', fairFill: () => fill }],
    entityPerceptible: (e, f) => {
      assert.strictEqual(f, fill, 'entityPerceptible got another fill')
      return e !== steve || seen
    },
    lastSwing: new Map(),
    arrows: new Map(),
    AGGRO_CONFIRMED: aggro,
    damageTypeMissed: false,
    LEGACY_1710: false,
    Vec3,
    ...Object.fromEntries(['SWING_MS', 'SWING_GAP_MS', 'SWING_FACING', 'ARROW_FLIGHT_MS', 'ARROW_HIT_MS', 'ARROW_RANGE', 'KNOCK_SPEED', 'KNOCK_CONE', 'KNOCK_MS']
      .map(name => [name, botConstant(name)]))
  })
  ctx.wireArmSwings()
  ctx.wireDamageAttribution()
  bot.emit('login')
  bot.emit('spawn')
  if (respawn) {
    if (!health) bot.emit('death')
    game.dimension = leftEnd ? 'overworld' : 'the_nether'
    bot.emit('respawn')
  }
  if (tracked !== null) {
    clock.now = tracked
    bot.emit('entitySpawn', steve)
  }
  for (const t of swings) {
    clock.now = t
    bot.emit('entitySwingArm', steve)
  }
  if (beforeHit) {
    beforeHit(bot, body)
    clock.now += 50
  }
  bot._client.emit('damage_event', { entityId: body.id, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 0 })
  if (later) await stepThrough(clock, timers, later.map(([ms, step]) => [ms, () => step(bot, body)]))
  await fight.swingWait
  return fight.lastAttrib && fight.lastAttrib.desc
}

// Runs each [ms, step] of steps ms after clock.now and each { at, fn } of timers at its time, in time order, settling
// the promises after each and setting clock.now to the time it runs at.
async function stepThrough (clock, timers, steps) {
  const start = clock.now
  const settle = () => new Promise(r => setImmediate(r))
  const due = async (at) => {
    for (const timer of timers.filter(x => x.at <= at).sort((a, b) => a.at - b.at)) {
      timers.splice(timers.indexOf(timer), 1)
      clock.now = timer.at
      timer.fn()
      await settle()
    }
    clock.now = at
  }
  for (const [ms, step] of steps) {
    await due(start + ms)
    step()
    await settle()
  }
  await due(Infinity)
}

test('a sourceless hit names a player whose lone swing faced the body from no farther than the nearest hostile', async () => {
  assert.strictEqual(await swingHit(), 'no attacker named, Steve swung nearby', 'control: a lone facing swing, the zombie farther')
  for (const [label, row, desc] of [
    ['a swing facing away', { yaw: -WEST }, 'zombie W ~3 (nearest hostile)'],
    ['a swing 100 ms after the previous one', { swings: [9900, 10000] }, 'zombie W ~3 (nearest hostile)'],
    ['a zombie closer than the player', { hostileX: -0.5 }, 'zombie W ~1 (nearest hostile)']
  ]) {
    assert.strictEqual(await swingHit(row), desc, label)
  }
})

test('a first swing counts as lone only when the body tracked the player through the quiet before it', async () => {
  assert.strictEqual(await swingHit({ swings: [10000] }), 'no attacker named, Steve swung nearby', 'control: tracked for 10 s')
  for (const [label, row] of [
    ['tracked for 10 ms', { tracked: 9990, swings: [10000] }],
    ['never seen appearing', { tracked: null, swings: [10000] }]
  ]) {
    assert.strictEqual(await swingHit(row), 'zombie W ~3 (nearest hostile)', label)
  }
})

test('a sourceless hit never names a swinging player the body cannot perceive', async () => {
  assert.strictEqual(await swingHit({ seen: false }), 'zombie W ~3 (nearest hostile)')
})

test('a sourceless hit while the body burns is the fire\'s, never the nearest hostile\'s', async () => {
  const noSwing = { tracked: null, swings: [] }
  assert.strictEqual(await swingHit(noSwing), 'zombie W ~3 (nearest hostile)', 'control: not burning')
  assert.strictEqual(await swingHit({ ...noSwing, burning: true }), 'no attacker named, on fire')
})

test('a burn tick 1 s after a hostile\'s hit keeps that attribution as an environmental hit', async () => {
  const fight = { damageTypes: ['generic'], lastAttrib: { t: -1000, desc: 'zombie W ~3 (nearest hostile)', entity: null, ranged: false } }
  await swingHit({ tracked: null, swings: [], burning: true, fight })
  assert.deepStrictEqual({ desc: fight.lastAttrib.desc, envHit: fight.lastAttrib.envHit }, { desc: 'zombie W ~3 (nearest hostile)', envHit: true })
})

test('a sourceless hit while the body burns ignores a swinging player farther than the nearest hostile', async () => {
  assert.strictEqual(await swingHit({ burning: true }), 'no attacker named, Steve swung nearby', 'control: the zombie farther than the player')
  assert.strictEqual(await swingHit({ burning: true, hostileX: -0.5 }), 'no attacker named, on fire')
})

const GRAVEL = { name: 'gravel', transparent: false, shapes: [[0, 0, 0, 1, 1, 1]] }
const FIRE = { name: 'fire', transparent: true, shapes: [] }
const LAVA = { name: 'lava', transparent: true, shapes: [] }

test('a sourceless hit while the head is buried is the block\'s, never the nearest hostile\'s', async () => {
  const noSwing = { tracked: null, swings: [] }
  const control = new Map()
  assert.strictEqual(await swingHit({ ...noSwing, cells: { feet: GRAVEL }, aggro: control }), 'zombie W ~3 (nearest hostile)', 'control: only the feet in gravel')
  assert.deepStrictEqual([...control.keys()], [3], 'control: the zombie confirmed')
  const aggro = new Map()
  assert.strictEqual(await swingHit({ ...noSwing, cells: { head: GRAVEL }, aggro }), 'no attacker named, buried')
  assert.deepStrictEqual([...aggro.keys()], [])
})

test('a sourceless hit with the feet in fire or the head in lava is theirs before the on-fire flag arrives', async () => {
  const noSwing = { tracked: null, swings: [] }
  assert.strictEqual(await swingHit(noSwing), 'zombie W ~3 (nearest hostile)', 'control: no fire or lava')
  assert.strictEqual(await swingHit({ ...noSwing, cells: { feet: FIRE } }), 'no attacker named, on fire')
  assert.strictEqual(await swingHit({ ...noSwing, cells: { head: LAVA } }), 'no attacker named, in lava')
})

test('the on-fire flag of a body that died burning ends with the respawn', async () => {
  const noSwing = { tracked: null, swings: [], burning: true }
  assert.strictEqual(await swingHit(noSwing), 'no attacker named, on fire', 'control: no respawn')
  assert.strictEqual(await swingHit({ ...noSwing, respawn: true, health: 0 }), 'zombie W ~3 (nearest hostile)')
})

test('the on-fire flag of a burning body outlasts a portal into another dimension but not the way out of the End', async () => {
  const portal = { tracked: null, swings: [], burning: true, respawn: true, health: 20 }
  assert.strictEqual(await swingHit(portal), 'no attacker named, on fire', 'control: into the nether')
  assert.strictEqual(await swingHit({ ...portal, leftEnd: true }), 'zombie W ~3 (nearest hostile)')
})

// The server's velocity for the entity with id, x and z across in blocks per tick.
const push = (x, z, id = 1) => (bot) => bot._client.emit('entity_velocity', { entityId: id, velocity: { x, y: 0.36, z } })

test('a knockback that arrives late still names the hostile, the moment it arrives', async () => {
  const fight = { damageTypes: ['generic'], lastAttrib: null }
  const waiting = []
  const look = () => waiting.push(!!fight.swingWait)
  await swingHit({ tracked: null, swings: [], seen: false, burning: true, fight, later: [[119, look], [120, push(0.4, 0)], [121, look]] })
  assert.deepStrictEqual({ desc: fight.lastAttrib.desc, waiting }, { desc: 'zombie W ~3 (knockback)', waiting: [true, false] })
})

test('a knockback names the hostile it points away from, and no other', async () => {
  const burning = { tracked: null, swings: [], seen: false, burning: true }
  const skeleton = { id: 4, name: 'skeleton', position: new Vec3(0.5, 64, 2.5) }
  const spider = { id: 5, name: 'spider', position: new Vec3(0.5, 66, 0.5) }
  const creeper = { id: 6, name: 'creeper', position: new Vec3(0.5 - 2 * Math.cos(Math.PI / 8), 64, 0.5 + 2 * Math.sin(Math.PI / 8)) }
  // A push of 0.4 across, deg degrees off the line from the zombie.
  const off = (deg) => push(0.4 * Math.cos(deg * Math.PI / 180), 0.4 * Math.sin(deg * Math.PI / 180))
  for (const [label, row, desc] of [
    ['toward the zombie', { duringWait: push(-0.4, 0) }, 'no attacker named, on fire'],
    ['across the line from the zombie', { duringWait: push(0, 0.4) }, 'no attacker named, on fire'],
    ['70 degrees off the line from the zombie', { duringWait: off(70) }, 'no attacker named, on fire'],
    ['50 degrees off the line from the zombie', { duringWait: off(50) }, 'zombie W ~3 (knockback)'],
    ['away from the zombie, a spider right above the body', { others: [spider], duringWait: push(0.4, 0) }, 'zombie W ~3 (knockback)'],
    ['straight away from the zombie, 22 degrees off a nearer creeper', { others: [creeper], duringWait: push(0.4, 0) }, 'zombie W ~3 (knockback)'],
    ['away from the farther zombie', { others: [skeleton], duringWait: push(0.4, 0) }, 'zombie W ~3 (knockback)'],
    ['away from the nearer skeleton', { others: [skeleton], duringWait: push(0, -0.4) }, 'skeleton S ~2 (knockback)'],
    ['away from the zombie alone', { duringWait: push(0.4, 0) }, 'zombie W ~3 (knockback)']
  ]) {
    assert.strictEqual(await swingHit({ ...burning, ...row }), desc, label)
  }
})

test('a velocity names no hostile when it is another entity\'s, arrived before the hit or is too slow for a knockback', async () => {
  const burning = { tracked: null, swings: [], seen: false, burning: true }
  for (const [label, row] of [
    ['another entity\'s', { duringWait: push(0.4, 0, 3) }],
    ['before the hit', { beforeHit: push(0.4, 0) }],
    ['under 0.2 across', { duringWait: push(0.15, 0) }]
  ]) {
    assert.strictEqual(await swingHit({ ...burning, ...row }), 'no attacker named, on fire', label)
  }
})

test('a knockback 200 ms after the hit comes too late, the wait ending at 150 ms', async () => {
  const fight = { damageTypes: ['generic'], lastAttrib: null }
  const waiting = []
  const look = () => waiting.push(!!fight.swingWait)
  await swingHit({ tracked: null, swings: [], seen: false, burning: true, fight, later: [[149, look], [151, look], [200, push(0.4, 0)]] })
  assert.deepStrictEqual({ desc: fight.lastAttrib.desc, waiting }, { desc: 'no attacker named, on fire', waiting: [true, false] })
})

test('a velocity packet the attribution fails on throws nothing back at the client', async () => {
  const others = []
  const broken = (bot) => {
    others.push({ id: 9, name: 'zombie', position: {} })
    push(0.4, 0)(bot)
  }
  await assert.doesNotReject(swingHit({ tracked: null, swings: [], seen: false, burning: true, others, later: [[50, broken]] }))
})

// The attribution of a sourceless hit at food 0 on a body at health hp on difficulty, with a zombie 2 west of it when
// hostile. The health update taking drop arrives update ms after the hit, none with null. landed lands the body from a
// fall 200 ms before the hit. Each [ms, step] of steps runs step(bot, fight) ms after the hit.
async function starveHit ({ hp, difficulty = 'easy', drop = 1, update = 0, landed = false, hostile = false, steps = [] }) {
  const clock = { now: 10000 }
  const zombie = { id: 3, name: 'zombie', position: new Vec3(-1.5, 64, 0.5) }
  const body = { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, metadata: [0] }
  const bot = Object.assign(new EventEmitter(), { entity: body, entities: {}, _client: new EventEmitter(), blockAt: () => null, health: hp, food: 0, game: { difficulty } })
  const fight = { damageTypes: ['generic'], lastAttrib: null }
  const fill = { cells: new Set() }
  const timers = []
  const ctx = loadBotFunctions(['wireDamageAttribution'], {
    bot,
    fight,
    Vec3,
    LEGACY_1710: false,
    Date: { now: () => clock.now },
    setTimeout: (fn, ms) => timers.push({ at: clock.now + ms, fn }),
    console: { log () {} },
    liveEntities: () => (hostile ? [zombie] : []),
    mobClass: () => 'hostile',
    reflexes: [{ name: 'combat', fairFill: () => fill }],
    entityPerceptible: () => true,
    playersNear: () => [],
    arrows: new Map(),
    AGGRO_CONFIRMED: new Map(),
    damageTypeMissed: false,
    ...Object.fromEntries(['SWING_MS', 'KNOCK_SPEED', 'KNOCK_CONE', 'KNOCK_MS'].map(name => [name, botConstant(name)]))
  })
  ctx.wireDamageAttribution()
  bot.emit('spawn')
  if (landed) {
    body.onGround = false
    bot.emit('move')
    body.onGround = true
    bot.emit('move')
  }
  clock.now += 200
  bot._client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 0 })
  const health = () => {
    bot.health -= drop
    bot.emit('health')
  }
  const all = [...(update === null ? [] : [[update, health]]), ...steps.map(([ms, step]) => [ms, () => step(bot, fight)])]
  await stepThrough(clock, timers, all.sort((a, b) => a[0] - b[0]))
  await fight.swingWait
  return fight.lastAttrib && fight.lastAttrib.desc
}

test('a sourceless hit at food 0 is starvation only at a health the server starves on its difficulty', async () => {
  for (const [label, row, desc] of [
    ['control: 12 on easy', { hp: 12 }, 'no attacker named, starving'],
    ['control: 10 on normal', { hp: 10, difficulty: 'normal' }, 'no attacker named, starving'],
    ['control: 1 on hard', { hp: 1, difficulty: 'hard' }, 'no attacker named, starving'],
    ['10 on easy', { hp: 10 }, 'no attacker named, no hostile within 4'],
    ['1 on normal', { hp: 1, difficulty: 'normal' }, 'no attacker named, no hostile within 4']
  ]) {
    assert.strictEqual(await starveHit(row), desc, label)
  }
})

test('a sourceless hit at food 0 that takes more than 1 is no starvation', async () => {
  assert.strictEqual(await starveHit({ hp: 12, drop: 3 }), 'no attacker named, no hostile within 4')
  assert.strictEqual(await starveHit({ hp: 12, drop: 3, hostile: true }), 'zombie W ~2 (nearest hostile)')
})

test('a sourceless hit at food 0 stays starvation when its health update comes after the wait or never', async () => {
  for (const [label, row] of [
    ['control: an update at once beside a hostile', { hostile: true }],
    ['an update 200 ms after the hit beside a hostile', { hostile: true, update: 200 }],
    ['no update beside a hostile', { hostile: true, update: null }],
    ['no update and no hostile', { update: null }]
  ]) {
    assert.strictEqual(await starveHit({ hp: 12, ...row }), 'no attacker named, starving', label)
  }
})

test('the health update of a starvation hit ends the wait', async () => {
  for (const hostile of [false, true]) {
    const waiting = []
    const look = (bot, fight) => waiting.push(!!fight.swingWait)
    const desc = await starveHit({ hp: 12, hostile, update: 20, steps: [[19, look], [21, look]] })
    assert.deepStrictEqual({ desc, waiting }, { desc: 'no attacker named, starving', waiting: [true, false] }, `hostile ${hostile}`)
  }
})

test('a sourceless hit at food 0 right after a fall is no starvation', async () => {
  assert.strictEqual(await starveHit({ hp: 12, landed: true }), 'no attacker named, no hostile within 4')
})

test('a body that catches fire while the hit waits for a swing keeps the cause read at the hit', async () => {
  const ignite = (bot, body) => { body.metadata[0] |= 0x01 }
  assert.strictEqual(await swingHit({ swings: [] }), 'zombie W ~3 (nearest hostile)', 'control: no fire')
  assert.strictEqual(await swingHit({ swings: [], duringWait: ignite }), 'zombie W ~3 (nearest hostile)')
})

test('a hit on a burning body with a hostile near is the hostile\'s when knockback follows it', async () => {
  // The server's velocity for the body, in blocks per tick: a burn tick sends its leftover motion, a hit by an entity knockback.
  const velocity = (v) => (bot, body) => bot._client.emit('entity_velocity', { entityId: body.id, velocity: v })
  const before = 'zombie W ~3 (nearest hostile)'
  for (const [label, duringWait, want] of [
    ['control: no velocity', undefined, { desc: before, t: -1000, envHit: true }],
    ['a burn tick', velocity({ x: 0, y: -0.0784, z: 0 }), { desc: before, t: -1000, envHit: true }],
    ['knockback from the zombie', velocity({ x: 0.4, y: 0.36, z: 0 }), { desc: 'zombie W ~3 (knockback)', t: 0, envHit: undefined }]
  ]) {
    const fight = { damageTypes: ['generic'], lastAttrib: { t: -1000, desc: before, entity: null, ranged: false } }
    await swingHit({ tracked: null, swings: [], seen: false, burning: true, fight, duringWait })
    const a = fight.lastAttrib
    assert.deepStrictEqual({ desc: a.desc, t: a.t, envHit: a.envHit }, want, label)
  }
})

// The attribution of a hit with no source entity and damage type typeId, from a registry of generic (0) and fall (1),
// with no hostile, player or arrow near.
function noSourceHit (typeId) {
  const bot = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, entities: {}, _client: new EventEmitter(), blockAt: () => null })
  const fight = { damageTypes: ['generic', 'fall'], lastAttrib: null }
  const ctx = loadBotFunctions(['wireDamageAttribution'], {
    bot,
    fight,
    Vec3,
    LEGACY_1710: false,
    console: { log () {} },
    liveEntities: () => [],
    mobClass: () => 'hostile',
    playersNear: () => [],
    arrows: new Map(),
    damageTypeMissed: false
  })
  ctx.wireDamageAttribution()
  bot.emit('spawn')
  bot._client.emit('damage_event', { entityId: 1, sourceTypeId: typeId, sourceCauseId: 0, sourceDirectId: 0 })
  return fight.lastAttrib && { desc: fight.lastAttrib.desc, untyped: fight.lastAttrib.untyped }
}

test('a hit with no source entity is untyped when generic or of an unknown type, a typed one is not', () => {
  assert.deepStrictEqual([0, 1, 2].map(noSourceHit), [
    { desc: 'no attacker named, no hostile within 4', untyped: true },
    { desc: 'fall', untyped: false },
    { desc: 'no attacker named', untyped: true }
  ])
})
