'use strict'

const { Vec3 } = require('vec3')

let bot, knownCell, shared, seesLit, cellKnown, heldLight, ck, airFlood, skyInSight, emitEvent

// ---- helpers ----
const vecStr = (v) => v ? `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})` : null
const round = (v) => v ? { x: Math.round(v.x*10)/10, y: Math.round(v.y*10)/10, z: Math.round(v.z*10)/10 } : null

function dayPhase (t) {
  t = ((t % 24000) + 24000) % 24000
  if (t < 12000) return 'day'
  if (t < 13800) return 'sunset'
  if (t < 22200) return 'night'
  return 'sunrise'
}
const HOSTILE_NAMES = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'slime', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'zombified_piglin', 'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'warden', 'blaze', 'ghast', 'magma_cube', 'silverfish', 'endermite', 'vex', 'guardian', 'elder_guardian', 'shulker', 'zombie_villager', 'wither_skeleton', 'wither', 'breeze'])

const OPENABLE = /(_door|_fence_gate|_trapdoor)$/
const CONTAINERS = /chest|barrel|furnace|smoker|hopper|dispenser|dropper|shulker_box|brewing_stand|lectern|crafter|jukebox|decorated_pot|gravestone/

function cellText (c) {
  return `${c.x},${c.y},${c.z}`
}

// ---- SIGHT helpers: compass + minimap glyph classification ----
// turn a dx,dz delta (Minecraft: +x=east, -x=west, +z=south, -z=north) into a compass letter.
function compass(dx, dz) {
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return '-'
  const ang = Math.atan2(dx, -dz) * 180 / Math.PI          // 0 = north(-z), 90 = east(+x)
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[(Math.round(((ang % 360) + 360) % 360 / 45)) % 8]
}
// facing letter from a yaw, using mineflayer's own forward vector (x=-sin(yaw), z=-cos(yaw)).
function yawToCompass(yaw) {
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw)
  return compass(dx, dz)
}
// The step [dx, dz] that dir names, else the axis nearest the forward vector at yaw.
function cardinal(dir, yaw) {
  const named = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
  if (Object.hasOwn(named, dir)) return named[dir]
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw)
  return Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)]
}
// ---- 3D LAY-OF-THE-LAND: the honest describer (the "vision" upgrade). Reports the measured
// FACTS of the space around the bot — walls with distance, where the ground FALLS AWAY and how
// deep, ceiling, footing, nearest lava — and NOTHING that's a verdict ("safe/fatal/go-here" is
// the pilot's call, not the sense's). Every scan STOPS at the first solid or at the first cell the
// bot does not know, and an unknown cell gives no fact. Fixed vocabulary so a word never misreads:
// wall / falls away / floor ~N down / floor out of sight / ceiling / open. Fresh every call.
function spatial3D(bot) {
  try {
    const V = require('vec3').Vec3
    const o = bot.entity.position.floored()
    const solid = (b) => !!(b && b.boundingBox === 'block')
    const liquid = (b) => b && (b.name.includes('water') || b.name.includes('lava'))
    const R = 24, DOWN = 40
    const feet = o.y, head = o.y + 1
    const look = (x, y, z) => {
      const p = new V(x, y, z)
      return knownCell(p) ? bot.blockAt(p) : null
    }
    // { y } of the first solid (or under the top liquid when unknown cells follow), { unseen } of the first unknown,
    // {} none.
    const floorOf = (x, z) => {
      let wetY = null
      for (let y = feet; y > feet - DOWN; y--) {
        const b = look(x, y, z)
        if (!b) return wetY === null ? { unseen: y } : { y: wetY - 1 }
        if (solid(b)) return { y }
        if (wetY === null && liquid(b)) wetY = y
      }
      return {}
    }

    const DIRS = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] }
    const walls = [], drops = [], opens = []
    let lava = null
    for (const [name, [dx, dz]] of Object.entries(DIRS)) {
      let wall = 0, scanTo = R, unseen = false
      for (let d = 1; d <= R; d++) {
        const x = o.x + dx * d, z = o.z + dz * d
        const fb = look(x, feet, z)
        if (!fb) { scanTo = d - 1; unseen = true; break }
        if (fb.name.includes('lava') && (!lava || d < lava.dist)) lava = { dir: name, dist: d }
        if (solid(fb)) {
          const hb = look(x, head, z)
          if (!hb) { scanTo = d - 1; unseen = true; break }
          if (solid(hb)) { wall = d; scanTo = d - 1; break }
        }
      }
      // floor profile OUTWARD along this direction: find the first ledge, then keep reading the
      // floor as it opens away — a step reads flat, the mouth of a cavern reads deepening.
      // 'deep' when open air runs at least 3 down and past the deepest floor seen, into unknown cells or DOWN.
      let dropAt = 0, firstFloor = 0, deepest = 0, deep = false, wet = null
      for (let d = 1; d <= scanTo; d++) {
        const x = o.x + dx * d, z = o.z + dz * d
        const f = floorOf(x, z)
        if (f.y === undefined) {
          const seen = f.unseen === undefined ? DOWN : (feet - 1) - f.unseen
          if (seen >= 3 && seen > deepest) { if (!dropAt) dropAt = d; deep = true }
          if (f.unseen !== undefined) unseen = true
          break
        }
        const depth = (feet - 1) - f.y
        if (!dropAt && depth >= 3) { dropAt = d; firstFloor = depth; deepest = depth }
        if (dropAt) {
          if (depth > deepest) deepest = depth
          const surf = look(x, f.y + 1, z)
          if (!wet && liquid(surf)) wet = surf.name.includes('lava') ? 'lava' : 'water'
        }
      }
      if (dropAt) drops.push({ name, dropAt, firstFloor, deepest, deep, wet, opensBeyond: (deepest - firstFloor) >= 4 })
      else if (wall && wall <= 2) walls.push(`${name} ${wall}`)
      else if (!unseen) opens.push(name)
    }
    let ceil = 0, ceilSeen = true
    for (let d = 1; d <= R; d++) {
      const b = look(o.x, head + d, o.z)
      if (!b) { ceilSeen = false; break }
      if (solid(b)) { ceil = d; break }
    }

    const parts = []
    const under = look(o.x, feet - 1, o.z)
    if (liquid(under)) parts.push(`standing in ${under.name.includes('lava') ? 'LAVA' : 'water'}`)
    else if (under && !solid(under)) parts.push('no floor underfoot')
    if (walls.length) parts.push('wall ' + walls.join('/'))
    for (const dr of drops) {
      const wetStr = dr.wet ? ` (${dr.wet === 'lava' ? 'LAVA' : 'water'} below)` : ''
      let phrase = `falls away ${dr.name} at ${dr.dropAt}, `
      if (dr.deep && !dr.firstFloor) phrase += 'floor out of sight'
      else if (dr.deep) phrase += `ledge ~${dr.firstFloor} down then drops out of sight`
      else if (dr.opensBeyond) phrase += `ledge ~${dr.firstFloor} down then OPENS — floor ~${dr.deepest} down${wetStr}`
      else phrase += `floor ~${dr.firstFloor} down${wetStr}`
      parts.push(phrase)
    }
    if (lava) parts.push(`LAVA ${lava.dir} ${lava.dist}`)
    if (!ceil && ceilSeen) parts.push('open above')
    else if (ceil && ceil <= 3) parts.push(`ceiling ${ceil} up`)
    if (opens.length >= 7) parts.push('open all round')
    else if (opens.length) parts.push('open ' + opens.join('/'))
    return parts.length ? parts.join('; ') : null
  } catch (e) { return null }
}

// ---- VEIN landmarks: the nearest ore in lit sight per TYPE, with compass direction, up/down and
// distance.
const VEIN_SENSE_R = 25
function veinScan(bot) {
  try {
    const o = bot.entity.position.floored()
    const oreIds = []
    if (shared.mcData && shared.mcData.blocksArray) for (const b of shared.mcData.blocksArray) if (b.name.endsWith('_ore')) oreIds.push(b.id)
    if (!oreIds.length) return null
    const byType = {}
    for (const p of bot.findBlocks({ matching: oreIds, maxDistance: VEIN_SENSE_R, count: 512 })) {
      const b = bot.blockAt(p); if (!b) continue
      const dx = p.x - o.x, dy = p.y - o.y, dz = p.z - o.z
      const dist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz))
      const t = b.name.replace('deepslate_', '').replace('_ore', '')
      if (byType[t] && byType[t].dist <= dist) continue
      if (seesLit(p, VEIN_SENSE_R)) byType[t] = { dir: compass(dx, dz), dy, dist }
    }
    const phr = Object.entries(byType).sort((a, b) => a[1].dist - b[1].dist)
      .map(([t, v]) => `${t} ${v.dir}${v.dy >= 3 ? ' up' : v.dy <= -3 ? ' down' : ''} ~${v.dist}`)
    return phr.length ? phr.join(', ') : null
  } catch (e) { return null }
}

// ---- WATER SENSE / proprioception: am I in liquid, SUBMERGED (drowning), or in a CURRENT that's
// pushing me? Flowing water was the blind spot that nearly killed the bot — this makes the body
// state LOUD in every /scene and /state so I can never miss it again. It's "feel the push," not
// "see the block": read directly off my own body + the liquid touching it. Flow via block
// metadata (0 = still source, !=0 = flowing/current).
// A head suffocates only in an opaque full-cube block.
function suffocates (b) {
  if (!b || b.transparent || !Array.isArray(b.shapes) || b.shapes.length !== 1) return false
  return b.shapes[0].every((v, i) => v === (i < 3 ? 0 : 1))
}
function waterState(bot) {
  try {
    const p = bot.entity.position
    const feetB = bot.blockAt(p.floored())
    const headB = bot.blockAt(p.offset(0, 1.6, 0).floored())
    const isW = (b) => b && b.name.includes('water')
    const isL = (b) => b && b.name.includes('lava')
    const submerged = isW(headB)
    const inWater = isW(feetB) || submerged
    const inLava = isL(feetB) || isL(headB)
    // ENTOMBMENT (07-12, the gravel lesson): a head inside SOLID is suffocation the water sense
    // never covered — I was buried in falling gravel and could not feel it; the helmsman dug me out.
    const buried = suffocates(headB)
    let current = false
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = bot.blockAt(p.offset(dx, 0, dz).floored())
      if (b && b.name.includes('water') && b.metadata !== 0) { current = true; break }
    }
    return { inWater, submerged, inLava, current, buried, oxygen: bot.oxygenLevel }
  } catch (e) { return null }
}
// classify one block name into a single minimap glyph.
function glyphFor(name) {
  if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return ' '
  if (name.includes('water') || name === 'kelp' || name === 'seagrass') return '~'
  if (name.includes('lava')) return '~'
  if (name.endsWith('_log') || name.endsWith('_wood') || name.includes('leaves') ||
      name.endsWith('_stem') || name.includes('mushroom_block')) return 'T'
  if (name === 'stone' || name.includes('cobblestone') || name === 'andesite' ||
      name === 'diorite' || name === 'granite' || name.includes('deepslate') ||
      name === 'bedrock' || name === 'tuff' || name === 'calcite') return '#'
  if (name.endsWith('_planks') || name.endsWith('_slab') || name.endsWith('_stairs') ||
      name.endsWith('_fence') || name.endsWith('_wall') || name.endsWith('_door') ||
      name.includes('brick') || name === 'glass' || name.includes('_glass') ||
      name.includes('concrete') || name.includes('terracotta') || name === 'crafting_table' ||
      name === 'furnace' || name === 'chest' || name === 'bookshelf') return '='
  if (name === 'grass_block' || name === 'dirt' || name === 'coarse_dirt' ||
      name === 'rooted_dirt' || name === 'sand' || name === 'red_sand' ||
      name === 'gravel' || name === 'podzol' || name === 'mycelium' ||
      name === 'dirt_path' || name === 'farmland' || name === 'snow_block' ||
      name === 'snow' || name === 'clay' || name.includes('mud')) return '.'
  return ' '
}

// ---- overhead cover: am I under open sky? The top-down /map renders whatever slice I'm embedded
// in, so a stone shelf at y40 reads identical to a mountaintop — this column scan is the missing
// vertical fix. Distinguishes true sky / tree canopy / underground from the column cells the bot knows.
// The cover count and its top need the sky to show: sky light 15 at the head, or the column known to the top.
function overheadCover() {
  try {
    const o = bot.entity.position.floored()
    const from = o.y + 2                       // first cell above the head
    const top = Math.min(from + 280, 320)      // 1.21 build ceiling
    let cover = 0, firstUp = 0, topSolidY = null, knownToTop = true
    const names = new Set()
    for (let y = from; y <= top; y++) {
      const p = new Vec3(o.x, y, o.z)
      if (!cellKnown(p)) { knownToTop = false; break }
      const b = bot.blockAt(p)
      if (b && b.boundingBox === 'block') {
        cover++
        if (!firstUp) firstUp = y - o.y - 1    // blocks above the head to the first solid
        topSolidY = y
        names.add(b.name)
      }
    }
    const head = bot.blockAt(o.offset(0, 1, 0))
    const skyShows = knownToTop || (!!head && heldLight(o.offset(0, 1, 0), head).skyLight === 15)
    if (!cover) return skyShows ? { sky: true } : { sky: false, unseen: true }
    const canopy = [...names].every(n => n.includes('leaves') || n.endsWith('_log') || n.endsWith('_wood'))
    return skyShows ? { sky: false, canopy, firstUp, cover, topY: topSolidY } : { sky: false, canopy, firstUp }
  } catch (e) { return null }
}
function skyPhrase(oh) {
  if (!oh) return ''
  if (oh.sky) return 'Open sky above. '
  if (oh.unseen) return 'Overhead unseen. '
  if (oh.canopy) return `Under tree canopy (leaves ${oh.firstUp} up). `
  if (oh.topY == null) return `UNDERGROUND, rock overhead (first solid ${oh.firstUp} up, unknown past it). `
  return `UNDERGROUND — rock overhead (first solid ${oh.firstUp} up, ~${oh.cover} cover, top ~y${oh.topY}). `
}
const INDOORS = new Map()
function wireIndoorsReset () {
  bot.on('physicsTick', () => INDOORS.clear())
}
// Under a known roof, in a space of at most 8x8 and 4 high closed off by known walls and closed doors.
function indoors (oh) {
  const o = bot.entity.position.floored()
  const key = ck(o.x, o.y, o.z)
  if (!INDOORS.has(key)) INDOORS.set(key, !!oh?.firstUp && roomClosed())
  return INDOORS.get(key)
}
function roomClosed () {
  const fill = airFlood({ radius: 8, cap: 8 * 8 * 4 + 1, known: knownCell, knownOnly: true })
  if (fill.capped || fill.unknown) return false
  const cells = [...fill.cells].map((k) => k.split(',').map(Number))
  const span = (i) => Math.max(...cells.map((c) => c[i])) - Math.min(...cells.map((c) => c[i])) + 1
  return span(0) <= 8 && span(2) <= 8 && span(1) <= 4
}
function coverPhrase (oh) {
  return indoors(oh) ? `Indoors, roof ${oh.firstUp} up. ` : skyPhrase(oh)
}

// Emits nightfall at the first sight of the sky in each night and returns whether this night's event fired.
function nightfall (fired) {
  const tod = bot.time && bot.time.timeOfDay
  if (typeof tod !== 'number') return fired
  if (tod < 13000 || tod >= 23000) return false
  if (fired || !skyInSight()) return fired
  emitEvent('nightfall', 'night has fallen', { timeOfDay: tod })
  return true
}

// far-tier honesty (07-14, the range upgrade the helmsman and I agreed 07-13): past arm's-length
// vision (64 blocks) a real player sees TERRAIN, not ore seams — distant hits collapse to
// coarse classes. No ore, no container names at range; a mountain is a mountain.
function terrainClass(name) {
  if (/_ore$|^ancient_debris$/.test(name)) return 'stone'
  if (/chest|barrel|furnace|shulker|spawner/.test(name)) return 'structure'
  if (/planks|cobble|brick|glass|door|fence|stairs|slab|wall|torch|ladder/.test(name)) return 'structure'
  if (/_log$|_wood$|_leaves$|sapling|mushroom_block/.test(name)) return 'trees'
  if (/^grass_block$|^dirt$|podzol|farmland|mycelium|mud/.test(name)) return 'ground'
  if (/sand|gravel/.test(name)) return 'sand/gravel'
  if (/water/.test(name)) return 'water'
  if (/lava|magma/.test(name)) return 'lava'
  if (/snow|ice/.test(name)) return 'snow/ice'
  if (/stone|deepslate|granite|diorite|andesite|tuff|calcite|basalt|obsidian/.test(name)) return 'stone'
  return 'terrain'
}

function createDescribe (ctx) {
  Object.assign(ctx, { vecStr, round, dayPhase, HOSTILE_NAMES, OPENABLE, CONTAINERS, cellText, compass, yawToCompass, cardinal, spatial3D, veinScan, suffocates, waterState, glyphFor, overheadCover, skyPhrase, indoors, coverPhrase, nightfall, terrainClass })
}

function bindDescribe (ctx) {
  ({ bot, knownCell, shared, seesLit, cellKnown, heldLight, ck, airFlood, skyInSight, emitEvent } = ctx)
}

module.exports = { createDescribe, bindDescribe, wireIndoorsReset }
