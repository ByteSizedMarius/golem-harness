'use strict'

const { goals } = require('mineflayer-pathfinder')
const { bunkerSummary } = require('../shelter')
const { walkFlood, groundCell } = require('../flee')
const { STRIKE_SWING_MS, STRIKE_APPROACH_MS, strikeBudgetMs, JUMP_FALL_TICKS, HOLD_MAX_S } = require('../combat-rules')
const { LEGACY_1710 } = require('../bot/config')
const { LEGACY_HIT_MS } = require('../bot/legacy-1710')
const { TOOLS } = require('../../mcp/tools')

let bot, shared, fight, ok, err, STANCES, drawAndLoose, guardState, legsMoving, mobClass, perched, inChokepoint, meleeAim, disengageHp, creeperRoute, bodyWalksTo, walkBudget, eyeLineWalled, fleeWorld, nearHostiles, mobHurt, sprintBlock, meleeSwing, chargedSwing, pilotLane, holdRun, strikeRun, walkGaveUp, buildBunker, BUNKER_HEIGHT, reflexes, emitEvent, round, liveEntities, nearestSeen, targetSeen, inMeleeReach, claimLane, releaseLane, stopPath, legs, namedStop, itemFrame, framedItem, nearestFrame, frameAt, withEntityUpdate, waitedText, walkToFrame, refuseWhileFighting

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
    // The ids of the item entities removed while in sight.
    const goneSeen = new Set()
    const onGone = (en) => { if (en && en.name === 'item' && targetSeen(en)) goneSeen.add(en.id) }
    const mark = legs.mark()
    let lane = null
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const ename = req.query.name
      if (!ename) return err(res, new Error('need name='))
      const cell = frameAt(ename, req.query.at)
      const iname = req.query.item || 'iron_sword'
      const it = bot.inventory.items().find(i => i.name === iname)
      if (!it) {
        const weapon = bot.inventory.items().find(i => /_(sword|axe)$/.test(i.name))
        return err(res, new Error(`refused: no ${iname} in your pockets to strike with. Ways out: ${weapon ? `strike(item: '${weapon.name}'), ` : ''}goto, bunker, or the combat reflex, which flees at low health while it is on.`))
      }
      // A strike at an empty frame knocks the frame itself off.
      const frames = itemFrame(ename) && nearestFrame(ename, true, cell)
      const where = cell && `${cell.x},${cell.y},${cell.z}`
      // Ids of hostiles struck from where the body stands.
      const inPlace = new Set()
      const walk = (en) => {
        if (!['hostile', 'heavy'].includes(mobClass(en))) return true
        inPlace.delete(en.id)
        if (bodyWalksTo(en.position, walkBudget(en.position))) return true
        if (!inMeleeReach(en, 0.6)) return false
        inPlace.add(en.id)
        return true
      }
      const target = frames ? frames.frame : nearestSeen(ename, 16, walk)
      if (!target && frames && frames.nearest) return err(res, new Error(where ? `the ${ename} at ${where} holds no item, refusing to knock an empty frame off` : `no ${ename} in sight holds an item, refusing to knock an empty frame off`))
      const walled = !target && !frames && nearestSeen(ename, 16)
      if (walled) {
        const p = walled.position.floored()
        return err(res, new Error(`${ename} at ${p.x},${p.y},${p.z} has no walk to me${eyeLineWalled(walled) ? ', behind a wall or a closed door' : ''}`))
      }
      if (!target) return err(res, new Error(where ? `no ${ename} in sight at ${where}` : `no ${ename} in sight within 16`))
      if (frames && target.objectData == null) {
        const p = target.position.floored()
        return err(res, new Error(`the ${ename} at ${p.x},${p.y},${p.z} has no known facing, its reach is unknown`))
      }
      if (target.type === 'player' || (bot.players && Object.values(bot.players).some(p => p.entity === target))) {
        return err(res, new Error('refusing: never strike players (friendly-fire tests wait for damage attribution)'))
      }
      if (/creeper/.test(String(target.name))) {
        return err(res, new Error('refusing: never melee a creeper — flee is the law'))
      }
      // ?max=N (07-21 latency session): bounded swing SEQUENCE in one round trip — re-acquire,
      // approach, swing, dead-watch, repeat. Exits honestly: dead / target gone / max / out of time.
      // One swing takes a frame's item out.
      const max = frames ? 1 : Math.min(5, Math.max(1, parseInt(req.query.max || '1')))
      const held = frames && framedItem(target).name
      // The server time the swing gives the frame update.
      const frameWaitMs = 500
      const deadline = Date.now() + strikeBudgetMs(max)
      lane = claimLane('strike', strikeBudgetMs(max))   // soft lane: the approach + swings are MINE (07-21)
      strikeRun.lane = lane
      // True once /stop, another verb's lane or a reflex took the body.
      const halted = () => pilotLane.token !== lane || legs.mark() !== mark
      // The ms an approach gets, at most STRIKE_APPROACH_MS and leaving reserve ms of the strike.
      const approachMs = (reserve) => Math.max(0, Math.min(STRIKE_APPROACH_MS, deadline - reserve - Date.now()))
      // Gives up after approachMs(reserve).
      const approach = (goal, reserve) => {
        const ms = approachMs(reserve)
        let timer
        const late = new Promise((resolve, reject) => {
          timer = setTimeout(() => { if (bot.pathfinder.goal === goal) stopPath(); reject(Object.assign(new Error(`not there after ${ms / 1000} s`), { reason: 'budget' })) }, ms)
        })
        // A halt that only took the lane leaves the pathfinder walking.
        const onTick = () => { if (halted() && bot.pathfinder.goal === goal) stopPath() }
        bot.on('physicsTick', onTick)
        return Promise.race([bot.pathfinder.goto(goal), late]).finally(() => {
          clearTimeout(timer)
          bot.removeListener('physicsTick', onTick)
        })
      }
      let struckAt = null, dead = false, swings = 0, stop = null, tgt = null, frameWait = null, frameUpdated = false
      // The item entities lying around and how many of the frame's item the pockets hold, both at the swing.
      let prior = new Set(), before = 0
      const pocketed = () => bot.inventory.items().filter(i => i.name === held).reduce((s, i) => s + i.count, 0)
      bot.on('entityDead', onDead)
      if (frames) bot.on('entityGone', onGone)
      for (let i = 0; i < max && !dead && deadline - Date.now() >= STRIKE_SWING_MS; i++) {
        if (halted()) { stop = { reason: 'stopped' }; break }
        const last = tgt
        tgt = i === 0 ? target : nearestSeen(ename, 16, walk)
        if (!tgt) {
          if (last && bot.entities[last.id] && !targetSeen(last)) stop = { reason: 'lost sight' }
          break
        }
        const still = inPlace.has(tgt.id)
        // On 1.7.10 a straight run over known ground replaces the walk and ends in a sprint hit.
        const run = LEGACY_1710 && !frames && !still && !sprintBlock(tgt)
        if (!run && !still && !inMeleeReach(tgt, 0.6)) {
          if (frames) {
            if (!await walkToFrame(ename, tgt, approachMs(STRIKE_SWING_MS), halted)) { stop = { reason: 'stopped' }; break }
          } else {
            const to = new goals.GoalNear(tgt.position.x, tgt.position.y, tgt.position.z, 2)
            try { await approach(to, STRIKE_SWING_MS) } catch (e) {
              if (halted()) { stop = { reason: 'stopped' }; break }
              // A NoPath or Timeout goto leaves the pathfinder walking.
              if ((e.name === 'NoPath' || e.name === 'Timeout') && bot.pathfinder.goal === to) stopPath()
              if (e.reason !== 'budget') throw e
              stop = walkGaveUp(e)
              break
            }
          }
        }
        if (halted()) { stop = { reason: 'stopped' }; break }
        const alreadyHeld = bot.heldItem && bot.heldItem.name === iname
        await bot.equip(it, 'hand')
        // One swing at tgt, true when it swung, false when the strike ends, null out of reach.
        const swing = async () => {
          // A frame takes no crit jump, which lifts the eye out of the reach the approach checked.
          if (LEGACY_1710 && !frames) {
            const hit = await meleeSwing(tgt, { run, aimY: 0.6, seen: () => !halted() && targetSeen(tgt) })
            if (hit === false) stop = { reason: halted() ? 'stopped' : 'lost sight' }
            if (hit) struckAt = tgt.position.clone()
            return hit
          }
          // 13 ticks after an equip cover a sword's full attack charge, and 11 more wait between swings.
          if (!alreadyHeld) await bot.waitForTicks(13)
          else if (i > 0) await bot.waitForTicks(11)
          const hurt = mobHurt.wait(tgt)
          if (hurt > 0) await new Promise(r => setTimeout(r, hurt))
          await bot.lookAt(meleeAim(tgt, 0.6), true)
          await bot.waitForTicks(2)                    // the tick race: aim packet lands NEXT tick
          if (halted()) { stop = { reason: 'stopped' }; return false }
          if (!targetSeen(tgt)) { stop = { reason: 'lost sight' }; return false }
          if (!inMeleeReach(tgt, 0.6)) return null
          struckAt = tgt.position.clone()
          bot.attack(tgt)
          fight.lastAttackT = Date.now()
          return true
        }
        let hit
        if (frames) {
          prior = new Set(liveEntities().filter(e => e.name === 'item').map(e => e.id))
          before = pocketed()
          frameWait = await withEntityUpdate(tgt, frameWaitMs, deadline, async () => (hit = await swing()) === true)
          frameUpdated = frameWait?.by === 'update'
        } else hit = await swing()
        if (hit === false) break
        if (hit === null && frames) {
          const p = tgt.position.floored()
          throw new Error(`the ${ename} at ${p.x},${p.y},${p.z} stays out of swing reach from here`)
        }
        if (hit === null) continue
        swings++
        if (frames) {
          dead = !bot.entities[tgt.id]
          break
        }
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
      const shown = frames && swings && !dead ? framedItem(tgt) : null
      const dropped = frameUpdated && !dead && !shown ? held : null
      // True when the body's own walk of 8 steps reaches no cell near accepts.
      let far = false
      const world = (killed || dropped) && struckAt ? fleeWorld() : null
      // The cells at most r off cell c sideways and at most 1 below it.
      const near = (c, r) => (n) => Math.abs(n.x - c.x) <= r && n.y - c.y >= -1 && n.y <= c.y && Math.abs(n.z - c.z) <= r
      const walkNear = async (goal) => {
        // A drop of 1 is the deepest the body climbs back out of.
        const cell = walkFlood(world, groundCell(world, bot.entity.position.floored(), 24), { maxSteps: 8, maxDrop: 1, goal }).reached
        if (halted()) stop = { reason: 'stopped' }
        else if (!cell) far = true
        else {
          const to = new goals.GoalBlock(cell.x, cell.y, cell.z)
          await approach(to, 0).catch((e) => {
            if ((e.name === 'NoPath' || e.name === 'Timeout') && bot.pathfinder.goal === to) stopPath()
            stop = halted() ? { reason: 'stopped' } : walkGaveUp(e) || { reason: 'no path' }
          })
        }
      }
      // The drops land on the floor under a mob struck mid-jump.
      if (killed && struckAt) await walkNear(near(groundCell(world, struckAt.floored()), 1))  // hoover the drops
      // The item entity the frame dropped.
      let drop = null, amount = 0
      const lying = () => !!drop && !!bot.entities[drop.id] && targetSeen(drop)
      // True once the drop is gone and the pockets have gained at least its count.
      const risen = () => !!drop && !bot.entities[drop.id] && pocketed() - before >= amount
      // A drop rests up to 0.3 below the floor surface.
      const dropCell = (e = drop) => groundCell(world, e.position.offset(0, 0.5, 0).floored(), 24)
      const holds = (e) => e.name === 'item' && e.metadata[bot.registry.supportFeature('metadataIxOfItem')] && e.getDroppedItem()?.name === dropped
      // Where the drop last moved by 0.1 or more. A drop at rest gets corrections of at most 1/32.
      let movedTo = null
      // The server age of the first age update after that move, null before it. The last age the server sent can be a
      // whole update interval older than the move.
      let movedAge = null
      // The ids of the entities with a position update since the wait for the drop began.
      const updated = new Set()
      const onMoved = (e) => {
        updated.add(e.id)
        const p = e.position
        if (drop && e.id === drop.id && Math.max(Math.abs(p.x - movedTo.x), Math.abs(p.y - movedTo.y), Math.abs(p.z - movedTo.z)) >= 0.1) {
          movedTo = p.clone()
          movedAge = null
        }
      }
      const onTime = () => { if (drop && movedAge === null) movedAge = bot.time.age }
      // True until the drop has had a position update and 40 ticks of server age have passed since movedAge. A flying
      // drop's position updates come about 20 ticks apart.
      const moving = () => !updated.has(drop.id) || movedAge === null || bot.time.age - movedAge < 40
      if (dropped && struckAt) {
        bot.on('entityMoved', onMoved)
        bot.on('time', onTime)
        try {
          // The yield lets packets queued behind the tick land before cond reads them.
          const ticksWhile = async (n, cond, end = deadline) => {
            for (let t = 0; t < n && cond() && !halted() && Date.now() < end; t++) {
              await bot.waitForTicks(1)
              await new Promise(r => setImmediate(r))
            }
          }
          // A drop's item arrives in a metadata packet after its spawn.
          const fresh = () => liveEntities().find(e => holds(e) && !prior.has(e.id) && e.position.distanceTo(struckAt) <= 3 && targetSeen(e))
          await ticksWhile(20, () => !fresh())
          drop = fresh() || null
          amount = drop ? drop.getDroppedItem().count : 0
          movedTo = drop && drop.position.clone()
          const on = (c) => {
            const d = dropCell()
            return d.x === c.x && d.y === c.y && d.z === c.z
          }
          // The server moves a drop on while it flies, falls and slides.
          let at = null
          for (let n = 0; ; n++) {
            await ticksWhile(Infinity, () => lying() && !risen() && moving())
            if (!lying() || risen() || moving() || n === 3 || (at && on(at))) break
            at = dropCell()
            await walkNear(near(at, 0))
            if (stop || far) break
            // A body collects a drop only once the drop's pickup delay has run out.
            await ticksWhile(30, () => !risen() && lying() && on(at))
          }
          // The server's slot update can follow the drop's removal by a few ticks, also past the deadline.
          if (drop && !bot.entities[drop.id]) await ticksWhile(10, () => !risen(), Infinity)
          if (!stop && halted()) stop = { reason: 'stopped' }
        } finally {
          bot.removeListener('entityMoved', onMoved)
          bot.removeListener('time', onTime)
        }
      }
      const stopped = stop && stop.reason === 'stopped'
      const left = lying() && dropCell()
      const leftAt = left && `${left.x},${left.y},${left.z}`
      // On 1.7.10 a drop next to a stack of its item merges into that stack.
      const merged = !!drop && !bot.entities[drop.id] && liveEntities().find(e => e.id !== drop.id && holds(e) && e.position.distanceTo(drop.position) <= 1 && targetSeen(e))
      const into = merged && dropCell(merged)
      const fate = risen() ? 'picked up the drop'
        : stopped ? 'stopped before the drop' : stop ? 'the walk to the drop gave up'
        : !drop ? 'no drop came in sight'
        : !left && (bot.entities[drop.id] || !goneSeen.has(drop.id)) ? 'lost sight of the drop'
        : merged ? `the drop merged into the item at ${into.x},${into.y},${into.z}`
        : !left ? 'the drop is gone, not into the pockets'
        : moving() ? 'the drop was still moving when the time ran out'
        : far ? `the drop at ${leftAt} lies out of walking reach, left it` : `walked to the drop, it still lies at ${leftAt}`
      const note = dropped ? `${fate}, the frame stays empty`
        : shown ? (frameUpdated ? `the frame still holds ${shown.name}` : `the server sent no frame update within ${waitedText(frameWaitMs, frameWait)}, the frame shows ${shown.name}`)
        : killed ? (stopped ? 'stopped before the drops' : stop ? 'the walk to the drops gave up' : far ? 'the drops lie out of walking reach, left them' : 'walked to drops') : stopped ? 'stopped, still standing' : stop ? (stop.reason === 'lost sight' ? 'lost sight of it' : 'out of time, still standing') : swings ? 'still standing — swing again deliberately' : 'target left reach'
      ok(res, namedStop({ struck: ename, with: iname, swings, at: struckAt ? round(frames ? struckAt.floored() : struckAt) : null, killed, ...(frames ? { dropped } : {}), note, ...stop }, mark))
    } catch (e) { err(res, e) } finally {
      if (strikeRun.lane === lane) strikeRun.lane = null
      releaseLane(lane)
      bot.removeListener('entityDead', onDead)
      bot.removeListener('entityGone', onGone)
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
        guardState.set(false, 'by pilot hold')
        if (!LEGACY_1710) await bot.waitForTicks(13)    // a sword's full attack charge after the equip
      }
      // The 1.7.10 sword block, raised between swings (no cause, unlogged) and while nothing is in reach.
      if (LEGACY_1710) {
        guard = {
          up: (cause = null) => {
            if (guardState.up || legsMoving() || !bot.heldItem || !/_sword$/.test(bot.heldItem.name)) return
            bot.activateItem()
            guardState.set(true, cause)
            Object.assign(guardState, { slot: bot.quickBarSlot, item: bot.heldItem.name })
          },
          down: (cause = null) => {
            if (!guardState.up) return
            bot.deactivateItem()
            guardState.set(false, cause)
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
          if (guard) guard.up('by pilot hold')
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
      if (guard && !guardState.pilot) guard.down('by pilot hold')
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
          guardState.set(false, 'by pilot guard')
          guardState.pilot = false
          return ok(res, { guarding: false })
        }
        if (!bot.heldItem || !/_sword$/.test(bot.heldItem.name)) return err(res, new Error('no sword in hand, equip one first'))
        if (legsMoving()) return err(res, new Error('the body is moving, and a walk lowers the block'))
        bot.activateItem()
        guardState.set(true, 'by pilot guard')
        Object.assign(guardState, { slot: bot.quickBarSlot, item: bot.heldItem.name, pilot: true })
        return ok(res, { guarding: true })
      }
      const s = bot.inventory.slots[45]
      if (!s || s.name !== 'shield') return err(res, new Error('no shield in offhand — /equip name=shield dest=off-hand first'))
      const on = req.query.on !== '0'
      if (on && legsMoving()) return err(res, new Error('the body is moving, and a walk lowers the shield'))
      if (on) bot.activateItem(true)
      else bot.deactivateItem()
      guardState.set(on, 'by pilot guard')
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

// Guards only the routes installed after it.
function installFightGate (app) {
  const gate = (req, res, next) => {
    try {
      refuseWhileFighting()
    } catch (e) {
      return err(res, e)
    }
    next()
  }
  for (const tool of TOOLS) if (tool.body && !tool.combat) app.all(tool.route, gate)
}

function createFightingRoutes (ctx) {
  Object.assign(ctx, { installFightingRoutes, installFightGate })
}

function bindFightingRoutes (ctx) {
  ({ bot, shared, fight, ok, err, STANCES, drawAndLoose, guardState, legsMoving, mobClass, perched, inChokepoint, meleeAim, disengageHp, creeperRoute, bodyWalksTo, walkBudget, eyeLineWalled, fleeWorld, nearHostiles, mobHurt, sprintBlock, meleeSwing, chargedSwing, pilotLane, holdRun, strikeRun, walkGaveUp, buildBunker, BUNKER_HEIGHT, reflexes, emitEvent, round, liveEntities, nearestSeen, targetSeen, inMeleeReach, claimLane, releaseLane, stopPath, legs, namedStop, itemFrame, framedItem, nearestFrame, frameAt, withEntityUpdate, waitedText, walkToFrame, refuseWhileFighting } = ctx)
}

module.exports = { createFightingRoutes, bindFightingRoutes }
