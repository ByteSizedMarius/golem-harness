'use strict'
const { Vec3 } = require('vec3')

// Per column d = 0..len along (dx, dz), the open run joining the one before (lo, hi, water) and what lies under lo.
function sectionColumns ({ o, dx, dz, len, up, down, open, wet, known, blockAt }) {
  const away = (r) => Math.max(r.lo - o.y, o.y - r.hi, 0)
  const cols = []
  let prev = null
  for (let d = 0; d <= len; d++) {
    const x = o.x + dx * d
    const z = o.z + dz * d
    const runs = []
    for (let y = o.y - down; y <= o.y + up; y++) {
      if (!open(x, y, z)) continue
      const last = runs[runs.length - 1]
      if (last && last.hi === y - 1) last.hi = y
      else runs.push({ lo: y, hi: y })
    }
    const joins = d === 0 ? runs : runs.filter((r) => prev && r.lo <= prev.hi && r.hi >= prev.lo)
    const run = joins.reduce((best, r) => (best && away(best) <= away(r) ? best : r), null)
    let water = false
    let under = null
    if (run) {
      for (let y = run.lo; y <= run.hi; y++) if (wet(x, y, z)) water = true
      const p = new Vec3(x, run.lo - 1, z)
      const b = blockAt(p)
      if (open(x, run.lo - 1, z)) under = 'air'
      else under = b && b.boundingBox === 'block' && known(p) ? 'solid' : 'unknown'
    }
    cols.push({ d, lo: run ? run.lo : null, hi: run ? run.hi : null, water, under })
    prev = run
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
