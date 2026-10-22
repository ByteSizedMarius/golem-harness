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
const { loadBotFunctions, fakeClock, botConstant, awaitRoute, hookedRoute, routeHandler, buildVerbEnv, groundMemory } = require('./helpers')

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

test('walls lists the cell its pockets ran out on, with the reason', async () => {
  const rig = wallsRig({ items: [{ name: 'cobblestone', count: 6 }] })
  assert.deepStrictEqual(await awaitRoute('/walls', RING, rig.env), {
    placed: 6, skipped: 0, failed: 1, failures: ['3,64,1: no block in pockets'], size: '3x3', height: 1, door: 'west'
  })
  assert.strictEqual(rig.bot.listenerCount('death'), 0, 'the run left its death listener behind')
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

// placeitem by a body at (-1.5, 64, 0.5) carrying name over the floor plus extra, blind to the cells in hidden,
// remembering the cells in unseen without seeing them now, on 1.7.10 when legacy is true.
// A click leaves placedAs (default a block of name) in the target, or with refused times out on the block update.
// With path the body stands at (-19.5, 64, 0.5) and its walk plans along the cell centres in path.
// log records looks, sneaks and places, clicks each clicked face as 'x,y,z face dx,dy,dz'.
function placeitemRig (name, { extra = {}, placedAs = null, hidden = [], unseen = [], legacy = false, refused = false, path = null } = {}) {
  const log = []
  const clicks = []
  const world = { ...extra }
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
      async lookAt (p) { log.push(`look ${p.x},${p.z}`) },
      async waitForTicks () {},
      setControlState (c, on) { if (c === 'sneak') { sneaking = on; log.push(`sneak ${on}`) } },
      async placeBlock (ref, face) { place(ref, face) },
      async _placeBlockWithOptions (ref, face) { place(ref, face) }
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
      ...walk
    }
  })
  return { log, clicks, env }
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

async function signRefusal (rig) {
  const { handle, res } = routeHandler('/sign', rig.env)
  await handle({ query: SIGN_AT }, res)
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
