'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const { routeHandler, awaitRoute } = require('./helpers')

const HERE = new Vec3(0.5, 64, 0.5)
const AT = new Vec3(5, 64, 0)
const IDS = { enchanting_table: [116], anvil: [145], chipped_anvil: [146], damaged_anvil: [147] }

// A body at HERE with empty pockets and one block of name at AT, unseen when seen is false.
function stationEnv (name, seen) {
  const walks = []
  const env = {
    ready: true,
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
    goals
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

function enchantingTable (pockets) {
  const sharpness = registry.enchantmentsByName.sharpness.id
  const table = {
    id: 7,
    closed: false,
    slots: [],
    enchantments: [],
    async putTargetItem (item) { table.slots[0] = item },
    async putLapis (item) {
      table.slots[1] = item
      table.enchantments = [2, 5, 9].map((level) => ({ level, expected: { enchant: sharpness } }))
    },
    targetItem: () => table.slots[0],
    async takeTargetItem () { table.slots[0] = null },
    close () { table.closed = true }
  }
  for (const [i, item] of pockets.entries()) table.slots[30 + i] = { ...item, slot: 30 + i }
  return table
}

test('enchant at a seen table lists the 3 offers, and with slot commits that one', async () => {
  const pockets = [{ name: 'iron_sword', count: 1 }, { name: 'lapis_lazuli', count: 3 }]
  const run = async (query) => {
    const { env } = stationEnv('enchanting_table', true)
    const table = enchantingTable(pockets)
    const writes = []
    Object.assign(env.bot, {
      inventory: { items: () => pockets },
      experience: { level: 10 },
      openEnchantmentTable: async () => table,
      putAway: async () => {},
      _client: { on () {}, removeListener () {}, write: (name, data) => writes.push([name, { ...data }]) }
    })
    // setTimeout ends the wait after the commit at once.
    Object.assign(env, { mcData: { enchantmentsArray: registry.enchantmentsArray }, emitEvent () {}, setTimeout: (fn) => setImmediate(fn) })
    return { reply: await awaitRoute('/enchant', query, env), writes, table }
  }
  const offers = [2, 5, 9].map((levelCost, slot) => ({ slot, levelCost, lapisCost: slot + 1, enchant: 'sharpness' }))

  const look = await run({ item: 'iron_sword' })
  assert.deepStrictEqual(look.reply.offers, offers)
  assert.deepStrictEqual(look.writes, [], 'a look committed an offer')
  assert.ok(look.table.closed)

  const commit = await run({ item: 'iron_sword', slot: '1' })
  assert.deepStrictEqual(commit.writes, [['enchant_item', { windowId: 7, enchantment: 1 }]])
  assert.deepStrictEqual([commit.reply.enchanted, commit.reply.offer], ['iron_sword', offers[1]])
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
