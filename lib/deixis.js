'use strict'
const { Vec3 } = require('vec3')

// The words that make a chat line point at something.
const DEICTIC = /\b(here|there|this|that)\b/i
// How far from the bot a speaker may stand, and how far their look reaches.
const POINT_RANGE = 32

const deictic = (msg) => DEICTIC.test(String(msg))

// A look passes air and liquids, and stops at any other block, grass and flowers included.
const lookPasses = (b) => b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' || b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column'

// The first block on the look from eye along yaw and pitch (mineflayer's angles) within maxDist, as
// { block, cell }, or null. blockAt(cell) gives the block in a cell, null where the world is not loaded.
function lookedAt (eye, yaw, pitch, blockAt, maxDist = POINT_RANGE) {
  const dir = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
  const from = [eye.x, eye.y, eye.z]
  const cell = from.map(Math.floor)
  const step = dir.map(Math.sign)
  const tDelta = dir.map((d) => (d ? Math.abs(1 / d) : Infinity))
  const tMax = dir.map((d, i) => (d > 0 ? (cell[i] + 1 - from[i]) / d : d < 0 ? (from[i] - cell[i]) / -d : Infinity))
  let t = 0
  while (t <= maxDist) {
    const at = new Vec3(cell[0], cell[1], cell[2])
    const b = blockAt(at)
    if (!b) return null
    if (!lookPasses(b)) return { block: b, cell: at }
    const i = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2)
    t = tMax[i]
    cell[i] += step[i]
    tMax[i] += tDelta[i]
  }
  return null
}

module.exports = { POINT_RANGE, deictic, lookedAt }
