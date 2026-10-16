'use strict'
// A block reaches the pilot only in line of sight from the head and within the distance its light carries.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const { Vec3 } = require('vec3')
const { sameVein } = require('../lib/wake')
const { sectionColumns, floorPhrase } = require('../lib/section')
const { botConstant, botSource, loadBotFunctions, routeHandler, runRoute, reflexIn } = require('./helpers')
const { GRAVESTONE } = require('../lib/server-overrides')

const ck = (x, y, z) => x + ',' + y + ',' + z
const IDS = { air: 0, coal_ore: 1, iron_ore: 2, stone: 3, diamond_ore: 4 }
const NOON = 6000
const MIDNIGHT = 18000

// Stone opened where open(x, y, z), ores keyed 'x,y,z', light by (x, z), the body at x = at, z = 0.
function world ({ open, ores = {}, light, skyLight = () => 0, at = 0, timeOfDay = NOON }) {
  const blockAt = (p) => {
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
  const blocks = [{ id: 1, name: 'coal_ore' }, { id: 2, name: 'iron_ore' }, { id: 4, name: 'diamond_ore' }]
  return {
    ready: true,
    bot: { entity: { position, yaw: 0 }, blockAt, findBlocks, time: { timeOfDay }, game: { minY: -64, height: 384 } },
    mcData: { blocksArray: blocks, blocksByName: Object.fromEntries(blocks.map((b) => [b.name, b])) },
    ck,
    Vec3,
    SEEN: new Set(),
    ESTIMATED_LIGHT: new Map(),
  }
}

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

// The light data of the block types in world, a torch as type 5, an end_rod as type 6, fire as type 7 and lava as type 8.
const REGISTRY = { blocks: { 0: { emitLight: 0, filterLight: 0 }, 1: { emitLight: 0, filterLight: 15 }, 2: { emitLight: 0, filterLight: 15 }, 3: { emitLight: 0, filterLight: 15 }, 4: { emitLight: 0, filterLight: 15 }, 5: { emitLight: 14, filterLight: 0 }, 6: { emitLight: 14, filterLight: 0 }, 7: { emitLight: 15, filterLight: 0 }, 8: { emitLight: 15, filterLight: 1 } } }
const block = (name, type, boundingBox) => (p) => ({ name, type, stateId: type, boundingBox, position: new Vec3(...p), getProperties: () => ({}) })
const stoneAt = block('stone', 3, 'block')
const airAt = block('air', 0, 'empty')
const torchAt = block('torch', 5, 'empty')

// Makes env.bot an emitter and wires it to the block update and chunk load handlers of bot.js.
function wireLight (env) {
  env.bot = Object.assign(new EventEmitter(), env.bot, { registry: REGISTRY })
  env.GRAVESTONE = GRAVESTONE
  const lines = [...botSource().matchAll(/^bot\.on\('(?:blockUpdate|chunkColumnLoad)', (?:\(\w+\) => )?([A-Za-z_$][\w$]*)\b.*\)$/gm)]
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

test('an old seen.json is dropped, one saved now loads again', () => {
  const env = { SEEN: new Set(), SEEN_CAP: 10, SEEN_VERSION: botConstant('SEEN_VERSION') }
  const { loadSeen, seenJson } = loadBotFunctions(['loadSeen', 'seenJson'], env)
  assert.strictEqual(loadSeen(JSON.stringify(['1,64,0', '2,64,0'])), false)
  assert.strictEqual(env.SEEN.size, 0)
  env.SEEN.add('3,64,0')
  const saved = seenJson()
  env.SEEN.clear()
  assert.strictEqual(loadSeen(saved), true, 'control: the current format')
  assert.deepStrictEqual([...env.SEEN], ['3,64,0'])
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

test('use names a block in lit sight, never one in rock, around a corner or in the dark', async () => {
  const use = async (env, at) => {
    const { handle, res } = routeHandler('/use', withHands(env))
    await handle({ query: at }, res)
    return res
  }
  const coal = { x: '-1', y: '65', z: '0' }
  assert.strictEqual((await use(cave(LIT), coal)).body.on, 'coal_ore', 'control: in sight')
  const room = world({ open: (x, y, z) => z === 0 && x >= 0 && x <= 3 && (y === 64 || y === 65), ores: { '1,62,0': 'diamond_ore' }, light: () => LIT })
  const rock = await use(room, { x: '1', y: '62', z: '0' })
  assert.match(rock.error.message, UNSEEN)
  assert.strictEqual(rock.body, undefined)
  const corner = await use(cave(LIT), { x: '7', y: '66', z: '0' })
  assert.match(corner.error.message, UNSEEN)
  assert.strictEqual(corner.body, undefined)
  assert.match((await use(cave(DARK, FAR_END), coal)).error.message, UNSEEN)
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
    const env = { ...withCells(cave(LIT), cells), require }
    const r = reflexIn('lava_watch', env)
    return r.check(env.bot) ? [r._hit.dir, r._hit.d] : null
  }
  assert.deepStrictEqual(watch({ '2,64,0': LAVA }), ['E', 2], 'control: lava in the room')
  assert.strictEqual(watch({ '2,64,-2': LAVA }), null, 'sealed in rock')
  assert.strictEqual(watch(behindWall(LAVA)), null, 'behind the wall')
})

test('the current watch fires on a current in lit sight or around the body, never on one behind a wall or in the dark', () => {
  const watch = (light, cells) => {
    const env = { ...withCells(cave(light), cells), require }
    const r = reflexIn('current_watch', env)
    return r.check(env.bot) ? [r._dir, r._dist] : null
  }
  assert.deepStrictEqual(watch(LIT, { '2,64,0': current(LIT) }), ['E', 2], 'control: in lit sight')
  assert.strictEqual(watch(LIT, behindWall(current(LIT))), null, 'behind the wall')
  assert.strictEqual(watch(DARK, { '3,64,0': current(DARK) }), null, 'in the dark')
  assert.deepStrictEqual(watch(DARK, { '0,64,0': current(DARK) }), ['-', 0], 'around the feet in the dark')
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

// The gaze reply of a body looking north from 0,64,0 over env, and the number of cells it marked seen.
function gaze (env) {
  env.bot.entity.pitch = 0
  Object.assign(env, { markSeen: (x, y, z) => env.SEEN.add(ck(x, y, z)), DARK_RAY: botConstant('DARK_RAY') })
  return { reply: runRoute('/gaze', {}, env), seen: env.SEEN.size }
}

const cavern = (light) => world({ open: (x, y, z) => Math.abs(x) <= 6 && Math.abs(z) <= 6 && y >= 64 && y <= 70, light: () => light })

test('gaze names nothing it would see only in total darkness, and says it is too dark', () => {
  const lit = gaze(cavern(LIT))
  assert.match(lit.reply.summary, /stone/, 'control: lit')
  const dark = gaze(cavern(DARK))
  assert.deepStrictEqual([dark.reply.surfaces, dark.reply.openings], [[], []])
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
