'use strict'

const { SERVER_OVERRIDES } = require('./config')

let bot, shared, emitEvent

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

// ---- tool sense: what am I holding and how worn is it?
function heldInfo() {
  const h = bot.heldItem
  if (!h) return null
  const out = { name: h.name, count: h.count }
  try {
    const max = (shared.mcData && shared.mcData.items[h.type] && shared.mcData.items[h.type].maxDurability) || null
    if (max) { out.durability = max - (h.durabilityUsed || 0); out.maxDurability = max }
  } catch (e) {}
  return out
}

// ---- tiered pick choice: use the LOWEST pick that can harvest the target (stop burning iron
// durability on plain stone), upgrade automatically for ore that needs better (protects drops).
const PICK_TIER = { wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1, iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 4 }
function neededPickTier(blockName) {
  if (!blockName) return 0
  const n = blockName.replace('deepslate_', '')
  if (/obsidian|ancient_debris|respawn_anchor/.test(n)) return 3   // diamond+ or the drop is DESTROYED
  if (/(gold|diamond|emerald|redstone)_ore/.test(n)) return 2
  if (/(iron|lapis|copper)_ore/.test(n)) return 1
  return 0
}
// The lowest carried pick that harvests blockName, else the best carried one, else null.
function pickFor(blockName) {
  const picks = bot.inventory.items().filter(i => PICK_TIER[i.name] !== undefined)
    .sort((a, b) => PICK_TIER[a.name] - PICK_TIER[b.name])
  if (!picks.length) return null
  const need = neededPickTier(blockName)
  return picks.find(p => PICK_TIER[p.name] >= need) || picks[picks.length - 1]
}
async function equipPickFor(blockName) {
  const pick = pickFor(blockName)
  if (!pick) return false
  if (!bot.heldItem || bot.heldItem.name !== pick.name) { try { await bot.equip(pick, 'hand') } catch (e) {} }
  return PICK_TIER[pick.name] >= neededPickTier(blockName)
}
// Tools /digat may use besides pickaxes. A sword loses 2 durability per block, and a hoe speeds no 1.7.10 dig.
const DIG_TOOL = /_axe$|_shovel$|^shears$/
// The carried tool to dig b with, null for the bare hand.
function digToolFor (b) {
  const bare = b.digTime(null, false, false, false)
  if (bare === 0) return null
  if (String(b.material).split(';').some(t => t === 'mineable/pickaxe' || t.startsWith('incorrect_for_'))) return pickFor(b.name)
  let tool = null
  let fastest = bare
  for (const i of bot.inventory.items()) {
    const ms = DIG_TOOL.test(i.name) ? b.digTime(i.type, false, false, false) : Infinity
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
// How long a meal waits for the server's food update.
const FOOD_UPDATE_MS = 1500
// The most filling carried food outside RISKY_FOODS and skip, else undefined.
function safeFood (skip = []) {
  const foods = (shared.mcData && shared.mcData.foods) || {}
  return bot.inventory.items().filter(i => foods[i.type] && !RISKY_FOODS.includes(i.name) && !skip.includes(i.name))
    .sort((a, b) => (foods[b.type].foodPoints || 0) - (foods[a.type].foodPoints || 0))[0]
}
// True once an update_health raises food or saturation above before, false after FOOD_UPDATE_MS.
function foodUpdate (before) {
  const raised = () => bot.food > before.food || bot.foodSaturation > before.saturation
  if (raised()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (confirmed) => { clearTimeout(timer); bot.removeListener('health', onHealth); resolve(confirmed) }
    const onHealth = () => { if (raised()) done(true) }
    const timer = setTimeout(() => done(false), FOOD_UPDATE_MS)
    bot.on('health', onHealth)
  })
}
// Eats the most filling safe food other than a golden apple and reports the food level.
async function refuelAfterFight () {
  const bite = safeFood(['golden_apple'])
  if (!bite) return
  const prevHeld = bot.heldItem
  const before = { food: bot.food, saturation: bot.foodSaturation }
  await bot.equip(bite, 'hand')
  try {
    await bot.consume()
    const confirmed = await foodUpdate(before)
    emitEvent('combat', `refueled on ${bite.name} after the fight, food ${bot.food}/20${confirmed ? '' : ' (unconfirmed, no food update from the server yet)'}`)
  } finally {
    if (prevHeld && bot.inventory.items().includes(prevHeld)) await bot.equip(prevHeld, 'hand')
  }
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

function createItems (ctx) {
  Object.assign(ctx, { resolveBlockIds, resolveItem, heldInfo, PICK_TIER, neededPickTier, pickFor, equipPickFor, holdDigTool, FOOD_UPDATE_MS, safeFood, foodUpdate, refuelAfterFight, holdHarvester })
}

function bindItems (ctx) {
  ({ bot, shared, emitEvent } = ctx)
}

module.exports = { createItems, bindItems }
