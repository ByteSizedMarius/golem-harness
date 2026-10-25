'use strict'

const { POINT_RANGE, lookedAt } = require('../deixis')
const { LEGACY_1710 } = require('./config')
const { LEGACY_SNEAK_EYE } = require('./legacy-1710')
const { segmentMeets } = require('./sight')

let bot, emitEvent, entityPerceptible, liveEntities, staleEntities, reflexes, seesLit, losClear, yawToCompass, mobClass, hitbox, recentOwnEdits, ck

// A player stands still while they stay within STILL_EPS of where they stopped for STILL_MS.
const STILL_EPS = 0.3
const STILL_MS = 500
// A swing's dig, block change or hit arrives within this time.
const SETTLE_MS = 250
// A point goes out this long after its second swing. Look updates arrive on 50 ms server ticks, so a 1.21.11 turn sent 300 ms after the punch can arrive at 450 ms.
const HOLD_MS = LEGACY_1710 ? SETTLE_MS : 500
// The first angle update within this time of a swing carries the look it was made with. It arrives 50 to 100 ms
// after the swing, and a turn's update about 100 ms after that one.
const LOOK_MS = 120
// A block this close on the received look is what the punch hit.
const RAY_REACH = 5.5
// A break progress this recent from the swinger makes the swing a dig.
const BREAK_MS = 1000
// A block change or hit this long before the swing still counts as caused by it.
const SWING_LEAD_MS = 300
// A box whose closest point lies farther than this from the eye is out of the punch's reach.
const SWING_REACH = 6
// A hitbox this close to a possible line of the punch could be what it aimed at.
const ENTITY_GAP = 0.5
// A projectile or dropped item spawning this close to the eye makes the swing a cast, throw or drop.
const THROW_ZONE = 3
// A hostile this close to the swinger makes the swing part of a fight.
const HOSTILE_RADIUS = 8
// One point lasts while its player stays within STILL_SPAN, turns less than TURN and repeats the double punch within EPISODE_IDLE_MS.
const STILL_SPAN = 1.5
const TURN = 20 * Math.PI / 180
const EPISODE_IDLE_MS = 20000
// The least time between two points of one player.
const GAP_MS = 5000
// A point takes a second punch at the same spot within this time of the first.
const PAIR_MS = 1000
// A pair's decision reads use marks back to its first swing's look-back.
const USE_KEEP_MS = PAIR_MS + SWING_LEAD_MS + SETTLE_MS
// A look past TILT from level reads up or down, and one past STEEP has no bearing.
const TILT = 20 * Math.PI / 180
const STEEP = 70 * Math.PI / 180
// Head angles cross the wire as one byte, floored.
const AIM_STEP = 2 * Math.PI / 256
// The server sends a head angle once its byte has moved this many steps from the last one sent.
const AIM_RESEND = LEGACY_1710 ? 4 : 1
// Looks at most this many steps apart on each axis aim at one spot. On 1.7.10, whose bytes lag the head up to 3 steps, a 2-step twitch can arrive as 5.
const SPOT_STEPS = Math.max(AIM_RESEND, 4)
// Rays per step across the possible looks.
const AIM_SPLIT = 2
// With mineflayer's sign flip, the true look lies in (received - AIM_RESEND, received + AIM_RESEND - 1] steps on each axis.
const AIM_OFFSETS = Array.from({ length: (2 * AIM_RESEND - 1) * AIM_SPLIT + 1 }, (_, i) => (i / AIM_SPLIT - AIM_RESEND) * AIM_STEP)
const AIM_CENTRE = (AIM_OFFSETS[0] + AIM_OFFSETS[AIM_OFFSETS.length - 1]) / 2
// The [yaw, pitch] offsets of every possible look.
const AIM_PAIRS = AIM_OFFSETS.flatMap((dy) => AIM_OFFSETS.map((dp) => [dy, dp]))
const USE_SOUNDS = {
  // Through Via, most 1.7.10 place sounds arrive as their material's break sound.
  place: /^(?:block\.[a-z_]+\.(?:place|place_in_water|break)|item\.(?:crop|nether_wart)\.plant)$/,
  chest: /^block\.(?:(?:[a-z_]+_)?chest|copper_chest_(?:weathered|oxidized)|barrel|shulker_box)\.(?:open|close)$/,
  door: /^block\.(?:[a-z_]+_)?(?:door|trapdoor|fence_gate)\.(?:open|close)$/,
  button: /^block\.[a-z_]+_button\.click_(?:on|off)$/,
  // Through Via, a 1.7.10 lever or button click arrives as the dispenser's.
  lever: /^block\.(?:lever\.click|dispenser\.dispense)$/,
  fill: /^item\.(?:bottle\.(?:fill(?:_dragonbreath)?|empty)|bucket\.(?:fill|empty)(?:_(?:lava|fish|axolotl|powder_snow|tadpole))?)$/,
  use: /^(?:block\.(?:bell\.use|composter\.(?:fill(?:_success)?|empty)|respawn_anchor\.(?:charge|set_spawn)|chiseled_bookshelf\.(?:insert|pickup)(?:\.enchanted)?|decorated_pot\.insert(?:_fail)?|shelf\.(?:single_swap|multi_swap|place_item|take_item)|vault\.insert_item(?:_fail)?|(?:cave_vines|sweet_berry_bush)\.pick_berries|candle\.extinguish|cake\.add_candle|(?:hanging_)?sign\.waxed_interact_fail)|item\.(?:book\.put|lead\.tied))$/
}
// Blocks the client swings at on a right-click, as named on a 1.21.11 client (a grave arrives as end_rod).
const USE_BLOCKS = new RegExp('^(?:crafting_table|furnace|smoker|blast_furnace|barrel|loom|grindstone|stonecutter|cartography_table|smithing_table|lectern|(?:chipped_|damaged_)?anvil|enchanting_table|brewing_stand|dispenser|dropper|hopper|crafter|(?:trapped_|ender_)?chest|(?:waxed_)?(?:(?:exposed|weathered|oxidized)_)?copper_(?:chest|golem_statue)|(?:[a-z_]+_)?shulker_box|beacon|(?:repeating_|chain_)?command_block|lever|[a-z_]+_(?:button|door|trapdoor|fence_gate|fence|bed|shelf)|repeater|comparator|note_block|jukebox|bell|composter|respawn_anchor|chiseled_bookshelf|decorated_pot|vault|(?:soul_)?campfire|(?:[a-z_]+_)?candle|(?:(?:[a-z_]+_)?candle_)?cake|cave_vines(?:_plant)?|sweet_berry_bush|(?:water_|lava_|powder_snow_)?cauldron|(?:deepslate_)?redstone_ore|flower_pot|potted_[a-z_]+|dragon_egg|end_rod' + (LEGACY_1710
  ? ''
  : '|redstone_wire|daylight_detector|[a-z_]+_sign') + ')$')
// A look passes through the gaps a door or trapdoor leaves when open, and beside or over a fence gate's panel.
const SWINGING = /^[a-z_]+_(?:door|trapdoor|fence_gate)$/
// Held items whose use on a block swings the arm without a sound the bot is sure to hear and recognise, named as they reach a 1.21.11 client.
const USE_ITEMS = new RegExp('^(?:bone_meal|flint_and_steel|fire_charge|ender_eye|firework_rocket|lead|painting|item_frame|[a-z_]+_hoe|[a-z_]+_spawn_egg|(?:[a-z_]+_)?minecart|music_disc_[a-z0-9_]+|' + (LEGACY_1710
  ? 'cocoa_beans|(?:wheat|pumpkin|melon)_seeds|nether_wart|carrot|potato|redstone|[a-z_]+_(?:sign|door|bed|skull|head)|' +
    '(?:(?:[a-z_]+_)?stained_)?glass(?:_pane)?|(?:packed_)?ice|glowstone|redstone_lamp|end_portal_frame|(?:chipped_|damaged_)?anvil'
  : '[a-z_]+_(?:axe|shovel|dye|boat|raft)|shears|honeycomb|brush|(?:glow_)?ink_sac|(?:water|lava|powder_snow|cod|salmon|pufferfish|tropical_fish|axolotl|tadpole)_bucket|bucket|glass_bottle|(?:splash_|lingering_)?potion|glow_item_frame|armor_stand|end_crystal|compass|filled_map') + ')$')
// Held items that place a block of another name, as named on a 1.21.11 client.
const RENAMED_PLACERS = new Set(['string', 'redstone', 'wheat_seeds', 'beetroot_seeds', 'pumpkin_seeds', 'melon_seeds', 'torchflower_seeds', 'pitcher_pod', 'cocoa_beans', 'carrot', 'potato', 'sweet_berries', 'glow_berries'])
// Past this distance from the bot's feet to the player's eye, a place sound from the player's reach can fall outside the bot's hearing.
const PLACE_EARSHOT = LEGACY_1710 ? 7 : 8
// Through Via, a 1.7.10 door, trapdoor or fence gate reaches a 1.21.11 client as one of these level events.
const DOOR_EVENTS = new Set(LEGACY_1710 ? [1005, 1011] : [])
// The level event that plays a broken block's break sound.
const BREAK_EVENT = 2001
const FILLS = /^(?:bucket|glass_bottle)$/
// Held items a 1.21.11 client places on the water its look meets.
const FLOATS = LEGACY_1710 ? null : /^(?:lily_pad|frogspawn)$/
// The liquids a look passes (lookPasses in deixis.js).
const FLUIDS = /^(?:water|lava|bubble_column)$/
// The liquids a FLOATS item's look stops at.
const WATERS = /^(?:water|bubble_column)$/
// What a filling or floating item's look meets in a liquid it stops at.
const FLUID_STOP = { name: 'fluid' }
// A block sound plays at the block's centre, its position rounded to an eighth of a block on each axis.
const SOUND_HALF = 0.5 + 1 / 8
// A dig or placement of the bot's own this recent made the sound at its cell.
const OWN_EDIT_MS = 8000

// By username: when the player's last point went out (lastT), and its stance, look and newest swing (episode).
const pointers = new Map()
// Usernames whose point waits for HOLD_MS.
const holding = new Set()
// By entity id: where the player stopped and since when.
const anchors = new Map()
// By entity id: a swing that passed every check and waits for a second at its spot, with its look and the cell it names.
const firsts = new Map()
// Swing looks still waiting for their angle update.
const openLooks = new Set()
// Break times by breaker id, then recent block changes, hurts, item or projectile spawns and block use sounds,
// oldest first. Hurts and spawns keep the entity as it was then.
const breaks = new Map()
const blockMarks = []
const hurtMarks = []
const spawnMarks = []
const soundMarks = []
// What the look passes in the eye's own cell.
const AIR = { name: 'air' }

// Marks older than BREAK_MS fall outside every window, use marks older than USE_KEEP_MS outside every pair's.
function pointPrune (now) {
  for (const [id, t] of breaks) if (now - t > BREAK_MS) breaks.delete(id)
  for (const [list, keep] of [[blockMarks, BREAK_MS], [hurtMarks, BREAK_MS], [spawnMarks, BREAK_MS], [soundMarks, USE_KEEP_MS]]) {
    while (list.length && now - list[0].t > keep) list.shift()
  }
}

// A player with no anchor has not moved since the bot saw them.
function pointStill (e, now) {
  const a = anchors.get(e.id)
  return !a || (e.position.distanceTo(a.pos) <= STILL_EPS && now - a.t >= STILL_MS)
}

// The look last received for player e, with the yaw of its entity look, which arrives apart from the head yaw.
function pointHeld (e) {
  return { yaw: e.headYaw ?? e.yaw, pitch: e.pitch, entityYaw: e.yaw }
}

// Opens the look player e swings with at now, held until an angle update within LOOK_MS replaces it.
function pointSwingLook (e, now) {
  const held = pointHeld(e)
  const look = { id: e.id, held, yaw: held.yaw, pitch: held.pitch, entityYaw: held.entityYaw, until: now + LOOK_MS }
  openLooks.add(look)
  return look
}

// True when looks a and b lie more than SPOT_STEPS steps apart on either axis.
function pointApart (a, b) {
  const steps = (x, y) => Math.round(Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y))) / AIM_STEP)
  return steps(a.yaw, b.yaw) > SPOT_STEPS || steps(a.pitch, b.pitch) > SPOT_STEPS
}

// True when player e's head angle, or on 1.21.11 its entity look, turned more than SPOT_STEPS steps on an axis since look.
// A 1.7.10 server resends each of the two once it is 4 steps from its own last sent byte.
function pointTurned (e, look) {
  const held = pointHeld(e)
  return pointApart(held, look) || (!LEGACY_1710 && pointApart({ yaw: held.entityYaw, pitch: held.pitch }, { yaw: look.entityYaw, pitch: look.pitch }))
}

function pointMoved (e) {
  if (!e || e.type !== 'player') return
  const now = Date.now()
  const a = anchors.get(e.id)
  // The first position seen counts as held from before the bot saw the player.
  if (!a) anchors.set(e.id, { pos: e.position.clone(), t: -Infinity })
  else if (e.position.distanceTo(a.pos) > STILL_EPS) anchors.set(e.id, { pos: e.position.clone(), t: now })
  // Head yaw and pitch arrive in separate packets. Each axis takes its first change.
  const cur = pointHeld(e)
  for (const look of openLooks) {
    if (look.id !== e.id || now > look.until) continue
    if (look.yaw === look.held.yaw) look.yaw = cur.yaw
    if (look.pitch === look.held.pitch) look.pitch = cur.pitch
    if (look.entityYaw === look.held.entityYaw) look.entityYaw = cur.entityYaw
  }
}

function pointBreak (block, stage, e) {
  if (e) breaks.set(e.id, Date.now())
}

// A door or lever toggle counts as a block change.
function pointBlock (oldB, newB) {
  try {
    if (oldB && newB && oldB.stateId === newB.stateId) return
    const now = Date.now()
    pointPrune(now)
    blockMarks.push({ p: (newB || oldB).position, t: now })
  } catch (e) {}
}

function pointHurt (e) {
  if (!e) return
  const now = Date.now()
  pointPrune(now)
  hurtMarks.push({ e: { id: e.id, type: e.type, name: e.name, metadata: e.metadata, position: e.position.clone(), height: e.height, box: hitbox(e) }, t: now })
}

// A cast bobber or a throw has left the eye by decision time.
function pointSpawn (e) {
  if (!e || (e.name !== 'item' && e.type !== 'projectile')) return
  const now = Date.now()
  pointPrune(now)
  spawnMarks.push({ e: { id: e.id, name: e.name, type: e.type, position: e.position.clone() }, t: now })
}

function pointUse (p) {
  const now = Date.now()
  const own = recentOwnEdits.get(ck(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)))
  if (own !== undefined && now - own <= OWN_EDIT_MS) return
  pointPrune(now)
  soundMarks.push({ p, t: now })
}

function pointSound (name, p) {
  try {
    const path = String(name).replace(/^minecraft:/, '')
    if (!p || !Object.values(USE_SOUNDS).some((re) => re.test(path))) return
    pointUse(p)
  } catch (err) { console.log('[point] sound check failed: ' + err.message) }
}

function pointLevelEvent (packet) {
  try {
    if (packet.effectId !== BREAK_EVENT && !DOOR_EVENTS.has(packet.effectId)) return
    const c = packet.location
    pointUse({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 })
  } catch (err) { console.log('[point] level event check failed: ' + err.message) }
}

function pointSwing (e) {
  try {
    if (!e || e.type !== 'player' || e === bot.entity || e.username === bot.username || staleEntities.has(e.id)) return
    // A rider moves with the mount.
    if (e.vehicle) return
    const now = Date.now()
    pointPrune(now)
    if (e.position.distanceTo(bot.entity.position) > POINT_RANGE || !pointStill(e, now)) return
    if (!entityPerceptible(e, reflexes.find(r => r.name === 'combat').fairFill(bot))) return
    const look = pointSwingLook(e, now)
    setTimeout(() => pointDecide(e, now, look), SETTLE_MS)
  } catch (err) { console.log('[point] swing check failed: ' + err.message) }
}

// The unit vector of a look, as lookedAt walks it.
function pointDir (yaw, pitch) {
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
}

// A click ray meets a fence gate's closed panel whether the gate is open or not.
function pointGateOutline (b) {
  const { facing, in_wall: inWall } = b.getProperties()
  const top = inWall ? 0.8125 : 1
  return [facing === 'north' || facing === 'south' ? [0, 0, 0.375, 1, top, 0.625] : [0.375, 0, 0, 0.625, top, 1]]
}

// The first block on the look past the eye's own cell (a doorway, ladder or vine) and past SWINGING blocks it misses.
// Liquids that stop the look count in the own cell too.
function pointRay (eye, yaw, pitch, maxDist, blockAt = (c) => bot.blockAt(c)) {
  const own = eye.floored()
  // Beyond the far side of every cell the look enters.
  const end = eye.offset(...pointDir(yaw, pitch).map((d) => d * (maxDist + 2)))
  return lookedAt(eye, yaw, pitch, (c) => {
    if (c.equals(own)) return blockAt(c) === FLUID_STOP ? FLUID_STOP : AIR
    const b = blockAt(c)
    if (!b || !SWINGING.test(b.name)) return b
    const boxes = b.name.endsWith('_fence_gate') ? pointGateOutline(b) : b.shapes
    return boxes.some((s) => segmentMeets(eye, end, c, s)) ? b : AIR
  }, maxDist)
}

function pointFullCube (b) {
  return b.shapes.length === 1 && b.shapes[0].every((v, i) => v === (i < 3 ? 0 : 1))
}

// The distance from the point from to the box from lo to hi.
function pointGap (lo, hi, from) {
  return Math.hypot(...from.map((f, i) => Math.max(lo[i] - f, 0, f - hi[i])))
}

// True when the block whose sound played at p lies within SWING_REACH of eye.
function pointHeardNear (p, eye) {
  const c = [p.x, p.y, p.z]
  return pointGap(c.map((v) => v - SOUND_HALF), c.map((v) => v + SOUND_HALF), [eye.x, eye.y, eye.z]) <= SWING_REACH
}

// True when the [width, height] box with its feet at p lies within SWING_REACH of eye and, grown by ENTITY_GAP,
// meets a look from eye along one of dirs.
function pointNearLook (p, [width, height], eye, dirs) {
  const half = (width || 0) / 2
  const lo = [p.x - half, p.y, p.z - half]
  const hi = [p.x + half, p.y + (height || 0), p.z + half]
  const from = [eye.x, eye.y, eye.z]
  if (pointGap(lo, hi, from) > SWING_REACH) return false
  return dirs.some((dir) => {
    let near = 0
    let far = Infinity
    for (let i = 0; i < 3; i++) {
      const l = lo[i] - ENTITY_GAP
      const h = hi[i] + ENTITY_GAP
      if (dir[i] === 0) {
        if (from[i] < l || from[i] > h) return false
        continue
      }
      const a = (l - from[i]) / dir[i]
      const b = (h - from[i]) / dir[i]
      near = Math.max(near, Math.min(a, b))
      far = Math.min(far, Math.max(a, b))
      if (near > far) return false
    }
    return true
  })
}

// The block on the middle of the possible looks, when sees passes its cell.
function pointHit (eye, yaw, pitch, sees) {
  const hit = pointRay(eye, yaw + AIM_CENTRE, pitch + AIM_CENTRE, POINT_RANGE)
  return hit && sees(hit.cell) ? hit : null
}

function pointText (e, eye, yaw, pitch, hit) {
  const p = e.position
  const tilt = pitch > TILT ? 'up' : pitch < -TILT ? 'down' : 'level'
  const way = Math.abs(pitch) > STEEP ? tilt : `${yawToCompass(yaw)}, ${tilt}`
  let at = ''
  if (hit) {
    const held = AIM_OFFSETS.every((dy) => AIM_OFFSETS.every((dp) => pointRay(eye, yaw + dy, pitch + dp, POINT_RANGE)?.cell.equals(hit.cell)))
    at = `, ${held ? 'at' : 'near'} ${hit.block.name} ${hit.cell.x} ${hit.cell.y} ${hit.cell.z}`
  }
  return `${e.username} at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} points ${way}${at}`
}

// Emits a point event when player e's swing at swingT pairs with one at the same spot and nothing else explains either.
function pointDecide (e, swingT, look) {
  openLooks.delete(look)
  const first = firsts.get(e.id)
  firsts.delete(e.id)
  try {
    const now = Date.now()
    if (bot.entities[e.id] !== e || !pointStill(e, now)) return
    const combat = reflexes.find(r => r.name === 'combat')
    const fill = combat.fairFill(bot)
    if (!entityPerceptible(e, fill)) return
    if (now - (breaks.get(e.id) ?? -Infinity) <= BREAK_MS) return
    if (combat.fightBusy()) return
    const eye = e.position.offset(0, !e.crouching ? 1.62 : LEGACY_1710 ? LEGACY_SNEAK_EYE : 1.27, 0)
    const counts = (o) => o.id === bot.entity.id || entityPerceptible(o, fill) || losClear(eye, o.position.offset(0, (o.height || 0) / 2, 0))
    const live = liveEntities()
    if (live.some(o => ['hostile', 'creeper', 'heavy'].includes(mobClass(o)) && o.position.distanceTo(e.position) <= HOSTILE_RADIUS && counts(o))) return
    // Sight verdicts by cell, for this decision.
    const lit = new Map()
    const sees = (c) => {
      const k = ck(c.x, c.y, c.z)
      if (!lit.has(k)) lit.set(k, seesLit(c, 64))
      return lit.get(k)
    }
    const { yaw, pitch } = look
    const reached = pointRay(eye, yaw, pitch, RAY_REACH)
    if (reached && sees(reached.cell)) return
    const since = swingT - SWING_LEAD_MS
    const dir = pointDir(yaw, pitch)
    const dirs = AIM_PAIRS.map(([dy, dp]) => pointDir(yaw + dy, pitch + dp))
    if (blockMarks.some(m => m.t >= since && pointNearLook(m.p.offset(0.5, 0, 0.5), [1, 1], eye, dirs) && sees(m.p))) return
    if (soundMarks.some(m => m.t >= since && pointHeardNear(m.p, eye))) return
    if (hurtMarks.some(m => m.t >= since && m.e.id !== e.id && pointNearLook(m.e.position, m.e.box, eye, dirs) && counts(m.e))) return
    const loose = (o) => o.name === 'item' || o.name === 'experience_orb' || o.type === 'projectile'
    if ([bot.entity, ...live].some(o => o !== e && !loose(o) && pointNearLook(o.position, hitbox(o), eye, dirs) && counts(o))) return
    if (spawnMarks.some(m => m.t >= since && m.e.position.distanceTo(eye) <= THROW_ZONE && counts(m.e))) return
    const held = e.heldItem?.name ?? ''
    const usesItem = USE_ITEMS.test(held) || (eye.distanceTo(bot.entity.position) > PLACE_EARSHOT &&
      (RENAMED_PLACERS.has(held) || Object.hasOwn(bot.registry.blocksByName, held)))
    const stops = !usesItem ? null : FILLS.test(held) ? FLUIDS : FLOATS?.test(held) ? WATERS : null
    // Without an item that acts on blocks, a look passes a block short of a full cube to a use block behind it.
    const blockAt = (c) => {
      const b = bot.blockAt(c)
      if (!b) return b
      if (stops?.test(b.name)) return FLUID_STOP
      return !usesItem && !USE_BLOCKS.test(b.name) && !pointFullCube(b) ? AIR : b
    }
    if (AIM_PAIRS.some(([dy, dp]) => {
      const r = pointRay(eye, yaw + dy, pitch + dp, RAY_REACH, blockAt)
      return r && (usesItem || USE_BLOCKS.test(r.block.name))
    })) return
    const hit = pointHit(eye, yaw, pitch, sees)
    const cell = hit && hit.cell
    // The anchor check holds the player still since before the first swing.
    if (!first || swingT - first.swingT > PAIR_MS || (anchors.get(e.id)?.t ?? -Infinity) > first.swingT - STILL_MS ||
      soundMarks.some(m => m.t >= first.swingT - SWING_LEAD_MS && pointHeardNear(m.p, eye)) ||
      (pointApart(look, first) && !(cell && first.cell && cell.equals(first.cell))) || pointTurned(e, look)) {
      firsts.set(e.id, { swingT, yaw, pitch, cell })
      return
    }
    const st = pointers.get(e.username) || { lastT: -Infinity, episode: null }
    const ep = st.episode
    const prior = ep && pointDir(ep.yaw, ep.pitch)
    if (ep && e.position.distanceTo(ep.pos) <= STILL_SPAN && swingT - ep.lastSwingT < EPISODE_IDLE_MS &&
      Math.acos(Math.min(1, dir[0] * prior[0] + dir[1] * prior[1] + dir[2] * prior[2])) < TURN) {
      ep.lastSwingT = swingT
      return
    }
    if (now - st.lastT < GAP_MS || holding.has(e.username)) return
    const text = pointText(e, eye, yaw, pitch, hit)
    const emit = () => {
      pointers.set(e.username, { lastT: Date.now(), episode: { pos: e.position.clone(), yaw, pitch, lastSwingT: swingT } })
      emitEvent('point', text, { name: e.username })
    }
    const wait = HOLD_MS - (now - swingT)
    if (wait <= 0) return emit()
    holding.add(e.username)
    setTimeout(() => pointRelease(e, look, emit), wait)
  } catch (err) { console.log('[point] decision failed: ' + err.message) }
}

// Emits player e's held point once HOLD_MS is up.
function pointRelease (e, look, emit) {
  holding.delete(e.username)
  try {
    if (bot.entities[e.id] !== e || staleEntities.has(e.id) || !pointStill(e, Date.now()) || pointTurned(e, look)) return
    if (!entityPerceptible(e, reflexes.find(r => r.name === 'combat').fairFill(bot))) return
    emit()
  } catch (err) { console.log('[point] held point failed: ' + err.message) }
}

function wirePointing () {
  bot.on('entitySwingArm', pointSwing)
  bot.on('entityMoved', pointMoved)
  bot.on('blockBreakProgressObserved', pointBreak)
  bot.on('blockUpdate', pointBlock)
  bot.on('entityHurt', pointHurt)
  bot.on('entitySpawn', pointSpawn)
  bot.on('soundEffectHeard', pointSound)
  bot._client.on('world_event', pointLevelEvent)
}

function bindPointing (ctx) {
  ({ bot, emitEvent, entityPerceptible, liveEntities, staleEntities, reflexes, seesLit, losClear, yawToCompass, mobClass, hitbox, recentOwnEdits, ck } = ctx)
}

module.exports = { bindPointing, wirePointing }
