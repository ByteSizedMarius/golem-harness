'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { digJob, facings, awaitRoute, botConstant } = require('./helpers')

const EAST = { dir: 'e', length: '2', torch: '0' }

// why is what fillFrom answers for the open floor cell at 1,63,0, null when the fill works.
async function tunnelOverGap (why) {
  const key = (p) => `${p.x},${p.y},${p.z}`
  const open = new Set(['0,64,0', '0,65,0', '1,63,0'])
  const air = (p) => open.has(key(p))
  const dug = []
  const steps = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    inventory: { emptySlotCount: () => 30 },
    blockAt: (p) => ({ name: air(p) ? 'air' : 'stone', boundingBox: air(p) ? 'empty' : 'block', position: p, skyLight: 0 }),
    async dig (b) { dug.push(key(b.position)); open.add(key(b.position)) }
  }
  const NEIGHBOURS = botConstant('NEIGHBOURS')
  let job = null
  await awaitRoute('/dig_tunnel', EAST, {
    bot,
    require,
    NEIGHBOURS,
    bunker: { building: false },
    jobs: { start: (name, fn) => { job = fn({ cancelled: false, progress () {} }); return { id: 1 } } },
    emitEvent () {},
    refuseWhileBuilding () {},
    equipPickFor: async () => {},
    fillFrom: async () => why,
    macroPlaceAt: async () => ({}),
    nudgeInto: async (cell) => { steps.push(key(cell)); bot.entity.position = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5); return true },
    knownCell: () => false,
    seesLit: (p) => NEIGHBOURS.some(([dx, dy, dz]) => air(p.offset(dx, dy, dz)))
  })
  return { ...(await job), dug, steps }
}

const NO_BOX = new Set(['air', 'seagrass', 'kelp', 'kelp_plant', 'bubble_column'])

// Runs route for a body at (0, 64, 0) in stone, each pick breaking after its uses digs, and returns the result with the cells dug and the mine event texts.
// The server's update of the held slot follows each dig after lag ms.
async function watchedDig (route, query, { open = () => false, blocks = {}, picks = [{ name: 'iron_pickaxe' }], seen = () => true, unlit = [], lag = 0 } = {}) {
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
      const name = isOpen(p) ? 'air' : blocks[key(p)] || 'stone'
      return { name, boundingBox: NO_BOX.has(name) ? 'empty' : 'block', position: p, skyLight: 0 }
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
    lightRange: (p) => (unlit.includes(key(p)) ? 4 : Infinity),
    seesLit: (p) => seen(p) && NEIGHBOURS.some(([dx, dy, dz]) => isOpen(p.offset(dx, dy, dz))),
    setTimeout,
    clearTimeout
  })
  return { ...(await job), dug, events }
}

const breaches = (r) => r.events.filter((t) => t.startsWith('breached'))

test('dig_tunnel stops once its last pick breaks and digs on without one from the start', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, length: '4' }, { picks: [{ name: 'stone_pickaxe', uses: 3 }] })
  assert.strictEqual(r.stopped, 'no pickaxe left (tool broke)')
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0', '2,65,0'], 'dug on after the pick broke')
  assert.match(r.events.at(-1), /^tunnel done: dug 3, stopped=no pickaxe left \(tool broke\)/)

  const bare = await watchedDig('/dig_tunnel', EAST, { picks: [] })
  assert.strictEqual(bare.stopped, 'length reached', 'control: a tunnel begun without a pick stopped')
})

test('dig_tunnel stops on a pick the server breaks 100 ms after the dig', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { lag: 100, picks: [{ name: 'stone_pickaxe', uses: 1, maxDurability: 131, durabilityUsed: 131 }] })
  assert.strictEqual(r.stopped, 'no pickaxe left (tool broke)')
  assert.deepStrictEqual(r.dug, ['1,65,0'], 'dug on with the broken pick')
})

test('dig_tunnel digs on with a pick too low for the ore', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { picks: [{ name: 'wooden_pickaxe' }], blocks: { '1,64,0': 'iron_ore' } })
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0', '2,65,0', '2,64,0'])
})

// Going east one step from (0, 64, 0), the wall ore at (1, 64, 1) borders cells the body does not touch.
const WALL_ORE = { ...EAST, length: '1' }
const oreBeside = (cells, extra = {}) => ({ blocks: { '1,64,1': 'iron_ore' }, open: (p) => cells.includes(`${p.x},${p.y},${p.z}`), ...extra })

test('dig_tunnel names open air a dig lays bare in sight, and whether it is lit', async () => {
  const r = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside(['1,64,2']))
  assert.ok(r.dug.includes('1,64,1'), 'control: the wall ore was not dug')
  assert.deepStrictEqual(breaches(r), ['breached open air at 1,64,2'])

  const dark = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside(['1,64,2'], { unlit: ['1,64,2'] }))
  assert.deepStrictEqual(breaches(dark), ['breached open air at 1,64,2 (unlit)'])
})

test('dig_tunnel names no open air it neither sees nor touches', async () => {
  const r = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside(['1,64,2'], { seen: (p) => !(p.x === 1 && p.y === 64 && p.z === 2) }))
  assert.ok(r.dug.includes('1,64,1'), 'control: the wall ore was not dug')
  assert.deepStrictEqual(breaches(r), [])
})

test('dig_tunnel names no water plant or bubble column as open air', async () => {
  for (const name of ['seagrass', 'kelp', 'kelp_plant', 'bubble_column']) {
    const r = await watchedDig('/dig_tunnel', WALL_ORE, { blocks: { '1,64,1': 'iron_ore', '1,64,2': name } })
    assert.ok(r.dug.includes('1,64,1'), 'control: the wall ore was not dug')
    assert.deepStrictEqual(breaches(r), [], name)
  }
})

test('dig_tunnel names two openings beside one dug cell in one event', async () => {
  const r = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside(['1,63,1', '1,64,2']))
  assert.deepStrictEqual(breaches(r), ['breached open air at 1,63,1 and 1,64,2'])
})

test('dig_tunnel names none of the open air beside where it starts', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, length: '3' }, { open: (p) => p.z === 1 && (p.y === 64 || p.y === 65) })
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(breaches(r), [])
})

test('dig_tunnel digs the face ahead into rock the bot knows nothing of', async () => {
  const r = await digJob('/dig_tunnel', EAST)
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0', '2,65,0', '2,64,0'])
})

test('dig_tunnel without a dir digs and is named the way the bot faces', async () => {
  const DIR = { '0,-1': 'n', '0,1': 's', '1,0': 'e', '-1,0': 'w' }
  for (const { name, yaw, step: [dx, dz] } of facings()) {
    const r = await digJob('/dig_tunnel', { length: '1', torch: '0' }, { yaw })
    assert.deepStrictEqual([r.dug, r.name], [[`${dx},65,${dz}`, `${dx},64,${dz}`], `dig_tunnel ${DIR[[dx, dz].join()]} x1`], `facing ${name}`)
  }
})

test('dig_tunnel counts no cave air as dug', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { blocks: { '1,65,0': 'cave_air', '2,64,0': 'cave_air' } })
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(r.dug, ['1,64,0', '2,65,0'])
})

test('dig_tunnel stops at bedrock and at a floor gap it cannot fill', async () => {
  const bedrock = await digJob('/dig_tunnel', EAST, { blocks: { '2,64,0': 'bedrock' } })
  assert.strictEqual(bedrock.stopped, 'hit bedrock')
  assert.deepStrictEqual(bedrock.dug, ['1,65,0', '1,64,0', '2,65,0'])

  const filled = await tunnelOverGap(null)
  assert.strictEqual(filled.stopped, 'length reached', 'control: the tunnel stopped at a filled gap')
  assert.deepStrictEqual(filled.steps, ['1,64,0', '2,64,0'], 'control: the tunnel did not step over a filled gap')

  const gap = await tunnelOverGap('no filler blocks carried')
  assert.strictEqual(gap.stopped, 'gap in floor, no filler blocks carried')
  assert.deepStrictEqual(gap.dug, ['1,65,0', '1,64,0'])
  assert.deepStrictEqual(gap.steps, [], 'stepped over the open floor')
})

test('dig_tunnel names lava behind unseen stone only once a dig lays it bare, and fills the hole back', async () => {
  const lava = { blocks: { '2,64,0': 'lava' } }
  const known = await digJob('/dig_tunnel', EAST, { ...lava, known: ['2,64,0'] })
  assert.match(known.stopped, /lava/, 'control: known lava ahead stops the tunnel')
  assert.deepStrictEqual(known.dug, [], 'control: dug toward known lava')

  const r = await digJob('/dig_tunnel', EAST, lava)
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0'], 'the tunnel stopped before the dig that laid the lava bare')
  assert.match(r.stopped, /^struck lava at 2,64,0\b/)
  assert.deepStrictEqual(r.fills, ['1,64,0'], 'the hole onto the lava was not filled back')
})

test('dig_tunnel stops at water a dig lays bare and leaves the hole open', async () => {
  const r = await digJob('/dig_tunnel', EAST, { blocks: { '2,65,0': 'water' } })
  assert.deepStrictEqual(r.dug, ['1,65,0'])
  assert.match(r.stopped, /^struck water at 2,65,0\b/)
  assert.deepStrictEqual(r.fills, [])
})
