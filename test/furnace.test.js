'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { smeltYield } = require('../lib/furnace')
const { HUNG, awaitRoute, routeHandler, timed } = require('./helpers')

const IDS = { iron_ore: 1, iron_ingot: 2, coal: 3, sand: 4, glass: 5 }
const stack = (name, count) => ({ name, type: IDS[name], count, stackSize: 64 })
const AT = new Vec3(3, 64, 0)

// A fake furnace window whose transfer picks slots the way mineflayer's does.
function furnaceWindow ({ input = null, fuel = null, output = null, pockets = [] }) {
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
    closed: false,
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

function furnaceEnv (f) {
  const logs = []
  const block = { name: 'furnace', position: AT }
  const env = {
    bot: {
      findBlock: () => block,
      blockAt: (p) => (p.equals(AT) ? block : { name: 'stone', position: p }),
      pathfinder: { goto: async () => {} },
      openFurnace: async (b) => { assert.strictEqual(b, block); return f.window },
      transfer: async (o) => { assert.strictEqual(o.window, f.window); f.transfer(o) },
      waitForTicks: async () => {}
    },
    ready: true,
    goals,
    Vec3,
    smeltYield,
    resolveBlockIds: () => [61],
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    console: { log: (line) => logs.push(line) }
  }
  return { env, logs }
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

  const foreign = furnaceWindow({ fuel: stack('coal', 1), output: stack('glass', 5), pockets: [stack('iron_ore', 6)] })
  const foreignReply = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, furnaceEnv(foreign).env)
  assert.strictEqual(foreignReply.took, undefined)
  assert.strictEqual(foreignReply.output, '5 glass')
  assert.match(foreignReply.note, /5 glass/)
  assert.strictEqual(foreign.pocket('glass'), 0)
})

test('the furnace tool lists the slots and the burn progress of the furnace at x,y,z', async () => {
  const f = furnaceWindow({ input: stack('iron_ore', 10), fuel: stack('coal', 2), output: stack('iron_ingot', 6) })
  f.window.progress = 0.456
  f.window.fuel = 0.5
  const { env } = furnaceEnv(f)
  env.bot.findBlock = () => null
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
