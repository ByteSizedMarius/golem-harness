'use strict'
require('./full-farmland')
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { dropLandCases, walk, field, bedAbove, terrace } = require('./drop-land-cases')

dropLandCases({
  straight: [0.5, 64, 4.374],
  // The goal's stone row.
  airSprintPast: 9
})

const nodeAt = (r, node) => r.taken.find((k) => k.node.every((v, i) => v === node[i]))

for (const sprint of [false, true]) {
  test(`a ${sprint ? 'sprinting' : 'walking'} drop of 1 from a bed onto the path takes the path's node standing on it and walks as the same drop from stone`, async (t) => {
    const goal = new goals.GoalBlock(0, 64, 5)
    const r = await walk(t, new Vec3(0.5, 65, 0.5), goal, bedAbove(), { sprint })
    assert.deepStrictEqual(r.plan.slice(1, 4), [[0.5, 65, 2.5], [0.5, 64, 3.5], [0.5, 64, 4.5]])
    assert.ok(r.done)
    // The first touchdown is the start's own.
    assert.deepStrictEqual(r.touchdowns.slice(1).map((d) => [d.on, d.at[1], Math.floor(d.at[2])]), [['stone', 64, 3]])
    const path = nodeAt(r, [0.5, 64, 3.5])
    assert.deepStrictEqual([path.at[1], path.ground], [64, true])
    const stone = await walk(t, new Vec3(0.5, 65, 0.5), goal, terrace(), { sprint })
    assert.strictEqual(r.hash, stone.hash)
  })
}

for (const sprint of [false, true]) {
  test(`a ${sprint ? 'sprinting' : 'walking'} descent of the field's terraces takes each path's node standing on it and touches down on no bed`, async (t) => {
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(5, 62, 9), field(), { sprint })
    assert.ok(r.done)
    assert.deepStrictEqual(r.touchdowns.filter((d) => d.on === 'farmland'), [])
    for (const node of [[1.5, 64, 3.5], [2.5, 63, 6.5]]) {
      const path = nodeAt(r, node)
      assert.deepStrictEqual([path.at[1], path.ground], [node[1], true], JSON.stringify(node))
    }
  })
}
