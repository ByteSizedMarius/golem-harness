'use strict'

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { entityInCell } = require('../shelter')
const { takenText } = require('../leg-ledger')

let bot, shared, fight, legs, jobs, reflexes, bunker, OPENABLE, emitEvent, ok, err, claimLane, releaseLane, resolveItem, meleeThreat, seenNow, cellKnown, lineCell, entityPerceptible, blockers, isSoftCover, isInteractive, clearSoftCover, sneakPlace, holdDigTool

// ---- build verbs: outline, walls, roof and build share the helpers below ----
// A build reply lists at most this many failed cells.
const BUILD_FAIL_LIST = 12
// How far from the eye to a cell's centre a build verb places without walking.
const BUILD_REACH = 4.2
// The failures a walk toward the cell can cure.
const BUILD_WALK_CURES = ['out of reach', 'cell not known to the bot', 'no line of sight to a face']

// The border cells [x, z] of the w x d rectangle with corner x0, z0, x-major.
function perimeter (x0, z0, w, d) {
  const cells = []
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
    if (i === 0 || i === w - 1 || j === 0 || j === d - 1) cells.push([x0 + i, z0 + j])
  }
  return cells
}

// Every cell [x, z] of that rectangle, outer rings first.
function ringOrder (x0, z0, w, d) {
  const cells = []
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
    cells.push([x0 + i, z0 + j, Math.min(i, j, w - 1 - i, d - 1 - j)])
  }
  return cells.sort((a, b) => a[2] - b[2]).map(([x, z]) => [x, z])
}

// The item name of the placeable block name stands for, after the server's aliases.
function buildBlock (name) {
  const item = resolveItem(name)
  if (!item || !shared.mcData.blocksByName[item.name] || !shared.mcData.itemsByName[item.name]) throw new Error(`unknown block: ${name}`)
  return item.name
}

// A build verb's run, holding the pilot lane until buildClose. failed lists { at, reason } per cell.
function buildRun (verb) {
  const run = { placed: 0, skipped: 0, failed: [], stopped: null, mark: legs.mark(), since: Date.now() }
  run.onDeath = () => { run.stopped = run.stopped || 'the body died' }
  bot.once('death', run.onDeath)
  run.lane = claimLane(verb, 600000)
  return run
}

// Why the run has to end now, or null. The first reason found stays.
function buildHalt (run, job = null) {
  if (run.stopped) return run.stopped
  const taken = legs.mark() !== run.mark
  if (taken || (job && job.cancelled)) {
    const by = taken ? legs.takenSince(run.mark) : job.takenBy
    run.stopped = by ? takenText(by) : 'stopped by the pilot'
  } else if (bunker.building) run.stopped = 'a bunker is being built'
  else if (fight.lastHit.t >= run.since && ['hostile', 'creeper', 'heavy', 'provokable'].includes(fight.lastHit.cls)) run.stopped = 'a mob hit me'
  else if (meleeThreat()) run.stopped = 'a hostile is in melee reach'
  return run.stopped
}

// The reply of a build verb: its run's counts and failures, then fields.
function buildSummary (run, fields) {
  const failures = run.failed.slice(0, BUILD_FAIL_LIST).map(({ at, reason }) => `${at.x},${at.y},${at.z}: ${reason}`)
  return { placed: run.placed, skipped: run.skipped, failed: run.failed.length, ...(failures.length && { failures }), ...(run.stopped && { stopped: run.stopped }), ...fields }
}

function buildClose (run) {
  if (!run) return
  bot.removeListener('death', run.onDeath)
  releaseLane(run.lane)
}

// The first of names the pockets hold, or null.
function pocketBlock (names) {
  const items = bot.inventory.items()
  for (const n of names) {
    const it = items.find(i => i.name === n)
    if (it) return it
  }
  return null
}

// 'door' or 'skip' for a cell the bot sees now holding a door, gate or trapdoor or a solid block, else null.
function cellTaken (cell) {
  if (!seenNow(cell)) return null
  const b = bot.blockAt(cell)
  if (b && OPENABLE.test(b.name)) return 'door'
  return b && b.boundingBox === 'block' && !isSoftCover(b) ? 'skip' : null
}

// True when the body or an entity the bot perceives keeps a block out of cell.
function entityBlocks (cell) {
  if (entityInCell(cell, [bot.entity])) return true
  const inCell = blockers().filter(e => entityInCell(cell, [e]))
  if (!inCell.length) return false
  const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
  return inCell.some(e => entityPerceptible(e, fill))
}

// The { ref, face } a block for cell goes against, below first and interactive blocks last, else why there is none.
function supportFace (cell) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  let unseen = false
  let interactive = null
  for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const p = cell.offset(dx, dy, dz)
    if (!seenNow(p)) { unseen = true; continue }
    const b = bot.blockAt(p)
    if (!b || b.boundingBox !== 'block' || isSoftCover(b)) continue
    if (!lineCell(eye, cell.offset(0.5 + dx * 0.45, 0.5 + dy * 0.45, 0.5 + dz * 0.45), cell)) { unseen = true; continue }
    const support = { ref: b, face: new Vec3(-dx, -dy, -dz) }
    if (!isInteractive(b)) return support
    interactive = interactive || support
  }
  return interactive || (unseen ? 'no line of sight to a face' : 'no support face')
}

// Walks to goal under the stall watch. Null once there, else why the cell failed.
async function buildWalk (goal) {
  try {
    await bot.pathfinder.goto(goal)
    return null
  } catch (e) { return e.reason ? 'path stalled' : 'out of reach' }
}

// What a block at cell meets from where the body stands: { ref, face } to place against, 'skip' for a solid cell, or why it fails.
function buildVerdict (cell) {
  if (bot.entity.position.offset(0, 1.62, 0).distanceTo(cell.offset(0.5, 0.5, 0.5)) > BUILD_REACH) return 'out of reach'
  if (!cellKnown(cell)) return 'cell not known to the bot'
  const taken = cellTaken(cell)
  if (taken) return taken
  if (entityBlocks(cell)) return 'occupied by an entity'
  return supportFace(cell)
}

// Places the first of names the pockets hold at cell, walking to goal when that helps, and counts the outcome in run.
async function buildCell (run, cell, names, goal, job = null) {
  const fail = (reason) => { run.failed.push({ at: cell, reason }) }
  if (buildHalt(run, job)) return
  const taken = cellTaken(cell)
  if (taken === 'door') return fail('door')
  if (taken) { run.skipped++; return }
  if (!pocketBlock(names)) return fail('no block in pockets')
  let v = buildVerdict(cell)
  if (BUILD_WALK_CURES.includes(v)) {
    const walk = await buildWalk(goal)
    if (buildHalt(run, job)) return
    v = buildVerdict(cell)
    if (walk && v === 'out of reach') v = walk
  }
  if (v === 'skip') { run.skipped++; return }
  if (typeof v === 'string') return fail(v)
  try {
    await clearSoftCover(cell)
    await bot.equip(pocketBlock(names), 'hand')
    if (buildHalt(run, job)) return
    await bot.lookAt(cell.offset(0.5, 0.5, 0.5), true)
    await sneakPlace(v.ref, () => bot.placeBlock(v.ref, v.face))
    run.placed++
  } catch (e) {
    if (!buildHalt(run, job)) fail(isInteractive(v.ref) ? `did not place against the ${v.ref.name}` : 'did not place')
  }
}

// The first solid block within 10 below top in column x,z, 'unknown' at a cell not seen now, else null.
function knownGround (x, z, top) {
  for (let y = top; y > top - 10; y--) {
    const p = new Vec3(x, y, z)
    if (!seenNow(p)) return 'unknown'
    const b = bot.blockAt(p)
    if (b && b.boundingBox === 'block' && !isSoftCover(b)) return b
  }
  return null
}

function installBuildingRoutes (app) {
  // lay a rectangular perimeter (foundation outline). Walks each border cell, finds the
  // ground column there, and places a block on top of it. x,z = a corner; w,d = size.
  app.get('/outline', async (req, res) => {
    let run = null
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const x0 = Math.floor(parseFloat(req.query.x))
      const z0 = Math.floor(parseFloat(req.query.z))
      const w = parseInt(req.query.w || '7')
      const d = parseInt(req.query.d || '7')
      const block = buildBlock(req.query.name || 'oak_planks')
      const startY = Math.floor(parseFloat(req.query.y || bot.entity.position.y))
      const cells = perimeter(x0, z0, w, d)
      run = buildRun('outline')
      for (const [x, z] of cells) {
        if (buildHalt(run)) break
        let ground = knownGround(x, z, startY + 4)
        let walk = null
        if (ground === 'unknown') {
          walk = await buildWalk(new goals.GoalNear(x, startY, z, 2))
          if (buildHalt(run)) break
          ground = knownGround(x, z, startY + 4)
        }
        if (!ground || ground === 'unknown') {
          run.failed.push({ at: { x, y: startY, z }, reason: ground ? walk || 'cell not known to the bot' : 'no support face' })
          continue
        }
        const target = ground.position.offset(0, 1, 0)
        await buildCell(run, target, [block], new goals.GoalNear(target.x, target.y, target.z, 2))
      }
      ok(res, buildSummary(run, { footprint: `${w}x${d}`, corner: { x: x0, z: z0 }, material: block }))
    } catch (e) { err(res, e) } finally { buildClose(run) }
  })

  // ---- raise walls: perimeter columns to a uniform height, with a doorway ----
  app.get('/walls', async (req, res) => {
    let run = null
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const x0 = Math.floor(parseFloat(req.query.x))
      const z0 = Math.floor(parseFloat(req.query.z))
      const w = parseInt(req.query.w || '7')
      const d = parseInt(req.query.d || '7')
      const h = parseInt(req.query.h || '3')
      const base = Math.floor(parseFloat(req.query.base || bot.entity.position.y))
      const baseMat = buildBlock(req.query.base_name || 'cobblestone')
      const wallMat = buildBlock(req.query.name || 'oak_planks')
      const doorSide = req.query.door || 'west'
      const perim = perimeter(x0, z0, w, d)
      let doorCell
      if (doorSide === 'west') doorCell = [x0, z0 + Math.floor(d / 2)]
      else if (doorSide === 'east') doorCell = [x0 + w - 1, z0 + Math.floor(d / 2)]
      else if (doorSide === 'north') doorCell = [x0 + Math.floor(w / 2), z0]
      else doorCell = [x0 + Math.floor(w / 2), z0 + d - 1]
      const isDoor = (x, z) => x === doorCell[0] && z === doorCell[1]
      run = buildRun('walls')
      for (const [x, z] of perim) {
        if (buildHalt(run)) break
        for (let k = 0; k < h; k++) {
          if (isDoor(x, z) && k < 2) continue          // leave a 2-high doorway
          await buildCell(run, new Vec3(x, base + k, z), k === 0 ? [baseMat, wallMat] : [wallMat, baseMat], new goals.GoalNear(x, base, z, 2))
        }
      }
      ok(res, buildSummary(run, { size: `${w}x${d}`, height: h, door: doorSide }))
    } catch (e) { err(res, e) } finally { buildClose(run) }
  })

  // fill a solid w x d slab at height y (roof/floor). Places outer rings first so each
  // interior cell has an already-placed neighbor to build against.
  app.get('/roof', async (req, res) => {
    let run = null
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const x0 = Math.floor(parseFloat(req.query.x))
      const z0 = Math.floor(parseFloat(req.query.z))
      const w = parseInt(req.query.w || '7')
      const d = parseInt(req.query.d || '7')
      const y = Math.floor(parseFloat(req.query.y))
      const block = buildBlock(req.query.name || 'oak_planks')
      const cells = ringOrder(x0, z0, w, d)
      run = buildRun('roof')
      for (const [x, z] of cells) {
        if (buildHalt(run)) break
        // A goal at the roof cell itself sends the pathfinder hunting for a way up.
        await buildCell(run, new Vec3(x, y, z), [block], new goals.GoalNear(x, y - 4, z, 1))
      }
      ok(res, buildSummary(run, { size: `${w}x${d}`, y }))
    } catch (e) { err(res, e) } finally { buildClose(run) }
  })

  // GET /build?template=cabin&x=&z=&w=&d=&h= : background job raising a full structure --
  // cobble/plank base perimeter -> plank walls to height h (default 3) -> 2-high doorway
  // centered on the west (-x) side -> a SOLID roof placed outer-ring-first (so each interior
  // roof cell has an already-placed neighbor to build against). Reuses the /outline,/walls,
  // /roof placement approach. Pulls from inventory; skips cells already solid.
  app.get('/build', (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const template = req.query.template || 'cabin'
      if (template !== 'cabin') return err(res, new Error("unknown template (only 'cabin')"))
      const x0 = Math.floor(parseFloat(req.query.x))
      const z0 = Math.floor(parseFloat(req.query.z))
      const w = Math.max(3, parseInt(req.query.w || '7'))
      const d = Math.max(3, parseInt(req.query.d || '7'))
      const h = Math.max(2, parseInt(req.query.h || '3'))
      const base = Math.floor(parseFloat(req.query.base || bot.entity.position.y))
      const baseMat = buildBlock(req.query.base_name || 'cobblestone')
      const wallMat = buildBlock(req.query.name || 'oak_planks')

      // west doorway centered on the -x wall (matches /walls door='west')
      const doorCell = [x0, z0 + Math.floor(d / 2)]
      const isDoor = (x, z) => x === doorCell[0] && z === doorCell[1]

      const { id } = jobs.start(`build ${template} ${w}x${d}h${h} @${x0},${z0}`, async (job) => {
        const run = buildRun('build')
        try {
          const stats = { foundation: 0, walls: 0, roof: 0 }
          const near = (cell) => new goals.GoalNear(cell.x, cell.y, cell.z, 3)
          const perim = perimeter(x0, z0, w, d)

          // ---- foundation: base-material perimeter at y=base ----
          job.progress('phase: foundation')
          let before = run.placed
          for (const [x, z] of perim) {
            if (buildHalt(run, job)) break
            if (isDoor(x, z)) continue                 // leave the doorway cell open (no place-then-dig churn)
            const cell = new Vec3(x, base, z)
            await buildCell(run, cell, [baseMat, wallMat], near(cell), job)
          }
          stats.foundation = run.placed - before
          emitEvent('build', `foundation done (${stats.foundation})`, { x: x0, z: z0 })

          // ---- walls: perimeter columns base+1..base+h-1, leaving the doorway open ----
          job.progress('phase: walls')
          before = run.placed
          for (const [x, z] of perim) {
            if (buildHalt(run, job)) break
            for (let k = 1; k < h; k++) {
              if (isDoor(x, z) && k < 2) { continue }  // 2-high doorway (rows k=0 base & k=1)
              const cell = new Vec3(x, base + k, z)
              await buildCell(run, cell, [wallMat, baseMat], near(cell), job)
            }
          }
          stats.walls = run.placed - before

          // ---- door: dig seen solid blocks out of the 2-high doorway span (base..base+1) ----
          job.progress('phase: door')
          for (let k = 0; k < 2 && !buildHalt(run, job); k++) {
            const dp = new Vec3(doorCell[0], base + k, doorCell[1])
            // Only a seen solid block goes, never a door.
            if (cellTaken(dp) !== 'skip') continue
            const walk = await buildWalk(near(dp))
            if (buildHalt(run, job)) break
            if (walk) { run.failed.push({ at: dp, reason: walk }); continue }
            if (cellTaken(dp) !== 'skip') continue
            try {
              await holdDigTool(bot.blockAt(dp))
              if (buildHalt(run, job)) break
              await bot.dig(bot.blockAt(dp))
            } catch (e) { if (!buildHalt(run, job)) run.failed.push({ at: dp, reason: 'did not dig' }) }
          }

          // ---- roof: solid slab at y=base+h, outer-ring-first (neighbor to build against) ----
          job.progress('phase: roof')
          const roofCells = ringOrder(x0, z0, w, d)
          before = run.placed
          for (const [x, z] of roofCells) {
            if (buildHalt(run, job)) break
            const cell = new Vec3(x, base + h, z)
            await buildCell(run, cell, [wallMat, baseMat], near(cell), job)
          }
          stats.roof = run.placed - before

          emitEvent('build', `cabin ${run.stopped || 'complete'} f=${stats.foundation} w=${stats.walls} r=${stats.roof}`, stats)
          return buildSummary(run, { template, size: `${w}x${d}`, height: h, corner: { x: x0, z: z0 }, ...stats })
        } finally { buildClose(run) }
      })
      ok(res, { job: id })
    } catch (e) { err(res, e) }
  })
}

function createBuildingRoutes (ctx) {
  Object.assign(ctx, { installBuildingRoutes })
}

function bindBuildingRoutes (ctx) {
  ({ bot, shared, fight, legs, jobs, reflexes, bunker, OPENABLE, emitEvent, ok, err, claimLane, releaseLane, resolveItem, meleeThreat, seenNow, cellKnown, lineCell, entityPerceptible, blockers, isSoftCover, isInteractive, clearSoftCover, sneakPlace, holdDigTool } = ctx)
}

module.exports = { createBuildingRoutes, bindBuildingRoutes }
