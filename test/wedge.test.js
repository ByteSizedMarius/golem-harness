'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const Block = require('prismarine-block')('1.21.11')
const { loadBotFunctions } = require('./helpers')

const WATER = ['water', { level: 0 }]

// A body at x, feet y on dirt over water between farmland, stone below y 149, plus cells, with bot.js's tick hooks wired.
function wedged (y, { x = 0.5, cells = {}, inWater = false, bed = null } = {}) {
  const world = { '0,149,0': ['dirt', {}], '0,148,0': WATER, '-1,149,0': ['farmland', { moisture: 7 }], '1,149,0': ['farmland', { moisture: 7 }], ...cells }
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(x, y, 0.5), velocity: new Vec3(0, -0.0784, 0), onGround: false, isInWater: inWater, isInLava: false }
  bot.blockAt = (p) => {
    const c = p.floored()
    const [name, props] = world[`${c.x},${c.y},${c.z}`] || [c.y < 149 ? 'stone' : 'air', {}]
    const b = Block.fromProperties(name, props, 0)
    b.position = c
    return b
  }
  const logs = []
  const clock = { t: 1000000 }
  const ctx = loadBotFunctions(['wirePathfinderTicks', 'beforePathfinder'], {
    bot,
    Vec3,
    shared: { ready: true, bed },
    seenNow: () => true,
    lastLift: null,
    skipPassedNodes () {},
    sprintSwitch () {},
    sprintGapCheck () {},
    console: { log: (s) => logs.push(s) },
    Date: { now: () => clock.t }
  })
  ctx.wirePathfinderTicks()
  return { bot, logs, clock }
}

const stance = (bot) => [bot.entity.position.y, bot.entity.onGround, bot.entity.velocity.y]

test('a body wedged 1/16 or one gravity tick into a full block stands on its top after one physics tick', () => {
  for (const y of [149.9375, 149.8591]) {
    const { bot } = wedged(y)
    bot.emit('physicsTick')
    assert.deepStrictEqual(stance(bot), [150, true, 0], `from ${y}`)
  }
})

test('a server correction that wedges the body lifts it at once', () => {
  const { bot } = wedged(150)
  bot.entity.position.y = 149.9375
  bot.emit('forcedMove')
  assert.deepStrictEqual(stance(bot), [150, true, 0])
})

test('a run of lifts out of one block logs one line, and a lift 5 s after the last logs again', () => {
  const { bot, logs, clock } = wedged(149.9375)
  const lift = (dt) => {
    clock.t += dt
    bot.entity.position.y = 149.9375
    bot.emit('forcedMove')
  }
  lift(0)
  lift(500)
  lift(4000)
  assert.deepStrictEqual(logs, ['[wedge] lifted onto the dirt at 0,149,0 from y 149.9375'])
  lift(5001)
  assert.strictEqual(logs.length, 2)
})

test('no lift from 0.2 deep, out of farmland or a slab, in water, or with a block where the head goes', () => {
  const cases = [
    ['0.2 deep', 149.8, {}],
    ['farmland', 149.875, { cells: { '0,149,0': ['farmland', { moisture: 7 }] } }],
    ['a top slab', 149.9375, { cells: { '0,149,0': ['oak_slab', { type: 'top' }] } }],
    ['in water', 149.9375, { cells: { '0,150,0': WATER, '0,151,0': WATER }, inWater: true }],
    ['a block over the head', 149.9375, { cells: { '0,151,0': ['stone', {}] } }]
  ]
  for (const [label, y, opts] of cases) {
    const { bot, logs } = wedged(y, opts)
    bot.emit('physicsTick')
    bot.emit('forcedMove')
    assert.deepStrictEqual([...stance(bot), logs], [y, false, -0.0784, []], label)
  }
})

test('a body in bed stays where the server laid it, partly in the block past the head', () => {
  const y = 149.9375
  const cells = { '0,149,0': ['red_bed', { facing: 'east', part: 'head', occupied: true }], '1,149,0': ['stone', {}] }
  const awake = wedged(y, { x: 0.9, cells })
  awake.bot.emit('physicsTick')
  assert.deepStrictEqual(stance(awake.bot), [150, true, 0], 'control: awake at the same spot')
  const { bot, logs } = wedged(y, { x: 0.9, cells, bed: { x: 0, y: 149, z: 0 } })
  bot.emit('physicsTick')
  bot.emit('forcedMove')
  assert.deepStrictEqual([...stance(bot), logs], [y, false, -0.0784, []])
})
