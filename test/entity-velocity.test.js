'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { createSerializer, createDeserializer, states } = require('minecraft-protocol')
const registryFor = require('prismarine-registry')
const entities = require('mineflayer/lib/plugins/entities')

const BOT_ID = 7
// A zombie hit's push, in blocks per tick.
const PUSH = { x: 0.4, y: 0.36, z: -0.2 }
// A standing player's velocity after a tick of gravity.
const STANDING = { x: 0, y: -0.0784, z: 0 }

function botOn (version) {
  const bot = new EventEmitter()
  bot.version = version
  bot.registry = registryFor(version)
  bot.supportFeature = bot.registry.supportFeature
  bot._client = new EventEmitter()
  entities(bot)
  bot._client.emit('login', { entityId: BOT_ID })
  return bot
}

// The lpVec3 as the 1.21.11 server and ViaVersion write it for a vector within one block per tick:
// scale and x, y, z packed into 48 bits, sent as two bytes and one big-endian int.
function serverLpVec3 ({ x, y, z }) {
  const pack = (v) => BigInt(Math.round((v * 0.5 + 0.5) * 32766))
  const bits = 1n | (pack(x) << 3n) | (pack(y) << 18n) | (pack(z) << 33n)
  const buf = Buffer.alloc(6)
  buf[0] = Number(bits & 0xffn)
  buf[1] = Number((bits >> 8n) & 0xffn)
  buf.writeUInt32BE(Number((bits >> 16n) & 0xffffffffn), 2)
  return buf
}

function serializer (version) {
  return createSerializer({ state: states.PLAY, isServer: true, version })
}

function parse (version, buf) {
  return createDeserializer({ state: states.PLAY, isServer: false, version }).parsePacketBuffer(buf).data.params
}

// A zero velocity is written as the single last byte 0.
function serverVelocityPacket (velocity) {
  const zero = serializer('1.21.11').createPacketBuffer({ name: 'entity_velocity', params: { entityId: BOT_ID, velocity: { x: 0, y: 0, z: 0 } } })
  return Buffer.concat([zero.subarray(0, -1), serverLpVec3(velocity)])
}

function assertVelocity (actual, expected) {
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-3, `${axis}: ${actual[axis]} vs ${expected[axis]}`)
  }
}

test('a server-encoded lpVec3 push on 1.21.11 sets the bot velocity in blocks per tick', () => {
  const bot = botOn('1.21.11')
  bot._client.emit('entity_velocity', parse('1.21.11', serverVelocityPacket(PUSH)))
  assertVelocity(bot.entity.velocity, PUSH)
})

test('a server-encoded lpVec3 standing velocity on 1.21.11 gives the bot no horizontal motion', () => {
  const bot = botOn('1.21.11')
  bot._client.emit('entity_velocity', parse('1.21.11', serverVelocityPacket(STANDING)))
  assertVelocity(bot.entity.velocity, STANDING)
})

test('minecraft-protocol writes an lpVec3 in the server layout', () => {
  const buf = serializer('1.21.11').createPacketBuffer({ name: 'entity_velocity', params: { entityId: BOT_ID, velocity: PUSH } })
  assert.deepStrictEqual(buf, serverVelocityPacket(PUSH))
})

test('a 1/8000 entity_velocity on 1.21.8 sets the bot velocity in blocks per tick', () => {
  const bot = botOn('1.21.8')
  const raw = { x: PUSH.x * 8000, y: PUSH.y * 8000, z: PUSH.z * 8000 }
  const buf = serializer('1.21.8').createPacketBuffer({ name: 'entity_velocity', params: { entityId: BOT_ID, velocity: raw } })
  bot._client.emit('entity_velocity', parse('1.21.8', buf))
  assertVelocity(bot.entity.velocity, PUSH)
})
