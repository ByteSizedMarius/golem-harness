'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const Item = require('prismarine-item')(registry)
const { loadBotFunctions, botConstant, routeHandler, fakeClock } = require('./helpers')

const SWORD = { name: 'iron_sword', type: 1 }
const WOOD_PICK = { name: 'wooden_pickaxe', type: 2 }
const STONE_PICK = { name: 'stone_pickaxe', type: 3 }
const IRON_ORE = {
  name: 'iron_ore',
  harvestTools: { 3: true },
  canHarvest (type) { return !!this.harvestTools[type] }
}

// equipTakes(k) says whether the k-th equip (0-based) puts the item in hand.
function hands ({ held, items, equipTakes = () => true }) {
  const bot = { heldItem: held, inventory: { items: () => items }, equips: 0 }
  bot.equip = async (item) => { if (equipTakes(bot.equips++)) bot.heldItem = item }
  const ctx = loadBotFunctions(['holdHarvester'], { bot, PICK_TIER: botConstant('PICK_TIER') })
  return { bot, holdHarvester: ctx.holdHarvester }
}

test('digat puts the harvesting tool back in hand when another item holds it', async () => {
  const h = hands({ held: SWORD, items: [SWORD, WOOD_PICK, STONE_PICK] })
  assert.strictEqual(await h.holdHarvester(IRON_ORE), null)
  assert.strictEqual(h.bot.heldItem, STONE_PICK)
})

test('digat tries the equip again when the first one does not take', async () => {
  const h = hands({ held: SWORD, items: [SWORD, STONE_PICK], equipTakes: (k) => k > 0 })
  assert.strictEqual(await h.holdHarvester(IRON_ORE), null)
  assert.strictEqual(h.bot.equips, 2)
  assert.strictEqual(h.bot.heldItem, STONE_PICK)
})

test('digat refuses when the harvesting tool never reaches the hand', async () => {
  const h = hands({ held: SWORD, items: [SWORD, STONE_PICK], equipTakes: () => false })
  const why = await h.holdHarvester(IRON_ORE)
  assert.match(why, /^refusing to dig iron_ore/)
  assert.match(why, /stone_pickaxe/)
  assert.match(why, /iron_sword/)
})

test('digat leaves the hand alone when it holds a harvester or none is carried', async () => {
  const held = hands({ held: STONE_PICK, items: [STONE_PICK] })
  assert.strictEqual(await held.holdHarvester(IRON_ORE), null)
  assert.strictEqual(held.bot.equips, 0, 'a harvester already in hand')
  const none = hands({ held: SWORD, items: [SWORD, WOOD_PICK] })
  assert.strictEqual(await none.holdHarvester(IRON_ORE), null)
  assert.strictEqual(none.bot.equips, 0, 'no carried tool harvests it')
  const dirt = hands({ held: SWORD, items: [SWORD, STONE_PICK] })
  assert.strictEqual(await dirt.holdHarvester({ name: 'dirt', harvestTools: undefined, canHarvest: () => true }), null)
  assert.strictEqual(dirt.bot.equips, 0, 'a block any hand harvests')
})

const CELL = new Vec3(2, 64, 0)
const cellBlock = (name) => Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState, 0), { position: CELL })

// hotbar entries are a name, [name, damage] or null. during is block names, after and slot are [ms, name] updates.
// With fighting the combat reflex is busy. Each equip takes equipMs, the dig's look lookMs and the dig digMs, in fake time.
// With reflex the combat reflex reaches for the sword as the dig starts.
async function digRun (blockName, hotbar, held, legacy, { during = [], after = [[20, 'air']], slot = [], fighting = false, equipMs = 0, lookMs = 0, digMs = 0, digTimeMs = digMs, reflex = false } = {}, query = {}) {
  const clock = fakeClock()
  let cell = cellBlock(blockName)
  const slots = new Array(46).fill(null)
  hotbar.forEach((spec, i) => {
    if (!spec) return
    const [name, damage] = [].concat(spec)
    slots[36 + i] = Object.assign(new Item(registry.itemsByName[name].id, 1), { slot: 36 + i })
    if (damage) slots[36 + i].durabilityUsed = damage
  })
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    inventory: Object.assign(new EventEmitter(), { slots, hotbarStart: 36, items: () => slots.filter(Boolean) }),
    quickBarSlot: held,
    setQuickBarSlot (i) { this.quickBarSlot = i },
    equips: [],
    async equip (item) {
      if (equipMs) await new Promise(resolve => clock.setTimeout(resolve, equipMs))
      this.equips.push(item.name)
      this.quickBarSlot = slots.indexOf(item) - 36
    },
    blockAt: () => cell,
    targetDigBlock: null,
    leasedAtWrite: null,
    log: [],
    _client: { write () {} },
    digTime: () => digTimeMs,
    async dig (b) {
      if (lookMs) await new Promise(resolve => clock.setTimeout(resolve, lookMs))
      this.leasedAtWrite = !!env.guardState.hand
      this.dugWith = this.heldItem ? this.heldItem.name : null
      this._client.write('block_dig', { status: 0, location: b.position, face: 1 })
      if (reflex) hand.handFree().then(() => this.log.push(`sword at ${clock.now()}`))
      const update = (name) => { const old = cell; cell = cellBlock(name); this.emit(`blockUpdate:${CELL}`, old, cell) }
      this.targetDigBlock = b
      during.forEach(update)
      if (digMs) await new Promise(resolve => clock.setTimeout(resolve, digMs))
      this.log.push(`dug at ${clock.now()}`)
      this._client.write('block_dig', { status: 2, location: b.position, face: 1 })
      this.targetDigBlock = null
      // mineflayer's own air write at the end of its timer.
      update('air')
      for (const [ms, name] of after) clock.setTimeout(() => update(name), ms)
      const s = 36 + this.quickBarSlot
      for (const [ms, name] of slot) {
        clock.setTimeout(() => {
          const old = slots[s]
          slots[s] = name && Object.assign(new Item(registry.itemsByName[name].id, 1), { slot: s })
          this.inventory.emit('updateSlot', s, old, slots[s])
        }, ms)
      }
    }
  })
  Object.defineProperty(bot, 'heldItem', { get () { return slots[36 + this.quickBarSlot] } })
  const env = {
    bot,
    bunker: { building: false },
    reflexes: [{ name: 'combat', fightBusy: () => fighting, _threat: null }],
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
    LEGACY_1710: legacy,
    setTimeout: (fn, ms) => { timers.push(ms); return clock.setTimeout(fn, ms) },
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now }
  }
  const timers = []
  const hand =loadBotFunctions(['wireHandLease', 'handFree'], { bot, guardState: env.guardState })
  hand.wireHandLease()
  const { handle, res } = routeHandler('/digat', env)
  const done = handle({ query: { x: '2', y: '64', z: '0', ...query } }, res)
  while (res.body === undefined && res.error === undefined && clock.now() < 10000) {
    await new Promise(setImmediate)
    clock.advance(1)
  }
  await done
  assert.strictEqual(bot.listenerCount(`blockUpdate:${CELL}`), 0, 'a block listener outlived the reply')
  assert.strictEqual(bot.inventory.listenerCount('updateSlot'), 0, 'a slot listener outlived the reply')
  return { reply: res.body && JSON.parse(JSON.stringify(res.body)), error: res.error, ms: clock.now(), bot, timers }
}

async function digWith (blockName, hotbar, held, legacy = false) {
  const r = await digRun(blockName, hotbar, held, legacy)
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  return r
}

const TOOLS = ['wooden_pickaxe', 'stone_axe', 'wooden_shovel', 'iron_pickaxe', 'stone_pickaxe', null]

test('digat refuses while the combat reflex is busy, before any tool goes into the hand', async () => {
  const r = await digRun('oak_log', TOOLS, 5, false, { fighting: true })
  assert.match(r.error.message, /^refused: fighting something, the guard reflex holds the hand\./)
  assert.strictEqual(r.error.reason, 'fighting')
  assert.deepStrictEqual([r.bot.equips, r.bot.dugWith], [[], undefined])
})

test('digat keeps the hand lease through the dig\'s look after slow equips used up the first 2 s', async () => {
  const r = await digRun('iron_ore', TOOLS, 1, false, { equipMs: 1800, lookMs: 600 })
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.bot.dugWith, 'iron_pickaxe')
  assert.strictEqual(r.bot.leasedAtWrite, true, 'the lease ended before the dig started')
})

test('digat holds the hand through a dig over 2 s, and the reflex\'s sword waits for the dig to end', async () => {
  const r = await digRun('stone', [['stone_pickaxe']], 0, false, { digMs: 3000, reflex: true })
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(r.bot.log, ['dug at 3000', 'sword at 3000'])
})

test('digat gives the hand back once a dig outlasts its dig time by 500 ms', async () => {
  const r = await digRun('stone', [['stone_pickaxe']], 0, false, { digMs: 4000, digTimeMs: 3000, reflex: true })
  assert.deepStrictEqual(r.bot.log, ['sword at 3500', 'dug at 4000'])
})

test('digat holds the hand at most 30 s for a block with no finite dig time', async () => {
  const r = await digRun('bedrock', [['stone_pickaxe']], 0, false, { digTimeMs: Infinity })
  assert.deepStrictEqual(r.timers, [2000, 30000])
})

test('digat refuses with a retry once slow equips ended the hand lease, before the dig', async () => {
  const r = await digRun('iron_ore', TOOLS, 1, false, { equipMs: 2100 })
  assert.match(r.error.message, /^lost the hand during the equip, nothing dug, retry$/)
  assert.strictEqual(r.bot.dugWith, undefined)
})

test('digat digs a log with an axe, dirt with a shovel, ore with the best pick up to iron and a crop bare-handed', async () => {
  const log = await digWith('oak_log', TOOLS, 5)
  assert.strictEqual(log.bot.dugWith, 'stone_axe')
  assert.strictEqual(log.reply.with, 'stone_axe')
  assert.strictEqual((await digWith('dirt', TOOLS, 0)).bot.dugWith, 'wooden_shovel')
  assert.strictEqual((await digWith('iron_ore', TOOLS, 1)).bot.dugWith, 'iron_pickaxe')
  const crop = await digWith('wheat', TOOLS, 0)
  assert.deepStrictEqual(crop.bot.equips, [], 'a crop')
  assert.strictEqual(crop.bot.dugWith, null)
  assert.strictEqual(crop.reply.with, null)
})

test('digat digs hay and leaves with a hoe, but bare-handed on 1.7.10, where a hoe speeds no dig', async () => {
  const hotbar = ['stone_axe', 'iron_hoe', null]
  for (const name of ['hay_block', 'oak_leaves']) {
    assert.strictEqual((await digWith(name, hotbar, 2)).bot.dugWith, 'iron_hoe', `${name} on 1.21.11`)
    assert.strictEqual((await digWith(name, hotbar, 2, true)).bot.dugWith, null, `${name} on 1.7.10`)
  }
})

test('digat answers a cave air cell as already air', async () => {
  const r = await digWith('cave_air', TOOLS, 0)
  assert.deepStrictEqual(r.reply, { already: 'air', at: { x: 2, y: 64, z: 0 } })
  assert.strictEqual(r.bot.dugWith, undefined)
})

function wrappedDigTime (legacy, held) {
  const bot = Object.assign(new EventEmitter(), {
    heldItem: new Item(registry.itemsByName[held].id, 1),
    game: { gameMode: 'survival' },
    entity: { onGround: true, effects: {} },
    _getBlockAtEyeLevel: () => null
  })
  bot.digTime = (b) => b.digTime(bot.heldItem.type, false, false, false, [], {})
  loadBotFunctions(['wireLegacyDigTime'], { bot, LEGACY_1710: legacy, LEGACY_HAND_DIG: botConstant('LEGACY_HAND_DIG') }).wireLegacyDigTime()
  bot.emit('inject_allowed')
  return bot.digTime
}

test('on 1.7.10 an axe digs a ladder at hand speed, and on 1.21.11 at axe speed', () => {
  const ladder = cellBlock('ladder')
  const hand = ladder.digTime(null, false, false, false)
  const axe = ladder.digTime(registry.itemsByName.iron_axe.id, false, false, false)
  assert.ok(axe < hand)
  assert.strictEqual(wrappedDigTime(true, 'iron_axe')(ladder), hand)
  assert.strictEqual(wrappedDigTime(false, 'iron_axe')(ladder), axe)
  const stone = cellBlock('stone')
  assert.strictEqual(wrappedDigTime(true, 'stone_pickaxe')(stone), stone.digTime(registry.itemsByName.stone_pickaxe.id, false, false, false))
})

const AT = { x: 2, y: 64, z: 0 }

test('digat digs a ladder bare-handed on 1.7.10 and with an axe on 1.21.11', async () => {
  const hotbar = ['iron_axe', null]
  const modern = await digWith('ladder', hotbar, 0)
  assert.deepStrictEqual(modern.reply, { dug: 'ladder', at: AT, with: 'iron_axe' })
  const legacy = await digWith('ladder', hotbar, 0, true)
  assert.strictEqual(legacy.bot.dugWith, null)
  assert.deepStrictEqual(legacy.reply, { dug: 'ladder', at: AT, with: null })
})

test('on 1.7.10 digat answers on the server\'s block update', async () => {
  const r = await digRun('stone', [['stone_pickaxe']], 0, true, { after: [[40, 'air']] })
  assert.deepStrictEqual(r.reply, { dug: 'stone', at: AT, with: 'stone_pickaxe' })
  assert.ok(r.ms >= 40 && r.ms < botConstant('LEGACY_DIG_CONFIRM_MS'), `replied at ${r.ms} ms`)
})

test('on 1.7.10 digat calls a dig unconfirmed when only its own air write reached the cell', async () => {
  const r = await digRun('stone', [['stone_pickaxe']], 0, true, { after: [] })
  assert.strictEqual(r.reply.dug, 'stone')
  assert.match(r.reply.unconfirmed, /^no block update from the server within \d+ ms$/)
})

test('on 1.7.10 digat waits past a resent block for the server\'s break', async () => {
  const r = await digRun('ladder', [null], 0, true, { after: [[10, 'ladder'], [600, 'air']] })
  assert.deepStrictEqual(r.reply, { dug: 'ladder', at: AT, with: null })
})

test('on 1.7.10 digat fails when the server resends the block and never breaks it', async () => {
  const r = await digRun('ladder', [null], 0, true, { after: [[10, 'ladder']] })
  assert.strictEqual(r.reply, undefined)
  assert.match(r.error.message, /^the server resent the ladder at 2,64,0 and had not broken it after \d+ ms$/)
})

test('on 1.7.10 digat counts the server\'s update during the dig and names a block that filled the cell', async () => {
  const during = await digRun('stone', [['stone_pickaxe']], 0, true, { during: ['air'], after: [] })
  assert.deepStrictEqual(during.reply, { dug: 'stone', at: AT, with: 'stone_pickaxe' })
  const fell = await digRun('stone', [['stone_pickaxe']], 0, true, { after: [[20, 'gravel']] }, { then: 'blockat' })
  assert.deepStrictEqual(fell.reply, { dug: 'stone', at: AT, with: 'stone_pickaxe', now: 'gravel', verify: { name: 'gravel', at: AT } })
})

test('on 1.7.10 digat reports a tool that broke on its last use', async () => {
  const max = registry.itemsByName.stone_pickaxe.maxDurability
  const last = await digRun('stone', [['stone_pickaxe', max]], 0, true, { after: [[20, 'air']], slot: [[80, null]] })
  assert.deepStrictEqual(last.reply, { dug: 'stone', at: AT, with: 'stone_pickaxe', toolBroke: true })
  const worn = await digRun('stone', [['stone_pickaxe', max - 1]], 0, true, { after: [[20, 'air']], slot: [[80, 'stone_pickaxe']] })
  assert.deepStrictEqual(worn.reply, { dug: 'stone', at: AT, with: 'stone_pickaxe' })
  assert.ok(worn.ms < 80, 'waited for the slot of a tool with uses left')
})
