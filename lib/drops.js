'use strict'
const { Vec3 } = require('vec3')
const { standCell, UNLOADED, UNKNOWN } = require('./walk')

// A body picks a drop up within its box grown by 1 sideways and 0.5 up and down. These bounds
// add the drop's own size and the play of a body inside its cell.
const REACH_XZ = 1.5
const REACH_BELOW = 0.75
const REACH_ABOVE = 2.3

// A drop can sit a little below its floor's top.
const dropCell = (p) => new Vec3(Math.floor(p.x), Math.floor(p.y + 0.5), Math.floor(p.z))

// True, false, or null when a cell it reads is unknown or unloaded.
function bodyFits (blockAt, known, c) {
  // A three-cell column makes standCell judge the feet cell c alone.
  const r = standCell(blockAt, c.x, c.z, c.y, { minY: c.y - 1, maxY: c.y + 2 }, known)
  if (r === UNLOADED || r === UNKNOWN) return null
  return !!r
}

// The drop's cell when no known cell a body fits in reaches it, else null.
function enclosedDrop (pos, { blockAt, known }) {
  const span = (a, b) => {
    const out = []
    for (let c = Math.ceil(a); c <= Math.floor(b); c++) out.push(c)
    return out
  }
  // Feet cells whose centre lies within reach.
  const xs = span(pos.x - REACH_XZ - 0.5, pos.x + REACH_XZ - 0.5)
  const zs = span(pos.z - REACH_XZ - 0.5, pos.z + REACH_XZ - 0.5)
  const ys = span(pos.y - REACH_ABOVE, pos.y + REACH_BELOW)
  for (const x of xs) {
    for (const z of zs) {
      for (const y of ys) {
        if (bodyFits(blockAt, known, new Vec3(x, y, z)) !== false) return null
      }
    }
  }
  return dropCell(pos)
}

module.exports = { enclosedDrop }
