'use strict'
// use clicks the block, or uses the held item where the block would not take it, and fails a click that should change the cell and did not.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { awaitRoute, routeHandler, botConstant, claimRescue, fakeClock } = require('./helpers')

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

// Runs /use on a fake clock with hand in hotbar slot 36 beside cell, the server ticking every 50 ms unless ticks is false.
// After the click the hand's slot turns to turned at turnMs, the cell to after at blockMs, and a reflex selects slot 37
// holding swap at swapMs, each when given. Returns the reply and the ms it took.
async function bucketUse (cell, hand, { turned = null, turnMs = 0, after = null, blockMs = 0, swap = null, swapMs = 0, ticks = true } = {}) {
  const clock = fakeClock()
  const p = new Vec3(1, 64, 0)
  let now = cell
  const inventory = Object.assign(new EventEmitter(), { hotbarStart: 36, slots: [], items: () => [] })
  inventory.slots[36] = hand
  inventory.slots[37] = swap
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory,
    quickBarSlot: 0,
    time: { age: 0 },
    blockAt: (at) => block(at.equals(p) ? now : AIR, at),
    pathfinder: { goto: async () => {} },
    lookAt: async () => {},
    activateItem () {
      if (turned) clock.setTimeout(() => setSlot(36, turned), turnMs)
      if (after) clock.setTimeout(() => { const old = block(now, p); now = after; bot.emit('blockUpdate', old, block(now, p)) }, blockMs)
      if (swap) clock.setTimeout(() => { bot.quickBarSlot = 1; bot.emit('heldItemChanged', bot.heldItem) }, swapMs)
    },
    deactivateItem () {}
  })
  Object.defineProperty(bot, 'heldItem', { get: () => inventory.slots[inventory.hotbarStart + bot.quickBarSlot] })
  const setSlot = (slot, item) => {
    const old = inventory.slots[slot]
    inventory.slots[slot] = item
    inventory.emit('updateSlot', slot, old, item)
    if (slot === inventory.hotbarStart + bot.quickBarSlot) bot.emit('heldItemChanged', item)
  }
  if (ticks) clock.setInterval(() => { bot.time.age++; bot.emit('time') }, 50)
  const env = {
    bot,
    Vec3,
    seesLit: () => true,
    cellKnown: () => true,
    goals: {},
    round: (v) => v,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now },
    BUCKET_WAIT_MS: botConstant('BUCKET_WAIT_MS'),
    BUCKET_WAIT_CAP_MS: botConstant('BUCKET_WAIT_CAP_MS'),
    ok: (res, body) => { res.body = { ok: true, ...body } }
  }
  const { handle, res } = routeHandler('/use', env)
  const done = handle({ query: AT }, res)
  while (res.body === undefined && res.error === undefined && clock.now() < 10000) {
    await new Promise(setImmediate)
    clock.advance(10)
  }
  const ms = clock.now()
  await done
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { reply: res.body, ms }
}

const WATER = { name: 'water', stateId: 86 }
const LAVA = { name: 'lava', stateId: 102 }

test('a bucket use counts as done once the bucket in hand turns, before the cell\'s late update', async () => {
  const late = { turnMs: 900, blockMs: 1500 }
  for (const [liquid, full] of [[WATER, 'water_bucket'], [LAVA, 'lava_bucket']]) {
    const pour = await bucketUse(AIR, { name: full, count: 1 }, { ...late, turned: { name: 'bucket', count: 1 }, after: liquid })
    assert.strictEqual(pour.reply.ok, true, `a ${full} poured`)
    const fill = await bucketUse(liquid, { name: 'bucket', count: 1 }, { ...late, turned: { name: full, count: 1 }, after: AIR })
    assert.strictEqual(fill.reply.ok, true, `a ${full} filled`)
  }
  const stack = await bucketUse(WATER, { name: 'bucket', count: 3 }, { ...late, turned: { name: 'bucket', count: 2 }, after: AIR })
  assert.strictEqual(stack.reply.ok, true, 'a fill from a stack of buckets')
  const none = await bucketUse(AIR, { name: 'water_bucket', count: 1 })
  assert.deepStrictEqual([none.reply.ok, none.reply.reason], [false, 'nothing changed at 1,64,0, still air'], 'control: neither turned')
})

test('a bucket use that changed nothing ends after 20 ticks of server age, well before the wall-clock cap', async () => {
  const ticked = await bucketUse(AIR, { name: 'water_bucket', count: 1 })
  assert.strictEqual(ticked.reply.ok, false)
  assert.ok(ticked.ms < 2000, `ended after ${ticked.ms} ms`)
  const silent = await bucketUse(AIR, { name: 'water_bucket', count: 1 }, { ticks: false })
  assert.ok(silent.ms >= 5000, `control: with no server age it ended after ${silent.ms} ms`)
})

test('a bucket use names the cell\'s new block once its update follows the turn, and no block when the update never comes', async () => {
  const pour = { turned: { name: 'bucket', count: 1 }, turnMs: 300 }
  const updated = await bucketUse(AIR, { name: 'water_bucket', count: 1 }, { ...pour, after: WATER, blockMs: 600 })
  assert.deepStrictEqual([updated.reply.ok, updated.reply.now], [true, 'water'])
  const missed = await bucketUse(AIR, { name: 'water_bucket', count: 1 }, pour)
  assert.strictEqual(missed.reply.ok, true)
  assert.ok(!('now' in missed.reply), `named ${missed.reply.now}`)
})

test('a reflex that swaps the hand during a bucket wait neither hides the bucket\'s turn nor stands in for one', async () => {
  const sword = { name: 'diamond_sword', count: 1 }
  const pour = await bucketUse(AIR, { name: 'water_bucket', count: 1 }, { swap: sword, swapMs: 100, turned: { name: 'bucket', count: 1 }, turnMs: 600 })
  assert.strictEqual(pour.reply.ok, true, 'a pour turned in the slot the reflex left')
  const fill = await bucketUse(WATER, { name: 'bucket', count: 1 }, { swap: { name: 'water_bucket', count: 1 }, swapMs: 100 })
  assert.deepStrictEqual([fill.reply.ok, fill.reply.reason], [false, 'nothing changed at 1,64,0, still water'], 'a failed fill while a reflex equips a full bucket')
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
