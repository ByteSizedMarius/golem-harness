'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const shelter = require('../lib/shelter')
const { loadBotFunctions, botConstant } = require('./helpers')

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

// craftItem over a body at (0.5, 64, 0.5) carrying a crafting table, with a placed table at tableAt or none.
// A 3x3 recipe needs the table, a 2x2 one does not. goto puts the body at its goal.
function crafter ({ tableAt = null, needsTable = true } = {}) {
  const entity = body(0.5, 64, 0.5)
  const log = []
  const table = tableAt && { name: 'crafting_table', position: tableAt }
  const recipe = { result: { count: needsTable ? 1 : 4 } }
  const env = placingEnv(entity, ground(), {
    items: [{ name: 'crafting_table', count: 1 }],
    bot: {
      recipesFor: (id, meta, min, t) => (t || !needsTable ? [recipe] : []),
      findBlock: ({ maxDistance }) => (table && table.position.distanceTo(entity.position) <= maxDistance ? table : null),
      pathfinder: { goto: async (g) => { log.push(['goto', g.x, g.y, g.z, g.r]); entity.position = new Vec3(g.x - 2.5, g.y, g.z + 0.5) } },
      async craft (r, n, t) { log.push(['craft', t ? key(t.position) : null]) },
      async placeBlock () { log.push(['placeBlock']) },
      async equip (item) { log.push(['equip', item.name]) }
    },
    env: { resolveBlockIds: () => [58], goals: { GoalNear: function (x, y, z, r) { Object.assign(this, { x, y, z, r }) } } }
  })
  return { log, ctx: loadBotFunctions(['craftItem'], env) }
}

test('craft with no table within 16 refuses a 3x3 recipe and places nothing', async () => {
  const { log, ctx } = crafter()
  await assert.rejects(ctx.craftItem({ id: 1, name: 'chest' }, 1), { message: 'no crafting table nearby, place one (place or placeitem) and craft again' })
  assert.deepStrictEqual(log, [])
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
