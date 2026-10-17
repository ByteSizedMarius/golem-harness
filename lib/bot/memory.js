'use strict'

const fs = require('fs')
const { Vec3 } = require('vec3')
const { HOST, PORT } = require('./config')

let bot, ck, perceived, seenNow

// ---- MEMORY: waypoints (persisted to ./waypoints.json) + journal (journal.md) ----
// Externalizes the driver's mental map to disk so it survives across sessions.
// All disk I/O wrapped in try/catch so a bad/missing file never crashes startup.
// ---- WAYPOINT GRAPH (2026-07-12): names that remember their NEIGHBORS. Nodes carry a kind
// ('place' = durable landmark, 'resource' = PERISHABLE claim — extraction falsifies it, delete on
// mine-out, doubt by default) and a one-line note. Edges record only REAL walked traversals
// (auto-linked when a /goto to a waypoint arrives from another waypoint). No routes are cached — the
// pathfinder stays the "how", the graph is just the shape of the known world in ~a dozen lines.
const waypoints = (() => {
  const FILE = './waypoints.json'
  // Prototype-free maps: a waypoint named __proto__ or constructor is just a key.
  const dict = (from) => Object.assign(Object.create(null), from)
  let map = dict()
  try { map = dict(JSON.parse(fs.readFileSync(FILE, 'utf8'))) } catch (e) { map = dict() }
  for (const [n, w] of Object.entries(map)) {                 // normalize legacy {x,y,z} entries
    if (w && typeof w === 'object') map[n] = { x: w.x, y: w.y, z: w.z, kind: w.kind || 'place', note: w.note || '', links: dict(w.links) }
  }
  function persist() { try { fs.writeFileSync(FILE, JSON.stringify(map, null, 2)) } catch (e) {} }
  return {
    set(name, coord, extra = {}) {
      const prev = map[name] || {}
      map[name] = {
        x: coord.x, y: coord.y, z: coord.z,
        kind: extra.kind || prev.kind || 'place',
        note: extra.note !== undefined ? extra.note : (prev.note || ''),
        links: prev.links || dict()
      }
      persist(); return map[name]
    },
    get(name) { return map[name] || null },
    remove(name) {
      if (!map[name]) return false
      delete map[name]
      for (const w of Object.values(map)) if (w.links) delete w.links[name]   // no dangling edges
      persist(); return true
    },
    link(a, b) {
      if (!map[a] || !map[b] || a === b) return false
      const stamp = new Date().toISOString().slice(0, 10)
      map[a].links[b] = stamp; map[b].links[a] = stamp
      persist(); return true
    },
    list() { return dict(map) }
  }
})()
const memory = {}
memory.lastWaypoint = null   // the last waypoint I verifiably STOOD at (resets on restart — no false edges)
function journal(step, text) {
  try { fs.appendFileSync('journal.md', '- [' + step + '] ' + text + '\n') } catch (e) {}
}

const SEEN = new Set()
const SEEN_CAP = 400000
// Count of SEEN additions, for the saver.
let seenEdits = 0
// The top block last seen in each column, 'x,z' -> [block id, y].
const SURFACE = new Map()
const SURFACE_CAP = 100000
// Count of SURFACE changes, for the saver.
let surfaceEdits = 0
// The station last seen in each cell, 'x,y,z' -> block id.
const STATIONS = new Map()
const STATION_CAP = 20000
const STATION_RE = /chest|furnace|crafting_table|anvil|enchanting_table|_bed$/
// Count of STATIONS changes, for the saver.
let stationEdits = 0
// The edit total at the last save, -1 to force the next.
let seenDirty = 0
// Per capped store, an iterator that yields its oldest entry next.
const OLDEST = new WeakMap()
// Makes key the newest entry of store, evicting the oldest at cap. True for a key store lacked.
function recordNewest (store, cap, key, value) {
  const added = !store.delete(key)
  if (store.size >= cap) {
    if (!OLDEST.has(store)) OLDEST.set(store, store.keys())
    store.delete(OLDEST.get(store).next().value)
  }
  if (value === undefined) store.add(key)
  else store.set(key, value)
  return added
}
function markSeen (x, y, z, b = bot.blockAt(new Vec3(x, y, z))) {
  if (recordNewest(SEEN, SEEN_CAP, ck(x, y, z))) seenEdits++
  rememberSurface(x, y, z, b)
  rememberStation(x, y, z, b)
}
// A seen station is remembered in its cell, and a cell seen holding anything else forgets it.
function rememberStation (x, y, z, b) {
  if (!b) return
  const key = ck(x, y, z)
  if (!STATION_RE.test(b.name)) {
    if (STATIONS.delete(key)) stationEdits++
  } else {
    if (STATIONS.get(key) !== b.type) stationEdits++
    recordNewest(STATIONS, STATION_CAP, key, b.type)
  }
}
// A seen solid or fluid cell up to 4 over the feet becomes its column's top unless a higher top in that reach is remembered.
function rememberSurface (x, y, z, b) {
  const key = x + ',' + z
  const top = SURFACE.get(key)
  const reach = Math.floor(bot.entity.position.y) + 4
  if (b && (b.boundingBox === 'block' || b.name === 'water' || b.name === 'lava')) {
    if (y > reach || (top && top[1] > y && top[1] <= reach)) return
    if (top && top[1] === y && top[0] === b.type) { recordNewest(SURFACE, SURFACE_CAP, key, top); return }
    recordNewest(SURFACE, SURFACE_CAP, key, [b.type, y])
    surfaceEdits++
  } else if (top && top[1] === y) {
    SURFACE.delete(key)
    surfaceEdits++
  }
}

// The walked trail feeds SEEN with the perceived cells of the 7x7x4 box around feet cell o.
function markTrail (o) {
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 2; dy++) {
    const p = new Vec3(o.x + dx, o.y + dy, o.z + dz)
    if (perceived(p)) markSeen(p.x, p.y, p.z)
  }
}

// ---- SEEN persistence: the fair fog-of-war memory survives restarts, one cell list per world
// (server address, dimension, world seed, spawn point). Saved on a timer and on clean disconnect.
const SEEN_FILE = './seen.json'
// Version of the sight rules and the seen.json layout.
const SEEN_VERSION = 3
// Saved cell lists by world key, except the current world's, which SEEN holds.
const SEEN_WORLDS = {}
// Saved column tops by world key, except the current world's, which SURFACE holds.
const SURFACE_WORLDS = {}
// Saved stations by world key, except the current world's, which STATIONS holds.
const STATION_WORLDS = {}
// The world key whose cells SEEN holds, null before login.
let seenKey = null
// The hashed seed of the last login or respawn packet, '' for a protocol without one.
memory.worldSeed = ''
function wireWorldSeed () {
  for (const name of ['login', 'respawn']) {
    bot._client.on(name, (packet) => {
      const seed = (packet.worldState || packet).hashedSeed
      memory.worldSeed = seed == null ? '' : String(seed)
    })
  }
}
// Loads a seen.json text into SEEN_WORLDS, SURFACE_WORLDS and STATION_WORLDS, false for one saved under older rules.
function loadSeen (text) {
  const saved = JSON.parse(text)
  if (saved.version !== SEEN_VERSION) return false
  Object.assign(SEEN_WORLDS, saved.worlds)
  Object.assign(SURFACE_WORLDS, saved.surfaces)
  Object.assign(STATION_WORLDS, saved.stations)
  return true
}
function seenJson () {
  const worlds = { ...SEEN_WORLDS }
  const surfaces = { ...SURFACE_WORLDS }
  const stations = { ...STATION_WORLDS }
  if (seenKey !== null) {
    worlds[seenKey] = [...SEEN]
    surfaces[seenKey] = [...SURFACE]
    stations[seenKey] = [...STATIONS]
  }
  return JSON.stringify({ version: SEEN_VERSION, worlds, surfaces, stations })
}
// A 1.7.10 server behind ViaProxy reports hashed seed 0.
function seenWorldKey () {
  const p = bot.spawnPoint
  return `${HOST}:${PORT}|${bot.game.dimension}|${memory.worldSeed}|${p ? `${p.x},${p.y},${p.z}` : ''}`
}
// Moves SEEN's cells, SURFACE's tops and STATIONS to the old world's lists and refills them from the current world's.
function enterSeenWorld () {
  const key = seenWorldKey()
  if (key === seenKey) return
  if (seenKey !== null) {
    SEEN_WORLDS[seenKey] = [...SEEN]
    SURFACE_WORLDS[seenKey] = [...SURFACE]
    STATION_WORLDS[seenKey] = [...STATIONS]
  }
  SEEN.clear()
  SURFACE.clear()
  STATIONS.clear()
  for (const k of (SEEN_WORLDS[key] || []).slice(-SEEN_CAP)) SEEN.add(k)
  for (const [k, top] of (SURFACE_WORLDS[key] || []).slice(-SURFACE_CAP)) SURFACE.set(k, top)
  for (const [k, id] of (STATION_WORLDS[key] || []).slice(-STATION_CAP)) STATIONS.set(k, id)
  delete SEEN_WORLDS[key]
  delete SURFACE_WORLDS[key]
  delete STATION_WORLDS[key]
  seenKey = key
  seenDirty = -1
  console.log('[bot] SEEN memory of ' + key + ': ' + SEEN.size + ' cells')
}
try {
  if (!loadSeen(fs.readFileSync(SEEN_FILE, 'utf8'))) console.log('[bot] dropped SEEN memory saved under older rules')
} catch (e) {}

// mineflayer emits game again when spawn_position arrives, which re-keys through enterSeenWorld.
function wireSeenWorld () {
  bot.on('game', enterSeenWorld)
}
function wireSeenSave () {
  setInterval(() => {
    try { if (seenEdits + surfaceEdits + stationEdits !== seenDirty) { fs.writeFileSync(SEEN_FILE, seenJson()); seenDirty = seenEdits + surfaceEdits + stationEdits } } catch (e) {}
  }, 120000)
  bot.on('end', () => { try { fs.writeFileSync(SEEN_FILE, seenJson()) } catch (e) {} })
}

// Cells within radius holding one of ids: seen there now, or remembered there while out of sight.
function knownBlocks (ids, radius) {
  const here = bot.entity.position
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 256 }).filter(p => seenNow(p))
  for (const [key, id] of STATIONS) {
    if (!ids.includes(id)) continue
    const p = new Vec3(...key.split(',').map(Number))
    if (here.distanceTo(p) <= radius && !seenNow(p) && bot.blockAt(p)) found.push(p)
  }
  return found
    .sort((a, b) => here.distanceTo(a.offset(0.5, 0.5, 0.5)) - here.distanceTo(b.offset(0.5, 0.5, 0.5)))
}
function nearestKnown (ids, radius) {
  const p = knownBlocks(ids, radius)[0]
  return p ? bot.blockAt(p) : null
}
// The block at p when the bot remembers a station of one of ids there, else null.
function rememberedStation (p, ids) {
  return ids.includes(STATIONS.get(ck(p.x, p.y, p.z))) ? bot.blockAt(p) : null
}
// The block at p once the walk to it ends, when it passes test. A remembered station found gone is forgotten.
function arrivedStation (p, test, what) {
  const b = bot.blockAt(p)
  if (b && test(b)) return b
  rememberStation(p.x, p.y, p.z, b)
  throw new Error(`no ${what} at ${p.x},${p.y},${p.z} any more`)
}

function createMemory (ctx) {
  Object.assign(ctx, { waypoints, memory, journal, SEEN, SEEN_CAP, SURFACE, SURFACE_CAP, STATIONS, STATION_CAP, STATION_RE, markSeen, rememberStation, markTrail, SEEN_VERSION, SEEN_WORLDS, SURFACE_WORLDS, STATION_WORLDS, loadSeen, seenJson, seenWorldKey, knownBlocks, nearestKnown, rememberedStation, arrivedStation })
}

function bindMemory (ctx) {
  ({ bot, ck, perceived, seenNow } = ctx)
}

module.exports = { createMemory, bindMemory, wireWorldSeed, wireSeenWorld, wireSeenSave }
