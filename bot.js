// Golem — a Mineflayer body for language-model pilots
// Doing-layer: structured perception + actions over a tiny HTTP API (drive with curl).
const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const armorManager = require('mineflayer-armor-manager')
const express = require('express')
const fs = require('fs')
const { Vec3 } = require('vec3')
const { installSecurity, chatMaxLen, BUNKER_MODES } = require('./lib/install')
const { entityInCell, bunkerSummary } = require('./lib/shelter')
const { STRIKE_SWING_MS, STRIKE_APPROACH_MS, strikeBudgetMs, JUMP_FALL_TICKS, HOLD_MAX_S } = require('./lib/pace')
const { isDoor } = require('./lib/doors')
const { stepView } = require('./lib/steps')
const { countVerbs } = require('./lib/verbs')
const { GRAVESTONE, overrideRecipes, craftable } = require('./lib/server-overrides')
const { smeltYield, burnItems, COOK_PROBE_TICKS } = require('./lib/furnace')
const { takenText } = require('./lib/legs')

// The HMAC key that signs every control API request and response.
const GOLEM_TOKEN = process.env.GOLEM_TOKEN || ''
if (GOLEM_TOKEN.length < 32) {
  console.error('[bot] GOLEM_TOKEN is missing or shorter than 32 characters, refusing to start')
  process.exit(1)
}
const { HOST, PORT, VERSION, USERNAME, CTRL_PORT, LEGACY_1710, LEGACY_HIT_MS, SERVER_RECIPES } = require('./lib/bot/config')
const { createContext } = require('./lib/context')
const { createStreams, bindStreams, wireChatCapture, wireServerMessages } = require('./lib/bot/streams')
const { createItems, bindItems } = require('./lib/bot/items')
const { createSight, bindSight, wireLightChanges, wireLightReload, wireSightMemoDrops, wireGroundTopForget, wireSkyInSightReset } = require('./lib/bot/sight')
const { createDescribe, bindDescribe, wireIndoorsReset } = require('./lib/bot/describe')
const { createLane, bindLane } = require('./lib/bot/lane')
const { createMemory, bindMemory, wireSeenWorld, wireSeenSave } = require('./lib/bot/memory')
const { createReflexes, bindReflexes } = require('./lib/bot/reflexes')
const { createLegs, bindLegs, wirePlanKnownReset, wireGateManners, wireLivePath, wirePathfinderTicks, wirePathLog } = require('./lib/bot/legs')
const { createJobBoard, bindJobBoard } = require('./lib/bot/jobs')
const { createFollow, bindFollow } = require('./lib/bot/follow')
const { createAwareness, bindAwareness, wireStaleEntities, wireCrumbRecording, wireCrumbForget, wirePresenceTick } = require('./lib/bot/awareness')
const { createUnstuck, bindUnstuck } = require('./lib/bot/unstuck')
const { createPlacing, bindPlacing } = require('./lib/bot/placing')
const { createWatchReflexes, bindWatchReflexes } = require('./lib/bot/watch-reflexes')
const { createBunkerCells, bindBunkerCells } = require('./lib/bot/bunker-cells')
const { createBunkerBuild, bindBunkerBuild } = require('./lib/bot/bunker-build')
const { createCombat, bindCombat, wireGuardDrop, wireItemUseCosts, wireArmSwings, wireArrowTracking, wireDamageAttribution, wireFloodDrops, wireMobHurt } = require('./lib/bot/combat')
const { createBunker, bindBunker, wireThreatReset } = require('./lib/bot/bunker')
const { createSenses, bindSenses, wireSoundTablePin, wireHearing, wireOwnEditStamps, wireWorldChangeNotes, wireWorldChangeEvents, wireOreCallout } = require('./lib/bot/senses')
const { createAlarms, bindAlarms, wireWearAlarm, wirePocketAlarm, wireTrailMarks, wireBodyAlarms } = require('./lib/bot/alarms')
const { createConnection, bindConnection, wireConnectionSpawn, wireConnectionEvents, wireLookPaceGoto } = require('./lib/bot/connection')
const { createViewer, bindViewer } = require('./lib/bot/viewer')

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
function wireConnectionHardening () {
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
}

bot.loadPlugin(pathfinder)
bot.loadPlugin(collectBlock)
bot.loadPlugin(armorManager)   // auto-equip best armor (freebie for the survival ramp; no-op on Peaceful)
const ctx = createContext()
ctx.bot = bot
wireEarly()

const shared = {}
ctx.shared = shared
shared.mcData = null
shared.ready = false
createLegs(ctx)
const { navPlaced, collectSafely, collectLock, collectBusy, watchedWork, walkGaveUp, legs, safeStop, stopPath, walkRoute, namedStop, routeEnd, stagedGoto, gotoQuery, doorBeside, nudgeInto } = ctx
shared.considerateMoves = null    // default no-dig profile (protects builds + terrain)
shared.forestryMoves = null       // lumberjack profile: may break ONLY leaves+logs (built at spawn)

createViewer(ctx)
createConnection(ctx)

createStreams(ctx)
const { chatLog, streams, eventLog, emitEvent, pulseLog } = ctx

createDescribe(ctx)
const { round, HOSTILE_NAMES, OPENABLE, cellText, compass, yawToCompass, spatial3D, veinScan, waterState, glyphFor, overheadCover, skyPhrase, indoors, coverPhrase, terrainClass } = ctx

createItems(ctx)
const { resolveBlockIds, resolveItem, heldInfo, PICK_TIER, neededPickTier, equipPickFor, holdDigTool, FOOD_UPDATE_MS, safeFood, foodUpdate, holdHarvester } = ctx

createReflexes(ctx)
const { reflexes } = ctx

createUnstuck(ctx)
const { unstuckReflex, unstuckKnows, passable } = ctx

createWatchReflexes(ctx)
const { currentWatchReflex, narratorReflex, trekReflex, lavaWatchReflex } = ctx

createJobBoard(ctx)
const { deaths, jobs } = ctx

createMemory(ctx)
const { waypoints, memory, journal, SEEN, SURFACE, knownBlocks, nearestKnown, rememberedStation, arrivedStation } = ctx

// ---- MACROS subsystem helpers ----
// how far below the bot's feet we tolerate before refusing to dig down toward a target
const GATHER_MAX_DROP = 2
const GATHER_MAX_RISE = 4   // don't target logs more than ~4 above feet — out of dig-reach without
                            // climbing, so with canDig=false they just time out. Get the reachable trunk.

createPlacing(ctx)
const { isSoftCover, clearSoftCover, macroPlaceAt, placeSpot, reachToPlace, isInteractive, sneakPlace, passageAxis, occupant, fillFrom } = ctx

createSight(ctx)
const { lineCell, freshLight, seesLit, findVisible, nearestVisible, cellKnown, knownCell, outOfSight, bodyTouches, seenNow, ck, floodPassable, airFlood, showsNow, skyInSight, raySweep, entityPerceptible } = ctx
function wireLightPackets () {
  bot._client.on('update_light', (packet) => freshLight(packet.chunkX, packet.chunkZ))
}

// ==== VISION 2 (2026-07-11): the vertical sense, the air flood-fill, and the ray-sweep retina ====
// Two tiers of knowing, everywhere: seen (SEEN, or lit sight now) / unknown (silence means "didn't
// look", never "clear").

// ==== SECOND SENSES (2026-07-12, Fable) — ears, felt world-changes, body alarms, tool sense ====
// Design constraints set by the helmsman: my reaction time is long, so alarms exist ONLY for what's worth
// waking me, the bot FREEZES to buy me time, and everything else is a pull-only buffer. Aggregate
// aggressively — a village or a mob-filled cave must never become an event firehose.

createAlarms(ctx)

createSenses(ctx)
const { HEARD, hearSummary, stampOwnEdit } = ctx

const fight = {}
ctx.fight = fight
fight.lastAttrib = null            // set by the damage_event wire; read by the hurt handler above

createCombat(ctx)
const { STANCES, drawAndLoose, guardState, legsMoving, mobClass, perched, inChokepoint, meleeAim, inMeleeReach, meleeThreat, disengageHp, creeperRoute, nearHostiles, combatReflex, fleeToPlayerReflex, mobHurt, sprintBlock, meleeSwing, chargedSwing } = ctx
fight.stance = 'guard'
fight.threatDebugUntil = 0                   // /threatdebug window: score players, narrate only
fight.lastHit = { dmg: 0, t: 0 }             // last hit taken (size + when) — scales the disengage tripwire while FRESH
fight.lastAttackT = 0                        // when the bot last attacked
// The damage type names by registry id, from the registry the server sends before spawn. Via sends
// generic as 16.
fight.damageTypes = []
function wireDamageTypes () {
  bot._client.on('registry_data', (packet) => {
    try {
      if (/^(minecraft:)?damage_type$/.test(packet.id)) fight.damageTypes = packet.entries.map(e => e.key.replace(/^minecraft:/, ''))
    } catch (e) { console.log('[combat] damage type registry unreadable: ' + e.message) }
  })
}
// Resolves once a sourceless hit beside a player or with an arrow in flight has its attribution.
fight.swingWait = null
createLane(ctx)
const { pilotLane, holdRun, strikeRun, claimLane, releaseLane, clearLane, bunker, BUNKER_WALK, refuseWhileBuilding, perch } = ctx

createBunker(ctx)
const { bunkerReflex, buildBunker } = ctx
installReflexes()
// (the /threatdebug route lives with the other routes below — `app` doesn't exist yet up here,
// learned via a TDZ crashloop the moment this block first loaded)

function wireWorldSeed () {
  for (const name of ['login', 'respawn']) {
    bot._client.on(name, (packet) => {
      const seed = (packet.worldState || packet).hashedSeed
      memory.worldSeed = seed == null ? '' : String(seed)
    })
  }
}

// ---- HTTP control layer ----
const app = express()
installSecurity(app, { token: GOLEM_TOKEN, port: CTRL_PORT, chat: { send: (text) => bot.chat(text), maxLen: chatMaxLen(process.env.GOLEM_CHAT_MAX) } })
// The pilot routes in flight, which follow waits out. A reply says when the body died while its route ran.
const verbs = countVerbs(app, deaths.watch)
ctx.verbs = verbs
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
const err = (res, e) => send(res, { ok: false, error: e.message || String(e), ...(e.reason && { reason: e.reason }) })

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
    if (!shared.ready) return err(res, new Error('not ready'))
    const chatSince = parseInt(req.query.chat || '0')
    const evSince = parseInt(req.query.ev || '0')
    const e = bot.entity
    const w = waterState(bot)
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

// GET /cursors: reads the cursors without marking chat read or events served.
app.get('/cursors', (req, res) => {
  ok(res, { boot: BOOT_ID, chat: chatLog.cursor, ev: streams.eventSeq, wakeEv: streams.wakeEv })
})

app.get('/state', (req, res) => {
  if (!shared.ready) return err(res, new Error('bot not spawned yet'))
  const e = bot.entity
  ok(res, {
    pos: round(e.position),
    yaw: +(bot.entity.yaw).toFixed(2), pitch: +(bot.entity.pitch).toFixed(2),
    health: bot.health, food: bot.food, oxygen: bot.oxygenLevel,
    xpLevel: bot.experience.level,   // enchanting currency — the table's offers cost levels
    ...(() => { const w = waterState(bot); return w ? { inWater: w.inWater, submerged: w.submerged, inCurrent: w.current, buried: w.buried } : {} })(),
    onGround: e.onGround, dimension: bot.game.dimension, gameMode: bot.game.gameMode,
    ...(skyInSight() ? { timeOfDay: bot.time.timeOfDay } : {}),
    held: heldInfo(),
    lookingAt: (() => { const b = bot.blockAtCursor(5); return b ? { name: b.name, pos: round(b.position) } : null })()
  })
})

app.get('/inventory', (req, res) => {
  if (!shared.ready) return err(res, new Error('not ready'))
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
    if (!shared.ready) return err(res, new Error('not ready'))
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

// The age of a crop block and whether it reached its last age, null for any other block.
function cropAge (b) {
  if (!b || !/^(wheat|carrots|potatoes|beetroots|nether_wart|melon_stem|pumpkin_stem|cocoa)$/.test(b.name)) return null
  const age = Number(b.getProperties().age)
  const ages = shared.mcData.blocks[b.type].states.find(s => s.name === 'age').num_values
  return { age, mature: age === ages - 1 }
}

app.get('/find', (req, res) => {
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
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
    const results = vis.map(v => {
      const b = bot.blockAt(v.pos)
      return Object.assign({ pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z }, name: b?.name, dist: +v.dist.toFixed(1) }, cropAge(b))
    })
    ok(res, { count: results.length, blocks: results, visibleOnly: true })
  } catch (e) { err(res, e) }
})

createAwareness(ctx)
const { liveEntities, playerEntity, playerSighting, nearestSeen, targetSeen, whereIs, entityLabel } = ctx
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
// first flock waiting). Walks into reach if needed; nearest matching entity in sight within 16.
app.get('/useon', async (req, res) => {
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
    const ename = req.query.name
    const iname = req.query.item
    const it = bot.inventory.items().find(i => i.name === iname)
    if (!it) return err(res, new Error(`no ${iname} in inventory`))
    const here = bot.entity.position
    const target = nearestSeen(ename, 16)
    if (!target) return err(res, new Error(`no ${ename} in sight within 16`))
    if (target.position.distanceTo(here) > 3) {
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2))
    }
    await bot.equip(it, 'hand')
    await bot.lookAt(target.position.offset(0, 0.6, 0), true)
    await bot.waitForTicks(2)
    if (!liveEntities().includes(target) || !targetSeen(target)) return ok(res, { used: null, on: ename, reason: 'lost sight', note: 'lost sight of it' })
    if (!inMeleeReach(target, 0.6)) return ok(res, { used: null, on: ename, note: 'target left reach' })
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
    if (!shared.ready) return err(res, new Error('not ready'))
    const ename = req.query.name
    if (!ename) return err(res, new Error('need name='))
    const iname = req.query.item || 'iron_sword'
    const it = bot.inventory.items().find(i => i.name === iname)
    if (!it) return err(res, new Error(`no ${iname} in inventory — refusing to punch with bare hands/wrong tool`))
    const target = nearestSeen(ename, 16)
    if (!target) return err(res, new Error(`no ${ename} in sight within 16`))
    if (target.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === target))) {
      return err(res, new Error('refusing: never strike players (friendly-fire tests wait for damage attribution)'))
    }
    if (/creeper/.test(String(target.name))) {
      return err(res, new Error('refusing: never melee a creeper — flee is the law'))
    }
    // ?max=N (07-21 latency session): bounded swing SEQUENCE in one round trip — re-acquire,
    // approach, swing, dead-watch, repeat. Exits honestly: dead / target gone / max / out of time.
    const max = Math.min(5, Math.max(1, parseInt(req.query.max || '1')))
    const deadline = Date.now() + strikeBudgetMs(max)
    lane = claimLane('strike', strikeBudgetMs(max))   // soft lane: the approach + swings are MINE (07-21)
    strikeRun.lane = lane
    // Walks within range of p. Gives up after STRIKE_APPROACH_MS, or once only reserve ms are left.
    const approach = (p, range, reserve) => {
      const ms = Math.max(0, Math.min(STRIKE_APPROACH_MS, deadline - reserve - Date.now()))
      let timer
      const late = new Promise((resolve, reject) => {
        timer = setTimeout(() => { stopPath(); reject(Object.assign(new Error(`not there after ${ms / 1000} s`), { reason: 'budget' })) }, ms)
      })
      return Promise.race([bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, range)), late]).finally(() => clearTimeout(timer))
    }
    let struckAt = null, dead = false, swings = 0, stop = null, tgt = null
    bot.on('entityDead', onDead)
    for (let i = 0; i < max && !dead && deadline - Date.now() >= STRIKE_SWING_MS; i++) {
      const last = tgt
      tgt = i === 0 ? target : nearestSeen(ename, 16)
      if (!tgt) {
        if (last && bot.entities[last.id] && !targetSeen(last)) stop = { reason: 'lost sight' }
        break
      }
      // On 1.7.10 a straight run over known ground replaces the walk and ends in a sprint hit.
      const run = LEGACY_1710 && !sprintBlock(tgt)
      if (!run && !inMeleeReach(tgt, 0.6)) {
        try { await approach(tgt.position, 2, STRIKE_SWING_MS) } catch (e) {
          if (e.reason !== 'budget') throw e
          stop = walkGaveUp(e)
          break
        }
      }
      const alreadyHeld = bot.heldItem && bot.heldItem.name === iname
      await bot.equip(it, 'hand')
      if (LEGACY_1710) {
        const hit = await meleeSwing(tgt, { run, aimY: 0.6, seen: () => targetSeen(tgt) })
        if (hit === false) { stop = { reason: 'lost sight' }; break }
        if (hit === null) continue
        struckAt = tgt.position.clone()
      } else {
        // 13 ticks after an equip cover a sword's full attack charge, and 11 more wait between swings.
        if (!alreadyHeld) await bot.waitForTicks(13)
        else if (i > 0) await bot.waitForTicks(11)
        const hurt = mobHurt.wait(tgt)
        if (hurt > 0) await new Promise(r => setTimeout(r, hurt))
        await bot.lookAt(meleeAim(tgt, 0.6), true)
        await bot.waitForTicks(2)                    // the tick race: aim packet lands NEXT tick
        if (!targetSeen(tgt)) { stop = { reason: 'lost sight' }; break }
        if (!inMeleeReach(tgt, 0.6)) continue
        struckAt = tgt.position.clone()
        bot.attack(tgt)
        fight.lastAttackT = Date.now()
      }
      swings++
      // watch for the death or the despawn instead of guessing a delay (the 700ms check called a real kill a miss)
      for (let w = 0; w < 15 && !dead; w++) {
        // On 1.7.10 the watch ends when the jump before the next swing is due.
        if (LEGACY_1710 && i < max - 1 && Date.now() + 100 > fight.lastAttackT + LEGACY_HIT_MS - JUMP_FALL_TICKS * 50) break
        await new Promise(r => setTimeout(r, 100))
        dead = died.has(tgt.id) || !bot.entities[tgt.id]
      }
    }
    if (dead && struckAt) {
      try { await approach(struckAt, 1, 0) } catch (e) { stop = walkGaveUp(e) }  // hoover the drops
    }
    const note = dead ? (stop ? 'the walk to the drops gave up' : 'walked to drops') : stop ? (stop.reason === 'lost sight' ? 'lost sight of it' : 'out of time, still standing') : swings ? 'still standing — swing again deliberately' : 'target left reach'
    ok(res, { struck: ename, with: iname, swings, at: struckAt ? round(struckAt) : null, killed: dead, note, ...stop })
  } catch (e) { err(res, e) } finally {
    if (strikeRun.lane === lane) strikeRun.lane = null
    releaseLane(lane)
    bot.removeListener('entityDead', onDead)
  }
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
    if (!shared.ready) return err(res, new Error('not ready'))
    const ename = req.query.name
    if (!ename) return err(res, new Error('need name='))
    // ?max=N (07-21 latency session): a bounded VOLLEY in one round trip — the assault's
    // hand-rolled bash loops (four arrows = four turns + sleeps ≈ 15s of wall time) move
    // into the body, where they run at game speed. Honest exits: dead, target gone,
    // out of arrows, max reached — or NO-PROGRESS (two arrows, range unchanged = you are
    // shooting a wall; the pilot burned ~8 arrows learning this rule, now the verb knows it).
    const max = Math.min(8, Math.max(1, parseInt(req.query.max || '1')))
    const shots = []
    let outcome = 'max', aimed = null
    bot.on('entityDead', onDead)
    for (let i = 0; i < max; i++) {
      if (!bot.inventory.items().find(x => x.name === 'bow')) { outcome = 'no-bow'; break }
      if (!bot.inventory.items().some(x => x.name === 'arrow')) { outcome = 'no-arrows'; break }
      const here = bot.entity.position
      const target = nearestSeen(ename, 25)
      if (!target) {
        if (!aimed) return err(res, new Error(`no ${ename} in sight within 25`))
        outcome = bot.entities[aimed.id] && !targetSeen(aimed) ? 'lost sight' : 'no-target'
        break
      }
      if (target.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === target))) {
        return err(res, new Error('refusing: never shoot players'))
      }
      const dist = target.position.distanceTo(here)
      aimed = target
      if (!(await drawAndLoose(target))) { outcome = 'no-line'; break }
      let dead = false
      for (let w = 0; w < 20 && !dead; w++) {
        await new Promise(r => setTimeout(r, 100))
        dead = died.has(target.id) || !bot.entities[target.id]
      }
      // A target gone out of sight may have died or only despawned.
      const killed = dead && targetSeen(target)
      shots.push({ dist: +dist.toFixed(1), killed })
      if (dead) { outcome = killed ? 'dead' : 'lost sight'; break }
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
        : outcome === 'lost sight' ? 'lost sight of it'
        : outcome === 'no-line' ? 'no clear line to it, nothing loosed'
        : 'still up — check where the arrow went (/gaze) and loose again'
    })
  } catch (e) { err(res, e) } finally { bot.removeListener('entityDead', onDead) }
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
    const fill = req.query.all === '1' ? null : reflexes.find(r => r.name === 'combat').fairFill(bot)
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

app.get('/goto', async (req, res) => {
  let lane = null
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
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
      if (memory.lastWaypoint && memory.lastWaypoint !== q.waypoint) waypoints.link(memory.lastWaypoint, q.waypoint)
      memory.lastWaypoint = q.waypoint
      journal('goto', 'went to ' + q.waypoint)
    }
    const { x, y, z } = bot.entity.position.floored()
    ok(res, namedStop({ ...r, cell: { x, y, z } }, route.mark))
  } catch (e) { err(res, e) } finally { releaseLane(lane) }
})

app.get('/mine', async (req, res) => {
  try {
    const name = req.query.name
    const count = parseInt(req.query.count || '1')
    const radius = parseInt(req.query.radius || '64')
    const ids = resolveBlockIds(name)
    if (!ids.length) return err(res, new Error(`unknown block: ${name}`))
    if (collectLock.done) return err(res, collectBusy())
    const items = gatherItems(ids)
    const pocketed = () => bot.inventory.items().reduce((s, it) => s + (items.has(it.name) ? it.count : 0), 0)
    const before = pocketed()
    let mined = 0
    // Why the collect stopped short: stalled, budget, busy or stopped.
    let reason = null
    for (let i = 0; i < count; i++) {
      const b = nearestVisible(ids, radius)
      if (!b) break
      try {
        await collectSafely(b, `mine ${name}`)
      } catch (e) {
        if (!e.reason) throw e
        reason = e.reason
      }
      // A collect can dig the block and then stall on the pickup.
      const after = bot.blockAt(b.position)
      if (after && after.name !== b.name) mined++
      if (reason) break
    }
    // The slot update of a pickup can land a few ticks after the drop is gone.
    for (let i = 0; i < 10 && pocketed() - before < mined; i++) await bot.waitForTicks(1)
    ok(res, { mined, requested: count, gathered: pocketed() - before, reason })
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
  return liveEntities()
    .filter(e => e.name === 'item' && e.position && !skip.has(e.id) && e.position.distanceTo(here) <= radius && entityPerceptible(e, null))
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
    if (!shared.ready) return err(res, new Error('not ready'))
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

// Crafts at a crafting table seen within 16 blocks, else in the 2x2 grid if the recipe fits, and never places a table.
async function craftItem (item, count) {
  const override = overrideRecipes(SERVER_RECIPES, item.name, shared.mcData.itemsByName)
  const recipesAt = (table) => override
    ? craftable(override, table, (id) => bot.inventory.count(id, null))
    : bot.recipesFor(item.id, null, 1, table)
  // Does this recipe need a 3x3 table? (craftable WITH an assumed table but not without one)
  const needsTable = !recipesAt(null).length && !!recipesAt(true).length
  // Tableless 2x2 crafting desyncs on 1.21.x: the client simulates the craft (materials down,
  // output up) but the server never performs it, and the next sync deletes the output. Route
  // every craft through a real table when one is reachable; 2x2 only as last resort.
  const canUseTable = !!recipesAt(true).length
  const tableIds = resolveBlockIds('crafting_table')
  const near = nearestKnown(tableIds, 16)
  if (needsTable && !near) throw new Error('no crafting table seen within 16, place one (place or placeitem) and craft again')
  const useTable = canUseTable && !!near
  if (useTable) {
    // walk within reach of an existing table (fixes today's "table 4 blocks away" failure)
    try { await bot.pathfinder.goto(new goals.GoalNear(near.position.x, near.position.y, near.position.z, 3)) } catch (e) { if (e.reason) throw e }
  }

  // count means ITEMS, not recipes (the 12-log lesson): one recipe pass may yield several
  // items (planks 4, sticks 4, torches 4) — stop as soon as we've made enough.
  let made = 0, lastErr = null
  while (made < count) {
    const at = useTable && nearestKnown(tableIds, 4)
    const t = at ? arrivedStation(at.position, (b) => b.name === 'crafting_table', 'crafting table') : null
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
// GET /eat?food=<name>: equips the named food, or the most filling safeFood, eats it and puts the held item back.
// A running job equips its tool again mid-meal, which ends the meal without an error.
app.get('/eat', async (req, res) => {
  try {
    const job = jobs.list().find(j => j.status === 'running' && !j.cancelled)
    if (job) return err(res, Object.assign(new Error(`busy: job ${job.id} ${job.name} holds the hand`), { reason: 'busy' }))
    const want = req.query.food || req.query.name   // accept both (the salmon/porkchop mystery: name= was ignored)
    const items = bot.inventory.items()
    let food = null
    if (want) food = items.find(i => i.name === want) || items.find(i => i.name.includes(want))
    if (!food) food = safeFood()
    if (!food) {
      const foods = (shared.mcData && shared.mcData.foods) || {}
      const risky = [...new Set(items.filter(i => foods[i.type]).map(i => i.name))]
      return err(res, new Error(risky.length ? `no safe food in inventory, ${risky.join(', ')} only when named in food` : 'no food in inventory'))
    }
    const prevHeld = bot.heldItem
    const before = bot.food
    const was = { food: bot.food, saturation: bot.foodSaturation }
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
    const confirmed = await foodUpdate(was)
    ok(res, { ate: food.name, foodBefore: before, foodNow: bot.food, ...(confirmed ? {} : { unconfirmed: `no food update from the server within ${FOOD_UPDATE_MS} ms, foodNow may predate the meal` }) })
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

// GET /brace?sec=N: for N seconds (cap 30) only survival reflexes may move the body.
app.get('/brace', (req, res) => {
  try {
    const sec = Math.min(30, Math.max(1, parseInt(req.query.sec || '8')))
    claimLane('brace', sec * 1000, true)
    emitEvent('brace', `braced ${sec}s — legs answer the pilot; survival reflexes only may override`)
    ok(res, { braced: sec, hardLane: true, note: 'release early with /stop' })
  } catch (e) { err(res, e) }
})
// GET /hold?sec=N[&anywhere=1] : brace's hard lane for N seconds in a doorway, a corridor or on a perch,
// striking every hostile the body sees within reach. It ends early on /stop, a creeper the stance flees,
// health under the disengage tripwire or a death.
app.get('/hold', async (req, res) => {
  const struck = new Set()
  let kills = 0
  let damage = 0
  let dead = false
  let hp = bot.health
  const onDead = (en) => { if (struck.has(en.id) && targetSeen(en)) kills++ }
  const onHealth = () => {
    if (bot.health < hp) damage += hp - bot.health
    hp = bot.health
  }
  const onDeath = () => { dead = true }
  let lane = null
  let guard = null
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
    const sec = Math.min(HOLD_MAX_S, Math.max(1, parseInt(req.query.sec || '10')))
    const spot = perched() ? 'perch' : inChokepoint() ? 'doorway' : req.query.anywhere === '1' ? 'anywhere' : null
    if (!spot) return err(res, new Error('refused: not in a 1-wide doorway or corridor with seen walls or closed doors on both sides, nor on a perch. anywhere=1 holds here anyway'))
    stopPath()
    lane = claimLane('hold', sec * 1000, true)
    holdRun.on = true
    bot.on('entityDead', onDead)
    bot.on('health', onHealth)
    bot.on('death', onDeath)
    const sword = bot.inventory.items().find(i => /_sword$/.test(i.name))
    if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) {
      await bot.equip(sword, 'hand')
      guardState.up = false
      if (!LEGACY_1710) await bot.waitForTicks(13)    // a sword's full attack charge after the equip
    }
    // The 1.7.10 sword block, raised between swings and while nothing is in reach.
    if (LEGACY_1710) {
      guard = {
        up: () => {
          if (guardState.up || legsMoving() || !bot.heldItem || !/_sword$/.test(bot.heldItem.name)) return
          bot.activateItem()
          Object.assign(guardState, { up: true, slot: bot.quickBarSlot })
        },
        down: () => {
          if (!guardState.up) return
          bot.deactivateItem()
          guardState.up = false
        }
      }
    }
    const t0 = Date.now()
    let swings = 0
    let ended = 'time'
    while (Date.now() - t0 < sec * 1000) {
      if (dead) { ended = 'died'; break }
      if (pilotLane.token !== lane) { ended = 'stopped'; break }
      const here = bot.entity.position
      const fleeDist = STANCES[fight.stance].fleeDist
      const combat = reflexes.find(r => r.name === 'combat')
      const near = nearHostiles(combat.fairFill(bot), fleeDist, combat._seenAt)
      if (near.some(h => mobClass(h.e) === 'creeper' && (h.at.distanceTo(here) < 8 || creeperRoute(h.at, fleeDist)))) { ended = 'creeper'; break }
      const target = liveEntities()
        .filter(e => e.position && ['hostile', 'heavy'].includes(mobClass(e)) && inMeleeReach(e) && targetSeen(e))
        .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
      if (bot.health < disengageHp(target ? mobClass(target) : 'hostile')) { ended = 'low health'; break }
      if (!target) {
        if (guard) guard.up()
        await new Promise(r => setTimeout(r, 100))
        continue
      }
      const seen = () => targetSeen(target)
      if (LEGACY_1710 ? await meleeSwing(target, { guard, seen }) : await chargedSwing(target, sword, { seen })) {
        swings++
        struck.add(target.id)
      }
    }
    ok(res, { held: Math.round((Date.now() - t0) / 100) / 10, spot, swings, kills, damage: Math.round(damage * 10) / 10, ended })
  } catch (e) { err(res, e) } finally {
    if (lane) holdRun.on = false
    releaseLane(lane)
    if (guard && !guardState.pilot) guard.down()
    bot.removeListener('entityDead', onDead)
    bot.removeListener('health', onHealth)
    bot.removeListener('death', onDeath)
  }
})
// GET /tidy — reclaim scaffolding the pathfinder left behind. Mines back every still-standing
// scaffold block the bot placed while navigating (tracked in navPlaced), collecting the material,
// leaving the world as it found it. ?dry=1 reports the pending count without mining.
app.get('/tidy', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const scaffold = new Set(['cobblestone', 'dirt'])
    if (req.query.dry === '1') return ok(res, { pending: navPlaced.length, blocks: navPlaced.slice(0, 20) })
    if (collectLock.done) return err(res, collectBusy())
    const todo = navPlaced.splice(0)                       // take & clear the queue
    const here = bot.entity.position
    todo.sort((a, b) => here.distanceTo(new Vec3(a.x, a.y, a.z)) - here.distanceTo(new Vec3(b.x, b.y, b.z)))
    let reclaimed = 0, alreadyGone = 0, failed = 0
    // Why the reclaim stopped short: stalled, budget, busy or stopped.
    let reason = null
    for (const [i, p] of todo.entries()) {
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
      if (!b || !scaffold.has(b.name)) { alreadyGone++; continue }  // already gone / not scaffold
      try { await collectSafely(b, 'tidy'); reclaimed++ }
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

createFollow(ctx)
const { follow, stopFollow, followTarget, armFollow, followTick } = ctx
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
    follow.followState = st
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

// ---- build verbs: outline, walls, roof and build share the helpers below ----
// A build reply lists at most this many failed cells.
const BUILD_FAIL_LIST = 12
// How far from the eye to a cell's centre a build verb places without walking.
const BUILD_REACH = 4.2
// The failures a walk toward the cell can cure.
const BUILD_WALK_CURES = ['out of reach', 'cell not known to the bot', 'no line of sight to a face']

// The item name of the placeable block name stands for, after the server's aliases.
function buildBlock (name) {
  const item = resolveItem(name)
  if (!item || !shared.mcData.blocksByName[item.name] || !shared.mcData.itemsByName[item.name]) throw new Error(`unknown block: ${name}`)
  return item.name
}

// A build verb's run, holding the pilot lane until buildClose. failed lists { at, reason } per cell.
function buildRun (verb) {
  const run = { placed: 0, skipped: 0, failed: [], stopped: null, mark: legs.mark(), since: Date.now() }
  run.onDeath = () => { run.stopped = run.stopped || 'the body died' }
  bot.once('death', run.onDeath)
  run.lane = claimLane(verb, 600000)
  return run
}

// Why the run has to end now, or null. The first reason found stays.
function buildHalt (run, job = null) {
  if (run.stopped) return run.stopped
  const taken = legs.mark() !== run.mark
  if (taken || (job && job.cancelled)) {
    const by = taken ? legs.takenSince(run.mark) : job.takenBy
    run.stopped = by ? takenText(by) : 'stopped by the pilot'
  } else if (bunker.building) run.stopped = 'a bunker is being built'
  else if (fight.lastHit.t >= run.since && ['hostile', 'creeper', 'heavy', 'provokable'].includes(fight.lastHit.cls)) run.stopped = 'a mob hit me'
  else if (meleeThreat()) run.stopped = 'a hostile is in melee reach'
  return run.stopped
}

// The reply of a build verb: its run's counts and failures, then fields.
function buildSummary (run, fields) {
  const failures = run.failed.slice(0, BUILD_FAIL_LIST).map(({ at, reason }) => `${at.x},${at.y},${at.z}: ${reason}`)
  return { placed: run.placed, skipped: run.skipped, failed: run.failed.length, ...(failures.length && { failures }), ...(run.stopped && { stopped: run.stopped }), ...fields }
}

function buildClose (run) {
  if (!run) return
  bot.removeListener('death', run.onDeath)
  releaseLane(run.lane)
}

// The first of names the pockets hold, or null.
function pocketBlock (names) {
  const items = bot.inventory.items()
  for (const n of names) {
    const it = items.find(i => i.name === n)
    if (it) return it
  }
  return null
}

// 'door' or 'skip' for a cell the bot sees now holding a door, gate or trapdoor or a solid block, else null.
function cellTaken (cell) {
  if (!seenNow(cell)) return null
  const b = bot.blockAt(cell)
  if (b && OPENABLE.test(b.name)) return 'door'
  return b && b.boundingBox === 'block' && !isSoftCover(b) ? 'skip' : null
}

// True when the body or an entity the bot perceives keeps a block out of cell.
function entityBlocks (cell) {
  if (entityInCell(cell, [bot.entity])) return true
  const inCell = blockers().filter(e => entityInCell(cell, [e]))
  if (!inCell.length) return false
  const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
  return inCell.some(e => entityPerceptible(e, fill))
}

// The { ref, face } a block for cell goes against, below first and interactive blocks last, else why there is none.
function supportFace (cell) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  let unseen = false
  let interactive = null
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const p = cell.offset(dx, dy, dz)
    if (!seenNow(p)) { unseen = true; continue }
    const b = bot.blockAt(p)
    if (!b || b.boundingBox !== 'block' || isSoftCover(b)) continue
    if (!lineCell(eye, cell.offset(0.5 + dx * 0.45, 0.5 + dy * 0.45, 0.5 + dz * 0.45), cell)) { unseen = true; continue }
    const support = { ref: b, face: new Vec3(-dx, -dy, -dz) }
    if (!isInteractive(b)) return support
    interactive = interactive || support
  }
  return interactive || (unseen ? 'no line of sight to a face' : 'no support face')
}

// Walks to goal under the stall watch. Null once there, else why the cell failed.
async function buildWalk (goal) {
  try {
    await bot.pathfinder.goto(goal)
    return null
  } catch (e) { return e.reason ? 'path stalled' : 'out of reach' }
}

// What a block at cell meets from where the body stands: { ref, face } to place against, 'skip' for a solid cell, or why it fails.
function buildVerdict (cell) {
  if (bot.entity.position.offset(0, 1.62, 0).distanceTo(cell.offset(0.5, 0.5, 0.5)) > BUILD_REACH) return 'out of reach'
  if (!cellKnown(cell)) return 'cell not known to the bot'
  const taken = cellTaken(cell)
  if (taken) return taken
  if (entityBlocks(cell)) return 'occupied by an entity'
  return supportFace(cell)
}

// Places the first of names the pockets hold at cell, walking to goal when that helps, and counts the outcome in run.
async function buildCell (run, cell, names, goal, job = null) {
  const fail = (reason) => { run.failed.push({ at: cell, reason }) }
  if (buildHalt(run, job)) return
  const taken = cellTaken(cell)
  if (taken === 'door') return fail('door')
  if (taken) { run.skipped++; return }
  if (!pocketBlock(names)) return fail('no block in pockets')
  let v = buildVerdict(cell)
  if (BUILD_WALK_CURES.includes(v)) {
    const walk = await buildWalk(goal)
    if (buildHalt(run, job)) return
    v = buildVerdict(cell)
    if (walk && v === 'out of reach') v = walk
  }
  if (v === 'skip') { run.skipped++; return }
  if (typeof v === 'string') return fail(v)
  try {
    await clearSoftCover(cell)
    await bot.equip(pocketBlock(names), 'hand')
    if (buildHalt(run, job)) return
    await bot.lookAt(cell.offset(0.5, 0.5, 0.5), true)
    await sneakPlace(v.ref, () => bot.placeBlock(v.ref, v.face))
    run.placed++
  } catch (e) {
    if (!buildHalt(run, job)) fail(isInteractive(v.ref) ? `did not place against the ${v.ref.name}` : 'did not place')
  }
}

// The first solid block within 10 below top in column x,z, 'unknown' at a cell not seen now, else null.
function knownGround (x, z, top) {
  for (let y = top; y > top - 10; y--) {
    const p = new Vec3(x, y, z)
    if (!seenNow(p)) return 'unknown'
    const b = bot.blockAt(p)
    if (b && b.boundingBox === 'block' && !isSoftCover(b)) return b
  }
  return null
}

// lay a rectangular perimeter (foundation outline). Walks each border cell, finds the
// ground column there, and places a block on top of it. x,z = a corner; w,d = size.
app.get('/outline', async (req, res) => {
  let run = null
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    const w = parseInt(req.query.w || '7')
    const d = parseInt(req.query.d || '7')
    const block = buildBlock(req.query.name || 'oak_planks')
    const startY = Math.floor(parseFloat(req.query.y || bot.entity.position.y))
    const cells = []
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      if (i === 0 || i === w - 1 || j === 0 || j === d - 1) cells.push([x0 + i, z0 + j])
    }
    run = buildRun('outline')
    for (const [x, z] of cells) {
      if (buildHalt(run)) break
      let ground = knownGround(x, z, startY + 4)
      let walk = null
      if (ground === 'unknown') {
        walk = await buildWalk(new goals.GoalNear(x, startY, z, 2))
        if (buildHalt(run)) break
        ground = knownGround(x, z, startY + 4)
      }
      if (!ground || ground === 'unknown') {
        run.failed.push({ at: { x, y: startY, z }, reason: ground ? walk || 'cell not known to the bot' : 'no support face' })
        continue
      }
      const target = ground.position.offset(0, 1, 0)
      await buildCell(run, target, [block], new goals.GoalNear(target.x, target.y, target.z, 2))
    }
    ok(res, buildSummary(run, { footprint: `${w}x${d}`, corner: { x: x0, z: z0 }, material: block }))
  } catch (e) { err(res, e) } finally { buildClose(run) }
})

// ---- chest / container interaction ----
const CHEST_RADIUS = 12
function sameChest (a, b) {
  return a.y === b.y && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) <= 1
}
// Trapped chests are left out because opening one powers redstone.
function knownChests (radius) {
  const here = bot.entity.position
  const near = knownBlocks(resolveBlockIds('chest'), radius)
    .map(p => ({ pos: p, dist: here.distanceTo(p.offset(0.5, 0.5, 0.5)) }))
  return near.filter((c, i) => !near.slice(0, i).some(o => sameChest(o.pos, c.pos)))
}
function otherChests (p, radius) {
  const others = knownChests(radius).filter(c => !sameChest(c.pos, p))
  if (!others.length) return `no other chest seen within ${radius}`
  return `other chests seen within ${radius}: ` + others.map(c => `${c.pos.x},${c.pos.y},${c.pos.z} (${c.dist.toFixed(1)} away)`).join(', ')
}
function targetChest(q) {
  if (q.x != null && q.y != null && q.z != null) {
    const Vec3 = require('vec3').Vec3
    const p = new Vec3(Math.floor(parseFloat(q.x)), Math.floor(parseFloat(q.y)), Math.floor(parseFloat(q.z)))
    if (!seenNow(p)) {
      const remembered = rememberedStation(p, resolveBlockIds('chest'))
      if (!remembered) throw outOfSight()
      return { cb: remembered }
    }
    const b = bot.blockAt(p)
    if (!b || !b.name.includes('chest')) throw new Error(`no chest at ${q.x},${q.y},${q.z} (${b ? b.name : 'unloaded'})`)
    return { cb: b }
  }
  const radius = parseInt(q.radius || CHEST_RADIUS)
  const chests = knownChests(radius)
  if (!chests.length) throw new Error(`no chest seen within ${radius}`)
  return { cb: bot.blockAt(chests[0].pos), chests }
}
app.get('/chest', async (req, res) => {
  try {
    const { cb, chests } = targetChest(req.query)
    let chest
    try {
      await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
      chest = await bot.openContainer(arrivedStation(cb.position, (b) => b.name.includes('chest'), 'chest'))
    } catch (e) {
      e.message = `cannot open the chest at ${cb.position.x},${cb.position.y},${cb.position.z}: ${e.message}; ${otherChests(cb.position, parseInt(req.query.radius || CHEST_RADIUS))}`
      throw e
    }
    const items = chest.containerItems().map(i => ({ name: i.name, count: i.count }))
    chest.close()
    const list = chests && { chests: chests.map(c => ({ at: round(c.pos), dist: Math.round(c.dist * 10) / 10 })) }
    ok(res, { at: round(cb.position), items, ...list })
  } catch (e) { err(res, e) }
})
app.get('/withdraw', async (req, res) => {
  try {
    const name = req.query.name
    const count = parseInt(req.query.count || '64')
    const { cb } = targetChest(req.query)
    await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
    const chest = await bot.openContainer(arrivedStation(cb.position, (b) => b.name.includes('chest'), 'chest'))
    const item = chest.containerItems().find(i => i.name === name) || chest.containerItems().find(i => i.name.includes(name))
    if (!item) { chest.close(); return err(res, new Error(`no ${name} in chest; ${otherChests(cb.position, parseInt(req.query.radius || CHEST_RADIUS))}`)) }
    const take = Math.min(count, item.count)
    await chest.withdraw(item.type, null, take)
    chest.close()
    ok(res, { withdrew: item.name, count: take })
  } catch (e) { err(res, e) }
})
// GET /deposit?name=&count=: moves count (default all) of the carried items whose name contains name into the target chest and replies with their total in it.
app.get('/deposit', async (req, res) => {
  try {
    const name = req.query.name
    if (!name) return err(res, new Error('name required'))
    const want = req.query.count != null ? parseInt(req.query.count) : Infinity
    const { cb } = targetChest(req.query)
    await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
    const chest = await bot.openContainer(arrivedStation(cb.position, (b) => b.name.includes('chest'), 'chest'))
    const matches = bot.inventory.items().filter(it => it.name === name || it.name.includes(name))
    if (!matches.length) { chest.close(); return err(res, new Error(`no ${name} in inventory`)) }
    const held = () => chest.containerItems().filter(i => i.name === name || i.name.includes(name)).reduce((s, i) => s + i.count, 0)
    const before = held()
    let remaining = want, deposited = 0
    try {
      for (const it of matches) {
        if (remaining <= 0) break
        const take = Math.min(it.count, remaining)
        await chest.deposit(it.type, null, take)
        deposited += take; remaining -= take
      }
    } catch (e) {
      const inChest = held()
      chest.close()
      const others = otherChests(cb.position, parseInt(req.query.radius || CHEST_RADIUS))
      return err(res, new Error(`deposited ${inChest - before} then failed (chest full?): ${e.message}; ${name} in chest now ${inChest}; ${others}`))
    }
    const inChest = held()
    chest.close()
    ok(res, { deposited, item: name, inChestNow: inChest })
  } catch (e) { err(res, e) }
})

const GRAVE_SIGHT = 32
// Refuses a cell out of lit sight before reading its block.
function targetGrave (q) {
  const grave = shared.mcData && shared.mcData.blocksByName[GRAVESTONE]
  if (!grave) throw new Error('this server has no gravestones')
  if (q.at == null) return nearestVisible([grave.id], GRAVE_SIGHT)
  const [x, y, z] = String(q.at).split(',').map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('at takes x,y,z')
  const p = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  if (!seesLit(p, GRAVE_SIGHT)) throw outOfSight()
  const b = bot.blockAt(p)
  if (!b || b.name !== GRAVESTONE) throw new Error(`no gravestone at ${q.at} (${b ? b.name : 'unloaded'})`)
  return b
}
// took counts what reached the pockets.
app.get('/grave', async (req, res) => {
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
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
  let run = null
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    const w = parseInt(req.query.w || '7')
    const d = parseInt(req.query.d || '7')
    const h = parseInt(req.query.h || '3')
    const base = Math.floor(parseFloat(req.query.base || bot.entity.position.y))
    const baseMat = buildBlock(req.query.base_name || 'cobblestone')
    const wallMat = buildBlock(req.query.name || 'oak_planks')
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
    run = buildRun('walls')
    for (const [x, z] of perim) {
      if (buildHalt(run)) break
      for (let k = 0; k < h; k++) {
        if (isDoor(x, z) && k < 2) continue          // leave a 2-high doorway
        await buildCell(run, new Vec3(x, base + k, z), k === 0 ? [baseMat, wallMat] : [wallMat, baseMat], new goals.GoalNear(x, base, z, 2))
      }
    }
    ok(res, buildSummary(run, { size: `${w}x${d}`, height: h, door: doorSide }))
  } catch (e) { err(res, e) } finally { buildClose(run) }
})

// dig a specific block by coordinate (no-op if already air)
app.get('/digat', async (req, res) => {
  try {
    if (bunker.building) return err(res, new Error(BUNKER_WALK))
    const Vec3 = require('vec3').Vec3
    const p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
    if (!cellKnown(p) && !bodyTouches(p)) return err(res, outOfSight())
    // only WALK if out of arm's reach — a deliberately positioned pilot digs from where they stand
    // (the old unconditional goto failed on ore embedded in rock with no walkable cell within 3)
    const far = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.2
    // A cell only remembered is judged once the walk there ends.
    if (!seenNow(p) && far()) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3))
    if (!seenNow(p)) return err(res, outOfSight())
    const b = bot.blockAt(p)
    if (!b || b.name === 'air') return ok(res, { already: 'air', at: round(p) })
    if (far()) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3))
    // holdDigTool swallows a failed equip.
    await holdDigTool(b)
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
    if (!seesLit({ x, y, z }, 20)) return err(res, outOfSight())
    if (bot.entity.position.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) > 3.5) {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2))
    }
    await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
    await bot.waitForTicks(2)
    await bot.activateBlock(b)
    const out = { activated: b.name, at: { x, y, z } }
    // The walk into reach can leave the block out of sight.
    if (seesLit({ x, y, z }, 20)) out.properties = (bot.blockAt(new Vec3(x, y, z)) || b).getProperties()
    ok(res, out)
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
    if (!shared.ready) return err(res, new Error('not ready'))
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

app.get('/placeitem', async (req, res) => {
  try {
    const Vec3 = require('vec3').Vec3
    const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
    const name = req.query.name
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it) return err(res, new Error(`no ${name} in inventory`))
    const known = (p) => cellKnown(p) || bodyTouches(p)
    if (!known(new Vec3(x, y, z))) return err(res, outOfSight())
    const taken = occupant(new Vec3(x, y, z))
    if (taken) return err(res, new Error(`cell occupied by ${taken}`))
    // ref: prefer the block below (top-face place); else chain sideways off any solid
    // neighbor — courses in mid-air (roof stairs, ridge lines) grow E/W from the gable
    // ends with nothing underneath them. An interactive neighbour serves only when nothing else does.
    let ref = null
    let faceVec = null
    let interactive = null
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const np = new Vec3(x + dx, y + dy, z + dz)
      const nb = seenNow(np) && bot.blockAt(np)
      if (!nb || nb.boundingBox !== 'block' || isSoftCover(nb)) continue
      if (!isInteractive(nb)) { ref = nb; faceVec = new Vec3(-dx, -dy, -dz); break }
      interactive = interactive || [nb, new Vec3(-dx, -dy, -dz)]
    }
    if (!ref && interactive) [ref, faceVec] = interactive
    if (!ref) return err(res, new Error('nothing solid I can see below or beside the target to place against'))
    await reachToPlace(new Vec3(x, y, z))
    const takenThere = occupant(new Vec3(x, y, z))
    if (takenThere) return err(res, new Error(`cell occupied by ${takenThere}`))
    await clearSoftCover(new Vec3(x, y, z))
    await bot.equip(it, 'hand')
    // face= (07-14): deliberate orientation for stairs & other facing blocks. The server derives
    // `facing` from the placer's yaw at click time (high side follows the gaze), so face=N means
    // "steps ascend toward north." We aim the body at a far compass point, then click with
    // forceLook:'ignore' so _genericPlace doesn't re-aim at the reference face and clobber it.
    const faceDir = (req.query.face || '').toUpperCase()
    let FD = faceDir ? { N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0] }[faceDir] : null
    if (faceDir && !FD) return err(res, new Error('face must be N, S, E or W'))
    // A door or gate in a fence or wall line looks across the line from the body's side.
    const axis = /(_door|_fence_gate)$/.test(name) ? passageAxis(new Vec3(x, y, z)) : null
    const feet = bot.entity.position
    if (!FD && axis) FD = axis === 'x' ? [feet.x < x + 0.5 ? 16 : -16, 0] : [0, feet.z < z + 0.5 ? 16 : -16]
    if (FD) {
      await bot.lookAt(new Vec3(x + 0.5 + FD[0], bot.entity.position.y + 1.6, z + 0.5 + FD[1]), true)
      await bot.waitForTicks(2)  // rotation PACKET goes out on the next physics tick — click too
                                 // fast and the server orients the stair by the stale rotation
                                 // (calibration row proved it: each stair wore the PREVIOUS aim)
      stampOwnEdit({ x, y, z })  // _placeBlockWithOptions bypasses the wrapped bot.placeBlock, stamp by hand
      await sneakPlace(ref, () => bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore', half: 'bottom' }))
    } else {
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      await sneakPlace(ref, () => bot.placeBlock(ref, faceVec))
    }
    // The facing the server set, with the wanted axis when it is off.
    let facing
    const placedBlock = axis && bot.blockAt(new Vec3(x, y, z))
    const got = placedBlock && /(_door|_fence_gate)$/.test(placedBlock.name) ? placedBlock.getProperties().facing : null
    if (got) facing = /^(east|west)$/.test(got) === (axis === 'x') ? got : `${got}, wanted ${axis === 'x' ? 'east-west' : 'north-south'}`
    // ?then=blockat (bones_ham, 07-21): fold act+verify into one trip. Scoped fairness —
    // you may always verify the one cell you just acted on (you clicked its neighbor with
    // line of sight); this also cures the close-range /blockat blindness for self-checks.
    const verify = (req.query.then === 'blockat')
      ? (() => { const b = bot.blockAt(new Vec3(x, y, z)); return { name: b ? b.name : '?', at: { x, y, z } } })()
      : undefined
    ok(res, { placed: name, at: { x, y, z }, face: faceDir || undefined, facing, verify })
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
    const known = (p) => cellKnown(p) || bodyTouches(p)
    if (!known(new Vec3(x, y, z))) return err(res, outOfSight())
    const taken = occupant(new Vec3(x, y, z))
    if (taken) return err(res, new Error(`cell occupied by ${taken}`))
    let ref = seenNow(new Vec3(x, y - 1, z)) && bot.blockAt(new Vec3(x, y - 1, z))
    let faceVec = new Vec3(0, 1, 0)
    if (!ref || ref.boundingBox !== 'block' || isSoftCover(ref)) {
      ref = null
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const np = new Vec3(x + dx, y, z + dz)
        const nb = seenNow(np) && bot.blockAt(np)
        if (nb && nb.boundingBox === 'block' && !isSoftCover(nb)) { ref = nb; faceVec = new Vec3(-dx, 0, -dz); break }
      }
      if (!ref) return err(res, new Error('nothing solid I can see below or beside the target to place against'))
    }
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
    const takenThere = occupant(new Vec3(x, y, z))
    if (takenThere) return err(res, new Error(`cell occupied by ${takenThere}`))
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
  let run = null
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
    const x0 = Math.floor(parseFloat(req.query.x))
    const z0 = Math.floor(parseFloat(req.query.z))
    const w = parseInt(req.query.w || '7')
    const d = parseInt(req.query.d || '7')
    const y = Math.floor(parseFloat(req.query.y))
    const block = buildBlock(req.query.name || 'oak_planks')
    const cells = []
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      cells.push([x0 + i, z0 + j, Math.min(i, j, w - 1 - i, d - 1 - j)])
    }
    cells.sort((a, b) => a[2] - b[2])   // outer rings first
    run = buildRun('roof')
    for (const [x, z] of cells) {
      if (buildHalt(run)) break
      // A goal at the roof cell itself sends the pathfinder hunting for a way up.
      await buildCell(run, new Vec3(x, y, z), [block], new goals.GoalNear(x, y - 4, z, 1))
    }
    ok(res, buildSummary(run, { size: `${w}x${d}`, y }))
  } catch (e) { err(res, e) } finally { buildClose(run) }
})

// ---- event stream: poll for driver-interrupting events since a cursor ----
app.get('/events', (req, res) => {
  try {
    const since = parseInt(req.query.since || '0')
    streams.eventsServed = streams.eventSeq
    ok(res, { cursor: streams.eventSeq, events: eventLog.filter(e => e.id > since) })
  } catch (e) { err(res, e) }
})
// GET /reflexes — list the always-on reflex layer; /reflexes?name=unstuck&on=0 toggles one off/on.
// /guard?on=1|0 — raise/lower the shield by pilot order (the reflex manages it in combat
// automatically; this is the manual posture for holding scary ground). Java shields only
// block while actively raised; raised = can't attack until lowered. Offhand slot is 45.
app.get('/guard', (req, res) => {
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
    // 1.7.10 blocks with the sword in the main hand. The combat reflex shares guardState: it raises the
    // block again after a fight while the pilot's order stands, and on=0 lowers its block too.
    if (LEGACY_1710) {
      if (req.query.on === '0') {
        bot.deactivateItem()
        Object.assign(guardState, { up: false, pilot: false })
        return ok(res, { guarding: false })
      }
      if (!bot.heldItem || !/_sword$/.test(bot.heldItem.name)) return err(res, new Error('no sword in hand, equip one first'))
      if (legsMoving()) return err(res, new Error('the body is moving, and a walk lowers the block'))
      bot.activateItem()
      Object.assign(guardState, { up: true, slot: bot.quickBarSlot, pilot: true })
      return ok(res, { guarding: true })
    }
    const s = bot.inventory.slots[45]
    if (!s || s.name !== 'shield') return err(res, new Error('no shield in offhand — /equip name=shield dest=off-hand first'))
    const on = req.query.on !== '0'
    if (on && legsMoving()) return err(res, new Error('the body is moving, and a walk lowers the shield'))
    if (on) bot.activateItem(true)
    else bot.deactivateItem()
    guardState.up = on
    ok(res, { guarding: on })
  } catch (e) { err(res, e) }
})
// /threatdebug?secs=60 — Peaceful-friendly validation: the combat watcher also SCORES players
// (narrate-only, weapons hard-refused in the reflex) so the helmsman can charge the machine and we
// watch the math call it.
app.get('/threatdebug', (req, res) => {
  try {
    const secs = Math.min(300, parseInt(req.query.secs || '60'))
    fight.threatDebugUntil = Date.now() + secs * 1000
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
      fight.stance = want
      emitEvent('stance', `combat posture now ${want}: ${STANCES[want].note}`)
    }
    ok(res, { stance: fight.stance, ...STANCES[fight.stance], all: Object.fromEntries(Object.entries(STANCES).map(([k, v]) => [k, v.note])) })
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
      if (on && shared.mcData && shared.mcData.itemsByName) {
        if (shared.mcData.itemsByName.dirt) scaff.push(shared.mcData.itemsByName.dirt.id)
        if (shared.mcData.itemsByName.cobblestone) scaff.push(shared.mcData.itemsByName.cobblestone.id)
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
    const died = j.died || undefined
    if (req.query.verbose) {
      return ok(res, { job: {
        id: j.id, name: j.name, status: j.status, note: j.note, takenBy, died,
        result: j.result, error: j.error, started: j.started, finished: j.finished || null
      } })
    }
    ok(res, { job: {
      id: j.id, name: j.name, status: j.status, note: j.note, takenBy, died,
      error: j.error, result: (j.status === 'done' ? j.result : null)
    } })
  } catch (e) { err(res, e) }
})

// Why c is no cell to stand in, '' when it is one, null when an unknown cell leaves it open.
function standFault (c) {
  const up = c.offset(0, 1, 0), down = c.offset(0, -1, 0)
  const known = (p) => !!bot.blockAt(p) && unstuckKnows(p)
  if (known(c) && !passable(c)) return bot.blockAt(c).name
  if (known(up) && !passable(up)) return bot.blockAt(up).name + ' above'
  // An open feet cell in sight shows the floor under it.
  const floorKnown = known(down) || (known(c) && !!bot.blockAt(down))
  if (floorKnown && bot.blockAt(down).boundingBox !== 'block') return 'no floor'
  return known(c) && known(up) && floorKnown ? '' : null
}
// On a distance tie, level cells win, then cells above.
function standBeside (c) {
  const ring = []
  for (const dy of [0, 1, -1]) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) ring.push(c.offset(dx, dy, dz))
  return ring.sort((a, b) => a.distanceSquared(c) - b.distanceSquared(c)).find((p) => standFault(p) === '') || null
}

// ---- MEMORY endpoints: waypoints + journal ----
// GET /waypoint?name=&x=&y=&z=  -> if x/y/z given, store that; else if stored, return it;
//                                  else stamp the cell the bot stands in.
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
      if (memory.lastWaypoint === name) memory.lastWaypoint = null
      return ok(res, { removed: gone ? name : null })
    }
    const extra = {}
    if (req.query.note != null) extra.note = String(req.query.note)
    if (req.query.kind != null) extra.kind = String(req.query.kind) === 'resource' ? 'resource' : 'place'
    const hasCoords = req.query.x != null && req.query.y != null && req.query.z != null
    const existing = waypoints.get(name)
    let wp = null, from, moved
    if (hasCoords) {
      let at = { x: parseFloat(req.query.x), y: parseFloat(req.query.y), z: parseFloat(req.query.z) }
      const cell = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
      const why = standFault(cell)
      if (why) {
        const beside = standBeside(cell)
        const named = `(${cellText(cell)})`
        if (!beside) return err(res, new Error(`${named} is no cell to stand in (${why}) and no cell beside it is known to be one`))
        at = { x: beside.x, y: beside.y, z: beside.z }
        moved = `from ${named}, no cell to stand in (${why})`
      }
      wp = waypoints.set(name, at, extra)
      from = 'coords'
    } else if (existing && (extra.note != null || extra.kind != null)) {
      wp = waypoints.set(name, existing, extra)               // annotate in place
      from = 'updated'
    } else if (existing) {
      wp = existing; from = 'stored'
    } else {
      wp = waypoints.set(name, bot.entity.position.floored(), extra)
      from = 'current'
      if (memory.lastWaypoint && memory.lastWaypoint !== name) waypoints.link(memory.lastWaypoint, name)   // I walked here from there
      memory.lastWaypoint = name
    }
    if (req.query.linkto) { const okd = waypoints.link(name, String(req.query.linkto)); if (okd) journal('waypoint', 'linked ' + name + ' <-> ' + req.query.linkto) }
    if (from !== 'stored') journal('waypoint', from + ' ' + name + ' = ' + JSON.stringify({ x: wp.x, y: wp.y, z: wp.z }))
    return ok(res, { name, at: wp, from, ...(moved && { moved }) })
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
      payload.underground = true
      payload.note = `this map is a SLICE at your depth, NOT the surface: ${skyPhrase(oh).trim()}`
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
    const time = skyInSight() ? { timeOfDay: tod, phase } : undefined

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
      `${biome ? biome + (time ? ' biome, ' : ' biome. ') : ''}${time ? `${phase} (t=${tod}). ` : ''}` +
      `HP ${bot.health}/20, food ${bot.food}/20, holding ${held}. ` +
      `Ahead: ${ahead ? ahead.name + ' @' + ahead.dist : 'open'}. ` +
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
    const open = (x, y, z) => seen(x, y, z) && floodPassable(at(x, y, z), true)
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
    const fill = airFlood({ radius, cap: 15000, known: cellKnown, knownOnly: true, body: true })
    const dirs = {}
    let contUp = false, contDown = false, leaves = false
    for (const k of fill.cells) {
      const [x, y, z] = k.split(',').map(Number)
      const ddx = x - o.x, ddy = y - o.y, ddz = z - o.z
      const side = Math.max(Math.abs(ddx), Math.abs(ddz)) >= radius
      if (!side && Math.abs(ddy) < radius) continue
      leaves = true
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

// The cell that must change when clicking b at p with held works, null when it may work and change nothing.
function useTarget (b, p, held) {
  const props = b.getProperties()
  if ('open' in props) return p
  if (!held) return null
  if (held.endsWith('_hoe') && /^(dirt|grass_block|dirt_path|coarse_dirt|rooted_dirt)$/.test(b.name)) return p
  if ((b.name === 'farmland' && /^(wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds|carrot|potato|torchflower_seeds|pitcher_pod)$/.test(held)) ||
    (b.name === 'soul_sand' && held === 'nether_wart')) return p.offset(0, 1, 0)
  if (held === 'bone_meal' && 'age' in props) return p
  if (held === 'bucket' && /^(water|lava)$/.test(b.name)) return p
  if (/^(water|lava)_bucket$/.test(held) && /^(cave_|void_)?air$/.test(b.name)) return p
  return null
}

// Runs act, then waits until the server updates the block at p, at most ms.
async function withBlockUpdate (p, ms, act) {
  let updated
  const update = new Promise((resolve) => { updated = resolve })
  const onUpdate = (old, now) => { if (now && now.position.equals(p)) updated() }
  bot.on('blockUpdate', onUpdate)
  let timer
  try {
    await act()
    await Promise.race([update, new Promise((resolve) => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
    bot.removeListener('blockUpdate', onUpdate)
  }
}

// GET /use?x=&y=&z=[&item=name] — the universal RIGHT-CLICK: equip item (optional) and activate it
// on the block. Unlocks the whole interaction layer: till (hoe), sow (seeds), bone meal, fill/pour
// bucket, open/close doors, shear sheep... For liquids (no activatable block) it aims and uses the
// held item instead. Walks closer only if out of arm's reach (digat's lesson).
// Replies ok false when a click that should change a cell (useTarget) left it as it was.
app.get('/use', async (req, res) => {
  try {
    const p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
    if (![p.x, p.y, p.z].every(Number.isFinite)) return err(res, new Error('x, y, z required'))
    const b = bot.blockAt(p)
    if (!b) return err(res, new Error('block not loaded'))
    if (!seesLit(p, 6)) return err(res, outOfSight())
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
    // On 1.7.10 a bucket used through activateBlock on grass, a flower or a torch pours nothing.
    const bucket = !!bot.heldItem && bot.heldItem.name.endsWith('bucket')
    const rawUse = bucket || b.name.includes('water') || b.name.includes('lava') || /^(cave_|void_)?air$/.test(b.name) || req.query.raw === '1'
    const target = useTarget(b, p, bot.heldItem ? bot.heldItem.name : null)
    const was = target && bot.blockAt(target)
    await withBlockUpdate(target || p, 500, async () => {
      if (rawUse) {
        bot.activateItem()
        await new Promise(r => setTimeout(r, 300))
        try { bot.deactivateItem() } catch (e) {}
      } else {
        await bot.activateBlock(b)
      }
    })
    const out = { used: bot.heldItem ? bot.heldItem.name : 'empty hand', on: b.name, at: round(p) }
    // The walk into reach can leave the block out of sight.
    if (seenNow(p)) out.now = (bot.blockAt(p) || {}).name
    const after = target && bot.blockAt(target)
    if (was && after && after.stateId === was.stateId && seenNow(target)) {
      Object.assign(out, { ok: false, reason: `nothing changed at ${target.x},${target.y},${target.z}, still ${was.name}` })
    }
    ok(res, out)
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

createBunkerCells(ctx)
const { jumpPlace, BUNKER_HEIGHT, BUNKER_MAX_HEIGHT, NEIGHBOURS, xyz, fillers, pillarHeight, blockers } = ctx

app.get('/pillar', async (req, res) => {
  try {
    const asked = Math.min(16, Math.max(1, parseInt(req.query.height || '3')))
    const up = pillarHeight(asked)
    const carried = fillers().reduce((n, i) => n + i.count, 0)
    // A pit's rim would read as ground the pillar has to clear.
    const head = bot.entity.position.floored().offset(0, 1, 0)
    const inPit = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => {
      const p = head.offset(dx, 0, dz)
      const b = bot.blockAt(p)
      return !!b && b.boundingBox === 'block' && knownCell(p)
    })
    const height = inPit ? asked : Math.max(asked, Math.min(up.height, BUNKER_MAX_HEIGHT, carried))
    let placed = 0
    const y0 = Math.floor(bot.entity.position.y)
    const done = (body) => {
      if (placed) perch.cell = bot.entity.position.floored()
      ok(res, height > asked ? { ...body, raised: `from ${asked} to ${height}, ${up.why}` } : body)
    }
    for (let i = 0; i < height; i++) {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const yBefore = Math.floor(bot.entity.position.y)
      const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
      if (!below || below.boundingBox !== 'block') return done({ placed, rose: yBefore - y0, stopped: 'no solid footing to build on' })
      const it = fillers()[0]
      if (!it) return done({ placed, rose: yBefore - y0, stopped: 'out of filler blocks (dirt, stone kinds, sandstone, bricks or planks)' })
      if (!(await jumpPlace(below, it))) return done({ placed, rose: Math.floor(bot.entity.position.y) - y0, stopped: 'placement would not take (ceiling? cell blocked?)' })
      placed++
    }
    done({ placed, rose: Math.floor(bot.entity.position.y) - y0, y: Math.floor(bot.entity.position.y) })
  } catch (e) { try { if (!bunker.building) bot.setControlState('jump', false) } catch (_) {} ; err(res, e) }
})

createBunkerBuild(ctx)

// GET /bunker?mode=auto|up|down&height=N: builds the shelter above and answers once it stands.
app.get('/bunker', async (req, res) => {
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
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
    if (!shared.ready) return err(res, new Error('not ready'))
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
      coverPhrase(oh) + (around ? `Around: ${around}. ` : '') +
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

// The items a dig of the blocks ids lands in the pockets: their drops, or the block itself.
function gatherItems (ids) {
  const names = new Set()
  for (const id of ids) {
    const blk = shared.mcData.blocks[id]
    for (const d of blk.drops) names.add(shared.mcData.items[d].name)
    if (shared.mcData.itemsByName[blk.name]) names.add(blk.name)
  }
  names.delete('air')
  return names
}

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
      // A dig whose drop never reaches the pockets counts nothing.
      const items = gatherItems(ids)
      const pocketed = () => bot.inventory.items().reduce((s, it) => s + (items.has(it.name) ? it.count : 0), 0)
      const before = pocketed()
      let gathered = 0
      let dug = 0
      let stop = null
      const tried = new Set()                     // positions we've given up on
      const key = (p) => `${p.x},${p.y},${p.z}`
      const startT = Date.now()
      let iters = 0
      let noProgress = 0                          // consecutive iterations with no mine (circuit breaker)
      // FORESTRY: harvesting wood → walk like a lumberjack (clear leaves+logs to travel) and
      // reach the whole trunk, not just the bottom few. Restored to considerate nav in finally.
      const isWood = ids.some(i => { const n = shared.mcData.blocks[i] && shared.mcData.blocks[i].name; return !!n && (n.endsWith('_log') || n.endsWith('_wood')) })
      const maxRise = isWood ? 24 : GATHER_MAX_RISE
      const usingForestry = isWood && !!shared.forestryMoves
      const prevThink = bot.pathfinder.thinkTimeout
      // forestry pathfinding is heavier (canDig opens dig-moves at every node), so a truly
      // awkward floating log can eat the full 10s think budget before we skip it. Fail fast:
      // drop the think budget while gathering wood so unreachable targets are abandoned quickly.
      if (usingForestry) { bot.pathfinder.setMovements(shared.forestryMoves); bot.pathfinder.thinkTimeout = 3000; job.progress('forestry nav: may clear leaves+logs') }
      try {
      while (gathered < amount) {
        if (job.cancelled) { stop = 'cancelled'; job.progress(stop); break }
        if (++iters > amount * 8 + 40 || Date.now() - startT > 180000) { stop = 'watchdog: stopping (iter/time bound)'; job.progress(stop); break }
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
          stop = `no reachable ${resource} left (gathered ${gathered}/${amount})`
          job.progress(stop)
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
            await collectSafely(b, job.name, { wait: true })
            dug++
            // The slot update of a pickup can land a few ticks after the drop is gone.
            for (let i = 0; i < 10 && pocketed() - before <= gathered; i++) await bot.waitForTicks(1)
            const now = pocketed() - before
            progressed = now > gathered
            gathered = now
            job.progress(progressed ? `gathered ${resource} ${gathered}/${amount} @ ${p.x},${p.y},${p.z}` : `dug ${resource} @ ${p.x},${p.y},${p.z}, nothing picked up`)
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
          stop = `spot tapped out — no reachable ${resource} in ${noProgress} passes (gathered ${gathered}/${amount})`
          job.progress(stop)
          break
        }
      }
      const have = pocketed()
      emitEvent('gather', `${gathered > 0 ? 'done' : 'failed'} ${resource} gathered=${gathered}`, { inventoryMatching: have })
      const result = { gathered, dug, requested: amount, inventoryMatching: have }
      if (gathered <= 0) Object.assign(result, { ok: false, reason: dug ? `dug ${dug} ${resource}, nothing reached the pockets` : stop })
      return result
      } finally {
        if (usingForestry && shared.considerateMoves) { bot.pathfinder.setMovements(shared.considerateMoves); bot.pathfinder.thinkTimeout = prevThink }
      }
    })
    ok(res, { job: id })
  } catch (e) { err(res, e) }
})

// Why a dig job stops after digging p (bared lava or water, or with falls a gravel or sand cap), or null.
async function struckHazard (p, falls) {
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const n = p.offset(dx, dy, dz)
    const b = bot.blockAt(n)
    const falling = falls && dy === 1 && !!b && /^(gravel|sand|red_sand)$/.test(b.name)
    if (!b || !(falling || /lava|water/.test(b.name)) || !(bodyTouches(n) || seesLit(n, 8))) continue
    const at = `${n.x},${n.y},${n.z}`
    if (falling) return `${b.name} falling from ${at}, stopping`
    if (!b.name.includes('lava')) return `struck ${b.name} at ${at}, stopping`
    const why = await fillFrom(p)
    return `struck ${b.name} at ${at}, ${why ? `the hole stays open, ${why}` : 'filled the hole back'}`
  }
  return null
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
        // Known lava or water that digging ahead would lay bare.
        for (const p of [ahead.offset(dx, 0, dz), aheadHead.offset(dx, 0, dz), aheadFloor, aheadHead.offset(0, 1, 0)]) {
          const hb = bot.blockAt(p); if (isHazard(hb) && knownCell(p)) { stop = `${hb.name} ahead — stopping short of it`; break }
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
          stop = await struckHazard(p, false)
          if (stop) break
        }
        if (stop) break
        const fb = bot.blockAt(aheadFloor)                    // keep a solid floor so we don't fall / breach a drop
        if (!fb || fb.boundingBox !== 'block') {
          const why = await fillFrom(aheadFloor)
          if (why) { stop = `gap in floor, ${why}`; break }
          await equipPick()
        }
        if (!(await nudgeInto(ahead, false))) { stop = 'cannot advance: nudge stalled'; break }
        const here = bot.entity.position.floored()            // grab ore now exposed in the corridor walls (adjacent, fair)
        for (const [ox, oz] of perp) for (const oy of [0, 1]) {
          const wb = bot.blockAt(here.offset(ox, oy, oz))
          if (!stop && wb && wb.name.includes('ore')) { note(wb.name, here.offset(ox, oy, oz)); await equipPick(wb); try { await bot.dig(wb); dug++ } catch (e) {} stop = await struckHazard(here.offset(ox, oy, oz), false) }
        }
        if (stop) break
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
// onto it. STOPS on water/lava it knows of or a dig lays bare, or gravel/sand falling into the
// passage; places a tread from andesite/cobble/dirt if the step is missing; torches the climb.
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
        // Known lava, water or fall-blocks that this step would dig or lay bare.
        for (const p of [...launch, feet, head, above, new Vec3(nx + dx, ny, nz + dz), new Vec3(nx + dx, ny + 1, nz + dz)]) {
          const hb = bot.blockAt(p)
          if (!knownCell(p) && !bodyTouches(p)) continue
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
          stop = await struckHazard(p, true)
          if (stop) break
        }
        if (stop) break
        const tb = bot.blockAt(tread)                                      // need a tread to stand on
        if (!tb || tb.boundingBox !== 'block') {
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
    if (!shared.ready) return err(res, new Error('not ready'))
    const baseMat = buildBlock(req.query.base_name || 'cobblestone')
    const wallMat = buildBlock(req.query.name || 'oak_planks')

    // west doorway centered on the -x wall (matches /walls door='west')
    const doorCell = [x0, z0 + Math.floor(d / 2)]
    const isDoor = (x, z) => x === doorCell[0] && z === doorCell[1]

    const { id } = jobs.start(`build ${template} ${w}x${d}h${h} @${x0},${z0}`, async (job) => {
      const run = buildRun('build')
      try {
        const stats = { foundation: 0, walls: 0, roof: 0 }
        const near = (cell) => new goals.GoalNear(cell.x, cell.y, cell.z, 3)
        const perim = []
        for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
          if (i === 0 || i === w - 1 || j === 0 || j === d - 1) perim.push([x0 + i, z0 + j])
        }

        // ---- foundation: base-material perimeter at y=base ----
        job.progress('phase: foundation')
        let before = run.placed
        for (const [x, z] of perim) {
          if (buildHalt(run, job)) break
          if (isDoor(x, z)) continue                 // leave the doorway cell open (no place-then-dig churn)
          const cell = new Vec3(x, base, z)
          await buildCell(run, cell, [baseMat, wallMat], near(cell), job)
        }
        stats.foundation = run.placed - before
        emitEvent('build', `foundation done (${stats.foundation})`, { x: x0, z: z0 })

        // ---- walls: perimeter columns base+1..base+h-1, leaving the doorway open ----
        job.progress('phase: walls')
        before = run.placed
        for (const [x, z] of perim) {
          if (buildHalt(run, job)) break
          for (let k = 1; k < h; k++) {
            if (isDoor(x, z) && k < 2) { continue }  // 2-high doorway (rows k=0 base & k=1)
            const cell = new Vec3(x, base + k, z)
            await buildCell(run, cell, [wallMat, baseMat], near(cell), job)
          }
        }
        stats.walls = run.placed - before

        // ---- door: dig seen solid blocks out of the 2-high doorway span (base..base+1) ----
        job.progress('phase: door')
        for (let k = 0; k < 2 && !buildHalt(run, job); k++) {
          const dp = new Vec3(doorCell[0], base + k, doorCell[1])
          // Only a seen solid block goes, never a door.
          if (cellTaken(dp) !== 'skip') continue
          const walk = await buildWalk(near(dp))
          if (walk) { run.failed.push({ at: dp, reason: walk }); continue }
          try { await bot.dig(bot.blockAt(dp)) } catch (e) { if (!buildHalt(run, job)) run.failed.push({ at: dp, reason: 'did not dig' }) }
        }

        // ---- roof: solid slab at y=base+h, outer-ring-first (neighbor to build against) ----
        job.progress('phase: roof')
        const roofCells = []
        for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
          roofCells.push([x0 + i, z0 + j, Math.min(i, j, w - 1 - i, d - 1 - j)])
        }
        roofCells.sort((a, b) => a[2] - b[2])
        before = run.placed
        for (const [x, z] of roofCells) {
          if (buildHalt(run, job)) break
          const cell = new Vec3(x, base + h, z)
          await buildCell(run, cell, [wallMat, baseMat], near(cell), job)
        }
        stats.roof = run.placed - before

        emitEvent('build', `cabin ${run.stopped || 'complete'} f=${stats.foundation} w=${stats.walls} r=${stats.roof}`, stats)
        return buildSummary(run, { template, size: `${w}x${d}`, height: h, corner: { x: x0, z: z0 }, ...stats })
      } finally { buildClose(run) }
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
    if (!shared.ready) return err(res, new Error('not ready'))
    const itemName = req.query.item
    const slot = req.query.slot === undefined ? null : parseInt(req.query.slot)
    if (!itemName) return err(res, new Error('item required'))
    const tb = nearestKnown(resolveBlockIds('enchanting_table'), 16)
    if (!tb) return err(res, new Error('no enchanting table seen within 16'))
    await bot.pathfinder.goto(new goals.GoalNear(tb.position.x, tb.position.y, tb.position.z, 2))
    const item = bot.inventory.items().find(i => i.name === itemName)
    if (!item) return err(res, new Error(`no ${itemName} in pockets`))
    const lapis = bot.inventory.items().find(i => i.name === 'lapis_lazuli')
    if (!lapis) return err(res, new Error('no lapis_lazuli in pockets — the table burns 1-3 per enchant'))
    const table = await bot.openEnchantmentTable(arrivedStation(tb.position, (b) => b.name === 'enchanting_table', 'enchanting table'))
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
        const e = (shared.mcData.enchantmentsArray || []).find(x => x.id === id)
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
    if (!shared.ready) return err(res, new Error('not ready'))
    const itemName = req.query.item
    const newName = req.query.name
    if (!itemName || !newName) return err(res, new Error('item and name required'))
    // exact-match resolve skips the damaged variants — an anvil is an anvil, gather all three
    const anvilIds = ['anvil', 'chipped_anvil', 'damaged_anvil'].flatMap(n => resolveBlockIds(n))
    const ab = nearestKnown(anvilIds, 16)
    if (!ab) return err(res, new Error('no anvil seen within 16'))
    await bot.pathfinder.goto(new goals.GoalNear(ab.position.x, ab.position.y, ab.position.z, 2))
    const item = bot.inventory.items().find(i => i.name === itemName)
    if (!item) return err(res, new Error(`no ${itemName} in pockets`))
    const anvil = await bot.openAnvil(arrivedStation(ab.position, (b) => /anvil$/.test(b.name), 'anvil'))
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
  if (q.at == null) {
    const b = nearestKnown(resolveBlockIds('furnace'), 8)
    if (!b) throw new Error('no furnace seen within 8')
    return b
  }
  const [x, y, z] = String(q.at).split(',').map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('at takes x,y,z')
  const p = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  if (!seenNow(p)) {
    const remembered = rememberedStation(p, resolveBlockIds('furnace'))
    if (!remembered) throw outOfSight()
    return remembered
  }
  const b = bot.blockAt(p)
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

// A furnace lights its fuel and cooks only an input the server has a recipe for.
async function furnaceCooks (furnace) {
  for (let t = 0; t < COOK_PROBE_TICKS; t++) {
    if (furnace.progress > 0) return true
    await bot.waitForTicks(1)
  }
  return furnace.progress > 0
}

// GET /smelt?item=&fuel=&count= : loads the nearest furnace and returns without waiting for the burn.
app.get('/smelt', async (req, res) => {
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
    const inputName = req.query.item
    const fuelName = req.query.fuel || 'coal'
    const want = Math.max(1, parseInt(req.query.count || '1'))
    if (!inputName) return err(res, new Error('item required'))
    if (burnItems(fuelName) == null) return err(res, new Error(`no known burn time for ${fuelName}`))
    const fb = targetFurnace({})
    await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
    const furnace = await bot.openFurnace(arrivedStation(fb.position, (b) => b.name === 'furnace', 'furnace'))
    try {
      // The flame bar arrives after the window.
      await bot.waitForTicks(2)
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
      // A fuel slot holding another item is used as it is.
      const per = burnItems(fuelIn ? fuelIn.name : fuelName)
      if (per == null) throw new Error(`no known burn time for the ${fuelIn.count} ${fuelIn.name} in the fuel slot`)
      // The flame shows the share of one fuel item left to burn, taken as the fuel in use.
      const burning = (furnace.fuel || 0) * per
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
      const pocketFuel = furnace.items().find(i => i.name === fuelName)
      if (pocketFuel && (!fuelIn || fuelIn.name === fuelName)) {
        const held = fuelIn ? fuelIn.count : 0
        const add = Math.min(pocketCount(fuelName), Math.ceil((total - burning) / per) - held, pocketFuel.stackSize - held)
        if (add > 0) {
          await furnace.putFuel(pocketFuel.type, null, add)
          step('loaded fuel')
        }
      }
      // A stall behind an occupied output says nothing about the recipe.
      if (!furnace.outputItem() && !await furnaceCooks(furnace)) {
        const back = furnace.inputItem()
        const held = back.count
        const moved = Math.min(held, pocketRoom(furnace, back))
        await takeSlot(furnace, back, moved)
        step('no recipe')
        const fuelLeft = furnace.fuelItem()
        const left = [held > moved && `${held - moved} ${inputName} in the input`, fuelLeft && `the ${fuelLeft.count} ${fuelLeft.name} in the fuel slot`].filter(Boolean)
        throw Object.assign(new Error(`this server does not smelt ${inputName}: took ${moved} ${inputName} back${left.length ? `, left ${left.join(' and ')}` : ''}`), { reason: 'no-recipe' })
      }
      const fuelNow = furnace.fuelItem()
      const covers = Math.round((burning + (fuelNow ? fuelNow.count * per : 0)) * 100) / 100
      // A furnace smelts one item every 10 s.
      ok(res, { at: round(fb.position), loaded: n, ...furnaceSlots(furnace), took, note,
        doneInSec: Math.round(Math.min(total, covers) * 10), fuelFor: covers < total ? covers : undefined })
    } finally {
      furnace.close()
    }
  } catch (e) { err(res, e) }
})

// GET /furnace?at=&take=&count= : lists a furnace's slots, or takes one slot into the pockets.
app.get('/furnace', async (req, res) => {
  try {
    if (!shared.ready) return err(res, new Error('not ready'))
    const take = req.query.take
    if (take != null && !['input', 'fuel', 'output'].includes(take)) return err(res, new Error('take is input, fuel or output'))
    const fb = targetFurnace(req.query)
    await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
    const furnace = await bot.openFurnace(arrivedStation(fb.position, (b) => b.name === 'furnace', 'furnace'))
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

function wireEarly () {
  wireConnectionHardening()
  wireLightPackets()
  wireDamageTypes()
  wireWorldSeed()
}
function wireRuntime () {
  wirePlanKnownReset()
  wireConnectionSpawn()
  wireConnectionEvents()
  wireChatCapture()
  wireServerMessages()
  wireLightChanges()
  wireLightReload()
  wireSightMemoDrops()
  wireGroundTopForget()
  wireIndoorsReset()
  wireSkyInSightReset()
  wireWearAlarm()
  wireSoundTablePin()
  wireHearing()
  wireOwnEditStamps()
  wireLookPaceGoto()
  wireGateManners()
  wireWorldChangeNotes()
  wireWorldChangeEvents()
  wirePocketAlarm()
  wireTrailMarks()
  wireBodyAlarms()
  wireGuardDrop()
  wireItemUseCosts()
  wireArmSwings()
  wireArrowTracking()
  wireDamageAttribution()
  wireFloodDrops()
  wireThreatReset()
  wireOreCallout()
  wireSeenWorld()
  wireSeenSave()
  wireStaleEntities()
  wireCrumbRecording()
  wireCrumbForget()
  wirePresenceTick()
  wireMobHurt()
  wireLivePath()
  wirePathfinderTicks()
  wirePathLog()
}
function installReflexes () {
  reflexes.push(unstuckReflex)
  reflexes.push(currentWatchReflex)
  reflexes.push(narratorReflex)
  reflexes.push(trekReflex)
  reflexes.unshift(combatReflex)
  reflexes.push(fleeToPlayerReflex)
  reflexes.unshift(lavaWatchReflex)
  reflexes.splice(reflexes.findIndex(r => r.name === 'combat'), 0, bunkerReflex)
}
function bindAll () {
  bindStreams(ctx)
  bindItems(ctx)
  bindSight(ctx)
  bindDescribe(ctx)
  bindLane(ctx)
  bindMemory(ctx)
  bindReflexes(ctx)
  bindLegs(ctx)
  bindJobBoard(ctx)
  bindFollow(ctx)
  bindAwareness(ctx)
  bindUnstuck(ctx)
  bindPlacing(ctx)
  bindWatchReflexes(ctx)
  bindBunkerCells(ctx)
  bindBunkerBuild(ctx)
  bindCombat(ctx)
  bindBunker(ctx)
  bindSenses(ctx)
  bindAlarms(ctx)
  bindConnection(ctx)
  bindViewer(ctx)
}
bindAll()
wireRuntime()
app.listen(CTRL_PORT, '127.0.0.1', (e) => {
  if (e) {
    console.error(`[bot] control API cannot listen on 127.0.0.1:${CTRL_PORT}: ${e.message}`)
    process.exit(1)
  }
  console.log(`[bot] control API on http://127.0.0.1:${CTRL_PORT}`)
})
