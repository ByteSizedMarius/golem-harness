'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const Item = require('prismarine-item')(registry)
const { botConstant, claimRescue, fakeClock, loadBotFunctions, routeHandler, runRoute } = require('./helpers')

// A carried item built from the enchantment components a 1.21.11 server sends.
function item (name, slot, enchants = {}, used = 0) {
  const enchantments = Object.entries(enchants).map(([e, level]) => ({ id: registry.enchantmentsByName[e].id, level }))
  const it = Item.fromNotch({
    itemId: registry.itemsByName[name].id,
    itemCount: 1,
    components: enchantments.length ? [{ type: 'enchantments', data: { enchantments } }] : [],
    removeComponents: []
  })
  return Object.assign(it, { slot, durabilityUsed: used })
}
const PLAIN = {}
const FORTUNE = { fortune: 3 }
const SILK = { silk_touch: 1 }

function picker (items, { legacy = false, held = null } = {}) {
  const bot = { heldItem: held, inventory: { items: () => items } }
  return loadBotFunctions(['pickFor'], { bot, PICK_TIER: botConstant('PICK_TIER'), LEGACY_1710: legacy, LEGACY_FORTUNE_ORES: botConstant('LEGACY_FORTUNE_ORES') }).pickFor
}

test('a pick choice takes the plain pick for stone and the fortune pick for coal ore', () => {
  const plain = item('iron_pickaxe', 36, PLAIN)
  const fortune = item('iron_pickaxe', 37, FORTUNE)
  for (const order of [[plain, fortune], [fortune, plain]]) {
    const pickFor = picker(order)
    assert.strictEqual(pickFor('stone'), plain)
    assert.strictEqual(pickFor('coal_ore'), fortune)
    assert.strictEqual(pickFor('deepslate_coal_ore'), fortune)
  }
})

test('a pick choice puts harvesting before fortune and fortune before tier', () => {
  const stoneFortune = item('stone_pickaxe', 36, FORTUNE)
  const ironPlain = item('iron_pickaxe', 37, PLAIN)
  assert.strictEqual(picker([stoneFortune, ironPlain])('diamond_ore'), ironPlain, 'the stone fortune pick does not harvest diamond')
  const ironFortune = item('iron_pickaxe', 36, FORTUNE)
  const diamondPlain = item('diamond_pickaxe', 37, PLAIN)
  assert.strictEqual(picker([diamondPlain, ironFortune])('diamond_ore'), ironFortune)
  const fortuneOne = item('iron_pickaxe', 38, { fortune: 1 })
  assert.strictEqual(picker([fortuneOne, ironFortune])('coal_ore'), ironFortune, 'the higher fortune level')
})

test('a pick choice digs stone with an enchanted pick when no plain one is carried, fortune before silk', () => {
  const fortune = item('iron_pickaxe', 36, FORTUNE)
  const silk = item('iron_pickaxe', 37, SILK)
  assert.strictEqual(picker([fortune])('stone'), fortune)
  assert.strictEqual(picker([silk])('stone'), silk)
  assert.strictEqual(picker([silk, fortune])('stone'), fortune)
})

test('a pick choice with only fortune picks digs stone with the lowest fortune level and coal ore with the highest', () => {
  const fortuneThree = item('iron_pickaxe', 36, FORTUNE)
  const fortuneOne = item('iron_pickaxe', 37, { fortune: 1 })
  for (const order of [[fortuneThree, fortuneOne], [fortuneOne, fortuneThree]]) {
    assert.strictEqual(picker(order)('stone'), fortuneOne)
    assert.strictEqual(picker(order)('coal_ore'), fortuneThree)
  }
})

test('a pick choice takes the silk touch pick only when silk is asked', () => {
  const plain = item('iron_pickaxe', 36, PLAIN)
  const silk = item('iron_pickaxe', 37, { silk_touch: 1, fortune: 2 })
  const pickFor = picker([silk, plain])
  assert.strictEqual(pickFor('coal_ore'), plain, 'a pick with silk touch and fortune counts as silk')
  assert.strictEqual(pickFor('stone', { silk: true }), silk)
  assert.strictEqual(picker([plain])('stone', { silk: true }), null)
})

test('a pick choice counts efficiency and unbreaking as plain, and among equal picks keeps the held one, else the most worn', () => {
  const efficient = item('iron_pickaxe', 36, { efficiency: 5, unbreaking: 3 })
  const fortune = item('iron_pickaxe', 37, FORTUNE)
  assert.strictEqual(picker([fortune, efficient])('stone'), efficient)
  const fresh = item('iron_pickaxe', 36, PLAIN, 10)
  const worn = item('iron_pickaxe', 37, PLAIN, 200)
  assert.strictEqual(picker([fresh, worn])('stone'), worn)
  assert.strictEqual(picker([fresh, worn], { held: fresh })('stone'), fresh)
})

test('on 1.7.10 a fortune pick is no better on iron ore, and on 1.21.11 it is', () => {
  const plain = item('iron_pickaxe', 36, PLAIN)
  const fortune = item('iron_pickaxe', 37, FORTUNE)
  assert.strictEqual(picker([fortune, plain], { legacy: true })('iron_ore'), plain)
  assert.strictEqual(picker([fortune, plain], { legacy: true })('coal_ore'), fortune)
  assert.strictEqual(picker([plain, fortune])('iron_ore'), fortune)
})

test('a pick equip swaps a held plain pick for the fortune pick of the same name on coal ore', async () => {
  const plain = item('iron_pickaxe', 36, PLAIN)
  const fortune = item('iron_pickaxe', 37, FORTUNE)
  const equips = []
  const bot = { heldItem: plain, inventory: { items: () => [plain, fortune] }, async equip (it) { equips.push(it.slot); bot.heldItem = it } }
  const { equipPickFor } = loadBotFunctions(['equipPickFor'], { bot, PICK_TIER: botConstant('PICK_TIER'), LEGACY_1710: false })
  assert.strictEqual(await equipPickFor('coal_ore'), true)
  assert.deepStrictEqual(equips, [37])
  assert.strictEqual(await equipPickFor('coal_ore'), true)
  assert.deepStrictEqual(equips, [37], 'the fortune pick already in hand')
})

test('a dig tool choice keeps the held tool over an equal one elsewhere in the pockets', () => {
  const spare = item('iron_axe', 9)
  const heldAxe = item('iron_axe', 36)
  const log = Block.fromStateId(registry.blocksByName.oak_log.defaultState, 0)
  const toolFor = (items, heldItem) => loadBotFunctions(['digToolFor'], {
    bot: { heldItem, inventory: { items: () => items } },
    PICK_TIER: botConstant('PICK_TIER'),
    DIG_TOOL: botConstant('DIG_TOOL'),
    LEGACY_HAND_DIG: botConstant('LEGACY_HAND_DIG'),
    LEGACY_1710: false
  }).digToolFor(log)
  assert.strictEqual(toolFor([spare, heldAxe], null), spare, 'control: the first of equal tools')
  assert.strictEqual(toolFor([spare, heldAxe], heldAxe), heldAxe)
  const stoneAxe = item('stone_axe', 36)
  assert.strictEqual(toolFor([spare, stoneAxe], stoneAxe), spare, 'a faster tool still wins')
})

const CELL = new Vec3(2, 64, 0)
const cellBlock = (name) => Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState, 0), { position: CELL })

// hotbar entries are [name, enchants] or null, held is the selected hotbar index.
async function digat (blockName, hotbar, held, query = {}) {
  const clock = fakeClock()
  let cell = cellBlock(blockName)
  const slots = new Array(46).fill(null)
  hotbar.forEach((spec, i) => { if (spec) slots[36 + i] = item(spec[0], 36 + i, spec[1]) })
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: Object.assign(new EventEmitter(), { slots, hotbarStart: 36, items: () => slots.filter(Boolean) }),
    quickBarSlot: held,
    setQuickBarSlot (i) { this.quickBarSlot = i },
    walks: 0,
    async equip (it) { this.quickBarSlot = slots.indexOf(it) - 36 },
    blockAt: () => cell,
    _client: { write () {} },
    digTime: () => 0,
    async dig (b) {
      this.dugWith = this.heldItem
      cell = cellBlock('air')
      this.emit(`blockUpdate:${CELL}`, b, cell)
    }
  })
  Object.defineProperty(bot, 'heldItem', { get () { return slots[36 + this.quickBarSlot] } })
  const env = {
    bot,
    bunker: { building: false },
    reflexes: [],
    guardState: { hand: null },
    digLock: botConstant('digLock'),
    stopPath () {},
    cellKnown: () => true,
    seenNow: () => true,
    require,
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    PICK_TIER: botConstant('PICK_TIER'),
    DIG_TOOL: botConstant('DIG_TOOL'),
    LEGACY_HAND_DIG: botConstant('LEGACY_HAND_DIG'),
    LEGACY_DIG_CONFIRM_MS: botConstant('LEGACY_DIG_CONFIRM_MS'),
    LEGACY_1710: false,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now }
  }
  loadBotFunctions(['wireHandLease'], { bot, guardState: env.guardState }).wireHandLease()
  const { handle, res } = routeHandler('/digat', env)
  await handle({ query: { x: '2', y: '64', z: '0', ...query } }, res)
  return { reply: res.body, error: res.error, dugWith: bot.dugWith, cell }
}

test('digat digs coal ore with the fortune pick when a plain pick of the same name is held', async () => {
  const r = await digat('coal_ore', [['iron_pickaxe', PLAIN], ['iron_pickaxe', FORTUNE]], 0)
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.dugWith.slot, 37)
})

test('digat digs glass with the silk touch pick only when silk is asked', async () => {
  const hotbar = [['iron_pickaxe', PLAIN], ['iron_pickaxe', SILK], null]
  const asked = await digat('glass', hotbar, 0, { silk: '1' })
  assert.strictEqual(asked.error, undefined, asked.error && asked.error.message)
  assert.strictEqual(asked.dugWith && asked.dugWith.slot, 37)
  const not = await digat('glass', hotbar, 1)
  assert.strictEqual(not.error, undefined, not.error && not.error.message)
  assert.strictEqual(not.dugWith, null, 'the bare hand')
})

test('digat with silk takes the silk touch pick over an axe on a bookshelf', async () => {
  const r = await digat('bookshelf', [['iron_axe'], ['iron_pickaxe', SILK]], 0, { silk: '1' })
  assert.strictEqual(r.dugWith && r.dugWith.slot, 37)
})

test('digat refuses silk without a silk touch pick that harvests the block, and digs nothing', async () => {
  const none = await digat('glass', [['iron_pickaxe', PLAIN]], 0, { silk: '1' })
  assert.match(none.error.message, /no silk touch pick carried/)
  assert.strictEqual(none.dugWith, undefined)
  const low = await digat('iron_ore', [['wooden_pickaxe', SILK], ['iron_pickaxe', PLAIN]], 1, { silk: '1' })
  assert.match(low.error.message, /^refusing to dig iron_ore: the wooden_pickaxe with silk touch does not harvest it/)
  assert.strictEqual(low.dugWith, undefined)
})

test('digat digs stone with the fortune pick when no plain pick is left', async () => {
  const r = await digat('stone', [['iron_pickaxe', FORTUNE], null], 1)
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.dugWith && r.dugWith.slot, 36)
})

test('a collect digs with the fork\'s tool choice and gives the tool plugin and the pathfinder their own back', async () => {
  const stock = { equip: async () => 'stock', harvest: () => 'stock' }
  const held = []
  const target = { type: 7, name: 'coal_ore' }
  const bot = {
    pathfinder: { movements: null, bestHarvestTool: stock.harvest, setMovements () {} },
    tool: { equipForBlock: stock.equip },
    collectBlock: {
      movements: null,
      async collect (b) {
        await bot.tool.equipForBlock(b)
        held.push(bot.pathfinder.bestHarvestTool(b), bot.pathfinder.bestHarvestTool({ type: 8, name: 'oak_leaves' }))
        throw new Error('walk failed')
      }
    }
  }
  class Movements { constructor () { this.openable = new Set() } }
  const env = {
    bot,
    Movements,
    shared: { mcData: { blocksArray: [] } },
    knownMoves: (m) => m,
    watchedWork: (work) => work(),
    abandonCollect () {},
    collectLock: botConstant('collectLock'),
    digLock: botConstant('digLock'),
    holdCollectTool: async (b, silk) => { held.push(`hold ${b.name} silk=${silk}`) },
    digToolFor: (b, { silk }) => `${b.name} silk=${silk}`
  }
  const { collectSafely } = loadBotFunctions(['collectSafely'], env)
  await assert.rejects(collectSafely(target, 'mine coal_ore', { silk: true }), /walk failed/)
  assert.deepStrictEqual(held, ['hold coal_ore silk=true', 'coal_ore silk=true', 'oak_leaves silk=false'])
  assert.strictEqual(bot.tool.equipForBlock, stock.equip)
  assert.strictEqual(bot.pathfinder.bestHarvestTool, stock.harvest)
})

test('a collect during the buried self-rescue answers busy naming it before any tool or collect', async () => {
  const calls = []
  const bot = {
    pathfinder: { movements: null, setMovements () {} },
    tool: {},
    collectBlock: {
      movements: null,
      async collect (b) {
        await bot.tool.equipForBlock(b)
        calls.push('collect')
      }
    }
  }
  class Movements { constructor () { this.openable = new Set() } }
  const env = {
    bot,
    Movements,
    shared: { mcData: { blocksArray: [] } },
    knownMoves: (m) => m,
    watchedWork: (work) => work(),
    abandonCollect () {},
    collectLock: botConstant('collectLock'),
    digLock: botConstant('digLock'),
    holdCollectTool: async () => { calls.push('hold') },
    digToolFor: () => null
  }
  const { collectSafely } = loadBotFunctions(['collectSafely'], env)
  const coal = { type: 7, name: 'coal_ore' }
  await collectSafely(coal, 'mine coal_ore')
  assert.deepStrictEqual(calls, ['hold', 'collect'], 'control: no rescue')
  calls.length = 0
  claimRescue(env.digLock)
  await assert.rejects(collectSafely(coal, 'mine coal_ore'), (e) => e.reason === 'busy' && /^busy: the buried self-rescue is running\b/.test(e.message))
  assert.deepStrictEqual(calls, [])
})

test('a collect with silk refuses without a silk touch pick, and without one asked holds the harvesting pick', async () => {
  const plain = item('iron_pickaxe', 36, PLAIN)
  const silk = item('iron_pickaxe', 37, SILK)
  const run = async (items, block, asked) => {
    const bot = { heldItem: null, inventory: { items: () => items, slots: [], hotbarStart: 36 }, async equip (it) { bot.heldItem = it } }
    const { holdCollectTool } = loadBotFunctions(['holdCollectTool'], { bot, PICK_TIER: botConstant('PICK_TIER'), DIG_TOOL: botConstant('DIG_TOOL'), LEGACY_HAND_DIG: botConstant('LEGACY_HAND_DIG'), LEGACY_1710: false })
    await holdCollectTool(block, asked)
    return bot.heldItem
  }
  const coal = Block.fromStateId(registry.blocksByName.coal_ore.defaultState, 0)
  assert.strictEqual(await run([plain, silk], coal, true), silk)
  assert.strictEqual(await run([silk, plain], coal, false), plain)
  await assert.rejects(run([plain], coal, true), (e) => e.name === 'NoSilk' && /^refusing to dig coal_ore: no silk touch pick carried$/.test(e.message))
  await assert.rejects(run([], coal, false), (e) => e.reason === 'no carried tool harvests coal_ore')
})

test('a silk dig takes a silk touch pick the server sent back as a new item as held', async () => {
  const silk = item('iron_pickaxe', 9, SILK)
  const bot = { heldItem: null, inventory: { items: () => [silk] }, async equip () { bot.heldItem = item('iron_pickaxe', 36, SILK) } }
  const { holdHarvester } = loadBotFunctions(['holdHarvester'], { bot, PICK_TIER: botConstant('PICK_TIER'), LEGACY_1710: false })
  const glass = Block.fromStateId(registry.blocksByName.glass.defaultState, 0)
  assert.strictEqual(await holdHarvester(glass, { silk: true }), null)
})

test('mine and gather refuse silk without a silk touch pick before they look for a block', () => {
  const plain = item('iron_pickaxe', 36, PLAIN)
  for (const [route, query] of [['/mine', { name: 'glass', silk: '1' }], ['/gather', { resource: 'glass', silk: '1' }]]) {
    const { handle, res } = routeHandler(route, {
      bot: { inventory: { items: () => [plain] } },
      require,
      PICK_TIER: botConstant('PICK_TIER'),
      LEGACY_1710: false,
      collectLock: botConstant('collectLock'),
      resolveBlockIds: () => { throw new Error('looked for a block') },
      jobs: { start () { throw new Error('started a job') } }
    })
    handle({ query }, res)
    assert.match(res.error && res.error.message, /no silk touch pick carried/, route)
  }
})

test('inventory names the enchantments of an enchanted item and leaves them out of a plain one', () => {
  const slots = new Array(46).fill(null)
  slots[36] = item('iron_pickaxe', 36, { fortune: 3, unbreaking: 2 })
  slots[37] = item('iron_pickaxe', 37, PLAIN)
  slots[5] = item('iron_helmet', 5, { protection: 4 })
  const bot = { inventory: { slots, items: () => [slots[36], slots[37]], emptySlotCount: () => 34 } }
  const { wear } = loadBotFunctions(['wear'], { LEGACY_1710: false })
  const reply = runRoute('/inventory', {}, { bot, shared: { ready: true }, LEGACY_1710: false, wear })
  assert.deepStrictEqual(reply.items.map((i) => i.enchants), [{ fortune: 3, unbreaking: 2 }, undefined])
  assert.deepStrictEqual(reply.worn[0].enchants, { protection: 4 })
})
