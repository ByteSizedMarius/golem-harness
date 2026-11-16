'use strict'
// Every registry in this process shares one shape table.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const FULL = [[0, 0, 0, 1, 1, 1]]
const FARM = ['farmland', { moisture: 7 }]
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-shapes-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
process.env.GOLEM_SERVER_OVERRIDES = path.join(dir, 'overrides.json')
fs.writeFileSync(process.env.GOLEM_SERVER_OVERRIDES, JSON.stringify({ ingredients: {}, recipes: [], blocks: {}, shapes: { farmland: FULL } }))

const { setShapes } = require('../lib/server-overrides')
const { LEGACY_SMOTHERS } = require('../lib/bot/legacy-1710')
const { createConnection, bindConnection, wireConnectionSpawn } = require('../lib/bot/connection')
const { loadBotFunctions, restingY, walkingBody } = require('./helpers')

const registry = require('prismarine-registry')('1.21.11')
const EarlyBlock = require('prismarine-block')(registry)
// The overrides file's shapes reach the registry at login.
const loginBot = Object.assign(new EventEmitter(), { registry })
createConnection({ bot: loginBot })
bindConnection({ bot: loginBot })
wireConnectionSpawn()
loginBot.emit('login')

const boxesOf = (Block, name, props = {}) => JSON.stringify(Block.fromProperties(name, props, 0).shapes)

function cellBot (cells) {
  const Block = require('prismarine-block')(registry)
  return {
    registry,
    blockAt (p) {
      const [name, props] = cells[`${p.x},${p.y},${p.z}`] || ['air', {}]
      const b = Block.fromProperties(name, props, 0)
      b.position = p
      return b
    }
  }
}

test('farmland collides as a full cube in a Block class made before the login and in one made after, and other blocks keep their boxes', () => {
  const late = require('prismarine-block')(registry)
  const fresh = require('prismarine-block')(require('prismarine-registry')('1.21.11'))
  for (const [label, Block] of [['before', EarlyBlock], ['after', late], ['another registry', fresh]]) {
    assert.strictEqual(boxesOf(Block, 'farmland', { moisture: 7 }), JSON.stringify(FULL), label)
    assert.strictEqual(boxesOf(Block, 'dirt_path'), JSON.stringify([[0, 0, 0, 1, 0.9375, 1]]), `${label}: control, dirt_path`)
  }
  assert.strictEqual(registry.blockCollisionShapes.blocks.farmland, registry.blockCollisionShapes.blocks.stone, 'the boxes stone has are shared')
})

test('a body let go over farmland rests on top of the block', async (t) => {
  assert.strictEqual(await restingY(t, new Vec3(0.5, 65, 0.5), { '0,63,0': FARM }), 64)
})

test('a planned walk across farmland on its level aims every node at the block\'s top', async (t) => {
  const cells = { '1,63,0': FARM, '2,63,0': FARM, '3,63,0': FARM }
  const { plan } = await walkingBody(t, new Vec3(0.5, 64, 0.5), cells)
  const r = plan(new goals.GoalBlock(3, 64, 0))
  assert.strictEqual(r.status, 'success')
  assert.deepStrictEqual(r.path.map((n) => [n.x, n.y, n.z]), [[1.5, 64, 0.5], [2.5, 64, 0.5], [3.5, 64, 0.5]])
})

test('boxes no shape holds get a shape of their own, and boxes one holds share it', () => {
  const low = [[0, 0, 0, 1, 0.8, 1]]
  const table = registry.blockCollisionShapes
  const before = Object.keys(table.shapes).length
  setShapes(registry, new Map([['soul_sand', low]]))
  assert.strictEqual(Object.keys(table.shapes).length, before + 1)
  assert.strictEqual(boxesOf(require('prismarine-block')(registry), 'soul_sand'), JSON.stringify(low))
  setShapes(registry, new Map([['soul_sand', low]]))
  assert.strictEqual(Object.keys(table.shapes).length, before + 1, 'a second apply adds no shape')
})

test('shapes for a block the version lacks or one whose boxes differ by state are refused by name, and nothing is applied', () => {
  const dirtPath = JSON.stringify([[0, 0, 0, 1, 0.9375, 1]])
  assert.throws(() => setShapes(registry, new Map([['dirt_path', FULL], ['no_such_block', FULL]])), /no_such_block/)
  assert.throws(() => setShapes(registry, new Map([['dirt_path', FULL], ['oak_slab', FULL]])), /oak_slab/)
  assert.ok(Array.isArray(registry.blockCollisionShapes.blocks.oak_slab))
  assert.strictEqual(boxesOf(require('prismarine-block')(registry), 'dirt_path'), dirtPath)
})

test('shapes that leave a solid block without a box or give a passable block boxes are refused by name, and nothing is applied', () => {
  const table = registry.blockCollisionShapes
  const state = (name) => [JSON.stringify(registry.blocksByName[name].shapes), table.blocks[name]]
  for (const [name, boxes] of [['stone', []], ['short_grass', FULL]]) {
    const before = [state(name), state('dirt_path')]
    assert.throws(() => setShapes(registry, new Map([['dirt_path', FULL], [name, boxes]])), new RegExp(name))
    assert.deepStrictEqual([state(name), state('dirt_path')], before, name)
  }
})

test('a torch cell over farmland has no block to stand on, and one over stone has', () => {
  const bot = cellBot({ '0,63,0': FARM, '2,63,0': ['stone', {}] })
  const { holdsTorch } = loadBotFunctions(['holdsTorch'], { bot, seenNow: () => true, entityInCell: () => false })
  assert.strictEqual(holdsTorch(new Vec3(0, 64, 0)), false)
  assert.strictEqual(holdsTorch(new Vec3(2, 64, 0)), true, 'control: stone')
})

test('an eye in farmland does not suffocate, and one in stone does', () => {
  const bot = cellBot({ '0,63,0': FARM, '2,63,0': ['stone', {}] })
  const [farmland, stone] = [new Vec3(0, 63, 0), new Vec3(2, 63, 0)].map((p) => bot.blockAt(p))
  for (const legacy of [true, false]) {
    const { opaqueCube, suffocates } = loadBotFunctions(['opaqueCube', 'suffocates'], { bot, LEGACY_1710: legacy, LEGACY_SMOTHERS })
    assert.deepStrictEqual([opaqueCube(farmland), suffocates(farmland)], [false, false], `legacy ${legacy}`)
    assert.deepStrictEqual([opaqueCube(stone), suffocates(stone)], [true, true], `legacy ${legacy}: control, stone`)
  }
})
