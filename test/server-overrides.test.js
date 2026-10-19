'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const mcData = require('minecraft-data')('1.21.11')
const { Vec3 } = require('vec3')
const { readServerOverrides, renameBlocks, overrideRecipes, craftable } = require('../lib/server-overrides')
const { awaitRoute, loadBotFunctions } = require('./helpers')

const id = (name) => mcData.itemsByName[name].id
const TABLE = { name: 'crafting_table', position: new Vec3(2, 64, 0) }
const OVERRIDES = {
  ingredients: {
    planks: { items: ['oak_planks', 'spruce_planks'] },
    stick: { items: ['stick'] }
  },
  recipes: [
    { item: 'oak_fence', count: 2, inShape: [['stick', 'stick', 'stick'], ['stick', 'stick', 'stick']] },
    { item: 'oak_door', count: 1, inShape: [['planks', 'planks'], ['planks', 'planks'], ['planks', 'planks']] }
  ],
  blocks: {}
}
// The registry's own oak_fence recipe, which makes 3.
const REGISTRY_FENCE = { result: { id: id('oak_fence'), count: 3 }, delta: [], requiresTable: true }
const REGISTRY_STICK = { result: { id: id('stick'), count: 4 }, delta: [], requiresTable: false }

function overridesFile (t, spec = OVERRIDES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-overrides-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'overrides.json')
  fs.writeFileSync(file, JSON.stringify(spec))
  return file
}

const recipesOf = (t, spec) => readServerOverrides(overridesFile(t, spec)).recipes

function crafter (items) {
  const held = new Map(Object.entries(items).map(([name, n]) => [id(name), n]))
  const crafts = []
  const bot = {
    inventory: {
      count: (itemId) => held.get(itemId) || 0,
      items: () => [...held].filter(([, n]) => n > 0).map(([itemId, n]) => ({ name: mcData.items[itemId].name, count: n }))
    },
    recipesFor: (itemId) => [REGISTRY_FENCE, REGISTRY_STICK].filter((r) => r.result.id === itemId),
    craft: async (recipe, n, table) => {
      crafts.push({ recipe, table })
      for (const d of recipe.delta) held.set(d.id, (held.get(d.id) || 0) + d.count)
      if (!recipe.delta.length) held.set(recipe.result.id, (held.get(recipe.result.id) || 0) + recipe.result.count)
    },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    findBlocks: () => [TABLE.position],
    blockAt: () => TABLE,
    pathfinder: { goto: async () => {} }
  }
  return { bot, crafts, held }
}

function craftEnv (bot, serverRecipes) {
  return {
    bot,
    shared: { mcData },
    SERVER_RECIPES: serverRecipes,
    LEGACY_1710: false,
    overrideRecipes,
    craftable,
    resolveItem: (name) => mcData.itemsByName[name] || null,
    resolveBlockIds: () => [mcData.blocksByName.crafting_table.id],
    cellKnown: () => true,
    seenNow: () => true,
    STATIONS: new Map(),
    goals: { GoalNear: class {} }
  }
}

const cellsOf = (recipe) => recipe.inShape.map((row) => row.map((cell) => (cell.id === -1 ? null : mcData.items[cell.id].name)))

test('an overridden oak_fence takes 6 sticks at a table and yields 2 per craft', (t) => {
  assert.strictEqual(recipesOf(t).get('oak_fence').length, 1)
  const [fence] = overrideRecipes(recipesOf(t), 'oak_fence', mcData.itemsByName)
  assert.deepStrictEqual(cellsOf(fence), [['stick', 'stick', 'stick'], ['stick', 'stick', 'stick']])
  assert.strictEqual(fence.result.count, 2)
  assert.strictEqual(fence.requiresTable, true)
  assert.deepStrictEqual(craftable([fence], TABLE, (itemId) => (itemId === id('stick') ? 5 : 0)), [])
  assert.deepStrictEqual(craftable([fence], TABLE, (itemId) => (itemId === id('stick') ? 6 : 0)), [fence])
})

test('several entries for one item each give their own recipes, their id, name and metadata keys ignored', (t) => {
  const spec = {
    ingredients: {
      oak: { items: ['oak_planks'], metadata: 0 },
      birch: { items: ['birch_planks'], metadata: 2 }
    },
    recipes: [
      { item: 'oak_boat', id: 333, name: 'boat', count: 1, inShape: [['oak', null, 'oak'], ['oak', 'oak', 'oak']] },
      { item: 'oak_boat', id: 4099, name: 'birch_boat', count: 1, inShape: [['birch', null, 'birch'], ['birch', 'birch', 'birch']] }
    ],
    blocks: {}
  }
  const recipes = recipesOf(t, spec)
  assert.strictEqual(recipes.get('oak_boat').length, 2)
  const boats = overrideRecipes(recipes, 'oak_boat', mcData.itemsByName)
  assert.deepStrictEqual(boats.map(cellsOf), [
    [['oak_planks', null, 'oak_planks'], ['oak_planks', 'oak_planks', 'oak_planks']],
    [['birch_planks', null, 'birch_planks'], ['birch_planks', 'birch_planks', 'birch_planks']]
  ])
  assert.deepStrictEqual(craftable(boats, TABLE, (itemId) => (itemId === id('birch_planks') ? 5 : 0)), [boats[1]])
})

test('craft counts made items by the override yield', async (t) => {
  const { bot, crafts, held } = crafter({ stick: 12 })
  const reply = await awaitRoute('/craft', { item: 'oak_fence', count: '3' }, craftEnv(bot, recipesOf(t)))
  assert.deepStrictEqual(reply, { crafted: 'oak_fence', requested: 3, made: 4, usedTable: true, nowHave: 4 })
  assert.strictEqual(crafts.length, 2)
  for (const craft of crafts) {
    assert.strictEqual(craft.table, TABLE)
    assert.deepStrictEqual(cellsOf(craft.recipe), [['stick', 'stick', 'stick'], ['stick', 'stick', 'stick']])
  }
  assert.strictEqual(held.get(id('stick')), 0)
})

test('craft stops when the override ingredients run out', async (t) => {
  const { bot, crafts } = crafter({ stick: 8 })
  const reply = await awaitRoute('/craft', { item: 'oak_fence', count: '4' }, craftEnv(bot, recipesOf(t)))
  assert.strictEqual(crafts.length, 1)
  assert.strictEqual(reply.requested, 4)
  assert.strictEqual(reply.made, 2)
  assert.match(reply.note, /out of materials/)
})

test('an overridden oak_door yields 1 per craft from any listed planks', async (t) => {
  const { bot, crafts } = crafter({ spruce_planks: 12 })
  const reply = await awaitRoute('/craft', { item: 'oak_door', count: '2' }, craftEnv(bot, recipesOf(t)))
  assert.strictEqual(reply.made, 2)
  assert.strictEqual(crafts.length, 2)
  assert.deepStrictEqual(cellsOf(crafts[0].recipe), [['spruce_planks', 'spruce_planks'], ['spruce_planks', 'spruce_planks'], ['spruce_planks', 'spruce_planks']])
})

test('an item without an override crafts by the registry recipe', async (t) => {
  const { bot, crafts } = crafter({ oak_planks: 2 })
  const reply = await awaitRoute('/craft', { item: 'stick', count: '4' }, craftEnv(bot, recipesOf(t)))
  assert.strictEqual(reply.made, 4)
  assert.deepStrictEqual(crafts.map((c) => c.recipe), [REGISTRY_STICK])
})

test('without an overrides file oak_fence crafts by the registry recipe', async () => {
  assert.strictEqual(readServerOverrides(undefined), null)
  assert.strictEqual(readServerOverrides(''), null)
  const { bot, crafts } = crafter({ stick: 12 })
  const reply = await awaitRoute('/craft', { item: 'oak_fence', count: '3' }, craftEnv(bot, null))
  assert.strictEqual(reply.made, 3)
  assert.deepStrictEqual(crafts.map((c) => c.recipe), [REGISTRY_FENCE])
})

test('an overrides file naming an undefined ingredient is refused at start', (t) => {
  const spec = { ...OVERRIDES, ingredients: {}, recipes: [{ item: 'oak_fence', count: 2, inShape: [['stick']] }] }
  assert.throws(() => readServerOverrides(overridesFile(t, spec)), /GOLEM_SERVER_OVERRIDES .*oak_fence names ingredient stick/)
})

test('an overrides file without a blocks object is refused at start', (t) => {
  const { blocks, ...spec } = OVERRIDES
  assert.throws(() => readServerOverrides(overridesFile(t, spec)), /GOLEM_SERVER_OVERRIDES .*blocks/)
})

test('an item alias resolves to its 1.21.11 item, and an unknown name stays unknown', (t) => {
  const rows = [
    ['an items map', readServerOverrides(overridesFile(t, { ...OVERRIDES, items: { fence: 'oak_fence' } })), 'oak_fence'],
    ['no overrides file', readServerOverrides(undefined), null],
    ['no items map', readServerOverrides(overridesFile(t)), null]
  ]
  for (const [label, overrides, alias] of rows) {
    const { resolveItem } = loadBotFunctions(['resolveItem'], { shared: { mcData }, SERVER_OVERRIDES: overrides })
    const fence = resolveItem('fence')
    assert.strictEqual(fence && fence.name, alias, label)
    assert.strictEqual(resolveItem('oak_fence').name, 'oak_fence', label)
    assert.strictEqual(resolveItem('fence_gate'), null, label)
  }
})

test('an overrides file with a malformed items map is refused at start', (t) => {
  for (const items of [['fence'], { fence: '' }, { fence: 85 }, null]) {
    assert.throws(() => readServerOverrides(overridesFile(t, { ...OVERRIDES, items })), /GOLEM_SERVER_OVERRIDES .*items/)
  }
})

test('a renamed block reaches every block of its kind under the shown name', (t) => {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const rod = registry.blocksByName.end_rod
  const { blocks } = readServerOverrides(overridesFile(t, { ...OVERRIDES, blocks: { end_rod: 'gravestone' } }))
  renameBlocks(registry, blocks)
  for (let state = rod.minStateId; state <= rod.maxStateId; state++) assert.strictEqual(Block.fromStateId(state, 0).name, 'gravestone')
  assert.strictEqual(registry.blocksByName.gravestone.id, rod.id)
  assert.strictEqual(registry.blocksByName.end_rod, undefined)
  assert.strictEqual(Block.fromStateId(registry.blocksByName.stone.defaultState, 0).name, 'stone', 'control: other blocks keep their names')
})

test('renaming a block the version lacks, or onto a name it has, is refused', () => {
  const registry = require('prismarine-registry')('1.21.11')
  assert.throws(() => renameBlocks(registry, new Map([['no_such_block', 'gravestone']])), /no_such_block/)
  assert.throws(() => renameBlocks(registry, new Map([['torch', 'stone']])), /torch to stone/)
  assert.strictEqual(registry.blocksByName.torch.name, 'torch')
})
