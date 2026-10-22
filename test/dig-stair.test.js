'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { digJob, facings, awaitRoute, botConstant } = require('./helpers')
const { ROUTE_BOUNDS } = require('../lib/bounds')

const UP_EAST = { dir: 'e', up: '1', steps: '2', torch: '0' }

// Runs route for a body at (0, 64, 0) in stone, each pick breaking after its uses digs, and returns the result with the cells dug and the mine event texts.
// The server's update of the held slot follows each dig after lag ms.
async function watchedDig (route, query, { open = () => false, picks = [{ name: 'iron_pickaxe' }], lag = 0 } = {}) {
  const key = (p) => `${p.x},${p.y},${p.z}`
  const opened = new Set(['0,64,0', '0,65,0'])
  const isOpen = (p) => opened.has(key(p)) || open(p)
  const items = picks.map((p, i) => ({ uses: Infinity, slot: 36 + i, ...p }))
  const dug = []
  const events = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    heldItem: null,
    inventory: Object.assign(new EventEmitter(), { emptySlotCount: () => 30, items: () => items }),
    async equip (item) { bot.heldItem = item },
    blockAt: (p) => {
      const name = isOpen(p) ? 'air' : 'stone'
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: p, skyLight: 0 }
    },
    async dig (b) {
      dug.push(key(b.position))
      opened.add(key(b.position))
      const held = bot.heldItem
      if (!held) return
      const wear = () => {
        const broke = --held.uses === 0
        if (broke) { items.splice(items.indexOf(held), 1); if (bot.heldItem === held) bot.heldItem = null }
        bot.inventory.emit('updateSlot', held.slot, held, broke ? null : held)
      }
      if (lag) setTimeout(wear, lag)
      else wear()
    }
  }
  const NEIGHBOURS = botConstant('NEIGHBOURS')
  let job = null
  await awaitRoute(route, query, {
    bot,
    require,
    NEIGHBOURS,
    PICK_TIER: botConstant('PICK_TIER'),
    bunker: { building: false },
    jobs: { start: (n, fn) => { job = fn({ cancelled: false, progress () {} }); return { id: 1 } } },
    emitEvent: (kind, text) => { if (kind === 'mine') events.push(text) },
    refuseWhileBuilding () {},
    fillFrom: async () => null,
    macroPlaceAt: async () => ({}),
    nudgeInto: async (cell) => { bot.entity.position = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5); return true },
    knownCell: () => false,
    skyInSight: () => false,
    lightRange: () => Infinity,
    seesLit: (p) => NEIGHBOURS.some(([dx, dy, dz]) => isOpen(p.offset(dx, dy, dz))),
    setTimeout,
    clearTimeout
  })
  return { ...(await job), dug, events }
}

const breaches = (r) => r.events.filter((t) => t.startsWith('breached'))

test('dig_stair stops once its last pick breaks', async () => {
  const r = await watchedDig('/dig_stair', UP_EAST, { picks: [{ name: 'stone_pickaxe', uses: 5 }] })
  assert.strictEqual(r.stopped, 'no pickaxe left (tool broke)')
  assert.deepStrictEqual(r.dug, ['0,66,0', '1,67,0', '1,66,0', '1,65,0', '2,68,0'], 'dug on after the pick broke')
})

test('dig_stair stops on a pick the server breaks 100 ms after the dig', async () => {
  const r = await watchedDig('/dig_stair', UP_EAST, { lag: 100, picks: [{ name: 'stone_pickaxe', uses: 1, maxDurability: 131, durabilityUsed: 131 }] })
  assert.strictEqual(r.stopped, 'no pickaxe left (tool broke)')
  assert.deepStrictEqual(r.dug, ['0,66,0'], 'dug on with the broken pick')
})

// Going up east one step from (0, 64, 0), the open cell at (1, 67, 1) shows once the passage's top cell is dug.
test('dig_stair names open air a dig lays bare in sight', async () => {
  const r = await watchedDig('/dig_stair', { ...UP_EAST, steps: '1' }, { open: (p) => p.x === 1 && p.y === 67 && p.z === 1 })
  assert.deepStrictEqual(breaches(r), ['breached open air at 1,67,1'])
})

test('dig_stair down from open ground names none of the open air it starts in', async () => {
  const r = await watchedDig('/dig_stair', { ...UP_EAST, up: '0', steps: '3' }, { open: (p) => p.y >= 64 })
  assert.deepStrictEqual([r.stopped, r.endY], ['steps done', 61])
  assert.ok(r.dug.includes('3,63,0'), 'control: the stair dug no cell beside the open ground')
  assert.deepStrictEqual(breaches(r), [])
})

test('dig_stair carves at most the 24 steps its tool schema allows', async () => {
  assert.deepStrictEqual(ROUTE_BOUNDS['/dig_stair'].steps, [1, 24])
  const r = await digJob('/dig_stair', { ...UP_EAST, steps: '30' })
  assert.deepStrictEqual([r.name, r.climbed], ['dig_stair up e x24', 24])
})

test('dig_stair carves its steps up or down and fills a missing step from filler', async () => {
  const up = await digJob('/dig_stair', UP_EAST)
  assert.deepStrictEqual([up.stopped, up.climbed, up.endY], ['steps done', 2, 66])
  assert.deepStrictEqual(up.dug, ['0,66,0', '1,67,0', '1,66,0', '1,65,0', '2,68,0', '2,67,0', '2,66,0'])
  assert.deepStrictEqual(up.fills, [])

  const down = await digJob('/dig_stair', { ...UP_EAST, up: '0' }, { air: ['0,64,0', '0,65,0', '1,62,0'] })
  assert.deepStrictEqual([down.stopped, down.climbed, down.endY], ['steps done', -2, 62])
  assert.deepStrictEqual(down.dug, ['1,65,0', '1,64,0', '1,63,0', '2,64,0', '2,63,0', '2,62,0'])
  assert.deepStrictEqual(down.fills, ['1,62,0'], 'the missing tread under the first step down')
})

test('dig_stair without a dir climbs and is named the way the bot faces', async () => {
  const DIR = { '0,-1': 'n', '0,1': 's', '1,0': 'e', '-1,0': 'w' }
  for (const { name, yaw, step: [dx, dz] } of facings()) {
    const r = await digJob('/dig_stair', { up: '1', steps: '1', torch: '0' }, { yaw })
    assert.deepStrictEqual(r.dug, ['0,66,0', `${dx},67,${dz}`, `${dx},66,${dz}`, `${dx},65,${dz}`], `facing ${name}`)
    assert.strictEqual(r.name, `dig_stair up ${DIR[[dx, dz].join()]} x1`, `facing ${name}`)
  }
})

test('dig_stair up stops where the sky shows, at any height', async () => {
  const deep = await digJob('/dig_stair', { ...UP_EAST, steps: '6' })
  assert.deepStrictEqual([deep.stopped, deep.endY], ['steps done', 70], 'no sky in sight')
  const r = await digJob('/dig_stair', { ...UP_EAST, steps: '6' }, { sky: (p) => p.y >= 67 })
  assert.deepStrictEqual([r.stopped, r.endY], ['sky in sight', 67])
})

test('dig_stair counts no cave air as dug', async () => {
  const up = await digJob('/dig_stair', UP_EAST, { blocks: { '1,66,0': 'cave_air', '2,68,0': 'cave_air' } })
  assert.deepStrictEqual([up.stopped, up.climbed, up.endY], ['steps done', 2, 66])
  assert.deepStrictEqual(up.dug, ['0,66,0', '1,67,0', '1,65,0', '2,67,0', '2,66,0'])
})

// Going up east from (0, 64, 0), the second dig is the passage's top cell at (1, 67, 0).
test('dig_stair names gravel over its passage only once a dig lays it bare', async () => {
  const gravel = { blocks: { '1,67,0': 'gravel', '1,68,0': 'gravel' } }
  const known = await digJob('/dig_stair', UP_EAST, { ...gravel, known: ['1,67,0'] })
  assert.match(known.stopped, /gravel/, 'control: known gravel in the passage stops the stair')
  assert.deepStrictEqual(known.dug, [], 'control: dug under known gravel')

  const r = await digJob('/dig_stair', UP_EAST, gravel)
  assert.deepStrictEqual(r.dug, ['0,66,0', '1,67,0'], 'the stair stopped before the dig that laid the gravel bare')
  assert.match(r.stopped, /^gravel falling from 1,68,0\b/)
})
