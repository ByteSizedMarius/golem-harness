'use strict'

const { Vec3 } = require('vec3')
const { GRAVESTONE } = require('../server-overrides')
const { LEGACY_1710 } = require('./config')
const { LEGACY_WATER_FILTER } = require('./legacy-1710')

let bot, SEEN, markSeen

const ck = (x, y, z) => x + ',' + y + ',' + z

// ---- fairness: only "see" a block a player here could — exposed to air AND in line of sight.
// Closes the x-ray cheat: bot.findBlocks() returns ore buried in solid stone no player could
// see. We reject buried blocks, and ray-march from the eye to confirm an unobstructed view.
function blockTransparent(b) {
  if (!b) return false
  if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return true
  return b.boundingBox === 'empty'
}
// A fence or fence gate, seen through between its posts and rails. A wall blocks sight.
function isFence (b) {
  return !!b && /_fence(_gate)?$/.test(b.name)
}
// A body walks and sees past these, though mc-data boxes ladders as solid.
function isClimbable (b) {
  return !!b && (b.name === 'ladder' || b.name === 'scaffolding' || b.name === 'vine' || b.name.includes('vines'))
}
function isExposed(p) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const n = bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz))
    if (blockTransparent(n) || isFence(n) || isClimbable(n)) return true
  }
  return false
}
// True when a neighbour of p lies in the flood's air.
function touchesFill(p, fill) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    if (fill.cells.has(ck(p.x + dx, p.y + dy, p.z + dz))) return true
  }
  return false
}
function holdsWater (b) {
  return !!b && (b.name.includes('water') || /^(kelp|kelp_plant|seagrass|tall_seagrass|bubble_column)$/.test(b.name) ||
    (b.getProperties?.() || {}).waterlogged === true)
}
// Calls visit(cell, f) for each cell the segment a to b enters past a's own, f the fraction at entry, and returns true once visit does.
function gridWalk (a, b, visit) {
  const o = [a.x, a.y, a.z]
  const d = [b.x - a.x, b.y - a.y, b.z - a.z]
  const c = o.map(Math.floor)
  // Segment fraction at the next cell boundary on each axis, and per cell along it.
  const next = d.map((v, i) => (v > 0 ? (c[i] + 1 - o[i]) / v : v < 0 ? (c[i] - o[i]) / v : Infinity))
  const span = d.map((v) => Math.abs(1 / v))
  for (;;) {
    const i = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2
    if (next[i] >= 1) return false
    c[i] += Math.sign(d[i])
    if (visit(new Vec3(c[0], c[1], c[2]), next[i])) return true
    next[i] += span[i]
  }
}
// The last cell the line from eye to point crosses short of cell at, null when the line is blocked. A sight line
// crosses fences and fence gates.
function lineCell(eye, point, at, sight = false) {
  let from = eye.floored()
  let water = 0
  const blocked = gridWalk(eye, point, (cell) => {
    if (cell.equals(at)) return false
    const b = bot.blockAt(cell)
    // Four cells of water past the eye's own hide what lies behind them.
    if (!(floodPassable(b) || (sight && isFence(b))) || (holdsWater(b) && ++water > 3)) return true
    from = cell
    return false
  })
  return blocked ? null : from
}
// The open cell the eye sees block p by (p itself, else the one before it), null when p is unseen.
function sightCell(p, maxDist, lit = () => true) {
  if (!isExposed(p)) return null
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const at = new Vec3(p.x, p.y, p.z)
  if (eye.distanceTo(at.offset(0.5, 0.5, 0.5)) > maxDist) return null
  const b = bot.blockAt(at)
  if (!b) return null
  const open = blockTransparent(b) || isClimbable(b)
  if (open && !lit(at)) return null
  const seenBy = (point) => {
    const from = lineCell(eye, point, at, true)
    return from && (open ? at : lit(from) ? from : null)
  }
  const centre = seenBy(at.offset(0.5, 0.5, 0.5))
  if (centre) return centre
  const e = [eye.x, eye.y, eye.z]
  const q = [p.x, p.y, p.z]
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) {
      const plane = q[i] + (s + 1) / 2
      if (s * (e[i] - plane) <= 0) continue
      const n = [...q]
      n[i] += s
      const nb = bot.blockAt(new Vec3(n[0], n[1], n[2]))
      if (!blockTransparent(nb) && !isFence(nb) && !isClimbable(nb)) continue
      for (const [u, v] of [[0.5, 0.5], [0.1, 0.1], [0.1, 0.9], [0.9, 0.1], [0.9, 0.9]]) {
        const point = [0, 0, 0]
        point[i] = plane
        point[(i + 1) % 3] = q[(i + 1) % 3] + u
        point[(i + 2) % 3] = q[(i + 2) % 3] + v
        const c = seenBy(new Vec3(point[0], point[1], point[2]))
        if (c) return c
      }
    }
  }
  return null
}
// Estimated light of the cells changed since their column's light arrived, by column, then by cell.
const ESTIMATED_LIGHT = new Map()
// The light the client holds or estimates for cell p.
function heldLight (p, b) {
  const column = ESTIMATED_LIGHT.get((p.x >> 4) + ',' + (p.z >> 4))
  const held = (column && column.get(ck(p.x, p.y, p.z))) || b
  if (!(held.skyLight < 15) || bot.game.dimension !== 'overworld' || !skyCrosses(b)) return held
  const top = groundTop(p.x, p.z)
  if (top === null) return held
  // A cell above a stale top that is not clear keeps its held light.
  if (p.y > top) return lightClear(b) ? { light: held.light, skyLight: 15 } : held
  let sky = 15
  for (let y = top; y >= p.y; y--) {
    const c = y === p.y ? b : bot.blockAt(new Vec3(p.x, y, p.z))
    if (!skyCrosses(c)) return held
    // A cell below the first dimmed one takes at least 1.
    sky -= sky < 15 ? Math.max(1, skyFilter(c)) : skyFilter(c)
    if (sky <= held.skyLight) return held
  }
  return { light: held.light, skyLight: sky }
}
function estimateLight (p, levels) {
  const key = (p.x >> 4) + ',' + (p.z >> 4)
  if (!ESTIMATED_LIGHT.has(key)) ESTIMATED_LIGHT.set(key, new Map())
  const held = heldLight(p, bot.blockAt(p))
  ESTIMATED_LIGHT.get(key).set(ck(p.x, p.y, p.z), { light: held.light, skyLight: held.skyLight, ...levels })
}
// Block light b gives off, litOnly for a block whose data gives it light only while lit.
function emission (b, litOnly) {
  // The 1.7.10 gravestone shows as an end_rod and gives no light.
  if (b.name === GRAVESTONE) return 0
  const lit = b.getProperties().lit
  if (lit === false) return 0
  return bot.registry.blocks[b.type].emitLight || (lit === true ? litOnly : 0)
}
// A cell light crosses undimmed on 1.21 and on 1.7.10. Fences, gates and walls do, though 1.21 data marks them opaque.
function lightClear (b) {
  return !!b && (b.boundingBox === 'empty' || b.transparent === true || /_fence(_gate)?$|_wall$/.test(b.name)) &&
    bot.registry.blocks[b.type].filterLight === 0
}
// A cell sky light crosses, dimmed by its filter: a clear one, or one with no collision box such as water.
function skyCrosses (b) {
  return lightClear(b) || (!!b && b.boundingBox === 'empty')
}
// The sky light a cell sky light crosses takes away.
function skyFilter (b) {
  return LEGACY_1710 && b.name === 'water' ? LEGACY_WATER_FILTER : bot.registry.blocks[b.type].filterLight
}
// Every cell above p up to the dimension's build ceiling is loaded and clear.
function openSky (p) {
  for (let y = p.y + 1; y <= bot.game.minY + bot.game.height - 1; y++) if (!lightClear(bot.blockAt(new Vec3(p.x, y, p.z)))) return false
  return true
}
// On 1.7.10 a cell that is already this bright passes light on only when it is a seed.
function lightAround (seeds) {
  const reached = new Map()
  const levels = Array.from({ length: 16 }, () => [])
  const below = (q, l) => !(reached.get(ck(q.x, q.y, q.z)) >= l)
  const reach = (q, l, seed) => { reached.set(ck(q.x, q.y, q.z), l); levels[l].push([q, seed]) }
  for (const [p, level] of seeds) if (level > 0 && below(p, level)) reach(p, level, true)
  for (let l = 15; l > 0; l--) {
    for (const [q, seed] of levels[l]) {
      if (reached.get(ck(q.x, q.y, q.z)) !== l) continue
      const raised = l > heldLight(q, bot.blockAt(q)).light
      if (raised) estimateLight(q, { light: l })
      if (l === 1 || (LEGACY_1710 && !raised && !seed)) continue
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = new Vec3(q.x + dx, q.y + dy, q.z + dz)
        if (below(n, l - 1) && lightClear(bot.blockAt(n))) reach(n, l - 1, false)
      }
    }
  }
}
// Darkens the clear cells the light at p could have lit, then spreads the light at their edge back in.
function unlight (p, level) {
  estimateLight(p, { light: 0 })
  const queue = [[p, level]]
  const edge = new Map()
  for (let i = 0; i < queue.length; i++) {
    const [q, l] = queue[i]
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = new Vec3(q.x + dx, q.y + dy, q.z + dz)
      const b = bot.blockAt(n)
      if (!b) continue
      const h = heldLight(n, b).light
      if (h === 0) continue
      const k = ck(n.x, n.y, n.z)
      if (h >= l) edge.set(k, [n, h])
      else if (lightClear(b)) {
        estimateLight(n, { light: 0 })
        edge.delete(k)
        queue.push([n, h])
      }
    }
  }
  lightAround([...edge.values()])
}
// Darkens every cell whose block light could come from a source of level at p.
function dimAround (p, level) {
  const r = level - 1
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
    if (d > r) continue
    const q = new Vec3(p.x + dx, p.y + dy, p.z + dz)
    const b = bot.blockAt(q)
    if (!b) continue
    const held = heldLight(q, b)
    if (held.light > 0 && held.light <= level - d) estimateLight(q, { light: 0 })
  }
}
// Fire and flowing liquid, which change too often to relight.
function flickers (b) {
  if (b.name === 'fire' || b.name === 'soul_fire') return true
  return (b.name === 'lava' || b.name === 'water') && Number(b.getProperties().level) > 0
}
// A roof at p drops sky 15 to 14 at p and below, less the filters down to each cell under open overworld sky.
function roofOver (p) {
  let sky = bot.game.dimension === 'overworld' && openSky(p) ? 14 : null
  for (let q = p; ; q = new Vec3(q.x, q.y - 1, q.z)) {
    const b = bot.blockAt(q)
    if (!b) return
    if (sky !== null && q !== p) {
      if (!skyCrosses(b)) return
      sky -= skyFilter(b)
      estimateLight(q, { skyLight: Math.max(0, sky) })
      if (sky <= 0) return
    } else if (heldLight(q, b).skyLight === 15) estimateLight(q, { skyLight: 14 })
    else if (q !== p) return
  }
}
// With the roof at p gone under open sky, the clear cells below it that held sky 15 in their chunk get it back.
function unroof (p) {
  for (let q = new Vec3(p.x, p.y - 1, p.z); ; q = new Vec3(q.x, q.y - 1, q.z)) {
    const b = bot.blockAt(q)
    if (!lightClear(b) || b.skyLight !== 15) return
    estimateLight(q, { skyLight: 15 })
  }
}
function lightChanged (oldB, newB) {
  if (!oldB || !newB || oldB.stateId === newB.stateId) return
  const p = newB.position
  let opened = 0
  if (!blockTransparent(oldB) && blockTransparent(newB)) {
    let light = 0, skyLight = 0
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const q = new Vec3(p.x + dx, p.y + dy, p.z + dz)
      const n = bot.blockAt(q)
      if (!n) continue
      const held = heldLight(q, n)
      light = Math.max(light, held.light - 1)
      skyLight = Math.max(skyLight, held.skyLight - 1)
    }
    const open = openSky(p)
    estimateLight(p, { light, skyLight: open ? 15 : skyLight })
    if (open) unroof(p)
    opened = light
  }
  if (flickers(oldB) || flickers(newB)) return
  const shut = lightClear(oldB) && !lightClear(newB)
  const was = emission(oldB, 15)
  const now = emission(newB, 0)
  // A 1.7.10 server sends no light update after a single block change.
  if (LEGACY_1710) {
    lightAround([[p, opened]])
    if (was > now || shut) unlight(p, Math.max(was, heldLight(p, oldB).light))
  }
  if (shut) roofOver(p)
  if (!LEGACY_1710 && was > now) dimAround(p, was)
  if (now > 0) lightAround([[p, now]])
}
function wireLightChanges () {
  bot.on('blockUpdate', lightChanged)
}
function freshLight(cx, cz) {
  ESTIMATED_LIGHT.delete(cx + ',' + cz)
}
function wireLightReload () {
  bot.on('chunkColumnLoad', (p) => freshLight(p.x >> 4, p.z >> 4))
}
function wireLightPackets () {
  bot._client.on('update_light', (packet) => freshLight(packet.chunkX, packet.chunkZ))
}
// Sky light lost to the time of day, from 0 by day to 11 at midnight.
function skyDarken () {
  const t = bot.time.timeOfDay
  if (t === null) return 0
  const f = (t / 24000 + 0.75) % 1
  const angle = f + ((1 - Math.cos(f * Math.PI)) / 2 - f) / 3
  return Math.floor((1 - Math.min(1, Math.max(0, 0.5 + 2 * Math.cos(angle * Math.PI * 2)))) * 11)
}
// How many blocks away a thing in open cell p shows by the light there, Infinity when that light is missing.
function lightRange (p, b = bot.blockAt(p)) {
  if (!b) return Infinity
  const held = heldLight(p, b)
  const level = Math.max(held.light, held.skyLight - skyDarken())
  return level >= 7 ? Infinity : [2, 4, 6, 8, 12, 16, 24][Math.max(0, level)]
}
// Distance from the eye to the nearest point of the column h cells tall from cell p.
function eyeDist (p, h = 1) {
  const e = bot.entity.position.offset(0, 1.62, 0)
  const gap = (v, lo, size) => Math.max(lo - v, 0, v - lo - size)
  return Math.hypot(gap(e.x, p.x, 1), gap(e.y, p.y, h), gap(e.z, p.z, 1))
}
// Block p, any {x, y, z}, in line of sight, within the reach of the light on its open face.
function seesLit(p, maxDist) {
  if (!p.floored) p = new Vec3(p.x, p.y, p.z)
  const dist = eyeDist(p)
  if (dist > lightReach(p)) return false
  return sightCell(p, maxDist, (c) => dist <= lightRange(c)) !== null
}
// Block p, any {x, y, z}, in line of sight lit or not, which shows its shape only.
function seesShape (p, maxDist) {
  if (!p.floored) p = new Vec3(p.x, p.y, p.z)
  return sightCell(p, maxDist) !== null
}
// The largest lightRange among the cells sightCell can judge block p by: p when it is open, else its neighbours.
function lightReach (p) {
  const b = bot.blockAt(p)
  if (!b) return 0
  if (blockTransparent(b) || isClimbable(b)) return lightRange(p, b)
  let reach = 0
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    reach = Math.max(reach, lightRange(new Vec3(p.x + dx, p.y + dy, p.z + dz)))
  }
  return reach
}
// findBlocks candidates (nearest-first) -> keep only what a player here could actually see
function findVisible(ids, maxDist, count) {
  const here = bot.entity.position
  const cands = bot.findBlocks({ matching: ids, maxDistance: maxDist, count: 256 })
  const out = []
  for (const p of cands) {
    if (seesLit(p, maxDist)) { out.push({ pos: p, dist: here.distanceTo(p) }); if (out.length >= count) break }
  }
  return out
}
function nearestVisible(ids, maxDist) {
  const v = findVisible(ids, maxDist, 1)
  return v.length ? bot.blockAt(v[0].pos) : null
}
// cellKnown's seesLit verdicts by ck key, all dropped every SIGHT_MS.
const SIGHT_MEMO = { t: 0, cells: new Map() }
// A verdict outlives the view it came from by at most this.
const SIGHT_MS = 500
// A cell the bot saw lit earlier or sees lit now.
function cellKnown (p) {
  const k = ck(p.x, p.y, p.z)
  if (SEEN.has(k)) return true
  const now = Date.now()
  if (now - SIGHT_MEMO.t > SIGHT_MS) { SIGHT_MEMO.cells.clear(); SIGHT_MEMO.t = now }
  let sees = SIGHT_MEMO.cells.get(k)
  if (sees === undefined) SIGHT_MEMO.cells.set(k, sees = seesLit(p, 64))
  return sees
}
// A changed block drops the verdicts of its cell and the six beside it.
function wireSightMemoDrops () {
  bot.on('blockUpdate', (oldB, newB) => {
    const p = (newB || oldB)?.position
    if (!p) return
    SIGHT_MEMO.cells.delete(ck(p.x, p.y, p.z))
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) SIGHT_MEMO.cells.delete(ck(p.x + dx, p.y + dy, p.z + dz))
  })
  // A loaded column brings blocks no verdict saw.
  bot.on('chunkColumnLoad', () => SIGHT_MEMO.cells.clear())
}
// How many columns out groundAbove looks on each side.
const GROUND_SPAN = 8
// A sky-lit cell with ground more than this above it on two opposite sides is no surface.
const SURFACE_DEPTH = 15
// Ground top by column 'x,z': the y of its highest block that is not clear.
const GROUND_TOP = new Map()
// The ground top of column x, z, null while the column is unloaded.
function groundTop (x, z) {
  const k = x + ',' + z
  let top = GROUND_TOP.get(k)
  if (top !== undefined) return top
  for (top = bot.game.minY + bot.game.height - 1; top >= bot.game.minY; top--) {
    const b = bot.blockAt(new Vec3(x, top, z))
    if (!b) return null
    if (!lightClear(b)) break
  }
  GROUND_TOP.set(k, top)
  return top
}
// True when a ground top within GROUND_SPAN along dx, dz lies above y, else null if a column there is unloaded.
function groundAbove (x, z, dx, dz, y) {
  let above = false
  for (let i = 1; i <= GROUND_SPAN; i++) {
    const top = groundTop(x + i * dx, z + i * dz)
    if (top === null) above = null
    else if (top > y) return true
  }
  return above
}
function forgetGround (x0, z0, x1, z1) {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) GROUND_TOP.delete(x + ',' + z)
}
// Only a change at or above a column's ground top can move it.
function wireGroundTopForget () {
  bot.on('blockUpdate', (oldB, newB) => {
    const p = (newB || oldB)?.position
    if (p && p.y >= GROUND_TOP.get(p.x + ',' + p.z)) forgetGround(p.x, p.z, p.x, p.z)
  })
  bot.on('chunkColumnLoad', (p) => forgetGround(p.x, p.z, p.x + 15, p.z + 15))
  bot.on('chunkColumnUnload', (p) => forgetGround(p.x, p.z, p.x + 15, p.z + 15))
}
// Surface: sky 15 in p or the cell above, and no SURFACE_DEPTH cover on two opposite sides.
function onSurface (p, b) {
  if (heldLight(p, b).skyLight !== 15) {
    const up = new Vec3(p.x, p.y + 1, p.z)
    const a = bot.blockAt(up)
    if (!a || heldLight(up, a).skyLight !== 15) return false
  }
  const y = p.y + SURFACE_DEPTH
  for (const [dx, dz] of [[1, 0], [0, 1]]) {
    if (groundAbove(p.x, p.z, dx, dz, y) !== false && groundAbove(p.x, p.z, -dx, -dz, y) !== false) return false
  }
  return true
}
// p may be any {x, y, z}, not only a Vec3.
function knownCell (p) {
  if (!p.floored) p = new Vec3(p.x, p.y, p.z)
  const b = bot.blockAt(p)
  return !!b && (onSurface(p, b) || cellKnown(p))
}
// The refusal for a target cell the bot does not perceive.
function outOfSight () {
  return new Error('not in my sight, blocked or unlit: walk closer, clear the view or light it')
}
// A cell the body fills, or one in lit sight now.
function perceived (p) {
  const o = bot.entity.position.floored()
  if (p.x === o.x && p.z === o.z && (p.y === o.y || p.y === o.y + 1)) return true
  return seesLit(p, 8)
}
// A cell the body fills or touches: feet, head, the cells above and below them and the four beside each.
function bodyTouches (p) {
  const o = bot.entity.position.floored()
  const side = Math.abs(p.x - o.x) + Math.abs(p.z - o.z)
  const dy = p.y - o.y
  return side === 0 ? dy >= -1 && dy <= 2 : side === 1 && (dy === 0 || dy === 1)
}
// A cell whose current block the bot perceives: touched by the body or in lit sight within r.
function seenNow (p, r = 64) {
  return bodyTouches(p) || seesLit(p, r)
}

// ---- air flood-fill: the volume of air my body is CONNECTED to (BFS from my feet, 6-way).
// The fill travels only through open cells my pocket already connects to. Lava stops it.
// A perception fill crosses at most 3 water cells on the way to a cell, a body fill swims any number.
// Bounded by a Chebyshev radius around the seed and a hard cell cap, so cost stays ~milliseconds.
// An open door, gate or trapdoor passes. With body, so does a closed door or gate the walker opens.
function floodPassable(b, body = false) {
  if (!b) return false                                        // unloaded/unknown = wall, stay honest
  if (b.name.includes('lava')) return false
  if (b.name.includes('door') || b.name.includes('gate')) {
    return !!b.getProperties?.().open || (body && !b.name.includes('iron') && !b.name.includes('trapdoor'))
  }
  if (isClimbable(b)) return true
  return blockTransparent(b)
}
function airFlood({ seed = null, radius = 24, cap = 15000, targets = null, known = null, knownOnly = false, keepWalls = false, body = false } = {}) {
  const o = (seed || bot.entity.position).floored()
  let s = o
  if (!floodPassable(bot.blockAt(s), body)) s = o.offset(0, 1, 0)   // feet cell solid (slab etc.) -> try head
  const cells = new Set()
  const liquid = new Set()
  const queue = [[s.x, s.y, s.z, 0]]
  cells.add(ck(s.x, s.y, s.z))
  // The water cells on the driest path found to each cell. A drier path found later floods on again.
  const wet = new Map([[ck(s.x, s.y, s.z), 0]])
  let capped = false, reached = null, qi = 0, unknown = false, cut = false
  // The cells that stopped the flood.
  const walls = known || keepWalls ? new Map() : null
  while (qi < queue.length) {
    const [x, y, z, w] = queue[qi++]
    if (w > wet.get(ck(x, y, z))) continue
    if (targets && targets.has(ck(x, y, z))) { reached = new Vec3(x, y, z); break }
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz
      const k = ck(nx, ny, nz)
      const was = wet.get(k)
      if (was <= w) continue
      const p = new Vec3(nx, ny, nz)
      const b = bot.blockAt(p)
      if (!floodPassable(b, body) || (knownOnly && !known(p))) {
        if (walls) walls.set(k, p)
        continue
      }
      if (Math.max(Math.abs(nx - o.x), Math.abs(ny - o.y), Math.abs(nz - o.z)) > radius) { cut = true; continue }
      const water = holdsWater(b)
      const nw = water && !body ? w + 1 : w
      if (nw > 3 || was <= nw) continue
      wet.set(k, nw)
      if (was === undefined) {
        cells.add(k)
        if (water) liquid.add(k)
        if (cells.size >= cap) { capped = true; break }
      }
      queue.push([nx, ny, nz, nw])
    }
    if (capped) break
  }
  // Only the walls of a fill that stayed closed need to be known.
  if (known && !reached && !capped && !cut) {
    for (const p of walls.values()) if (!known(p)) { unknown = true; break }
  }
  return { cells, liquid, capped, cut, reached, seed: s, unknown, ...(keepWalls && { walls }) }
}

// A loaded cell the bot perceives now: on the surface or in lit sight.
function showsNow (p) {
  const b = bot.blockAt(p)
  return !!b && (onSurface(p, b) || seesLit(p, 64))
}
const SKY_IN_SIGHT = new Map()
// When the bot last had sky in sight, and the latest time it knew.
const SKY_SEEN = { at: null, timeOfDay: null, age: null, cycle: null }
function wireSkyInSightRefresh () {
  let ticks = 0
  bot.on('physicsTick', () => {
    SKY_IN_SIGHT.clear()
    // Keeps SKY_SEEN current while no reply or reflex asks for the sky.
    if (++ticks % 40 === 0) skyInSight()
  })
  // A night slept through skips the time of day without the age, in the first time update after the wake.
  bot.on('wake', () => bot.once('time', knowTime))
}
function knowTime () {
  Object.assign(SKY_SEEN, { timeOfDay: bot.time.timeOfDay, age: bot.time.age, cycle: bot.time.doDaylightCycle })
}
function skyInSight () {
  const head = bot.entity.position.floored().offset(0, 1, 0)
  const key = ck(head.x, head.y, head.z)
  if (!SKY_IN_SIGHT.has(key)) SKY_IN_SIGHT.set(key, skyFrom(head))
  const sky = SKY_IN_SIGHT.get(key)
  // The time of day is null until the server sends it.
  if (sky && typeof bot.time.timeOfDay === 'number') {
    SKY_SEEN.at = Date.now()
    knowTime()
  }
  return sky
}
// The sky in sight, or a clock in hand in the overworld. A clock spins at random in other dimensions.
function timeShows () {
  if (skyInSight()) return true
  const clock = bot.game.dimension === 'overworld' && [bot.heldItem, bot.inventory.slots[45]].some((i) => i && i.name === 'clock')
  if (clock && typeof bot.time.timeOfDay === 'number') knowTime()
  return clock
}
// Sky light 15 at the head cell, or in an open cell within 4 of it in sight.
function skyFrom (head) {
  const hb = bot.blockAt(head)
  if (hb && heldLight(head, hb).skyLight === 15) return true
  for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) {
    const p = head.offset(dx, dy, dz)
    const b = bot.blockAt(p)
    if (b && blockTransparent(b) && heldLight(p, b).skyLight === 15 && sightCell(p, 8) !== null) return true
  }
  return false
}
// forward vector from mineflayer yaw/pitch — same convention /scene's "ahead" probe uses
function lookVec(yaw, pitch) {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
}
// First surface {pos,name,dist,liquid} along dir, null for lit open air, DARK_RAY when it lies past its light.
const DARK_RAY = { dark: true }
function castRay(dir, maxDist) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  // A struck surface shows by the light of the open cell the ray left.
  let range = lightRange(eye.floored())
  let lit = true
  let hit = null
  gridWalk(eye, eye.plus(dir.scaled(maxDist)), (c, f) => {
    const t = f * maxDist
    const b = bot.blockAt(c)
    if (!b) return true
    const liquid = b.name.includes('water') || b.name.includes('lava')
    if (liquid || !floodPassable(b)) {
      if (t > range) lit = false
      else {
        markSeen(c.x, c.y, c.z, b)
        hit = { pos: c, name: b.name, dist: +t.toFixed(1), liquid }
      }
      return true
    }
    range = lightRange(c, b)
    lit = t <= range
    if (lit) markSeen(c.x, c.y, c.z, b)                          // traversed open air — seen empty
    return false
  })
  return hit || (lit ? null : DARK_RAY)
}
// sweep a field of view around (yaw,pitch): hSteps x vSteps rays. Each hit carries u (-1 left ..
// +1 right) and v (-1 low .. +1 high) so callers can talk about screen regions in words.
function raySweep({ yaw = null, pitch = null, hFov = 1.75, vFov = 1.05, hSteps = 15, vSteps = 7, maxDist = 24 } = {}) {
  const cy = yaw == null ? bot.entity.yaw : yaw
  const cp = pitch == null ? bot.entity.pitch : pitch
  const hits = [], misses = [], unlit = []
  for (let i = 0; i < hSteps; i++) {
    const u = hSteps === 1 ? 0 : (i / (hSteps - 1)) * 2 - 1
    for (let j = 0; j < vSteps; j++) {
      const v = vSteps === 1 ? 0 : (j / (vSteps - 1)) * 2 - 1
      // screen-left = +yaw offset in this convention (yaw grows counterclockwise looking down)
      const ry = cy - u * (hFov / 2)
      const rp = Math.max(-1.55, Math.min(1.55, cp + v * (vFov / 2)))
      const hit = castRay(lookVec(ry, rp), maxDist)
      if (!hit) misses.push({ u, v })
      else if (hit === DARK_RAY) unlit.push({ u, v })
      else hits.push({ ...hit, u, v })
    }
  }
  return { hits, misses, unlit, rays: hSteps * vSteps, yaw: cy, pitch: cp, maxDist }
}

// The segment a to b meets shape s, [x0, y0, z0, x1, y1, z1] within cell c.
function segmentMeets (a, b, c, s) {
  let lo = 0
  let hi = 1
  for (const [i, k] of ['x', 'y', 'z'].entries()) {
    const min = c[k] + s[i] - a[k]
    const max = c[k] + s[i + 3] - a[k]
    const d = b[k] - a[k]
    if (d === 0) {
      if (min > 0 || max < 0) return false
      continue
    }
    lo = Math.max(lo, Math.min(min / d, max / d))
    hi = Math.min(hi, Math.max(min / d, max / d))
  }
  return lo <= hi
}
// A clear eye-ray between the end cells, glass and leaves counting as walls.
function losClear(from, to, liquids = false) {
  try {
    if (to.distanceTo(from) > 160) return false   // past honest server tracking — nothing to see
    const end = to.floored()
    let water = 0
    // These render as full cubes and collide lower or not at all.
    const fullToTheEye = /^(soul_sand|mud|honey_block|powder_snow)$/
    return !gridWalk(from, to, (c) => {
      if (c.equals(end)) return false
      const b = bot.blockAt(c)
      if (!b) return true                     // unloaded chunk in the way — can't claim sight
      if (fullToTheEye.test(b.name)) return true
      // Snow renders a layer above its collision box.
      const shapes = b.name === 'snow' ? [[0, 0, 0, 1, Number(b.getProperties().layers) / 8, 1]] : b.boundingBox === 'block' ? b.shapes : []
      // A ray over a slab or a carpet passes above its shape.
      // Only fences, walls and gates collide up to 1.5 and show only 1 high.
      if (!shapes || shapes.some((s) => segmentMeets(from, to, c, [s[0], s[1], s[2], s[3], /_(fence|fence_gate|wall)$/.test(b.name) ? Math.min(s[4], 1) : s[4], s[5]]))) return true
      if (!liquids) return false
      return b.name.includes('lava') || (holdsWater(b) && ++water > 3)
    })
  } catch (e) { return false }
}
// fill is a flood over knownCell cells. A dropped item shows only in a clear line, never through fill.
function entityPerceptible(en, fill) {
  try {
    // An invisible player shows neither body nor nametag.
    if (en.type === 'player' && isInvisible(en)) return false
    const item = en.name === 'item'
    // A drop rests up to 0.3 below the floor surface.
    const top = en.position.offset(0, item ? 0.5 : 0, 0)
    const p = top.floored()
    // A partial block such as soul sand holds no light in the feet cell.
    if (eyeDist(p, 2) > Math.max(lightRange(p), lightRange(p.offset(0, 1, 0)))) return false
    if (!item && (touchesFill(p, fill) || fill.cells.has(ck(p.x, p.y, p.z)) || fill.cells.has(ck(p.x, p.y + 1, p.z)))) return true
    // last resort: the eye-ray — sight across caverns/chasms the flood can't afford to fill
    return losClear(bot.entity.position.offset(0, 1.62, 0), item ? top : en.position.offset(0, 1.0, 0), true)
  } catch (e) { return false }
}
// The shared entity flag 0x20 an invisibility potion sets.
function isInvisible (en) {
  return !!(((en.metadata && en.metadata[0]) || 0) & 0x20)
}
// A player's nametag shows through walls within 64 blocks while they neither sneak nor are invisible.
function nametagVisible (en) {
  return !en.crouching && !isInvisible(en) && en.position.distanceTo(bot.entity.position) <= 64
}

function createSight (ctx) {
  Object.assign(ctx, { touchesFill, holdsWater, gridWalk, lineCell, heldLight, freshLight, seesLit, seesShape, onSurface, findVisible, nearestVisible, cellKnown, knownCell, outOfSight, perceived, bodyTouches, seenNow, ck, floodPassable, airFlood, showsNow, skyInSight, SKY_SEEN, timeShows, lightRange, raySweep, losClear, entityPerceptible, nametagVisible })
}

function bindSight (ctx) {
  ({ bot, SEEN, markSeen } = ctx)
}

module.exports = { createSight, bindSight, segmentMeets, wireLightChanges, wireLightReload, wireLightPackets, wireSightMemoDrops, wireGroundTopForget, wireSkyInSightRefresh }
