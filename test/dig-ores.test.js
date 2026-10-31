'use strict'
// A tunnel or stair names the ore it saw or touched on its way and did not dig.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { sameVein } = require('../lib/wake')
const { awaitRoute, botConstant } = require('./helpers')

const ck = (x, y, z) => x + ',' + y + ',' + z
const IDS = { air: 0, stone: 1, coal_ore: 2, iron_ore: 3, redstone_ore: 4, diamond_ore: 5, lava: 6 }
const BLOCKS_BY_NAME = Object.fromEntries(Object.entries(IDS).map(([name, id]) => [name, { id, name }]))
const PICK = { name: 'iron_pickaxe', type: 100, slot: 36 }
const DARK = () => false
// Light reaches only the cells seen from the start cell.
const FROM_START = (p, here) => here.x < 1

// A cell is in sight when lit(cell, feet) holds and it borders an open cell.
// The server answers each dig at the next step, resending the cells in refuse.
async function dig (route, query, { open = [], blocks = {}, lit = DARK, refuse = [] } = {}) {
  const opened = new Set(['0,64,0', '0,65,0', ...open])
  const key = (p) => ck(p.x, p.y, p.z)
  const nameAt = (p) => (opened.has(key(p)) ? 'air' : blocks[key(p)] || 'stone')
  const answers = []
  const events = []
  const progress = []
  const answer = () => {
    for (const p of answers.splice(0)) {
      if (refuse.includes(key(p))) opened.delete(key(p))
      bot.emit(`blockUpdate:${p}`, null, bot.blockAt(p))
    }
  }
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    heldItem: null,
    inventory: { emptySlotCount: () => 30, items: () => [PICK], slots: { [PICK.slot]: PICK } },
    blockAt: (p) => {
      const name = nameAt(p)
      return { name, type: IDS[name], boundingBox: name === 'air' ? 'empty' : 'block', position: p, skyLight: 0 }
    },
    findBlocks: ({ matching, maxDistance }) => Object.keys(blocks).map((k) => new Vec3(...k.split(',').map(Number)))
      .filter((p) => matching.includes(IDS[nameAt(p)]) && p.distanceTo(bot.entity.position) <= maxDistance),
    async waitForTicks () {},
    // mineflayer writes the air before the dig resolves.
    async dig (b) {
      opened.add(key(b.position))
      bot.emit(`blockUpdate:${b.position}`, b, bot.blockAt(b.position))
      answers.push(b.position)
    }
  })
  const NEIGHBOURS = botConstant('NEIGHBOURS')
  let job = null
  await awaitRoute(route, query, {
    bot,
    require,
    NEIGHBOURS,
    PICK_TIER: botConstant('PICK_TIER'),
    LEGACY_1710: false,
    digLock: botConstant('digLock'),
    bunker: { building: false },
    jobs: { start: (n, fn) => { job = fn({ cancelled: false, progress: (line) => progress.push(line) }); return { id: 1 } } },
    emitEvent: (kind, text) => events.push(text),
    refuseWhileBuilding () {},
    equipPickFor: async () => { bot.heldItem = PICK; return PICK },
    fillFrom: async () => null,
    macroPlaceAt: async () => ({}),
    nudgeInto: async (cell) => {
      answer()
      bot.entity.position = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5)
      return true
    },
    knownCell: () => false,
    skyInSight: () => false,
    lightRange: () => Infinity,
    seesLit: (p) => lit(p, bot.entity.position.floored()) && NEIGHBOURS.some(([dx, dy, dz]) => opened.has(key(p.offset(dx, dy, dz)))),
    liveEntities: () => [],
    FALL_TICKS: botConstant('FALL_TICKS'),
    FALL_START_TICKS: botConstant('FALL_START_TICKS'),
    ck,
    sameVein,
    shared: { mcData: { blocksByName: BLOCKS_BY_NAME } },
    ORE_IDS: botConstant('ORE_IDS')
  })
  return { ...JSON.parse(JSON.stringify(await job)), events, progress }
}

const EAST = { dir: 'e', length: '2', torch: '0' }

test('dig_tunnel in the dark names the floor and ceiling ore it passed', async () => {
  const r = await dig('/dig_tunnel', EAST, { blocks: { '1,63,0': 'redstone_ore', '2,66,0': 'iron_ore' } })
  assert.strictEqual(r.stopped, 'length reached', 'control: the tunnel stopped')
  assert.deepStrictEqual(r.ores, ['redstone_ore 1,63,0', 'iron_ore 2,66,0'])
})

test('dig_tunnel in the dark names no ore its body never touched', async () => {
  // Coal under the floor cell and diamond in the ceiling beside the way.
  const blocks = { '1,63,0': 'redstone_ore', '1,62,0': 'coal_ore', '2,66,1': 'diamond_ore' }
  const r = await dig('/dig_tunnel', EAST, { blocks })
  assert.deepStrictEqual(r.ores, ['redstone_ore 1,63,0'])
})

test('dig_tunnel names no wall ore it dug, also once out of sight', async () => {
  // The open cells let the start see both ores.
  const scene = { open: ['1,64,2', '2,64,-1'], blocks: { '1,64,1': 'iron_ore', '2,64,-2': 'coal_ore' }, lit: FROM_START }
  const r = await dig('/dig_tunnel', { ...EAST, length: '3' }, scene)
  assert.deepStrictEqual(r.found, { iron_ore: 1 }, 'control: the wall ore was not dug')
  assert.deepStrictEqual(r.ores, ['coal_ore 2,64,-2'])
})

test('dig_tunnel names a wall ore the server resent after its dig', async () => {
  const scene = { open: ['1,64,2'], blocks: { '1,64,1': 'iron_ore' }, lit: FROM_START }
  const gone = await dig('/dig_tunnel', { ...EAST, length: '3' }, scene)
  assert.strictEqual(gone.ores, undefined, 'control: a dig the server took left no ore')
  const kept = await dig('/dig_tunnel', { ...EAST, length: '3' }, { ...scene, refuse: ['1,64,1'] })
  assert.deepStrictEqual(kept.ores, ['iron_ore 1,64,1'])
})

test('dig_tunnel counts the ore it dug as found in its progress and done event', async () => {
  const r = await dig('/dig_tunnel', { ...EAST, length: '1' }, { blocks: { '1,64,1': 'iron_ore' } })
  assert.match(r.progress.at(-1), /, found \{"iron_ore":1\}$/)
  assert.match(r.events.at(-1), /, found=\{"iron_ore":1\}$/)
})

test('dig_tunnel stopped before its first step names the floor ore it touched', async () => {
  // Only the lava glows.
  const scene = { open: ['2,64,1'], blocks: { '0,63,0': 'redstone_ore', '2,64,0': 'lava' }, lit: (p) => ck(p.x, p.y, p.z) === '2,64,0' }
  const r = await dig('/dig_tunnel', EAST, scene)
  assert.match(r.stopped, /^lava ahead/, 'control: the tunnel stopped at the lava')
  assert.deepStrictEqual(r.ores, ['redstone_ore 0,63,0'])
})

test('dig_stair names the ore under a tread in the dark and no ore it dug', async () => {
  // The head cell of the first step holds iron the start sees, and coal sits beside the first tread.
  const blocks = { '1,62,0': 'redstone_ore', '1,64,0': 'iron_ore', '1,62,1': 'coal_ore' }
  const r = await dig('/dig_stair', { dir: 'e', up: '-1', steps: '2', torch: '0' }, { blocks, lit: FROM_START })
  assert.deepStrictEqual([r.stopped, r.climbed], ['steps done', -2], 'control: the stair stopped')
  assert.deepStrictEqual(r.ores, ['redstone_ore 1,62,0'])
})
