'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { smeltYield, burnItems, COOK_PROBE_TICKS } = require('../lib/furnace')
const { HUNG, awaitRoute, routeHandler, timed } = require('./helpers')

const IDS = { iron_ore: 1, iron_ingot: 2, coal: 3, sand: 4, glass: 5, stone: 6, stick: 7, blaze_rod: 8, deepslate_bricks: 9 }
const stack = (name, count) => ({ name, type: IDS[name], count, stackSize: 64 })
const HERE = new Vec3(0.5, 64, 0.5)
const AT = new Vec3(3, 64, 0)
const UNSEEN = /not in my sight, blocked or unlit/

// A fake furnace window whose transfer picks slots the way mineflayer's does. While input and fuel
// are loaded, cook progress shows from tick cookFrom on, and never when cookFrom is null.
function furnaceWindow ({ input = null, fuel = null, output = null, pockets = [], cookFrom = 0 }) {
  const slots = [input, fuel, output, ...pockets]
  while (slots.length < 39) slots.push(null)
  const set = (i, item) => { slots[i] = item && { ...item, slot: i } }
  slots.forEach((s, i) => set(i, s))
  function transfer ({ itemType, count, sourceStart, sourceEnd, destStart, destEnd }) {
    while (count > 0) {
      const from = slots.findIndex((s, i) => i >= sourceStart && i < sourceEnd && s && s.type === itemType)
      if (from < 0) throw new Error(`no item ${itemType} in slots ${sourceStart} to ${sourceEnd}`)
      const src = slots[from]
      let to = slots.findIndex((s, i) => i >= destStart && i < destEnd && s && s.type === itemType && s.count < s.stackSize)
      if (to < 0) to = slots.findIndex((s, i) => i >= destStart && i < destEnd && !s)
      if (to < 0) throw new Error('destination full')
      const moved = Math.min(count, src.count, src.stackSize - (slots[to] ? slots[to].count : 0))
      set(to, { ...src, count: (slots[to] ? slots[to].count : 0) + moved })
      set(from, src.count > moved ? { ...src, count: src.count - moved } : null)
      count -= moved
    }
  }
  const window = {
    slots,
    inventoryStart: 3,
    inventoryEnd: 39,
    progress: null,
    fuel: null,
    ticks: 0,
    closed: false,
    tick (n) {
      window.ticks += n
      if (cookFrom !== null && window.ticks >= cookFrom && slots[0] && (slots[1] || window.fuel > 0)) window.progress = Math.max(window.progress || 0, 0.01)
    },
    inputItem: () => slots[0],
    fuelItem: () => slots[1],
    outputItem: () => slots[2],
    items: () => slots.slice(3).filter(Boolean),
    emptySlotCount: () => slots.slice(3).filter((s) => !s).length,
    close () { window.closed = true },
    putInput: async (itemType, metadata, count) => transfer({ itemType, count, sourceStart: 3, sourceEnd: 39, destStart: 0, destEnd: 1 }),
    putFuel: async (itemType, metadata, count) => transfer({ itemType, count, sourceStart: 3, sourceEnd: 39, destStart: 1, destEnd: 2 })
  }
  const pocket = (name) => window.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  return { window, transfer, pocket }
}

// seen tells whether the furnace cell is in lit sight or was seen, and walks collects the goals the pathfinder was sent.
function furnaceEnv (f, seen = true) {
  const logs = []
  const walks = []
  const block = { name: 'furnace', position: AT }
  const env = {
    bot: {
      entity: { position: HERE },
      findBlocks: ({ matching }) => (matching.includes(61) ? [AT] : []),
      blockAt: (p) => (p.equals(AT) ? block : { name: 'stone', position: p }),
      pathfinder: { goto: async (goal) => { walks.push(goal) } },
      openFurnace: async (b) => { assert.strictEqual(b, block); return f.window },
      transfer: async (o) => { assert.strictEqual(o.window, f.window); f.transfer(o) },
      waitForTicks: async (n) => f.window.tick(n)
    },
    cellKnown: (p) => seen || !p.equals(AT),
    seenNow: (p) => seen || !p.equals(AT),
    STATIONS: new Map(),
    ck: (x, y, z) => x + ',' + y + ',' + z,
    shared: { ready: true },
    goals,
    Vec3,
    smeltYield,
    burnItems,
    COOK_PROBE_TICKS,
    resolveBlockIds: () => [61],
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    console: { log: (line) => logs.push(line) }
  }
  return { env, logs, walks }
}

async function refusal (route, query, env) {
  const { handle, res } = routeHandler(route, env)
  await handle({ query }, res)
  assert.ok(res.error, `${route} answered ${JSON.stringify(res.body)}`)
  return res.error.message
}

test('smelt loads input and fuel and returns at once with the burn time, logging each step', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 22), stack('coal', 5)] })
  const { env, logs } = furnaceEnv(f)
  const { out } = await timed(awaitRoute('/smelt', { item: 'iron_ore', count: '30' }, env), 1000)
  assert.notStrictEqual(out, HUNG, 'smelt waited for the burn')
  assert.deepStrictEqual(out, { at: { x: 3, y: 64, z: 0 }, loaded: 22, input: '22 iron_ore', fuel: '3 coal', output: null, doneInSec: 220 })
  assert.ok(f.window.closed, 'the window stays open')
  assert.deepStrictEqual(logs, [
    '[smelt] opened {"input":null,"fuel":null,"output":null}',
    '[smelt] loaded input {"input":"22 iron_ore","fuel":null,"output":null}',
    '[smelt] loaded fuel {"input":"22 iron_ore","fuel":"3 coal","output":null}'
  ])
})

test('smelt refuses a furnace busy with another input, names it and moves nothing', async () => {
  const f = furnaceWindow({ input: stack('iron_ore', 22), pockets: [stack('sand', 10), stack('coal', 5)] })
  const { env } = furnaceEnv(f)
  assert.match(await refusal('/smelt', { item: 'sand', count: '10' }, env), /busy with 22 iron_ore/)
  assert.strictEqual(f.window.inputItem().count, 22)
  assert.deepStrictEqual([f.pocket('iron_ore'), f.pocket('sand'), f.pocket('coal')], [0, 10, 5])
  assert.ok(f.window.closed, 'the window stays open')
})

test('smelt takes its own finished output into the pockets and leaves a foreign one', async () => {
  const own = furnaceWindow({ input: stack('iron_ore', 2), fuel: stack('coal', 1), output: stack('iron_ingot', 4), pockets: [stack('iron_ore', 6)] })
  const ownReply = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, furnaceEnv(own).env)
  assert.strictEqual(ownReply.took, '4 iron_ingot')
  assert.strictEqual(own.pocket('iron_ingot'), 4)
  assert.strictEqual(ownReply.output, null)

  // A foreign output stops the furnace, so its stall is no verdict on the recipe.
  const foreign = furnaceWindow({ fuel: stack('coal', 1), output: stack('glass', 5), pockets: [stack('iron_ore', 6)], cookFrom: null })
  const foreignReply = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, furnaceEnv(foreign).env)
  assert.strictEqual(foreignReply.took, undefined)
  assert.strictEqual(foreignReply.output, '5 glass')
  assert.match(foreignReply.note, /5 glass/)
  assert.strictEqual(foreign.pocket('glass'), 0)
})

test('the furnace tool lists the slots and the burn progress of the seen furnace at x,y,z', async () => {
  const f = furnaceWindow({ input: stack('iron_ore', 10), fuel: stack('coal', 2), output: stack('iron_ingot', 6) })
  f.window.progress = 0.456
  f.window.fuel = 0.5
  const { env } = furnaceEnv(f)
  env.bot.findBlocks = () => []
  const reply = await awaitRoute('/furnace', { at: '3,64,0' }, env)
  assert.deepStrictEqual(reply, { at: { x: 3, y: 64, z: 0 }, input: '10 iron_ore', fuel: '2 coal', output: '6 iron_ingot', progress: 0.46, fuelLeft: 0.5 })
  assert.ok(f.window.closed, 'the window stays open')
})

test('the furnace tool takes count from the input and the whole output stack', async () => {
  const f = furnaceWindow({ input: stack('iron_ore', 10), output: stack('iron_ingot', 6) })
  const { env } = furnaceEnv(f)
  const input = await awaitRoute('/furnace', { take: 'input', count: '4' }, env)
  assert.strictEqual(input.took, '4 iron_ore')
  assert.deepStrictEqual([f.window.inputItem().count, f.pocket('iron_ore')], [6, 4])
  const output = await awaitRoute('/furnace', { take: 'output', count: '2' }, env)
  assert.strictEqual(output.took, '6 iron_ingot')
  assert.deepStrictEqual([f.window.outputItem(), f.pocket('iron_ingot')], [null, 6])
})

test('furnace by x,y,z and smelt refuse an unseen furnace without walking to it or naming it', async () => {
  const f = furnaceWindow({ input: stack('iron_ore', 10), pockets: [stack('iron_ore', 4), stack('coal', 5)] })
  const { env, walks } = furnaceEnv(f, false)
  env.bot.openFurnace = async () => assert.fail('opened an unseen furnace')
  const atError = await refusal('/furnace', { at: '3,64,0' }, env)
  assert.match(atError, UNSEEN)
  assert.doesNotMatch(atError, /furnace|iron/)
  const nearError = await refusal('/smelt', { item: 'iron_ore' }, env)
  assert.match(nearError, /no furnace seen within 8/)
  assert.doesNotMatch(nearError, /3,64,0|iron/)
  assert.deepStrictEqual(walks, [])
  assert.deepStrictEqual([f.window.inputItem().count, f.pocket('iron_ore'), f.pocket('coal')], [10, 4, 5])
})

test('smelt takes an input the furnace never cooks back into the pockets, leaves the fuel and answers no-recipe', async () => {
  const f = furnaceWindow({ pockets: [stack('stone', 8), stack('coal', 5)], cookFrom: null })
  const { handle, res } = routeHandler('/smelt', furnaceEnv(f).env)
  await handle({ query: { item: 'stone', count: '8' } }, res)
  assert.ok(res.error, `smelt answered ${JSON.stringify(res.body)}`)
  assert.strictEqual(res.error.reason, 'no-recipe')
  assert.strictEqual(res.error.message, 'this server does not smelt stone: took 8 stone back, left the 1 coal in the fuel slot')
  assert.deepStrictEqual([f.window.inputItem(), f.window.fuelItem().count, f.pocket('stone'), f.pocket('coal')], [null, 1, 8, 4])
  assert.ok(f.window.ticks >= COOK_PROBE_TICKS, `gave up after ${f.window.ticks} ticks`)
  assert.ok(f.window.closed, 'the window stays open')
})

test('smelt loads an input its table does not know once the furnace cooks it', async () => {
  const f = furnaceWindow({ pockets: [stack('deepslate_bricks', 4), stack('coal', 1)] })
  const reply = await awaitRoute('/smelt', { item: 'deepslate_bricks', count: '4' }, furnaceEnv(f).env)
  assert.deepStrictEqual(reply, { at: { x: 3, y: 64, z: 0 }, loaded: 4, input: '4 deepslate_bricks', fuel: '1 coal', output: null, doneInSec: 40 })
})

test('smelt waits for a furnace slow to start cooking and leaves it loaded', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 8), stack('coal', 1)], cookFrom: 30 })
  const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '8' }, furnaceEnv(f).env)
  assert.deepStrictEqual([reply.input, reply.fuel, reply.doneInSec], ['8 iron_ore', '1 coal', 80])
  assert.ok(f.window.ticks >= 30, `replied after ${f.window.ticks} ticks, before the furnace cooked`)
})

test('smelt reports the burn time only for what its fuel covers, a stick half an item and a blaze rod twelve', async () => {
  const sticks = furnaceWindow({ pockets: [stack('iron_ore', 8), stack('stick', 1)] })
  const stick = await awaitRoute('/smelt', { item: 'iron_ore', count: '8', fuel: 'stick' }, furnaceEnv(sticks).env)
  assert.deepStrictEqual([stick.fuel, stick.doneInSec, stick.fuelFor], ['1 stick', 5, 0.5])

  const rods = furnaceWindow({ pockets: [stack('iron_ore', 12), stack('blaze_rod', 3)] })
  const rod = await awaitRoute('/smelt', { item: 'iron_ore', count: '12', fuel: 'blaze_rod' }, furnaceEnv(rods).env)
  assert.deepStrictEqual([rod.fuel, rod.doneInSec, rod.fuelFor], ['1 blaze_rod', 120, undefined])
  assert.strictEqual(rods.pocket('blaze_rod'), 2)
})

test('smelt counts the fuel the flame shows still burning', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 12), stack('coal', 5)] })
  f.window.fuel = 0.5
  const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '12' }, furnaceEnv(f).env)
  assert.deepStrictEqual([reply.fuel, reply.doneInSec, f.pocket('coal')], ['1 coal', 120, 4])
})
