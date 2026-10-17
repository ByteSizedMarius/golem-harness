'use strict'
const { Vec3 } = require('vec3')
const { MIN_FOOD } = require('./sprint')

// A mob takes a full hit at most once per 10 ticks, plus the tick the last hit landed in.
const HURT_GAP_MS = 11 * 50
// A jump rises for 6 ticks.
const JUMP_FALL_TICKS = 7
const JUMP_TICKS = 14
// The farthest a sprint opener runs and the ticks it may take.
const RUN_MAX = 8
const RUN_TICKS = 40
// How far a 1.7.10 sprint carries the body after the run's last check.
const RUN_COAST = 0.63
// Melee reach along the look ray, from the eye to the target's hitbox grown by its 0.1 border.
const SWING_REACH = 3.0
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

function hurtWindows (now = Date.now) {
  const at = new Map()
  return {
    // The ms until e takes a full hit again, 0 when it does now.
    wait: (e) => Math.max(0, (at.has(e.id) ? at.get(e.id) : -Infinity) + HURT_GAP_MS - now()),
    wire: (bot) => {
      bot.on('entityHurt', (e) => { if (e) at.set(e.id, now()) })
      bot.on('entityGone', (e) => { if (e) at.delete(e.id) })
    }
  }
}

// Why a jump before a swing lands no critical hit, or null when it does.
function noCritReason ({ riding, inWater, onLadder, onGround, walking, perched, headroom }) {
  if (riding) return 'riding'
  if (inWater) return 'in water'
  if (onLadder) return 'on a ladder'
  if (!onGround) return 'off the ground'
  if (walking) return 'walking a path'
  if (perched) return 'on a perch'
  if (!headroom) return 'no headroom'
  return null
}

// The feet cells of a straight run from feet position from to to, at the height of from.
function runCells (from, to) {
  const y = Math.floor(from.y)
  const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) * 4))
  return Array.from({ length: n + 1 }, (_, i) => new Vec3(Math.floor(from.x + (to.x - from.x) * i / n), y, Math.floor(from.z + (to.z - from.z) * i / n)))
}

// Why the body cannot sprint straight from feet position from to to, or null.
function noRunReason ({ from, to, food, blockAt, known }) {
  if (!(food >= MIN_FOOD)) return 'too hungry'
  if (Math.abs(to.y - from.y) > 0.5) return 'not on one level'
  for (const cell of runCells(from, to)) {
    const floor = cell.offset(0, -1, 0)
    const f = blockAt(floor)
    if (!f || f.boundingBox !== 'block' || !known(floor)) return 'no known floor on the way'
    for (const up of [0, 1]) {
      const p = cell.offset(0, up, 0)
      const b = blockAt(p)
      if (!b || b.boundingBox !== 'empty' || /water|lava/.test(b.name) || !known(p)) return 'blocked on the way'
    }
  }
  return null
}

// One /strike swing at its slowest: 4 ticks to take-off, the jump, 2 ticks of aim and the 1.5 s kill watch.
const STRIKE_SWING_MS = (4 + JUMP_TICKS + 2) * 50 + 1500
// The longest walk /strike takes toward a target within 16 blocks, or to its drops.
const STRIKE_APPROACH_MS = 6000

// How long /strike may take for max swings: an approach before each swing and the walk to the drops.
function strikeBudgetMs (max) {
  return max * (STRIKE_APPROACH_MS + STRIKE_SWING_MS) + STRIKE_APPROACH_MS
}

const HOLD_MAX_S = 30

module.exports = {
  HURT_GAP_MS,
  JUMP_FALL_TICKS,
  JUMP_TICKS,
  RUN_MAX,
  RUN_TICKS,
  RUN_COAST,
  SWING_REACH,
  HITBOX_1710,
  hurtWindows,
  noCritReason,
  runCells,
  noRunReason,
  STRIKE_SWING_MS,
  STRIKE_APPROACH_MS,
  strikeBudgetMs,
  HOLD_MAX_S
}
