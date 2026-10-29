'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { createSerializer, createDeserializer, states } = require('minecraft-protocol')

function loadItems (legacy) {
  for (const m of ['../lib/bot/items', '../lib/bot/config']) delete require.cache[require.resolve(m)]
  const was = process.env.GOLEM_MC_1710
  process.env.GOLEM_MC_1710 = legacy ? '1' : '0'
  try {
    return require('../lib/bot/items')
  } finally {
    if (was === undefined) delete process.env.GOLEM_MC_1710
    else process.env.GOLEM_MC_1710 = was
  }
}

// A body holding hotbar slot 2 with the respawn listener wired, every packet it writes pushed to order.
function bodyHoldingSlot2 (legacy, order) {
  const { bindItems, wireRespawnHeldSlot } = loadItems(legacy)
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.write = (name, params) => order.push({ name, ...params })
  bot.quickBarSlot = 2
  bindItems({ bot })
  wireRespawnHeldSlot()
  return bot
}

// The packet as a 1.21.11 server reads it.
function serverReads ({ name, ...params }) {
  const version = '1.21.11'
  const buf = createSerializer({ state: states.PLAY, isServer: false, version }).createPacketBuffer({ name, params })
  return createDeserializer({ state: states.PLAY, isServer: true, version }).parsePacketBuffer(buf).data
}

test('a 1.7.10 respawn sends the client\'s hotbar slot to the server', () => {
  const order = []
  const bot = bodyHoldingSlot2(true, order)
  bot._client.emit('respawn', {})
  assert.deepStrictEqual(order, [{ name: 'held_item_slot', slotId: 2 }])
  assert.deepStrictEqual(serverReads(order[0]), { name: 'held_item_slot', params: { slotId: 2 } })
})

test('a 1.21.11 respawn writes nothing', () => {
  const order = []
  const bot = bodyHoldingSlot2(false, order)
  bot._client.emit('respawn', {})
  assert.deepStrictEqual(order, [])
})
