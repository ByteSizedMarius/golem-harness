'use strict'

const { takenText } = require('../leg-ledger')
const { digBusy } = require('../bot/dig-lock')

let bot, shared, bunker, ok, err, BUNKER_WALK, gotoQuery, claimLane, walkRoute, stagedGoto, standsAtWaypoint, memory, waypoints, journal, doorBeside, namedStop, releaseLane, legs, stopFollow, stopPath, clearLane, jobs, navPlaced, collectLock, collectBusy, collectSafely, follow, followTarget, armFollow, followTick, safeStop, nudgeInto, pillarHeight, fillers, knownCell, jumpPlace, BUNKER_MAX_HEIGHT, perch, seenNow, endHand

function installMovingRoutes (app) {
  app.get('/goto', async (req, res) => {
    let lane = null
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const q = gotoQuery(req.query)
      if (['x', 'y', 'z'].some(k => k in q && !Number.isFinite(q[k]))) return err(res, new Error('x, y and z must be numbers'))
      const preview = req.query.preview === '1'
      lane = claimLane('goto', 300000)
      // A walk anywhere but to a waypoint leaves the waypoint the body stood at.
      if (!preview && q.waypoint === undefined) memory.lastWaypoint = null
      // An edge joins two waypoints only when the walk began on the first.
      const from = q.waypoint !== undefined && memory.lastWaypoint && standsAtWaypoint(memory.lastWaypoint) ? memory.lastWaypoint : null
      const route = walkRoute({ ores: !preview })
      let r, seen
      try { r = await stagedGoto(q, route, { preview, accept: req.query.accept === '1', eat: true }) } finally { seen = route.end() }
      if (preview) r.preview = true
      else if (r.reason) {
        r.walked = route.walked()
        const door = doorBeside()
        if (door) r.door = door
      }
      if (r.arrived && q.waypoint !== undefined) {
        if (from && from === memory.lastWaypoint && from !== q.waypoint) waypoints.link(from, q.waypoint)
        memory.lastWaypoint = q.waypoint
        journal('goto', 'went to ' + q.waypoint)
      }
      const { x, y, z } = bot.entity.position.floored()
      ok(res, namedStop({ ...r, ...seen, cell: { x, y, z } }, route.mark))
    } catch (e) { err(res, e) } finally { releaseLane(lane) }
  })

  app.get('/lookat', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      await bot.lookAt(new Vec3(parseFloat(req.query.x), parseFloat(req.query.y), parseFloat(req.query.z)), true)
      ok(res, { yaw: +bot.entity.yaw.toFixed(2), pitch: +bot.entity.pitch.toFixed(2) })
    } catch (e) { err(res, e) }
  })

  app.get('/stop', (req, res) => { bunker.stop = 'stopped by the pilot'; legs.take(null); try { stopFollow() } catch {} ; stopPath(); try { bot.clearControlStates() } catch {} ; clearLane(); endHand(); const jobsCancelled = jobs.stopAll(); ok(res, { stopped: true, jobsCancelled }) })

  // Mines back the scaffold blocks in sight that the pathfinder placed and that still stand.
  app.get('/tidy', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const scaffold = new Set(['cobblestone', 'dirt'])
      if (req.query.dry === '1') return ok(res, { pending: navPlaced.length, blocks: navPlaced.slice(0, 20) })
      if (collectLock.done) return err(res, collectBusy())
      digBusy()
      const todo = navPlaced.splice(0)                       // take & clear the queue
      const here = bot.entity.position
      todo.sort((a, b) => here.distanceTo(new Vec3(a.x, a.y, a.z)) - here.distanceTo(new Vec3(b.x, b.y, b.z)))
      let reclaimed = 0, alreadyGone = 0, failed = 0
      // Why blocks stayed queued: the stop that ended the reclaim, or the last tool refusal.
      let reason = null
      const stops = new Set(['stalled', 'budget', 'busy', 'stopped'])
      // Scaffold names whose dig was refused for its tool.
      const refused = new Set()
      for (const [i, p] of todo.entries()) {
        const at = new Vec3(p.x, p.y, p.z)
        // A cell out of sight stays queued, whatever stands there now.
        if (!seenNow(at)) { navPlaced.push(p); continue }
        const b = bot.blockAt(at)
        if (!b || !scaffold.has(b.name)) { alreadyGone++; continue }  // already gone / not scaffold
        if (refused.has(b.name)) { navPlaced.push(p); continue }
        try { await collectSafely(b, 'tidy'); reclaimed++ }
        catch (e) {
          failed++
          navPlaced.push(p)                                           // unreachable now — requeue
          if (stops.has(e.reason)) {
            reason = e.reason === 'busy' ? e.message : e.reason
            navPlaced.push(...todo.slice(i + 1))
            break
          }
          if (e.reason) {
            reason = e.reason
            if (!e.equip) refused.add(b.name)                       // a failed equip may pass, the next block retries
          }
        }
      }
      ok(res, { reclaimed, alreadyGone, failed, remaining: navPlaced.length, reason })
    } catch (e) { err(res, e) }
  })

  app.get('/follow', (req, res) => {
    try {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const name = req.query.name
      const range = parseInt(req.query.range || '2')
      const st = { name, range, goal: null, lastPos: bot.entity.position.clone(), lastT: Date.now(), drilling: false, lostT: 0, told: false, warnT: 0 }
      const target = followTarget(st)
      if (!target) return err(res, new Error(`player '${name}' not in view (get closer or check name)`))
      stopFollow()
      armFollow(st, target)
      st.timer = setInterval(() => { followTick(st).catch(e => console.log('[follow] check failed: ' + e.message)) }, 400)
      follow.followState = st
      ok(res, { following: name, range, supervised: true })
    } catch (e) { err(res, e) }
  })
  app.get('/unfollow', (req, res) => {
    try {
      stopFollow()
      // A bunker build owns the pathfinder and the control states.
      if (!bunker.building) { bot.pathfinder.setGoal(null); bot.clearControlStates() }
      ok(res, { unfollowed: true })
    } catch (e) { err(res, e) }
  })

  // GET /bridging?on=1|0 — deliberate opt-in for scaffolding. OFF by default (the bot swims/walks/
  // parkours, zero litter). Flip ON when a chasm/lava/gap genuinely needs a bridge; the blocks it
  // places are tracked for /tidy. No arg = report current state.
  app.get('/bridging', (req, res) => {
    try {
      const mv = bot.pathfinder.movements
      if (!mv) return err(res, new Error('movements not ready (bot not spawned?)'))
      if (req.query.on != null) {
        const on = (req.query.on === '1' || req.query.on === 'true')
        const scaff = []
        if (on && shared.mcData && shared.mcData.itemsByName) {
          if (shared.mcData.itemsByName.dirt) scaff.push(shared.mcData.itemsByName.dirt.id)
          if (shared.mcData.itemsByName.cobblestone) scaff.push(shared.mcData.itemsByName.cobblestone.id)
        }
        mv.scafoldingBlocks = scaff
      }
      ok(res, { bridging: (mv.scafoldingBlocks || []).length > 0, scaffoldItems: (mv.scafoldingBlocks || []).length })
    } catch (e) { err(res, e) }
  })

  // GET /pillar?height=N — deliberate 1x1 pillar-jump: place a block under my own feet while jumping,
  // N times. The vertical-access verb the causeway and spiral stairs both lacked (mid-air treads have
  // no reference face; my OWN feet always do). Deliberate infrastructure like stair treads — bounded,
  // never automatic (Movements keeps allow1by1towers=false; this is the pilot CHOOSING to climb).
  // /climb — ascend an adjacent ladder column (the pathfinder can't plan ladder moves; this
  // is the manual reflex, like nudgeInto is for carved stairs). Finds a ladder within 1 block,
  // faces it, holds forward (physics climbs a body pressed against a ladder), releases when the
  // feet clear the top rung, then keeps forward briefly to step off onto the floor.
  app.get('/climb', async (req, res) => {
    try {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const Vec3 = require('vec3').Vec3
      const base = bot.entity.position.floored()
      let lad = null
      outer: for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [0, 1]) {
          const b = bot.blockAt(base.offset(dx, dy, dz))
          if (b && b.name === 'ladder') { lad = b; break outer }
        }
      }
      if (!lad) return err(res, new Error('no ladder within reach'))
      const lx = lad.position.x, lz = lad.position.z
      let topY = lad.position.y
      while (((bot.blockAt(new Vec3(lx, topY + 1, lz))) || {}).name === 'ladder') topY++
      // climb = press toward the WALL the ladder hangs on. The ladder's `facing` points away
      // from its mount wall — aim opposite. ("Look at the ladder" fails when the ladder shares
      // my own column: that aims at my own feet and forward goes nowhere useful.)
      const lf = (lad.getProperties() || {}).facing || 'north'
      const AWAY = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[lf]
      safeStop()
      // enter the ladder COLUMN first — pressing at the mount wall from a neighboring
      // column just bounces against bare wall beside the ladder (learned live)
      const myCell = bot.entity.position.floored()
      if (!(myCell.x === lx && myCell.z === lz)) {
        await nudgeInto(new Vec3(lx, myCell.y, lz), false)
      }
      // A bunker build that began during the climb owns the control states from then on.
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      await bot.lookAt(new Vec3(lx + 0.5 - AWAY[0] * 2, bot.entity.position.y + 0.6, lz + 0.5 - AWAY[1] * 2), true)
      // The look turns over several ticks.
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)    // physics only sees a ladder at the FEET cell — a hop
                                           // lifts the feet into it, and climbUsingJump takes over
      const t0 = Date.now()
      let crested = false
      while (Date.now() - t0 < 15000 && !bunker.building) {
        await bot.waitForTicks(2)
        if (bot.entity.position.y >= topY + 0.9) { crested = true; break }
      }
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      bot.setControlState('jump', false)
      await bot.waitForTicks(8)            // momentum carries the step-off past the hatch lip
      if (!bunker.building) bot.setControlState('forward', false)
      ok(res, { climbed: crested, y: Math.round(bot.entity.position.y * 10) / 10, onGround: bot.entity.onGround })
    } catch (e) {
      if (!bunker.building) { try { bot.clearControlStates() } catch (_) {} }
      err(res, e)
    }
  })

  app.get('/pillar', async (req, res) => {
    const mark = legs.mark()
    let lane = null
    let stamp = null
    try {
      // 300 s outlasts the tool's budget of 16 levels at 3 jump-and-place tries each.
      lane = claimLane('pillar', 300000)
      stamp = perch.rose = Date.now()
      const given = !!req.query.height
      const asked = Math.min(16, Math.max(1, parseInt(req.query.height || '3')))
      const up = pillarHeight(asked)
      const carried = fillers().reduce((n, i) => n + i.count, 0)
      // A pit's rim would read as ground the pillar has to clear.
      const head = bot.entity.position.floored().offset(0, 1, 0)
      const inPit = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => {
        const p = head.offset(dx, 0, dz)
        const b = bot.blockAt(p)
        return !!b && b.boundingBox === 'block' && knownCell(p)
      })
      const height = inPit || given ? asked : Math.max(asked, Math.min(up.height, BUNKER_MAX_HEIGHT, carried))
      const hint = !inPit && height === asked && up.safe > asked ? { safe: up.why } : {}
      let placed = 0
      const y0 = Math.floor(bot.entity.position.y)
      const done = (body) => {
        ok(res, height > asked ? { ...body, raised: `from ${asked} to ${height}, ${up.why}` } : { ...body, ...hint })
      }
      for (let i = 0; i < height; i++) {
        if (bunker.building) return err(res, new Error(BUNKER_WALK))
        if (legs.mark() !== mark) {
          const by = legs.takenSince(mark)
          return done({ placed, rose: Math.floor(bot.entity.position.y) - y0, stopped: by ? takenText(by) : 'stopped by the pilot' })
        }
        const yBefore = Math.floor(bot.entity.position.y)
        const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
        if (!below || below.boundingBox !== 'block') return done({ placed, rose: yBefore - y0, stopped: 'no solid footing to build on' })
        const it = fillers()[0]
        if (!it) return done({ placed, rose: yBefore - y0, stopped: 'out of filler blocks (dirt, stone kinds, sandstone, bricks or planks)' })
        if (!(await jumpPlace(below, it))) {
          const at = bot.entity.position.floored()
          const onColumn = at.x === below.position.x && at.z === below.position.z
          return done({ placed, rose: at.y - y0, stopped: onColumn ? 'placement would not take (ceiling? cell blocked?)' : 'knocked off the pillar column' })
        }
        placed++
        // Each level's top holds the legs while the next one goes up.
        perch.cell = bot.entity.position.floored()
        stamp = perch.rose = Date.now()
      }
      done({ placed, rose: Math.floor(bot.entity.position.y) - y0, y: Math.floor(bot.entity.position.y) })
    } catch (e) { try { if (!bunker.building) bot.setControlState('jump', false) } catch (_) {} ; err(res, e) } finally {
      releaseLane(lane)
      // A later pillar keeps its own mark.
      if (perch.rose === stamp) perch.rose = 0
    }
  })
}

function createMovingRoutes (ctx) {
  Object.assign(ctx, { installMovingRoutes })
}

function bindMovingRoutes (ctx) {
  ({ bot, shared, bunker, ok, err, BUNKER_WALK, gotoQuery, claimLane, walkRoute, stagedGoto, standsAtWaypoint, memory, waypoints, journal, doorBeside, namedStop, releaseLane, legs, stopFollow, stopPath, clearLane, jobs, navPlaced, collectLock, collectBusy, collectSafely, follow, followTarget, armFollow, followTick, safeStop, nudgeInto, pillarHeight, fillers, knownCell, jumpPlace, BUNKER_MAX_HEIGHT, perch, seenNow, endHand } = ctx)
}

module.exports = { createMovingRoutes, bindMovingRoutes }
