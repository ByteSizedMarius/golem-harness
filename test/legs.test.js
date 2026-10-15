'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { legLedger, takenText, laneBlocks } = require('../lib/legs')
const { routeDeadline } = require('../lib/walk')
const { loadBotFunctions, combatReflexIn } = require('./helpers')

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
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false },
    mcData: null,
    goals,
    headFree: () => true,
    compass: () => 'E',
    emitEvent () {},
    mobClass: () => 'hostile',
    airFlood: () => ({}),
    nearHostiles: () => [],
    meleeReach: () => 3.2,
    yieldJob: (reflex, why) => takes.push(['job', reflex, why]),
    takeLegs: (reflex, why) => takes.push(['legs', reflex, why]),
    laneBlocks: () => false,
    laneNarrate () {},
    drawAndLoose: async () => false,
    // The zombie dies after the first swing.
    setTimeout: (fn) => {
      if (++waits === 2) delete bot.entities[7]
      setImmediate(fn)
    }
  }
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
