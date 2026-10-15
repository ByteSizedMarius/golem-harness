'use strict'
const { Vec3 } = require('vec3')

// Path nodes ahead that must lie in one straight, flat line before a sprint jump.
const RUN = 4
const MIN_FOOD = 8

const hasWork = (n) => n.toBreak.length > 0 || n.toPlace.length > 0

// The unit step from node a to node b along x or z on one level, or null.
function step (a, b) {
  const dx = b.x - a.x
  const dz = b.z - a.z
  if (Math.abs(b.y - a.y) > 0.001 || Math.abs(Math.abs(dx) + Math.abs(dz) - 1) > 0.001 || (dx !== 0 && dz !== 0)) return null
  return { dx: Math.round(dx), dz: Math.round(dz) }
}

// True when the feet, head and jump cells over node n are open and dry.
function clearForJump (blockAt, n) {
  const feet = new Vec3(Math.floor(n.x), Math.floor(n.y), Math.floor(n.z))
  return [0, 1, 2].every((up) => {
    const b = blockAt(feet.offset(0, up, 0))
    return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name)
  })
}

// True when the body, sprinting along path, may hold jump: on the ground, level with the next node,
// and the next RUN nodes run straight and flat with room for a jump over each.
function sprintJump ({ path, pos, onGround, blockAt, inWater, food, fighting }) {
  if (!onGround || inWater || fighting || !(food >= MIN_FOOD) || path.length < RUN) return false
  const first = path[0]
  if (Math.abs(first.y - pos.y) > 0.001 || hasWork(first)) return false
  const s = step(first, path[1])
  if (!s) return false
  for (let i = 1; i < RUN; i++) {
    const t = step(path[i - 1], path[i])
    if (!t || t.dx !== s.dx || t.dz !== s.dz || hasWork(path[i])) return false
  }
  // The body stands on the line, at most at the first node.
  const along = (first.x - pos.x) * s.dx + (first.z - pos.z) * s.dz
  const side = Math.abs((first.x - pos.x) * s.dz - (first.z - pos.z) * s.dx)
  if (along < 0 || along > 1.5 || side > 0.35) return false
  return [pos, ...path.slice(0, RUN)].every((n) => clearForJump(blockAt, n))
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

module.exports = { RUN, MIN_FOOD, step, sprintJump, passedNodes }
