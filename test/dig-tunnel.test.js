'use strict'
const test = require('node:test')
const assert = require('node:assert')
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

test('dig_tunnel digs the face ahead into rock the bot knows nothing of', async () => {
  const r = await digJob('/dig_tunnel', EAST)
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0', '2,65,0', '2,64,0'])
})

test('dig_tunnel without a dir digs the way the bot faces', async () => {
  for (const { name, yaw, step: [dx, dz] } of facings()) {
    const r = await digJob('/dig_tunnel', { length: '1', torch: '0' }, { yaw })
    assert.deepStrictEqual(r.dug, [`${dx},65,${dz}`, `${dx},64,${dz}`], `facing ${name}`)
  }
})

test('dig_tunnel counts no cave air as dug', async () => {
  const r = await digJob('/dig_tunnel', EAST, { blocks: { '1,65,0': 'cave_air', '2,64,0': 'cave_air' } })
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
