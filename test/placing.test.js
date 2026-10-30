'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const shelter = require('../lib/shelter')
const { overrideRecipes } = require('../lib/server-overrides')
const { deathLedger } = require('../lib/deaths')
const { summarizePlan, DROP_MAX } = require('../lib/plan')
const { goals } = require('mineflayer-pathfinder')
const { loadBotFunctions, fakeClock, botConstant, awaitRoute, hookedRoute, routeHandler, buildVerbEnv, groundMemory, claimRescue, routeJobs } = require('./helpers')

const AIR = { name: 'air', boundingBox: 'empty' }
const STONE = { name: 'stone', boundingBox: 'block' }
const key = (p) => `${p.x},${p.y},${p.z}`
const body = (x, y, z) => ({ position: new Vec3(x, y, z), width: 0.6, height: 1.8 })

// Floor at y 63, air above, plus the blocks in extra by cell.
const ground = (extra = {}) => (p) => ({ ...(extra[key(p)] || (p.y <= 63 ? STONE : AIR)), position: p })

function placingEnv (entity, blockAt, over = {}) {
  return {
    bot: {
      entity,
      entities: {},
      blockAt,
      inventory: { items: () => over.items || [] },
      async equip (item) { this.heldItem = item },
      async lookAt () {},
      async dig () {},
      ...over.bot
    },
    Vec3,
    entityInCell: shelter.entityInCell,
    isSoftCover: (b) => !!b && b.name === 'snow',
    bunker: { building: false },
    BUNKER_WALK: botConstant('BUNKER_WALK'),
    ...over.env
  }
}

test('place picks a cell beside the feet that the body does not overlap', () => {
  const centred = loadBotFunctions(['placeSpot'], placingEnv(body(0.5, 64, 0.5), ground()))
  assert.deepStrictEqual(key(centred.placeSpot()), '1,64,0', 'control: a centred body leaves the +x cell free')
  // Standing at x 0.8, the body reaches into the +x cell.
  const leaning = loadBotFunctions(['placeSpot'], placingEnv(body(0.8, 64, 0.5), ground()))
  assert.deepStrictEqual(key(leaning.placeSpot()), '-1,64,0')
  const boxed = ground({ '-1,64,0': STONE, '0,64,1': STONE, '0,64,-1': STONE })
  assert.strictEqual(loadBotFunctions(['placeSpot'], placingEnv(body(0.8, 64, 0.5), boxed)).placeSpot(), null, 'the only open cell holds part of the body')
})

test('place names the cell it placed in and the block under it', async () => {
  const clicks = []
  const env = placingEnv(body(0.5, 64, 0.5), ground(), {
    items: [{ name: 'crafting_table', count: 1 }],
    bot: { async placeBlock (ref, face) { clicks.push(key(ref.position.plus(face))) } },
    env: { require, clearSoftCover: async () => {}, round: botConstant('round') }
  })
  assert.deepStrictEqual(await awaitRoute('/place', { name: 'crafting_table' }, env), {
    placed: 'crafting_table', at: { x: 1, y: 64, z: 0 }, on: { x: 1, y: 63, z: 0 }
  })
  assert.deepStrictEqual(clicks, ['1,64,0'])
})

test('place refuses busy while the buried self-rescue holds the hand, and equips and places nothing', async () => {
  const done = []
  const digLock = botConstant('digLock')
  claimRescue(digLock)
  const env = placingEnv(body(0.5, 64, 0.5), ground(), {
    items: [{ name: 'crafting_table', count: 1 }],
    bot: {
      heldItem: { name: 'iron_shovel' },
      async equip (item) { done.push(`equip ${item.name}`); this.heldItem = item },
      async placeBlock (ref, face) { done.push(`place ${key(ref.position.plus(face))}`) }
    },
    env: { require, clearSoftCover: async () => {}, round: botConstant('round'), digLock }
  })
  const { handle, res } = routeHandler('/place', env)
  await handle({ query: { name: 'crafting_table' } }, res)
  assert.strictEqual(res.error && res.error.message, 'busy: the buried self-rescue is running, nothing placed')
  assert.strictEqual(res.error.reason, 'busy')
  assert.deepStrictEqual(done, [])
  assert.strictEqual(env.bot.heldItem.name, 'iron_shovel')
})

// reachToPlace from a body at (0.5, 64, 0.5) over the floor, every cell known. planPath answers a successful search
// along the cell centres in path (answering status instead when given), or null with the route ended for ended.
// With fighting the combat reflex is busy. log records plans, route ends and walks.
function reacher ({ path = [], ended = null, status = 'success', fighting = false } = {}) {
  const log = []
  const env = placingEnv(body(0.5, 64, 0.5), ground(), {
    bot: { pathfinder: { goto: async (g) => { log.push(`walk ${g.x},${g.y},${g.z} within ${Math.sqrt(g.rangeSq)}`) } } },
    env: {
      goals,
      walkRoute: () => ({ end () { log.push('end') } }),
      planPath: async (g) => {
        log.push(`plan ${g.x},${g.y},${g.z}`)
        return path && { status, path: path.map(([x, y, z]) => new Vec3(x + 0.5, y, z + 0.5)) }
      },
      routeEnd: () => ended,
      knownCell: () => true,
      summarizePlan,
      DROP_MAX,
      PLACE_WALK_MAX: botConstant('PLACE_WALK_MAX'),
      reflexes: [{ name: 'combat', fightBusy: () => fighting, _threat: null }]
    }
  })
  return { log, reachToPlace: loadBotFunctions(['reachToPlace'], env).reachToPlace }
}

// The cells from x 1 to x on y 64, z 0.
const lane = (x) => Array.from({ length: x }, (_, i) => [i + 1, 64, 0])

test('placeitem walks to a cell in reach without planning', async () => {
  const near = reacher()
  await near.reachToPlace(new Vec3(1, 64, 0))
  assert.deepStrictEqual(near.log, ['walk 1,64,0 within 3'])
})

test('placeitem walks a short plan to a cell out of reach, its route ended before the walk', async () => {
  const short = reacher({ path: lane(9) })
  await short.reachToPlace(new Vec3(10, 64, 0))
  assert.deepStrictEqual(short.log, ['plan 10,64,0', 'end', 'walk 10,64,0 within 3'])
})

test('placeitem refuses after its walk while the combat reflex is busy', async () => {
  const fight = reacher({ path: lane(9), fighting: true })
  await assert.rejects(fight.reachToPlace(new Vec3(10, 64, 0)), { message: /^refused: fighting something, the guard reflex holds the hand\./, reason: 'fighting' })
  assert.deepStrictEqual(fight.log, ['plan 10,64,0', 'end', 'walk 10,64,0 within 3'])
})

test('placeitem refuses a planned walk longer than 16 blocks', async () => {
  const far = reacher({ path: lane(19) })
  await assert.rejects(far.reachToPlace(new Vec3(20, 64, 0)), { message: 'refusing to walk 19 blocks to place at 20,64,0: goto closer first' })
  assert.deepStrictEqual(far.log, ['plan 20,64,0', 'end'])
})

test('placeitem refuses a planned walk that drops more than 3 blocks at once', async () => {
  const three = reacher({ path: [[1, 64, 0], [2, 64, 0], [3, 61, 0], [4, 61, 0]] })
  await three.reachToPlace(new Vec3(6, 61, 0))
  assert.strictEqual(three.log.at(-1), 'walk 6,61,0 within 3', 'control: a drop of 3 walks')
  const four = reacher({ path: [[1, 64, 0], [2, 64, 0], [3, 60, 0], [4, 60, 0]] })
  await assert.rejects(four.reachToPlace(new Vec3(6, 60, 0)), { message: 'refusing to walk to place at 6,60,0: the way drops 4 blocks at once' })
  assert.deepStrictEqual(four.log, ['plan 6,60,0', 'end'])
})

test('placeitem refuses a walk whose route ended while it planned, naming why', async () => {
  const taken = reacher({ path: null, ended: 'stopped' })
  await assert.rejects(taken.reachToPlace(new Vec3(10, 64, 0)), { message: 'refusing to walk to place at 10,64,0: the walk ended (stopped)' })
  assert.deepStrictEqual(taken.log, ['plan 10,64,0', 'end'])
})

test('placeitem refuses a failed plan, however short its path, and walks a successful one', async () => {
  const noPath = reacher({ path: [], status: 'noPath' })
  await assert.rejects(noPath.reachToPlace(new Vec3(10, 64, 0)), { message: 'refusing to walk to place at 10,64,0: no known way there (noPath)' })
  assert.deepStrictEqual(noPath.log, ['plan 10,64,0', 'end'])
  const timeout = reacher({ path: lane(5), status: 'timeout' })
  await assert.rejects(timeout.reachToPlace(new Vec3(10, 64, 0)), { message: 'refusing to walk to place at 10,64,0: no known way there (timeout)' })
  assert.deepStrictEqual(timeout.log, ['plan 10,64,0', 'end'])
  const found = reacher({ path: lane(9), status: 'success' })
  await found.reachToPlace(new Vec3(10, 64, 0))
  assert.deepStrictEqual(found.log, ['plan 10,64,0', 'end', 'walk 10,64,0 within 3'])
})

test('placeitem refuses a cell the body overlaps after its walk, the head cell included', async () => {
  const { reachToPlace } = reacher()
  for (const cell of [new Vec3(0, 64, 0), new Vec3(0, 65, 0)]) {
    await assert.rejects(reachToPlace(cell), /my body overlaps that cell/, key(cell))
  }
})

// craftItem over a body at (0.5, 64, 0.5) carrying a crafting table, with a placed table at tableAt or none,
// unseen when seen is false. A 3x3 recipe needs the table, a 2x2 one does not. goto puts the body 2.5 short of its goal in x,
// or finds no path when unreachable is true.
function crafter ({ tableAt = null, needsTable = true, seen = true, unreachable = false } = {}) {
  const entity = body(0.5, 64, 0.5)
  const log = []
  const recipe = { result: { count: needsTable ? 1 : 4 } }
  const placed = tableAt ? { [key(tableAt)]: { name: 'crafting_table', boundingBox: 'block' } } : {}
  const env = placingEnv(entity, ground(placed), {
    items: [{ name: 'crafting_table', count: 1 }],
    bot: {
      recipesFor: (id, meta, min, t) => (t || !needsTable ? [recipe] : []),
      findBlocks: ({ maxDistance }) => (tableAt && tableAt.distanceTo(entity.position) <= maxDistance ? [tableAt] : []),
      pathfinder: { goto: async (g) => { log.push(['goto', g.x, g.y, g.z, g.r]); if (unreachable) throw new Error('No path to the goal!'); entity.position = new Vec3(g.x - 2.5, g.y, g.z + 0.5) } },
      async craft (r, n, t) { log.push(['craft', t ? key(t.position) : null]) },
      async placeBlock () { log.push(['placeBlock']) },
      async equip (item) { log.push(['equip', item.name]) }
    },
    env: {
      resolveBlockIds: () => [58],
      goals: { GoalNear: function (x, y, z, r) { Object.assign(this, { x, y, z, r }) } },
      SERVER_RECIPES: null,
      overrideRecipes,
      shared: { mcData: { itemsByName: {} } },
      cellKnown: (p) => seen || !tableAt || !p.equals(tableAt),
      seenNow: (p) => seen || !tableAt || !p.equals(tableAt),
      STATIONS: new Map(),
      LEGACY_1710: false
    }
  })
  return { log, ctx: loadBotFunctions(['craftItem'], env) }
}

const NO_TABLE = 'no crafting table seen within 16, place one (place or placeitem) and craft again'

test('craft with no table within 16 refuses a 3x3 recipe and places nothing', async () => {
  const { log, ctx } = crafter()
  await assert.rejects(ctx.craftItem({ id: 1, name: 'chest' }, 1), { message: NO_TABLE })
  assert.deepStrictEqual(log, [])
})

test('craft treats an unseen crafting table as none, without walking to it or naming it', async () => {
  const hidden = crafter({ tableAt: new Vec3(10, 64, 0), seen: false })
  await assert.rejects(hidden.ctx.craftItem({ id: 1, name: 'chest' }, 1), { message: NO_TABLE })
  assert.deepStrictEqual(hidden.log, [])
  const grid = crafter({ tableAt: new Vec3(10, 64, 0), seen: false, needsTable: false })
  await grid.ctx.craftItem({ id: 2, name: 'oak_planks' }, 4)
  assert.deepStrictEqual(grid.log, [['craft', null]], 'a 2x2 recipe used the unseen table')
})

test('craft walks to a table 10 blocks off and crafts at it', async () => {
  const { log, ctx } = crafter({ tableAt: new Vec3(10, 64, 0) })
  const r = await ctx.craftItem({ id: 1, name: 'chest' }, 1)
  assert.deepStrictEqual(log, [['goto', 10, 64, 0, 3], ['craft', '10,64,0']])
  assert.deepStrictEqual({ ...r }, { crafted: 'chest', requested: 1, made: 1, usedTable: true, nowHave: 0, note: undefined })
})

test('craft names a seen table it cannot reach', async () => {
  const { log, ctx } = crafter({ tableAt: new Vec3(10, 64, 0), unreachable: true })
  await assert.rejects(ctx.craftItem({ id: 1, name: 'chest' }, 1), { message: 'cannot reach the crafting table at 10,64,0' })
  assert.deepStrictEqual(log, [['goto', 10, 64, 0, 3]])
})

test('craft makes a 2x2 recipe in the inventory grid with no table about', async () => {
  const { log, ctx } = crafter({ needsTable: false })
  const r = await ctx.craftItem({ id: 2, name: 'oak_planks' }, 4)
  assert.deepStrictEqual(log, [['craft', null]])
  assert.deepStrictEqual([r.made, r.usedTable], [4, false])
})

// jumpPlace on the floor block under a body at (0.5, 64, 0.5). rise(y) gives the feet y after a tick.
function jumper (rise) {
  const entity = body(0.5, 64, 0.5)
  const places = []
  const env = placingEnv(entity, ground(), {
    bot: {
      setControlState () {},
      async waitForTicks () { entity.position = new Vec3(0.5, rise(entity.position.y), 0.5) },
      async placeBlock () { places.push(entity.position.y) }
    },
    env: { setTimeout, clearTimeout, blockers: () => [], guardState: { hand: null } }
  })
  return { ctx: loadBotFunctions(['jumpPlace'], env), places, below: { position: new Vec3(0, 63, 0) } }
}

test('a pillar block goes under the body only once the body has risen clear of the cell', async () => {
  const clears = jumper((y) => y + 0.4)
  await clears.ctx.jumpPlace(clears.below, { name: 'dirt' })
  assert.strictEqual(clears.places.length, 1, 'control: the block went down once the body rose')
  assert.ok(clears.places[0] >= 65, `placed with the feet at ${clears.places[0]}, inside the cell`)

  const stuck = jumper((y) => y)
  assert.strictEqual(await stuck.ctx.jumpPlace(stuck.below, { name: 'dirt' }), false)
  assert.deepStrictEqual(stuck.places, [], 'a block went into the cell the body stands in')
})

test('a pilot pillar holds the hand from the equip to the click of every try, and a sword swapped in between goes back out', async () => {
  const entity = body(0.5, 64, 0.5)
  const dirt = { name: 'dirt' }
  const guardState = { hand: null }
  const log = []
  let ticks = 0
  const env = placingEnv(entity, ground(), {
    bot: {
      async equip (item) { this.heldItem = item; log.push(`equip ${item.name} leased=${!!guardState.hand}`) },
      // The first try stays in the cell, and the combat reflex swaps the sword in once the hand is free.
      setControlState (c, on) { if (c === 'jump' && !on && !guardState.hand) env.bot.heldItem = { name: 'iron_sword' } },
      async waitForTicks () { if (++ticks > 3) entity.position = new Vec3(0.5, 65.4, 0.5) },
      async placeBlock () { log.push(`click ${env.bot.heldItem.name} leased=${!!guardState.hand}`) }
    },
    env: { setTimeout, clearTimeout, blockers: () => [], guardState }
  })
  const { jumpPlace } = loadBotFunctions(['jumpPlace'], env)
  assert.strictEqual(await jumpPlace({ position: new Vec3(0, 63, 0) }, dirt), true)
  assert.deepStrictEqual(log, ['equip dirt leased=true', 'equip dirt leased=true', 'click dirt leased=true'])
  assert.strictEqual(guardState.hand, null, 'the lease outlived the placement')
})

// The hand lease of a buried self-rescue holding the sole claim on digLock, set in guardState. ended records its end.
function rescueLease (digLock, guardState) {
  claimRescue(digLock)
  const lease = { ended: false, end () { lease.ended = true }, renew: () => true }
  guardState.hand = lease
  return lease
}

test('a pilot pillar refuses busy while the buried self-rescue holds the hand, and leaves its lease and shovel alone', async () => {
  const guardState = { hand: null }
  const digLock = botConstant('digLock')
  const rescue = rescueLease(digLock, guardState)
  const log = []
  const env = placingEnv(body(0.5, 64, 0.5), ground(), {
    bot: {
      heldItem: { name: 'iron_shovel' },
      async equip (item) { this.heldItem = item; log.push(`equip ${item.name}`) },
      setControlState (c, on) { log.push(`${c} ${on}`) },
      async waitForTicks () {},
      async placeBlock () { log.push('click') }
    },
    env: { setTimeout, clearTimeout, blockers: () => [], guardState, digLock }
  })
  const { jumpPlace } = loadBotFunctions(['jumpPlace'], env)
  await assert.rejects(jumpPlace({ position: new Vec3(0, 63, 0) }, { name: 'dirt' }), { message: 'busy: the buried self-rescue is running, nothing done', reason: 'busy' })
  assert.deepStrictEqual(log, [])
  assert.strictEqual(env.bot.heldItem.name, 'iron_shovel')
  assert.strictEqual(guardState.hand, rescue)
  assert.strictEqual(rescue.ended, false)
})

test('a dig step fills from any filler carried, cobbled deepslate included', async () => {
  const equipped = []
  const env = placingEnv(body(0.5, 64, 0.5), ground(), {
    items: [{ name: 'cobbled_deepslate', count: 12 }, { name: 'torch', count: 8 }],
    bot: { async equip (item) { equipped.push(item.name) }, async placeBlock () {} },
    env: { BUNKER_FILL: botConstant('BUNKER_FILL'), goals: {} }
  })
  const { fillFrom } = loadBotFunctions(['fillFrom'], env)
  assert.strictEqual(await fillFrom(new Vec3(1, 64, 0)), null)
  assert.deepStrictEqual(equipped, ['cobbled_deepslate'])
})

test('a dig step that cannot be filled says why', async () => {
  const run = async (over, cell) => loadBotFunctions(['fillFrom'], placingEnv(body(0.5, 64, 0.5), ground(), {
    ...over, env: { BUNKER_FILL: botConstant('BUNKER_FILL'), goals: {} }
  })).fillFrom(cell)
  assert.strictEqual(await run({ items: [{ name: 'torch', count: 8 }] }, new Vec3(1, 64, 0)), 'no filler blocks carried')
  assert.strictEqual(await run({ items: [{ name: 'dirt', count: 8 }], bot: { async placeBlock () { throw new Error('timeout') } } }, new Vec3(1, 64, 0)), 'the block did not place (timeout)')
  assert.strictEqual(await run({ items: [{ name: 'dirt', count: 8 }] }, new Vec3(1, 70, 0)), 'nothing solid beside it to place against')
})

// A 3x3 ring of walls at x 1..3, z -1..1, one row high at y 64, doorway at 1,64,0. All seven cells lie in reach.
const RING = { x: '1', z: '-1', w: '3', d: '3', h: '1', base: '64' }

// A body at (0.5, 64, 0.5) on the floor, carrying items. afterPlace(n, bot) runs after the n-th placing.
function wallsRig ({ items = [{ name: 'cobblestone', count: 64 }], extra = {}, afterPlace = () => {}, env = {} } = {}) {
  const log = []
  const stock = items.map((i) => ({ ...i }))
  const bot = Object.assign(new EventEmitter(), {
    entity: body(0.5, 64, 0.5),
    entities: {},
    blockAt: ground(extra),
    inventory: { items: () => stock.filter((i) => i.count > 0) },
    pathfinder: { goto: async () => { log.push('goto') } },
    async equip (item) { log.push(`equip ${item.name}`); this.heldItem = item },
    async lookAt () {},
    async dig () {},
    async placeBlock (ref, face) {
      this.heldItem.count--
      log.push(`place ${key(ref.position.plus(face))}`)
      afterPlace(log.filter((l) => l.startsWith('place')).length, bot)
    }
  })
  const placed = () => log.filter((l) => l.startsWith('place')).map((l) => l.slice(6))
  return { bot, log, placed, env: buildVerbEnv(bot, env) }
}

test('walls lists the cell its pockets ran out on, with the blocks it looked for', async () => {
  const rig = wallsRig({ items: [{ name: 'cobblestone', count: 6 }] })
  assert.deepStrictEqual(await awaitRoute('/walls', RING, rig.env), {
    placed: 6, skipped: 0, failed: 1, failures: ['3,64,1: no cobblestone or oak_planks in pockets'], size: '3x3', height: 1, door: 'west'
  })
  assert.strictEqual(rig.bot.listenerCount('death'), 0, 'the run left its death listener behind')
})

test('roof without a name reports the oak_planks it looked for', async () => {
  const rig = wallsRig()
  assert.deepStrictEqual(await awaitRoute('/roof', { x: '1', z: '0', w: '1', d: '1', y: '64' }, rig.env), {
    placed: 0, skipped: 0, failed: 1, failures: ['1,64,0: no oak_planks in pockets'], size: '1x1', y: 64
  })
})

test('walls refuses a block name the registry lacks before anything moves, and takes a server alias', async () => {
  const items = [{ name: 'oak_planks', count: 64 }]
  const alias = { SERVER_OVERRIDES: { items: new Map([['planks', 'oak_planks']]) } }
  const named = wallsRig({ items, env: alias })
  await awaitRoute('/walls', { ...RING, name: 'planks', base_name: 'planks' }, named.env)
  assert.ok(named.log.includes('equip oak_planks'), 'control: the alias builds')

  const misspelt = wallsRig({ items, env: alias })
  const { handle, res } = routeHandler('/walls', misspelt.env)
  await handle({ query: { ...RING, name: 'oak_plankz', base_name: 'planks' } }, res)
  assert.strictEqual(res.error && res.error.message, 'unknown block: oak_plankz')
  assert.deepStrictEqual(misspelt.log, [])
})

test('walls leaves a door in its line standing and names it, and a hidden one only as unknown', async () => {
  const door = { '3,64,0': { name: 'oak_door', boundingBox: 'block' } }
  const seen = wallsRig({ extra: door })
  const r = await awaitRoute('/walls', RING, seen.env)
  assert.deepStrictEqual([r.placed, r.failures], [6, ['3,64,0: door']])
  assert.ok(!seen.placed().includes('3,64,0'))

  const hidden = wallsRig({ extra: door, env: { cellKnown: (p) => key(p) !== '3,64,0' } })
  const h = await awaitRoute('/walls', RING, hidden.env)
  assert.deepStrictEqual([h.placed, h.failures], [6, ['3,64,0: cell not known to the bot']])
})

// Every cell known, and all but the one at k seen now.
const unseenNow = (k) => ({ seenNow: (p) => key(p) !== k })

test('walls answers a remembered cell out of sight the same whether a door stands in it now', async () => {
  const door = wallsRig({ extra: { '3,64,0': { name: 'oak_door', boundingBox: 'block' } }, env: unseenNow('3,64,0') })
  const empty = wallsRig({ env: unseenNow('3,64,0') })
  assert.deepStrictEqual(await awaitRoute('/walls', RING, door.env), await awaitRoute('/walls', RING, empty.env))
})

test('a build block goes against no remembered face out of sight, whatever holds that cell now', () => {
  const verdict = (extra) => loadBotFunctions(['supportFace'], wallsRig({ extra, env: unseenNow('2,63,0') }).env).supportFace(new Vec3(2, 64, 0))
  assert.strictEqual(verdict({}), 'no line of sight to a face')
  assert.strictEqual(verdict({ '2,63,0': AIR }), 'no line of sight to a face')
})

test('outline builds on no remembered ground out of sight, whatever holds that cell now', async () => {
  for (const extra of [{}, { '2,63,0': AIR }]) {
    const rig = wallsRig({ extra, env: unseenNow('2,63,0') })
    const r = await awaitRoute('/outline', { x: '2', z: '0', w: '1', d: '1', y: '64' }, rig.env)
    assert.deepStrictEqual([r.placed, r.failures], [0, ['2,64,0: cell not known to the bot']], extra['2,63,0'] ? 'dug out' : 'stone')
    assert.deepStrictEqual(rig.placed(), [])
  }
})

test('a death mid-build ends walls with the reason, what it placed and the death message', async () => {
  const deaths = deathLedger()
  const die = (bot) => {
    deaths.heard('Claude was slain by Zombie')
    deaths.died('DIED near (0,64,0)')
    bot.emit('death')
  }
  const rig = wallsRig({ afterPlace: (n, bot) => { if (n === 3) die(bot) } })
  assert.deepStrictEqual(await hookedRoute('/walls', RING, rig.env, deaths), {
    died: 'Claude was slain by Zombie', ok: true, placed: 3, skipped: 0, failed: 0, stopped: 'the body died', size: '3x3', height: 1, door: 'west'
  })
  assert.strictEqual(rig.placed().length, 3)
})

// A 3x3 cabin two rows high at x 1..3, z -1..1 on base 64, its doorway at 1,64,0 and 1,65,0.
const CABIN = { x: '1', z: '-1', w: '3', d: '3', h: '2', base: '64' }

// The /build job of CABIN with stone in the doorway, onDoorWalk(world, job) running at each door-phase walk.
async function buildCabin (onDoorWalk = () => {}) {
  const log = []
  const world = {}
  for (const y of [64, 65]) {
    const stone = Block.fromStateId(registry.blocksByName.stone.defaultState, 0)
    stone.position = new Vec3(1, y, 0)
    world[`1,${y},0`] = stone
  }
  const items = [{ name: 'cobblestone', count: 64 }, { name: 'stone_pickaxe', count: 1 }]
  let phase = null
  let job = null
  let result = null
  const bot = Object.assign(new EventEmitter(), {
    entity: body(0.5, 64, 0.5),
    entities: {},
    heldItem: items[0],
    blockAt: (p) => world[key(p)] || { ...(p.y <= 63 ? STONE : AIR), position: p },
    inventory: { items: () => items },
    pathfinder: { goto: async () => { log.push(`walk in ${phase}`); if (phase === 'door') onDoorWalk(world, job) } },
    async equip (item) { this.heldItem = item },
    async lookAt () {},
    async placeBlock () {},
    async dig (b) { log.push(`dig ${key(b.position)} with ${this.heldItem && this.heldItem.name}`) }
  })
  const env = buildVerbEnv(bot, {
    emitEvent () {},
    PICK_TIER: botConstant('PICK_TIER'),
    DIG_TOOL: botConstant('DIG_TOOL'),
    jobs: {
      start: (name, fn) => {
        job = { cancelled: false, progress (msg) { phase = msg.replace('phase: ', '') } }
        result = fn(job)
        return { id: 1 }
      }
    }
  })
  await awaitRoute('/build', CABIN, env)
  return { reply: await result, log }
}

const digs = (log) => log.filter((l) => l.startsWith('dig'))

test('build digs its doorway with the tool for the block', async () => {
  const { log } = await buildCabin()
  assert.deepStrictEqual(digs(log), ['dig 1,64,0 with stone_pickaxe', 'dig 1,65,0 with stone_pickaxe'])
})

test('build leaves a doorway cell that holds a door once its walk there ends', async () => {
  const door = (world) => {
    for (const y of [64, 65]) world[`1,${y},0`] = { name: 'oak_door', boundingBox: 'block', position: new Vec3(1, y, 0) }
  }
  const { log } = await buildCabin(door)
  assert.ok(log.includes('walk in door'), 'control: the door phase walked')
  assert.deepStrictEqual(digs(log), [])
})

test('build digs no doorway cell once the pilot took over during its walk there', async () => {
  const { reply, log } = await buildCabin((world, job) => { job.cancelled = true })
  assert.ok(log.includes('walk in door'), 'control: the door phase walked')
  assert.deepStrictEqual(digs(log), [])
  assert.strictEqual(reply.stopped, 'stopped by the pilot')
})

test('build answers not ready before it reads the body position', async () => {
  const { handle, res } = routeHandler('/build', buildVerbEnv({ entity: null }, { shared: { ready: false } }))
  await handle({ query: { x: '1', z: '-1' } }, res)
  assert.strictEqual(res.error && res.error.message, 'not ready')
})

test('build during the buried self-rescue answers busy naming it and starts no job', async () => {
  const env = buildVerbEnv({ entity: body(0.5, 64, 0.5) })
  assert.deepStrictEqual((await routeJobs('/build', CABIN, env)).started, ['build cabin 3x3h2 @1,-1'], 'control: no rescue')
  claimRescue(env.digLock)
  const r = await routeJobs('/build', CABIN, env)
  assert.deepStrictEqual([r.error && r.error.reason, r.started], ['busy', []])
  assert.strictEqual(r.error.message, 'busy: the buried self-rescue is running, nothing built')
})

test('outline, walls and roof refuse busy while the buried self-rescue holds the dig lock, before any walk, equip or place', async () => {
  const cell = { x: '2', z: '0', w: '1', d: '1', y: '64', name: 'cobblestone' }
  for (const [route, query] of [['/outline', cell], ['/walls', RING], ['/roof', cell]]) {
    const control = wallsRig()
    await awaitRoute(route, query, control.env)
    assert.ok(control.placed().length, `${route} control: placed nothing`)
    const rig = wallsRig()
    claimRescue(rig.env.digLock)
    const { handle, res } = routeHandler(route, rig.env)
    await handle({ query }, res)
    assert.strictEqual(res.error && res.error.message, 'busy: the buried self-rescue is running, nothing built', route)
    assert.strictEqual(res.error.reason, 'busy', route)
    assert.deepStrictEqual(rig.log, [], route)
  }
})

test('a buried self-rescue starting during a cell walk or its soft cover dig stops outline, walls and roof before the equip, and leaves its lease and shovel alone', async () => {
  const snow = { name: 'snow', boundingBox: 'empty' }
  const cases = [
    ['/roof', { x: '8', z: '0', w: '1', d: '1', y: '64', name: 'cobblestone' }, 'walk', {}],
    ['/outline', { x: '2', z: '0', w: '1', d: '1', y: '64', name: 'cobblestone' }, 'dig', { '2,64,0': snow }],
    ['/walls', RING, 'dig', { '1,64,-1': snow }],
    ['/roof', { x: '2', z: '0', w: '1', d: '1', y: '64', name: 'cobblestone' }, 'dig', { '2,64,0': snow }]
  ]
  for (const [route, query, during, extra] of cases) {
    const guardState = { hand: null }
    const rig = wallsRig({ extra, env: { isSoftCover: (b) => !!b && b.name === 'snow' } })
    const { holdHand, endHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState, digLock: rig.env.digLock, setTimeout, clearTimeout })
    let rescue = null
    // As digOutHead does: the sole claim, the legs, then the hand with the shovel in it.
    const startRescue = () => {
      claimRescue(rig.env.digLock)
      rig.env.legs.take('buried self-rescue', 'free a head buried in a block')
      rescue = holdHand(rig.env.digLock.holder)
      rig.bot.heldItem = { name: 'iron_shovel' }
    }
    if (during === 'walk') rig.bot.pathfinder.goto = async () => { rig.bot.entity.position = new Vec3(8.5, 64, 2.5); startRescue() }
    else rig.bot.dig = async () => { startRescue(); throw new Error('Digging aborted') }
    try {
      const reply = await awaitRoute(route, query, rig.env)
      const where = `${route} during the ${during}`
      assert.strictEqual(reply.stopped, 'the buried self-rescue reflex took the legs to free a head buried in a block', where)
      assert.deepStrictEqual([reply.placed, reply.failed], [0, 0], where)
      assert.deepStrictEqual(rig.log.filter((l) => !l.startsWith('goto')), [], where)
      assert.strictEqual(rig.bot.heldItem.name, 'iron_shovel', where)
      assert.strictEqual(guardState.hand, rescue, where)
    } finally { endHand(rescue) }
  }
})

// placeitem by a body at (-1.5, 64, 0.5) carrying name over the floor plus extra, blind to the cells in hidden,
// remembering the cells in unseen without seeing them now, on 1.7.10 when legacy is true.
// A click leaves placedAs (default a block of name) in the target, or with refused times out on the block update.
// With path the body stands at (-19.5, 64, 0.5) and its walk plans along the cell centres in path.
// With spawn, a _genericPlace click spawns spawnAs (default name) with that objectData in the cell off the clicked face, or at spawnAt ([x, y, z]).
// With spawnNext, a second spawn with that objectData follows the first in the same emit.
// It arrives on the next immediate. With spawnWhen 'look' it arrives
// at spawnAt during every look instead. A function spawnWhen runs at the click, and the spawn arrives when it calls its emit.
// A _genericPlace without forceLook 'ignore' looks at the face centre first, as mineflayer's does.
// log records looks, sneaks and places, clicks each clicked face as 'x,y,z face dx,dy,dz'.
// looks records each look in full as {x, y, z, force}, lookAtClick the last of them at each _genericPlace click.
function placeitemRig (name, { extra = {}, placedAs = null, hidden = [], unseen = [], legacy = false, refused = false, path = null, spawn = null, spawnNext = null, spawnAt = null, spawnAs = name, spawnWhen = 'after' } = {}) {
  const log = []
  const clicks = []
  const looks = []
  const lookAtClick = []
  const world = { ...extra }
  const client = new EventEmitter()
  const emitSpawn = ([x, y, z]) => {
    for (const objectData of spawnNext === null ? [spawn] : [spawn, spawnNext]) client.emit('spawn_entity', { entityId: 77, type: registry.entitiesByName[spawnAs].id, x, y, z, objectData })
  }
  let sneaking = false
  const place = (ref, face) => {
    log.push(`place against ${ref.name} sneaking=${sneaking}`)
    clicks.push(`${key(ref.position)} face ${key(face)}`)
    if (refused) throw new Error(`Event blockUpdate:${ref.position.plus(face)} did not fire within timeout of 5000ms`)
    world[key(ref.position.plus(face))] = placedAs || { name, boundingBox: 'block' }
  }
  const walk = path && {
    walkRoute: () => ({ end () {} }),
    planPath: async () => ({ status: 'success', path: path.map(([x, y, z]) => new Vec3(x + 0.5, y, z + 0.5)) }),
    routeEnd: () => null,
    knownCell: () => true,
    summarizePlan,
    DROP_MAX,
    PLACE_WALK_MAX: botConstant('PLACE_WALK_MAX')
  }
  const env = placingEnv(path ? body(-19.5, 64, 0.5) : body(-1.5, 64, 0.5), ground(world), {
    items: [{ name, count: 1 }],
    bot: {
      pathfinder: { goto: async () => {} },
      async lookAt (p, force) {
        log.push(`look ${p.x},${p.z}`)
        looks.push({ x: p.x, y: p.y, z: p.z, force })
        if (spawn !== null && spawnWhen === 'look') emitSpawn(spawnAt)
      },
      async waitForTicks () {},
      setControlState (c, on) { if (c === 'sneak') { sneaking = on; log.push(`sneak ${on}`) } },
      async placeBlock (ref, face) { place(ref, face) },
      async _placeBlockWithOptions (ref, face) { place(ref, face) },
      registry,
      _client: client,
      async _genericPlace (ref, face, { forceLook } = {}) {
        if (forceLook !== 'ignore') await this.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5))
        log.push(`place against ${ref.name} sneaking=${sneaking}`)
        clicks.push(`${key(ref.position)} face ${key(face)}`)
        lookAtClick.push(looks.at(-1))
        if (spawn === null || spawnWhen === 'look') return
        const at = spawnAt || ref.position.plus(face).toArray()
        if (typeof spawnWhen === 'function') spawnWhen(() => emitSpawn(at))
        else setImmediate(() => emitSpawn(at))
      }
    },
    env: {
      require,
      goals,
      LEGACY_1710: legacy,
      cellKnown: (p) => !hidden.includes(key(p)),
      seenNow: (p) => !hidden.includes(key(p)) && !unseen.includes(key(p)),
      clearSoftCover: async () => {},
      stampOwnEdit () {},
      send: (res, body) => { res.sent = body },
      reflexes: [],
      guardState: { hand: null },
      setTimeout,
      clearTimeout,
      setImmediate,
      HANGS: botConstant('HANGS'),
      BEHIND: botConstant('BEHIND'),
      ...walk
    }
  })
  return { log, clicks, looks, lookAtClick, env }
}

const FENCE_NS = { '1,64,-1': { name: 'oak_fence', boundingBox: 'block' }, '1,64,1': { name: 'oak_fence', boundingBox: 'block' } }
const gate = (facing) => ({ name: 'oak_fence_gate', boundingBox: 'block', getProperties: () => ({ facing }) })

test('a gate placed into a north-south fence line looks east before placing, and a wrong facing from the server is named', async () => {
  const at = { x: '1', y: '64', z: '0', name: 'oak_fence_gate' }
  const right = placeitemRig('oak_fence_gate', { extra: FENCE_NS, placedAs: gate('east') })
  assert.strictEqual((await awaitRoute('/placeitem', at, right.env)).facing, 'east', 'control: a facing along the passage')
  const wrong = placeitemRig('oak_fence_gate', { extra: FENCE_NS, placedAs: gate('north') })
  assert.strictEqual((await awaitRoute('/placeitem', at, wrong.env)).facing, 'north, wanted east-west')
  const looks = wrong.log.slice(0, wrong.log.findIndex((l) => l.startsWith('place'))).filter((l) => l.startsWith('look'))
  assert.deepStrictEqual(looks.at(-1), 'look 17.5,0.5', 'the last look before the click was not due east')
})

test('a gate looks along no fence line the bot remembers out of sight', async () => {
  const at = { x: '1', y: '64', z: '0', name: 'oak_fence_gate' }
  const unseen = Object.keys(FENCE_NS)
  const fenced = placeitemRig('oak_fence_gate', { extra: FENCE_NS, placedAs: gate('north'), unseen })
  const open = placeitemRig('oak_fence_gate', { placedAs: gate('north'), unseen })
  assert.deepStrictEqual(await awaitRoute('/placeitem', at, fenced.env), await awaitRoute('/placeitem', at, open.env))
  assert.deepStrictEqual(fenced.log, open.log)
})

test('placeitem against a chest holds sneak through the place call', async () => {
  const rig = placeitemRig('oak_planks', { extra: { '1,63,0': { name: 'chest', boundingBox: 'block' } } })
  await awaitRoute('/placeitem', { x: '1', y: '64', z: '0', name: 'oak_planks' }, rig.env)
  assert.deepStrictEqual(rig.log.filter((l) => !l.startsWith('look')), ['sneak true', 'place against chest sneaking=true', 'sneak false'])
})

test('placeitem goes against a stone face beside a chest, without sneaking', async () => {
  const extra = { '1,63,0': { name: 'chest', boundingBox: 'block' }, '2,64,0': STONE }
  const rig = placeitemRig('oak_planks', { extra })
  await awaitRoute('/placeitem', { x: '1', y: '64', z: '0', name: 'oak_planks' }, rig.env)
  assert.deepStrictEqual(rig.log.filter((l) => !l.startsWith('look')), ['place against stone sneaking=false'])
})

async function placeitemRefusal (rig) {
  const { handle, res } = routeHandler('/placeitem', rig.env)
  await handle({ query: { x: '1', y: '64', z: '0', name: 'oak_planks' } }, res)
  assert.ok(res.error, 'placeitem did not refuse')
  assert.deepStrictEqual(rig.log.filter((l) => l.startsWith('place')), [])
  return res.error.message
}

// placeitemRig for name over digLock, holding an iron shovel. done records the walk into reach and the soft cover cleared.
function rescueRig (name, digLock) {
  const rig = placeitemRig(name)
  rig.done = []
  Object.assign(rig.env, { digLock, reachToPlace: async () => { rig.done.push('walk') }, clearSoftCover: async () => { rig.done.push('clear') } })
  rig.env.bot.heldItem = { name: 'iron_shovel' }
  return rig
}

test('placeitem and sign refuse busy while the buried self-rescue holds the hand, before the walk, and leave its lease and shovel alone', async () => {
  for (const [route, refusal, name] of [['/placeitem', placeitemRefusal, 'oak_planks'], ['/sign', signRefusal, 'oak_sign']]) {
    const digLock = botConstant('digLock')
    const rig = rescueRig(name, digLock)
    const rescue = rescueLease(digLock, rig.env.guardState)
    assert.strictEqual(await refusal(rig), 'busy: the buried self-rescue is running, nothing placed', route)
    assert.deepStrictEqual(rig.done, [], route)
    assert.strictEqual(rig.env.bot.heldItem.name, 'iron_shovel', route)
    assert.strictEqual(rig.env.guardState.hand, rescue, route)
    assert.strictEqual(rescue.ended, false, route)
  }
})

test('placeitem and sign refuse busy at the hand when the buried self-rescue starts during the walk, and leave its lease and shovel alone', async () => {
  for (const [route, refusal, name] of [['/placeitem', placeitemRefusal, 'oak_planks'], ['/sign', signRefusal, 'oak_sign']]) {
    const digLock = botConstant('digLock')
    const rig = rescueRig(name, digLock)
    let rescue = null
    rig.env.reachToPlace = async () => {
      rescue = rescueLease(digLock, rig.env.guardState)
    }
    const equips = []
    rig.env.bot.equip = async (item) => { equips.push(item.name) }
    assert.strictEqual(await refusal(rig), 'busy: the buried self-rescue is running, nothing done', route)
    assert.deepStrictEqual(equips, [], route)
    assert.strictEqual(rig.env.bot.heldItem.name, 'iron_shovel', route)
    assert.strictEqual(rig.env.guardState.hand, rescue, route)
    assert.strictEqual(rescue.ended, false, route)
  }
})

test('placeitem and sign refuse busy when the buried self-rescue stops their walk into reach, and leave its lease and shovel alone', async () => {
  for (const [route, refusal, name] of [['/placeitem', placeitemRefusal, 'oak_planks'], ['/sign', signRefusal, 'oak_sign']]) {
    const digLock = botConstant('digLock')
    const rig = rescueRig(name, digLock)
    delete rig.env.reachToPlace
    let rescue = null
    // The rescue's stopPath clears the goal, and mineflayer-pathfinder's goto fails with GoalChanged.
    rig.env.bot.pathfinder.goto = async () => {
      rig.done.push('walk')
      rescue = rescueLease(digLock, rig.env.guardState)
      throw Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' })
    }
    assert.strictEqual(await refusal(rig), 'busy: the buried self-rescue is running, nothing placed', route)
    assert.deepStrictEqual(rig.done, ['walk'], route)
    assert.strictEqual(rig.env.bot.heldItem.name, 'iron_shovel', route)
    assert.strictEqual(rig.env.guardState.hand, rescue, route)
    assert.strictEqual(rescue.ended, false, route)
  }
})

test('placeitem and sign click nothing once the buried self-rescue takes the hand during their equip, and leave its lease alone', async () => {
  for (const [route, refusal, name] of [['/placeitem', placeitemRefusal, 'oak_planks'], ['/sign', signRefusal, 'oak_sign']]) {
    const digLock = botConstant('digLock')
    const rig = rescueRig(name, digLock)
    let rescue = null
    rig.env.bot.equip = async (item) => {
      rig.done.push(`equip ${item.name}`)
      rig.env.bot.heldItem = item
      rescue = rescueLease(digLock, rig.env.guardState)
    }
    assert.strictEqual(await refusal(rig), 'busy: the buried self-rescue is running, nothing placed', route)
    assert.deepStrictEqual(rig.done, ['walk', 'clear', `equip ${name}`], route)
    assert.strictEqual(rig.env.guardState.hand, rescue, route)
    assert.strictEqual(rescue.ended, false, route)
  }
})

test('placeitem refuses a fight that starts while it clears soft cover, before the item goes into the hand', async () => {
  let fighting = false
  let equipped = false
  const rig = placeitemRig('oak_planks')
  Object.assign(rig.env, { reflexes: [{ name: 'combat', fightBusy: () => fighting, _threat: null }], clearSoftCover: async () => { fighting = true } })
  rig.env.bot.equip = async () => { equipped = true }
  assert.match(await placeitemRefusal(rig), /^refused: fighting something, the guard reflex holds the hand\./)
  assert.deepStrictEqual({ equipped, hand: rig.env.guardState.hand }, { equipped: false, hand: null })
})

test('a placeitem that fails between taking the hand and the click gives the hand back', async () => {
  let held = null
  const rig = placeitemRig('oak_planks')
  rig.env.bot.equip = async () => {
    held = rig.env.guardState.hand
    throw new Error('the equip timed out')
  }
  assert.strictEqual(await placeitemRefusal(rig), 'the equip timed out')
  assert.ok(held, 'control: the equip ran under a lease')
  assert.strictEqual(rig.env.guardState.hand, null)
})

test('placeitem does not click once the guard reflex took the hand back after the equip, whatever the facing', async () => {
  for (const face of [undefined, 'N']) {
    const rig = placeitemRig('oak_planks')
    rig.env.bot.lookAt = async () => { rig.env.bot.heldItem = { name: 'iron_sword' } }
    const { handle, res } = routeHandler('/placeitem', rig.env)
    await handle({ query: { x: '1', y: '64', z: '0', name: 'oak_planks', face } }, res)
    assert.match(res.error && res.error.message, /^the guard reflex took the hand back from the oak_planks \(holding iron_sword\), nothing placed, retry$/, `face ${face}`)
    assert.deepStrictEqual(rig.clicks, [], `face ${face} clicked`)
    assert.strictEqual(rig.env.guardState.hand, null, `face ${face} kept the lease`)
  }
})

test('placeitem keeps the hand lease through its look after a slow equip used up the first 2 s', async () => {
  const clock = fakeClock()
  const rig = placeitemRig('oak_planks')
  const { env } = rig
  const wait = (ms) => new Promise(resolve => clock.setTimeout(resolve, ms))
  let leasedAtClick = null
  Object.assign(env, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  env.bot.equip = async (item) => { await wait(1800); env.bot.heldItem = item }
  env.bot.lookAt = async () => { await wait(600) }
  env.bot.placeBlock = async () => { leasedAtClick = !!env.guardState.hand }
  const { handle, res } = routeHandler('/placeitem', env)
  const done = handle({ query: { x: '1', y: '64', z: '0', name: 'oak_planks' } }, res)
  while (res.body === undefined && res.error === undefined && clock.now() < 10000) {
    await new Promise(setImmediate)
    clock.advance(1)
  }
  await done
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.strictEqual(leasedAtClick, true, 'the lease ended before the click')
})

const SIGN_AT = { x: '1', y: '64', z: '0', text: 'hi' }

async function signRefusal (rig, query = SIGN_AT) {
  const { handle, res } = routeHandler('/sign', rig.env)
  await handle({ query }, res)
  assert.ok(res.error, 'sign did not refuse')
  assert.deepStrictEqual(rig.log.filter((l) => l.startsWith('place')), [])
  return res.error.message
}

test('placeitem and sign name the block in a seen target cell, and refuse an unseen one alike whatever it holds', async () => {
  const ORE = { '1,64,0': { name: 'diamond_ore', boundingBox: 'block' } }
  for (const [route, refusal, name] of [['/placeitem', placeitemRefusal, 'oak_planks'], ['/sign', signRefusal, 'oak_sign']]) {
    assert.match(await refusal(placeitemRig(name, { extra: ORE })), /cell occupied by diamond_ore/, `${route} control: a seen cell`)
    const hiddenOre = await refusal(placeitemRig(name, { extra: ORE, hidden: ['1,64,0'] }))
    assert.doesNotMatch(hiddenOre, /diamond_ore/, route)
    assert.strictEqual(hiddenOre, await refusal(placeitemRig(name, { hidden: ['1,64,0'] })), `${route}: an unseen empty cell refuses the same`)
  }
})

test('placeitem and sign place only against a block they know', async () => {
  const at = { x: '1', y: '64', z: '0', name: 'oak_planks' }
  const side = { '2,64,0': { name: 'cobblestone', boundingBox: 'block' } }
  const floorOnly = placeitemRig('oak_planks', { extra: side })
  await awaitRoute('/placeitem', at, floorOnly.env)
  assert.deepStrictEqual(floorOnly.log.filter((l) => l.startsWith('place')), ['place against stone sneaking=false'], 'control: the floor first')
  const sideways = placeitemRig('oak_planks', { extra: side, hidden: ['1,63,0'] })
  await awaitRoute('/placeitem', at, sideways.env)
  assert.deepStrictEqual(sideways.log.filter((l) => l.startsWith('place')), ['place against cobblestone sneaking=false'])
  await placeitemRefusal(placeitemRig('oak_planks', { hidden: ['1,63,0'] }))

  const sign = placeitemRig('oak_sign', { extra: side, hidden: ['1,63,0'] })
  sign.env.bot.updateSign = async () => {}
  await awaitRoute('/sign', SIGN_AT, sign.env)
  assert.deepStrictEqual(sign.log.filter((l) => l.startsWith('place')), ['place against cobblestone sneaking=true'], 'sign')
  assert.match(await signRefusal(placeitemRig('oak_sign', { hidden: ['1,63,0'] })), /^nothing solid I can see below or beside/)
})

// A walled stone platform, roofed when asked, where every cell holds light 0 and sky light 0.
function heldPlatformRig (roofed) {
  const placed = []
  const solid = (x, y, z) => Math.abs(x) <= 4 && Math.abs(z) <= 4 &&
    (y === 63 || (roofed && y === 66) || ((Math.abs(x) === 4 || Math.abs(z) === 4) && (y === 64 || y === 65)))
  const blockAt = (pos) => {
    const p = pos.floored()
    const s = solid(p.x, p.y, p.z)
    return { name: s ? 'stone' : 'air', type: s ? 1 : 0, boundingBox: s ? 'block' : 'empty', position: p, light: 0, skyLight: 0 }
  }
  const env = placingEnv(body(0.5, 64, 1.5), blockAt, {
    items: [{ name: 'cobblestone', count: 1 }],
    bot: {
      registry: { blocks: { 0: { emitLight: 0, filterLight: 0 }, 1: { emitLight: 0, filterLight: 15 } } },
      time: { timeOfDay: 6000 },
      game: { minY: -64, height: 384, dimension: 'overworld' },
      pathfinder: { goto: async () => {} },
      async placeBlock (ref, face) { placed.push(`${key(ref.position)} face ${key(face)}`) }
    },
    env: {
      require,
      ck: (x, y, z) => `${x},${y},${z}`,
      goals,
      SEEN: new Set(['0,64,-2']),
      SIGHT_MEMO: { t: 0, cells: new Map() },
      SIGHT_MS: botConstant('SIGHT_MS'),
      ESTIMATED_LIGHT: new Map(),
      ...groundMemory(),
      LEGACY_1710: false,
      clearSoftCover: async () => {},
      stampOwnEdit () {},
      reflexes: [],
      guardState: { hand: null },
      setTimeout,
      clearTimeout
    }
  })
  return { env, placed }
}

test('placeitem goes against a floor in open sky that the client holds no sky light for, never one in a dark room', async () => {
  const at = { x: '0', y: '64', z: '-2', name: 'cobblestone' }
  const open = heldPlatformRig(false)
  await awaitRoute('/placeitem', at, open.env)
  assert.deepStrictEqual(open.placed, ['0,63,-2 face 0,1,0'])
  const roofed = heldPlatformRig(true)
  const { handle, res } = routeHandler('/placeitem', roofed.env)
  await handle({ query: at }, res)
  assert.strictEqual(res.error && res.error.message, 'nothing solid I can see below or beside the target to place against')
  assert.deepStrictEqual(roofed.placed, [])
})

test('placeitem and sign answer a remembered support out of sight the same whatever holds it now', async () => {
  const dug = { '1,63,0': AIR }
  const placeitem = (extra) => placeitemRefusal(placeitemRig('oak_planks', { extra, unseen: ['1,63,0'] }))
  assert.strictEqual(await placeitem({}), await placeitem(dug))
  const sign = (extra) => signRefusal(placeitemRig('oak_sign', { extra, unseen: ['1,63,0'] }))
  assert.strictEqual(await sign({}), await sign(dug))
})

test('sign refuses a planned walk longer than 16 blocks or one that drops more than 3 at once', async () => {
  const short = placeitemRig('oak_sign', { path: Array.from({ length: 16 }, (_, i) => [i - 19, 64, 0]) })
  short.env.bot.updateSign = async () => {}
  await awaitRoute('/sign', SIGN_AT, short.env)
  assert.deepStrictEqual(short.log.filter((l) => l.startsWith('place')), ['place against stone sneaking=true'], 'control: a 16 block walk places')
  const long = placeitemRig('oak_sign', { path: Array.from({ length: 19 }, (_, i) => [i - 19, 64, 0]) })
  assert.strictEqual(await signRefusal(long), 'refusing to walk 19 blocks to place at 1,64,0: goto closer first')
  const deep = placeitemRig('oak_sign', { path: [[-19, 64, 0], [-18, 64, 0], [-17, 60, 0], [-16, 60, 0]] })
  assert.strictEqual(await signRefusal(deep), 'refusing to walk to place at 1,64,0: the way drops 4 blocks at once')
})

const CHEST = { name: 'chest', boundingBox: 'block' }
const wallSign = (facing) => ({ name: 'oak_wall_sign', boundingBox: 'empty', getProperties: () => ({ facing }) })

async function signed (query, opts) {
  const rig = placeitemRig('oak_sign', opts)
  rig.env.bot.updateSign = async () => {}
  return { reply: await awaitRoute('/sign', { ...SIGN_AT, ...query }, rig.env), ...rig }
}

test('sign with wall hangs on that neighbour, a chest included, over a solid floor and a solid block across the cell', async () => {
  const extra = { '0,64,0': CHEST, '2,64,0': STONE }
  const hung = await signed({ wall: 'W' }, { extra, placedAs: wallSign('east') })
  assert.deepStrictEqual(hung.clicks, ['0,64,0 face 1,0,0'])
  assert.deepStrictEqual(hung.log.filter((l) => l.startsWith('place')), ['place against chest sneaking=true'])
  assert.deepStrictEqual([hung.reply.wall, hung.reply.facing, hung.reply.wrote], ['west', 'east', ['hi']])
  const moved = await signed({ wall: 'W' }, { extra, placedAs: wallSign('west') })
  assert.deepStrictEqual([moved.reply.wall, moved.reply.facing], ['east, wanted west', 'west'])
  const standing = await signed({ wall: 'W' }, { extra })
  assert.strictEqual(standing.reply.wall, 'none, wanted west')
})

test('sign without wall stands on the floor, else hangs on the first solid side from +x, and face aims the standing sign', async () => {
  const sides = { '0,64,0': STONE, '2,64,0': STONE }
  const floor = await signed({}, { extra: sides })
  assert.deepStrictEqual(floor.clicks, ['1,63,0 face 0,1,0'], 'the floor first')
  assert.strictEqual(floor.reply.wall, undefined)
  const side = await signed({}, { extra: sides, hidden: ['1,63,0'], placedAs: wallSign('west') })
  assert.deepStrictEqual(side.clicks, ['2,64,0 face -1,0,0'])
  assert.deepStrictEqual([side.reply.wall, side.reply.facing], ['east', 'west'])
  const aimed = await signed({ face: 'N' }, { extra: sides })
  assert.deepStrictEqual(aimed.clicks, ['1,63,0 face 0,1,0'])
  assert.deepStrictEqual(aimed.log.filter((l) => l.startsWith('look')), ['look 1.5,16.5'], 'a standing sign faces the placer')
})

test('sign refuses a wall out of sight and one that holds air alike', async () => {
  const query = { ...SIGN_AT, wall: 'W' }
  const air = await signRefusal(placeitemRig('oak_sign'), query)
  assert.strictEqual(air, 'no solid wall west of the cell for a sign')
  assert.strictEqual(await signRefusal(placeitemRig('oak_sign', { extra: { '0,64,0': CHEST }, unseen: ['0,64,0'] }), query), air)
})

test('sign refuses wall together with face before it walks', async () => {
  const rig = placeitemRig('oak_sign', { extra: { '0,64,0': CHEST } })
  let walked = false
  rig.env.bot.pathfinder.goto = async () => { walked = true }
  assert.strictEqual(await signRefusal(rig, { ...SIGN_AT, wall: 'W', face: 'N' }), 'face aims a standing sign, wall hangs one: pass one')
  assert.strictEqual(walked, false)
})

test('sign takes wall in lower case and refuses an unknown one before it walks', async () => {
  const extra = { '0,64,0': CHEST }
  const hung = await signed({ wall: 'w' }, { extra, placedAs: wallSign('east') })
  assert.deepStrictEqual(hung.clicks, ['0,64,0 face 1,0,0'])
  const rig = placeitemRig('oak_sign', { extra })
  let walked = false
  rig.env.bot.pathfinder.goto = async () => { walked = true }
  assert.strictEqual(await signRefusal(rig, { ...SIGN_AT, wall: 'q' }), 'wall must be N, S, E or W')
  assert.deepStrictEqual({ walked, clicks: rig.clicks }, { walked: false, clicks: [] })
})

test('sign refuses a fight that starts while it clears soft cover, before the sign goes into the hand', async () => {
  let fighting = false
  let equipped = false
  const rig = placeitemRig('oak_sign')
  Object.assign(rig.env, { reflexes: [{ name: 'combat', fightBusy: () => fighting, _threat: null }], clearSoftCover: async () => { fighting = true } })
  rig.env.bot.equip = async () => { equipped = true }
  assert.match(await signRefusal(rig), /^refused: fighting something, the guard reflex holds the hand\./)
  assert.deepStrictEqual({ equipped, hand: rig.env.guardState.hand }, { equipped: false, hand: null })
})

test('sign does not click once the guard reflex took the hand back after the equip, whatever the facing', async () => {
  for (const face of [undefined, 'N']) {
    const rig = placeitemRig('oak_sign')
    rig.env.bot.lookAt = async () => { rig.env.bot.heldItem = { name: 'iron_sword' } }
    assert.match(await signRefusal(rig, { ...SIGN_AT, face }), /^the guard reflex took the hand back from the oak_sign \(holding iron_sword\), nothing placed, retry$/, `face ${face}`)
    assert.deepStrictEqual(rig.clicks, [], `face ${face} clicked`)
    assert.strictEqual(rig.env.guardState.hand, null, `face ${face} kept the lease`)
  }
})

test('sign keeps the hand lease through its look after a slow equip used up the first 2 s, and gives it back after', async () => {
  for (const face of [undefined, 'N']) {
    const clock = fakeClock()
    const { env } = placeitemRig('oak_sign')
    const wait = (ms) => new Promise(resolve => clock.setTimeout(resolve, ms))
    const leased = []
    Object.assign(env, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
    env.bot.equip = async (item) => { await wait(1800); env.bot.heldItem = item }
    env.bot.lookAt = async () => { await wait(600) }
    env.bot.updateSign = async () => {}
    for (const click of ['placeBlock', '_placeBlockWithOptions']) {
      const place = env.bot[click]
      env.bot[click] = async (ref, at) => { leased.push(!!env.guardState.hand); return place(ref, at) }
    }
    const { handle, res } = routeHandler('/sign', env)
    const done = handle({ query: { ...SIGN_AT, face } }, res)
    while (res.body === undefined && res.error === undefined && clock.now() < 10000) {
      await new Promise(setImmediate)
      clock.advance(1)
    }
    await done
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
    assert.deepStrictEqual(leased, [true], `face ${face}: the lease ended before the click`)
    assert.strictEqual(env.guardState.hand, null, `face ${face} kept the lease`)
  }
})

const ladder = (facing) => ({ name: 'ladder', boundingBox: 'block', getProperties: () => ({ facing }) })
const LADDER_AT = { x: '1', y: '64', z: '0', name: 'ladder' }
const WALL = { east: '2,64,0', west: '0,64,0', south: '1,64,1', north: '1,64,-1' }
const walls = (...sides) => Object.fromEntries(sides.map((s) => [WALL[s], STONE]))

async function ladderRefusal (query, rig) {
  const { handle, res } = routeHandler('/placeitem', rig.env)
  await handle({ query }, res)
  assert.ok(res.error, 'placeitem did not refuse')
  assert.deepStrictEqual(rig.clicks, [])
  return res.error.message
}

test('a 1.7.10 ladder with face clicks the side of that wall, never the block below, and names the wall and facing the server set', async () => {
  const north = placeitemRig('ladder', { legacy: true, extra: walls('east', 'north'), placedAs: ladder('south') })
  const placed = await awaitRoute('/placeitem', { ...LADDER_AT, face: 'N' }, north.env)
  assert.deepStrictEqual([placed.wall, placed.facing], ['north', 'south'])
  assert.deepStrictEqual(north.clicks, ['1,64,-1 face 0,0,1'])
  const off = placeitemRig('ladder', { legacy: true, extra: walls('north'), placedAs: ladder('west') })
  const moved = await awaitRoute('/placeitem', { ...LADDER_AT, face: 'N' }, off.env)
  assert.deepStrictEqual([moved.wall, moved.facing], ['east, wanted north', 'west'])
})

test('a 1.7.10 ladder refuses a face whose wall is missing, and one out of sight alike', async () => {
  const missing = await ladderRefusal({ ...LADDER_AT, face: 'N' }, placeitemRig('ladder', { legacy: true, extra: walls('east', 'south') }))
  assert.strictEqual(missing, 'no solid wall north of the cell for a ladder')
  const unseen = placeitemRig('ladder', { legacy: true, extra: walls('east', 'north'), unseen: [WALL.north] })
  assert.strictEqual(await ladderRefusal({ ...LADDER_AT, face: 'N' }, unseen), missing)
})

test('a 1.7.10 ladder over a ladder hangs on the wall the one below hangs on', async () => {
  const rig = placeitemRig('ladder', { legacy: true, extra: { ...walls('east', 'south'), '1,63,0': ladder('north') }, placedAs: ladder('north') })
  await awaitRoute('/placeitem', LADDER_AT, rig.env)
  assert.deepStrictEqual(rig.clicks, ['1,64,1 face 0,0,-1'])
})

test('a 1.7.10 ladder without face over a solid block hangs on the first wall of +x, -x, +z, -z', async () => {
  const rig = placeitemRig('ladder', { legacy: true, extra: walls('west', 'south'), placedAs: ladder('east') })
  const placed = await awaitRoute('/placeitem', LADDER_AT, rig.env)
  assert.deepStrictEqual(rig.clicks, ['0,64,0 face 1,0,0'])
  assert.deepStrictEqual([placed.wall, placed.facing], ['west', 'east'])
  assert.strictEqual(await ladderRefusal(LADDER_AT, placeitemRig('ladder', { legacy: true })), 'a ladder needs a solid wall beside the cell')
})

test('a 1.7.10 ladder the server refuses names the wall, and then=blockat still reads the cell', async () => {
  const refused = () => placeitemRig('ladder', { legacy: true, extra: walls('south'), refused: true })
  const plain = routeHandler('/placeitem', refused().env)
  await plain.handle({ query: LADDER_AT }, plain.res)
  assert.strictEqual(plain.res.error && plain.res.error.message, 'the server refused the ladder on the south wall')
  const checked = routeHandler('/placeitem', refused().env)
  await checked.handle({ query: { ...LADDER_AT, then: 'blockat' } }, checked.res)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(checked.res.sent || null)), {
    ok: false, error: 'the server refused the ladder on the south wall', verify: { name: 'air', at: { x: 1, y: 64, z: 0 } }
  })
})

test('a ladder on 1.21.11 goes on the block below, with face or without', async () => {
  for (const face of ['', 'N']) {
    const rig = placeitemRig('ladder', { extra: walls('south') })
    await awaitRoute('/placeitem', { ...LADDER_AT, face }, rig.env)
    assert.deepStrictEqual(rig.clicks, ['1,63,0 face 0,1,0'], `face ${face}`)
  }
})

const FRAME_AT = { x: '1', y: '64', z: '0', name: 'item_frame' }
const SLAB = { name: 'stone_slab', boundingBox: 'block' }
// The objectData of a frame spawn by facing.
const FACING = { up: 1, north: 2, south: 3, west: 4, east: 5 }

// placeitemRig for an item_frame, with the frames in hanging as {name, at: [x, y, z], objectData, seen} already tracked.
// A hanging frame is perceived unless seen is false. The server ticks every 50 ms of rig.clock and sends its age every
// 20 ticks through rig.server, or no age when ageless. rig.proxy(ms) holds the ages for ms and then delivers them at once.
function frameRig ({ hanging = [], ageless = false, ...opts } = {}) {
  const rig = placeitemRig('item_frame', opts)
  const clock = fakeClock()
  const server = new EventEmitter()
  Object.assign(rig.env, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date: { now: clock.now } })
  Object.assign(rig.env.bot, { time: { age: ageless ? null : 0 }, on: (e, f) => server.on(e, f), removeListener: (e, f) => server.removeListener(e, f) })
  const sendAge = (age) => {
    rig.env.bot.time.age = age
    server.emit('time')
  }
  let ticks = 0
  let held = null
  clock.setInterval(() => {
    if (++ticks % 20 || ageless) return
    if (held) held.push(ticks)
    else sendAge(ticks)
  }, 50)
  rig.proxy = (ms) => {
    held = []
    clock.setTimeout(() => {
      const ages = held
      held = null
      ages.forEach(sendAge)
    }, ms)
  }
  Object.assign(rig, { clock, server })
  rig.env.FRAME_SPAWN_MS = botConstant('FRAME_SPAWN_MS')
  rig.env.FRAME_SPAWN_CAP_MS = botConstant('FRAME_SPAWN_CAP_MS')
  rig.env.staleEntities = new Set()
  rig.env.targetSeen = (en) => en.seen
  hanging.forEach(({ name, at, objectData, seen = true }, i) => { rig.env.bot.entities[i + 1] = { id: i + 1, name, position: new Vec3(...at), objectData, seen } })
  return rig
}

async function frameRoute (rig, query) {
  const { clock } = rig
  const { handle, res } = routeHandler('/placeitem', rig.env)
  const done = handle({ query }, res)
  while (res.body === undefined && res.error === undefined && clock.now() < 10000) {
    await new Promise(setImmediate)
    clock.advance(50)
  }
  await done
  return res
}

async function frameReply (rig, query) {
  const res = await frameRoute(rig, query)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return JSON.parse(JSON.stringify(res.body))
}

async function frameRefusal (rig, query) {
  const res = await frameRoute(rig, query)
  assert.ok(res.error, 'placeitem did not refuse')
  return res.error.message
}

test('a 1.7.10 frame with face hangs on that wall, a chest clicked sneaking, over a floor and beside a slab', async () => {
  const rig = frameRig({ legacy: true, extra: { [WALL.west]: CHEST, [WALL.east]: SLAB }, spawn: FACING.east })
  const placed = await frameReply(rig, { ...FRAME_AT, face: 'W', then: 'blockat' })
  assert.deepStrictEqual(rig.clicks, ['0,64,0 face 1,0,0'])
  assert.deepStrictEqual(rig.log.filter((l) => !l.startsWith('look')), ['sneak true', 'place against chest sneaking=true', 'sneak false'])
  assert.deepStrictEqual([placed.wall, placed.facing], ['west', 'east'])
  assert.deepStrictEqual(placed.verify, { name: 'item_frame', at: { x: 1, y: 64, z: 0 } })
})

test('a 1.7.10 frame without face never clicks the floor, it hangs on a side', async () => {
  const rig = frameRig({ legacy: true, extra: walls('south'), spawn: FACING.north })
  const placed = await frameReply(rig, FRAME_AT)
  assert.deepStrictEqual(rig.clicks, ['1,64,1 face 0,0,-1'])
  assert.deepStrictEqual([placed.wall, placed.facing], ['south', 'north'])
  const bare = frameRig({ legacy: true, spawn: FACING.up })
  assert.strictEqual(await frameRefusal(bare, FRAME_AT), 'a frame needs a solid wall beside the cell')
  assert.deepStrictEqual(bare.clicks, [])
})

test('a frame on 1.21.11 goes on the floor and reports the facing up', async () => {
  const rig = frameRig({ spawn: FACING.up })
  const placed = await frameReply(rig, FRAME_AT)
  assert.deepStrictEqual(rig.clicks, ['1,63,0 face 0,1,0'])
  assert.deepStrictEqual([placed.facing, placed.wall], ['up', undefined])
})

test('a frame counts as placed only on its spawn in the cell, a chest wall wrapping the no-spawn text', async () => {
  const west = { ...FRAME_AT, face: 'W' }
  await frameReply(frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east }), west)
  const none = 'no item_frame spawned at 1,64,0 within 40 ticks of the click on the west wall'
  assert.strictEqual(await frameRefusal(frameRig({ legacy: true, extra: walls('west') }), west), none)
  const elsewhere = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, spawnAt: [1, 65, 0] })
  assert.strictEqual(await frameRefusal(elsewhere, west), none)
  const chest = frameRig({ legacy: true, extra: { [WALL.west]: CHEST } })
  assert.strictEqual(await frameRefusal(chest, west), `did not place while sneaking against the chest at 0,64,0 (${none})`)
})

test('a frame the server hangs off the named wall reports the wanted one', async () => {
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.north })
  const placed = await frameReply(rig, { ...FRAME_AT, face: 'W' })
  assert.deepStrictEqual([placed.wall, placed.facing], ['south, wanted west', 'north'])
})

test('a frame refuses a face wall out of sight and a missing one alike, before any click', async () => {
  const missing = frameRig({ legacy: true, extra: walls('east') })
  const text = await frameRefusal(missing, { ...FRAME_AT, face: 'W' })
  assert.strictEqual(text, 'no solid wall west of the cell for a frame')
  const unseen = frameRig({ legacy: true, extra: walls('west'), unseen: [WALL.west] })
  assert.strictEqual(await frameRefusal(unseen, { ...FRAME_AT, face: 'W' }), text)
  assert.deepStrictEqual([missing.clicks, unseen.clicks], [[], []])
})

test('a frame with face on 1.21.11 hangs on that wall, never on the floor', async () => {
  const rig = frameRig({ extra: walls('west'), spawn: FACING.east })
  const placed = await frameReply(rig, { ...FRAME_AT, face: 'W' })
  assert.deepStrictEqual(rig.clicks, ['0,64,0 face 1,0,0'])
  assert.deepStrictEqual([placed.wall, placed.facing], ['west', 'east'])
})

test('a frame spawning in the cell during the look before the click does not count', async () => {
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, spawnAt: [1, 64, 0], spawnWhen: 'look' })
  const none = 'no item_frame spawned at 1,64,0 within 40 ticks of the click on the west wall'
  assert.strictEqual(await frameRefusal(rig, { ...FRAME_AT, face: 'W' }), none)
  assert.deepStrictEqual(rig.clicks, ['0,64,0 face 1,0,0'], 'control: it clicked')
})

test('a 1.7.10 frame looks at the centre of the wall face, forced, before it clicks', async () => {
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east })
  await frameReply(rig, { ...FRAME_AT, face: 'W' })
  assert.deepStrictEqual(rig.clicks, ['0,64,0 face 1,0,0'], 'control: it clicked')
  assert.deepStrictEqual(rig.lookAtClick, [{ x: 1, y: 64.5, z: 0.5, force: true }])
})

test('a frame spawn queued behind the age update that ends the wait still counts', async () => {
  // The first age update after the click opens the 40 ticks and the third closes them.
  const late = (emit) => {
    let ages = 0
    const onTime = () => {
      if (++ages < 3) return
      rig.server.removeListener('time', onTime)
      setImmediate(emit)
    }
    rig.server.on('time', onTime)
  }
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, spawnWhen: late })
  const placed = await frameReply(rig, { ...FRAME_AT, face: 'W' })
  assert.deepStrictEqual([placed.wall, placed.facing], ['west', 'east'])
})

test('a frame spawn that follows the burst of stale server ages a 3 s proxy stall over the click queued counts', async () => {
  // The proxy holds the click and the server's ages for 3 s, then delivers the ages at once. The server answers the
  // click 100 ms later.
  const stalled = (emit) => {
    rig.proxy(3000)
    rig.clock.setTimeout(emit, 3100)
  }
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, spawnWhen: stalled })
  const placed = await frameReply(rig, { ...FRAME_AT, face: 'W' })
  assert.deepStrictEqual([placed.wall, placed.facing], ['west', 'east'])
})

test('a frame on a server that sends no age waits 5 s after the click for its spawn', async () => {
  const late = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, ageless: true, spawnWhen: (emit) => late.clock.setTimeout(emit, 4500) })
  const placed = await frameReply(late, { ...FRAME_AT, face: 'W' })
  assert.deepStrictEqual([placed.wall, placed.facing], ['west', 'east'])
  const quiet = frameRig({ legacy: true, extra: walls('west'), ageless: true })
  let clickT = null
  const click = quiet.env.bot._genericPlace
  quiet.env.bot._genericPlace = function (...args) {
    clickT = quiet.clock.now()
    return click.apply(this, args)
  }
  const none = 'no item_frame spawned at 1,64,0 within 5 s (no tick from the server) of the click on the west wall'
  assert.strictEqual(await frameRefusal(quiet, { ...FRAME_AT, face: 'W' }), none)
  const waited = quiet.clock.now() - clickT
  assert.ok(waited >= 5000 && waited <= 5100, `refused ${waited} ms after the click`)
})

test('a frame whose server sends no age after 20 ticks names the ticks it counted by the 5 s cap', async () => {
  // The proxy holds every age after the second one since the click until long after the cap.
  const held = () => {
    let ages = 0
    rig.server.on('time', function onTime () {
      if (++ages < 2) return
      rig.server.removeListener('time', onTime)
      rig.proxy(10000)
    })
  }
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, spawnWhen: held })
  const short = 'no item_frame spawned at 1,64,0 within 5 s (20 of 40 ticks counted) of the click on the west wall'
  assert.strictEqual(await frameRefusal(rig, { ...FRAME_AT, face: 'W' }), short)
})

test('a frame names the ticks counted by the 5 s cap, not those of an age update handled after it', async () => {
  // The proxy swallows every age after the second one and delivers one more in the turn after the cap.
  const held = () => {
    let ages = 0
    rig.server.on('time', function onTime () {
      if (++ages < 2) return
      rig.server.removeListener('time', onTime)
      const emit = rig.server.emit
      rig.server.emit = () => false
      rig.clock.setTimeout(() => {
        rig.server.emit = emit
        rig.server.emit('time')
      }, 3050)
    })
  }
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, spawnWhen: held })
  const short = 'no item_frame spawned at 1,64,0 within 5 s (20 of 40 ticks counted) of the click on the west wall'
  assert.strictEqual(await frameRefusal(rig, { ...FRAME_AT, face: 'W' }), short)
})

test('a frame does not click once the guard reflex took the hand back during the look', async () => {
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east })
  rig.env.bot.lookAt = async () => { rig.env.bot.heldItem = { name: 'iron_sword' } }
  const text = await frameRefusal(rig, { ...FRAME_AT, face: 'W' })
  assert.strictEqual(text, 'the guard reflex took the hand back from the item_frame (holding iron_sword), nothing placed, retry')
  assert.deepStrictEqual(rig.clicks, [])
  assert.strictEqual(rig.env.bot._client.listenerCount('spawn_entity'), 0)
})

test('a frame leaves no spawn or age listener behind after a timeout or a failed click', async () => {
  const quiet = frameRig({ legacy: true, extra: walls('west') })
  await frameRefusal(quiet, { ...FRAME_AT, face: 'W' })
  assert.strictEqual(quiet.env.bot._client.listenerCount('spawn_entity'), 0, 'after the timeout')
  assert.strictEqual(quiet.server.listenerCount('time'), 0, 'age listener after the timeout')
  const failing = frameRig({ legacy: true, extra: walls('west') })
  failing.env.bot._genericPlace = async () => { throw new Error('the click failed') }
  assert.strictEqual(await frameRefusal(failing, { ...FRAME_AT, face: 'W' }), 'the click failed')
  assert.strictEqual(failing.env.bot._client.listenerCount('spawn_entity'), 0, 'after the failed click')
})

test('a 1.21.11 frame spawning just short of the far edge of its cell confirms', async () => {
  const rig = frameRig({ extra: walls('east'), spawn: FACING.west, spawnAt: [1.96875, 64.5, 0.5] })
  const placed = await frameReply(rig, { ...FRAME_AT, face: 'E' })
  assert.deepStrictEqual([placed.wall, placed.facing], ['east', 'west'])
})

test('a 1.21.11 frame at negative coordinates confirms on a spawn inside its cell', async () => {
  const rig = frameRig({ extra: { '-4,64,0': STONE }, spawn: FACING.west, spawnAt: [-4.03125, 64.5, 0.5] })
  const placed = await frameReply(rig, { ...FRAME_AT, x: '-5', face: 'E' })
  assert.deepStrictEqual([placed.wall, placed.facing], ['east', 'west'])
})

test('a spawn of another entity in the cell does not count as the frame', async () => {
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, spawnAs: 'item' })
  const none = 'no item_frame spawned at 1,64,0 within 40 ticks of the click on the west wall'
  assert.strictEqual(await frameRefusal(rig, { ...FRAME_AT, face: 'W' }), none)
})

test('two frame spawns in the cell after one click report the facing of the first', async () => {
  const rig = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, spawnNext: FACING.north })
  const placed = await frameReply(rig, { ...FRAME_AT, face: 'W' })
  assert.deepStrictEqual([placed.wall, placed.facing], ['west', 'east'])
})

test('a frame refuses a face that a frame or glow frame already hangs on, before any click, on both servers', async () => {
  for (const legacy of [true, false]) {
    const rig = frameRig({ legacy, extra: walls('west'), spawn: FACING.east, hanging: [{ name: 'item_frame', at: [1, 64, 0], objectData: FACING.east }] })
    assert.strictEqual(await frameRefusal(rig, { ...FRAME_AT, face: 'W' }), 'the item_frame at 1,64,0 already hangs on that face', `legacy ${legacy}`)
    assert.deepStrictEqual(rig.clicks, [], `legacy ${legacy}`)
  }
  const glow = frameRig({ extra: walls('west'), spawn: FACING.east, hanging: [{ name: 'glow_item_frame', at: [1, 64, 0], objectData: FACING.east }] })
  assert.strictEqual(await frameRefusal(glow, { ...FRAME_AT, face: 'W' }), 'the glow_item_frame at 1,64,0 already hangs on that face')
  assert.deepStrictEqual(glow.clicks, [])
  const floor = frameRig({ spawn: FACING.up, hanging: [{ name: 'item_frame', at: [1, 64, 0], objectData: FACING.up }] })
  assert.strictEqual(await frameRefusal(floor, FRAME_AT), 'the item_frame at 1,64,0 already hangs on that face')
  assert.deepStrictEqual(floor.clicks, [])
})

test('a frame on another face of the cell or on the same face of another cell does not block a frame', async () => {
  for (const legacy of [true, false]) {
    const hanging = [{ name: 'item_frame', at: [1, 64, 0], objectData: FACING.north }, { name: 'item_frame', at: [1, 65, 0], objectData: FACING.east }]
    const rig = frameRig({ legacy, extra: walls('west'), spawn: FACING.east, hanging })
    const placed = await frameReply(rig, { ...FRAME_AT, face: 'W' })
    assert.deepStrictEqual(rig.clicks, ['0,64,0 face 1,0,0'], `legacy ${legacy}`)
    assert.deepStrictEqual([placed.wall, placed.facing], ['west', 'east'], `legacy ${legacy}`)
  }
})

test('a frame the body does not perceive on the face leaves the click to the server, a perceived one refuses after the walk and the look', async () => {
  const hanging = (seen) => [{ name: 'item_frame', at: [1, 64, 0], objectData: FACING.east, seen }]
  const unseen = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, hanging: hanging(false) })
  const placed = await frameReply(unseen, { ...FRAME_AT, face: 'W' })
  assert.deepStrictEqual([unseen.clicks, placed.wall], [['0,64,0 face 1,0,0'], 'west'])
  const seen = frameRig({ legacy: true, extra: walls('west'), spawn: FACING.east, hanging: hanging(true) })
  seen.env.bot.pathfinder.goto = async () => { seen.log.push('walk') }
  assert.strictEqual(await frameRefusal(seen, { ...FRAME_AT, face: 'W' }), 'the item_frame at 1,64,0 already hangs on that face')
  assert.deepStrictEqual([seen.log, seen.clicks], [['walk', 'look 1,0.5'], []])
})

test('a 1.7.10 frame without face skips a wall whose face holds a perceived frame, refusing only when every wall does', async () => {
  const east = { name: 'item_frame', at: [1, 64, 0], objectData: FACING.west }
  const moved = frameRig({ legacy: true, extra: walls('east', 'west'), spawn: FACING.east, hanging: [east] })
  const placed = await frameReply(moved, FRAME_AT)
  assert.deepStrictEqual([moved.clicks, placed.wall], [['0,64,0 face 1,0,0'], 'west'])
  const unseen = frameRig({ legacy: true, extra: walls('east', 'west'), spawn: FACING.west, hanging: [{ ...east, seen: false }] })
  const kept = await frameReply(unseen, FRAME_AT)
  assert.deepStrictEqual([unseen.clicks, kept.wall], [['2,64,0 face -1,0,0'], 'east'])
  const full = frameRig({ legacy: true, extra: walls('east', 'west'), hanging: [east, { name: 'glow_item_frame', at: [1, 64, 0], objectData: FACING.east }] })
  assert.strictEqual(await frameRefusal(full, FRAME_AT), 'the item_frame at 1,64,0 already hangs on that face')
  assert.deepStrictEqual(full.clicks, [])
})
