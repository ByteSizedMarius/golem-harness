'use strict'
// The block search behind find, on real 1.21.11 chunks, against mineflayer's findBlocks.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { loadBotFunctions } = require('./helpers')
const { GRAVESTONE } = require('../lib/server-overrides')
const registry = require('prismarine-registry')('1.21.11')
const Chunk = require('prismarine-chunk')(registry)
const World = require('prismarine-world')(registry)
const loadBlock = require('prismarine-block')
const injectBlocks = require('mineflayer/lib/plugins/blocks')

const ck = (x, y, z) => x + ',' + y + ',' + z
const state = (name) => registry.blocksByName[name].defaultState
const ID = (name) => registry.blocksByName[name].id
const BODY = new Vec3(0.5, 64, 0.5)

// A bot with mineflayer's block plugin over the chunks columns(set, column) fills.
function realBot (columns) {
  const bot = Object.assign(new EventEmitter(), {
    registry,
    _client: new EventEmitter(),
    supportFeature: registry.supportFeature,
    game: { minY: -64, height: 384, dimension: 'overworld' },
    entity: { position: BODY },
    time: { timeOfDay: 6000 }
  })
  injectBlocks(bot, { version: '1.21.11' })
  bot.world = new World(null).sync
  const made = new Map()
  const column = (x, z) => {
    const k = (x >> 4) + ',' + (z >> 4)
    if (!made.has(k)) made.set(k, new Chunk({ minY: -64, worldHeight: 384 }))
    return made.get(k)
  }
  columns((x, y, z, name) => column(x, z).setBlockStateId({ x: x & 15, y, z: z & 15 }, state(name)), column)
  for (const [k, c] of made) bot.world.setColumn(...k.split(',').map(Number), c)
  return bot
}

function sight (bot, names, env = {}) {
  return loadBotFunctions(names, {
    bot,
    Vec3,
    loadBlock,
    STATE_CLEAR: new WeakMap(),
    GROUND_TOP: new Map(),
    ESTIMATED_LIGHT: new Map(),
    GRAVESTONE,
    LEGACY_1710: false,
    ...env
  })
}

function random (seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Columns -2 to 2 each way: stone to y 47, random caves, ores, lava and see-through blocks from y 48 to 95, air above,
// a room around the body, a section of coal_ore alone at y 32 to 47 in column -1,-1 and a section of 300 state ids
// at y 80 to 95 in column 1,1.
function generated (seed) {
  const rnd = random(seed)
  const kinds = [[0.4, 'air'], [0.44, 'coal_ore'], [0.46, 'iron_ore'], [0.47, 'lava'], [0.48, 'glass'], [0.49, 'oak_leaves'], [0.5, 'oak_fence'], [1, 'stone']]
  return realBot((set, column) => {
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) {
        const c = column(cx * 16, cz * 16)
        for (let i = 0; i < 7; i++) c.sections[i] = new Chunk.section({ singleValue: state('stone'), maxBitsPerBlock: c.maxBitsPerBlock })
        for (let y = 48; y < 96; y++) {
          for (let z = cz * 16; z < cz * 16 + 16; z++) {
            for (let x = cx * 16; x < cx * 16 + 16; x++) {
              const r = rnd()
              set(x, y, z, kinds.find(([p]) => r < p)[1])
            }
          }
        }
      }
    }
    for (let x = -1; x <= 1; x++) for (let y = 64; y <= 66; y++) for (let z = -1; z <= 1; z++) set(x, y, z, 'air')
    const coal = column(-16, -16)
    coal.sections[6] = new Chunk.section({ singleValue: state('coal_ore'), maxBitsPerBlock: coal.maxBitsPerBlock })
    const mixed = column(16, 16)
    for (let k = 0; k < 300; k++) mixed.setBlockStateId({ x: k & 15, y: 80 + (k >> 8), z: (k >> 4) & 15 }, 1000 + k)
  })
}

// findBlocks searches the sections within steps(maxDistance) of sectionOf(point).
const sectionOf = (p) => [Math.floor(p.x / 16), Math.floor(p.y / 16), Math.floor(p.z / 16)]
const steps = (maxDistance) => Math.ceil((maxDistance + 8) / 16)

test('the search returns the cells findBlocks finds that show a face to sight, nearest the eye first, plus those of the sections findBlocks never reaches', () => {
  for (const seed of [1, 2, 3, 4]) {
    const bot = generated(seed)
    const s = sight(bot, ['nearestCells', 'nearPoint', 'floodPassable', 'isFence', 'isLeaves', 'eyeDist'])
    const mixed = bot.world.getColumn(1, 1).sections[9]
    assert.ok(!mixed.palette && !('value' in mixed.data), 'control: a section without a palette')
    assert.ok('value' in bot.world.getColumn(-1, -1).sections[6].data, 'control: a section of one state')
    const faced = (p) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => {
      const n = bot.blockAt(p.offset(dx, dy, dz))
      return s.floodPassable(n) || s.isFence(n) || s.isLeaves(n)
    })
    const coal = ID('coal_ore')
    const cases = [
      { ids: [coal, ID('iron_ore')], maxDist: 24 },
      { ids: [coal], maxDist: 12, point: new Vec3(20.5, 70, -12.5) },
      { ids: (b) => b.type === coal && (!b.position || ((b.position.x ^ b.position.z) & 1) === 0), maxDist: 24 },
      { ids: [ID('lava'), ID('glass')], maxDist: 30 }
    ]
    for (const { ids, maxDist, point = BODY } of cases) {
      const label = `seed ${seed}, ${typeof ids === 'function' ? 'a matcher' : ids.join('+')} within ${maxDist} of ${point}`
      const range = maxDist + BODY.distanceTo(point)
      const matching = point === BODY ? ids : s.nearPoint(ids, point, maxDist)
      const expected = bot.findBlocks({ matching, maxDistance: range, count: Infinity }).filter(faced)
      const found = []
      s.nearestCells(ids, point, maxDist, range, Infinity, (p) => { found.push(p) })
      const key = (p) => ck(p.x, p.y, p.z)
      const keys = new Set(found.map(key))
      assert.ok(expected.length > 0 && found.length < 4096, `control: ${expected.length} cells, ${found.length} found, ${label}`)
      assert.strictEqual(keys.size, found.length, `no cell twice, ${label}`)
      assert.deepStrictEqual(expected.map(key).filter((k) => !keys.has(k)), [], `every findBlocks cell, ${label}`)
      const from = sectionOf(BODY)
      const unreached = (p) => sectionOf(p).reduce((sum, v, i) => sum + Math.abs(v - from[i]), 0) > steps(range)
      const known = new Set(expected.map(key))
      assert.deepStrictEqual(found.filter((p) => !known.has(key(p)) && !unreached(p)).map(key), [], `no cell findBlocks passes over, ${label}`)
      const dists = found.map((p) => s.eyeDist(p))
      assert.ok(dists.every((d, i) => i === 0 || d >= dists[i - 1]), `nearest the eye first, ${label}`)
    }
  }
})

test('a search stopped by the cap names only cells nearer the eye than every cell it left unscanned', () => {
  for (const seed of [1, 2]) {
    const bot = generated(seed)
    const s = sight(bot, ['nearestCells', 'eyeDist'])
    const ids = [ID('coal_ore'), ID('iron_ore')]
    const all = []
    s.nearestCells(ids, BODY, 24, 24, Infinity, (p) => { all.push(p) })
    for (const cap of [768, 1536]) {
      const label = `seed ${seed}, cap ${cap}`
      const cut = []
      s.nearestCells(ids, BODY, 24, 24, Infinity, (p) => { cut.push(p) }, cap)
      assert.ok(cut.length > 0 && cut.length < all.length, `control: ${cut.length} of ${all.length} cells, ${label}`)
      const dists = (cells) => cells.map((p) => s.eyeDist(p))
      assert.deepStrictEqual(dists(cut), dists(all).slice(0, cut.length), `the nearest cells, ${label}`)
    }
  }
})

test('find names lava in sight beside the body before lava farther out in sections findBlocks reaches first', () => {
  // A stone-roofed room, a section of lava east of it, and lava at -3,64,-2 in a nook two sections from the body's.
  const bot = realBot((set) => {
    for (let x = -16; x < 48; x++) for (let y = 60; y < 80; y++) for (let z = -16; z < 32; z++) set(x, y, z, 'stone')
    for (let x = 0; x < 16; x++) for (let y = 64; y <= 66; y++) for (let z = 0; z < 16; z++) set(x, y, z, 'air')
    for (let x = -4; x <= 0; x++) for (let y = 64; y <= 66; y++) for (let z = -3; z <= 0; z++) set(x, y, z, 'air')
    for (let x = 16; x < 32; x++) for (let y = 64; y < 80; y++) for (let z = 0; z < 16; z++) set(x, y, z, 'lava')
    set(-3, 64, -2, 'lava')
  })
  const { findVisible } = sight(bot, ['findVisible'])
  assert.deepStrictEqual(Array.from(findVisible([ID('lava')], 64, 2), (v) => [v.pos.x, v.pos.y, v.pos.z]), [[-3, 64, -2], [16, 65, 0]])
})

// Coal at 40,64,0, plus, when crowded, a layer of coal at every even y in the eight sections around the body.
const coalRig = (crowded) => realBot((set) => {
  set(40, 64, 0, 'coal_ore')
  if (crowded) for (let x = -16; x < 16; x++) for (let y = 48; y < 80; y += 2) for (let z = -16; z < 16; z++) set(x, y, z, 'coal_ore')
})

test('the search stops once 4096 cells wait their turn, and says it stopped', () => {
  const search = (crowded) => {
    const keys = new Set()
    const stopped = sight(coalRig(crowded), ['nearestCells']).nearestCells([ID('coal_ore')], BODY, 64, 64, Infinity, (p) => { keys.add(ck(p.x, p.y, p.z)) })
    return { keys, stopped }
  }
  const alone = search(false)
  assert.ok(alone.keys.has('40,64,0') && alone.stopped === false, 'control: the coal alone')
  const crowd = search(true)
  assert.strictEqual(crowd.stopped, true)
  assert.ok(crowd.keys.size < 4096, `${crowd.keys.size} cells`)
  assert.strictEqual(crowd.keys.has('40,64,0'), false)
})

test('findVisible marks its result partial when the search stops at the cap', () => {
  // A clock that stands still keeps the search budget from running out.
  const found = (crowded) => sight(coalRig(crowded), ['findVisible'], { Date: { now: () => 0 } }).findVisible([ID('coal_ore')], 64, 100000)
  assert.strictEqual(Object.hasOwn(found(false), 'partial'), false, 'control: a search that ends')
  assert.strictEqual(found(true).partial, true)
})
