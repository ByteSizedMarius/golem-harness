'use strict'

// Cell checks and placement for the last-resort bunker, the "down" shaft and the "up" pillar shell.

const { Vec3 } = require('vec3')
const { entityInCell, SHELTER } = require('../shelter')

let bot, refuseWhileBuilding, isSoftCover, clearSoftCover, pickFor, knownCell, bodyTouches, liveEntities

// Equips item and jump-places it on below, the block under the feet, in up to three tries. True once
// the body stands a block higher. own marks the bunker build's call, the only one a build lets through.
async function jumpPlace (below, item, own = false) {
  const yBefore = Math.floor(bot.entity.position.y)
  refuseWhileBuilding(own)
  await bot.equip(item, 'hand')
  await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
  const cell = below.position.offset(0, 1, 0)
  for (let attempt = 0; attempt < 3; attempt++) {
    refuseWhileBuilding(own)
    bot.setControlState('jump', true)
    await new Promise(r => setTimeout(r, 180))                       // near jump apex
    // A block never goes into a cell the body still overlaps.
    for (let i = 0; i < 3 && entityInCell(cell, [bot.entity]); i++) await bot.waitForTicks(1)
    refuseWhileBuilding(own)
    if (!entityInCell(cell, [bot.entity, ...blockers()])) {
      try { await bot.placeBlock(below, new Vec3(0, 1, 0)) } catch (e) {}
    }
    // A build that began during the place owns the jump control.
    refuseWhileBuilding(own)
    bot.setControlState('jump', false)
    await new Promise(r => setTimeout(r, 400))                       // settle
    if (Math.floor(bot.entity.position.y) > yBefore) return true
  }
  return false
}

// The bunker height when none is asked for.
const BUNKER_HEIGHT = 3
const BUNKER_MAX_HEIGHT = 6
// The health below which the bunker reflex fires, and the health at which it re-arms.
const BUNKER_HP = 8
const BUNKER_REARM_HP = 12
// Natural ground, the only blocks "down" digs.
const BUNKER_GROUND = /^(grass_block|dirt|coarse_dirt|podzol|mycelium|stone|granite|diorite|andesite|deepslate|tuff|sand|red_sand|gravel|sandstone|red_sandstone|netherrack|soul_sand|soul_soil|end_stone)$/
// The longest dig per cell "down" accepts, with the pick it digs with.
const BUNKER_DIG_MS = 1500
// Filler, most expendable first. Planks of any wood come after these.
const BUNKER_FILL = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'stone', 'sandstone', 'end_stone', 'stone_bricks', 'bricks']
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// The neighbours a placement may click, the one below first.
const NEIGHBOURS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
const solidAt = (p) => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' && !isSoftCover(b) }
const xyz = (v) => ({ x: v.x, y: v.y, z: v.z })

function fillers () {
  const items = bot.inventory.items()
  return [...BUNKER_FILL.flatMap(n => items.filter(i => i.name === n)), ...items.filter(i => i.name.endsWith('_planks'))]
}

// 'placed', 'solid' when the cell already was, or null when nothing was placed.
async function placeFiller (cell, item = fillers()[0]) {
  if (solidAt(cell)) return 'solid'
  const ref = item && NEIGHBOURS.map(([dx, dy, dz]) => cell.offset(dx, dy, dz)).find(solidAt)
  if (!ref) return null
  await clearSoftCover(cell)
  if (!bot.heldItem || bot.heldItem.name !== item.name) await bot.equip(item, 'hand')
  if (entityInCell(cell, blockers())) return null
  try { await bot.placeBlock(bot.blockAt(ref), cell.minus(ref)) } catch (e) {}
  return solidAt(cell) ? 'placed' : null
}

// Sneaks the body to the middle of cell and returns true once within 0.2 of it, enough to fit a one-wide shaft.
async function centerOnCell (cell = bot.entity.position.floored()) {
  const mid = cell.offset(0.5, 0, 0.5)
  const off = () => Math.max(Math.abs(bot.entity.position.x - mid.x), Math.abs(bot.entity.position.z - mid.z))
  if (off() > 0.2) {
    const ticks = 30 * Math.ceil(off())
    try {
      await bot.lookAt(new Vec3(mid.x, bot.entity.position.y + 1.62, mid.z), true)
      bot.setControlState('sneak', true)
      bot.setControlState('forward', true)
      for (let i = 0; i < ticks && off() > 0.1; i++) await bot.waitForTicks(1)
    } finally {
      bot.setControlState('forward', false)
      bot.setControlState('sneak', false)
    }
    await bot.waitForTicks(2)
  }
  return off() <= 0.2
}

// The ms the body takes to dig b with the pick it would equip.
function digMs (b) {
  const pick = pickFor(b.name)
  return b.digTime(pick ? pick.type : null, false, false, false, [], bot.entity.effects)
}

// Why "down" cannot dig in where the body stands, or null.
function digInProblem () {
  if (!bot.entity.onGround) return 'not standing on the ground'
  const o = bot.entity.position.floored()
  // Water or lava beside the body runs down the shaft once it is open.
  for (const dy of [0, 1]) {
    for (const [dx, dz] of SIDES) {
      const side = bot.blockAt(o.offset(dx, dy, dz))
      if (!side || /water|lava/.test(side.name)) return `${side ? side.name : 'an unloaded block'} beside the body`
    }
  }
  // Unknown cells are left to digIn, which judges each one once the body stands on it.
  const known = (p) => knownCell(p) || bodyTouches(p)
  for (let dy = -1; dy >= -3; dy--) {
    const p = o.offset(0, dy, 0)
    const b = bot.blockAt(p)
    if (known(p) && !BUNKER_GROUND.test(b.name)) return `${b.name} ${-dy} below is not natural ground`
    if (known(p) && digMs(b) > BUNKER_DIG_MS) return `${b.name} ${-dy} below digs too slowly`
    for (const [dx, dz] of SIDES) {
      const side = bot.blockAt(o.offset(dx, dy, dz))
      if (!side) return 'unloaded ground beside the shaft'
      if (!known(side.position)) continue
      if (/water|lava/.test(side.name)) return `${side.name} beside the shaft`
      if (dy < -1 && !solidAt(side.position)) return `an opening beside the shaft ${-dy} below`
    }
  }
  const floor = o.offset(0, -4, 0)
  if (known(floor) && !solidAt(floor)) return 'no solid floor 4 below'
  if (!SIDES.some(([dx, dz]) => known(o.offset(dx, -1, dz)) && solidAt(o.offset(dx, -1, dz)))) return 'nothing beside the shaft to hold a cap'
  if (!fillers().length) return 'no blocks for the cap'
  return null
}

// Why "up" cannot pillar height blocks where the body stands, or null.
function pillarProblem (height) {
  const o = bot.entity.position.floored()
  if (!solidAt(o.offset(0, -1, 0))) return 'no solid footing'
  for (let dy = 2; dy <= height + 2; dy++) {
    const b = bot.blockAt(o.offset(0, dy, 0))
    if (!b || (b.boundingBox !== 'empty' && !isSoftCover(b))) return `no headroom ${dy} above the feet`
  }
  // A mob on a ledge beside the column, standing up to one block over the head of the body on top, is nearer it.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      for (let dy = 0; dy <= height + 1; dy++) {
        if (solidAt(o.offset(dx, dy, dz)) && !solidAt(o.offset(dx, dy + 1, dz))) return 'a step beside the pillar'
      }
    }
  }
  const blocks = fillers().reduce((n, i) => n + i.count, 0)
  if (blocks < height) return `${blocks} blocks carried, the pillar takes ${height}`
  return null
}

const PILLAR_SCAN_UP = 16
// The bunker's pillar height { height, safe, why }, safe clearing the highest seen standable ground within 3 blocks.
function pillarHeight (minHeight) {
  const o = bot.entity.position.floored()
  const clear = (p) => { const b = bot.blockAt(p); return !!b && b.boundingBox === 'empty' }
  let top = 0
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if ((!dx && !dz) || Math.hypot(dx, dz) > 3) continue
      for (let dy = PILLAR_SCAN_UP; dy > top; dy--) {
        const feet = o.offset(dx, dy, dz)
        const floor = feet.offset(0, -1, 0)
        if (solidAt(floor) && clear(feet) && clear(feet.offset(0, 1, 0)) && knownCell(floor) && knownCell(feet)) { top = dy; break }
      }
    }
  }
  const safe = top + SHELTER.SAFE_HEIGHT
  const ground = top ? `seen ground ${top} above the feet within 3 blocks` : 'no seen ground above the feet within 3 blocks'
  return { height: Math.max(minHeight, safe), safe, why: `${ground}, out of reach from ${safe} up` }
}

// Why no bunker can start where the body stands, or null: water or lava in its feet or head cell,
// which a shell would hold the body in.
function liquidProblem () {
  const p = bot.entity.position
  for (const c of [p.floored(), p.offset(0, 1.6, 0).floored()]) {
    const b = bot.blockAt(c)
    if (b && (/^(water|lava|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(b.name) || b.isWaterlogged)) return `the body stands in ${b.isWaterlogged ? 'waterlogged ' : ''}${b.name}`
  }
  return null
}

// The entities whose box keeps a block out of its cell.
function blockers () {
  const living = ['mob', 'hostile', 'animal', 'passive', 'ambient', 'living', 'player']
  return liveEntities().filter(e => living.includes(e.type))
}

function createBunkerCells (ctx) {
  Object.assign(ctx, { jumpPlace, BUNKER_HEIGHT, BUNKER_MAX_HEIGHT, BUNKER_HP, BUNKER_REARM_HP, BUNKER_GROUND, BUNKER_DIG_MS, BUNKER_FILL, SIDES, NEIGHBOURS, solidAt, xyz, fillers, placeFiller, centerOnCell, digMs, digInProblem, pillarProblem, PILLAR_SCAN_UP, pillarHeight, liquidProblem, blockers })
}

function bindBunkerCells (ctx) {
  ({ bot, refuseWhileBuilding, isSoftCover, clearSoftCover, pickFor, knownCell, bodyTouches, liveEntities } = ctx)
}

module.exports = { createBunkerCells, bindBunkerCells }
