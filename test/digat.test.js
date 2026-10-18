'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const Item = require('prismarine-item')(registry)
const { loadBotFunctions, botConstant, awaitRoute } = require('./helpers')

const SWORD = { name: 'iron_sword', type: 1 }
const WOOD_PICK = { name: 'wooden_pickaxe', type: 2 }
const STONE_PICK = { name: 'stone_pickaxe', type: 3 }
const IRON_ORE = {
  name: 'iron_ore',
  harvestTools: { 3: true },
  canHarvest (type) { return !!this.harvestTools[type] }
}

// equipTakes(k) says whether the k-th equip (0-based) puts the item in hand.
function hands ({ held, items, equipTakes = () => true }) {
  const bot = { heldItem: held, inventory: { items: () => items }, equips: 0 }
  bot.equip = async (item) => { if (equipTakes(bot.equips++)) bot.heldItem = item }
  const ctx = loadBotFunctions(['holdHarvester'], { bot, PICK_TIER: botConstant('PICK_TIER') })
  return { bot, holdHarvester: ctx.holdHarvester }
}

test('digat puts the harvesting tool back in hand when another item holds it', async () => {
  const h = hands({ held: SWORD, items: [SWORD, WOOD_PICK, STONE_PICK] })
  assert.strictEqual(await h.holdHarvester(IRON_ORE), null)
  assert.strictEqual(h.bot.heldItem, STONE_PICK)
})

test('digat tries the equip again when the first one does not take', async () => {
  const h = hands({ held: SWORD, items: [SWORD, STONE_PICK], equipTakes: (k) => k > 0 })
  assert.strictEqual(await h.holdHarvester(IRON_ORE), null)
  assert.strictEqual(h.bot.equips, 2)
  assert.strictEqual(h.bot.heldItem, STONE_PICK)
})

test('digat refuses when the harvesting tool never reaches the hand', async () => {
  const h = hands({ held: SWORD, items: [SWORD, STONE_PICK], equipTakes: () => false })
  const why = await h.holdHarvester(IRON_ORE)
  assert.match(why, /^refusing to dig iron_ore/)
  assert.match(why, /stone_pickaxe/)
  assert.match(why, /iron_sword/)
})

test('digat leaves the hand alone when it holds a harvester or none is carried', async () => {
  const held = hands({ held: STONE_PICK, items: [STONE_PICK] })
  assert.strictEqual(await held.holdHarvester(IRON_ORE), null)
  assert.strictEqual(held.bot.equips, 0, 'a harvester already in hand')
  const none = hands({ held: SWORD, items: [SWORD, WOOD_PICK] })
  assert.strictEqual(await none.holdHarvester(IRON_ORE), null)
  assert.strictEqual(none.bot.equips, 0, 'no carried tool harvests it')
  const dirt = hands({ held: SWORD, items: [SWORD, STONE_PICK] })
  assert.strictEqual(await dirt.holdHarvester({ name: 'dirt', harvestTools: undefined, canHarvest: () => true }), null)
  assert.strictEqual(dirt.bot.equips, 0, 'a block any hand harvests')
})

// /digat on blockName in reach, with hotbar holding item names (null for an empty slot) and slot held selected.
async function digWith (blockName, hotbar, held, legacy = false) {
  const block = Block.fromStateId(registry.blocksByName[blockName].defaultState, 0)
  block.position = new Vec3(2, 64, 0)
  const slots = new Array(45).fill(null)
  hotbar.forEach((name, i) => { if (name) slots[36 + i] = new Item(registry.itemsByName[name].id, 1) })
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: { slots, hotbarStart: 36, items: () => slots.filter(Boolean) },
    quickBarSlot: held,
    get heldItem () { return slots[36 + this.quickBarSlot] },
    setQuickBarSlot (i) { this.quickBarSlot = i },
    equips: [],
    async equip (item) { this.equips.push(item.name); this.quickBarSlot = slots.indexOf(item) - 36 },
    blockAt: () => block,
    async dig () { this.dugWith = this.heldItem ? this.heldItem.name : null }
  }
  const env = {
    bot,
    bunker: { building: false },
    cellKnown: () => true,
    seenNow: () => true,
    require,
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    PICK_TIER: botConstant('PICK_TIER'),
    DIG_TOOL: botConstant('DIG_TOOL'),
    LEGACY_1710: legacy
  }
  const reply = await awaitRoute('/digat', { x: '2', y: '64', z: '0' }, env)
  return { reply, bot }
}

const TOOLS = ['wooden_pickaxe', 'stone_axe', 'wooden_shovel', 'iron_pickaxe', 'stone_pickaxe', null]

test('digat digs a log with an axe, dirt with a shovel, ore with the lowest pick that keeps the drop and a crop bare-handed', async () => {
  const log = await digWith('oak_log', TOOLS, 5)
  assert.strictEqual(log.bot.dugWith, 'stone_axe')
  assert.strictEqual(log.reply.with, 'stone_axe')
  assert.strictEqual((await digWith('dirt', TOOLS, 0)).bot.dugWith, 'wooden_shovel')
  assert.strictEqual((await digWith('iron_ore', TOOLS, 1)).bot.dugWith, 'stone_pickaxe')
  const crop = await digWith('wheat', TOOLS, 0)
  assert.deepStrictEqual(crop.bot.equips, [], 'a crop')
  assert.strictEqual(crop.bot.dugWith, null)
  assert.strictEqual(crop.reply.with, null)
})

test('digat digs hay and leaves with a hoe, but bare-handed on 1.7.10, where a hoe speeds no dig', async () => {
  const hotbar = ['stone_axe', 'iron_hoe', null]
  for (const name of ['hay_block', 'oak_leaves']) {
    assert.strictEqual((await digWith(name, hotbar, 2)).bot.dugWith, 'iron_hoe', name)
    assert.strictEqual((await digWith(name, hotbar, 2, true)).bot.dugWith, null, `${name} on 1.7.10`)
  }
})

test('digat answers a cave air cell as already air', async () => {
  const r = await digWith('cave_air', TOOLS, 0)
  assert.deepStrictEqual(r.reply, { already: 'air', at: { x: 2, y: 64, z: 0 } })
  assert.strictEqual(r.bot.dugWith, undefined)
})
