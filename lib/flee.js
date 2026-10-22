'use strict'
const { HITBOX_1710 } = require('./bot/legacy-1710')

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

// world.kind(x, y, z) is 'solid', 'tall' (a fence, wall or closed gate), 'open', 'water' (a passable cell holding water),
// 'hazard' (lava or fire) or 'unknown'. world.hazard(x, y, z) is true for a known lava or fire cell. world.cover(x, y, z)
// is true for a known full block. With world.unseenWalkable, world.kind(x, y, z, unseen) may skip the known check for a
// block that reads unseen.
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const key = (x, y, z) => x + ',' + y + ',' + z
const kindAs = (world, x, y, z, unseen) => {
  const k = world.kind(x, y, z, unseen)
  return k === 'unknown' && world.unseenWalkable ? unseen : k
}
const open = (world, x, y, z) => kindAs(world, x, y, z, 'open') === 'open'

function standing (world, x, y, z) {
  const feet = kindAs(world, x, y, z, 'open')
  if (world.swim && feet === 'water') {
    const head = kindAs(world, x, y + 1, z, 'open')
    return head === 'open' || head === 'water'
  }
  return (feet === 'open' || feet === 'water') && open(world, x, y + 1, z) && kindAs(world, x, y - 1, z, 'solid') === 'solid'
}

// The feet cells from y0 up to y1 in column (x, z) that standing accepts.
function standingIn (world, x, z, y0, y1) {
  const ys = []
  for (let y = y0; y <= y1; y++) if (standing(world, x, y, z)) ys.push(y)
  return ys
}

function groundCell (world, p, depth = 3) {
  for (let d = 0; d <= depth; d++) if (standing(world, p.x, p.y - d, p.z)) return { x: p.x, y: p.y - d, z: p.z }
  return { x: p.x, y: p.y, z: p.z }
}

// A step from feet cell (x, y, z) into column (nx, nz): { y, drop } where the body lands, 'wall',
// 'deep' for a floor more than maxDrop down, 'pond' for water deeper than the body wades, or 'unsafe'
// for an unknown or burning cell in the way.
function step (world, x, y, z, nx, nz, maxDrop) {
  const feet = kindAs(world, nx, y, nz, 'open')
  if (feet === 'solid') return standing(world, nx, y + 1, nz) && open(world, x, y + 2, z) ? { y: y + 1, drop: 0 } : 'wall'
  if (feet === 'tall') return 'wall'
  if (feet !== 'open' && feet !== 'water') return 'unsafe'
  const head = kindAs(world, nx, y + 1, nz, 'open')
  if (head === 'solid' || head === 'tall') return 'wall'
  if (head === 'water' && !world.swim) return 'pond'
  if (head !== 'open' && head !== 'water') return 'unsafe'
  for (let d = 0; d <= maxDrop; d++) {
    const k = kindAs(world, nx, y - 1 - d, nz, 'solid')
    if (k === 'solid') return { y: y - d, drop: d }
    // The body stops sinking at the water surface.
    if (world.kind(nx, y - d, nz) === 'water') return world.swim ? { y: y - d, drop: d } : k === 'water' ? 'pond' : 'unsafe'
    if (k !== 'open' && k !== 'water') return 'unsafe'
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

// A creeper's eyes stand 0.85 of its height above its feet, 1.7 on 1.21.11.
const creeperEye = (legacy1710) => 0.85 * (legacy1710 ? HITBOX_1710.creeper[1] : 1.7)
// The head points a body standing in a cell may take, as offsets from the cell centre.
const HEAD_SPOTS = [[0, 0], [-0.3, -0.3], [-0.3, 0.3], [0.3, -0.3], [0.3, 0.3]]

// True when a cell world.cover accepts lies on the segment from a to b.
function covered (world, a, b) {
  const n = Math.ceil(dist(a, b) / 0.05)
  for (let i = 1; i < n; i++) {
    const t = i / n
    if (world.cover(Math.floor(a.x + (b.x - a.x) * t), Math.floor(a.y + (b.y - a.y) * t), Math.floor(a.z + (b.z - a.z) * t))) return true
  }
  return false
}

// The nearest cell within maxSteps, minDist or more from the creeper and hidden from its eyes by world.cover, or null.
function creeperCover ({ world, here, creeper, mobs = [], maxSteps = 4, minDist = 3, legacy1710 = false }) {
  const all = [creeper, ...mobs]
  const start = groundCell(world, { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) })
  const keep = all.map((m) => Math.min(minDist, dist(here, m)))
  const enter = (c) => (hazardNear(world, c) || all.some((m, i) => dist(centre(c), m) < keep[i]) ? 'kept out' : null)
  const { cells } = walkFlood(world, start, { maxSteps, maxDrop: 3, enter })
  const eye = { x: creeper.x, y: creeper.y + creeperEye(legacy1710), z: creeper.z }
  const hidden = (c) => HEAD_SPOTS.every(([dx, dz]) => covered(world, eye, { x: c.x + 0.5 + dx, y: c.y + 1.62, z: c.z + 0.5 + dz }))
  const best = [...cells.values()]
    .filter((c) => c.steps > 0 && dist(centre(c), creeper) >= minDist && !edgeCell(world, c) && hidden(c))
    .sort((a, b) => a.steps - b.steps || dist(centre(b), creeper) - dist(centre(a), creeper))[0]
  return best ? { goal: { x: best.x, y: best.y, z: best.z }, steps: best.steps, creeperDist: dist(centre(best), creeper) } : null
}

// True when a mob at from walks to within 2 of to in maxSteps or fewer, sinking through water.
function routeWithin (world, from, to, maxSteps, maxDrop) {
  const kind = (x, y, z) => (world.kind(x, y, z) === 'water' ? 'open' : world.kind(x, y, z))
  const mobWorld = { ...world, kind }
  return !!walkFlood(mobWorld, groundCell(mobWorld, from), { maxSteps, maxDrop, cap: 4000, goal: (c) => dist(c, to) <= 2 }).reached
}

// A walk flood grown backwards from the cells within 1 of `to`, only as far as each reaches() call needs.
// reaches(p, limit) is true when a mob with feet cell p walks into those cells in limit steps or fewer,
// and also once the cap kept out a cell within limit steps.
// touches(p) is true for a cell whose change can change an answer.
function walkersTo (world, to, { maxSteps, maxDrop, cap }) {
  const steps = new Map()
  const queue = []
  let qi = 0
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  const widen = (x, y, z) => {
    lo.x = Math.min(lo.x, x); lo.y = Math.min(lo.y, y); lo.z = Math.min(lo.z, z)
    hi.x = Math.max(hi.x, x); hi.y = Math.max(hi.y, y); hi.z = Math.max(hi.z, z)
  }
  // The fewest steps of a cell the cap kept out.
  let cut = Infinity
  const add = (x, y, z, n) => {
    const k = key(x, y, z)
    if (steps.has(k)) return
    if (steps.size >= cap) { cut = Math.min(cut, n); return }
    steps.set(k, n)
    queue.push({ x, y, z, n })
    widen(x, y, z)
  }
  // On level ground the four cells beside a column ask it for the same range.
  const columns = new Map()
  const standingAt = (x, z, y0, y1) => {
    const k = key(x, y0, z) + ',' + y1
    let ys = columns.get(k)
    if (ys === undefined) columns.set(k, ys = standingIn(world, x, z, y0, y1))
    return ys
  }
  const expand = (c) => {
    // A swimmer rises from the water cell under c and sinks from the one over it.
    if (world.swim && world.kind(c.x, c.y, c.z) === 'water') {
      for (const dy of [-1, 1]) if (world.kind(c.x, c.y + dy, c.z) === 'water') add(c.x, c.y + dy, c.z, c.n + 1)
    }
    // A drop into c from ny passes the cells of c's column from ny - 1 down to c.y + 1, open air every one.
    let top = c.y + 1
    while (top < c.y + maxDrop && kindAs(world, c.x, top, c.z, 'solid') === 'open') top++
    for (const [dx, dz] of SIDES) {
      const nx = c.x - dx
      const nz = c.z - dz
      for (const ny of standingAt(nx, nz, c.y - 1, top)) {
        const s = step(world, nx, ny, nz, c.x, c.z, maxDrop)
        if (typeof s === 'object' && s.y === c.y) add(nx, ny, nz, c.n + 1)
      }
    }
  }
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) add(to.x + dx, to.y + dy, to.z + dz, 0)
  return {
    reaches (p, limit) {
      const start = groundCell(world, p)
      widen(start.x, start.y, start.z)
      // The cells that answer yes, each with the most steps it may lie from the goal cells.
      const within = new Map([[key(start.x, start.y, start.z), limit]])
      // The flood never reaches a start cell in mid-air.
      for (const [dx, dz] of SIDES) {
        const s = step(world, start.x, start.y, start.z, start.x + dx, start.z + dz, maxDrop)
        const k = typeof s === 'object' && key(start.x + dx, s.y, start.z + dz)
        if (k && !within.has(k)) within.set(k, limit - 1)
      }
      const hit = () => [...within].some(([k, n]) => steps.has(k) && steps.get(k) <= n)
      const last = Math.min(limit, maxSteps)
      while (!hit()) {
        if (cut <= last) return true
        if (qi >= queue.length || queue[qi].n >= last) return false
        expand(queue[qi++])
      }
      return true
    },
    touches: (p) => p.x >= lo.x - 1 && p.x <= hi.x + 1 && p.z >= lo.z - 1 && p.z <= hi.z + 1 &&
      p.y >= lo.y - maxDrop - 2 && p.y <= hi.y + maxDrop + 2
  }
}

module.exports = { fleeHeading, planFlee, creeperCover, routeWithin, walkersTo, walkFlood, groundCell }
