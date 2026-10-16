'use strict'
// use clicks the block, or uses the held item where the block would not take it, and fails a click that should change the cell and did not.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { awaitRoute } = require('./helpers')

const AT = { x: '1', y: '64', z: '0' }
const AIR = { name: 'air', stateId: 0 }
const block = (state, position) => ({ ...state, position, getProperties: () => (state.age === undefined ? {} : { age: String(state.age) }) })

// A body beside a seen cell at 1,64,0 holding state, with held in hand. The server answers a block
// click once the click returns, with an update to the state click(state) gives.
function useCell (state, held, click) {
  const p = new Vec3(1, 64, 0)
  let cell = state
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    heldItem: { name: held },
    inventory: { items: () => [] },
    blockAt: (at) => block(at.equals(p) ? cell : AIR, at),
    pathfinder: { goto: async () => {} },
    lookAt: async () => {},
    activateBlock: async () => {
      setImmediate(() => {
        const old = block(cell, p)
        cell = click(cell)
        bot.emit('blockUpdate', old, block(cell, p))
      })
    }
  })
  return { bot, Vec3, seesLit: () => true, cellKnown: () => true, goals: {}, round: (v) => v, setTimeout, clearTimeout, ok: (res, body) => { res.body = { ok: true, ...body } } }
}

// The clicks /use makes on a seen cell holding name, with held in hand.
async function clicksOn (name, held) {
  const clicks = []
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    heldItem: { name: held },
    inventory: { items: () => [] },
    blockAt: (p) => block({ name, stateId: 1 }, p),
    pathfinder: { goto: async () => {} },
    lookAt: async () => {},
    activateBlock: async () => { clicks.push('block') },
    activateItem: () => { clicks.push('item') },
    deactivateItem: () => {}
  })
  await awaitRoute('/use', AT, { bot, Vec3, seesLit: () => true, cellKnown: () => true, goals: {}, round: (v) => v, setTimeout: (fn) => fn(), clearTimeout () {} })
  return clicks
}

test('use states what the cell holds now only while the walk into reach left it in sight, a remembered cell included', async () => {
  for (const inSight of [true, false]) {
    for (const tills of [true, false]) {
      let walked = false
      let tilled = false
      const bot = Object.assign(new EventEmitter(), {
        entity: { position: new Vec3(0.5, 64, 0.5) },
        heldItem: { name: 'iron_hoe' },
        inventory: { items: () => [] },
        blockAt: (p) => block(tilled ? { name: 'farmland', stateId: 2 } : { name: 'dirt', stateId: 1 }, p),
        pathfinder: { goto: async () => { walked = true } },
        lookAt: async () => {},
        activateBlock: async () => { tilled = tills }
      })
      const env = { bot, Vec3, seesLit: () => !walked || inSight, cellKnown: () => true, goals: { GoalNear: class {} }, round: (v) => v, setTimeout: (fn) => fn(), clearTimeout () {} }
      const reply = await awaitRoute('/use', { x: '9', y: '63', z: '0' }, env)
      const label = `in sight ${inSight}, tills ${tills}`
      assert.ok(walked, label)
      if (!inSight) assert.deepStrictEqual(reply, { used: 'iron_hoe', on: 'dirt', at: { x: 9, y: 63, z: 0 } }, label)
      else if (tills) assert.deepStrictEqual([reply.now, reply.ok], ['farmland', undefined], label)
      else assert.deepStrictEqual([reply.now, reply.ok, typeof reply.reason], ['dirt', false, 'string'], label)
    }
  }
})

test('tilling grass waits for the server and names the farmland it made', async () => {
  const reply = await awaitRoute('/use', AT, useCell({ name: 'grass_block', stateId: 9 }, 'iron_hoe', () => ({ name: 'farmland', stateId: 20 })))
  assert.deepStrictEqual([reply.ok, reply.now], [true, 'farmland'])
})

test('bone meal fails on a fully grown crop and works on a growing one', async () => {
  const grow = (s) => ({ name: 'wheat', stateId: Math.min(7, s.age + 2), age: Math.min(7, s.age + 2) })
  const growing = await awaitRoute('/use', AT, useCell({ name: 'wheat', stateId: 3, age: 3 }, 'bone_meal', grow))
  assert.strictEqual(growing.ok, true, 'control: a growing crop')
  const ripe = await awaitRoute('/use', AT, useCell({ name: 'wheat', stateId: 7, age: 7 }, 'bone_meal', grow))
  assert.strictEqual(ripe.ok, false)
  assert.strictEqual(typeof ripe.reason, 'string')
})

test('a bucket on grass, a flower or a torch uses the item, other items click the block', async () => {
  assert.deepStrictEqual(await clicksOn('short_grass', 'bone_meal'), ['block'], 'control: bone meal')
  for (const cell of ['short_grass', 'poppy', 'torch']) {
    for (const bucket of ['bucket', 'water_bucket', 'lava_bucket']) {
      assert.deepStrictEqual(await clicksOn(cell, bucket), ['item'], `${bucket} on ${cell}`)
    }
  }
})
