'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { loadBotFunctions, botConstant } = require('./helpers')

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
