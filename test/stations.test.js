'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const { ENCHANTING_1_21 } = require('../lib/server-overrides')
const { routeHandler, awaitRoute } = require('./helpers')

const HERE = new Vec3(0.5, 64, 0.5)
const AT = new Vec3(5, 64, 0)
const IDS = { enchanting_table: [116], anvil: [145], chipped_anvil: [146], damaged_anvil: [147] }

// A body at HERE with empty pockets and one block of name at AT, unseen when seen is false.
function stationEnv (name, seen) {
  const walks = []
  const env = {
    shared: { ready: true },
    bot: {
      entity: { position: HERE },
      findBlocks: ({ matching }) => (matching.includes(IDS[name][0]) ? [AT] : []),
      blockAt: (p) => ({ name: p.equals(AT) ? name : 'stone', position: p }),
      pathfinder: { goto: async (g) => { walks.push([g.x, g.y, g.z]) } },
      inventory: { items: () => [] },
      openEnchantmentTable: async () => assert.fail('opened the table'),
      openAnvil: async () => assert.fail('opened the anvil')
    },
    cellKnown: (p) => seen || !p.equals(AT),
    seenNow: (p) => seen || !p.equals(AT),
    STATIONS: new Map(),
    resolveBlockIds: (n) => IDS[n] || [],
    goals,
    LEGACY_1710: false,
    SERVER_OVERRIDES: null,
    ENCHANTING_1_21
  }
  return { env, walks }
}

async function refusal (route, query, env) {
  const { handle, res } = routeHandler(route, env)
  await handle({ query }, res)
  assert.ok(res.error, `${route} answered ${JSON.stringify(res.body)}`)
  return res.error.message
}

test('enchant and rename walk only to a seen enchanting table or anvil, and refuse an unseen one without walking to it or naming it', async () => {
  for (const [route, name, query, none] of [
    ['/enchant', 'enchanting_table', { item: 'iron_sword' }, 'no enchanting table seen within 16'],
    ['/rename', 'chipped_anvil', { item: 'iron_sword', name: 'Occam' }, 'no anvil seen within 16']
  ]) {
    const seen = stationEnv(name, true)
    assert.strictEqual(await refusal(route, query, seen.env), 'no iron_sword in pockets', `control: ${route} reaches a seen ${name}`)
    assert.deepStrictEqual(seen.walks, [[5, 64, 0]], route)

    const hidden = stationEnv(name, false)
    assert.strictEqual(await refusal(route, query, hidden.env), none)
    assert.deepStrictEqual(hidden.walks, [], route)
  }
})

// The enchantment registry a server sent, in an order other than minecraft-data's.
function sentRegistry () {
  const sent = require('prismarine-registry')('1.21.11')
  sent.loadDimensionCodec({
    id: 'minecraft:enchantment',
    entries: ['sharpness', 'silk_touch', 'power'].map((name) => ({ key: `minecraft:${name}`, value: { type: 'compound', name: '', value: {} } }))
  })
  return sent
}

// A table whose offer i hints at the sent registry's enchantment i at level 2.
function enchantingTable (pockets, levels, applies, sent) {
  const Item = require('prismarine-item')(sent)
  const table = {
    id: 7,
    closed: false,
    slots: [],
    inventoryStart: 2,
    inventoryEnd: 38,
    enchantments: [],
    async putTargetItem (item) { table.slots[0] = item },
    async putLapis (item) {
      table.slots[1] = { ...item, slot: 1 }
      table.held = table.slots[0] && table.slots[0].count
      table.enchantments = levels.map((level, i) => ({ level, expected: { enchant: level > 0 ? i : -1, level: level > 0 ? 2 : -1 } }))
    },
    targetItem: () => table.slots[0],
    async putAway (slot) {
      const empty = table.slots.findIndex((s, i) => i >= table.inventoryStart && i < table.inventoryEnd && !s)
      table.slots[empty] = table.slots[slot]
      table.slots[slot] = null
    },
    close () { table.closed = true },
    commit (slot) {
      if (!applies) return
      const book = table.slots[0].name === 'book'
      table.slots[0] = Item.fromNotch({
        itemId: sent.itemsByName[book ? 'enchanted_book' : table.slots[0].name].id,
        itemCount: 1,
        components: [{ type: book ? 'stored_enchantments' : 'enchantments', data: { enchantments: [{ id: slot, level: 2 }] } }]
      })
    }
  }
  for (const [i, item] of pockets.entries()) table.slots[30 + i] = { ...item, slot: 30 + i }
  return table
}

// mineflayer's clickWindow over the table's slots and a cursor, for mode 0 clicks.
function clicker (table, clicks) {
  let cursor = null
  return async (slot, button, mode) => {
    clicks.push([slot, button, mode])
    const there = table.slots[slot]
    if (button === 1 && cursor && !there) {
      table.slots[slot] = { ...cursor, count: 1, slot }
      cursor = cursor.count > 1 ? { ...cursor, count: cursor.count - 1 } : null
    } else {
      table.slots[slot] = cursor && { ...cursor, slot }
      cursor = there
    }
  }
}

// stuck lists the table slots whose putAway throws. inTable holds the names in the table's item and lapis slots when the reply went out.
async function enchantRun (query, { legacy = false, overrides = null, levels = [2, 5, 9], applies = true, item = { name: 'iron_sword', count: 1 }, stuck = [] } = {}) {
  const pockets = [item, { name: 'lapis_lazuli', count: 3 }]
  const { env, walks } = stationEnv('enchanting_table', true)
  const sent = sentRegistry()
  const table = enchantingTable(pockets, levels, applies, sent)
  table.takeTargetItem = () => env.bot.putAway(0)
  const writes = []
  const clicks = []
  let inTable = null
  const replied = (send) => (res, body) => {
    inTable = [table.slots[0], table.slots[1]].map((s) => s && s.name)
    send(res, body)
  }
  Object.assign(env.bot, {
    registry: sent,
    clickWindow: clicker(table, clicks),
    inventory: { items: () => pockets },
    experience: { level: 10 },
    openEnchantmentTable: async () => table,
    putAway: async (slot) => {
      if (stuck.includes(slot)) throw new Error(`no answer for slot ${slot}`)
      await table.putAway(slot)
    },
    _client: {
      on () {},
      removeListener () {},
      write: (name, data) => {
        writes.push([name, { ...data }])
        if (name === 'enchant_item') table.commit(data.enchantment)
      }
    }
  })
  // setTimeout ends the wait after the commit at once.
  Object.assign(env, {
    shared: { ...env.shared, mcData: registry },
    LEGACY_1710: legacy,
    SERVER_OVERRIDES: overrides,
    ENCHANTING_1_21,
    emitEvent () {},
    setTimeout: (fn) => setImmediate(fn),
    ok: replied((res, body) => { res.body = body }),
    err: replied((res, e) => { res.error = e }),
    send: replied((res, body) => { res.body = body })
  })
  const { handle, res } = routeHandler('/enchant', env)
  await handle({ query }, res)
  return { reply: res.body && JSON.parse(JSON.stringify(res.body)), error: res.error && res.error.message, writes, table, walks, clicks, inTable }
}

const offersBy = (model, levels = [2, 5, 9]) => levels.map((levelNeeded, slot) => ({
  slot, levelNeeded, levelCost: model.levelCost[slot], lapisCost: model.lapisCost[slot], enchant: `${['sharpness', 'silk_touch', 'power'][slot]} 2`
}))

test('enchant at a seen table lists the 3 offers, and with slot commits that one', async () => {
  const offers = offersBy({ lapisCost: [1, 2, 3], levelCost: [1, 2, 3] })
  const look = await enchantRun({ item: 'iron_sword' })
  assert.deepStrictEqual(look.reply.offers, offers)
  assert.deepStrictEqual(look.writes, [], 'a look committed an offer')
  assert.ok(look.table.closed)

  const commit = await enchantRun({ item: 'iron_sword', slot: '1' })
  assert.deepStrictEqual(commit.writes, [['enchant_item', { windowId: 7, enchantment: 1 }]])
  assert.deepStrictEqual([commit.reply.enchanted, commit.reply.offer, commit.reply.enchants], ['iron_sword', offers[1], { silk_touch: 2 }])
})

test('enchant names each offer by the enchantment registry the server sent', async () => {
  const { reply } = await enchantRun({ item: 'iron_sword' })
  assert.notStrictEqual(registry.enchantments[1].name, 'silk_touch', 'control: minecraft-data names id 1 otherwise')
  assert.deepStrictEqual(reply.offers.map((o) => o.enchant), ['sharpness 2', 'silk_touch 2', 'power 2'])
})

test('enchant prices the offers by the declared enchanting costs', async () => {
  const declared = { lapisCost: [2, 4, 6], levelCost: [1, 1, 1] }
  for (const legacy of [true, false]) {
    const { reply } = await enchantRun({ item: 'iron_sword' }, { legacy, overrides: { enchanting: declared } })
    assert.deepStrictEqual(reply.offers, offersBy(declared), `legacy ${legacy}`)
  }
})

test('enchant on a 1.7.10 server without declared enchanting costs refuses before walking', async () => {
  for (const overrides of [null, { enchanting: null }]) {
    const { error, walks, writes } = await enchantRun({ item: 'iron_sword', slot: '0' }, { legacy: true, overrides })
    assert.strictEqual(error, 'refused: this 1.7.10 server declares no enchanting costs (no enchanting entry in GOLEM_SERVER_OVERRIDES), nothing done')
    assert.deepStrictEqual([walks, writes], [[], []])
  }
})

test('enchant refuses to commit an offer that shows level 0', async () => {
  const { error, writes, table } = await enchantRun({ item: 'iron_sword', slot: '1' }, { levels: [3, 0, 0] })
  assert.strictEqual(error, 'slot 1 holds no offer')
  assert.deepStrictEqual(writes, [])
  assert.ok(table.closed)
})

test('enchant puts one item of a stack into the table and keeps the rest in its pocket slot', async () => {
  const { reply, clicks, table } = await enchantRun({ item: 'book' }, { item: { name: 'book', count: 3 } })
  assert.ok(reply, 'the look failed')
  assert.deepStrictEqual(clicks, [[30, 0, 0], [0, 1, 0], [30, 0, 0]])
  assert.strictEqual(table.held, 1, 'books in the table when the lapis went in')
  assert.strictEqual(table.slots[30].count, 2)
})

test('enchant reports what a committed book got, from its stored enchantments', async () => {
  const { reply, error } = await enchantRun({ item: 'book', slot: '1' }, { item: { name: 'book', count: 1 } })
  assert.strictEqual(error, undefined)
  assert.deepStrictEqual(reply.enchants, { silk_touch: 2 })
})

test('enchant reports an error when the server enchanted nothing', async () => {
  const { error, writes } = await enchantRun({ item: 'iron_sword', slot: '2' }, { applies: false })
  assert.deepStrictEqual(writes, [['enchant_item', { windowId: 7, enchantment: 2 }]])
  assert.strictEqual(error, 'the server enchanted nothing: iron_sword in the table carries no enchantment 1 s after the commit')
})

test('enchant replies once the item and lapis are back in the pockets', async () => {
  for (const [query, levels] of [[{ item: 'iron_sword' }], [{ item: 'iron_sword', slot: '1' }], [{ item: 'iron_sword', slot: '1' }, [3, 0, 0]]]) {
    const { reply, error, inTable } = await enchantRun(query, { levels })
    assert.ok(reply || error, JSON.stringify(query))
    assert.deepStrictEqual(inTable, [null, null], JSON.stringify(query))
    assert.strictEqual(reply && reply.notBack, undefined)
  }
})

test('enchant names what a failed put-away left out of the pockets', async () => {
  const look = await enchantRun({ item: 'iron_sword' }, { stuck: [0] })
  assert.strictEqual(look.reply.offers.length, 3)
  assert.deepStrictEqual([look.reply.ok, look.reply.notBack, look.reply.reason], [false, { iron_sword: 1 }, 'iron_sword x1 did not come back from the table to my pockets'])
  assert.ok(look.table.closed)

  const commit = await enchantRun({ item: 'iron_sword', slot: '1' }, { stuck: [1] })
  assert.deepStrictEqual(commit.reply.enchants, { silk_touch: 2 })
  assert.deepStrictEqual([commit.reply.ok, commit.reply.notBack], [false, { lapis_lazuli: 3 }])

  const refused = await enchantRun({ item: 'iron_sword', slot: '1' }, { levels: [3, 0, 0], stuck: [0] })
  assert.deepStrictEqual(refused.reply, { ok: false, error: 'slot 1 holds no offer', notBack: { iron_sword: 1 } })
})

test('rename renames the named pocket item at a seen anvil', async () => {
  const { env } = stationEnv('anvil', true)
  const sword = { name: 'iron_sword', count: 1 }
  const renamed = []
  Object.assign(env.bot, {
    inventory: { items: () => [{ name: 'stick', count: 2 }, sword] },
    experience: { level: 9 },
    openAnvil: async () => ({ rename: async (item, name) => { renamed.push([item, name]) }, close () {} })
  })
  env.emitEvent = () => {}
  assert.deepStrictEqual(await awaitRoute('/rename', { item: 'iron_sword', name: 'Occam' }, env), { renamed: 'iron_sword', name: 'Occam', myLevelNow: 9 })
  assert.deepStrictEqual(renamed, [[sword, 'Occam']])
})
