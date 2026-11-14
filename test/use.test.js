'use strict'
// use clicks the block, or uses the held item where the block would not take it, and fails a click that should change the cell and did not.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const WorldSync = require('prismarine-world/src/worldsync')
const { awaitRoute, routeHandler, botConstant, claimRescue, fakeClock } = require('./helpers')

const AT = { x: '1', y: '64', z: '0' }
const AIR = { name: 'air', stateId: 0, shapes: [] }
const STONE = { name: 'stone', stateId: 1, shapes: [[0, 0, 0, 1, 1, 1]] }
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
  return { bot, Vec3, seesLit: () => true, leafInTheWay: () => null, cellKnown: () => true, goals: {}, round: (v) => v, setTimeout, clearTimeout, ok: (res, body) => { res.body = { ok: true, ...body } } }
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
  await awaitRoute('/use', AT, { bot, Vec3, seesLit: () => true, leafInTheWay: () => null, cellKnown: () => true, goals: {}, round: (v) => v, setTimeout: (fn) => fn(), clearTimeout () {} })
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
      const env = { bot, Vec3, seesLit: () => !walked || inSight, leafInTheWay: () => null, cellKnown: () => true, goals: { GoalNear: class {} }, round: (v) => v, setTimeout: (fn) => fn(), clearTimeout () {} }
      const reply = await awaitRoute('/use', { x: '9', y: '63', z: '0' }, env)
      const label = `in sight ${inSight}, tills ${tills}`
      assert.ok(walked, label)
      if (!inSight) assert.deepStrictEqual(reply, { used: 'iron_hoe', on: 'dirt', at: { x: 9, y: 63, z: 0 } }, label)
      else if (tills) assert.deepStrictEqual([reply.now, reply.ok], ['farmland', undefined], label)
      else assert.deepStrictEqual([reply.now, reply.ok, typeof reply.reason], ['dirt', false, 'string'], label)
    }
  }
})

test('use clears the goal of a walk into reach that ends short of the cell', async () => {
  for (const end of ['NoPath', 'Timeout', 'an empty plan']) {
    const pathfinder = {
      goal: null,
      setGoal (goal) { pathfinder.goal = goal },
      stop () {},
      isMoving: () => false,
      async goto (goal) {
        pathfinder.goal = goal
        if (end !== 'an empty plan') throw Object.assign(new Error(end), { name: end })
      }
    }
    const bot = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      heldItem: { name: 'iron_hoe' },
      inventory: { items: () => [] },
      blockAt: (p) => block({ name: 'dirt', stateId: 1 }, p),
      pathfinder,
      lookAt: async () => {},
      activateBlock: async () => {}
    })
    const env = { bot, Vec3, seesLit: () => true, leafInTheWay: () => null, cellKnown: () => true, goals: { GoalNear: class {} }, round: (v) => v, setTimeout: (fn) => fn(), clearTimeout () {} }
    const { handle, res } = routeHandler('/use', env)
    await handle({ query: { x: '9', y: '63', z: '0' } }, res)
    if (end !== 'an empty plan') assert.strictEqual(res.error && res.error.name, end)
    assert.strictEqual(pathfinder.goal, null, end)
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
  const env = { bot, Vec3, seesLit: seen, leafInTheWay: () => null, cellKnown: () => true, goals: {}, round: (v) => v, setTimeout, clearTimeout, ok: (res, body) => { res.body = { ok: true, ...body } } }
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

// Runs /use on query, advancing clock 10 ms at a time until it replies.
async function useOnClock (clock, env, query) {
  const { handle, res } = routeHandler('/use', env)
  const done = handle({ query }, res)
  while (res.body === undefined && res.error === undefined && clock.now() < 10000) {
    await new Promise(setImmediate)
    clock.advance(10)
  }
  const ms = clock.now()
  await done
  return { res, ms }
}

// Runs /use on a fake clock with hand in hotbar slot 36 beside cell over a stone floor, the server ticking every 50 ms unless ticks is false.
// After the click the hand's slot turns to turned at turnMs, the cell to after at blockMs, and a reflex selects slot 37
// holding swap at swapMs, each when given. Returns the reply and the ms it took.
async function bucketUse (cell, hand, { turned = null, turnMs = 0, after = null, blockMs = 0, swap = null, swapMs = 0, ticks = true } = {}) {
  const clock = fakeClock()
  const p = new Vec3(1, 64, 0)
  let now = cell
  const inventory = Object.assign(new EventEmitter(), { hotbarStart: 36, slots: [], items: () => [] })
  inventory.slots[36] = hand
  inventory.slots[37] = swap
  const blockAt = (at) => block(at.equals(p) ? now : at.y < p.y ? STONE : AIR, at)
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory,
    quickBarSlot: 0,
    time: { age: 0 },
    blockAt,
    world: { raycast: (...ray) => WorldSync.prototype.raycast.apply({ getBlock: blockAt }, ray) },
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
    leafInTheWay: () => null,
    cellKnown: () => true,
    goals: {},
    round: (v) => v,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now },
    BUCKET_WAIT_MS: botConstant('BUCKET_WAIT_MS'),
    BUCKET_WAIT_CAP_MS: botConstant('BUCKET_WAIT_CAP_MS'),
    POUR_REACH: botConstant('POUR_REACH'),
    POUR_FACES: botConstant('POUR_FACES'),
    ok: (res, body) => { res.body = { ok: true, ...body } }
  }
  const { res, ms } = await useOnClock(clock, env, AT)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { reply: res.body, ms }
}

const WATER = { name: 'water', stateId: 86, shapes: [] }
const LAVA = { name: 'lava', stateId: 102, shapes: [] }

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

// The step from a block across each prismarine-world face id.
const FACE_STEP = { 0: [0, -1, 0], 1: [0, 1, 0], 2: [0, 0, -1], 3: [0, 0, 1], 4: [-1, 0, 0], 5: [1, 0, 0] }
// The survival block reach of a 1.21.11 server.
const SERVER_REACH = 4.5

// Runs /use with hand on at, and the fake server pours across the face the last look's ray meets first within SERVER_REACH.
// A cell for which hidden(key, feet) is true is unseen and unknown.
async function pourAt (at, { hand = 'water_bucket', feet = new Vec3(0.5, 64, 0.5), cells = {}, hidden = () => false, walkTo = feet } = {}) {
  const clock = fakeClock()
  const key = (c) => `${c.x},${c.y},${c.z}`
  const world = { ...cells }
  const looks = []
  const walks = []
  let poured = null
  const inventory = Object.assign(new EventEmitter(), { hotbarStart: 36, slots: [], items: () => [] })
  inventory.slots[36] = { name: hand, count: 1 }
  const blockAt = (c) => block(world[key(c)] || (c.y <= 63 ? STONE : AIR), c)
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: feet },
    inventory,
    heldItem: inventory.slots[36],
    quickBarSlot: 0,
    time: { age: 0 },
    blockAt,
    world: { raycast: (...ray) => WorldSync.prototype.raycast.apply({ getBlock: blockAt }, ray) },
    pathfinder: { goto: async (goal) => { walks.push(goal); bot.entity.position = walkTo } },
    lookAt: async (point) => { looks.push(point) },
    activateItem () {
      if (hand === 'bucket') return
      const eye = bot.entity.position.offset(0, 1.62, 0)
      const hit = bot.world.raycast(eye, looks.at(-1).minus(eye).normalize(), SERVER_REACH)
      if (!hit) return
      const into = hit.position.offset(...FACE_STEP[hit.face])
      clock.setTimeout(() => {
        const old = blockAt(into)
        world[key(into)] = WATER
        poured = key(into)
        bot.emit('blockUpdate', old, blockAt(into))
        const full = inventory.slots[36]
        inventory.slots[36] = { name: 'bucket', count: 1 }
        inventory.emit('updateSlot', 36, full, inventory.slots[36])
      }, 100)
    },
    deactivateItem () {}
  })
  clock.setInterval(() => { bot.time.age++; bot.emit('time') }, 50)
  const seen = (c) => !hidden(key(c), bot.entity.position)
  const env = {
    bot,
    Vec3,
    seesLit: seen,
    cellKnown: seen,
    leafInTheWay: () => null,
    goals: { GoalNear: class { constructor (x, y, z, range) { Object.assign(this, { x, y, z, range }) } } },
    round: (v) => v,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now },
    BUCKET_WAIT_MS: botConstant('BUCKET_WAIT_MS'),
    BUCKET_WAIT_CAP_MS: botConstant('BUCKET_WAIT_CAP_MS'),
    POUR_REACH: botConstant('POUR_REACH'),
    POUR_FACES: botConstant('POUR_FACES'),
    ok: (res, body) => { res.body = { ok: true, ...body } }
  }
  const { res } = await useOnClock(clock, env, { x: String(at.x), y: String(at.y), z: String(at.z) })
  return { reply: res.body, refusal: res.error && res.error.message, looks, walks, poured }
}

test('a pour into an air cell over stone looks at the middle of the stone\'s top face', async () => {
  const { looks, poured } = await pourAt(new Vec3(1, 64, 0))
  assert.deepStrictEqual(looks, [new Vec3(1.5, 64, 0.5)])
  assert.strictEqual(poured, '1,64,0')
})

test('a pour into a floor cell 4.15 from the eye lands in that cell, not one past it', async () => {
  const { reply, poured } = await pourAt(new Vec3(4, 64, 0))
  assert.deepStrictEqual([reply.ok, reply.now, poured], [true, 'water', '4,64,0'])
})

test('a pour into the cell on top of a 1-high block aims at that block\'s top face', async () => {
  const { reply, looks, poured } = await pourAt(new Vec3(3, 65, 0), { cells: { '3,64,0': STONE } })
  assert.deepStrictEqual(looks, [new Vec3(3.5, 65, 0.5)])
  assert.deepStrictEqual([reply.ok, poured], [true, '3,65,0'])
})

test('a pour against a side face aims at its middle when the cell has no floor', async () => {
  const { reply, looks, poured } = await pourAt(new Vec3(1, 65, 0), { cells: { '1,64,0': AIR, '2,65,0': STONE } })
  assert.deepStrictEqual(looks, [new Vec3(2, 65.5, 0.5)])
  assert.deepStrictEqual([reply.ok, poured], [true, '1,65,0'])
})

test('a pour into air with nothing beside it to rest against refuses naming the cell, walks nowhere and pours nothing', async () => {
  const { refusal, looks, walks, poured } = await pourAt(new Vec3(1, 66, 0))
  assert.match(refusal || '', /1,66,0/)
  assert.deepStrictEqual([looks, walks.length, poured], [[], 0, null])
})

test('a pour whose floor is unseen from here walks, then pours once the walk brings the floor into sight', async () => {
  const start = new Vec3(0.5, 64, 0.5)
  const hidden = (k, feet) => k === '1,63,0' && feet.equals(start)
  const { reply, looks, walks, poured } = await pourAt(new Vec3(1, 64, 0), { feet: start, hidden, walkTo: new Vec3(2.5, 64, 0.5) })
  assert.strictEqual(walks.length, 1)
  assert.deepStrictEqual(looks, [new Vec3(1.5, 64, 0.5)])
  assert.deepStrictEqual([reply.ok, poured], [true, '1,64,0'])
})

test('a pour whose floor stays unseen after the walk refuses naming the cell and pours nothing', async () => {
  const { refusal, looks, walks, poured } = await pourAt(new Vec3(1, 64, 0), { hidden: (k) => k === '1,63,0', walkTo: new Vec3(2.5, 64, 0.5) })
  assert.match(refusal || '', /1,64,0/)
  assert.deepStrictEqual([looks, walks.length, poured], [[], 1, null])
})

test('a fill from a water source still looks at the source\'s middle', async () => {
  const { looks } = await pourAt(new Vec3(1, 64, 0), { hand: 'bucket', cells: { '1,64,0': WATER } })
  assert.deepStrictEqual(looks, [new Vec3(1.5, 64.5, 0.5)])
})

const SOIL = new Vec3(1, 64, 0)
const CROP = '1,65,0'
const FARMLAND = { name: 'farmland', stateId: 30, shapes: [[0, 0, 0, 1, 0.9375, 1]] }
const WHEAT = { name: 'wheat', stateId: 31, shapes: [] }

// /use of wheat_seeds on SOIL, each answer [ms after the click (negative during the look), 'soil' | 'crop' | 'slot' | 'tick', state or count].
async function sowUse ({ feet = new Vec3(0.5, 64, 0.5), cells = {}, count = 8, hand = 'wheat_seeds', answers = [], unseen = [], walk = {}, reflex = false, ticks = true, env: extra = {} } = {}) {
  const clock = fakeClock()
  const key = (c) => `${c.x},${c.y},${c.z}`
  const world = { [key(SOIL)]: FARMLAND, ...cells }
  const hidden = new Set(unseen)
  const seen = (c) => !hidden.has(key(c))
  const log = []
  const unseenReads = []
  const guardState = { hand: null }
  const inventory = Object.assign(new EventEmitter(), { hotbarStart: 36, slots: [], items: () => inventory.slots.filter(Boolean) })
  inventory.slots[36] = { name: 'wheat_seeds', count, slot: 36 }
  inventory.slots[37] = { name: 'iron_sword', count: 1, slot: 37 }
  const setSlot = (n) => {
    const old = inventory.slots[36]
    inventory.slots[36] = n ? { name: 'wheat_seeds', count: n, slot: 36 } : null
    inventory.emit('updateSlot', 36, old, inventory.slots[36])
  }
  const cellAt = (c) => block(world[key(c)] || (c.y < 64 ? STONE : AIR), c)
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: feet },
    inventory,
    quickBarSlot: hand === 'iron_sword' ? 1 : 0,
    time: { age: 0 },
    blockAt: (c) => {
      if (!seen(c)) unseenReads.push(key(c))
      return cellAt(c)
    },
    pathfinder: {
      movements: { getBlock: (c) => (seen(c) ? {} : { name: 'unknown' }) },
      goto: () => new Promise((resolve) => {
        log.push('walk')
        clock.setTimeout(() => {
          bot.entity.position = walk.to || new Vec3(0.5, 64, 0.5)
          for (const k of walk.hides || []) hidden.add(k)
          Object.assign(world, walk.sets)
          if (reflex && !guardState.hand) bot.quickBarSlot = 1
          resolve()
        }, walk.ms || 0)
      })
    },
    lookAt: async () => {},
    equip: async (it) => { log.push(`equip ${it.name}`); bot.quickBarSlot = it.slot - 36 },
    activateBlock: async (b) => {
      const look = Math.max(0, ...answers.map(([ms]) => -ms))
      for (const [ms, kind, value] of answers) {
        clock.setTimeout(() => {
          if (kind === 'slot') return setSlot(value)
          if (kind === 'tick') return tick()
          const at = kind === 'soil' ? SOIL : SOIL.offset(0, 1, 0)
          const old = cellAt(at)
          if (kind === 'crop') world[CROP] = value
          bot.emit('blockUpdate', old, cellAt(at))
        }, look + ms)
      }
      if (look) await new Promise((resolve) => clock.setTimeout(resolve, look))
      log.push(`click ${bot.heldItem ? bot.heldItem.name : 'nothing'} on ${key(b.position)}`)
    }
  })
  Object.defineProperty(bot, 'heldItem', { get: () => inventory.slots[inventory.hotbarStart + bot.quickBarSlot] })
  const tick = () => { bot.time.age++; bot.emit('time') }
  if (ticks) clock.setInterval(tick, 50)
  const env = {
    bot,
    Vec3,
    guardState,
    reflexes: [],
    seesLit: seen,
    seenNow: seen,
    cellKnown: seen,
    leafInTheWay: () => null,
    goals: { GoalNear: class {} },
    round: (v) => v,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now },
    POUR_REACH: botConstant('POUR_REACH'),
    SEED_ANSWER_MS: botConstant('SEED_ANSWER_MS'),
    SEED_ANSWER_CAP_MS: botConstant('SEED_ANSWER_CAP_MS'),
    SEED_DROP_MS: botConstant('SEED_DROP_MS'),
    ok: (res, body) => { res.body = { ok: true, ...body } },
    ...extra
  }
  const { res, ms } = await useOnClock(clock, env, { x: '1', y: '64', z: '0', item: 'wheat_seeds' })
  return { reply: res.body, error: res.error, ms, log, guardState, unseenReads, held: bot.heldItem && bot.heldItem.name }
}

const PLANTS = [[30, 'soil'], [30, 'crop', WHEAT], [31, 'slot', 7]]
const IGNORES = [[45, 'soil'], [45, 'crop', AIR]]

test('a seed whose crop cell is out of sight and whose click the server ignored replies ok false once the server answered, reading no cell', async () => {
  const { reply, ms, unseenReads } = await sowUse({ unseen: [CROP], answers: IGNORES })
  assert.strictEqual(reply.ok, false)
  assert.match(reply.reason, /ignored/)
  assert.doesNotMatch(reply.reason, /air|1,65,0/)
  assert.ok(!('now' in reply), `now ${reply.now}`)
  assert.ok(ms >= 145 && ms < 500, `replied after ${ms} ms`)
  assert.deepStrictEqual(unseenReads, [])
})

test('a seed out of sight counts as planted on a count drop one tick after the crop update, and names no crop', async () => {
  const { reply, unseenReads } = await sowUse({ unseen: [CROP], answers: [[30, 'soil'], [30, 'crop', WHEAT], [80, 'slot', 7]] })
  assert.deepStrictEqual([reply.ok, reply.planted, 'crop' in reply, 'now' in reply], [true, true, false, false])
  assert.deepStrictEqual(unseenReads, [])
})

test('a pickup into the seed stack during the wait neither hides the seed\'s drop nor stands in for one', async () => {
  for (const answers of [[[20, 'slot', 9], [30, 'soil'], [40, 'slot', 8]], [[30, 'soil'], [35, 'slot', 7], [40, 'slot', 10]]]) {
    const { reply, unseenReads } = await sowUse({ unseen: [CROP], answers })
    assert.deepStrictEqual([reply.ok, reply.planted], [true, true], JSON.stringify(answers))
    assert.deepStrictEqual(unseenReads, [])
  }
  const { reply, unseenReads } = await sowUse({ unseen: [CROP], answers: [[20, 'slot', 9], [30, 'soil']] })
  assert.strictEqual(reply.ok, false, 'a pickup alone')
  assert.deepStrictEqual(unseenReads, [])
})

test('a seed count drop before the server answered the click is no planted seed', async () => {
  const { reply, unseenReads } = await sowUse({ unseen: [CROP], answers: [[20, 'slot', 7], [30, 'soil']] })
  assert.strictEqual(reply.ok, false)
  assert.match(reply.reason, /ignored/)
  assert.deepStrictEqual(unseenReads, [])
})

test('a farmland update during the look before the click is no answer, and the later answer plants, in sight and out of it', async () => {
  for (const unseen of [[], [CROP]]) {
    const { reply } = await sowUse({ unseen, answers: [[-100, 'soil'], [150, 'soil'], [150, 'crop', WHEAT], [170, 'slot', 7]] })
    assert.deepStrictEqual([reply.ok, reply.planted], [true, true], `unseen ${unseen}`)
  }
})

test('a seed out of sight counts as planted on a count drop 300 ms after the answer with one server tick between them', async () => {
  const { reply } = await sowUse({ unseen: [CROP], ticks: false, answers: [[30, 'soil'], [50, 'tick'], [330, 'slot', 7]] })
  assert.deepStrictEqual([reply.ok, reply.planted], [true, true])
})

test('a seed click on a server that sends no age and no answer replies unanswered at the wall-clock cap', async () => {
  for (const unseen of [[], [CROP]]) {
    const { reply, ms } = await sowUse({ unseen, ticks: false })
    const label = `unseen ${unseen}`
    assert.strictEqual(reply.ok, false, label)
    assert.match(reply.reason, /no answer/, label)
    assert.ok(ms >= 5000 && ms < 6000, `${label}: replied after ${ms} ms`)
  }
})

test('the last seed counts as planted when its slot empties', async () => {
  const { reply, unseenReads } = await sowUse({ unseen: [CROP], count: 1, answers: [[30, 'soil'], [30, 'slot', 0]] })
  assert.deepStrictEqual([reply.ok, reply.planted, reply.used], [true, true, 'wheat_seeds'])
  assert.deepStrictEqual(unseenReads, [])
})

test('a seed slot update that keeps the count is no planted seed', async () => {
  const { reply, unseenReads } = await sowUse({ unseen: [CROP], answers: [[30, 'soil'], [30, 'slot', 8]] })
  assert.strictEqual(reply.ok, false)
  assert.match(reply.reason, /ignored/)
  assert.deepStrictEqual(unseenReads, [])
})

test('a seed whose crop cell is in sight names the crop it planted', async () => {
  const { reply } = await sowUse({ answers: PLANTS })
  assert.deepStrictEqual([reply.ok, reply.planted, reply.crop, 'now' in reply], [true, true, 'wheat', false])
})

test('a seed whose crop cell is in sight and stays air fails as an ignored click', async () => {
  const { reply } = await sowUse({ answers: IGNORES })
  assert.strictEqual(reply.ok, false)
  assert.match(reply.reason, /ignored/)
  assert.ok(!('now' in reply), `now ${reply.now}`)
})

test('a seed planted in sight returns only after its count drop one tick after the crop update', async () => {
  const { reply, ms } = await sowUse({ answers: [[30, 'soil'], [30, 'crop', WHEAT], [80, 'slot', 7]] })
  assert.deepStrictEqual([reply.ok, reply.crop], [true, 'wheat'])
  assert.ok(ms >= 80, `replied after ${ms} ms`)
})

test('a seed counts as planted when the server answers after 600 ms, in sight and out of it', async () => {
  const late = [[600, 'soil'], [600, 'crop', WHEAT], [620, 'slot', 7]]
  for (const unseen of [[], [CROP]]) {
    const { reply } = await sowUse({ unseen, answers: late })
    assert.deepStrictEqual([reply.ok, reply.planted], [true, true], `unseen ${unseen}`)
  }
})

test('a seed click the server never answers replies that it is unknown whether the seed went in, never an ignored click', async () => {
  for (const unseen of [[], [CROP]]) {
    const { reply, ms, unseenReads } = await sowUse({ unseen })
    const label = `unseen ${unseen}`
    assert.strictEqual(reply.ok, false, label)
    assert.match(reply.reason, /no answer/, label)
    assert.match(reply.reason, /unknown whether/, label)
    assert.doesNotMatch(reply.reason, /ignored/, label)
    assert.ok(ms >= 1000 && ms < 2000, `${label}: replied after ${ms} ms`)
    assert.deepStrictEqual(unseenReads, [], label)
  }
})

test('a seed onto farmland under visible wheat is refused naming the wheat, and clicks nothing', async () => {
  const { error, log } = await sowUse({ cells: { [CROP]: WHEAT }, answers: PLANTS })
  assert.match(error ? error.message : 'no refusal', /wheat at 1,65,0/)
  assert.deepStrictEqual(log.filter((l) => l.startsWith('click')), [])
})

test('a seed whose farmland the walk left out of sight is refused for sight, reading and naming no block there', async () => {
  const walk = { to: new Vec3(2.5, 64, 0.5), hides: ['1,64,0'], sets: { '1,64,0': { name: 'dirt', stateId: 2, shapes: [[0, 0, 0, 1, 1, 1]] } } }
  const { error, log, unseenReads } = await sowUse({ feet: new Vec3(6.5, 64, 0.5), walk, answers: PLANTS })
  assert.match(error ? error.message : 'no refusal', /not in my sight/)
  assert.doesNotMatch(error.message, /dirt|farmland/)
  assert.deepStrictEqual(unseenReads, [])
  assert.deepStrictEqual(log.filter((l) => l.startsWith('click')), [])
})

test('an unseen block on the ray to the farmland top does not hide the top', async () => {
  const { reply, error, unseenReads } = await sowUse({ feet: new Vec3(-0.5, 64, 0.5), cells: { '0,65,0': STONE }, unseen: ['0,65,0'], answers: PLANTS })
  assert.strictEqual(error, undefined, error && error.message)
  assert.strictEqual(reply.planted, true)
  assert.deepStrictEqual(unseenReads, [])
})

test('a seed is clicked from a stand beside the bed or one terrace level down', async () => {
  for (const feet of [new Vec3(0.5, 65, 0.5), new Vec3(0.5, 64, 0.5)]) {
    const { reply, log } = await sowUse({ feet, answers: PLANTS })
    assert.deepStrictEqual([reply && reply.planted, log.at(-1)], [true, 'click wheat_seeds on 1,64,0'], `feet at ${feet}`)
  }
})

test('a seed is refused with the eye below the farmland top or its top hidden, and nothing is clicked', async () => {
  const below = await sowUse({ feet: new Vec3(0.5, 63, 0.5), cells: { '0,63,0': AIR }, answers: PLANTS })
  const hidden = await sowUse({ feet: new Vec3(-0.5, 64, 0.5), cells: { '0,65,0': STONE }, answers: PLANTS })
  const texts = [below, hidden].map((r) => (r.error ? r.error.message : `replied ${JSON.stringify(r.reply)}`))
  assert.deepStrictEqual(texts.map((t) => /stand higher/.test(t)), [true, true], texts.join(' | '))
  assert.deepStrictEqual([/eye is below/.test(texts[0]), /hidden/.test(texts[1])], [true, true], texts.join(' | '))
  assert.deepStrictEqual([below, hidden].map((r) => r.log.filter((l) => l.startsWith('click'))), [[], []])
})

test('a seed use refuses while fighting before it equips, walks or clicks', async () => {
  const refuseWhileFighting = () => { throw Object.assign(new Error('refused: fighting zombie'), { reason: 'fighting' }) }
  const { error, log } = await sowUse({ feet: new Vec3(6.5, 64, 0.5), answers: PLANTS, env: { refuseWhileFighting } })
  assert.strictEqual(error && error.reason, 'fighting')
  assert.deepStrictEqual(log, [])
})

test('a seed use takes the hand after a walk longer than a lease, and the click goes out with the seed', async () => {
  const { reply, log, guardState } = await sowUse({ feet: new Vec3(6.5, 64, 0.5), walk: { ms: 3000 }, reflex: true, answers: PLANTS })
  assert.deepStrictEqual(log, ['walk', 'equip wheat_seeds', 'click wheat_seeds on 1,64,0'])
  assert.deepStrictEqual([reply.ok, reply.planted], [true, true])
  assert.strictEqual(guardState.hand, null, 'the lease outlived the use')
})

test('a seed use refused for its stand after the walk leaves the hand as it was', async () => {
  const walk = { to: new Vec3(0.5, 63, 0.5) }
  const { error, log, held } = await sowUse({ feet: new Vec3(6.5, 64, 0.5), hand: 'iron_sword', cells: { '0,63,0': AIR }, walk, answers: PLANTS })
  assert.match(error ? error.message : 'no refusal', /eye is below/)
  assert.deepStrictEqual([log, held], [['walk'], 'iron_sword'])
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
    deactivateItem: () => {},
    isABed: () => false
  })
  const env = { bot, Vec3, require, seesLit: () => true, leafInTheWay: () => null, cellKnown: () => true, goals: { GoalNear: class {} }, round: (v) => v, setTimeout: (fn) => fn(), clearTimeout () {}, digLock, LEGACY_1710: false }
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
