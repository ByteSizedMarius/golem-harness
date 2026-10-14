'use strict'

// A resource name: an optional namespace, then lowercase words joined by dots.
const NAME = /^(?:[a-z0-9_.-]+:)?[a-z0-9_.-]+$/
const MAX_NAME = 128
const ENTITY = /^entity\.([a-z0-9_]+)\.([a-z0-9_.-]+)$/
// 1.7.10 mob names Via passes on unchanged.
const LEGACY_MOB = /^mob\.([a-z0-9_]+)\.[a-z0-9_.-]+$/

const FIXED = new Map([
  ['mob.attack', 'slime'],
  ['ambient.weather.thunder', 'thunder']
])
const DROPPED = new Set(['boat', 'experience_orb', 'fishing_bobber', 'firework_rocket', 'item'])
const GENERIC_DROPPED = new Set(['splash', 'swim', 'eat', 'drink', 'burp'])
// Matched anywhere in the name, the first match wins.
const SUBSTRINGS = [[/^(?!music_disc\.).*lava/, 'lava'], [/fuse|primed/, 'fuse'], [/explo/, 'explosion'], [/water|drip/, 'water']]

// Entity words of the 1.21.11 sound names, each filed under itself.
const KINDS = new Map([
  ...[
    'allay', 'armadillo', 'armor_stand', 'arrow', 'axolotl', 'baby_nautilus', 'bat', 'bee', 'blaze',
    'bogged', 'breeze', 'camel', 'camel_husk', 'cat', 'chicken', 'cod', 'copper_golem',
    'copper_golem_oxidized', 'copper_golem_weathered', 'cow', 'creaking', 'creeper', 'dolphin',
    'donkey', 'dragon_fireball', 'drowned', 'egg', 'elder_guardian', 'ender_dragon', 'ender_eye',
    'ender_pearl', 'enderman', 'endermite', 'evoker', 'evoker_fangs', 'experience_bottle', 'fish',
    'fox', 'frog', 'generic', 'ghast', 'ghastling', 'glow_item_frame', 'glow_squid', 'goat',
    'guardian', 'happy_ghast', 'hoglin', 'horse', 'hostile', 'husk', 'illusioner', 'iron_golem',
    'item_frame', 'lingering_potion', 'llama', 'magma_cube', 'minecart', 'mooshroom', 'mule',
    'nautilus', 'ocelot', 'painting', 'panda', 'parched', 'parrot', 'phantom', 'pig', 'piglin',
    'piglin_brute', 'pillager', 'polar_bear', 'puffer_fish', 'rabbit', 'ravager', 'salmon', 'sheep',
    'shulker', 'shulker_bullet', 'silverfish', 'skeleton', 'skeleton_horse', 'slime', 'sniffer',
    'snow_golem', 'snowball', 'spider', 'splash_potion', 'squid', 'stray', 'strider', 'tadpole',
    'tnt', 'tropical_fish', 'turtle', 'vex', 'villager', 'vindicator', 'wandering_trader', 'warden',
    'wind_charge', 'witch', 'wither', 'wither_skeleton', 'wolf', 'wolf_angry', 'wolf_big',
    'wolf_cute', 'wolf_grumpy', 'wolf_puglin', 'wolf_sad', 'zoglin', 'zombie', 'zombie_horse',
    'zombie_nautilus', 'zombie_villager', 'zombified_piglin'
  ].map((kind) => [kind, kind]),
  ['lightning_bolt', 'thunder'],
  // Via's name for the 1.7.10 zombie pigman.
  ['zombie_pigman', 'zombified_piglin']
])

// The category a heard sound is filed under, or null for a sound the bot ignores.
function classifySound (name, { legacy1710 = false } = {}) {
  if (typeof name !== 'string' || name.length > MAX_NAME || !NAME.test(name)) return null
  const path = name.slice(name.indexOf(':') + 1)
  const fixed = FIXED.get(path)
  if (fixed) return fixed
  // The 1.7.10 fizz of lava meeting water or something burning.
  if (legacy1710 === true && path === 'entity.generic.extinguish_fire') return 'lava'
  const entity = ENTITY.exec(path)
  if (entity) {
    const [, kind, sound] = entity
    if (DROPPED.has(kind) || (kind === 'generic' && GENERIC_DROPPED.has(sound))) return null
    if (sound === 'big_fall' || sound === 'small_fall') return 'fall'
    if (kind === 'player') return sound === 'death' || /^hurt(_|$)/.test(sound) ? 'player' : null
  }
  for (const [pattern, category] of SUBSTRINGS) if (pattern.test(path)) return category
  const source = entity || LEGACY_MOB.exec(path)
  return source ? KINDS.get(source[1]) ?? null : null
}

module.exports = { classifySound }
