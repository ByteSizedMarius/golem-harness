'use strict'
// use clicks the block, or uses the held item where the block would not take it.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { awaitRoute } = require('./helpers')

// The clicks /use makes on a seen cell holding name, with held in hand.
async function clicksOn (name, held) {
  const clicks = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    heldItem: { name: held },
    inventory: { items: () => [] },
    blockAt: (p) => ({ name, position: p }),
    pathfinder: { goto: async () => {} },
    lookAt: async () => {},
    activateBlock: async () => { clicks.push('block') },
    activateItem: () => { clicks.push('item') },
    deactivateItem: () => {}
  }
  await awaitRoute('/use', { x: '1', y: '64', z: '0' }, { bot, Vec3, seesLit: () => true, goals: {}, round: (v) => v, setTimeout: (fn) => fn() })
  return clicks
}

test('a bucket on grass, a flower or a torch uses the item, other items click the block', async () => {
  assert.deepStrictEqual(await clicksOn('short_grass', 'bone_meal'), ['block'], 'control: bone meal')
  for (const cell of ['short_grass', 'poppy', 'torch']) {
    for (const bucket of ['bucket', 'water_bucket', 'lava_bucket']) {
      assert.deepStrictEqual(await clicksOn(cell, bucket), ['item'], `${bucket} on ${cell}`)
    }
  }
})
