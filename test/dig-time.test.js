'use strict'
const test = require('node:test')
const assert = require('node:assert')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)

// Survival, dry, on the ground, no enchantments or effects.
function digTime (block, tool) {
  return Block.fromStateId(registry.blocksByName[block].defaultState, 0)
    .digTime(registry.itemsByName[tool].id, false, false, false)
}

test('a pickaxe digs obsidian and ores at its tier speed', () => {
  assert.strictEqual(digTime('obsidian', 'diamond_pickaxe'), 9400)
  assert.strictEqual(digTime('iron_ore', 'stone_pickaxe'), 1150)
})

test('a wooden axe digs iron ore at bare-hand speed', () => {
  assert.strictEqual(digTime('iron_ore', 'wooden_axe'), 15000)
})
