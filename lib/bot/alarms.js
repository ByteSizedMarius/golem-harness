'use strict'

const { GRAVES } = require('./config')
const { digLock, claimDig, releaseDig, soleClaim, soleDig } = require('./dig-lock')

let bot, heldInfo, emitEvent, markTrail, markBody, suffocates, smotherBlock, holdDigTool, holdHand, endHand, fight, mobClass, bunker, reflexes, CONFIRMED_HORIZON, waterState, onBuildHit, freezeBody, swimUp, waypoints, memory, deaths, takeLegs, stopPath, nudgeInto, centerOnCell, knownCell, seenNow, holdsWater

let lastWearWarn = 0
function wireWearAlarm () {
  setInterval(() => {   // low-durability alarm: once per minute max, only when a tool is nearly dead
    try {
      const h = heldInfo()
      if (h && h.maxDurability && h.durability / h.maxDurability < 0.12 && Date.now() - lastWearWarn > 60000) {
        lastWearWarn = Date.now()
        emitEvent('wear', `${h.name} nearly broken (${h.durability}/${h.maxDurability}) — swap or craft a spare`)
      }
    } catch (e) {}
  }, 5000)
}

// ---- BODY ALARMS: damage freezes everything (the bot buys my slow reaction time); hunger warns
// once per crossing; death stamps a waypoint and says what was lost where.
let lastHp = null
let lastPosSafe = null
// The feet cell the body stood in before it entered the current column.
let lastFeet = null
let lastHurtEmit = 0
// The damage in one hit at or above which a hurt event skips the throttle.
const BIG_HIT = 4
let lowFoodWarned = false
// pocket-fullness sense (07-16, the helmsman's ask after the museum purge found ZERO free slots —
// full pockets make pickups fail SILENTLY and stopped a dig mid-escape on 07-15). Same one-warning-
// per-episode + hysteresis shape as the food alarm: say it once at "getting full" (≤4 free), once
// more at FULL (0 free), re-arm only after real space opens up (≥6 free). Polled 5s — cheap.
let pocketsWarned = 0                                   // 0 = quiet, 1 = warned "getting full", 2 = warned FULL
function wirePocketAlarm () {
  setInterval(() => {
    try {
      if (!bot || !bot.inventory || !bot.entity) return
      const empty = bot.inventory.emptySlotCount ? bot.inventory.emptySlotCount() : bot.inventory.slots.slice(9, 45).filter(s => !s).length
      if (empty === 0 && pocketsWarned < 2) { pocketsWarned = 2; emitEvent('pockets', 'pockets FULL (0 free) — pickups now fail silently; bank or /toss before mining/looting') }
      else if (empty <= 4 && empty > 0 && pocketsWarned < 1) { pocketsWarned = 1; emitEvent('pockets', `pockets getting full — ${empty} slots free`) }
      else if (empty >= 6) pocketsWarned = 0
    } catch (e) {}
  }, 5000)
}

function wireTrailMarks () {
  setInterval(() => {
    try {
      lastPosSafe = bot.entity.position.clone()
      markTrail(lastPosSafe.floored())
    } catch (e) {}
  }, 2000)
  bot.on('move', markBody)
  bot.on('move', (was) => {
    const at = bot.entity.position
    if (Math.floor(was.x) !== Math.floor(at.x) || Math.floor(was.z) !== Math.floor(at.z)) lastFeet = was.floored()
  })
}
// A known cell the body passes through unhurt and unslowed: no collision box, no liquid, fire or cobweb.
function openCell (p) {
  const b = bot.blockAt(p)
  return !!b && knownCell(p) && b.shapes.length === 0 && !holdsWater(b) && !/lava|^(soul_)?fire$|^cobweb$/.test(b.name)
}
// True when the body can step from feet cell from to feet cell c on a known full-cube floor, with no gravel or sand
// seen now over its head.
function canStepOutTo (c, from = bot.entity.position.offset(0, 0.01, 0).floored()) {
  const under = c.offset(0, -1, 0)
  const floor = bot.blockAt(under)
  if (!openCell(c) || !openCell(c.offset(0, 1, 0)) || !floor || !knownCell(under)) return false
  if (floor.shapes.length !== 1 || floor.shapes[0].join() !== '0,0,0,1,1,1') return false
  // The head sweeps the cell over c on a step down and the cell over from on a climb.
  if (c.y < from.y && !openCell(c.offset(0, 2, 0))) return false
  if (c.y > from.y && !openCell(from.offset(0, 2, 0))) return false
  const over = c.offset(0, 2, 0)
  const top = bot.blockAt(over)
  return !(top && seenNow(over) && /^(gravel|sand|red_sand)$/.test(top.name))
}
// The cell beside the feet, level or one down, the body can step out to, lastFeet first, or null.
function stepOutCell () {
  const o = bot.entity.position.offset(0, 0.01, 0).floored()
  const cells = [0, -1].flatMap((dy) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => o.offset(dx, dy, dz)))
  const back = lastFeet && cells.find((c) => c.equals(lastFeet))
  return back && canStepOutTo(back) ? back : cells.find((c) => canStepOutTo(c)) || null
}
// The buried self-rescue under way, null when none.
let rescue = null
// The reason and time of the last give-up event, null before the first.
let lastGiveUp = null
// The last give-up on the head block with its reason, feet cell and step-out cell, null once the head cell changes.
let stuck = null
// The longest a buried self-rescue runs.
const RESCUE_MS = 30000
const RESCUE_NAME = 'the buried self-rescue'
// True while the body stands in the feet cell of the last give-up on its head block, with the same step-out cell or none.
function stuckHere () {
  if (!stuck || !stuck.feet.equals(bot.entity.position.offset(0, 0.01, 0).floored())) return false
  const out = stepOutCell()
  return out ? !!stuck.out && out.equals(stuck.out) : !stuck.out
}
// The scene alert's words on the rescue under way or on a give-up that still holds, null for neither.
function rescueNote () {
  if (soleClaim()?.what === RESCUE_NAME) return `${RESCUE_NAME} is freeing it`
  return stuckHere() ? `${RESCUE_NAME} gave up: ${stuck.why}` : null
}
// Starts freeing a body buried at the eye, out only once the eye is clear. True while it runs.
function digOutHead () {
  if (rescue) return true
  const cell = (dy) => bot.entity.position.offset(0, dy, 0).floored()
  const feetBlock = () => bot.blockAt(cell(0.01))
  const hb = smotherBlock()
  if (!hb || stuckHere()) return false
  const offCentre = () => {
    const b = smotherBlock()
    const o = cell(0.01)
    return !!b && (b.position.x !== o.x || b.position.z !== o.z) && !suffocates(feetBlock())
  }
  if (!stepOutCell() && !offCentre()) {
    const no = undiggable(hb, 'head')
    if (no) {
      giveUp(no)
      holdStuck(no)
      return false
    }
  }
  const claim = claimDig(RESCUE_NAME, true)
  claim.sole = true
  if (bot.targetDigBlock) digLock.rawStop()
  const run = { claim, over: null, lease: null, digging: false }
  const step = async () => {
    const c = stepOutCell()
    if (!c || run.over) return false
    console.log(`[buried] stepping out to ${c.x},${c.y},${c.z}`)
    let reached = false
    try {
      reached = await nudgeInto(c, false)
      if (reached && !run.over) await centerOnCell(c)
    } catch (e) {
      console.log(`[buried] step-out failed: ${e.message}`)
    }
    return reached && !smotherBlock()
  }
  const feetSmother = () => suffocates(feetBlock()) ? feetBlock() : null
  const free = async () => {
    console.log(`[buried] start, smothered by ${hb.name} at ${hb.position.x},${hb.position.y},${hb.position.z}, feet ${feetBlock().name}`)
    takeLegs('buried self-rescue', 'free a head buried in a block')
    stopPath()
    // A stopped bunker build keeps moving the body until it unwinds.
    while (bunker.building && !run.over) await bot.waitForTicks(1)
    if (run.over) return {}
    if (offCentre()) {
      console.log('[buried] centring in its cell')
      try {
        await centerOnCell()
      } catch (e) {
        console.log(`[buried] centring failed: ${e.message}`)
      }
      if (run.over) return {}
      if (!smotherBlock()) return { out: 'centred' }
    }
    if (await step()) return { out: 'stepped' }
    if (run.over) return {}
    run.lease = holdHand()
    for (;;) {
      const head = await digHead(run, 'head', smotherBlock)
      if (head) return { gaveUp: head, onHead: true }
      if (!feetSmother()) return { out: 'head clear' }
      if (await step()) return { out: 'stepped' }
      const feet = await digHead(run, 'feet', feetSmother)
      if (feet) return { gaveUp: feet }
      if (!smotherBlock()) return { out: 'feet clear' }
    }
  }
  let timer = null
  let died = null
  const cut = new Promise((resolve) => {
    const end = (why) => {
      run.over = why
      resolve({ gaveUp: why })
    }
    timer = setTimeout(() => end(`still buried after ${RESCUE_MS / 1000} s`), RESCUE_MS)
    died = () => end('died')
    bot.once('death', died)
  })
  rescue = Promise.race([free(), cut])
    .catch((e) => ({ gaveUp: e.message }))
    .then(({ out, gaveUp, onHead }) => {
      if (out) {
        console.log(`[buried] out (${out})`)
      } else {
        giveUp(gaveUp)
        if (onHead) holdStuck(gaveUp)
      }
    })
    .finally(() => {
      clearTimeout(timer)
      bot.removeListener('death', died)
      if (run.digging) digLock.rawStop()
      endHand(run.lease)
      releaseDig(claim)
      rescue = null
    })
  return true
}
// Tells the pilot of a give-up at most once per 3 s for the same reason, and logs every one.
function giveUp (why) {
  console.log(`[buried] gave up: ${why}`)
  // The death event already tells the pilot of a death.
  if (why !== 'died' && (!lastGiveUp || lastGiveUp.why !== why || Date.now() - lastGiveUp.t > 3000)) {
    lastGiveUp = { why, t: Date.now() }
    emitEvent('buried', `${RESCUE_NAME} gave up: ${why}`)
  }
}
function holdStuck (why) {
  forgetStuck()
  const b = smotherBlock()
  if (!b) return
  const event = `blockUpdate:${b.position}`
  // A block the server sends again is the same block.
  const drop = (was, now) => { if (!was || !now || was.stateId !== now.stateId) forgetStuck() }
  stuck = { why, feet: bot.entity.position.offset(0, 0.01, 0).floored(), out: stepOutCell(), event, drop }
  bot.on(event, drop)
}
function forgetStuck () {
  if (!stuck) return
  bot.removeListener(stuck.event, stuck.drop)
  stuck = null
}
function undiggable (b, part) {
  return !b.diggable || b.name === 'bedrock' || bot.digTime(b) === Infinity ? `the ${part} block ${b.name} cannot be dug` : null
}
// Digs the head or the feet block next() names until it names none. Null once it does, else why it gave up. A dig
// that resolves resets the failure count, since a block falling in after it is a new one.
async function digHead (run, part, next) {
  let fails = 0
  for (;;) {
    if (run.over) return run.over
    const b = next()
    if (!b) return null
    const no = undiggable(b, part)
    if (no) return no
    await holdDigTool(b)
    if (run.over) return run.over
    const ms = bot.digTime(b)
    const hold = Math.min(ms + 500, 30000)
    if (!run.lease.renew(hold)) {
      run.lease = holdHand()
      run.lease.renew(hold)
    }
    console.log(`[buried] digging ${part} ${b.name} with ${bot.heldItem ? bot.heldItem.name : 'hand'}, ~${ms} ms`)
    run.digging = true
    try {
      await soleDig(run.claim, b)
      fails = 0
    } catch (e) {
      if (run.over) return run.over
      if (++fails === 2) return `two digs of the ${part} block ${b.name} failed: ${e.message}`
      console.log(`[buried] dig of the ${part} block ${b.name} failed: ${e.message}`)
    } finally {
      run.digging = false
    }
  }
}
function wireBodyAlarms () {
  // When the body was last off the ground.
  let airborneAt = 0
  bot.on('move', () => { if (!bot.entity.onGround) airborneAt = Date.now() })
  bot.on('health', async () => {
    try {
      if (lastHp !== null && bot.health < lastHp - 0.5) {
        const dmg = +(lastHp - bot.health).toFixed(1)
        const hurtDue = (ms) => dmg >= BIG_HIT || Date.now() - lastHurtEmit > ms
        if (fight.swingWait) {
          lastHp = bot.health                               // a health update during the wait counts from here
          await fight.swingWait
        }
        // LAW AMENDED 07-14, built 07-15: hurt-FREEZE is for UNEXPLAINED damage only. When damage
        // attribution (damage_event wire below) has just named a living attacker, freezing is the
        // worst response — the combat reflex owns it; we only narrate.
        const attrib = (fight.lastAttrib && Date.now() - fight.lastAttrib.t < 1500) ? fight.lastAttrib : null
        // cls is the mobClass of the attacker the hit is attributed to, null for an unattributed hit and
        // for an environmental one that kept an attribution.
        fight.lastHit = { dmg, t: Date.now(), cls: attrib && attrib.entity && !attrib.envHit ? mobClass(attrib.entity) : null }   // feeds the reflex's ADAPTIVE tripwire (death #2 lesson)
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
          if (hurtDue(2000)) {
            lastHurtEmit = Date.now()
            emitEvent('hurt', `took ${dmg} — ${attrib.desc} — HP ${bot.health}/20 — ${action}`)
          }
        }
        const ws = waterState()
        const smothering = () => `suffocating inside ${smotherBlock().name}`
        const cause = ws && ws.inLava ? 'LAVA' : ws && ws.submerged ? 'drowning' : 'unknown — look around'
        // Every hit during a bunker build lands here, attributed or not.
        if (bunker.building) {
          onBuildHit(attrib)
          if (hurtDue(3000)) {
            lastHurtEmit = Date.now()
            emitEvent('hurt', `took ${dmg} damage while building the bunker${attrib ? `, ${attrib.desc}` : ''}, HP ${bot.health}/20`)
          }
        } else if (!attrib && ws && ws.buried) {
          // A freeze would release the rescue's step-out.
          if (hurtDue(3000)) {
            lastHurtEmit = Date.now()
            emitEvent('hurt', `took ${dmg} damage (${dmg <= 2 ? smothering() : cause}), HP ${bot.health}/20`)
          }
        } else if (!attrib) {
          freezeBody()
          if (hurtDue(3000)) {
            lastHurtEmit = Date.now()
            emitEvent('hurt', `took ${dmg} damage (${cause}) — HP ${bot.health}/20 — FROZE all action; assess before moving`)
          }
        } else if (attrib.env && hurtDue(3000)) {
          // An environmental hit, or a sourceless one with no hostile near, never freezes the body.
          lastHurtEmit = Date.now()
          // An untyped hit of at most 2 damage takes the name of a cause the body feels: suffocation, then drowning, then starvation.
          const felt = attrib.untyped && dmg <= 2 && (ws && ws.buried ? smothering()
            : ws && ws.submerged && ws.oxygen <= 0 ? 'drowning'
              // Fire and fall damage arrive untyped too (the on-fire flag 0x01 or a fire block at feet or head, a landing within the last second).
              : bot.food === 0 && !(bot.entity.metadata[0] & 0x01) && !(ws && ws.inFire) && Date.now() - airborneAt > 1000 ? 'starving' : null)
          emitEvent('hurt', `took ${dmg} damage (${felt || attrib.desc}), HP ${bot.health}/20`)
        }
        // Every hit gets the rescues below, attributed or not.
        // SELF-RESCUE REFLEXES (the cases freezing makes WORSE — a frozen body suffocates or sinks):
        // buried = step out to a known cell, else centre and dig the block smothering the eye, then the feet
        if (ws && ws.buried) {
          try { digOutHead() } catch (e) { console.log(`[buried] the rescue failed to start: ${e.message}`) }
        }
        // drowning = SWIM UP, don't freeze (learned live 07-12: the freeze held me under during the
        // farm flood; only the next walk order saved me). Hold jump ~3s to surface, then release.
        if (ws && ws.submerged && !ws.buried) {
          try { swimUp(3000) } catch (e) {}
        }
      }
      lastHp = bot.health
      if (bot.food <= 7 && !lowFoodWarned) { lowFoodWarned = true; emitEvent('low_food', `food ${bot.food}/20 — eat soon (/eat)`, { food: bot.food }) }
      if (bot.food > 10) lowFoodWarned = false
    } catch (e) {}
  })
  bot.on('death', () => {
    try {
      // The body respawns away from the waypoint it stood at.
      memory.lastWaypoint = null
      const p = lastPosSafe || bot.entity.position
      const at = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
      try { waypoints.set('lastdeath', at, GRAVES ? { note: 'your items are in a gravestone here' } : {}) } catch (e) {}
      const items = GRAVES ? 'your items are in a gravestone there, take them with grave' : 'drops despawn in ~5 min'
      const msg = `DIED near (${at.x},${at.y},${at.z}) — waypoint 'lastdeath' set; ${items}`
      deaths.died(msg)
      emitEvent('death', msg)
    } catch (e) {}
  })
}

function createAlarms (ctx) {
  Object.assign(ctx, { BIG_HIT, digOutHead, canStepOutTo })
}

function bindAlarms (ctx) {
  ({ bot, heldInfo, emitEvent, markTrail, markBody, suffocates, smotherBlock, holdDigTool, holdHand, endHand, fight, mobClass, bunker, reflexes, CONFIRMED_HORIZON, waterState, onBuildHit, freezeBody, swimUp, waypoints, memory, deaths, takeLegs, stopPath, nudgeInto, centerOnCell, knownCell, seenNow, holdsWater } = ctx)
}

module.exports = { createAlarms, bindAlarms, wireWearAlarm, wirePocketAlarm, wireTrailMarks, wireBodyAlarms, rescueNote }
