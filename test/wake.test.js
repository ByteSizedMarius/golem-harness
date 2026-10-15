'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { ambientChange, sameVein } = require('../lib/wake')
const { loadBotFunctions } = require('./helpers')

test('grass, snow and leaves coming and going are ambient, a dug or placed block is not', () => {
  for (const [from, to] of [['dirt', 'grass_block'], ['grass_block', 'dirt'], ['air', 'snow'], ['snow', 'air'],
    ['oak_leaves', 'air'], ['air', 'short_grass'], ['tall_grass', 'air'], ['short_grass', 'snow']]) {
    assert.ok(ambientChange(from, to), `${from} to ${to}`)
  }
  for (const [from, to] of [['grass_block', 'air'], ['dirt', 'air'], ['air', 'cobblestone'], ['oak_log', 'air'],
    ['air', 'snow_block'], ['air', 'water'], ['air', 'cave_air']]) {
    assert.ok(!ambientChange(from, to), `${from} to ${to}`)
  }
})

test('an ore block within 2 of an announced one of the same name joins its vein', () => {
  const announced = new Map([['10,40,10', { name: 'iron_ore' }]])
  assert.ok(sameVein(announced, 'iron_ore', new Vec3(12, 41, 9)))
  assert.ok(!sameVein(announced, 'iron_ore', new Vec3(13, 40, 10)), 'three apart')
  assert.ok(!sameVein(announced, 'coal_ore', new Vec3(11, 40, 10)), 'another ore')
})

// worldChangeEvent over the changes in buf, with the events it emits.
function worldChanges (buf) {
  const events = []
  const env = {
    changeBuf: buf,
    lastChangeEmit: 0,
    ambientChange,
    emitEvent: (kind, msg, data, opts) => events.push({ kind, msg, quiet: !!(opts && opts.quiet) })
  }
  loadBotFunctions(['worldChangeEvent'], env).worldChangeEvent()
  return events
}

const change = (from, to) => ({ from, to, dir: 'N', d: 4, t: 0 })

test('a burst of ambient world changes is a quiet event, a burst with a dug block wakes', () => {
  assert.deepStrictEqual(worldChanges([change('air', 'snow'), change('oak_leaves', 'air')]).map((e) => e.quiet), [true])
  assert.deepStrictEqual(worldChanges([change('air', 'snow'), change('stone', 'air')]).map((e) => e.quiet), [false])
})

test('the ore callout names a vein once, however many of its blocks come into view', () => {
  const events = []
  let exposed = []
  const env = {
    ready: true,
    bot: { entity: { position: new Vec3(0.5, 40, 0.5) }, blockAt: () => ({ name: 'iron_ore' }) },
    mcData: {},
    ORE_IDS: [1],
    ORE_ANNOUNCED: new Map(),
    Vec3,
    sameVein,
    findVisible: () => exposed,
    compass: () => 'E',
    emitEvent: (kind, msg) => events.push(msg)
  }
  const { oreCallout } = loadBotFunctions(['oreCallout'], env)
  const ore = (x, y, z) => ({ pos: new Vec3(x, y, z), dist: x })
  exposed = [ore(6, 40, 0)]
  oreCallout()
  exposed = [ore(6, 40, 0), ore(7, 40, 0), ore(8, 41, 1)]
  oreCallout()
  assert.strictEqual(events.length, 1)
  exposed = [ore(11, 40, 0)]
  oreCallout()
  assert.strictEqual(events.length, 2, 'a block three past the vein is another vein')
})
