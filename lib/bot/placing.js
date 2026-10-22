'use strict'

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { entityInCell } = require('../shelter')
const { summarizePlan, DROP_MAX } = require('../plan')

let bot, refuseWhileBuilding, walkGaveUp, cellKnown, cellText, seenNow, fillers, walkRoute, planPath, routeEnd, knownCell, refuseWhileFighting

// The longest planned walk placeitem takes to a cell out of reach.
const PLACE_WALK_MAX = 16

// ---- SOFT COVER (07-20, a 4.6 pilot's field report): thin snow and soft plants read as
// "occupied" to naive cell checks — layer snow's boundingBox even lies ('block') — but the
// game treats them as replaceable, and snowfall RE-COVERS half-built courses in cold biomes,
// so a snowy plain bricked every build verb with "cell occupied by snow" / silent skips.
// Doctrine: never treat soft cover as an obstacle OR as a reference face; break it (instant
// with any tool) so placement lands in honest air.
const SOFT_COVER = new Set(['snow', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush'])
const isSoftCover = (b) => !!b && SOFT_COVER.has(b.name)
async function clearSoftCover (p) {
  const b = bot.blockAt(p)
  if (isSoftCover(b)) { try { await bot.dig(b) } catch (e) {} }
  return bot.blockAt(p)
}

async function macroPlaceAt(x, y, z, names, walk = true) {
  const target = new Vec3(x, y, z)
  const tb = bot.blockAt(target)
  if (tb && tb.boundingBox === 'block' && !isSoftCover(tb)) return { done: true, skipped: true }
  let ref = null, face = null
  const below = bot.blockAt(new Vec3(x, y - 1, z))
  if (below && below.boundingBox === 'block' && !isSoftCover(below)) { ref = below; face = new Vec3(0, 1, 0) }
  else {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nb = bot.blockAt(new Vec3(x + dx, y, z + dz))
      if (nb && nb.boundingBox === 'block' && !isSoftCover(nb)) { ref = nb; face = new Vec3(-dx, 0, -dz); break }
    }
  }
  if (!ref) return { done: false }
  const nameList = Array.isArray(names) ? names : [names]
  let it = null
  for (const n of nameList) { it = bot.inventory.items().find(m => m.name === n); if (it) break }
  if (!it) return { done: false, noItem: true }
  try {
    if (walk) await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
    refuseWhileBuilding()
    await clearSoftCover(target)
    refuseWhileBuilding()
    await bot.equip(it, 'hand')
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
    refuseWhileBuilding()
    await bot.placeBlock(ref, face)
    return { done: true, placed: true }
  } catch (e) { return Object.assign({ done: false, error: e.message }, walkGaveUp(e)) }
}

// The cell beside the feet that a block placed on the ground below fills: air or soft cover over a
// solid block, clear of the body, or null.
function placeSpot () {
  const base = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const spot = base.offset(dx, 0, dz)
    const spotBlock = bot.blockAt(spot)
    const belowBlock = bot.blockAt(spot.offset(0, -1, 0))
    if (!spotBlock || !(spotBlock.name === 'air' || isSoftCover(spotBlock))) continue
    if (!belowBlock || belowBlock.boundingBox !== 'block' || isSoftCover(belowBlock)) continue
    if (entityInCell(spot, [bot.entity])) continue
    return spot
  }
  return null
}

// Walks within reach of cell, refusing a long walk, a deep drop on the way, a body that overlaps cell and a fight.
async function reachToPlace (cell) {
  const goal = new goals.GoalNear(cell.x, cell.y, cell.z, 3)
  const at = `${cell.x},${cell.y},${cell.z}`
  if (!goal.isEnd(bot.entity.position.floored())) {
    const route = walkRoute()
    let plan
    try {
      const planned = await planPath(goal, route)
      if (!planned) throw new Error(`refusing to walk to place at ${at}: the walk ended (${routeEnd(route)})`)
      if (planned.status !== 'success') throw new Error(`refusing to walk to place at ${at}: no known way there (${planned.status})`)
      plan =summarizePlan(bot.entity.position, planned, knownCell)
    } finally { route.end() }
    if (plan.length > PLACE_WALK_MAX) throw new Error(`refusing to walk ${plan.length} blocks to place at ${at}: goto closer first`)
    if (plan.drop > DROP_MAX) throw new Error(`refusing to walk to place at ${at}: the way drops ${plan.drop} blocks at once`)
  }
  await bot.pathfinder.goto(goal)
  if (entityInCell(cell, [bot.entity])) throw new Error(`refusing to place into ${cell.x},${cell.y},${cell.z}: my body overlaps that cell, step out of it first`)
  refuseWhileFighting()
}

// True for a block that a click opens or toggles. Iron doors and trapdoors take redstone only.
function isInteractive (b) {
  return !!b && !/^iron_/.test(b.name) &&
    /(^|_)(chest|barrel|furnace|smoker|crafting_table|crafter|door|trapdoor|fence_gate|lever|button|bed|anvil|enchanting_table|brewing_stand|hopper|dispenser|dropper|beacon|note_block|jukebox|repeater|comparator|daylight_detector|cake|shulker_box|loom|stonecutter|grindstone|cartography_table|smithing_table|lectern|bell|sign|flower_pot)$/.test(b.name)
}

async function sneakPlace (ref, place) {
  if (!isInteractive(ref)) return place()
  bot.setControlState('sneak', true)
  try {
    await bot.waitForTicks(1)
    return await place()
  } catch (e) {
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
    const what = cellKnown(ref.position) ? `the ${ref.name} at ${cellText(ref.position)}` : 'the block it went against'
    throw new Error(`did not place while sneaking against ${what} (${e.message})`)
  } finally { bot.setControlState('sneak', false) }
}

// The axis a door or gate at cell passes along, 'x' or 'z', when solid neighbours seen now form a line on the other axis.
function passageAxis (cell) {
  const solid = (dx, dz) => {
    const p = cell.offset(dx, 0, dz)
    const b = seenNow(p) && bot.blockAt(p)
    return !!b && b.boundingBox === 'block' && !isSoftCover(b)
  }
  const lineZ = solid(0, -1) || solid(0, 1)
  const lineX = solid(1, 0) || solid(-1, 0)
  return lineZ === lineX ? null : lineZ ? 'x' : 'z'
}

// The name of the block keeping a placement out of cell p, when the bot sees p now.
function occupant (p) {
  const b = bot.blockAt(p)
  return b && b.name !== 'air' && b.boundingBox !== 'empty' && !isSoftCover(b) && seenNow(p) ? b.name : null
}

// Fills cell with a carried filler block from where the body stands. Null once it is solid, else why not.
async function fillFrom (cell) {
  const r = await macroPlaceAt(cell.x, cell.y, cell.z, fillers().map(i => i.name), false)
  if (r.done) return null
  if (r.noItem) return 'no filler blocks carried'
  return r.error ? `the block did not place (${r.error})` : 'nothing solid beside it to place against'
}

function createPlacing (ctx) {
  Object.assign(ctx, { isSoftCover, clearSoftCover, macroPlaceAt, placeSpot, reachToPlace, isInteractive, sneakPlace, passageAxis, occupant, fillFrom })
}

function bindPlacing (ctx) {
  ({ bot, refuseWhileBuilding, walkGaveUp, cellKnown, cellText, seenNow, fillers, walkRoute, planPath, routeEnd, knownCell, refuseWhileFighting } = ctx)
}

module.exports = { createPlacing, bindPlacing }
