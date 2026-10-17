'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { digJob, facings } = require('./helpers')

const UP_EAST = { dir: 'e', up: '1', steps: '2', torch: '0' }

test('dig_stair carves its steps up or down and fills a missing step from filler', async () => {
  const up = await digJob('/dig_stair', UP_EAST)
  assert.deepStrictEqual([up.stopped, up.climbed, up.endY], ['steps done', 2, 66])
  assert.deepStrictEqual(up.dug, ['0,66,0', '1,67,0', '1,66,0', '1,65,0', '2,68,0', '2,67,0', '2,66,0'])
  assert.deepStrictEqual(up.fills, [])

  const down = await digJob('/dig_stair', { ...UP_EAST, up: '0' }, { air: ['0,64,0', '0,65,0', '1,62,0'] })
  assert.deepStrictEqual([down.stopped, down.climbed, down.endY], ['steps done', -2, 62])
  assert.deepStrictEqual(down.dug, ['1,65,0', '1,64,0', '1,63,0', '2,64,0', '2,63,0', '2,62,0'])
  assert.deepStrictEqual(down.fills, ['1,62,0'], 'the missing tread under the first step down')
})

test('dig_stair without a dir climbs the way the bot faces', async () => {
  for (const { name, yaw, step: [dx, dz] } of facings()) {
    const r = await digJob('/dig_stair', { up: '1', steps: '1', torch: '0' }, { yaw })
    assert.deepStrictEqual(r.dug, ['0,66,0', `${dx},67,${dz}`, `${dx},66,${dz}`, `${dx},65,${dz}`], `facing ${name}`)
  }
})

test('dig_stair with an unknown dir climbs and is named the way the bot faces', async () => {
  const DIR = { '0,-1': 'n', '0,1': 's', '1,0': 'e', '-1,0': 'w' }
  for (const { name, yaw, step: [dx, dz] } of facings()) {
    const r = await digJob('/dig_stair', { dir: 'up', up: '1', steps: '1', torch: '0' }, { yaw })
    assert.deepStrictEqual([r.dug[1], r.name], [`${dx},67,${dz}`, `dig_stair up ${DIR[[dx, dz].join()]} x1`], `facing ${name}`)
  }
})

test('dig_stair up stops where the sky shows, at any height', async () => {
  const deep = await digJob('/dig_stair', { ...UP_EAST, steps: '6' })
  assert.deepStrictEqual([deep.stopped, deep.endY], ['steps done', 70], 'no sky in sight')
  const r = await digJob('/dig_stair', { ...UP_EAST, steps: '6' }, { sky: (p) => p.y >= 67 })
  assert.deepStrictEqual([r.stopped, r.endY], ['sky in sight', 67])
})

test('dig_stair counts no cave air as dug', async () => {
  const up = await digJob('/dig_stair', UP_EAST, { blocks: { '1,66,0': 'cave_air', '2,68,0': 'cave_air' } })
  assert.deepStrictEqual([up.stopped, up.climbed, up.endY], ['steps done', 2, 66])
  assert.deepStrictEqual(up.dug, ['0,66,0', '1,67,0', '1,65,0', '2,67,0', '2,66,0'])
})

// Going up east from (0, 64, 0), the second dig is the passage's top cell at (1, 67, 0).
test('dig_stair names gravel over its passage only once a dig lays it bare', async () => {
  const gravel = { blocks: { '1,67,0': 'gravel', '1,68,0': 'gravel' } }
  const known = await digJob('/dig_stair', UP_EAST, { ...gravel, known: ['1,67,0'] })
  assert.match(known.stopped, /gravel/, 'control: known gravel in the passage stops the stair')
  assert.deepStrictEqual(known.dug, [], 'control: dug under known gravel')

  const r = await digJob('/dig_stair', UP_EAST, gravel)
  assert.deepStrictEqual(r.dug, ['0,66,0', '1,67,0'], 'the stair stopped before the dig that laid the gravel bare')
  assert.match(r.stopped, /^gravel falling from 1,68,0\b/)
})
