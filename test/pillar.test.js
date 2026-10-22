'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { awaitRoute } = require('./helpers')

// The first level of a 3-high pillar goes up, the second shoves the body by shove and fails.
function failedLevel (shove) {
  const entity = { position: new Vec3(0.5, 64, 0.5) }
  let level = 0
  return awaitRoute('/pillar', { height: '3' }, {
    bot: { entity, blockAt: (p) => ({ name: 'stone', boundingBox: 'block', position: p }) },
    bunker: { building: false },
    legs: legLedger(),
    takenText,
    perch: { cell: null },
    claimLane: () => ({}),
    releaseLane () {},
    fillers: () => [{ name: 'dirt', count: 64 }],
    pillarHeight: (height) => ({ height, safe: 2, why: 'flat ground' }),
    BUNKER_MAX_HEIGHT: 6,
    knownCell: () => false,
    jumpPlace: async () => {
      if (level++ === 0) {
        entity.position = entity.position.offset(0, 1, 0)
        return true
      }
      entity.position = entity.position.plus(shove)
      return false
    }
  })
}

test('a pillar names the knock-off when a failed placement leaves the body off its column', async () => {
  assert.deepStrictEqual(await failedLevel(new Vec3(1, -1, 0)), { placed: 1, rose: 0, stopped: 'knocked off the pillar column' })
  assert.deepStrictEqual(await failedLevel(new Vec3(0, 0, 0)), { placed: 1, rose: 1, stopped: 'placement would not take (ceiling? cell blocked?)' }, 'control: still on the column')
})
