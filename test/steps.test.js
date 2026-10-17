'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { stepView } = require('../lib/steps')

const block = (name, boundingBox) => ({ name, boundingBox, shapes: boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [] })
const AIR = block('air', 'empty')
const STONE = block('stone', 'block')
const WATER = block('water', 'empty')

// Stone up to the floor height of each column (default 63), so a column at 64 is a step up.
function terrain (floors = {}, cells = {}) {
  return (p) => {
    const k = `${p.x},${p.y},${p.z}`
    if (cells[k]) return cells[k]
    const top = floors[`${p.x},${p.z}`] ?? 63
    return p.y <= top ? STONE : AIR
  }
}

const FEET = new Vec3(0.5, 64, 0.5)
const all = () => true

test('the step view shows the step to each stand cell around the feet, north up', () => {
  // North a step up, east a 2-block dip, west a wall, south a pit, south-west water.
  const blockAt = terrain({ '0,-1': 64, '1,0': 61, '-1,0': 70, '0,1': 40, '-1,1': 60 }, { '-1,61,1': WATER, '-1,62,1': WATER, '-1,63,1': WATER, '-1,64,1': WATER })
  assert.strictEqual(stepView(blockAt, all, FEET, 1), [
    '  0 +1  0',
    '  #  @ -2',
    '  ~  v  0'
  ].join('\n'))
})

test('a step the bot has not seen shows as unknown', () => {
  const blockAt = terrain({ '0,-1': 64 })
  const seen = (p) => !(p.x === 0 && p.z === -1)
  assert.strictEqual(stepView(blockAt, all, FEET, 1).split('\n')[0], '  0 +1  0', 'control: in sight')
  assert.strictEqual(stepView(blockAt, seen, FEET, 1).split('\n')[0], '  0  ?  0')
})

test('a wall or a pit whose cell level with the feet the bot has not seen shows as unknown', () => {
  // East a wall, south a pit, every cell seen but the one level with the feet.
  const blockAt = terrain({ '1,0': 70, '0,1': 40 })
  const hidden = (p) => !(p.y === 64 && ((p.x === 1 && p.z === 0) || (p.x === 0 && p.z === 1)))
  const grid = (known) => stepView(blockAt, known, FEET, 1).split('\n')
  assert.deepStrictEqual([grid(all)[1].trim(), grid(all)[2].trim()], ['0  @  #', '0  v  0'], 'control: in sight')
  assert.deepStrictEqual([grid(hidden)[1].trim(), grid(hidden)[2].trim()], ['0  @  ?', '0  ?  0'])
})

test('water and lava read as liquid and a filled cauldron as a wall', () => {
  // West water over a pit, east lava, south a cauldron under a ledge.
  const blockAt = terrain({ '-1,0': 60, '1,0': 60 }, {
    '-1,61,0': WATER, '-1,62,0': WATER, '-1,63,0': WATER, '-1,64,0': WATER,
    '1,61,0': block('lava', 'empty'), '1,62,0': block('lava', 'empty'), '1,63,0': block('lava', 'empty'), '1,64,0': block('lava', 'empty'),
    '0,64,1': block('water_cauldron', 'block'), '0,65,1': STONE, '0,66,1': STONE, '0,67,1': STONE
  })
  assert.strictEqual(stepView(blockAt, all, FEET, 1).split('\n')[1], '  ~  @  ~', 'liquid')
  assert.strictEqual(stepView(blockAt, all, FEET, 1).split('\n')[2], '  0  #  0', 'cauldron')
})

test('a body sunk into farmland or standing on a slab reads level ground as 0', () => {
  const blockAt = terrain()
  assert.strictEqual(stepView(blockAt, all, new Vec3(0.5, 63.94, 0.5), 1), ['  0  0  0', '  0  @  0', '  0  0  0'].join('\n'))
})
