'use strict'

// Minecraft 1.7.10 values for a Forge 1.7.10 server behind ViaProxy.

// On 1.7.10 a full hit lands every 10 ticks at most, and the bot attacks 11 ticks apart.
const LEGACY_HIT_MS = 550
// How far a 1.7.10 sprint carries the body after the run's last check.
const RUN_COAST = 0.63
// The 1.7.10 [width, height] by 1.21.11 name where the hitboxes differ, slimes and magma cubes at size 1.
const HITBOX_1710 = {
  zombie: [0.6, 1.8],
  zombie_villager: [0.6, 1.8],
  zombified_piglin: [0.6, 1.8],
  skeleton: [0.6, 1.8],
  wither_skeleton: [0.72, 2.34],
  creeper: [0.6, 1.8],
  witch: [0.6, 1.8],
  silverfish: [0.3, 0.7],
  slime: [0.6, 0.6],
  magma_cube: [0.6, 0.6],
  wolf: [0.6, 0.8],
  cow: [0.9, 1.3],
  mooshroom: [0.9, 1.3],
  chicken: [0.3, 0.7]
}
// The eye height of a sneaking 1.7.10 player.
const LEGACY_SNEAK_EYE = 1.54
// The sky light water takes away on 1.7.10, where the 1.21 data says 1.
const LEGACY_WATER_FILTER = 3
// 1.7.10 mob names Via passes on unchanged.
const LEGACY_MOB = /^mob\.([a-z0-9_]+)\.[a-z0-9_.-]+$/
// 1.7.10 sound names Via passes on unchanged, with their category.
const LEGACY_FIXED_SOUNDS = [['mob.attack', 'slime']]
// Via's name for the 1.7.10 zombie pigman, with its category.
const LEGACY_SOUND_KINDS = [['zombie_pigman', 'zombified_piglin']]
// Via's name for the 1.7.10 fizz (lava meeting water, or a burning thing going out), with its category.
const LEGACY_SOUNDS = new Map([['entity.generic.extinguish_fire', 'lava or fizz']])
// How long and how far from 1.7.10 thunder an explosion counts as its lightning.
const LEGACY_STRIKE_MS = 2000
const LEGACY_STRIKE_RANGE = 2
// 1.7.10 formats the 1.21 language lacks.
const LEGACY_FORMATS = { 'chat.type.achievement': '%s has just earned the achievement %s' }
// Blocks the 1.7.10 server breaks at hand speed whatever the tool.
const LEGACY_HAND_DIG = new Set(['ladder'])
// How long a dig waits for the server's block update after mineflayer's own timer ends.
const LEGACY_DIG_CONFIRM_MS = 1500
// The server's window 0 update after a table craft arrives 67 to 125 ms after the last click.
const LEGACY_CRAFT_SYNC_MS = 500
// How long a 2x2 craft waits for the window_items the server sends when it rejects the click.
const LEGACY_GRID_SYNC_MS = 200

module.exports = {
  LEGACY_HIT_MS,
  RUN_COAST,
  HITBOX_1710,
  LEGACY_SNEAK_EYE,
  LEGACY_WATER_FILTER,
  LEGACY_MOB,
  LEGACY_FIXED_SOUNDS,
  LEGACY_SOUND_KINDS,
  LEGACY_SOUNDS,
  LEGACY_STRIKE_MS,
  LEGACY_STRIKE_RANGE,
  LEGACY_FORMATS,
  LEGACY_HAND_DIG,
  LEGACY_DIG_CONFIRM_MS,
  LEGACY_CRAFT_SYNC_MS,
  LEGACY_GRID_SYNC_MS
}
