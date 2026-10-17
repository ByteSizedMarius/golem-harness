'use strict'

const { GRAVES } = require('./config')

let bot, heldInfo, emitEvent, markTrail, suffocates, OPENABLE, equipPickFor, fight, mobClass, bunker, reflexes, CONFIRMED_HORIZON, waterState, onBuildHit, freezeBody, swimUp, waypoints, deaths

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
let lastHp = 20
let lastPosSafe = null
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
}
// Digs out the block the head suffocates in, true once the dig starts.
async function digOutHead () {
  const hb = bot.blockAt(bot.entity.position.offset(0, 1.6, 0).floored())
  if (!suffocates(hb) || OPENABLE.test(hb.name) || hb.name === 'bedrock') return false
  await equipPickFor(hb.name)
  bot.dig(hb).catch(() => {})
  return true
}
function wireBodyAlarms () {
  bot.on('health', async () => {
    try {
      if (bot.health < lastHp - 0.5) {
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
        const ws = waterState(bot)
        // Every hit during a bunker build lands here, attributed or not.
        if (bunker.building) {
          onBuildHit(attrib)
          if (hurtDue(3000)) {
            lastHurtEmit = Date.now()
            emitEvent('hurt', `took ${dmg} damage while building the bunker${attrib ? `, ${attrib.desc}` : ''}, HP ${bot.health}/20`)
          }
        } else if (!attrib) {
          freezeBody()
          const cause = ws && ws.buried ? 'SUFFOCATING inside a block' : ws && ws.inLava ? 'LAVA' : ws && ws.submerged ? 'drowning' : 'unknown — look around'
          if (hurtDue(3000)) {
            lastHurtEmit = Date.now()
            emitEvent('hurt', `took ${dmg} damage (${cause}) — HP ${bot.health}/20 — FROZE all action; assess before moving`)
          }
        } else if (attrib.env && hurtDue(3000)) {
          // An environmental hit, or a sourceless one with no hostile near, never freezes the body.
          lastHurtEmit = Date.now()
          emitEvent('hurt', `took ${dmg} damage (${attrib.desc}), HP ${bot.health}/20`)
        }
        // Every hit gets the rescues below, attributed or not.
        // SELF-RESCUE REFLEXES (the cases freezing makes WORSE — a frozen body suffocates or sinks):
        // buried = dig the head block NOW (my own cell, fairness-clean, like yanking a hand from fire)
        if (ws && ws.buried) {
          try { await digOutHead() } catch (e) {}
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
      const msg = `DIED near (${at.x},${at.y},${at.z}) — waypoint 'lastdeath' set; ${items}`
      deaths.died(msg)
      emitEvent('death', msg)
    } catch (e) {}
  })
}

function createAlarms (ctx) {
  Object.assign(ctx, { BIG_HIT, digOutHead })
}

function bindAlarms (ctx) {
  ({ bot, heldInfo, emitEvent, markTrail, suffocates, OPENABLE, equipPickFor, fight, mobClass, bunker, reflexes, CONFIRMED_HORIZON, waterState, onBuildHit, freezeBody, swimUp, waypoints, deaths } = ctx)
}

module.exports = { createAlarms, bindAlarms, wireWearAlarm, wirePocketAlarm, wireTrailMarks, wireBodyAlarms }
