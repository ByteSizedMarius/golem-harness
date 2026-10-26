'use strict'

const { Movements } = require('mineflayer-pathfinder')
const { smoothLook } = require('../head')
const { installGaze } = require('../gaze')
const { pacePlacements } = require('../pace')
const { renameBlocks } = require('../server-overrides')
const { SERVER_OVERRIDES } = require('./config')

let bot, knownMoves, navPlaced, startReflexes, vecStr, emitEvent, waterState, takeLegs, swimUp, round, entityPerceptible, reflexes, liveEntities, nightfall, watchGoto, leaveBedFirst, mobClass, perch

const shared = {}
shared.mcData = null
shared.ready = false
shared.considerateMoves = null    // the default no-dig profile
shared.forestryMoves = null       // the profile /gather swaps in for wood

function wireConnectionSpawn () {
  bot.once('spawn', () => {
    shared.mcData = require('minecraft-data')(bot.version)
    // bot.registry shares these block entries.
    if (SERVER_OVERRIDES) renameBlocks(shared.mcData, SERVER_OVERRIDES.blocks)
    const moves = knownMoves(new Movements(bot))
    // ---- CONSIDERATE PLAYER: don't vandalize builds/terrain, don't litter ----
    moves.canDig = false            // NEVER break blocks to travel — protects your house AND the
                                    // landscape (no tunneling shortcuts). NB: collectBlock swaps in
                                    // its own dig-legs — collectSafely() cages that (07-20).
    moves.maxDropDown = 4           // the feet drop at most 3 blocks
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
    const addDoors = (m) => { shared.mcData.blocksArray.forEach(b => { if (b.name.endsWith('_door') && !b.name.includes('iron')) m.openable.add(b.id) }); m.canOpenDoors = true }
    addDoors(moves)
    moves.infiniteLiquidDropdownDistance = false   // a drop into water is held to maxDropDown too
    bot.pathfinder.setMovements(moves)
    shared.thinkTimeout = 10000           // the default /gather restores after forestry
    bot.pathfinder.thinkTimeout = shared.thinkTimeout
    shared.considerateMoves = moves       // remember the default so /gather can restore it after forestry

    // ---- FORESTRY profile: a lumberjack's legs. Same considerate base, but permitted to break
    // ONLY leaves and logs to travel — so it clears canopy to reach trunks and can always chew a
    // leaf to free itself from a foliage wedge. Every other block (stone, dirt, ore, sand, and
    // every plank/door/block of your builds) stays UNbreakable, so the no-tunnel / no-x-ray
    // fairness floor is exactly as before. Swapped in only while /gather is harvesting wood.
    shared.forestryMoves = knownMoves(new Movements(bot))
    shared.forestryMoves.canDig = true
    shared.forestryMoves.maxDropDown = 3          // the feet drop at most 2 blocks
    shared.forestryMoves.infiniteLiquidDropdownDistance = false
    shared.forestryMoves.allow1by1towers = false
    shared.forestryMoves.allowParkour = true
    shared.forestryMoves.scafoldingBlocks = []          // still zero litter — never places blocks to travel
    const cantBreak = new Set()
    for (const blk of shared.mcData.blocksArray) {
      if (/(_log|_wood|_leaves)$/.test(blk.name)) continue   // leaves + logs are the ONLY breakables
      cantBreak.add(blk.id)
    }
    shared.forestryMoves.blocksCantBreak = cantBreak
    addDoors(shared.forestryMoves)                      // lumberjack legs get the same door manners

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

    shared.ready = true
    startReflexes()                     // start the always-on reflex loop (unstuck, +survival reflexes later)
    console.log(`[bot] spawned as ${bot.username} on ${bot.version} at`, vecStr(bot.entity.position))

    // ---- event listeners: fire emitEvent for driver-interrupting conditions, each deduped ----
    try {
      const warnedMobs = new Set()   // entity ids already warned about, so a lingering mob isn't re-fired
      let nightFired = false
      let critHealthFired = false
      const lastDrown = { alarm: -Infinity, reflex: -Infinity }

      bot.on('health', () => {
        try {
          const h = bot.health
          if (typeof h === 'number') {
            if (h <= 6 && !critHealthFired) {
              critHealthFired = true
              emitEvent('health_critical', `health critical: ${h.toFixed(1)}`, { health: h })
            } else if (h > 6) {
              critHealthFired = false   // re-arm once recovered
            }
          }
        } catch (e) {}
      })

      // breath event: fires when oxygen changes. Alarm ONLY on REAL drowning — a VALID low reading
      // (0..12; bot.oxygenLevel returns junk like -1 sometimes) AND actually SUBMERGED (head in water).
      // The old version fired on the junk reading alone, screaming at a bone-dry Claude; the submersion
      // gate kills that.
      bot.on('breath', () => {
        try {
          const o2 = bot.oxygenLevel
          if (typeof o2 !== 'number' || o2 < 0 || o2 > 12) return    // ignore junk (-1) + healthy readings
          const ws = waterState()
          if (!ws || !ws.submerged) return                           // not actually underwater → no alarm
          drownReflex(o2, lastDrown)
        } catch (e) {}
      })

      // warn once when a hostile mob is within ~16 blocks (via spawn event AND the slow scan below)
      const considerMob = (en) => {
        try {
          if (!en || en === bot.entity || !en.position || !bot.entity) return
          const nm = (en.name || '').toLowerCase()
          if (!['hostile', 'creeper', 'heavy'].includes(mobClass(en))) return
          if (warnedMobs.has(en.id)) return
          const d = en.position.distanceTo(bot.entity.position)
          if (d <= 16) {
            // FAIRNESS (07-16, caught from inside a sealed night shelter: this alarm quoted live
            // distances to skeletons through the dirt wall — raw-entity x-ray, the same leak-class
            // as the combat watcher's). A distance-quoting alarm is SIGHT-class perception: shared
            // air required (sealed hostiles may still be HEARD — ears are server-fair). NOT marked
            // warned when gated, so the alarm still fires the moment the wall opens.
            try { if (!entityPerceptible(en, reflexes.find(r => r.name === 'combat').fairFill(bot))) return } catch (e) { return }
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
          nightFired = nightfall(nightFired)
        } catch (e) {}
      }, 2000)
    } catch (e) { console.log('[bot] event listeners failed (non-fatal):', e.message) }
  })
}

// How long after a running pillar's last level the drown reflex leaves it the legs.
const PILLAR_RISE_MS = 3000
// The oxygen at which the drown reflex takes the legs from a rising pillar too.
const PILLAR_MIN_O2 = 3
// The drowning alarm and the full drown reflex each repeat at most this often.
const DROWN_REPEAT_MS = 3000

// last holds when the alarm went out and when the reflex last ran in full.
function drownReflex (o2, last) {
  const now = Date.now()
  if (now - last.alarm >= DROWN_REPEAT_MS) {
    last.alarm = now
    emitEvent('drowning', `DROWNING — oxygen ${o2}/20, get to air NOW`, { oxygen: o2, health: bot.health })
  }
  // A rising pillar climbs to air on its own.
  if (o2 > PILLAR_MIN_O2 && now - perch.rose < PILLAR_RISE_MS) return
  // SURVIVAL REFLEX (07-17, drowned to 2HP mid-dig): an active dig pins the body underwater
  // and nothing else lets go. Abort the dig and swim — air first, apologies after.
  if (o2 <= 8 && now - last.reflex >= DROWN_REPEAT_MS) {
    last.reflex = now
    try { bot.stopDigging() } catch (e) {}
    takeLegs('drown', 'swim up')
    try { bot.pathfinder.setGoal(null) } catch (e) {}
    try { swimUp(4000) } catch (e) {}
    emitEvent('drowning', 'drown reflex: dig aborted, swimming up', {})
  }
}

function wireConnectionEvents () {
  bot.on('kicked', (r) => console.log('[bot] kicked:', r))
  bot.on('error', (e) => console.log('[bot] error:', e.message))
  // The connection dying MUST kill the process: the watchdog only relaunches on process death,
  // and a live control API over a dead socket serves stale world state with ok:true (ghost mode).
  bot.on('end', (r) => {
    console.log('[bot] disconnected:', r, '— exiting so the watchdog can relaunch')
    setTimeout(() => process.exit(1), 500)
  })
}

function wireLookPaceGoto () {
  bot.once('spawn', () => {
    const combat = reflexes.find(r => r.name === 'combat')
    const gaze = installGaze(bot)
    bot.look = smoothLook(bot, bot.look, () => combat.active, gaze.hold)
    bot._genericPlace = pacePlacements(bot._genericPlace)
    bot.pathfinder.goto = watchGoto(bot.pathfinder.goto)
    bot.pathfinder.setGoal = leaveBedFirst(bot.pathfinder.setGoal)
  })
}

function createConnection (ctx) {
  Object.assign(ctx, { shared })
}

function bindConnection (ctx) {
  ({ bot, knownMoves, navPlaced, startReflexes, vecStr, emitEvent, waterState, takeLegs, swimUp, round, entityPerceptible, reflexes, liveEntities, nightfall, watchGoto, leaveBedFirst, mobClass, perch } = ctx)
}

module.exports = { createConnection, bindConnection, wireConnectionSpawn, wireConnectionEvents, wireLookPaceGoto }
