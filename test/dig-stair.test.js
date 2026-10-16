'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { digJob } = require('./helpers')

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
