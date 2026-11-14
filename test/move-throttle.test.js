'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { fakeClock, loadBotFunctions } = require('./helpers')

const GROUND = { onGround: true, hasHorizontalCollision: false }
const AIR = { onGround: false, hasHorizontalCollision: false }

// Starts at t 1000 with one move packet already on the wire.
// A clientbound position is answered as mineflayer's physics plugin does, inside its own handler.
function throttle () {
  const clock = fakeClock()
  const sent = []
  const listeners = {}
  const client = {
    write: (name, data) => sent.push({ t: clock.now(), name, data: { ...data } }),
    on: (event, fn) => (listeners[event] = listeners[event] || []).push(fn),
    emit (event, ...args) {
      for (const fn of listeners[event] || []) fn(...args)
      return true
    }
  }
  client.on('position', (p) => {
    client.write('teleport_confirm', { teleportId: p.teleportId })
    client.write('position_look', { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flags: AIR })
  })
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
  const correct = (ms, x, z, teleportId = 1) => {
    clock.advance(ms)
    client.emit('position', { x, y: 64, z, yaw: 90, pitch: 0, flags: 0, teleportId })
  }
  const moves = () => sent.filter((p) => p.name !== 'teleport_confirm')
  return { clock, sent, write, correct, client, moves }
}

const answer = (t, x, z) => ({ t, name: 'position_look', data: { x, y: 64, z, yaw: 90, pitch: 0, flags: AIR } })

test('a position and a look inside one window go out as one position_look', async (t) => {
  for (const [label, first, second, expected] of [
    ['position then look', ['position', { x: 1, y: 2, z: 3, flags: GROUND }], ['look', { yaw: 10, pitch: 20, flags: AIR }],
      { x: 1, y: 2, z: 3, yaw: 10, pitch: 20, flags: AIR }],
    ['look then position', ['look', { yaw: 10, pitch: 20, flags: GROUND }], ['position', { x: 1, y: 2, z: 3, flags: AIR }],
      { x: 1, y: 2, z: 3, yaw: 10, pitch: 20, flags: AIR }],
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

test('the answer to a server position goes out at once with its exact coordinates, also inside the window', () => {
  const { moves, correct } = throttle()
  correct(10, 5.5, -3.25)
  assert.deepStrictEqual(moves(), [answer(1010, 5.5, -3.25)])
})

test('a move pending from before a server position is dropped, never sent after the answer', () => {
  const { clock, moves, write, correct } = throttle()
  write(10, 'position', { x: 1, y: 64, z: 0, flags: GROUND })
  correct(10, 5.5, -3.25)
  clock.advance(100)
  assert.deepStrictEqual(moves(), [answer(1020, 5.5, -3.25)])
})

test('a move after the answer neither replaces nor merges into it and waits out the window', async (t) => {
  await t.test('later ticks', () => {
    const { clock, moves, write, correct } = throttle()
    correct(10, 5.5, -3.25)
    write(10, 'position', { x: 6, y: 64, z: 0, flags: GROUND })
    write(10, 'look', { yaw: 5, pitch: 1, flags: GROUND })
    clock.advance(100)
    assert.deepStrictEqual(moves(), [answer(1010, 5.5, -3.25),
      { t: 1060, name: 'position_look', data: { x: 6, y: 64, z: 0, yaw: 5, pitch: 1, flags: GROUND } }])
  })
  await t.test('another listener of the same server position', () => {
    const { clock, moves, client, correct } = throttle()
    client.on('position', () => client.write('look', { yaw: 7, pitch: 2, flags: GROUND }))
    correct(10, 5.5, -3.25)
    clock.advance(100)
    assert.deepStrictEqual(moves(), [answer(1010, 5.5, -3.25), { t: 1060, name: 'look', data: { yaw: 7, pitch: 2, flags: GROUND } }])
  })
})

test('two server positions in the same millisecond each get their answer', () => {
  const { clock, moves, correct } = throttle()
  correct(10, 5.5, -3.25, 1)
  correct(0, 7.5, -3.25, 2)
  clock.advance(100)
  assert.deepStrictEqual(moves(), [answer(1010, 5.5, -3.25), answer(1010, 7.5, -3.25)])
})
