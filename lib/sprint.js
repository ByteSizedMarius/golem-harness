'use strict'
const { Vec3 } = require('vec3')

// Path nodes ahead that must lie in one straight, flat line before a sprint jump.
const RUN = 4
// Vanilla sprints only with food above 6.
const MIN_FOOD = 7
// A goto walk sprints, and any walk sprint jumps, only with food above this.
const SPRINT_FLOOR = 14
// The flat length of a parkour move past which only a sprint carries it.
const WALK_GAP = 2.5
// Blocks that break when the farmland under them is trampled.
const CROPS = new Set(['wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem', 'attached_melon_stem', 'attached_pumpkin_stem'])

const hasWork = (n) => n.toBreak.length > 0 || n.toPlace.length > 0

// The unit step from node a to node b along x or z on one level, or null.
function step (a, b) {
  const dx = b.x - a.x
  const dz = b.z - a.z
  if (Math.abs(b.y - a.y) > 0.001 || Math.abs(Math.abs(dx) + Math.abs(dz) - 1) > 0.001 || (dx !== 0 && dz !== 0)) return null
  return { dx: Math.round(dx), dz: Math.round(dz) }
}

const fullCube = (b) => b.shapes.length === 1 && b.shapes[0].join() === '0,0,0,1,1,1'

// 'ceiling' under a full-cube jump cell, 'open' when the feet, head and jump cells are open and dry, else why the body may not jump.
function overhead (blockAt, n) {
  const feet = new Vec3(Math.floor(n.x), Math.floor(n.y), Math.floor(n.z))
  for (const up of [0, 1, 2]) {
    const b = blockAt(feet.offset(0, up, 0))
    if (up === 2 && b && b.boundingBox === 'block' && fullCube(b)) return 'ceiling'
    if (!b || b.boundingBox !== 'empty') return 'no headroom'
    const liquid = /water|lava/.exec(b.name)
    if (liquid) return liquid[0]
  }
  return 'open'
}

// 'farmland' or 'crops' when a landing at x, z with the feet at y tramples a field, else null.
function field (blockAt, x, y, z) {
  const feet = new Vec3(Math.floor(x), Math.ceil(y), Math.floor(z))
  const floor = blockAt(feet.offset(0, -1, 0))
  if (floor && floor.name === 'farmland') return 'farmland'
  const crop = blockAt(feet)
  return crop && CROPS.has(crop.name) ? 'crops' : null
}

// The reason the body, sprinting along path, may not hold jump, or null when it may.
function noJumpReason ({ path, pos, onGround, blockAt, inWater, food, fighting }) {
  if (!onGround) return 'off the ground'
  if (inWater) return 'water'
  if (fighting) return 'fighting'
  if (!(food > SPRINT_FLOOR)) return 'too hungry'
  if (path.length < RUN) return 'path too short'
  if (path.slice(0, RUN).some(hasWork)) return 'work on the path'
  const first = path[0]
  const s = Math.abs(first.y - pos.y) > 0.001 ? null : step(first, path[1])
  if (!s) return 'path not straight or flat'
  for (let i = 1; i < RUN; i++) {
    const t = step(path[i - 1], path[i])
    if (!t || t.dx !== s.dx || t.dz !== s.dz) return 'path not straight or flat'
  }
  // The body stands on the line, at most at the first node.
  const along = (first.x - pos.x) * s.dx + (first.z - pos.z) * s.dz
  const side = Math.abs((first.x - pos.x) * s.dz - (first.z - pos.z) * s.dx)
  if (along < 0 || along > 1.5 || side > 0.35) return 'off the line'
  for (let k = 0; k <= RUN; k++) {
    const why = field(blockAt, first.x + k * s.dx, first.y, first.z + k * s.dz)
    if (why) return why
  }
  // A hop from under open sky into a ceiling hits the ceiling's side and stops the body.
  let open = false
  for (const n of [pos, ...path.slice(0, RUN)]) {
    const over = overhead(blockAt, n)
    if (over === 'open') open = true
    else if (over !== 'ceiling') return over
    else if (open) return 'no headroom'
  }
  return null
}

// How many leading nodes of a straight, flat run along dir (a step) the body has passed. A node where the
// path turns stays. The pathfinder ticks a node off only with the feet less than a block above it, which a
// hop is not.
function passedNodes (path, pos, dir) {
  let n = 0
  while (n + 1 < path.length) {
    const a = path[n]
    const s = step(a, path[n + 1])
    if (!s || s.dx !== dir.dx || s.dz !== dir.dz || hasWork(a) || hasWork(path[n + 1])) break
    const along = (pos.x - a.x) * s.dx + (pos.z - a.z) * s.dz
    const side = Math.abs((pos.x - a.x) * s.dz - (pos.z - a.z) * s.dx)
    if (along < 0 || side > 0.5 || pos.y < a.y - 0.5) break
    n++
  }
  return n
}

// Whether the pathfinder may sprint: by the vanilla rule, and on a goto walk only above the floor or in a fight.
function sprintAllowed ({ food, goto, fighting }) {
  return food >= MIN_FOOD && (!goto || food > SPRINT_FLOOR || fighting)
}

// True when path node n lies a jump from from that only a sprint carries.
function sprintGap (from, n) {
  return !!n.parkour && Math.hypot(n.x - from.x, n.z - from.z) > WALK_GAP
}

// True when a move between two nodes of path is a sprint gap.
function gapAhead (path) {
  for (let i = 1; i < path.length; i++) if (sprintGap(path[i - 1], path[i])) return true
  return false
}

module.exports = { RUN, MIN_FOOD, SPRINT_FLOOR, step, noJumpReason, passedNodes, sprintAllowed, sprintGap, gapAhead }
