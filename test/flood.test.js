'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { loadBotFunctions } = require('./helpers')

const AIR = { name: 'air', boundingBox: 'empty' }
const STONE = { name: 'stone', boundingBox: 'block' }
const ck = (x, y, z) => x + ',' + y + ',' + z

// Two air rooms in stone along x on y 64-65, z 0: the body stands in 0..2, the other is 5..7, joined when open.
function rooms (open) {
  const room = (p) => (p.y === 64 || p.y === 65) && p.z === 0 && p.x >= 0 && p.x <= 7 && (open || p.x <= 2 || p.x >= 5)
  const asked = []
  const env = {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: (p) => (room(p) ? AIR : STONE) },
    ck,
    Vec3
  }
  const { airFlood } = loadBotFunctions(['airFlood'], env)
  const flood = (known) => airFlood({ radius: 12, cap: 15000, targets: new Set([ck(6, 64, 0)]), known: (p) => { asked.push(p); return known(p) } })
  return { flood, asked, room }
}

test('a flood that reaches its target asks about no cell', () => {
  const { flood, asked } = rooms(true)
  const fill = flood(() => true)
  assert.ok(fill.reached)
  assert.deepStrictEqual([asked.length, fill.unknown], [0, false])
})

test('a closed flood asks only about the cells that stopped it, and an unknown one leaves it unsettled', () => {
  const { flood, asked, room } = rooms(false)
  const closed = flood(() => true)
  assert.deepStrictEqual([closed.reached, closed.unknown], [null, false], 'control: every wall known')
  assert.ok(asked.length > 0)
  assert.ok(asked.every((p) => !room(p)), 'it asked about an open cell')
  assert.strictEqual(new Set(asked.map((p) => ck(p.x, p.y, p.z))).size, asked.length, 'it asked about a cell twice')
  asked.length = 0
  assert.strictEqual(flood((p) => !(p.x === 3 && p.y === 64)).unknown, true, 'the wall between the rooms is unseen')
})

test('a closed flood that keeps its walls and asks no known gives the walls', () => {
  const { room } = rooms(false)
  const env = { bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: (p) => (room(p) ? AIR : STONE) }, ck, Vec3 }
  const fill = loadBotFunctions(['airFlood'], env).airFlood({ radius: 12, cap: 15000, keepWalls: true })
  assert.deepStrictEqual([fill.capped, fill.reached, fill.unknown, fill.cells.size], [false, null, false, 6])
  assert.ok(fill.walls.has(ck(1, 63, 0)), 'the floor under the body')
  assert.ok(fill.walls.has(ck(3, 64, 0)), 'the wall between the rooms')
})
