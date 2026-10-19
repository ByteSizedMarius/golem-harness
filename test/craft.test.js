'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const mcData = require('minecraft-data')('1.21.11')
const { Vec3 } = require('vec3')
const { readServerOverrides, overrideRecipes, craftable } = require('../lib/server-overrides')
const { LEGACY_CRAFT_SYNC_MS, LEGACY_GRID_SYNC_MS } = require('../lib/bot/legacy-1710')
const { routeHandler } = require('./helpers')

const TABLE_AT = new Vec3(10, 64, 0)
const FAR = 'the crafting table at 10,64,0 is out of reach, crafted in the 2x2 grid'
// count is what one pass yields.
const RECIPES = {
  ladder: { count: 3, requiresTable: true, cost: { stick: 7 } },
  stick: { count: 4, requiresTable: false, cost: { oak_planks: 2 } },
  oak_button: { count: 1, requiresTable: false, cost: { oak_planks: 1 } }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// A /craft run with a seen table at 10,64,0 unless table is false, which the default walk stops 2.5 short of.
// overrides is a parsed server overrides file, which supplies both the aliases and the recipes.
function craftRig ({ items, legacy = true, table = true, walk, during = () => {}, aliases = {}, overrides = null }) {
  const held = new Map(Object.entries(items))
  const timers = []
  const log = []
  const entity = { position: new Vec3(0.5, 64, 0.5) }
  const recipeFor = (name, t) => {
    const r = RECIPES[name]
    if (!r || (r.requiresTable && !t)) return []
    if (!Object.entries(r.cost).every(([n, k]) => (held.get(n) || 0) >= k)) return []
    return [{ name, result: { id: mcData.itemsByName[name].id, count: r.count }, requiresTable: r.requiresTable }]
  }
  const rig = { held, timers, log }
  const bot = {
    entity,
    _client: new EventEmitter(),
    inventory: {
      count: (id) => held.get(mcData.items[id].name) || 0,
      items: () => [...held].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count }))
    },
    recipesFor: (id, meta, min, t) => recipeFor(mcData.items[id].name, t),
    findBlocks: ({ maxDistance }) => (table && TABLE_AT.distanceTo(entity.position) <= maxDistance ? [TABLE_AT] : []),
    blockAt: (p) => ({ name: table && p.equals(TABLE_AT) ? 'crafting_table' : 'air', position: p }),
    pathfinder: {
      goto: async (g) => {
        log.push(`walk ${g.x},${g.y},${g.z}`)
        if (walk) return walk(g, entity)
        entity.position = new Vec3(g.x - 2.5, g.y, g.z + 0.5)
      }
    },
    async craft (recipe, n, t) {
      const made = mcData.items[recipe.result.id].name
      log.push(`craft ${made} ${t ? 'table' : 'grid'}`)
      await flush()
      during(rig)
      if (recipe.delta) {
        for (const d of recipe.delta) held.set(mcData.items[d.id].name, (held.get(mcData.items[d.id].name) || 0) + d.count)
        return
      }
      const r = RECIPES[made]
      for (const [name, k] of Object.entries(r.cost)) held.set(name, held.get(name) - k)
      held.set(made, (held.get(made) || 0) + r.count)
    },
    async waitForTicks (n) { log.push(`tick ${n}`) }
  }
  rig.bot = bot
  // The packet the server sends, after server(held) settles the inventory.
  rig.packet = (name, data, server = () => {}) => { server(held); bot._client.emit(name, data) }
  rig.waiting = () => timers.find((t) => !t.cleared && !t.fired)
  rig.fire = () => { const t = rig.waiting(); t.fired = true; t.fn() }
  const env = {
    bot,
    shared: { mcData },
    SERVER_RECIPES: overrides && overrides.recipes,
    SERVER_OVERRIDES: overrides ?? { items: new Map(Object.entries(aliases)) },
    overrideRecipes,
    craftable,
    resolveBlockIds: () => [mcData.blocksByName.crafting_table.id],
    seenNow: () => true,
    STATIONS: new Map(),
    goals: { GoalNear: function (x, y, z, r) { Object.assign(this, { x, y, z, r }) } },
    LEGACY_1710: legacy,
    LEGACY_CRAFT_SYNC_MS,
    LEGACY_GRID_SYNC_MS,
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
    clearTimeout: (t) => { if (t) t.cleared = true }
  }
  rig.run = (query) => {
    const { handle, res } = routeHandler('/craft', env)
    rig.done = handle({ query }, res).then(() => (res.error ? { error: res.error.message } : JSON.parse(JSON.stringify(res.body))))
    return rig
  }
  rig.armed = async () => {
    for (let i = 0; i < 50 && !rig.waiting(); i++) await flush()
    assert.ok(rig.waiting(), 'craftItem armed no wait')
    return rig.waiting()
  }
  return rig
}

test('1.7.10 made and nowHave count the inventory after the window 0 update that follows the craft', async () => {
  const rig = craftRig({ items: { stick: 14 } }).run({ item: 'ladder', count: '3' })
  const wait = await rig.armed()
  assert.strictEqual(wait.ms, LEGACY_CRAFT_SYNC_MS)
  rig.held.set('ladder', 0)
  rig.packet('set_slot', { windowId: 1, slot: 10 })
  await flush()
  assert.ok(rig.waiting(), 'a table window set_slot ended the wait')
  rig.packet('set_slot', { windowId: 0, slot: 36 }, (held) => held.set('ladder', 3))
  assert.deepStrictEqual(await rig.done, { crafted: 'ladder', requested: 3, made: 3, usedTable: true, nowHave: 3 })
  assert.deepStrictEqual(rig.log, ['walk 10,64,0', 'craft ladder table', 'tick 1'])
})

test('1.7.10 set_player_inventory and window_items for window 0 end the table wait too', async () => {
  for (const [name, data] of [['set_player_inventory', { slotId: 0 }], ['window_items', { windowId: 0 }]]) {
    const rig = craftRig({ items: { stick: 7 } }).run({ item: 'ladder', count: '3' })
    await rig.armed()
    rig.packet(name, data)
    const reply = await rig.done
    assert.strictEqual(reply.unconfirmed, undefined, name)
    assert.strictEqual(reply.nowHave, 3, name)
  }
})

test('1.7.10 a window 0 update during the craft does not end the wait for the one after it', async () => {
  const rig = craftRig({ items: { stick: 7 }, during: (r) => r.packet('window_items', { windowId: 0 }) }).run({ item: 'ladder', count: '3' })
  await rig.armed()
  rig.held.set('ladder', 0)
  await flush()
  assert.ok(rig.waiting(), 'the wait ended before the update after the craft')
  rig.packet('set_slot', { windowId: 0, slot: 36 }, (held) => held.set('ladder', 3))
  const reply = await rig.done
  assert.deepStrictEqual([reply.made, reply.nowHave], [3, 3])
})

test('1.7.10 a table craft with no window 0 update within the wait is marked unconfirmed', async () => {
  const rig = craftRig({ items: { stick: 7 } }).run({ item: 'ladder', count: '3' })
  await rig.armed()
  rig.fire()
  assert.deepStrictEqual(await rig.done, {
    crafted: 'ladder', requested: 3, made: 3, usedTable: true, nowHave: 3,
    unconfirmed: `no inventory update from the server within ${LEGACY_CRAFT_SYNC_MS} ms, made and nowHave may predate the craft`
  })
  assert.ok(!rig.log.includes('tick 1'), 'a timed-out wait waited a tick')
})

test('1.7.10 a 2x2 pass waits only the short wait, for a window_items alone', async () => {
  const rig = craftRig({ items: { oak_planks: 2 }, table: false }).run({ item: 'stick', count: '4' })
  const wait = await rig.armed()
  assert.strictEqual(wait.ms, LEGACY_GRID_SYNC_MS)
  rig.packet('set_slot', { windowId: 0, slot: 36 })
  assert.ok(rig.waiting(), 'a set_slot ended the grid wait')
  rig.fire()
  assert.deepStrictEqual(await rig.done, { crafted: 'stick', requested: 4, made: 4, usedTable: false, nowHave: 4 })
  assert.deepStrictEqual(rig.timers.map((t) => t.ms), [LEGACY_GRID_SYNC_MS])
})

test('1.7.10 a pass the server rejects ends the loop with a note', async () => {
  const rig = craftRig({ items: { oak_planks: 6 }, table: false }).run({ item: 'stick', count: '12' })
  await rig.armed()
  rig.fire()
  await flush()
  await rig.armed()
  rig.packet('window_items', { windowId: 0 }, (held) => { held.set('stick', 4); held.set('oak_planks', 4) })
  assert.deepStrictEqual(await rig.done, {
    crafted: 'stick', requested: 12, made: 4, usedTable: false, nowHave: 4,
    note: 'the server made no stick on pass 2'
  })
  assert.deepStrictEqual(rig.log.filter((l) => l.startsWith('craft')), ['craft stick grid', 'craft stick grid'])
})

test('1.7.10 a first pass the server rejects refuses the craft', async () => {
  const rig = craftRig({ items: { oak_planks: 2 }, table: false }).run({ item: 'stick', count: '4' })
  await rig.armed()
  rig.packet('window_items', { windowId: 0 }, (held) => { held.set('stick', 0); held.set('oak_planks', 2) })
  assert.deepStrictEqual(await rig.done, { error: 'the server made no stick on pass 1' })
})

test('1.7.10 a 2x2 recipe crafts in the grid when the walk to a seen table fails, or ends with no table within 4', async () => {
  const walks = {
    'no path': async () => { throw new Error('No path to the goal!') },
    'arrived short': async () => {}
  }
  for (const [label, walk] of Object.entries(walks)) {
    const rig = craftRig({ items: { oak_planks: 2 }, walk }).run({ item: 'stick', count: '4' })
    await rig.armed()
    rig.fire()
    assert.deepStrictEqual(await rig.done, { crafted: 'stick', requested: 4, made: 4, usedTable: false, nowHave: 4, note: FAR }, label)
    assert.deepStrictEqual(rig.log, ['walk 10,64,0', 'craft stick grid'], label)
  }
})

test('1.7.10 a stop during the walk to the table is rethrown', async () => {
  const stop = async () => { throw Object.assign(new Error('stopped by /stop'), { reason: 'stopped' }) }
  const rig = craftRig({ items: { oak_planks: 2 }, walk: stop }).run({ item: 'stick', count: '4' })
  assert.deepStrictEqual(await rig.done, { error: 'stopped by /stop' })
  assert.deepStrictEqual(rig.log, ['walk 10,64,0'])
})

test('1.7.10 a 3x3 recipe at an unreachable table is still refused', async () => {
  const rig = craftRig({ items: { stick: 7 }, walk: async () => { throw new Error('No path to the goal!') } }).run({ item: 'ladder', count: '3' })
  assert.deepStrictEqual(await rig.done, { error: 'cannot reach the crafting table at 10,64,0' })
  assert.deepStrictEqual(rig.log, ['walk 10,64,0'])
})

test('1.21.11 counts the recipe yield at once and refuses an unreachable table for a 2x2 recipe', async () => {
  const rig = craftRig({ items: { stick: 7 }, legacy: false }).run({ item: 'ladder', count: '3' })
  assert.deepStrictEqual(await rig.done, { crafted: 'ladder', requested: 3, made: 3, usedTable: true, nowHave: 3 })
  assert.deepStrictEqual([rig.timers, rig.bot._client.eventNames()], [[], []])
  const far = craftRig({ items: { oak_planks: 2 }, legacy: false, walk: async () => { throw new Error('No path to the goal!') } }).run({ item: 'stick', count: '4' })
  assert.deepStrictEqual(await far.done, { error: 'cannot reach the crafting table at 10,64,0' })
})

test('1.7.10 a 1.21 name the server knows as another item is noted, an old 1.7 alias is not', async () => {
  const aliases = { birch_button: 'oak_button', wooden_button: 'oak_button' }
  const birch = craftRig({ items: { oak_planks: 1 }, table: false, aliases }).run({ item: 'birch_button', count: '1' })
  await birch.armed()
  birch.fire()
  assert.deepStrictEqual(await birch.done, { crafted: 'oak_button', requested: 1, made: 1, usedTable: false, nowHave: 1, note: 'birch_button is oak_button on this server' })
  const old = craftRig({ items: { oak_planks: 1 }, table: false, aliases }).run({ item: 'wooden_button', count: '1' })
  await old.armed()
  old.fire()
  assert.strictEqual((await old.done).note, undefined)
})

test('1.7.10 a wood fence the server lacks crafts the one fence from 6 sticks, with a note', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-overrides-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'overrides.json')
  fs.writeFileSync(file, JSON.stringify({
    ingredients: { stick: { items: ['stick'] } },
    recipes: [{ item: 'oak_fence', count: 2, inShape: [['stick', 'stick', 'stick'], ['stick', 'stick', 'stick']] }],
    blocks: {},
    items: { birch_fence: 'oak_fence' }
  }))
  const rig = craftRig({ items: { stick: 6 }, overrides: readServerOverrides(file) }).run({ item: 'birch_fence', count: '2' })
  await rig.armed()
  rig.packet('window_items', { windowId: 0 })
  assert.deepStrictEqual(await rig.done, {
    crafted: 'oak_fence', requested: 2, made: 2, usedTable: true, nowHave: 2, note: 'birch_fence is oak_fence on this server'
  })
  assert.deepStrictEqual([rig.held.get('stick'), rig.held.get('oak_fence')], [0, 2])
  assert.deepStrictEqual(rig.log.filter((l) => l.startsWith('craft')), ['craft oak_fence table'])
})

test('1.7.10 several notes join in one', async () => {
  const aliases = { birch_button: 'oak_button' }
  const rig = craftRig({ items: { oak_planks: 1 }, aliases, walk: async () => { throw new Error('No path to the goal!') } }).run({ item: 'birch_button', count: '2' })
  await rig.armed()
  rig.fire()
  assert.strictEqual((await rig.done).note, `birch_button is oak_button on this server; ${FAR}; out of materials/recipe after 1`)
})
