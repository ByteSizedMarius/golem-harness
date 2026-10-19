'use strict'
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const { Vec3 } = require('vec3')
const { expireConfirmed } = require('../lib/shelter')
const { STANCES } = require('../lib/bot/stances')
const { CREEPER_ZONE_SLACK } = require('../lib/plan')
const { loadBotFunctions, combatReflexIn, botConstant } = require('./helpers')

const CLASSES = { zombie: 'hostile', skeleton: 'hostile', creeper: 'creeper' }
const ARROW_ID = 50

// The combat reflex and the damage wire of a body at the origin among mobs, over one AGGRO_CONFIRMED. A mob carries
// seen (the body perceives it), reach (in melee reach) and watched (a floor away, not engageable).
function fightAmong (mobs) {
  const bot = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5) },
    entities: Object.fromEntries(mobs.map((e) => [e.id, e])),
    _client: new EventEmitter()
  })
  const fill = { cells: new Set() }
  const env = {
    bot,
    Vec3,
    fight: { stance: 'guard', threatDebugUntil: 0, damageTypes: ['mob_attack', 'arrow'], lastAttrib: null },
    STANCES,
    CREEPER_ZONE_SLACK,
    AGGRO_CONFIRMED: new Map(),
    expireConfirmed,
    bunker: { building: false },
    holdRun: { on: false },
    console: { log () {} },
    reflexes: [],
    liveEntities: () => Object.values(bot.entities),
    mobClass: (e) => CLASSES[e.name] || 'other',
    airFlood: () => fill,
    knownCell: () => true,
    entityPerceptible: (e) => !!e.seen,
    entityEngageable: (e) => !e.watched,
    inMeleeReach: (e) => !!e.reach,
    perchStrike: () => false,
    creeperRoute: () => null,
    emitEvent () {},
    lastSwing: new Map(),
    arrows: new Map(),
    damageTypeMissed: false,
    ...Object.fromEntries(['CONFIRMED_HORIZON', 'CONFIRMED_MS', 'CONFIRMED_COOL_MS', 'SHOOTERS', 'ARROWS', 'ARROW_RANGE',
      'ARROW_LOOSE', 'ARROW_FLIGHT_MS', 'ARROW_HIT_MS', 'SWING_MS', 'SWING_GAP_MS', 'SWING_FACING']
      .map((name) => [name, botConstant(name)]))
  }
  const wire = loadBotFunctions(['wireDamageAttribution'], env)
  const combat = combatReflexIn(env)
  env.reflexes.push(combat)
  wire.wireDamageAttribution()
  bot.emit('spawn')
  const confirmed = env.AGGRO_CONFIRMED
  return {
    bot,
    combat,
    confirmed,
    // A melee hit by e, or an arrow hit when arrow is true.
    hit (e, arrow = false) {
      if (arrow) bot.entities[ARROW_ID] = { id: ARROW_ID, name: 'arrow', position: new Vec3(1.5, 65, 0.5) }
      bot._client.emit('damage_event', { entityId: 1, sourceTypeId: arrow ? 1 : 0, sourceCauseId: e.id + 1, sourceDirectId: (arrow ? ARROW_ID : e.id) + 1 })
      delete bot.entities[ARROW_ID]
    },
    // Moves every confirmed hit and in-reach sighting ms into the past.
    age (ms) {
      for (const h of confirmed.values()) {
        h.t -= ms
        if (h.near) h.near -= ms
      }
    },
    check: () => combat.check(bot)
  }
}

const zombie = (x, reach, seen = true) => ({ id: 9, name: 'zombie', seen, reach, position: new Vec3(x, 64, 0.5) })

test('a confirmed zombie out of melee reach lapses 20 s after its last hit, and its next hit confirms it again', () => {
  const f = fightAmong([zombie(30.5, false)])
  assert.strictEqual(f.check(), false, 'control: an unproven zombie at 30')
  f.hit(f.bot.entities[9])
  assert.strictEqual(f.check(), true, 'scored at 30 once it hit')
  f.age(19000)
  assert.strictEqual(f.check(), true, '19 s after the hit')
  f.age(2000)
  assert.strictEqual(f.check(), false, '21 s after the hit')
  assert.strictEqual(f.confirmed.has(9), false)
  f.hit(f.bot.entities[9])
  assert.strictEqual(f.check(), true, 'the next hit')
  assert.strictEqual(f.combat._threat.confirmed, true)
})

test('a confirmed zombie the body sees in melee reach stays confirmed past 20 s, an unseen one lapses', () => {
  for (const seen of [true, false]) {
    const f = fightAmong([zombie(1.5, true, seen)])
    f.hit(f.bot.entities[9])
    assert.ok(f.confirmed.has(9), 'control: the hit confirms it')
    f.age(19000)
    f.check()
    f.age(2000)
    f.check()
    assert.strictEqual(f.confirmed.has(9), seen, seen ? 'in sight' : 'out of sight')
  }
})

test('a confirmed skeleton behind cover lapses 20 s after its last arrow, and its next arrow confirms it as ranged', () => {
  const skeleton = { id: 5, name: 'skeleton', seen: true, reach: false, position: new Vec3(20.5, 64, 0.5) }
  const f = fightAmong([skeleton])
  f.check()
  f.hit(skeleton, true)
  assert.strictEqual(f.confirmed.get(5).ranged, true, 'control: the arrow confirms it')
  skeleton.seen = false
  assert.strictEqual(f.check(), true, 'scored behind cover')
  f.age(20001)
  assert.strictEqual(f.check(), false, '20 s after the arrow')
  assert.strictEqual(f.confirmed.has(5), false)
  skeleton.seen = true
  f.hit(skeleton, true)
  assert.strictEqual(f.confirmed.get(5).ranged, true, 'the next arrow')
  assert.strictEqual(f.check(), true)
})

const creeper = (id, x, y, more) => ({ id, name: 'creeper', reach: false, position: new Vec3(x, y, 0.5), ...more })

test('the watched creepers list only those the body sees, with the stance berth plus 3, for 1 s', () => {
  const above = creeper(20, 3.5, 70, { seen: true, watched: true })
  const noWalk = creeper(21, 12.5, 64, { seen: true })
  const hiddenAbove = creeper(22, -3.5, 70, { seen: false, watched: true })
  const hiddenNoWalk = creeper(23, -12.5, 64, { seen: false })
  const f = fightAmong([above, noWalk, hiddenAbove, hiddenNoWalk])
  const now = Date.now()
  f.combat._hist.set(21, { d: 14, t: now - 1000, closes: 3, logT: now })
  for (const e of [hiddenAbove, hiddenNoWalk]) {
    f.confirmed.set(e.id, { name: 'creeper', t: now })
    f.combat._seenAt.set(e.id, e.position.clone())
  }
  const zones = () => Array.from(f.combat.watchedCreepers(), ({ id, at, radius }) => [id, at.toArray(), radius])
  assert.deepStrictEqual(zones(), [], 'before a check pass')
  assert.strictEqual(f.check(), false, 'every creeper watched')
  const radius = STANCES.guard.fleeDist + 3
  assert.deepStrictEqual(zones(), [[20, [3.5, 70, 0.5], radius], [21, [12.5, 64, 0.5], radius]])
  f.combat._watched.t -= 1001
  assert.deepStrictEqual(zones(), [], 'a pass over 1 s old')
  f.check()
  delete f.bot.entities[20]
  assert.deepStrictEqual(zones(), [[21, [12.5, 64, 0.5], radius]], 'creeper 20 gone')
})
