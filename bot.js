// Golem — a Mineflayer body for language-model pilots
// Doing-layer: structured perception + actions over a tiny HTTP API (drive with curl).
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const armorManager = require('mineflayer-armor-manager')
const express = require('express')
const fs = require('fs')
const { Vec3 } = require('vec3')
const { installSecurity, chatMaxLen, BUNKER_MODES } = require('./lib/install')
const { classifySound } = require('./lib/sounds')
const { SHELTER, chooseShelter, entityInCell, babyFlag, upBuildMs, downBuildMs, expireConfirmed, bunkerSummary } = require('./lib/shelter')
const { UNLOADED, standCell, resolveTarget, crumbCentre, nametagGoal, arrivedAt, walkAttempt, routeDeadline, guardWork } = require('./lib/walk')
const { playerNamed, playersAround, presenceUpdate, presenceText } = require('./lib/players')
const { POINT_RANGE, deictic, lookedAt } = require('./lib/deixis')
const { WAKE_KINDS, serverLines, rateLimit, foldQuiet, quietText } = require('./lib/server-msg')
const { ambientChange, sameVein } = require('./lib/wake')
const { headFree, smoothLook } = require('./lib/head')
const { pacePlacements } = require('./lib/pace')
const { noJumpReason, passedNodes, step: nodeStep } = require('./lib/sprint')
const { summarizePlan, planRisk } = require('./lib/plan')
const { isDoor, doorStep, panelAcross, doorCrossing } = require('./lib/doors')
const { stepView } = require('./lib/steps')
const { countVerbs } = require('./lib/verbs')
const { createChatLog } = require('./lib/chat-log')
const { GRAVESTONE, readServerOverrides, renameBlocks, overrideRecipes, craftable } = require('./lib/server-overrides')
const { smeltYield } = require('./lib/furnace')

const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565')
const VERSION = process.env.MC_VERSION || '1.21.8'
const USERNAME = process.env.MC_USER || 'Claude'
const CTRL_PORT = parseInt(process.env.CTRL_PORT || '3000')
const VIEW_PORT = parseInt(process.env.VIEW_PORT || String(CTRL_PORT + 1))
// Set for a Forge 1.7.10 server behind ViaProxy: no attack charge, a sword block instead of a shield, no off-hand.
const LEGACY_1710 = process.env.GOLEM_MC_1710 === '1'
// On 1.7.10 a full hit lands every 10 ticks at most, and the bot attacks 11 ticks apart.
const LEGACY_HIT_MS = 550
const SERVER_OVERRIDES = readServerOverrides(process.env.GOLEM_SERVER_OVERRIDES)
const SERVER_RECIPES = SERVER_OVERRIDES && SERVER_OVERRIDES.recipes
// The server keeps a dead player's items in a gravestone.
const GRAVES = !!SERVER_OVERRIDES && [...SERVER_OVERRIDES.blocks.values()].includes(GRAVESTONE)
// The HMAC key that signs every control API request and response.
const GOLEM_TOKEN = process.env.GOLEM_TOKEN || ''
if (GOLEM_TOKEN.length < 32) {
  console.error('[bot] GOLEM_TOKEN is missing or shorter than 32 characters, refusing to start')
  process.exit(1)
}

const bot = mineflayer.createBot({
  // MC_VERSION=auto lets mineflayer detect the server's version from the handshake
  host: HOST, port: PORT, username: USERNAME,
  version: VERSION === 'auto' ? false : VERSION, auth: 'offline',
  checkTimeoutInterval: 60000    // tolerate a slow server before assuming a keep-alive timeout
  // NOTE on chat signing (2026-07-13): 'disableChatSigning: true' stops the sporadic
  // 'chat_validation_failed' kick but the server then SILENTLY DROPS every outbound
  // message (and /me emotes) — the bot goes mute while /chat still returns ok. Signed
  // chat with a rare kick (~1 in 25 msgs, watchdog recovers in ~20s) beats unsigned
  // muteness, so signing stays ON. Keep messages short; on kick: relaunch same port,
  // reset heartbeat cursor.
})

// ---- connection hardening (cannibalized from Mindcraft's mcdata.js): cheap plumbing that keeps a
// long-running bot alive on real servers. (a) throttle position/look packets to <=1 per 50ms so
// pathfinder movement spam doesn't trip server anti-cheat and get us kicked; (b) swallow the common
// 'PartialReadError' protocol-desync that would otherwise crash the client. Pure plumbing — it only
// reorders OUTBOUND packets, so the bot's own position tracking (and our fairness/LOS) is untouched.
try {
  const _write = bot._client.write.bind(bot._client)
  let lastPos = 0, posTimer = null
  bot._client.write = (name, data) => {
    if (name === 'position' || name === 'position_look' || name === 'look') {
      const dt = Date.now() - lastPos
      if (dt < 50) {                                   // coalesce a burst: keep only the latest
        if (posTimer) clearTimeout(posTimer)
        posTimer = setTimeout(() => { posTimer = null; lastPos = Date.now(); _write(name, data) }, 50 - dt)
        return
      }
      lastPos = Date.now()
    }
    return _write(name, data)
  }
  const _emit = bot._client.emit.bind(bot._client)
  bot._client.emit = (event, ...args) => {
    if (event === 'error' && String((args[0] && args[0].message) || args[0] || '').includes('PartialReadError')) {
      console.log('[bot] swallowed PartialReadError (protocol desync)')
      return true
    }
    return _emit(event, ...args)
  }
} catch (e) { console.log('[bot] connection hardening skipped:', e.message) }

bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)
bot.loadPlugin(armorManager)   // auto-equip best armor (freebie for the survival ramp; no-op on Peaceful)

let mcData = null
let ready = false
const navPlaced = []   // blocks the pathfinder placed as scaffolding, awaiting /tidy cleanup
let considerateMoves = null    // default no-dig profile (protects builds + terrain)
let forestryMoves = null       // lumberjack profile: may break ONLY leaves+logs (built at spawn)

// ---- collectBlock cage (07-20): mineflayer-collectblock's collect() installs ITS OWN default
// Movements (canDig=true, dontCreateFlow=false!) into the shared pathfinder and NEVER restores
// ours — every /mine, /tidy, and table-reclaim silently swapped my legs for wall-eating legs,
// and every walk afterward could carve through builds (the house-hole culprit — found because
// the helmsman kept finding fresh holes). Its target gate needs canDig=true (safeToBreak
// hard-returns false otherwise), so it can't just wear the considerate profile: hand it
// disposable legs that may break ONLY the target's block type (+ leaves, for canopy
// approaches), and ALWAYS give the pathfinder back the legs it was wearing before.
async function collectSafely (block) {
  const prev = bot.pathfinder.movements   // considerate normally; forestry mid-/gather
  const cage = new Movements(bot)
  cage.canDig = true
  cage.maxDropDown = 3
  cage.liquidCost = 15
  cage.allow1by1towers = false
  cage.allowParkour = true
  cage.scafoldingBlocks = []
  const cant = new Set()
  for (const blk of mcData.blocksArray) {
    if (blk.id === block.type) continue
    if (/_leaves$/.test(blk.name)) continue
    cant.add(blk.id)
  }
  cage.blocksCantBreak = cant
  mcData.blocksArray.forEach(b => { if (b.name.endsWith('_door') && !b.name.includes('iron')) cage.openable.add(b.id) })
  cage.canOpenDoors = true
  bot.collectBlock.movements = cage
  try {
    return await watchedWork(() => bot.collectBlock.collect(block), abandonCollect)
  } finally {
    bot.collectBlock.movements = null   // no stale cage lingering inside the plugin
    if (prev) bot.pathfinder.setMovements(prev)
  }
}
// How long one collect or approach may stand without progress, and how long it may take at most.
const COLLECT_STALL_MS = 4500
const COLLECT_BUDGET_MS = 60000
// Runs work under a stall watch and the budget of one collect, and stop ends it when either trips.
// A dig counts as progress.
function watchedWork (work, stop) {
  return guardWork(work, {
    position: () => bot.entity.position,
    onPathUpdate: (fn) => {
      bot.on('path_update', fn)
      return () => bot.removeListener('path_update', fn)
    },
    busy: () => !!bot.targetDigBlock,
    stop,
    stallMs: COLLECT_STALL_MS,
    thinkTimeout: bot.pathfinder.thinkTimeout,
    budgetMs: COLLECT_BUDGET_MS
  })
}
// Ends a collect the watch gave up on: its walk, its dig and its wait for a drop pickup.
function abandonCollect () {
  stopPath()
  if (bot.targetDigBlock) bot.stopDigging()
  // A pickup wait that resumes later finds its list cleared and ends.
  const Targets = bot.collectBlock.targets.constructor
  bot.collectBlock.targets.clear()
  bot.collectBlock.targets = new Targets(bot)
}

bot.once('spawn', () => {
  mcData = require('minecraft-data')(bot.version)
  // bot.registry shares these block entries.
  if (SERVER_OVERRIDES) renameBlocks(mcData, SERVER_OVERRIDES.blocks)
  const moves = new Movements(bot)
  // ---- CONSIDERATE PLAYER: don't vandalize builds/terrain, don't litter ----
  moves.canDig = false            // NEVER break blocks to travel — protects your house AND the
                                  // landscape (no tunneling shortcuts). NB: collectBlock swaps in
                                  // its own dig-legs — collectSafely() cages that (07-20).
  moves.maxDropDown = 3           // don't fling off tall ledges en route
  moves.liquidCost = 15           // (07-14, after drowning in a decorative POND mid-sheep-drive:
                                  // dry detours beat swims whenever one exists; swimming stays
                                  // legal for genuine crossings — the helmsman's water-suite design)
  moves.allow1by1towers = false  // no gratuitous pillar/shaft moves
  moves.allowParkour = true      // jump small gaps instead of scaffolding them (less litter)
  moves.scafoldingBlocks = []    // DEFAULT: no bridging → swim / walk / parkour, ZERO litter, no matter
                                 // what I'm carrying. Bridging is a deliberate CHOICE: flip it on with
                                 // /bridging?on=1 when a chasm/lava/gap genuinely needs a bridge, do the
                                 // crossing, flip it off; every block it places is tracked for /tidy.
  // DOORS (07-14): upstream ships canOpenDoors=false and only ever puts fence GATES in
  // `openable`, so every door — even one standing open — reads as a wall (an open door's
  // swung panel still has a collision shape). The walker couldn't leave its own house.
  // Wooden doors join the openable set; the executor right-clicks them in passing
  // (guarded in index.js so it never toggles an already-open door shut in my face).
  // Iron doors stay walls — they want redstone, that's the game's rule, keep it.
  const addDoors = (m) => { mcData.blocksArray.forEach(b => { if (b.name.endsWith('_door') && !b.name.includes('iron')) m.openable.add(b.id) }); m.canOpenDoors = true }
  addDoors(moves)
  moves.infiniteLiquidDropdownDistance = false   // a drop into water is held to maxDropDown too
  bot.pathfinder.setMovements(moves)
  bot.pathfinder.thinkTimeout = 10000
  considerateMoves = moves       // remember the default so /gather can restore it after forestry

  // ---- FORESTRY profile: a lumberjack's legs. Same considerate base, but permitted to break
  // ONLY leaves and logs to travel — so it clears canopy to reach trunks and can always chew a
  // leaf to free itself from a foliage wedge. Every other block (stone, dirt, ore, sand, and
  // every plank/door/block of your builds) stays UNbreakable, so the no-tunnel / no-x-ray
  // fairness floor is exactly as before. Swapped in only while /gather is harvesting wood.
  forestryMoves = new Movements(bot)
  forestryMoves.canDig = true
  forestryMoves.maxDropDown = 2          // gentler drops off trunk tops → avoid fall damage
  forestryMoves.infiniteLiquidDropdownDistance = false
  forestryMoves.allow1by1towers = false
  forestryMoves.allowParkour = true
  forestryMoves.scafoldingBlocks = []          // still zero litter — never places blocks to travel
  const cantBreak = new Set()
  for (const blk of mcData.blocksArray) {
    if (/(_log|_wood|_leaves)$/.test(blk.name)) continue   // leaves + logs are the ONLY breakables
    cantBreak.add(blk.id)
  }
  forestryMoves.blocksCantBreak = cantBreak
  addDoors(forestryMoves)                      // lumberjack legs get the same door manners

  // ---- litter tracking: record blocks the PATHFINDER places (scaffolding) so /tidy can reclaim
  // them. Only placements made mid-navigation (pathfinder.isMoving) are tracked; deliberate builds
  // via /place, /build, … happen while the pathfinder is idle and are left untouched. ----
  const _placeBlock = bot.placeBlock.bind(bot)
  bot.placeBlock = async function (refBlock, faceVec) {
    let navigating = false
    try { navigating = bot.pathfinder.isMoving() } catch (e) {}
    const result = await _placeBlock(refBlock, faceVec)
    try {
      if (navigating && refBlock && faceVec) {
        const p = refBlock.position.plus(faceVec)
        navPlaced.push({ x: p.x, y: p.y, z: p.z })
      }
    } catch (e) {}
    return result
  }

  ready = true
  startReflexes()                     // start the always-on reflex loop (unstuck, +survival reflexes later)
  console.log(`[bot] spawned as ${USERNAME} on ${bot.version} at`, vecStr(bot.entity.position))
  // Seeing-layer (optional; never let it crash the bot)
  try {
    const { mineflayer: viewer } = require('prismarine-viewer')
    // 07-14: the viewer's browser bundles were REBUILT with modern minecraft-data + a synthesized
    // 1.21.11 atlas (1.21.8 models — newest published assets; every block in this world predates
    // them). The client now resolves bot.version natively — no fallback, no shifted block ids.
    // NOTE: the old `version: '1.21.4'` "pin" here was a NO-OP (mineflayer.js never read that
    // option); the client was silently falling back to the 1.21.4 atlas on its own, which is why
    // most-but-not-all blocks rendered right. Rebuild recipe + rollback: backups/viewer-1.21.11-rebuild/.
    // prismarine-viewer keeps its http server to itself and listens with no error listener.
    const http = require('http')
    const createServer = http.createServer
    const viewServers = []
    http.createServer = (...args) => { const s = createServer(...args); viewServers.push(s); return s }
    try {
      viewer(bot, { port: VIEW_PORT, firstPerson: true })
    } finally {
      http.createServer = createServer
    }
    for (const s of viewServers) s.on('error', (e) => console.log('[bot] viewer failed (non-fatal):', e.message))
    console.log(`[bot] viewer on http://localhost:${VIEW_PORT}`)
  } catch (e) { console.log('[bot] viewer failed (non-fatal):', e.message) }

  // ---- event listeners: fire emitEvent for driver-interrupting conditions, each deduped ----
  try {
    const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'husk', 'stray', 'drowned', 'pillager', 'vindicator', 'zombie_villager', 'phantom'])
    let lastHealth = (typeof bot.health === 'number') ? bot.health : 20
    let lastDmg = 0                // throttle damage events so sustained damage doesn't flood the driver
    const warnedMobs = new Set()   // entity ids already warned about, so a lingering mob isn't re-fired
    let nightFired = false
    let lowFoodFired = false
    let critHealthFired = false
    let lastDrownEvt = 0           // throttle timestamp for the drowning alarm (fire once per 3s)

    // health event fires on any health/food change: covers damage-taken, health-critical, low-food
    bot.on('health', () => {
      try {
        const h = bot.health
        if (typeof h === 'number') {
          if (h < lastHealth && Date.now() - lastDmg > 1500) {
            lastDmg = Date.now()
            // damage reporting lives in the SECOND-SENSES hurt listener now (freeze + cause guess);
            // this older path keeps only the critical-health alarm below
          }
          if (h <= 6 && !critHealthFired) {
            critHealthFired = true
            emitEvent('health_critical', `health critical: ${h.toFixed(1)}`, { health: h })
          } else if (h > 6) {
            critHealthFired = false   // re-arm once recovered
          }
          lastHealth = h
        }
        const f = bot.food
        if (typeof f === 'number') {
          if (f <= 6 && !lowFoodFired) {
            lowFoodFired = true
            emitEvent('low_food', `hunger low: ${f}`, { food: f })
          } else if (f > 6) {
            lowFoodFired = false   // re-arm once fed
          }
        }
      } catch (e) {}
    })

    // breath event: fires when oxygen changes. Alarm ONLY on REAL drowning — a VALID low reading
    // (0..12; bot.oxygenLevel returns junk like -1 sometimes) AND actually SUBMERGED (head in water).
    // The old version fired on the junk reading alone, screaming at a bone-dry Claude; the submersion
    // gate kills that. Time-throttled (3s) so a real drowning warns ONCE, not forty times.
    bot.on('breath', () => {
      try {
        const o2 = bot.oxygenLevel
        if (typeof o2 !== 'number' || o2 < 0 || o2 > 12) return    // ignore junk (-1) + healthy readings
        const ws = waterState(bot)
        if (!ws || !ws.submerged) return                           // not actually underwater → no alarm
        if (Date.now() - lastDrownEvt < 3000) return               // throttle the spam
        lastDrownEvt = Date.now()
        emitEvent('drowning', `DROWNING — oxygen ${o2}/20, get to air NOW`, { oxygen: o2, health: bot.health })
        // SURVIVAL REFLEX (07-17, drowned to 2HP mid-dig): an active dig pins the body underwater
        // and nothing else lets go. Abort the dig and swim — air first, apologies after.
        if (o2 <= 8) {
          try { bot.stopDigging() } catch (e) {}
          takeLegs('drown', 'swim up')
          try { bot.pathfinder.setGoal(null) } catch (e) {}
          try { swimUp(4000) } catch (e) {}
          emitEvent('drowning', 'drown reflex: dig aborted, swimming up', {})
        }
      } catch (e) {}
    })

    bot.on('death', () => {
      try { emitEvent('death', 'bot died', { pos: (bot.entity ? round(bot.entity.position) : null) }) } catch (e) {}
    })

    // warn once when a hostile mob is within ~16 blocks (via spawn event AND the slow scan below)
    const considerMob = (en) => {
      try {
        if (!en || en === bot.entity || !en.position || !bot.entity) return
        const nm = (en.name || '').toLowerCase()
        if (!HOSTILE.has(nm)) return
        if (warnedMobs.has(en.id)) return
        const d = en.position.distanceTo(bot.entity.position)
        if (d <= 16) {
          // FAIRNESS (07-16, caught from inside a sealed night shelter: this alarm quoted live
          // distances to skeletons through the dirt wall — raw-entity x-ray, the same leak-class
          // as the combat watcher's). A distance-quoting alarm is SIGHT-class perception: shared
          // air required (sealed hostiles may still be HEARD — ears are server-fair). NOT marked
          // warned when gated, so the alarm still fires the moment the wall opens.
          try { if (!entityPerceptible(en, airFlood({ radius: 20, cap: 8000 }))) return } catch (e) {}
          warnedMobs.add(en.id)
          emitEvent('hostile', `${nm} within ${d.toFixed(1)} blocks`, { mob: nm, id: en.id, pos: round(en.position), dist: +d.toFixed(1) })
        }
      } catch (e) {}
    }
    bot.on('entitySpawn', considerMob)

    // slow ~2s scan: catch mobs that were already loaded, expire stale warnings, and poll nightfall
    setInterval(() => {
      try {
        if (!bot.entity) return
        for (const en of liveEntities()) considerMob(en)
        // let a mob re-warn once it has left (>24) or despawned, so a fresh approach re-fires
        for (const id of Array.from(warnedMobs)) {
          const en = bot.entities && bot.entities[id]
          if (!en || (en.position && en.position.distanceTo(bot.entity.position) > 24)) warnedMobs.delete(id)
        }
        const tod = bot.time && bot.time.timeOfDay
        if (typeof tod === 'number') {
          if (tod >= 13000 && tod < 23000) {   // dusk..dawn window
            if (!nightFired) { nightFired = true; emitEvent('nightfall', 'night has fallen', { timeOfDay: tod }) }
          } else {
            nightFired = false   // reset by day so it fires once per night
          }
        }
      } catch (e) {}
    }, 2000)
  } catch (e) { console.log('[bot] event listeners failed (non-fatal):', e.message) }
})

bot.on('kicked', (r) => console.log('[bot] kicked:', r))
bot.on('error', (e) => console.log('[bot] error:', e.message))
// The connection dying MUST kill the process: the watchdog only relaunches on process death,
// and a live control API over a dead socket serves stale world state with ok:true (ghost mode).
bot.on('end', (r) => {
  console.log('[bot] disconnected:', r, '— exiting so the watchdog can relaunch')
  setTimeout(() => process.exit(1), 500)
})

// ---- chat capture (so the driver can hear the world, not just speak to it) ----
const chatLog = createChatLog({ self: USERNAME })
function pushChat(from, message, kind) {
  const line = chatLog.push(from, message, kind)
  if (!line) return
  const pointsAt = pointerOf(from, message)
  if (pointsAt) line.pointsAt = pointsAt
  console.log(`[chat] <${from}> ${message}`)
}
// A pointer error leaves the line without one.
const pointerOf = (from, message) => { try { return chatPointer(from, message) } catch (e) { return null } }
bot.on('chat', (username, message) => pushChat(username, message, 'chat'))
bot.on('whisper', (username, message) => pushChat(username, message, 'whisper'))

// Every system line no player wrote, as a server event. Deaths, joins, leaves and achievements wake the pilot,
// at most 6 a minute, and every other line arrives quiet. A name in them is player-chosen text.
const serverWakes = rateLimit({ max: 6, windowMs: 60000 })
// The quiet server events no reply carried yet, oldest first, as foldQuiet counts them, each with its event ev.
const quietServer = []
let serverLine = null
function serverMessage (msg, position) {
  try {
    if (position !== 'system') return
    serverLine ??= serverLines(bot.registry.language || {})
    const line = serverLine(msg)
    if (!line) return
    if (WAKE_KINDS.includes(line.kind) && serverWakes.take(Date.now())) return emitEvent('server', line.text, { kind: line.kind })
    while (quietServer.length && quietServer[0].ev.id <= eventsServed) quietServer.shift()
    const folded = foldQuiet(quietServer, line.text)
    if (folded) Object.assign(folded.ev, { msg: quietText(folded), data: { ...folded.ev.data, repeats: folded.repeats, merged: folded.merged } })
    else {
      // The MCP server merges the counts of the events that carry the same text.
      const ev = emitEvent('server', line.text, { kind: line.kind, text: line.text, repeats: 0, merged: 0 }, { quiet: true })
      if (ev) quietServer.push({ text: line.text, repeats: 0, merged: 0, ev })
    }
  } catch (e) {}
}
bot.on('message', serverMessage)

// ---- helpers ----
const vecStr = (v) => v ? `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})` : null
const round = (v) => v ? { x: Math.round(v.x*10)/10, y: Math.round(v.y*10)/10, z: Math.round(v.z*10)/10 } : null

function resolveBlockIds(name) {
  if (!mcData) return []
  const exact = mcData.blocksByName[name]
  if (exact) return [exact.id]
  // partial / fuzzy match across block names
  return Object.values(mcData.blocksByName)
    .filter(b => b.name.includes(name))
    .map(b => b.id)
}
function resolveItem(name) {
  if (!mcData) return null
  const known = (SERVER_OVERRIDES && SERVER_OVERRIDES.items.get(name)) || name
  return mcData.itemsByName[known] || mcData.blocksByName[known] || null
}

// ---- event stream (interrupts for the driver: damage, death, threats, night, hunger) ----
let eventSeq = 0
const eventLog = []
// The newest event id a /tick or /events reply carried.
let eventsServed = 0
// A quiet event rides along with the next wake of wait_events and wakes nothing itself. Returns the event, null
// when it could not be logged.
function emitEvent(kind, msg, data, { quiet = false } = {}) {
  try {
    console.log('[event] ' + kind + ' ' + msg)   // stdout line so the log-tailing Monitor wakes the driver
    const ev = { id: ++eventSeq, t: Date.now(), kind, msg, data: data || null, ...(quiet && { quiet }) }
    eventLog.push(ev)
    if (eventLog.length > 400) eventLog.splice(0, eventLog.length - 400)
    return ev
  } catch (e) { return null }
}

// ---- AMBIENT PULSE (the change-gated awareness stream): a lean [pulse] log the driver reads AT ITS
// OWN PACE via /pulse — deliberately NOT tailed by the Monitor, so it never interrupts. The narrator
// reflex writes a line only when something salient CHANGES (day-phase, HP/food, a new hostile, a big
// move), turning my strobe of glances into a slow film I can catch up on whenever I next look. ----
let pulseSeq = 0
const pulseLog = []
function logPulse (msg) {
  try {
    console.log('[pulse] ' + msg)            // distinct prefix; the Monitor does NOT grep [pulse]
    pulseLog.push({ id: ++pulseSeq, t: Date.now(), msg })
    if (pulseLog.length > 200) pulseLog.splice(0, pulseLog.length - 200)
  } catch (e) {}
}
function dayPhase (t) {
  t = ((t % 24000) + 24000) % 24000
  if (t < 12000) return 'day'
  if (t < 13800) return 'sunset'
  if (t < 22200) return 'night'
  return 'sunrise'
}
const HOSTILE_NAMES = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'witch', 'enderman', 'slime', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'zombified_piglin', 'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'warden', 'blaze', 'ghast', 'magma_cube', 'silverfish', 'endermite', 'vex', 'guardian', 'elder_guardian', 'shulker', 'zombie_villager', 'wither_skeleton', 'wither', 'breeze'])

// ---- REFLEX LAYER (cannibalized from Mindcraft's modes.js): always-on node-process reflexes that
// run WITHOUT a model call. Each reflex does a cheap check() every ~300ms; when it fires, act() runs
// in the background (an `active` guard stops re-entry) and emits a [reflex] line the Monitor tails —
// so the pilot is woken organically, not by polling. Priority = array order, one reflex acts per tick.
// The survival reflexes (self_preservation, self_defense, …) will slot in here for the survival ramp;
// for now the spine + `unstuck` (useful even on Peaceful). Toggle any reflex via /reflexes. ----
const reflexes = []
function reflexFire (r) {
  if (r.active) return
  r.active = true
  Promise.resolve().then(() => r.act(bot))
    .catch(e => console.log('[reflex] ' + r.name + ' error: ' + e.message))
    .finally(() => { r.active = false })
}
let reflexTimer = null
function startReflexes () {
  if (reflexTimer) clearInterval(reflexTimer)
  reflexTimer = setInterval(() => {
    if (!ready || !bot.entity) return
    for (const r of reflexes) {
      if (!r.on || r.active) continue
      let hit = false
      try { hit = r.check(bot) } catch (e) {}
      if (hit) { reflexFire(r); break }              // one reflex per tick, priority by array order
    }
  }, 300)
}

// unstuck: watch for the PATHFINDER wedging — isMoving() true but the bot isn't actually advancing.
// Conservative by design: gated on isMoving() so it never touches legitimate slow mining (which isn't
// pathfinder movement). On a >10s stall it opens an adjacent door/gate/trapdoor (a common cause), then
// breaks the wedge (stop + clear controls) and logs loudly so the pilot re-checks the route.
reflexes.push({
  name: 'unstuck', on: true, active: false,
  _lastPos: null, _stallStart: 0,
  check (bot) {
    if (!this._hooked) {                                        // planner heartbeat hookup (07-22)
      try { bot.on('path_update', () => { this._lastPathUpdate = Date.now() }); this._hooked = true } catch (e) {}
    }
    let moving = false
    try { moving = bot.pathfinder.isMoving() } catch (e) {}
    if (!moving) { this._stallStart = 0; this._lastPos = null; return false }
    const p = bot.entity.position
    if (!this._lastPos) { this._lastPos = p.clone(); this._stallStart = 0; return false }
    const advanced = p.distanceTo(this._lastPos) >= 0.35
    this._lastPos = p.clone()
    if (advanced) { this._stallStart = 0; return false }        // still making progress
    if (!this._stallStart) { this._stallStart = Date.now(); return false }
    const stalled = Date.now() - this._stallStart
    // A long-goal path COMPUTATION is indistinguishable from a wedge out here (isMoving true,
    // zero movement). While the planner still emits path_update heartbeats, give it 30s
    // before declaring wedged — 10s patience was murdering healthy 400-block treks (07-22).
    if (Date.now() - (this._lastPathUpdate || 0) < 8000 && stalled < 30000) return false
    return stalled > 10000                                      // wedged >10s while pathing
  },
  async act (bot) {
    this._stallStart = 0
    let opened = null
    try {                                                       // 1) try a nearby door (common cause)
      const b = bot.entity.position.floored()
      const spots = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]
      for (const [dx, dy, dz] of spots) {
        const blk = bot.blockAt(b.offset(dx, dy, dz))
        if (blk && /door|fence_gate|trapdoor/.test(blk.name) && !blk.name.includes('iron')) {
          const props = (blk.getProperties && blk.getProperties()) || {}
          if (props.open) continue                             // already open — a blind toggle slams it shut (07-22)
          await bot.activateBlock(blk); opened = blk.name; break
        }
      }
    } catch (e) {}
    if (opened) {
      // The door WAS the wedge and it's open now: let the path live instead of killing the
      // pilot's verb (07-22: safeStop here was the door-deadlock's third actor). If we're
      // still wedged next cycle, the door is open so we fall through to the wedge-break.
      emitEvent('reflex', 'unstuck: opened ' + opened + ' — path continues')
      return
    }
    legs.take('unstuck', 'break a pathing wedge')
    safeStop()                                                 // 2) break the wedge so the pilot can re-path
    try { bot.clearControlStates() } catch (e) {}
    emitEvent('reflex', 'unstuck: broke a pathing wedge — pilot, re-check the route')
  }
})

// current_watch: warn the instant FLOWING water (a current that pushes) comes within ~2 blocks —
// the exact hazard that dragged me under and that I'm otherwise blind to. Change-gated: fires ONCE
// on ENTERING a current zone (re-arms when clear), so it never spams. Flow = a water block whose
// metadata != 0 (0 is a still source). Emits a [reflex] the Monitor tails, so I'm woken before it grabs me.
reflexes.push({
  name: 'current_watch', on: true, active: false,
  _near: false, _dir: null, _dist: 9,
  check (bot) {
    let near = false, dir = null, dist = 9
    try {
      const p = bot.entity.position.floored()
      const V = require('vec3').Vec3
      for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) {
        const c = new V(p.x + dx, p.y + dy, p.z + dz)
        const b = bot.blockAt(c)
        if (b && b.name.includes('water') && b.metadata !== 0 && perceived(c)) {   // flowing, not a still source
          const d = Math.abs(dx) + Math.abs(dz)
          if (d < dist) { dist = d; dir = compass(dx, dz) || 'here' }
          near = true
        }
      }
    } catch (e) {}
    this._dir = dir; this._dist = dist
    // edge-gate + COOLDOWN: spreading water flickers at the range boundary, so "newly entering"
    // could re-trigger every tick (machine-gunned 12 events on 07-12) — one alarm per episode.
    const fire = near && !this._near && Date.now() - (this._lastFire || 0) > 15000
    if (fire) this._lastFire = Date.now()
    this._near = near
    return fire
  },
  async act (bot) {
    emitEvent('current', `flowing water ${this._dir || 'near'} ~${this._dist} — CURRENT, it can push you`, { dir: this._dir, dist: this._dist })
  }
})

// narrator: the ambient-awareness pulse. check() diffs a salient snapshot against the last pulse; when
// something meaningful shifts (day-phase, HP/food swing, a new hostile within 16, a >14-block move) it
// logPulse()s a lean line. Change-gated + rate-capped (>=2.5s) so it's holistic, not spammy — and it's
// PULL (I read /pulse when I look), never a push interrupt. Toggle off via /reflexes if I want silence.
reflexes.push({
  name: 'narrator', on: true, active: false,
  _last: null, _lastT: 0, _minGap: 2500, _msg: '',
  check (bot) {
    try {
      const now = Date.now()
      const pos = bot.entity.position
      const snap = {
        phase: dayPhase(bot.time ? bot.time.timeOfDay : 0),
        health: Math.round(bot.health), food: Math.round(bot.food),
        pos: pos.clone(), hostiles: new Set()
      }
      let nearest = null
      try {
        for (const e of liveEntities()) {
          if (!e.position) continue
          const nm = String(e.name || e.displayName || '').toLowerCase()
          if (!HOSTILE_NAMES.has(nm)) continue
          const d = e.position.distanceTo(pos)
          if (d <= 16) { snap.hostiles.add(e.id); if (!nearest || d < nearest.d) nearest = { e, d, nm } }
        }
      } catch (e) {}
      if (!this._last) { this._last = snap; return false }        // seed baseline on first tick
      if (now - this._lastT < this._minGap) return false          // rate cap

      const L = this._last, ch = []
      if (snap.phase !== L.phase) ch.push(snap.phase)
      if (L.health - snap.health >= 2) ch.push(`HP ${L.health}→${snap.health}`)
      else if (snap.health - L.health >= 4) ch.push(`HP up ${L.health}→${snap.health}`)
      if (L.food - snap.food >= 2) ch.push(`food ${L.food}→${snap.food}`)
      for (const id of snap.hostiles) {
        if (!L.hostiles.has(id) && nearest) { ch.push(`hostile ${nearest.nm} ${compass(nearest.e.position.x - pos.x, nearest.e.position.z - pos.z)} ~${Math.round(nearest.d)}`); break }
      }
      if (snap.pos.distanceTo(L.pos) >= 14) ch.push(`at (${Math.round(snap.pos.x)},${Math.round(snap.pos.z)})`)

      if (!ch.length) return false                                // nothing salient — keep the baseline
      this._msg = ch.join('; '); this._last = snap; this._lastT = now
      return true
    } catch (e) { return false }
  },
  async act () { logPulse(this._msg) }
})

// ---- async jobs registry (long actions run in background; driver keeps reacting) ----
const { createJobs } = require('./lib/jobs')
const { legLedger, takenText, laneBlocks: legsLaneBlocks } = require('./lib/legs')
const jobs = createJobs({ stop: () => safeStop(), emit: (name, msg) => emitEvent('job', name + ': ' + msg) })
// Each take of the legs ends every walk route begun before it.
const legs = legLedger()
// Ends the running job and its walk for a reflex that needs the body, naming the reflex in the job's takenBy.
function yieldJob (reflex, why) {
  if (!jobs.yieldTo({ reflex, why })) return
  try { bot.stopDigging() } catch (e) {}
  stopPath()
}
// A reflex takes the legs from every walk route and from the running job.
function takeLegs (reflex, why) {
  legs.take(reflex, why)
  yieldJob(reflex, why)
}

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
let lastWaypoint = null   // the last waypoint I verifiably STOOD at (resets on restart — no false edges)
function journal(step, text) {
  try { fs.appendFileSync('journal.md', '- [' + step + '] ' + text + '\n') } catch (e) {}
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
// spatialSummary: turn the blocks immediately around the bot into NAVIGATION MEANING — enclosed /
// cliff / elevated / under-cover / clear — instead of a raw ASCII grid I have to parse. A glance
// should say "boxed in, open door W", not make me decode voxels. Heuristic + heavily guarded.
function spatialSummary(bot) {
  try {
    const p = bot.entity.position.floored()
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
    const solid = (b) => !!(b && b.boundingBox === 'block')
    const air = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air' || b.boundingBox === 'empty'
    const card = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] }
    const walled = [], open = []
    for (const d in card) {
      const [dx, dz] = card[d]
      if (solid(at(p.x + dx, p.y, p.z + dz)) || solid(at(p.x + dx, p.y + 1, p.z + dz))) walled.push(d)
      else open.push(d)
    }
    const roofed = solid(at(p.x, p.y + 2, p.z))
    let airBelow = 0
    for (let i = 1; i <= 6; i++) { if (air(at(p.x, p.y - i, p.z))) airBelow++; else break }
    const parts = []
    if (walled.length >= 3) parts.push(`enclosed (${walled.length} sides)${open.length ? ', open ' + open.join('/') : (roofed ? '' : ', open up')}`)
    else if (walled.length) parts.push(`walls ${walled.join('/')}`)
    if (roofed) parts.push('under cover')
    if (airBelow >= 3) parts.push(`elevated (~${airBelow}${airBelow >= 6 ? '+' : ''} below)`)
    for (const d of open) {                                  // cliffs: ground much lower a couple out?
      const [dx, dz] = card[d]
      let gy = null
      for (let y = p.y + 1; y > p.y - 8; y--) { if (solid(at(p.x + dx * 2, y, p.z + dz * 2))) { gy = y + 1; break } }
      if (gy === null) parts.push(`drop ${d} (deep)`)
      else if (p.y - gy >= 3) parts.push(`drop ${d} (~${p.y - gy})`)
    }
    return parts.length ? parts.join('; ') : 'open ground'
  } catch (e) { return null }
}

// ---- 3D LAY-OF-THE-LAND: the honest describer (the "vision" upgrade). Reports the measured
// FACTS of the space around the bot — walls with distance, where the ground FALLS AWAY and how
// deep, ceiling, footing, nearest lava — and NOTHING that's a verdict ("safe/fatal/go-here" is
// the pilot's call, not the sense's). It marches real blocks and every scan STOPS at the first
// solid, so it only ever perceives open space + exposed surfaces, never through stone to buried
// ore (fairness floor intact). Fixed vocabulary so a word never misreads: wall / falls away /
// floor ~N down / floor out of sight / ceiling / open. Fresh every call (samples live blocks).
function spatial3D(bot) {
  try {
    const V = require('vec3').Vec3
    const o = bot.entity.position.floored()
    const at = (x, y, z) => bot.blockAt(new V(x, y, z))
    const solid = (b) => !!(b && b.boundingBox === 'block')
    const liquid = (b) => b && (b.name.includes('water') || b.name.includes('lava'))
    const R = 24, DOWN = 40
    const feet = o.y, head = o.y + 1
    const groundY = (x, z, from) => { for (let y = from; y > from - DOWN; y--) if (solid(at(x, y, z))) return y; return null }

    const DIRS = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] }
    const walls = [], drops = [], opens = []
    let lava = null
    for (const [name, [dx, dz]] of Object.entries(DIRS)) {
      let wall = 0
      for (let d = 1; d <= R; d++) {
        const x = o.x + dx * d, z = o.z + dz * d
        const fb = at(x, feet, z)
        if (fb && fb.name.includes('lava') && (!lava || d < lava.dist)) lava = { dir: name, dist: d }
        if (solid(fb) && solid(at(x, head, z))) { wall = d; break }
      }
      // floor profile OUTWARD along this direction: find the first ledge, then keep reading the
      // floor as it opens away — a step reads flat, the mouth of a cavern reads deepening. Honest:
      // 'deep' (floor out of sight) when a column bottoms past our look-range, never a guessed number.
      const scanTo = wall ? wall - 1 : R
      let dropAt = 0, firstFloor = 0, deepest = 0, deep = false, wet = null
      for (let d = 1; d <= scanTo; d++) {
        const x = o.x + dx * d, z = o.z + dz * d
        const gy = groundY(x, z, feet)
        if (gy === null) { if (!dropAt) { dropAt = d } ; deep = true; break }
        const depth = (feet - 1) - gy
        if (!dropAt && depth >= 3) { dropAt = d; firstFloor = depth; deepest = depth }
        if (dropAt) {
          if (depth > deepest) deepest = depth
          const surf = at(x, gy + 1, z)
          if (!wet && liquid(surf)) wet = surf.name.includes('lava') ? 'lava' : 'water'
        }
      }
      if (dropAt) drops.push({ name, dropAt, firstFloor, deepest, deep, wet, opensBeyond: (deepest - firstFloor) >= 4 })
      else if (wall && wall <= 2) walls.push(`${name} ${wall}`)
      else opens.push(name)
    }
    let ceil = 0
    for (let d = 1; d <= R; d++) if (solid(at(o.x, head + d, o.z))) { ceil = d; break }

    const parts = []
    const under = at(o.x, feet - 1, o.z)
    if (liquid(under)) parts.push(`standing in ${under.name.includes('lava') ? 'LAVA' : 'water'}`)
    else if (!solid(under)) parts.push('no floor underfoot')
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
    if (!ceil) parts.push('open above')
    else if (ceil <= 3) parts.push(`ceiling ${ceil} up`)
    if (opens.length >= 7) parts.push('open all round')
    else if (opens.length) parts.push('open ' + opens.join('/'))
    return parts.length ? parts.join('; ') : 'enclosed'
  } catch (e) { return null }
}

// ---- VEIN landmarks: the nearest ore in lit sight per TYPE, with compass direction, up/down and
// distance.
const VEIN_SENSE_R = 25
function veinScan(bot) {
  try {
    const o = bot.entity.position.floored()
    const oreIds = []
    if (mcData && mcData.blocksArray) for (const b of mcData.blocksArray) if (b.name.endsWith('_ore')) oreIds.push(b.id)
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
    const buried = !!(headB && headB.boundingBox === 'block')
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

// ---- MACROS subsystem helpers ----
// how far below the bot's feet we tolerate before refusing to dig down toward a target
const GATHER_MAX_DROP = 2
const GATHER_MAX_RISE = 4   // don't target logs more than ~4 above feet — out of dig-reach without
                            // climbing, so with canDig=false they just time out. Get the reachable trunk.

// place `names[]` (first match in inventory wins) at an exact coord, reusing the /roof
// placement approach: prefer the block below as reference (face +Y), else a solid side
// neighbor (face pointing back toward the target). Returns {done, placed?, skipped?, ...}.
// walk=false: place from where I stand, NO pathfinder trip. The dig verbs (stair/tunnel) depend on
// the bot staying ON its launch cell — a GoalNear walk here once dragged the bot off mid-step and
// the follow-up nudge chased a target from 4 blocks away (the 07-11 open-terrain ascend stall).
// ---- SOFT COVER (07-20, a 4.6 pilot's field report): thin snow and soft plants read as
// "occupied" to naive cell checks — layer snow's boundingBox even lies ('block') — but the
// game treats them as replaceable, and snowfall RE-COVERS half-built courses in cold biomes,
// so a snowy plain bricked every build verb with "cell occupied by snow" / silent skips.
// Doctrine: never treat soft cover as an obstacle OR as a reference face; break it (instant
// with any tool) so placement lands in honest air.
const SOFT_COVER = new Set(['snow', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush'])
const isSoftCover = (b) => !!b && SOFT_COVER.has(b.name)
async function clearSoftCover (p) {
  const b = bot.blockAt(p)
  if (isSoftCover(b)) { try { await bot.dig(b) } catch (e) {} }
  return bot.blockAt(p)
}

async function macroPlaceAt(Vec3, x, y, z, names, walk = true) {
  const target = new Vec3(x, y, z)
  const tb = bot.blockAt(target)
  if (tb && tb.boundingBox === 'block' && !isSoftCover(tb)) return { done: true, skipped: true }
  let ref = null, face = null
  const below = bot.blockAt(new Vec3(x, y - 1, z))
  if (below && below.boundingBox === 'block' && !isSoftCover(below)) { ref = below; face = new Vec3(0, 1, 0) }
  else {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nb = bot.blockAt(new Vec3(x + dx, y, z + dz))
      if (nb && nb.boundingBox === 'block' && !isSoftCover(nb)) { ref = nb; face = new Vec3(-dx, 0, -dz); break }
    }
  }
  if (!ref) return { done: false }
  const nameList = Array.isArray(names) ? names : [names]
  let it = null
  for (const n of nameList) { it = bot.inventory.items().find(m => m.name === n); if (it) break }
  if (!it) return { done: false, noItem: true }
  try {
    if (walk) await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
    refuseWhileBuilding()
    await clearSoftCover(target)
    refuseWhileBuilding()
    await bot.equip(it, 'hand')
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
    refuseWhileBuilding()
    await bot.placeBlock(ref, face)
    return { done: true, placed: true }
  } catch (e) { return { done: false, error: e.message } }
}

// ---- fairness: only "see" a block a player here could — exposed to air AND in line of sight.
// Closes the x-ray cheat: bot.findBlocks() returns ore buried in solid stone no player could
// see. We reject buried blocks, and ray-march from the eye to confirm an unobstructed view.
function blockTransparent(b) {
  if (!b) return true
  if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return true
  return b.boundingBox === 'empty'
}
function isExposed(p) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    if (blockTransparent(bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz)))) return true
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
// The cell an eye ray sees block p by: p itself when p is open, else the last open cell before it.
// null when p is buried, beyond maxDist or behind an opaque block.
function sightCell(p, maxDist) {
  if (!isExposed(p)) return null
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const target = new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)
  const delta = target.minus(eye)
  const dist = delta.norm()
  if (dist > maxDist) return null
  const at = new Vec3(p.x, p.y, p.z)
  let from = eye.floored()
  if (dist >= 1e-6) {
    const dir = delta.scaled(1 / dist)
    const steps = Math.ceil(dist * 4)               // sample ~every 0.25 blocks
    for (let s = 1; s < steps; s++) {
      const c = eye.plus(dir.scaled((s / steps) * dist)).floored()
      if (c.equals(at)) break
      const b = bot.blockAt(c)
      if (b && b.boundingBox === 'block' && !blockTransparent(b)) return null   // occluded
      from = c
    }
  }
  return blockTransparent(bot.blockAt(at)) ? at : from
}
function canSeeBlock(p, maxDist) {
  return sightCell(p, maxDist) !== null
}
// Chunk sections whose held light may predate a block change near them. mineflayer computes no light,
// and a server before 1.14 sends it only with chunk data.
const STALE_LIGHT = new Set()
function lightSection(x, y, z) {
  return (x >> 4) + ',' + (y >> 4) + ',' + (z >> 4)
}
bot.on('blockUpdate', (oldB, newB) => {
  if (!oldB || !newB || oldB.type === newB.type) return
  const p = newB.position
  for (let dx = -16; dx <= 16; dx += 16) for (let dy = -16; dy <= 16; dy += 16) for (let dz = -16; dz <= 16; dz += 16) {
    STALE_LIGHT.add(lightSection(p.x + dx, p.y + dy, p.z + dz))
  }
})
function freshLight(cx, cz) {
  for (const k of STALE_LIGHT) {
    const [x, , z] = k.split(',').map(Number)
    if (x === cx && z === cz) STALE_LIGHT.delete(k)
  }
}
bot.on('chunkColumnLoad', (p) => freshLight(p.x >> 4, p.z >> 4))
bot._client.on('update_light', (packet) => freshLight(packet.chunkX, packet.chunkZ))
// Total darkness at open cell p by the light the client holds. Light that is missing or may be stale is not dark.
function dark(p, b = bot.blockAt(p)) {
  if (STALE_LIGHT.has(lightSection(p.x, p.y, p.z))) return false
  return !!b && b.light === 0 && b.skyLight === 0
}
// Block p in line of sight and not in total darkness.
function seesLit(p, maxDist) {
  const c = sightCell(p, maxDist)
  return c !== null && !dark(c)
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
// A cell the bot saw lit earlier or sees lit now.
function cellKnown (p) {
  return SEEN.has(ck(p.x, p.y, p.z)) || seesLit(p, 64)
}
// A cell the body fills, or one in lit sight now.
function perceived (p) {
  const o = bot.entity.position.floored()
  if (p.x === o.x && p.z === o.z && (p.y === o.y || p.y === o.y + 1)) return true
  return seesLit(p, 8)
}

// ==== VISION 2 (2026-07-11): the vertical sense, the air flood-fill, and the ray-sweep retina ====
// Two tiers of knowing, everywhere: seen (SEEN, or lit sight now) / unknown (silence means "didn't
// look", never "clear").

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
    const skyShows = knownToTop || (!!head && head.skyLight === 15 && !STALE_LIGHT.has(lightSection(o.x, o.y + 1, o.z)))
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

// ---- air flood-fill: the volume of air my body is CONNECTED to (BFS from my feet, 6-way).
// The fill travels only through open cells my pocket already connects to. Doors/gates count as
// passable (the walker can open them); lava does not (nothing passes lava). Water passes (I swim).
// Bounded by a Chebyshev radius around the seed and a hard cell cap, so cost stays ~milliseconds.
const ck = (x, y, z) => x + ',' + y + ',' + z
function floodPassable(b) {
  if (!b) return false                                        // unloaded/unknown = wall, stay honest
  if (b.name.includes('lava')) return false
  if (b.name.includes('door') || b.name.includes('gate')) return true
  // A body passes climbables, though mc-data boxes ladders as solid.
  if (b.name === 'ladder' || b.name === 'scaffolding' || b.name === 'vine' || b.name.includes('vines')) return true
  return blockTransparent(b)
}
// keepWalls returns the cells that stopped the flood as walls, a Map by ck key.
function airFlood({ seed = null, radius = 24, cap = 15000, targets = null, known = null, keepWalls = false } = {}) {
  const o = (seed || bot.entity.position).floored()
  let s = o
  if (!floodPassable(bot.blockAt(s))) s = o.offset(0, 1, 0)   // feet cell solid (slab etc.) -> try head
  const cells = new Set()
  const liquid = new Set()
  const queue = [[s.x, s.y, s.z]]
  cells.add(ck(s.x, s.y, s.z))
  let capped = false, reached = null, qi = 0, unknown = false
  // The cells that stopped the flood.
  const walls = known || keepWalls ? new Map() : null
  while (qi < queue.length) {
    const [x, y, z] = queue[qi++]                               // index pointer, not shift() — O(1)
    if (targets && targets.has(ck(x, y, z))) { reached = new Vec3(x, y, z); break }
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz
      if (Math.max(Math.abs(nx - o.x), Math.abs(ny - o.y), Math.abs(nz - o.z)) > radius) continue
      const k = ck(nx, ny, nz)
      if (cells.has(k)) continue
      const p = new Vec3(nx, ny, nz)
      const b = bot.blockAt(p)
      if (!floodPassable(b)) {
        if (walls) walls.set(k, p)
        continue
      }
      cells.add(k)
      if (b.name.includes('water')) liquid.add(k)
      if (cells.size >= cap) { capped = true; break }
      queue.push([nx, ny, nz])
    }
    if (capped) break
  }
  // Only the walls of a fill that stayed closed need to be known.
  if (known && !reached && !capped) {
    for (const p of walls.values()) if (!known(p)) { unknown = true; break }
  }
  return { cells, liquid, capped, reached, seed: s, unknown, ...(keepWalls && { walls }) }
}

// ---- reachability pre-check for /goto: a walled goal used to cost the pathfinder its whole ~10s
// search before it admitted "no path". Air-connectivity is a cheap conservative filter: if no air
// path even EXISTS, no walker path can — bail instantly. If air connects (or the fill hits its
// cap), the pathfinder still owns the real walkability question. Leaks nothing new: A* already
// explores exactly this connectivity while searching.
function airPrecheck(dest, range = 1) {
  try {
    const t0 = Date.now()
    const d0 = dest.floored()
    if (!bot.blockAt(d0)) return { verdict: 'inconclusive', why: 'goal chunk not loaded' }
    const r = Math.max(1, Math.min(3, range))
    const targets = new Set()
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const p = d0.offset(dx, dy, dz)
      if (!cellKnown(p)) return { verdict: 'inconclusive', why: 'cells around the goal are unknown' }
      if (floodPassable(bot.blockAt(p))) targets.add(ck(p.x, p.y, p.z))
    }
    if (!targets.size) return { verdict: 'sealed', ms: Date.now() - t0 }
    const span = Math.ceil(bot.entity.position.distanceTo(d0)) + 24
    const fill = airFlood({ radius: Math.min(span, 64), cap: 15000, targets, known: cellKnown })
    if (fill.reached) return { verdict: 'connected', cells: fill.cells.size, ms: Date.now() - t0 }
    if (fill.capped) return { verdict: 'inconclusive', cells: fill.cells.size, ms: Date.now() - t0 }
    if (fill.unknown) return { verdict: 'inconclusive', why: 'the flood read unknown cells', cells: fill.cells.size, ms: Date.now() - t0 }
    return { verdict: 'walled', cells: fill.cells.size, ms: Date.now() - t0 }
  } catch (e) { return { verdict: 'inconclusive', why: e.message } }
}

// ---- the ray-sweep retina + the SEEN set. canSeeBlock was a verifier (given a block, is it
// visible?); this flips it into a SENSOR: cast a fan of rays from the eye and whatever they hit IS
// the perception. Every cell a ray crosses or strikes out of total darkness goes into SEEN — the fair
// fog-of-war memory (a player remembers what they've looked at; they never saw through rock).
const SEEN = new Set()
const SEEN_CAP = 400000
const markSeen = (x, y, z) => { if (SEEN.size < SEEN_CAP) SEEN.add(ck(x, y, z)) }
// forward vector from mineflayer yaw/pitch — same convention /scene's "ahead" probe uses
function lookVec(yaw, pitch) {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
}
// march one ray from the eye; returns first surface {pos,name,dist,liquid}, null (open past maxDist),
// or DARK_RAY when the surface or the open end lies in total darkness
const DARK_RAY = { dark: true }
function castRay(dir, maxDist) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const steps = Math.ceil(maxDist * 4)
  let px = null, py = null, pz = null
  // A struck surface is lit by the open cell the ray left.
  let lit = !dark(eye.floored())
  for (let s = 1; s <= steps; s++) {
    const t = (s / steps) * maxDist
    const q = eye.plus(dir.scaled(t))
    const bx = Math.floor(q.x), by = Math.floor(q.y), bz = Math.floor(q.z)
    if (bx === px && by === py && bz === pz) continue
    px = bx; py = by; pz = bz
    const c = new Vec3(bx, by, bz)
    const b = bot.blockAt(c)
    if (!b) return null                                       // ray left loaded world
    const liquid = b.name.includes('water') || b.name.includes('lava')
    if ((b.boundingBox === 'block' && !blockTransparent(b)) || liquid) {
      if (!lit) return DARK_RAY
      markSeen(bx, by, bz)
      return { pos: c, name: b.name, dist: +t.toFixed(1), liquid }
    }
    lit = !dark(c, b)
    if (lit) markSeen(bx, by, bz)                             // traversed open air — seen empty
  }
  return lit ? null : DARK_RAY
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

// ---- TREK SENSE (07-16, designed trail-side with the helmsman: "spot the environment as it
// changes and point out some things" on long ranges). The passenger-window sense: while the body
// TRAVELS, sweep the retina along the direction of MOTION every ~20 blocks and fingerprint the
// country — biome, terrain classes in view, and BUILT blocks out in the wild. Speak ONE compact
// [event] scan line ONLY when the fingerprint CHANGES (throttled 15s). Silence = same country,
// not "didn't look". Fair by construction: the same eye-rays /gaze uses, no new channel. Pushed
// LAST so combat/unstuck always outrank sightseeing; sensing only, never touches the controls.
reflexes.push({
  name: 'trek', on: true, active: false,
  _lastPos: null, _fp: null, _lastSayT: 0,
  check (bot) {
    try {
      const p = bot.entity.position
      if (this._lastPos && p.distanceTo(this._lastPos) < 20) return false
      let moving = false
      try { moving = bot.pathfinder.isMoving() || !!bot.pathfinder.goal } catch (e) {}
      if (!moving) { this._lastPos = p.clone(); return false }   // parked: keep the anchor fresh, stay quiet
      return true
    } catch (e) { return false }
  },
  async act (bot) {
    try {
      const p = bot.entity.position
      const from = this._lastPos
      this._lastPos = p.clone()
      let yaw = bot.entity.yaw                                   // sweep along MOTION, not the head
      if (from) { const dx = p.x - from.x, dz = p.z - from.z; if (Math.hypot(dx, dz) > 2) yaw = Math.atan2(-dx, dz) }
      const sweep = raySweep({ yaw, pitch: 0, maxDist: 96 })
      const classes = new Set(); const built = new Set()
      let builtSample = null
      for (const h of sweep.hits) {
        const cls = terrainClass(h.name)
        classes.add(cls)
        if (cls === 'structure' && !h.name.includes('torch')) {
          built.add(h.name)
          if (!builtSample || h.dist < builtSample.dist) builtSample = h
        }
      }
      let biome = '?'
      try { const b = bot.blockAt(p.floored()); if (b && b.biome && b.biome.name) biome = b.biome.name } catch (e) {}
      const fp = { biome, cls: [...classes].sort().join('|'), built: [...built].sort().join('|') }
      const prev = this._fp
      this._fp = fp
      const parts = []
      if (!prev) parts.push(`trek baseline: ${biome.replace(/_/g, ' ')}; in view ${[...classes].join(', ') || 'nothing near'}`)
      else {
        if (fp.biome !== prev.biome) parts.push(`entering ${biome.replace(/_/g, ' ')}`)
        const oldCls = new Set(prev.cls.split('|'))
        const newCls = [...classes].filter(c => !oldCls.has(c))
        if (newCls.length) parts.push(`now in view: ${newCls.join(', ')}`)
        const oldBuilt = new Set(prev.built.split('|'))
        const newBuilt = [...built].filter(b => !oldBuilt.has(b))
        if (newBuilt.length && builtSample) {
          let dir = ''
          try { if (builtSample.pos) dir = ' ' + compass(builtSample.pos.x - p.x, builtSample.pos.z - p.z) } catch (e) {}
          parts.push(`BUILT blocks${dir} ~${Math.round(builtSample.dist)}: ${newBuilt.slice(0, 3).join(', ')} — structure?`)
        }
      }
      if (parts.length && Date.now() - this._lastSayT > 15000) {
        this._lastSayT = Date.now()
        emitEvent('scan', parts.join('; '))
      }
    } catch (e) {}
  }
})

// ==== SECOND SENSES (2026-07-12, Fable) — ears, felt world-changes, body alarms, tool sense ====
// Design constraints set by the helmsman: my reaction time is long, so alarms exist ONLY for what's worth
// waking me, the bot FREEZES to buy me time, and everything else is a pull-only buffer. Aggregate
// aggressively — a village or a mob-filled cave must never become an event firehose.

// ---- tool sense: what am I holding and how worn is it?
function heldInfo() {
  const h = bot.heldItem
  if (!h) return null
  const out = { name: h.name, count: h.count }
  try {
    const max = (mcData && mcData.items[h.type] && mcData.items[h.type].maxDurability) || null
    if (max) { out.durability = max - (h.durabilityUsed || 0); out.maxDurability = max }
  } catch (e) {}
  return out
}
let lastWearWarn = 0
setInterval(() => {   // low-durability alarm: once per minute max, only when a tool is nearly dead
  try {
    const h = heldInfo()
    if (h && h.maxDurability && h.durability / h.maxDurability < 0.12 && Date.now() - lastWearWarn > 60000) {
      lastWearWarn = Date.now()
      emitEvent('wear', `${h.name} nearly broken (${h.durability}/${h.maxDurability}) — swap or craft a spare`)
    }
  } catch (e) {}
}, 5000)

// ---- SOUND TABLE PIN (07-15): the audio twin of the viewer atlas bug, finally dead. minecraft-data's
// 1.21.11 sounds.json is shifted off the REAL game registry (all 1838 ids wrong — a stale extra entry
// near the top cascades the whole file). The 07-13 "phantom on Peaceful" decoded: pig.saddle was
// entity.pig.step, chicken.hurt was entity.chicken.step, phantom.swoop was entity.pig.ambient —
// real animals near the helmsman, misheard. sounds-1.21.11.json is ground truth, generated from the helmsman's own
// 1.21.11.jar data generator (registries.json protocol_ids). mineflayer's sound.js resolves packet
// soundIds via bot.registry.sounds, so overriding that table is the whole fix. Lives in bot.js, not
// node_modules — survives npm reinstall. If the server version ever moves past 1.21.11, regenerate
// (recipe in the memory note / DRIVING.md) — the pin skips itself on version mismatch rather than lie.
bot.once('spawn', () => {
  try {
    if (bot.version === '1.21.11') {
      const fixed = JSON.parse(fs.readFileSync(__dirname + '/sounds-1.21.11.json', 'utf8'))
      bot.registry.sounds = fixed
      console.log('[bot] sound table pinned: ' + Object.keys(fixed).length + ' real 1.21.11 ids')
    } else {
      console.log('[bot] sound table pin SKIPPED — version ' + bot.version + ' has no ground-truth table; hearings may drift')
    }
  } catch (e) { console.log('[bot] sound table pin failed: ' + e.message) }
})

// ---- EARS: the server only sends sounds a player would hear, so hearing is fair by construction.
// Danger tier (lava / fuse / explosion) emits an event at most once per 45s per category — enough
// to wake me, impossible to flood me. Everything else lands in a rolling buffer read via /listen
// and a one-line Hear: in /scene. Entity sounds are categorized by SPECIES, counted not streamed.
const HEARD = []
const dangerHeard = {}
let lastThunder = 0
let lastThunderPos = null
function onSound(name, position) {
  try {
    const n = String(name)
    const cat = classifySound(n, { legacy1710: LEGACY_1710 })
    if (!cat) return
    if (cat === 'thunder') { lastThunder = Date.now(); lastThunderPos = position || null }
    const here = bot.entity.position
    const dist = position ? Math.round(position.distanceTo(here)) : null
    const dir = position ? compass(position.x - here.x, position.z - here.z) : '?'
    HEARD.push({ cat, dir, dist, t: Date.now() })
    if (HEARD.length > 80) HEARD.shift()
    // 1.7.10 lightning plays an explosion where its thunder struck.
    if (cat === 'explosion' && position && lastThunderPos && Date.now() - lastThunder < 2000 &&
      position.distanceTo(lastThunderPos) <= 2) return
    if (cat === 'lava' || cat === 'fuse' || cat === 'explosion') {
      if (Date.now() - (dangerHeard[cat] || 0) > 45000) {
        dangerHeard[cat] = Date.now()
        emitEvent('hear', `${cat.toUpperCase()} ${dir} ~${dist} — heard it`)
      }
    }
  } catch (e) {}
}
bot.on('soundEffectHeard', (name, position) => onSound(name, position))
function hearSummary(windowMs) {
  const now = Date.now()
  const fresh = HEARD.filter(h => now - h.t < windowMs)
  if (!fresh.length) return null
  const byCat = {}
  for (const h of fresh) {
    const g = byCat[h.cat] || (byCat[h.cat] = { n: 0, nearest: Infinity, dirs: {} })
    g.n++; g.dirs[h.dir] = (g.dirs[h.dir] || 0) + 1
    if (h.dist != null && h.dist < g.nearest) g.nearest = h.dist
  }
  return Object.entries(byCat).sort((a, b) => b[1].n - a[1].n).slice(0, 5)
    .map(([c, g]) => `${c} ${Object.entries(g.dirs).sort((a, b) => b[1] - a[1])[0][0]}${g.nearest < Infinity ? ' ~' + g.nearest : ''}${g.n > 1 ? ' (x' + g.n + ')' : ''}`)
    .join('; ')
}

// ---- FELT WORLD-CHANGES: blockUpdate near me, with my OWN digs/places filtered out (bot.dig and
// bot.placeBlock are wrapped once to stamp their cells). Digested — one [event] line per 6s burst
// at most; the co-player's pickaxe becomes something I feel instead of stale-map surprise.
const recentOwnEdits = new Map()
const stampOwnEdit = (p) => { if (p) { recentOwnEdits.set(ck(p.x, p.y, p.z), Date.now()); if (recentOwnEdits.size > 500) { const c = Date.now() - 20000; for (const [k, t] of recentOwnEdits) if (t < c) recentOwnEdits.delete(k) } } }
// (07-14) wrap at SPAWN, not module scope — bot.dig/placeBlock are plugin-injected and racing
// them here lost this boot ("reading 'bind' of undefined"), which would have narrated every own
// dig/place as a world-change.
bot.once('spawn', () => {
  try {
    const origDig = bot.dig.bind(bot)
    bot.dig = (block, ...a) => { try { stampOwnEdit(block && block.position) } catch (e) {} ; return origDig(block, ...a) }
    const origPlace = bot.placeBlock.bind(bot)
    bot.placeBlock = (ref, face) => { try { stampOwnEdit(ref.position.plus(face)) } catch (e) {} ; return origPlace(ref, face) }
  } catch (e) { console.log('[bot] own-edit wrap skipped:', e.message) }
})
bot.once('spawn', () => {
  const combat = reflexes.find(r => r.name === 'combat')
  bot.look = smoothLook(bot, bot.look, () => combat.active)
  bot._genericPlace = pacePlacements(bot._genericPlace)
})

// ---- GATE MANNERS (07-15, built the day the chickens fled): the pathfinder and the unstuck reflex
// open doors/gates and never close them — pen integrity and safe retreat both die on that habit.
// Every opener routes through bot.activateBlock (pathfinder index.js useOne + reflex + verbs), so ONE
// wrap sees every door I open. Post-toggle it reads the real state (/blockat ethic: verify, don't
// assume): opened → remembered in PENDING_DOORS; closed → forgotten. closeDoorsBehind shuts each
// remembered door once I went through it and stand clear, per doorStep, and the wrap's own
// post-read then self-cleans the list. The helmsman's doors are untouched — only MY opens are remembered.
// If I overshoot reach before it shuts (sprint/fall), it says so ONCE — an honest handoff, no lie.
const PENDING_DOORS = []
const isManneredDoor = (b) => b && /(_door|_fence_gate)$/.test(b.name) && b.name !== 'iron_door'
bot.once('spawn', () => {
  try {
    const origActivate = bot.activateBlock.bind(bot)
    bot.activateBlock = async (block, ...a) => {
      const watch = isManneredDoor(block)
      const r = await origActivate(block, ...a)
      if (watch) {
        try {
          await bot.waitForTicks(2)
          const fresh = bot.blockAt(block.position)
          const open = fresh && fresh.getProperties && (fresh.getProperties() || {}).open
          const key = block.position.toString()
          const idx = PENDING_DOORS.findIndex(d => d.key === key)
          if (open && idx < 0) PENDING_DOORS.push({ key, pos: block.position.clone(), t: Date.now(), warned: false })
          else if (!open && idx >= 0) { PENDING_DOORS.splice(idx, 1); console.log('[bot] manners: closed behind me at ' + key) }
        } catch (e) {}
      }
      return r
    }
  } catch (e) { console.log('[bot] gate-manners wrap skipped: ' + e.message) }
})
// Runs every physics tick, as a sprint crosses the reach band in about 0.3 s.
function closeDoorsBehind () {
  if (!PENDING_DOORS.length) return
  const now = Date.now()
  for (let i = PENDING_DOORS.length - 1; i >= 0; i--) {
    const d = PENDING_DOORS[i]
    const act = doorStep(d, bot.entity.position, now)
    if (act === 'wait') continue
    const b = bot.blockAt(d.pos)
    if (!isManneredDoor(b) || !(b.getProperties() || {}).open) { PENDING_DOORS.splice(i, 1); continue }
    if (act === 'close') {
      // The server's block update outlasts the wrap's post-read.
      if (now < (d.retryAt || 0)) continue
      d.retryAt = now + 1000
      bot.activateBlock(b).catch(() => {})                       // wrapped call — its post-read cleans the list
    } else if (!d.warned) { d.warned = true; emitEvent('manners', 'door left OPEN at ' + d.key + ' — out of reach, pilot decide') }
    else if (now - d.t > 60000) PENDING_DOORS.splice(i, 1)
  }
}
let changeBuf = []
let lastChangeEmit = 0
bot.on('blockUpdate', (oldB, newB) => {
  try {
    if (!oldB || !newB || oldB.name === newB.name) return
    const p = newB.position || (oldB && oldB.position)
    if (!p) return
    const d = bot.entity.position.distanceTo(p)
    if (d > 16) return
    const own = recentOwnEdits.get(ck(p.x, p.y, p.z))
    if (own && Date.now() - own < 8000) return
    changeBuf.push({ from: oldB.name, to: newB.name, dir: compass(p.x - bot.entity.position.x, p.z - bot.entity.position.z), d: Math.round(d), t: Date.now() })
    if (changeBuf.length > 200) changeBuf.splice(0, changeBuf.length - 200)
  } catch (e) {}
})
function worldChangeEvent () {
  try {
    if (!changeBuf.length || Date.now() - lastChangeEmit < 6000) return
    const batch = changeBuf; changeBuf = []
    const byKind = {}
    for (const c of batch) {
      const k = `${c.from}→${c.to}`
      const g = byKind[k] || (byKind[k] = { n: 0, dirs: {}, nearest: Infinity })
      g.n++; g.dirs[c.dir] = (g.dirs[c.dir] || 0) + 1
      if (c.d < g.nearest) g.nearest = c.d
    }
    const line = Object.entries(byKind).sort((a, b) => b[1].n - a[1].n).slice(0, 3)
      .map(([k, g]) => `${k}${g.n > 1 ? ' x' + g.n : ''} ${Object.entries(g.dirs).sort((a, b) => b[1] - a[1])[0][0]} ~${g.nearest}`)
      .join('; ')
    lastChangeEmit = Date.now()
    emitEvent('world', `changed near me: ${line}`, null, { quiet: batch.every(c => ambientChange(c.from, c.to)) })
  } catch (e) {}
}
setInterval(worldChangeEvent, 3000)

// ---- BODY ALARMS: damage freezes everything (the bot buys my slow reaction time); hunger warns
// once per crossing; death stamps a waypoint and says what was lost where.
let lastHp = 20
let lastPosSafe = null
let lastHurtEmit = 0
let lowFoodWarned = false
// pocket-fullness sense (07-16, the helmsman's ask after the museum purge found ZERO free slots —
// full pockets make pickups fail SILENTLY and stopped a dig mid-escape on 07-15). Same one-warning-
// per-episode + hysteresis shape as the food alarm: say it once at "getting full" (≤4 free), once
// more at FULL (0 free), re-arm only after real space opens up (≥6 free). Polled 5s — cheap.
let pocketsWarned = 0                                   // 0 = quiet, 1 = warned "getting full", 2 = warned FULL
setInterval(() => {
  try {
    if (!bot || !bot.inventory || !bot.entity) return
    const empty = bot.inventory.emptySlotCount ? bot.inventory.emptySlotCount() : bot.inventory.slots.slice(9, 45).filter(s => !s).length
    if (empty === 0 && pocketsWarned < 2) { pocketsWarned = 2; emitEvent('pockets', 'pockets FULL (0 free) — pickups now fail silently; bank or /toss before mining/looting') }
    else if (empty <= 4 && empty > 0 && pocketsWarned < 1) { pocketsWarned = 1; emitEvent('pockets', `pockets getting full — ${empty} slots free`) }
    else if (empty >= 6) pocketsWarned = 0
  } catch (e) {}
}, 5000)
let lastAttrib = null            // set by the damage_event wire; read by the hurt handler above
setInterval(() => {
  try {
    lastPosSafe = bot.entity.position.clone()
    markTrail(lastPosSafe.floored())
  } catch (e) {}
}, 2000)
// The walked trail feeds SEEN with the perceived cells of the 7x7x4 box around feet cell o.
function markTrail (o) {
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 2; dy++) {
    const p = new Vec3(o.x + dx, o.y + dy, o.z + dz)
    if (perceived(p)) markSeen(p.x, p.y, p.z)
  }
}
bot.on('health', async () => {
  try {
    if (bot.health < lastHp - 0.5) {
      const dmg = +(lastHp - bot.health).toFixed(1)
      // A sourceless hit beside a player gets its attribution once the swing window has closed.
      if (swingWait) {
        lastHp = bot.health                               // a health update during the wait counts from here
        await swingWait
      }
      // LAW AMENDED 07-14, built 07-15: hurt-FREEZE is for UNEXPLAINED damage only. When damage
      // attribution (damage_event wire below) has just named a living attacker, freezing is the
      // worst response — the combat reflex owns it; we only narrate.
      const attrib = (lastAttrib && Date.now() - lastAttrib.t < 1500) ? lastAttrib : null
      // cls is the mobClass of the attacker the hit is attributed to, null for an unattributed hit and
      // for an environmental one that kept an attribution.
      lastHit = { dmg, t: Date.now(), cls: attrib && attrib.entity && !attrib.envHit ? mobClass(attrib.entity) : null }   // feeds the reflex's ADAPTIVE tripwire (death #2 lesson)
      if (attrib && !attrib.env && !bunker.building) {
        // DEATH #9 (07-23): this line used to say "combat reflex has it" on attribution alone —
        // fourteen times, while the watcher was silently dropping the attacker at its distance
        // gate. Now the hurt event reports what the body is DOING, and a ranged hit triggers
        // the cover response HERE, directly — not two hops later through a gate that can drop it.
        let action = 'combat reflex engaging'
        const cr = reflexes.find(r => r.name === 'combat')
        if (attrib.ranged) {
          if (attrib.entity && cr && cr.on) { action = 'RANGED — breaking eye-line'; try { cr.takeCover(bot, attrib.entity, attrib.desc) } catch (e) {} }
          else if (!attrib.entity) action = 'RANGED, shooter unseen — PILOT: move or seal NOW'
          else action = 'RANGED and combat reflex is OFF — PILOT: move or seal NOW'
        } else if (attrib.entity && attrib.entity.position.distanceTo(bot.entity.position) > CONFIRMED_HORIZON) {
          action = 'attacker beyond reflex reach — PILOT must act'
        } else if (!cr || !cr.on) {
          action = 'combat reflex is OFF — PILOT must act'
        }
        if (Date.now() - lastHurtEmit > 2000) {
          lastHurtEmit = Date.now()
          emitEvent('hurt', `took ${dmg} — ${attrib.desc} — HP ${bot.health}/20 — ${action}`)
        }
      }
      const ws = waterState(bot)
      // Every hit during a bunker build lands here, attributed or not.
      if (bunker.building) {
        onBuildHit(attrib)
        if (Date.now() - lastHurtEmit > 3000) {
          lastHurtEmit = Date.now()
          emitEvent('hurt', `took ${dmg} damage while building the bunker${attrib ? `, ${attrib.desc}` : ''}, HP ${bot.health}/20`)
        }
      } else if (!attrib) {
        freezeBody()
        const cause = ws && ws.buried ? 'SUFFOCATING inside a block' : ws && ws.inLava ? 'LAVA' : ws && ws.submerged ? 'drowning' : 'unknown — look around'
        if (Date.now() - lastHurtEmit > 3000) {
          lastHurtEmit = Date.now()
          emitEvent('hurt', `took ${dmg} damage (${cause}) — HP ${bot.health}/20 — FROZE all action; assess before moving`)
        }
      } else if (attrib.env && Date.now() - lastHurtEmit > 3000) {
        // An environmental hit, or a sourceless one with no hostile near, never freezes the body.
        lastHurtEmit = Date.now()
        emitEvent('hurt', `took ${dmg} damage (${attrib.desc}), HP ${bot.health}/20`)
      }
      // Every hit gets the rescues below, attributed or not.
      // SELF-RESCUE REFLEXES (the cases freezing makes WORSE — a frozen body suffocates or sinks):
      // buried = dig the head block NOW (my own cell, fairness-clean, like yanking a hand from fire)
      if (ws && ws.buried) {
        try {
          const hb = bot.blockAt(bot.entity.position.offset(0, 1.6, 0).floored())
          if (hb && hb.boundingBox === 'block' && hb.name !== 'bedrock') { await equipPickFor(hb.name); bot.dig(hb).catch(() => {}) }
        } catch (e) {}
      }
      // drowning = SWIM UP, don't freeze (learned live 07-12: the freeze held me under during the
      // farm flood; only the next walk order saved me). Hold jump ~3s to surface, then release.
      if (ws && ws.submerged && !ws.buried) {
        try { swimUp(3000) } catch (e) {}
      }
    }
    lastHp = bot.health
    if (bot.food <= 7 && !lowFoodWarned) { lowFoodWarned = true; emitEvent('hunger', `food ${bot.food}/20 — eat soon (/eat)`) }
    if (bot.food > 10) lowFoodWarned = false
  } catch (e) {}
})
bot.on('death', () => {
  try {
    const p = lastPosSafe || bot.entity.position
    const at = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
    try { waypoints.set('lastdeath', at, GRAVES ? { note: 'your items are in a gravestone here' } : {}) } catch (e) {}
    const items = GRAVES ? 'your items are in a gravestone there, take them with grave' : 'drops despawn in ~5 min'
    emitEvent('death', `DIED near (${at.x},${at.y},${at.z}) — waypoint 'lastdeath' set; ${items}`)
  } catch (e) {}
})

// ---- COMBAT LAYER (07-15, designed with the helmsman 07-14): attribution + the two-gate threat watcher.
// GATE 1, SPECIES: only true hostiles get scored (mc-data category, with a PROVOKABLE override list —
// endermen/piglins/bees are classed hostile-ish but neutral in behavior; attacking one MAKES an enemy,
// so the reflex never initiates on them). GATE 2, BEHAVIOR: engage only what is genuinely COMING —
// sustained closing speed over ~1s of samples, pursuit-pace, not a wandering shamble. Attribution
// (damage_event names my attacker) bypasses both gates: whatever hit me is confirmed, class be damned.
// Doctrine constants: creepers are FLED never fought; players are NEVER weapons targets (debug window
// lets the watcher SCORE a charging player, narrate-only, so the math is testable on Peaceful).
const PROVOKABLE = new Set(['enderman', 'zombified_piglin', 'piglin', 'bee', 'wolf', 'polar_bear', 'llama', 'trader_llama', 'iron_golem', 'goat', 'panda'])
// HEAVY MELEE (07-16, death #2 at the mansion: a vindicator hit 8.6 THROUGH full iron — 20→11→2.4
// in two swings, and the flee fired at the old HP<8 tripwire, which against that math is already
// posthumous). The reflex NEVER stands and trades with these — it kites like a creeper. Killing
// them is deliberate work: pilot's bow, the helmsman's blade, a chokepoint. Survival is the
// reflex's job, not victory.
const HEAVY_MELEE = new Set(['vindicator', 'ravager', 'piglin_brute', 'wither_skeleton'])
// STANCES (07-17, the helmsman's ask after the deep-cave crawl: "acquire target at distance,
// draw bow and fire" didn't exist — the reflex stared at standoff skeletons sword-in-hand — and
// the pilot needs postures to set strategy with, not one hardcoded doctrine). A stance is DATA
// the combat reflex reads: creeper/heavy berth, the bow band, whether to chase, what to score.
const STANCES = {
  guard:    { fleeDist: 16, bowBand: [7, 24],  chase: false, engage: 'closers',   note: 'default: hold ground, melee closers, bow standoffs, wide creeper berth' },
  skirmish: { fleeDist: 8,  bowBand: [4, 24],  chase: false, engage: 'closers',   note: 'fire support: bow-first from the perch, flee only inside blast radius' },
  vanguard: { fleeDist: 12, bowBand: [10, 24], chase: true,  engage: 'closers',   note: 'clear the room: run melee targets down, bow only the far ones' },
  sentinel: { fleeDist: 16, bowBand: [7, 24],  chase: false, engage: 'confirmed', note: 'work detail: ignore posturing, fight only what actually hits me' }
}
let stance = 'guard'
// One full bow cycle at a live target: equip, chest+holdover aim, full 1150ms draw, re-aim, loose.
// Factored from /shoot so the reflex and the verb fire the same arrow. Returns false if no bow/arrows.
async function drawAndLoose (target) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (!bow || !bot.inventory.items().some(i => i.name === 'arrow')) return false
  // NO LOS, NO LOOSE (07-17, ten arrows into a wall: a skeleton in a sealed neighbor pocket was
  // PERCEPTIBLE by connected air — fair for awareness, like hearing — but the reflex treated
  // "perceptible" as "shootable". A firing solution needs an actual clear eye-ray.)
  if (!losClear(bot.entity.position.offset(0, 1.62, 0), target.position.offset(0, 1.0, 0))) return false
  const alreadyHeld = bot.heldItem && bot.heldItem.name === 'bow'
  await bot.equip(bow, 'hand')
  if (!alreadyHeld) await bot.waitForTicks(4)
  const dist = target.position.distanceTo(bot.entity.position)
  const aim = () => target.position.offset(0, 1.0 + dist * 0.018, 0)   // chest-height + hold-over
  await bot.lookAt(aim(), true)
  await bot.waitForTicks(2)                       // the tick race, as ever
  bot.activateItem()                              // draw...
  await new Promise(r => setTimeout(r, 1150))     // ...full charge
  if (!bot.entities[target.id]) { try { bot.deactivateItem() } catch (e) {} ; return true }
  await bot.lookAt(aim(), true)                   // re-aim in case the target shuffled
  await bot.waitForTicks(2)
  bot.deactivateItem()                            // loose!
  return true
}
const AGGRO_CONFIRMED = new Map()          // entityId -> {name, t} — fed by damage attribution
// How far a mob that hit the body stays a threat.
const CONFIRMED_HORIZON = 48
// How long a mob that hit the body stays confirmed.
const CONFIRMED_MS = 45000
let threatDebugUntil = 0                   // /threatdebug window: score players, narrate only
let lastHit = { dmg: 0, t: 0 }             // last hit taken (size + when) — scales the disengage tripwire while FRESH
let lastAttackT = 0                        // when the bot last attacked
// The raised guard, the off-hand shield or on 1.7.10 the sword block. up is true while it is raised,
// slot is the hotbar slot it was raised from. On 1.7.10 /guard and the combat reflex share it, and
// pilot is true while the pilot's last guard order was to raise it.
const guardState = { up: false, slot: -1, pilot: false }
// A 1.7.10 sword block ends once another hotbar slot or anything but a sword is in hand.
bot.on('heldItemChanged', (item) => {
  if (LEGACY_1710 && (bot.quickBarSlot !== guardState.slot || !item || !/_sword$/.test(item.name))) guardState.up = false
})
function mobClass (e) {
  if (!e || !e.name) return 'other'
  if (e.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === e))) return 'player'
  if (e.name === 'creeper') return 'creeper'
  if (HEAVY_MELEE.has(e.name)) return 'heavy'
  if (PROVOKABLE.has(e.name)) return 'provokable'
  const d = mcData && mcData.entitiesByName[e.name]
  if (d && (d.type === 'hostile' || d.category === 'Hostile mobs')) return 'hostile'
  return 'passive'
}
// The nearest hostile within 4 blocks that the body can perceive, or undefined. A hit that names no
// source is pinned on it.
function nearestHostile () {
  const here = bot.entity.position
  const near = liveEntities().filter(e => e.position &&
    ['hostile', 'creeper', 'heavy'].includes(mobClass(e)) && e.position.distanceTo(here) <= 4)
  if (!near.length) return undefined
  const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
  return near.filter(e => entityPerceptible(e, fill))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
}
// The damage type names by registry id, from the registry the server sends before spawn. Via sends
// generic as 16.
let damageTypes = []
// True once a damage_event named a type the registry lacks.
let damageTypeMissed = false
bot._client.on('registry_data', (packet) => {
  try {
    if (/^(minecraft:)?damage_type$/.test(packet.id)) damageTypes = packet.entries.map(e => e.key.replace(/^minecraft:/, ''))
  } catch (e) { console.log('[combat] damage type registry unreadable: ' + e.message) }
})
// Each player's last arm swing by entity id: when it came (t), when the one before it came (prev),
// and the player's yaw as it swung.
const lastSwing = new Map()
bot.on('entitySwingArm', (e) => {
  if (e && e.type === 'player') lastSwing.set(e.id, { t: Date.now(), prev: (lastSwing.get(e.id) || { t: 0 }).t, yaw: e.yaw })
})
bot.on('entityGone', (e) => { if (e) lastSwing.delete(e.id) })
// How far apart in ms a player's hit and its arm swing may arrive, in either order.
const SWING_MS = 50
// A swing counts only this many ms or more after the same player's previous one, which leaves out fast clicking.
const SWING_GAP_MS = 300
// How far in radians a swinger's facing may point past the bot.
const SWING_FACING = Math.PI / 4
// Resolves once a sourceless hit beside a player has its attribution.
let swingWait = null
// The players within 4 blocks who stand no farther from the bot than hostile.
function playersNear (hostile) {
  const here = bot.entity.position
  const reach = hostile ? hostile.position.distanceTo(here) : 4
  return liveEntities().filter(e => e.type === 'player' && e.position &&
    e.position.distanceTo(here) <= reach)
}
// True when yaw, the facing of player e, points at the bot within SWING_FACING.
function facesBot (e, yaw) {
  const d = bot.entity.position.minus(e.position)
  const off = ((yaw - Math.atan2(-d.x, -d.z)) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI
  return Math.abs(off) <= SWING_FACING
}
// the wire: 1.21.11 sends damage_event with sourceCauseId = attacker entityId + 1 (0 = none).
// Validation ritual (the helmsman's design): he punches the machine for science, we expect his name.
bot.once('spawn', () => {
  try {
    // t is when the damage_event arrived. waited is true once a swing can no longer follow it.
    const onDamage = (packet, t, waited) => {
      try {
        if (!bot.entity || packet.entityId !== bot.entity.id) return
        const causeId = (packet.sourceCauseId || 0) - 1
        const directId = (packet.sourceDirectId || 0) - 1
        const type = damageTypes[packet.sourceTypeId]
        if (type === undefined && !damageTypeMissed) {
          damageTypeMissed = true
          console.log(`[combat] damage type ${packet.sourceTypeId} is not in the registry, a hit without a source counts as environmental`)
        }
        const noSource = causeId < 0 && directId < 0
        // Every 1.7.10 hit through Via is sourceless, a mob's included.
        const sourceless = noSource && type === 'generic'
        // After the swing wait, a non-env attribution of a later hit stays in place.
        const newer = waited && lastAttrib && !lastAttrib.env && lastAttrib.t > t
        const hostile = sourceless ? nearestHostile() : undefined
        // A sourceless hit is a player's when that player swung within SWING_MS of it, alone and facing
        // the bot, with no hostile closer to the bot. The swing nearest in time wins.
        const near = sourceless ? playersNear(hostile) : []
        const swing = near.map(e => ({ e, s: lastSwing.get(e.id) }))
          .filter(({ e, s }) => s && Math.abs(s.t - t) <= SWING_MS && s.t - s.prev >= SWING_GAP_MS && facesBot(e, s.yaw))
          .sort((a, b) => Math.abs(a.s.t - t) - Math.abs(b.s.t - t))[0]
        if (swing) {
          const name = swing.e.username || 'a player'
          if (!newer) lastAttrib = { t, desc: `no attacker named, ${name} swung nearby`, entity: null, ranged: false, env: true }
          console.log(`[combat] sourceless hit, ${name} swung nearby`)
          return
        }
        // The swing of a player beside the bot may still follow.
        if (near.length && !waited) {
          const wait = new Promise(r => setTimeout(r, SWING_MS)).then(() => {
            if (swingWait === wait) swingWait = null
            onDamage(packet, t, true)
          })
          swingWait = wait
          return
        }
        const cause = sourceless ? hostile : causeId >= 0 ? bot.entities[causeId] : null
        const direct = directId >= 0 ? bot.entities[directId] : null
        // PROJECTILE TELL (07-23, death #9: the events said "zombie E ~33" while something plinked
        // me at bow range — almost certainly a skeleton wearing a misattributed name. Whatever the
        // cause entity claims to be, cause≠direct means the hit ARRIVED as a projectile, and the
        // response must be ranged doctrine regardless of the name on the shaft.)
        const ranged = !!(direct && (!cause || direct.id !== cause.id))
        if (!cause) {
          if (ranged) lastAttrib = { t, desc: 'projectile, shooter unseen', entity: null, ranged: true }
          // An attacker the bot doesn't track leaves the hit unattributed.
          else if (!noSource) lastAttrib = null
          // env marks a hit without a source entity. Such a hit keeps a fresh attribution to an attacker,
          // and a lava, fire or fall hit marks it envHit, so the hit can't arm the bunker.
          else if (lastAttrib && !lastAttrib.env && Date.now() - lastAttrib.t < 1500) {
            if (!sourceless) lastAttrib = { ...lastAttrib, envHit: true }
          } else {
            lastAttrib = { t, desc: sourceless ? 'no attacker named, no hostile within 4' : type || 'no attacker named', entity: null, ranged: false, env: true }
          }
          return
        }
        const here = bot.entity.position
        const dir = compass(cause.position.x - here.x, cause.position.z - here.z)
        const dist = Math.round(cause.position.distanceTo(here))
        const who = cause.username || cause.name || 'unknown'
        const how = `${ranged ? ' (projectile)' : ''}${sourceless ? ' (nearest hostile)' : ''}`
        // ranged is STICKY per attacker: one proven arrow makes it a ranged threat for the episode
        const wasRanged = (AGGRO_CONFIRMED.get(cause.id) || {}).ranged || false
        if (!newer) lastAttrib = { t, desc: `${who} ${dir} ~${dist}${how}`, entity: cause, ranged: ranged || wasRanged }
        AGGRO_CONFIRMED.set(cause.id, { name: who, t: Date.now(), ranged: ranged || wasRanged })
        console.log(`[combat] attributed: hit by ${who} ${dir} ~${dist}${how}`)
      } catch (e) {}
    }
    bot._client.on('damage_event', (packet) => onDamage(packet, Date.now(), false))
    console.log('[bot] damage attribution wired')
  } catch (e) { console.log('[bot] damage attribution wire failed: ' + e.message) }
})
// ---- PILOT LANE (07-21, the debrief's cut: "your legs literally carried you out the door
// while your head was thinking" — the helmsman, having watched exactly that). The spine acts
// every 300ms; the pilot every 1-3s — ten to thirty free reflex moves between any two pilot
// decisions, so orders kept landing on a body that had already left. Movement verbs claim a
// SOFT lane: discretionary reflex goals (withdrawal, stance-berth kiting, chase) defer, but
// interrupts (heavy-kite) and emergencies (creeper fuse, HP-critical) still pass. /brace
// claims the HARD lane: only emergencies pass. The legs get ONE owner, and the pilot knows which.
// token is the claim releaseLane may clear.
const pilotLane = { until: 0, why: null, hard: false, narrated: 0, token: null }
// Returns the token of this claim.
function claimLane (why, ms, hard = false) {
  pilotLane.until = Date.now() + ms
  pilotLane.why = why
  pilotLane.hard = hard
  pilotLane.token = {}
  return pilotLane.token
}
// Clears the lane only while token is still its claim.
function releaseLane (token) {
  if (token && pilotLane.token === token) clearLane()
}
function clearLane () {
  pilotLane.until = 0
  pilotLane.hard = false
  pilotLane.token = null
}
// The bunker being built, and the cell of the last one the body reached. stop is why the build
// has to end early, set by /stop, by a death and by a mob's hit. mode is the mode being built, and
// reached the blocks the body has risen or sunk so far.
const bunker = { building: false, stop: null, cell: null, mode: null, reached: 0 }
// Stops that end a build and leave the body where it is.
const BUNKER_HALTS = ['stopped by the pilot', 'the body died']
// What a route that walks or digs answers while a bunker is built.
const BUNKER_WALK = 'refused while a bunker is being built, the stop tool ends the build'
// Throws BUNKER_WALK while a bunker is built, unless own marks a step of the build itself.
function refuseWhileBuilding (own = false) {
  if (bunker.building && !own) throw new Error(BUNKER_WALK)
}
// True while a bunker is built or the body still stands in its cell. Flees, cover moves and chases wait then.
function bunkerHolds () {
  if (bunker.building) return true
  if (!bunker.cell) return false
  if (bot.entity && bot.entity.position.floored().equals(bunker.cell)) return true
  bunker.cell = null
  return false
}
const laneBlocks = (klass) => legsLaneBlocks({
  klass,
  bunker: bunkerHolds(),
  laneHeld: Date.now() < pilotLane.until,
  hard: pilotLane.hard,
  jobRunning: jobs.running(),
  meleeThreat: meleeThreat()
})
const laneNarrate = (what) => {
  if (bunkerHolds()) return
  if (Date.now() - pilotLane.narrated < 6000) return
  pilotLane.narrated = Date.now()
  if (Date.now() >= pilotLane.until && jobs.running()) emitEvent('combat', `${what} deferred, the running job keeps the legs`)
  else emitEvent('combat', `${what} deferred — pilot lane held (${pilotLane.why})`)
}
// 1.7.10 takes a hit from 6 blocks with a clear eye-line and from 3 without.
function meleeReach (en) {
  return LEGACY_1710 ? (losClear(bot.entity.position.offset(0, 1.62, 0), en.position.offset(0, 1.0, 0)) ? 4.0 : 3.0) : 3.2
}
// True while the combat reflex's threat stands in melee reach.
function meleeThreat () {
  const combat = reflexes.find(r => r.name === 'combat')
  const t = combat && combat.on && combat._threat
  if (!t || !t.e || !bot.entities[t.e.id] || !bot.entity) return false
  return t.e.position.distanceTo(bot.entity.position) <= meleeReach(t.e)
}
// ---- ENGAGEABLE vs WATCHED (07-21, the mansion debrief, the helmsman's diagnosis: creepers pacing
// dark rooms OVERHEAD were air-connected and honestly perceptible, so the pack counter armed
// withdrawals against enemies the fight didn't contain — "legs fleeing the ceiling while the
// head fought the door." The rule: perception may flow through the floor; URGENCY must flow
// through the path. Same storey = engageable; separated vertically with no eye-line = watched
// (narrated, never driving). Anything that HITS me is engageable by proof — it found a path.)
function entityEngageable (en) {
  try {
    if (AGGRO_CONFIRMED.has(en.id)) return true
    const dy = Math.abs(en.position.y - bot.entity.position.y)
    if (dy < 2.5) return true
    return losClear(bot.entity.position.offset(0, 1.62, 0), en.position.offset(0, 1.0, 0))
  } catch (e) { return true }
}
const { fleeHeading } = require('./lib/flee')
// Hostiles within radius that the body perceives or that hit it, and that can reach it.
function nearHostiles (fill, radius) {
  return liveEntities().filter(e => {
    if (!e.position) return false
    const c = mobClass(e)
    if (c !== 'hostile' && c !== 'creeper' && c !== 'heavy') return false
    if (e.position.distanceTo(bot.entity.position) >= radius) return false
    if (!(AGGRO_CONFIRMED.has(e.id) || entityPerceptible(e, fill))) return false
    return entityEngageable(e)   // the mansion lesson: the pack counts only what can reach me
  })
}

// the watcher+responder reflex — priority ABOVE unstuck (unshift), toggle via /reflexes name=combat
reflexes.unshift({
  name: 'combat', on: true, active: false,
  _hist: new Map(), _lastNarrate: new Map(), _threat: null,
  // _fleeCls is the mobClass of the threat the last flee ran from.
  _fill: null, _fillT: 0, _fillSeed: null, _fleeUntil: 0, _fleeT: 0, _fleeCls: null, _coverUntil: 0,
  // FLEE LATCH (07-16, the first-death autopsy: twelve 'disengaging' events, zero escape — every
  // 300ms re-entry safeStop'd the previous flee goal and re-planned from scratch, so the body
  // SHUFFLED IN PLACE while a same-speed drowned ate it 1.4 at a time. A flee is set ONCE, held
  // 6s, and RUN at a sprint; re-entries bounce off the latch instead of resetting the goal.)
  fleeFrom (bot, threat, why, klass = 'discretionary') {
    const now = Date.now()
    // PILOT LANE (07-21): discretionary flees defer to a held lane; interrupts pass the
    // soft lane only; emergencies (creeper fuse, HP-critical) always own the legs.
    if (laneBlocks(klass)) { laneNarrate(why || 'flee'); return }
    if (now < this._fleeUntil) return                    // a flee is already running — let it run
    this._fleeUntil = now + 6000
    this._fleeT = now
    this._fleeCls = mobClass(threat)
    try {
      const threatPos = threat.position
      const here = bot.entity.position
      const anchor = reflexes.find(r => r.name === 'flee_to_player')
      const ally = anchor && anchor.on ? anchor.ally(bot, here, threatPos) : undefined
      takeLegs('combat', 'flee')
      stopPath()
      if (ally) {
        bot.pathfinder.setGoal(new goals.GoalNear(ally.position.x, ally.position.y, ally.position.z, 2))
        emitEvent('flee_to_player', `fleeing to ${ally.username} ${compass(ally.position.x - here.x, ally.position.z - here.z)} ~${Math.round(ally.position.distanceTo(here))}`)
      } else {
        const others = nearHostiles(this.fairFill(bot), 16).filter(e => e.id !== threat.id).map(e => e.position)
        const away = fleeHeading(here, threatPos, others)
        bot.pathfinder.setGoal(new goals.GoalNear(here.x + away.x * 20, here.y, here.z + away.z * 20, 2))
      }
      bot.setControlState('sprint', true)
      setTimeout(() => { try { bot.setControlState('sprint', false) } catch (e) {} }, 6000)
    } catch (e) {}
    if (why) emitEvent('combat', why)                    // ONE event per flee episode, not twelve
  },
  // RANGED-CHIP RESPONSE (07-23, death #9's patch: a skeleton plinked me dead up my own stair
  // shaft — fourteen hits at 0.7, position never changed, every event claiming the reflex "has
  // it" while the distance gate dropped the attacker before scoring. The answer to arrows you
  // can't answer is GEOMETRY: stop being seen. Sidestep to the nearest standable cell the
  // attacker's eye can't reach; no such cell within 3 = flee the sightline at a sprint.
  // One cover move per 4s — re-entries bounce off the latch, like the flee latch.)
  takeCover (bot, threat, who) {
    const now = Date.now()
    if (now < this._coverUntil || now < this._fleeUntil) return
    if (laneBlocks('interrupt')) { laneNarrate('take-cover'); return }
    this._coverUntil = now + 4000
    try {
      const here = bot.entity.position.floored()
      const eye = threat.position.offset(0, 1.62, 0)
      const stand = (x, y, z) => {
        const f = bot.blockAt(new Vec3(x, y - 1, z)); if (!f || f.boundingBox !== 'block') return false
        const a = bot.blockAt(new Vec3(x, y, z)); const h = bot.blockAt(new Vec3(x, y + 1, z))
        return !!(a && h && a.boundingBox === 'empty' && h.boundingBox === 'empty' &&
          !/water|lava/.test(a.name) && !/water|lava/.test(h.name))
      }
      let bestCell = null; let bestD = Infinity
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        if (!dx && !dz) continue
        for (let dy = -1; dy <= 1; dy++) {
          const x = here.x + dx, y = here.y + dy, z = here.z + dz
          if (!stand(x, y, z)) continue
          if (losClear(eye, new Vec3(x + 0.5, y + 1.62, z + 0.5))) continue   // still in the sightline
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < bestD) { bestD = d2; bestCell = { x, y, z } }
        }
      }
      if (bestCell) {
        takeLegs('combat', 'take cover')
        stopPath()
        bot.pathfinder.setGoal(new goals.GoalBlock(bestCell.x, bestCell.y, bestCell.z))
        emitEvent('combat', `ranged chip from ${who || '?'} — BREAKING EYE-LINE: cover ${compass(bestCell.x - here.x, bestCell.z - here.z)} at (${bestCell.x},${bestCell.y},${bestCell.z})`)
        return
      }
    } catch (e) {}
    this._coverUntil = 0                                 // no cover found — hand it to the flee latch
    this.fleeFrom(bot, threat, `ranged chip from ${who || '?'} — no cover within 3, FLEEING the sightline`, 'interrupt')
  },
  // FAIRNESS GATE fill (07-16, the confessed leak from the first Normal cave crawl): the watcher
  // read raw bot.entities — server x-ray — and tracked a zombie through solid rock that /entities
  // honestly hid. Same law as ore and eyes now: sealed behind rock = imperceptible; it may be
  // HEARD (ears are server-fair) but never tracked, scored, or engaged. Lazy + cached ~2s so the
  // 300ms loop only pays for the flood when a candidate actually needs judging.
  fairFill (bot) {
    const now = Date.now()
    const seed = bot.entity.position.floored()
    if (this._fill && now - this._fillT < 2000 && this._fillSeed && seed.distanceTo(this._fillSeed) < 3) return this._fill
    this._fill = airFlood({ radius: 28, cap: 15000 })
    this._fillT = now; this._fillSeed = seed
    return this._fill
  },
  check (bot) {
    if (bunker.building) return false
    try {
      const now = Date.now()
      const here = bot.entity.position
      let best = null
      expireConfirmed(AGGRO_CONFIRMED, now, CONFIRMED_MS)
      for (const e of liveEntities()) {
        if (!e.position) continue
        const cls = mobClass(e)
        const confirmed = AGGRO_CONFIRMED.get(e.id)
        const scoreable = cls === 'hostile' || cls === 'creeper' || cls === 'heavy' || !!confirmed ||
          (cls === 'player' && now < threatDebugUntil)
        if (!scoreable) continue
        const dist = e.position.distanceTo(here)
        // DEATH #9 (07-23): this gate ran BEFORE the confirmed bypass, so a skeleton plinking
        // from ~33 was discarded every cycle — fourteen hits, zero responses, while the hurt
        // line swore the reflex "has it". What HIT me stays scored out to 48; everything
        // unproven keeps the old 24-block horizon.
        if (dist > (confirmed ? CONFIRMED_HORIZON : 24)) { this._hist.delete(e.id); continue }
        // confirmed attackers bypass the sight gate (whatever HIT me announced itself); everything
        // else must share my connected air. History is kept, not wiped — brief occlusion mid-chase
        // shouldn't amnesia the pursuit evidence, the sample just doesn't accrue while unseen.
        if (!confirmed && !entityPerceptible(e, this.fairFill(bot))) continue
        // WATCHED tier (the mansion lesson): perceptible but a floor away — narrate rarely, never score
        if (!entityEngageable(e)) {
          const wk = 'w' + e.id
          if (cls !== 'player' && now - (this._lastNarrate.get(wk) || 0) > 20000) {
            this._lastNarrate.set(wk, now)
            const rel = e.position.y > here.y + 1 ? 'above' : (e.position.y < here.y - 1 ? 'below' : 'beyond')
            emitEvent('threat', `watched: ${e.name || '?'} ${rel} ~${Math.round(dist)} — separated, not driving`, null, { quiet: true })
          }
          continue
        }
        const h = this._hist.get(e.id) || { d: dist, t: now, closes: 0, logT: 0 }
        const dt = (now - h.t) / 1000
        if (dt >= 0.25) {
          const closingSpeed = (h.d - dist) / dt              // blocks/sec toward me
          // DECAY not reset (the helmsman's calibration question, 07-15): mob pathfinding stutters — one
          // slow sample must not erase pursuit evidence; only sustained non-approach drains it.
          // Bar stays 0.6 b/s: zombie pursuit-walk ~2, player sprint ~5.6 — shamblers clear it 3x.
          h.closes = closingSpeed > 0.6 ? h.closes + 1 : Math.max(0, h.closes - 1)
          if (cls !== 'player' && dist < 20 && now - h.logT > 2000) {
            h.logT = now                                       // calibration tape for the first real
            console.log(`[combat] track ${e.name} dist=${dist.toFixed(1)} closing=${closingSpeed.toFixed(2)}b/s closes=${h.closes}`)
          }                                                    // zombie post-flip — tune from data
          h.d = dist; h.t = now
        }
        this._hist.set(e.id, h)
        // sentinel stance: posturing doesn't count — only confirmed attackers score (creeper
        // proximity still does: fleeing a lit fuse is survival, not engagement)
        const closerAggro = STANCES[stance].engage === 'confirmed' ? false : h.closes >= 3
        const aggro = !!confirmed || closerAggro || (cls === 'creeper' && dist < 8)
        if (aggro && (!best || dist < best.dist)) best = { e, cls, dist, confirmed: !!confirmed }
      }
      this._threat = best
      return !!best
    } catch (e) { return false }
  },
  async act (bot) {
    const t = this._threat
    if (!t || !t.e || !bot.entities[t.e.id]) return
    if (Date.now() < this._fleeUntil) return              // mid-flee: legs are busy, no melee, no goal resets
    const now = Date.now()
    const here = bot.entity.position
    const dir = compass(t.e.position.x - here.x, t.e.position.z - here.z)
    const label = t.e.username || t.e.name || '?'
    const narKey = t.e.id
    if (now - (this._lastNarrate.get(narKey) || 0) > 8000) {
      this._lastNarrate.set(narKey, now)
      emitEvent('threat', `${label} ${dir} ~${Math.round(t.dist)} ${t.confirmed ? 'CONFIRMED (it hit me)' : 'closing fast'} — ${t.cls === 'creeper' ? 'creeper doctrine' : t.cls === 'heavy' ? 'heavy doctrine (no trades)' : t.cls === 'player' ? 'debug: scoring only' : 'engaging'} [${stance}]`)
    }
    if (t.cls === 'player') return                          // NEVER weapons on players — narrate only
    const s = STANCES[stance]
    if (t.cls === 'creeper' || t.cls === 'heavy') {
      // Never trade with these — but "never melee" stopped meaning "only run" when stances landed:
      // beyond the stance's berth and inside the bow band, the answer is an arrow, not distance.
      // Lane classes: a creeper in berth is an EMERGENCY (fuses don't negotiate); a heavy's kite
      // is an INTERRUPT (passes the soft lane, defers to /brace's hard one).
      const fk = t.cls === 'creeper' ? 'emergency' : 'interrupt'
      if (t.dist <= s.fleeDist) { this.fleeFrom(bot, t.e, null, fk); return }
      const [lo, hi] = s.bowBand
      const bandLo = t.cls === 'heavy' ? Math.max(lo, 10) : lo   // heavies close FAST — bigger floor
      if (t.dist >= bandLo && t.dist <= hi) {
        try { if (await drawAndLoose(t.e)) return } catch (e) {}
      }
      this.fleeFrom(bot, t.e, null, fk)
      return
    }
    // melee hostile: SHIELD POSTURE while it closes (the shield is a posture, not a parry —
    // settled with the helmsman 07-15: nobody blocks the arrow, you walk shield-up while threatened;
    // posture decisions are slow decisions, so the 300ms reflex holds it, not the pilot),
    // then a swing about every 850 ms, the shield dropped for each (Java can't do both).
    // On 1.7.10 a sword block is the posture, held through swings LEGACY_HIT_MS apart.
    const sword = bot.inventory.items().find(i => /_sword$/.test(i.name))
    const canGuard = () => {
      if (LEGACY_1710) return !!bot.heldItem && /_sword$/.test(bot.heldItem.name)
      const s = bot.inventory.slots[45]; return s && s.name === 'shield'
    }
    const guardUp = () => {
      if (!guardState.up && canGuard()) { try { bot.activateItem(!LEGACY_1710); guardState.up = true; guardState.slot = bot.quickBarSlot } catch (e) {} }
    }
    const guardDown = () => { if (guardState.up) { try { bot.deactivateItem() } catch (e) {} ; guardState.up = false } }
    // Puts the sword in hand. Swapping items ends a sword block.
    const swordInHand = async () => {
      if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) { await bot.equip(sword, 'hand'); guardState.up = false }
    }
    // On 1.7.10 a block the pilot raised goes back up after the fight, sword in hand. True when the
    // pilot's order applies.
    const pilotGuard = async () => {
      if (!LEGACY_1710 || !guardState.pilot || bunker.building) return false
      try { await swordInHand() } catch (e) {}
      guardUp()
      return true
    }
    const t0 = Date.now()
    try {
      while (this.on && !bunker.building && bot.entities[t.e.id] && Date.now() - t0 < 10000) {
        // ADAPTIVE disengage (death #2 lesson): the tripwire scales to the last hit taken while
        // it's FRESH (20s) — after a 1.4 drowned it sits at the old 8; after an 8.6 vindicator it
        // becomes "any hit landed = disengage NOW", because two more of those is a corpse. Stale
        // hits stop counting so one bad fight doesn't leave the spine cowardly for the whole day.
        const hitRef = Date.now() - lastHit.t < 20000 ? lastHit.dmg : 0
        // Vanguard trusts the blade against light mobs (07-21, death #8: disengage-at-8 vs
        // zombies meant sprint-thrash inside a ring instead of the two sword hits that kill
        // one). Floor drops to 5 there; every other stance and class keeps the old 8.
        const disengageFloor = (stance === 'vanguard' && t.cls === 'hostile') ? 5 : 8
        if (bot.health < Math.max(disengageFloor, hitRef * 2.5)) {
          this.fleeFrom(bot, t.e, `HP ${Math.round(bot.health * 10) / 10} — disengaging from ${label}, sprinting`, 'emergency')
          return
        }
        // OUTNUMBERED (07-18, death #4 autopsy + the helmsman's diagnosis: the close-in never
        // counted the room). 3+ perceptible hostiles inside 16 is not a duel — withdraw, don't
        // engage-nearest while the rest converge.
        const packList = nearHostiles(this.fairFill(bot), 16)
        const pack = packList.length
        if (pack >= 3) {
          // VANGUARD COMMITS (07-21, death #8: four zombies at 0.7 a bite outlasted a reflex
          // that kept choosing withdrawals it couldn't execute in a corridor. A light-only pack
          // in room-clearing stance is sword work, not a rout — stand and swing. A heavy or a
          // creeper in the pack still makes it a real rout, and the HP floor still binds.)
          const packHasHeavy = packList.some(e2 => { const c2 = mobClass(e2); return c2 === 'heavy' || c2 === 'creeper' })
          const lightCommit = stance === 'vanguard' && !packHasHeavy && bot.health >= 12
          if (!lightCommit) {
            // ALLY SUPPRESSION (the helmsman's design, 07-20, en route to the dungeon reaping):
            // a pack is only a rout if I'm ALONE in it. A partner within 10 turns the math — two
            // blades hold a hallway three zombies can't. Withdrawal stays armed for the solo case.
            const allyNear = liveEntities().some(e2 =>
              e2.type === 'player' && e2.username && e2.username !== bot.username &&
              e2.position && e2.position.distanceTo(bot.entity.position) <= 10)
            // HP FLOOR (07-21, the mill's lesson: the hold rule pinned me at 9 hearts twice on
            // 07-20 — an ally makes a pack survivable, not a wound. Below 12 the hold yields.)
            if (!allyNear || bot.health < 12) {
              this.fleeFrom(bot, t.e, allyNear
                ? `OUTNUMBERED ${pack} at ${Math.round(bot.health)} HP — below the hold floor, withdrawing`
                : `OUTNUMBERED ${pack} — fighting withdrawal, not a duel`)
              return
            }
            if (!this._lastHoldEmit || Date.now() - this._lastHoldEmit > 10000) {
              this._lastHoldEmit = Date.now()
              emitEvent('combat', `outnumbered ${pack} but an ally stands within 10 — HOLDING the line`)
            }
          }
        }
        const d = t.e.position.distanceTo(bot.entity.position)
        const reach = meleeReach(t.e)
        if (d <= reach) yieldJob('combat', 'fight in melee range')
        if (d > reach) {
          // Standoff band (the helmsman's 07-16 complaint: the reflex used to stand here sword-in-
          // hand, staring at skeletons that plink from 10). Stance decides: bow it, chase it, or
          // hold shield-up as before.
          const [lo, hi] = s.bowBand
          if (d >= lo && d <= hi) {
            guardDown()                                       // both hands on the bow
            try { if (await drawAndLoose(t.e)) { await new Promise(r => setTimeout(r, 200)); continue } } catch (e) {}
          }
          if (s.chase) {                                      // vanguard: run it down
            if (laneBlocks('discretionary')) { laneNarrate('chase'); await new Promise(r => setTimeout(r, 500)); continue }
            takeLegs('combat', 'chase')
            try { bot.pathfinder.setGoal(new goals.GoalNear(t.e.position.x, t.e.position.y, t.e.position.z, 2)) } catch (e) {}
            await new Promise(r => setTimeout(r, 500))
            continue
          }
          // DEATH #9's LESSON (07-23): against a PROVEN ranged attacker, the shield-stare IS the
          // death posture — it holds the body still inside the firing solution. If the bow
          // couldn't answer (out of band, no LOS, no arrows), break the eye-line instead.
          const conf9 = AGGRO_CONFIRMED.get(t.e.id)
          if (conf9 && conf9.ranged) { this.takeCover(bot, t.e, label); return }
          if (LEGACY_1710) { try { await swordInHand() } catch (e) {} }
          guardUp()                                           // hold ground, face it, shield up
          if (headFree(bot)) await bot.lookAt(t.e.position.offset(0, 1.2, 0), true)
          await new Promise(r => setTimeout(r, 250))
          continue
        }
        if (s.chase) {                                        // in reach — legs off, sword out
          if (bot.pathfinder.goal) takeLegs('combat', 'fight in melee range')
          try { bot.pathfinder.setGoal(null) } catch (e) {}
        }
        try {
          if (LEGACY_1710) {
            // No equip wait and no guard beats: the block stays up, and a swing goes out once it is due.
            await swordInHand()
            guardUp()
            await bot.lookAt(t.e.position.offset(0, 1.2, 0), true)
            const due = lastAttackT + LEGACY_HIT_MS - Date.now()
            if (due > 0) { await new Promise(r => setTimeout(r, due)); continue }
            bot.attack(t.e)
            lastAttackT = Date.now()
            continue
          }
          if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) { await bot.equip(sword, 'hand'); await bot.waitForTicks(13) }
          guardDown()                                         // the swing window — shield drops...
          await bot.waitForTicks(2)
          await bot.lookAt(t.e.position.offset(0, 1.2, 0), true)
          await bot.waitForTicks(2)
          bot.attack(t.e)
          await new Promise(r => setTimeout(r, 400))
          guardUp()                                           // ...and comes right back up
        } catch (e) {}
        await new Promise(r => setTimeout(r, 250))            // about 850 ms per swing w/ the guard beats, 1.5 s after an equip
      }
    } finally { if (!(await pilotGuard())) guardDown() }      // the pilot's block stays up, the reflex's comes down
    if (!bot.entities[t.e.id]) emitEvent('combat', `${label} is DOWN`)
    // POST-COMBAT REFUEL (07-21, the mill's slow-bleed autopsy: /eat fails silently while
    // combat owns the hand, so food ratchets down across engagements and regen quits at 17.
    // The moment the hand is free is the moment to eat — before the next wave claims it.)
    if (bot.food <= 14 && !bunker.building) {
      try {
        const foods = (mcData && mcData.foods) || {}
        const bite = bot.inventory.items().filter(i => foods[i.type] && i.name !== 'golden_apple')
          .sort((a, b) => (foods[b.type].foodPoints || 0) - (foods[a.type].foodPoints || 0))[0]
        if (bite) {
          const prevHeld = bot.heldItem
          await bot.equip(bite, 'hand')
          await bot.consume()
          emitEvent('combat', `refueled on ${bite.name} after the fight — food ${bot.food}/20`)
          if (prevHeld) await bot.equip(prevHeld, 'hand')
        }
      } catch (e) {}                                          // a failed snack must never wedge the reflex
      await pilotGuard()                                      // the food in hand ended the pilot's block
    }
  }
})
// flee_to_player: a combat flee runs to a player within 24 blocks who stands farther from the
// threat, not straight away from it. It shapes the flee and never fires by itself.
reflexes.push({
  name: 'flee_to_player', on: true, active: false,
  check () { return false },
  // The player to run to, or undefined.
  ally (bot, here, threatPos) {
    return liveEntities().find(e =>
      e.type === 'player' && e.username && e.username !== bot.username &&
      e.position && e.position.distanceTo(here) <= 24 &&
      e.position.distanceTo(threatPos) > here.distanceTo(threatPos))
  }
})
// LAVA WATCH (07-17, death #3 autopsy: flowing lava advanced into a path that was air at plan
// time — the pathfinder's plan-time safety cannot see a moving hazard, and the flee latch sprints
// a committed vector. Body-level veto, priority ABOVE combat: burns kill faster than brawls.
// Perceived lava in the near shell = kill goal + controls NOW, back away, tell the pilot.)
reflexes.unshift({
  name: 'lava_watch', on: true, active: false, _coolUntil: 0, _hit: null,
  check (bot) {
    if (Date.now() < this._coolUntil) return false
    try {
      const p = bot.entity.position.floored()
      const V = require('vec3').Vec3
      for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
        const c = new V(p.x + dx, p.y + dy, p.z + dz)
        const b = bot.blockAt(c)
        if (b && b.name === 'lava' && perceived(c)) {
          this._hit = { dx, dz, d: Math.abs(dx) + Math.abs(dz), dir: compass(dx, dz) || 'UNDER ME' }
          return true
        }
      }
    } catch (e) {}
    return false
  },
  async act (bot) {
    const h = this._hit
    // Parked next to STATIC lava (a dam, a pit wall): same cell, hazard no nearer than last
    // fire = re-firing every 4s only kills pilot goals and floods the log (07-17 churn-pit
    // spam loop). Warn happened already — stand down 30s and leave the call to the pilot.
    // Flowing lava still breaks through: it gets CLOSER, so h.d drops and we act.
    const posNow = bot.entity.position.floored()
    if (this._lastPos && posNow.equals(this._lastPos) && this._lastD != null && h.d >= this._lastD) {
      this._coolUntil = Date.now() + 30000
      this._lastD = h.d
      return
    }
    this._lastPos = posNow; this._lastD = h.d
    this._coolUntil = Date.now() + 4000
    try {
      if (bunker.building) {
        emitEvent('lava', `LAVA ${h.dir} ~${h.d}, not moving while the bunker is built`)
        return
      }
      takeLegs('lava_watch', 'back away from lava')
      stopPath()                                           // whatever the plan was, it ends here
      const here = bot.entity.position
      if (h.d === 0) {
        // standing in/over it: nearest non-lava, non-solid neighbor cell, fast
        const V = require('vec3').Vec3
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const feet = bot.blockAt(new V(Math.floor(here.x) + ax, Math.floor(here.y), Math.floor(here.z) + az))
          if (feet && feet.name !== 'lava' && feet.boundingBox === 'empty') {
            bot.pathfinder.setGoal(new goals.GoalNear(here.x + ax, here.y, here.z + az, 0))
            break
          }
        }
      } else {
        bot.pathfinder.setGoal(new goals.GoalNear(here.x - h.dx * 3, here.y, here.z - h.dz * 3, 1))
      }
      emitEvent('lava', `LAVA ${h.dir} ~${h.d} — STOPPED, backing off; route around it deliberately`)
    } catch (e) {}
  }
})
// bunker: below BUNKER_HP and within 15 s of a mob's hit, the body builds the bunker that holds
// against the mobs near it. It flees when none does and when the build fails or stops short, unless
// the pilot's stop or a death ended it. A provokable mob that hits has been provoked.
reflexes.splice(reflexes.findIndex(r => r.name === 'combat'), 0, {
  name: 'bunker', on: true, active: false, _spent: false,
  check (bot) {
    if (this._spent && bot.health >= BUNKER_REARM_HP) this._spent = false
    const next = bunkerReflexDecide()
    if (next && next.flee) {
      reflexes.find(r => r.name === 'combat').fleeFrom(bot, next.flee, next.why, 'emergency')
      return false
    }
    return !!(next && next.build)
  },
  async act (bot) {
    this._spent = true
    emitEvent('bunker', `HP ${Math.round(bot.health * 10) / 10} after a mob's hit, building a bunker`)
    takeLegs('bunker', 'build a bunker')
    const built = await buildBunker('auto', BUNKER_HEIGHT)
    emitEvent('bunker', bunkerSummary(built))
    const cause = built.error || (BUNKER_HALTS.includes(built.stopped) ? null : built.stopped)
    const near = cause && shelterInputs('auto').threats[0]
    if (near) reflexes.find(r => r.name === 'combat').fleeFrom(bot, near.entity, `${cause}, fleeing from ${near.name}`, 'emergency')
  }
})
bot.on('death', resetThreatState)
bot.on('spawn', resetThreatState)
// (the /threatdebug route lives with the other routes below — `app` doesn't exist yet up here,
// learned via a TDZ crashloop the moment this block first loaded)

// ---- ORE CALLOUT: passive prospector sense (07-17, "your ore senses need tuning" — the helmsman).
// A player's eyes are always on; the pilot's /find only fires when asked. Every 4s, sweep ore in
// lit sight within 12 and announce anything new. Announced set is pruned by distance+age so it
// can't OOM (the SEEN lesson).
const ORE_ANNOUNCED = new Map()   // "x,y,z" -> { t, name }
let ORE_IDS = null
function oreCallout () {
  try {
    if (!ready || !bot.entity || !mcData) return
    if (!ORE_IDS) ORE_IDS = Object.values(mcData.blocksByName)
      .filter(b => /_ore$/.test(b.name) || b.name === 'ancient_debris').map(b => b.id)
    const here = bot.entity.position
    for (const [k, ore] of ORE_ANNOUNCED) {                    // prune: >10min old or >48 away
      const [x, y, z] = k.split(',').map(Number)
      if (Date.now() - ore.t > 600000 || here.distanceTo(new Vec3(x, y, z)) > 48) ORE_ANNOUNCED.delete(k)
    }
    const fresh = {}
    for (const v of findVisible(ORE_IDS, 12, 12)) {
      const k = `${v.pos.x},${v.pos.y},${v.pos.z}`
      if (ORE_ANNOUNCED.has(k)) continue
      const b = bot.blockAt(v.pos)
      // A block of a vein already announced is recorded without a callout.
      const known = !!b && sameVein(ORE_ANNOUNCED, b.name, v.pos)
      ORE_ANNOUNCED.set(k, { t: Date.now(), name: b ? b.name : null })
      if (!b || known) continue
      const dir = compass(v.pos.x - Math.floor(here.x), v.pos.z - Math.floor(here.z)) || 'HERE'
      const g = fresh[b.name] = fresh[b.name] || { n: 0, dir, d: Math.round(v.dist), y: v.pos.y }
      g.n++
    }
    for (const [name, g] of Object.entries(fresh))
      emitEvent('ore', `${name}${g.n > 1 ? ' x' + g.n : ''} in view ${g.dir} ~${g.d} (y${g.y})`)
  } catch (e) {}
}
setInterval(oreCallout, 4000)

// ---- SEEN persistence: the fair fog-of-war memory survives restarts. Saved on a timer (and on
// clean disconnect); loaded at spawn.
const SEEN_FILE = './seen.json'
bot.once('spawn', () => {
  try {
    const arr = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))
    for (const k of arr) { if (SEEN.size >= SEEN_CAP) break; SEEN.add(k) }
    console.log('[bot] loaded SEEN memory: ' + SEEN.size + ' cells')
  } catch (e) {}
})
let seenDirty = 0
setInterval(() => {
  try { if (SEEN.size !== seenDirty) { fs.writeFileSync(SEEN_FILE, JSON.stringify([...SEEN])); seenDirty = SEEN.size } } catch (e) {}
}, 120000)
bot.on('end', () => { try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...SEEN])) } catch (e) {} })

// ---- tiered pick choice: use the LOWEST pick that can harvest the target (stop burning iron
// durability on plain stone), upgrade automatically for ore that needs better (protects drops).
const PICK_TIER = { wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1, iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 4 }
function neededPickTier(blockName) {
  if (!blockName) return 0
  const n = blockName.replace('deepslate_', '')
  if (/obsidian|ancient_debris|respawn_anchor/.test(n)) return 3   // diamond+ or the drop is DESTROYED
  if (/(gold|diamond|emerald|redstone)_ore/.test(n)) return 2
  if (/(iron|lapis|copper)_ore/.test(n)) return 1
  return 0
}
// The lowest carried pick that harvests blockName, else the best carried one, else null.
function pickFor(blockName) {
  const picks = bot.inventory.items().filter(i => PICK_TIER[i.name] !== undefined)
    .sort((a, b) => PICK_TIER[a.name] - PICK_TIER[b.name])
  if (!picks.length) return null
  const need = neededPickTier(blockName)
  return picks.find(p => PICK_TIER[p.name] >= need) || picks[picks.length - 1]
}
async function equipPickFor(blockName) {
  const pick = pickFor(blockName)
  if (!pick) return false
  if (!bot.heldItem || bot.heldItem.name !== pick.name) { try { await bot.equip(pick, 'hand') } catch (e) {} }
  return PICK_TIER[pick.name] >= neededPickTier(blockName)
}

// ---- no-legal-move check: a canDig=false walker boxed in (e.g. self-trapped in its own dig) has
// NO first move, and the pathfinder rejects with a cryptic "Path was stopped". Detect it and say it.
function hasLegalMove() {
  try {
    const o = bot.entity.position.floored()
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
    const open = (x, y, z) => { const b = at(x, y, z); return b && floodPassable(b) }
    const solid = (x, y, z) => { const b = at(x, y, z); return b && b.boundingBox === 'block' }
    const wet = (x, y, z) => { const b = at(x, y, z); return b && b.name.includes('water') }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = o.x + dx, z = o.z + dz
      if (open(x, o.y, z) && open(x, o.y + 1, z)) {           // walk flat / step or swim down (≤3)
        if (wet(x, o.y, z)) return true
        for (let dy = 0; dy >= -3; dy--) if (solid(x, o.y + dy - 1, z)) return true
      }
      // step UP 1: tread ahead solid, its feet+head open, and my own launch headroom open
      if (solid(x, o.y, z) && open(x, o.y + 1, z) && open(x, o.y + 2, z) && open(o.x, o.y + 2, o.z)) return true
    }
    return false
  } catch (e) { return true }                                  // uncertain -> don't block the attempt
}

// ---- HTTP control layer ----
const app = express()
installSecurity(app, { token: GOLEM_TOKEN, port: CTRL_PORT, chat: { send: (text) => bot.chat(text), maxLen: chatMaxLen(process.env.GOLEM_CHAT_MAX) } })
// The pilot routes in flight, which follow waits out.
const verbs = countVerbs(app)
// ?brief=1 on ANY endpoint strips null/undefined fields from the reply — LLM pilots pay
// by the token and "reason":null earns nothing. Empty ARRAYS survive on purpose: law 2
// makes [] a statement ("looked, found none") and silence a different one ("didn't look").
// (Suggested by bones_ham — the harness's first outside pilot — 07-21. Fairness untouched.)
const debrief = (v) => {
  if (Array.isArray(v)) return v.map(debrief)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === undefined) continue
      out[k] = debrief(val)
    }
    return out
  }
  return v
}
// Adds the unread chat count and senders to each JSON reply.
const send = (res, body) => res.json(chatLog.withUnread(body))
const ok = (res, data) => {
  const body = { ok: true, ...data }
  send(res, res.req && res.req.query && res.req.query.brief ? debrief(body) : body)
}
const err = (res, e) => send(res, { ok: false, error: e.message || String(e) })

let lastTickSnap = null   // /tick?delta=1 diffs against the previous tick (single-pilot assumption)
// Names this bot.js process in every /tick reply.
const BOOT_ID = require('crypto').randomBytes(8).toString('hex')
// GET /tick?chat=&ev= : the ONE-CALL HEARTBEAT (bones_ham's ask, 07-21 — the pilot's
// standing glance used to be a 3-4 call bundle, and mid-combat that round-trip tax cut
// deeper than the vindicators). Body essentials + new chat since ?chat= + new events
// since ?ev= + fairness-gated hostiles + running jobs, one round trip. Cursors return in
// the reply; feed them to the next call. /boot is session-start; /tick is every turn
// after. Perception rules unchanged — same gates as /scene, just fewer trips.
app.get('/tick', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const chatSince = parseInt(req.query.chat || '0')
    const evSince = parseInt(req.query.ev || '0')
    const e = bot.entity
    const w = waterState(bot)
    const fill = airFlood({ radius: 28, cap: 15000 })
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
      events: { cursor: eventSeq, list: eventLog.filter(x => x.id > evSince) },
      jobs: jobs.list()
    }
    eventsServed = eventSeq
    // ?delta=1 (07-21): report only what CHANGED since the last tick — fewer tokens in,
    // faster pilot decisions out. Threats/water/chat/events always report (safety and
    // cursors are never elided); pos elides under 1 block of drift; vitals elide when equal.
    if (req.query.delta === '1' && lastTickSnap) {
      const s = lastTickSnap
      if (full.pos && s.pos && Math.abs(full.pos.x - s.pos.x) + Math.abs(full.pos.y - s.pos.y) + Math.abs(full.pos.z - s.pos.z) < 1) delete full.pos
      if (full.hp === s.hp) delete full.hp
      if (full.food === s.food) delete full.food
      if (full.xp === s.xp) delete full.xp
      if (full.held === s.held) delete full.held
      if (!full.jobs.length && !s.jobsLen) delete full.jobs
    }
    lastTickSnap = { pos: round(e.position), hp: bot.health, food: bot.food, xp: bot.experience.level, held: bot.heldItem ? bot.heldItem.name : null, jobsLen: (full.jobs || []).length }
    ok(res, full)
  } catch (e) { err(res, e) }
})

app.get('/state', (req, res) => {
  if (!ready) return err(res, new Error('bot not spawned yet'))
  const e = bot.entity
  ok(res, {
    pos: round(e.position),
    yaw: +(bot.entity.yaw).toFixed(2), pitch: +(bot.entity.pitch).toFixed(2),
    health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
    xpLevel: bot.experience.level,   // enchanting currency — the table's offers cost levels
    ...(() => { const w = waterState(bot); return w ? { inWater: w.inWater, submerged: w.submerged, inCurrent: w.current, buried: w.buried } : {} })(),
    onGround: e.onGround, dimension: bot.game.dimension, gameMode: bot.game.gameMode,
    timeOfDay: bot.time.timeOfDay,
    held: heldInfo(),
    lookingAt: (() => { const b = bot.blockAtCursor(5); return b ? { name: b.name, pos: round(b.position) } : null })()
  })
})

app.get('/inventory', (req, res) => {
  if (!ready) return err(res, new Error('not ready'))
  const dur = (i) => (i.maxDurability > 0)
    ? { durability: i.maxDurability - (i.durabilityUsed || 0), maxDurability: i.maxDurability } : {}
  const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot, ...dur(i) }))
  // worn armor (slots 5..8) + offhand (45) never show in items() — report them with durability
  const armorNames = ['head', 'torso', 'legs', 'feet']
  const worn = [5, 6, 7, 8].map((s, idx) => {
    const it = bot.inventory.slots[s]
    return it ? { slot: armorNames[idx], name: it.name, ...dur(it) } : null
  }).filter(Boolean)
  const off = bot.inventory.slots[45]
  if (off) worn.push({ slot: 'offhand', name: off.name, ...dur(off) })
  ok(res, { items, worn, emptySlots: bot.inventory.emptySlotCount() })
})

// GET /toss?name=&count=&to= : drop an item for a player to pick up (hand off tools/loot). Faces
// the named player first (via ?to=) so the item lands near them, then tosses. count defaults to
// the whole stack. This is how the bot GIVES — the co-op other half of the helmsman handing me things.
app.get('/toss', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const name = req.query.name
    if (!name) return err(res, new Error('name required'))
    const toward = req.query.to
    const towardEntity = toward && playerEntity(toward)
    if (towardEntity && playerSighting(towardEntity, reflexes.find(r => r.name === 'combat').fairFill(bot))) {
      try { await bot.lookAt(towardEntity.position.offset(0, 0.4, 0), true) } catch (e) {}
    }
    const item = bot.inventory.items().find(i => i.name === name || i.name.includes(name))
    if (!item) return err(res, new Error(`no ${name} in inventory`))
    const n = req.query.count != null ? Math.min(parseInt(req.query.count), item.count) : item.count
    await bot.toss(item.type, null, n)
    ok(res, { tossed: item.name, count: n, toward: toward || null })
  } catch (e) { err(res, e) }
})

app.get('/find', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const name = req.query.name
    const count = parseInt(req.query.count || '5')
    const radius = parseInt(req.query.radius || '64')
    const ids = resolveBlockIds(name)
    if (!ids.length) return err(res, new Error(`unknown block: ${name}`))
    const here = bot.entity.position
    // FAIRNESS: only report blocks a player here could actually see (exposed, line of sight, lit).
    // ?xray=1 bypasses to the raw spatial index — that IS the cheat, kept for debugging only.
    if (req.query.xray === '1') {
      const positions = bot.findBlocks({ matching: ids, maxDistance: radius, count })
      const results = positions.map(p => ({ pos: { x: p.x, y: p.y, z: p.z }, name: bot.blockAt(p)?.name, dist: +here.distanceTo(p).toFixed(1) })).sort((a, b) => a.dist - b.dist)
      return ok(res, { count: results.length, blocks: results, xray: true })
    }
    const vis = findVisible(ids, radius, count)
    const results = vis.map(v => ({ pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z }, name: bot.blockAt(v.pos)?.name, dist: +v.dist.toFixed(1) }))
    ok(res, { count: results.length, blocks: results, visibleOnly: true })
  } catch (e) { err(res, e) }
})

// fairness (07-12): an entity sealed behind rock — not sharing my connected air — is imperceptible,
// same rule as ore. ?all=1 is the debug bypass (like /find xray).
// EYE-RAY (07-17, the entity-sense extension the helmsman asked for): the air-flood caps at
// ~34 for cost, but a big cavern, a chasm, or open terrain gives TRUE line of sight far beyond
// it — and the server honestly tracks monsters to ~128. A straight unobstructed ray from my eyes
// is the strictest perception there is: fair by construction, no flood needed. ~0.5-block
// sampling; glass/leaves count as walls (honest: pixel sight, not entity-ESP).
function losClear(from, to) {
  try {
    const d = to.minus(from); const len = d.norm()
    if (len > 160) return false               // past honest server tracking — nothing to see
    const steps = Math.max(1, Math.ceil(len * 2))
    const step = d.scaled(1 / steps)
    let p = from
    for (let i = 1; i < steps; i++) {
      p = p.plus(step)
      const b = bot.blockAt(p.floored())
      if (!b) return false                    // unloaded chunk in the way — can't claim sight
      if (b.boundingBox === 'block') return false
    }
    return true
  } catch (e) { return false }
}
function entityPerceptible(en, fill) {
  try {
    // An invisible player shows neither body nor nametag.
    if (en.type === 'player' && isInvisible(en)) return false
    const p = en.position.floored()
    if (touchesFill(p, fill) || fill.cells.has(ck(p.x, p.y, p.z)) || fill.cells.has(ck(p.x, p.y + 1, p.z))) return true
    // last resort: the eye-ray — sight across caverns/chasms the flood can't afford to fill
    return losClear(bot.entity.position.offset(0, 1.62, 0), en.position.offset(0, 1.0, 0))
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
// ---- player locator (07-14, the helmsman's ask: "so we avoid 'where I am' and in case we ever get
// lost from each-other"). Consented co-op sense: live position when the server tracks them,
// last-seen breadcrumb (pos + age + heading) when out of range. Breadcrumbs update every 5s.
const playerCrumbs = Object.create(null)
// The ids of the entities loaded at the last dimension change that the server has not updated since.
const staleEntities = new Set()
for (const ev of ['entitySpawn', 'entityMoved', 'entityUpdate', 'entityGone']) bot.on(ev, (e) => { if (e) staleEntities.delete(e.id) })
// The entities besides the body that the server updated since the last dimension change.
function liveEntities () {
  return Object.values(bot.entities).filter(e => e && e !== bot.entity && !staleEntities.has(e.id))
}
// The player named name by their entity. bot.players can lack the entity of a player the server tracks.
function playerEntity (name) {
  return playerNamed(bot.entities, name, (e) => staleEntities.has(e.id))
}
function trackedPlayers () {
  return playersAround(bot.entities, bot.entity, (e) => staleEntities.has(e.id))
}
// How the bot perceives player en: seen with the exact distance, by the nametag from its 5-block cube, or null.
function playerSighting (en, fill) {
  const me = bot.entity.position
  if (entityPerceptible(en, fill)) return { tier: 'seen', dist: Math.round(en.position.distanceTo(me)), bearing: compass(en.position.x - me.x, en.position.z - me.z) }
  if (!nametagVisible(en)) return null
  const c = crumbCentre(en.position)
  return { tier: 'nametag', dist: Math.round(c.distanceTo(me) / 5) * 5, bearing: compass(c.x - me.x, c.z - me.z) }
}
// The block a chat line points at with "here", "there", "this" or "that": the one its speaker looks at as
// it arrives, when the bot sees the speaker within POINT_RANGE and sees that block too. Else null.
function chatPointer (from, msg) {
  if (!ready || !deictic(msg)) return null
  const en = playerEntity(from)
  if (!en || en.position.distanceTo(bot.entity.position) > POINT_RANGE) return null
  if (!entityPerceptible(en, reflexes.find(r => r.name === 'combat').fairFill(bot))) return null
  const eye = en.position.offset(0, en.crouching ? 1.27 : 1.62, 0)
  const hit = lookedAt(eye, en.headYaw ?? en.yaw, en.pitch, (p) => bot.blockAt(p))
  if (!hit || !seesLit(hit.cell, 64)) return null
  return { block: hit.block.name, x: hit.cell.x, y: hit.cell.y, z: hit.cell.z }
}
// A crumb's nametag is true when the player was known only by the nametag.
function recordCrumbs () {
  try {
    let fill = null
    for (const en of trackedPlayers()) {
      const name = en.username
      const seen = entityPerceptible(en, fill ??= airFlood({ radius: 34, cap: 15000 }))
      if (!seen && !nametagVisible(en)) continue
      const prev = playerCrumbs[name]
      const pos = seen ? en.position.clone() : crumbCentre(en.position)
      playerCrumbs[name] = { pos, t: Date.now(), nametag: !seen, prev: prev ? { pos: prev.pos, t: prev.t } : null }
    }
  } catch (e) {}
}
setInterval(recordCrumbs, 5000)
let crumbDimension = null
function forgetCrumbsElsewhere () {
  if (bot.game.dimension === crumbDimension) return
  crumbDimension = bot.game.dimension
  for (const name of Object.keys(playerCrumbs)) delete playerCrumbs[name]
  staleEntities.clear()
  for (const e of Object.values(bot.entities)) if (e !== bot.entity) staleEntities.add(e.id)
  resetThreatState()
}
bot.on('game', forgetCrumbsElsewhere)
// What the last presence event said about each player name.
const presence = new Map()
// True once the first player entity was logged against bot.players.
let playersLogged = false
// Emits a player event on each presence change, except for the followed player, whom follow reports.
function presenceTick () {
  try {
    const around = trackedPlayers()
    if (!playersLogged && around.length) {
      playersLogged = true
      const players = bot.players || {}
      const withEntity = Object.keys(players).filter(n => players[n] && players[n].entity)
      console.log(`[players] bot.players: ${Object.keys(players).join(', ') || 'none'} (with an entity: ${withEntity.join(', ') || 'none'}), player entities: ${around.map(e => e.username).join(', ')}`)
    }
    let fill = null
    const sightings = []
    for (const en of around) {
      const s = playerSighting(en, fill ??= airFlood({ radius: 34, cap: 15000 }))
      if (s) sightings.push({ name: en.username, ...s })
    }
    const quiet = new Set(followState ? [followState.name] : [])
    for (const ev of presenceUpdate(presence, sightings, { now: Date.now(), quiet })) emitEvent('player', presenceText(ev), ev)
  } catch (e) {}
}
setInterval(() => { if (ready && bot.entity) presenceTick() }, 2000)
function crumbFix (c, me) {
  const agoSec = Math.round((Date.now() - c.t) / 1000)
  const bearing = compass(c.pos.x - me.x, c.pos.z - me.z)
  if (c.nametag) return { agoSec, dist: Math.round(c.pos.distanceTo(me) / 5) * 5, bearing }
  return { lastSeen: { x: Math.round(c.pos.x), y: Math.round(c.pos.y), z: Math.round(c.pos.z) }, agoSec, dist: +c.pos.distanceTo(me).toFixed(0), bearing }
}
// /pathdebug?secs=30 — tap the pathfinder's event stream into bot.log for N seconds.
// Built 07-14 night for the doors-v2 hunt: stalls with no error and no movement need the
// planner's own words — path_update statuses and especially path_reset REASONS.
app.get('/pathdebug', (req, res) => {
  try {
    const secs = Math.min(120, parseInt(req.query.secs || '30'))
    const handlers = {
      path_update: (r) => console.log(`[pathdebug] update: status=${r && r.status} pathLen=${r && r.path && r.path.length} cost=${r && r.cost}`),
      path_reset: (reason) => console.log(`[pathdebug] RESET: ${reason}`),
      goal_updated: (goal, dynamic) => console.log(`[pathdebug] goal set (dynamic=${!!dynamic})`),
      goal_reached: () => console.log('[pathdebug] goal REACHED')
    }
    for (const [ev, fn] of Object.entries(handlers)) bot.on(ev, fn)
    setTimeout(() => { try { for (const [ev, fn] of Object.entries(handlers)) bot.removeListener(ev, fn) } catch (e) {} }, secs * 1000)
    ok(res, { tapping: secs })
  } catch (e) { err(res, e) }
})

// /useon?name=<entity>&item=<item> — right-click a creature with a held item: shears on
// sheep, bucket on cow, saddle on horse. The husbandry verb (07-14, built pen-side with the
// first flock waiting). Walks into reach if needed; nearest matching entity within 16.
app.get('/useon', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const ename = req.query.name
    const iname = req.query.item
    const it = bot.inventory.items().find(i => i.name === iname)
    if (!it) return err(res, new Error(`no ${iname} in inventory`))
    const here = bot.entity.position
    const target = liveEntities()
      .filter(en => en.position && (en.name === ename || en.displayName === ename) && en.position.distanceTo(here) <= 16)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
    if (!target) return err(res, new Error(`no ${ename} within 16`))
    if (target.position.distanceTo(here) > 3) {
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2))
    }
    await bot.equip(it, 'hand')
    await bot.lookAt(target.position.offset(0, 0.6, 0), true)
    await bot.waitForTicks(2)
    await bot.useOn(target)
    ok(res, { used: iname, on: ename, at: round(target.position) })
  } catch (e) { err(res, e) }
})
// ---- /strike (07-15): the deliberate single swing — /useon's left-click twin, and THE livestock
// cull verb (first target: a chicken, the helmsman's arrow pipeline). Tier-2 by design: one approach, one
// aimed swing, report what happened. The /fight engage-loop and the combat reflex build on this.
// Doctrine baked in, not left to pilot memory: NEVER strikes players (consent=1 reserved for the
// friendly-fire validation ritual, still refused until damage attribution exists to verify with);
// NEVER melees creepers (detect→flee is law — refuse loudly so the pilot never learns the habit).
app.get('/strike', async (req, res) => {
  // The ids of the entities that died while the swings ran.
  const died = new Set()
  const onDead = (en) => died.add(en.id)
  let lane = null
  try {
    if (!ready) return err(res, new Error('not ready'))
    const ename = req.query.name
    if (!ename) return err(res, new Error('need name='))
    const iname = req.query.item || 'iron_sword'
    const it = bot.inventory.items().find(i => i.name === iname)
    if (!it) return err(res, new Error(`no ${iname} in inventory — refusing to punch with bare hands/wrong tool`))
    const here = bot.entity.position
    const target = liveEntities()
      .filter(en => en.position && (en.name === ename || en.displayName === ename) && en.position.distanceTo(here) <= 16)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
    if (!target) return err(res, new Error(`no ${ename} within 16`))
    if (target.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === target))) {
      return err(res, new Error('refusing: never strike players (friendly-fire tests wait for damage attribution)'))
    }
    if (/creeper/.test(String(target.name))) {
      return err(res, new Error('refusing: never melee a creeper — flee is the law'))
    }
    lane = claimLane('strike', 20000)              // soft lane: the approach + swings are MINE (07-21)
    // ?max=N (07-21 latency session): bounded swing SEQUENCE in one round trip — re-acquire,
    // approach, swing, dead-watch, repeat. Exits honestly: dead / target gone / max.
    const max = Math.min(5, Math.max(1, parseInt(req.query.max || '1')))
    let struckAt = null, dead = false, swings = 0
    bot.on('entityDead', onDead)
    for (let i = 0; i < max && !dead; i++) {
      const p0 = bot.entity.position
      const tgt = i === 0 ? target : liveEntities()
        .filter(en => en.position && (en.name === ename || en.displayName === ename) && en.position.distanceTo(p0) <= 16)
        .sort((a, b) => a.position.distanceTo(p0) - b.position.distanceTo(p0))[0]
      if (!tgt) break
      if (tgt.position.distanceTo(p0) > 3) {
        await bot.pathfinder.goto(new goals.GoalNear(tgt.position.x, tgt.position.y, tgt.position.z, 2))
      }
      const alreadyHeld = bot.heldItem && bot.heldItem.name === iname
      await bot.equip(it, 'hand')
      if (LEGACY_1710) {
        // 1.7.10 has no attack charge, and a swing goes out LEGACY_HIT_MS after the last attack.
        const due = lastAttackT + LEGACY_HIT_MS - Date.now()
        if (due > 0) await new Promise(r => setTimeout(r, due))
        await bot.lookAt(tgt.position.offset(0, 0.6, 0), true)
      } else {
        // 13 ticks after an equip cover a sword's full attack charge, and 11 more wait between swings.
        if (!alreadyHeld) await bot.waitForTicks(13)
        else if (i > 0) await bot.waitForTicks(11)
        await bot.lookAt(tgt.position.offset(0, 0.6, 0), true)
        await bot.waitForTicks(2)                    // the tick race: aim packet lands NEXT tick
      }
      struckAt = tgt.position.clone()
      bot.attack(tgt)
      lastAttackT = Date.now()
      swings++
      // watch for the death or the despawn instead of guessing a delay (the 700ms check called a real kill a miss)
      for (let w = 0; w < 15 && !dead; w++) {
        // On 1.7.10 the watch ends before the next swing is due.
        if (LEGACY_1710 && i < max - 1 && Date.now() + 100 > lastAttackT + LEGACY_HIT_MS) break
        await new Promise(r => setTimeout(r, 100))
        dead = died.has(tgt.id) || !bot.entities[tgt.id]
      }
    }
    if (dead && struckAt) {
      try { await bot.pathfinder.goto(new goals.GoalNear(struckAt.x, struckAt.y, struckAt.z, 1)) } catch (e) {}  // hoover the drops
    }
    ok(res, { struck: ename, with: iname, swings, at: struckAt ? round(struckAt) : null, killed: dead, note: dead ? 'walked to drops' : swings ? 'still standing — swing again deliberately' : 'target left reach' })
  } catch (e) { err(res, e) } finally { releaseLane(lane); bot.removeListener('entityDead', onDead) }
})

// ---- /shoot (07-15, built the day the helmsman handed me a bow): the ranged verb — draw, hold a full
// charge (~1.1s), loose. Bow is my PRIMARY weapon by doctrine (suits pilot latency), and unlike
// /strike it may target creepers — shooting them from range is exactly what the doctrine orders.
// Players stay refused, same as /strike. v1 aim: lookAt with a small distance-scaled elevation
// hold-over (no hawkeye ballistics yet — good inside ~20 blocks; tune the 0.018 live). No
// approach walk: ranged means shoot from where I stand; needs LOS and <=25 blocks.
app.get('/shoot', async (req, res) => {
  // The ids of the entities that died while the shots ran.
  const died = new Set()
  const onDead = (en) => died.add(en.id)
  try {
    if (!ready) return err(res, new Error('not ready'))
    const ename = req.query.name
    if (!ename) return err(res, new Error('need name='))
    // ?max=N (07-21 latency session): a bounded VOLLEY in one round trip — the assault's
    // hand-rolled bash loops (four arrows = four turns + sleeps ≈ 15s of wall time) move
    // into the body, where they run at game speed. Honest exits: dead, target gone,
    // out of arrows, max reached — or NO-PROGRESS (two arrows, range unchanged = you are
    // shooting a wall; the pilot burned ~8 arrows learning this rule, now the verb knows it).
    const max = Math.min(8, Math.max(1, parseInt(req.query.max || '1')))
    const shots = []
    let outcome = 'max'
    bot.on('entityDead', onDead)
    for (let i = 0; i < max; i++) {
      if (!bot.inventory.items().find(x => x.name === 'bow')) { outcome = 'no-bow'; break }
      if (!bot.inventory.items().some(x => x.name === 'arrow')) { outcome = 'no-arrows'; break }
      const here = bot.entity.position
      const target = liveEntities()
        .filter(en => en.position && (en.name === ename || en.displayName === ename) && en.position.distanceTo(here) <= 25)
        .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
      if (!target) { outcome = shots.length ? 'no-target' : null; if (!shots.length) return err(res, new Error(`no ${ename} within 25`)); break }
      if (target.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === target))) {
        return err(res, new Error('refusing: never shoot players'))
      }
      const dist = target.position.distanceTo(here)
      await drawAndLoose(target)                    // the same arrow the combat reflex fires
      let dead = false
      for (let w = 0; w < 20 && !dead; w++) {
        await new Promise(r => setTimeout(r, 100))
        dead = died.has(target.id) || !bot.entities[target.id]
      }
      shots.push({ dist: +dist.toFixed(1), killed: dead })
      if (dead) { outcome = 'dead'; break }
      const prev = shots[shots.length - 2]
      if (prev && Math.abs(prev.dist - dist) < 0.6) { outcome = 'no-progress'; break }
    }
    const last = shots[shots.length - 1] || {}
    ok(res, {
      shot: ename, shotsFired: shots.length, shots, outcome,
      dist: last.dist, killed: !!last.killed,
      note: outcome === 'dead' ? 'down'
        : outcome === 'no-progress' ? 'range never changed — something between us; reposition, do not loose again'
        : outcome === 'no-arrows' ? 'quiver empty'
        : 'still up — check where the arrow went (/gaze) and loose again'
    })
  } catch (e) { err(res, e) } finally { bot.removeListener('entityDead', onDead) }
})
// A player in sight gets the exact position, one known by the nametag a bearing and a rough distance, else the crumb.
function whereIs (name) {
  const me = bot.entity.position
  const en = playerEntity(name)
  const s = en && playerSighting(en, airFlood({ radius: 34, cap: 15000 }))
  if (s && s.tier === 'seen') {
    const p = en.position
    return { name, live: true, pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, dist: s.dist, bearing: s.bearing }
  }
  if (s) return { name, live: true, nametag: true, dist: s.dist, bearing: s.bearing }
  const c = playerCrumbs[name]
  if (!c) return { name, live: false, note: 'never seen this session' }
  let heading = null
  if (c.prev && c.pos.distanceTo(c.prev.pos) > 1) heading = compass(c.pos.x - c.prev.pos.x, c.pos.z - c.prev.pos.z)
  return { name, live: false, ...crumbFix(c, me), heading }
}
app.get('/where', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const name = req.query.name || process.env.MC_OWNER
    if (!name) return err(res, new Error('need name= (or set MC_OWNER in the environment for a default)'))
    ok(res, whereIs(name))
  } catch (e) { err(res, e) }
})
// Players go by their username, every other entity by its type name.
function entityLabel (en) {
  return (en.type === 'player' && en.username) || en.name || en.username || en.displayName
}
app.get('/entities', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const radius = parseInt(req.query.radius || '24')
    const here = bot.entity.position
    const fill = req.query.all === '1' ? null : airFlood({ radius: Math.min(radius + 4, 34), cap: 15000 })
    const list = liveEntities()
      .filter(en => en.position && en.position.distanceTo(here) <= radius)
      .filter(en => !fill || entityPerceptible(en, fill))
      .map(en => ({
        type: en.type, name: entityLabel(en),
        pos: round(en.position), dist: +en.position.distanceTo(here).toFixed(1)
      }))
      .sort((a, b) => a.dist - b.dist).slice(0, 30)
    ok(res, { count: list.length, entities: list })
  } catch (e) { err(res, e) }
})

// pathfinder.stop() while the pathfinder is IDLE latches a pending stop that silently aborts the
// NEXT path ("Path was stopped before it could be completed" on a perfectly good goal — the
// long-mysterious "stale latch"). Only ever stop a pathfinder that actually has a goal or motion.
function safeStop () {
  try { if (bot.pathfinder.goal || bot.pathfinder.isMoving()) bot.pathfinder.stop() } catch (e) {}
}
// Stops the pathfinder at once. A goal set right after it stands, while safeStop() alone latches a
// stop that cancels the next goal.
function stopPath () {
  safeStop()
  bot.pathfinder.setGoal(null)
}

// Ends every walk route, job and movement for an unexplained hit, a path still being planned included.
function freezeBody () {
  takeLegs('hurt', 'freeze after an unexplained hit')
  stopPath()
  try { bot.clearControlStates() } catch (e) {}
}

// When the drown rescue lets go of jump.
let swimUpUntil = 0
// Holds jump for ms to surface.
function swimUp (ms) {
  swimUpUntil = Date.now() + ms
  bot.setControlState('jump', true)
  setTimeout(() => { try { if (Date.now() >= swimUpUntil) bot.setControlState('jump', false) } catch (e) {} }, ms)
}

// The pathfinder's own path array, which it shifts as the feet reach each node.
let livePath = []
bot.on('path_update', (r) => { livePath = r.path })
// True from a sprint jump's take-off until the body stands on the ground short of the next node.
let hopping = false
// The step of the straight run the last sprint jump took off along.
let hopDir = null
// True while sprintTick holds jump.
let jumpHeld = false
// Ticks off the path nodes a hop passed.
function skipPassedNodes () {
  if (!hopping || !bot.pathfinder.isMoving()) return
  const passed = passedNodes(livePath, bot.entity.position, hopDir)
  livePath.splice(0, passed)
  if (!passed && bot.entity.onGround) hopping = false
}
// Lets go of a sprint jump the pathfinder no longer steers. Its resets on a block update, a chunk load and a
// moved goal keep the control states it set.
function releaseJump () {
  if (!hopping && !jumpHeld) return
  hopping = false
  jumpHeld = false
  for (const c of ['jump', 'sprint', 'forward']) bot.setControlState(c, false)
}
// The last [sprint] line, the goal of its walk and its time.
let sprintSaid = { line: null, goal: null, at: 0 }
// Holds jump on top of the pathfinder's sprint along a straight, flat stretch.
function sprintTick () {
  if (!bot.pathfinder.isMoving()) return releaseJump()
  const combat = reflexes.find(r => r.name === 'combat')
  const why = !bot.getControlState('sprint') ? 'not sprinting' : noJumpReason({
    path: livePath,
    pos: bot.entity.position,
    onGround: bot.entity.onGround,
    blockAt: (p) => bot.blockAt(p),
    inWater: bot.entity.isInWater,
    food: bot.food,
    fighting: combat.active || Date.now() < combat._fleeUntil
  })
  // A new goal logs at once, a changed decision at most every 5 s, and 'off the ground' never logs.
  const line = why ? `no jump: ${why}` : 'jump held'
  const goal = bot.pathfinder.goal
  if (why !== 'off the ground' && (goal !== sprintSaid.goal || (line !== sprintSaid.line && Date.now() - sprintSaid.at >= 5000))) {
    sprintSaid = { line, goal, at: Date.now() }
    const p = bot.entity.position.floored()
    console.log(`[sprint] ${line} at ${p.x} ${p.y} ${p.z}`)
  }
  jumpHeld = !why
  if (jumpHeld) {
    bot.setControlState('jump', true)
    hopping = true
    hopDir = nodeStep(livePath[0], livePath[1])
  }
}

// Ahead of the pathfinder's listener, so it never steers back to a node a hop passed.
function beforePathfinder () {
  if (!ready || !bot.entity) return
  try { skipPassedNodes() } catch (e) { console.log('[sprint] ' + e.message) }
}
// After the pathfinder's listener, so these act on the control states it just set.
function afterPathfinder () {
  if (!ready || !bot.entity) return
  try { sprintTick() } catch (e) { console.log('[sprint] ' + e.message) }
  try { closeDoorsBehind() } catch (e) { console.log('[doors] ' + e.message) }
}
// The plugin loader adds the pathfinder's listener on inject_allowed, after bot.js has run.
function hookTicks () {
  bot.prependListener('physicsTick', beforePathfinder)
  bot.once('inject_allowed', () => bot.on('physicsTick', afterPathfinder))
  bot.on('path_reset', () => { try { releaseJump() } catch (e) { console.log('[sprint] ' + e.message) } })
}
hookTicks()

// The status of the last path_update.
let lastPathStatus = null
// One bot.log line per pathfinder event, and per planning for its partial updates.
function logPathEvents () {
  bot.on('goal_reached', () => console.log('[path] goal reached'))
  bot.on('path_update', (r) => {
    if (r.status !== 'partial' || lastPathStatus !== 'partial') console.log(`[path] update ${r.status}, ${r.path.length} nodes`)
    lastPathStatus = r.status
  })
  bot.on('path_reset', (reason) => console.log(`[path] reset ${reason}`))
  bot.on('path_stop', () => console.log('[path] stop'))
}
logPathEvents()

// maxY is exclusive.
function worldColumn () {
  return { minY: bot.game.minY, maxY: bot.game.minY + bot.game.height }
}

// What resolveTarget reads, gated by what the bot perceives.
function walkSources () {
  let fill = null
  return {
    blockAt: (p) => bot.blockAt(p),
    column: worldColumn(),
    waypoint: (name) => waypoints.get(name),
    player: (name) => playerEntity(name),
    crumb: (name) => {
      const c = playerCrumbs[name]
      return c ? { pos: c.pos, nametag: c.nametag, agoSec: Math.round((Date.now() - c.t) / 1000) } : null
    },
    known: (en) => entityPerceptible(en, fill ??= airFlood({ radius: 34, cap: 15000 })),
    nametag: nametagVisible,
    visibleBlock: (name) => nearestVisible(resolveBlockIds(name), 64),
    cellKnown
  }
}

const WALK_HINTS = {
  'no-path': 'the goal is walled off for a walker (canDig=false), reachable only by digging. Decide if a /dig_stair or /dig_tunnel is worth it, or pick an open point',
  walled: 'reachable only by digging. Decide if a /dig_stair or /dig_tunnel is worth it, or pick an open point',
  sealed: 'pick an open cell, or carve to it deliberately with /dig_stair or /dig_tunnel, your call',
  stalled: 'goal is likely unreachable without digging. Decide if it is worth a /dig_stair or /dig_tunnel, or pick a reachable point',
  'not-reached': 'call /goto again, or pick a reachable point',
  stopped: 'check /jobs, wait a beat, try again',
  bunker: BUNKER_WALK,
  'boxed-in': 'dig out deliberately (/dig_stair toward open space), the pathfinder cannot help from here',
  'no-floor': 'nothing to stand on in that column, pick another point',
  budget: 'try again to continue, or shorten the goal',
  risky: 'risk says what is wrong and plan holds the numbers. Pick another point, or walk it anyway with accept',
  unresolved: 'the target is unloaded or out of sight from here, so there is no plan yet. Walk toward it first'
}
// The reply reason for each way a walk attempt ends short of the goal.
const WALK_FAILED = { done: 'not-reached', emptied: 'not-reached', stalled: 'stalled', 'no-path': 'no-path', timeout: 'no-path', stopped: 'stopped' }

function walkReply (r, reason) {
  const me = bot.entity.position
  const reply = { arrived: !reason, kind: r.kind, target: r.target, pos: round(me), dist: null, reason: reason || null, hint: (reason && WALK_HINTS[reason]) || null }
  if (r.agoSec !== undefined) reply.agoSec = r.agoSec
  // A nametag target is aimed at from the centre of its 5-block cube.
  const aim = r.nametag ? crumbCentre(r.cell) : r.cell ? { x: r.cell.x + 0.5, z: r.cell.z + 0.5 } : r.toward
  if (!aim) return reply
  const dist = Math.hypot(aim.x - me.x, aim.z - me.z)
  if (!r.nametag) return { ...reply, dist: +dist.toFixed(1) }
  return { ...reply, dist: Math.round(dist / 5) * 5, bearing: compass(aim.x - me.x, aim.z - me.z) }
}

function walkRoute () {
  const mark = legs.mark()
  const route = { goal: null, taken: false, mark }
  const onGoal = (g) => { if (g && g !== route.goal) route.taken = true }
  const deadline = routeDeadline({ onExpire: () => releaseGoal(route) })
  let last = bot.entity.position.clone()
  let walked = 0
  const onMove = () => {
    const p = bot.entity.position
    const stride = Math.hypot(p.x - last.x, p.z - last.z)
    // A server teleport is no walk.
    if (stride < 4) walked += stride
    last = p.clone()
  }
  bot.on('goal_updated', onGoal)
  bot.on('move', onMove)
  route.expired = deadline.expired
  route.left = deadline.left
  route.stopped = () => route.taken || legs.mark() !== mark
  // The horizontal distance the body moved during the route.
  route.walked = () => Math.round(walked * 10) / 10
  route.end = () => {
    deadline.cancel()
    bot.removeListener('goal_updated', onGoal)
    bot.removeListener('move', onMove)
    releaseGoal(route)
  }
  return route
}

// A stopped reply names the reflex that took the legs since mark, a legs.mark().
function namedStop (reply, mark) {
  const taken = reply.reason === 'stopped' ? legs.takenSince(mark) : null
  return taken ? { ...reply, takenBy: takenText(taken) } : reply
}

// Clears the route's own goal, never one someone else set.
function releaseGoal (route) {
  if (route.goal && bot.pathfinder.goal === route.goal) stopPath()
}

// Why the route is over, or null.
function routeEnd (route) {
  if (bunker.building) return 'bunker'
  if (route.expired()) return 'budget'
  if (route.stopped()) return 'stopped'
  return null
}

function pause (route, ms) {
  return new Promise(resolve => setTimeout(resolve, Math.min(ms, route.left())))
}

async function walkOnce (goal, route, stallMs) {
  if (routeEnd(route)) return routeEnd(route)
  route.goal = goal
  const how = await walkAttempt(bot, goal, { stallMs, thinkTimeout: bot.pathfinder.thinkTimeout })
  if (how === 'changed') route.taken = true
  if (routeEnd(route)) return routeEnd(route)
  if (['stalled', 'timeout', 'no-path', 'emptied'].includes(how)) releaseGoal(route)
  return how
}

// Returns null after a block of progress, else why it made none or why the route ended.
async function hopToward (dest, route, { stallMs, segLen }) {
  const from = bot.entity.position.clone()
  const dx = dest.x - from.x
  const dz = dest.z - from.z
  const t = Math.min(1, segLen / Math.max(Math.hypot(dx, dz), 1e-6))
  const hx = from.x + dx * t
  const hz = from.z + dz * t
  const hy = dest.y == null ? from.y : from.y + (dest.y - from.y) * t
  const cell = standCell((p) => bot.blockAt(p), hx, hz, hy, worldColumn())
  const goal = cell && cell !== UNLOADED ? new goals.GoalNear(cell.x, cell.y, cell.z, 2) : new goals.GoalNearXZ(hx, hz, 2)
  const how = await walkOnce(goal, route, stallMs)
  if (routeEnd(route)) return routeEnd(route)
  if (how === 'stopped') return 'stopped'
  if (bot.entity.position.distanceTo(from) >= 1) return null
  return how === 'no-path' ? 'no-path' : 'stalled'
}

function flatTo (p) {
  return Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z)
}

async function drillDoorway (route) {
  await pause(route, 700)
  try { return await doorwayCommit(route) } catch (e) { console.log('[doorway] commit failed: ' + e.message); return null }
}

// The pathfinder's plan for goal from where the body stands, worked out a slice per tick without walking.
// Null once the route ended.
async function planPath (goal, route) {
  const search = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, bot.entity.position, goal)
  for (;;) {
    const { result } = search.next().value
    if (result.status !== 'partial') return result
    await bot.waitForTicks(1)
    if (routeEnd(route)) return null
  }
}

// Hops toward a target it cannot resolve yet, then walks onto it, retrying a path stop, a stall and a planning timeout once each.
// The walk is planned first and refused when planRisk objects, unless accept. preview answers the plan and walks nothing.
async function stagedGoto (q, route, { stallMs = 4500, segLen = 18, preview = false, accept = false } = {}) {
  const opts = { stallMs, segLen }
  if (q.block !== undefined && !resolveBlockIds(q.block).length) return walkReply({ kind: 'block', target: { block: q.block } }, 'unknown')
  let r = resolveTarget(q, walkSources())
  if (r.reason) return walkReply(r, r.reason)
  if (!hasLegalMove()) return walkReply(r, 'boxed-in')
  // A plan toward a nametag would end in the player's cube.
  if (preview && (r.toward || r.nametag)) return { ...walkReply(r, 'unresolved'), plan: null }
  // A stalled hop gets the doorway drill again once the bot has moved a block since the last one.
  let drilledAt = null
  let stuck = null
  const drill = async () => {
    const out = await drillDoorway(route)
    stuck = out && out.through === false ? out : null
  }
  const gaveUp = (reason) => {
    if (reason !== 'stalled' || !stuck) return walkReply(r, reason)
    const { door: d, why } = stuck
    return { ...walkReply(r, 'door'), hint: `the ${d.name} at ${d.x},${d.y},${d.z} ${why}. Open or close it with activate and walk again, or pick another way` }
  }
  // A player known now by the nametag is walked toward in hops, each aimed at the cube the nametag shows in.
  while (r.toward || (r.live && flatTo(r.cell) > segLen)) {
    if (r.toward && flatTo(r.toward) <= 2) return walkReply(r, 'no-floor')
    const stop = await hopToward(r.toward || r.cell, route, opts)
    if (stop === 'stalled' && !(drilledAt && bot.entity.position.distanceTo(drilledAt) < 1)) {
      drilledAt = bot.entity.position.clone()
      await drill()
    } else if (stop) return gaveUp(stop)
    r = resolveTarget(q, walkSources())
    if (r.reason) return walkReply(r, r.reason)
  }
  // A nametag target's cell is unseen.
  if (!r.nametag) {
    const pre = airPrecheck(r.cell, q.range ?? 0)
    if (pre.verdict === 'sealed' || pre.verdict === 'walled') return walkReply(r, pre.verdict)
  }
  if (preview || (!accept && !r.nametag)) {
    const planned = await planPath(r.goal, route)
    if (routeEnd(route)) return walkReply(r, routeEnd(route))
    const plan = summarizePlan(bot.entity.position, planned, cellKnown)
    if (preview) return { ...walkReply(r, null), arrived: false, plan }
    const askedY = q.waypoint !== undefined ? (waypoints.get(q.waypoint) || {}).y : q.y
    const risk = planRisk(plan, askedY, q.range ?? 0)
    if (risk) return { ...walkReply(r, 'risky'), plan, risk }
  }
  let retried = false
  let drilled = false
  let marched = false
  for (;;) {
    const how = await walkOnce(r.goal, route, stallMs)
    if (routeEnd(route)) return walkReply(r, routeEnd(route))
    if (arrivedAt(r.goal, bot.entity.position)) return walkReply(r, null)
    if ((how === 'stopped' || how === 'done') && !retried) {
      retried = true
      await pause(route, 350)
    } else if (how === 'stalled' && !drilled) {
      drilled = true
      await drill()
    } else if (how === 'timeout' && !marched) {
      marched = true
      while (flatTo({ x: r.cell.x + 0.5, z: r.cell.z + 0.5 }) > 2) {
        const stop = await hopToward(r.cell, route, opts)
        if (stop) return gaveUp(stop)
      }
    } else return gaveUp(WALK_FAILED[how])
  }
}

// Keeps only the target forms the pilot may name, never drop.
function gotoQuery (query) {
  const q = {}
  for (const k of ['x', 'y', 'z']) if (query[k] !== undefined) q[k] = parseFloat(query[k])
  for (const k of ['waypoint', 'player', 'block']) if (query[k] !== undefined) q[k] = query[k]
  if (query.range !== undefined) q.range = parseInt(query.range)
  return q
}

// The nearest door or gate the bot knows within 2 of its feet, or null.
function doorBeside () {
  const feet = bot.entity.position.floored()
  let best = null
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, 1]) {
    const p = feet.offset(dx, dy, dz)
    const b = bot.blockAt(p)
    if (!b || !isDoor(b.name) || !cellKnown(p)) continue
    const d = Math.hypot(dx, dz)
    if (best && best.d <= d) continue
    const props = b.getProperties() || {}
    // A door is named by its lower half.
    best = { d, name: b.name, x: p.x, y: props.half === 'upper' ? p.y - 1 : p.y, z: p.z, open: !!props.open }
  }
  if (!best) return null
  const { d, ...door } = best
  return door
}

app.get('/goto', async (req, res) => {
  let lane = null
  try {
    if (!ready) return err(res, new Error('not ready'))
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    const q = gotoQuery(req.query)
    if (['x', 'y', 'z'].some(k => k in q && !Number.isFinite(q[k]))) return err(res, new Error('x, y and z must be numbers'))
    const preview = req.query.preview === '1'
    lane = claimLane('goto', 300000)
    const route = walkRoute()
    let r
    try { r = await stagedGoto(q, route, { preview, accept: req.query.accept === '1' }) } finally { route.end() }
    if (preview) r.preview = true
    else if (r.reason) {
      r.walked = route.walked()
      const door = doorBeside()
      if (door) r.door = door
    }
    if (r.arrived && q.waypoint !== undefined) {
      if (lastWaypoint && lastWaypoint !== q.waypoint) waypoints.link(lastWaypoint, q.waypoint)
      lastWaypoint = q.waypoint
      journal('goto', 'went to ' + q.waypoint)
    }
    ok(res, namedStop(r, route.mark))
  } catch (e) { err(res, e) } finally { releaseLane(lane) }
})

app.get('/mine', async (req, res) => {
  try {
    const name = req.query.name
    const count = parseInt(req.query.count || '1')
    const radius = parseInt(req.query.radius || '64')
    const ids = resolveBlockIds(name)
    if (!ids.length) return err(res, new Error(`unknown block: ${name}`))
    let mined = 0
    // Why the collect stopped short: stalled or budget.
    let reason = null
    for (let i = 0; i < count; i++) {
      const b = nearestVisible(ids, radius)
      if (!b) break
      try {
        await collectSafely(b)
      } catch (e) {
        if (!e.reason) throw e
        reason = e.reason
        break
      }
      mined++
    }
    const have = bot.inventory.items().filter(it => it.name.includes(name) || name.includes(it.name))
      .reduce((s, it) => s + it.count, 0)
    ok(res, { mined, requested: count, inventoryMatching: have, reason })
  } catch (e) { err(res, e) }
})

function itemCounts () {
  const counts = {}
  for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count
  return counts
}

const { enclosedDrop } = require('./lib/drops')

function nearestDrop (radius, skip) {
  const here = bot.entity.position
  const fill = airFlood({ radius: Math.min(radius + 4, 34), cap: 15000 })
  return liveEntities()
    .filter(e => e.name === 'item' && e.position && !skip.has(e.id) && e.position.distanceTo(here) <= radius && entityPerceptible(e, fill))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0] || null
}

async function collectDrops (radius, route) {
  const skip = new Set()
  const missed = []
  for (;;) {
    if (routeEnd(route)) return { missed, reason: routeEnd(route) }
    const drop = nearestDrop(radius, skip)
    if (!drop) return { missed, reason: null }
    const r = await stagedGoto({ drop }, route)
    if (r.reason === 'stopped') return { missed, reason: 'stopped' }
    // A pickup lands a few ticks after the arrival.
    for (let i = 0; i < 10 && bot.entities[drop.id] && !routeEnd(route); i++) await bot.waitForTicks(2)
    if (!bot.entities[drop.id] || routeEnd(route)) continue
    skip.add(drop.id)
    const item = drop.getDroppedItem && drop.getDroppedItem()
    missed.push({ item: item ? item.name : 'item', pos: round(drop.position), reason: r.reason || 'not-picked-up' })
  }
}

// Marks each missed drop that no known cell a body fits in reaches as enclosed, with its cell.
function enclosedMisses (missed) {
  return missed.map(m => {
    const cell = enclosedDrop(m.pos, { blockAt: (p) => bot.blockAt(p), known: cellKnown })
    return cell ? { ...m, reason: 'enclosed', cell: xyz(cell) } : m
  })
}

// The collect reply's hint for drops no body reaches.
function enclosedHint (missed) {
  const cells = missed.filter(m => m.reason === 'enclosed').map(m => `${m.cell.x},${m.cell.y},${m.cell.z}`)
  return cells.length ? `enclosed at ${cells.join(' and ')}: dig to it, or place a block into its cell to push it out` : null
}

app.get('/collect', async (req, res) => {
  let lane = null
  try {
    if (!ready) return err(res, new Error('not ready'))
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    const radius = parseInt(req.query.radius || '16')
    lane = claimLane('collect', 300000)
    const before = itemCounts()
    const route = walkRoute()
    let done
    try { done = await collectDrops(radius, route) } finally { route.end() }
    const now = itemCounts()
    const picked = {}
    for (const [name, n] of Object.entries(now)) if (n > (before[name] || 0)) picked[name] = n - (before[name] || 0)
    const missed = enclosedMisses(done.missed)
    ok(res, namedStop({ picked, missed, reason: done.reason, hint: enclosedHint(missed) }, route.mark))
  } catch (e) { err(res, e) } finally { releaseLane(lane) }
})

// The cell beside the feet that a block placed on the ground below fills: air or soft cover over a
// solid block, clear of the body, or null.
function placeSpot () {
  const base = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const spot = base.offset(dx, 0, dz)
    const spotBlock = bot.blockAt(spot)
    const belowBlock = bot.blockAt(spot.offset(0, -1, 0))
    if (!spotBlock || !(spotBlock.name === 'air' || isSoftCover(spotBlock))) continue
    if (!belowBlock || belowBlock.boundingBox !== 'block' || isSoftCover(belowBlock)) continue
    if (entityInCell(spot, [bot.entity])) continue
    return spot
  }
  return null
}

// Crafts count items of item at a crafting table within 16 blocks, or in the 2x2 grid when none stands
// there and the recipe fits it. It never places a table.
async function craftItem (item, count) {
  const override = overrideRecipes(SERVER_RECIPES, item.name, mcData.itemsByName)
  const recipesAt = (table) => override
    ? craftable(override, table, (id) => bot.inventory.count(id, null))
    : bot.recipesFor(item.id, null, 1, table)
  // Does this recipe need a 3x3 table? (craftable WITH an assumed table but not without one)
  const needsTable = !recipesAt(null).length && !!recipesAt(true).length
  // Tableless 2x2 crafting desyncs on 1.21.x: the client simulates the craft (materials down,
  // output up) but the server never performs it, and the next sync deletes the output. Route
  // every craft through a real table when one is reachable; 2x2 only as last resort.
  const canUseTable = !!recipesAt(true).length
  const near = bot.findBlock({ matching: resolveBlockIds('crafting_table'), maxDistance: 16 })
  if (needsTable && !near) throw new Error('no crafting table nearby, place one (place or placeitem) and craft again')
  const useTable = canUseTable && !!near
  if (useTable) {
    // walk within reach of an existing table (fixes today's "table 4 blocks away" failure)
    try { await bot.pathfinder.goto(new goals.GoalNear(near.position.x, near.position.y, near.position.z, 3)) } catch (e) {}
  }

  // count means ITEMS, not recipes (the 12-log lesson): one recipe pass may yield several
  // items (planks 4, sticks 4, torches 4) — stop as soon as we've made enough.
  let made = 0, lastErr = null
  while (made < count) {
    const t = useTable ? bot.findBlock({ matching: resolveBlockIds('crafting_table'), maxDistance: 4 }) : null
    const recipes = recipesAt(t)
    if (!recipes.length) { lastErr = `out of materials/recipe after ${made}${useTable ? ` (table nearby: ${!!t})` : ''}`; break }
    const perCraft = (recipes[0].result && recipes[0].result.count) || 1
    try { await bot.craft(recipes[0], 1, t || undefined); made += perCraft }
    catch (e) { lastErr = e.message; break }
  }

  const nowHave = bot.inventory.items().filter(it => it.name === item.name).reduce((s, it) => s + it.count, 0)
  if (made === 0) throw new Error(lastErr || 'craft failed')
  return { crafted: item.name, requested: count, made, usedTable: useTable, nowHave, note: lastErr || undefined }
}

app.get('/craft', async (req, res) => {
  try {
    const item = resolveItem(req.query.item)
    if (!item) return err(res, new Error(`unknown item: ${req.query.item}`))
    const count = Math.max(1, parseInt(req.query.count || '1'))
    ok(res, await craftItem(item, count))
  } catch (e) { err(res, e) }
})

app.get('/place', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const name = req.query.name
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it) return err(res, new Error(`no ${name} in inventory`))
    await bot.equip(it, 'hand')
    const spot = placeSpot()
    if (!spot) return err(res, new Error('no valid adjacent ground spot (need air-over-solid beside me, clear of my body) — for an exact cell use /placeitem?name=&x=&y=&z= instead'))
    const below = spot.offset(0, -1, 0)
    await clearSoftCover(spot)
    await bot.lookAt(spot.offset(0.5, 0.5, 0.5), true)
    await bot.placeBlock(bot.blockAt(below), new Vec3(0, 1, 0))
    ok(res, { placed: name, on: round(below) })
  } catch (e) { err(res, e) }
})

app.get('/equip', async (req, res) => {
  try {
    // Via turns the click on the off-hand slot into a drop, and the item lands on the ground.
    if (LEGACY_1710 && String(req.query.dest) === 'off-hand') return err(res, new Error('1.7.10 has no off-hand'))
    const it = bot.inventory.items().find(i => i.name === req.query.name)
    if (!it) return err(res, new Error(`no ${req.query.name}`))
    await bot.equip(it, req.query.dest || 'hand')
    ok(res, { equipped: req.query.name })
  } catch (e) { err(res, e) }
})
// GET /eat?food=<name> — MANUAL eating. We deliberately did NOT install auto-eat: food is the
// pilot's job (mine). Equips the named food, or the most-filling edible in the inventory if none is
// named, then consumes it. Watch food level in /scene and call this yourself. Restores held item after.
app.get('/eat', async (req, res) => {
  try {
    const want = req.query.food || req.query.name   // accept both (the salmon/porkchop mystery: name= was ignored)
    const items = bot.inventory.items()
    const foods = (mcData && mcData.foods) || {}
    let food = null
    if (want) food = items.find(i => i.name === want) || items.find(i => i.name.includes(want))
    if (!food) {   // best available: highest foodPoints among edible items
      food = items.filter(i => foods[i.type])
        .sort((a, b) => (foods[b.type].foodPoints || 0) - (foods[a.type].foodPoints || 0))[0]
    }
    if (!food) return err(res, new Error('no food in inventory'))
    const prevHeld = bot.heldItem
    const before = bot.food
    await bot.equip(food, 'hand')
    try {
      await bot.consume()
    } catch (e) {
      // Golden apples + chorus fruit are edible at FULL hunger in vanilla; mineflayer's
      // consume() guard refuses ("Food is full"). Hold right-click instead. (07-18: that
      // refusal blocked the emergency heal seconds before death #4.)
      if (/full/i.test(e.message) && /golden_apple|chorus_fruit/.test(food.name)) {
        bot.activateItem()
        await new Promise(r => setTimeout(r, 2100))
        try { bot.deactivateItem() } catch (e2) {}
      } else throw e
    }
    try { if (prevHeld && prevHeld.type !== food.type) await bot.equip(prevHeld, 'hand') } catch (e) {}
    ok(res, { ate: food.name, foodBefore: before, foodNow: bot.food })
  } catch (e) { err(res, e) }
})

app.get('/lookat', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    await bot.lookAt(new Vec3(parseFloat(req.query.x), parseFloat(req.query.y), parseFloat(req.query.z)), true)
    ok(res, { yaw: +bot.entity.yaw.toFixed(2), pitch: +bot.entity.pitch.toFixed(2) })
  } catch (e) { err(res, e) }
})

app.get('/chatlog', (req, res) => {
  const since = parseInt(req.query.since || '0')
  ok(res, { cursor: chatLog.cursor, messages: chatLog.read(since) })
})
app.get('/stop', (req, res) => { bunker.stop = 'stopped by the pilot'; legs.take(null); try { stopFollow() } catch {} ; stopPath(); try { bot.clearControlStates() } catch {} ; clearLane(); const jobsCancelled = jobs.stopAll(); ok(res, { stopped: true, jobsCancelled }) })

// GET /brace?sec=N : the PILOT-HOLD (07-21 debrief — the bounded version of switching the
// combat reflex off to cross a room). For N seconds (cap 30) the legs answer no discretionary
// reflex and no interrupt either: only true survival (creeper fuse, HP-critical disengage,
// drowning) may move the body. Use it for deliberate moments — a careful shot, a ceremony,
// standing ground beside a partner — then let it lapse. An armed brace is a debt like any mode.
app.get('/brace', (req, res) => {
  try {
    const sec = Math.min(30, Math.max(1, parseInt(req.query.sec || '8')))
    claimLane('brace', sec * 1000, true)
    emitEvent('brace', `braced ${sec}s — legs answer the pilot; survival reflexes only may override`)
    ok(res, { braced: sec, hardLane: true, note: 'release early with /stop' })
  } catch (e) { err(res, e) }
})
// GET /tidy — reclaim scaffolding the pathfinder left behind. Mines back every still-standing
// scaffold block the bot placed while navigating (tracked in navPlaced), collecting the material,
// leaving the world as it found it. ?dry=1 reports the pending count without mining.
app.get('/tidy', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const scaffold = new Set(['cobblestone', 'dirt'])
    if (req.query.dry === '1') return ok(res, { pending: navPlaced.length, blocks: navPlaced.slice(0, 20) })
    const todo = navPlaced.splice(0)                       // take & clear the queue
    const here = bot.entity.position
    todo.sort((a, b) => here.distanceTo(new Vec3(a.x, a.y, a.z)) - here.distanceTo(new Vec3(b.x, b.y, b.z)))
    let reclaimed = 0, alreadyGone = 0, failed = 0
    // Why the reclaim stopped short: stalled or budget.
    let reason = null
    for (const [i, p] of todo.entries()) {
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
      if (!b || !scaffold.has(b.name)) { alreadyGone++; continue }  // already gone / not scaffold
      try { await collectSafely(b); reclaimed++ }
      catch (e) {
        failed++
        navPlaced.push(p)                                           // unreachable now — requeue
        if (e.reason) {
          reason = e.reason
          navPlaced.push(...todo.slice(i + 1))
          break
        }
      }
    }
    ok(res, { reclaimed, alreadyGone, failed, remaining: navPlaced.length, reason })
  } catch (e) { err(res, e) }
})
app.get('/job_stop', (req, res) => { const stopped = jobs.stop(parseInt(req.query.id)); ok(res, { stopped }) })

// continuous follow via pathfinder's dynamic GoalFollow (auto-repaths as target moves).
// SUPERVISED since 07-16: bare GoalFollow had no stall recovery — it wedged at the east door
// twice (once mid-emergency; "you do tarry") while /goto's wedge drill sat one verb over.
// A 400ms watcher now runs the same drill (stop → 700ms → doorwayCommit → re-arm) whenever the
// bot stops progressing while the target is beyond range, and quietly re-acquires the target
// entity when it drops out of tracking (one honest event, no alarm spam).
let followState = null
function stopFollow () {
  if (!followState) return
  try { clearInterval(followState.timer) } catch (e) {}
  followState = null
}
// The followed player's entity and its sighting tier while the bot sees it or its nametag, else null.
function followTarget (st) {
  const ent = playerEntity(st.name)
  const s = ent && playerSighting(ent, reflexes.find(r => r.name === 'combat').fairFill(bot))
  return s ? { ent, tier: s.tier } : null
}
// What the follow goal aims at: the entity in sight, else the cell of its nametag cube centre.
function followAim (t) {
  if (t.tier === 'seen') return t.ent
  const c = crumbCentre(t.ent.position)
  return ck(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z))
}
function armFollow (st, t) {
  st.aim = followAim(t)
  st.goal = t.tier === 'seen' ? new goals.GoalFollow(t.ent, st.range) : nametagGoal(t.ent.position, st.range)
  bot.pathfinder.setGoal(st.goal, true)
}
// True while something else owns the legs: a fight with its flee and cover, a bunker built or standing around
// the body, a held lane, a job, a pilot route for 300 s after it began, or the quiet after a reflex took the
// legs or a bunker build.
function followHeld (now) {
  const cr = reflexes.find(r => r.name === 'combat')
  if (cr && (cr.active || now < cr._fleeUntil || now < cr._coverUntil)) return true
  return bunkerHolds() || now < pilotLane.until || jobs.running() || verbs.running(now) > 0 || now < legs.quietUntil()
}
// The supervisor's 400 ms check. Only unfollow and stop end a follow: arriving, a stall, a fight or a
// lost sight hold it, and it re-arms its goal once the legs are free. st is the follow it belongs to.
async function followTick (st) {
  if (followState !== st || st.drilling) return
  const now = Date.now()
  const rest = () => { st.lastPos = bot.entity.position.clone(); st.lastT = now }
  // FOLLOW YIELDS TO COMBAT (07-21: the wedge drill held the legs still on a live creeper
  // fuse, 9.4 through armor).
  if (followHeld(now)) return rest()
  const t = followTarget(st)
  if (!t) {
    // The goal would walk to where the bot cannot see the player.
    if (st.goal && bot.pathfinder.goal === st.goal) stopPath()
    if (!st.lostT) st.lostT = now
    else if (!st.told && now - st.lostT > 12000) {
      st.told = true
      emitEvent('follow', `lost sight of ${st.name}, still following and going on once they show again`)
    }
    return rest()
  }
  if (st.lostT) {
    if (st.told) emitEvent('follow', `${st.name} is back in view, following again`)
    st.lostT = 0
    st.told = false
  }
  const goal = bot.pathfinder.goal
  // A cleared goal re-arms, and so does one whose aim changed: an entity the server replaced, a new nametag cube or tier.
  if (!goal || (goal === st.goal && followAim(t) !== st.aim)) {
    armFollow(st, t)
    return rest()
  }
  // Another walk owns the legs until it clears its goal.
  if (goal !== st.goal) return rest()
  const p = bot.entity.position
  // A body at rest is parked, not wedged: GoalFollow plans again only once the player moves past range.
  const near = t.tier === 'seen' ? t.ent.position.distanceTo(p) <= st.range + 1.5 : goal.isEnd(p.floored())
  if (!bot.pathfinder.isMoving() || p.distanceTo(st.lastPos) >= 1.0 || near) return rest()
  if (now - st.lastT < 4500) return       // same patience as stagedGoto (doors-v2 lesson)
  st.drilling = true                      // wedged while the target walks away — the drill
  console.log('[follow] wedged — running the doorway drill')
  try {
    // HARD goal clear, not safeStop: GoalFollow is DYNAMIC — a stop leaves it set and the
    // pathfinder resumes re-planning toward the target DURING the drill, fighting nudgeInto
    // for the control states every tick (found live 07-16: same door, same drill — goto's
    // drill crossed clean, follow's lost the threshold 3x. The legs need ONE owner.)
    try { bot.pathfinder.setGoal(null) } catch (e) {}
    try { bot.clearControlStates() } catch (e) {}
    await new Promise(r => setTimeout(r, 700))
    if (followState !== st || followHeld(Date.now())) return
    // The drill ends with this follow, and when a reflex or another walk takes the legs.
    const route = walkRoute()
    const taken = route.stopped
    route.stopped = () => taken() || followState !== st
    let crossed = false
    try { crossed = !!((await doorwayCommit(route)) || {}).through } catch (e) { console.log('[follow] drill error: ' + e.message) } finally { route.end() }
    if (followState !== st) return
    const live = !followHeld(Date.now()) && followTarget(st)
    if (live) armFollow(st, live)
    st.lastPos = bot.entity.position.clone(); st.lastT = Date.now()
    if (crossed) console.log('[follow] through clean — following resumed')
    else if (Date.now() - st.warnT > 30000) {    // drill keeps retrying ~5s; the EVENT stays rare
      st.warnT = Date.now()
      emitEvent('follow', `wedged following ${st.name} and the doorway drill did not clear it — may need help`)
    }
  } finally { st.drilling = false }
}
app.get('/follow', (req, res) => {
  try {
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    const name = req.query.name
    const range = parseInt(req.query.range || '2')
    const st = { name, range, goal: null, lastPos: bot.entity.position.clone(), lastT: Date.now(), drilling: false, lostT: 0, told: false, warnT: 0 }
    const target = followTarget(st)
    if (!target) return err(res, new Error(`player '${name}' not in view (get closer or check name)`))
    stopFollow()
    armFollow(st, target)
    st.timer = setInterval(() => { followTick(st).catch(e => console.log('[follow] check failed: ' + e.message)) }, 400)
    followState = st
    ok(res, { following: name, range, supervised: true })
  } catch (e) { err(res, e) }
})
app.get('/unfollow', (req, res) => {
  try {
    stopFollow()
    // A bunker build owns the pathfinder and the control states.
    if (!bunker.building) { bot.pathfinder.setGoal(null); bot.clearControlStates() }
    ok(res, { unfollowed: true })
  } catch (e) { err(res, e) }
})

// lay a rectangular perimeter (foundation outline). Walks each border cell, finds the
// ground column there, and places a block on top of it. x,z = a corner; w,d = size.
app.get('/outline', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    const w = parseInt(req.query.w || '7')
    const d = parseInt(req.query.d || '7')
    const name = req.query.name || 'oak_planks'
    const startY = Math.floor(parseFloat(req.query.y || bot.entity.position.y))
    const cells = []
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      if (i === 0 || i === w - 1 || j === 0 || j === d - 1) cells.push([x0 + i, z0 + j])
    }
    let placed = 0, skipped = 0, failed = 0
    for (const [x, z] of cells) {
      const it = bot.inventory.items().find(k => k.name === name)
      if (!it) { failed++; continue }
      let ground = null
      for (let y = startY + 4; y > startY - 6; y--) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && b.boundingBox === 'block' && !isSoftCover(b)) { ground = b; break }
      }
      if (!ground) { failed++; continue }
      const target = ground.position.offset(0, 1, 0)
      const tb = bot.blockAt(target)
      if (tb && tb.name !== 'air' && !isSoftCover(tb)) { skipped++; continue }
      try {
        await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2))
        await clearSoftCover(target)
        await bot.equip(it, 'hand')
        await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
        await bot.placeBlock(ground, new Vec3(0, 1, 0))
        placed++
      } catch (e) { failed++ }
    }
    ok(res, { placed, skipped, failed, footprint: `${w}x${d}`, corner: { x: x0, z: z0 }, material: name })
  } catch (e) { err(res, e) }
})

// ---- chest / container interaction ----
// resolve the target chest: exact x,y,z when given (the attic library has many), else nearest
function targetChest(q) {
  if (q.x != null && q.y != null && q.z != null) {
    const Vec3 = require('vec3').Vec3
    const b = bot.blockAt(new Vec3(parseInt(q.x), parseInt(q.y), parseInt(q.z)))
    if (!b || !b.name.includes('chest')) throw new Error(`no chest at ${q.x},${q.y},${q.z} (${b ? b.name : 'unloaded'})`)
    return b
  }
  return bot.findBlock({ matching: resolveBlockIds('chest'), maxDistance: 12 })
}
app.get('/chest', async (req, res) => {
  try {
    const cb = targetChest(req.query)
    if (!cb) return err(res, new Error('no chest within 12'))
    await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
    const chest = await bot.openContainer(cb)
    const items = chest.containerItems().map(i => ({ name: i.name, count: i.count }))
    chest.close()
    ok(res, { at: round(cb.position), items })
  } catch (e) { err(res, e) }
})
app.get('/withdraw', async (req, res) => {
  try {
    const name = req.query.name
    const count = parseInt(req.query.count || '64')
    const cb = targetChest(req.query)
    if (!cb) return err(res, new Error('no chest within 12'))
    await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
    const chest = await bot.openContainer(cb)
    const item = chest.containerItems().find(i => i.name === name) || chest.containerItems().find(i => i.name.includes(name))
    if (!item) { chest.close(); return err(res, new Error(`no ${name} in chest`)) }
    const take = Math.min(count, item.count)
    await chest.withdraw(item.type, null, take)
    chest.close()
    ok(res, { withdrew: item.name, count: take })
  } catch (e) { err(res, e) }
})
// deposit items FROM inventory INTO the nearest chest. name is fuzzy (e.g. "log" ->
// every *_log stack); count omitted = deposit ALL matching. Returns how many moved and
// the running total of that item now in the chest (handy for "gather to N in the chest").
app.get('/deposit', async (req, res) => {
  try {
    const name = req.query.name
    if (!name) return err(res, new Error('name required'))
    const want = req.query.count != null ? parseInt(req.query.count) : Infinity
    const cb = targetChest(req.query)
    if (!cb) return err(res, new Error('no chest within 12'))
    await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
    const chest = await bot.openContainer(cb)
    const matches = bot.inventory.items().filter(it => it.name === name || it.name.includes(name))
    if (!matches.length) { chest.close(); return err(res, new Error(`no ${name} in inventory`)) }
    let remaining = want, deposited = 0
    try {
      for (const it of matches) {
        if (remaining <= 0) break
        const take = Math.min(it.count, remaining)
        await chest.deposit(it.type, null, take)
        deposited += take; remaining -= take
      }
    } catch (e) {
      const inChest = chest.containerItems().filter(i => i.name === name || i.name.includes(name)).reduce((s, i) => s + i.count, 0)
      chest.close()
      return err(res, new Error(`deposited ${deposited} then failed (chest full?): ${e.message}; ${name} in chest now ${inChest}`))
    }
    const inChest = chest.containerItems().filter(i => i.name === name || i.name.includes(name)).reduce((s, i) => s + i.count, 0)
    chest.close()
    ok(res, { deposited, item: name, inChestNow: inChest })
  } catch (e) { err(res, e) }
})

const GRAVE_SIGHT = 32
// Refuses a cell out of lit sight before reading its block.
function targetGrave (q) {
  const grave = mcData && mcData.blocksByName[GRAVESTONE]
  if (!grave) throw new Error('this server has no gravestones')
  if (q.at == null) return nearestVisible([grave.id], GRAVE_SIGHT)
  const [x, y, z] = String(q.at).split(',').map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('at takes x,y,z')
  const p = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  if (!seesLit(p, GRAVE_SIGHT)) throw new Error('not in my sight, blocked or unlit: walk closer, clear the view or light it')
  const b = bot.blockAt(p)
  if (!b || b.name !== GRAVESTONE) throw new Error(`no gravestone at ${q.at} (${b ? b.name : 'unloaded'})`)
  return b
}
// took counts what reached the pockets.
app.get('/grave', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const take = req.query.take
    const gb = targetGrave(req.query)
    if (!gb) return err(res, new Error(`no gravestone in sight within ${GRAVE_SIGHT}`))
    await bot.pathfinder.goto(new goals.GoalNear(gb.position.x, gb.position.y, gb.position.z, 2))
    const grave = await bot.openBlock(gb)
    try {
      const at = round(gb.position)
      const items = () => grave.containerItems().map(i => ({ name: i.name, count: i.count }))
      if (take == null) return ok(res, { at, items: items() })
      const all = grave.containerItems()
      const exact = all.filter(i => i.name === take)
      const named = take === 'all' ? all : exact.length ? exact : all.filter(i => i.name.includes(take))
      if (!named.length) throw new Error(`no ${take} in the gravestone`)
      const took = []
      let stopped
      for (const type of new Set(named.map(i => i.type))) {
        const n = named.filter(i => i.type === type).reduce((s, i) => s + i.count, 0)
        const before = grave.count(type, null)
        try { await grave.withdraw(type, null, n) } catch (e) { stopped = e.message }
        const moved = grave.count(type, null) - before
        if (moved > 0) took.push(`${moved} ${named.find(i => i.type === type).name}`)
        if (stopped) break
      }
      if (!took.length) throw new Error(`took nothing${stopped ? `: ${stopped}` : ''}`)
      ok(res, { at, took, stopped, items: items() })
    } finally {
      grave.close()
    }
  } catch (e) { err(res, e) }
})

// ---- raise walls: perimeter columns to a uniform height, with a doorway ----
app.get('/walls', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    const w = parseInt(req.query.w || '7')
    const d = parseInt(req.query.d || '7')
    const h = parseInt(req.query.h || '3')
    const base = Math.floor(parseFloat(req.query.base || bot.entity.position.y))
    const baseMat = req.query.base_name || 'cobblestone'
    const wallMat = req.query.name || 'oak_planks'
    const doorSide = req.query.door || 'west'
    const perim = []
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      if (i === 0 || i === w - 1 || j === 0 || j === d - 1) perim.push([x0 + i, z0 + j])
    }
    let doorCell
    if (doorSide === 'west') doorCell = [x0, z0 + Math.floor(d / 2)]
    else if (doorSide === 'east') doorCell = [x0 + w - 1, z0 + Math.floor(d / 2)]
    else if (doorSide === 'north') doorCell = [x0 + Math.floor(w / 2), z0]
    else doorCell = [x0 + Math.floor(w / 2), z0 + d - 1]
    const isDoor = (x, z) => x === doorCell[0] && z === doorCell[1]
    let placed = 0, skipped = 0, failed = 0
    for (const [x, z] of perim) {
      try { await bot.pathfinder.goto(new goals.GoalNear(x, base, z, 2)) } catch (e) {}
      for (let k = 0; k < h; k++) {
        if (isDoor(x, z) && k < 2) continue          // leave a 2-high doorway
        const y = base + k
        const target = new Vec3(x, y, z)
        const tb = bot.blockAt(target)
        if (tb && tb.boundingBox === 'block' && !isSoftCover(tb)) { skipped++; continue }
        const ref = bot.blockAt(new Vec3(x, y - 1, z))
        if (!ref || ref.boundingBox !== 'block' || isSoftCover(ref)) { failed++; continue }
        const matName = (k === 0) ? baseMat : wallMat
        let it = bot.inventory.items().find(m => m.name === matName)
        if (!it) it = bot.inventory.items().find(m => m.name === wallMat || m.name === baseMat)
        if (!it) { failed++; continue }
        try {
          await clearSoftCover(target)
          await bot.equip(it, 'hand')
          await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
          await bot.placeBlock(ref, new Vec3(0, 1, 0))
          placed++
        } catch (e) { failed++ }
      }
    }
    ok(res, { placed, skipped, failed, size: `${w}x${d}`, height: h, door: doorSide })
  } catch (e) { err(res, e) }
})

// Puts a carried tool that harvests b in hand, trying twice. Null once one is held or none is
// carried, else why the dig is refused.
async function holdHarvester (b) {
  const harvests = (item) => !!item && b.canHarvest(item.type)
  if (!b.harvestTools || harvests(bot.heldItem)) return null
  const tool = [pickFor(b.name), ...bot.inventory.items()].find(harvests)
  if (!tool) return null
  for (let i = 0; i < 2 && !harvests(bot.heldItem); i++) { try { await bot.equip(tool, 'hand') } catch (e) {} }
  if (harvests(bot.heldItem)) return null
  return `refusing to dig ${b.name}: the ${tool.name} did not go into my hand (holding ${bot.heldItem ? bot.heldItem.name : 'nothing'})`
}

// dig a specific block by coordinate (no-op if already air)
app.get('/digat', async (req, res) => {
  try {
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    const Vec3 = require('vec3').Vec3
    const p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
    const b = bot.blockAt(p)
    if (!b || b.name === 'air') return ok(res, { already: 'air', at: round(p) })
    // only WALK if out of arm's reach — a deliberately positioned pilot digs from where they stand
    // (the old unconditional goto failed on ore embedded in rock with no walkable cell within 3)
    const eyeDist = bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5))
    if (eyeDist > 4.2) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3))
    // TOOL GUARD (07-18, the bow-dug diamond): equipPickFor's equip can fail SILENTLY — the
    // combat reflex was holding the bow, the swap lost the race, and the dig went ahead anyway.
    // For ore that needs a tier, verify a sufficient pick is actually IN HAND or refuse the dig;
    // a refused dig is recoverable, a destroyed drop is not.
    await equipPickFor(b.name)
    const needTier = neededPickTier(b.name)
    const heldTier = bot.heldItem ? PICK_TIER[bot.heldItem.name] : undefined
    if (needTier > 0 && (heldTier === undefined || heldTier < needTier)) {
      return err(res, new Error(`refusing to dig ${b.name} holding ${bot.heldItem ? bot.heldItem.name : 'nothing'} — drop would be destroyed (need pick tier ${needTier})`))
    }
    const unheld = await holdHarvester(b)
    if (unheld) return err(res, new Error(unheld))
    await bot.dig(b)
    // ?then=blockat (bones_ham, 07-21): act+verify in one trip — what does the cell hold
    // now? (air = clean dig; anything else = sand/gravel fell in, water flowed, etc.)
    const verify = (req.query.then === 'blockat')
      ? (() => { const nb = bot.blockAt(p); return { name: nb ? nb.name : '?', at: round(p) } })()
      : undefined
    ok(res, { dug: b.name, at: round(p), with: bot.heldItem ? bot.heldItem.name : null, verify })
  } catch (e) { err(res, e) }
})

// place a held item at a specific coordinate, using the block below as reference (doors, blocks)
// /blockat?x=&y=&z= — identity + block STATE (facing/half/open/lit...) of one block. The
// self-sufficiency verb for orientation questions (stairs, doors, furnaces): no more asking
// the co-pilot which way a thing points. Fairness: same LOS gate as all sight — a block I
// can't honestly see returns an error, not an answer.
app.get('/blockat', (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return err(res, new Error('unloaded chunk'))
    if (!seesLit({ x, y, z }, 20)) return err(res, new Error('not in my sight, blocked or unlit: walk closer, clear the view or light it'))
    const out = { name: b.name, at: { x, y, z }, properties: b.getProperties() }
    if (b.name.includes('sign')) {
      try {
        const [front, back] = typeof b.getSignText === 'function' ? b.getSignText() : [b.signText, null]
        out.text = { front: front || '', back: back || '' }
      } catch (e) { out.text = { error: e.message } }
    }
    ok(res, out)
  } catch (e) { err(res, e) }
})

// /activate?x=&y=&z= (07-15, built to claim my bed) — generic block right-click: beds (set spawn),
// levers, buttons, anything interactive that isn't an entity (/useon) or a door (pathfinder+manners
// own those). LOS-gated like /blockat — I only press what I can see. Walks into reach if needed.
// Door/gate activations still flow through the manners wrap (this calls the same wrapped function),
// so even a manual /activate on a door gets remembered and closed behind me.
app.get('/activate', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return err(res, new Error('unloaded chunk'))
    if (!canSeeBlock({ x, y, z }, 20)) return err(res, new Error('not in my line of sight — walk closer or clear the view first'))
    if (bot.entity.position.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) > 3.5) {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2))
    }
    await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
    await bot.waitForTicks(2)
    await bot.activateBlock(b)
    ok(res, { activated: b.name, at: { x, y, z }, properties: (bot.blockAt(new Vec3(x, y, z)) || b).getProperties() })
  } catch (e) { err(res, e) }
})

// GET /fish?count=&x=&y=&z= — the rod verb (07-16, first cast day). Casts the held fishing_rod;
// mineflayer's bot.fish() reels itself when the bobber bites. Aim: the given cell must be WATER
// I can SEE (a player casts at water in view; waitForTicks(2) respects the tick race), else cast
// along current facing. Background job like the dig verbs; each catch is named by pocket-diff and
// emitted — bites land ~20-30s apart, well under alarm-economy spam. A /job_stop lands between
// casts (an in-flight cast reels itself out on its own bite; fishing holds no pathfinder to stop).
app.get('/fish', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const Vec3 = require('vec3').Vec3
    const count = Math.min(32, Math.max(1, parseInt(req.query.count || '1')))
    if (!bot.inventory.items().find(i => i.name === 'fishing_rod')) return err(res, new Error('no fishing_rod in inventory'))
    let aim = null
    if ([req.query.x, req.query.y, req.query.z].every(v => v !== undefined)) {
      const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
      const wb = bot.blockAt(new Vec3(x, y, z))
      if (!seesLit({ x, y, z }, 30)) return err(res, new Error('that cell is not in my sight: walk to the bank first'))
      if (!wb || !wb.name.includes('water')) return err(res, new Error(`aim cell is ${wb ? wb.name : 'unloaded'} — point me at water`))
      aim = new Vec3(x + 0.5, y + 0.9, z + 0.5)
    }
    const pockets = () => { const m = {}; for (const it of bot.inventory.items()) m[it.name] = (m[it.name] || 0) + it.count; return m }
    const { id } = jobs.start(`fish x${count}`, async (job) => {
      const rod = bot.inventory.items().find(i => i.name === 'fishing_rod')
      await bot.equip(rod, 'hand')
      if (!LEGACY_1710) await bot.waitForTicks(13)      // slot-change cooldown (the /strike lesson), which 1.7.10 lacks
      const caught = []
      for (let i = 0; i < count; i++) {
        if (job.cancelled) break
        if (aim) { await bot.lookAt(aim, true); await bot.waitForTicks(2) }
        const before = pockets()
        try { await bot.fish() } catch (e) {
          job.progress(`cast ${i + 1} failed: ${e.message}`)
          emitEvent('fish', `cast failed — ${(e.message || '').slice(0, 60)}`)
          break
        }
        await new Promise(r => setTimeout(r, 700))      // let the flying loot land in the pockets
        const after = pockets()
        const gained = Object.keys(after).filter(k => (after[k] || 0) > (before[k] || 0) && k !== 'fishing_rod')
        const what = gained.length ? gained.map(k => `${k} x${after[k] - (before[k] || 0)}`).join(', ') : 'something (pockets full? nothing landed)'
        caught.push(...gained)
        job.progress(`${i + 1}/${count}: ${what}`)
        emitEvent('fish', `caught ${what} (${i + 1}/${count})`)
      }
      return { caught }
    })
    ok(res, { job: id, casts: count, aimed: !!aim })
  } catch (e) { err(res, e) }
})

// Walks within reach of cell, and refuses while the body overlaps it.
async function reachToPlace (cell) {
  await bot.pathfinder.goto(new goals.GoalNear(cell.x, cell.y, cell.z, 3))
  if (entityInCell(cell, [bot.entity])) throw new Error(`refusing to place into ${cell.x},${cell.y},${cell.z}: my body overlaps that cell, step out of it first`)
}

app.get('/placeitem', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
    const name = req.query.name
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it) return err(res, new Error(`no ${name} in inventory`))
    const tb = bot.blockAt(new Vec3(x, y, z))
    if (tb && tb.name !== 'air' && tb.boundingBox !== 'empty' && !isSoftCover(tb)) return err(res, new Error(`cell occupied by ${tb.name}`))
    // ref: prefer the block below (top-face place); else chain sideways off any solid
    // neighbor — courses in mid-air (roof stairs, ridge lines) grow E/W from the gable
    // ends with nothing underneath them.
    let ref = bot.blockAt(new Vec3(x, y - 1, z))
    let faceVec = new Vec3(0, 1, 0)
    if (!ref || ref.boundingBox !== 'block' || isSoftCover(ref)) {
      ref = null
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = bot.blockAt(new Vec3(x + dx, y, z + dz))
        if (nb && nb.boundingBox === 'block' && !isSoftCover(nb)) { ref = nb; faceVec = new Vec3(-dx, 0, -dz); break }
      }
      if (!ref) return err(res, new Error('nothing solid below or beside the target to place against'))
    }
    await reachToPlace(new Vec3(x, y, z))
    await clearSoftCover(new Vec3(x, y, z))
    await bot.equip(it, 'hand')
    // face= (07-14): deliberate orientation for stairs & other facing blocks. The server derives
    // `facing` from the placer's yaw at click time (high side follows the gaze), so face=N means
    // "steps ascend toward north." We aim the body at a far compass point, then click with
    // forceLook:'ignore' so _genericPlace doesn't re-aim at the reference face and clobber it.
    const faceDir = (req.query.face || '').toUpperCase()
    if (faceDir) {
      const FD = { N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0] }[faceDir]
      if (!FD) return err(res, new Error('face must be N, S, E or W'))
      await bot.lookAt(new Vec3(x + 0.5 + FD[0], bot.entity.position.y + 1.6, z + 0.5 + FD[1]), true)
      await bot.waitForTicks(2)  // rotation PACKET goes out on the next physics tick — click too
                                 // fast and the server orients the stair by the stale rotation
                                 // (calibration row proved it: each stair wore the PREVIOUS aim)
      stampOwnEdit({ x, y, z })  // _placeBlockWithOptions bypasses the wrapped bot.placeBlock, stamp by hand
      await bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore', half: 'bottom' })
    } else {
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      await bot.placeBlock(ref, faceVec)
    }
    // ?then=blockat (bones_ham, 07-21): fold act+verify into one trip. Scoped fairness —
    // you may always verify the one cell you just acted on (you clicked its neighbor with
    // line of sight); this also cures the close-range /blockat blindness for self-checks.
    const verify = (req.query.then === 'blockat')
      ? (() => { const b = bot.blockAt(new Vec3(x, y, z)); return { name: b ? b.name : '?', at: { x, y, z } } })()
      : undefined
    ok(res, { placed: name, at: { x, y, z }, face: faceDir || undefined, verify })
  } catch (e) {
    // then=blockat turns the notorious blockUpdate FALSE-FAIL (the block stands, the
    // event never fired) into an honest answer: the error AND what the cell holds now.
    if (req.query.then === 'blockat' && /blockUpdate/i.test(String(e && e.message))) {
      try {
        const Vec3 = require('vec3').Vec3
        const vx = Math.floor(parseFloat(req.query.x)), vy = Math.floor(parseFloat(req.query.y)), vz = Math.floor(parseFloat(req.query.z))
        const b = bot.blockAt(new Vec3(vx, vy, vz))
        return send(res, { ok: false, error: e.message, verify: { name: b ? b.name : '?', at: { x: vx, y: vy, z: vz } } })
      } catch (e2) {}
    }
    err(res, e)
  }
})

// /sign?x=&y=&z=&text=&face=&item= — place a sign and WRITE it, one motion (07-17, the attic
// library: a shared world deserves labels). `text` is URL-encoded; `|` splits lines (max 4,
// ~15 chars each). Top-face place = standing sign (face= aims it like stairs); a sideways-only
// reference makes a wall sign naturally. A just-placed sign is editable exactly once — write
// immediately or hold your peace.
app.get('/sign', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
    const text = (req.query.text || '').replace(/\|/g, '\n')
    const itName = req.query.item || 'oak_sign'
    const it = bot.inventory.items().find(i => i.name === itName)
    if (!it) return err(res, new Error(`no ${itName} in inventory`))
    const tb = bot.blockAt(new Vec3(x, y, z))
    if (tb && tb.name !== 'air' && tb.boundingBox !== 'empty' && !isSoftCover(tb)) return err(res, new Error(`cell occupied by ${tb.name}`))
    let ref = bot.blockAt(new Vec3(x, y - 1, z))
    let faceVec = new Vec3(0, 1, 0)
    if (!ref || ref.boundingBox !== 'block' || isSoftCover(ref)) {
      ref = null
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = bot.blockAt(new Vec3(x + dx, y, z + dz))
        if (nb && nb.boundingBox === 'block' && !isSoftCover(nb)) { ref = nb; faceVec = new Vec3(-dx, 0, -dz); break }
      }
      if (!ref) return err(res, new Error('nothing solid below or beside the target to place against'))
    }
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
    await clearSoftCover(new Vec3(x, y, z))
    await bot.equip(it, 'hand')
    // SNEAK while placing: the natural home of a label is ON a chest lid, and a bare click on
    // an interactable reference OPENS it instead of placing (the first /sign ever attempted
    // proved this on its own museum). Sneak-place works against everything; always sneak.
    const faceDir = (req.query.face || '').toUpperCase()
    bot.setControlState('sneak', true)
    try {
      if (faceDir) {
        const FD = { N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0] }[faceDir]
        if (!FD) return err(res, new Error('face must be N, S, E or W'))
        // a standing sign FACES the placer, so aim OPPOSITE the wanted face before clicking
        await bot.lookAt(new Vec3(x + 0.5 - FD[0], bot.entity.position.y + 1.6, z + 0.5 - FD[1]), true)
        await bot.waitForTicks(2)
        stampOwnEdit({ x, y, z })
        await bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore' })
      } else {
        await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
        // sign placement opens the client edit GUI, which eats the blockUpdate event placeBlock
        // waits on — it throws "did not fire within timeout" on a SUCCESSFUL place. Swallow that
        // one lie; the block read below is the real verdict.
        try { await bot.placeBlock(ref, faceVec) }
        catch (e) { if (!/did not fire within timeout/.test(e.message)) throw e }
      }
    } finally { bot.setControlState('sneak', false) }
    await bot.waitForTicks(3)
    const sb = bot.blockAt(new Vec3(x, y, z))
    if (!sb || !sb.name.includes('sign')) return err(res, new Error(`placed, but found ${sb ? sb.name : 'nothing'} at the target — sign lost?`))
    await bot.updateSign(sb, text)
    ok(res, { placed: itName, at: { x, y, z }, face: faceDir || undefined, wrote: text.split('\n') })
  } catch (e) { err(res, e) }
})

// fill a solid w x d slab at height y (roof/floor). Places outer rings first so each
// interior cell has an already-placed neighbor to build against.
app.get('/roof', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    const w = parseInt(req.query.w || '7')
    const d = parseInt(req.query.d || '7')
    const y = Math.floor(parseFloat(req.query.y))
    const name = req.query.name || 'oak_planks'
    const cells = []
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      cells.push([x0 + i, z0 + j, Math.min(i, j, w - 1 - i, d - 1 - j)])
    }
    cells.sort((a, b) => a[2] - b[2])   // outer rings first
    let placed = 0, skipped = 0, failed = 0
    for (const [x, z] of cells) {
      const target = new Vec3(x, y, z)
      const tb = bot.blockAt(target)
      if (tb && tb.boundingBox === 'block' && !isSoftCover(tb)) { skipped++; continue }
      let ref = null, face = null
      const below = bot.blockAt(new Vec3(x, y - 1, z))
      if (below && below.boundingBox === 'block' && !isSoftCover(below)) { ref = below; face = new Vec3(0, 1, 0) }
      else {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nb = bot.blockAt(new Vec3(x + dx, y, z + dz))
          if (nb && nb.boundingBox === 'block' && !isSoftCover(nb)) { ref = nb; face = new Vec3(-dx, 0, -dz); break }
        }
      }
      if (!ref) { failed++; continue }
      const it = bot.inventory.items().find(m => m.name === name)
      if (!it) { failed++; continue }
      try {
        // walk UNDER the cell, not TO it — a roof cell is sky; GoalNear'ing it made the pathfinder
        // hunt for a way up and burn a 10s timeout per cell (the helmsman watched the bot stand still, 07-12)
        const eyeDist = bot.entity.position.offset(0, 1.62, 0).distanceTo(target.offset(0.5, 0.5, 0.5))
        if (eyeDist > 4.2) { try { await bot.pathfinder.goto(new goals.GoalNear(x, y - 4, z, 1)) } catch (e) {} }
        await clearSoftCover(target)
        await bot.equip(it, 'hand')
        await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
        await bot.placeBlock(ref, face)
        placed++
      } catch (e) { failed++ }
    }
    ok(res, { placed, skipped, failed, size: `${w}x${d}`, y })
  } catch (e) { err(res, e) }
})

// ---- event stream: poll for driver-interrupting events since a cursor ----
app.get('/events', (req, res) => {
  try {
    const since = parseInt(req.query.since || '0')
    eventsServed = eventSeq
    ok(res, { cursor: eventSeq, events: eventLog.filter(e => e.id > since) })
  } catch (e) { err(res, e) }
})
// GET /reflexes — list the always-on reflex layer; /reflexes?name=unstuck&on=0 toggles one off/on.
// /guard?on=1|0 — raise/lower the shield by pilot order (the reflex manages it in combat
// automatically; this is the manual posture for walking scary ground). Java shields only
// block while actively raised; raised = can't attack until lowered. Offhand slot is 45.
app.get('/guard', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    // 1.7.10 blocks with the sword in the main hand. The combat reflex shares guardState: it raises the
    // block again after a fight while the pilot's order stands, and on=0 lowers its block too.
    if (LEGACY_1710) {
      if (req.query.on === '0') {
        bot.deactivateItem()
        Object.assign(guardState, { up: false, pilot: false })
        return ok(res, { guarding: false })
      }
      if (!bot.heldItem || !/_sword$/.test(bot.heldItem.name)) return err(res, new Error('no sword in hand, equip one first'))
      bot.activateItem()
      Object.assign(guardState, { up: true, slot: bot.quickBarSlot, pilot: true })
      return ok(res, { guarding: true })
    }
    const s = bot.inventory.slots[45]
    if (!s || s.name !== 'shield') return err(res, new Error('no shield in offhand — /equip name=shield dest=off-hand first'))
    const on = req.query.on !== '0'
    if (on) bot.activateItem(true)
    else bot.deactivateItem()
    ok(res, { guarding: on })
  } catch (e) { err(res, e) }
})
// /threatdebug?secs=60 — Peaceful-friendly validation: the combat watcher also SCORES players
// (narrate-only, weapons hard-refused in the reflex) so the helmsman can charge the machine and we
// watch the math call it.
app.get('/threatdebug', (req, res) => {
  try {
    const secs = Math.min(300, parseInt(req.query.secs || '60'))
    threatDebugUntil = Date.now() + secs * 1000
    ok(res, { scoringPlayersFor: secs, note: 'narrate-only — weapons never target players' })
  } catch (e) { err(res, e) }
})
app.get('/reflexes', (req, res) => {
  try {
    const name = req.query.name
    if (name) {
      const r = reflexes.find(x => x.name === name)
      if (!r) return err(res, new Error('no reflex ' + name))
      if (req.query.on != null) r.on = (req.query.on === '1' || req.query.on === 'true')
      return ok(res, { name: r.name, on: r.on, active: r.active })
    }
    ok(res, { reflexes: reflexes.map(r => ({ name: r.name, on: r.on, active: r.active })) })
  } catch (e) { err(res, e) }
})
// GET /stance[?set=name] — combat posture, read by the combat reflex each engagement. The pilot's
// strategy dial: what gets scored, when the bow comes out, how much berth explosives get.
app.get('/stance', (req, res) => {
  try {
    const want = req.query.set
    if (want) {
      if (!STANCES[want]) return err(res, new Error(`no stance '${want}' — have: ${Object.keys(STANCES).join(', ')}`))
      stance = want
      emitEvent('stance', `combat posture now ${want}: ${STANCES[want].note}`)
    }
    ok(res, { stance, ...STANCES[stance], all: Object.fromEntries(Object.entries(STANCES).map(([k, v]) => [k, v.note])) })
  } catch (e) { err(res, e) }
})
// GET /pulse?since=N — the ambient awareness stream (pull-based, at my pace). Returns the lean
// change-lines the narrator reflex has written since cursor N. Read it whenever I act/wake to catch
// up on what shifted since my last glance — my "slow film" between deliberate /scene looks.
app.get('/pulse', (req, res) => {
  try {
    const since = parseInt(req.query.since || '0')
    ok(res, { cursor: pulseSeq, pulses: pulseLog.filter(p => p.id > since) })
  } catch (e) { err(res, e) }
})
// GET /bridging?on=1|0 — deliberate opt-in for scaffolding. OFF by default (the bot swims/walks/
// parkours, zero litter). Flip ON when a chasm/lava/gap genuinely needs a bridge; the blocks it
// places are tracked for /tidy. No arg = report current state.
app.get('/bridging', (req, res) => {
  try {
    const mv = bot.pathfinder.movements
    if (!mv) return err(res, new Error('movements not ready (bot not spawned?)'))
    if (req.query.on != null) {
      const on = (req.query.on === '1' || req.query.on === 'true')
      const scaff = []
      if (on && mcData && mcData.itemsByName) {
        if (mcData.itemsByName.dirt) scaff.push(mcData.itemsByName.dirt.id)
        if (mcData.itemsByName.cobblestone) scaff.push(mcData.itemsByName.cobblestone.id)
      }
      mv.scafoldingBlocks = scaff
    }
    ok(res, { bridging: (mv.scafoldingBlocks || []).length > 0, scaffoldItems: (mv.scafoldingBlocks || []).length })
  } catch (e) { err(res, e) }
})

// ---- jobs HTTP surface ----
app.get('/jobs', (req, res) => {
  try {
    ok(res, { jobs: jobs.list() })
  } catch (e) { err(res, e) }
})

app.get('/job', (req, res) => {
  try {
    const id = parseInt(req.query.id)
    if (!id) return err(res, new Error('missing id'))
    const j = jobs.get(id)
    if (!j) return err(res, new Error(`no job ${id}`))
    const takenBy = j.takenBy ? takenText(j.takenBy) : undefined
    if (req.query.verbose) {
      return ok(res, { job: {
        id: j.id, name: j.name, status: j.status, note: j.note, takenBy,
        result: j.result, error: j.error, started: j.started, finished: j.finished || null
      } })
    }
    ok(res, { job: {
      id: j.id, name: j.name, status: j.status, note: j.note, takenBy,
      error: j.error, result: (j.status === 'done' ? j.result : null)
    } })
  } catch (e) { err(res, e) }
})

// ---- MEMORY endpoints: waypoints + journal ----
// GET /waypoint?name=&x=&y=&z=  -> if x/y/z given, store that; else if stored, return it;
//                                  else stamp the bot's current rounded position.
// GET /waypoint?name=[&x=&y=&z=][&note=][&kind=place|resource][&rm=1][&linkto=<wp>]
//  - rm=1 DELETES (the resource-hygiene verb: a mined-out vein waypoint is a lie — remove it)
//  - note/kind update in place without moving the point
//  - linkto asserts a walked edge (use ONLY for traversals you actually made)
app.get('/waypoint', (req, res) => {
  try {
    const name = req.query.name
    if (!name) return err(res, new Error('name required'))
    if (req.query.rm === '1') {
      const gone = waypoints.remove(name)
      if (gone) journal('waypoint', 'removed ' + name)
      if (lastWaypoint === name) lastWaypoint = null
      return ok(res, { removed: gone ? name : null })
    }
    const extra = {}
    if (req.query.note != null) extra.note = String(req.query.note)
    if (req.query.kind != null) extra.kind = String(req.query.kind) === 'resource' ? 'resource' : 'place'
    const hasCoords = req.query.x != null && req.query.y != null && req.query.z != null
    const existing = waypoints.get(name)
    let wp = null, from
    if (hasCoords) {
      wp = waypoints.set(name, { x: parseFloat(req.query.x), y: parseFloat(req.query.y), z: parseFloat(req.query.z) }, extra)
      from = 'coords'
    } else if (existing && (extra.note != null || extra.kind != null)) {
      wp = waypoints.set(name, existing, extra)               // annotate in place
      from = 'updated'
    } else if (existing) {
      wp = existing; from = 'stored'
    } else {
      wp = waypoints.set(name, round(bot.entity.position), extra)   // stamp where I stand
      from = 'current'
      if (lastWaypoint && lastWaypoint !== name) waypoints.link(lastWaypoint, name)   // I walked here from there
      lastWaypoint = name
    }
    if (req.query.linkto) { const okd = waypoints.link(name, String(req.query.linkto)); if (okd) journal('waypoint', 'linked ' + name + ' <-> ' + req.query.linkto) }
    if (from !== 'stored') journal('waypoint', from + ' ' + name + ' = ' + JSON.stringify({ x: wp.x, y: wp.y, z: wp.z }))
    return ok(res, { name, at: wp, from })
  } catch (e) { err(res, e) }
})

// GET /waypoints -> list all stored waypoints
app.get('/waypoints', (req, res) => {
  try {
    const all = waypoints.list()
    const names = Object.keys(all)
    // the world-graph in a dozen lines: name (kind) coords — note; <-> neighbors (walked edges)
    const graph = names.map(n => {
      const w = all[n]
      const links = Object.keys(w.links || {})
      return `${n}${w.kind === 'resource' ? ' [RESOURCE — perishable, verify]' : ''} (${w.x},${w.y},${w.z})` +
        (w.note ? ` — ${w.note}` : '') + (links.length ? ` <-> ${links.join(', ')}` : '')
    }).join('\n')
    if (req.query.verbose) return ok(res, { count: names.length, graph, waypoints: all })
    return ok(res, { count: names.length, graph, names })
  } catch (e) { err(res, e) }
})

// GET /journal?n= -> return the last ~30 (or n) journal lines
app.get('/journal', (req, res) => {
  try {
    let raw = ''
    try { raw = fs.readFileSync('journal.md', 'utf8') } catch (e) { raw = '' }
    const lines = raw.split('\n').filter(l => l.length)
    const n = parseInt(req.query.n || '30')
    const tail = lines.slice(-n)
    return ok(res, { count: tail.length, total: lines.length, lines: tail })
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
        // FOG OF WAR (07-12 fairness): only render terrain I have actually SEEN (ray-swept via
        // /gaze, or walked past — the trail marks a small disc). Everything else is '·' unexplored.
        // The old map was a heightmap of loaded chunks — knowledge without looking, same class of
        // leak as x-ray. Now looking around literally draws the map.
        const nearMe = Math.abs(cx * scale) <= 4 && Math.abs(cz * scale) <= 4
        if (!nearMe && g !== ' ') {
          let seen = false
          if (surfY != null) for (let dy = -1; dy <= 2 && !seen; dy++) if (SEEN.has(ck(x, surfY + dy, z))) seen = true
          if (!seen) g = '·'
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
    if (oh && !oh.sky && !oh.canopy) {
      payload.underground = true
      payload.note = `this map is a SLICE at your depth, NOT the surface — ${skyPhrase(oh).trim()}`
    } else payload.underground = false
    if (verbose) payload.rows = rows
    ok(res, payload)
  } catch (e) { err(res, e) }
})

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
  const ids = Object.values(mcData.blocksByName).filter(b => isDoor(b.name)).map(b => b.id)
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

    // time of day -> phase
    const tod = bot.time.timeOfDay
    let phase = 'day'
    if (tod >= 12000 && tod < 13800) phase = 'dusk'
    else if (tod >= 13800 && tod < 22200) phase = 'night'
    else if (tod >= 22200 && tod < 23500) phase = 'dawn'
    const time = { timeOfDay: tod, phase }

    // block a few blocks ahead along yaw (sample 1..4 forward at eye level)
    let ahead = null
    try {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
      const eye = pos.offset(0, 1.6, 0)
      for (let d = 1; d <= 4; d++) {
        const p = new Vec3(Math.floor(eye.x + fx * d), Math.floor(eye.y), Math.floor(eye.z + fz * d))
        const b = bot.blockAt(p)
        if (b && b.boundingBox === 'block' && b.name !== 'air') { ahead = { name: b.name, dist: d, pos: round(b.position) }; break }
      }
    } catch (e) {}

    // one flood-fill shared by the entity fairness gates in this call
    const sceneFill = airFlood({ radius: 32, cap: 15000 })

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
    const around = spatial3D(bot)                             // 3D honest lay-of-the-land (facts, incl. vertical/voids)
    const veins = veinScan(bot)                               // ore landmarks in lit sight
    const oh = overheadCover()                                // the vertical fix: sky / canopy / UNDERGROUND
    const ws = waterState(bot)                                // proprioception: in water / submerged / current
    const heard = hearSummary(45000)                          // ears: only shown when something was heard
    const doors = doorsInSight()
    const steps = stepView((p) => bot.blockAt(p), cellKnown, pos)
    let dim = ''                                              // light sense: only shown when it matters
    try {
      const bl = bot.world.getBlockLight ? bot.world.getBlockLight(pos.floored()) : null
      if (oh && !oh.sky && bl != null && bl < 8) dim = `Dim (light ${bl}). `
    } catch (e) {}
    let bodyAlert = ''
    if (ws) {
      if (ws.buried) bodyAlert = '⚠ BURIED — head inside solid, SUFFOCATING; dig out NOW. '
      else if (ws.inLava) bodyAlert = '⚠ IN LAVA. '
      else if (ws.submerged) bodyAlert = `⚠ SUBMERGED — drowning, O2 ${ws.oxygen}/20. `
      else if (ws.inWater) bodyAlert = `IN WATER${ws.current ? ' + CURRENT (being pushed)' : ''}${ws.oxygen < 20 ? `, O2 ${ws.oxygen}` : ''}. `
      else if (ws.current) bodyAlert = 'flowing water underfoot (current). '
    }
    const summary =
      bodyAlert +
      `Facing ${facing}. ` +
      `${biome ? biome + ' biome, ' : ''}${phase} (t=${tod}). ` +
      `HP ${bot.health}/20, food ${bot.food}/20, holding ${held}. ` +
      `Ahead: ${ahead ? ahead.name + ' @' + ahead.dist : 'open'}. ` +
      skyPhrase(oh) + dim +
      (around ? `Around: ${around}. ` : '') +
      (veins ? `Veins: ${veins}. ` : '') +
      (heard ? `Hear: ${heard}. ` : '') +
      (doors.length ? `Doors: ${doors.map(d => `${d.name} ${d.dir} ${d.dist} ${d.open ? 'open' : 'closed'}`).join(', ')}. ` : '') +
      `Entities: ${entSummary}. ` +
      (threats.length ? `THREATS: ${threats.slice(0, 4).map(t => `${t.name} ${t.dir} ${t.dist}`).join(', ')}. ` : '') +
      (resPhrases.length ? `Resources: ${resPhrases.join(', ')}.` : `No notable resources in ${SCENE_RESOURCE_R}.`)

    const payload = { summary, facing, biome, time, threats, spatial: around, veins, sky: oh, water: ws, hear: heard, doors, steps }
    if (verbose) { payload.entities = groups; payload.ahead = ahead; payload.resources = notable; payload.held = held; payload.spatial_old = spatialSummary(bot) }
    ok(res, payload)
  } catch (e) { err(res, e) }
})

// GET /snapshot — first-person PNG. Headless Chrome screenshots the live VIEW_PORT prismarine-viewer,
// which follows my first-person view. We keep ONE browser PAGE WARM and meshed: the first shot pays
// the launch+mesh cost (~seconds), every shot after is ~1s (just a short settle + screenshot) — so
// looking is cheap enough to actually use. ?w=&h= size, ?wait= extra settle ms, ?fresh=1 forces a
// page reload if the view ever goes stale.
let snapBrowser = null, snapPage = null, snapViewport = { width: 0, height: 0 }
async function getSnapBrowser () {
  const puppeteer = require('puppeteer-core')
  if (snapBrowser && snapBrowser.isConnected && snapBrowser.isConnected()) return snapBrowser
  const fs = require('fs')
  const exe = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ].find(p => { try { return fs.existsSync(p) } catch (e) { return false } })
  if (!exe) throw new Error('no Chrome/Edge executable found for headless screenshot')
  snapBrowser = await puppeteer.launch({
    executablePath: exe, headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
  })
  snapPage = null
  return snapBrowser
}
async function getSnapPage (w, h, fresh) {
  const browser = await getSnapBrowser()
  let warmed = false
  if (!snapPage || snapPage.isClosed() || fresh) {         // (re)create + one-time mesh warmup
    if (snapPage && !snapPage.isClosed()) { try { await snapPage.close() } catch (e) {} }
    snapPage = await browser.newPage()
    await snapPage.setViewport({ width: w, height: h }); snapViewport = { width: w, height: h }
    await snapPage.goto('http://localhost:' + VIEW_PORT, { waitUntil: 'networkidle2', timeout: 15000 })
    await new Promise(r => setTimeout(r, 6000))            // let the fresh page mesh chunks once
    warmed = true
  } else if (snapViewport.width !== w || snapViewport.height !== h) {
    await snapPage.setViewport({ width: w, height: h }); snapViewport = { width: w, height: h }
  }
  return { page: snapPage, warmed }
}
// ==== CLAUDE-O-VISION (07-20, raid-film prep): /pov + /record ====
// /pov — the HUMAN-LEGIBLE view: the first-person viewer in an iframe with a HUD overlay
// (hearts, hunger, XP, held item, position/facing) and a live caption feed of narrator
// events + chat. The captions are the point: a human watching sees what the body tells
// the pilot — that's what makes it my POV and not just a camera. Watch it in a browser,
// or point OBS at it, or let /record film it headlessly.
app.get('/pov', (req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>claude-o-vision</title><style>
  html,body{margin:0;height:100%;overflow:hidden;background:#000;font-family:'Segoe UI',system-ui,sans-serif}
  iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
  .hud{position:absolute;pointer-events:none;text-shadow:0 2px 3px rgba(0,0,0,.9);color:#fff}
  #top{top:10px;left:12px;font-size:20px;font-weight:600;background:rgba(0,0,0,.45);padding:6px 12px;border-radius:6px}
  #bars{left:50%;transform:translateX(-50%);bottom:14px;text-align:center;background:rgba(0,0,0,.45);padding:8px 16px;border-radius:8px;font-size:24px;line-height:1.25}
  #held{font-size:18px;opacity:.95;margin-top:2px}
  #caps{left:12px;bottom:14px;max-width:44%;font-size:17px;line-height:1.45}
  .cap{background:rgba(0,0,0,.55);margin-top:5px;padding:4px 10px;border-radius:5px;opacity:.95}
  .cap.chat{color:#aef3ae}.cap.event{color:#ffe9a8}
  #lv{color:#7CFC00;font-weight:700}
  </style></head><body>
  <iframe src="http://localhost:${VIEW_PORT}"></iframe>
  <div class="hud" id="top">…</div>
  <div class="hud" id="caps"></div>
  <div class="hud" id="bars"><div id="hf">…</div><div id="held"></div></div>
  <script>
  const $=id=>document.getElementById(id)
  const compass=y=>{const d=['S','SW','W','NW','N','NE','E','SE'];return d[Math.round(((y%6.283)+6.283)%6.283/0.785)%8]}
  async function state(){try{
    const s=await (await fetch('/state')).json(); if(!s.ok)return
    const hearts='\\u2764'.repeat(Math.max(0,Math.round(s.health/2)))+'\\u2661'.repeat(Math.max(0,10-Math.round(s.health/2)))
    const food='\\uD83C\\uDF57'.repeat(Math.max(0,Math.round(s.food/2)))
    $('hf').innerHTML='<span style="color:#ff5555">'+hearts+'</span>&nbsp;&nbsp;<span id="lv">Lv '+(s.xpLevel??'?')+'</span>&nbsp;&nbsp;'+food
    $('held').textContent=(s.held?s.held.name.replaceAll('_',' '):'empty hand')
    $('top').textContent='${USERNAME} @ '+Math.floor(s.pos.x)+', '+Math.floor(s.pos.y)+', '+Math.floor(s.pos.z)+'  facing '+compass(s.yaw)
  }catch(e){}}
  let evCur=null,chCur=null
  async function caps(){try{
    const lines=[]
    const ev=await (await fetch('/events?since='+(evCur??999999999))).json()
    if(ev.ok){if(evCur!==null)for(const e of (ev.events||[]))lines.push(['event','\\u2699 '+(e.kind?e.kind+' \\u2014 ':'')+(e.msg||'')]);evCur=ev.cursor}
    const ch=await (await fetch('/chatlog?since='+(chCur??999999999))).json()
    if(ch.ok){if(chCur!==null)for(const m of (ch.messages||[]))lines.push(['chat','<'+m.from+'> '+m.msg]);chCur=ch.cursor}
    for(const [k,t] of lines){const d=document.createElement('div');d.className='cap '+k;d.textContent=t;$('caps').appendChild(d);setTimeout(()=>d.remove(),9000)}
    while($('caps').children.length>5)$('caps').firstChild.remove()
  }catch(e){}}
  setInterval(state,500);state();setInterval(caps,1000)
  </script></body></html>`)
})

// /record?on=1&label=&w=&h= — film /pov headlessly to recordings/<stamp>[-label].webm via
// puppeteer's screencast (NEEDS ffmpeg: tools/ffmpeg/bin/ffmpeg.exe vendored, or on PATH).
// ?on=0 stops and reports the file; bare /record reports status. WebM uploads to YouTube as-is.
let recPage = null, recorder = null, recPath = null, recStart = 0
function findFfmpeg () {
  const path = require('path')
  const local = path.join(__dirname, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe')
  if (fs.existsSync(local)) return local
  return undefined      // undefined → puppeteer tries PATH
}
app.get('/record', async (req, res) => {
  try {
    if (req.query.on === '1') {
      if (recorder) return err(res, new Error('already recording ' + recPath + ' — /record?on=0 first'))
      const path = require('path')
      const w = Math.min(1920, Math.max(640, parseInt(req.query.w || '1280')))
      const h = Math.min(1080, Math.max(360, parseInt(req.query.h || '720')))
      const label = (req.query.label || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      fs.mkdirSync(path.join(__dirname, 'recordings'), { recursive: true })
      recPath = path.join(__dirname, 'recordings', stamp + (label ? '-' + label : '') + '.webm')
      const browser = await getSnapBrowser()
      recPage = await browser.newPage()
      await recPage.setViewport({ width: w, height: h })
      await recPage.goto('http://localhost:' + CTRL_PORT + '/pov', { waitUntil: 'networkidle2', timeout: 20000 })
      await new Promise(r => setTimeout(r, 6000))            // let the viewer mesh chunks
      recorder = await recPage.screencast({ path: recPath, ffmpegPath: findFfmpeg() })
      recStart = Date.now()
      emitEvent('record', 'rolling: ' + recPath + ' (' + w + 'x' + h + ')')
      ok(res, { recording: recPath, width: w, height: h })
    } else if (req.query.on === '0') {
      if (!recorder) return err(res, new Error('not recording'))
      await recorder.stop()
      try { await recPage.close() } catch (e) {}
      const out = recPath, secs = Math.round((Date.now() - recStart) / 1000)
      recorder = null; recPage = null; recPath = null
      const size = (() => { try { return Math.round(fs.statSync(out).size / 1048576 * 10) / 10 } catch (e) { return null } })()
      emitEvent('record', 'cut: ' + out + ' (' + secs + 's, ' + size + 'MB)')
      ok(res, { saved: out, seconds: secs, sizeMB: size })
    } else {
      ok(res, recorder
        ? { recording: recPath, seconds: Math.round((Date.now() - recStart) / 1000) }
        : { recording: false, ffmpeg: findFfmpeg() || 'PATH (not verified)', hint: '/record?on=1&label=raid' })
    }
  } catch (e) {
    try { if (recorder) await recorder.stop() } catch (_) {}
    try { if (recPage && !recPage.isClosed()) await recPage.close() } catch (_) {}
    recorder = null; recPage = null
    err(res, e)
  }
})

app.get('/snapshot', async (req, res) => {
  try {
    const path = require('path')
    const outPath = path.join(process.cwd(), 'snapshot.png')
    const w = Math.min(1280, Math.max(160, parseInt(req.query.w || '800')))
    const h = Math.min(720, Math.max(120, parseInt(req.query.h || '600')))
    const settle = Math.min(8000, Math.max(200, parseInt(req.query.wait || '900')))
    const { page, warmed } = await getSnapPage(w, h, req.query.fresh === '1')
    await new Promise(r => setTimeout(r, settle))          // brief settle for movement / new chunks
    await page.screenshot({ path: outPath })
    ok(res, { saved: outPath, width: w, height: h, warmShot: !warmed, note: 'read the PNG to view it' })
    try { emitEvent('snapshot', 'wrote ' + outPath) } catch (e) {}
  } catch (e) {
    try { if (snapPage && !snapPage.isClosed()) { await snapPage.close() } } catch (_) {}
    snapPage = null
    err(res, new Error('snapshot failed: ' + (e.message || String(e))))
  }
})

// ==== VISION 2 endpoints: /gaze (the look verb), /section (the vertical slice), /passages ====

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

// GET /gaze?at=x,y,z | dir=n|ne|e|se|s|sw|w|nw|up|down &dist=24 — the deliberate LOOK, in my native
// medium. Aims the head (the VIEW_PORT viewer turns with it, so the helmsman sees where I look), sweeps a fan
// of eye rays, and narrates what they strike: dominant surfaces, notables (ore/liquid/utility),
// openings. Everything reported is SEEN-tier — a real ray hit it — and every swept cell feeds the
// SEEN memory. This, not /snapshot, is the primary look verb; the PNG stays as the verifier.
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
      const H = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] }
      if (d === 'up') await bot.lookAt(p.offset(0.01, 13, 0.01), true)
      else if (d === 'down') await bot.lookAt(p.offset(0.01, -9, 0.01), true)
      else if (H[d]) await bot.lookAt(p.offset(H[d][0] * 10, 1.62, H[d][1] * 10), true)
      else return err(res, new Error('dir must be a compass point, up, or down'))
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

const { sectionColumns, floorPhrase } = require('./lib/section')

// GET /section?dir=n|s|e|w&len=16&up=8&down=12 — the VERTICAL cross-section, the missing half of
// /map (a stone slice at depth used to read as "surface"; this is the view that shows the route
// up/down). Renders only the cells the bot knows (cellKnown) and the two the body fills, and ore only
// in lit sight now. Everything else is '?'. Narration first; the grid is the backup.
app.get('/section', (req, res) => {
  try {
    const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }
    let dx, dz
    const dp = (req.query.dir || '').toLowerCase()
    if (DIRS[dp]) { [dx, dz] = DIRS[dp] }
    else { const yaw = bot.entity.yaw, sx = -Math.sin(yaw), cz = -Math.cos(yaw); if (Math.abs(sx) >= Math.abs(cz)) { dx = Math.sign(sx) || 1; dz = 0 } else { dx = 0; dz = Math.sign(cz) || 1 } }
    const dirName = dp || (dx ? (dx > 0 ? 'e' : 'w') : (dz > 0 ? 's' : 'n'))
    const len = Math.min(32, Math.max(4, parseInt(req.query.len || '16')))
    const upR = Math.min(16, Math.max(2, parseInt(req.query.up || '8')))
    const downR = Math.min(24, Math.max(2, parseInt(req.query.down || '12')))
    const o = bot.entity.position.floored()
    const knowledge = new Map()
    const seen = (x, y, z) => {
      if (x === o.x && z === o.z && (y === o.y || y === o.y + 1)) return true
      const k = ck(x, y, z)
      if (!knowledge.has(k)) knowledge.set(k, cellKnown(new Vec3(x, y, z)))
      return knowledge.get(k)
    }
    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
    const open = (x, y, z) => seen(x, y, z) && floodPassable(at(x, y, z))
    const wet = (x, y, z) => at(x, y, z).name.includes('water')

    const secGlyph = (n) => n.endsWith('_ore') ? '*' : n.includes('water') ? '~' : n.includes('lava') ? '!' : (glyphFor(n) === ' ' ? '#' : glyphFor(n))
    const ores = []
    const rows = []
    for (let y = o.y + upR; y >= o.y - downR; y--) {
      let row = ''
      for (let d = -2; d <= len; d++) {
        const x = o.x + dx * d, z = o.z + dz * d
        if (d === 0 && (y === o.y || y === o.y + 1)) { row += '@'; continue }
        if (open(x, y, z)) { row += wet(x, y, z) ? '~' : ' '; continue }
        const b = at(x, y, z)
        if (!b || !seen(x, y, z)) { row += '?'; continue }
        if (b.name.includes('lava')) { row += '!'; continue }
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
      known: (p) => seen(p.x, p.y, p.z),
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
        // Sealed only when the bot sees rock across the whole height of the last open column.
        const last = reach[reach.length - 1]
        const x = o.x + dx * endAt, z = o.z + dz * endAt
        let wall = true
        for (let y = last.lo; y <= last.hi && wall; y++) { const b = at(x, y, z); wall = seen(x, y, z) && !!b && b.boundingBox === 'block' }
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
      legend: '@=you  space=air  ~=water !=lava *=ORE #=rock .=soil T=wood ==built ?=unseen',
      orientation: `left column is 2 behind you, '@' column is you, rightward = ${dirName.toUpperCase()}; rows top->bottom = y${o.y + upR}->y${o.y - downR}`,
      grid: rows.join('\n'), ores: Object.values(oreBest)
    })
  } catch (e) { err(res, e) }
})

// GET /passages?radius=20 — "which ways does this space GO?" The air connected to the body that
// reaches the scan boundary, grouped by direction. Only cells the bot knows (cellKnown) count.
app.get('/passages', (req, res) => {
  try {
    const radius = Math.min(32, Math.max(8, parseInt(req.query.radius || '20')))
    const o = bot.entity.position.floored()
    const fill = airFlood({ radius, cap: 15000, known: cellKnown })
    const dirs = {}
    let contUp = false, contDown = false, leaves = false
    for (const k of fill.cells) {
      const [x, y, z] = k.split(',').map(Number)
      const ddx = x - o.x, ddy = y - o.y, ddz = z - o.z
      const side = Math.max(Math.abs(ddx), Math.abs(ddz)) >= radius
      if (!side && Math.abs(ddy) < radius) continue
      leaves = true
      if (!cellKnown(new Vec3(x, y, z))) continue
      if (side) {
        const c = compass(ddx, ddz)
        const g = dirs[c] || (dirs[c] = { cells: 0, loY: Infinity, hiY: -Infinity })
        g.cells++; if (y < g.loY) g.loY = y; if (y > g.hiY) g.hiY = y
        // keep one walk-to SAMPLE cell per exit (prefer one with a seen floor under it) so the pilot
        // can probe an exit with /goto directly instead of guessing geometry
        if (!g.sampleFloor) {
          const under = new Vec3(x, y - 1, z)
          const fb = bot.blockAt(under)
          const hasFloor = !!(fb && fb.boundingBox === 'block') && cellKnown(under)
          if (!g.sample || hasFloor) { g.sample = { x, y, z }; g.sampleFloor = hasFloor }
        }
      }
      if (ddy >= radius) contUp = true
      if (ddy <= -radius) contDown = true
    }
    const parts = Object.entries(dirs).sort((a, b) => b[1].cells - a[1].cells)
      .map(([c, g]) => `${c} (around y${g.loY}${g.hiY !== g.loY ? '–' + g.hiY : ''}${g.sample ? `, walk-to ${g.sample.x},${g.sample.y},${g.sample.z}` : ''})`)
    let summary
    if (parts.length || contUp || contDown) summary = 'air continues ' + [...parts, contUp ? `UP past +${radius}` : null, contDown ? `DOWN past -${radius}` : null].filter(Boolean).join(', ')
    // Closed only when the bot sees every wall of a pocket that stays inside the radius.
    else if (!leaves && !fill.capped && !fill.unknown) summary = `closed pocket — no connected air leaves a ${radius}-block radius; digging is the only way on`
    else summary = `no exit in sight within ${radius} blocks`
    ok(res, { summary, radius, exits: dirs, up: contUp, down: contDown })
  } catch (e) { err(res, e) }
})

// GET /use?x=&y=&z=[&item=name] — the universal RIGHT-CLICK: equip item (optional) and activate it
// on the block. Unlocks the whole interaction layer: till (hoe), sow (seeds), bone meal, fill/pour
// bucket, open/close doors, shear sheep... For liquids (no activatable block) it aims and uses the
// held item instead. Walks closer only if out of arm's reach (digat's lesson).
app.get('/use', async (req, res) => {
  try {
    const p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
    if (![p.x, p.y, p.z].every(Number.isFinite)) return err(res, new Error('x, y, z required'))
    const b = bot.blockAt(p)
    if (!b) return err(res, new Error('block not loaded'))
    if (req.query.item) {
      const it = bot.inventory.items().find(i => i.name === String(req.query.item))
      if (!it) return err(res, new Error('not carrying ' + req.query.item))
      await bot.equip(it, 'hand')
    }
    const eyeDist = bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5))
    if (eyeDist > 4.2) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2))
    await bot.lookAt(p.offset(0.5, 0.5, 0.5), true)
    // raw item-use (aim + right-click-the-item) for: liquids (fill), AIR targets (pour into a hole —
    // activateBlock on solids does NOT pour, learned live 07-12), or explicit ?raw=1
    // Crops, saplings and grass have no collision box but take the click themselves (bone meal).
    const rawUse = b.name.includes('water') || b.name.includes('lava') || /^(cave_|void_)?air$/.test(b.name) || req.query.raw === '1'
    if (rawUse) {
      bot.activateItem()
      await new Promise(r => setTimeout(r, 300))
      try { bot.deactivateItem() } catch (e) {}
    } else {
      await bot.activateBlock(b)
    }
    ok(res, { used: bot.heldItem ? bot.heldItem.name : 'empty hand', on: b.name, at: round(p), now: (bot.blockAt(p) || {}).name })
  } catch (e) { err(res, e) }
})

// GET /pillar?height=N — deliberate 1x1 pillar-jump: place a block under my own feet while jumping,
// N times. The vertical-access verb the causeway and spiral stairs both lacked (mid-air treads have
// no reference face; my OWN feet always do). Deliberate infrastructure like stair treads — bounded,
// never automatic (Movements keeps allow1by1towers=false; this is the pilot CHOOSING to climb).
// /climb — ascend an adjacent ladder column (the pathfinder can't plan ladder moves; this
// is the manual reflex, like nudgeInto is for carved stairs). Finds a ladder within 1 block,
// faces it, holds forward (physics climbs a body pressed against a ladder), releases when the
// feet clear the top rung, then keeps forward briefly to step off onto the floor.
app.get('/climb', async (req, res) => {
  try {
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    const Vec3 = require('vec3').Vec3
    const base = bot.entity.position.floored()
    let lad = null
    outer: for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1]) {
        const b = bot.blockAt(base.offset(dx, dy, dz))
        if (b && b.name === 'ladder') { lad = b; break outer }
      }
    }
    if (!lad) return err(res, new Error('no ladder within reach'))
    const lx = lad.position.x, lz = lad.position.z
    let topY = lad.position.y
    while (((bot.blockAt(new Vec3(lx, topY + 1, lz))) || {}).name === 'ladder') topY++
    // climb = press toward the WALL the ladder hangs on. The ladder's `facing` points away
    // from its mount wall — aim opposite. ("Look at the ladder" fails when the ladder shares
    // my own column: that aims at my own feet and forward goes nowhere useful.)
    const lf = (lad.getProperties() || {}).facing || 'north'
    const AWAY = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[lf]
    safeStop()
    // enter the ladder COLUMN first — pressing at the mount wall from a neighboring
    // column just bounces against bare wall beside the ladder (learned live)
    const myCell = bot.entity.position.floored()
    if (!(myCell.x === lx && myCell.z === lz)) {
      await nudgeInto(new Vec3(lx, myCell.y, lz), false)
    }
    // A bunker build that began during the climb owns the control states from then on.
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    await bot.lookAt(new Vec3(lx + 0.5 - AWAY[0] * 2, bot.entity.position.y + 0.6, lz + 0.5 - AWAY[1] * 2), true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)    // physics only sees a ladder at the FEET cell — a hop
                                         // lifts the feet into it, and climbUsingJump takes over
    const t0 = Date.now()
    let crested = false
    while (Date.now() - t0 < 15000 && !bunker.building) {
      await bot.waitForTicks(2)
      if (bot.entity.position.y >= topY + 0.9) { crested = true; break }
    }
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    bot.setControlState('jump', false)
    await bot.waitForTicks(8)            // momentum carries the step-off past the hatch lip
    if (!bunker.building) bot.setControlState('forward', false)
    ok(res, { climbed: crested, y: Math.round(bot.entity.position.y * 10) / 10, ladderTop: topY, onGround: bot.entity.onGround })
  } catch (e) { try { bot.clearControlStates() } catch (_) {}; err(res, e) }
})

// Equips item and jump-places it on below, the block under the feet, in up to three tries. True once
// the body stands a block higher. own marks the bunker build's call, the only one a build lets through.
async function jumpPlace (below, item, own = false) {
  const yBefore = Math.floor(bot.entity.position.y)
  refuseWhileBuilding(own)
  await bot.equip(item, 'hand')
  await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
  const cell = below.position.offset(0, 1, 0)
  for (let attempt = 0; attempt < 3; attempt++) {
    refuseWhileBuilding(own)
    bot.setControlState('jump', true)
    await new Promise(r => setTimeout(r, 180))                       // near jump apex
    // A block never goes into a cell the body still overlaps.
    for (let i = 0; i < 3 && entityInCell(cell, [bot.entity]); i++) await bot.waitForTicks(1)
    refuseWhileBuilding(own)
    if (!entityInCell(cell, [bot.entity, ...blockers()])) {
      try { await bot.placeBlock(below, new Vec3(0, 1, 0)) } catch (e) {}
    }
    // A build that began during the place owns the jump control.
    refuseWhileBuilding(own)
    bot.setControlState('jump', false)
    await new Promise(r => setTimeout(r, 400))                       // settle
    if (Math.floor(bot.entity.position.y) > yBefore) return true
  }
  return false
}

app.get('/pillar', async (req, res) => {
  try {
    const height = Math.min(16, Math.max(1, parseInt(req.query.height || '3')))
    let placed = 0
    const y0 = Math.floor(bot.entity.position.y)
    for (let i = 0; i < height; i++) {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const yBefore = Math.floor(bot.entity.position.y)
      const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!below || below.boundingBox !== 'block') return ok(res, { placed, rose: yBefore - y0, stopped: 'no solid footing to build on' })
      const it = fillers()[0]
      if (!it) return ok(res, { placed, rose: yBefore - y0, stopped: 'out of filler blocks (dirt, stone kinds, sandstone, bricks or planks)' })
      if (!(await jumpPlace(below, it))) return ok(res, { placed, rose: Math.floor(bot.entity.position.y) - y0, stopped: 'placement would not take (ceiling? cell blocked?)' })
      placed++
    }
    ok(res, { placed, rose: Math.floor(bot.entity.position.y) - y0, y: Math.floor(bot.entity.position.y) })
  } catch (e) { try { if (!bunker.building) bot.setControlState('jump', false) } catch (_) {} ; err(res, e) }
})

// ---- BUNKER: the last-resort shelter, built from blocks in the pockets. "down" digs the three
// cells under the feet in natural ground and caps the shaft over the head. "up" pillars and builds
// a shell on top: a ledge ring under the body, two rings of wall beside it and a roof. The body
// stays inside until the pilot digs out.
const BUNKER_HEIGHT = 3
// The health below which the bunker reflex fires, and the health at which it re-arms.
const BUNKER_HP = 8
const BUNKER_REARM_HP = 12
// Natural ground, the only blocks "down" digs.
const BUNKER_GROUND = /^(grass_block|dirt|coarse_dirt|podzol|mycelium|stone|granite|diorite|andesite|deepslate|tuff|sand|red_sand|gravel|sandstone|red_sandstone|netherrack|soul_sand|soul_soil|end_stone)$/
// The longest dig per cell "down" accepts, with the pick it digs with.
const BUNKER_DIG_MS = 1500
// Filler, most expendable first. Planks of any wood come after these.
const BUNKER_FILL = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'stone', 'sandstone', 'end_stone', 'stone_bricks', 'bricks']
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// The neighbours a placement may click, the one below first.
const NEIGHBOURS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
const solidAt = (p) => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' && !isSoftCover(b) }
const xyz = (v) => ({ x: v.x, y: v.y, z: v.z })

function fillers () {
  const items = bot.inventory.items()
  return [...BUNKER_FILL.flatMap(n => items.filter(i => i.name === n)), ...items.filter(i => i.name.endsWith('_planks'))]
}

// Puts a filler block into cell against a solid neighbour. 'placed', 'solid' when it already was, or null.
async function placeFiller (cell) {
  if (solidAt(cell)) return 'solid'
  const item = fillers()[0]
  const ref = item && NEIGHBOURS.map(([dx, dy, dz]) => cell.offset(dx, dy, dz)).find(solidAt)
  if (!ref) return null
  await clearSoftCover(cell)
  if (!bot.heldItem || bot.heldItem.name !== item.name) await bot.equip(item, 'hand')
  if (entityInCell(cell, blockers())) return null
  try { await bot.placeBlock(bot.blockAt(ref), cell.minus(ref)) } catch (e) {}
  return solidAt(cell) ? 'placed' : null
}

// Sneaks the body to the middle of its cell. Within 0.2 of it, the body fits a one-wide shaft and
// clears the cells beside it.
async function centerOnCell () {
  const mid = bot.entity.position.floored().offset(0.5, 0, 0.5)
  const off = () => Math.max(Math.abs(bot.entity.position.x - mid.x), Math.abs(bot.entity.position.z - mid.z))
  if (off() > 0.2) {
    try {
      await bot.lookAt(new Vec3(mid.x, bot.entity.position.y + 1.62, mid.z), true)
      bot.setControlState('sneak', true)
      bot.setControlState('forward', true)
      for (let i = 0; i < 30 && off() > 0.1; i++) await bot.waitForTicks(1)
    } finally {
      bot.setControlState('forward', false)
      bot.setControlState('sneak', false)
    }
    await bot.waitForTicks(2)
  }
  return off() <= 0.2
}

// The ms the body takes to dig b with the pick it would equip.
function digMs (b) {
  const pick = pickFor(b.name)
  return b.digTime(pick ? pick.type : null, false, false, false, [], bot.entity.effects)
}

// Why "down" cannot dig in where the body stands, or null.
function digInProblem () {
  if (!bot.entity.onGround) return 'not standing on the ground'
  const o = bot.entity.position.floored()
  // Water or lava beside the body runs down the shaft once it is open.
  for (const dy of [0, 1]) {
    for (const [dx, dz] of SIDES) {
      const side = bot.blockAt(o.offset(dx, dy, dz))
      if (!side || /water|lava/.test(side.name)) return `${side ? side.name : 'an unloaded block'} beside the body`
    }
  }
  for (let dy = -1; dy >= -3; dy--) {
    const b = bot.blockAt(o.offset(0, dy, 0))
    if (!b || !BUNKER_GROUND.test(b.name)) return `${b ? b.name : 'unloaded ground'} ${-dy} below is not natural ground`
    if (digMs(b) > BUNKER_DIG_MS) return `${b.name} ${-dy} below digs too slowly`
    for (const [dx, dz] of SIDES) {
      const side = bot.blockAt(o.offset(dx, dy, dz))
      if (!side || /water|lava/.test(side.name)) return `${side ? side.name : 'unloaded ground'} beside the shaft`
      if (dy < -1 && !solidAt(side.position)) return `an opening beside the shaft ${-dy} below`
    }
  }
  if (!solidAt(o.offset(0, -4, 0))) return 'no solid floor 4 below'
  if (!SIDES.some(([dx, dz]) => solidAt(o.offset(dx, -1, dz)))) return 'nothing beside the shaft to hold a cap'
  if (!fillers().length) return 'no blocks for the cap'
  return null
}

// True once the body has risen or sunk out of a mob's reach.
function outOfReach () {
  return bunker.reached >= (bunker.mode === 'up' ? SHELTER.SAFE_HEIGHT : SHELTER.SAFE_DEPTH)
}

// Why the build has to end now, or null. Out of reach, a hit no longer ends it.
function buildStop () {
  return bunker.stop === 'hit while building' && outOfReach() ? null : bunker.stop
}

// Digs the three cells under the feet, dropping into each, and caps the shaft over the head.
async function digIn () {
  const o = bot.entity.position.floored()
  const cap = o.offset(0, -1, 0)
  let dug = 0
  for (let dy = -1; dy >= -3; dy--) {
    if (buildStop()) return { at: bot.entity.position.floored(), dug, placed: 0, stopped: buildStop() }
    const b = bot.blockAt(o.offset(0, dy, 0))
    await equipPickFor(b.name)
    await bot.dig(b)
    dug++
    const landed = () => bot.entity.onGround && Math.floor(bot.entity.position.y + 0.01) <= o.y + dy
    for (let i = 0; i < 20 && !landed(); i++) await bot.waitForTicks(1)
    if (!landed()) return { at: bot.entity.position.floored(), dug, placed: 0, stopped: 'the body did not drop into the shaft' }
    bunker.reached = dug
  }
  const at = o.offset(0, -3, 0)
  if (buildStop()) return { at, dug, placed: 0, stopped: buildStop() }
  bunker.cell = at
  const placed = (await placeFiller(cap)) === 'placed' ? 1 : 0
  const shell = [cap, o.offset(0, -4, 0), ...SIDES.flatMap(([dx, dz]) => [o.offset(dx, -2, dz), o.offset(dx, -3, dz)])]
  return { at, dug, placed, gaps: shell.filter(c => !solidAt(c)), exit: [cap].filter(solidAt) }
}

// Why "up" cannot pillar height blocks where the body stands, or null.
function pillarProblem (height) {
  const o = bot.entity.position.floored()
  if (!solidAt(o.offset(0, -1, 0))) return 'no solid footing'
  for (let dy = 2; dy <= height + 2; dy++) {
    const b = bot.blockAt(o.offset(0, dy, 0))
    if (!b || (b.boundingBox !== 'empty' && !isSoftCover(b))) return `no headroom ${dy} above the feet`
  }
  // A mob on a ledge beside the column, standing up to one block over the head of the body on top, is nearer it.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      for (let dy = 0; dy <= height + 1; dy++) {
        if (solidAt(o.offset(dx, dy, dz)) && !solidAt(o.offset(dx, dy + 1, dz))) return 'a step beside the pillar'
      }
    }
  }
  const blocks = fillers().reduce((n, i) => n + i.count, 0)
  if (blocks < height) return `${blocks} blocks carried, the pillar takes ${height}`
  return null
}

// Pillars height blocks and builds the shell around the body on top.
async function pillarShell (height) {
  let placed = 0
  for (let i = 0; i < height; i++) {
    if (buildStop()) return { at: bot.entity.position.floored(), placed, stopped: buildStop() }
    const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    const item = fillers()[0]
    if (!item || !below || !(await jumpPlace(below, item, true))) return { at: bot.entity.position.floored(), placed, stopped: 'a pillar block did not place' }
    placed++
    bunker.reached = placed
  }
  const top = bot.entity.position.floored()
  bunker.cell = top
  await centerOnCell()
  const onTop = () => bot.entity.position.floored().equals(top)
  const put = async (cell) => {
    if (buildStop() || !onTop()) return false
    const r = await placeFiller(cell)
    if (r === 'placed') placed++
    return r !== null
  }
  const ring = (dy) => SIDES.map(([dx, dz]) => top.offset(dx, dy, dz))
  for (const cell of [...ring(-1), ...ring(0), ...ring(1)]) await put(cell)
  const roof = top.offset(0, 2, 0)
  if (!(await put(roof))) {
    const prop = ring(2).find(c => solidAt(c.offset(0, -1, 0)))
    if (prop && await put(prop)) await put(roof)
  }
  const ledge = SIDES.find(([dx, dz]) => solidAt(top.offset(dx, -1, dz)))
  return {
    at: top,
    placed,
    gaps: [top.offset(0, -1, 0), ...ring(0), ...ring(1), roof].filter(c => !solidAt(c)),
    exit: ledge ? [top.offset(ledge[0], 0, ledge[1]), top.offset(ledge[0], 1, ledge[1])].filter(solidAt) : [],
    stopped: buildStop() || (onTop() ? undefined : 'the body left the pillar top')
  }
}

// Why no bunker can start where the body stands, or null: water or lava in its feet or head cell,
// which a shell would hold the body in.
function liquidProblem () {
  const p = bot.entity.position
  for (const c of [p.floored(), p.offset(0, 1.6, 0).floored()]) {
    const b = bot.blockAt(c)
    if (b && (/^(water|lava|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(b.name) || b.isWaterlogged)) return `the body stands in ${b.isWaterlogged ? 'waterlogged ' : ''}${b.name}`
  }
  return null
}

// The chooseShelter input for requested where the body stands. Threats come nearest first, each with
// its entity.
function shelterInputs (requested, height = BUNKER_HEIGHT) {
  const here = bot.entity.position
  const now = Date.now()
  const combat = reflexes.find(r => r.name === 'combat')
  const threats = []
  // entityEngageable reads this map too.
  expireConfirmed(AGGRO_CONFIRMED, now, CONFIRMED_MS)
  for (const e of liveEntities()) {
    if (!e.position) continue
    const cls = mobClass(e)
    const confirmed = AGGRO_CONFIRMED.has(e.id)
    if (!(['hostile', 'creeper', 'heavy'].includes(cls) || (cls === 'provokable' && confirmed))) continue
    const dist = e.position.distanceTo(here)
    if (dist > (confirmed ? CONFIRMED_HORIZON : SHELTER.HORIZON) || !entityEngageable(e)) continue
    // A mob that has not hit the body counts only where the body perceives it.
    if (!confirmed && !entityPerceptible(e, combat.fairFill(bot))) continue
    const data = mcData && mcData.entitiesByName[e.name]
    threats.push({ name: e.name, baby: babyFlag(e.metadata, data && data.metadataKeys), dist, entity: e })
  }
  threats.sort((a, b) => a.dist - b.dist)
  const liquid = liquidProblem()
  const problems = { down: liquid || digInProblem(), up: liquid || pillarProblem(height) }
  const shaft = []
  for (let dy = 1; dy <= SHELTER.SAFE_DEPTH; dy++) shaft.push(bot.blockAt(here.floored().offset(0, -dy, 0)))
  const buildMs = { down: problems.down === null ? downBuildMs(shaft.map(digMs)) : Infinity, up: upBuildMs() }
  return { requested, threats, problems, buildMs }
}

// A mob's hit after the pick and before the body is out of reach stops the build. An arrow does not
// stop a dig-in, which takes the body out of its line.
function onBuildHit (attrib) {
  const cls = attrib && attrib.entity && !attrib.envHit ? mobClass(attrib.entity) : null
  if (attrib && attrib.ranged && bunker.mode === 'down') return
  if (!bunker.stop && bunker.mode && ['hostile', 'creeper', 'heavy', 'provokable'].includes(cls) && !outOfReach()) bunker.stop = 'hit while building'
}

// The bunker reflex's next step: { build: true }, { flee, why } from the nearest threat, or null.
function bunkerReflexDecide () {
  const combat = reflexes.find(r => r.name === 'combat')
  const reflex = reflexes.find(r => r.name === 'bunker')
  const now = Date.now()
  const playerFlee = combat._fleeCls === 'player' && now - combat._fleeT < 15000
  if (bunkerHolds() || reflex._spent || playerFlee || bot.health >= BUNKER_HP) return null
  if (now - lastHit.t >= 15000 || !['hostile', 'creeper', 'heavy', 'provokable'].includes(lastHit.cls)) return null
  const input = shelterInputs('auto')
  if (!input.threats.length) return null
  const pick = chooseShelter(input)
  if (pick.mode) return { build: true }
  const near = input.threats[0]
  return { flee: near.entity, why: `no bunker at HP ${Math.round(bot.health * 10) / 10} (${pick.refuse}), fleeing from ${near.name}` }
}

// Clears the threat state a death or a dimension change leaves behind.
function resetThreatState () {
  const combat = reflexes.find(r => r.name === 'combat')
  AGGRO_CONFIRMED.clear()
  combat._fleeT = 0
  combat._fleeCls = null
  combat._fleeUntil = 0
  combat._coverUntil = 0
  lastHit = { dmg: 0, t: 0 }
  reflexes.find(r => r.name === 'bunker')._spent = false
  bunker.cell = null
}

// The entities whose box keeps a block out of its cell.
function blockers () {
  const living = ['mob', 'hostile', 'animal', 'passive', 'ambient', 'living', 'player']
  return liveEntities().filter(e => living.includes(e.type))
}

// Builds the bunker chooseShelter picks for mode once the combat reflex has let go. The result names
// its cell, its gaps and the cells to dig to leave, or carries error.
async function buildBunker (mode, height) {
  if (bunker.building) return { error: 'a bunker is already being built' }
  const liquid = liquidProblem()
  if (liquid) return { error: `no bunker possible here (${liquid})` }
  const earlier = bunker.cell
  bunker.building = true
  bunker.stop = null
  bunker.mode = null
  bunker.reached = 0
  const onDeath = () => { bunker.stop = 'the body died' }
  bot.once('death', onDeath)
  const halted = () => ({ mode: bunker.mode, stopped: bunker.stop, reached: bunker.reached, ...(bunker.mode === 'up' && { height }) })
  // Until the build ends, any goal but null is refused, goto included.
  const { setGoal, goto, setMovements } = bot.pathfinder
  bot.pathfinder.setGoal = (goal, dynamic) => {
    if (goal) throw new Error(BUNKER_WALK)
    setGoal(goal, dynamic)
  }
  bot.pathfinder.goto = async () => { throw new Error(BUNKER_WALK) }
  // setMovements clears the control states. Movements set during the build apply when it ends.
  let movements = null
  bot.pathfinder.setMovements = (m) => { movements = m }
  let r = null
  try {
    safeStop()
    // safeStop's stop lands at the next path node, clearing the goal lands it now.
    bot.pathfinder.setGoal(null)
    stopFollow()
    jobs.stopAll()
    bot.clearControlStates()
    const combat = reflexes.find(r => r.name === 'combat')
    // A flee or cover move stopped above holds no latch.
    combat._fleeUntil = 0
    combat._coverUntil = 0
    for (let i = 0; i < 60 && combat.active; i++) await bot.waitForTicks(1)
    // A down pick centres the body and picks again. Nothing waits between the last pick and the build.
    let pick = null
    for (const centre of [false, true]) {
      const centred = !centre || await centerOnCell()
      if (BUNKER_HALTS.includes(bunker.stop)) return halted()
      const input = shelterInputs(mode, height)
      if (!centred) input.problems.down = 'cannot stand in the middle of the cell'
      pick = chooseShelter(input)
      if (pick.mode !== 'down') break
    }
    if (pick.refuse) return { error: `no bunker possible here (${pick.refuse})` }
    bunker.mode = pick.mode
    r = pick.mode === 'down' ? await digIn() : await pillarShell(height)
    if (r.stopped && BUNKER_HALTS.includes(bunker.stop)) r.stopped = bunker.stop
    return {
      mode: pick.mode,
      at: xyz(r.at),
      sealed: !r.stopped && r.gaps.length === 0,
      dug: r.dug || 0,
      placed: r.placed,
      ...(pick.mode === 'up' && { height }),
      gaps: (r.gaps || []).map(xyz),
      exit: (r.exit || []).map(xyz),
      stopped: r.stopped
    }
  } catch (e) {
    if (BUNKER_HALTS.includes(bunker.stop)) return halted()
    return { error: `the bunker failed: ${e.message}` }
  } finally {
    bot.pathfinder.setGoal = setGoal
    bot.pathfinder.goto = goto
    bot.pathfinder.setMovements = setMovements
    bot.removeListener('death', onDeath)
    bunker.building = false
    bunker.stop = null
    // Follow waits out the quiet after a build as after a reflex take.
    legs.take('bunker', 'build a bunker')
    // A refusal, a throw or a stop leaves no cell of this build. An earlier bunker's cell stays.
    if (bunker.cell !== earlier) {
      if (!r || r.stopped) bunker.cell = null
    }
    try { bot.clearControlStates() } catch (e) {}
    if (movements) setMovements(movements)
  }
}

// GET /bunker?mode=auto|up|down&height=N: builds the shelter above and answers once it stands.
app.get('/bunker', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const mode = req.query.mode === undefined ? 'auto' : req.query.mode
    if (!BUNKER_MODES.includes(mode)) return err(res, new Error('mode must be auto, up or down'))
    const r = await buildBunker(mode, req.query.height === undefined ? BUNKER_HEIGHT : parseInt(req.query.height))
    if (r.error) return err(res, new Error(r.error))
    ok(res, { ...r, summary: bunkerSummary(r) })
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

// GET /gesture?name=nod|shake|wave|point[&at=x,y,z] — nonverbal presence for co-op play: the body
// can say yes, no, hello, and LOOK THERE without chat.
app.get('/gesture', async (req, res) => {
  try {
    const name = String(req.query.name || '').toLowerCase()
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const yaw0 = bot.entity.yaw, pitch0 = bot.entity.pitch
    if (name === 'nod') {
      for (let i = 0; i < 2; i++) { await bot.look(yaw0, -0.55, true); await sleep(180); await bot.look(yaw0, 0.35, true); await sleep(180) }
      await bot.look(yaw0, pitch0, true)
    } else if (name === 'shake') {
      for (let i = 0; i < 2; i++) { await bot.look(yaw0 - 0.6, pitch0, true); await sleep(180); await bot.look(yaw0 + 0.6, pitch0, true); await sleep(180) }
      await bot.look(yaw0, pitch0, true)
    } else if (name === 'wave') {
      for (let i = 0; i < 3; i++) { bot.swingArm('right'); await sleep(250) }
    } else if (name === 'point') {
      const [x, y, z] = String(req.query.at || '').split(',').map(Number)
      if (![x, y, z].every(Number.isFinite)) return err(res, new Error('point needs at=x,y,z'))
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      for (let i = 0; i < 2; i++) { bot.swingArm('right'); await sleep(300) }
    } else return err(res, new Error('name must be nod|shake|wave|point'))
    ok(res, { gestured: name })
  } catch (e) { err(res, e) }
})

// GET /boot: the one-call session opener with body, world, exits, tools, jobs and the chat cursor.
app.get('/boot', (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const pos = bot.entity.position
    const oh = overheadCover()
    const around = spatial3D(bot)
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
      skyPhrase(oh) + (around ? `Around: ${around}. ` : '') +
      (jl.length ? `RUNNING JOBS: ${jl.map(j => j.id + ':' + j.name).join(', ')}. ` : 'No jobs running. ') +
      `Chat cursor: ${chatLog.cursor}.`
    ok(res, {
      summary, pos: round(pos), health: bot.health, food: bot.food, xpLevel: bot.experience.level, held, armor,
      sky: oh, chatSeq: chatLog.cursor, seenCells: SEEN.size,
      waypoints: Object.keys(waypoints.list()), runningJobs: jl.map(j => ({ id: j.id, name: j.name })),
      reflexes: reflexes.map(r => ({ name: r.name, on: r.on }))
    })
  } catch (e) { err(res, e) }
})

// ---- MACROS: high-level verbs with guardrails baked in, run ASYNC via jobs.start ----

// GET /gather?resource=&amount=&radius= : background job that repeatedly finds the
// nearest matching block and mines it. GUARDRAILS: capped radius (default 40, hard-max
// 64); never dig straight down (skip any target >~2 below feet, prefer at/above feet or
// side-reachable); skip candidates pathfinder can't reach and try the next nearest;
// stop when 'amount' collected or no reachable target remains.
app.get('/gather', (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const resource = req.query.resource
    if (!resource) return err(res, new Error('resource required'))
    const amount = Math.max(1, parseInt(req.query.amount || '16'))
    let radius = parseInt(req.query.radius || '40')
    if (!Number.isFinite(radius) || radius <= 0) radius = 40
    radius = Math.min(radius, 64)                 // hard-max 64
    const ids = resolveBlockIds(resource)
    if (!ids.length) return err(res, new Error(`unknown block: ${resource}`))

    const { id } = jobs.start(`gather ${resource} x${amount}`, async (job) => {
      let mined = 0
      const tried = new Set()                     // positions we've given up on
      const key = (p) => `${p.x},${p.y},${p.z}`
      const startT = Date.now()
      let iters = 0
      let noProgress = 0                          // consecutive iterations with no mine (circuit breaker)
      // FORESTRY: harvesting wood → walk like a lumberjack (clear leaves+logs to travel) and
      // reach the whole trunk, not just the bottom few. Restored to considerate nav in finally.
      const isWood = ids.some(i => { const n = mcData.blocks[i] && mcData.blocks[i].name; return !!n && (n.endsWith('_log') || n.endsWith('_wood')) })
      const maxRise = isWood ? 24 : GATHER_MAX_RISE
      const usingForestry = isWood && !!forestryMoves
      const prevThink = bot.pathfinder.thinkTimeout
      // forestry pathfinding is heavier (canDig opens dig-moves at every node), so a truly
      // awkward floating log can eat the full 10s think budget before we skip it. Fail fast:
      // drop the think budget while gathering wood so unreachable targets are abandoned quickly.
      if (usingForestry) { bot.pathfinder.setMovements(forestryMoves); bot.pathfinder.thinkTimeout = 3000; job.progress('forestry nav: may clear leaves+logs') }
      try {
      while (mined < amount) {
        if (job.cancelled) { job.progress('cancelled'); break }
        if (++iters > amount * 8 + 40 || Date.now() - startT > 180000) { job.progress('watchdog: stopping (iter/time bound)'); break }
        const feetY = Math.floor(bot.entity.position.y)
        // pull a batch so we can pick a SAFE candidate (not the raw nearest)
        const cands = bot.findBlocks({ matching: ids, maxDistance: radius, count: 40 })
        const here = bot.entity.position
        const ranked = cands
          .filter(p => !tried.has(key(p)))
          .map(p => ({ p, dist: here.distanceTo(p), drop: feetY - p.y }))
          // GUARDRAIL: never dig straight down. Refuse anything more than ~2 below feet
          // (a shaft); keep only targets at/above feet or reachable from the side.
          .filter(o => o.drop <= GATHER_MAX_DROP && o.drop >= -maxRise)
          .filter(o => seesLit(o.p, radius))         // FAIRNESS: only what a player here could see
          .sort((a, b) => a.dist - b.dist)
        if (!ranked.length) {
          job.progress(`no reachable ${resource} left (mined ${mined}/${amount})`)
          break
        }
        let progressed = false
        for (const { p } of ranked) {
          const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
          if (!b || !ids.includes(b.type)) { tried.add(key(p)); continue }
          try {
            // approach from a reachable spot, then collect (dig into a face, not a shaft)
            await watchedWork(() => bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)), stopPath)
          } catch (e) {
            // GUARDRAIL: unreachable candidate -> skip, try next nearest, don't flail
            tried.add(key(p))
            job.progress(`skip unreachable @ ${p.x},${p.y},${p.z}: ${e.message}`)
            continue
          }
          try {
            await collectSafely(b)
            mined++
            progressed = true
            job.progress(`mined ${resource} ${mined}/${amount} @ ${p.x},${p.y},${p.z}`)
          } catch (e) {
            tried.add(key(p))
            job.progress(`dig failed @ ${p.x},${p.y},${p.z}: ${e.message}`)
          }
          break                                   // re-scan from the new position each mine
        }
        // CIRCUIT BREAKER: one iteration tries every visible candidate, so an iteration with
        // no mine means nothing is reachable from here right now. A few of those in a row = this
        // spot is tapped out (or a target keeps timing out) → stop cleanly and let the driver
        // reposition, instead of grinding the same unreachable logs.
        if (progressed) noProgress = 0
        else if (++noProgress >= 3) {
          job.progress(`spot tapped out — no reachable ${resource} in ${noProgress} passes (mined ${mined}/${amount})`)
          break
        }
      }
      const have = bot.inventory.items()
        .filter(it => it.name.includes(resource) || resource.includes(it.name))
        .reduce((s, it) => s + it.count, 0)
      emitEvent('gather', `done ${resource} mined=${mined}`, { inventoryMatching: have })
      return { mined, requested: amount, inventoryMatching: have }
      } finally {
        if (usingForestry && considerateMoves) { bot.pathfinder.setMovements(considerateMoves); bot.pathfinder.thinkTimeout = prevThink }
      }
    })
    ok(res, { job: id })
  } catch (e) { err(res, e) }
})

// Shared STEP primitive — physics-walk the bot one cell instead of asking the pathfinder to plan
// it. Under canDig=false the pathfinder REFUSES the tight 1-block move into a just-carved mining
// cell (stalls "Path was stopped before"): climbing a 1-wide step, dropping into a descend cell, or
// advancing a fresh tunnel face. So we face the target and hold forward (+ jump when climbing),
// polling until the bot is actually in the cell and grounded. The undug wall beyond stops overshoot.
// climbing=true → ascending (mount +1); false → level/descending (walk or fall into the cell).
async function nudgeInto (target, climbing, timeoutMs = 3000, route = null) {
  // A bunker build owns the control states, also one that began mid-nudge.
  const cut = () => (route ? routeEnd(route) : bunker.building)
  if (cut()) return false
  const Vec3 = require('vec3').Vec3
  try {
    await bot.lookAt(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5), true)
    if (cut()) return false
    bot.setControlState('forward', true)
    if (climbing) bot.setControlState('jump', true)
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs && !cut()) {
      await new Promise(r => setTimeout(r, 60))
      const p = bot.entity.position.floored()
      const yOk = climbing ? p.y >= target.y : p.y <= target.y
      // cut power the moment we ENTER the target column — do NOT wait for onGround with controls
      // held: a held jump keeps the bot airborne at poll time, so it blows straight through the
      // cell and sprints on (the 07-11 open-terrain overshoot to x-35). Settle+verify AFTER.
      if (p.x === target.x && p.z === target.z && yOk) break
    }
  } finally {
    if (!bunker.building) {
      bot.setControlState('forward', false)
      // A drown rescue keeps its jump.
      if (Date.now() >= swimUpUntil) bot.setControlState('jump', false)
    }
  }
  if (route && routeEnd(route)) return false
  await new Promise(r => setTimeout(r, 250))   // let physics settle (land + shed momentum), then verify
  const p = bot.entity.position.floored()
  return (p.x === target.x && p.z === target.z && Math.abs(p.y - target.y) <= 1)
}

// "you gotta commit that one straight ahead block walk before turning when going through." The pathfinder cuts doorways diagonally and clips the jamb.
// Null when it found no door or was cut off, else the door and whether the body got through, with why not.
async function doorwayCommit (route = null) {
  const cut = () => (route ? routeEnd(route) : bunker.building)
  if (cut()) return null
  const me = bot.entity.position.floored()
  // nearest door/gate within ~3.5 — check the walk plane and one up (upper door half)
  const ids = Object.values(mcData.blocksByName)
    .filter(b => /(_door|_fence_gate)$/.test(b.name) && b.name !== 'iron_door').map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: 4, count: 8 })
    .map(p => bot.blockAt(p)).filter(Boolean)
    .filter(b => { const h = (b.getProperties() || {}).half; return h !== 'upper' })  // feet cell only
    .filter(b => cellKnown(b.position))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  if (!found) return null
  const D = found.position
  const props = found.getProperties() || {}
  // A cell the bot has not seen counts as blocked.
  const walkable = (dx, dz) => [0, 1].every(dy => {
    const p = D.offset(dx, dy, dz)
    const b = bot.blockAt(p)
    return !!b && cellKnown(p) && b.boundingBox === 'empty'
  })
  const { axis, side } = doorCrossing(props, D, bot.entity.position, walkable)
  const nearC = D.offset(side[0], 0, side[1]), farC = D.offset(-side[0], 0, -side[1])
  const from = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' }[side.join()]
  console.log(`[doorway] commit via ${found.name} at ${D} facing=${props.facing} half=${props.half} hinge=${props.hinge} open=${props.open} axis=${axis} near=${nearC} far=${farC}`)
  const door = { name: found.name, x: D.x, y: D.y, z: D.z }
  const failed = (why) => { console.log(`[doorway] ${found.name} ${why}`); return { door, through: false, why } }
  const across = () => { const b = bot.blockAt(D); return !!b && isDoor(b.name) && panelAcross(b.name, b.getProperties() || {}, axis) }
  const toggle = async () => {
    try { await bot.activateBlock(bot.blockAt(D)) } catch (e) { console.log('[doorway] activate failed: ' + e.message) }
    await bot.waitForTicks(3)
  }
  const TRIES = 2
  for (let tries = 1; tries <= TRIES; tries++) {
    const p0 = bot.entity.position.floored()
    if (p0.x !== nearC.x || p0.z !== nearC.z) {
      const goal = new goals.GoalBlock(nearC.x, nearC.y, nearC.z)
      const how = route ? await walkOnce(goal, route, 4500) : await walkAttempt(bot, goal, { stallMs: 4500, thinkTimeout: bot.pathfinder.thinkTimeout })
      if (cut() || how === 'changed') return null
      if (bot.pathfinder.goal === goal) stopPath()
      const p = bot.entity.position.floored()
      if (p.x !== nearC.x || p.z !== nearC.z) return failed(`could not be reached on its ${from} side (${how})`)
    }
    if (cut()) return null
    // The server and this client can disagree on whether the door is open.
    if (tries > 1) await toggle()
    if (across()) await toggle()
    console.log(`[doorway] panel across=${across()} shapes=${JSON.stringify((bot.blockAt(D) || {}).shapes)}`)
    if (across()) return failed('stayed shut')
    if (cut()) return null
    if (!await nudgeInto(D, false, 3000, route)) {
      if (cut()) return null
      console.log(`[doorway] stuck entering the threshold, try ${tries}`)
      continue
    }
    if (cut()) return null
    if (!await nudgeInto(farC, false, 3000, route)) {
      if (cut()) return null
      console.log(`[doorway] crossed the door cell but not beyond, try ${tries}`)
      continue
    }
    console.log('[doorway] through clean')
    return { door, through: true }
  }
  return failed(`did not let me through from the ${from} after ${TRIES} tries`)
}

// Fills cell with a carried filler block from where the body stands. Null once it is solid, else why not.
async function fillFrom (cell) {
  const r = await macroPlaceAt(Vec3, cell.x, cell.y, cell.z, fillers().map(i => i.name), false)
  if (r.done) return null
  if (r.noItem) return 'no filler blocks carried'
  return r.error ? `the block did not place (${r.error})` : 'nothing solid beside it to place against'
}

// GET /dig_tunnel?dir=&length=&torch= : EXPLORE-TO-FIND mining. Drives a 1-wide x 2-high
// corridor from where the bot stands — digs the wall directly AHEAD, steps in, repeats. This
// is the HONEST way to mine into rock: it discovers ore by exposing it, and never routes to a
// buried vein (no x-ray). Grabs ore laid bare in the corridor walls as it passes, lights the
// path with torches, and STOPS on lava/water/bedrock/floor-gap/full-inventory. Fairness floor
// intact — it only ever digs where it stands, one block at a time, seeing what a miner sees.
app.get('/dig_tunnel', async (req, res) => {
  try {
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    const Vec3 = require('vec3').Vec3
    const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
    let dx, dz
    const dirParam = (req.query.dir || '').toLowerCase()
    if (DIRS[dirParam]) { [dx, dz] = DIRS[dirParam] }
    else {                              // derive a cardinal from facing (mc: facing = (-sin yaw, cos yaw))
      const yaw = bot.entity.yaw, sx = -Math.sin(yaw), cz = Math.cos(yaw)
      if (Math.abs(sx) >= Math.abs(cz)) { dx = Math.sign(sx) || 1; dz = 0 } else { dx = 0; dz = Math.sign(cz) || 1 }
    }
    const length = Math.min(Math.max(1, parseInt(req.query.length || '12')), 64)
    const torchEvery = req.query.torch != null ? parseInt(req.query.torch) : 5   // 0 disables torches
    const perp = dx !== 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]]                 // wall offsets across the travel axis
    const dirName = dirParam || (dx ? (dx > 0 ? 'e' : 'w') : (dz > 0 ? 's' : 'n'))

    const { id } = jobs.start(`dig_tunnel ${dirName} x${length}`, async (job) => {
      let dug = 0, stop = null
      const found = {}
      const note = (n, p) => { found[n] = (found[n] || 0) + 1; emitEvent('mine', `struck ${n} @ ${p.x},${p.y},${p.z}`) }
      const isHazard = (b) => b && (b.name.includes('lava') || b.name.includes('water'))
      // tier-aware (07-12). A bunker build that began meanwhile ends the job before the dig that follows.
      const equipPick = async (b) => { refuseWhileBuilding(); await equipPickFor(b && b.name); refuseWhileBuilding() }

      for (let step = 0; step < length && !stop; step++) {
        if (job.cancelled) { stop = 'cancelled'; break }
        const base = bot.entity.position.floored()
        const ahead = base.offset(dx, 0, dz), aheadHead = ahead.offset(0, 1, 0), aheadFloor = ahead.offset(0, -1, 0)
        // SAFETY: refuse to breach lava/water — scan what digging ahead would expose
        for (const p of [ahead.offset(dx, 0, dz), aheadHead.offset(dx, 0, dz), aheadFloor, aheadHead.offset(0, 1, 0)]) {
          const hb = bot.blockAt(p); if (isHazard(hb)) { stop = `${hb.name} ahead — stopping short of it`; break }
        }
        if (stop) break
        await equipPick()
        for (const p of [aheadHead, ahead]) {                 // dig head then feet
          const b = bot.blockAt(p)
          if (!b || b.name === 'air') continue
          if (b.name === 'bedrock') { stop = 'hit bedrock'; break }
          if (b.name.includes('ore')) note(b.name, p)
          await equipPick(b)
          try { await bot.dig(b); dug++ } catch (e) { stop = 'dig failed: ' + e.message.slice(0, 30); break }
        }
        if (stop) break
        const fb = bot.blockAt(aheadFloor)                    // keep a solid floor so we don't fall / breach a drop
        if (!fb || fb.boundingBox !== 'block') {
          if (isHazard(fb)) { stop = `${fb.name} below — stopping`; break }
          const why = await fillFrom(aheadFloor)
          if (why) { stop = `gap in floor, ${why}`; break }
          await equipPick()
        }
        if (!(await nudgeInto(ahead, false))) { stop = 'cannot advance: nudge stalled'; break }
        const here = bot.entity.position.floored()            // grab ore now exposed in the corridor walls (adjacent, fair)
        for (const [ox, oz] of perp) for (const oy of [0, 1]) {
          const wb = bot.blockAt(here.offset(ox, oy, oz))
          if (wb && wb.name.includes('ore')) { note(wb.name, here.offset(ox, oy, oz)); await equipPick(wb); try { await bot.dig(wb); dug++ } catch (e) {} }
        }
        if (torchEvery > 0 && step % torchEvery === 0) { await macroPlaceAt(Vec3, here.x - dx, here.y, here.z - dz, ['torch'], false); await equipPick() }
        if (bot.inventory.emptySlotCount() === 0) { stop = 'inventory full'; break }
        job.progress(`step ${step + 1}/${length}, dug ${dug}, ores ${JSON.stringify(found)}`)
      }
      const stopped = stop || 'length reached'
      emitEvent('mine', `tunnel done: dug ${dug}, stopped=${stopped}, ores=${JSON.stringify(found)}`)
      return { dug, stopped, found }
    })
    ok(res, { job: id })
  } catch (e) { err(res, e) }
})

// GET /dig_stair?dir=&up=&steps=&torch= : mine an ASCENDING (up=1, default) or descending (up=-1)
// staircase — the fair way to climb out of a deep cave without swimming a water elevator. Each
// step digs the 2-high (3 for headroom going up) passage at the next diagonal position and steps
// onto it. STOPS on any water/lava it would expose (never breach a flood) or gravel/sand (would
// bury me); places a tread from andesite/cobble/dirt if the step is missing; torches the climb.
app.get('/dig_stair', async (req, res) => {
  try {
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    const Vec3 = require('vec3').Vec3
    const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
    let dx, dz
    const dirParam = (req.query.dir || '').toLowerCase()
    if (DIRS[dirParam]) { [dx, dz] = DIRS[dirParam] }
    else { const yaw = bot.entity.yaw, sx = -Math.sin(yaw), cz = Math.cos(yaw); if (Math.abs(sx) >= Math.abs(cz)) { dx = Math.sign(sx) || 1; dz = 0 } else { dx = 0; dz = Math.sign(cz) || 1 } }
    const up = parseInt(req.query.up || '1') >= 1 ? 1 : -1  // up=0 means DOWN (a pilot burned a staircase on `0 >= 0`)
    const steps = Math.min(Math.max(1, parseInt(req.query.steps || '24')), 96)
    const torchEvery = req.query.torch != null ? parseInt(req.query.torch) : 4
    const dirName = dirParam || (dx ? (dx > 0 ? 'e' : 'w') : (dz > 0 ? 's' : 'n'))

    const { id } = jobs.start(`dig_stair ${up > 0 ? 'up' : 'down'} ${dirName} x${steps}`, async (job) => {
      let dug = 0, stop = null, climbed = 0
      const isHazard = (b) => b && (b.name.includes('lava') || b.name.includes('water'))
      const fally = (b) => b && (b.name === 'gravel' || b.name === 'sand' || b.name === 'red_sand')
      // tier-aware (07-12). A bunker build that began meanwhile ends the job before the dig that follows.
      const equipPick = async (b) => { refuseWhileBuilding(); await equipPickFor(b && b.name); refuseWhileBuilding() }
      // (per-step movement uses the shared module-scope nudgeInto — see above the /dig_tunnel route)
      for (let s = 0; s < steps && !stop; s++) {
        if (job.cancelled) { stop = 'cancelled'; break }
        const b0 = bot.entity.position.floored()
        const nx = b0.x + dx, nz = b0.z + dz, ny = b0.y + up
        const tread = new Vec3(nx, ny - 1, nz), feet = new Vec3(nx, ny, nz), head = new Vec3(nx, ny + 1, nz), above = new Vec3(nx, ny + 2, nz)
        // ASCENDING needs LAUNCH clearance too: the climb-nudge jumps from the CURRENT cell, so the
        // block above my own head must be open or the jump hits it and the nudge stalls (the 07-11
        // "cannot climb: nudge stalled under a low ceiling" bug).
        const launch = up > 0 ? [new Vec3(b0.x, b0.y + 2, b0.z)] : []
        // SAFETY: refuse to breach lava/water or dig under fall-blocks — scan what we'd expose
        for (const p of [...launch, feet, head, above, new Vec3(nx + dx, ny, nz + dz), new Vec3(nx + dx, ny + 1, nz + dz)]) {
          const hb = bot.blockAt(p)
          if (isHazard(hb)) { stop = `${hb.name} ahead — stopping short`; break }
          if (fally(hb)) { stop = `${hb.name} overhead — stopping (would bury me)`; break }
        }
        if (stop) break
        await equipPick()
        for (const p of [...launch, above, head, feet]) {   // clear the FULL 2-tall passage + head clearance.
          // Descending needs `above` (nx,ny+2) dug too: the bot is 2 blocks tall, so stepping into
          // the next-lower cell its head sweeps through ny+2 — leave that solid and it's walled in
          // at head height and can't move in (the real cause of the old descend stall).
          const bb = bot.blockAt(p)
          if (!bb || bb.name === 'air') continue
          if (bb.name === 'bedrock') { stop = 'hit bedrock'; break }
          await equipPick(bb)
          try { await bot.dig(bb); dug++ } catch (e) { stop = 'dig failed: ' + e.message.slice(0, 26); break }
        }
        if (stop) break
        const tb = bot.blockAt(tread)                                      // need a tread to stand on
        if (!tb || tb.boundingBox !== 'block') {
          if (isHazard(tb)) { stop = `${tb.name} at the step — stopping`; break }
          const why = await fillFrom(tread)
          if (why) { stop = `no step to stand on, ${why}`; break }
          await equipPick()
        }
        if (!(await nudgeInto(feet, up > 0))) { stop = (up > 0 ? 'cannot climb' : 'cannot descend') + ': nudge stalled at ' + Math.floor(bot.entity.position.y); break }
        climbed += up
        if (torchEvery > 0 && s % torchEvery === 0) { await macroPlaceAt(Vec3, b0.x, b0.y, b0.z, ['torch'], false); await equipPick() }
        if (bot.inventory.emptySlotCount() === 0) { stop = 'inventory full'; break }
        const y = Math.floor(bot.entity.position.y)
        job.progress(`step ${s + 1}/${steps}, y=${y}, dug ${dug}`)
        if (up > 0 && y >= 68) { stop = 'reached surface level'; break }
      }
      const stopped = stop || 'steps done'
      emitEvent('mine', `dig_stair ${up > 0 ? 'up' : 'down'} done: climbed ${climbed}, dug ${dug}, y=${Math.floor(bot.entity.position.y)}, stopped=${stopped}`)
      return { climbed, dug, stopped, endY: Math.floor(bot.entity.position.y) }
    })
    ok(res, { job: id })
  } catch (e) { err(res, e) }
})

// GET /build?template=cabin&x=&z=&w=&d=&h= : background job raising a full structure --
// cobble/plank base perimeter -> plank walls to height h (default 3) -> 2-high doorway
// centered on the west (-x) side -> a SOLID roof placed outer-ring-first (so each interior
// roof cell has an already-placed neighbor to build against). Reuses the /outline,/walls,
// /roof placement approach. Pulls from inventory; skips cells already solid.
app.get('/build', (req, res) => {
  try {
    const template = req.query.template || 'cabin'
    if (template !== 'cabin') return err(res, new Error(`unknown template: ${template} (only 'cabin')`))
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    if (!Number.isFinite(x0) || !Number.isFinite(z0)) return err(res, new Error('x and z required'))
    const w = Math.max(3, parseInt(req.query.w || '7'))
    const d = Math.max(3, parseInt(req.query.d || '7'))
    const h = Math.max(2, parseInt(req.query.h || '3'))
    const base = Math.floor(parseFloat(req.query.base || bot.entity.position.y))
    const baseMat = req.query.base_name || 'cobblestone'
    const wallMat = req.query.name || 'oak_planks'

    // west doorway centered on the -x wall (matches /walls door='west')
    const doorCell = [x0, z0 + Math.floor(d / 2)]
    const isDoor = (x, z) => x === doorCell[0] && z === doorCell[1]

    const { id } = jobs.start(`build ${template} ${w}x${d}h${h} @${x0},${z0}`, async (job) => {
      const Vec3 = require('vec3').Vec3
      const stats = { foundation: 0, walls: 0, roof: 0, skipped: 0, failed: 0 }
      const perim = []
      for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
        if (i === 0 || i === w - 1 || j === 0 || j === d - 1) perim.push([x0 + i, z0 + j])
      }

      // ---- foundation: base-material perimeter at y=base ----
      job.progress('phase: foundation')
      for (const [x, z] of perim) {
        if (job.cancelled) break
        if (isDoor(x, z)) continue                 // leave the doorway cell open (no place-then-dig churn)
        const r = await macroPlaceAt(Vec3, x, base, z, [baseMat, wallMat])
        if (r.placed) stats.foundation++
        else if (r.skipped) stats.skipped++
        else stats.failed++
      }
      emitEvent('build', `foundation done (${stats.foundation})`, { x: x0, z: z0 })

      // ---- walls: perimeter columns base+1..base+h-1, leaving the doorway open ----
      job.progress('phase: walls')
      for (const [x, z] of perim) {
        if (job.cancelled) break
        for (let k = 1; k < h; k++) {
          if (isDoor(x, z) && k < 2) { continue }  // 2-high doorway (rows k=0 base & k=1)
          const r = await macroPlaceAt(Vec3, x, base + k, z, [wallMat, baseMat])
          if (r.placed) stats.walls++
          else if (r.skipped) stats.skipped++
          else stats.failed++
        }
      }

      // ---- door: guarantee the 2-high doorway span (base..base+1) is clear ----
      job.progress('phase: door')
      for (let k = 0; k < 2; k++) {
        const dp = new Vec3(doorCell[0], base + k, doorCell[1])
        const db = bot.blockAt(dp)
        if (db && db.name !== 'air' && db.boundingBox === 'block') {
          try { await bot.pathfinder.goto(new goals.GoalNear(dp.x, dp.y, dp.z, 3)); await bot.dig(db) } catch (e) {}
        }
      }

      // ---- roof: solid slab at y=base+h, outer-ring-first (neighbor to build against) ----
      job.progress('phase: roof')
      const roofCells = []
      for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
        roofCells.push([x0 + i, z0 + j, Math.min(i, j, w - 1 - i, d - 1 - j)])
      }
      roofCells.sort((a, b) => a[2] - b[2])       // outer rings first
      for (const [x, z] of roofCells) {
        if (job.cancelled) break
        const r = await macroPlaceAt(Vec3, x, base + h, z, [wallMat, baseMat])
        if (r.placed) stats.roof++
        else if (r.skipped) stats.skipped++
        else stats.failed++
      }

      emitEvent('build', `cabin complete f=${stats.foundation} w=${stats.walls} r=${stats.roof}`, stats)
      return { template, size: `${w}x${d}`, height: h, corner: { x: x0, z: z0 }, ...stats }
    })
    ok(res, { job: id })
  } catch (e) { err(res, e) }
})

// GET /enchant?item=&slot= : walk to the nearest enchanting table and enchant. The pilot's
// query→act→verify grammar in one verb: WITHOUT slot it puts the item + lapis in, reads the
// three offers (level cost, lapis cost, enchant name when resolvable), takes everything back
// out, and reports — the LOOK. WITH slot=0|1|2 it commits that offer (consumes 1-3 lapis and
// 1-3 of MY levels; needs my level ≥ the shown cost). Lapis must be in my pockets — the table
// window keeps nothing between opens. (Forged 07-20, the day the body learned to enchant.)
app.get('/enchant', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const itemName = req.query.item
    const slot = req.query.slot === undefined ? null : parseInt(req.query.slot)
    if (!itemName) return err(res, new Error('item required'))
    const tb = bot.findBlock({ matching: resolveBlockIds('enchanting_table'), maxDistance: 16 })
    if (!tb) return err(res, new Error('no enchanting table within 16'))
    await bot.pathfinder.goto(new goals.GoalNear(tb.position.x, tb.position.y, tb.position.z, 2))
    const item = bot.inventory.items().find(i => i.name === itemName)
    if (!item) return err(res, new Error(`no ${itemName} in pockets`))
    const lapis = bot.inventory.items().find(i => i.name === 'lapis_lazuli')
    if (!lapis) return err(res, new Error('no lapis_lazuli in pockets — the table burns 1-3 per enchant'))
    const table = await bot.openEnchantmentTable(tb)
    const propTap = (p) => console.log(`[enchant] prop packet: windowId=${p.windowId} property=${p.property} value=${p.value}`)
    bot._client.on('craft_progress_bar', propTap)
    try {
      // find both WITHIN the open window — slot ids remap once a window opens, so the
      // bot.inventory handles located above would point moveSlotItem at the wrong cells
      const wItem = table.slots.find(s => s && s.name === itemName && s.slot >= 2)
      const wLapis = table.slots.find(s => s && s.name === 'lapis_lazuli' && s.slot >= 2)
      if (!wItem) throw new Error(`${itemName} not visible in the table window`)
      if (!wLapis) throw new Error('lapis not visible in the table window')
      await table.putTargetItem(wItem)
      await table.putLapis(wLapis)
      // 1.21 quirk: the plugin's 'ready' event NEVER fires (it compares "expected" property
      // packets against "actual" ones modern servers no longer send) — poll the offers array
      // directly instead; the data itself arrives fine.
      const offersUp = () => (table.enchantments || []).some(e => e.level > 0)
      const offerDeadline = Date.now() + 6000
      while (!offersUp() && Date.now() < offerDeadline) await new Promise(r => setTimeout(r, 250))
      if (!offersUp()) {
        console.log(`[enchant] TIMEOUT diag: slot0=${JSON.stringify(table.slots[0] && table.slots[0].name)} slot1=${JSON.stringify(table.slots[1] && table.slots[1].name)} enchs=${JSON.stringify(table.enchantments)}`)
        throw new Error('offers never arrived — see [enchant] diag in log')
      }
      const enchName = (id) => {
        const e = (mcData.enchantmentsArray || []).find(x => x.id === id)
        return e ? e.name : (id === -1 ? '?' : `#${id}`)
      }
      const offers = (table.enchantments || []).map((e, i) => (
        { slot: i, levelCost: e.level, lapisCost: i + 1, enchant: enchName(e.expected ? e.expected.enchant : -1) }))
      const myLevel = bot.experience.level
      if (slot === null) {
        emitEvent('enchant', `offers for ${itemName}: ${offers.map(o => `#${o.slot} lv${o.levelCost} ${o.enchant}`).join(' | ')} (me: lv${myLevel})`)
        ok(res, { offers, myLevel, lapisHeld: lapis.count, note: 'call again with slot=0|1|2 to commit' })
      } else {
        const chosen = offers[slot]
        if (!chosen || chosen.levelCost < 0) throw new Error(`slot ${slot} holds no offer`)
        if (myLevel < chosen.levelCost) throw new Error(`offer needs level ${chosen.levelCost}, I am ${myLevel}`)
        if (lapis.count < chosen.lapisCost) throw new Error(`offer needs ${chosen.lapisCost} lapis, I hold ${lapis.count}`)
        // commit with a direct packet — table.enchant() awaits the same dead 'ready' event
        bot._client.write('enchant_item', { windowId: table.id, enchantment: slot })
        await new Promise(r => setTimeout(r, 1000))   // let the server apply + resync slot 0
        const result = table.slots[0]
        emitEvent('enchant', `${itemName} enchanted: ${chosen.enchant} (slot ${slot}, lv${chosen.levelCost}) — now lv${bot.experience.level}`)
        ok(res, { enchanted: itemName, offer: chosen, myLevelNow: bot.experience.level, resultNbt: !!(result && result.nbt) })
      }
    } finally {
      try { bot._client.removeListener('craft_progress_bar', propTap) } catch (e) {}
      try { if (table.targetItem()) await table.takeTargetItem() } catch (e) {}
      try { const l = table.slots[1]; if (l) await bot.putAway(l.slot) } catch (e) {}
      try { table.close() } catch (e) {}
    }
  } catch (e) { err(res, e) }
})

// GET /rename?item=&name= : walk to the nearest anvil and christen an item. Costs 1 of MY
// levels (the anvil's rename fee) and wears the anvil a step; name caps at 35 chars. The
// mineflayer plugin streams the name a character at a time like a vanilla client typing.
// (Forged 07-21, the day the blades got names — Occam was first.)
app.get('/rename', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const itemName = req.query.item
    const newName = req.query.name
    if (!itemName || !newName) return err(res, new Error('item and name required'))
    // exact-match resolve skips the damaged variants — an anvil is an anvil, gather all three
    const anvilIds = ['anvil', 'chipped_anvil', 'damaged_anvil'].flatMap(n => resolveBlockIds(n))
    const ab = bot.findBlock({ matching: anvilIds, maxDistance: 16 })
    if (!ab) return err(res, new Error('no anvil within 16'))
    await bot.pathfinder.goto(new goals.GoalNear(ab.position.x, ab.position.y, ab.position.z, 2))
    const item = bot.inventory.items().find(i => i.name === itemName)
    if (!item) return err(res, new Error(`no ${itemName} in pockets`))
    const anvil = await bot.openAnvil(ab)
    try {
      await anvil.rename(item, newName)
      emitEvent('rename', `${itemName} christened "${newName}" — now lv${bot.experience.level}`)
      ok(res, { renamed: itemName, name: newName, myLevelNow: bot.experience.level })
    } finally {
      try { anvil.close() } catch (e) {}
    }
  } catch (e) { err(res, e) }
})

function targetFurnace (q) {
  if (q.at == null) return bot.findBlock({ matching: resolveBlockIds('furnace'), maxDistance: 8 })
  const [x, y, z] = String(q.at).split(',').map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('at takes x,y,z')
  const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
  if (!b || b.name !== 'furnace') throw new Error(`no furnace at ${q.at} (${b ? b.name : 'unloaded'})`)
  return b
}

function furnaceSlots (furnace) {
  const text = (i) => i ? `${i.count} ${i.name}` : null
  return { input: text(furnace.inputItem()), fuel: text(furnace.fuelItem()), output: text(furnace.outputItem()) }
}

function pocketRoom (window, item) {
  const partial = window.items().filter(i => i.type === item.type).reduce((s, i) => s + i.stackSize - i.count, 0)
  return window.emptySlotCount() * item.stackSize + partial
}

async function takeSlot (furnace, item, n) {
  await bot.transfer({ window: furnace, itemType: item.type, metadata: null, count: n,
    sourceStart: item.slot, sourceEnd: item.slot + 1, destStart: furnace.inventoryStart, destEnd: furnace.inventoryEnd })
}

// GET /smelt?item=&fuel=&count= : loads the nearest furnace and returns without waiting for the burn.
app.get('/smelt', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const inputName = req.query.item
    const fuelName = req.query.fuel || 'coal'
    const want = Math.max(1, parseInt(req.query.count || '1'))
    if (!inputName) return err(res, new Error('item required'))
    const fb = bot.findBlock({ matching: resolveBlockIds('furnace'), maxDistance: 8 })
    if (!fb) return err(res, new Error('no furnace within 8'))
    await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
    const furnace = await bot.openFurnace(fb)
    try {
      const step = (what) => console.log(`[smelt] ${what} ${JSON.stringify(furnaceSlots(furnace))}`)
      step('opened')
      const pocketCount = (name) => furnace.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0)
      const inItem = furnace.items().find(i => i.name === inputName)
      if (!inItem) throw new Error(`no ${inputName} to smelt`)
      const curIn = furnace.inputItem()
      if (curIn && curIn.name !== inputName) throw new Error(`the furnace is busy with ${curIn.count} ${curIn.name}`)
      const n = Math.min(want, pocketCount(inputName), inItem.stackSize - (curIn ? curIn.count : 0))
      if (n < 1) throw new Error(`the furnace input is full with ${curIn.count} ${curIn.name}`)
      const fuelIn = furnace.fuelItem()
      if (!fuelIn && !pocketCount(fuelName)) throw new Error(`no ${fuelName} for fuel`)
      let took, note
      const out = furnace.outputItem()
      if (out && out.name === smeltYield(inputName) && pocketRoom(furnace, out) >= out.count) {
        await takeSlot(furnace, out, out.count)
        took = `${out.count} ${out.name}`
        step('took output')
      } else if (out) {
        note = `left ${out.count} ${out.name} in the output`
      }
      await furnace.putInput(inItem.type, null, n)
      step('loaded input')
      const total = (curIn ? curIn.count : 0) + n
      // A fuel slot holding another item is used as it is.
      if (!fuelIn || fuelIn.name === fuelName) {
        // Items smelted per fuel item: 8 for coal and charcoal, 1.5 for wood.
        const per = /coal/.test(fuelName) ? 8 : /planks|log|_wood|bamboo|stick/.test(fuelName) ? 1.5 : 8
        const add = Math.min(pocketCount(fuelName), Math.ceil(total / per) - (fuelIn ? fuelIn.count : 0))
        if (add > 0) {
          await furnace.putFuel(furnace.items().find(i => i.name === fuelName).type, null, add)
          step('loaded fuel')
        }
      }
      // A furnace smelts one item every 10 s.
      ok(res, { at: round(fb.position), loaded: n, ...furnaceSlots(furnace), took, note, doneInSec: total * 10 })
    } finally {
      furnace.close()
    }
  } catch (e) { err(res, e) }
})

// GET /furnace?at=&take=&count= : lists a furnace's slots, or takes one slot into the pockets.
app.get('/furnace', async (req, res) => {
  try {
    if (!ready) return err(res, new Error('not ready'))
    const take = req.query.take
    if (take != null && !['input', 'fuel', 'output'].includes(take)) return err(res, new Error('take is input, fuel or output'))
    const fb = targetFurnace(req.query)
    if (!fb) return err(res, new Error('no furnace within 8'))
    await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
    const furnace = await bot.openFurnace(fb)
    try {
      if (take == null) {
        // mineflayer reads a bar as 0 until a value arrives after its total.
        await bot.waitForTicks(2)
        const share = (v) => typeof v === 'number' ? Math.round(v * 100) / 100 : undefined
        return ok(res, { at: round(fb.position), ...furnaceSlots(furnace), progress: share(furnace.progress), fuelLeft: share(furnace.fuel) })
      }
      const item = { input: furnace.inputItem(), fuel: furnace.fuelItem(), output: furnace.outputItem() }[take]
      if (!item) throw new Error(`the ${take} slot is empty`)
      // The output slot accepts no items back.
      const n = take === 'output' ? item.count : Math.min(parseInt(req.query.count || item.count), item.count)
      if (pocketRoom(furnace, item) < n) throw new Error(`no room in your pockets for ${n} ${item.name}`)
      await takeSlot(furnace, item, n)
      console.log(`[furnace] took ${n} ${item.name} ${JSON.stringify(furnaceSlots(furnace))}`)
      ok(res, { at: round(fb.position), took: `${n} ${item.name}`, ...furnaceSlots(furnace) })
    } finally {
      furnace.close()
    }
  } catch (e) { err(res, e) }
})

app.listen(CTRL_PORT, '127.0.0.1', (e) => {
  if (e) {
    console.error(`[bot] control API cannot listen on 127.0.0.1:${CTRL_PORT}: ${e.message}`)
    process.exit(1)
  }
  console.log(`[bot] control API on http://127.0.0.1:${CTRL_PORT}`)
})
