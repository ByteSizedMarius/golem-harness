'use strict'

const { SERVER_OVERRIDES, LEGACY_1710 } = require('./config')
const { LEGACY_HAND_DIG } = require('./legacy-1710')

let bot, shared, emitEvent, handFree

function resolveBlockIds(name) {
  if (!shared.mcData) return []
  const exact = Object.hasOwn(shared.mcData.blocksByName, name) && shared.mcData.blocksByName[name]
  if (exact) return [exact.id]
  // partial / fuzzy match across block names
  return Object.values(shared.mcData.blocksByName)
    .filter(b => b.name.includes(name))
    .map(b => b.id)
}
function resolveItem(name) {
  if (!shared.mcData) return null
  const known = (SERVER_OVERRIDES && SERVER_OVERRIDES.items.get(name)) || name
  const { itemsByName, blocksByName } = shared.mcData
  return (Object.hasOwn(itemsByName, known) && itemsByName[known]) || (Object.hasOwn(blocksByName, known) && blocksByName[known]) || null
}

// On 1.7.10 a tool still works on the use that takes its damage past the maximum.
function wear (item) {
  const max = item.maxDurability
  if (!(max > 0)) return {}
  const left = max - (item.durabilityUsed || 0)
  return LEGACY_1710 ? { durability: left + 1, maxDurability: max + 1 } : { durability: left, maxDurability: max }
}

// ---- tool sense: what am I holding and how worn is it?
function heldInfo() {
  const h = bot.heldItem
  if (!h) return null
  return { name: h.name, count: h.count, ...wear(h) }
}

const PICK_TIER = { wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1, iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 4 }
function neededPickTier(blockName) {
  if (!blockName) return 0
  const n = blockName.replace('deepslate_', '')
  if (/obsidian|ancient_debris|respawn_anchor/.test(n)) return 3   // diamond+ or the drop is DESTROYED
  if (/(gold|diamond|emerald|redstone)_ore/.test(n)) return 2
  if (/(iron|lapis|copper)_ore/.test(n)) return 1
  return 0
}
// The best carried pick up to iron that harvests blockName, else the lowest one above iron that does, else the best carried, else null.
function pickFor(blockName) {
  const picks = bot.inventory.items().filter(i => PICK_TIER[i.name] !== undefined)
    .sort((a, b) => PICK_TIER[a.name] - PICK_TIER[b.name])
  if (!picks.length) return null
  const need = neededPickTier(blockName)
  const harvests = picks.filter(p => PICK_TIER[p.name] >= need)
  const upToIron = harvests.filter(p => PICK_TIER[p.name] <= PICK_TIER.iron_pickaxe).sort((a, b) => PICK_TIER[b.name] - PICK_TIER[a.name])
  return upToIron[0] || harvests[0] || picks[picks.length - 1]
}
// True when the pick harvests the block, false when it is too low, null when no pick is carried.
async function equipPickFor(blockName) {
  const pick = pickFor(blockName)
  if (!pick) return null
  if (!bot.heldItem || bot.heldItem.name !== pick.name) { try { await bot.equip(pick, 'hand') } catch (e) {} }
  return PICK_TIER[pick.name] >= neededPickTier(blockName)
}
// No sword, it loses 2 durability per block.
const DIG_TOOL = /_axe$|_shovel$|^shears$/
// A hoe speeds no 1.7.10 dig.
function digToolFor (b) {
  const bare = b.digTime(null, false, false, false)
  if (bare === 0) return null
  if (String(b.material).split(';').some(t => t === 'mineable/pickaxe' || t.startsWith('incorrect_for_'))) return pickFor(b.name)
  if (LEGACY_1710 && LEGACY_HAND_DIG.has(b.name)) return null
  let tool = null
  let fastest = bare
  for (const i of bot.inventory.items()) {
    const digs = DIG_TOOL.test(i.name) || (/_hoe$/.test(i.name) && !LEGACY_1710)
    const ms = digs ? b.digTime(i.type, false, false, false) : Infinity
    if (ms < fastest) { tool = i; fastest = ms }
  }
  return tool
}
// Holds digToolFor(b), or for the bare hand the first hotbar slot holding no tool, if any.
async function holdDigTool (b) {
  const tool = digToolFor(b)
  if (tool) {
    if (!bot.heldItem || bot.heldItem.name !== tool.name) { try { await bot.equip(tool, 'hand') } catch (e) {} }
    return
  }
  if (!bot.heldItem || !(bot.heldItem.maxDurability > 0)) return
  const slots = bot.inventory.slots.slice(bot.inventory.hotbarStart, bot.inventory.hotbarStart + 9)
  const free = slots.findIndex(s => !s)
  const slot = free >= 0 ? free : slots.findIndex(s => !(s.maxDurability > 0))
  if (slot >= 0) bot.setQuickBarSlot(slot)
}

// Foods that poison, starve or nauseate, eaten only by name.
const RISKY_FOODS = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish']
// How long a meal waits for the server's food update, counted from the bite: a 32-tick bite plus 1.5 s.
const FOOD_UPDATE_MS = 3200
// The most filling carried food outside RISKY_FOODS and skip, else undefined.
function safeFood (skip = []) {
  const foods = (shared.mcData && shared.mcData.foods) || {}
  return bot.inventory.items().filter(i => foods[i.type] && !RISKY_FOODS.includes(i.name) && !skip.includes(i.name))
    .sort((a, b) => (foods[b.type].foodPoints || 0) - (foods[a.type].foodPoints || 0))[0]
}
// Waits from the bite of the carried food named name. Resolves to { confirmed, changed, countBefore, countNow } once an
// update_health raises food or saturation above before (confirmed), after FOOD_UPDATE_MS, or on cancel(). The counts
// sum the carried stacks named name, and changed means confirmed or exactly one fewer.
function foodUpdate (before, name) {
  const count = () => bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0)
  const countBefore = count()
  const raised = () => bot.food > before.food || bot.foodSaturation > before.saturation
  let end
  const wait = new Promise((resolve) => {
    const onHealth = () => { if (raised()) end(true) }
    const timer = setTimeout(() => end(false), FOOD_UPDATE_MS)
    end = (confirmed) => {
      clearTimeout(timer)
      bot.removeListener('health', onHealth)
      const countNow = count()
      resolve({ confirmed, changed: confirmed || countNow === countBefore - 1, countBefore, countNow })
    }
    bot.on('health', onHealth)
  })
  if (raised()) end(true)
  return Object.assign(wait, { cancel: () => end(false) })
}
// Eats the most filling safe food other than a golden apple and reports the food level.
async function refuelAfterFight () {
  const bite = safeFood(['golden_apple'])
  if (!bite) return
  const prevHeld = bot.heldItem
  const before = { food: bot.food, saturation: bot.foodSaturation }
  await handFree()
  await bot.equip(bite, 'hand')
  const update = foodUpdate(before, bite.name)
  try {
    await bot.consume()
  } catch (e) {
    update.cancel()
    throw e
  } finally {
    await handFree()
    if (prevHeld && bot.inventory.items().includes(prevHeld)) await bot.equip(prevHeld, 'hand')
  }
  const { confirmed, changed, countBefore, countNow } = await update
  if (changed) emitEvent('refuel', `refueled on ${bite.name} after the fight, food ${bot.food}/20${confirmed ? '' : ' (unconfirmed, no food update from the server yet)'}`)
  else emitEvent('refuel', `no meal seen within ${FOOD_UPDATE_MS} ms of the bite after the fight: ${bite.name} ${countBefore} before and ${countNow} after, food ${bot.food}/20. The pockets may show items the server does not hold.`)
}

// Puts a carried tool that harvests b in hand, trying twice. Null once one is held or none is
// carried, else why the dig is refused.
async function holdHarvester (b) {
  const harvests = (item) => !!item && b.canHarvest(item.type)
  if (!b.harvestTools || harvests(bot.heldItem)) return null
  const tool = [pickFor(b.name), ...bot.inventory.items()].find(harvests)
  if (!tool) return null
  for (let i = 0; i < 2 && !harvests(bot.heldItem); i++) { try { await bot.equip(tool, 'hand') } catch (e) {} }
  if (harvests(bot.heldItem)) return null
  return `refusing to dig ${b.name}: the ${tool.name} did not go into my hand (holding ${bot.heldItem ? bot.heldItem.name : 'nothing'})`
}

// mineflayer sets bot.digTime when its plugins inject.
function wireLegacyDigTime () {
  if (!LEGACY_1710) return
  bot.once('inject_allowed', () => {
    const toolTime = bot.digTime
    bot.digTime = (block) => LEGACY_HAND_DIG.has(block.name)
      ? block.digTime(null, bot.game.gameMode === 'creative', ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel()?.name), !bot.entity.onGround, [], bot.entity.effects)
      : toolTime(block)
  })
}

// A 1.7.10 server selects hotbar slot 0 after a death without telling the client.
function wireRespawnHeldSlot () {
  if (!LEGACY_1710) return
  bot._client.on('respawn', () => bot._client.write('held_item_slot', { slotId: bot.quickBarSlot }))
}

function createItems (ctx) {
  Object.assign(ctx, { resolveBlockIds, resolveItem, wear, heldInfo, PICK_TIER, neededPickTier, pickFor, equipPickFor, holdDigTool, FOOD_UPDATE_MS, safeFood, foodUpdate, refuelAfterFight, holdHarvester })
}

function bindItems (ctx) {
  ({ bot, shared, emitEvent, handFree } = ctx)
}

module.exports = { createItems, bindItems, wireLegacyDigTime, wireRespawnHeldSlot }
