// Golem — a Mineflayer body for language-model pilots
// Structured perception and actions over a small HMAC-signed HTTP API.

// The control API's HMAC key.
const GOLEM_TOKEN = process.env.GOLEM_TOKEN || ''
if (GOLEM_TOKEN.length < 32) {
  console.error('[bot] GOLEM_TOKEN is missing or shorter than 32 characters, refusing to start')
  process.exit(1)
}
delete process.env.GOLEM_TOKEN   // before any module loads

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const armorManager = require('mineflayer-armor-manager')
const { chatMaxLen } = require('./lib/install')
const { HOST, PORT, VERSION, USERNAME, CTRL_PORT, LEGACY_1710 } = require('./lib/bot/config')
const { createApp } = require('./lib/app')
const { createContext } = require('./lib/context')
const { createStreams, bindStreams, wireChatCapture, wireServerMessages } = require('./lib/bot/streams')
const { createItems, bindItems, wireLegacyDigTime } = require('./lib/bot/items')
const { createSight, bindSight, wireLightChanges, wireLightReload, wireLightPackets, wireSightMemoDrops, wireGroundTopForget, wireSkyInSightRefresh } = require('./lib/bot/sight')
const { createDescribe, bindDescribe, wireIndoorsReset } = require('./lib/bot/describe')
const { createLane, bindLane } = require('./lib/bot/lane')
const { createMemory, bindMemory, wireWorldSeed, wireSeenWorld, wireSeenSave } = require('./lib/bot/memory')
const { createReflexes, bindReflexes } = require('./lib/bot/reflexes')
const { createLegs, bindLegs, wirePlanKnownReset, wireGateManners, wireLivePath, wirePathfinderTicks, wirePathLog } = require('./lib/bot/legs')
const { createJobBoard, bindJobBoard } = require('./lib/bot/jobs')
const { createFollow, bindFollow } = require('./lib/bot/follow')
const { bindPointing, wirePointing } = require('./lib/bot/pointing')
const { createAwareness, bindAwareness, wireStaleEntities, wireCrumbRecording, wireCrumbForget, wirePresenceTick } = require('./lib/bot/awareness')
const { createOnline, bindOnline, wireOnline } = require('./lib/bot/online')
const { createUnstuck, bindUnstuck, wireUnstuckHeartbeat } = require('./lib/bot/unstuck')
const { createPlacing, bindPlacing } = require('./lib/bot/placing')
const { createWatchReflexes, bindWatchReflexes } = require('./lib/bot/watch-reflexes')
const { createBunkerCells, bindBunkerCells } = require('./lib/bot/bunker-cells')
const { createBunkerBuild, bindBunkerBuild } = require('./lib/bot/bunker-build')
const { createCombat, bindCombat, wireDamageTypes, wireGuardDrop, wireHandLease, wireItemUseCosts, wireArmSwings, wireArrowTracking, wireDamageAttribution, wireFloodDrops, wireMobHurt } = require('./lib/bot/combat')
const { createBunker, bindBunker, wireThreatReset } = require('./lib/bot/bunker')
const { createSenses, bindSenses, wireSoundTablePin, wireHearing, wireOwnEditStamps, wireWorldChangeNotes, wireWorldChangeEvents, wireOreCallout } = require('./lib/bot/senses')
const { createAlarms, bindAlarms, wireWearAlarm, wirePocketAlarm, wireTrailMarks, wireBodyAlarms } = require('./lib/bot/alarms')
const { createConnection, bindConnection, wireConnectionSpawn, wireConnectionEvents, wireLookPaceGoto } = require('./lib/bot/connection')
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

// Connection hardening adapted from Mindcraft's mcdata.js (MIT, https://github.com/kolbytn/mindcraft).
// Move packets go out at most once per 50 ms. A PartialReadError the client emits is logged and dropped.
function wireConnectionHardening () {
  try {
    const _write = bot._client.write.bind(bot._client)
    let lastPos = 0, posTimer = null, pending = null
    const flush = () => {
      posTimer = null
      lastPos = Date.now()
      const { name, data } = pending
      pending = null
      return _write(name, data)
    }
    bot._client.write = (name, data) => {
      if (name !== 'position' && name !== 'position_look' && name !== 'look') return _write(name, data)
      // A burst inside one window goes out as one packet with its newest position, look and flags.
      if (!pending || pending.name === name || name === 'position_look') pending = { name, data }
      else {
        const merged = { ...pending.data, ...data }
        for (const k of name === 'look' ? ['x', 'y', 'z'] : ['yaw', 'pitch']) merged[k] = pending.data[k]
        pending = { name: 'position_look', data: merged }
      }
      const dt = Date.now() - lastPos
      if (dt >= 50) {
        clearTimeout(posTimer)
        return flush()
      }
      if (!posTimer) posTimer = setTimeout(flush, 50 - dt)
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

createLegs(ctx)

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

createPlacing(ctx)

createSight(ctx)

createAlarms(ctx)

createSenses(ctx)

createCombat(ctx)
const { combatReflex, fleeToPlayerReflex } = ctx
createLane(ctx)

createBunker(ctx)
const { bunkerReflex } = ctx

createAwareness(ctx)

createOnline(ctx)

createFollow(ctx)

createBunkerCells(ctx)

createBunkerBuild(ctx)
installReflexes()

// ---- HTTP control layer ----
// Follow waits while a pilot route runs.
const { app, verbs } = createApp({ token: GOLEM_TOKEN, port: CTRL_PORT, chat: { send: (text) => bot.chat(text), maxLen: chatMaxLen(process.env.GOLEM_CHAT_MAX, LEGACY_1710) }, onRequest: deaths.watch })
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
const { installFightingRoutes, installFightGate } = ctx
createMovingRoutes(ctx)
const { installMovingRoutes } = ctx
createSeeingRoutes(ctx)
const { installSeeingRoutes } = ctx
createWorkingRoutes(ctx)
const { installWorkingRoutes } = ctx

function wireEarly () {
  wireConnectionHardening()
}
function wireRuntime () {
  wireLightPackets()
  wireDamageTypes()
  wireWorldSeed()
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
  wireSkyInSightRefresh()
  wireWearAlarm()
  wireSoundTablePin()
  wireHearing()
  wireOwnEditStamps()
  wireLegacyDigTime()
  wireLookPaceGoto()
  wireGateManners()
  wireWorldChangeNotes()
  wireWorldChangeEvents()
  wirePocketAlarm()
  wireTrailMarks()
  wireBodyAlarms()
  wireGuardDrop()
  wireHandLease()
  wireItemUseCosts()
  wireArmSwings()
  wirePointing()
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
  wireOnline()
  wireMobHurt()
  wireLivePath()
  wirePathfinderTicks()
  wirePathLog()
  wireUnstuckHeartbeat()
}
// Priority order: lava_watch, bunker, combat, unstuck, current_watch, narrator, trek, flee_to_player.
function installReflexes () {
  reflexes.push(lavaWatchReflex, bunkerReflex, combatReflex, unstuckReflex, currentWatchReflex, narratorReflex, trekReflex, fleeToPlayerReflex)
}
function installRoutes () {
  installFightGate(app)
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
  bindPointing(ctx)
  bindAwareness(ctx)
  bindOnline(ctx)
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
