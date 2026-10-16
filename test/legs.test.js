'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { QUIET_MS, LONG_QUIET_MS, legLedger, takenText, laneBlocks } = require('../lib/legs')
const { routeDeadline } = require('../lib/walk')
const { loadBotFunctions, combatReflexIn, awaitRoute } = require('./helpers')

const KLASSES = ['discretionary', 'interrupt', 'emergency']
const lane = (over) => laneBlocks({ klass: 'discretionary', bunker: false, laneHeld: false, hard: false, jobRunning: false, meleeThreat: false, ...over })

test('the ledger names the last reflex that took the legs since a mark, and a stop names nobody', () => {
  const legs = legLedger()
  const m = legs.mark()
  assert.strictEqual(legs.takenSince(m), null, 'control: nothing taken yet')
  legs.take('combat', 'flee')
  legs.take('lava_watch', 'back away from lava')
  assert.deepStrictEqual(legs.takenSince(m), { reflex: 'lava_watch', why: 'back away from lava' })
  assert.strictEqual(legs.takenSince(legs.mark()), null, 'a take before the mark counts')
  legs.take(null)
  assert.strictEqual(legs.takenSince(m), null, 'the pilot stop still names the reflex before it')
})

test('the quiet after a reflex take lasts 3 s, 5 s after the hurt freeze or a lava take, and the pilot stop leaves none', () => {
  const legs = legLedger()
  assert.strictEqual(legs.quietUntil(), 0, 'control: nothing taken yet')
  legs.take('unstuck', 'break a pathing wedge', 1000)
  assert.strictEqual(legs.quietUntil(), 1000 + QUIET_MS)
  legs.take('hurt', 'freeze after an unexplained hit', 2000)
  assert.strictEqual(legs.quietUntil(), 2000 + LONG_QUIET_MS)
  legs.take('lava_watch', 'back away from lava', 3000)
  assert.strictEqual(legs.quietUntil(), 3000 + LONG_QUIET_MS)
  legs.take(null)
  assert.strictEqual(legs.quietUntil(), 0)
  assert.deepStrictEqual([QUIET_MS, LONG_QUIET_MS], [3000, 5000])
})

test('takenText names the reflex and what it took the legs for', () => {
  assert.strictEqual(takenText({ reflex: 'combat', why: 'flee' }), 'the combat reflex took the legs to flee')
  assert.strictEqual(takenText({ reflex: 'unstuck', why: null }), 'the unstuck reflex took the legs')
})

test('with no job running the lane decides as before', () => {
  for (const klass of KLASSES) assert.strictEqual(lane({ klass }), false, `${klass} with a free lane`)
  assert.strictEqual(lane({ klass: 'discretionary', laneHeld: true }), true, 'discretionary under a held lane')
  assert.strictEqual(lane({ klass: 'interrupt', laneHeld: true }), false, 'interrupt under a soft lane')
  assert.strictEqual(lane({ klass: 'interrupt', laneHeld: true, hard: true }), true, 'interrupt under a hard lane')
  assert.strictEqual(lane({ klass: 'emergency', laneHeld: true, hard: true }), false, 'emergency under a hard lane')
  for (const klass of KLASSES) assert.strictEqual(lane({ klass, bunker: true }), true, `${klass} while a bunker holds`)
})

test('a running job keeps the legs from all but emergencies until a threat is in melee range', () => {
  assert.strictEqual(lane({ klass: 'discretionary' }), false, 'control: no job')
  assert.strictEqual(lane({ klass: 'discretionary', jobRunning: true }), true, 'discretionary during a job')
  assert.strictEqual(lane({ klass: 'interrupt', jobRunning: true }), true, 'interrupt during a job')
  assert.strictEqual(lane({ klass: 'emergency', jobRunning: true }), false, 'emergency during a job')
  assert.strictEqual(lane({ klass: 'discretionary', jobRunning: true, meleeThreat: true }), false, 'discretionary with a threat in melee range')
  assert.strictEqual(lane({ klass: 'interrupt', jobRunning: true, meleeThreat: true }), false, 'interrupt with a threat in melee range')
})

test('a pillar top holds the legs from every flee but an emergency at disengage health with a mob in melee reach', async () => {
  const entity = { position: new Vec3(0.5, 64, 0.5) }
  const env = {
    bot: { entity, blockAt: (p) => ({ name: 'stone', boundingBox: 'block', position: p }) },
    bunker: { building: false },
    BUNKER_WALK: 'refused while a bunker is being built',
    perch: { cell: null },
    fillers: () => [{ name: 'dirt', count: 64 }],
    pillarHeight: (height) => ({ height, safe: 2, why: 'flat ground' }),
    BUNKER_MAX_HEIGHT: 6,
    knownCell: () => false,
    jumpPlace: async () => {
      entity.position = entity.position.offset(0, 1, 0)
      return true
    }
  }
  await awaitRoute('/pillar', { height: '3' }, env)
  const { perchHolds } = loadBotFunctions(['perchHolds'], env)
  const onTop = (over) => lane({ perch: perchHolds(), ...over })
  for (const klass of KLASSES) assert.strictEqual(onTop({ klass }), true, `${klass} on the pillar top`)
  assert.strictEqual(onTop({ klass: 'interrupt', hpMelee: true }), true, 'an interrupt at disengage health')
  assert.strictEqual(onTop({ klass: 'emergency', hpMelee: true }), false, 'an emergency at disengage health')
  Object.assign(entity, { position: new Vec3(0.5, 68.18, 0.5), onGround: false })
  assert.strictEqual(onTop({ klass: 'discretionary' }), true, 'a jump on the pillar top')
  entity.position = new Vec3(1.5, 67.5, 0.5)
  assert.strictEqual(onTop({ klass: 'discretionary' }), false, 'once the body stepped off into the air beside it')
  assert.strictEqual(env.perch.cell, null)
})

test('a stopped walk names the reflex that took the legs during it, nothing else does', () => {
  const legs = legLedger()
  const { namedStop } = loadBotFunctions(['namedStop'], { legs, takenText })
  const mark = legs.mark()
  const stopped = { arrived: false, reason: 'stopped', hint: 'check /jobs, wait a beat, try again' }
  assert.deepStrictEqual(namedStop(stopped, mark), stopped, 'control: no reflex took the legs')
  legs.take('combat', 'take cover')
  const r = namedStop(stopped, mark)
  assert.strictEqual(r.takenBy, 'the combat reflex took the legs to take cover')
  assert.strictEqual(r.hint, stopped.hint)
  const stalled = { arrived: false, reason: 'stalled', hint: 'h' }
  assert.deepStrictEqual(namedStop(stalled, mark), stalled, 'a walk that ended for another reason')
  assert.deepStrictEqual(namedStop(stopped, legs.mark()), stopped, 'a take before the route began')
})

test('every take of the legs ends the walk routes begun before it, and the route mark names the reflex', () => {
  const legs = legLedger()
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  bot.pathfinder = { goal: null }
  const { walkRoute, namedStop } = loadBotFunctions(['walkRoute', 'namedStop'], { bot, legs, takenText, routeDeadline, stopPath () {} })
  const stopped = { reason: 'stopped' }
  const route = walkRoute()
  assert.strictEqual(route.stopped(), false, 'control: nothing took the legs')
  legs.take('lava_watch', 'back away from lava')
  assert.strictEqual(route.stopped(), true)
  assert.strictEqual(namedStop(stopped, route.mark).takenBy, 'the lava_watch reflex took the legs to back away from lava')
  route.end()
  const next = walkRoute()
  assert.strictEqual(next.stopped(), false, 'a take before the route began')
  legs.take(null)
  assert.strictEqual(next.stopped(), true, 'the pilot stop ends it too')
  assert.strictEqual(namedStop(stopped, next.mark).takenBy, undefined, 'and names nobody')
  next.end()
})

// The leg and job takes of one melee swing at a zombie 2 blocks off, under a stance that chases or not.
async function meleeSwing ({ chase, goal }) {
  const zombie = { id: 7, name: 'zombie', position: new Vec3(2.5, 64, 0.5) }
  const takes = []
  let waits = 0
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 7: zombie },
    health: 20,
    food: 20,
    inventory: { items: () => [], slots: [] },
    heldItem: null,
    pathfinder: { goal, isMoving: () => !!goal, setGoal (g) { this.goal = g } },
    lookAt: async () => {},
    waitForTicks: async () => {},
    attack () {}
  }
  const env = {
    bot,
    STANCES: { s: { fleeDist: 16, bowBand: [7, 24], chase, engage: 'closers' } },
    stance: 's',
    LEGACY_1710: false,
    guardState: { up: false, slot: -1, pilot: false },
    lastHit: { dmg: 0, t: 0 },
    lastAttackT: 0,
    mobHurt: { wait: () => 0 },
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false },
    mcData: null,
    goals,
    headFree: () => true,
    compass: () => 'E',
    emitEvent () {},
    mobClass: () => 'hostile',
    airFlood: () => ({}),
    knownCell: () => true,
    entityPerceptible: () => true,
    nearHostiles: () => [],
    inMeleeReach: () => true,
    meleeAim: (e, y) => e.position.offset(0, y, 0),
    disengageHp: () => 8,
    yieldJob: (reflex, why) => takes.push(['job', reflex, why]),
    takeLegs: (reflex, why) => takes.push(['legs', reflex, why]),
    threatWhy: (what) => what,
    laneBlocks: () => false,
    laneNarrate () {},
    drawAndLoose: async () => false,
    strikeRun: { lane: null },
    // The zombie dies after the first swing.
    setTimeout: (fn) => {
      if (++waits === 2) delete bot.entities[7]
      setImmediate(fn)
    }
  }
  loadBotFunctions(['chargedSwing'], env)
  const combat = combatReflexIn(env)
  combat._threat = { e: zombie, cls: 'hostile', dist: 2, confirmed: false }
  await combat.act(bot)
  return { takes, goal: bot.pathfinder.goal }
}

test('a melee fight ends the running job but leaves a walk its legs, and a chase stance takes them by name', async () => {
  const walk = new goals.GoalNear(20, 64, 0, 0)
  const melee = ['job', 'combat', 'fight in melee range']
  assert.deepStrictEqual(await meleeSwing({ chase: false, goal: walk }), { takes: [melee], goal: walk })
  assert.deepStrictEqual(await meleeSwing({ chase: true, goal: walk }), { takes: [melee, ['legs', 'combat', 'fight in melee range']], goal: null })
  assert.deepStrictEqual(await meleeSwing({ chase: true, goal: null }), { takes: [melee], goal: null }, 'no goal to take')
})
