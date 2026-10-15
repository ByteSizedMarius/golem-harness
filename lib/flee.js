'use strict'

// The unit {x, z} heading away from threat and the other mobs, each pushing harder the nearer it
// stands. Straight away from threat when the pushes cancel out.
function fleeHeading (here, threat, mobs) {
  let x = 0
  let z = 0
  for (const m of [threat, ...mobs]) {
    const dx = here.x - m.x
    const dz = here.z - m.z
    const d2 = dx * dx + dz * dz
    if (d2 < 1e-6) continue
    x += dx / d2
    z += dz / d2
  }
  const len = Math.hypot(x, z)
  if (len > 1e-6) return { x: x / len, z: z / len }
  const ax = here.x - threat.x
  const az = here.z - threat.z
  const alen = Math.hypot(ax, az)
  return alen > 1e-6 ? { x: ax / alen, z: az / alen } : { x: 1, z: 0 }
}

// world.kind(x, y, z) is 'solid', 'open', 'hazard' (lava or fire) or 'unknown'. world.hazard(x, y, z)
// is true for a known lava or fire cell.
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const key = (x, y, z) => x + ',' + y + ',' + z
const open = (world, x, y, z) => world.kind(x, y, z) === 'open'

function standing (world, x, y, z) {
  return open(world, x, y, z) && open(world, x, y + 1, z) && world.kind(x, y - 1, z) === 'solid'
}

function groundCell (world, p) {
  for (let d = 0; d <= 3; d++) if (standing(world, p.x, p.y - d, p.z)) return { x: p.x, y: p.y - d, z: p.z }
  return { x: p.x, y: p.y, z: p.z }
}

// A step from feet cell (x, y, z) into column (nx, nz): { y, drop } where the body lands, 'wall',
// 'deep' for a floor more than maxDrop down, or 'unsafe' for an unknown or burning cell in the way.
function step (world, x, y, z, nx, nz, maxDrop) {
  const feet = world.kind(nx, y, nz)
  if (feet === 'solid') return standing(world, nx, y + 1, nz) && open(world, x, y + 2, z) ? { y: y + 1, drop: 0 } : 'wall'
  if (feet !== 'open') return 'unsafe'
  const head = world.kind(nx, y + 1, nz)
  if (head === 'solid') return 'wall'
  if (head !== 'open') return 'unsafe'
  for (let d = 0; d <= maxDrop; d++) {
    const k = world.kind(nx, y - 1 - d, nz)
    if (k === 'solid') return { y: y - d, drop: d }
    if (k !== 'open') return 'unsafe'
  }
  return 'deep'
}

// A cell with a drop deeper than 3, or an unknown or burning cell, beside it.
function edgeCell (world, c) {
  return SIDES.some(([dx, dz]) => {
    const s = step(world, c.x, c.y, c.z, c.x + dx, c.z + dz, 3)
    return s === 'deep' || s === 'unsafe'
  })
}

function hazardNear (world, c) {
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) {
    if (world.hazard(c.x + dx, c.y + dy, c.z + dz)) return true
  }
  return false
}

// Breadth-first walk over standing cells from start, a step down at most maxDrop. enter(c) names
// why c stays out, or null. Stops at the first cell goal(c) accepts.
function walkFlood (world, start, { maxSteps, maxDrop, cap = 6000, enter = null, goal = null }) {
  const first = { ...start, steps: 0 }
  const cells = new Map([[key(start.x, start.y, start.z), first]])
  const refused = new Map()
  const queue = [first]
  for (let qi = 0; qi < queue.length && cells.size < cap; qi++) {
    const c = queue[qi]
    if (goal && goal(c)) return { cells, refused, reached: c }
    if (c.steps >= maxSteps) continue
    for (const [dx, dz] of SIDES) {
      const s = step(world, c.x, c.y, c.z, c.x + dx, c.z + dz, maxDrop)
      if (typeof s !== 'object') continue
      const n = { x: c.x + dx, y: s.y, z: c.z + dz, steps: c.steps + 1 }
      const k = key(n.x, n.y, n.z)
      if (cells.has(k) || refused.has(k)) continue
      const why = enter && enter(n)
      if (why) { refused.set(k, why); continue }
      cells.set(k, n)
      queue.push(n)
    }
  }
  return { cells, refused, reached: null }
}

const centre = (c) => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 })
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

// The cell a flee from threat runs to over known cells, goal null when none is safe.
function planFlee ({ world, here, threat, mobs = [], ally = null, minDist = 8, maxDist = 16, maxSteps = 32 }) {
  const all = [threat, ...mobs]
  const nearest = (p) => Math.min(...all.map((m) => dist(p, m)))
  const start = groundCell(world, { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) })
  const keep = all.map((m) => Math.min(3, dist(here, m)))
  const enter = (c) => {
    if (hazardNear(world, c)) return 'lava'
    return all.some((m, i) => dist(centre(c), m) < keep[i]) ? 'mob' : null
  }
  const { cells, refused } = walkFlood(world, start, { maxSteps, maxDrop: 3, enter })
  const rejected = { edge: 0, lava: 0, mob: 0 }
  for (const why of refused.values()) rejected[why]++
  const safe = [...cells.values()].filter((c) => c.steps > 0 && !edgeCell(world, c))
  rejected.edge = cells.size - 1 - safe.length
  const out = (best, more) => ({ goal: best ? { x: best.x, y: best.y, z: best.z } : null, steps: best ? best.steps : 0, rejected, ...more })
  if (ally) {
    const near = safe.filter((c) => dist(centre(c), ally) <= 2)
      .sort((a, b) => dist(centre(a), ally) - dist(centre(b), ally) || a.steps - b.steps)
    if (near.length) return out(near[0], { ally: true, candidates: near.length, mobDist: nearest(centre(near[0])) })
  }
  const heading = fleeHeading(here, threat, mobs)
  const from = nearest(here)
  const scored = safe.map((c) => ({ c, p: centre(c) }))
    .filter(({ p }) => {
      const d = flat(p, here)
      return d >= minDist && d <= maxDist && (p.x - here.x) * heading.x + (p.z - here.z) * heading.z > 0 && nearest(p) > from
    })
    .map(({ c, p }) => ({ c, mobDist: nearest(p), score: nearest(p) - c.steps / 2 }))
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  return out(best && best.c, { ally: false, allyRefused: !!ally, candidates: scored.length, mobDist: best ? best.mobDist : 0, score: best ? best.score : 0 })
}

// True when a mob at from walks to within 2 of to in maxSteps or fewer, over cells world knows.
function routeWithin (world, from, to, maxSteps, maxDrop) {
  return !!walkFlood(world, groundCell(world, from), { maxSteps, maxDrop, cap: 4000, goal: (c) => dist(c, to) <= 2 }).reached
}

module.exports = { fleeHeading, planFlee, routeWithin }
