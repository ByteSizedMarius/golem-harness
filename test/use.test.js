'use strict'
// use clicks the block, or uses the held item where the block would not take it, and fails a click that should change the cell and did not.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { awaitRoute, routeHandler, botConstant, claimRescue } = require('./helpers')

const AT = { x: '1', y: '64', z: '0' }
const AIR = { name: 'air', stateId: 0 }
const block = (state, position) => ({
  ...state,
  position,
  getProperties: () => Object.fromEntries(['age', 'stage'].filter((k) => state[k] !== undefined).map((k) => [k, String(state[k])]))
})

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

// Farmland at 1,64,0 under plant, and each click on the plant grows it to grow(plant).
function farmland (plant, grow, seen = () => true) {
  const soil = new Vec3(1, 64, 0)
  const up = soil.offset(0, 1, 0)
  const cells = { [soil]: { name: 'farmland', stateId: 30 }, [up]: plant }
  const clicked = []
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    heldItem: { name: 'bone_meal' },
    inventory: { items: () => [] },
    blockAt: (at) => block(cells[at] || AIR, at),
    pathfinder: { goto: async () => {} },
    lookAt: async () => {},
    activateBlock: async (b) => {
      clicked.push(b.position)
      setImmediate(() => {
        const old = block(cells[b.position], b.position)
        if (b.position.equals(up)) cells[up] = grow(cells[up])
        bot.emit('blockUpdate', old, block(cells[b.position], b.position))
      })
    }
  })
  const env = { bot, Vec3, seesLit: seen, cellKnown: () => true, goals: {}, round: (v) => v, setTimeout, clearTimeout, ok: (res, body) => { res.body = { ok: true, ...body } } }
  return { env, clicked }
}

test('bone meal on farmland clicks the crop above it and replies the age the server sent', async () => {
  const { env, clicked } = farmland({ name: 'wheat', stateId: 1, age: 0 }, () => ({ name: 'wheat', stateId: 5, age: 4 }))
  const reply = await awaitRoute('/use', AT, env)
  assert.deepStrictEqual([reply.ok, reply.on, reply.at, reply.age], [true, 'wheat', { x: 1, y: 65, z: 0 }, 4])
  assert.deepStrictEqual(clicked, [new Vec3(1, 65, 0)])
})

test('bone meal on farmland whose cell above is out of sight is refused alike for a crop and for air, and clicks nothing', async () => {
  const replies = []
  for (const above of [{ name: 'wheat', stateId: 1, age: 0 }, AIR]) {
    const { env, clicked } = farmland(above, (s) => s, (p) => p.y === 64)
    const { handle, res } = routeHandler('/use', env)
    await handle({ query: AT }, res)
    replies.push({ body: res.body, error: res.error && res.error.message })
    assert.deepStrictEqual(clicked, [], `${above.name} above`)
  }
  assert.match(replies[0].error, /not in my sight/)
  assert.deepStrictEqual(replies[1], replies[0])
})

test('bone meal that uses up the last one names bone_meal as used', async () => {
  const env = useCell({ name: 'wheat', stateId: 1, age: 0 }, 'bone_meal', () => ({ name: 'wheat', stateId: 5, age: 4 }))
  const click = env.bot.activateBlock
  env.bot.activateBlock = async (b) => {
    env.bot.heldItem = null
    return click(b)
  }
  const reply = await awaitRoute('/use', AT, env)
  assert.deepStrictEqual([reply.ok, reply.used, reply.age], [true, 'bone_meal', 4])
})

test('bone meal on a sapling the server left as it was replies ok with its stage', async () => {
  const sapling = { name: 'oak_sapling', stateId: 40, stage: 0 }
  const reply = await awaitRoute('/use', AT, useCell(sapling, 'bone_meal', (s) => s))
  assert.deepStrictEqual([reply.ok, reply.on, reply.stage], [true, 'oak_sapling', 0])
  assert.strictEqual(typeof reply.note, 'string')
})

test('a bucket on grass, a flower or a torch uses the item, other items click the block', async () => {
  assert.deepStrictEqual(await clicksOn('short_grass', 'bone_meal'), ['block'], 'control: bone meal')
  for (const cell of ['short_grass', 'poppy', 'torch']) {
    for (const bucket of ['bucket', 'water_bucket', 'lava_bucket']) {
      assert.deepStrictEqual(await clicksOn(cell, bucket), ['item'], `${bucket} on ${cell}`)
    }
  }
})

// A body holding an iron shovel beside a seen dirt cell at 1,64,0, an iron hoe in its pockets, over digLock. done records walks, looks, equips and clicks.
function rescueBody (digLock) {
  const done = []
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    heldItem: { name: 'iron_shovel' },
    inventory: { items: () => [{ name: 'iron_hoe' }] },
    blockAt: (p) => block({ name: 'dirt', stateId: 1 }, p),
    pathfinder: { goto: async () => { done.push('walk') } },
    lookAt: async () => { done.push('look') },
    waitForTicks: async () => {},
    equip: async (it) => { done.push(`equip ${it.name}`); bot.heldItem = it },
    activateBlock: async () => { done.push('click') },
    activateItem: () => { done.push('use item') },
    deactivateItem: () => {}
  })
  const env = { bot, Vec3, require, seesLit: () => true, cellKnown: () => true, goals: { GoalNear: class {} }, round: (v) => v, setTimeout: (fn) => fn(), clearTimeout () {}, digLock }
  return { bot, env, done }
}

test('use and activate refuse busy while the buried self-rescue holds the hand, and equip and click nothing', async () => {
  const digLock = botConstant('digLock')
  claimRescue(digLock)
  const { bot, env, done } = rescueBody(digLock)
  for (const [route, query, skipped] of [['/use', { ...AT, item: 'iron_hoe' }, 'used'], ['/activate', AT, 'activated']]) {
    const { handle, res } = routeHandler(route, env)
    await handle({ query }, res)
    assert.strictEqual(res.error && res.error.message, `busy: the buried self-rescue is running, nothing ${skipped}`, route)
    assert.strictEqual(res.error.reason, 'busy', route)
  }
  assert.deepStrictEqual(done, [])
  assert.strictEqual(bot.heldItem.name, 'iron_shovel')
})

test('use and activate equip and click once the buried self-rescue ends', async () => {
  const digLock = botConstant('digLock')
  claimRescue(digLock)
  digLock.holder = null
  const { env, done } = rescueBody(digLock)
  await awaitRoute('/use', { ...AT, item: 'iron_hoe' }, env)
  await awaitRoute('/activate', AT, env)
  assert.deepStrictEqual(done, ['equip iron_hoe', 'look', 'click', 'look', 'click'])
})

test('fish refuses busy while the buried self-rescue holds the hand and starts no job, and starts one once the rescue ends', async () => {
  const digLock = botConstant('digLock')
  claimRescue(digLock)
  const started = []
  const env = {
    bot: { inventory: { items: () => [{ name: 'fishing_rod' }] } },
    shared: { ready: true },
    jobs: { start: (name) => { started.push(name); return { id: 1 } } },
    require,
    digLock
  }
  const { handle, res } = routeHandler('/fish', env)
  await handle({ query: {} }, res)
  assert.strictEqual(res.error && res.error.message, 'busy: the buried self-rescue is running, nothing cast')
  assert.strictEqual(res.error.reason, 'busy')
  assert.deepStrictEqual(started, [])
  digLock.holder = null
  assert.deepStrictEqual(await awaitRoute('/fish', {}, env), { job: 1, casts: 1, aimed: false })
  assert.deepStrictEqual(started, ['fish x1'])
})
