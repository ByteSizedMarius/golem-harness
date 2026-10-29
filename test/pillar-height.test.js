'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { legLedger, takenText } = require('../lib/leg-ledger')
const shelter = require('../lib/shelter')
const { awaitRoute, botConstant } = require('./helpers')

const WHY = 'seen ground 4 above the feet within 3 blocks, out of reach from 6 up'

function pillar (query, blocks = 64) {
  const entity = { position: new Vec3(0.5, 64, 0.5) }
  return awaitRoute('/pillar', query, {
    bot: { entity, blockAt: (p) => ({ name: 'stone', boundingBox: 'block', position: p }) },
    bunker: { building: false },
    legs: legLedger(),
    takenText,
    perch: { cell: null },
    claimLane: () => ({}),
    releaseLane () {},
    fillers: () => [{ name: 'dirt', count: blocks }],
    pillarHeight: (height) => ({ height: Math.max(height, 6), safe: 6, why: WHY }),
    BUNKER_MAX_HEIGHT: 6,
    knownCell: () => false,
    jumpPlace: async () => {
      entity.position = entity.position.offset(0, 1, 0)
      return true
    }
  })
}

test('a pillar with a height builds that height and names the safe height when it is higher', async () => {
  assert.deepStrictEqual(await pillar({ height: '1' }), { placed: 1, rose: 1, y: 65, safe: WHY })
  assert.deepStrictEqual(await pillar({ height: '6' }), { placed: 6, rose: 6, y: 70 }, 'control: the asked height is safe')
})

test('a pillar without a height is raised to the safe height', async () => {
  assert.deepStrictEqual(await pillar({}), { placed: 6, rose: 6, y: 70, raised: `from 3 to 6, ${WHY}` })
})

test('a pillar without a height and too few blocks to raise it names the safe height', async () => {
  assert.deepStrictEqual(await pillar({}, 3), { placed: 3, rose: 3, y: 67, safe: WHY })
})

// The /pillar reply on flat ground at y 63 beside a seen ledge 3 high at x 2, its head cell at y 68 unseen.
function besideLedge (headSolid) {
  const entity = { position: new Vec3(0.5, 64, 0.5) }
  const ledge = (p) => p.x === 2 && p.z === 0 && p.y < 67
  const head = (p) => p.x === 2 && p.z === 0 && p.y === 68
  const solid = (p) => p.y < 64 || ledge(p) || (headSolid && head(p)) || (p.x === 0 && p.z === 0 && p.y < entity.position.y)
  return awaitRoute('/pillar', { height: '1' }, {
    bot: { entity, blockAt: (p) => ({ name: solid(p) ? 'stone' : 'air', boundingBox: solid(p) ? 'block' : 'empty', position: p }) },
    bunker: { building: false },
    legs: legLedger(),
    takenText,
    perch: { cell: null },
    claimLane: () => ({}),
    releaseLane () {},
    fillers: () => [{ name: 'dirt', count: 64 }],
    solidAt: solid,
    knownCell: (p) => !head(p),
    SHELTER: shelter.SHELTER,
    PILLAR_SCAN_UP: botConstant('PILLAR_SCAN_UP'),
    BUNKER_MAX_HEIGHT: botConstant('BUNKER_MAX_HEIGHT'),
    jumpPlace: async () => {
      entity.position = entity.position.offset(0, 1, 0)
      return true
    }
  })
}

test('the safe height a pillar names does not depend on an unseen block over a ledge', async () => {
  const open = await besideLedge(false)
  assert.match(String(open.safe), /^seen ground 3 above the feet\b/, `control: an unseen open cell over the ledge, got ${JSON.stringify(open)}`)
  assert.deepStrictEqual(await besideLedge(true), open)
})
