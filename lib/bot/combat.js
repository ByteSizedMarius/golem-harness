'use strict'

const { Vec3 } = require('vec3')
const { mobFamily, babyFlag, expireConfirmed } = require('../shelter')
const { hurtWindows, noCritReason, runCells, noRunReason, JUMP_FALL_TICKS, JUMP_TICKS, RUN_MAX, RUN_TICKS, SWING_REACH } = require('../combat-rules')
const { isDoor } = require('../doors')
const { LEGACY_1710 } = require('./config')
const { LEGACY_HIT_MS, RUN_COAST, HITBOX_1710, LEGACY_SNEAK_EYE } = require('./legacy-1710')
const { routeWithin, walkersTo, creeperCover, planFlee, walkFlood, groundCell } = require('../flee')
const { takenText } = require('../leg-ledger')
const { goals } = require('mineflayer-pathfinder')
const { headFree } = require('../head')
const { STANCES } = require('./stances')
const { CREEPER_ZONE_SLACK } = require('../plan')
const { soleClaim } = require('./dig-lock')
const { MIN_FOOD, SPRINT_FLOOR } = require('../sprint')

let bot, losClear, reflexes, shared, liveEntities, entityPerceptible, compass, perchHolds, knownCell, OPENABLE, lineCell, ck, cellKnown, seenNow, seesShape, holdsWater, touchesFill, emitEvent, laneBlocks, laneNarrate, takeLegs, stopPath, gridWalk, airFlood, bunker, holdRun, strikeRun, yieldJob, refuelAfterFight, bunkerHolds, waterState

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
// One full bow cycle at target, false when nothing was loosed.
async function drawAndLoose (target) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (!bow || !bot.inventory.items().some(i => i.name === 'arrow')) return false
  // NO LOS, NO LOOSE (07-17, ten arrows into a wall: a skeleton in a sealed neighbor pocket was
  // PERCEPTIBLE by connected air — fair for awareness, like hearing — but the reflex treated
  // "perceptible" as "shootable". A firing solution needs an actual clear eye-ray.)
  if (!bowLine(target)) return false
  await handFree()
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
      await bot.lookAt(aim(), true)
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
const fight = {}
fight.lastAttrib = null            // set by the damage_event wire, read by the hurt handler in alarms.js
fight.stance = 'guard'
fight.threatDebugUntil = 0                   // /threatdebug window: score players, narrate only
fight.lastHit = { dmg: 0, t: 0 }             // the last hit taken, which raises the disengage threshold for 20 s
fight.lastAttackT = 0
// The damage type names by registry id, from the registry either server sends (generic at 16 through Via).
fight.damageTypes = []
function wireDamageTypes () {
  bot._client.on('registry_data', (packet) => {
    try {
      if (/^(minecraft:)?damage_type$/.test(packet.id)) fight.damageTypes = packet.entries.map(e => e.key.replace(/^minecraft:/, ''))
    } catch (e) { console.log('[combat] damage type registry unreadable: ' + e.message) }
  })
  // mineflayer registers the spawn_entity listener that makes the entity at inject_allowed.
  bot.once('inject_allowed', () => bot._client.on('spawn_entity', keepFrameFacing))
}
// Resolves once a sourceless hit beside a player or with an arrow in flight has its attribution.
fight.swingWait = null
const AGGRO_CONFIRMED = new Map()          // entityId -> {name, t} — fed by damage attribution
// How far a mob that hit the body stays a threat.
const CONFIRMED_HORIZON = 48
// How long a mob that hit the body stays confirmed.
const CONFIRMED_MS = 45000
// How long a mob that hit the body stays confirmed with no new hit and no sight of it in melee reach.
const CONFIRMED_COOL_MS = 20000
// up is the raised guard (shield or 1.7.10 sword block), slot its hotbar slot, item the name held at the raise, pilot set by /guard, hand the holdHand lease or null.
const guardState = {
  up: false, slot: -1, item: null, pilot: false, hand: null,
  set (up, cause = null) {
    if (up !== this.up && cause) console.log(`[combat] guard ${up ? 'up' : 'down'} ${cause}`)
    this.up = up
  }
}
// A 1.7.10 sword block ends once another hotbar slot, a sword with another name or anything but a sword is in hand.
function wireGuardDrop () {
  bot.on('heldItemChanged', (item) => {
    if (!LEGACY_1710) return
    const sword = !!item && /_sword$/.test(item.name)
    if (!sword) guardState.set(false, item ? `for ${item.name} in hand` : 'for an empty hand')
    else if (bot.quickBarSlot !== guardState.slot) guardState.set(false, `for hotbar slot ${bot.quickBarSlot}`)
    else if (item.name !== guardState.item) guardState.set(false, `for ${item.name} in hand`)
    if (!sword && !reflexes.find(r => r.name === 'combat').active) guardState.pilot = false
  })
}
// Leases the hand to a pilot action for 2 s past its start or last renew(ms), or ms when longer. While a sole claim
// other than owner holds the dig lock, it throws busy.
function holdHand (owner = null) {
  const sole = soleClaim()
  if (sole && sole !== owner) throw Object.assign(new Error(`busy: ${sole.what} is running, nothing done`), { reason: 'busy' })
  let end
  let over = false
  const lease = new Promise(resolve => { end = resolve })
  const arm = (ms = 0) => setTimeout(() => endHand(lease), Math.max(2000, ms))
  let timer = arm()
  lease.end = () => { over = true; clearTimeout(timer); end() }
  lease.renew = (ms) => {
    if (over) return false
    clearTimeout(timer)
    timer = arm(ms)
    return true
  }
  lease.owner = owner
  if (guardState.hand) guardState.hand.end()
  guardState.hand = lease
  return lease
}
// A sole claim holds the hand between its leases too.
async function handFree () {
  for (;;) {
    if (guardState.hand) await guardState.hand
    else if (soleClaim()) await bot.waitForTicks(1)
    else return
  }
}
// Without lease it ends the lease in hand unless a sole claim owns it, since clicks and stops come from someone else.
function endHand (lease = guardState.hand?.owner ? null : guardState.hand) {
  if (!lease || guardState.hand !== lease) return
  guardState.hand = null
  lease.end()
}
function wireHandLease () {
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, params) => {
    const out = write(name, params)
    if (name === 'block_place') endHand()
    return out
  }
}
// Work passes inside the bunker, where digging is the way out.
function refuseWhileFighting () {
  const combat = reflexes.find(r => r.name === 'combat')
  if (!combat || !combat.fightBusy() || bunkerHolds()) return
  const t = combat._threat
  const seen = !!t && !!t.e && !!bot.entities[t.e.id] && entityPerceptible(t.e, combat.fairFill(bot))
  const e = new Error(`refused: fighting ${seen ? t.e.name || 'something' : 'something'}, the guard reflex holds the hand. Ways out: goto, pillar, bunker, or switching the combat reflex off with reflexes(name: 'combat', on: '0').`)
  e.reason = 'fighting'
  throw e
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
    lowerGuard('for an eat, drink or bow draw')
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
      if (state) lowerGuard('for a walk')
    }
    return setControlState(control, state)
  }
  const attack = bot.attack.bind(bot)
  bot.attack = (...a) => {
    if (paused || shared.bed) return
    lowerGuard()
    return attack(...a)
  }
  const activateItem = bot.activateItem.bind(bot)
  bot.activateItem = (offHand = false) => {
    if (shared.bed) return
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
// The swing is the one caller that passes no cause.
function lowerGuard (cause = null) {
  if (!guardState.up) return
  try { bot.deactivateItem() } catch (e) {}
  guardState.set(false, cause)
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
// The hostiles within 4 blocks that the body can perceive, nearest first.
function closeHostiles () {
  const here = bot.entity.position
  const near = liveEntities().filter(e => e.position &&
    ['hostile', 'creeper', 'heavy'].includes(mobClass(e)) && e.position.distanceTo(here) <= 4)
  if (!near.length) return []
  const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
  return near.filter(e => entityPerceptible(e, fill))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))
}
// A hit that names no source is pinned on the nearest close hostile, or on the one its knockback points away from.
function nearestHostile () {
  return closeHostiles()[0]
}
// True once a damage_event named a type the registry lacks.
let damageTypeMissed = false
// Each player's last two arm swing times (t, prev) and yaw by entity id. Appearing counts as a swing.
const lastSwing = new Map()
function wireArmSwings () {
  const swing = (e) => {
    const now = Date.now()
    lastSwing.set(e.id, { t: now, prev: (lastSwing.get(e.id) || { t: now }).t, yaw: e.yaw })
  }
  bot.on('entitySpawn', (e) => {
    if (!e || e.type !== 'player') return
    lastSwing.delete(e.id)
    swing(e)
  })
  bot.on('entitySwingArm', (e) => { if (e && e.type === 'player') swing(e) })
  bot.on('entityGone', (e) => { if (e) lastSwing.delete(e.id) })
}
// How far apart in ms a player's hit and its arm swing may arrive, in either order.
const SWING_MS = 50
// A swing counts only this many ms or more after the same player's previous one, which leaves out fast clicking.
const SWING_GAP_MS = 300
// How far in radians a swinger's facing may point past the bot.
const SWING_FACING = Math.PI / 4
// The players the body perceives no farther from the bot than hostile, or within 4 with no hostile.
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
// Ranged mobs and how far each attacks from, in blocks.
const RANGED = new Map([['skeleton', 15], ['stray', 15], ['bogged', 15], ['blaze', 48], ['witch', 10], ['ghast', 64], ['pillager', 8], ['drowned', 10]])
// True when e at `at` is a ranged mob within its range, no seen solid cell or closed door on the line from its eye to the body's.
function rangedInSight (e, at) {
  const range = RANGED.get(e.name)
  if (!range || (e.name === 'drowned' && e.heldItem?.name !== 'trident')) return false
  if (at.distanceTo(bot.entity.position) > range) return false
  const world = fleeWorld({ openDoors: true, unseenWalkable: true, thinFloors: true })
  return !gridWalk(bot.entity.position.offset(0, 1.62, 0), at.offset(0, 1.62, 0), (c) => world.kind(c.x, c.y, c.z) === 'solid')
}
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
// True when a cactus stands in a cell the body's box overlaps.
function touchesCactus () {
  const p = bot.entity.position
  const E = 1e-3
  for (let x = Math.floor(p.x - 0.3 + E); x <= Math.floor(p.x + 0.3 - E); x++) {
    for (let y = Math.floor(p.y + E); y <= Math.floor(p.y + 1.8 - E); y++) {
      for (let z = Math.floor(p.z - 0.3 + E); z <= Math.floor(p.z + 0.3 - E); z++) {
        if (bot.blockAt(new Vec3(x, y, z))?.name === 'cactus') return true
      }
    }
  }
  return false
}
// What the body feels that hurts it without a source entity, or null. The hit that sets the body on fire lands
// before the on-fire flag, so fire or lava in the feet or head cell counts too.
function envCauseOf () {
  const ws = waterState()
  if (ws?.buried) return 'buried'
  if (ws?.inLava) return 'in lava'
  if (ws?.inFire || bot.entity.metadata?.[0] & 0x01) return 'on fire'
  if (drowns(ws)) return 'drowning'
  if (touchesCactus()) return 'touching a cactus'
  // bot.health still holds the health before the hit, whose update follows the damage_event.
  return starves(bot.health) ? 'starving' : null
}
// At food 0 the server starves a body by 1 every 4 s above 10 health, above 1 on normal and at any health on hard.
// True when a hit taken at health hp can be that, with no landing within the last second to make it a fall.
function starves (hp) {
  if (bot.food !== 0 || Date.now() - fight.airborneAt <= 1000) return false
  const d = bot.game.difficulty
  return hp > 10 || d === 'hard' || (d === 'normal' && hp > 1)
}
// True when a health drop can be a starvation hit, which takes 1, or shows no drop yet when its update comes late or
// absorption takes it.
function starveDrop (drop) {
  return drop === 0 || drop === 1
}
// True when the water state ws has the head under water with no air left.
function drowns (ws) {
  return !!ws?.submerged && ws.oxygen <= 0
}
// A hit by an entity knocks the body about 0.4 blocks per tick across, away from the entity. A hit without one sends
// the server's leftover motion, under 0.16 by the time such a hit can land.
const KNOCK_SPEED = 0.2
// How far a knockback's direction strays from the line from its hitter to the body.
const KNOCK_CONE = Math.PI / 3
// The server sends the knockback with its entity updates after the rest of the tick, so a lagging server sends it
// well after the damage_event.
const KNOCK_MS = 150
// The close hostile that push, a horizontal velocity, points most directly away from within KNOCK_CONE, the nearer on
// a tie, or undefined. A hostile less than 0.3 across from the body, as one right above it, has no bearing to push along.
function knockerOf (push) {
  const here = bot.entity.position
  const speed = Math.hypot(push.x, push.z)
  let best
  let most = -Infinity
  for (const e of closeHostiles()) {
    const dx = here.x - e.position.x
    const dz = here.z - e.position.z
    const d = Math.hypot(dx, dz)
    if (d < 0.3) continue
    const cos = (push.x * dx + push.z * dz) / (speed * d)
    if (cos >= Math.cos(KNOCK_CONE) && cos > most) {
      best = e
      most = cos
    }
  }
  return best
}
// the wire: 1.21.11 sends damage_event with sourceCauseId = attacker entityId + 1 (0 = none).
// Validation ritual (the helmsman's design): he punches the machine for science, we expect his name.
function wireDamageAttribution () {
  // mineflayer keeps the body's metadata across a respawn, and a 1.7.10 server never resends an unchanged on-fire flag.
  // A respawn after a death (at health 0) or out of the End brings a new entity that is not burning, a portal into
  // another dimension keeps the entity.
  let dimension
  bot.on('login', () => { dimension = bot.game.dimension })
  bot.on('respawn', () => {
    const left = dimension
    dimension = bot.game.dimension
    if (bot.health > 0 && left !== 'the_end') return
    const meta = bot.entity?.metadata
    if (meta?.[0]) meta[0] &= ~0x01
  })
  // When the body was last off the ground.
  fight.airborneAt = 0
  bot.on('move', () => { if (!bot.entity.onGround) fight.airborneAt = Date.now() })
  bot.once('spawn', () => {
    try {
      // The body's last knockback, when it arrived and its horizontal velocity.
      let knock = { t: -Infinity, x: 0, z: 0 }
      // A wait for a knockback (knock) or the hit's health update (health), ended by end once one of them arrives.
      let wake = null
      bot._client.on('entity_velocity', (packet) => {
        try {
          const v = packet.velocity
          if (!bot.entity || packet.entityId !== bot.entity.id || Math.hypot(v.x, v.z) < KNOCK_SPEED) return
          knock = { t: Date.now(), x: v.x, z: v.z }
          if (wake?.knock && knockerOf(knock)) wake.end()
        } catch (e) {}
      })
      bot.on('health', () => { if (wake?.health) wake.end() })
      // t is when the damage_event arrived. first is set once a swing, an arrow or a knockback can no longer follow
      // it, and holds the environmental cause and the health read when it arrived.
      const onDamage = (packet, t, first) => {
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
          const newer = first && fight.lastAttrib && !fight.lastAttrib.env && fight.lastAttrib.t > t
          // A sourceless hit is the environment's while the body feels an environmental cause, unless the knockback of a
          // hostile followed it.
          let envCause = first ? first.cause : sourceless ? envCauseOf() : null
          const knocker = first && envCause && knock.t >= t ? knockerOf(knock) : undefined
          if (knocker || (first && envCause === 'starving' && !starveDrop(first.hp - bot.health))) envCause = null
          const nearest = knocker || (sourceless ? nearestHostile() : undefined)
          const hostile = envCause ? undefined : nearest
          // A sourceless hit is a player's when that player swung within SWING_MS of it, alone and facing
          // the bot, with no hostile closer to the bot. The swing nearest in time wins.
          const near = sourceless ? playersNear(nearest) : []
          const swing = near.map(e => ({ e, s: lastSwing.get(e.id) }))
            .filter(({ e, s }) => s && Math.abs(s.t - t) <= SWING_MS && s.t - s.prev >= SWING_GAP_MS && facesBot(e, s.yaw))
            .sort((a, b) => Math.abs(a.s.t - t) - Math.abs(b.s.t - t))[0]
          if (swing) {
            const name = swing.e.username || 'a player'
            if (!newer) fight.lastAttrib = { t, desc: `no attacker named, ${name} swung nearby`, entity: null, ranged: false, env: true }
            console.log(`[combat] sourceless hit, ${name} swung nearby`)
            return
          }
          // The swing of a player beside the bot may still follow, an arrow in flight may vanish, the knockback of a
          // hostile's hit follows its damage_event, and so does the health update that shows a starvation hit.
          const flying = sourceless && [...arrows.values()].some(a => !a.gone && t - a.t <= ARROW_FLIGHT_MS && arrowInRange(a))
          if ((near.length || flying || (envCause && nearest) || envCause === 'starving') && !first) {
            const hp = bot.health
            const wait = new Promise(r => {
              wake = !near.length && !flying && { knock: !!nearest, health: envCause === 'starving', end: r }
              setTimeout(r, flying ? ARROW_HIT_MS : envCause ? KNOCK_MS : SWING_MS)
            }).then(() => {
              if (fight.swingWait === wait) {
                fight.swingWait = null
                wake = null
              }
              onDamage(packet, t, { cause: envCause, hp })
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
            // and a hit with an environmental cause or a damage type marks it envHit, so the hit can't arm the bunker.
            else if (fight.lastAttrib && !fight.lastAttrib.env && Date.now() - fight.lastAttrib.t < 1500) {
              if (!sourceless || envCause) fight.lastAttrib = { ...fight.lastAttrib, envHit: true }
            } else {
              // untyped marks a hit whose damage type names no cause.
              fight.lastAttrib = { t, desc: sourceless ? `no attacker named, ${envCause || 'no hostile within 4'}` : type || 'no attacker named', entity: null, ranged: false, env: true, untyped: sourceless || !type }
            }
            return
          }
          const here = bot.entity.position
          const dir = compass(cause.position.x - here.x, cause.position.z - here.z)
          const dist = Math.round(cause.position.distanceTo(here))
          const who = cause.username || cause.name || 'unknown'
          const how = `${ranged ? ' (projectile)' : ''}${knocker ? ' (knockback)' : sourceless ? ' (nearest hostile)' : ''}`
          // ranged is STICKY per attacker: one proven arrow makes it a ranged threat for the episode
          const wasRanged = (AGGRO_CONFIRMED.get(cause.id) || {}).ranged || false
          if (!newer) fight.lastAttrib = { t, desc: `${who} ${dir} ~${dist}${how}`, entity: cause, ranged: ranged || wasRanged }
          AGGRO_CONFIRMED.set(cause.id, { name: who, t: Date.now(), ranged: ranged || wasRanged })
          console.log(`[combat] attributed: hit by ${who} ${dir} ~${dist}${how}`)
        } catch (e) {}
      }
      bot._client.on('damage_event', (packet) => onDamage(packet, Date.now()))
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
function isFrame (en) {
  return en.name === 'item_frame' || en.name === 'glow_item_frame'
}
// Keeps the facing a frame spawns with, which mineflayer drops.
function keepFrameFacing (packet) {
  const en = bot.entities[packet.entityId]
  if (en && isFrame(en)) en.objectData = packet.objectData
}
// The [lo, hi] corners of frame en's 0.75 by 0.75 face, 1/16 deep against the cell side it faces away from, null without a facing.
function frameBox (en) {
  // objectData indexes down, up, north, south, west, east.
  const axis = 'yyzzxx'[en.objectData]
  if (!axis) return null
  // Both servers spawn a frame at the corner of its cell.
  const cell = en.position.floored()
  const lo = cell.offset(0.125, 0.125, 0.125)
  const hi = cell.offset(0.875, 0.875, 0.875)
  // A frame facing down, north or west hangs on the high side.
  lo[axis] = cell[axis] + (en.objectData % 2 ? 0 : 15 / 16)
  hi[axis] = lo[axis] + 1 / 16
  return [lo, hi]
}
// The point a melee swing at en aims at: a frame's face centre, else aimY above its feet, or half its height when aimY clears its top.
function meleeAim (en, aimY) {
  const box = isFrame(en) && frameBox(en)
  if (box) return box[0].plus(box[1]).scaled(0.5)
  const h = hitbox(en)[1]
  return en.position.offset(0, aimY < h ? aimY : h / 2, 0)
}
// True when the look ray from the eye over feet to meleeAim(en, aimY) enters en's box, grown 0.1, within SWING_REACH and unblocked. False for a frame without a facing.
function inMeleeReach (en, aimY = 1.2, feet = bot.entity.position) {
  // A 1.7.10 sneak lowers the eye by 0.08, a 1.21.11 one to 1.27.
  const eye = feet.offset(0, !bot.entity.crouching ? 1.62 : LEGACY_1710 ? LEGACY_SNEAK_EYE : 1.27, 0)
  let lo, hi
  if (isFrame(en)) {
    const box = frameBox(en)
    if (!box) return false
    lo = box[0].offset(-0.1, -0.1, -0.1)
    hi = box[1].offset(0.1, 0.1, 0.1)
  } else {
    const [w, h] = hitbox(en)
    const r = w / 2 + 0.1
    lo = en.position.offset(-r, -0.1, -r)
    hi = en.position.offset(r, h + 0.1, r)
  }
  const dir = meleeAim(en, aimY).minus(eye)
  // With the aim point inside the box, the ray enters at its last near-face crossing.
  let enter = 0
  for (const k of ['x', 'y', 'z']) {
    if (dir[k]) enter = Math.max(enter, ((dir[k] > 0 ? lo : hi)[k] - eye[k]) / dir[k])
  }
  // A swing reaches over a fence.
  return enter * dir.norm() <= SWING_REACH && !!lineCell(eye, eye.plus(dir.scaled(enter)), en.position.floored(), true)
}
// A pathfinder goal met on the body's start cell at build time while the body stands in inMeleeReach(en, aimY), and on
// another cell when each corner of the square a walk stops in there does.
function meleeReachGoal (en, aimY) {
  const aim = meleeAim(en, aimY)
  // A walk stands the body on the highest shape top of the node's own block when it lies inside the cell, else of the block below.
  const feet = (node) => {
    const top = (dy) => {
      const b = bot.blockAt(new Vec3(node.x, node.y + dy, node.z))
      return b && b.shapes.length ? Math.max(...b.shapes.map((s) => s[4])) : null
    }
    const inCell = top(0)
    return new Vec3(node.x + 0.5, inCell !== null && inCell < 1 ? node.y + inCell : node.y - 1 + (top(-1) ?? 1), node.z + 0.5)
  }
  // A walk stops up to 0.2 off the centre of its last cell on each axis.
  const stops = (node) => {
    const f = feet(node)
    return [[-0.2, -0.2], [-0.2, 0.2], [0.2, -0.2], [0.2, 0.2]].map(([dx, dz]) => f.offset(dx, 0, dz))
  }
  // Whether the body's box, grown 0.001, meets a shape in column x, z above its feet.
  const touches = (pos, x, z) => {
    const w = bot.entity.width / 2 + 0.001
    for (let y = Math.floor(pos.y); y < pos.y + bot.entity.height; y++) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (b && b.shapes.some((s) => x + s[0] < pos.x + w && x + s[3] > pos.x - w && z + s[2] < pos.z + w && z + s[5] > pos.z - w &&
        y + s[4] > pos.y + 0.001 && y + s[1] < pos.y + bot.entity.height)) return true
    }
    return false
  }
  // The pathfinder's start column: the floored one, or with the body touching a shape there the nearest column the body overlaps and touches none in.
  const start = () => {
    const pos = bot.entity.position
    const p = pos.floored()
    if (!touches(pos, p.x, p.z)) return p
    const w = bot.entity.width / 2
    let best = null
    for (let x = Math.floor(pos.x - w); x < pos.x + w; x++) {
      for (let z = Math.floor(pos.z - w); z < pos.z + w; z++) {
        const d = (x + 0.5 - pos.x) ** 2 + (z + 0.5 - pos.z) ** 2
        if ((!best || d < best.d) && !touches(pos, x, z)) best = { x, z, d }
      }
    }
    return best ? new Vec3(best.x, p.y, best.z) : p
  }
  const p = start()
  const reached = inMeleeReach(en, aimY)
  // On a slab the start node sits one above the floored feet.
  const own = (node) => node.x === p.x && node.z === p.z && (node.y === p.y || node.y === p.y + 1)
  return Object.assign(new goals.Goal(), {
    aim,
    heuristic: (node) => aim.distanceTo(feet(node)),
    isEnd: (node) => own(node) ? reached : stops(node).every((p) => inMeleeReach(en, aimY, p))
  })
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
// With openDoors, an open door or fence gate reads 'open', and a door, gate or trapdoor out of sight 'unknown'.
// With unseenWalkable, a walk crosses unseen cells and stands on unseen floor.
// With thinFloors, a block no higher than 0.25 reads 'open'.
// With swim, a body stands in water and swims up and down through it.
// A cell counts as seen when known(p) holds.
function fleeWorld ({ openDoors = false, unseenWalkable = false, thinFloors = false, swim = false, known = cellKnown } = {}) {
  // A 1.7.10 server keeps a door's open state in its lower half.
  const doorOpen = (b, p) => {
    const lower = b.getProperties?.().half === 'upper' ? bot.blockAt(p.offset(0, -1, 0)) : b
    return !!lower && isDoor(lower.name) && !!lower.getProperties?.().open
  }
  const blockKind = (p) => {
    const b = bot.blockAt(p)
    if (!b) return 'unknown'
    if (/lava|fire/.test(b.name)) return 'hazard'
    // A door, gate or trapdoor shows open or shut only in sight, lit or dark.
    if (openDoors && OPENABLE.test(b.name) && !seenNow(p) && !seesShape(p, 64)) return 'unknown'
    if (openDoors && isDoor(b.name) && doorOpen(b, p)) return 'open'
    if (thinFloors && b.boundingBox === 'block' && b.shapes?.length && b.shapes.every(s => s[4] <= 0.25)) return 'open'
    if (b.boundingBox === 'block') return b.shapes && b.shapes.some(s => s[4] > 1) ? 'tall' : 'solid'
    return holdsWater(b) ? 'water' : 'open'
  }
  const cells = new Map()
  const hazards = new Map()
  const covers = new Map()
  const memo = (map, x, y, z, read) => {
    const k = ck(x, y, z)
    if (!map.has(k)) map.set(k, read(new Vec3(x, y, z)))
    return map.get(k)
  }
  return {
    unseenWalkable,
    swim,
    // kindAs reads an unknown cell as unseen anyway in an unseenWalkable world.
    kind: (x, y, z, unseen) => {
      const k = ck(x, y, z)
      let c = cells.get(k)
      if (c === undefined) {
        const p = new Vec3(x, y, z)
        cells.set(k, c = { p, kind: blockKind(p), known: undefined })
      }
      if (c.kind === 'unknown' || (unseenWalkable && c.kind === unseen)) return c.kind
      if (c.known === undefined) c.known = known(c.p)
      return c.known ? c.kind : 'unknown'
    },
    hazard: (x, y, z) => memo(hazards, x, y, z, (p) => {
      const b = bot.blockAt(p)
      return !!b && /lava|fire/.test(b.name) && known(p)
    }),
    cover: (x, y, z) => memo(covers, x, y, z, (p) => {
      const b = bot.blockAt(p)
      return !!b && known(p) && !!b.shapes && b.shapes.length === 1 && b.shapes[0].join() === '0,0,0,1,1,1'
    })
  }
}
// True while creeper e swells or burns an ignited fuse, as its metadata shows.
function creeperSwelling (e) {
  const keys = (shared.mcData && shared.mcData.entitiesByName.creeper && shared.mcData.entitiesByName.creeper.metadataKeys) || []
  const at = (key) => (e.metadata || [])[keys.indexOf(key)]
  return at('swell_dir') > 0 || at('is_ignited') === true
}
// The deepest drop a creeper takes on its walk to the body.
const CREEPER_DROP = 22
// True when creeper e walks to within 2 of the body in maxSteps steps or fewer over known cells.
function creeperRoute (from, maxSteps) {
  return routeWithin(fleeWorld(), from.floored(), bot.entity.position.floored(), maxSteps, CREEPER_DROP)
}
// A walk flood reaches a mob 24 off, the farthest an unconfirmed mob scores.
const WALK_STEPS = 2 * 24 + 4
const WALK_CAP = 8000
// The walk floods to the body's ground cell by drop limit, over world as it read at t.
const WALK_MEMO = { t: 0, ground: null, world: null, floods: new Map() }
// The body's walks from its ground cell to mob cells by cell and budget, over world as it read at t.
const REACH_MEMO = { t: 0, ground: null, world: null, floods: new Map() }
function walkMemo (memo, world) {
  const now = Date.now()
  // An airborne body counts from the floor under it.
  const ground = groundCell(world, bot.entity.position.floored(), 24)
  const was = memo.ground
  if (!memo.world || now - memo.t > 1000 || was.x !== ground.x || was.y !== ground.y || was.z !== ground.z) {
    Object.assign(memo, { t: now, ground, world, floods: new Map() })
  }
  return memo
}
// True when a mob at `at` walks past seen walls and closed doors to within 1 of the body on each axis.
function walksToBody (at, { steps, drop }) {
  const memo = walkMemo(WALK_MEMO, fleeWorld({ openDoors: true, unseenWalkable: true, thinFloors: true, swim: true }))
  const flood = (d) => {
    if (!memo.floods.has(d)) memo.floods.set(d, walkersTo(memo.world, memo.ground, { maxSteps: WALK_STEPS, maxDrop: d, cap: WALK_CAP }))
    return memo.floods.get(d)
  }
  const from = at.floored()
  // A walk found under a drop of 3 holds under any deeper limit.
  const shallow = Math.min(drop, 3)
  return flood(shallow).reaches(from, steps) || (drop > shallow && flood(drop).reaches(from, steps))
}
function walkBudget (at) {
  return Math.ceil(2 * at.distanceTo(bot.entity.position)) + 4
}
// True when the body walks to within 1 of the mob on each axis, never dropping more than 1.
function bodyWalksTo (at, steps) {
  const memo = walkMemo(REACH_MEMO, fleeWorld({ openDoors: true, thinFloors: true, swim: true, known: knownCell }))
  const to = at.floored()
  const k = `${ck(to.x, to.y, to.z)} ${steps}`
  if (!memo.floods.has(k)) {
    // GoalNear(at, 2) also ends on cells 2 off, some of them behind a wall.
    const goal = (c) => Math.abs(c.x - to.x) <= 1 && Math.abs(c.y - to.y) <= 1 && Math.abs(c.z - to.z) <= 1
    const { cells, reached } = walkFlood(memo.world, memo.ground, { maxSteps: steps, maxDrop: 1, cap: WALK_CAP, goal })
    const lo = { x: Infinity, y: Infinity, z: Infinity }
    const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const c of cells.values()) for (const a of ['x', 'y', 'z']) { lo[a] = Math.min(lo[a], c[a]); hi[a] = Math.max(hi[a], c[a]) }
    memo.floods.set(k, {
      reached: !!reached,
      // The cells the flood's steps read.
      touches: (p) => p.x >= lo.x - 1 && p.x <= hi.x + 1 && p.z >= lo.z - 1 && p.z <= hi.z + 1 && p.y >= lo.y - 2 && p.y <= hi.y + 2
    })
  }
  return memo.floods.get(k).reached
}
// True when the line from the eye to en's chest crosses a seen solid cell or a closed door.
function eyeLineWalled (en) {
  const world = fleeWorld({ openDoors: true, unseenWalkable: true, thinFloors: true })
  return !!gridWalk(bot.entity.position.offset(0, 1.62, 0), en.position.offset(0, 1.0, 0), (c) => world.kind(c.x, c.y, c.z) === 'solid')
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
    if (confirmed) return [{ e, at }]
    const d = at.distanceTo(bot.entity.position)
    if (c === 'creeper' && creeperSwelling(e)) return [{ e, at }]
    if (walksToBody(at, { steps: Math.ceil(2 * d) + 4, drop: c === 'creeper' ? CREEPER_DROP : 3 })) return [{ e, at }]
    return rangedInSight(e, at) ? [{ e, at }] : []
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
  bot.on('blockUpdate', (oldB, newB) => {
    const p = (newB || oldB)?.position
    for (const memo of [WALK_MEMO, REACH_MEMO]) if (p && [...memo.floods.values()].some(f => f.touches(p))) memo.world = null
  })
  bot.on('chunkColumnLoad', () => { WALK_MEMO.world = null; REACH_MEMO.world = null })
}

// the watcher+responder reflex — priority ABOVE unstuck (unshift), toggle via /reflexes name=combat
const combatReflex = {
  name: 'combat', on: true, active: false,
  _hist: new Map(), _lastNarrate: new Map(), _threat: null,
  // _seenAt maps an entity id to where the body last perceived it.
  _seenAt: new Map(),
  // _watched holds the perceived creepers the last check pass watched, and that pass's time t.
  _watched: null,
  // _fleeCls is the mobClass of the threat the last flee ran from, _sprint the token of its sprint.
  // _noWalk is the threat id and cell of the last no-walk hold that logged.
  _fill: null, _fillT: 0, _fillSeed: null, _fleeUntil: 0, _fleeT: 0, _fleeCls: null, _sprint: null, _noWalk: null, _coverUntil: 0, _holdUntil: 0,
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
  // True while the reflex is on and fights, flees, takes cover, or scores a live threat it fires at next.
  fightBusy () {
    if (!this.on) return false
    const now = Date.now()
    const t = this._threat
    return this.active || now < this._fleeUntil || now < this._holdUntil || now < this._coverUntil ||
      (!!t && !!t.e && t.cls !== 'player' && !!bot.entities[t.e.id])
  },
  // The creepers of _watched still loaded, each with the berth a walk keeps from it, [] once the pass is over 1 s old.
  watchedCreepers () {
    const w = this._watched
    if (!w || Date.now() - w.t > 1000) return []
    const radius = STANCES[fight.stance].fleeDist + CREEPER_ZONE_SLACK
    return w.zones.filter(z => bot.entities[z.id]).map(z => ({ id: z.id, at: z.at.clone(), radius }))
  },
  // Returns 'held' when no safe cell exists or the pillar top keeps the body. A flee keeps its goal for 6 s.
  fleeFrom (bot, threat, why, klass = 'discretionary') {
    const now = Date.now()
    if (laneBlocks(klass)) {
      const onPillar = perchHolds()
      if (onPillar) this.narrate('hold', 'the combat reflex ' + threatWhy('kept the body on the pillar top instead of a flee', threat, this.fairFill(bot)))
      laneNarrate(why || 'flee')
      return onPillar ? 'held' : undefined
    }
    if (now < this._fleeUntil) return
    if (now < this._holdUntil) return 'held'
    this._fleeUntil = now + 6000
    try {
      const here = bot.entity.position
      const fill = this.fairFill(bot)
      const seen = entityPerceptible(threat, fill)
      const at = this.perceivedAt(threat, seen)
      const anchor = reflexes.find(r => r.name === 'flee_to_player')
      const ally = at && anchor && anchor.on ? anchor.ally(bot, here, at, fill) : undefined
      const others = nearHostiles(fill, 16, this._seenAt).filter(h => h.e.id !== threat.id)
      const mobs = others.map(h => h.at)
      const world = fleeWorld()
      const swelling = mobClass(threat) === 'creeper' && creeperSwelling(threat) && seen
      // A swelling creeper stops once it loses sight of the body.
      const cover = swelling ? creeperCover({ world, here, creeper: threat.position, mobs, legacy1710: LEGACY_1710 }) : null
      // A hit proves the mob has a way to the body.
      if (!swelling && at && !AGGRO_CONFIRMED.has(threat.id)) {
        const walk = Math.ceil(2 * at.distanceTo(here)) + 4
        const creeper = mobClass(threat) === 'creeper'
        const steps = creeper ? Math.max(walk, STANCES[fight.stance].fleeDist) : walk
        // No hold while another near hostile hit the body, shoots at it, walks to it or swells.
        if (!walksToBody(at, { steps, drop: creeper ? CREEPER_DROP : 3 }) && !rangedInSight(threat, at) && !others.length) {
          this._fleeUntil = 0
          this.narrate('hold', 'the combat reflex ' + threatWhy('held, no flee, it has no walk to me', threat, fill))
          const c = at.floored()
          const held = `${threat.id} ${c}`
          if (this._noWalk !== held) {
            this._noWalk = held
            console.log(`[flee] from ${threat.name || '?'} at (${c.x},${c.y},${c.z}): no walk to the body, holding`)
          }
          return 'held'
        }
      }
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
      if (bot.food >= MIN_FOOD) {
        bot.setControlState('sprint', true)
        const sprint = this._sprint = {}
        setTimeout(() => { if (this._sprint === sprint) try { bot.setControlState('sprint', false) } catch (e) {} }, this._fleeUntil - now)
      }
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
    if (soleClaim()) return
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
      const reach = eye && walkFlood(fleeWorld({ openDoors: true }), here, { maxSteps: 6, maxDrop: 3 }).cells
      let bestCell = null; let bestD = Infinity
      if (eye) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        if (!dx && !dz) continue
        for (let dy = -1; dy <= 1; dy++) {
          const x = here.x + dx, y = here.y + dy, z = here.z + dz
          if (!stand(x, y, z) || !reach.has(ck(x, y, z))) continue
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
    // A door shows open or shut only in sight, lit or dark, and one out of sight walls the flood.
    const known = (p) => knownCell(p) && (!OPENABLE.test(bot.blockAt(p).name) || seenNow(p) || seesShape(p, 64))
    this._fill = airFlood({ radius: 20, cap: 15000, known, knownOnly: true })
    this._fillT = now; this._fillSeed = seed
    return this._fill
  },
  check (bot) {
    // A sole claim (the buried self-rescue or the bunker build) holds the hand and the legs.
    if (bunker.building || soleClaim()) return false
    try {
      const now = Date.now()
      const here = bot.entity.position
      let best = null
      const zones = []
      const watch = (e, cls, dist, seen, at) => {
        if (cls === 'creeper' && seen) zones.push({ id: e.id, at: at.clone() })
        const wk = 'w' + e.id
        if (cls !== 'player' && now - (this._lastNarrate.get(wk) || 0) > 20000 && entityPerceptible(e, this.fairFill(bot))) {
          this._lastNarrate.set(wk, now)
          const rel = e.position.y > here.y + 1 ? 'above' : (e.position.y < here.y - 1 ? 'below' : 'beyond')
          emitEvent('threat', `watched: ${e.name || '?'} ${rel} ~${Math.round(dist)} — separated, not driving`, null, { quiet: true })
        }
      }
      expireConfirmed(AGGRO_CONFIRMED, now, CONFIRMED_MS)
      for (const [id, hit] of AGGRO_CONFIRMED) if (now - Math.max(hit.t, hit.near || 0) > CONFIRMED_COOL_MS) AGGRO_CONFIRMED.delete(id)
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
        if (confirmed && seen && inMeleeReach(e)) confirmed.near = now
        const at = this.perceivedAt(e, seen)
        const dist = at ? at.distanceTo(here) : Infinity
        if (at && dist > CONFIRMED_HORIZON) { this._hist.delete(e.id); continue }
        // WATCHED tier (the mansion lesson): perceptible but a floor away — narrate rarely, never score
        if (!entityEngageable(e)) { watch(e, cls, dist, seen, at); continue }
        const h = this._hist.get(e.id) || { d: dist, t: now, closes: 0, logT: 0 }
        const dt = (now - h.t) / 1000
        if (at && dt >= 0.25) {
          const closingSpeed = (h.d - dist) / dt              // blocks/sec toward me
          // DECAY not reset (the helmsman's calibration question, 07-15): mob pathfinding stutters — one
          // slow sample must not erase pursuit evidence; only sustained non-approach drains it.
          // A chasing zombie closes at about 2.3 b/s.
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
          if (!h.route) { watch(e, cls, dist, seen, at); continue }
        }
        let shooting = false
        if (aggro && (cls === 'hostile' || cls === 'heavy') && !confirmed && at && !perchAggro) {
          const walk = walksToBody(at, { steps: Math.ceil(2 * dist) + 4, drop: 3 })
          shooting = !walk && rangedInSight(e, at)
          if (!walk && !shooting) { watch(e, cls, dist, seen, at); continue }
        }
        // A creeper the body perceives within the stance's flee distance outranks every other mob.
        const urgent = cls === 'creeper' && dist <= STANCES[fight.stance].fleeDist && seen
        if (aggro && (!best || urgent > best.urgent || (urgent === best.urgent && dist < best.dist))) best = { e, cls, dist, confirmed: !!confirmed, urgent, shooting }
      }
      this._watched = { t: now, zones }
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
      else if (t.shooting) emitEvent('threat', `${label} ${dir} ~${Math.round(t.dist)} in sight, shooting range [${fight.stance}]`)
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
    // The swing cycle raises and lowers the guard without a cause.
    const guardUp = (cause = null) => {
      if (!guardState.up && !guardState.hand && canGuard()) { try { bot.activateItem(!LEGACY_1710); guardState.set(true, cause); Object.assign(guardState, { slot: bot.quickBarSlot, item: bot.heldItem?.name }) } catch (e) {} }
    }
    const guardDown = (cause = null) => { if (guardState.up) { try { bot.deactivateItem() } catch (e) {} ; guardState.set(false, cause) } }
    // Swapping items ends a sword block.
    const swordInHand = async () => {
      await handFree()
      if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) { await bot.equip(sword, 'hand'); guardState.set(false, 'for the sword in hand') }
    }
    // On 1.7.10 a block the pilot raised goes back up after the fight, sword in hand. True when the
    // pilot's order applies.
    const pilotGuard = async () => {
      if (!LEGACY_1710 || !guardState.pilot || bunker.building || soleClaim()) return false
      try { await swordInHand() } catch (e) {}
      guardUp('as the pilot ordered')
      return true
    }
    const pursuit = { ...(this._hist.get(t.e.id) || { d: t.dist, t: now, closes: 0 }) }
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
      const why = `vs ${label} ~${Math.round(d)}: ${g.why}`
      if (g.up) guardUp(why)
      else if (!guardState.pilot) guardDown(why)
    }
    if (t.cls === 'creeper' || t.cls === 'heavy') {
      // Never trade with these — but "never melee" stopped meaning "only run" when stances landed:
      // beyond the stance's berth and inside the bow band, the answer is an arrow, not distance.
      // Lane classes: a creeper in berth is an EMERGENCY (fuses don't negotiate); a heavy's kite
      // is an INTERRUPT (passes the soft lane, defers to /brace's hard one).
      const fk = t.cls === 'creeper' ? 'emergency' : 'interrupt'
      const flee = () => {
        const held = this.fleeFrom(bot, t.e, null, fk) === 'held'
        if (held && !strikeRun.lane) guardUp(`vs ${label}: held in place, no flee`)
        else if (!guardState.pilot) guardDown(`vs ${label}: ${held ? 'a strike or shoot holds the hand' : 'the flee'}`)
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
      while (this.on && !bunker.building && !soleClaim() && !holdRun.on && bot.entities[t.e.id] && Date.now() - t0 < 10000) {
        // An urgent creeper ends the melee, and the fought threat goes back into this._threat for meleeThreat().
        const fought = this._threat
        const creeperFirst = this.check(bot) && this._threat.urgent
        this._threat = fought
        if (creeperFirst) return
        const perceived = entityPerceptible(t.e, this.fairFill(bot))
        const at = this.perceivedAt(t.e, perceived)
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
          if (!guardState.pilot) guardDown(`vs ${label}: a strike or shoot holds the hand`)
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
          if (perceived && d >= lo && d <= hi && pockets.some(i => i.name === 'bow') && pockets.some(i => i.name === 'arrow') && bowLine(t.e)) {
            guardDown(`vs ${label}: the bow`)
            try { if (await drawAndLoose(t.e)) { await new Promise(r => setTimeout(r, 200)); continue } } catch (e) {}
          }
          if (s.chase && !perchHit && entityPerceptible(t.e, this.fairFill(bot)) && at && bodyWalksTo(at, walkBudget(at))) {   // only vanguard chases
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
        if (s.chase && !laneBlocks('discretionary')) {
          if (bot.pathfinder.goal) takeLegs('combat', threatWhy('fight in melee range', t.e, this.fairFill(bot)))
          try { bot.pathfinder.setGoal(null) } catch (e) {}
        }
        try {
          if (LEGACY_1710) {
            // The sword block holds while the hit waits, against a mob in sight or one that can walk to the body.
            await swordInHand()
            const reachable = !!at && (losClear(bot.entity.position.offset(0, 1.62, 0), at.offset(0, 1.62, 0)) || creeperRoute(at, GUARD_STEPS))
            if (!reachable && !guardState.pilot) guardDown(`vs ${label}: no walk to the body`)
            const inSight = () => entityPerceptible(t.e, this.fairFill(bot))
            if (!inSight()) {
              if (reachable || guardState.pilot) guardUp(`vs ${label}: in reach out of sight`)
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
        if (!guardState.pilot) guardDown(`vs ${label}: a strike or shoot holds the hand`)
      } else if (!(await pilotGuard())) guardDown(`vs ${label}: the fight ended`)
    }
    // Out of sight, a vanished target may have despawned instead of died.
    if (!bot.entities[t.e.id] && entityPerceptible(t.e, this.fairFill(bot))) emitEvent('combat', `${t.e.username || t.e.name || '?'} is DOWN`)
    // POST-COMBAT REFUEL (07-21, the mill's slow-bleed autopsy: /eat fails silently while
    // combat owns the hand, so food ratchets down across engagements and regen quits at 17.
    // The moment the hand is free is the moment to eat — before the next wave claims it.)
    if (bot.food <= SPRINT_FLOOR && !bunker.building && !soleClaim() && !holdRun.on && !strikeRun.lane) {
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
    // An earlier stalled sprint never blocks a new opener.
    bot.pathfinder.sprintBlocked = false
    bot.setControlState('sprint', true)
    bot.setControlState('forward', true)
    try {
      for (let i = 0; i < RUN_TICKS && !bot.pathfinder.sprintBlocked && bot.entities[e.id] && !inMeleeReach(e, aimY) && seen() && onLine() && ran() < length; i++) {
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
  await handFree()
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
  Object.assign(ctx, { fight, STANCES, drawAndLoose, bowLine, AGGRO_CONFIRMED, CONFIRMED_HORIZON, CONFIRMED_MS, guardState, holdHand, endHand, handFree, refuseWhileFighting, MOVES, legsMoving, mobClass, nearestHostile, lastSwing, SWING_MS, SWING_GAP_MS, SWING_FACING, arrows, ARROW_FLIGHT_MS, ARROW_HIT_MS, SHOOTERS, ARROW_RANGE, ARROWS, ARROW_LOOSE, arrowAttrib, arrowHitOf, starves, starveDrop, drowns, perched, PERCH_MELEE, PERCH_DROP, perchStrike, inChokepoint, hpMelee, hitbox, meleeAim, inMeleeReach, meleeReachGoal, meleeThreat, disengageHp, entityEngageable, fleeWorld, creeperSwelling, CREEPER_DROP, creeperRoute, bodyWalksTo, walkBudget, eyeLineWalled, GUARD_REACH, GUARD_STEPS, standoffGuard, fleeLog, nearHostiles, threatWhy, combatReflex, fleeToPlayerReflex, mobHurt, sprintBlock, meleeSwing, chargedSwing })
}

function bindCombat (ctx) {
  ({ bot, losClear, reflexes, shared, liveEntities, entityPerceptible, compass, perchHolds, knownCell, OPENABLE, lineCell, ck, cellKnown, seenNow, seesShape, holdsWater, touchesFill, emitEvent, laneBlocks, laneNarrate, takeLegs, stopPath, gridWalk, airFlood, bunker, holdRun, strikeRun, yieldJob, refuelAfterFight, bunkerHolds, waterState } = ctx)
}

module.exports = { createCombat, bindCombat, wireDamageTypes, wireGuardDrop, wireHandLease, wireItemUseCosts, wireArmSwings, wireArrowTracking, wireDamageAttribution, wireFloodDrops, wireMobHurt }
