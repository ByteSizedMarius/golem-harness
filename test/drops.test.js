'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { enclosedDrop } = require('../lib/drops')
const { loadBotFunctions } = require('./helpers')

const AIR = { name: 'air', boundingBox: 'empty', shapes: [] }
const STONE = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
const key = (p) => `${p.x},${p.y},${p.z}`

// Stone everywhere but the open cells, every cell known unless listed in unknown.
function world (open, unknown = []) {
  const air = new Set(open)
  const hidden = new Set(unknown)
  return {
    blockAt: (p) => (air.has(key(p)) ? AIR : STONE),
    known: (p) => !hidden.has(key(p))
  }
}

// A drop resting on the floor of cell (0, 64, 0), sunk a little into it.
const DROP = new Vec3(0.5, 63.8, 0.5)

test('a drop in a one-high pocket no body fits beside is enclosed at its cell', () => {
  assert.strictEqual(enclosedDrop(DROP, world(['0,64,0', '0,65,0'])), null, 'control: a two-high cell holds a body over the drop')
  assert.deepStrictEqual({ ...enclosedDrop(DROP, world(['0,64,0'])) }, { x: 0, y: 64, z: 0 })
})

test('a drop a body reaches from a cell beside it is not enclosed', () => {
  const pocket = ['0,64,0']
  assert.ok(enclosedDrop(DROP, world(pocket)), 'control: the pocket alone is enclosed')
  assert.strictEqual(enclosedDrop(DROP, world([...pocket, '1,64,0', '1,65,0'])), null, 'a corridor cell beside the pocket')
  assert.strictEqual(enclosedDrop(DROP, world([...pocket, '1,63,0', '1,64,0'])), null, 'a cell one lower beside the pocket')
  assert.ok(enclosedDrop(DROP, world([...pocket, '2,64,0', '2,65,0'])), 'a cell two away is out of reach')
})

test('a cell the bot has not seen keeps a drop from reading as enclosed', () => {
  const pocket = ['0,64,0']
  assert.ok(enclosedDrop(DROP, world(pocket)), 'control: all known')
  assert.strictEqual(enclosedDrop(DROP, world([...pocket, '1,64,0', '1,65,0'], ['1,63,0', '1,64,0', '1,65,0'])), null, 'an unseen open cell beside it')
  assert.strictEqual(enclosedDrop(DROP, world(pocket, ['-1,64,0', '-1,65,0'])), null, 'unseen rock beside it')
})

test('collect marks a missed drop enclosed only where every cell around it is known', () => {
  const misses = [{ item: 'diamond', pos: { x: 0.5, y: 63.8, z: 0.5 }, reason: 'not-picked-up' }]
  const run = (unknown) => {
    const w = world(['0,64,0'], unknown)
    const env = { bot: { blockAt: w.blockAt }, cellKnown: w.known, enclosedDrop, xyz: (v) => ({ x: v.x, y: v.y, z: v.z }) }
    return JSON.parse(JSON.stringify(loadBotFunctions(['enclosedMisses'], env).enclosedMisses(misses)))
  }
  assert.deepStrictEqual(run([]), [{ ...misses[0], reason: 'enclosed', cell: { x: 0, y: 64, z: 0 } }])
  assert.deepStrictEqual(run(['1,64,0', '1,65,0']), misses, 'unseen cells beside the drop')
})

test('the collect hint names each enclosed cell and stays silent without one', () => {
  const { enclosedHint } = loadBotFunctions(['enclosedHint'], {})
  assert.strictEqual(enclosedHint([{ item: 'diamond', pos: {}, reason: 'not-picked-up' }]), null, 'control')
  const hint = enclosedHint([
    { item: 'diamond', pos: {}, reason: 'enclosed', cell: { x: 3, y: 12, z: -7 } },
    { item: 'coal', pos: {}, reason: 'no-path' }
  ])
  assert.match(hint, /^enclosed at 3,12,-7: /)
  assert.match(hint, /dig to it/)
  assert.match(hint, /place a block into its cell/)
})
