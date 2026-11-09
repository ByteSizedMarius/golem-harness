'use strict'
// The lava watch backs the body away from lava in sight and stays quiet beside lava it already acted on.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { reflexIn, fakeClock } = require('./helpers')

const LAVA = { name: 'lava', boundingBox: 'empty' }
const AIR = { name: 'air', boundingBox: 'empty' }
const STONE = { name: 'stone', boundingBox: 'block' }
const ck = (x, y, z) => `${x},${y},${z}`
const SPOT = new Vec3(8.5, 81, 8.5)

// tick(ms) runs the reflex loop over ms, a check every 300 ms and an act on each hit.
function rig () {
  const clock = fakeClock()
  const lava = new Set()
  const unseen = new Set()
  const events = []
  const goals = []
  const bot = {
    entity: { position: SPOT.clone() },
    blockAt: (p) => ({ ...(lava.has(ck(p.x, p.y, p.z)) ? LAVA : p.y < 81 ? STONE : AIR), position: p }),
    pathfinder: { setGoal: (g) => goals.push(g) }
  }
  const r = reflexIn('lava_watch', {
    bot,
    Vec3,
    Date: { now: clock.now },
    bunker: { building: false },
    perceived: (c) => !unseen.has(ck(c.x, c.y, c.z)),
    takeLegs () {},
    stopPath () {},
    emitEvent: (kind, msg) => events.push(`${kind} ${msg}`),
    goals: { GoalNear: class { constructor (x, y, z, range) { Object.assign(this, { x, y, z, range }) } } }
  })
  const tick = async (ms) => {
    for (let t = 0; t < ms; t += 300) {
      clock.advance(300)
      if (r.check(bot)) await r.act(bot)
    }
  }
  return { bot, lava, unseen, events, goals, tick }
}

test('new lava after the shell held none acts with the body back on the cell of its last act', async () => {
  const { bot, lava, events, goals, tick } = rig()
  lava.add(ck(10, 81, 8))
  await tick(600)
  assert.strictEqual(events.length, 1, 'control: the first pour warns')
  bot.entity.position = new Vec3(goals[0].x, 81, goals[0].z)
  await tick(1000)
  lava.clear()
  await tick(33000)
  bot.entity.position = SPOT.clone()
  await tick(1500)
  lava.add(ck(8, 81, 10))
  await tick(300)
  assert.strictEqual(events.length, 2, events.join('\n'))
  assert.match(events[1], /^lava LAVA S ~2 /)
  assert.strictEqual(goals.length, 2)
  assert.deepStrictEqual([goals[1].x, goals[1].z], [8.5, 8.5 - 6], 'six blocks north, away from the lava 2 south')
})

test('lava that flows closer to a parked body acts at once', async () => {
  const { lava, events, goals, tick } = rig()
  lava.add(ck(10, 81, 8))
  await tick(10000)
  assert.strictEqual(events.length, 1, 'control: one warning for the lava 2 east')
  lava.add(ck(9, 81, 8))
  await tick(300)
  assert.strictEqual(events.length, 2, events.join('\n'))
  assert.match(events[1], /^lava LAVA E ~1 /)
  assert.strictEqual(goals.length, 2)
})

test('unchanged lava beside a parked body warns once', async () => {
  const { lava, events, goals, tick } = rig()
  lava.add(ck(10, 81, 8))
  lava.add(ck(10, 82, 8))
  await tick(120000)
  assert.strictEqual(events.length, 1, events.join('\n'))
  assert.strictEqual(goals.length, 1)
})

test('new lava no nearer than the known lava acts', async () => {
  const { lava, events, goals, tick } = rig()
  lava.add(ck(10, 81, 8))
  await tick(10000)
  lava.add(ck(6, 81, 7))
  await tick(300)
  assert.strictEqual(events.length, 2, events.join('\n'))
  assert.match(events[1], /^lava LAVA E ~2 /, 'the warning names the nearest lava')
  assert.strictEqual(goals.length, 2)
})

test('nearer lava the body cannot see stays quiet until it comes into sight', async () => {
  const { lava, unseen, events, tick } = rig()
  lava.add(ck(10, 81, 8))
  await tick(10000)
  lava.add(ck(9, 81, 8))
  unseen.add(ck(9, 81, 8))
  await tick(3000)
  assert.strictEqual(events.length, 1, 'unseen lava is no news')
  unseen.clear()
  await tick(300)
  assert.strictEqual(events.length, 2, events.join('\n'))
  assert.match(events[1], /^lava LAVA E ~1 /)
})

test('lava that spreads no nearer while the body backs off adds no warning', async () => {
  const { lava, events, goals, tick } = rig()
  lava.add(ck(10, 81, 8))
  await tick(1500)
  for (const cell of [ck(10, 81, 7), ck(10, 81, 9), ck(11, 81, 8)]) lava.add(cell)
  await tick(10000)
  assert.strictEqual(events.length, 1, events.join('\n'))
  assert.strictEqual(goals.length, 1)
})

test('new lava right after the shell emptied acts inside the back-off', async () => {
  const { lava, events, tick } = rig()
  lava.add(ck(10, 81, 8))
  await tick(600)
  lava.clear()
  await tick(600)
  lava.add(ck(8, 81, 10))
  await tick(300)
  assert.strictEqual(events.length, 2, events.join('\n'))
  assert.match(events[1], /^lava LAVA S ~2 /)
})
