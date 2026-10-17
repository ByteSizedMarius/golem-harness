'use strict'

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { enclosedDrop } = require('../drops')
const { GRAVESTONE, overrideRecipes, craftable } = require('../server-overrides')
const { smeltYield, burnItems, COOK_PROBE_TICKS } = require('../furnace')
const { LEGACY_1710, SERVER_RECIPES } = require('../bot/config')

let bot, liveEntities, entityPerceptible, routeEnd, stagedGoto, round, cellKnown, xyz, shared, resolveBlockIds, nearestKnown, arrivedStation, NEIGHBOURS, bodyTouches, seesLit, fillFrom, err, collectLock, collectBusy, nearestVisible, collectSafely, ok, bunker, BUNKER_WALK, claimLane, walkRoute, namedStop, releaseLane, resolveItem, placeSpot, clearSoftCover, jobs, safeFood, foodUpdate, FOOD_UPDATE_MS, outOfSight, seenNow, holdDigTool, neededPickTier, PICK_TIER, holdHarvester, occupant, isSoftCover, isInteractive, reachToPlace, passageAxis, stampOwnEdit, sneakPlace, send, watchedWork, stopPath, emitEvent, refuseWhileBuilding, equipPickFor, knownCell, nudgeInto, macroPlaceAt, playerEntity, playerSighting, reflexes, nearestSeen, targetSeen, inMeleeReach, knownBlocks, rememberedStation, skyInSight, cardinal, cardinalName

// ---- MACROS subsystem helpers ----
// how far below the bot's feet we tolerate before refusing to dig down toward a target
const GATHER_MAX_DROP = 2
const GATHER_MAX_RISE = 4   // don't target logs more than ~4 above feet — out of dig-reach without
                            // climbing, so with canDig=false they just time out. Get the reachable trunk.

function itemCounts () {
  const counts = {}
  for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count
  return counts
}

function nearestDrop (radius, skip) {
  const here = bot.entity.position
  return liveEntities()
    .filter(e => e.name === 'item' && e.position && !skip.has(e.id) && e.position.distanceTo(here) <= radius && entityPerceptible(e, null))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0] || null
}

async function collectDrops (radius, route) {
  const skip = new Set()
  const missed = []
  for (;;) {
    if (routeEnd(route)) return { missed, reason: routeEnd(route) }
    const drop = nearestDrop(radius, skip)
    if (!drop) return { missed, reason: null }
    const r = await stagedGoto({ drop }, route)
    if (r.reason === 'stopped') return { missed, reason: 'stopped' }
    // A pickup lands a few ticks after the arrival.
    for (let i = 0; i < 10 && bot.entities[drop.id] && !routeEnd(route); i++) await bot.waitForTicks(2)
    if (!bot.entities[drop.id] || routeEnd(route)) continue
    skip.add(drop.id)
    const item = drop.getDroppedItem && drop.getDroppedItem()
    missed.push({ item: item ? item.name : 'item', pos: round(drop.position), reason: r.reason || 'not-picked-up' })
  }
}

// Marks each missed drop that no known cell a body fits in reaches as enclosed, with its cell.
function enclosedMisses (missed) {
  return missed.map(m => {
    const cell = enclosedDrop(m.pos, { blockAt: (p) => bot.blockAt(p), known: cellKnown })
    return cell ? { ...m, reason: 'enclosed', cell: xyz(cell) } : m
  })
}

// The collect reply's hint for drops no body reaches.
function enclosedHint (missed) {
  const cells = missed.filter(m => m.reason === 'enclosed').map(m => `${m.cell.x},${m.cell.y},${m.cell.z}`)
  return cells.length ? `enclosed at ${cells.join(' and ')}: dig to it, or place a block into its cell to push it out` : null
}

// Crafts at a crafting table seen within 16 blocks, else in the 2x2 grid if the recipe fits, and never places a table.
async function craftItem (item, count) {
  const override = overrideRecipes(SERVER_RECIPES, item.name, shared.mcData.itemsByName)
  const recipesAt = (table) => override
    ? craftable(override, table, (id) => bot.inventory.count(id, null))
    : bot.recipesFor(item.id, null, 1, table)
  // Does this recipe need a 3x3 table? (craftable WITH an assumed table but not without one)
  const needsTable = !recipesAt(null).length && !!recipesAt(true).length
  // Tableless 2x2 crafting desyncs on 1.21.x: the client simulates the craft (materials down,
  // output up) but the server never performs it, and the next sync deletes the output. Route
  // every craft through a real table when one is reachable; 2x2 only as last resort.
  const canUseTable = !!recipesAt(true).length
  const tableIds = resolveBlockIds('crafting_table')
  const near = nearestKnown(tableIds, 16)
  if (needsTable && !near) throw new Error('no crafting table seen within 16, place one (place or placeitem) and craft again')
  const useTable = canUseTable && !!near
  if (useTable) {
    // walk within reach of an existing table (fixes today's "table 4 blocks away" failure)
    const { x, y, z } = near.position
    try { await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3)) } catch (e) {
      if (e.reason) throw e
      throw new Error(`cannot reach the crafting table at ${x},${y},${z}`)
    }
  }

  // count means ITEMS, not recipes (the 12-log lesson): one recipe pass may yield several
  // items (planks 4, sticks 4, torches 4) — stop as soon as we've made enough.
  let made = 0, lastErr = null
  while (made < count) {
    const at = useTable && nearestKnown(tableIds, 4)
    const t = at ? arrivedStation(at.position, (b) => b.name === 'crafting_table', 'crafting table') : null
    const recipes = recipesAt(t)
    if (!recipes.length) { lastErr = `out of materials/recipe after ${made}${useTable ? ` (table nearby: ${!!t})` : ''}`; break }
    const perCraft = (recipes[0].result && recipes[0].result.count) || 1
    try { await bot.craft(recipes[0], 1, t || undefined); made += perCraft }
    catch (e) { lastErr = e.message; break }
  }

  const nowHave = bot.inventory.items().filter(it => it.name === item.name).reduce((s, it) => s + it.count, 0)
  if (made === 0) throw new Error(lastErr || 'craft failed')
  return { crafted: item.name, requested: count, made, usedTable: useTable, nowHave, note: lastErr || undefined }
}

// The items a dig of the blocks ids lands in the pockets: their drops, or the block itself.
function gatherItems (ids) {
  const names = new Set()
  for (const id of ids) {
    const blk = shared.mcData.blocks[id]
    for (const d of blk.drops) names.add(shared.mcData.items[d].name)
    if (shared.mcData.itemsByName[blk.name]) names.add(blk.name)
  }
  names.delete('air')
  return names
}

// Why a dig job stops after digging p (bared lava or water, or with falls a gravel or sand cap), or null.
async function struckHazard (p, falls) {
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const n = p.offset(dx, dy, dz)
    const b = bot.blockAt(n)
    const falling = falls && dy === 1 && !!b && /^(gravel|sand|red_sand)$/.test(b.name)
    if (!b || !(falling || /lava|water/.test(b.name)) || !(bodyTouches(n) || seesLit(n, 8))) continue
    const at = `${n.x},${n.y},${n.z}`
    if (falling) return `${b.name} falling from ${at}, stopping`
    if (!b.name.includes('lava')) return `struck ${b.name} at ${at}, stopping`
    const why = await fillFrom(p)
    return `struck ${b.name} at ${at}, ${why ? `the hole stays open, ${why}` : 'filled the hole back'}`
  }
  return null
}

// ---- chest / container interaction ----
const CHEST_RADIUS = 12
function sameChest (a, b) {
  return a.y === b.y && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) <= 1
}
// Trapped chests are left out because opening one powers redstone.
function knownChests (radius) {
  const here = bot.entity.position
  const near = knownBlocks(resolveBlockIds('chest'), radius)
    .map(p => ({ pos: p, dist: here.distanceTo(p.offset(0.5, 0.5, 0.5)) }))
  return near.filter((c, i) => !near.slice(0, i).some(o => sameChest(o.pos, c.pos)))
}
function otherChests (p, radius) {
  const others = knownChests(radius).filter(c => !sameChest(c.pos, p))
  if (!others.length) return `no other chest seen within ${radius}`
  return `other chests seen within ${radius}: ` + others.map(c => `${c.pos.x},${c.pos.y},${c.pos.z} (${c.dist.toFixed(1)} away)`).join(', ')
}
function targetChest(q) {
  if (q.x != null && q.y != null && q.z != null) {
    const Vec3 = require('vec3').Vec3
    const p = new Vec3(Math.floor(parseFloat(q.x)), Math.floor(parseFloat(q.y)), Math.floor(parseFloat(q.z)))
    if (!seenNow(p)) {
      const remembered = rememberedStation(p, resolveBlockIds('chest'))
      if (!remembered) throw outOfSight()
      return { cb: remembered }
    }
    const b = bot.blockAt(p)
    if (!b || !b.name.includes('chest')) throw new Error(`no chest at ${q.x},${q.y},${q.z} (${b ? b.name : 'unloaded'})`)
    return { cb: b }
  }
  const radius = parseInt(q.radius || CHEST_RADIUS)
  const chests = knownChests(radius)
  if (!chests.length) throw new Error(`no chest seen within ${radius}`)
  return { cb: bot.blockAt(chests[0].pos), chests }
}

const GRAVE_SIGHT = 32
// Refuses a cell out of lit sight before reading its block.
function targetGrave (q) {
  const grave = shared.mcData && shared.mcData.blocksByName[GRAVESTONE]
  if (!grave) throw new Error('this server has no gravestones')
  if (q.at == null) return nearestVisible([grave.id], GRAVE_SIGHT)
  const [x, y, z] = String(q.at).split(',').map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('at takes x,y,z')
  const p = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  if (!seesLit(p, GRAVE_SIGHT)) throw outOfSight()
  const b = bot.blockAt(p)
  if (!b || b.name !== GRAVESTONE) throw new Error(`no gravestone at ${q.at} (${b ? b.name : 'unloaded'})`)
  return b
}

// The cell that must change when clicking b at p with held works, null when it may work and change nothing.
function useTarget (b, p, held) {
  const props = b.getProperties()
  if ('open' in props) return p
  if (!held) return null
  if (held.endsWith('_hoe') && /^(dirt|grass_block|dirt_path|coarse_dirt|rooted_dirt)$/.test(b.name)) return p
  if ((b.name === 'farmland' && /^(wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds|carrot|potato|torchflower_seeds|pitcher_pod)$/.test(held)) ||
    (b.name === 'soul_sand' && held === 'nether_wart')) return p.offset(0, 1, 0)
  if (held === 'bone_meal' && 'age' in props) return p
  if (held === 'bucket' && /^(water|lava)$/.test(b.name)) return p
  if (/^(water|lava)_bucket$/.test(held) && /^(cave_|void_)?air$/.test(b.name)) return p
  return null
}

// Runs act, then waits until the server updates the block at p, at most ms.
async function withBlockUpdate (p, ms, act) {
  let updated
  const update = new Promise((resolve) => { updated = resolve })
  const onUpdate = (old, now) => { if (now && now.position.equals(p)) updated() }
  bot.on('blockUpdate', onUpdate)
  let timer
  try {
    await act()
    await Promise.race([update, new Promise((resolve) => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
    bot.removeListener('blockUpdate', onUpdate)
  }
}

function targetFurnace (q) {
  if (q.at == null) {
    const b = nearestKnown(resolveBlockIds('furnace'), 8)
    if (!b) throw new Error('no furnace seen within 8')
    return b
  }
  const [x, y, z] = String(q.at).split(',').map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('at takes x,y,z')
  const p = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  if (!seenNow(p)) {
    const remembered = rememberedStation(p, resolveBlockIds('furnace'))
    if (!remembered) throw outOfSight()
    return remembered
  }
  const b = bot.blockAt(p)
  if (!b || b.name !== 'furnace') throw new Error(`no furnace at ${q.at} (${b ? b.name : 'unloaded'})`)
  return b
}

function furnaceSlots (furnace) {
  const text = (i) => i ? `${i.count} ${i.name}` : null
  return { input: text(furnace.inputItem()), fuel: text(furnace.fuelItem()), output: text(furnace.outputItem()) }
}

function pocketRoom (window, item) {
  const partial = window.items().filter(i => i.type === item.type).reduce((s, i) => s + i.stackSize - i.count, 0)
  return window.emptySlotCount() * item.stackSize + partial
}

async function takeSlot (furnace, item, n) {
  await bot.transfer({ window: furnace, itemType: item.type, metadata: null, count: n,
    sourceStart: item.slot, sourceEnd: item.slot + 1, destStart: furnace.inventoryStart, destEnd: furnace.inventoryEnd })
}

// A furnace lights its fuel and cooks only an input the server has a recipe for.
async function furnaceCooks (furnace) {
  for (let t = 0; t < COOK_PROBE_TICKS; t++) {
    if (furnace.progress > 0) return true
    await bot.waitForTicks(1)
  }
  return furnace.progress > 0
}

function installWorkingRoutes (app) {
  app.get('/mine', async (req, res) => {
    try {
      const name = req.query.name
      const count = parseInt(req.query.count || '1')
      const radius = parseInt(req.query.radius || '64')
      const ids = resolveBlockIds(name)
      if (!ids.length) return err(res, new Error(`unknown block: ${name}`))
      if (collectLock.done) return err(res, collectBusy())
      const items = gatherItems(ids)
      const pocketed = () => bot.inventory.items().reduce((s, it) => s + (items.has(it.name) ? it.count : 0), 0)
      const before = pocketed()
      let mined = 0
      // Why the collect stopped short: stalled, budget, busy or stopped.
      let reason = null
      for (let i = 0; i < count; i++) {
        const b = nearestVisible(ids, radius)
        if (!b) break
        try {
          await collectSafely(b, `mine ${name}`)
        } catch (e) {
          if (!e.reason) throw e
          reason = e.reason
        }
        // A collect can dig the block and then stall on the pickup.
        const after = bot.blockAt(b.position)
        if (after && after.name !== b.name) mined++
        if (reason) break
      }
      // The slot update of a pickup can land a few ticks after the drop is gone.
      for (let i = 0; i < 10 && pocketed() - before < mined; i++) await bot.waitForTicks(1)
      ok(res, { mined, requested: count, gathered: pocketed() - before, reason })
    } catch (e) { err(res, e) }
  })

  app.get('/collect', async (req, res) => {
    let lane = null
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const radius = parseInt(req.query.radius || '16')
      lane = claimLane('collect', 300000)
      const before = itemCounts()
      const route = walkRoute()
      let done
      try { done = await collectDrops(radius, route) } finally { route.end() }
      const now = itemCounts()
      const picked = {}
      for (const [name, n] of Object.entries(now)) if (n > (before[name] || 0)) picked[name] = n - (before[name] || 0)
      const missed = enclosedMisses(done.missed)
      ok(res, namedStop({ picked, missed, reason: done.reason, hint: enclosedHint(missed) }, route.mark))
    } catch (e) { err(res, e) } finally { releaseLane(lane) }
  })

  app.get('/craft', async (req, res) => {
    try {
      const item = resolveItem(req.query.item)
      if (!item) return err(res, new Error(`unknown item: ${req.query.item}`))
      const count = Math.max(1, parseInt(req.query.count || '1'))
      ok(res, await craftItem(item, count))
    } catch (e) { err(res, e) }
  })

  app.get('/place', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const name = req.query.name
      const it = bot.inventory.items().find(i => i.name === name)
      if (!it) return err(res, new Error(`no ${name} in inventory`))
      await bot.equip(it, 'hand')
      const spot = placeSpot()
      if (!spot) return err(res, new Error('no valid adjacent ground spot (need air-over-solid beside me, clear of my body) — for an exact cell use /placeitem?name=&x=&y=&z= instead'))
      const below = spot.offset(0, -1, 0)
      await clearSoftCover(spot)
      await bot.lookAt(spot.offset(0.5, 0.5, 0.5), true)
      await bot.placeBlock(bot.blockAt(below), new Vec3(0, 1, 0))
      ok(res, { placed: name, on: round(below) })
    } catch (e) { err(res, e) }
  })

  app.get('/equip', async (req, res) => {
    try {
      // Via turns the click on the off-hand slot into a drop, and the item lands on the ground.
      if (LEGACY_1710 && String(req.query.dest) === 'off-hand') return err(res, new Error('1.7.10 has no off-hand'))
      const it = bot.inventory.items().find(i => i.name === req.query.name)
      if (!it) return err(res, new Error(`no ${req.query.name}`))
      await bot.equip(it, req.query.dest || 'hand')
      ok(res, { equipped: req.query.name })
    } catch (e) { err(res, e) }
  })

  // GET /eat?food=<name>: equips the named food, or the most filling safeFood, eats it and puts the held item back.
  // A running job equips its tool again mid-meal, which ends the meal without an error.
  app.get('/eat', async (req, res) => {
    try {
      const job = jobs.list().find(j => j.status === 'running' && !j.cancelled)
      if (job) return err(res, Object.assign(new Error(`busy: job ${job.id} ${job.name} holds the hand`), { reason: 'busy' }))
      const want = req.query.food || req.query.name   // accept both (the salmon/porkchop mystery: name= was ignored)
      const items = bot.inventory.items()
      let food = null
      if (want) food = items.find(i => i.name === want) || items.find(i => i.name.includes(want))
      if (!food) food = safeFood()
      if (!food) {
        const foods = (shared.mcData && shared.mcData.foods) || {}
        const risky = [...new Set(items.filter(i => foods[i.type]).map(i => i.name))]
        return err(res, new Error(risky.length ? `no safe food in inventory, ${risky.join(', ')} only when named in food` : 'no food in inventory'))
      }
      const prevHeld = bot.heldItem
      const before = bot.food
      const was = { food: bot.food, saturation: bot.foodSaturation }
      await bot.equip(food, 'hand')
      try {
        await bot.consume()
      } catch (e) {
        // Golden apples + chorus fruit are edible at FULL hunger in vanilla; mineflayer's
        // consume() guard refuses ("Food is full"). Hold right-click instead. (07-18: that
        // refusal blocked the emergency heal seconds before death #4.)
        if (/full/i.test(e.message) && /golden_apple|chorus_fruit/.test(food.name)) {
          bot.activateItem()
          await new Promise(r => setTimeout(r, 2100))
          try { bot.deactivateItem() } catch (e2) {}
        } else throw e
      }
      try { if (prevHeld && prevHeld.type !== food.type) await bot.equip(prevHeld, 'hand') } catch (e) {}
      const confirmed = await foodUpdate(was)
      ok(res, { ate: food.name, foodBefore: before, foodNow: bot.food, ...(confirmed ? {} : { unconfirmed: `no food update from the server within ${FOOD_UPDATE_MS} ms, foodNow may predate the meal` }) })
    } catch (e) { err(res, e) }
  })

  // dig a specific block by coordinate (no-op if already air)
  app.get('/digat', async (req, res) => {
    try {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const Vec3 = require('vec3').Vec3
      const p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
      if (!cellKnown(p) && !bodyTouches(p)) return err(res, outOfSight())
      // only WALK if out of arm's reach — a deliberately positioned pilot digs from where they stand
      // (the old unconditional goto failed on ore embedded in rock with no walkable cell within 3)
      const far = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.2
      // A cell only remembered is judged once the walk there ends.
      if (!seenNow(p) && far()) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3))
      if (!seenNow(p)) return err(res, outOfSight())
      const b = bot.blockAt(p)
      if (!b || /^(cave_|void_)?air$/.test(b.name)) return ok(res, { already: 'air', at: round(p) })
      if (far()) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3))
      // holdDigTool swallows a failed equip.
      await holdDigTool(b)
      const needTier = neededPickTier(b.name)
      const heldTier = bot.heldItem ? PICK_TIER[bot.heldItem.name] : undefined
      if (needTier > 0 && (heldTier === undefined || heldTier < needTier)) {
        return err(res, new Error(`refusing to dig ${b.name} holding ${bot.heldItem ? bot.heldItem.name : 'nothing'} — drop would be destroyed (need pick tier ${needTier})`))
      }
      const unheld = await holdHarvester(b)
      if (unheld) return err(res, new Error(unheld))
      await bot.dig(b)
      // ?then=blockat (bones_ham, 07-21): act+verify in one trip — what does the cell hold
      // now? (air = clean dig; anything else = sand/gravel fell in, water flowed, etc.)
      const verify = (req.query.then === 'blockat')
        ? (() => { const nb = bot.blockAt(p); return { name: nb ? nb.name : '?', at: round(p) } })()
        : undefined
      ok(res, { dug: b.name, at: round(p), with: bot.heldItem ? bot.heldItem.name : null, verify })
    } catch (e) { err(res, e) }
  })

  app.get('/placeitem', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
      const name = req.query.name
      const it = bot.inventory.items().find(i => i.name === name)
      if (!it) return err(res, new Error(`no ${name} in inventory`))
      const known = (p) => cellKnown(p) || bodyTouches(p)
      if (!known(new Vec3(x, y, z))) return err(res, outOfSight())
      const taken = occupant(new Vec3(x, y, z))
      if (taken) return err(res, new Error(`cell occupied by ${taken}`))
      // ref: prefer the block below (top-face place); else chain sideways off any solid
      // neighbor — courses in mid-air (roof stairs, ridge lines) grow E/W from the gable
      // ends with nothing underneath them. An interactive neighbour serves only when nothing else does.
      let ref = null
      let faceVec = null
      let interactive = null
      for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        const np = new Vec3(x + dx, y + dy, z + dz)
        const nb = seenNow(np) && bot.blockAt(np)
        if (!nb || nb.boundingBox !== 'block' || isSoftCover(nb)) continue
        if (!isInteractive(nb)) { ref = nb; faceVec = new Vec3(-dx, -dy, -dz); break }
        interactive = interactive || [nb, new Vec3(-dx, -dy, -dz)]
      }
      if (!ref && interactive) [ref, faceVec] = interactive
      if (!ref) return err(res, new Error('nothing solid I can see below or beside the target to place against'))
      await reachToPlace(new Vec3(x, y, z))
      const takenThere = occupant(new Vec3(x, y, z))
      if (takenThere) return err(res, new Error(`cell occupied by ${takenThere}`))
      await clearSoftCover(new Vec3(x, y, z))
      await bot.equip(it, 'hand')
      // face= (07-14): deliberate orientation for stairs & other facing blocks. The server derives
      // `facing` from the placer's yaw at click time (high side follows the gaze), so face=N means
      // "steps ascend toward north." We aim the body at a far compass point, then click with
      // forceLook:'ignore' so _genericPlace doesn't re-aim at the reference face and clobber it.
      const faceDir = (req.query.face || '').toUpperCase()
      let FD = faceDir ? { N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0] }[faceDir] : null
      if (faceDir && !FD) return err(res, new Error('face must be N, S, E or W'))
      // A door or gate in a fence or wall line looks across the line from the body's side.
      const axis = /(_door|_fence_gate)$/.test(name) ? passageAxis(new Vec3(x, y, z)) : null
      const feet = bot.entity.position
      if (!FD && axis) FD = axis === 'x' ? [feet.x < x + 0.5 ? 16 : -16, 0] : [0, feet.z < z + 0.5 ? 16 : -16]
      if (FD) {
        await bot.lookAt(new Vec3(x + 0.5 + FD[0], bot.entity.position.y + 1.6, z + 0.5 + FD[1]), true)
        await bot.waitForTicks(2)  // rotation PACKET goes out on the next physics tick — click too
                                   // fast and the server orients the stair by the stale rotation
                                   // (calibration row proved it: each stair wore the PREVIOUS aim)
        stampOwnEdit({ x, y, z })  // _placeBlockWithOptions bypasses the wrapped bot.placeBlock, stamp by hand
        await sneakPlace(ref, () => bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore', half: 'bottom' }))
      } else {
        await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
        await sneakPlace(ref, () => bot.placeBlock(ref, faceVec))
      }
      // The facing the server set, with the wanted axis when it is off.
      let facing
      const placedBlock = axis && bot.blockAt(new Vec3(x, y, z))
      const got = placedBlock && /(_door|_fence_gate)$/.test(placedBlock.name) ? placedBlock.getProperties().facing : null
      if (got) facing = /^(east|west)$/.test(got) === (axis === 'x') ? got : `${got}, wanted ${axis === 'x' ? 'east-west' : 'north-south'}`
      // ?then=blockat (bones_ham, 07-21): fold act+verify into one trip. Scoped fairness —
      // you may always verify the one cell you just acted on (you clicked its neighbor with
      // line of sight); this also cures the close-range /blockat blindness for self-checks.
      const verify = (req.query.then === 'blockat')
        ? (() => { const b = bot.blockAt(new Vec3(x, y, z)); return { name: b ? b.name : '?', at: { x, y, z } } })()
        : undefined
      ok(res, { placed: name, at: { x, y, z }, face: faceDir || undefined, facing, verify })
    } catch (e) {
      // then=blockat turns the notorious blockUpdate FALSE-FAIL (the block stands, the
      // event never fired) into an honest answer: the error AND what the cell holds now.
      if (req.query.then === 'blockat' && /blockUpdate/i.test(String(e && e.message))) {
        try {
          const Vec3 = require('vec3').Vec3
          const vx = Math.floor(parseFloat(req.query.x)), vy = Math.floor(parseFloat(req.query.y)), vz = Math.floor(parseFloat(req.query.z))
          const b = bot.blockAt(new Vec3(vx, vy, vz))
          return send(res, { ok: false, error: e.message, verify: { name: b ? b.name : '?', at: { x: vx, y: vy, z: vz } } })
        } catch (e2) {}
      }
      err(res, e)
    }
  })

  // /sign?x=&y=&z=&text=&face=&item= — place a sign and WRITE it, one motion (07-17, the attic
  // library: a shared world deserves labels). `text` is URL-encoded; `|` splits lines (max 4,
  // ~15 chars each). Top-face place = standing sign (face= aims it like stairs); a sideways-only
  // reference makes a wall sign naturally. A just-placed sign is editable exactly once — write
  // immediately or hold your peace.
  app.get('/sign', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
      const text = (req.query.text || '').replace(/\|/g, '\n')
      const itName = req.query.item || 'oak_sign'
      const it = bot.inventory.items().find(i => i.name === itName)
      if (!it) return err(res, new Error(`no ${itName} in inventory`))
      const known = (p) => cellKnown(p) || bodyTouches(p)
      if (!known(new Vec3(x, y, z))) return err(res, outOfSight())
      const taken = occupant(new Vec3(x, y, z))
      if (taken) return err(res, new Error(`cell occupied by ${taken}`))
      let ref = seenNow(new Vec3(x, y - 1, z)) && bot.blockAt(new Vec3(x, y - 1, z))
      let faceVec = new Vec3(0, 1, 0)
      if (!ref || ref.boundingBox !== 'block' || isSoftCover(ref)) {
        ref = null
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const np = new Vec3(x + dx, y, z + dz)
          const nb = seenNow(np) && bot.blockAt(np)
          if (nb && nb.boundingBox === 'block' && !isSoftCover(nb)) { ref = nb; faceVec = new Vec3(-dx, 0, -dz); break }
        }
        if (!ref) return err(res, new Error('nothing solid I can see below or beside the target to place against'))
      }
      const faceDir = (req.query.face || '').toUpperCase()
      const FD = faceDir && { N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0] }[faceDir]
      if (faceDir && !FD) return err(res, new Error('face must be N, S, E or W'))
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
      const takenThere = occupant(new Vec3(x, y, z))
      if (takenThere) return err(res, new Error(`cell occupied by ${takenThere}`))
      await clearSoftCover(new Vec3(x, y, z))
      await bot.equip(it, 'hand')
      // SNEAK while placing: the natural home of a label is ON a chest lid, and a bare click on
      // an interactable reference OPENS it instead of placing (the first /sign ever attempted
      // proved this on its own museum). Sneak-place works against everything; always sneak.
      bot.setControlState('sneak', true)
      try {
        if (FD) {
          // a standing sign FACES the placer, so aim OPPOSITE the wanted face before clicking
          await bot.lookAt(new Vec3(x + 0.5 - FD[0], bot.entity.position.y + 1.6, z + 0.5 - FD[1]), true)
          await bot.waitForTicks(2)
          stampOwnEdit({ x, y, z })
          await bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore' })
        } else {
          await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
          // sign placement opens the client edit GUI, which eats the blockUpdate event placeBlock
          // waits on — it throws "did not fire within timeout" on a SUCCESSFUL place. Swallow that
          // one lie; the block read below is the real verdict.
          try { await bot.placeBlock(ref, faceVec) }
          catch (e) { if (!/did not fire within timeout/.test(e.message)) throw e }
        }
      } finally { bot.setControlState('sneak', false) }
      await bot.waitForTicks(3)
      const sb = bot.blockAt(new Vec3(x, y, z))
      if (!sb || !sb.name.includes('sign')) return err(res, new Error(`placed, but found ${sb ? sb.name : 'nothing'} at the target — sign lost?`))
      await bot.updateSign(sb, text)
      ok(res, { placed: itName, at: { x, y, z }, face: faceDir || undefined, wrote: text.split('\n') })
    } catch (e) { err(res, e) }
  })

  // GET /gather?resource=&amount=&radius= : background job that repeatedly finds the
  // nearest matching block and mines it. GUARDRAILS: capped radius (default 40, hard-max
  // 64); never dig straight down (skip any target >~2 below feet, prefer at/above feet or
  // side-reachable); skip candidates pathfinder can't reach and try the next nearest;
  // stop when 'amount' collected or no reachable target remains.
  app.get('/gather', (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const resource = req.query.resource
      if (!resource) return err(res, new Error('resource required'))
      const amount = Math.max(1, parseInt(req.query.amount || '16'))
      let radius = parseInt(req.query.radius || '40')
      if (!Number.isFinite(radius) || radius <= 0) radius = 40
      radius = Math.min(radius, 64)                 // hard-max 64
      const ids = resolveBlockIds(resource)
      if (!ids.length) return err(res, new Error(`unknown block: ${resource}`))

      const { id } = jobs.start(`gather ${resource} x${amount}`, async (job) => {
        // A dig whose drop never reaches the pockets counts nothing.
        const items = gatherItems(ids)
        const pocketed = () => bot.inventory.items().reduce((s, it) => s + (items.has(it.name) ? it.count : 0), 0)
        const before = pocketed()
        let gathered = 0
        let dug = 0
        let stop = null
        const tried = new Set()                     // positions we've given up on
        const key = (p) => `${p.x},${p.y},${p.z}`
        const startT = Date.now()
        let iters = 0
        let noProgress = 0                          // consecutive iterations with no mine (circuit breaker)
        // FORESTRY: harvesting wood → walk like a lumberjack (clear leaves+logs to travel) and
        // reach the whole trunk, not just the bottom few. Restored to considerate nav in finally.
        const isWood = ids.some(i => { const n = shared.mcData.blocks[i] && shared.mcData.blocks[i].name; return !!n && (n.endsWith('_log') || n.endsWith('_wood')) })
        const maxRise = isWood ? 24 : GATHER_MAX_RISE
        const usingForestry = isWood && !!shared.forestryMoves
        // forestry pathfinding is heavier (canDig opens dig-moves at every node), so a truly
        // awkward floating log can eat the full 10s think budget before we skip it. Fail fast:
        // drop the think budget while gathering wood so unreachable targets are abandoned quickly.
        const forestry = {}
        if (usingForestry) { shared.forestryOwner = forestry; bot.pathfinder.setMovements(shared.forestryMoves); bot.pathfinder.thinkTimeout = 3000; job.progress('forestry nav: may clear leaves+logs') }
        try {
        while (gathered < amount) {
          if (job.cancelled) { stop = 'cancelled'; job.progress(stop); break }
          if (++iters > amount * 8 + 40 || Date.now() - startT > 180000) { stop = 'watchdog: stopping (iter/time bound)'; job.progress(stop); break }
          const feetY = Math.floor(bot.entity.position.y)
          // pull a batch so we can pick a SAFE candidate (not the raw nearest)
          const cands = bot.findBlocks({ matching: ids, maxDistance: radius, count: 40 })
          const here = bot.entity.position
          const ranked = cands
            .filter(p => !tried.has(key(p)))
            .map(p => ({ p, dist: here.distanceTo(p), drop: feetY - p.y }))
            // GUARDRAIL: never dig straight down. Refuse anything more than ~2 below feet
            // (a shaft); keep only targets at/above feet or reachable from the side.
            .filter(o => o.drop <= GATHER_MAX_DROP && o.drop >= -maxRise)
            .filter(o => seesLit(o.p, radius))         // FAIRNESS: only what a player here could see
            .sort((a, b) => a.dist - b.dist)
          if (!ranked.length) {
            stop = `no reachable ${resource} left (gathered ${gathered}/${amount})`
            job.progress(stop)
            break
          }
          let progressed = false
          for (const { p } of ranked) {
            const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
            if (!b || !ids.includes(b.type)) { tried.add(key(p)); continue }
            try {
              // approach from a reachable spot, then collect (dig into a face, not a shaft)
              await watchedWork(() => bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)), stopPath)
            } catch (e) {
              // GUARDRAIL: unreachable candidate -> skip, try next nearest, don't flail
              tried.add(key(p))
              job.progress(`skip unreachable @ ${p.x},${p.y},${p.z}: ${e.message}`)
              continue
            }
            try {
              await collectSafely(b, job.name, { wait: true })
              dug++
              // The slot update of a pickup can land a few ticks after the drop is gone.
              for (let i = 0; i < 10 && pocketed() - before <= gathered; i++) await bot.waitForTicks(1)
              const now = pocketed() - before
              progressed = now > gathered
              gathered = now
              job.progress(progressed ? `gathered ${resource} ${gathered}/${amount} @ ${p.x},${p.y},${p.z}` : `dug ${resource} @ ${p.x},${p.y},${p.z}, nothing picked up`)
            } catch (e) {
              tried.add(key(p))
              job.progress(`dig failed @ ${p.x},${p.y},${p.z}: ${e.message}`)
            }
            break                                   // re-scan from the new position each mine
          }
          // CIRCUIT BREAKER: one iteration tries every visible candidate, so an iteration with
          // no mine means nothing is reachable from here right now. A few of those in a row = this
          // spot is tapped out (or a target keeps timing out) → stop cleanly and let the driver
          // reposition, instead of grinding the same unreachable logs.
          if (progressed) noProgress = 0
          else if (++noProgress >= 3) {
            stop = `spot tapped out — no reachable ${resource} in ${noProgress} passes (gathered ${gathered}/${amount})`
            job.progress(stop)
            break
          }
        }
        const have = pocketed()
        emitEvent('gather', `${gathered > 0 ? 'done' : 'failed'} ${resource} gathered=${gathered}`, { inventoryMatching: have })
        const result = { gathered, dug, requested: amount, inventoryMatching: have }
        if (gathered <= 0) Object.assign(result, { ok: false, reason: dug ? `dug ${dug} ${resource}, nothing reached the pockets` : stop })
        return result
        } finally {
          // A replaced gather ends after its successor set up, and leaves the successor's setup alone.
          if (usingForestry && shared.forestryOwner === forestry) {
            shared.forestryOwner = null
            if (shared.considerateMoves) { bot.pathfinder.setMovements(shared.considerateMoves); bot.pathfinder.thinkTimeout = shared.thinkTimeout }
          }
        }
      })
      ok(res, { job: id })
    } catch (e) { err(res, e) }
  })

  // GET /dig_tunnel?dir=&length=&torch= : EXPLORE-TO-FIND mining. Drives a 1-wide x 2-high
  // corridor from where the bot stands — digs the wall directly AHEAD, steps in, repeats. This
  // is the HONEST way to mine into rock: it discovers ore by exposing it, and never routes to a
  // buried vein (no x-ray). Grabs ore laid bare in the corridor walls as it passes, lights the
  // path with torches, and STOPS on lava/water/bedrock/floor-gap/full-inventory. Fairness floor
  // intact — it only ever digs where it stands, one block at a time, seeing what a miner sees.
  app.get('/dig_tunnel', async (req, res) => {
    try {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const Vec3 = require('vec3').Vec3
      const dirParam = (req.query.dir || '').toLowerCase()
      const [dx, dz] = cardinal(dirParam, bot.entity.yaw)
      const length = Math.min(Math.max(1, parseInt(req.query.length || '12')), 64)
      const torchEvery = req.query.torch != null ? parseInt(req.query.torch) : 5   // 0 disables torches
      const perp = dx !== 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]]                 // wall offsets across the travel axis
      const dirName = cardinalName(dirParam, bot.entity.yaw)

      const { id } = jobs.start(`dig_tunnel ${dirName} x${length}`, async (job) => {
        let dug = 0, stop = null
        const found = {}
        const note = (n, p) => { found[n] = (found[n] || 0) + 1; emitEvent('mine', `struck ${n} @ ${p.x},${p.y},${p.z}`) }
        const isHazard = (b) => b && (b.name.includes('lava') || b.name.includes('water'))
        // tier-aware (07-12). A bunker build that began meanwhile ends the job before the dig that follows.
        const equipPick = async (b) => { refuseWhileBuilding(); await equipPickFor(b && b.name); refuseWhileBuilding() }

        for (let step = 0; step < length && !stop; step++) {
          if (job.cancelled) { stop = 'cancelled'; break }
          const base = bot.entity.position.floored()
          const ahead = base.offset(dx, 0, dz), aheadHead = ahead.offset(0, 1, 0), aheadFloor = ahead.offset(0, -1, 0)
          // Known lava or water that digging ahead would lay bare.
          for (const p of [ahead.offset(dx, 0, dz), aheadHead.offset(dx, 0, dz), aheadFloor, aheadHead.offset(0, 1, 0)]) {
            const hb = bot.blockAt(p); if (isHazard(hb) && knownCell(p)) { stop = `${hb.name} ahead — stopping short of it`; break }
          }
          if (stop) break
          await equipPick()
          for (const p of [aheadHead, ahead]) {                 // dig head then feet
            const b = bot.blockAt(p)
            if (!b || /^(cave_|void_)?air$/.test(b.name)) continue
            if (b.name === 'bedrock') { stop = 'hit bedrock'; break }
            if (b.name.includes('ore')) note(b.name, p)
            await equipPick(b)
            try { await bot.dig(b); dug++ } catch (e) { stop = 'dig failed: ' + e.message.slice(0, 30); break }
            stop = await struckHazard(p, false)
            if (stop) break
          }
          if (stop) break
          const fb = bot.blockAt(aheadFloor)                    // keep a solid floor so we don't fall / breach a drop
          if (!fb || fb.boundingBox !== 'block') {
            const why = await fillFrom(aheadFloor)
            if (why) { stop = `gap in floor, ${why}`; break }
            await equipPick()
          }
          if (!(await nudgeInto(ahead, false))) { stop = 'cannot advance: nudge stalled'; break }
          const here = bot.entity.position.floored()            // grab ore now exposed in the corridor walls (adjacent, fair)
          for (const [ox, oz] of perp) for (const oy of [0, 1]) {
            const wb = bot.blockAt(here.offset(ox, oy, oz))
            if (!stop && wb && wb.name.includes('ore')) { note(wb.name, here.offset(ox, oy, oz)); await equipPick(wb); try { await bot.dig(wb); dug++ } catch (e) {} stop = await struckHazard(here.offset(ox, oy, oz), false) }
          }
          if (stop) break
          if (torchEvery > 0 && step % torchEvery === 0) { await macroPlaceAt(Vec3, here.x - dx, here.y, here.z - dz, ['torch'], false); await equipPick() }
          if (bot.inventory.emptySlotCount() === 0) { stop = 'inventory full'; break }
          job.progress(`step ${step + 1}/${length}, dug ${dug}, ores ${JSON.stringify(found)}`)
        }
        const stopped = stop || 'length reached'
        emitEvent('mine', `tunnel done: dug ${dug}, stopped=${stopped}, ores=${JSON.stringify(found)}`)
        return { dug, stopped, found }
      })
      ok(res, { job: id })
    } catch (e) { err(res, e) }
  })

  // GET /dig_stair?dir=&up=&steps=&torch= : mine an ASCENDING (up=1, default) or descending (up=-1)
  // staircase — the fair way to climb out of a deep cave without swimming a water elevator. Each
  // step digs the 2-high (3 for headroom going up) passage at the next diagonal position and steps
  // onto it. STOPS on water/lava it knows of or a dig lays bare, or gravel/sand falling into the
  // passage; places a tread from andesite/cobble/dirt if the step is missing; torches the climb.
  app.get('/dig_stair', async (req, res) => {
    try {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const Vec3 = require('vec3').Vec3
      const dirParam = (req.query.dir || '').toLowerCase()
      const [dx, dz] = cardinal(dirParam, bot.entity.yaw)
      const up = parseInt(req.query.up || '1') >= 1 ? 1 : -1  // up=0 means DOWN (a pilot burned a staircase on `0 >= 0`)
      const steps = Math.min(Math.max(1, parseInt(req.query.steps || '24')), 96)
      const torchEvery = req.query.torch != null ? parseInt(req.query.torch) : 4
      const dirName = cardinalName(dirParam, bot.entity.yaw)

      const { id } = jobs.start(`dig_stair ${up > 0 ? 'up' : 'down'} ${dirName} x${steps}`, async (job) => {
        let dug = 0, stop = null, climbed = 0
        const isHazard = (b) => b && (b.name.includes('lava') || b.name.includes('water'))
        const fally = (b) => b && (b.name === 'gravel' || b.name === 'sand' || b.name === 'red_sand')
        // tier-aware (07-12). A bunker build that began meanwhile ends the job before the dig that follows.
        const equipPick = async (b) => { refuseWhileBuilding(); await equipPickFor(b && b.name); refuseWhileBuilding() }
        // (per-step movement uses the shared module-scope nudgeInto — see above the /dig_tunnel route)
        for (let s = 0; s < steps && !stop; s++) {
          if (job.cancelled) { stop = 'cancelled'; break }
          const b0 = bot.entity.position.floored()
          const nx = b0.x + dx, nz = b0.z + dz, ny = b0.y + up
          const tread = new Vec3(nx, ny - 1, nz), feet = new Vec3(nx, ny, nz), head = new Vec3(nx, ny + 1, nz), above = new Vec3(nx, ny + 2, nz)
          // ASCENDING needs LAUNCH clearance too: the climb-nudge jumps from the CURRENT cell, so the
          // block above my own head must be open or the jump hits it and the nudge stalls (the 07-11
          // "cannot climb: nudge stalled under a low ceiling" bug).
          const launch = up > 0 ? [new Vec3(b0.x, b0.y + 2, b0.z)] : []
          // Known lava, water or fall-blocks that this step would dig or lay bare.
          for (const p of [...launch, feet, head, above, new Vec3(nx + dx, ny, nz + dz), new Vec3(nx + dx, ny + 1, nz + dz)]) {
            const hb = bot.blockAt(p)
            if (!knownCell(p) && !bodyTouches(p)) continue
            if (isHazard(hb)) { stop = `${hb.name} ahead — stopping short`; break }
            if (fally(hb)) { stop = `${hb.name} overhead — stopping (would bury me)`; break }
          }
          if (stop) break
          await equipPick()
          for (const p of [...launch, above, head, feet]) {   // clear the FULL 2-tall passage + head clearance.
            // Descending needs `above` (nx,ny+2) dug too: the bot is 2 blocks tall, so stepping into
            // the next-lower cell its head sweeps through ny+2 — leave that solid and it's walled in
            // at head height and can't move in (the real cause of the old descend stall).
            const bb = bot.blockAt(p)
            if (!bb || /^(cave_|void_)?air$/.test(bb.name)) continue
            if (bb.name === 'bedrock') { stop = 'hit bedrock'; break }
            await equipPick(bb)
            try { await bot.dig(bb); dug++ } catch (e) { stop = 'dig failed: ' + e.message.slice(0, 26); break }
            stop = await struckHazard(p, true)
            if (stop) break
          }
          if (stop) break
          const tb = bot.blockAt(tread)                                      // need a tread to stand on
          if (!tb || tb.boundingBox !== 'block') {
            const why = await fillFrom(tread)
            if (why) { stop = `no step to stand on, ${why}`; break }
            await equipPick()
          }
          if (!(await nudgeInto(feet, up > 0))) { stop = (up > 0 ? 'cannot climb' : 'cannot descend') + ': nudge stalled at ' + Math.floor(bot.entity.position.y); break }
          climbed += up
          if (torchEvery > 0 && s % torchEvery === 0) { await macroPlaceAt(Vec3, b0.x, b0.y, b0.z, ['torch'], false); await equipPick() }
          if (bot.inventory.emptySlotCount() === 0) { stop = 'inventory full'; break }
          const y = Math.floor(bot.entity.position.y)
          job.progress(`step ${s + 1}/${steps}, y=${y}, dug ${dug}`)
          if (up > 0 && skyInSight()) { stop = 'sky in sight'; break }
        }
        const stopped = stop || 'steps done'
        emitEvent('mine', `dig_stair ${up > 0 ? 'up' : 'down'} done: climbed ${climbed}, dug ${dug}, y=${Math.floor(bot.entity.position.y)}, stopped=${stopped}`)
        return { climbed, dug, stopped, endY: Math.floor(bot.entity.position.y) }
      })
      ok(res, { job: id })
    } catch (e) { err(res, e) }
  })

  // GET /toss?name=&count=&to= : drop an item for a player to pick up (hand off tools/loot). Faces
  // the named player first (via ?to=) so the item lands near them, then tosses. count defaults to
  // the whole stack. This is how the bot GIVES — the co-op other half of the helmsman handing me things.
  app.get('/toss', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const name = req.query.name
      if (!name) return err(res, new Error('name required'))
      const toward = req.query.to
      const towardEntity = toward && playerEntity(toward)
      if (towardEntity && playerSighting(towardEntity, reflexes.find(r => r.name === 'combat').fairFill(bot))) {
        try { await bot.lookAt(towardEntity.position.offset(0, 0.4, 0), true) } catch (e) {}
      }
      const items = bot.inventory.items()
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return err(res, new Error(`no ${name} in inventory`))
      const n = req.query.count != null ? Math.min(parseInt(req.query.count), item.count) : item.count
      await bot.toss(item.type, null, n)
      ok(res, { tossed: item.name, count: n, toward: toward || null })
    } catch (e) { err(res, e) }
  })

  // /useon?name=<entity>&item=<item> — right-click a creature with a held item: shears on
  // sheep, bucket on cow, saddle on horse. The husbandry verb (07-14, built pen-side with the
  // first flock waiting). Walks into reach if needed; nearest matching entity in sight within 16.
  app.get('/useon', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const ename = req.query.name
      const iname = req.query.item
      const it = bot.inventory.items().find(i => i.name === iname)
      if (!it) return err(res, new Error(`no ${iname} in inventory`))
      const here = bot.entity.position
      const target = nearestSeen(ename, 16)
      if (!target) return err(res, new Error(`no ${ename} in sight within 16`))
      if (target.position.distanceTo(here) > 3) {
        await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2))
      }
      await bot.equip(it, 'hand')
      await bot.lookAt(target.position.offset(0, 0.6, 0), true)
      await bot.waitForTicks(2)
      if (!liveEntities().includes(target) || !targetSeen(target)) return ok(res, { used: null, on: ename, reason: 'lost sight', note: 'lost sight of it' })
      if (!inMeleeReach(target, 0.6)) return ok(res, { used: null, on: ename, note: 'target left reach' })
      await bot.useOn(target)
      ok(res, { used: iname, on: ename, at: round(target.position) })
    } catch (e) { err(res, e) }
  })

  app.get('/chest', async (req, res) => {
    try {
      const { cb, chests } = targetChest(req.query)
      let chest
      try {
        await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
        chest = await bot.openContainer(arrivedStation(cb.position, (b) => b.name.includes('chest'), 'chest'))
      } catch (e) {
        e.message = `cannot open the chest at ${cb.position.x},${cb.position.y},${cb.position.z}: ${e.message}; ${otherChests(cb.position, parseInt(req.query.radius || CHEST_RADIUS))}`
        throw e
      }
      const items = chest.containerItems().map(i => ({ name: i.name, count: i.count }))
      chest.close()
      const list = chests && { chests: chests.map(c => ({ at: round(c.pos), dist: Math.round(c.dist * 10) / 10 })) }
      ok(res, { at: round(cb.position), items, ...list })
    } catch (e) { err(res, e) }
  })
  app.get('/withdraw', async (req, res) => {
    try {
      const name = req.query.name
      const count = parseInt(req.query.count || '64')
      const { cb } = targetChest(req.query)
      await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
      const chest = await bot.openContainer(arrivedStation(cb.position, (b) => b.name.includes('chest'), 'chest'))
      const item = chest.containerItems().find(i => i.name === name) || chest.containerItems().find(i => i.name.includes(name))
      if (!item) { chest.close(); return err(res, new Error(`no ${name} in chest; ${otherChests(cb.position, parseInt(req.query.radius || CHEST_RADIUS))}`)) }
      const take = Math.min(count, item.count)
      try {
        await chest.withdraw(item.type, null, take)
      } finally {
        chest.close()
      }
      ok(res, { withdrew: item.name, count: take })
    } catch (e) { err(res, e) }
  })
  // GET /deposit?name=&count=: moves count (default all) of the carried items whose name contains name into the target chest and replies with their total in it.
  app.get('/deposit', async (req, res) => {
    try {
      const name = req.query.name
      if (!name) return err(res, new Error('name required'))
      const want = req.query.count != null ? parseInt(req.query.count) : Infinity
      const { cb } = targetChest(req.query)
      await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
      const chest = await bot.openContainer(arrivedStation(cb.position, (b) => b.name.includes('chest'), 'chest'))
      const matches = bot.inventory.items().filter(it => it.name === name || it.name.includes(name))
      if (!matches.length) { chest.close(); return err(res, new Error(`no ${name} in inventory`)) }
      const held = () => chest.containerItems().filter(i => i.name === name || i.name.includes(name)).reduce((s, i) => s + i.count, 0)
      const before = held()
      let remaining = want, deposited = 0
      try {
        for (const it of matches) {
          if (remaining <= 0) break
          const take = Math.min(it.count, remaining)
          await chest.deposit(it.type, null, take)
          deposited += take; remaining -= take
        }
      } catch (e) {
        const inChest = held()
        chest.close()
        const others = otherChests(cb.position, parseInt(req.query.radius || CHEST_RADIUS))
        return err(res, new Error(`deposited ${inChest - before} then failed (chest full?): ${e.message}; ${name} in chest now ${inChest}; ${others}`))
      }
      const inChest = held()
      chest.close()
      ok(res, { deposited, item: name, inChestNow: inChest })
    } catch (e) { err(res, e) }
  })

  // took counts what reached the pockets.
  app.get('/grave', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const take = req.query.take
      const gb = targetGrave(req.query)
      if (!gb) return err(res, new Error(`no gravestone in sight within ${GRAVE_SIGHT}`))
      await bot.pathfinder.goto(new goals.GoalNear(gb.position.x, gb.position.y, gb.position.z, 2))
      const grave = await bot.openBlock(gb)
      try {
        const at = round(gb.position)
        const items = () => grave.containerItems().map(i => ({ name: i.name, count: i.count }))
        if (take == null) return ok(res, { at, items: items() })
        const all = grave.containerItems()
        const exact = all.filter(i => i.name === take)
        const named = take === 'all' ? all : exact.length ? exact : all.filter(i => i.name.includes(take))
        if (!named.length) throw new Error(`no ${take} in the gravestone`)
        const took = []
        let stopped
        for (const type of new Set(named.map(i => i.type))) {
          const n = named.filter(i => i.type === type).reduce((s, i) => s + i.count, 0)
          const before = grave.count(type, null)
          try { await grave.withdraw(type, null, n) } catch (e) { stopped = e.message }
          const moved = grave.count(type, null) - before
          if (moved > 0) took.push(`${moved} ${named.find(i => i.type === type).name}`)
          if (stopped) break
        }
        if (!took.length) throw new Error(`took nothing${stopped ? `: ${stopped}` : ''}`)
        ok(res, { at, took, stopped, items: items() })
      } finally {
        grave.close()
      }
    } catch (e) { err(res, e) }
  })

  // /activate?x=&y=&z= (07-15, built to claim my bed) — generic block right-click: beds (set spawn),
  // levers, buttons, anything interactive that isn't an entity (/useon) or a door (pathfinder+manners
  // own those). LOS-gated like /blockat — I only press what I can see. Walks into reach if needed.
  // Door/gate activations still flow through the manners wrap (this calls the same wrapped function),
  // so even a manual /activate on a door gets remembered and closed behind me.
  app.get('/activate', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) return err(res, new Error('unloaded chunk'))
      if (!seesLit({ x, y, z }, 20)) return err(res, outOfSight())
      if (bot.entity.position.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) > 3.5) {
        await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2))
      }
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      await bot.waitForTicks(2)
      await bot.activateBlock(b)
      const out = { activated: b.name, at: { x, y, z } }
      // The walk into reach can leave the block out of sight.
      if (seesLit({ x, y, z }, 20)) out.properties = (bot.blockAt(new Vec3(x, y, z)) || b).getProperties()
      ok(res, out)
    } catch (e) { err(res, e) }
  })

  // GET /fish?count=&x=&y=&z= — the rod verb (07-16, first cast day). Casts the held fishing_rod;
  // mineflayer's bot.fish() reels itself when the bobber bites. Aim: the given cell must be WATER
  // I can SEE (a player casts at water in view; waitForTicks(2) respects the tick race), else cast
  // along current facing. Background job like the dig verbs; each catch is named by pocket-diff and
  // emitted — bites land ~20-30s apart, well under alarm-economy spam. A /job_stop lands between
  // casts (an in-flight cast reels itself out on its own bite; fishing holds no pathfinder to stop).
  app.get('/fish', (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const Vec3 = require('vec3').Vec3
      const count = Math.min(32, Math.max(1, parseInt(req.query.count || '1')))
      if (!bot.inventory.items().find(i => i.name === 'fishing_rod')) return err(res, new Error('no fishing_rod in inventory'))
      let aim = null
      if ([req.query.x, req.query.y, req.query.z].every(v => v !== undefined)) {
        const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
        const wb = bot.blockAt(new Vec3(x, y, z))
        if (!seesLit({ x, y, z }, 30)) return err(res, new Error('that cell is not in my sight: walk to the bank first'))
        if (!wb || !wb.name.includes('water')) return err(res, new Error(`aim cell is ${wb ? wb.name : 'unloaded'} — point me at water`))
        aim = new Vec3(x + 0.5, y + 0.9, z + 0.5)
      }
      const pockets = () => { const m = {}; for (const it of bot.inventory.items()) m[it.name] = (m[it.name] || 0) + it.count; return m }
      const { id } = jobs.start(`fish x${count}`, async (job) => {
        const rod = bot.inventory.items().find(i => i.name === 'fishing_rod')
        await bot.equip(rod, 'hand')
        if (!LEGACY_1710) await bot.waitForTicks(13)      // slot-change cooldown (the /strike lesson), which 1.7.10 lacks
        const caught = []
        for (let i = 0; i < count; i++) {
          if (job.cancelled) break
          if (aim) { await bot.lookAt(aim, true); await bot.waitForTicks(2) }
          const before = pockets()
          try { await bot.fish() } catch (e) {
            job.progress(`cast ${i + 1} failed: ${e.message}`)
            emitEvent('fish', `cast failed — ${(e.message || '').slice(0, 60)}`)
            break
          }
          await new Promise(r => setTimeout(r, 700))      // let the flying loot land in the pockets
          const after = pockets()
          const gained = Object.keys(after).filter(k => (after[k] || 0) > (before[k] || 0) && k !== 'fishing_rod')
          const what = gained.length ? gained.map(k => `${k} x${after[k] - (before[k] || 0)}`).join(', ') : 'something (pockets full? nothing landed)'
          caught.push(...gained)
          job.progress(`${i + 1}/${count}: ${what}`)
          emitEvent('fish', `caught ${what} (${i + 1}/${count})`)
        }
        return { caught }
      })
      ok(res, { job: id, casts: count, aimed: !!aim })
    } catch (e) { err(res, e) }
  })

  // GET /use?x=&y=&z=[&item=name] — the universal RIGHT-CLICK: equip item (optional) and activate it
  // on the block. Unlocks the whole interaction layer: till (hoe), sow (seeds), bone meal, fill/pour
  // bucket, open/close doors, shear sheep... For liquids (no activatable block) it aims and uses the
  // held item instead. Walks closer only if out of arm's reach (digat's lesson).
  // Replies ok false when a click that should change a cell (useTarget) left it as it was.
  app.get('/use', async (req, res) => {
    try {
      const p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
      if (![p.x, p.y, p.z].every(Number.isFinite)) return err(res, new Error('x, y, z required'))
      const b = bot.blockAt(p)
      if (!b) return err(res, new Error('block not loaded'))
      if (!seesLit(p, 6)) return err(res, outOfSight())
      if (req.query.item) {
        const it = bot.inventory.items().find(i => i.name === String(req.query.item))
        if (!it) return err(res, new Error('not carrying ' + req.query.item))
        await bot.equip(it, 'hand')
      }
      const eyeDist = bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5))
      if (eyeDist > 4.2) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2))
      await bot.lookAt(p.offset(0.5, 0.5, 0.5), true)
      // raw item-use (aim + right-click-the-item) for: liquids (fill), AIR targets (pour into a hole —
      // activateBlock on solids does NOT pour, learned live 07-12), or explicit ?raw=1
      // Crops, saplings and grass have no collision box but take the click themselves (bone meal).
      // On 1.7.10 a bucket used through activateBlock on grass, a flower or a torch pours nothing.
      const bucket = !!bot.heldItem && bot.heldItem.name.endsWith('bucket')
      const rawUse = bucket || b.name.includes('water') || b.name.includes('lava') || /^(cave_|void_)?air$/.test(b.name) || req.query.raw === '1'
      const target = useTarget(b, p, bot.heldItem ? bot.heldItem.name : null)
      const was = target && bot.blockAt(target)
      await withBlockUpdate(target || p, 500, async () => {
        if (rawUse) {
          bot.activateItem()
          await new Promise(r => setTimeout(r, 300))
          try { bot.deactivateItem() } catch (e) {}
        } else {
          await bot.activateBlock(b)
        }
      })
      const out = { used: bot.heldItem ? bot.heldItem.name : 'empty hand', on: b.name, at: round(p) }
      // The walk into reach can leave the block out of sight.
      if (seenNow(p)) out.now = (bot.blockAt(p) || {}).name
      const after = target && bot.blockAt(target)
      if (was && after && after.stateId === was.stateId && seenNow(target)) {
        Object.assign(out, { ok: false, reason: `nothing changed at ${target.x},${target.y},${target.z}, still ${was.name}` })
      }
      ok(res, out)
    } catch (e) { err(res, e) }
  })

  // ---- MACROS: high-level verbs with guardrails baked in, run ASYNC via jobs.start ----

  // GET /enchant?item=&slot= : walk to the nearest enchanting table and enchant. The pilot's
  // query→act→verify grammar in one verb: WITHOUT slot it puts the item + lapis in, reads the
  // three offers (level cost, lapis cost, enchant name when resolvable), takes everything back
  // out, and reports — the LOOK. WITH slot=0|1|2 it commits that offer (consumes 1-3 lapis and
  // 1-3 of MY levels; needs my level ≥ the shown cost). Lapis must be in my pockets — the table
  // window keeps nothing between opens. (Forged 07-20, the day the body learned to enchant.)
  app.get('/enchant', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const itemName = req.query.item
      const slot = req.query.slot === undefined ? null : parseInt(req.query.slot)
      if (!itemName) return err(res, new Error('item required'))
      const tb = nearestKnown(resolveBlockIds('enchanting_table'), 16)
      if (!tb) return err(res, new Error('no enchanting table seen within 16'))
      await bot.pathfinder.goto(new goals.GoalNear(tb.position.x, tb.position.y, tb.position.z, 2))
      const item = bot.inventory.items().find(i => i.name === itemName)
      if (!item) return err(res, new Error(`no ${itemName} in pockets`))
      const lapis = bot.inventory.items().find(i => i.name === 'lapis_lazuli')
      if (!lapis) return err(res, new Error('no lapis_lazuli in pockets — the table burns 1-3 per enchant'))
      const table = await bot.openEnchantmentTable(arrivedStation(tb.position, (b) => b.name === 'enchanting_table', 'enchanting table'))
      try {
        // find both WITHIN the open window — slot ids remap once a window opens, so the
        // bot.inventory handles located above would point moveSlotItem at the wrong cells
        const wItem = table.slots.find(s => s && s.name === itemName && s.slot >= 2)
        const wLapis = table.slots.find(s => s && s.name === 'lapis_lazuli' && s.slot >= 2)
        if (!wItem) throw new Error(`${itemName} not visible in the table window`)
        if (!wLapis) throw new Error('lapis not visible in the table window')
        await table.putTargetItem(wItem)
        await table.putLapis(wLapis)
        // 1.21 quirk: the plugin's 'ready' event NEVER fires (it compares "expected" property
        // packets against "actual" ones modern servers no longer send) — poll the offers array
        // directly instead; the data itself arrives fine.
        const offersUp = () => (table.enchantments || []).some(e => e.level > 0)
        const offerDeadline = Date.now() + 6000
        while (!offersUp() && Date.now() < offerDeadline) await new Promise(r => setTimeout(r, 250))
        if (!offersUp()) throw new Error('offers never arrived')
        const enchName = (id) => {
          const e = (shared.mcData.enchantmentsArray || []).find(x => x.id === id)
          return e ? e.name : (id === -1 ? '?' : `#${id}`)
        }
        const offers = (table.enchantments || []).map((e, i) => (
          { slot: i, levelCost: e.level, lapisCost: i + 1, enchant: enchName(e.expected ? e.expected.enchant : -1) }))
        const myLevel = bot.experience.level
        if (slot === null) {
          emitEvent('enchant', `offers for ${itemName}: ${offers.map(o => `#${o.slot} lv${o.levelCost} ${o.enchant}`).join(' | ')} (me: lv${myLevel})`)
          ok(res, { offers, myLevel, lapisHeld: lapis.count, note: 'call again with slot=0|1|2 to commit' })
        } else {
          const chosen = offers[slot]
          if (!chosen || chosen.levelCost < 0) throw new Error(`slot ${slot} holds no offer`)
          if (myLevel < chosen.levelCost) throw new Error(`offer needs level ${chosen.levelCost}, I am ${myLevel}`)
          if (lapis.count < chosen.lapisCost) throw new Error(`offer needs ${chosen.lapisCost} lapis, I hold ${lapis.count}`)
          // commit with a direct packet — table.enchant() awaits the same dead 'ready' event
          bot._client.write('enchant_item', { windowId: table.id, enchantment: slot })
          await new Promise(r => setTimeout(r, 1000))   // let the server apply + resync slot 0
          const result = table.slots[0]
          emitEvent('enchant', `${itemName} enchanted: ${chosen.enchant} (slot ${slot}, lv${chosen.levelCost}) — now lv${bot.experience.level}`)
          ok(res, { enchanted: itemName, offer: chosen, myLevelNow: bot.experience.level, resultNbt: !!(result && result.nbt) })
        }
      } finally {
        try { if (table.targetItem()) await table.takeTargetItem() } catch (e) {}
        try { const l = table.slots[1]; if (l) await bot.putAway(l.slot) } catch (e) {}
        try { table.close() } catch (e) {}
      }
    } catch (e) { err(res, e) }
  })

  // GET /rename?item=&name= : walk to the nearest anvil and christen an item. Costs 1 of MY
  // levels (the anvil's rename fee) and wears the anvil a step; name caps at 35 chars. The
  // mineflayer plugin streams the name a character at a time like a vanilla client typing.
  // (Forged 07-21, the day the blades got names — Occam was first.)
  app.get('/rename', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const itemName = req.query.item
      const newName = req.query.name
      if (!itemName || !newName) return err(res, new Error('item and name required'))
      // exact-match resolve skips the damaged variants — an anvil is an anvil, gather all three
      const anvilIds = ['anvil', 'chipped_anvil', 'damaged_anvil'].flatMap(n => resolveBlockIds(n))
      const ab = nearestKnown(anvilIds, 16)
      if (!ab) return err(res, new Error('no anvil seen within 16'))
      await bot.pathfinder.goto(new goals.GoalNear(ab.position.x, ab.position.y, ab.position.z, 2))
      const item = bot.inventory.items().find(i => i.name === itemName)
      if (!item) return err(res, new Error(`no ${itemName} in pockets`))
      const anvil = await bot.openAnvil(arrivedStation(ab.position, (b) => /anvil$/.test(b.name), 'anvil'))
      try {
        await anvil.rename(item, newName)
        emitEvent('rename', `${itemName} christened "${newName}" — now lv${bot.experience.level}`)
        ok(res, { renamed: itemName, name: newName, myLevelNow: bot.experience.level })
      } finally {
        try { anvil.close() } catch (e) {}
      }
    } catch (e) { err(res, e) }
  })

  // GET /smelt?item=&fuel=&count= : loads the nearest furnace and returns without waiting for the burn.
  app.get('/smelt', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const inputName = req.query.item
      const fuelName = req.query.fuel || 'coal'
      const want = Math.max(1, parseInt(req.query.count || '1'))
      if (!inputName) return err(res, new Error('item required'))
      if (burnItems(fuelName) == null) return err(res, new Error(`no known burn time for ${fuelName}`))
      const fb = targetFurnace({})
      await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
      const furnace = await bot.openFurnace(arrivedStation(fb.position, (b) => b.name === 'furnace', 'furnace'))
      try {
        // The flame bar arrives after the window.
        await bot.waitForTicks(2)
        const step = (what) => console.log(`[smelt] ${what} ${JSON.stringify(furnaceSlots(furnace))}`)
        step('opened')
        const pocketCount = (name) => furnace.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0)
        const inItem = furnace.items().find(i => i.name === inputName)
        if (!inItem) throw new Error(`no ${inputName} to smelt`)
        const curIn = furnace.inputItem()
        if (curIn && curIn.name !== inputName) throw new Error(`the furnace is busy with ${curIn.count} ${curIn.name}`)
        const n = Math.min(want, pocketCount(inputName), inItem.stackSize - (curIn ? curIn.count : 0))
        if (n < 1) throw new Error(`the furnace input is full with ${curIn.count} ${curIn.name}`)
        const fuelIn = furnace.fuelItem()
        if (!fuelIn && !pocketCount(fuelName)) throw new Error(`no ${fuelName} for fuel`)
        // A fuel slot holding another item is used as it is.
        const per = burnItems(fuelIn ? fuelIn.name : fuelName)
        if (per == null) throw new Error(`no known burn time for the ${fuelIn.count} ${fuelIn.name} in the fuel slot`)
        // The flame shows the share of one fuel item left to burn, taken as the fuel in use.
        const burning = (furnace.fuel || 0) * per
        let took, note
        const out = furnace.outputItem()
        if (out && out.name === smeltYield(inputName) && pocketRoom(furnace, out) >= out.count) {
          await takeSlot(furnace, out, out.count)
          took = `${out.count} ${out.name}`
          step('took output')
        } else if (out) {
          note = `left ${out.count} ${out.name} in the output`
        }
        await furnace.putInput(inItem.type, null, n)
        step('loaded input')
        const total = (curIn ? curIn.count : 0) + n
        const pocketFuel = furnace.items().find(i => i.name === fuelName)
        if (pocketFuel && (!fuelIn || fuelIn.name === fuelName)) {
          const held = fuelIn ? fuelIn.count : 0
          const add = Math.min(pocketCount(fuelName), Math.ceil((total - burning) / per) - held, pocketFuel.stackSize - held)
          if (add > 0) {
            await furnace.putFuel(pocketFuel.type, null, add)
            step('loaded fuel')
          }
        }
        // A stall behind an occupied output says nothing about the recipe.
        if (!furnace.outputItem() && !await furnaceCooks(furnace)) {
          const back = furnace.inputItem()
          const held = back.count
          const moved = Math.min(held, pocketRoom(furnace, back))
          await takeSlot(furnace, back, moved)
          step('no recipe')
          const fuelLeft = furnace.fuelItem()
          const left = [held > moved && `${held - moved} ${inputName} in the input`, fuelLeft && `the ${fuelLeft.count} ${fuelLeft.name} in the fuel slot`].filter(Boolean)
          throw Object.assign(new Error(`this server does not smelt ${inputName}: took ${moved} ${inputName} back${left.length ? `, left ${left.join(' and ')}` : ''}`), { reason: 'no-recipe' })
        }
        const fuelNow = furnace.fuelItem()
        const covers = Math.round((burning + (fuelNow ? fuelNow.count * per : 0)) * 100) / 100
        // A furnace smelts one item every 10 s.
        ok(res, { at: round(fb.position), loaded: n, ...furnaceSlots(furnace), took, note,
          doneInSec: Math.round(Math.min(total, covers) * 10), fuelFor: covers < total ? covers : undefined })
      } finally {
        furnace.close()
      }
    } catch (e) { err(res, e) }
  })

  // GET /furnace?at=&take=&count= : lists a furnace's slots, or takes one slot into the pockets.
  app.get('/furnace', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const take = req.query.take
      if (take != null && !['input', 'fuel', 'output'].includes(take)) return err(res, new Error('take is input, fuel or output'))
      const fb = targetFurnace(req.query)
      await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
      const furnace = await bot.openFurnace(arrivedStation(fb.position, (b) => b.name === 'furnace', 'furnace'))
      try {
        if (take == null) {
          // mineflayer reads a bar as 0 until a value arrives after its total.
          await bot.waitForTicks(2)
          const share = (v) => typeof v === 'number' ? Math.round(v * 100) / 100 : undefined
          return ok(res, { at: round(fb.position), ...furnaceSlots(furnace), progress: share(furnace.progress), fuelLeft: share(furnace.fuel) })
        }
        const item = { input: furnace.inputItem(), fuel: furnace.fuelItem(), output: furnace.outputItem() }[take]
        if (!item) throw new Error(`the ${take} slot is empty`)
        // The output slot accepts no items back.
        const n = take === 'output' ? item.count : Math.min(parseInt(req.query.count || item.count), item.count)
        if (pocketRoom(furnace, item) < n) throw new Error(`no room in your pockets for ${n} ${item.name}`)
        await takeSlot(furnace, item, n)
        console.log(`[furnace] took ${n} ${item.name} ${JSON.stringify(furnaceSlots(furnace))}`)
        ok(res, { at: round(fb.position), took: `${n} ${item.name}`, ...furnaceSlots(furnace) })
      } finally {
        furnace.close()
      }
    } catch (e) { err(res, e) }
  })
}

function createWorkingRoutes (ctx) {
  Object.assign(ctx, { installWorkingRoutes })
}

function bindWorkingRoutes (ctx) {
  ({ bot, liveEntities, entityPerceptible, routeEnd, stagedGoto, round, cellKnown, xyz, shared, resolveBlockIds, nearestKnown, arrivedStation, NEIGHBOURS, bodyTouches, seesLit, fillFrom, err, collectLock, collectBusy, nearestVisible, collectSafely, ok, bunker, BUNKER_WALK, claimLane, walkRoute, namedStop, releaseLane, resolveItem, placeSpot, clearSoftCover, jobs, safeFood, foodUpdate, FOOD_UPDATE_MS, outOfSight, seenNow, holdDigTool, neededPickTier, PICK_TIER, holdHarvester, occupant, isSoftCover, isInteractive, reachToPlace, passageAxis, stampOwnEdit, sneakPlace, send, watchedWork, stopPath, emitEvent, refuseWhileBuilding, equipPickFor, knownCell, nudgeInto, macroPlaceAt, playerEntity, playerSighting, reflexes, nearestSeen, targetSeen, inMeleeReach, knownBlocks, rememberedStation, skyInSight, cardinal, cardinalName } = ctx)
}

module.exports = { createWorkingRoutes, bindWorkingRoutes }
