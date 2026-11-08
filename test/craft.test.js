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
const { craftBlocker, bindCraftCheck } = require('../lib/bot/craft-check')
const { routeHandler } = require('./helpers')
const registry = require('prismarine-registry')('1.21.11')
const Item = require('prismarine-item')(registry)
const windows = require('prismarine-windows')(registry)
const { Recipe } = require('prismarine-recipe')(registry)
const injectCraft = require('mineflayer/lib/plugins/craft')

const TABLE_AT = new Vec3(10, 64, 0)
const FAR = 'the crafting table at 10,64,0 is out of reach, crafted in the 2x2 grid'
// count is what one pass yields.
const RECIPES = {
  ladder: { count: 3, requiresTable: true, cost: { stick: 7 } },
  stick: { count: 4, requiresTable: false, cost: { oak_planks: 2 } },
  oak_button: { count: 1, requiresTable: false, cost: { oak_planks: 1 } },
  dispenser: { count: 1, requiresTable: true, cost: { cobblestone: 7, bow: 1, redstone: 1 } },
  bucket: { count: 1, requiresTable: true, cost: { iron_ingot: 3 } }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// A /craft run with a seen table at 10,64,0 unless table is false, which the default walk stops 2.5 short of.
// overrides is a parsed server overrides file, which supplies both the aliases and the recipes.
function craftRig ({ items, legacy = true, table = true, walk, during = () => {}, aliases = {}, overrides = null, damaged = {}, full = false }) {
  const held = new Map(Object.entries(items))
  const timers = []
  const log = []
  const options = []
  const entity = { position: new Vec3(0.5, 64, 0.5) }
  const ref = (name, count) => ({ id: mcData.itemsByName[name].id, metadata: null, count })
  const recipeFor = (name, t) => {
    const r = RECIPES[name]
    if (!r || (r.requiresTable && !t)) return []
    const cost = Object.entries(r.cost)
    if (!cost.every(([n, k]) => (held.get(n) || 0) >= k)) return []
    return [{
      name,
      result: ref(name, r.count),
      requiresTable: r.requiresTable,
      ingredients: cost.flatMap(([n, k]) => Array.from({ length: k }, () => ref(n, 1))),
      delta: [...cost.map(([n, k]) => ref(n, -k)), ref(name, r.count)]
    }]
  }
  const stack = (name, count) => {
    const { id, stackSize, maxDurability } = mcData.itemsByName[name]
    return { type: id, name, count, stackSize, maxDurability, durabilityUsed: maxDurability ? (damaged[name] || 0) : null }
  }
  const rig = { held, timers, log, options }
  const bot = {
    entity,
    _client: new EventEmitter(),
    inventory: {
      count: (id) => held.get(mcData.items[id].name) || 0,
      items: () => [...held].filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })),
      inventoryStart: 9,
      inventoryEnd: 45,
      get slots () {
        const stacks = [...held].filter(([, n]) => n > 0).map(([name, count]) => stack(name, count))
        while (full && stacks.length < 36) stacks.push(stack('dirt', 64))
        return [...Array(9).fill(null), ...stacks, ...Array(37 - stacks.length).fill(null)]
      }
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
    async craft (recipe, n, t, opts) {
      log.push(`craft ${mcData.items[recipe.result.id].name} ${t ? 'table' : 'grid'}`)
      options.push({ ...opts })
      await flush()
      during(rig)
      for (const d of recipe.delta) held.set(mcData.items[d.id].name, (held.get(mcData.items[d.id].name) || 0) + d.count)
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

// From pass from on, the rig's craft takes the materials and lands no result in the pockets.
function dropsResult (rig, from) {
  const craft = rig.bot.craft
  let pass = 0
  rig.bot.craft = async (recipe, ...rest) => {
    if (++pass < from) return craft(recipe, ...rest)
    for (const d of recipe.delta) {
      const name = mcData.items[d.id].name
      if (d.count < 0) rig.held.set(name, rig.held.get(name) + d.count)
    }
  }
  return rig
}

test('1.21.11 counts what each pass added to the pockets and ends at a pass that added nothing', async () => {
  const later = dropsResult(craftRig({ items: { stick: 14 }, legacy: false }), 2).run({ item: 'ladder', count: '6' })
  assert.deepStrictEqual(await later.done, { crafted: 'ladder', requested: 6, made: 3, usedTable: true, nowHave: 3, note: 'the server made no ladder on pass 2' })
  const first = dropsResult(craftRig({ items: { stick: 7 }, legacy: false }), 1).run({ item: 'ladder', count: '3' })
  assert.deepStrictEqual(await first.done, { error: 'the server made no ladder on pass 1' })
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

bindCraftCheck({ shared: { mcData } })

const recipeFor = (name) => Recipe.find(mcData.itemsByName[name].id)[0]

// Pockets holding fill, slot to [name, count, damage, components].
function pockets (fill, full = false) {
  const slots = new Array(46).fill(null)
  const stack = (slot, name, count, damage = 0, components = []) => {
    const { id, stackSize, maxDurability } = mcData.itemsByName[name]
    return { type: id, name, count, slot, stackSize, maxDurability, durabilityUsed: maxDurability ? damage : null, components, removedComponents: [] }
  }
  if (full) for (let i = 9; i < 45; i++) slots[i] = stack(i, 'dirt', 64)
  for (const [slot, [name, count, damage, components]] of Object.entries(fill)) slots[slot] = stack(Number(slot), name, count, damage, components)
  return { slots, inventoryStart: 9, inventoryEnd: 45 }
}

const DISPENSER_PARTS = { 9: ['cobblestone', 7], 10: ['redstone', 1] }
const NO_POCKET = 'no free pocket slot for the bucket, free one and craft again'

test('1.7.10 refuses a dispenser when every bow carried is damaged, a modern server takes the damaged bow', () => {
  const inv = pockets({ ...DISPENSER_PARTS, 11: ['bow', 1, 50] })
  assert.strictEqual(craftBlocker(inv, recipeFor('dispenser'), true),
    'every bow carried is damaged, and this server crafts dispenser only from an undamaged one')
  assert.strictEqual(craftBlocker(inv, recipeFor('dispenser'), false), null)
})

test('1.7.10 crafts a dispenser from an undamaged bow carried above a damaged one', () => {
  const inv = pockets({ ...DISPENSER_PARTS, 11: ['bow', 1, 50], 30: ['bow', 1] })
  assert.strictEqual(craftBlocker(inv, recipeFor('dispenser'), true), null)
})

test('full pockets of full stacks refuse a bucket the craft would drop', () => {
  const inv = pockets({ 9: ['iron_ingot', 64] }, true)
  for (const legacy of [true, false]) assert.strictEqual(craftBlocker(inv, recipeFor('bucket'), legacy), NO_POCKET, `legacy ${legacy}`)
})

test('full pockets take a bucket into the slot the lowest iron stack empties', () => {
  const inv = pockets({ 9: ['iron_ingot', 2], 20: ['iron_ingot', 30] }, true)
  assert.strictEqual(craftBlocker(inv, recipeFor('bucket'), true), null)
})

test('full pockets take a bucket when the leftover iron joins a part-full stack whole, and refuse when part of it is left', () => {
  assert.strictEqual(craftBlocker(pockets({ 9: ['iron_ingot', 10], 20: ['iron_ingot', 50] }, true), recipeFor('bucket'), true), null)
  assert.strictEqual(craftBlocker(pockets({ 9: ['iron_ingot', 10], 20: ['iron_ingot', 60] }, true), recipeFor('bucket'), true), NO_POCKET)
})

test('full pockets take a bucket into a bucket stack with room, and refuse it when that stack has other components', () => {
  const inv = (components) => pockets({ 9: ['iron_ingot', 64], 30: ['bucket', 5, 0, components] }, true)
  assert.strictEqual(craftBlocker(inv([]), recipeFor('bucket'), true), null)
  assert.strictEqual(craftBlocker(inv([{ type: 'custom_name', data: 'Milk run' }]), recipeFor('bucket'), true), NO_POCKET)
})

test('full pockets take 4 sticks when all of them join a stick stack, and refuse when 2 are left', () => {
  const sticks = Recipe.find(mcData.itemsByName.stick.id).find((r) => r.inShape.flat()[0].id === mcData.itemsByName.oak_planks.id)
  const inv = (count) => pockets({ 9: ['oak_planks', 64], 10: ['stick', count] }, true)
  assert.strictEqual(craftBlocker(inv(60), sticks, true), null)
  assert.strictEqual(craftBlocker(inv(62), sticks, true), 'no free pocket slot for the stick, free one and craft again')
})

// The slots bot.craft picks a bow up from while crafting a dispenser.
async function bowPickups (options) {
  const table = windows.createWindow(1, 'minecraft:crafting', 'Crafting')
  // A 1.21.11 server sends the damage as an item component.
  const put = (slot, name, count, damage = 0) => {
    const components = damage ? [{ type: 'damage', data: damage }] : []
    table.updateSlot(slot, Item.fromNotch({ itemId: registry.itemsByName[name].id, itemCount: count, components }))
  }
  put(10, 'cobblestone', 7)
  put(11, 'redstone', 1)
  put(12, 'bow', 1, 100)
  put(30, 'bow', 1)
  const picked = []
  const bot = Object.assign(new EventEmitter(), {
    registry,
    activateBlock: () => setImmediate(() => bot.emit('windowOpen', table)),
    async clickWindow (slot, mouseButton, mode) {
      const item = table.slots[slot]
      if (item && item.name === 'bow') picked.push(slot)
      table.acceptClick({ slot, mouseButton, mode, item })
    },
    async putSelectedItemRange () { table.selectedItem = null },
    async putAway () {},
    closeWindow () {}
  })
  injectCraft(bot)
  await bot.craft(recipeFor('dispenser'), 1, { position: TABLE_AT }, options)
  return picked
}

test('craft with intact picks up the undamaged bow above a damaged one, without it the lowest bow', async () => {
  assert.deepStrictEqual(await bowPickups({ intact: true }), [30])
  assert.deepStrictEqual(await bowPickups(), [12])
})

test('1.7.10 refuses a dispenser whose only bow is damaged before the walk to the table, and crafts one from an undamaged bow with undamaged ingredients only', async () => {
  const parts = { cobblestone: 7, redstone: 1, bow: 1 }
  const worn = craftRig({ items: parts, damaged: { bow: 50 } }).run({ item: 'dispenser', count: '1' })
  assert.deepStrictEqual(await worn.done, { error: 'every bow carried is damaged, and this server crafts dispenser only from an undamaged one' })
  assert.deepStrictEqual(worn.log, [])
  const whole = craftRig({ items: parts }).run({ item: 'dispenser', count: '1' })
  await whole.armed()
  whole.packet('window_items', { windowId: 0 })
  assert.deepStrictEqual(await whole.done, { crafted: 'dispenser', requested: 1, made: 1, usedTable: true, nowHave: 1 })
  assert.deepStrictEqual(whole.options, [{ intact: true }])
})

test('1.21.11 crafts a dispenser from a damaged bow', async () => {
  const rig = craftRig({ items: { cobblestone: 7, redstone: 1, bow: 1 }, damaged: { bow: 50 }, legacy: false }).run({ item: 'dispenser', count: '1' })
  assert.deepStrictEqual(await rig.done, { crafted: 'dispenser', requested: 1, made: 1, usedTable: true, nowHave: 1 })
  assert.deepStrictEqual(rig.options, [{ intact: false }])
})

test('a craft whose result would find no free pocket slot is refused before the walk to the table', async () => {
  for (const legacy of [true, false]) {
    const rig = craftRig({ items: { iron_ingot: 64 }, legacy, full: true }).run({ item: 'bucket', count: '1' })
    assert.deepStrictEqual(await rig.done, { error: NO_POCKET }, `legacy ${legacy}`)
    assert.deepStrictEqual(rig.log, [], `legacy ${legacy}`)
  }
})
