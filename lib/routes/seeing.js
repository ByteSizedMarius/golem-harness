'use strict'

const { Vec3 } = require('vec3')
const { isDoor } = require('../doors')
const { stepView } = require('../steps')
const { sectionColumns, floorPhrase } = require('../section')
const { GAZE_DIRS } = require('../gaze-dirs')
const { flatText } = require('../flat-text')
const { rescueNote } = require('../bot/alarms')

let bot, shared, ok, err, streams, jobs, waypoints, reflexes, chatLog, eventLog, pulseLog, HEARD, HOSTILE_NAMES, SEEN, SURFACE, airFlood, bodyTouches, cellKnown, knownCell, ck, compass, coverPhrase, entityLabel, entityPerceptible, findVisible, floodPassable, glyphFor, hearSummary, heldInfo, heldLight, indoors, insideBlock, liveEntities, nearestVisible, onlineNames, outOfSight, overheadCover, raySweep, resolveBlockIds, round, seenNow, seesLit, seesShape, showsNow, SKY_SEEN, skyPhrase, spatial3D, terrainClass, timeShows, veinScan, waterState, wear, enchantNames, whereIs, yawToCompass, cardinal, cardinalName, itemFrame, framedItem

let lastTickSnap = null   // /tick?delta=1 diffs against the previous tick (single-pilot assumption)
// Names this bot.js process in every reply.
const BOOT_ID = require('crypto').randomBytes(8).toString('hex')

// The age of a crop block and whether it reached its last age, null for any other block.
function cropAge (b) {
  if (!b || !/^(wheat|carrots|potatoes|beetroots|nether_wart|melon_stem|pumpkin_stem|cocoa)$/.test(b.name)) return null
  const age = Number(b.getProperties().age)
  const ages = shared.mcData.blocks[b.type].states.find(s => s.name === 'age').num_values
  return { age, mature: age === ages - 1 }
}

// A text component as plain text: a string or number as is, or NBT compound fields with `extra` flattened depth-first.
function componentText (c) {
  if (typeof c !== 'object') return String(c)
  // A list of mixed tags wraps each element in a compound under the empty key.
  if ('' in c) return componentText(c[''].value)
  return (c.text ? c.text.value : '') + (c.extra ? c.extra.value.value.map(e => componentText(e)).join('') : '')
}

function timePhase (tod) {
  if (tod >= 12000 && tod < 13800) return 'dusk'
  if (tod >= 13800 && tod < 22200) return 'night'
  if (tod >= 22200 && tod < 23500) return 'dawn'
  return 'day'
}

// How long ago the bot last saw the sky, and the phase estimated from the server ticks since, or the phase then with the day cycle off.
function lastSky () {
  if (SKY_SEEN.at === null) return null
  const min = Math.floor((Date.now() - SKY_SEEN.at) / 300000) * 5
  const ago = `last saw sky ${min ? `~${min} min ago` : 'just now'}`
  if (SKY_SEEN.cycle !== true || ![SKY_SEEN.age, bot.time.age].every(Number.isFinite)) return `${ago}, ${timePhase(SKY_SEEN.timeOfDay)} then`
  const tod = (((SKY_SEEN.timeOfDay + bot.time.age - SKY_SEEN.age) % 24000) + 24000) % 24000
  const where = bot.game.dimension === 'overworld' ? '' : ' in the overworld'
  return `probably ${timePhase(tod)}${where} now, ${ago}`
}

function skyClock () {
  const dimension = bot.game.dimension
  if (timeShows()) return { dimension, timeOfDay: bot.time.timeOfDay }
  const l = lastSky()
  return l ? { dimension, lastSky: l } : { dimension }
}

// The creatures perceptible within 48 grouped by label, and the hostile mobs among them, nearest first.
function sceneEntities (here, fill) {
  const threats = []
  // Player names are keys here.
  const groups = Object.create(null)
  for (const en of liveEntities()) {
    if (en.type !== 'mob' && en.type !== 'animal' && en.type !== 'hostile' &&
        en.type !== 'passive' && en.type !== 'player' && en.type !== 'living') continue
    const d = en.position.distanceTo(here)
    if (d > 48) continue                                   // 32→48 (07-17): the eye-ray tier makes far sight real
    if (!entityPerceptible(en, fill)) continue             // sealed behind rock = imperceptible (07-12)
    const nm = entityLabel(en) || en.type || 'entity'
    const dir = compass(en.position.x - here.x, en.position.z - here.z)
    if (!groups[nm]) groups[nm] = { count: 0, dirs: {}, nearest: Infinity }
    groups[nm].count++
    groups[nm].dirs[dir] = (groups[nm].dirs[dir] || 0) + 1
    if (d < groups[nm].nearest) groups[nm].nearest = d
    // A player named like a mob is no threat.
    if (en.type !== 'player' && HOSTILE_NAMES.has(String(nm).toLowerCase())) threats.push({ name: nm, dir, dist: +d.toFixed(1) })
  }
  threats.sort((a, b) => a.dist - b.dist)
  return { threats, groups }
}

// The doors and gates in sight within 16, nearest first, each named once by its lower half.
function doorsInSight () {
  const here = bot.entity.position
  const ids = Object.values(shared.mcData.blocksByName).filter(b => isDoor(b.name)).map(b => b.id)
  const seen = new Set()
  const out = []
  for (const { pos } of findVisible(ids, 16, 12)) {
    const b = bot.blockAt(pos)
    const props = b.getProperties() || {}
    const y = props.half === 'upper' ? pos.y - 1 : pos.y
    if (seen.has(ck(pos.x, y, pos.z))) continue
    seen.add(ck(pos.x, y, pos.z))
    out.push({ name: b.name, dir: compass(pos.x + 0.5 - here.x, pos.z + 0.5 - here.z), dist: Math.round(here.distanceTo(pos.offset(0.5, 0, 0.5))), open: !!props.open })
  }
  return out.slice(0, 6)
}

function knownSolid (x, y, z) {
  const p = new Vec3(x, y, z)
  const b = bot.blockAt(p)
  return !!b && b.boundingBox === 'block' && cellKnown(p)
}

// A fill cell the body stands in, on a known solid floor.
function stairFoot (cells, x, y, z) {
  return cells.has(ck(x, y, z)) && cells.has(ck(x, y + 1, z)) && knownSolid(x, y - 1, z)
}

function closedPanel (b) {
  return !!b && (b.name.includes('door') || b.name.includes('gate')) && !b.getProperties?.().open
}

// The slope ('up' or 'down') of each compass group in sideDir whose side cells a shortest chain of stand cells from
// the feet o reaches through 3 steps in a row that each move one cell sideways and rise 1, or each fall 1, onto a
// cell with a known solid ceiling 2 or 3 above it. A group reached both ways gets null.
function stairSlopes (cells, o, sideDir) {
  const slopes = new Map()
  if (!stairFoot(cells, o.x, o.y, o.z)) return slopes
  // The chain to each stand cell: run counts its last enclosed steps that rose (positive) or fell (negative) alike,
  // and up and down say whether a run reached 3 or -3.
  const chains = new Map([[ck(o.x, o.y, o.z), { run: 0, up: false, down: false }]])
  const rejected = new Set()
  const queue = [[o.x, o.y, o.z]]
  for (let i = 0; i < queue.length; i++) {
    const [x, y, z] = queue[i]
    const chain = chains.get(ck(x, y, z))
    const c = sideDir.get(ck(x, y, z))
    if (c && (chain.up || chain.down)) {
      const slope = chain.up && chain.down ? null : chain.up ? 'up' : 'down'
      slopes.set(c, !slopes.has(c) || slopes.get(c) === slope ? slope : null)
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [-1, 0, 1]) {
      const nx = x + dx, ny = y + dy, nz = z + dz
      const k = ck(nx, ny, nz)
      if (chains.has(k) || rejected.has(k)) continue
      if (!stairFoot(cells, nx, ny, nz)) { rejected.add(k); continue }
      const enclosed = dy !== 0 && (knownSolid(nx, ny + 2, nz) || knownSolid(nx, ny + 3, nz))
      const run = !enclosed ? 0 : Math.sign(chain.run) === dy ? chain.run + dy : dy
      chains.set(k, { run, up: chain.up || run >= 3, down: chain.down || run <= -3 })
      queue.push([nx, ny, nz])
    }
  }
  return slopes
}

// screen-region words for ray hits: u -1..1 = left..right, v -1..1 = low..high
function gazeRegion(u, v) {
  const vert = v > 0.4 ? 'high ' : v < -0.4 ? 'low ' : ''
  return vert + (u < -0.33 ? 'left' : u > 0.33 ? 'right' : 'center')
}
function gazeNarrate(sweep) {
  const groups = Object.create(null)
  for (const h of sweep.hits) {
    const t = h.name.replace('deepslate_', '')
    const g = groups[t] || (groups[t] = { count: 0, min: Infinity, max: 0, sumU: 0, sumV: 0 })
    g.count++; g.sumU += h.u; g.sumV += h.v
    if (h.dist < g.min) g.min = h.dist
    if (h.dist > g.max) g.max = h.dist
  }
  const notable = (n) => n.endsWith('_ore') || n.includes('water') || n.includes('lava') ||
    ['chest', 'furnace', 'crafting_table', 'torch', 'spawner', 'rail', 'door', 'ladder'].some(k => n.includes(k))
  const entries = Object.entries(groups).sort((a, b) => b[1].count - a[1].count)
  const phrase = ([name, g]) => {
    const where = gazeRegion(g.sumU / g.count, g.sumV / g.count)
    const span = Math.round(g.min) === Math.round(g.max) ? `~${Math.round(g.min)}` : `${Math.round(g.min)}–${Math.round(g.max)}`
    return `${name} ${where} ${span} out${g.count >= sweep.rays * 0.3 ? ' (fills much of the view)' : ''}`
  }
  const phrases = []
  for (const e of entries.filter(e => !notable(e[0])).slice(0, 3)) phrases.push(phrase(e))
  for (const e of entries.filter(e => notable(e[0])).slice(0, 6)) phrases.push(phrase(e))
  // The regions at least 3 of the rays end in, most first.
  const regions = (rays) => {
    const buckets = {}
    for (const m of rays) { const r = gazeRegion(m.u, m.v); buckets[r] = (buckets[r] || 0) + 1 }
    return Object.entries(buckets).sort((a, b) => b[1] - a[1]).filter(([, c]) => c >= 3).slice(0, 3).map(([r]) => r)
  }
  // openings: regions where no lit ray found a surface, open space or sky
  const openings = regions(sweep.misses)
  if (openings.length) phrases.push(`nothing within ${sweep.maxDist} ${openings.join(', ')} — open space there`)
  const unlit = regions(sweep.unlit)
  if (unlit.length) phrases.push(`too dark to see ${unlit.join(', ')}`)
  const surfaces = entries.map(([name, g]) => ({ name, rays: g.count, nearest: +g.min.toFixed(1) }))
  return { phrases, surfaces, openings }
}

function installSeeingRoutes (app) {
  // One-call heartbeat: body, chat since ?chat=, events since ?ev=, perceptible hostiles and jobs, with the next cursors.
  app.get('/tick', (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const chatSince = parseInt(req.query.chat || '0')
      const evSince = parseInt(req.query.ev || '0')
      const e = bot.entity
      const w = waterState()
      const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
      const threats = []
      for (const en of liveEntities()) {
        if (!en.position) continue
        const nm = String(en.name || '').toLowerCase()
        if (!HOSTILE_NAMES.has(nm)) continue
        const d = en.position.distanceTo(e.position)
        if (d > 48) continue
        if (!entityPerceptible(en, fill)) continue
        threats.push({ name: nm, dir: compass(en.position.x - e.position.x, en.position.z - e.position.z), dist: +d.toFixed(1) })
      }
      threats.sort((a, b) => a.dist - b.dist)
      const full = {
        boot: BOOT_ID,
        pos: round(e.position),
        hp: bot.health, food: bot.food, xp: bot.experience.level,
        held: bot.heldItem ? bot.heldItem.name : null,
        ...(w && (w.inWater || w.submerged || w.current || w.buried)
          ? { water: { inWater: w.inWater, submerged: w.submerged, current: w.current, buried: w.buried, oxygen: bot.oxygenLevel } } : {}),
        threats,
        chat: { cursor: chatLog.cursor, messages: chatLog.read(chatSince) },
        events: { cursor: streams.eventSeq, list: eventLog.filter(x => x.id > evSince) },
        jobs: jobs.list()
      }
      streams.eventsServed = streams.eventSeq
      // ?delta=1 drops pos under 1 block of drift from the last pos sent and vitals that did not change.
      if (req.query.delta === '1' && lastTickSnap) {
        const s = lastTickSnap
        if (full.pos && s.pos && Math.abs(full.pos.x - s.pos.x) + Math.abs(full.pos.y - s.pos.y) + Math.abs(full.pos.z - s.pos.z) < 1) delete full.pos
        if (full.hp === s.hp) delete full.hp
        if (full.food === s.food) delete full.food
        if (full.xp === s.xp) delete full.xp
        if (full.held === s.held) delete full.held
        if (!full.jobs.length && !s.jobsLen) delete full.jobs
      }
      lastTickSnap = { pos: full.pos || lastTickSnap.pos, hp: bot.health, food: bot.food, xp: bot.experience.level, held: bot.heldItem ? bot.heldItem.name : null, jobsLen: (full.jobs || []).length }
      ok(res, full)
    } catch (e) { err(res, e) }
  })

  // GET /cursors: reads the cursors without marking chat read or events served.
  app.get('/cursors', (req, res) => {
    ok(res, { boot: BOOT_ID, chat: chatLog.cursor, ev: streams.eventSeq, wakeEv: streams.wakeEv })
  })

  app.get('/state', (req, res) => {
    if (!shared.ready) return err(res, new Error('bot not spawned yet'))
    const e = bot.entity
    const inside = insideBlock()
    const { dimension, ...time } = skyClock()
    ok(res, {
      pos: round(e.position),
      yaw: +(bot.entity.yaw).toFixed(2), pitch: +(bot.entity.pitch).toFixed(2),
      health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
      xpLevel: bot.experience.level,   // enchanting currency — the table's offers cost levels
      ...(() => { const w = waterState(); return w ? { inWater: w.inWater, submerged: w.submerged, inCurrent: w.current, buried: w.buried } : {} })(),
      onGround: e.onGround, dimension, gameMode: bot.game.gameMode,
      ...(inside ? { inside } : {}),
      ...time,
      held: heldInfo(),
      lookingAt: (() => { const b = bot.blockAtCursor(5); return b ? { name: b.name, pos: round(b.position) } : null })()
    })
  })

  app.get('/inventory', (req, res) => {
    if (!shared.ready) return err(res, new Error('not ready'))
    const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot, ...wear(i), enchants: enchantNames(i) }))
    // worn armor (slots 5..8) + offhand (45) never show in items() — report them with durability
    const armorNames = ['head', 'torso', 'legs', 'feet']
    const worn = [5, 6, 7, 8].map((s, idx) => {
      const it = bot.inventory.slots[s]
      return it ? { slot: armorNames[idx], name: it.name, ...wear(it), enchants: enchantNames(it) } : null
    }).filter(Boolean)
    const off = bot.inventory.slots[45]
    if (off) worn.push({ slot: 'offhand', name: off.name, ...wear(off), enchants: enchantNames(off) })
    ok(res, { items, worn, emptySlots: bot.inventory.emptySlotCount() })
  })

  app.get('/find', (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const name = req.query.name
      const count = parseInt(req.query.count || '5')
      const radius = parseInt(req.query.radius || '64')
      const ids = resolveBlockIds(name)
      if (!ids.length) return err(res, new Error(`unknown block: ${name}`))
      const vis = findVisible(ids, radius, count)
      const results = vis.map(v => {
        const b = bot.blockAt(v.pos)
        return Object.assign({ pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z }, name: b?.name, dist: +v.dist.toFixed(1) }, cropAge(b))
      })
      ok(res, { count: results.length, blocks: results, visibleOnly: true })
    } catch (e) { err(res, e) }
  })

  app.get('/where', (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const name = req.query.name || process.env.MC_OWNER
      if (!name) return err(res, new Error('need name= (or set MC_OWNER in the environment for a default)'))
      ok(res, whereIs(name))
    } catch (e) { err(res, e) }
  })
  app.get('/entities', (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const radius = parseInt(req.query.radius || '24')
      const here = bot.entity.position
      const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
      const list = liveEntities()
        .filter(en => en.position && en.position.distanceTo(here) <= radius)
        .filter(en => entityPerceptible(en, fill))
        .map(en => {
          const frame = itemFrame(en.name)
          const shown = frame && framedItem(en)
          return {
            type: en.type, name: entityLabel(en),
            pos: round(frame ? en.position.floored() : en.position), dist: +en.position.distanceTo(here).toFixed(1),
            ...(frame ? { framed: shown ? shown.name : null } : {})
          }
        })
        .sort((a, b) => a.dist - b.dist).slice(0, 30)
      ok(res, { count: list.length, entities: list })
    } catch (e) { err(res, e) }
  })

  app.get('/chatlog', (req, res) => {
    const since = parseInt(req.query.since || '0')
    ok(res, { cursor: chatLog.cursor, messages: chatLog.read(since) })
  })

  // /blockat?x=&y=&z= — identity + block STATE (facing/half/open/lit...) of one block. The
  // self-sufficiency verb for orientation questions (stairs, doors, furnaces): no more asking
  // the co-pilot which way a thing points. Fairness: same LOS gate as all sight — a block I
  // can't honestly see returns an error, not an answer. A cell the body touches is known by touch.
  app.get('/blockat', (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) return err(res, new Error('unloaded chunk'))
      if (!bodyTouches({ x, y, z }) && !seesLit({ x, y, z }, 20)) return err(res, outOfSight())
      const out = { name: b.name, at: { x, y, z }, properties: b.getProperties() }
      if (b.name.includes('sign')) {
        try {
          const side = (s) => (b.entity?.value?.[s]?.value?.messages?.value?.value || []).map(l => componentText(l)).join('\n')
          out.text = { front: side('front_text'), back: side('back_text') }
        } catch (e) { out.text = { error: e.message } }
      }
      ok(res, out)
    } catch (e) { err(res, e) }
  })

  // ---- event stream: poll for driver-interrupting events since a cursor ----
  app.get('/events', (req, res) => {
    try {
      const since = parseInt(req.query.since || '0')
      streams.eventsServed = streams.eventSeq
      ok(res, { cursor: streams.eventSeq, events: eventLog.filter(e => e.id > since) })
    } catch (e) { err(res, e) }
  })
  // GET /pulse?since=N — the ambient awareness stream (pull-based, at my pace). Returns the lean
  // change-lines the narrator reflex has written since cursor N. Read it whenever I act/wake to catch
  // up on what shifted since my last glance — my "slow film" between deliberate /scene looks.
  app.get('/pulse', (req, res) => {
    try {
      const since = parseInt(req.query.since || '0')
      ok(res, { cursor: streams.pulseSeq, pulses: pulseLog.filter(p => p.id > since) })
    } catch (e) { err(res, e) }
  })

  // GET /map?radius=12  — top-down minimap. Row 0 = most-negative Z (north); left->right = -x..+x (west->east).
  app.get('/map', (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      let radius = parseInt(req.query.radius || '12')
      if (!Number.isFinite(radius) || radius < 1) radius = 12
      if (radius > 256) radius = 256                        // the 07-13 agreement: 16 chunks of sight; scale keeps it cheap
      let scale = parseInt(req.query.scale || '1')          // blocks per cell; >1 = zoomed-out survey
      if (!Number.isFinite(scale) || scale < 1) scale = 1
      while ((2 * Math.floor(radius / scale) + 1) > 121) scale++   // cap grid side ~121 cells (readable/cheap)
      const verbose = req.query.verbose === '1'
      const origin = bot.entity.position.floored()
      const ox = origin.x, oz = origin.z, topY = origin.y + 4
      const half = Math.floor(radius / scale)
      const rows = []
      for (let cz = -half; cz <= half; cz++) {             // z: north(-) .. south(+)
        let row = ''
        for (let cx = -half; cx <= half; cx++) {           // x: west(-) .. east(+)
          if (cx === 0 && cz === 0) { row += '@'; continue }
          const x = ox + cx * scale, z = oz + cz * scale   // each cell samples one block, `scale` apart
          let g = ' ', surfY = null
          for (let y = topY; y > topY - 24; y--) {         // scan down for highest solid/fluid surface
            const b = bot.blockAt(new Vec3(x, y, z))
            if (!b) continue
            const isFluid = b.name === 'water' || b.name === 'lava'
            if (b.boundingBox === 'block' || isFluid) { g = glyphFor(b.name); surfY = y; break }
          }
          // Live where the top cell shows now, elsewhere the top last seen in this column, '·' with none.
          if (!showsNow(new Vec3(x, surfY == null ? topY - 23 : surfY, z))) {
            const top = SURFACE.get(x + ',' + z)
            g = top && top[1] <= topY && top[1] > topY - 24 ? glyphFor(bot.registry.blocks[top[0]].name) : '·'
          }
          row += g
        }
        rows.push(row)
      }
      const payload = {
        legend: '@=you T=tree #=stone ~=water .=ground ==built ·=unexplored (gaze around / walk to fill in)',
        orientation: 'row0=north(-z), top->bottom = north->south(+z), left->right = west->east(-x->+x)',
        center: { x: ox, z: oz },
        radius,
        scale,                                              // blocks per cell (1 = full detail; >1 = survey)
        grid: rows.join('\n')
      }
      // the vertical fix: a stone slice at depth looks IDENTICAL to a mountaintop — say which this is.
      const oh = overheadCover()
      if (oh && !oh.sky && !oh.canopy && !indoors(oh)) {
        payload.underground = oh.canopy === null ? null : true
        payload.note = `this map is a SLICE at your depth, NOT the surface: ${skyPhrase(oh).trim()}`
      } else payload.underground = false
      if (verbose) payload.rows = rows
      ok(res, payload)
    } catch (e) { err(res, e) }
  })

  // GET /scene — compact situational summary for the driver.
  app.get('/scene', (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const verbose = req.query.verbose === '1'
      const pos = bot.entity.position
      const yaw = bot.entity.yaw
      const facing = yawToCompass(yaw)

      // biome: read from the block at the bot's feet, then head, then below
      let biome = null
      try {
        const probes = [bot.blockAt(pos), bot.blockAt(pos.offset(0, 1, 0)), bot.blockAt(pos.offset(0, -1, 0))]
        for (const b of probes) { if (b && b.biome && b.biome.name) { biome = b.biome.name; break } }
      } catch (e) {}

      const tod = bot.time.timeOfDay
      const phase = timePhase(tod)
      const time = timeShows() ? { timeOfDay: tod, phase } : undefined
      const sky = time ? null : lastSky()

      let ahead = null
      try {
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
        const eye = pos.offset(0, 1.6, 0)
        for (let d = 1; d <= 4; d++) {
          const p = new Vec3(Math.floor(eye.x + fx * d), Math.floor(eye.y), Math.floor(eye.z + fz * d))
          if (!seenNow(p)) { ahead = { unseen: true, dist: d, pos: round(p) }; break }
          const b = bot.blockAt(p)
          if (b && b.boundingBox === 'block' && b.name !== 'air') { ahead = { name: b.name, dist: d, pos: round(b.position) }; break }
        }
      } catch (e) {}

      // one flood-fill shared by the entity fairness gates in this call
      const sceneFill = reflexes.find(r => r.name === 'combat').fairFill(bot)

      // grouped entity summary + hostiles
      let threats = []
      let groups = {}
      try { ({ threats, groups } = sceneEntities(pos, sceneFill)) } catch (e) {}

      const entPhrases = Object.entries(groups).map(([nm, g]) => {
        const domDir = Object.entries(g.dirs).sort((a, b) => b[1] - a[1])[0][0]
        return `${g.count} ${nm} ${domDir} ~${Math.round(g.nearest)}`
      })
      const entSummary = entPhrases.length
        ? entPhrases.join('; ') + (threats.length ? '' : '; no hostiles')
        : 'no entities near'

      // nearest notable resources via findBlock (direction + distance). 64 not 48: the old 48 here
      // outlived the 07-14 gaze upgrade and kept announcing itself in every glance — the "48-block
      // visual limit" the helmsman kept re-reporting was mostly THIS sentence.
      const SCENE_RESOURCE_R = 64
      const notable = {}
      const wants = { water: 'water', oak_log: 'oak_log', stone: 'stone' }
      try {
        for (const [label, blockName] of Object.entries(wants)) {
          const ids = resolveBlockIds(blockName)
          if (!ids.length) continue
          const b = nearestVisible(ids, SCENE_RESOURCE_R)
          if (b) {
            const d = pos.distanceTo(b.position)
            notable[label] = { dir: compass(b.position.x - pos.x, b.position.z - pos.z), dist: +d.toFixed(1) }
          }
        }
      } catch (e) {}

      const held = bot.heldItem ? `${bot.heldItem.name} x${bot.heldItem.count}` : 'nothing'
      const resPhrases = Object.entries(notable).map(([k, v]) => `${k} ${v.dir} ~${Math.round(v.dist)}`)
      const around = spatial3D()
      const veins = veinScan()
      const oh = overheadCover()                                // the vertical fix: sky / canopy / UNDERGROUND
      const ws = waterState()
      const heard = hearSummary(45000)                          // ears: only shown when something was heard
      const doors = doorsInSight()
      const steps = stepView((p) => bot.blockAt(p), cellKnown, pos)
      let dim = ''                                              // light sense: only shown when it matters
      try {
        // The feet can stand inside soul sand or another partial block, which holds no light.
        const lights = [pos.floored(), pos.floored().offset(0, 1, 0)].flatMap((p) => {
          const b = bot.blockAt(p)
          return b ? [heldLight(p, b).light] : []
        })
        const bl = lights.length ? Math.max(...lights) : null
        if (oh && !oh.sky && bl != null && bl < 8) dim = `Dim (light ${bl}). `
      } catch (e) {}
      let bodyAlert = ''
      if (ws) {
        if (ws.buried) bodyAlert = `⚠ BURIED — head in a solid block's reach, SUFFOCATING; ${rescueNote() || 'dig out NOW'}. `
        else if (ws.inLava) bodyAlert = '⚠ IN LAVA. '
        else if (ws.submerged) bodyAlert = `⚠ SUBMERGED — drowning, O2 ${ws.oxygen}/20. `
        else if (ws.inWater) bodyAlert = `IN WATER${ws.current ? ' + CURRENT (being pushed)' : ''}${ws.oxygen < 20 ? `, O2 ${ws.oxygen}` : ''}. `
        else if (ws.current) bodyAlert = 'flowing water underfoot (current). '
      }
      const summary =
        bodyAlert +
        `Facing ${facing}. ` +
        `${biome ? biome + (time ? ' biome, ' : ' biome. ') : ''}${time ? `${phase} (t=${tod}). ` : ''}${sky ? `${sky[0].toUpperCase()}${sky.slice(1)}. ` : ''}` +
        `HP ${bot.health}/20, food ${bot.food}/20, holding ${held}. ` +
        `Ahead: ${ahead ? (ahead.unseen ? 'unseen' : ahead.name) + ' @' + ahead.dist : 'open'}. ` +
        coverPhrase(oh) + dim +
        (around ? `Around: ${around}. ` : '') +
        (veins ? `Veins: ${veins}. ` : '') +
        (heard ? `Hear: ${heard}. ` : '') +
        (doors.length ? `Doors: ${doors.map(d => `${d.name} ${d.dir} ${d.dist} ${d.open ? 'open' : 'closed'}`).join(', ')}. ` : '') +
        `Entities: ${entSummary}. ` +
        (threats.length ? `THREATS: ${threats.slice(0, 4).map(t => `${t.name} ${t.dir} ${t.dist}`).join(', ')}. ` : '') +
        (resPhrases.length ? `Resources: ${resPhrases.join(', ')}.` : `No notable resources in ${SCENE_RESOURCE_R}.`)

      const payload = { summary, facing, biome, time, threats, spatial: around, veins, sky: oh, water: ws, hear: heard, doors, steps }
      if (verbose) { payload.entities = groups; payload.ahead = ahead; payload.resources = notable; payload.held = held }
      ok(res, payload)
    } catch (e) { err(res, e) }
  })

  // GET /gaze?at=x,y,z | dir=n|ne|e|se|s|sw|w|nw|up|down &dist=24
  app.get('/gaze', async (req, res) => {
    try {
      const dist = Math.min(256, Math.max(4, parseInt(req.query.dist || '24')))
      const p = bot.entity.position
      if (req.query.at) {
        const [x, y, z] = String(req.query.at).split(',').map(Number)
        if (![x, y, z].every(Number.isFinite)) return err(res, new Error('at=x,y,z needs three numbers'))
        await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      } else if (req.query.dir) {
        const d = String(req.query.dir).toLowerCase()
        if (!Object.hasOwn(GAZE_DIRS, d)) return err(res, new Error('dir must be a compass point, up, or down'))
        await bot.lookAt(p.offset(...GAZE_DIRS[d]), true)
      }
      const sweep = raySweep({ maxDist: dist })
      for (const h of sweep.hits) { if (h.dist > 64) h.name = terrainClass(h.name) }
      const g = gazeNarrate(sweep)
      const pitch = bot.entity.pitch
      const tilt = pitch > 0.6 ? ' and up' : pitch > 0.25 ? ' and slightly up' : pitch < -0.6 ? ' and down' : pitch < -0.25 ? ' and slightly down' : ''
      const summary = `Looking ${yawToCompass(bot.entity.yaw)}${tilt} (${dist}-block sweep): ` +
        (g.phrases.length ? g.phrases.join('; ') : `no surface within ${dist} anywhere in view — wide open`) + '.'
      ok(res, { summary, dist, rays: sweep.rays, surfaces: g.surfaces, openings: g.openings, seenCells: SEEN.size })
    } catch (e) { err(res, e) }
  })

  // Names only the cells seenNow passes and ore in lit sight, draws the other cells in sight as dark shapes and the rest as '?'.
  app.get('/section', (req, res) => {
    try {
      const dp = (req.query.dir || '').toLowerCase()
      const [dx, dz] = cardinal(dp, bot.entity.yaw)
      const dirName = cardinalName(dp, bot.entity.yaw)
      const len = Math.min(32, Math.max(4, parseInt(req.query.len || '16')))
      const upR = Math.min(16, Math.max(2, parseInt(req.query.up || '8')))
      const downR = Math.min(24, Math.max(2, parseInt(req.query.down || '12')))
      const o = bot.entity.position.floored()
      const knowledge = new Map()
      const seen = (x, y, z) => {
        const k = ck(x, y, z)
        if (!knowledge.has(k)) knowledge.set(k, seenNow(new Vec3(x, y, z)))
        return knowledge.get(k)
      }
      const shapes = new Map()
      const shaped = (x, y, z) => {
        const k = ck(x, y, z)
        if (!shapes.has(k)) shapes.set(k, seen(x, y, z) || seesShape(new Vec3(x, y, z), 64))
        return shapes.get(k)
      }
      const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
      // A closed door in the dark reads as a wall whatever it is made of.
      const open = (x, y, z) => shaped(x, y, z) && floodPassable(at(x, y, z), seen(x, y, z))
      const wet = (x, y, z) => seen(x, y, z) && at(x, y, z).name.includes('water')

      const secGlyph = (n) => n.endsWith('_ore') ? '*' : n.includes('water') ? '~' : n.includes('lava') ? '!' : (glyphFor(n) === ' ' ? '#' : glyphFor(n))
      const ores = []
      const rows = []
      for (let y = o.y + upR; y >= o.y - downR; y--) {
        let row = ''
        for (let d = -2; d <= len; d++) {
          const x = o.x + dx * d, z = o.z + dz * d
          if (d === 0 && (y === o.y || y === o.y + 1)) { row += '@'; continue }
          if (open(x, y, z)) { row += !seen(x, y, z) ? ':' : wet(x, y, z) ? '~' : ' '; continue }
          const b = at(x, y, z)
          if (!b || !shaped(x, y, z)) { row += '?'; continue }
          // Lava shows by its own light.
          if (b.name.includes('lava')) { row += '!'; continue }
          if (!seen(x, y, z)) { row += b.boundingBox === 'block' ? '%' : '?'; continue }
          if (b.boundingBox === 'block') {
            const gl = secGlyph(b.name)
            if (gl === '*') {
              if (!seesLit(new Vec3(x, y, z), 48)) { row += '?'; continue }
              ores.push({ name: b.name.replace('deepslate_', '').replace('_ore', ''), d, dy: y - o.y, x, y, z })
            }
            row += gl
          } else row += '?'
        }
        rows.push(`y${String(y).padStart(3)} ${row}`)
      }

      // per-column profile -> narration: floor trend, headroom, water, where it seals or continues
      const cols = sectionColumns({
        o, dx, dz, len, up: upR, down: downR, open, wet,
        known: (p) => shaped(p.x, p.y, p.z),
        blockAt: (p) => bot.blockAt(p)
      })
      const parts = []
      let endAt = null
      for (const c of cols) if (c.lo === null) { endAt = c.d; break }
      const reach = cols.filter(c => c.lo !== null && (endAt === null || c.d < endAt))
      if (!reach.length) parts.push(`no open cell in sight ${dirName.toUpperCase()}`)
      else {
        parts.push(floorPhrase(reach, o.y))
        const rooms = reach.map(c => c.hi - c.lo + 1)
        parts.push(`headroom ${Math.min(...rooms)}${Math.min(...rooms) === Math.max(...rooms) ? '' : '–' + Math.max(...rooms)}`)
        const water = reach.filter(c => c.water)
        if (water.length) parts.push(`water at d${water[0].d}${water.length > 1 ? '–' + water[water.length - 1].d : ''}`)
        if (endAt !== null) {
          // Sealed only when the bot sees a solid shape across the whole height of the last open column.
          const last = reach[reach.length - 1]
          const x = o.x + dx * endAt, z = o.z + dz * endAt
          let wall = true
          for (let y = last.lo; y <= last.hi && wall; y++) { const b = at(x, y, z); wall = shaped(x, y, z) && !!b && b.boundingBox === 'block' }
          parts.push(wall ? `sealed from d${endAt}` : `out of sight from d${endAt}`)
        } else if (cols[len].lo !== null) parts.push(`passage continues past d${len}`)
        if (reach.some(c => c.hi === o.y + upR)) parts.push('open above the frame in places')
      }
      const oreBest = {}
      for (const or of ores) if (!oreBest[or.name] || Math.abs(or.d) < Math.abs(oreBest[or.name].d)) oreBest[or.name] = or
      for (const or of Object.values(oreBest)) {
        parts.push(`${or.name} at d${or.d}, ${or.dy >= 0 ? or.dy + ' up' : Math.abs(or.dy) + ' down'}`)
      }

      const summary = `Section ${dirName.toUpperCase()} from (${o.x},${o.y},${o.z}): ` + parts.join('; ') + '.'
      ok(res, {
        summary, dir: dirName, len, up: upR, down: downR,
        legend: '@=you  space=air  ~=water !=lava *=ORE #=rock .=soil T=wood ==built :=dark open %=dark solid ?=unseen',
        orientation: `left column is 2 behind you, '@' column is you, rightward = ${dirName.toUpperCase()}; rows top->bottom = y${o.y + upR}->y${o.y - downR}`,
        grid: rows.join('\n'), ores: Object.values(oreBest)
      })
    } catch (e) { err(res, e) }
  })

  // GET /passages?radius=20 : the air connected to the body that reaches the scan boundary, by direction, over cells the bot knows or sees the shape of.
  app.get('/passages', (req, res) => {
    try {
      const radius = Math.min(32, Math.max(8, parseInt(req.query.radius || '20')))
      const o = bot.entity.position.floored()
      const shapes = new Map()
      const known = (p) => {
        const k = ck(p.x, p.y, p.z)
        if (!shapes.has(k)) shapes.set(k, cellKnown(p) || (seesShape(p, 64) && !closedPanel(bot.blockAt(p))))
        return shapes.get(k)
      }
      const fill = airFlood({ radius, cap: 15000, known, knownOnly: true, body: true })
      const dirs = {}
      // The compass group of each side cell.
      const sideDir = new Map()
      let contUp = false, contDown = false, leaves = false
      for (const k of fill.cells) {
        const [x, y, z] = k.split(',').map(Number)
        const ddx = x - o.x, ddy = y - o.y, ddz = z - o.z
        const side = Math.max(Math.abs(ddx), Math.abs(ddz)) >= radius
        if (!side && Math.abs(ddy) < radius) continue
        leaves = true
        if (side) {
          const c = compass(ddx, ddz)
          sideDir.set(k, c)
          const g = dirs[c] || (dirs[c] = { cells: 0, loY: Infinity, hiY: -Infinity })
          g.cells++; if (y < g.loY) g.loY = y; if (y > g.hiY) g.hiY = y
          // One walk-to sample per exit from cells a walk can plan to, preferring one over a seen floor.
          if (!g.sampleFloor && knownCell(new Vec3(x, y, z))) {
            const under = new Vec3(x, y - 1, z)
            const fb = bot.blockAt(under)
            const hasFloor = !!(fb && fb.boundingBox === 'block') && cellKnown(under)
            if (!g.sample || hasFloor) { g.sample = { x, y, z }; g.sampleFloor = hasFloor }
          }
        }
        if (ddy >= radius) contUp = true
        if (ddy <= -radius) contDown = true
      }
      for (const [c, slope] of stairSlopes(fill.cells, o, sideDir)) if (slope) dirs[c].slope = slope
      const parts = Object.entries(dirs).sort((a, b) => b[1].cells - a[1].cells)
        .map(([c, g]) => `${c}${g.slope ? ' sloping ' + g.slope : ''} (around y${g.loY}${g.hiY !== g.loY ? '–' + g.hiY : ''}${g.sample ? `, walk-to ${g.sample.x},${g.sample.y},${g.sample.z}` : ''})`)
      let summary
      if (parts.length || contUp || contDown) summary = 'air continues ' + [...parts, contUp ? `UP past +${radius}` : null, contDown ? `DOWN past -${radius}` : null].filter(Boolean).join(', ')
      // Closed only when the bot sees every wall of a pocket that stays inside the radius.
      else if (!leaves && !fill.capped && !fill.unknown) summary = `closed pocket — no connected air leaves a ${radius}-block radius; digging is the only way on`
      else summary = `no exit in sight within ${radius} blocks`
      ok(res, { summary, radius, exits: dirs, up: contUp, down: contDown })
    } catch (e) { err(res, e) }
  })

  // GET /listen?window=60 — what have I HEARD lately? Pull-only companion to the danger-tier hear
  // events: everything the ears buffered, aggregated by category (species for mobs), never streamed.
  app.get('/listen', (req, res) => {
    try {
      const windowS = Math.min(300, Math.max(5, parseInt(req.query.window || '60')))
      const s = hearSummary(windowS * 1000)
      const payload = { heard: s || null, summary: s ? `heard (last ${windowS}s): ${s}` : `nothing heard in the last ${windowS}s`, buffered: HEARD.length }
      if (req.query.verbose === '1') payload.recent = HEARD.slice(-25)
      ok(res, payload)
    } catch (e) { err(res, e) }
  })

  // GET /boot: the one-call session opener with body, world, exits, tools, jobs and the chat cursor.
  app.get('/boot', (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const pos = bot.entity.position
      const oh = overheadCover()
      const around = spatial3D()
      const held = heldInfo()
      const jl = jobs.list().filter(j => j.status === 'running')
      // armor slots 5..8 = head/torso/legs/feet — worn gear never shows in items(), so report it here
      const armorNames = ['head', 'torso', 'legs', 'feet']
      const armor = [5, 6, 7, 8].map((s, i) => {
        const it = bot.inventory.slots[s]
        return it ? { slot: armorNames[i], name: it.name } : null
      }).filter(Boolean)
      const summary =
        `${bot.username || 'bot'} @ (${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}), HP ${bot.health}/20, food ${bot.food}/20, ` +
        `holding ${held ? held.name + (held.durability != null ? ` (${held.durability}/${held.maxDurability})` : '') : 'nothing'}. ` +
        (armor.length ? `Wearing: ${armor.map(a => a.name + ' (' + a.slot + ')').join(', ')}. ` : 'No armor worn. ') +
        ((bot.inventory.slots[45] && bot.inventory.slots[45].name) ? `Offhand: ${bot.inventory.slots[45].name}. ` : '') +
        coverPhrase(oh) + (around ? `Around: ${around}. ` : '') +
        (jl.length ? `RUNNING JOBS: ${jl.map(j => j.id + ':' + j.name).join(', ')}. ` : 'No jobs running. ') +
        `Chat cursor: ${chatLog.cursor}.`
      const clock = skyClock()
      const online = [...new Set(onlineNames().map((n) => Array.from(flatText(n)).slice(0, 32).join('')).filter(Boolean))]
      ok(res, {
        summary, pos: round(pos), health: bot.health, food: bot.food, xpLevel: bot.experience.level, held, armor,
        sky: oh, ...clock, online: online.slice(0, 20), ...(online.length > 20 ? { onlineMore: online.length - 20 } : {}),
        chatSeq: chatLog.cursor, seenCells: SEEN.size,
        waypoints: Object.keys(waypoints.list()), runningJobs: jl.map(j => ({ id: j.id, name: j.name })),
        reflexes: reflexes.map(r => ({ name: r.name, on: r.on }))
      })
    } catch (e) { err(res, e) }
  })
}

function createSeeingRoutes (ctx) {
  Object.assign(ctx, { installSeeingRoutes, BOOT_ID })
}

function bindSeeingRoutes (ctx) {
  ({ bot, shared, ok, err, streams, jobs, waypoints, reflexes, chatLog, eventLog, pulseLog, HEARD, HOSTILE_NAMES, SEEN, SURFACE, airFlood, bodyTouches, cellKnown, knownCell, ck, compass, coverPhrase, entityLabel, entityPerceptible, findVisible, floodPassable, glyphFor, hearSummary, heldInfo, heldLight, indoors, insideBlock, liveEntities, nearestVisible, onlineNames, outOfSight, overheadCover, raySweep, resolveBlockIds, round, seenNow, seesLit, seesShape, showsNow, SKY_SEEN, skyPhrase, spatial3D, terrainClass, timeShows, veinScan, waterState, wear, enchantNames, whereIs, yawToCompass, cardinal, cardinalName, itemFrame, framedItem } = ctx)
}

module.exports = { createSeeingRoutes, bindSeeingRoutes }
