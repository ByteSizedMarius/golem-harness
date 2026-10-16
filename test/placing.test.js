'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const shelter = require('../lib/shelter')
const { overrideRecipes } = require('../lib/server-overrides')
const { loadBotFunctions, botConstant, awaitRoute, routeHandler } = require('./helpers')

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

test('placeitem refuses a cell the body overlaps after its walk, the head cell included', async () => {
  const walks = []
  const env = placingEnv(body(0.5, 64, 0.5), ground(), {
    bot: { pathfinder: { goto: async (g) => { walks.push(g) } } },
    env: { goals: { GoalNear: function (x, y, z, r) { Object.assign(this, { x, y, z, r }) } } }
  })
  const { reachToPlace } = loadBotFunctions(['reachToPlace'], env)
  await reachToPlace(new Vec3(1, 64, 0))
  assert.deepStrictEqual({ ...walks[0] }, { x: 1, y: 64, z: 0, r: 3 }, 'control: a free cell beside the body')
  for (const cell of [new Vec3(0, 64, 0), new Vec3(0, 65, 0)]) {
    await assert.rejects(reachToPlace(cell), /my body overlaps that cell/, key(cell))
  }
})

// craftItem over a body at (0.5, 64, 0.5) carrying a crafting table, with a placed table at tableAt or none,
// unseen when seen is false. A 3x3 recipe needs the table, a 2x2 one does not. goto puts the body 2.5 short of its goal in x.
function crafter ({ tableAt = null, needsTable = true, seen = true } = {}) {
  const entity = body(0.5, 64, 0.5)
  const log = []
  const recipe = { result: { count: needsTable ? 1 : 4 } }
  const placed = tableAt ? { [key(tableAt)]: { name: 'crafting_table', boundingBox: 'block' } } : {}
  const env = placingEnv(entity, ground(placed), {
    items: [{ name: 'crafting_table', count: 1 }],
    bot: {
      recipesFor: (id, meta, min, t) => (t || !needsTable ? [recipe] : []),
      findBlocks: ({ maxDistance }) => (tableAt && tableAt.distanceTo(entity.position) <= maxDistance ? [tableAt] : []),
      pathfinder: { goto: async (g) => { log.push(['goto', g.x, g.y, g.z, g.r]); entity.position = new Vec3(g.x - 2.5, g.y, g.z + 0.5) } },
      async craft (r, n, t) { log.push(['craft', t ? key(t.position) : null]) },
      async placeBlock () { log.push(['placeBlock']) },
      async equip (item) { log.push(['equip', item.name]) }
    },
    env: {
      resolveBlockIds: () => [58],
      goals: { GoalNear: function (x, y, z, r) { Object.assign(this, { x, y, z, r }) } },
      SERVER_RECIPES: null,
      overrideRecipes,
      mcData: { itemsByName: {} },
      cellKnown: (p) => seen || !tableAt || !p.equals(tableAt),
      seenNow: (p) => seen || !tableAt || !p.equals(tableAt),
      STATIONS: new Map()
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
    env: { setTimeout, blockers: () => [] }
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

// placeitem by a body at (-1.5, 64, 0.5) carrying name over the floor plus extra, blind to the cells in hidden,
// remembering the cells in unseen without seeing them now.
// A click leaves placedAs (default a block of name) in the target. log records looks, sneaks and places.
function placeitemRig (name, { extra = {}, placedAs = null, hidden = [], unseen = [] } = {}) {
  const log = []
  const world = { ...extra }
  let sneaking = false
  const place = (ref, face) => {
    log.push(`place against ${ref.name} sneaking=${sneaking}`)
    world[key(ref.position.plus(face))] = placedAs || { name, boundingBox: 'block' }
  }
  const env = placingEnv(body(-1.5, 64, 0.5), ground(world), {
    items: [{ name, count: 1 }],
    bot: {
      pathfinder: { goto: async () => {} },
      async lookAt (p) { log.push(`look ${p.x},${p.z}`) },
      async waitForTicks () {},
      setControlState (c, on) { if (c === 'sneak') { sneaking = on; log.push(`sneak ${on}`) } },
      async placeBlock (ref, face) { place(ref, face) },
      async _placeBlockWithOptions (ref, face) { place(ref, face) }
    },
    env: { require, goals: { GoalNear: function () {} }, cellKnown: (p) => !hidden.includes(key(p)), seenNow: (p) => !hidden.includes(key(p)) && !unseen.includes(key(p)), clearSoftCover: async () => {}, stampOwnEdit () {} }
  })
  return { log, env }
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

test('placeitem and sign answer a remembered support out of sight the same whatever holds it now', async () => {
  const dug = { '1,63,0': AIR }
  const placeitem = (extra) => placeitemRefusal(placeitemRig('oak_planks', { extra, unseen: ['1,63,0'] }))
  assert.strictEqual(await placeitem({}), await placeitem(dug))
  const sign = (extra) => signRefusal(placeitemRig('oak_sign', { extra, unseen: ['1,63,0'] }))
  assert.strictEqual(await sign({}), await sign(dug))
})
