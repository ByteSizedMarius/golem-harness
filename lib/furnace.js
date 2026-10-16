'use strict'

// What a furnace makes of each input, by 1.21.11 item name.
const YIELD = {
  sand: 'glass',
  red_sand: 'glass',
  cobblestone: 'stone',
  stone: 'smooth_stone',
  cobbled_deepslate: 'deepslate',
  stone_bricks: 'cracked_stone_bricks',
  sandstone: 'smooth_sandstone',
  red_sandstone: 'smooth_red_sandstone',
  quartz_block: 'smooth_quartz',
  basalt: 'smooth_basalt',
  clay_ball: 'brick',
  clay: 'terracotta',
  netherrack: 'nether_brick',
  nether_quartz_ore: 'quartz',
  nether_gold_ore: 'gold_ingot',
  ancient_debris: 'netherite_scrap',
  cactus: 'green_dye',
  sea_pickle: 'lime_dye',
  kelp: 'dried_kelp',
  wet_sponge: 'sponge',
  chorus_fruit: 'popped_chorus_fruit',
  potato: 'baked_potato'
}
for (const metal of ['iron', 'gold', 'copper']) {
  YIELD[`${metal}_ore`] = YIELD[`deepslate_${metal}_ore`] = YIELD[`raw_${metal}`] = `${metal}_ingot`
}
for (const [ore, gem] of [['coal', 'coal'], ['diamond', 'diamond'], ['emerald', 'emerald'], ['lapis', 'lapis_lazuli'], ['redstone', 'redstone']]) {
  YIELD[`${ore}_ore`] = YIELD[`deepslate_${ore}_ore`] = gem
}
for (const meat of ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon']) YIELD[meat] = `cooked_${meat}`

function smeltYield (input) {
  if (/_(log|wood)$/.test(input)) return 'charcoal'
  return Object.hasOwn(YIELD, input) ? YIELD[input] : null
}

// Items smelted per fuel item, the vanilla 1.7.10 burn time in ticks over 200.
const BURN = {
  coal: 8, charcoal: 8, coal_block: 80, lava_bucket: 100, blaze_rod: 12, stick: 0.5,
  chest: 1.5, trapped_chest: 1.5, crafting_table: 1.5, bookshelf: 1.5, jukebox: 1.5, note_block: 1.5
}
const WOOD = /^(?:stripped_)?(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo)_(planks|log|wood|slab|stairs|fence|fence_gate|trapdoor|pressure_plate)$/

function burnItems (fuel) {
  if (Object.hasOwn(BURN, fuel)) return BURN[fuel]
  const wood = WOOD.exec(fuel)
  if (wood) return wood[1] === 'slab' ? 0.75 : 1.5
  if (/^wooden_(sword|shovel|pickaxe|axe|hoe)$/.test(fuel)) return 1
  if (/_sapling$/.test(fuel)) return 0.5
  return null
}

// Ticks smelt watches a loaded furnace for cook progress before it calls the input unsmeltable.
const COOK_PROBE_TICKS = 60

module.exports = { smeltYield, burnItems, COOK_PROBE_TICKS }
