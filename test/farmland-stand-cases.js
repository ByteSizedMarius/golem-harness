'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { goals } = require('mineflayer-pathfinder')
const { standCell, arrivedAt } = require('../lib/walk')
const { farmlandTop } = require('./helpers')

const block = (name, boundingBox, height) => ({ name, boundingBox, shapes: height ? [[0, 0, 0, 1, height, 1]] : [] })
const AIR = block('air', 'empty')
const STONE = block('stone', 'block', 1)

const ground = (top, cells = {}) => (y) => cells[y] || (y <= top ? STONE : AIR)

// columns: { 'x,z': (y) => block }. Every other column is unloaded.
function world (columns) {
  return (p) => {
    const col = columns[`${p.x},${p.z}`]
    return col ? col(p.y) : null
  }
}

const cellOf = (v) => v && { x: v.x, y: v.y, z: v.z }

// feet is the y the body's feet rest at on the farmland block at y 63.
function farmlandStandCases ({ feet = 63.94 } = {}) {
  const FARMLAND = block('farmland', 'block', farmlandTop())
  const sunk = feet < 64

  test(`standCell stands on farmland from feet ${sunk ? 'sunk into it' : 'on its top'}`, () => {
    const blockAt = world({ '0,0': ground(62, { 63: FARMLAND }) })
    assert.deepStrictEqual(cellOf(standCell(blockAt, 0.5, 0.5, feet)), { x: 0, y: 64, z: 0 })
  })

  test(`arrivedAt counts feet ${sunk ? 'sunk into farmland' : 'on top of farmland'} as standing on the cell above it`, () => {
    const goal = new goals.GoalBlock(0, 64, 0)
    assert.strictEqual(arrivedAt(goal, { x: 0.5, y: feet, z: 0.5 }), true)
    assert.strictEqual(arrivedAt(goal, { x: 1.5, y: feet, z: 0.5 }), false, 'a cell to the side')
  })
}

module.exports = { block, AIR, STONE, ground, world, cellOf, farmlandStandCases }
