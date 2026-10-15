'use strict'
const { Vec3 } = require('vec3')
const { standCell, UNLOADED, UNKNOWN } = require('./walk')

// The step heights it reads, from the feet up and down.
const UP = 2
const DOWN = 3

const liquid = (b) => /water|lava/.test(b.name)

// A north-up grid of the step to each stand cell around feet within radius, west to east in a row.
// A cell shows +1, 0 or -2, # for a wall over UP, v for a drop past DOWN, ~ for liquid, ? for cells
// known() rejects, @ for the body.
function stepView (blockAt, known, feet, radius = 2) {
  const fx = Math.floor(feet.x)
  const fz = Math.floor(feet.z)
  const fy = Math.round(feet.y)
  const column = { minY: fy - DOWN - 1, maxY: fy + UP + 2 }
  const rows = []
  for (let dz = -radius; dz <= radius; dz++) {
    const row = []
    for (let dx = -radius; dx <= radius; dx++) {
      if (!dx && !dz) {
        row.push('@')
        continue
      }
      const cell = standCell(blockAt, fx + dx, fz + dz, fy, column, known)
      if (cell === UNLOADED || cell === UNKNOWN) row.push('?')
      else if (cell) row.push(liquid(blockAt(cell)) ? '~' : cell.y > fy ? `+${cell.y - fy}` : String(cell.y - fy))
      else {
        const p = new Vec3(fx + dx, fy, fz + dz)
        const b = blockAt(p)
        row.push(!known(p) ? '?' : liquid(b) ? '~' : b.boundingBox === 'empty' ? 'v' : '#')
      }
    }
    rows.push(row.map((c) => c.padStart(3)).join(''))
  }
  return rows.join('\n')
}

module.exports = { stepView }
