'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { routeHandler, awaitRoute, botConstant, claimRescue, loadBotFunctions } = require('./helpers')

// mineflayer 4.37.1's inventory window: armor in 5 to 8, pockets from 9, the hotbar from 36, the off-hand at 45.
const ARMOR = { head: 5, torso: 6, legs: 7, feet: 8 }

// A body carrying names from slot 9 on, wearing worn ({ dest: name }) and holding held in the selected hotbar slot.
function body (names, worn = {}, held = null) {
  const slots = new Array(46).fill(null)
  names.forEach((name, i) => { slots[9 + i] = { name, slot: 9 + i } })
  for (const [dest, name] of Object.entries(worn)) slots[ARMOR[dest]] = { name, slot: ARMOR[dest] }
  if (held) slots[36] = { name: held, slot: 36 }
  const bot = { quickBarSlot: 0, equips: [] }
  bot.inventory = { slots, items: () => slots.slice(9, 45).filter(Boolean) }
  bot.getEquipmentDestSlot = (dest) => dest === 'hand' ? 36 + bot.quickBarSlot : dest === 'off-hand' ? 45 : ARMOR[dest]
  bot.equip = async (it, dest) => { bot.equips.push([it.name, dest]) }
  return bot
}

const env = (bot, legacy = false, digLock = botConstant('digLock')) => ({ bot, LEGACY_1710: legacy, digLock })

async function refusal (query, bot, legacy = false, digLock) {
  const { handle, res } = routeHandler('/equip', env(bot, legacy, digLock))
  await handle({ query }, res)
  assert.ok(res.error, 'equip did not refuse')
  return res.error.message
}

test('equip without dest puts armor in its slot', async () => {
  const bot = body(['iron_helmet', 'diamond_boots'])
  assert.deepStrictEqual(await awaitRoute('/equip', { name: 'iron_helmet' }, env(bot)), { equipped: 'iron_helmet', dest: 'head' })
  assert.deepStrictEqual(await awaitRoute('/equip', { name: 'diamond_boots' }, env(bot)), { equipped: 'diamond_boots', dest: 'feet' })
  assert.deepStrictEqual(bot.equips, [['iron_helmet', 'head'], ['diamond_boots', 'feet']])
})

test('equip without dest refuses armor for a slot already worn and names the worn piece', async () => {
  const bot = body(['iron_helmet'], { head: 'golden_helmet' })
  assert.strictEqual(await refusal({ name: 'iron_helmet' }, bot), 'already wearing golden_helmet on head, dest: "head" swaps it')
  assert.deepStrictEqual(bot.equips, [])
})

test('equip without dest puts armor in a free slot while another slot is worn', async () => {
  const bot = body(['diamond_boots'], { head: 'golden_helmet' })
  assert.deepStrictEqual(await awaitRoute('/equip', { name: 'diamond_boots' }, env(bot)), { equipped: 'diamond_boots', dest: 'feet' })
  assert.deepStrictEqual(bot.equips, [['diamond_boots', 'feet']])
})

test('equip without dest puts an elytra in the torso slot', async () => {
  const bot = body(['elytra'])
  assert.deepStrictEqual(await awaitRoute('/equip', { name: 'elytra' }, env(bot)), { equipped: 'elytra', dest: 'torso' })
  assert.deepStrictEqual(bot.equips, [['elytra', 'torso']])
})

test('equip without dest puts anything but armor in the hand, a held item included', async () => {
  const bot = body(['diamond_sword', 'shield'], {}, 'stone_pickaxe')
  assert.deepStrictEqual(await awaitRoute('/equip', { name: 'diamond_sword' }, env(bot)), { equipped: 'diamond_sword', dest: 'hand' })
  assert.deepStrictEqual(await awaitRoute('/equip', { name: 'shield' }, env(bot)), { equipped: 'shield', dest: 'hand' })
  assert.deepStrictEqual(bot.equips, [['diamond_sword', 'hand'], ['shield', 'hand']])
})

test('an explicit dest wins over the armor slot and swaps a worn piece', async () => {
  const bot = body(['iron_helmet'], { head: 'golden_helmet' })
  assert.deepStrictEqual(await awaitRoute('/equip', { name: 'iron_helmet', dest: 'head' }, env(bot)), { equipped: 'iron_helmet', dest: 'head' })
  assert.deepStrictEqual(await awaitRoute('/equip', { name: 'iron_helmet', dest: 'hand' }, env(bot)), { equipped: 'iron_helmet', dest: 'hand' })
  assert.deepStrictEqual(bot.equips, [['iron_helmet', 'head'], ['iron_helmet', 'hand']])
})

test('on 1.7.10 equip refuses the off-hand and puts a shield without dest in the hand', async () => {
  const bot = body(['shield'])
  assert.strictEqual(await refusal({ name: 'shield', dest: 'off-hand' }, bot, true), '1.7.10 has no off-hand')
  await awaitRoute('/equip', { name: 'shield' }, env(bot, true))
  assert.deepStrictEqual(bot.equips, [['shield', 'hand']])
})

test('during the buried self-rescue equip refuses busy for the hand and still puts armor on, leaving the shovel and the rescue\'s lease alone', async () => {
  const bot = body(['diamond_sword', 'iron_helmet'], {}, 'iron_shovel')
  const digLock = botConstant('digLock')
  const guardState = { hand: null }
  const { holdHand, endHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState, digLock, setTimeout, clearTimeout })
  claimRescue(digLock)
  const rescue = holdHand(digLock.holder)
  try {
    assert.strictEqual(await refusal({ name: 'diamond_sword' }, bot, false, digLock), 'busy: the buried self-rescue is running, nothing equipped')
    assert.strictEqual(await refusal({ name: 'iron_helmet', dest: 'hand' }, bot, false, digLock), 'busy: the buried self-rescue is running, nothing equipped')
    assert.deepStrictEqual(await awaitRoute('/equip', { name: 'iron_helmet' }, { ...env(bot, false, digLock), guardState }), { equipped: 'iron_helmet', dest: 'head' })
    assert.deepStrictEqual(bot.equips, [['iron_helmet', 'head']])
    assert.strictEqual(bot.inventory.slots[36].name, 'iron_shovel')
    assert.strictEqual(guardState.hand, rescue, 'equip ended the rescue\'s lease')
  } finally { endHand(rescue) }
})

test('equip puts the item in the hand once the buried self-rescue ends', async () => {
  const bot = body(['diamond_sword'], {}, 'iron_shovel')
  const digLock = botConstant('digLock')
  claimRescue(digLock)
  digLock.holder = null
  assert.deepStrictEqual(await awaitRoute('/equip', { name: 'diamond_sword' }, env(bot, false, digLock)), { equipped: 'diamond_sword', dest: 'hand' })
  assert.deepStrictEqual(bot.equips, [['diamond_sword', 'hand']])
})
