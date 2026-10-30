'use strict'
// Digs decide on gravel and sand only while the bot perceives them.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { entityInCell } = require('../lib/shelter')
const { botConstant, digJob, groundMemory, loadBotFunctions, routeHandler } = require('./helpers')

const ck = (x, y, z) => x + ',' + y + ',' + z

// A body in a lit pocket at 0,64,0 and 0,65,0 under a dirt roof at 0,66,0, in stone up to y 67 with open sky above,
// or stone all the way up without sky. cells holds other blocks by 'x,y,z'.
function pocket (cells, { sky = true } = {}) {
  const blocks = { '0,66,0': 'dirt', '0,64,0': 'air', '0,65,0': 'air', ...cells }
  const blockAt = (pos) => {
    const p = pos.floored()
    const name = blocks[ck(p.x, p.y, p.z)] || (sky && p.y > 67 ? 'air' : 'stone')
    const air = name === 'air'
    const lit = air && p.y < 66
    return { name, type: air ? 0 : 1, boundingBox: air ? 'empty' : 'block', shapes: air ? [] : [[0, 0, 0, 1, 1, 1]], position: p, light: lit ? 15 : 0, skyLight: air && !lit ? 15 : 0, getProperties: () => ({}), digTime: () => 750 }
  }
  const acts = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, width: 0.6, height: 1.8 },
    blockAt,
    registry: { blocks: { 0: { emitLight: 0, filterLight: 0 }, 1: { emitLight: 0, filterLight: 15 } } },
    time: { timeOfDay: 6000, age: 100000, doDaylightCycle: true },
    game: { minY: -64, height: 384 },
    heldItem: null,
    inventory: { items: () => [], slots: [] },
    pathfinder: { goto: async () => { acts.push('walk') } },
    lookAt: async () => {},
    waitForTicks: async () => {},
    digTime: () => 750,
    equip: async () => { acts.push('equip') },
    dig: async () => { acts.push('dig') }
  }
  const env = {
    bot,
    ck,
    Vec3,
    require,
    entityInCell,
    SEEN: new Set(),
    ESTIMATED_LIGHT: new Map(),
    SKY_IN_SIGHT: new Map(),
    SKY_SEEN: { at: null, timeOfDay: null, age: null, cycle: null },
    SIGHT_MEMO: { t: 0, cells: new Map() },
    SIGHT_MS: botConstant('SIGHT_MS'),
    LEGACY_1710: false,
    ...groundMemory()
  }
  return { env, acts }
}

// What digat at x,y,z answers over env, and the walks, equips and digs it made.
async function digat ({ env, acts }, [x, y, z], query = {}) {
  Object.assign(env, { round: (v) => ({ x: v.x, y: v.y, z: v.z }), goals: { GoalNear: class {} }, bunker: { building: false }, reflexes: [], guardState: { hand: null }, digLock: botConstant('digLock'), stopPath () {}, setTimeout, clearTimeout, PICK_TIER: botConstant('PICK_TIER'), DIG_TOOL: botConstant('DIG_TOOL') })
  const { handle, res } = routeHandler('/digat', env)
  await handle({ query: { x: String(x), y: String(y), z: String(z), ...query } }, res)
  return { body: res.body, error: res.error, acts }
}

// The roof cell over the head, with gravel on it at 0,67,0.
const ROOF = [0, 66, 0]
const GRAVEL_ON_ROOF = { '0,67,0': 'gravel' }
const GRAVEL_AT = new Vec3(0, 67, 0)

test('digat digs a roof under gravel the open sky lies on but the bot does not see, never naming the gravel', async () => {
  const sense = loadBotFunctions(['onSurface', 'knownCell', 'seenNow'], pocket(GRAVEL_ON_ROOF).env)
  const gravel = sense.bot.blockAt(GRAVEL_AT)
  assert.deepStrictEqual([sense.onSurface(GRAVEL_AT, gravel), sense.knownCell(GRAVEL_AT), sense.seenNow(GRAVEL_AT)], [true, true, false], 'control: on the surface, out of sight')
  const r = await digat(pocket(GRAVEL_ON_ROOF), ROOF)
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.body.dug, 'dirt')
  assert.deepStrictEqual(r.acts, ['dig'])
  assert.doesNotMatch(JSON.stringify(r.body), /gravel/)
})

test('digat digs a roof under gravel that fell where the bot saw air, out of sight now', async () => {
  const world = pocket(GRAVEL_ON_ROOF, { sky: false })
  world.env.SEEN.add(ck(0, 67, 0))
  const sense = loadBotFunctions(['knownCell', 'seenNow'], pocket(GRAVEL_ON_ROOF, { sky: false }).env)
  sense.SEEN.add(ck(0, 67, 0))
  assert.deepStrictEqual([sense.knownCell(GRAVEL_AT), sense.seenNow(GRAVEL_AT)], [true, false], 'control: remembered, out of sight')
  const r = await digat(world, ROOF)
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.body.dug, 'dirt')
  assert.doesNotMatch(JSON.stringify(r.body), /gravel/)
})

// digJob's known cells are on the surface or remembered, and it sees a block only beside open air.
test('dig_tunnel digs toward gravel it knows of but does not see, and names it once a dig lays it bare', async () => {
  const r = await digJob('/dig_tunnel', { dir: 'e', length: '2', torch: '0' }, { blocks: { '1,66,0': 'gravel' }, known: ['1,66,0'] })
  assert.deepStrictEqual([r.dug, r.stopped], [['1,65,0'], 'gravel falling from 1,66,0, stopping'])
})

test('dig_stair digs toward gravel it knows of but does not see, and names it once a dig lays it bare', async () => {
  const r = await digJob('/dig_stair', { dir: 'e', up: '1', steps: '2', torch: '0' }, { blocks: { '0,67,0': 'gravel' }, known: ['0,67,0'] })
  assert.deepStrictEqual(r.dug, ['0,66,0'])
  assert.match(r.stopped, /^gravel falling from 0,67,0, stopping\b/)
})
