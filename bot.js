// Golem — a Mineflayer body for language-model pilots
// Structured perception and actions over a small HMAC-signed HTTP API.
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const armorManager = require('mineflayer-armor-manager')
const { chatMaxLen } = require('./lib/install')

// The control API's HMAC key.
const GOLEM_TOKEN = process.env.GOLEM_TOKEN || ''
if (GOLEM_TOKEN.length < 32) {
  console.error('[bot] GOLEM_TOKEN is missing or shorter than 32 characters, refusing to start')
  process.exit(1)
}
const { HOST, PORT, VERSION, USERNAME, CTRL_PORT } = require('./lib/bot/config')
const { createApp } = require('./lib/app')
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
const { createUnstuck, bindUnstuck, wireUnstuckHeartbeat } = require('./lib/bot/unstuck')
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
const { createReply, bindReply } = require('./lib/routes/reply')
const { createDebugRoutes, bindDebugRoutes } = require('./lib/routes/debug')
const { createSocialRoutes, bindSocialRoutes } = require('./lib/routes/social')
const { createBuildingRoutes, bindBuildingRoutes } = require('./lib/routes/building')
const { createMemoryRoutes, bindMemoryRoutes } = require('./lib/routes/memory')
const { createFightingRoutes, bindFightingRoutes } = require('./lib/routes/fighting')
const { createMovingRoutes, bindMovingRoutes } = require('./lib/routes/moving')
const { createSeeingRoutes, bindSeeingRoutes } = require('./lib/routes/seeing')
const { createWorkingRoutes, bindWorkingRoutes } = require('./lib/routes/working')

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
shared.considerateMoves = null    // default no-dig profile (protects builds + terrain)
shared.forestryMoves = null       // lumberjack profile: may break ONLY leaves+logs (built at spawn)

createViewer(ctx)
createConnection(ctx)

createStreams(ctx)

createDescribe(ctx)

createItems(ctx)

createReflexes(ctx)
const { reflexes } = ctx

createUnstuck(ctx)
const { unstuckReflex } = ctx

createWatchReflexes(ctx)
const { currentWatchReflex, narratorReflex, trekReflex, lavaWatchReflex } = ctx

createJobBoard(ctx)
const { deaths } = ctx

createMemory(ctx)
const { memory } = ctx

createPlacing(ctx)

createSight(ctx)
const { freshLight } = ctx
function wireLightPackets () {
  bot._client.on('update_light', (packet) => freshLight(packet.chunkX, packet.chunkZ))
}

createAlarms(ctx)

createSenses(ctx)

const fight = {}
ctx.fight = fight
fight.lastAttrib = null            // set by the damage_event wire, read by the hurt handler in alarms.js

createCombat(ctx)
const { combatReflex, fleeToPlayerReflex } = ctx
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

createBunker(ctx)
const { bunkerReflex } = ctx

createAwareness(ctx)

createFollow(ctx)

createBunkerCells(ctx)

createBunkerBuild(ctx)
installReflexes()

function wireWorldSeed () {
  for (const name of ['login', 'respawn']) {
    bot._client.on(name, (packet) => {
      const seed = (packet.worldState || packet).hashedSeed
      memory.worldSeed = seed == null ? '' : String(seed)
    })
  }
}

// ---- HTTP control layer ----
// Follow waits while a pilot route runs.
const { app, verbs } = createApp({ token: GOLEM_TOKEN, port: CTRL_PORT, chat: { send: (text) => bot.chat(text), maxLen: chatMaxLen(process.env.GOLEM_CHAT_MAX) }, onRequest: deaths.watch })
ctx.verbs = verbs
createReply(ctx)
createDebugRoutes(ctx)
const { installDebugRoutes } = ctx
createSocialRoutes(ctx)
const { installSocialRoutes } = ctx
createBuildingRoutes(ctx)
const { installBuildingRoutes } = ctx
createMemoryRoutes(ctx)
const { installMemoryRoutes } = ctx
createFightingRoutes(ctx)
const { installFightingRoutes } = ctx
createMovingRoutes(ctx)
const { installMovingRoutes } = ctx
createSeeingRoutes(ctx)
const { installSeeingRoutes } = ctx
createWorkingRoutes(ctx)
const { installWorkingRoutes } = ctx

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
  wireUnstuckHeartbeat()
}
// Priority order: lava_watch, bunker, combat, unstuck, current_watch, narrator, trek, flee_to_player.
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
function installRoutes () {
  installDebugRoutes(app)
  installSocialRoutes(app)
  installBuildingRoutes(app)
  installMemoryRoutes(app)
  installFightingRoutes(app)
  installMovingRoutes(app)
  installSeeingRoutes(app)
  installWorkingRoutes(app)
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
  bindReply(ctx)
  bindDebugRoutes(ctx)
  bindSocialRoutes(ctx)
  bindBuildingRoutes(ctx)
  bindMemoryRoutes(ctx)
  bindFightingRoutes(ctx)
  bindMovingRoutes(ctx)
  bindSeeingRoutes(ctx)
  bindWorkingRoutes(ctx)
}
bindAll()
wireRuntime()
installRoutes()
app.listen(CTRL_PORT, '127.0.0.1', (e) => {
  if (e) {
    console.error(`[bot] control API cannot listen on 127.0.0.1:${CTRL_PORT}: ${e.message}`)
    process.exit(1)
  }
  console.log(`[bot] control API on http://127.0.0.1:${CTRL_PORT}`)
})
