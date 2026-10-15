'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { pacePlacements, PLACE_GAP_MS, PLACE_JITTER_MS } = require('../lib/pace')

const flush = () => new Promise(setImmediate)

// Places 1 to count in one burst on a fake clock that steps 5 ms at a time.
async function burst (t, count, failing = null) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const times = []
  const place = pacePlacements(async (n) => {
    if (n === failing) throw new Error('must be holding an item to place')
    times.push([n, Date.now()])
  })
  let settled = false
  const results = Promise.allSettled(Array.from({ length: count }, (_, i) => place(i + 1)))
  results.then(() => { settled = true })
  for (let i = 0; i < 1000 && !settled; i++) {
    await flush()
    t.mock.timers.tick(5)
  }
  assert.ok(settled, 'the placements never settled')
  return { outcomes: (await results).map((r) => r.status), times }
}

test('consecutive placements go out in order at least the gap apart, within the jitter', async (t) => {
  const { times } = await burst(t, 5)
  assert.deepStrictEqual(times.map(([n]) => n), [1, 2, 3, 4, 5])
  assert.strictEqual(times[0][1], 1000, 'the first placement waits for nothing')
  for (let i = 1; i < times.length; i++) {
    const gap = times[i][1] - times[i - 1][1]
    assert.ok(gap >= PLACE_GAP_MS && gap <= PLACE_GAP_MS + PLACE_JITTER_MS + 5, `gap ${gap} ms`)
  }
})

test('a failed placement leaves the queue running', async (t) => {
  const { outcomes, times } = await burst(t, 3, 2)
  assert.deepStrictEqual(outcomes, ['fulfilled', 'rejected', 'fulfilled'])
  assert.deepStrictEqual(times.map(([n]) => n), [1, 3])
  assert.ok(times[1][1] - times[0][1] >= PLACE_GAP_MS)
})
