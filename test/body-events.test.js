'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { createCombat, bindCombat } = require('../lib/bot/combat')
const { createAlarms, bindAlarms, wireBodyAlarms } = require('../lib/bot/alarms')
const { createConnection, bindConnection, wireConnectionSpawn } = require('../lib/bot/connection')

// A spawned bot with the alarm and connection listeners wired, recording every emitted event.
function eventRig (t, { entityPerceptible = () => true } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const events = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    version: '1.21.11',
    registry: require('minecraft-data')('1.21.11'),
    entity: { id: 1, type: 'player', position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    players: {},
    health: 20,
    food: 20,
    pathfinder: { setMovements () {}, isMoving: () => false },
    async placeBlock () {}
  })
  const ctx = {
    bot,
    knownMoves: (m) => m,
    navPlaced: [],
    startReflexes () {},
    vecStr: (p) => `${p.x},${p.y},${p.z}`,
    emitEvent: (kind, msg, data) => { events.push({ kind, data: data || null }) },
    waterState: () => null,
    round: (p) => p,
    entityPerceptible,
    reflexes: [{ name: 'combat', fairFill: () => null }],
    liveEntities: () => [],
    nightfall: (fired) => fired,
    bunker: { building: false },
    freezeBody () {},
    waypoints: { set () {} },
    memory: { lastWaypoint: 'home' },
    deaths: { died () {} }
  }
  createCombat(ctx)
  createAlarms(ctx)
  createConnection(ctx)
  bindCombat(ctx)
  bindAlarms(ctx)
  bindConnection(ctx)
  wireBodyAlarms()
  wireConnectionSpawn()
  bot.emit('spawn')
  const update = async (food) => {
    bot.food = food
    await Promise.all(bot.listeners('health').map((f) => f()))
  }
  return { bot, events, update, memory: ctx.memory }
}

test('every hostile mob in sight raises a hostile event, a neutral one does not', (t) => {
  const { bot, events } = eventRig(t)
  for (const [id, name] of [[2, 'blaze'], [3, 'piglin'], [4, 'creeper']]) {
    bot.emit('entitySpawn', { id, name, type: 'mob', position: new Vec3(id + 3, 64, 0.5) })
  }
  assert.deepStrictEqual(events.filter((e) => e.kind === 'hostile').map((e) => e.data.mob), ['blaze', 'creeper'])
})

test('a hostile mob the body cannot perceive raises no hostile event', (t) => {
  const { bot, events } = eventRig(t, { entityPerceptible: (en) => en.id !== 3 })
  for (const id of [2, 3]) bot.emit('entitySpawn', { id, name: 'zombie', type: 'mob', position: new Vec3(id + 3, 64, 0.5) })
  assert.deepStrictEqual(events.filter((e) => e.kind === 'hostile').map((e) => e.data.id), [2])
})

test('one death sends one death event', (t) => {
  const { bot, events } = eventRig(t)
  bot.emit('death')
  assert.deepStrictEqual(events.map((e) => e.kind), ['death'])
})

test('a death forgets the waypoint the body last stood at', (t) => {
  const { bot, memory } = eventRig(t)
  assert.strictEqual(memory.lastWaypoint, 'home', 'control')
  bot.emit('death')
  assert.strictEqual(memory.lastWaypoint, null)
})

test('food falling to 7 then 6 sends one low_food event carrying the food level', async (t) => {
  const { events, update } = eventRig(t)
  await update(20)
  await update(7)
  await update(6)
  assert.deepStrictEqual(events, [{ kind: 'low_food', data: { food: 7 } }])
})
