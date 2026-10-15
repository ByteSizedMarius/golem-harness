'use strict'
const { Vec3 } = require('vec3')

// The columns d = 0..len from o along (dx, dz), each with the lowest (lo) and highest (hi) open
// cell between o.y - down and o.y + up, whether it holds water, and how the cell under lo
// reads: 'air' when the open cells go on below the frame, 'solid', or 'unknown'.
// open(x, y, z) and wet(x, y, z) read the cells the bot sees, blockAt the world, known(p) whether
// the bot sees a cell. A cell under lo is solid only when the bot sees it.
function sectionColumns ({ o, dx, dz, len, up, down, open, wet, known, blockAt }) {
  const cols = []
  for (let d = 0; d <= len; d++) {
    const x = o.x + dx * d
    const z = o.z + dz * d
    let lo = null
    let hi = null
    let water = false
    for (let y = o.y - down; y <= o.y + up; y++) {
      if (!open(x, y, z)) continue
      if (lo === null) lo = y
      hi = y
      if (wet(x, y, z)) water = true
    }
    let under = null
    if (lo !== null) {
      const p = new Vec3(x, lo - 1, z)
      const b = blockAt(p)
      if (open(x, lo - 1, z)) under = 'air'
      else under = b && b.boundingBox === 'block' && known(p) ? 'solid' : 'unknown'
    }
    cols.push({ d, lo, hi, water, under })
  }
  return cols
}

// The floor segments of cols, merged where neighbours read the same. Only a seen solid cell under
// the lowest open cell is a floor.
function floorPhrase (cols, feetY) {
  const segs = []
  for (const c of cols) {
    const label = c.under === 'solid' ? String(c.lo - feetY) : c.under
    const last = segs[segs.length - 1]
    if (last && last.label === label) last.to = c.d
    else segs.push({ label, from: c.d, to: c.d, r: c.lo - feetY })
  }
  return 'floor: ' + segs.map((s) => {
    const span = s.from === s.to ? `d${s.from}` : `d${s.from}–${s.to}`
    if (s.label === 'air') return `drops below the frame at ${span}`
    if (s.label === 'unknown') return `floor unknown at ${span}`
    return s.r === 0 ? `level ${span}` : `${s.r > 0 ? 'up' : 'down'} ${Math.abs(s.r)} at ${span}`
  }).join(', ')
}

module.exports = { sectionColumns, floorPhrase }
