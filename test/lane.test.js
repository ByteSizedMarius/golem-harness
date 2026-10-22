'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { performance } = require('node:perf_hooks')
const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { legLedger } = require('../lib/leg-ledger')
const { createLane, bindLane } = require('../lib/bot/lane')
const { loadBotFunctions } = require('./helpers')

function lane () {
  const env = { pilotLane: { until: 0, why: null, hard: false, narrated: 0, token: null } }
  return { env, ...loadBotFunctions(['claimLane', 'releaseLane', 'clearLane'], env) }
}

test('a route releases only its own lane claim, so a stale one leaves the newer claim held', () => {
  const { env, claimLane, releaseLane, clearLane } = lane()
  const old = claimLane('goto', 300000)
  clearLane()
  const fresh = claimLane('collect', 300000)
  releaseLane(old)
  assert.strictEqual(env.pilotLane.why, 'collect')
  assert.ok(env.pilotLane.until > Date.now(), 'the newer claim still holds the lane')
  releaseLane(fresh)
  assert.strictEqual(env.pilotLane.until, 0)
  releaseLane(null)
  assert.strictEqual(env.pilotLane.until, 0, 'a route that never claimed releases nothing')
})

test('a reflex move deferred to a job or to the pilot lane raises a lane event, no fight event', () => {
  const events = []
  const lane = {}
  let job = true
  createLane(lane)
  bindLane({ bot: { entity: { position: new Vec3(0.5, 64, 0.5) } }, hpMelee: () => false, jobs: { running: () => job }, meleeThreat: () => null, emitEvent: (kind, msg) => events.push([kind, msg]) })
  lane.laneNarrate('chase')
  job = false
  lane.claimLane('goto', 60000)
  lane.pilotLane.narrated = 0
  lane.laneNarrate('flee')
  lane.clearLane()
  assert.deepStrictEqual(events.map(([kind]) => kind), ['lane', 'lane'])
  assert.match(events[0][1], /^chase deferred, the running job keeps the legs$/)
  assert.match(events[1][1], /^flee deferred .* pilot lane held \(goto\)$/)
})

test('the pilot stop clears any claim', () => {
  const { env, claimLane, clearLane } = lane()
  claimLane('brace', 30000, true)
  clearLane()
  assert.deepStrictEqual([env.pilotLane.until, env.pilotLane.hard, env.pilotLane.token], [0, false, null])
})

// A pathfinder planning its first path: a goal set, no path walked yet. stop() only latches until the next node.
function planningPathfinder () {
  return {
    goal: { x: 5, y: 64, z: 5 },
    latched: false,
    isMoving () { return false },
    stop () { this.latched = true },
    setGoal (g) {
      this.goal = g
      this.latched = false
    }
  }
}

test('a freeze ends a path still being planned, so no step of it is walked', () => {
  const env = {
    bot: { pathfinder: planningPathfinder(), clearControlStates () {} },
    jobs: { yieldTo: () => false },
    legs: legLedger()
  }
  const mark = env.legs.mark()
  const { freezeBody } = loadBotFunctions(['freezeBody'], env)
  freezeBody()
  assert.deepStrictEqual([env.bot.pathfinder.goal, env.bot.pathfinder.latched], [null, false])
  assert.deepStrictEqual(env.legs.takenSince(mark), { reflex: 'hurt', why: 'freeze after an unexplained hit' }, 'the walk routes end and name the freeze')
})

test('a freeze ends the running job and names itself in the job', () => {
  const yielded = []
  let digStops = 0
  const env = {
    bot: { pathfinder: planningPathfinder(), clearControlStates () {}, stopDigging () { digStops++ } },
    jobs: { yieldTo: (taken) => { yielded.push(taken); return true } },
    legs: legLedger()
  }
  loadBotFunctions(['freezeBody'], env).freezeBody()
  assert.deepStrictEqual(yielded.map((t) => [t.reflex, t.why]), [['hurt', 'freeze after an unexplained hit']])
  assert.strictEqual(digStops, 1, 'the job is digging')
})

test('a goal set right after a reflex took the legs from a walking job stands under the real pathfinder', async () => {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.write = () => {}
  client.end = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  bot.loadPlugin(pathfinder)
  await once(bot, 'inject_allowed')
  Object.assign(bot, { entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) }, clearControlStates () {}, stopDigging () {} })
  const { takeLegs } = loadBotFunctions(['takeLegs'], { bot, jobs: { yieldTo: () => true }, legs: legLedger() })
  bot.pathfinder.setGoal(new goals.GoalNear(20, 64, 0, 1))
  takeLegs('combat', 'chase')
  const chase = new goals.GoalNear(5, 64, 5, 2)
  bot.pathfinder.setGoal(chase)
  assert.strictEqual(bot.pathfinder.goal, chase)
})

test('a nudge that ends during a drown rescue leaves the swim-up jump held', async () => {
  for (const swimming of [false, true]) {
    const controls = {}
    const env = {
      bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, lookAt: async () => {}, setControlState: (k, v) => { controls[k] = v } },
      bunker: { building: false },
      swimUpUntil: swimming ? Date.now() + 60000 : 0,
      require,
      setTimeout
    }
    const { nudgeInto } = loadBotFunctions(['nudgeInto'], env)
    controls.jump = true
    const t0 = performance.now()
    await nudgeInto(new Vec3(5, 64, 0), false, 3000, { expired: () => performance.now() - t0 > 50, stopped: () => false })
    assert.deepStrictEqual(controls, { forward: false, jump: swimming }, swimming ? 'swimming up' : 'control: no rescue running')
  }
})

test('a second drown rescue keeps the jump past the end of the first', async () => {
  const controls = {}
  const timers = []
  const env = {
    bot: { setControlState: (k, v) => { controls[k] = v } },
    swimUpUntil: 0,
    setTimeout: (fn, ms) => timers.push({ fn, ms })
  }
  const { swimUp } = loadBotFunctions(['swimUp'], env)
  swimUp(10)
  swimUp(60000)
  timers[0].fn()
  assert.strictEqual(controls.jump, true, 'the first timer leaves the second rescue its jump')
  env.swimUpUntil = Date.now()
  timers[1].fn()
  assert.strictEqual(controls.jump, false)
})
