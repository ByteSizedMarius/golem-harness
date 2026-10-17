'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { routeHandler } = require('./helpers')

// The GET /tick handler over a body at position, with no hostiles, chat, events or jobs.
function tickHarness (position) {
  const env = {
    shared: { ready: true },
    bot: { entity: { position }, health: 20, food: 20, experience: { level: 0 }, heldItem: null, oxygenLevel: 20 },
    waterState: () => null,
    reflexes: [{ name: 'combat', fairFill: () => ({ cells: new Set() }) }],
    liveEntities: () => [],
    HOSTILE_NAMES: new Set(),
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    BOOT_ID: 'b0',
    chatLog: { cursor: 0, read: () => [] },
    streams: { eventSeq: 0, eventsServed: 0 },
    eventLog: [],
    jobs: { list: () => [] },
    lastTickSnap: null
  }
  const { handle, res } = routeHandler('/tick', env)
  return (query) => {
    handle({ query }, res)
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
    return res.body
  }
}

test('tick?delta=1 reports pos once a slow drift adds up to a block', () => {
  const position = new Vec3(0, 64, 0)
  const tick = tickHarness(position)
  assert.deepStrictEqual(tick({}).pos, { x: 0, y: 64, z: 0 }, 'control: the full tick sends pos')
  const sent = []
  for (let i = 0; i < 4; i++) {
    position.x += 0.25
    sent.push(tick({ delta: '1' }).pos)
  }
  assert.deepStrictEqual(sent, [undefined, undefined, undefined, { x: 1, y: 64, z: 0 }])
})
