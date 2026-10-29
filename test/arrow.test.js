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
// tracked is when his entity appeared, null for never.
async function swingHit ({ yaw = WEST, swings = [9600, 10000], hostileX = -2.5, seen = true, tracked = 0 } = {}) {
  const clock = { now: 0 }
  const body = { id: 1, position: new Vec3(0.5, 64, 0.5) }
  const steve = { id: 2, type: 'player', username: 'Steve', yaw, position: new Vec3(2.5, 64, 0.5) }
  const zombie = { id: 3, name: 'zombie', position: new Vec3(hostileX, 64, 0.5) }
  const bot = Object.assign(new EventEmitter(), { entity: body, entities: {}, _client: new EventEmitter() })
  const fight = { damageTypes: ['generic'], lastAttrib: null }
  const fill = { cells: new Set() }
  const ctx = loadBotFunctions(['wireArmSwings', 'wireDamageAttribution'], {
    bot,
    fight,
    Date: { now: () => clock.now },
    setTimeout: (fn) => fn(),
    console: { log () {} },
    liveEntities: () => [steve, zombie],
    nearestHostile: () => zombie,
    reflexes: [{ name: 'combat', fairFill: () => fill }],
    entityPerceptible: (e, f) => {
      assert.strictEqual(f, fill, 'entityPerceptible got another fill')
      return e !== steve || seen
    },
    lastSwing: new Map(),
    arrows: new Map(),
    AGGRO_CONFIRMED: new Map(),
    damageTypeMissed: false,
    ...Object.fromEntries(['SWING_MS', 'SWING_GAP_MS', 'SWING_FACING', 'ARROW_FLIGHT_MS', 'ARROW_HIT_MS', 'ARROW_RANGE']
      .map(name => [name, botConstant(name)]))
  })
  ctx.wireArmSwings()
  ctx.wireDamageAttribution()
  bot.emit('spawn')
  if (tracked !== null) {
    clock.now = tracked
    bot.emit('entitySpawn', steve)
  }
  for (const t of swings) {
    clock.now = t
    bot.emit('entitySwingArm', steve)
  }
  bot._client.emit('damage_event', { entityId: body.id, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 0 })
  await fight.swingWait
  return fight.lastAttrib && fight.lastAttrib.desc
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
