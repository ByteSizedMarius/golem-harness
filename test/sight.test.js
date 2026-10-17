'use strict'
// A block reaches the pilot only in line of sight from the head and within the distance its light carries.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const { Vec3 } = require('vec3')
const { ambientChange, sameVein } = require('../lib/wake')
const { sectionColumns, floorPhrase } = require('../lib/section')
const { GRAVESTONE } = require('../lib/server-overrides')
const { balanced, botConstant, wiredSource, groundMemory, loadBotFunctions, routeHandler, runRoute, reflexIn, combatReflexIn } = require('./helpers')

const ck = (x, y, z) => x + ',' + y + ',' + z
const IDS = { air: 0, coal_ore: 1, iron_ore: 2, stone: 3, diamond_ore: 4, wheat: 5, chest: 6 }
const NOON = 6000
const MIDNIGHT = 18000

// Stone opened where open(x, y, z), ores keyed 'x,y,z', light by (x, z), the body at x = at, z = 0.
// blockAt takes a Vec3 and floors it, as prismarine-world does.
function world ({ open, ores = {}, light, skyLight = () => 0, at = 0, timeOfDay = NOON }) {
  const blockAt = (pos) => {
    const p = pos.floored()
    const name = ores[ck(p.x, p.y, p.z)] || (open(p.x, p.y, p.z) ? 'air' : 'stone')
    const air = name === 'air'
    return { name, type: IDS[name], boundingBox: air ? 'empty' : 'block', position: new Vec3(p.x, p.y, p.z), light: air ? light(p.x, p.z) : 0, skyLight: air ? skyLight(p.x, p.z) : 0 }
  }
  const position = new Vec3(at + 0.5, 64, 0.5)
  const findBlocks = ({ matching, maxDistance, count }) => Object.keys(ores)
    .map((k) => new Vec3(...k.split(',').map(Number)))
    .filter((p) => matching.includes(IDS[ores[ck(p.x, p.y, p.z)]]) && p.distanceTo(position) <= maxDistance)
    .sort((a, b) => a.distanceTo(position) - b.distanceTo(position))
    .slice(0, count)
  const blocks = [{ id: 1, name: 'coal_ore' }, { id: 2, name: 'iron_ore' }, { id: 4, name: 'diamond_ore' }, { id: 5, name: 'wheat', states: [{ name: 'age', num_values: 8 }] }]
  return {
    shared: { ready: true, mcData: { blocksArray: blocks, blocksByName: Object.fromEntries(blocks.map((b) => [b.name, b])), blocks: Object.fromEntries(blocks.map((b) => [b.id, b])) } },
    bot: { entity: { position, yaw: 0 }, blockAt, findBlocks, time: { timeOfDay }, game: { minY: -64, height: 384 } },
    ck,
    Vec3,
    SEEN: new Set(),
    ESTIMATED_LIGHT: new Map(),
    SKY_IN_SIGHT: new Map(),
    SIGHT_MEMO: { t: 0, cells: new Map() },
    SIGHT_MS: botConstant('SIGHT_MS'),
    LEGACY_1710: false,
    ...groundMemory()
  }
}

// An empty station memory as bot.js keeps it.
const stationMemory = () => ({ STATIONS: new Map(), STATION_CAP: botConstant('STATION_CAP'), STATION_RE: botConstant('STATION_RE'), stationEdits: 0 })

// A room at x 0..3 with coal in its west wall, joined by a z 1 passage to a lit cave at x 5..8 behind a wall at x 4, with iron in the cave ceiling.
function cave (roomLight, at = 0) {
  const open = (x, y, z) => (y === 64 || y === 65) &&
    ((z === 0 && x >= 0 && x <= 3) || (z === 1 && x >= 3 && x <= 8) || (z === 0 && x >= 5 && x <= 8))
  const ores = { '-1,65,0': 'coal_ore', '7,66,0': 'iron_ore' }
  return world({ open, ores, light: (x, z) => (z === 0 && x <= 3 ? roomLight : 15), at })
}

const LIT = 15
const DARK = 0
// The room's far end, 3.5 blocks from the coal.
const FAR_END = 3
const hidden = (reply) => assert.doesNotMatch(JSON.stringify(reply), /iron|7,66|"x":7,"y":66/)

test('find names ore in lit sight, never ore around a corner or in the dark', () => {
  const find = (env, name) => runRoute('/find', { name }, env)
  assert.deepStrictEqual(find(cave(LIT), 'coal').blocks.map((b) => [b.name, b.pos.x, b.pos.y, b.pos.z]), [['coal_ore', -1, 65, 0]], 'control: in sight')
  const iron = find(cave(LIT), 'iron')
  assert.strictEqual(iron.count, 0)
  hidden(iron)
  assert.strictEqual(find(cave(DARK, FAR_END), 'coal').count, 0, 'in sight, in total darkness')
})

test('find gives each crop in sight its age and whether it is fully grown', () => {
  const env = world({ open: (x, y) => y >= 64, ores: { '2,64,0': 'wheat', '4,64,0': 'wheat' }, light: () => LIT, skyLight: () => 15 })
  const ages = { '2,64,0': 7, '4,64,0': 3 }
  const base = env.bot.blockAt
  env.bot.blockAt = (p) => ({ ...base(p), getProperties: () => ({ age: String(ages[ck(p.x, p.y, p.z)]) }) })
  const found = runRoute('/find', { name: 'wheat' }, env).blocks.map((b) => [b.pos.x, b.age, b.mature])
  assert.deepStrictEqual(found, [[2, 7, true], [4, 3, false]])
})

const LAVA = { name: 'lava', boundingBox: 'empty', light: 15, metadata: 0 }
const current = (light) => ({ name: 'water', boundingBox: 'empty', light, metadata: 3 })
const still = (light) => ({ name: 'water', boundingBox: 'empty', light, metadata: 0 })
const AIR = { name: 'air', boundingBox: 'empty', light: LIT }
// An air pocket at 1,64,-2 behind the room's north wall, beside the cell at 2,64,-2.
const behindWall = (block) => ({ '1,64,-2': AIR, '2,64,-2': block })

const tunnel = (len, light) => world({ open: (x, y, z) => z === 0 && (y === 64 || y === 65) && x >= 0 && x < len, ores: { [`${len},65,0`]: 'coal_ore' }, light: () => light })
const findsCoal = (env) => runRoute('/find', { name: 'coal' }, env).count === 1

test('ore shows only as far as the light on it carries', () => {
  assert.strictEqual(findsCoal(tunnel(2, 0)), true, 'light 0, 2 blocks out')
  assert.strictEqual(findsCoal(tunnel(3, 0)), false, 'light 0, 3 blocks out')
  assert.strictEqual(findsCoal(tunnel(4, 1)), true, 'light 1, 4 blocks out')
  assert.strictEqual(findsCoal(tunnel(5, 1)), false, 'light 1, 5 blocks out')
  assert.strictEqual(findsCoal(tunnel(40, 7)), true, 'light 7, 40 blocks out')
})

test('open sky at midnight shows ore 12 blocks out, not 13', () => {
  const plain = (out, timeOfDay) => world({ open: (x, y) => y >= 64, ores: { [`${out},64,0`]: 'coal_ore' }, light: () => 0, skyLight: () => 15, timeOfDay })
  assert.strictEqual(findsCoal(plain(13, NOON)), true, 'control: noon')
  assert.strictEqual(findsCoal(plain(12, MIDNIGHT)), true)
  assert.strictEqual(findsCoal(plain(13, MIDNIGHT)), false)
})

test('a floor block five out shows by its top face, never under a block laid over it', () => {
  // A lit corridor with coal in its floor at x 5, its east face open to a hole at 6,63,0.
  const floor = (covered) => world({
    open: (x, y, z) => z === 0 && ((x === 6 && y === 63) || ((y === 64 || y === 65) && x >= 0 && x <= 9 && !(covered && x === 5 && y === 64))),
    ores: { '5,63,0': 'coal_ore' },
    light: () => LIT
  })
  assert.strictEqual(findsCoal(floor(false)), true)
  const covered = runRoute('/find', { name: 'coal' }, floor(true))
  assert.strictEqual(covered.count, 0)
  assert.doesNotMatch(JSON.stringify(covered), /coal_ore|"x":5,"y":63/)
})

test('ore open only on its bottom face to a dug cell shows from below at an angle', () => {
  // A lit tunnel east along z 0, the wall cell 4,65,1 dug out and diamond above it.
  const env = world({
    open: (x, y, z) => (z === 0 && (y === 64 || y === 65) && x >= 0 && x <= 6) || (x === 4 && y === 65 && z === 1),
    ores: { '4,66,1': 'diamond_ore' },
    light: () => LIT
  })
  assert.deepStrictEqual(runRoute('/find', { name: 'diamond' }, env).blocks.map((b) => [b.pos.x, b.pos.y, b.pos.z]), [[4, 66, 1]])
})

test('ore facing the bot from behind a wall stays hidden in every reply', async () => {
  // A lit tunnel along z 0, a wall at z 1, a lit pocket along z 2 with diamond in its far wall at 5,64,3.
  const behind = () => withHands(world({
    open: (x, y, z) => (z === 0 || z === 2) && (y === 64 || y === 65) && x >= 0 && x <= 9,
    ores: { '5,64,3': 'diamond_ore' },
    light: () => LIT
  }))
  const leak = /diamond|"x":5,"y":64,"z":3|5,64,3/
  const found = runRoute('/find', { name: 'diamond' }, behind())
  assert.strictEqual(found.count, 0)
  assert.doesNotMatch(JSON.stringify(found), leak)
  const at = { x: '5', y: '64', z: '3' }
  for (const route of ['/blockat', '/use']) {
    const { handle, res } = routeHandler(route, behind())
    await handle({ query: at }, res)
    assert.match(res.error.message, UNSEEN, route)
    assert.strictEqual(res.body, undefined, route)
    assert.doesNotMatch(res.error.message, leak, route)
  }
})

// The light data of the block types in world, a torch as type 5, an end_rod as type 6, fire as type 7, lava as type 8 and
// water as type 9.
const REGISTRY = { blocks: { 0: { emitLight: 0, filterLight: 0 }, 1: { emitLight: 0, filterLight: 15 }, 2: { emitLight: 0, filterLight: 15 }, 3: { emitLight: 0, filterLight: 15 }, 4: { emitLight: 0, filterLight: 15 }, 5: { emitLight: 14, filterLight: 0 }, 6: { emitLight: 14, filterLight: 0 }, 7: { emitLight: 15, filterLight: 0 }, 8: { emitLight: 15, filterLight: 1 }, 9: { emitLight: 0, filterLight: 1 } } }
const block = (name, type, boundingBox) => (p) => ({ name, type, stateId: type, boundingBox, position: new Vec3(...p), getProperties: () => ({}) })
const stoneAt = block('stone', 3, 'block')
const airAt = block('air', 0, 'empty')
const torchAt = block('torch', 5, 'empty')

// Makes env.bot an emitter and wires it to the block update and chunk load handlers of bot.js.
function wireLight (env) {
  env.bot = Object.assign(new EventEmitter(), env.bot, { registry: REGISTRY })
  env.GRAVESTONE = GRAVESTONE
  const lines = [...wiredSource().matchAll(/^bot\.on\('(?:blockUpdate|chunkColumnLoad)', (?:\(\w+\) => )?([A-Za-z_$][\w$]*)\b.*\)$/gm)]
  vm.runInContext(lines.map((m) => m[0]).join('\n'), loadBotFunctions(lines.map((m) => m[1]), env))
  return env
}

test('a gravestone placed on a 1.7.10 server lights nothing, an end_rod on a modern one does', () => {
  // The server overrides show the 1.7.10 gravestone under the end_rod block type.
  const lightBeside = (name) => {
    const env = wireLight(tunnel(11, DARK))
    env.bot.emit('blockUpdate', airAt([9, 64, 0]), block(name, 6, 'empty')([9, 64, 0]))
    const at = new Vec3(8, 64, 0)
    return env.heldLight(at, env.bot.blockAt(at)).light
  }
  assert.strictEqual(lightBeside('end_rod'), 13)
  assert.strictEqual(lightBeside(GRAVESTONE), 0)
})

test('a placed torch lights the cells within its falloff, not past it or through rock', () => {
  // The coal at 30,65,0 shows from 29.5 blocks out by light 7 on the cell before it.
  const coalAfter = (torch) => {
    const env = wireLight(tunnel(30, DARK))
    env.bot.emit('blockUpdate', stoneAt(torch), torchAt(torch))
    return findsCoal(env)
  }
  assert.strictEqual(coalAfter([23, 64, 0]), true, '7 steps from the cell before the coal')
  assert.strictEqual(coalAfter([22, 64, 0]), false, '8 steps')
  assert.strictEqual(coalAfter([29, 65, 2]), false, '2 cells away behind rock')
})

test('a torch taken away darkens the cells it could have lit, not those lit past its reach, until fresh light arrives', () => {
  const torchTaken = (light) => {
    const env = wireLight(world({ open: (x, y, z) => z === 0 && (y === 64 || y === 65) && x >= 0 && x < 20, ores: { '20,65,0': 'coal_ore' }, light }))
    env.bot.emit('blockUpdate', torchAt([17, 65, 0]), airAt([17, 65, 0]))
    return env
  }
  const torchLit = torchTaken((x) => Math.max(0, 14 - Math.abs(x - 17)))
  assert.strictEqual(findsCoal(torchLit), false, 'lit by the torch alone')
  assert.strictEqual(findsCoal(torchTaken((x) => (x === 19 ? 13 : 0))), true, 'brighter than the torch reaches')
  torchLit.bot.emit('chunkColumnLoad', new Vec3(16, 0, 0))
  assert.strictEqual(findsCoal(torchLit), true, 'the light of a fresh chunk')
})

test('a cell opened beside a lit one takes its light, one level down', () => {
  const env = wireLight(tunnel(3, 5))
  const at = new Vec3(1, 65, -1)
  env.bot.emit('blockUpdate', stoneAt([1, 65, -1]), airAt([1, 65, -1]))
  assert.deepStrictEqual({ ...env.heldLight(at, env.bot.blockAt(at)) }, { light: 4, skyLight: 0 })
})

test('a cell opened under open sky takes the full sky light, one under a roof a level less', () => {
  const skyAfterDig = (roof) => {
    const env = wireLight(world({ open: (x, y, z) => y >= 64 && !(roof && x === 0 && z === 0 && y === 70), light: () => 0, skyLight: () => 15 }))
    const at = new Vec3(0, 63, 0)
    env.bot.emit('blockUpdate', stoneAt([0, 63, 0]), airAt([0, 63, 0]))
    return env.heldLight(at, env.bot.blockAt(at)).skyLight
  }
  assert.strictEqual(skyAfterDig(false), 15)
  assert.strictEqual(skyAfterDig(true), 14, 'rock at y 70')
})

test('a cell opened under open sky in a 1.7.10 dimension takes the full sky light', () => {
  const env = wireLight(world({ open: (x, y) => y >= 64, light: () => 0, skyLight: () => 15 }))
  const modern = env.bot.blockAt
  env.bot.game = { minY: 0, height: 256 }
  env.bot.blockAt = (p) => (p.y < 0 || p.y > 255 ? null : modern(p))
  const at = new Vec3(0, 63, 0)
  env.bot.emit('blockUpdate', stoneAt([0, 63, 0]), airAt([0, 63, 0]))
  assert.strictEqual(env.heldLight(at, env.bot.blockAt(at)).skyLight, 15)
})

// A room at x 10..12, z -1..1 on the floor at y 63, walled to y 66 under open sky, the body at x = at. Its air holds
// sky light 15 in the chunk, and its roof at y 66 is laid and taken off again roofs times after the chunk arrived.
function roomUnder (at, roofs) {
  const roof = new Set()
  const wall = (x, z) => x >= 9 && x <= 13 && z >= -2 && z <= 2 && (x === 9 || x === 13 || z === -2 || z === 2)
  const env = wireLight(world({ open: (x, y, z) => y >= 64 && !(y <= 66 && wall(x, z)) && !roof.has(ck(x, y, z)), light: () => 0, skyLight: () => 15, at }))
  for (let i = 0; i < roofs; i++) {
    for (let x = 10; x <= 12; x++) for (let z = -1; z <= 1; z++) {
      const k = ck(x, 66, z)
      const laid = !roof.has(k)
      if (laid) roof.add(k)
      else roof.delete(k)
      env.bot.emit('blockUpdate', (laid ? airAt : stoneAt)([x, 66, z]), (laid ? stoneAt : airAt)([x, 66, z]))
    }
  }
  return env
}

test('a roof laid over a room takes away the open sky its held light still shows', () => {
  const floorKnown = (roofs) => loadBotFunctions(['knownCell'], roomUnder(0, roofs)).knownCell(new Vec3(11, 63, 0))
  assert.strictEqual(floorKnown(0), true, 'control: open to the sky')
  assert.strictEqual(floorKnown(1), false, 'the floor, unseen from outside the walls')
  assert.strictEqual(floorKnown(2), true, 'the roof taken off again')
  const skyInside = (roofs) => loadBotFunctions(['skyInSight'], roomUnder(11, roofs)).skyInSight()
  assert.strictEqual(skyInside(0), true, 'control: open to the sky')
  assert.strictEqual(skyInside(1), false)
})

test('a roof laid high over open ground on a modern server leaves the cells below it the sky light of a covered cell', () => {
  // A modern server sends sky light for this column only up to y 79.
  const roof = new Set()
  const env = wireLight(world({ open: (x, y, z) => y >= 64 && !roof.has(ck(x, y, z)), light: () => 0 }))
  env.bot.game.dimension = 'overworld'
  const sent = env.bot.blockAt
  env.bot.blockAt = (p) => {
    const b = sent(p)
    return { ...b, skyLight: b.name === 'air' && p.y < 80 ? 15 : 0 }
  }
  roof.add(ck(0, 100, 0))
  env.bot.emit('blockUpdate', airAt([0, 100, 0]), stoneAt([0, 100, 0]))
  const sky = (y) => env.heldLight(new Vec3(0, y, 0), env.bot.blockAt(new Vec3(0, y, 0))).skyLight
  assert.deepStrictEqual([sky(99), sky(70)], [14, 14])
})

test('water high over open ground on a modern server holds the sky light that reaches it through the water above', () => {
  // A stone basin at y 97 to 100 holds water three deep, above y 79, the highest a modern server sent sky light for.
  const basin = (x, y, z) => Math.abs(x) <= 1 && Math.abs(z) <= 1 && y >= 97 && y <= 100
  const pool = (x, y, z) => x === 0 && z === 0 && y >= 98 && y <= 100
  const env = wireLight(world({ open: (x, y, z) => y >= 64 && !basin(x, y, z), light: () => 0 }))
  env.bot.game.dimension = 'overworld'
  const sent = env.bot.blockAt
  env.bot.blockAt = (pos) => {
    const p = pos.floored()
    const b = pool(p.x, p.y, p.z) ? block('water', 9, 'empty')([p.x, p.y, p.z]) : sent(p)
    return { ...b, light: 0, skyLight: b.name === 'air' && p.y < 80 ? 15 : 0 }
  }
  const sky = (y) => env.heldLight(new Vec3(0, y, 0), env.bot.blockAt(new Vec3(0, y, 0))).skyLight
  assert.deepStrictEqual([sky(101), sky(100), sky(99), sky(98)], [15, 14, 13, 12])
})

// A 1.7.10 world from y 0 to 255 with a pool three deep at 0,61..63,0 in the ground at y 63 over an air pocket at
// 0,60,0, open to the sky until a roof is laid at 0,64,0. The chunk holds the sky light a 1.7.10 server sends there.
function pool1710 (roofed) {
  const roof = new Set()
  const env = wireLight({ ...world({ open: (x, y, z) => (y >= 64 && !roof.has(ck(x, y, z))) || (x === 0 && y === 60 && z === 0), light: () => 0 }), LEGACY_1710: true })
  env.bot.game = { minY: 0, height: 256, dimension: 'overworld' }
  const ground = env.bot.blockAt
  const sent = { 63: 12, 62: 9, 61: 6, 60: 5 }
  env.bot.blockAt = (pos) => {
    const p = pos.floored()
    if (p.y < 0 || p.y > 255) return null
    const column = p.x === 0 && p.z === 0
    const b = column && p.y >= 61 && p.y <= 63 ? block('water', 9, 'empty')([p.x, p.y, p.z]) : ground(p)
    return { ...b, light: 0, skyLight: column && p.y in sent ? sent[p.y] : b.name === 'air' ? 15 : 0 }
  }
  if (roofed) {
    roof.add(ck(0, 64, 0))
    env.bot.emit('blockUpdate', airAt([0, 64, 0]), stoneAt([0, 64, 0]))
  }
  return (y) => env.heldLight(new Vec3(0, y, 0), env.bot.blockAt(new Vec3(0, y, 0))).skyLight
}

test('water on a 1.7.10 server dims sky light by 3 a cell, and a cell below it by at least 1', () => {
  assert.deepStrictEqual([64, 63, 62, 61, 60].map(pool1710(false)), [15, 12, 9, 6, 5])
  assert.deepStrictEqual([63, 62, 61].map(pool1710(true)), [11, 8, 5], 'under a roof')
})

test('air under one cell of water on a modern server takes sky light at least 1 below the water', () => {
  // A stone pocket at y 98 to 100 above y 79, the highest a modern server sent sky light for, water at 0,100,0 over air at 0,99,0.
  const pocket = (x, y, z) => Math.abs(x) <= 1 && Math.abs(z) <= 1 && y >= 98 && y <= 100 && !(x === 0 && z === 0 && y === 99)
  const env = wireLight(world({ open: (x, y, z) => y >= 64 && !pocket(x, y, z), light: () => 0 }))
  env.bot.game.dimension = 'overworld'
  const sent = env.bot.blockAt
  env.bot.blockAt = (pos) => {
    const p = pos.floored()
    const b = p.x === 0 && p.y === 100 && p.z === 0 ? block('water', 9, 'empty')([p.x, p.y, p.z]) : sent(p)
    return { ...b, light: 0, skyLight: b.name === 'air' && p.y < 80 ? 15 : 0 }
  }
  const sky = (y) => env.heldLight(new Vec3(0, y, 0), env.bot.blockAt(new Vec3(0, y, 0))).skyLight
  assert.deepStrictEqual([sky(101), sky(100), sky(99)], [15, 14, 13])
})

test('a fence, gate or wall on open ground lets the sky through to the floor beneath it', () => {
  // A modern server sends no sky light this high and marks these blocks opaque, though light crosses them undimmed.
  const beneath = (name) => {
    const env = world({ open: (x, y) => y >= 64, light: () => 0 })
    env.bot.game.dimension = 'overworld'
    env.bot.registry = { blocks: { ...REGISTRY.blocks, 10: { emitLight: 0, filterLight: name === 'stone' ? 15 : 0 } } }
    const sent = env.bot.blockAt
    env.bot.blockAt = (pos) => (pos.floored().equals(new Vec3(0, 64, 0)) ? { ...block(name, 10, 'block')([0, 64, 0]), light: 0, skyLight: 0 } : sent(pos))
    const { heldLight, onSurface } = loadBotFunctions(['heldLight', 'onSurface'], env)
    const post = new Vec3(0, 64, 0)
    const floor = new Vec3(0, 63, 0)
    return [heldLight(post, env.bot.blockAt(post)).skyLight, onSurface(floor, env.bot.blockAt(floor))]
  }
  assert.deepStrictEqual(beneath('stone'), [0, false], 'control: a block light does not cross')
  for (const name of ['oak_fence', 'oak_fence_gate', 'cobblestone_wall']) assert.deepStrictEqual(beneath(name), [15, true], name)
})

// Open sky over ground at y 63, cut by a ravine at x 3..12 with its floor block at y floor, the body at x = at.
function ravine (floor, at = 0) {
  const env = world({ open: (x, y) => y > (x >= 3 && x <= 12 ? floor : 63), light: () => LIT, skyLight: () => 15, at })
  env.bot.registry = REGISTRY
  return env
}

test('a ravine floor 20 down shows in lit sight or from memory', () => {
  const known = (env) => loadBotFunctions(['knownCell'], env).knownCell(new Vec3(10, 44, 0))
  assert.strictEqual(known(ravine(43)), false, 'control: from the ground away from the edge')
  assert.strictEqual(known(ravine(43, 2)), true, 'at the edge, looking down')
  const seen = ravine(43)
  seen.SEEN.add(ck(10, 44, 0))
  assert.strictEqual(known(seen), true, 'seen earlier')
})

// Ground at y 63 under open sky, at y 83 where high(x, z) and deep below 63 where low(x, z), unloaded where unloaded(x).
function relief ({ high = () => false, low = () => false, deep = 20, unloaded = () => false }) {
  const top = (x, z) => (high(x, z) ? 83 : low(x, z) ? 63 - deep : 63)
  const env = world({ open: (x, y, z) => y > top(x, z), light: () => LIT, skyLight: () => 15 })
  const loaded = env.bot.blockAt
  env.bot.blockAt = (p) => (unloaded(p.x) ? null : loaded(p))
  env.bot.registry = REGISTRY
  return env
}
// knownCell of cells at z 100, out of sight of the body at 0,64,0.
const knownFar = (env, cells) => {
  const { knownCell, cellKnown } = loadBotFunctions(['knownCell', 'cellKnown'], env)
  return cells.map(([x, y]) => {
    assert.strictEqual(cellKnown(new Vec3(x, y, 100)), false, `control: ${x},${y},100 out of sight`)
    return knownCell(new Vec3(x, y, 100))
  })
}

test('out of sight the surface is known beside a cliff 20 high and on a ravine floor 10 down, never in a trench 20 deep', () => {
  assert.deepStrictEqual({
    cliffFoot: knownFar(relief({ high: (x) => x <= -5 }), [[-4, 64], [-4, 63]]),
    shallowRavine: knownFar(relief({ low: (x) => x >= 3 && x <= 12, deep: 10 }), [[10, 54], [10, 53]]),
    ravineAlongZ: knownFar(relief({ low: (x) => x >= 0 && x <= 2 }), [[1, 44], [1, 43], [0, 44]]),
    ravineAlongX: knownFar(relief({ low: (x, z) => z >= 99 && z <= 101 }), [[1, 44], [1, 43]]),
    widestRavine: knownFar(relief({ low: (x) => x >= 0 && x <= 14 }), [[7, 44], [7, 43]]),
    valley: knownFar(relief({ high: (x) => x <= -10 || x >= 10 }), [[0, 64], [0, 63]])
  }, {
    cliffFoot: [true, true],
    shallowRavine: [true, true],
    ravineAlongZ: [false, false, false],
    ravineAlongX: [false, false],
    widestRavine: [false, false],
    valley: [true, true]
  })
})

test('an unloaded column hides the surface only where it could hold the far wall of a trench', () => {
  const unloaded = (x) => x <= -3
  assert.deepStrictEqual(knownFar(relief({ unloaded }), [[0, 64]]), [true], 'open ground')
  assert.deepStrictEqual(knownFar(relief({ unloaded, low: (x) => x >= -2 && x <= 2 }), [[1, 44]]), [false], 'a ravine floor below its east wall')
})

test('a field stays on the surface in a world from y 0 to 255 that holds no block outside it', () => {
  const env = relief({})
  const loaded = env.bot.blockAt
  env.bot.blockAt = (p) => (p.y < 0 || p.y > 255 ? null : loaded(p))
  env.bot.game = { minY: 0, height: 256 }
  assert.deepStrictEqual(knownFar(env, [[0, 64], [0, 63]]), [true, true])
})

const fireAt = block('fire', 7, 'empty')
const lavaAt = (level) => (p) => ({ ...block('lava', 8, 'empty')(p), stateId: 80 + level, getProperties: () => ({ level: String(level) }) })

test('fire and flowing lava relight nothing, a placed torch or lava source lights its falloff', () => {
  // A dark field, the cell at 0,64,0 changing from what was to what is.
  const after = (was, is) => {
    const env = wireLight(world({ open: (x, y) => y >= 64, light: () => 0 }))
    const base = env.bot.blockAt
    let reads = 0
    env.bot.blockAt = (p) => { reads++; return base(p) }
    env.bot.emit('blockUpdate', was([0, 64, 0]), is([0, 64, 0]))
    const at = new Vec3(3, 64, 0)
    return { light: env.heldLight(at, base(at)).light, reads }
  }
  for (const [was, is, what] of [[airAt, fireAt, 'fire flaring up'], [fireAt, airAt, 'fire going out'], [lavaAt(2), lavaAt(3), 'lava flowing']]) {
    const { light, reads } = after(was, is)
    assert.strictEqual(light, 0, what)
    assert.ok(reads < 20, `${what} read ${reads} cells`)
  }
  assert.strictEqual(after(airAt, torchAt).light, 11, 'control: a torch')
  assert.strictEqual(after(airAt, lavaAt(0)).light, 12, 'a lava source poured from a bucket')
})

test('ore under lava or more than three cells of water is not named', () => {
  const room = (over) => {
    const env = world({ open: (x, y, z) => z === 0 && (y === 64 || y === 65) && x >= 0 && x <= 3, ores: { '1,63,0': 'diamond_ore' }, light: () => LIT })
    return over ? withCells(env, { '1,64,0': over }) : env
  }
  const diamonds = (env) => runRoute('/find', { name: 'diamond' }, env)
  assert.strictEqual(diamonds(room(null)).count, 1, 'control: under air')
  const lava = diamonds(room(LAVA))
  assert.strictEqual(lava.count, 0)
  assert.doesNotMatch(JSON.stringify(lava), /diamond_ore/)
  // A tunnel to the coal with len cells of water from x 1.
  const flooded = (len) => withCells(tunnel(len + 1, LIT), Object.fromEntries([64, 65].flatMap((y) => Array.from({ length: len }, (_, i) => [`${i + 1},${y},0`, still(LIT)]))))
  assert.strictEqual(findsCoal(flooded(3)), true, 'control: three cells of water')
  assert.strictEqual(findsCoal(flooded(4)), false)
})

test('a mob shows only as far as the light at its feet carries', () => {
  const seen = (x, light) => {
    const env = tunnel(20, light)
    const fill = { cells: new Set(Array.from({ length: 20 }, (_, i) => ck(i, 64, 0))) }
    const { entityPerceptible } = loadBotFunctions(['entityPerceptible'], env)
    return entityPerceptible({ type: 'mob', name: 'zombie', position: new Vec3(x + 0.5, 64, 0.5), metadata: [0] }, fill)
  }
  assert.strictEqual(seen(4, 1), true, 'light 1, 4 blocks out')
  assert.strictEqual(seen(5, 1), false, 'light 1, 5 blocks out')
  assert.strictEqual(seen(15, 7), true, 'light 7, 15 blocks out')
})

test('a mob behind a closed door is out of sight, behind an open one in sight', () => {
  // A lit corridor along x on y 64-65 with the door at x 4 and the zombie at x 6.
  const seen = (name, open) => {
    const door = { name, boundingBox: 'block', light: LIT, getProperties: () => ({ open }) }
    const corridor = world({ open: (x, y, z) => z === 0 && (y === 64 || y === 65) && x >= 0 && x <= 8, light: () => LIT })
    const env = withCells(corridor, { '4,64,0': door, '4,65,0': door })
    const { airFlood, entityPerceptible } = loadBotFunctions(['airFlood', 'entityPerceptible'], env)
    return entityPerceptible({ type: 'mob', name: 'zombie', position: new Vec3(6.5, 64, 0.5), metadata: [0] }, airFlood({ radius: 28, cap: 15000 }))
  }
  for (const name of ['oak_door', 'oak_fence_gate']) {
    assert.strictEqual(seen(name, true), true, `control: an open ${name}`)
    assert.strictEqual(seen(name, false), false, name)
  }
})

// A lit tunnel from the body east to x 4, south to z 6, east to x 10 and north back to its end at 10,64,0:
// 22 cells by the walk, 10 by the eye with rock between.
const windingOpen = (x, y, z) => (y === 64 || y === 65) &&
  ((z === 0 && x >= 0 && x <= 4) || (x === 4 && z >= 0 && z <= 6) || (z === 6 && x >= 4 && x <= 10) || (x === 10 && z >= 0 && z <= 6))

test('entities name a lit mob down a winding tunnel only once the bot has seen the tunnel', () => {
  const listed = (seen) => {
    const env = world({ open: windingOpen, light: () => LIT })
    if (seen) for (let x = 0; x <= 10; x++) for (let z = 0; z <= 6; z++) for (const y of [64, 65]) if (windingOpen(x, y, z)) env.SEEN.add(ck(x, y, z))
    env.bot.entities = { 1: { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(10.5, 64, 0.5), metadata: [0] } }
    Object.assign(env, { staleEntities: new Set(), round: (v) => v, reflexes: [] })
    loadBotFunctions(['airFlood', 'knownCell'], env)
    env.reflexes.push(combatReflexIn(env))
    return runRoute('/entities', {}, env)
  }
  assert.deepStrictEqual(listed(true).entities.map((e) => e.name), ['zombie'], 'control: the tunnel seen')
  const unseen = listed(false)
  assert.strictEqual(unseen.count, 0)
  assert.doesNotMatch(JSON.stringify(unseen), /zombie|10\.5/)
})

test('a mob is heard through shared known air within 20 blocks, beyond only on a clear eye ray', () => {
  // A seen lit tunnel east to x 4, south to z 6, east to x far and north back to the zombie at far,64,0,
  // far blocks from the body with rock between, or a straight seen lit corridor to it.
  const perceptible = (far, straight) => {
    const open = straight
      ? (x, y, z) => (y === 64 || y === 65) && z === 0 && x >= 0 && x <= far
      : (x, y, z) => (y === 64 || y === 65) &&
        ((z === 0 && x >= 0 && x <= 4) || (x === 4 && z >= 0 && z <= 6) || (z === 6 && x >= 4 && x <= far) || (x === far && z >= 0 && z <= 6))
    const env = world({ open, light: () => LIT })
    for (let x = 0; x <= far; x++) for (let z = 0; z <= 6; z++) for (const y of [64, 65]) if (open(x, y, z)) env.SEEN.add(ck(x, y, z))
    env.reflexes = []
    loadBotFunctions(['airFlood', 'knownCell', 'entityPerceptible'], env)
    const combat = combatReflexIn(env)
    return env.entityPerceptible({ type: 'mob', name: 'zombie', position: new Vec3(far + 0.5, 64, 0.5), metadata: [0] }, combat.fairFill(env.bot))
  }
  assert.strictEqual(perceptible(18, false), true, 'control: 18 blocks through the tunnel')
  assert.strictEqual(perceptible(25, false), false, '25 blocks through the tunnel')
  assert.strictEqual(perceptible(25, true), true, '25 blocks down a straight corridor')
})

test('collect finds a drop in sight in a lit room, never one around the corner', () => {
  // A lit room east along z 0 to x 4 that turns south at x 4 to z 4.
  const drop = (x, y, z) => {
    const env = world({ open: (cx, cy, cz) => (cy === 64 || cy === 65) && ((cz === 0 && cx >= 0 && cx <= 4) || (cx === 4 && cz >= 0 && cz <= 4)), light: () => LIT })
    const item = { id: 1, name: 'item', position: new Vec3(x, y, z) }
    env.bot.entities = { 1: item }
    env.staleEntities = new Set()
    return loadBotFunctions(['nearestDrop'], env).nearestDrop(8, new Set()) === item
  }
  assert.strictEqual(drop(3.5, 64, 0.5), true, 'control: in sight')
  assert.strictEqual(drop(3.5, 63.85, 0.5), true, 'in sight, sunk into the floor')
  assert.strictEqual(drop(4.5, 64, 3.5), false)
})

test('the veins of scene name ore in lit sight, never ore around a corner or in the dark', () => {
  const veins = (light, at) => {
    const env = { ...cave(light, at), VEIN_SENSE_R: botConstant('VEIN_SENSE_R') }
    return loadBotFunctions(['veinScan'], env).veinScan(env.bot)
  }
  assert.strictEqual(veins(LIT), 'coal W ~1', 'control: in sight')
  assert.strictEqual(veins(DARK, FAR_END), null)
})

test('the ore callout announces ore in lit sight, never ore around a corner or in the dark', () => {
  const callouts = (light, at) => {
    const events = []
    const env = { ...cave(light, at), ORE_IDS: [1, 2], ORE_ANNOUNCED: new Map(), sameVein, emitEvent: (kind, msg) => events.push(msg) }
    loadBotFunctions(['oreCallout'], env).oreCallout()
    return events
  }
  const lit = callouts(LIT)
  assert.deepStrictEqual(lit.map((e) => e.split(' ')[0]), ['coal_ore'], 'control: in sight')
  hidden(lit)
  assert.deepStrictEqual(callouts(DARK, FAR_END), [])
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

test('section in total darkness names no ore and no air past two blocks', () => {
  const body = runRoute('/section', { dir: 'w' }, { ...cave(DARK, FAR_END), sectionColumns, floorPhrase })
  assert.deepStrictEqual(body.ores, [])
  // Columns d -2..len west along y 65: the wall at d -1, the room at d 1..3, the coal at d 4.
  const row = body.grid.split('\n').find((r) => r.startsWith('y 65')).slice(5)
  assert.strictEqual(row.slice(0, 7), '?#@  ??')
})

// A corridor at z 0, y 64..65 east from x 0 to 9 at light level light, or with bend, a room at
// x 0..3 and a lit passage on south at x 3 from z 1 to 9.
function corridor (light, bend = false) {
  const open = (x, y, z) => (y === 64 || y === 65) &&
    (bend ? (z === 0 && x >= 0 && x <= 3) || (x === 3 && z >= 1 && z <= 9) : z === 0 && x >= 0 && x <= 9)
  return world({ open, light: (x, z) => (z >= 1 ? 15 : light) })
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

test('passages gives no exit at a seen cell that only an unseen dark stretch reaches', () => {
  const env = corridor(DARK)
  env.SEEN.add(ck(8, 64, 0)).add(ck(8, 65, 0))
  const body = runRoute('/passages', { radius: '8' }, env)
  assert.strictEqual(body.summary, 'no exit in sight within 8 blocks')
  assert.deepStrictEqual(body.exits, {})
})

test('passages calls a pocket closed only when the bot has seen its walls', () => {
  const room = () => world({ open: (x, y, z) => z === 0 && x >= 0 && x <= 3 && (y === 64 || y === 65), light: () => DARK })
  const seen = room()
  for (let x = -1; x <= 4; x++) for (let y = 63; y <= 66; y++) for (let z = -1; z <= 1; z++) seen.SEEN.add(ck(x, y, z))
  assert.match(runRoute('/passages', { radius: '8' }, seen).summary, /^closed pocket/, 'control: every wall seen')
  assert.strictEqual(runRoute('/passages', { radius: '8' }, room()).summary, 'no exit in sight within 8 blocks')
})

// The walk into reach moves the body to walkTo.
function withHands (env, walkTo = null) {
  const base = env.bot.blockAt
  env.bot.blockAt = (p) => ({ ...base(p), getProperties: () => ({ lit: false }) })
  Object.assign(env.bot, {
    heldItem: null,
    inventory: { items: () => [] },
    pathfinder: { goto: async () => { if (walkTo) env.bot.entity.position = walkTo } },
    lookAt: async () => {},
    waitForTicks: async () => {},
    activateBlock: async () => {},
    activateItem () {},
    deactivateItem () {}
  })
  return Object.assign(env, { require, round: (v) => ({ x: v.x, y: v.y, z: v.z }), goals: { GoalNear: class {} } })
}

const UNSEEN = /not in my sight, blocked or unlit/

test('digat digs a block in lit sight, never one seen before and dark now, around a corner or in the dark', async () => {
  const digat = async (env, at) => {
    const acts = []
    withHands(env)
    const base = env.bot.blockAt
    env.bot.blockAt = (p) => ({ ...base(p), digTime: () => 750 })
    env.bot.pathfinder.goto = async () => { acts.push('walk') }
    Object.assign(env.bot, { equip: async () => { acts.push('equip') }, dig: async () => { acts.push('dig') } })
    Object.assign(env, { bunker: { building: false }, PICK_TIER: botConstant('PICK_TIER'), DIG_TOOL: botConstant('DIG_TOOL') })
    const { handle, res } = routeHandler('/digat', env)
    await handle({ query: at }, res)
    return { body: res.body, error: res.error, acts }
  }
  const coal = { x: '-1', y: '65', z: '0' }
  const lit = await digat(cave(LIT), coal)
  assert.strictEqual(lit.body.dug, 'coal_ore', 'control: in sight')
  assert.deepStrictEqual(lit.acts, ['dig'])
  const remembered = cave(DARK, FAR_END)
  remembered.SEEN.add(ck(-1, 65, 0))
  for (const [env, at] of [[cave(LIT), { x: '7', y: '66', z: '0' }], [cave(DARK, FAR_END), coal], [remembered, coal]]) {
    const r = await digat(env, at)
    assert.match(r.error.message, UNSEEN)
    assert.doesNotMatch(r.error.message, /iron|coal|ore/)
    assert.strictEqual(r.body, undefined)
    assert.deepStrictEqual(r.acts, [], 'no walk, equip or dig')
  }
})

test('activate presses a block in lit sight and gives its state only while it stays in sight', async () => {
  const activate = async (env, at) => {
    const { handle, res } = routeHandler('/activate', env)
    await handle({ query: at }, res)
    return { body: res.body && JSON.parse(JSON.stringify(res.body)), error: res.error }
  }
  const coal = { x: '-1', y: '65', z: '0' }
  assert.deepStrictEqual((await activate(withHands(cave(LIT)), coal)).body, { activated: 'coal_ore', at: { x: -1, y: 65, z: 0 }, properties: { lit: false } }, 'control: in sight')
  assert.match((await activate(withHands(cave(DARK, FAR_END)), coal)).error.message, UNSEEN)
  const away = await activate(withHands(cave(LIT, FAR_END), new Vec3(6.5, 64, 0.5)), coal)
  assert.deepStrictEqual(away.body, { activated: 'coal_ore', at: { x: -1, y: 65, z: 0 } }, 'the walk went round the corner')
})

test('blockat answers the cells the body fills and touches in the dark, never a cell two away or diagonal', () => {
  const blockat = (env, [x, y, z]) => {
    const { handle, res } = routeHandler('/blockat', env)
    handle({ query: { x: String(x), y: String(y), z: String(z) } }, res)
    return { body: res.body && JSON.parse(JSON.stringify(res.body)), error: res.error }
  }
  // A passage north through stone that ends at the feet, coal beside the feet, iron in the floor two cells
  // ahead, diamond diagonal to the feet and open only to a pocket east of it.
  const passage = (light, cells = {}) => withHands(withCells(world({
    open: (x, y, z) => (x === 0 && z >= -3 && z <= 0 && (y === 64 || y === 65)) || (x === 2 && y === 64 && z === 1),
    ores: { '1,64,0': 'coal_ore', '0,63,-2': 'iron_ore', '1,64,1': 'diamond_ore' },
    light: () => light
  }), cells))
  const DOOR = { name: 'oak_door', boundingBox: 'block', light: 0 }
  const doorway = (light) => passage(light, { '0,64,0': DOOR, '0,65,0': DOOR })
  for (const cell of [[0, 63, 0], [0, 64, 0], [0, 66, 0], [1, 64, 0], [1, 65, 0]]) {
    const r = blockat(doorway(DARK), cell)
    assert.strictEqual(r.error, undefined, `${cell}: ${r.error && r.error.message}`)
    assert.deepStrictEqual(r.body.at, { x: cell[0], y: cell[1], z: cell[2] })
  }
  assert.strictEqual(blockat(doorway(DARK), [0, 64, 0]).body.name, 'oak_door', 'the door the feet stand in')
  assert.strictEqual(blockat(doorway(DARK), [1, 64, 0]).body.name, 'coal_ore', 'the wall beside the feet')
  assert.strictEqual(blockat(passage(LIT), [0, 63, -2]).body.name, 'iron_ore', 'control: two away in the light')
  for (const cell of [[0, 63, -2], [1, 64, 1]]) {
    const r = blockat(passage(DARK), cell)
    assert.match(r.error.message, UNSEEN, String(cell))
    assert.strictEqual(r.body, undefined, String(cell))
    assert.doesNotMatch(r.error.message, /iron|diamond|ore/, String(cell))
  }
})

// env with the blocks at the 'x,y,z' keys of cells in place of its own.
function withCells (env, cells) {
  const base = env.bot.blockAt
  env.bot.blockAt = (p) => {
    const c = cells[ck(p.x, p.y, p.z)]
    return c ? { position: new Vec3(p.x, p.y, p.z), skyLight: 0, ...c } : base(p)
  }
  return env
}


test('the lava watch fires on lava in sight, never on lava sealed in rock or behind a wall', () => {
  const watch = (cells) => {
    const env = withCells(cave(LIT), cells)
    const r = reflexIn('lava_watch', env)
    return r.check(env.bot) ? [r._hit.dir, r._hit.d] : null
  }
  assert.deepStrictEqual(watch({ '2,64,0': LAVA }), ['E', 2], 'control: lava in the room')
  assert.strictEqual(watch({ '2,64,-2': LAVA }), null, 'sealed in rock')
  assert.strictEqual(watch(behindWall(LAVA)), null, 'behind the wall')
})

// The lava watch over cells with the body at x 2 of the lit room: its event and the goal it walks to, or null when it stays quiet.
async function lavaWatch (cells) {
  const events = []
  let goal = null
  const env = {
    ...withCells(cave(LIT, 2), cells),
    bunker: { building: false },
    takeLegs () {},
    stopPath () {},
    emitEvent: (kind, msg) => events.push(msg),
    goals: { GoalNear: class { constructor (x, y, z, range) { Object.assign(this, { x, y, z, range }) } } }
  }
  env.bot.pathfinder = { setGoal: (g) => { goal = g } }
  const r = reflexIn('lava_watch', env)
  if (!r.check(env.bot)) return null
  await r.act(env.bot)
  return { event: events[0], goal }
}

test('the lava watch backs away from the nearest lava in sight', async () => {
  const { event, goal } = await lavaWatch({ '0,64,0': LAVA, '3,64,0': LAVA })
  assert.match(event, /^LAVA E ~1 /)
  assert.strictEqual(goal.x, 2.5 - 3, 'three blocks west, away from the lava 1 east')
})

test('the lava watch names lava in the body column as above, below or here', async () => {
  for (const [cell, dir] of [['2,64,0', 'here'], ['2,65,0', 'here'], ['2,63,0', 'below'], ['2,66,0', 'above']]) {
    const { event } = await lavaWatch({ [cell]: LAVA })
    assert.match(event, new RegExp(`^LAVA ${dir} ~0 `), cell)
  }
})

test('the ore callout names ore straight above or below the body as above or below', () => {
  const callout = (cell) => {
    const events = []
    const env = {
      ...world({ open: (x, y, z) => z === 0 && x >= 0 && x <= 3 && (y === 64 || y === 65), ores: { [cell]: 'coal_ore' }, light: () => LIT }),
      ORE_IDS: [1],
      ORE_ANNOUNCED: new Map(),
      sameVein,
      emitEvent: (kind, msg) => events.push(msg)
    }
    loadBotFunctions(['oreCallout'], env).oreCallout()
    return events
  }
  assert.match(callout('0,66,0')[0], /^coal_ore in view above ~\d+ \(y66\)$/)
  assert.match(callout('0,63,0')[0], /^coal_ore in view below ~\d+ \(y63\)$/)
})

test('the current watch fires on a current in lit sight or around the body, never on one behind a wall or in the dark', () => {
  const watch = (light, cells) => {
    const env = withCells(cave(light), cells)
    const r = reflexIn('current_watch', env)
    return r.check(env.bot) ? [r._dir, r._dist] : null
  }
  assert.deepStrictEqual(watch(LIT, { '2,64,0': current(LIT) }), ['E', 2], 'control: in lit sight')
  assert.strictEqual(watch(LIT, behindWall(current(LIT))), null, 'behind the wall')
  assert.strictEqual(watch(DARK, { '3,64,0': current(DARK) }), null, 'in the dark')
  assert.deepStrictEqual(watch(DARK, { '0,64,0': current(DARK) }), ['here', 0], 'around the feet in the dark')
  assert.deepStrictEqual(watch(LIT, { '0,63,0': current(LIT) }), ['below', 0], 'under the feet')
})

test('the current watch never takes a filled water cauldron for a current', () => {
  const fires = (block) => {
    const env = withCells(cave(LIT), { '1,64,0': block })
    return reflexIn('current_watch', env).check(env.bot)
  }
  assert.strictEqual(fires(current(LIT)), true, 'control: a current')
  assert.strictEqual(fires({ name: 'water_cauldron', boundingBox: 'block', light: LIT, metadata: 2 }), false)
})

test('the trek scans ahead along the way the body moves', async () => {
  const env = cave(LIT)
  let yaw = null
  Object.assign(env, {
    raySweep: (opts) => { yaw = opts.yaw; return { hits: [] } },
    terrainClass: () => 'stone',
    compass: () => 'N',
    emitEvent () {}
  })
  const trek = reflexIn('trek', env)
  trek._lastPos = env.bot.entity.position.offset(0, 0, 30)
  await trek.act(env.bot)
  const ahead = loadBotFunctions(['lookVec'], env).lookVec(yaw, 0)
  assert.ok(ahead.z < -0.99, `moving north the scan looks north, got ${ahead}`)
})

// A one-cell shaft up to y roof - 1, then stone to y 69 and open air from y 70.
function shaft (light, roof = 66) {
  return world({ open: (x, y, z) => (x === 0 && z === 0 && y >= 64 && y < roof) || y >= 70, light: () => light })
}

test('overhead cover counts and tops the rock only once the sky shows, and gives no height past unseen rock', () => {
  const cover = (env) => {
    const { overheadCover, skyPhrase } = loadBotFunctions(['overheadCover', 'skyPhrase'], env)
    const oh = overheadCover()
    return [JSON.parse(JSON.stringify(oh)), skyPhrase(oh)]
  }
  const seenToSky = shaft(LIT)
  for (let y = 66; y <= 320; y++) seenToSky.SEEN.add(ck(0, y, 0))
  assert.deepStrictEqual(cover(seenToSky)[0], { sky: false, canopy: false, firstUp: 1, cover: 4, topY: 69 }, 'control: the column seen to the sky')
  const [oh, phrase] = cover(shaft(LIT))
  assert.deepStrictEqual(oh, { sky: false, canopy: false, firstUp: 1 })
  assert.doesNotMatch(phrase, /cover|top|~y|69|70/)
  assert.deepStrictEqual(cover(shaft(DARK, 68)), [{ sky: false, unseen: true }, 'Overhead unseen. '], 'rock 2.4 blocks over the eye')
  const open = world({ open: (x, y, z) => x === 0 && z === 0 && y >= 64, light: () => LIT, skyLight: () => 15 })
  assert.deepStrictEqual(cover(open)[0], { sky: true }, 'sky light 15 at the head')
})

test('the walked trail marks only what the body fills and sees by its light, never a cell behind a wall', () => {
  const trail = (light) => {
    const env = withCells(cave(light), behindWall(AIR))
    env.markSeen = (x, y, z) => env.SEEN.add(ck(x, y, z))
    loadBotFunctions(['markTrail'], env).markTrail(new Vec3(0, 64, 0))
    return env.SEEN
  }
  const lit = trail(LIT)
  assert.ok(lit.has('3,64,0') && lit.has('2,63,0'), 'control: the room and its floor in sight')
  assert.ok(!lit.has('2,64,-2') && !lit.has('1,64,-2'), 'the pocket behind the wall')
  const dark = trail(DARK)
  assert.ok(dark.has('0,64,0') && dark.has('0,65,0') && dark.has('1,64,0'), 'the body and the cells within two blocks')
  assert.ok(!dark.has('3,64,0') && !dark.has('2,63,0'), 'past two blocks')
})

// The gaze reply of a body looking north from 0,64,0 over env, and the cells it marked seen.
function gaze (env) {
  env.bot.entity.pitch = 0
  Object.assign(env, { markSeen: (x, y, z) => env.SEEN.add(ck(x, y, z)), DARK_RAY: botConstant('DARK_RAY') })
  return { reply: runRoute('/gaze', {}, env), seen: env.SEEN }
}

// The 'x,y,z' keys whose cell lies more than d blocks from the eye of a body at 0,64,0.
const fartherThan = (keys, d) => [...keys].filter((k) => {
  const [x, y, z] = k.split(',').map(Number)
  const gap = (v, lo) => Math.max(lo - v, 0, v - lo - 1)
  return Math.hypot(gap(0.5, x), gap(65.62, y), gap(0.5, z)) > d
})

const cavern = (light) => world({ open: (x, y, z) => Math.abs(x) <= 6 && Math.abs(z) <= 6 && y >= 64 && y <= 70, light: () => light })

test('gaze names nothing it would see only in total darkness, and says it is too dark', () => {
  const lit = gaze(cavern(LIT))
  assert.match(lit.reply.summary, /stone/, 'control: lit')
  const dark = gaze(cavern(DARK))
  assert.deepStrictEqual([dark.reply.surfaces, dark.reply.openings], [[], []])
  assert.deepStrictEqual(fartherThan(dark.seen, 2), [], 'no cell past the two blocks light 0 shows')
  assert.doesNotMatch(dark.reply.summary, /stone|coal|open space/)
  assert.match(dark.reply.summary, /too dark to see/)
})

test('gaze at the edge of the loaded world in the dark says too dark, not open space', () => {
  const edge = (light) => {
    const env = world({ open: () => true, light: () => light })
    const base = env.bot.blockAt
    env.bot.blockAt = (p) => (p.z < -3 ? null : base(p))
    return gaze(env).reply.summary
  }
  assert.match(edge(LIT), /open space/, 'control: lit')
  const dark = edge(DARK)
  assert.doesNotMatch(dark, /open space/)
  assert.match(dark, /too dark to see/)
})

test('a line through the seam where two blocks meet at an edge sees nothing behind it', () => {
  // Lit open ground with stone at 1,y,0 and 0,y,1 for y 64..66, the body at 0,64,0.
  const env = world({ open: (x, y, z) => y >= 64 && !(y <= 66 && x + z === 1 && x * z === 0), light: () => LIT })
  Object.assign(env, { markSeen: (x, y, z) => env.SEEN.add(ck(x, y, z)), DARK_RAY: botConstant('DARK_RAY') })
  const { castRay, lookVec, entityPerceptible } = loadBotFunctions(['castRay', 'lookVec', 'entityPerceptible'], env)
  const behind = () => [...env.SEEN].filter((k) => { const [x, , z] = k.split(',').map(Number); return x >= 1 && z >= 1 })
  assert.strictEqual(castRay(lookVec(Math.PI / 4, 0), 24), null, 'control: open ground to the north-west')
  assert.ok(env.SEEN.has('-2,65,-2'), 'control: the ground it crossed')
  assert.strictEqual(castRay(lookVec(-3 * Math.PI / 4, 0), 24).name, 'stone')
  assert.deepStrictEqual(behind(), [])
  const zombie = (x, z) => entityPerceptible({ type: 'mob', name: 'zombie', position: new Vec3(x, 64, z), metadata: [0] }, { cells: new Set() })
  assert.strictEqual(zombie(-2.5, -2.5), true, 'control: a zombie to the north-west')
  assert.strictEqual(zombie(3.5, 3.5), false)
})

const LADDER = { name: 'ladder', boundingBox: 'block', light: LIT }
const doorAt = (open) => ({ name: 'oak_door', boundingBox: 'block', light: LIT, getProperties: () => ({ open }) })

test('a block shows through an open door or a ladder, never through a closed door', () => {
  const through = (cell) => findsCoal(withCells(tunnel(4, LIT), { '2,64,0': cell, '2,65,0': cell }))
  assert.strictEqual(through(doorAt(true)), true, 'open door')
  assert.strictEqual(through(LADDER), true, 'ladder')
  assert.strictEqual(findsCoal(withCells(tunnel(4, LIT), { '0,64,0': LADDER, '0,65,0': LADDER })), true, 'a ladder the body stands on')
  assert.strictEqual(through(doorAt(false)), false)
})

test('a lit floor indoors shows through a closed fence gate or a fence, never through a wall', () => {
  // A lit corridor under rock along z 0, blocked at x 3, with the floor cell 6,63,0 beyond.
  const through = (cell) => {
    const env = withCells(world({ open: (x, y, z) => z === 0 && (y === 64 || y === 65) && x >= 0 && x <= 8, light: () => LIT }), { '3,64,0': cell, '3,65,0': cell })
    return loadBotFunctions(['knownCell'], env).knownCell(new Vec3(6, 63, 0))
  }
  const post = (name) => ({ name, boundingBox: 'block', light: LIT, getProperties: () => ({ open: false }) })
  assert.strictEqual(through(AIR), true, 'control: nothing in the way')
  assert.strictEqual(through(post('oak_fence_gate')), true, 'closed fence gate')
  assert.strictEqual(through(post('oak_fence')), true, 'fence')
  assert.strictEqual(through(post('cobblestone_wall')), false)
})

test('an unloaded cell between the body and a block hides the block', () => {
  const env = tunnel(5, LIT)
  assert.strictEqual(findsCoal(env), true, 'control: every cell loaded')
  const base = env.bot.blockAt
  env.bot.blockAt = (p) => (p.x === 2 ? null : base(p))
  assert.strictEqual(findsCoal(env), false)
})

// A lit room at x 0..3, z 0 and a pocket at x 0..2, z -2 that one cell of stone seals off from it.
const besidePocket = (ores = {}) => world({ open: (x, y, z) => (y === 64 || y === 65) && ((z === 0 && x >= 0 && x <= 3) || (z === -2 && x >= 0 && x <= 2)), ores, light: () => LIT })

// The narrator's console lines and the pulse reply after a zombie at cell x, 64, z joins the scene of env,
// with a skeleton at cell [x, z] of known in it from the start.
function pulseWithZombie (env, x, z, known = null) {
  const lines = []
  Object.assign(env.bot, { entities: {}, health: 20, food: 20 })
  Object.assign(env, {
    reflexes: [],
    staleEntities: new Set(),
    HOSTILE_NAMES: botConstant('HOSTILE_NAMES'),
    pulseLog: [],
    streams: { pulseSeq: 0 },
    console: { log: (line) => lines.push(line) }
  })
  loadBotFunctions(['airFlood', 'knownCell'], env)
  env.reflexes.push(combatReflexIn(env))
  const narrator = reflexIn('narrator', env)
  if (known) env.bot.entities[2] = { id: 2, type: 'hostile', name: 'skeleton', position: new Vec3(known[0] + 0.5, 64, known[1] + 0.5), metadata: [0] }
  assert.strictEqual(narrator.check(env.bot), false, 'control: the first pulse seeds the baseline')
  env.bot.entities[1] = { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(x + 0.5, 64, z + 0.5), metadata: [0] }
  if (narrator.check(env.bot)) narrator.act()
  return [...lines, JSON.stringify(runRoute('/pulse', {}, env))].join('\n')
}

test('the narrator and pulse name a hostile in shared air, never one sealed behind rock', () => {
  assert.match(pulseWithZombie(besidePocket(), 3, 0), /hostile zombie E ~3/, 'control: in the room')
  assert.doesNotMatch(pulseWithZombie(besidePocket(), 1, -2), /zombie/)
})

test('the narrator names the hostile that just appeared, not a nearer one already in view', () => {
  assert.match(pulseWithZombie(besidePocket(), 3, 0, [1, 0]), /hostile zombie E ~3/)
})

// The world events after the cells at [x, y, z] in env turn from the from block (dirt) to the to block (farmland).
function tilled (env, cells, from = block('dirt', 3, 'block'), to = block('farmland', 3, 'block')) {
  const events = []
  Object.assign(env, { recentOwnEdits: new Map(), changeBuf: [], lastChangeEmit: 0, ambientChange, emitEvent: (kind, msg) => events.push(msg) })
  const { noteWorldChange, worldChangeEvent } = loadBotFunctions(['noteWorldChange', 'worldChangeEvent'], env)
  for (const p of cells) noteWorldChange(from(p), to(p))
  worldChangeEvent()
  return events
}

test('a block change in a sealed room beside the bot raises no world event, the same change in sight does', () => {
  const room = [2, 63, 0]
  const pocket = [1, 63, -2]
  assert.deepStrictEqual(tilled(besidePocket(), [room]), ['changed near me: dirt→farmland E ~2'], 'control: the room floor')
  assert.deepStrictEqual(tilled(besidePocket(), [pocket]), [])
  assert.deepStrictEqual(tilled(besidePocket(), [room, pocket]), ['changed near me: dirt→farmland E ~2'], 'both at once')
  assert.match(tilled(besidePocket(), [[2, 64, 1]], stoneAt, airAt).join(), /stone→air/, 'control: the room wall broken in sight')
  const seenEarlier = besidePocket()
  seenEarlier.SEEN.add(ck(1, 64, -3))
  assert.deepStrictEqual(tilled(seenEarlier, [[1, 64, -3]], stoneAt, airAt), [], 'a wall seen earlier and out of sight now')
})

test('a chest seen and then broken out of sight stays listed until the bot sees its cell again', () => {
  const ores = { '2,64,-2': 'chest' }
  const env = besidePocket(ores)
  Object.assign(env, {
    require,
    SEEN_CAP: 1000,
    SURFACE: new Map(),
    SURFACE_CAP: 1000,
    surfaceEdits: 0,
    ...stationMemory(),
    resolveBlockIds: (name) => (name === 'chest' ? [IDS.chest] : [])
  })
  const inRoom = env.bot.entity.position
  const inPocket = new Vec3(0.5, 64, -1.5)
  const { markTrail, knownChests, targetChest } = loadBotFunctions(['markTrail', 'knownChests', 'targetChest'], env)
  const listed = () => knownChests(12).map((c) => ck(c.pos.x, c.pos.y, c.pos.z))
  const at = { x: '2', y: '64', z: '-2' }
  env.bot.entity.position = inPocket
  markTrail(inPocket.floored())
  env.bot.entity.position = inRoom
  assert.deepStrictEqual(listed(), ['2,64,-2'], 'control: the chest stands')
  delete ores['2,64,-2']
  assert.deepStrictEqual(listed(), ['2,64,-2'])
  assert.deepStrictEqual(targetChest(at).cb.position, new Vec3(2, 64, -2))
  env.bot.entity.position = inPocket
  assert.deepStrictEqual(listed(), [])
  assert.throws(() => targetChest(at), { message: 'no chest at 2,64,-2 (air)' })
})

test('digat at a cell seen before and out of sight now walks there before it says the cell is air', async () => {
  // A lit room at x 0..3, z 0 and a lit pocket at x 0..6, z -2 that one cell of stone seals off from it.
  const pocket = () => world({ open: (x, y, z) => (y === 64 || y === 65) && ((z === 0 && x >= 0 && x <= 3) || (z === -2 && x >= 0 && x <= 6)), light: () => LIT })
  const digat = async (arrive) => {
    const env = pocket()
    env.SEEN.add(ck(6, 64, -2))
    const acts = []
    env.bot.pathfinder = { goto: async () => { acts.push('walk'); if (arrive) env.bot.entity.position = new Vec3(4.5, 64, -1.5) } }
    Object.assign(env, { bunker: { building: false }, require, round: (v) => ({ x: v.x, y: v.y, z: v.z }), goals: { GoalNear: function () {} } })
    const { handle, res } = routeHandler('/digat', env)
    await handle({ query: { x: '6', y: '64', z: '-2' } }, res)
    return { body: res.body, error: res.error, acts }
  }
  const there = await digat(true)
  assert.deepStrictEqual(JSON.parse(JSON.stringify([there.body, there.acts])), [{ already: 'air', at: { x: 6, y: 64, z: -2 } }, ['walk']])
  const short = await digat(false)
  assert.match(short.error.message, UNSEEN)
  assert.deepStrictEqual([short.body, short.acts], [undefined, ['walk']])
})

// The verbose scene reply as JSON and the boot summary over env, the senses besides the lay of the land and the sky stubbed.
function summaries (env) {
  Object.assign(env.bot, { health: 20, food: 20, heldItem: null, username: 'Bot', experience: { level: 0 }, inventory: { slots: [] } })
  const stubs = {
    require,
    round: (v) => v,
    shared: { ...env.shared, ready: true },
    sceneEntities: () => ({ threats: [], groups: {} }),
    resolveBlockIds: () => [],
    veinScan: () => null,
    waterState: () => null,
    hearSummary: () => null,
    doorsInSight: () => [],
    stepView: () => null,
    indoors: () => false,
    heldInfo: () => null,
    jobs: { list: () => [] },
    chatLog: { cursor: 0 },
    waypoints: { list: () => ({}) },
    reflexes: [{ name: 'combat', fairFill: () => ({ cells: new Set() }) }]
  }
  return [JSON.stringify(runRoute('/scene', { verbose: '1' }, { ...env, ...stubs })), runRoute('/boot', {}, { ...env, ...stubs }).summary]
}

// A lit room at x -3..3, z -3..3 on a stone floor over a lava lake at y 34, with a one-wide hole at x 2, z 0
// from the floor down to y bottom.
function roomOverLava (bottom) {
  const open = (x, y, z) => ((y === 64 || y === 65) && Math.abs(x) <= 3 && Math.abs(z) <= 3) ||
    (x === 2 && z === 0 && y >= bottom && y <= 63) || (y === 34 && Math.abs(x) <= 6 && Math.abs(z) <= 6)
  const env = world({ open, light: () => LIT })
  const base = env.bot.blockAt
  env.bot.blockAt = (p) => (p.y === 34 && open(p.x, p.y, p.z) ? { ...LAVA, position: new Vec3(p.x, p.y, p.z), skyLight: 0 } : base(p))
  return env
}

test('scene and boot name no lava and no depth down a shaft the bot cannot see into', () => {
  const [scene, boot] = summaries(roomOverLava(35))
  for (const s of [scene, boot]) assert.doesNotMatch(s, /LAVA|lava|~30/)
  assert.deepStrictEqual(summaries(roomOverLava(63)), [scene, boot], 'the shaft and the lake read unlike a hole one deep')
})

test('scene and boot report a drop on open ground the bot can see, with the lava at its foot', () => {
  // A plateau to x 2 above a lava pool at y 55 on a floor at y 54, all under open sky.
  const env = world({ open: (x, y) => y >= (x <= 2 ? 64 : 55), light: () => LIT, skyLight: () => 15 })
  env.bot.registry = REGISTRY
  const base = env.bot.blockAt
  env.bot.blockAt = (p) => (p.x >= 3 && p.y === 55 ? { ...LAVA, type: 8, position: new Vec3(p.x, p.y, p.z), skyLight: 14 } : base(p))
  for (const s of summaries(env)) assert.match(s, /falls away E at 3, floor ~9 down \(LAVA below\)/)
})

test('map draws a floor changed out of sight as last seen, and the new block once in sight', () => {
  let light = LIT
  const planked = new Set()
  // A room at x -5..5, z -5..5 with its ceiling above the map's top, on a stone floor at y 63.
  const env = world({ open: (x, y, z) => Math.abs(x) <= 5 && Math.abs(z) <= 5 && y >= 64 && y <= 70, light: () => light })
  const base = env.bot.blockAt
  env.bot.blockAt = (p) => (planked.has(ck(p.x, p.y, p.z)) ? { ...base(p), name: 'oak_planks', type: 9 } : base(p))
  env.bot.registry = { blocks: { 3: { name: 'stone' }, 9: { name: 'oak_planks' } } }
  Object.assign(env, { require, SEEN_CAP: 1000, SURFACE: new Map(), SURFACE_CAP: 1000, surfaceEdits: 0, ...stationMemory(), indoors: () => false })
  loadBotFunctions(['markTrail'], env).markTrail(new Vec3(0, 64, 0))
  // The glyph of column x 3, z 0.
  const glyph = () => runRoute('/map', { radius: '4' }, env).grid.split('\n')[4][7]
  assert.strictEqual(glyph(), '#', 'control: the stone floor in sight')
  light = DARK
  planked.add('3,63,0')
  assert.strictEqual(glyph(), '#')
  light = LIT
  assert.strictEqual(glyph(), '=')
})

// An open column above the body at 0,64,0 holding sky light sky.
const shaftToSky = (sky, timeOfDay = NOON) => world({ open: (x, y, z) => x === 0 && z === 0 && y >= 64, light: () => LIT, skyLight: () => sky, timeOfDay })

test('state and scene tell the time only while the sky shows', () => {
  const told = (env) => {
    Object.assign(env.bot.entity, { pitch: 0, onGround: true })
    Object.assign(env.bot, { oxygenLevel: 20, game: { ...env.bot.game, dimension: 'overworld' }, registry: REGISTRY, blockAtCursor: () => null })
    const [scene] = summaries(env)
    const state = runRoute('/state', {}, { ...env, waterState: () => null, heldInfo: () => null, round: (v) => v, shared: { ...env.shared, ready: true } })
    return [state.timeOfDay, /"time"|day|t=6000/.test(scene)]
  }
  assert.deepStrictEqual(told(shaftToSky(15)), [NOON, true], 'control: under open sky')
  const capped = world({ open: (x, y, z) => x === 0 && z === 0 && y >= 64 && y < 80, light: () => LIT })
  assert.deepStrictEqual(told(capped), [undefined, false])
})

test('nightfall stays silent underground and fires once at the first sight of the sky', () => {
  const env = shaftToSky(0, MIDNIGHT)
  const events = []
  env.emitEvent = (kind) => events.push(kind)
  const { nightfall } = loadBotFunctions(['nightfall'], env)
  let fired = nightfall(false)
  assert.deepStrictEqual(events, [])
  const sky = shaftToSky(15, MIDNIGHT)
  env.bot.blockAt = sky.bot.blockAt
  // The next physics tick.
  env.SKY_IN_SIGHT.clear()
  fired = nightfall(fired)
  fired = nightfall(fired)
  assert.deepStrictEqual(events, ['nightfall'])
})

// Runs the one blockUpdate handler of bot.js that names marker on env.bot.
function wireBlockUpdate (env, marker, names) {
  env.bot = Object.assign(new EventEmitter(), env.bot)
  const src = wiredSource()
  const handlers = [...src.matchAll(/^bot\.on\('blockUpdate', \(oldB, newB\) => /gm)]
    .map((m) => m[0] + balanced(src, m.index + m[0].length) + ')')
    .filter((h) => h.includes(marker))
  assert.strictEqual(handlers.length, 1, `blockUpdate handlers of bot.js naming ${marker}`)
  const ctx = loadBotFunctions(names, env)
  vm.runInContext(handlers[0], ctx)
  return ctx
}

test('a cell a block change walls off reads unseen at once, not once its kept sight runs out', () => {
  let now = 1000
  const cells = {}
  const env = withCells(tunnel(4, LIT), cells)
  env.Date = { now: () => now }
  const { cellKnown } = wireBlockUpdate(env, 'SIGHT_MEMO', ['cellKnown'])
  const beyond = new Vec3(3, 64, 0)
  assert.strictEqual(cellKnown(beyond), true, 'control: in sight')
  cells['2,64,0'] = cells['2,65,0'] = { name: 'stone', boundingBox: 'block', light: 0 }
  now += 100
  assert.strictEqual(cellKnown(beyond), true, 'control: walled off with no block update')
  env.bot.emit('blockUpdate', airAt([2, 64, 0]), stoneAt([2, 64, 0]))
  assert.strictEqual(cellKnown(beyond), false)
})

test('a mob that a door just closed seals off leaves the entity list at once', () => {
  let now = 1000
  let open = true
  const door = { name: 'oak_door', boundingBox: 'block', light: LIT, getProperties: () => ({ open }) }
  const corridor = world({ open: (x, y, z) => z === 0 && (y === 64 || y === 65) && x >= 0 && x <= 8, light: () => LIT })
  const env = withCells(corridor, { '4,64,0': door, '4,65,0': door })
  env.bot.entities = { 1: { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(6.5, 64, 0.5), metadata: [0] } }
  Object.assign(env, { Date: { now: () => now }, staleEntities: new Set(), round: (v) => v, reflexes: [] })
  wireBlockUpdate(env, '_fill', ['airFlood', 'knownCell', 'touchesFill'])
  env.reflexes.push(combatReflexIn(env))
  const listed = () => runRoute('/entities', {}, env).count
  assert.strictEqual(listed(), 1, 'control: the door open')
  open = false
  now += 100
  assert.strictEqual(listed(), 1, 'control: the door closed with no block update')
  const closed = block('oak_door', 3, 'block')([4, 64, 0])
  env.bot.emit('blockUpdate', closed, closed)
  assert.strictEqual(listed(), 0)
})
