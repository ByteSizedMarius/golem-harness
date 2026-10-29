'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registryFor = require('prismarine-registry')
const digging = require('mineflayer/lib/plugins/digging')

// The enchantment registry ViaProxy sent a 1.21.11 client in front of a 1.7.10 server, in its order.
const VIA_ENCHANTMENTS = [
  'protection', 'fire_protection', 'feather_falling', 'blast_protection', 'projectile_protection', 'respiration',
  'aqua_affinity', 'thorns', 'depth_strider', 'frost_walker', 'binding_curse', 'soul_speed', 'swift_sneak', 'sharpness',
  'smite', 'bane_of_arthropods', 'knockback', 'fire_aspect', 'looting', 'sweeping_edge', 'efficiency', 'silk_touch',
  'unbreaking', 'fortune', 'power', 'punch', 'flame', 'infinity', 'luck_of_the_sea', 'lure', 'loyalty', 'impaling',
  'riptide', 'channeling', 'multishot', 'quick_charge', 'piercing', 'density', 'breach', 'wind_burst', 'mending',
  'vanishing_curse'
]
const HEAD_SLOT = 5

// A survival bot on the ground, its registry loaded from ViaProxy's registry_data, with mineflayer's dig time.
function digBot ({ held = null, helmet = null, eyeIn = 'air' } = {}) {
  const registry = registryFor('1.21.11')
  registry.loadDimensionCodec({
    id: 'minecraft:enchantment',
    entries: VIA_ENCHANTMENTS.map((name) => ({ key: `minecraft:${name}`, value: { type: 'compound', name: '', value: {} } }))
  })
  const Item = require('prismarine-item')(registry)
  const Block = require('prismarine-block')(registry)
  const item = (name, enchantments) => Item.fromNotch({
    itemId: registry.itemsByName[name].id,
    itemCount: 1,
    components: enchantments ? [{ type: 'enchantments', data: { enchantments } }] : [],
    removeComponents: []
  })
  const slots = new Array(46).fill(null)
  if (helmet) slots[HEAD_SLOT] = item(helmet.name, helmet.enchantments)
  const bot = Object.assign(new EventEmitter(), {
    registry,
    heldItem: held && item(held.name, held.enchantments),
    inventory: { slots },
    getEquipmentDestSlot: (dest) => dest === 'head' ? HEAD_SLOT : null,
    game: { gameMode: 'survival' },
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, onGround: true, effects: {} },
    blockAt: () => ({ name: eyeIn })
  })
  digging(bot)
  bot.stone = Block.fromStateId(registry.blocksByName.stone.defaultState, 0)
  return bot
}

test('an Efficiency pick digs faster than a plain one', () => {
  const plain = digBot({ held: { name: 'iron_pickaxe' } })
  const efficient = digBot({ held: { name: 'iron_pickaxe', enchantments: [{ id: 20, level: 5 }] } })
  assert.ok(efficient.digTime(efficient.stone) < plain.digTime(plain.stone),
    `efficiency V ${efficient.digTime(efficient.stone)} ms, plain ${plain.digTime(plain.stone)} ms`)
})

test('an Aqua Affinity helmet keeps the dry dig time under water', () => {
  const dry = digBot({ held: { name: 'iron_pickaxe' } })
  const wet = digBot({ held: { name: 'iron_pickaxe' }, helmet: { name: 'iron_helmet', enchantments: [{ id: 6, level: 1 }] }, eyeIn: 'water' })
  assert.strictEqual(wet.digTime(wet.stone), dry.digTime(dry.stone))
})

test('enchants names each enchantment by the registry the server sent', () => {
  const bot = digBot({ held: { name: 'iron_pickaxe', enchantments: [{ id: 23, level: 3 }, { id: 21, level: 1 }] } })
  assert.deepStrictEqual(bot.heldItem.enchants, [{ name: 'fortune', lvl: 3 }, { name: 'silk_touch', lvl: 1 }])
})
