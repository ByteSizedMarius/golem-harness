'use strict'

const { Vec3 } = require('vec3')
const { mobFamily, babyFlag, expireConfirmed } = require('../shelter')
const { hurtWindows, noCritReason, runCells, noRunReason, JUMP_FALL_TICKS, JUMP_TICKS, RUN_MAX, RUN_TICKS, RUN_COAST, SWING_REACH, HITBOX_1710 } = require('../pace')
const { isDoor } = require('../doors')
const { LEGACY_1710, LEGACY_HIT_MS } = require('./config')
const { routeWithin, creeperCover, planFlee } = require('../flee')
const { takenText } = require('../legs')
const { goals } = require('mineflayer-pathfinder')
const { headFree } = require('../head')

let bot, losClear, reflexes, shared, liveEntities, entityPerceptible, compass, fight, perchHolds, knownCell, OPENABLE, lineCell, ck, cellKnown, holdsWater, touchesFill, emitEvent, laneBlocks, laneNarrate, takeLegs, stopPath, gridWalk, airFlood, bunker, holdRun, strikeRun, yieldJob, refuelAfterFight

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
  skirmish: { fleeDist: 8,  bowBand: [4, 24],  chase: false, engage: 'closers',   note: 'fire support: bow-first from the perch, creepers shot from 8 out' },
  vanguard: { fleeDist: 12, bowBand: [10, 24], chase: true,  engage: 'closers',   note: 'clear the room: run melee targets down, bow only the far ones' },
  sentinel: { fleeDist: 16, bowBand: [7, 24],  chase: false, engage: 'confirmed', note: 'work detail: ignore posturing, fight only what actually hits me' }
}
// One full bow cycle at target, false when nothing was loosed.
async function drawAndLoose (target) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (!bow || !bot.inventory.items().some(i => i.name === 'arrow')) return false
  // NO LOS, NO LOOSE (07-17, ten arrows into a wall: a skeleton in a sealed neighbor pocket was
  // PERCEPTIBLE by connected air — fair for awareness, like hearing — but the reflex treated
  // "perceptible" as "shootable". A firing solution needs an actual clear eye-ray.)
  if (!bowLine(target)) return false
  const alreadyHeld = bot.heldItem && bot.heldItem.name === 'bow'
  await bot.equip(bow, 'hand')
  if (!alreadyHeld) await bot.waitForTicks(4)
  const dist = target.position.distanceTo(bot.entity.position)
  const aim = () => target.position.offset(0, 1.0 + dist * 0.018, 0)   // chest-height + hold-over
  await bot.lookAt(aim(), true)
  await bot.waitForTicks(2)                       // the tick race, as ever
  bot.activateItem()                              // draw...
  try {
    await new Promise(r => setTimeout(r, 1150))   // ...full charge
    if (!bot.entities[target.id]) return true
    // A target out of line or out of sight is loosed at the last aim.
    if (bowLine(target) && entityPerceptible(target, reflexes.find(r => r.name === 'combat').fairFill(bot))) {
      await bot.lookAt(aim(), true)               // re-aim in case the target shuffled
      await bot.waitForTicks(2)
    }
  } finally {
    bot.deactivateItem()
  }
  return true
}
// True when the eyes have a clear line to the chest of target.
function bowLine (target) {
  return losClear(bot.entity.position.offset(0, 1.62, 0), target.position.offset(0, 1.0, 0))
}
const AGGRO_CONFIRMED = new Map()          // entityId -> {name, t} — fed by damage attribution
// How far a mob that hit the body stays a threat.
const CONFIRMED_HORIZON = 48
// How long a mob that hit the body stays confirmed.
const CONFIRMED_MS = 45000
// The raised guard (shield, or the 1.7.10 sword block), slot the hotbar slot it rose in, pilot set by /guard.
const guardState = { up: false, slot: -1, pilot: false }
// A 1.7.10 sword block ends once another hotbar slot or anything but a sword is in hand.
function wireGuardDrop () {
  bot.on('heldItemChanged', (item) => {
    if (!LEGACY_1710) return
    const sword = !!item && /_sword$/.test(item.name)
    if (bot.quickBarSlot !== guardState.slot || !sword) guardState.up = false
    if (!sword && !reflexes.find(r => r.name === 'combat').active) guardState.pilot = false
  })
}
const MOVES = ['forward', 'back', 'left', 'right', 'sprint']
function legsMoving () {
  return MOVES.some(c => bot.controlState[c])
}
// Moving or attacking lowers the guard, and an eat, drink or bow draw holds the legs and drops attacks.
function itemUseCosts () {
  // The moves held back during an eat, a drink or a bow draw, else null.
  let paused = null
  const usedOverTime = (item) => !!item && (/^(bow|potion|milk_bucket)$/.test(item.name) || !!(shared.mcData && shared.mcData.foods[item.type]))
  const setControlState = bot.setControlState.bind(bot)
  const pause = () => {
    if (paused) return
    lowerGuard()
    paused = Object.fromEntries(MOVES.map(c => [c, !!bot.controlState[c]]))
    for (const c of MOVES) setControlState(c, false)
  }
  const resume = () => {
    const held = paused
    paused = null
    for (const c of MOVES) if (held && held[c]) bot.setControlState(c, true)
  }
  bot.setControlState = (control, state) => {
    if (MOVES.includes(control)) {
      if (paused) { paused[control] = state; return }
      if (state) lowerGuard()
    }
    return setControlState(control, state)
  }
  const attack = bot.attack.bind(bot)
  bot.attack = (...a) => {
    if (paused) return
    lowerGuard()
    return attack(...a)
  }
  const activateItem = bot.activateItem.bind(bot)
  bot.activateItem = (offHand = false) => {
    const pausing = !paused && usedOverTime(offHand ? bot.inventory.slots[45] : bot.heldItem)
    if (pausing) pause()
    try {
      return activateItem(offHand)
    } catch (e) {
      if (pausing) resume()
      throw e
    }
  }
  const deactivateItem = bot.deactivateItem.bind(bot)
  bot.deactivateItem = () => {
    try {
      return deactivateItem()
    } finally {
      resume()
    }
  }
  const consume = bot.consume.bind(bot)
  bot.consume = async () => {
    pause()
    try {
      return await consume()
    } finally {
      resume()
    }
  }
}
function wireItemUseCosts () {
  bot.once('spawn', itemUseCosts)
}
function lowerGuard () {
  if (!guardState.up) return
  try { bot.deactivateItem() } catch (e) {}
  guardState.up = false
}
function mobClass (e) {
  if (!e || !e.name) return 'other'
  if (e.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === e))) return 'player'
  if (e.name === 'creeper') return 'creeper'
  if (HEAVY_MELEE.has(e.name)) return 'heavy'
  if (PROVOKABLE.has(e.name)) return 'provokable'
  const d = shared.mcData && shared.mcData.entitiesByName[e.name]
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
// True once a damage_event named a type the registry lacks.
let damageTypeMissed = false
// Each player's last arm swing by entity id: when it came (t), when the one before it came (prev),
// and the player's yaw as it swung.
const lastSwing = new Map()
function wireArmSwings () {
  bot.on('entitySwingArm', (e) => {
    if (e && e.type === 'player') lastSwing.set(e.id, { t: Date.now(), prev: (lastSwing.get(e.id) || { t: 0 }).t, yaw: e.yaw })
  })
  bot.on('entityGone', (e) => { if (e) lastSwing.delete(e.id) })
}
// How far apart in ms a player's hit and its arm swing may arrive, in either order.
const SWING_MS = 50
// A swing counts only this many ms or more after the same player's previous one, which leaves out fast clicking.
const SWING_GAP_MS = 300
// How far in radians a swinger's facing may point past the bot.
const SWING_FACING = Math.PI / 4
// The players the body perceives within 4 blocks who stand no farther from the bot than hostile.
function playersNear (hostile) {
  const here = bot.entity.position
  const reach = hostile ? hostile.position.distanceTo(here) : 4
  const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
  return liveEntities().filter(e => e.type === 'player' && e.position &&
    e.position.distanceTo(here) <= reach && entityPerceptible(e, fill))
}
// True when yaw, the facing of e, points at the bot within SWING_FACING.
function facesBot (e, yaw) {
  const d = bot.entity.position.minus(e.position)
  const off = ((yaw - Math.atan2(-d.x, -d.z)) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI
  return Math.abs(off) <= SWING_FACING
}
// Arrows by entity id: the entity, where it appeared (from), when (t) and when it vanished (gone, 0 while it flies).
const arrows = new Map()
// An arrow flies at most ARROW_FLIGHT_MS and vanishes within ARROW_HIT_MS of the hit it makes, before or after it.
const ARROW_FLIGHT_MS = 5000
const ARROW_HIT_MS = 300
// The skeleton family, and how far a skeleton shoots.
const SHOOTERS = new Set(['skeleton', 'stray', 'bogged'])
const ARROW_RANGE = 15
const ARROWS = new Set(['arrow', 'spectral_arrow'])
// How far from the shooter's eye an arrow appears.
const ARROW_LOOSE = 2
function wireArrowTracking () {
  bot.on('entitySpawn', (e) => {
    if (!e || !ARROWS.has(e.name) || !bot.entity) return
    const now = Date.now()
    for (const [id, a] of arrows) if (now - a.t > ARROW_FLIGHT_MS + ARROW_HIT_MS) arrows.delete(id)
    // The body's own arrows leave from its eyes.
    if (e.position.distanceTo(bot.entity.position.offset(0, 1.62, 0)) < 2) return
    arrows.set(e.id, { e, from: e.position.clone(), t: now, gone: 0 })
  })
  bot.on('entityGone', (e) => {
    const a = e && arrows.get(e.id)
    if (a && !a.gone) a.gone = Date.now()
  })
}
// True when arrow a appeared within shooting range of the body.
function arrowInRange (a) {
  return a.from.distanceTo(bot.entity.position) <= ARROW_RANGE + 1
}
// The arrows in range that appeared up to ARROW_FLIGHT_MS before a hit at t and vanished within ARROW_HIT_MS of it.
function arrowsOf (t) {
  return [...arrows.values()].filter(a => a.t <= t && t - a.t <= ARROW_FLIGHT_MS && a.gone && Math.abs(a.gone - t) <= ARROW_HIT_MS && arrowInRange(a))
}
// Credits the arrow hit at t to its shooter when perceived, else to the arrow's seen bearing.
function arrowAttrib (arrow, t, cause) {
  const here = bot.entity.position
  const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
  const shooter = cause && entityPerceptible(cause, fill) ? cause : liveEntities()
    .filter(e => SHOOTERS.has(e.name) && e.position && e.position.distanceTo(here) <= ARROW_RANGE &&
      arrow.from.distanceTo(e.position.offset(0, e.height * 0.85, 0)) <= ARROW_LOOSE &&
      facesBot(e, e.headYaw ?? e.yaw) && entityPerceptible(e, fill))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
  if (shooter) {
    const dir = compass(shooter.position.x - here.x, shooter.position.z - here.z)
    return { t, desc: `${shooter.username || shooter.name} ${dir} ~${Math.round(shooter.position.distanceTo(here))} (arrow)`, entity: shooter, ranged: true }
  }
  const seen = [arrow.from, arrow.e.position].find(p => p.distanceTo(here) > 2 && entityPerceptible({ position: p }, fill))
  return { t, desc: seen ? `hit by an arrow from ${compass(seen.x - here.x, seen.z - here.z)}` : 'hit by an arrow', entity: null, ranged: true }
}
// The hit at t as an arrow hit, or null.
function arrowHitOf (t, sourceless, direct, cause) {
  if (sourceless) {
    const hits = arrowsOf(t).map(arrow => arrowAttrib(arrow, t, null))
    return hits.find(a => a.entity) || hits[0] || null
  }
  if (!direct || !ARROWS.has(direct.name)) return null
  return arrowAttrib(arrows.get(direct.id) || { e: direct, from: direct.position }, t, cause)
}
// the wire: 1.21.11 sends damage_event with sourceCauseId = attacker entityId + 1 (0 = none).
// Validation ritual (the helmsman's design): he punches the machine for science, we expect his name.
function wireDamageAttribution () {
  bot.once('spawn', () => {
    try {
      // t is when the damage_event arrived. waited is true once a swing can no longer follow it.
      const onDamage = (packet, t, waited) => {
        try {
          if (!bot.entity || packet.entityId !== bot.entity.id) return
          const causeId = (packet.sourceCauseId || 0) - 1
          const directId = (packet.sourceDirectId || 0) - 1
          const type = fight.damageTypes[packet.sourceTypeId]
          if (type === undefined && !damageTypeMissed) {
            damageTypeMissed = true
            console.log(`[combat] damage type ${packet.sourceTypeId} is not in the registry, a hit without a source counts as environmental`)
          }
          const noSource = causeId < 0 && directId < 0
          // Every 1.7.10 hit through Via is sourceless, a mob's included.
          const sourceless = noSource && type === 'generic'
          // After the swing wait, a non-env attribution of a later hit stays in place.
          const newer = waited && fight.lastAttrib && !fight.lastAttrib.env && fight.lastAttrib.t > t
          const hostile = sourceless ? nearestHostile() : undefined
          // A sourceless hit is a player's when that player swung within SWING_MS of it, alone and facing
          // the bot, with no hostile closer to the bot. The swing nearest in time wins.
          const near = sourceless ? playersNear(hostile) : []
          const swing = near.map(e => ({ e, s: lastSwing.get(e.id) }))
            .filter(({ e, s }) => s && Math.abs(s.t - t) <= SWING_MS && s.t - s.prev >= SWING_GAP_MS && facesBot(e, s.yaw))
            .sort((a, b) => Math.abs(a.s.t - t) - Math.abs(b.s.t - t))[0]
          if (swing) {
            const name = swing.e.username || 'a player'
            if (!newer) fight.lastAttrib = { t, desc: `no attacker named, ${name} swung nearby`, entity: null, ranged: false, env: true }
            console.log(`[combat] sourceless hit, ${name} swung nearby`)
            return
          }
          // The swing of a player beside the bot may still follow, and an arrow in flight may vanish.
          const flying = sourceless && [...arrows.values()].some(a => !a.gone && t - a.t <= ARROW_FLIGHT_MS && arrowInRange(a))
          if ((near.length || flying) && !waited) {
            const wait = new Promise(r => setTimeout(r, flying ? ARROW_HIT_MS : SWING_MS)).then(() => {
              if (fight.swingWait === wait) fight.swingWait = null
              onDamage(packet, t, true)
            })
            fight.swingWait = wait
            return
          }
          const cause = sourceless ? hostile : causeId >= 0 ? bot.entities[causeId] : null
          const direct = directId >= 0 ? bot.entities[directId] : null
          const a = arrowHitOf(t, sourceless, direct, cause)
          if (a) {
            if (!newer) fight.lastAttrib = a
            if (a.entity) AGGRO_CONFIRMED.set(a.entity.id, { name: a.entity.username || a.entity.name, t: Date.now(), ranged: true })
            console.log(`[combat] attributed: ${a.entity ? 'hit by ' : ''}${a.desc}`)
            return
          }
          // PROJECTILE TELL (07-23, death #9: the events said "zombie E ~33" while something plinked
          // me at bow range — almost certainly a skeleton wearing a misattributed name. Whatever the
          // cause entity claims to be, cause≠direct means the hit ARRIVED as a projectile, and the
          // response must be ranged doctrine regardless of the name on the shaft.)
          const ranged = !!(direct && (!cause || direct.id !== cause.id))
          if (!cause) {
            if (ranged) fight.lastAttrib = { t, desc: 'projectile, shooter unseen', entity: null, ranged: true }
            // An attacker the bot doesn't track leaves the hit unattributed.
            else if (!noSource) fight.lastAttrib = null
            // env marks a hit without a source entity. Such a hit keeps a fresh attribution to an attacker,
            // and a lava, fire or fall hit marks it envHit, so the hit can't arm the bunker.
            else if (fight.lastAttrib && !fight.lastAttrib.env && Date.now() - fight.lastAttrib.t < 1500) {
              if (!sourceless) fight.lastAttrib = { ...fight.lastAttrib, envHit: true }
            } else {
              fight.lastAttrib = { t, desc: sourceless ? 'no attacker named, no hostile within 4' : type || 'no attacker named', entity: null, ranged: false, env: true }
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
          if (!newer) fight.lastAttrib = { t, desc: `${who} ${dir} ~${dist}${how}`, entity: cause, ranged: ranged || wasRanged }
          AGGRO_CONFIRMED.set(cause.id, { name: who, t: Date.now(), ranged: ranged || wasRanged })
          console.log(`[combat] attributed: hit by ${who} ${dir} ~${dist}${how}`)
        } catch (e) {}
      }
      bot._client.on('damage_event', (packet) => onDamage(packet, Date.now(), false))
      console.log('[bot] damage attribution wired')
    } catch (e) { console.log('[bot] damage attribution wire failed: ' + e.message) }
  })
}

// True on a pillar top, or on ground whose 8 neighbours each drop 3 known cells or wall off feet and head.
function perched () {
  if (perchHolds()) return true
  if (!bot.entity.onGround) return false
  const feet = bot.entity.position.floored()
  const at = (dx, dy, dz) => {
    const p = feet.offset(dx, dy, dz)
    const b = bot.blockAt(p)
    return b && knownCell(p) ? b : null
  }
  const open = (b) => !!b && b.boundingBox === 'empty' && !/ladder|vine/.test(b.name)
  const wall = (b) => !!b && b.boundingBox === 'block'
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      if (![0, -1, -2].every(dy => open(at(dx, dy, dz))) && ![0, 1].every(dy => wall(at(dx, dy, dz)))) return false
    }
  }
  return true
}
// Melee mobs that cannot climb, besides the zombie family.
const PERCH_MELEE = new Set(['silverfish', 'endermite'])
// A zombie this far below the feet stays out of its reach.
const PERCH_DROP = 1.9
// True when the body stands perched at least PERCH_DROP above e standing at `at`, a melee mob that cannot climb.
function perchStrike (e, at = e.position) {
  if (mobFamily(e.name) !== 'zombie' && !PERCH_MELEE.has(e.name)) return false
  return bot.entity.position.y - at.y >= PERCH_DROP && perched()
}
// True when known blocks or closed doors flank feet and head on both sides along one axis.
function inChokepoint () {
  const feet = bot.entity.position.floored()
  const shut = (p) => {
    const b = bot.blockAt(p)
    if (!b || !knownCell(p)) return false
    if (isDoor(b.name)) return !b.getProperties().open
    return b.boundingBox === 'block' && !OPENABLE.test(b.name)
  }
  return [[1, 0], [0, 1]].some(([dx, dz]) => [0, 1].every(up => shut(feet.offset(dx, up, dz)) && shut(feet.offset(-dx, up, -dz))))
}
function hpMelee () {
  return meleeThreat() && bot.health < disengageHp(reflexes.find(r => r.name === 'combat')._threat.cls)
}
// The [width, height] of en's hitbox on the server, half size for a baby, times its size for a slime or magma cube.
function hitbox (en) {
  const data = shared.mcData && shared.mcData.entitiesByName[en.name]
  const keys = data && data.metadataKeys
  const s = Array.isArray(keys) && keys.some(k => k === 'baby' || k === 'is_baby') && babyFlag(en.metadata, keys) ? 0.5 : 1
  // Size 1 until the metadata arrives.
  const size = (['slime', 'magma_cube'].includes(en.name) && Array.isArray(keys) && en.metadata && en.metadata[keys.indexOf('size')]) || 1
  const [w, h] = (LEGACY_1710 && HITBOX_1710[en.name]) || [en.width, en.height]
  return [w * s * size, h * s * size]
}
// The point a melee swing at en aims at: aimY above its feet, or half its height when aimY clears its top.
function meleeAim (en, aimY) {
  const h = hitbox(en)[1]
  return en.position.offset(0, aimY < h ? aimY : h / 2, 0)
}
// True when the look ray to meleeAim(en, aimY) enters en's hitbox, grown 0.1, within SWING_REACH and unblocked.
function inMeleeReach (en, aimY = 1.2) {
  const [w, h] = hitbox(en)
  const r = w / 2 + 0.1
  const lo = en.position.offset(-r, -0.1, -r)
  const hi = en.position.offset(r, h + 0.1, r)
  // A 1.7.10 sneak lowers the eye by 0.08, a 1.21.11 one to 1.27.
  const eye = bot.entity.position.offset(0, !bot.entity.crouching ? 1.62 : LEGACY_1710 ? 1.54 : 1.27, 0)
  const dir = meleeAim(en, aimY).minus(eye)
  // With the aim point inside the box, the ray enters at its last near-face crossing.
  let enter = 0
  for (const k of ['x', 'y', 'z']) {
    if (dir[k]) enter = Math.max(enter, ((dir[k] > 0 ? lo : hi)[k] - eye[k]) / dir[k])
  }
  return enter * dir.norm() <= SWING_REACH && !!lineCell(eye, eye.plus(dir.scaled(enter)), en.position.floored())
}
// True while the combat reflex's threat stands in melee reach.
function meleeThreat () {
  const combat = reflexes.find(r => r.name === 'combat')
  const t = combat && combat.on && combat._threat
  if (!t || !t.e || !bot.entities[t.e.id] || !bot.entity) return false
  return inMeleeReach(t.e)
}
// ADAPTIVE disengage (death #2 lesson): the tripwire scales to the last hit taken while
// it's FRESH (20s) — after a 1.4 drowned it sits at the old 8; after an 8.6 vindicator it
// becomes "any hit landed = disengage NOW", because two more of those is a corpse. Stale
// hits stop counting so one bad fight doesn't leave the spine cowardly for the whole day.
// Vanguard trusts the blade against light mobs (07-21, death #8: disengage-at-8 vs
// zombies meant sprint-thrash inside a ring instead of the two sword hits that kill
// one). Floor drops to 5 there; every other stance and class keeps the old 8.
function disengageHp (cls) {
  const hitRef = Date.now() - fight.lastHit.t < 20000 ? fight.lastHit.dmg : 0
  return Math.max(fight.stance === 'vanguard' && cls === 'hostile' ? 5 : 8, hitRef * 2.5)
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
// The cells as the body knows them, in the shape planFlee and routeWithin read.
function fleeWorld () {
  const kinds = new Map()
  const hazards = new Map()
  const covers = new Map()
  const memo = (map, x, y, z, read) => {
    const k = ck(x, y, z)
    if (!map.has(k)) map.set(k, read(new Vec3(x, y, z)))
    return map.get(k)
  }
  return {
    kind: (x, y, z) => memo(kinds, x, y, z, (p) => {
      const b = bot.blockAt(p)
      if (!b || !cellKnown(p)) return 'unknown'
      if (/lava|fire/.test(b.name)) return 'hazard'
      if (b.boundingBox === 'block') return b.shapes && b.shapes.some(s => s[4] > 1) ? 'tall' : 'solid'
      return holdsWater(b) ? 'water' : 'open'
    }),
    hazard: (x, y, z) => memo(hazards, x, y, z, (p) => {
      const b = bot.blockAt(p)
      return !!b && /lava|fire/.test(b.name) && cellKnown(p)
    }),
    cover: (x, y, z) => memo(covers, x, y, z, (p) => {
      const b = bot.blockAt(p)
      return !!b && cellKnown(p) && !!b.shapes && b.shapes.length === 1 && b.shapes[0].join() === '0,0,0,1,1,1'
    })
  }
}
// True while creeper e swells or burns an ignited fuse, as its metadata shows.
function creeperSwelling (e) {
  const keys = (shared.mcData && shared.mcData.entitiesByName.creeper && shared.mcData.entitiesByName.creeper.metadataKeys) || []
  const at = (key) => (e.metadata || [])[keys.indexOf(key)]
  return at('swell_dir') > 0 || at('is_ignited') === true
}
// The deepest drop a creeper route takes.
const CREEPER_DROP = 22
// True when creeper e walks to within 2 of the body in maxSteps steps or fewer over known cells.
function creeperRoute (from, maxSteps) {
  return routeWithin(fleeWorld(), from.floored(), bot.entity.position.floored(), maxSteps, CREEPER_DROP)
}
// A closing mob beyond GUARD_REACH blocks, or more than GUARD_STEPS steps away on foot, gets no standoff guard.
const GUARD_REACH = 6
const GUARD_STEPS = 10
// Whether the standoff guard goes up against e at distance d, and why: { up, why }.
function standoffGuard (e, d, closing, fill) {
  if (!entityPerceptible(e, fill)) return { up: false, why: 'out of sight' }
  if (mobFamily(e.name) === 'skeleton') {
    if (d > 15) return { up: false, why: 'a skeleton beyond 15' }
    return losClear(bot.entity.position.offset(0, 1.62, 0), e.position.offset(0, 1.62, 0))
      ? { up: true, why: 'a skeleton in sight within 15' }
      : { up: false, why: 'a skeleton out of line of sight' }
  }
  if (!closing) return { up: false, why: 'not closing' }
  if (d > GUARD_REACH) return { up: false, why: `closing beyond ${GUARD_REACH}` }
  return routeWithin(fleeWorld(), e.position.floored(), bot.entity.position.floored(), GUARD_STEPS, CREEPER_DROP)
    ? { up: true, why: `closing, a walk of at most ${GUARD_STEPS} steps to the body over seen cells` }
    : { up: false, why: `no walk of ${GUARD_STEPS} steps or less to the body over seen cells` }
}
function fleeLog (threat, ally, plan) {
  const at = (c) => `(${c.x},${c.y},${c.z})`
  const r = plan.rejected
  const rejected = `rejected ${r.edge} beside a drop or an unknown cell, ${r.lava} within 2 of lava or fire, ${r.mob} too near a mob`
  const from = `[flee] from ${threat.name || '?'} at ${at(threat.position.floored())}`
  const refused = plan.allyRefused ? `, no safe route to ${ally.username}` : ''
  if (!plan.goal) return `${from}: no safe cell${refused}, holding, ${rejected}`
  const to = plan.ally ? ` to ${ally.username}` : ''
  const score = plan.ally ? '' : ` score ${plan.score.toFixed(1)},`
  return `${from}:${to} goal ${at(plan.goal)},${score} ${plan.steps} steps, ${plan.mobDist.toFixed(1)} from the nearest mob, solid floor, no drop over 3 on the way or beside it, no lava or fire within 2, ${plan.candidates} candidates${refused}, ${rejected}`
}
// Hostiles within radius that can reach the body, as { e, at }, an unperceived one that hit it placed at seenAt.
function nearHostiles (fill, radius, seenAt) {
  return liveEntities().flatMap(e => {
    if (!e.position) return []
    const c = mobClass(e)
    if (c !== 'hostile' && c !== 'creeper' && c !== 'heavy') return []
    const confirmed = AGGRO_CONFIRMED.has(e.id)
    // An unproven mob counts only while perceived, at its live position.
    if (!confirmed && e.position.distanceTo(bot.entity.position) >= radius) return []
    const seen = entityPerceptible(e, fill)
    if (!(confirmed || seen)) return []
    const at = seen ? e.position : seenAt.get(e.id)
    if (!at || at.distanceTo(bot.entity.position) >= radius) return []
    if (!entityEngageable(e)) return []
    return [{ e, at }]
  })
}
// what, then where e stands from the body when the body perceives it: "flee: creeper E ~10, 8 below".
function threatWhy (what, e, fill) {
  if (!entityPerceptible(e, fill)) return what
  const here = bot.entity.position
  const dy = Math.round(e.position.y - here.y)
  const level = dy > 0 ? `${dy} above` : dy < 0 ? `${-dy} below` : 'same level'
  return `${what}: ${e.username || e.name || '?'} ${compass(e.position.x - here.x, e.position.z - here.z)} ~${Math.round(e.position.distanceTo(here))}, ${level}`
}
// A block change in or beside the shared perception flood drops it, and so does a loaded column.
function wireFloodDrops () {
  bot.on('blockUpdate', (oldB, newB) => {
    const combat = reflexes.find(r => r.name === 'combat')
    const p = (newB || oldB)?.position
    if (combat._fill && p && (combat._fill.cells.has(ck(p.x, p.y, p.z)) || touchesFill(p, combat._fill))) combat._fill = null
  })
  bot.on('chunkColumnLoad', () => { reflexes.find(r => r.name === 'combat')._fill = null })
}

// the watcher+responder reflex — priority ABOVE unstuck (unshift), toggle via /reflexes name=combat
const combatReflex = {
  name: 'combat', on: true, active: false,
  _hist: new Map(), _lastNarrate: new Map(), _threat: null,
  // _seenAt maps an entity id to where the body last perceived it.
  _seenAt: new Map(),
  // _fleeCls is the mobClass of the threat the last flee ran from, _sprint the token of its sprint.
  _fill: null, _fillT: 0, _fillSeed: null, _fleeUntil: 0, _fleeT: 0, _fleeCls: null, _sprint: null, _coverUntil: 0, _holdUntil: 0,
  // Emits text as a combat event, at most once per 8 s for key.
  narrate (key, text) {
    const now = Date.now()
    if (now - (this._lastNarrate.get(key) || 0) <= 8000) return
    this._lastNarrate.set(key, now)
    emitEvent('combat', text)
  },
  perceivedAt (e, seen) {
    return seen ? e.position : this._seenAt.get(e.id) || null
  },
  // FLEE LATCH (07-16, the first-death autopsy: twelve 'disengaging' events, zero escape — every
  // 300ms re-entry safeStop'd the previous flee goal and re-planned from scratch, so the body
  // SHUFFLED IN PLACE while a same-speed drowned ate it 1.4 at a time. A flee is set ONCE, held
  // 6s, and RUN at a sprint; re-entries bounce off the latch instead of resetting the goal.)
  // Returns 'held' when no safe cell exists or the pillar top keeps the body, which then holds its ground.
  fleeFrom (bot, threat, why, klass = 'discretionary') {
    const now = Date.now()
    if (laneBlocks(klass)) {
      const onPillar = perchHolds()
      if (onPillar) this.narrate('hold', 'the combat reflex ' + threatWhy('kept the body on the pillar top instead of a flee', threat, this.fairFill(bot)))
      laneNarrate(why || 'flee')
      return onPillar ? 'held' : undefined
    }
    if (now < this._fleeUntil) return                   // a flee is already running — let it run
    if (now < this._holdUntil) return 'held'
    this._fleeUntil = now + 6000
    try {
      const here = bot.entity.position
      const fill = this.fairFill(bot)
      const seen = entityPerceptible(threat, fill)
      const at = this.perceivedAt(threat, seen)
      const anchor = reflexes.find(r => r.name === 'flee_to_player')
      const ally = at && anchor && anchor.on ? anchor.ally(bot, here, at, fill) : undefined
      const mobs = nearHostiles(fill, 16, this._seenAt).filter(h => h.e.id !== threat.id).map(h => h.at)
      const world = fleeWorld()
      // A swelling creeper stops once it loses sight of the body.
      const cover = mobClass(threat) === 'creeper' && creeperSwelling(threat) && seen
        ? creeperCover({ world, here, creeper: threat.position, mobs })
        : null
      const plan = cover || (at ? planFlee({ world, here, threat: at, mobs, ally: ally ? ally.position : null }) : { goal: null })
      if (cover) {
        // The creeper walks round the cover in about 1 s, its fuse still lit.
        this._fleeUntil = now + 1000
        const [c, g] = [threat.position.floored(), cover.goal]
        console.log(`[flee] from swelling creeper at (${c.x},${c.y},${c.z}): goal (${g.x},${g.y},${g.z}) out of its sight behind seen blocks, ${cover.steps} steps, ${cover.creeperDist.toFixed(1)} from it`)
      } else if (at) console.log(fleeLog({ name: threat.name, position: at }, ally, plan))
      else console.log('[flee] from something never perceived: no heading, holding')
      if (!plan.goal) {
        this._fleeUntil = 0
        this._holdUntil = now + 1500
        const stand = at ? threatWhy('stand still, no safe cell to flee to', threat, fill) : 'stand still, nothing seen to flee from'
        takeLegs('combat', stand)
        stopPath()
        this.narrate('hold', takenText({ reflex: 'combat', why: stand }))
        return 'held'
      }
      this._fleeT = now
      this._fleeCls = mobClass(threat)
      const fled = threatWhy(cover ? 'break its sight' : 'flee', threat, fill)
      takeLegs('combat', fled)
      stopPath()
      bot.pathfinder.setGoal(new goals.GoalBlock(plan.goal.x, plan.goal.y, plan.goal.z))
      if (!why) this.narrate('flee', takenText({ reflex: 'combat', why: fled }))
      if (plan.ally) emitEvent('flee_to_player', `fleeing to ${ally.username} ${compass(ally.position.x - here.x, ally.position.z - here.z)} ~${Math.round(ally.position.distanceTo(here))}`)
      bot.setControlState('sprint', true)
      const sprint = this._sprint = {}
      setTimeout(() => { if (this._sprint === sprint) try { bot.setControlState('sprint', false) } catch (e) {} }, this._fleeUntil - now)
    } catch (e) { console.log('[flee] failed: ' + e.message) }
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
    const seen = entityPerceptible(threat, this.fairFill(bot))
    if (seen) this._seenAt.set(threat.id, threat.position.clone())
    const from = seen ? who || '?' : 'something'
    // The shooter's eye where the body last perceived it, none for a shooter never perceived.
    const at = this._seenAt.get(threat.id)
    try {
      const here = bot.entity.position.floored()
      const eye = at && at.offset(0, 1.62, 0)
      const stand = (x, y, z) => {
        if (![y - 1, y, y + 1].every(v => knownCell(new Vec3(x, v, z)))) return false
        const f = bot.blockAt(new Vec3(x, y - 1, z)); if (!f || f.boundingBox !== 'block') return false
        const a = bot.blockAt(new Vec3(x, y, z)); const h = bot.blockAt(new Vec3(x, y + 1, z))
        return !!(a && h && a.boundingBox === 'empty' && h.boundingBox === 'empty' &&
          !holdsWater(a) && !holdsWater(h) && !/lava/.test(a.name) && !/lava/.test(h.name))
      }
      // True when no block the body knows stands between the eye and head. An unknown cell reads as open.
      const inSight = (head) => {
        const end = head.floored()
        return !gridWalk(eye, head, (c) => {
          if (c.equals(end) || !knownCell(c)) return false
          const b = bot.blockAt(c)
          return !!b && b.boundingBox === 'block'
        })
      }
      let bestCell = null; let bestD = Infinity
      if (eye) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        if (!dx && !dz) continue
        for (let dy = -1; dy <= 1; dy++) {
          const x = here.x + dx, y = here.y + dy, z = here.z + dz
          if (!stand(x, y, z)) continue
          if (inSight(new Vec3(x + 0.5, y + 1.62, z + 0.5))) continue   // still in the sightline
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < bestD) { bestD = d2; bestCell = { x, y, z } }
        }
      }
      if (bestCell) {
        takeLegs('combat', threatWhy('take cover', threat, this.fairFill(bot)))
        stopPath()
        bot.pathfinder.setGoal(new goals.GoalBlock(bestCell.x, bestCell.y, bestCell.z))
        emitEvent('combat', `ranged chip from ${from} — BREAKING EYE-LINE: cover ${compass(bestCell.x - here.x, bestCell.z - here.z)} at (${bestCell.x},${bestCell.y},${bestCell.z})`)
        return
      }
    } catch (e) {}
    this._coverUntil = 0                                 // no cover found — hand it to the flee latch
    this.fleeFrom(bot, threat, `ranged chip from ${from} — no cover within 3, FLEEING the sightline`, 'interrupt')
  },
  // The flood every entity sense shares, reused for 2 s while the body stays within 3 blocks of its seed.
  fairFill (bot) {
    const now = Date.now()
    const seed = bot.entity.position.floored()
    if (this._fill && now - this._fillT < 2000 && seed.distanceTo(this._fillSeed) < 3) return this._fill
    this._fill = airFlood({ radius: 20, cap: 15000, known: knownCell, knownOnly: true })
    this._fillT = now; this._fillSeed = seed
    return this._fill
  },
  check (bot) {
    if (bunker.building) return false
    try {
      const now = Date.now()
      const here = bot.entity.position
      let best = null
      const watch = (e, cls, dist) => {
        const wk = 'w' + e.id
        if (cls !== 'player' && now - (this._lastNarrate.get(wk) || 0) > 20000 && entityPerceptible(e, this.fairFill(bot))) {
          this._lastNarrate.set(wk, now)
          const rel = e.position.y > here.y + 1 ? 'above' : (e.position.y < here.y - 1 ? 'below' : 'beyond')
          emitEvent('threat', `watched: ${e.name || '?'} ${rel} ~${Math.round(dist)} — separated, not driving`, null, { quiet: true })
        }
      }
      expireConfirmed(AGGRO_CONFIRMED, now, CONFIRMED_MS)
      for (const m of [this._seenAt, this._hist]) for (const id of m.keys()) if (!bot.entities[id]) m.delete(id)
      // Numeric and 'w<id>' keys belong to an entity, 'hold' and 'flee' throttle the reflex's own lines.
      for (const key of this._lastNarrate.keys()) {
        const id = typeof key === 'number' ? key : /^w-?\d+$/.test(key) ? key.slice(1) : null
        if (id !== null && !bot.entities[id]) this._lastNarrate.delete(key)
      }
      for (const e of liveEntities()) {
        if (!e.position) continue
        const cls = mobClass(e)
        const confirmed = AGGRO_CONFIRMED.get(e.id)
        const scoreable = cls === 'player' ? now < fight.threatDebugUntil : cls === 'hostile' || cls === 'creeper' || cls === 'heavy' || !!confirmed
        if (!scoreable) continue
        // DEATH #9 (07-23): this gate ran BEFORE the confirmed bypass, so a skeleton plinking
        // from ~33 was discarded every cycle — fourteen hits, zero responses, while the hurt
        // line swore the reflex "has it". What HIT me stays scored out to 48; everything
        // unproven keeps the old 24-block horizon.
        // An unproven mob scores only while perceived, at its live position.
        if (!confirmed && e.position.distanceTo(here) > 24) { this._hist.delete(e.id); continue }
        // confirmed attackers bypass the sight gate (whatever HIT me announced itself); everything
        // else must share my connected air. History is kept, not wiped — brief occlusion mid-chase
        // shouldn't amnesia the pursuit evidence, the sample just doesn't accrue while unseen.
        const seen = entityPerceptible(e, this.fairFill(bot))
        if (seen) this._seenAt.set(e.id, e.position.clone())
        else if (!confirmed) continue
        const at = this.perceivedAt(e, seen)
        const dist = at ? at.distanceTo(here) : Infinity
        if (at && dist > CONFIRMED_HORIZON) { this._hist.delete(e.id); continue }
        // WATCHED tier (the mansion lesson): perceptible but a floor away — narrate rarely, never score
        if (!entityEngageable(e)) { watch(e, cls, dist); continue }
        const h = this._hist.get(e.id) || { d: dist, t: now, closes: 0, logT: 0 }
        const dt = (now - h.t) / 1000
        if (at && dt >= 0.25) {
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
        if (at) this._hist.set(e.id, h)
        // sentinel stance: posturing doesn't count — only confirmed attackers score (creeper
        // proximity still does: fleeing a lit fuse is survival, not engagement)
        const closerAggro = STANCES[fight.stance].engage === 'confirmed' ? false : h.closes >= 3
        // A melee mob below a perch is a free target in reach.
        const perchAggro = cls === 'hostile' && STANCES[fight.stance].engage !== 'confirmed' && perchStrike(e) && inMeleeReach(e)
        const aggro = !!confirmed || closerAggro || perchAggro || (cls === 'creeper' && dist < 8)
        // A creeper from 8 out drives the legs only along a walk of at most the stance's fleeDist.
        if (aggro && cls === 'creeper' && at && dist >= 8) {
          const routeKey = `${fight.stance} ${at.floored()} ${here.floored()}`
          if (h.routeKey !== routeKey) {
            h.routeKey = routeKey
            h.route = creeperRoute(at, STANCES[fight.stance].fleeDist)
          }
          if (!h.route) { watch(e, cls, dist); continue }
        }
        // A creeper the body perceives within the stance's flee distance outranks every other mob.
        const urgent = cls === 'creeper' && dist <= STANCES[fight.stance].fleeDist && seen
        if (aggro && (!best || urgent > best.urgent || (urgent === best.urgent && dist < best.dist))) best = { e, cls, dist, confirmed: !!confirmed, urgent }
      }
      this._threat = best
      return !!best && !(holdRun.on && best.cls !== 'creeper')
    } catch (e) { return false }
  },
  async act (bot) {
    const t = this._threat
    if (!t || !t.e || !bot.entities[t.e.id]) return
    if (Date.now() < this._fleeUntil) return              // mid-flee: legs are busy, no melee, no goal resets
    const now = Date.now()
    const here = bot.entity.position
    const dir = compass(t.e.position.x - here.x, t.e.position.z - here.z)
    const seen = entityPerceptible(t.e, this.fairFill(bot))
    const label = seen ? t.e.username || t.e.name || '?' : 'something'
    const narKey = t.e.id
    if (now - (this._lastNarrate.get(narKey) || 0) > 8000 && (seen || t.confirmed)) {
      this._lastNarrate.set(narKey, now)
      if (!seen) emitEvent('threat', `something hit me [${fight.stance}]`)
      else emitEvent('threat', `${label} ${dir} ~${Math.round(t.dist)} ${t.confirmed ? 'CONFIRMED (it hit me)' : 'closing fast'} — ${t.cls === 'creeper' ? 'creeper doctrine' : t.cls === 'heavy' ? 'heavy doctrine (no trades)' : t.cls === 'player' ? 'debug: scoring only' : 'engaging'} [${fight.stance}]`)
    }
    if (t.cls === 'player') return                          // NEVER weapons on players — narrate only
    const s = STANCES[fight.stance]
    // The standoff guard goes up while a melee hostile closes and drops for each swing.
    const sword = bot.inventory.items().find(i => /_sword$/.test(i.name))
    const canGuard = () => {
      if (LEGACY_1710) return !!bot.heldItem && /_sword$/.test(bot.heldItem.name) && !legsMoving()
      const offHand = bot.inventory.slots[45]; return !!offHand && offHand.name === 'shield' && !legsMoving()
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
    // pursuit carries on this._hist's closing count, guardCall is the last standoff decision.
    const pursuit = { ...(this._hist.get(t.e.id) || { d: t.dist, t: now, closes: 0 }) }
    let guardCall = null
    const setStandoffGuard = (d) => {
      if (!canGuard()) return
      const at = Date.now()
      if (at - pursuit.t >= 250) {
        const speed = (pursuit.d - d) / ((at - pursuit.t) / 1000)
        // A distance never perceived gives no speed.
        if (Number.isFinite(speed)) pursuit.closes = speed > 0.6 ? pursuit.closes + 1 : Math.max(0, pursuit.closes - 1)
        pursuit.d = d
        pursuit.t = at
      }
      const g = standoffGuard(t.e, d, pursuit.closes > 0, this.fairFill(bot))
      const was = guardCall ? guardCall.up : guardState.up
      if (g.up !== was && (g.up || !guardState.pilot)) console.log(`[combat] guard ${g.up ? 'up' : 'down'} vs ${label} ~${Math.round(d)}: ${g.why}`)
      guardCall = g
      if (g.up) guardUp()
      else if (!guardState.pilot) guardDown()
    }
    if (t.cls === 'creeper' || t.cls === 'heavy') {
      // Never trade with these — but "never melee" stopped meaning "only run" when stances landed:
      // beyond the stance's berth and inside the bow band, the answer is an arrow, not distance.
      // Lane classes: a creeper in berth is an EMERGENCY (fuses don't negotiate); a heavy's kite
      // is an INTERRUPT (passes the soft lane, defers to /brace's hard one).
      const fk = t.cls === 'creeper' ? 'emergency' : 'interrupt'
      const flee = () => {
        const held = this.fleeFrom(bot, t.e, null, fk) === 'held'
        if (held && !strikeRun.lane) guardUp()
        else if (!guardState.pilot) guardDown()
      }
      if (t.dist <= s.fleeDist) { flee(); return }
      const [lo, hi] = s.bowBand
      const bandLo = t.cls === 'heavy' ? Math.max(lo, 10) : lo   // heavies close FAST — bigger floor
      if (seen && t.dist >= bandLo && t.dist <= hi && !strikeRun.lane) {
        try { if (await drawAndLoose(t.e)) return } catch (e) {}
      }
      flee()
      return
    }
    const t0 = Date.now()
    try {
      while (this.on && !bunker.building && !holdRun.on && bot.entities[t.e.id] && Date.now() - t0 < 10000) {
        // An urgent creeper ends the melee, and the fought threat goes back into this._threat for meleeThreat().
        const fought = this._threat
        const creeperFirst = this.check(bot) && this._threat.urgent
        this._threat = fought
        if (creeperFirst) return
        const seenNow = entityPerceptible(t.e, this.fairFill(bot))
        const at = this.perceivedAt(t.e, seenNow)
        const perchHit = t.cls === 'hostile' && !!at && perchStrike(t.e, at)
        // A flee with no safe cell holds the ground and fights on.
        if (bot.health < disengageHp(t.cls) && !perchHit) {
          if (this.fleeFrom(bot, t.e, `HP ${Math.round(bot.health * 10) / 10} — disengaging from ${label}, sprinting`, 'emergency') !== 'held') return
        }
        // OUTNUMBERED (07-18, death #4 autopsy + the helmsman's diagnosis: the close-in never
        // counted the room). 3+ perceptible hostiles inside 16 is not a duel — withdraw, don't
        // engage-nearest while the rest converge.
        const packList = nearHostiles(this.fairFill(bot), 16, this._seenAt)
        const pack = packList.length
        if (pack >= 3 && !perchHit) {
          // VANGUARD COMMITS (07-21, death #8: four zombies at 0.7 a bite outlasted a reflex
          // that kept choosing withdrawals it couldn't execute in a corridor. A light-only pack
          // in room-clearing stance is sword work, not a rout — stand and swing. A heavy or a
          // creeper in the pack still makes it a real rout, and the HP floor still binds.)
          const packHasHeavy = packList.some(h => { const c2 = mobClass(h.e); return c2 === 'heavy' || c2 === 'creeper' })
          const lightCommit = fight.stance === 'vanguard' && !packHasHeavy && bot.health >= 12
          if (!lightCommit) {
            // ALLY SUPPRESSION (the helmsman's design, 07-20, en route to the dungeon reaping):
            // a pack is only a rout if I'm ALONE in it. A partner in sight within 10 turns the math — two
            // blades hold a hallway three zombies can't. Withdrawal stays armed for the solo case.
            const allyNear = liveEntities().some(e2 =>
              e2.type === 'player' && e2.username && e2.username !== bot.username &&
              e2.position && e2.position.distanceTo(bot.entity.position) <= 10 && entityPerceptible(e2, this.fairFill(bot)))
            // HP FLOOR (07-21, the mill's lesson: the hold rule pinned me at 9 hearts twice on
            // 07-20 — an ally makes a pack survivable, not a wound. Below 12 the hold yields.)
            if (!allyNear || bot.health < 12) {
              const held = this.fleeFrom(bot, t.e, allyNear
                ? `OUTNUMBERED ${pack} at ${Math.round(bot.health)} HP — below the hold floor, withdrawing`
                : `OUTNUMBERED ${pack} — fighting withdrawal, not a duel`) === 'held'
              if (!held) return
            }
            if (allyNear && (!this._lastHoldEmit || Date.now() - this._lastHoldEmit > 10000)) {
              this._lastHoldEmit = Date.now()
              emitEvent('combat', `outnumbered ${pack} but an ally stands within 10 — HOLDING the line`)
            }
          }
        }
        if (strikeRun.lane) {                                 // the flees above still run during a /strike or /shoot
          if (!guardState.pilot) guardDown()
          await new Promise(r => setTimeout(r, 250))
          continue
        }
        const d = at ? at.distanceTo(bot.entity.position) : Infinity
        const inReach = inMeleeReach(t.e)
        if (inReach) yieldJob('combat', threatWhy('fight in melee range', t.e, this.fairFill(bot)))
        if (!inReach) {
          // Standoff band (the helmsman's 07-16 complaint: the reflex used to stand here sword-in-
          // hand, staring at skeletons that plink from 10). Stance decides: bow it, chase it, or
          // hold shield-up as before.
          const [lo, hi] = s.bowBand
          const pockets = bot.inventory.items()
          if (seenNow && d >= lo && d <= hi && pockets.some(i => i.name === 'bow') && pockets.some(i => i.name === 'arrow') && bowLine(t.e)) {
            guardDown()                                       // both hands on the bow
            try { if (await drawAndLoose(t.e)) { await new Promise(r => setTimeout(r, 200)); continue } } catch (e) {}
          }
          if (s.chase && !perchHit && entityPerceptible(t.e, this.fairFill(bot))) {   // vanguard: run down a mob in sight
            if (laneBlocks('discretionary')) { laneNarrate('chase'); await new Promise(r => setTimeout(r, 500)); continue }
            takeLegs('combat', threatWhy('chase', t.e, this.fairFill(bot)))
            if (LEGACY_1710 && !sprintBlock(t.e)) {
              try {
                bot.pathfinder.setGoal(null)
                await swordInHand()
                await meleeSwing(t.e, { run: true, seen: () => entityPerceptible(t.e, this.fairFill(bot)) })
              } catch (e) { console.log('[combat] sprint opener failed: ' + e.message) }
              continue
            }
            try { bot.pathfinder.setGoal(new goals.GoalNear(t.e.position.x, t.e.position.y, t.e.position.z, 2)) } catch (e) {}
            await new Promise(r => setTimeout(r, 500))
            continue
          }
          // DEATH #9's LESSON (07-23): against a PROVEN ranged attacker, the shield-stare IS the
          // death posture — it holds the body still inside the firing solution. If the bow
          // couldn't answer (out of band, no LOS, no arrows), break the eye-line instead.
          const confirmedHit = AGGRO_CONFIRMED.get(t.e.id)
          if (confirmedHit && confirmedHit.ranged) { this.takeCover(bot, t.e, label); return }
          if (LEGACY_1710) { try { await swordInHand() } catch (e) {} }
          setStandoffGuard(d)
          if (headFree(bot) && at) await bot.lookAt(at.offset(0, 1.2, 0), true)
          await new Promise(r => setTimeout(r, 250))
          continue
        }
        if (s.chase) {                                        // in reach — legs off, sword out
          if (bot.pathfinder.goal) takeLegs('combat', threatWhy('fight in melee range', t.e, this.fairFill(bot)))
          try { bot.pathfinder.setGoal(null) } catch (e) {}
        }
        try {
          if (LEGACY_1710) {
            // The sword block holds while the hit waits, against a mob in sight or one that can walk to the body.
            await swordInHand()
            const reachable = !!at && (losClear(bot.entity.position.offset(0, 1.62, 0), at.offset(0, 1.62, 0)) || creeperRoute(at, GUARD_STEPS))
            if (!reachable && !guardState.pilot) guardDown()
            const inSight = () => entityPerceptible(t.e, this.fairFill(bot))
            if (!inSight()) {
              if (reachable || guardState.pilot) guardUp()
              await new Promise(r => setTimeout(r, 250))
              continue
            }
            await bot.lookAt(t.e.position.offset(0, 1.2, 0), true)
            await meleeSwing(t.e, { guard: reachable || guardState.pilot ? { up: guardUp, down: guardDown } : null, seen: inSight })
            continue
          }
          await chargedSwing(t.e, sword, { guard: { up: guardUp, down: guardDown }, seen: () => entityPerceptible(t.e, this.fairFill(bot)) })
          continue
        } catch (e) {}
        await new Promise(r => setTimeout(r, 250))
      }
    } finally {                                               // the pilot's block stays up, the reflex's comes down
      if (strikeRun.lane) {
        if (!guardState.pilot) guardDown()                    // a /strike or /shoot holds the hand
      } else if (!(await pilotGuard())) {
        if (guardCall && guardCall.up && guardState.up) console.log(`[combat] guard down vs ${label}: the fight ended`)
        guardDown()
      }
    }
    // Out of sight, a vanished target may have despawned instead of died.
    if (!bot.entities[t.e.id] && entityPerceptible(t.e, this.fairFill(bot))) emitEvent('combat', `${t.e.username || t.e.name || '?'} is DOWN`)
    // POST-COMBAT REFUEL (07-21, the mill's slow-bleed autopsy: /eat fails silently while
    // combat owns the hand, so food ratchets down across engagements and regen quits at 17.
    // The moment the hand is free is the moment to eat — before the next wave claims it.)
    if (bot.food <= 14 && !bunker.building && !holdRun.on && !strikeRun.lane) {
      try { await refuelAfterFight() } catch (e) {}
      await pilotGuard()                                      // the food in hand ended the pilot's block
    }
  }
}
// flee_to_player: a combat flee runs to a player in sight within 24 blocks who stands farther from
// the threat, not straight away from it. It shapes the flee and never fires by itself.
const fleeToPlayerReflex = {
  name: 'flee_to_player', on: true, active: false,
  check () { return false },
  // The player to run to, or undefined. A nametag alone gives no route to run along.
  ally (bot, here, threatPos, fill) {
    return liveEntities().find(e =>
      e.type === 'player' && e.username && e.username !== bot.username &&
      e.position && e.position.distanceTo(here) <= 24 &&
      e.position.distanceTo(threatPos) > here.distanceTo(threatPos) && entityPerceptible(e, fill))
  }
}

// The hurt windows of the mobs around the body.
const mobHurt = hurtWindows()
function wireMobHurt () {
  mobHurt.wire(bot)
}
// Why the body cannot open on e with a sprint hit, or null.
function sprintBlock (e) {
  const d = e.position.distanceTo(bot.entity.position)
  if (inMeleeReach(e)) return 'in reach'
  if (d > RUN_MAX) return `beyond ${RUN_MAX}`
  return noRunReason({ from: bot.entity.position, to: e.position, food: bot.food, blockAt: (p) => bot.blockAt(p), known: knownCell })
}
// One 1.7.10 melee hit at e, true when it swung, false out of sight, null out of reach.
async function meleeSwing (e, { run = false, aimY = 1.2, guard = null, seen = () => true } = {}) {
  const wait = () => Math.max(0, fight.lastAttackT + LEGACY_HIT_MS - Date.now(), mobHurt.wait(e))
  const sleep = (ms) => ms > 0 ? new Promise(r => setTimeout(r, ms)) : null
  const aim = () => bot.lookAt(meleeAim(e, aimY), true)
  const swing = async (note) => {
    if (guard) guard.down()
    await aim()
    if (!seen()) return false
    if (!inMeleeReach(e, aimY)) return null
    bot.attack(e)
    fight.lastAttackT = Date.now()
    console.log(`[combat] swing ${e.name || '?'} ~${e.position.distanceTo(bot.entity.position).toFixed(1)}: ${note}`)
    return true
  }
  const blocked = run && sprintBlock(e)
  let why = blocked ? `no run, ${blocked}` : null
  if (run && !blocked) {
    const from = bot.entity.position.clone()
    const line = runCells(from, e.position)
    const length = Math.hypot(e.position.x - from.x, e.position.z - from.z) - RUN_COAST
    const onLine = () => line.some(c => c.x === Math.floor(e.position.x) && c.z === Math.floor(e.position.z))
    const ran = () => Math.hypot(bot.entity.position.x - from.x, bot.entity.position.z - from.z)
    let hit = null
    bot.setControlState('sprint', true)
    bot.setControlState('forward', true)
    try {
      for (let i = 0; i < RUN_TICKS && bot.entities[e.id] && !inMeleeReach(e, aimY) && seen() && onLine() && ran() < length; i++) {
        await aim()
        await bot.waitForTicks(1)
      }
      if (inMeleeReach(e, aimY) && wait() === 0) hit = await swing('sprint hit, crit no, sprinting on the ground')
    } finally {
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
    }
    if (hit !== null) return hit
    if (!seen()) return false
    why = 'the run ended out of reach or inside the hurt window'
  }
  // The last jump may still be in the air while the hit waits.
  for (let i = 0; i < JUMP_TICKS && !bot.entity.onGround && wait() > 0; i++) await bot.waitForTicks(1)
  const feet = bot.entity.position.floored()
  const open = (up) => {
    const p = feet.offset(0, up, 0)
    const b = bot.blockAt(p)
    return !!b && b.boundingBox === 'empty' && knownCell(p)
  }
  const ground = bot.blockAt(feet)
  why = why || noCritReason({
    riding: !!bot.vehicle,
    inWater: !!bot.entity.isInWater,
    onLadder: !!ground && /ladder|vine/.test(ground.name),
    onGround: !!bot.entity.onGround,
    walking: bot.pathfinder.isMoving(),
    perched: perched(),
    headroom: open(2) && open(3)
  })
  if (guard && (wait() > 0 || !why)) guard.up()
  if (!why) {
    // Server-side the fall distance grows only while a position packet sinks off the ground.
    await sleep(wait() - JUMP_FALL_TICKS * 50)
    let y = bot.entity.position.y
    let fall = 0
    let left = false
    bot.setControlState('jump', true)
    try {
      for (let i = 0; i < JUMP_TICKS; i++) {
        await bot.waitForTicks(1)
        bot.setControlState('jump', false)
        const p = bot.entity.position.y
        if (bot.entity.onGround) {
          if (left || i >= 2) break
        } else {
          left = true
          if (p < y) fall += y - p
        }
        y = p
        if (fall > 0 && wait() === 0) break
      }
    } finally {
      bot.setControlState('jump', false)
    }
    if (!(fall > 0 && !bot.entity.onGround)) why = left ? 'landed before the hit was due' : 'the jump never left the ground'
  }
  // A hit from another attacker reopens the window, which the swing waits out at most twice.
  for (let k = 0; k < 3 && wait() > 0; k++) await sleep(wait())
  return swing(why ? `crit no, ${why}` : 'crit yes')
}
// One melee hit at e on a server with an attack cooldown, true when it swung.
async function chargedSwing (e, sword, { guard = null, seen = () => true } = {}) {
  if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) { await bot.equip(sword, 'hand'); await bot.waitForTicks(13) }
  const hurt = mobHurt.wait(e)
  if (hurt > 0) await new Promise(r => setTimeout(r, hurt))
  if (guard) guard.down()
  await bot.waitForTicks(2)
  await bot.lookAt(meleeAim(e, 1.2), true)
  await bot.waitForTicks(2)
  const hit = inMeleeReach(e) && seen()
  if (hit) bot.attack(e)
  await new Promise(r => setTimeout(r, 400))
  if (guard) guard.up()
  await new Promise(r => setTimeout(r, 250))
  return hit
}

function createCombat (ctx) {
  Object.assign(ctx, { STANCES, drawAndLoose, bowLine, AGGRO_CONFIRMED, CONFIRMED_HORIZON, CONFIRMED_MS, guardState, MOVES, legsMoving, mobClass, nearestHostile, lastSwing, SWING_MS, SWING_GAP_MS, SWING_FACING, arrows, ARROW_FLIGHT_MS, ARROW_HIT_MS, SHOOTERS, ARROW_RANGE, ARROWS, ARROW_LOOSE, arrowAttrib, arrowHitOf, perched, PERCH_MELEE, PERCH_DROP, perchStrike, inChokepoint, hpMelee, hitbox, meleeAim, inMeleeReach, meleeThreat, disengageHp, entityEngageable, fleeWorld, creeperSwelling, CREEPER_DROP, creeperRoute, GUARD_REACH, GUARD_STEPS, standoffGuard, fleeLog, nearHostiles, threatWhy, combatReflex, fleeToPlayerReflex, mobHurt, sprintBlock, meleeSwing, chargedSwing })
}

function bindCombat (ctx) {
  ({ bot, losClear, reflexes, shared, liveEntities, entityPerceptible, compass, fight, perchHolds, knownCell, OPENABLE, lineCell, ck, cellKnown, holdsWater, touchesFill, emitEvent, laneBlocks, laneNarrate, takeLegs, stopPath, gridWalk, airFlood, bunker, holdRun, strikeRun, yieldJob, refuelAfterFight } = ctx)
}

module.exports = { createCombat, bindCombat, wireGuardDrop, wireItemUseCosts, wireArmSwings, wireArrowTracking, wireDamageAttribution, wireFloodDrops, wireMobHurt }
