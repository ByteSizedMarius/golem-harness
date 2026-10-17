'use strict'

const { goals } = require('mineflayer-pathfinder')
const { bunkerSummary } = require('../shelter')
const { STRIKE_SWING_MS, STRIKE_APPROACH_MS, strikeBudgetMs, JUMP_FALL_TICKS, HOLD_MAX_S } = require('../combat-rules')
const { LEGACY_1710, LEGACY_HIT_MS } = require('../bot/config')

let bot, shared, fight, ok, err, STANCES, drawAndLoose, guardState, legsMoving, mobClass, perched, inChokepoint, meleeAim, disengageHp, creeperRoute, nearHostiles, mobHurt, sprintBlock, meleeSwing, chargedSwing, pilotLane, holdRun, strikeRun, walkGaveUp, buildBunker, BUNKER_HEIGHT, reflexes, emitEvent, round, liveEntities, nearestSeen, targetSeen, inMeleeReach, claimLane, releaseLane, stopPath, legs, namedStop

function installFightingRoutes (app) {
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
    const mark = legs.mark()
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
      // True once /stop, another verb's lane or a reflex took the body.
      const halted = () => pilotLane.token !== lane || legs.mark() !== mark
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
        if (halted()) { stop = { reason: 'stopped' }; break }
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
            if (halted()) { stop = { reason: 'stopped' }; break }
            if (e.reason !== 'budget') throw e
            stop = walkGaveUp(e)
            break
          }
        }
        const alreadyHeld = bot.heldItem && bot.heldItem.name === iname
        await bot.equip(it, 'hand')
        if (LEGACY_1710) {
          const hit = await meleeSwing(tgt, { run, aimY: 0.6, seen: () => !halted() && targetSeen(tgt) })
          if (hit === false) { stop = { reason: halted() ? 'stopped' : 'lost sight' }; break }
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
          if (halted()) { stop = { reason: 'stopped' }; break }
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
      // A target gone out of sight may have died or only despawned.
      const killed = dead && targetSeen(tgt)
      if (dead && !killed) stop = { reason: 'lost sight' }
      if (killed && struckAt) {
        if (halted()) stop = { reason: 'stopped' }
        else await approach(struckAt, 1, 0).catch((e) => { stop = halted() ? { reason: 'stopped' } : walkGaveUp(e) })  // hoover the drops
      }
      const stopped = stop && stop.reason === 'stopped'
      const note = killed ? (stopped ? 'stopped before the drops' : stop ? 'the walk to the drops gave up' : 'walked to drops') : stopped ? 'stopped, still standing' : stop ? (stop.reason === 'lost sight' ? 'lost sight of it' : 'out of time, still standing') : swings ? 'still standing — swing again deliberately' : 'target left reach'
      ok(res, namedStop({ struck: ename, with: iname, swings, at: struckAt ? round(struckAt) : null, killed, note, ...stop }, mark))
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
    const mark = legs.mark()
    let lane = null
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
        if (lane && (pilotLane.token !== lane || legs.mark() !== mark)) { outcome = 'stopped'; break }
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
        // The lane is claimed once every refusal has passed. A shot takes at most 1550 ms to loose and 2000 ms to watch.
        if (!lane) {
          lane = claimLane('shoot', max * (1550 + 2000))
          strikeRun.lane = lane
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
      ok(res, namedStop({
        shot: ename, shotsFired: shots.length, shots, outcome,
        dist: last.dist, killed: !!last.killed,
        ...(outcome === 'stopped' && { reason: 'stopped' }),
        note: outcome === 'dead' ? 'down'
          : outcome === 'no-progress' ? 'range never changed — something between us; reposition, do not loose again'
          : outcome === 'no-arrows' ? 'quiver empty'
          : outcome === 'lost sight' ? 'lost sight of it'
          : outcome === 'no-line' ? 'no clear line to it, nothing loosed'
          : outcome === 'stopped' ? 'stopped, still up'
          : 'still up — check where the arrow went (/gaze) and loose again'
      }, mark))
    } catch (e) { err(res, e) } finally {
      if (strikeRun.lane === lane) strikeRun.lane = null
      releaseLane(lane)
      bot.removeListener('entityDead', onDead)
    }
  })

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
      holdRun.lane = lane
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
      if (holdRun.lane === lane) holdRun.lane = null
      releaseLane(lane)
      if (guard && !guardState.pilot) guard.down()
      bot.removeListener('entityDead', onDead)
      bot.removeListener('health', onHealth)
      bot.removeListener('death', onDeath)
    }
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
        if (!Object.hasOwn(STANCES, want)) return err(res, new Error(`no such stance, have: ${Object.keys(STANCES).join(', ')}`))
        fight.stance = want
        emitEvent('stance', `combat posture now ${want}: ${STANCES[want].note}`)
      }
      ok(res, { stance: fight.stance, ...STANCES[fight.stance], all: Object.fromEntries(Object.entries(STANCES).map(([k, v]) => [k, v.note])) })
    } catch (e) { err(res, e) }
  })

  // GET /bunker?mode=auto|up|down&height=N: builds the shelter above and answers once it stands.
  app.get('/bunker', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const r = await buildBunker(req.query.mode ?? 'auto', req.query.height === undefined ? BUNKER_HEIGHT : parseInt(req.query.height))
      if (r.error) return err(res, new Error(r.error))
      ok(res, { ...r, summary: bunkerSummary(r) })
    } catch (e) { err(res, e) }
  })
}

function createFightingRoutes (ctx) {
  Object.assign(ctx, { installFightingRoutes })
}

function bindFightingRoutes (ctx) {
  ({ bot, shared, fight, ok, err, STANCES, drawAndLoose, guardState, legsMoving, mobClass, perched, inChokepoint, meleeAim, disengageHp, creeperRoute, nearHostiles, mobHurt, sprintBlock, meleeSwing, chargedSwing, pilotLane, holdRun, strikeRun, walkGaveUp, buildBunker, BUNKER_HEIGHT, reflexes, emitEvent, round, liveEntities, nearestSeen, targetSeen, inMeleeReach, claimLane, releaseLane, stopPath, legs, namedStop } = ctx)
}

module.exports = { createFightingRoutes, bindFightingRoutes }
