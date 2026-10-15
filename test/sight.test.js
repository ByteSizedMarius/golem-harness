'use strict'
// A block reaches the pilot only when it is in line of sight from the head and not in total darkness.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { sameVein } = require('../lib/wake')
const { sectionColumns, floorPhrase } = require('../lib/section')
const { botConstant, loadBotFunctions, runRoute } = require('./helpers')

const ck = (x, y, z) => x + ',' + y + ',' + z
const IDS = { air: 0, coal_ore: 1, iron_ore: 2, stone: 3 }

// Stone with open cells where open(x, y, z), the ores at their 'x,y,z', and open cells at light(x, z) and skyLight(x, z).
function world ({ open, ores = {}, light, skyLight = () => 0 }) {
  const blockAt = (p) => {
    const name = ores[ck(p.x, p.y, p.z)] || (open(p.x, p.y, p.z) ? 'air' : 'stone')
    const air = name === 'air'
    return { name, type: IDS[name], boundingBox: air ? 'empty' : 'block', position: new Vec3(p.x, p.y, p.z), light: air ? light(p.x, p.z) : 0, skyLight: air ? skyLight(p.x, p.z) : 0 }
  }
  const position = new Vec3(0.5, 64, 0.5)
  const findBlocks = ({ matching, maxDistance, count }) => Object.keys(ores)
    .map((k) => new Vec3(...k.split(',').map(Number)))
    .filter((p) => matching.includes(IDS[ores[ck(p.x, p.y, p.z)]]) && p.distanceTo(position) <= maxDistance)
    .sort((a, b) => a.distanceTo(position) - b.distanceTo(position))
    .slice(0, count)
  const blocks = [{ id: 1, name: 'coal_ore' }, { id: 2, name: 'iron_ore' }]
  return {
    ready: true,
    bot: { entity: { position, yaw: 0 }, blockAt, findBlocks },
    mcData: { blocksArray: blocks, blocksByName: Object.fromEntries(blocks.map((b) => [b.name, b])) },
    ck,
    Vec3,
    SEEN: new Set(),
    STALE_LIGHT: new Set()
  }
}

// The body stands in a room at x 0..3, z 0, y 64..65, with coal in its west wall at -1,65,0. A side
// passage at z 1 runs east from x 3 to 8 into a lit cave at x 5..8, z 0, behind a wall at x 4, with
// iron in the cave ceiling at 7,66,0. The room is at light level roomLight.
function cave (roomLight) {
  const open = (x, y, z) => (y === 64 || y === 65) &&
    ((z === 0 && x >= 0 && x <= 3) || (z === 1 && x >= 3 && x <= 8) || (z === 0 && x >= 5 && x <= 8))
  const ores = { '-1,65,0': 'coal_ore', '7,66,0': 'iron_ore' }
  return world({ open, ores, light: (x, z) => (z === 0 && x <= 3 ? roomLight : 15) })
}

const LIT = 15
const DARK = 0
const hidden = (reply) => assert.doesNotMatch(JSON.stringify(reply), /iron|7,66|"x":7,"y":66/)

test('find names ore in lit sight, never ore around a corner or in the dark', () => {
  const find = (light, name) => runRoute('/find', { name }, cave(light))
  assert.deepStrictEqual(find(LIT, 'coal').blocks.map((b) => [b.name, b.pos.x, b.pos.y, b.pos.z]), [['coal_ore', -1, 65, 0]], 'control: in sight')
  const iron = find(LIT, 'iron')
  assert.strictEqual(iron.count, 0)
  hidden(iron)
  assert.strictEqual(find(DARK, 'coal').count, 0, 'in sight, in total darkness')
})

test('light the client may hold from before a block change leaves sight alone to decide', () => {
  const env = cave(DARK)
  env.STALE_LIGHT.add('0,4,0')
  assert.strictEqual(runRoute('/find', { name: 'coal' }, env).count, 1)
  assert.strictEqual(runRoute('/find', { name: 'iron' }, env).count, 0)
})

test('the veins of scene name ore in lit sight, never ore around a corner or in the dark', () => {
  const veins = (light) => {
    const env = { ...cave(light), VEIN_SENSE_R: botConstant('VEIN_SENSE_R') }
    return loadBotFunctions(['veinScan'], env).veinScan(env.bot)
  }
  assert.strictEqual(veins(LIT), 'coal W ~1', 'control: in sight')
  assert.strictEqual(veins(DARK), null)
})

test('the ore callout announces ore in lit sight, never ore around a corner or in the dark', () => {
  const callouts = (light) => {
    const events = []
    const env = { ...cave(light), ORE_IDS: [1, 2], ORE_ANNOUNCED: new Map(), sameVein, emitEvent: (kind, msg) => events.push(msg) }
    loadBotFunctions(['oreCallout'], env).oreCallout()
    return events
  }
  const lit = callouts(LIT)
  assert.deepStrictEqual(lit.map((e) => e.split(' ')[0]), ['coal_ore'], 'control: in sight')
  hidden(lit)
  assert.deepStrictEqual(callouts(DARK), [])
})

test('section draws the room it sees and leaves the cave around the corner unseen', () => {
  const env = { ...cave(LIT), sectionColumns, floorPhrase }
  const body = runRoute('/section', { dir: 'e' }, env)
  assert.deepStrictEqual(body.ores.map((o) => o.name), ['coal'], 'control: in sight')
  hidden(body)
  // Columns d -2..len along y 65: the coal at d -1, the room to d 3, the wall at d 4, the cave beyond.
  const row = body.grid.split('\n').find((r) => r.startsWith('y 65')).slice(5)
  assert.strictEqual(row.slice(0, 7), '?*@   #', 'control: the room and its walls')
  assert.strictEqual(row.slice(7, 11), '????', 'the cave at d 5..8')
  assert.match(body.summary, /sealed from d4/)
})

test('section names no ore and no air in total darkness', () => {
  const body = runRoute('/section', { dir: 'e' }, { ...cave(DARK), sectionColumns, floorPhrase })
  assert.deepStrictEqual(body.ores, [])
  const row = body.grid.split('\n').find((r) => r.startsWith('y 65')).slice(5)
  assert.strictEqual(row.slice(0, 7), '??@????')
})

// A corridor at z 0, y 64..65 east from x 0 to 9 at light level light, or with bend, a room at
// x 0..3 and a lit passage on at z 1 from x 3 to 9.
function corridor (light, bend = false) {
  const open = (x, y, z) => (y === 64 || y === 65) &&
    (bend ? (z === 0 && x >= 0 && x <= 3) || (z === 1 && x >= 3 && x <= 9) : z === 0 && x >= 0 && x <= 9)
  return world({ open, light: (x, z) => (z === 1 ? 15 : light) })
}

test('passages gives an exit in lit sight, never one around a corner or in the dark', () => {
  const passages = (env) => runRoute('/passages', { radius: '8' }, env)
  const straight = passages(corridor(LIT))
  assert.match(straight.summary, /^air continues E \(around y64–65, walk-to 8,6[45],0\)$/, 'control: in sight')
  const bent = passages(corridor(LIT, true))
  assert.strictEqual(bent.summary, 'no exit in sight within 8 blocks')
  assert.deepStrictEqual(bent.exits, {})
  assert.strictEqual(passages(corridor(DARK)).summary, 'no exit in sight within 8 blocks')
})

test('passages calls a pocket closed only when the bot has seen its walls', () => {
  const room = () => world({ open: (x, y, z) => z === 0 && x >= 0 && x <= 3 && (y === 64 || y === 65), light: () => DARK })
  const seen = room()
  for (let x = -1; x <= 4; x++) for (let y = 63; y <= 66; y++) for (let z = -1; z <= 1; z++) seen.SEEN.add(ck(x, y, z))
  assert.match(runRoute('/passages', { radius: '8' }, seen).summary, /^closed pocket/, 'control: every wall seen')
  assert.strictEqual(runRoute('/passages', { radius: '8' }, room()).summary, 'no exit in sight within 8 blocks')
})

test('gaze names nothing it would see only in total darkness, and says it is too dark', () => {
  const gaze = (light) => {
    const env = cave(light)
    env.bot.entity.pitch = 0
    Object.assign(env, { markSeen: (x, y, z) => env.SEEN.add(ck(x, y, z)), DARK_RAY: botConstant('DARK_RAY') })
    return { reply: runRoute('/gaze', {}, env), seen: env.SEEN.size }
  }
  const lit = gaze(LIT)
  assert.match(lit.reply.summary, /stone/, 'control: lit')
  const dark = gaze(DARK)
  assert.deepStrictEqual([dark.reply.surfaces, dark.reply.openings, dark.seen], [[], [], 0])
  assert.doesNotMatch(dark.reply.summary, /stone|coal|open space/)
  assert.match(dark.reply.summary, /too dark to see/)
})
