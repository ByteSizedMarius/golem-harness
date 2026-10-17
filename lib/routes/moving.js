'use strict'

const { takenText } = require('../legs')

let bot, shared, bunker, ok, err, BUNKER_WALK, gotoQuery, claimLane, walkRoute, stagedGoto, memory, waypoints, journal, doorBeside, namedStop, releaseLane, legs, stopFollow, stopPath, clearLane, jobs, navPlaced, collectLock, collectBusy, collectSafely, follow, followTarget, armFollow, followTick, safeStop, nudgeInto, pillarHeight, fillers, knownCell, jumpPlace, BUNKER_MAX_HEIGHT, perch

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
      const route = walkRoute()
      let r
      try { r = await stagedGoto(q, route, { preview, accept: req.query.accept === '1' }) } finally { route.end() }
      if (preview) r.preview = true
      else if (r.reason) {
        r.walked = route.walked()
        const door = doorBeside()
        if (door) r.door = door
      }
      if (r.arrived && q.waypoint !== undefined) {
        if (memory.lastWaypoint && memory.lastWaypoint !== q.waypoint) waypoints.link(memory.lastWaypoint, q.waypoint)
        memory.lastWaypoint = q.waypoint
        journal('goto', 'went to ' + q.waypoint)
      }
      const { x, y, z } = bot.entity.position.floored()
      ok(res, namedStop({ ...r, cell: { x, y, z } }, route.mark))
    } catch (e) { err(res, e) } finally { releaseLane(lane) }
  })

  app.get('/lookat', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      await bot.lookAt(new Vec3(parseFloat(req.query.x), parseFloat(req.query.y), parseFloat(req.query.z)), true)
      ok(res, { yaw: +bot.entity.yaw.toFixed(2), pitch: +bot.entity.pitch.toFixed(2) })
    } catch (e) { err(res, e) }
  })

  app.get('/stop', (req, res) => { bunker.stop = 'stopped by the pilot'; legs.take(null); try { stopFollow() } catch {} ; stopPath(); try { bot.clearControlStates() } catch {} ; clearLane(); const jobsCancelled = jobs.stopAll(); ok(res, { stopped: true, jobsCancelled }) })

  // GET /tidy — reclaim scaffolding the pathfinder left behind. Mines back every still-standing
  // scaffold block the bot placed while navigating (tracked in navPlaced), collecting the material,
  // leaving the world as it found it. ?dry=1 reports the pending count without mining.
  app.get('/tidy', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const scaffold = new Set(['cobblestone', 'dirt'])
      if (req.query.dry === '1') return ok(res, { pending: navPlaced.length, blocks: navPlaced.slice(0, 20) })
      if (collectLock.done) return err(res, collectBusy())
      const todo = navPlaced.splice(0)                       // take & clear the queue
      const here = bot.entity.position
      todo.sort((a, b) => here.distanceTo(new Vec3(a.x, a.y, a.z)) - here.distanceTo(new Vec3(b.x, b.y, b.z)))
      let reclaimed = 0, alreadyGone = 0, failed = 0
      // Why the reclaim stopped short: stalled, budget, busy or stopped.
      let reason = null
      for (const [i, p] of todo.entries()) {
        const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
        if (!b || !scaffold.has(b.name)) { alreadyGone++; continue }  // already gone / not scaffold
        try { await collectSafely(b, 'tidy'); reclaimed++ }
        catch (e) {
          failed++
          navPlaced.push(p)                                           // unreachable now — requeue
          if (e.reason) {
            reason = e.reason
            navPlaced.push(...todo.slice(i + 1))
            break
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
      ok(res, { climbed: crested, y: Math.round(bot.entity.position.y * 10) / 10, ladderTop: topY, onGround: bot.entity.onGround })
    } catch (e) { try { bot.clearControlStates() } catch (_) {}; err(res, e) }
  })

  app.get('/pillar', async (req, res) => {
    const mark = legs.mark()
    try {
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
      const height = inPit ? asked : Math.max(asked, Math.min(up.height, BUNKER_MAX_HEIGHT, carried))
      let placed = 0
      const y0 = Math.floor(bot.entity.position.y)
      const done = (body) => {
        if (placed) perch.cell = bot.entity.position.floored()
        ok(res, height > asked ? { ...body, raised: `from ${asked} to ${height}, ${up.why}` } : body)
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
        if (!(await jumpPlace(below, it))) return done({ placed, rose: Math.floor(bot.entity.position.y) - y0, stopped: 'placement would not take (ceiling? cell blocked?)' })
        placed++
      }
      done({ placed, rose: Math.floor(bot.entity.position.y) - y0, y: Math.floor(bot.entity.position.y) })
    } catch (e) { try { if (!bunker.building) bot.setControlState('jump', false) } catch (_) {} ; err(res, e) }
  })
}

function createMovingRoutes (ctx) {
  Object.assign(ctx, { installMovingRoutes })
}

function bindMovingRoutes (ctx) {
  ({ bot, shared, bunker, ok, err, BUNKER_WALK, gotoQuery, claimLane, walkRoute, stagedGoto, memory, waypoints, journal, doorBeside, namedStop, releaseLane, legs, stopFollow, stopPath, clearLane, jobs, navPlaced, collectLock, collectBusy, collectSafely, follow, followTarget, armFollow, followTick, safeStop, nudgeInto, pillarHeight, fillers, knownCell, jumpPlace, BUNKER_MAX_HEIGHT, perch } = ctx)
}

module.exports = { createMovingRoutes, bindMovingRoutes }
