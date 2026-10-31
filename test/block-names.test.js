'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const { loadBotFunctions, routeHandler } = require('./helpers')

const namesOf = (ids) => [...ids].map((id) => registry.blocks[id].name).sort()
const COBBLE_REFUSAL = 'unknown block: cobble (names containing cobble: cobblestone, cobblestone_slab, cobblestone_wall, cobbled_deepslate, mossy_cobblestone, cobblestone_stairs, infested_cobblestone, cobbled_deepslate_slab)'

test('a block name picks the exact block, else every block holding it as whole words, else none', () => {
  const { resolveBlockIds } = loadBotFunctions(['resolveBlockIds'], { shared: { mcData: registry } })
  assert.deepStrictEqual(namesOf(resolveBlockIds('stone')), ['stone'])
  const woods = ['acacia', 'birch', 'cherry', 'dark_oak', 'jungle', 'mangrove', 'oak', 'pale_oak', 'spruce']
  assert.deepStrictEqual(namesOf(resolveBlockIds('log')), [...woods.map((w) => `${w}_log`), ...woods.map((w) => `stripped_${w}_log`)].sort())
  assert.deepStrictEqual(namesOf(resolveBlockIds('cobble')), [])
})

// The /find handler over a body at the origin that sees an oak log 3 blocks east, and the ids it looked for.
function findRoute (name) {
  const looked = []
  const log = new Vec3(3, 64, 0)
  const { handle, res } = routeHandler('/find', {
    shared: { ready: true, mcData: registry },
    bot: { entity: { position: new Vec3(0, 64, 0) }, blockAt: () => ({ name: 'oak_log' }) },
    findVisible: (ids) => { looked.push(...ids); return [{ pos: log, dist: 3 }] },
    cropAge: () => ({})
  })
  handle({ query: { name } }, res)
  return { res, looked }
}

test('/find refuses a block name no block holds as whole words, naming the closest names containing it', () => {
  const logs = findRoute('log')
  assert.strictEqual(logs.res.body.count, 1, 'control: a whole word finds its family')
  assert.ok(logs.looked.includes(registry.blocksByName.stripped_oak_log.id), 'control: a whole word finds its family')
  const { res, looked } = findRoute('cobble')
  assert.deepStrictEqual([res.error && res.error.message, res.error && res.error.reason], [COBBLE_REFUSAL, 'no_match'])
  assert.strictEqual(looked.length, 0)
  assert.strictEqual(findRoute('chset').res.error.message, 'unknown block: chset')
})

test('mine and gather refuse a block name no block holds as whole words, naming the closest names containing it', () => {
  for (const [route, query] of [['/mine', { name: 'cobble' }], ['/gather', { resource: 'cobble' }]]) {
    const { handle, res } = routeHandler(route, { require, shared: { ready: true, mcData: registry } })
    handle({ query }, res)
    assert.deepStrictEqual([res.error && res.error.message, res.error && res.error.reason], [COBBLE_REFUSAL, 'no_match'], route)
  }
})
