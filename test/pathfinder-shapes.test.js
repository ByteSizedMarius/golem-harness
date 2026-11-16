'use strict'
require('./full-farmland')
const test = require('node:test')
const assert = require('node:assert')
const { goals } = require('mineflayer-pathfinder')
const { knowing, steps, stepMoves, START, fieldPlanCases, fieldMoveCases } = require('./farmland-plan-cases')

// A bed on the start's level leaves no gap to jump over.
fieldPlanCases({ overBed: null, landings: 1 })
fieldMoveCases()

test('the walk legs step from a path onto a bed on its level as onto stone, and plan a walk across the beds on that level with every node at the block\'s top', async () => {
  const from = await stepMoves(() => null, [3, 64, 0])
  const cost = (key) => from.find((m) => m.key === key)?.cost
  assert.ok(cost('3,64,1') > 0)
  assert.strictEqual(cost('3,64,1'), cost('4,64,0'), 'control: a step along the stone path')
  const { open, solid } = steps()
  const r = (await knowing(START, { open, solid, seen: () => true })).plan(new goals.GoalBlock(3, 64, 2))
  assert.strictEqual(r.status, 'success')
  assert.deepStrictEqual(r.path.map((n) => [n.y, !!n.parkour]), r.path.map(() => [64, false]))
})
