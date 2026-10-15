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

module.exports = { smeltYield }
