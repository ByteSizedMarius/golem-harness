'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const mineflayer = require('mineflayer')
const inventoryPlugin = require('mineflayer/lib/plugins/inventory')
const { awaitRoute, botConstant } = require('./helpers')
const { setStackSizes } = require('../lib/server-overrides')
const { CHEST_WINDOW, server1710 } = require('./chest-1710')

const VERSION = '1.21.11'
const registry = require('minecraft-data')(VERSION)
const CHEST_ID = registry.blocksByName.chest.id
const CHEST_AT = new Vec3(3, 64, 0)
// The 1.7.10 server's max stack where it differs from the 1.21.11 data.
const CAPS_1710 = { oak_door: 1, iron_door: 1 }
const ORIGINAL_SIZES = Object.fromEntries(['oak_door', 'iron_door'].map((n) => [n, registry.itemsByName[n].stackSize]))

// Puts back the registry entries a 1.7.10 login changes in this process.
const restoreSizes = () => { for (const [n, size] of Object.entries(ORIGINAL_SIZES)) registry.itemsByName[n].stackSize = size }

function loadConnection (legacy) {
  for (const m of ['../lib/bot/connection', '../lib/bot/config']) delete require.cache[require.resolve(m)]
  const was = process.env.GOLEM_MC_1710
  process.env.GOLEM_MC_1710 = legacy ? '1' : '0'
  try {
    return require('../lib/bot/connection')
  } finally {
    if (was === undefined) delete process.env.GOLEM_MC_1710
    else process.env.GOLEM_MC_1710 = was
  }
}

// A body on mineflayer's real inventory plugin, logged in through the connection wiring, beside a chest on a 1.7.10 server.
async function doorBody (t, legacy, contents) {
  t.after(restoreSizes)
  const client = new EventEmitter()
  client.version = VERSION
  client.end = () => {}
  const server = server1710(client, contents, CAPS_1710)
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  await once(bot, 'inject_allowed')
  bot.loadPlugin(inventoryPlugin)
  const Item = require('prismarine-item')(bot.registry)
  const { createConnection, bindConnection, wireConnectionSpawn } = loadConnection(legacy)
  const ctx = { bot }
  createConnection(ctx)
  bindConnection(ctx)
  wireConnectionSpawn()
  bot.emit('login')
  client.emit('window_items', server.notch(Item, 0))
  const chestBlock = { name: 'chest', type: CHEST_ID, position: CHEST_AT, getProperties: () => ({ type: 'single', facing: 'north' }) }
  Object.assign(bot, {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: (p) => (p.equals(CHEST_AT) ? chestBlock : { name: 'air', type: 0, position: p }),
    findBlocks: () => [CHEST_AT],
    world: { raycast: () => null },
    pathfinder: { goto: async () => {}, startCell: (p) => p.floored() },
    openContainer: async () => {
      const opened = once(bot, 'windowOpen')
      client.emit('open_window', { windowId: CHEST_WINDOW, inventoryType: 2, windowTitle: 'Chest' })
      client.emit('window_items', server.notch(Item, CHEST_WINDOW))
      return (await opened)[0]
    }
  })
  const env = {
    bot,
    guardState: { hand: null },
    reflexes: [{ name: 'combat', fightBusy: () => false, _threat: null }],
    bunkerHolds: () => false,
    setTimeout,
    clearTimeout,
    stackPause: async () => {},
    cellKnown: () => true,
    seenNow: () => true,
    leafInTheWay: () => null,
    STATIONS: new Map(),
    ck: (x, y, z) => x + ',' + y + ',' + z,
    require,
    resolveBlockIds: (name) => (name === 'chest' ? [CHEST_ID] : []),
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    goals,
    seenWorld: () => bot.world,
    CHEST_RADIUS: botConstant('CHEST_RADIUS'),
    CHEST_REACH: botConstant('CHEST_REACH')
  }
  return { bot, Item, server, env }
}

const at = { x: String(CHEST_AT.x), y: String(CHEST_AT.y), z: String(CHEST_AT.z) }

test('a 1.7.10 door deposit lands in an empty chest slot, never on a chest door', async (t) => {
  const { server, env } = await doorBody(t, true, { chest: [[0, 'oak_door', 1]], pockets: [[36, 'oak_door', 1], [37, 'oak_door', 1]] })
  const reply = await awaitRoute('/deposit', { name: 'oak_door', ...at }, env)
  assert.deepStrictEqual(reply, { deposited: [{ item: 'oak_door', count: 2, inChestNow: 3 }] })
  assert.deepStrictEqual([server.inChest('oak_door'), server.inPockets('oak_door'), server.cursorAtClose], [3, 0, null])
})

test('a 1.7.10 door withdrawal fills empty pocket slots', async (t) => {
  const chest = [[0, 'iron_door', 1], [1, 'iron_door', 1], [2, 'iron_door', 1]]
  const { server, env } = await doorBody(t, true, { chest, pockets: [[36, 'iron_door', 1]] })
  const reply = await awaitRoute('/withdraw', { name: 'iron_door', count: '3', ...at }, env)
  assert.deepStrictEqual(reply, { withdrew: [{ item: 'iron_door', count: 3 }] })
  assert.deepStrictEqual([server.inChest('iron_door'), server.inPockets('iron_door'), server.cursorAtClose], [0, 4, null])
})

test('withdraw without count takes one door on 1.7.10', async (t) => {
  const chest = [[0, 'oak_door', 1], [1, 'oak_door', 1], [2, 'oak_door', 1]]
  const { server, env } = await doorBody(t, true, { chest, pockets: [[36, 'oak_door', 1]] })
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'oak_door', ...at }, env), { withdrew: [{ item: 'oak_door', count: 1 }] })
  assert.deepStrictEqual([server.inChest('oak_door'), server.inPockets('oak_door'), server.cursorAtClose], [2, 2, null])
})

test('1.7.10 stack sizes reach the registry, new Items and window planning, and the 1.21 ones stay without LEGACY_1710', async (t) => {
  const pockets = [[36, 'oak_door', 1], [37, 'ender_pearl', 1]]
  const modern = await doorBody(t, false, { chest: [], pockets })
  const door = registry.itemsByName.oak_door.id
  assert.deepStrictEqual([modern.bot.registry.itemsByName.oak_door.stackSize, new modern.Item(door, 1).stackSize], [64, 64])
  assert.strictEqual(modern.bot.inventory.findItemRange(9, 45, door, null, true).slot, 36)

  const legacy = await doorBody(t, true, { chest: [], pockets })
  const sizes = (bot) => ['oak_door', 'iron_door', 'ender_pearl', 'stone'].map((n) => bot.registry.itemsByName[n].stackSize)
  assert.deepStrictEqual(sizes(legacy.bot), [1, 1, 16, 64])
  assert.deepStrictEqual([new legacy.Item(door, 1).stackSize, legacy.bot.inventory.slots[36].stackSize], [1, 1])
  assert.strictEqual(legacy.bot.inventory.findItemRange(9, 45, door, null, true), null)
  assert.throws(() => setStackSizes(registry, { wooden_door: 1 }), /wooden_door, an item this version lacks/)
})
