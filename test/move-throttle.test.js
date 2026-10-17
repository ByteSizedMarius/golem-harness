'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { fakeClock, loadBotFunctions } = require('./helpers')

const GROUND = { onGround: true, hasHorizontalCollision: false }
const AIR = { onGround: false, hasHorizontalCollision: false }

// Starts at t 1000 with one move packet already on the wire.
function throttle () {
  const clock = fakeClock()
  const sent = []
  const client = { write: (name, data) => sent.push({ t: clock.now(), name, data: { ...data } }), emit () {} }
  const ctx = loadBotFunctions(['wireConnectionHardening'], {
    bot: { _client: client },
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    console: { log () {} }
  })
  ctx.wireConnectionHardening()
  clock.advance(1000)
  client.write('position', { x: 0, y: 64, z: 0, flags: GROUND })
  sent.length = 0
  const write = (ms, name, data) => {
    clock.advance(ms)
    client.write(name, data)
  }
  return { clock, sent, write }
}

test('a position and a look inside one window go out as one position_look', async (t) => {
  for (const [label, first, second, expected] of [
    ['position then look', ['position', { x: 1, y: 2, z: 3, flags: GROUND }], ['look', { yaw: 10, pitch: 20, flags: AIR }],
      { x: 1, y: 2, z: 3, yaw: 10, pitch: 20, flags: AIR }],
    ['look then position', ['look', { yaw: 10, pitch: 20, flags: GROUND }], ['position', { x: 1, y: 2, z: 3, flags: AIR }],
      { x: 1, y: 2, z: 3, yaw: 10, pitch: 20, flags: AIR }],
    ['position_look then look', ['position_look', { x: 1, y: 2, z: 3, yaw: 10, pitch: 20, flags: GROUND }], ['look', { yaw: 11, pitch: 21, flags: AIR }],
      { x: 1, y: 2, z: 3, yaw: 11, pitch: 21, flags: AIR }],
    ['position_look then position', ['position_look', { x: 1, y: 2, z: 3, yaw: 10, pitch: 20, flags: GROUND }], ['position', { x: 4, y: 5, z: 6, flags: AIR }],
      { x: 4, y: 5, z: 6, yaw: 10, pitch: 20, flags: AIR }]
  ]) {
    await t.test(label, () => {
      const { clock, sent, write } = throttle()
      write(10, ...first)
      write(10, ...second)
      clock.advance(100)
      assert.deepStrictEqual(sent, [{ t: 1050, name: 'position_look', data: expected }])
    })
  }
})

test('move packets of one kind inside one window collapse to the newest', () => {
  const { clock, sent, write } = throttle()
  for (const x of [1, 2, 3]) write(10, 'position', { x, y: 64, z: 0, flags: GROUND })
  clock.advance(100)
  assert.deepStrictEqual(sent, [{ t: 1050, name: 'position', data: { x: 3, y: 64, z: 0, flags: GROUND } }])
})

test('move packets reach the wire at most once per 50 ms and still deliver the newest position and look', () => {
  const { clock, sent, write } = throttle()
  for (let i = 1; i <= 50; i++) {
    if (i % 2) write(10, 'position', { x: i, y: 64, z: 0, flags: GROUND })
    else write(10, 'look', { yaw: i, pitch: 0, flags: GROUND })
  }
  clock.advance(100)
  const gaps = sent.slice(1).map((p, i) => p.t - sent[i].t)
  assert.ok(gaps.every((g) => g >= 50), `gaps ${gaps.join(', ')}`)
  assert.deepStrictEqual(Object.assign({}, ...sent.map((p) => p.data)), { x: 49, y: 64, z: 0, yaw: 50, pitch: 0, flags: GROUND })
})
