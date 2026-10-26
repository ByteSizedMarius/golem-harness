'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { createSerializer, createDeserializer, states } = require('minecraft-protocol')
const registryFor = require('prismarine-registry')
const bed = require('mineflayer/lib/plugins/bed')
const { loadBotFunctions } = require('./helpers')

const BOT_ID = 7
const GOAL = { x: 4, y: 64, z: -2 }

// A body on version with mineflayer's bed plugin, every packet it writes pushed to order.
function bodyOn (version, order) {
  const bot = new EventEmitter()
  bot.registry = registryFor(version)
  bot.supportFeature = bot.registry.supportFeature
  bot._client = new EventEmitter()
  bot._client.write = (name, params) => order.push({ name, ...params })
  bot.entity = { id: BOT_ID }
  bed(bot)
  return bot
}

// bot's setGoal wrapped by leaveBedFirst, each goal the inner setGoal gets pushed to order.
function wrappedSetGoal (bot, order) {
  const { leaveBedFirst } = loadBotFunctions(['leaveBedFirst'], { bot, console: { log: (line) => order.push(line) } })
  return leaveBedFirst((goal, dynamic) => {
    order.push({ goal, dynamic })
    return 'planned'
  })
}

// The packet as the server reads it.
function serverReads (version, { name, ...params }) {
  const buf = createSerializer({ state: states.PLAY, isServer: false, version }).createPacketBuffer({ name, params })
  return createDeserializer({ state: states.PLAY, isServer: true, version }).parsePacketBuffer(buf).data
}

test('a goal for a body in bed leaves the bed before the goal reaches the pathfinder', () => {
  const order = []
  const bot = bodyOn('1.21.11', order)
  bot.isSleeping = true
  assert.strictEqual(wrappedSetGoal(bot, order)(GOAL, true), 'planned')
  assert.deepStrictEqual(order, [
    { name: 'entity_action', entityId: BOT_ID, actionId: 'leave_bed', jumpBoost: 0 },
    { goal: GOAL, dynamic: true }
  ])
  assert.strictEqual(order[1].goal, GOAL)
})

test('a goal for an awake body and a cleared goal for a body in bed pass through without a packet', () => {
  for (const [sleeping, goal] of [[false, GOAL], [true, null]]) {
    const order = []
    const bot = bodyOn('1.21.11', order)
    bot.isSleeping = sleeping
    assert.strictEqual(wrappedSetGoal(bot, order)(goal, false), 'planned')
    assert.deepStrictEqual(order, [{ goal, dynamic: false }], `sleeping ${sleeping}`)
    assert.strictEqual(order[0].goal, goal)
  }
})

test('mineflayer wake() sends leave bed as the server version reads it', async () => {
  for (const [version, actionId] of [['1.21.11', 'leave_bed'], ['1.21.4', 2]]) {
    const order = []
    const bot = bodyOn(version, order)
    bot.isSleeping = true
    await bot.wake()
    assert.strictEqual(order.length, 1, version)
    assert.deepStrictEqual(serverReads(version, order[0]), {
      name: 'entity_action', params: { entityId: BOT_ID, actionId, jumpBoost: 0 }
    }, version)
  }
})
