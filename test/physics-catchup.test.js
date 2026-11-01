'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { performance } = require('node:perf_hooks')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const physicsPlugin = require('mineflayer/lib/plugins/physics')

test('physics drops the ticks of an event-loop stall instead of replaying them', async (t) => {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.end = () => {}
  client.write = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  await once(bot, 'inject_allowed')
  bot.loadPlugin(physicsPlugin)
  // tickPhysics reads the block under the body once per tick.
  let ticks = 0
  Object.assign(bot, {
    physicsEnabled: false,
    isAlive: true,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, eyeHeight: 1.62, onGround: true },
    blockAt: () => { ticks++; return {} }
  })
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  let skew = 0
  t.mock.method(performance, 'now', () => Date.now() + skew)
  // One large mock tick runs every due interval at its end time, so time advances one interval at a time.
  const advance = (ms) => { for (let i = 0; i < ms / 50; i++) t.mock.timers.tick(50) }
  bot.emit('login')
  client.emit('position', { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, flags: {}, teleportId: 1 })
  advance(500)

  // The interval fires once after a 4 s stall.
  skew += 4000
  advance(50)
  ticks = 0
  advance(1000)
  assert.ok(ticks >= 16 && ticks <= 24, `${ticks} physics ticks in the second after the stall`)
})
