'use strict'
// A goto names the ore it saw within 4 blocks of the way it walked.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { sameVein } = require('../lib/wake')
const { routeDeadline } = require('../lib/walk')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { botConstant, groundMemory, awaitRoute } = require('./helpers')

const ck = (x, y, z) => x + ',' + y + ',' + z
const IDS = { air: 0, coal_ore: 1, iron_ore: 2, stone: 3, diamond_ore: 4 }
const BLOCKS_BY_NAME = Object.fromEntries(Object.entries(IDS).map(([name, id]) => [name, { id, name }]))
const LIT = 15
const DARK = 0
const ARRIVED = { arrived: true, reason: null }

// Stone with a corridor at y 64..65, z 0 from x 0 to x len, plus the open cells and the ores keyed 'x,y,z'.
function world ({ len = 20, open = [], ores = {}, light = LIT }) {
  const isOpen = (x, y, z) => ((y === 64 || y === 65) && z === 0 && x >= 0 && x <= len) || open.includes(ck(x, y, z))
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: 0 }
  bot.pathfinder = { goal: null }
  bot.game = { minY: -64, height: 384 }
  bot.time = { timeOfDay: 6000, age: 100000, doDaylightCycle: true }
  bot.inventory = { slots: [] }
  bot.blockAt = (pos) => {
    const p = pos.floored()
    const name = ores[ck(p.x, p.y, p.z)] || (isOpen(p.x, p.y, p.z) ? 'air' : 'stone')
    const air = name === 'air'
    return { name, type: IDS[name], boundingBox: air ? 'empty' : 'block', shapes: air ? [] : [[0, 0, 0, 1, 1, 1]], position: p, light: air ? light : 0, skyLight: 0 }
  }
  bot.findBlocks = ({ matching, maxDistance, count }) => Object.keys(ores)
    .map((k) => new Vec3(...k.split(',').map(Number)))
    .filter((p) => matching.includes(IDS[ores[ck(p.x, p.y, p.z)]]) && p.distanceTo(bot.entity.position) <= maxDistance)
    .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    .slice(0, count)
  return bot
}

// The /goto reply of a walk east along the corridor to x len, one block every 300 ms.
async function walkEast (scene) {
  const len = scene.len ?? 20
  const bot = world(scene)
  const clock = { now: 0 }
  const stagedGoto = async () => {
    for (let x = 1; x <= len; x++) {
      clock.now += 300
      bot.entity.position = new Vec3(x + 0.5, 64, 0.5)
      bot.emit('move')
      if (scene.step) scene.step(x)
    }
    if (scene.arrive) scene.arrive(bot)
    return { ...(scene.reply ?? ARRIVED) }
  }
  const env = {
    bot,
    shared: { ready: true, mcData: { blocksByName: BLOCKS_BY_NAME } },
    bunker: { building: false },
    claimLane: () => ({}),
    releaseLane () {},
    stagedGoto,
    doorBeside: () => null,
    journal () {},
    memory: { lastWaypoint: null },
    waypoints: {},
    legs: legLedger(),
    takenText,
    routeDeadline,
    stopPath () {},
    Date: { now: () => clock.now },
    ORE_IDS: botConstant('ORE_IDS'),
    sameVein,
    ck,
    Vec3,
    SEEN: new Set(),
    ESTIMATED_LIGHT: new Map(),
    SKY_IN_SIGHT: new Map(),
    SKY_SEEN: { at: null, timeOfDay: null, age: null, cycle: null },
    SIGHT_MEMO: { t: 0, cells: new Map() },
    SIGHT_MS: botConstant('SIGHT_MS'),
    LEGACY_1710: false,
    ...groundMemory()
  }
  const reply = await awaitRoute('/goto', { x: String(len), z: '0' }, env)
  if (!scene.reply) assert.strictEqual(reply.arrived, true, 'control: the walk arrived')
  return reply
}

test('a goto names a vein it walked past in sight, with its size and a cell', async () => {
  const reply = await walkEast({ ores: { '10,66,0': 'iron_ore', '11,66,0': 'iron_ore' } })
  assert.deepStrictEqual(reply.ores, ['iron_ore x2 11,66,0'])
  assert.strictEqual(reply.oresMore, undefined)
})

test('a goto leaves out ore behind a wall and ore in the dark', async () => {
  // An alcove north of x 10, two cells deep, with ore at its end 3 blocks from the corridor.
  const alcove = { open: ['10,64,-1', '10,64,-2', '10,65,-1', '10,65,-2'], ores: { '10,64,-3': 'coal_ore' } }
  assert.deepStrictEqual((await walkEast(alcove)).ores, ['coal_ore 10,64,-3'], 'control: the alcove lit')
  assert.strictEqual((await walkEast({ ...alcove, light: DARK })).ores, undefined)
  const walled = await walkEast({ ores: { '5,64,-2': 'coal_ore' } })
  assert.strictEqual(walled.ores, undefined)
  assert.doesNotMatch(JSON.stringify(walled), /coal|5,64,-2/)
})

test('a goto that gave up names the ore it saw and leaves out ore behind a wall', async () => {
  const ores = { '10,66,0': 'iron_ore', '5,64,-2': 'coal_ore' }
  const reply = await walkEast({ ores, reply: { arrived: false, reason: 'stalled' } })
  assert.strictEqual(reply.reason, 'stalled', 'control: the walk gave up')
  assert.deepStrictEqual(reply.ores, ['iron_ore 10,66,0'], 'control: the ore in sight')
  assert.doesNotMatch(JSON.stringify(reply), /coal|5,64,-2/)
})

test('a goto leaves out a vein it saw more than 4 blocks from its way', async () => {
  // A lit side passage north of x 15, with ore at its end.
  const passage = (depth) => ({
    open: Array.from({ length: depth - 1 }, (_, i) => [`15,64,${-1 - i}`, `15,65,${-1 - i}`]).flat(),
    ores: { [`15,64,${-depth}`]: 'iron_ore' }
  })
  assert.deepStrictEqual((await walkEast(passage(4))).ores, ['iron_ore 15,64,-4'], 'control: 4 blocks off')
  assert.strictEqual((await walkEast(passage(5))).ores, undefined)
})

test('a goto marks a vein it never had in dig reach as unreached', async () => {
  // A lit pit north of x 10 with its floor 3 below the feet, ore at y in its far cell.
  const pit = (y) => ({ open: ['10,64,-1', '10,63,-1', '10,62,-1', '10,62,-2'], ores: { [`10,${y},-2`]: 'coal_ore' } })
  assert.deepStrictEqual((await walkEast(pit(62))).ores, ['coal_ore 10,62,-2'], 'control: 2 below the feet')
  assert.deepStrictEqual((await walkEast(pit(61))).ores, ['coal_ore 10,61,-2 unreached'])
})

test('a goto names at most 8 veins, each ore name first, and counts the rest', async () => {
  // Ten coal veins in the roof every 3 blocks, and one diamond near the start.
  const ores = { '1,66,0': 'diamond_ore' }
  for (let i = 0; i < 10; i++) ores[`${3 + 3 * i},66,0`] = 'coal_ore'
  const reply = await walkEast({ len: 32, ores })
  assert.strictEqual(reply.ores.length, 8)
  assert.strictEqual(reply.oresMore, 3)
  assert.ok(reply.ores.includes('diamond_ore 1,66,0'), 'the farthest vein holds the only diamond')
  assert.ok(reply.ores.includes('coal_ore 30,66,0'), 'the nearest coal')
})

test('a goto through a long coal seam still names the ore it saw last', async () => {
  // Coal lines the corridor's roof, floor and walls for 70 blocks, with a diamond in the roof at the end.
  const ores = { '70,66,0': 'diamond_ore' }
  for (let x = 0; x < 70; x++) for (const [y, z] of [[66, 0], [63, 0], [64, -1], [65, -1], [64, 1], [65, 1]]) ores[ck(x, y, z)] = 'coal_ore'
  const reply = await walkEast({ len: 70, ores })
  assert.ok(reply.ores.some((o) => o.startsWith('coal_ore x')), 'control: the seam')
  assert.ok(reply.ores.includes('diamond_ore 70,66,0'))
})

test('a goto through a long coal seam still names the rare ore it saw first', async () => {
  // A diamond in the roof at the start, then coal on the corridor's six faces for 67 blocks.
  const ores = { '1,66,0': 'diamond_ore' }
  for (let x = 3; x < 70; x++) for (const [y, z] of [[66, 0], [63, 0], [64, -1], [65, -1], [64, 1], [65, 1]]) ores[ck(x, y, z)] = 'coal_ore'
  const reply = await walkEast({ len: 70, ores })
  assert.ok(reply.ores.some((o) => o.startsWith('coal_ore x')), 'control: the seam')
  assert.ok(reply.ores.includes('diamond_ore 1,66,0'), JSON.stringify(reply.ores))
})

test('a goto leaves out a vein dug away in sight before it arrived', async () => {
  const ores = { '19,66,0': 'iron_ore' }
  assert.deepStrictEqual((await walkEast({ ores: { ...ores } })).ores, ['iron_ore 19,66,0'], 'control: still there')
  const open = []
  const dug = () => { delete ores['19,66,0']; open.push('19,66,0') }
  assert.strictEqual((await walkEast({ ores, open, arrive: dug })).ores, undefined)
})

test('a goto leaves out ore it saw dug away, also once out of sight', async () => {
  // A room north of x 9 to 11, two cells deep, with ore in its far wall.
  const room = () => [9, 10, 11].flatMap((x) => [`${x},64,-1`, `${x},64,-2`, `${x},65,-1`, `${x},65,-2`])
  assert.deepStrictEqual((await walkEast({ ores: { '10,64,-3': 'coal_ore' }, open: room() })).ores, ['coal_ore 10,64,-3'], 'control: not dug')
  const ores = { '10,64,-3': 'coal_ore' }
  const open = room()
  const dug = (x) => { if (x === 9) { delete ores['10,64,-3']; open.push('10,64,-3') } }
  assert.strictEqual((await walkEast({ ores, open, step: dug })).ores, undefined)
})

test('a goto whose ore report fails still replies', async () => {
  const unloaded = (bot) => { bot.blockAt = () => { throw new Error('chunk unloaded') } }
  const reply = await walkEast({ ores: { '10,66,0': 'iron_ore' }, arrive: unloaded })
  assert.ok(!('ores' in reply))
})

test('a goto past no ore adds no ore field', async () => {
  const reply = await walkEast({})
  assert.ok(!('ores' in reply) && !('oresMore' in reply))
})

test('a goto that walks nothing names no ore, even ore in sight', async () => {
  const ores = { '1,66,0': 'coal_ore' }
  assert.deepStrictEqual((await walkEast({ len: 1, ores })).ores, ['coal_ore 1,66,0'], 'control: one block walked')
  assert.strictEqual((await walkEast({ len: 0, ores })).ores, undefined)
})
