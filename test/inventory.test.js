'use strict'
const test = require('node:test')
const assert = require('node:assert')
const registry = require('prismarine-registry')('1.21.11')
const Item = require('prismarine-item')(registry)
const { runRoute, loadBotFunctions } = require('./helpers')

const PICK_MAX = registry.itemsByName.stone_pickaxe.maxDurability
const HELMET_MAX = registry.itemsByName.iron_helmet.maxDurability
const SHIELD_MAX = registry.itemsByName.shield.maxDurability

function body (damage) {
  const item = (name, slot, used = 0) => Object.assign(new Item(registry.itemsByName[name].id, 1), { slot, durabilityUsed: used })
  const slots = new Array(46).fill(null)
  slots[36] = item('stone_pickaxe', 36, damage)
  slots[37] = item('cobblestone', 37)
  slots[5] = item('iron_helmet', 5, damage)
  slots[45] = item('shield', 45)
  return { heldItem: slots[36], inventory: { slots, items: () => [slots[36], slots[37]], emptySlotCount: () => 34 } }
}

function inventory (legacy, damage) {
  const bot = body(damage)
  // The loader does not follow a call behind a spread, such as wear in heldInfo.
  const { wear } = loadBotFunctions(['wear'], { LEGACY_1710: legacy })
  const env = { bot, shared: { ready: true, mcData: registry }, LEGACY_1710: legacy, wear }
  const held = loadBotFunctions(['heldInfo'], env).heldInfo()
  return { reply: runRoute('/inventory', {}, env), held: JSON.parse(JSON.stringify(held)) }
}

test('on 1.7.10 durability counts the uses a tool has left, the one that breaks it included', () => {
  const { reply, held } = inventory(true, 130)
  assert.deepStrictEqual(reply.items, [
    { name: 'stone_pickaxe', count: 1, slot: 36, durability: 2, maxDurability: PICK_MAX + 1 },
    { name: 'cobblestone', count: 1, slot: 37 }
  ])
  assert.deepStrictEqual(reply.worn, [
    { slot: 'head', name: 'iron_helmet', durability: HELMET_MAX - 129, maxDurability: HELMET_MAX + 1 },
    { slot: 'offhand', name: 'shield', durability: SHIELD_MAX + 1, maxDurability: SHIELD_MAX + 1 }
  ])
  assert.deepStrictEqual(held, { name: 'stone_pickaxe', count: 1, durability: 2, maxDurability: PICK_MAX + 1 })
})

test('on 1.21.11 durability is the maximum less the damage', () => {
  const { reply, held } = inventory(false, 130)
  assert.deepStrictEqual(reply.items[0], { name: 'stone_pickaxe', count: 1, slot: 36, durability: PICK_MAX - 130, maxDurability: PICK_MAX })
  assert.deepStrictEqual(reply.worn[0], { slot: 'head', name: 'iron_helmet', durability: HELMET_MAX - 130, maxDurability: HELMET_MAX })
  assert.deepStrictEqual(held, { name: 'stone_pickaxe', count: 1, durability: PICK_MAX - 130, maxDurability: PICK_MAX })
})
