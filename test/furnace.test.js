'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { smeltYield, burnItems, COOK_PROBE_TICKS } = require('../lib/furnace')
const { LEGACY_CLICK_REACH } = require('../lib/bot/legacy-1710')
const { HUNG, awaitRoute, loadBotFunctions, routeHandler, timed, fakeClock, botConstant } = require('./helpers')

const IDS = { iron_ore: 1, iron_ingot: 2, coal: 3, sand: 4, glass: 5, stone: 6, stick: 7, blaze_rod: 8, deepslate_bricks: 9, oak_log: 10, charcoal: 11 }
const stack = (name, count) => ({ name, type: IDS[name], count, stackSize: 64 })
const HERE = new Vec3(0.5, 64, 0.5)
const AT = new Vec3(3, 64, 0)
const UNSEEN = /not in my sight, blocked or unlit/
const READ_MS = botConstant('LEGACY_CLOSE_READ_MS')
const unconfirmed = (names) => `the server did not confirm my ${names} pocket slots within ${READ_MS} ms of closing the furnace`

// A fake clock that moves in 10 ms steps, one per event loop turn, while a timer waits.
function autoClock () {
  const clock = fakeClock()
  let moving = false
  const step = () => {
    clock.advance(10)
    if (clock.pending()) setImmediate(step)
    else moving = false
  }
  return {
    now: clock.now,
    clearTimeout: clock.clearTimeout,
    setTimeout (fn, ms) {
      const id = clock.setTimeout(fn, ms)
      if (!moving) {
        moving = true
        setImmediate(step)
      }
      return id
    }
  }
}

// A fake furnace whose server refuses the moves named in rejects and answers a legacy close with set_slots for the changed pocket slots.
function furnaceWindow ({ input = null, fuel = null, output = null, pockets = [], cookFrom = 0, lights = false, legacy = false, rejects = [], answers = true, pickup = null }) {
  const slots = [input, fuel, output, ...pockets]
  while (slots.length < 39) slots.push(null)
  const set = (on, i, item) => { on[i] = item && { ...item, slot: i } }
  slots.forEach((s, i) => set(slots, i, s))
  const server = [...slots]
  const atOpen = [...slots]
  const client = new EventEmitter()
  const bot = new EventEmitter()
  const clock = autoClock()
  const packets = []
  const components = (s) => JSON.stringify([s.components ?? [], s.removedComponents ?? []])
  function move (on, { itemType, count, sourceStart, sourceEnd, destStart, destEnd }) {
    while (count > 0) {
      const from = on.findIndex((s, i) => i >= sourceStart && i < sourceEnd && s && s.type === itemType)
      if (from < 0) throw new Error(`no item ${itemType} in slots ${sourceStart} to ${sourceEnd}`)
      const src = on[from]
      let to = on.findIndex((s, i) => i >= destStart && i < destEnd && s && s.type === itemType && s.count < s.stackSize && components(s) === components(src))
      if (to < 0) to = on.findIndex((s, i) => i >= destStart && i < destEnd && !s)
      if (to < 0) throw new Error('destination full')
      const moved = Math.min(count, src.count, src.stackSize - (on[to] ? on[to].count : 0))
      set(on, to, { ...src, count: (on[to] ? on[to].count : 0) + moved })
      set(on, from, src.count > moved ? { ...src, count: src.count - moved } : null)
      count -= moved
    }
  }
  function transfer (o, what = 'take') {
    if (rejects.includes(what)) {
      if (legacy) move(slots, o)
      return
    }
    move(server, o)
    move(slots, o)
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
      if (lights && slots[0] && slots[1] && !(window.fuel > 0)) {
        window.fuel = 1
        set(slots, 1, slots[1].count > 1 ? { ...slots[1], count: slots[1].count - 1 } : null)
      }
      if (cookFrom !== null && window.ticks >= cookFrom && slots[0] && (slots[1] || window.fuel > 0)) window.progress = Math.max(window.progress || 0, 0.01)
    },
    inputItem: () => slots[0],
    fuelItem: () => slots[1],
    outputItem: () => slots[2],
    items: () => slots.slice(3).filter(Boolean),
    emptySlotCount: () => slots.slice(3).filter((s) => !s).length,
    close () {
      window.closed = true
      if (!legacy) return
      // mineflayer copies the window's pockets into bot.inventory at the close.
      for (let i = 3; i < 39; i++) inventory.slots[i + 6] = slots[i]
      bot.emit('windowClose', window)
      const changed = Array.from({ length: 36 }, (_, k) => k + 3).filter((i) => server[i] !== atOpen[i])
      if (!answers || !changed.length) return
      clock.setTimeout(() => {
        for (const i of changed) {
          inventory.slots[i + 6] = server[i]
          packets.push(i + 6)
          client.emit('set_slot', { windowId: 0, slot: i + 6 })
        }
        if (!pickup) return
        clock.setTimeout(() => {
          const had = inventory.slots[pickup.slot]
          inventory.slots[pickup.slot] = { ...(had ?? stack(pickup.name, 0)), count: (had ? had.count : 0) + pickup.count }
          packets.push(pickup.slot)
          client.emit('set_slot', { windowId: 0, slot: pickup.slot })
        }, 20)
      }, 100)
    },
    putInput: async (itemType, metadata, count) => transfer({ itemType, count, sourceStart: 3, sourceEnd: 39, destStart: 0, destEnd: 1 }, 'input'),
    putFuel: async (itemType, metadata, count) => transfer({ itemType, count, sourceStart: 3, sourceEnd: 39, destStart: 1, destEnd: 2 }, 'fuel')
  }
  const pocket = (name) => window.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0)
  const inventory = { inventoryStart: 9, inventoryEnd: 45, slots: Array(46).fill(null), items: () => inventory.slots.slice(9, 45).filter(Boolean) }
  for (let i = 3; i < 39; i++) inventory.slots[i + 6] = server[i]
  return { window, server, transfer, pocket, client, bot, inventory, legacy, clock, packets }
}

// seen tells whether the furnace cell is in lit sight or was seen, and walks collects the goals the pathfinder was sent.
function furnaceEnv (f, seen = true) {
  const logs = []
  const walks = []
  const block = { name: 'furnace', position: AT }
  const env = {
    bot: Object.assign(f.bot, {
      entity: { position: HERE },
      _client: f.client,
      inventory: f.inventory,
      findBlocks: ({ matching }) => (matching.includes(61) ? [AT] : []),
      blockAt: (p) => (p.equals(AT) ? block : { name: 'stone', position: p }),
      pathfinder: { goto: async (goal) => { walks.push(goal) } },
      openFurnace: async (b) => { assert.strictEqual(b, block); return f.window },
      transfer: async (o) => { assert.strictEqual(o.window, f.window); f.transfer(o) },
      waitForTicks: async (n) => f.window.tick(n)
    }),
    LEGACY_1710: f.legacy,
    LEGACY_CLOSE_READ_MS: READ_MS,
    POCKET_SETTLE_MS: botConstant('POCKET_SETTLE_MS'),
    setTimeout: f.clock.setTimeout,
    clearTimeout: f.clock.clearTimeout,
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

test('smelt leaves its output in the furnace when only a pocket stack with other components has room for it', async () => {
  const renamed = { ...stack('iron_ingot', 60), components: [{ type: 'custom_name', data: 'Loot' }] }
  const pockets = [stack('iron_ore', 6), renamed, ...Array.from({ length: 34 }, () => stack('stone', 64))]
  const f = furnaceWindow({ input: stack('iron_ore', 2), fuel: stack('coal', 1), output: stack('iron_ingot', 4), pockets })
  const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, furnaceEnv(f).env)
  assert.deepStrictEqual([reply.took, reply.output, reply.note], [undefined, '4 iron_ingot', 'left 4 iron_ingot in the output'])
  assert.strictEqual(f.pocket('iron_ingot'), 60)
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
  const smeltAtError = await refusal('/smelt', { item: 'iron_ore', at: '3,64,0' }, env)
  assert.match(smeltAtError, UNSEEN)
  assert.doesNotMatch(smeltAtError, /furnace|iron/)
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
  const f = furnaceWindow({ fuel: stack('coal', 1), pockets: [stack('iron_ore', 12), stack('coal', 5)] })
  f.window.fuel = 0.5
  const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '12' }, furnaceEnv(f).env)
  assert.deepStrictEqual([reply.fuel, reply.burning, reply.doneInSec, f.pocket('coal')], ['1 coal', 'coal', 120, 5])
})

test('smelt neither names nor counts a flame it found burning over an empty fuel slot', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 12), stack('coal', 5)] })
  f.window.fuel = 0.5
  const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '12' }, furnaceEnv(f).env)
  assert.deepStrictEqual([reply.fuel, reply.burning, reply.doneInSec, f.pocket('coal')], ['2 coal', undefined, 120, 3])
})

test('smelt with at walks from the floor into click reach of a furnace stacked two over it', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 8), stack('coal', 1)] })
  const { env, walks } = furnaceEnv(f)
  const upper = { name: 'furnace', position: new Vec3(3, 66, 0) }
  const blockAt = env.bot.blockAt
  env.bot.blockAt = (p) => (p.equals(upper.position) ? upper : blockAt(p))
  // The walk ends on the nearest floor cell that ends the goal, outside the furnace column.
  env.bot.pathfinder.goto = async (goal) => {
    walks.push(goal)
    const floor = []
    for (let x = -2; x <= 8; x++) for (let z = -5; z <= 5; z++) if (x !== 3 || z !== 0) floor.push(new Vec3(x, 64, z))
    const end = floor.filter((c) => goal.isEnd(c)).sort((a, b) => a.distanceTo(HERE) - b.distanceTo(HERE))[0]
    if (!end) throw Object.assign(new Error('No path to the goal!'), { name: 'NoPath' })
    env.bot.entity.position = end.offset(0.5, 0, 0.5)
  }
  const { inClickReach } = loadBotFunctions(['inClickReach'], { bot: env.bot, LEGACY_1710: true, LEGACY_CLICK_REACH })
  env.bot.openFurnace = inClickReach(async (b) => { assert.strictEqual(b, upper); return f.window })
  const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '8', at: '3,66,0' }, env)
  assert.deepStrictEqual([reply.at, reply.input], [{ x: 3, y: 66, z: 0 }, '8 iron_ore'])
  assert.strictEqual(walks.length, 1)
})

test('smelt at a remembered furnace in an unloaded chunk refuses it as too far to load', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 8), stack('coal', 1)] })
  const { env, walks } = furnaceEnv(f, false)
  env.STATIONS.set('3,64,0', 61)
  env.bot.blockAt = (p) => (p.equals(AT) ? null : { name: 'stone', position: p })
  assert.strictEqual(await refusal('/smelt', { item: 'iron_ore', at: '3,64,0' }, env), 'the furnace at 3,64,0 is too far to load')
  assert.deepStrictEqual(walks, [])
})

test('smelt without item loads only fuel, what the input in the furnace needs or count items', async () => {
  const f = furnaceWindow({ input: stack('iron_ore', 16), pockets: [stack('coal', 5)], lights: true })
  const topUp = await awaitRoute('/smelt', { fuel: 'coal' }, furnaceEnv(f).env)
  assert.deepStrictEqual(topUp, { at: { x: 3, y: 64, z: 0 }, loaded: 2, input: '16 iron_ore', fuel: '1 coal', output: null, burning: 'coal', doneInSec: 160 })
  const counted = await awaitRoute('/smelt', { fuel: 'coal', count: '3' }, furnaceEnv(f).env)
  assert.deepStrictEqual([counted.loaded, counted.fuel, counted.burning], [3, '4 coal', 'coal'])
  assert.deepStrictEqual([f.window.inputItem().count, f.pocket('coal')], [16, 0])
})

test('smelt without item refuses when it can add no fuel, and moves nothing', async () => {
  const covered = furnaceWindow({ input: stack('iron_ore', 8), fuel: stack('coal', 1), pockets: [stack('coal', 5)] })
  assert.match(await refusal('/smelt', { fuel: 'coal' }, furnaceEnv(covered).env), /already covers its 8 iron_ore/)
  assert.deepStrictEqual([covered.window.fuelItem().count, covered.pocket('coal')], [1, 5])

  const full = furnaceWindow({ input: stack('iron_ore', 8), fuel: stack('coal', 64), pockets: [stack('coal', 5)] })
  assert.match(await refusal('/smelt', { fuel: 'coal', count: '3' }, furnaceEnv(full).env), /fuel slot is full with 64 coal/)
  assert.deepStrictEqual([full.window.fuelItem().count, full.pocket('coal')], [64, 5])
})

test('smelt names the fuel burning in the flame once the furnace took its only fuel item', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 8), stack('coal', 3)], lights: true })
  const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '8' }, furnaceEnv(f).env)
  assert.deepStrictEqual([reply.fuel, reply.burning, reply.doneInSec, reply.fuelFor], [null, 'coal', 80, undefined])
})

test('smelt counts loaded and took from the pockets, on 1.7.10 from the server\'s set_slots after the close', async () => {
  for (const legacy of [false, true]) {
    const setup = { input: stack('iron_ore', 2), fuel: stack('coal', 1), output: stack('iron_ingot', 4), pockets: [stack('iron_ore', 6)], legacy }
    const control = furnaceWindow(setup)
    const accepted = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, furnaceEnv(control).env)
    assert.deepStrictEqual([accepted.loaded, accepted.took, accepted.unconfirmed], [6, '4 iron_ingot', undefined], `control, legacy ${legacy}`)
    assert.deepStrictEqual(control.packets, legacy ? [9, 10] : [], `control, legacy ${legacy}`)
  }
})

test('smelt counts refused moves as none on the baseline, and on 1.7.10, where the server leaves those slots silent, as unconfirmed', async () => {
  const setup = { input: stack('iron_ore', 2), fuel: stack('coal', 1), output: stack('iron_ingot', 4), pockets: [stack('iron_ore', 6)], rejects: ['input', 'take'] }
  const baseline = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, furnaceEnv(furnaceWindow(setup)).env)
  assert.deepStrictEqual([baseline.loaded, baseline.took, baseline.unconfirmed], [0, '0 iron_ingot', undefined])
  const f = furnaceWindow({ ...setup, legacy: true })
  const legacy = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, furnaceEnv(f).env)
  assert.deepStrictEqual([legacy.loaded, legacy.took, legacy.unconfirmed], [undefined, undefined, `${unconfirmed('iron_ore and iron_ingot')}, the counts moved are unknown`])
  assert.deepStrictEqual(f.packets, [])
  assert.ok(f.window.closed, 'the window stays open')
})

test('smelt on 1.7.10 does not claim an input load the server answered only for the fuel slot', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 8), stack('coal', 1)], legacy: true, rejects: ['input'] })
  const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '8' }, furnaceEnv(f).env)
  assert.deepStrictEqual(f.packets, [10])
  assert.deepStrictEqual([reply.loaded, reply.unconfirmed], [undefined, `${unconfirmed('iron_ore')}, the counts moved are unknown`])
})

test('smelt without item counts the fuel the pockets gave up', async () => {
  const f = furnaceWindow({ input: stack('iron_ore', 16), pockets: [stack('coal', 5)], rejects: ['fuel'] })
  assert.strictEqual((await awaitRoute('/smelt', { fuel: 'coal' }, furnaceEnv(f).env)).loaded, 0)
  const legacy = furnaceWindow({ input: stack('iron_ore', 16), pockets: [stack('coal', 5)], legacy: true })
  assert.strictEqual((await awaitRoute('/smelt', { fuel: 'coal' }, furnaceEnv(legacy).env)).loaded, 2)
  const refused = furnaceWindow({ input: stack('iron_ore', 16), pockets: [stack('coal', 5)], legacy: true, rejects: ['fuel'] })
  const reply = await awaitRoute('/smelt', { fuel: 'coal' }, furnaceEnv(refused).env)
  assert.deepStrictEqual([reply.loaded, reply.unconfirmed], [undefined, `${unconfirmed('coal')}, the counts moved are unknown`])
})

test('1.7.10 smelt with no answer from the server after the close states no counts and says they are unconfirmed', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 8), stack('coal', 1)], legacy: true, answers: false })
  const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '8' }, furnaceEnv(f).env)
  assert.deepStrictEqual(reply, { at: { x: 3, y: 64, z: 0 }, input: '8 iron_ore', fuel: '1 coal', output: null, doneInSec: 80, unconfirmed: `${unconfirmed('iron_ore')}, the counts moved are unknown` })
  assert.strictEqual(f.clock.now(), READ_MS)
})

test('smelt with its input as fuel counts the items put in both slots in loaded and says so', async () => {
  for (const legacy of [false, true]) {
    const f = furnaceWindow({ pockets: [stack('oak_log', 20)], legacy })
    const reply = await awaitRoute('/smelt', { item: 'oak_log', count: '8', fuel: 'oak_log' }, furnaceEnv(f).env)
    assert.deepStrictEqual([reply.loaded, reply.input, reply.fuel, reply.note], [14, '8 oak_log', '6 oak_log', 'loaded counts the oak_log put in the fuel slot too'], `legacy ${legacy}`)
  }
})

test('smelt taking the output it then loads as fuel states the net change of that item instead of took', async () => {
  for (const legacy of [false, true]) {
    const f = furnaceWindow({ output: stack('charcoal', 3), pockets: [stack('oak_log', 8), stack('charcoal', 1)], legacy })
    const reply = await awaitRoute('/smelt', { item: 'oak_log', count: '8', fuel: 'charcoal' }, furnaceEnv(f).env)
    assert.deepStrictEqual([reply.loaded, reply.took, reply.fuel, reply.note],
      [8, undefined, '1 charcoal', 'took charcoal from the output and put charcoal in the fuel slot, my pockets hold 2 more charcoal than before'], `legacy ${legacy}`)
    assert.strictEqual(f.pocket('charcoal'), 3)
  }
})

test('the furnace tool reports what reached the pockets when the take throws partway, on 1.7.10 from the server\'s set_slot', async () => {
  for (const legacy of [false, true]) {
    const f = furnaceWindow({ input: stack('iron_ore', 10), legacy })
    const { env } = furnaceEnv(f)
    env.bot.transfer = async (o) => { f.transfer({ ...o, count: 4 }); throw new Error('the window closed') }
    assert.strictEqual(await refusal('/furnace', { take: 'input', count: '10' }, env), 'took 4 iron_ore; then the window closed', `legacy ${legacy}`)
    assert.ok(f.window.closed, 'the window stays open')
  }
})

test('1.7.10 the furnace tool counts a take the server answers with a set_slot for pocket slot 9, before the deadline', async () => {
  const f = furnaceWindow({ output: stack('iron_ingot', 6), legacy: true })
  const reply = await awaitRoute('/furnace', { take: 'output' }, furnaceEnv(f).env)
  assert.deepStrictEqual([reply.took, reply.unconfirmed, f.packets], ['6 iron_ingot', undefined, [9]])
  assert.ok(f.clock.now() < READ_MS, `replied at ${f.clock.now()} ms`)
})

test('1.7.10 the furnace tool calls a take the server leaves silent unconfirmed', async () => {
  const unsure = `${unconfirmed('iron_ingot')}, the count taken is unknown`
  const refused = furnaceWindow({ output: stack('iron_ingot', 6), legacy: true, rejects: ['take'] })
  assert.deepStrictEqual(await awaitRoute('/furnace', { take: 'output' }, furnaceEnv(refused).env),
    { at: { x: 3, y: 64, z: 0 }, input: null, fuel: null, output: null, unconfirmed: unsure })
  const silent = furnaceWindow({ output: stack('iron_ingot', 6), legacy: true, answers: false })
  assert.deepStrictEqual(await awaitRoute('/furnace', { take: 'output' }, furnaceEnv(silent).env),
    { at: { x: 3, y: 64, z: 0 }, input: null, fuel: null, output: null, unconfirmed: unsure })
  const broken = furnaceWindow({ input: stack('iron_ore', 10), legacy: true, answers: false })
  const { env } = furnaceEnv(broken)
  env.bot.transfer = async (o) => { broken.transfer({ ...o, count: 4 }); throw new Error('the window closed') }
  assert.strictEqual(await refusal('/furnace', { take: 'input', count: '10' }, env), `the window closed; ${unconfirmed('iron_ore')}, the count taken is unknown`)
})

test('1.7.10 the furnace tool and smelt count a take at most the source slot held when a pickup of that item lands during the read', async () => {
  const f = furnaceWindow({ output: stack('iron_ingot', 6), legacy: true, pickup: { slot: 9, name: 'iron_ingot', count: 3 } })
  const reply = await awaitRoute('/furnace', { take: 'output' }, furnaceEnv(f).env)
  assert.deepStrictEqual([reply.took, reply.note, f.packets], ['6 iron_ingot', '3 more iron_ingot reached my pockets than the 6 in the output slot', [9, 9]])
  const s = furnaceWindow({ input: stack('iron_ore', 2), fuel: stack('coal', 1), output: stack('iron_ingot', 4), pockets: [stack('iron_ore', 6)], legacy: true, pickup: { slot: 12, name: 'iron_ingot', count: 2 } })
  const smelt = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, furnaceEnv(s).env)
  assert.deepStrictEqual([smelt.loaded, smelt.took, smelt.note, s.packets], [6, '4 iron_ingot', '2 more iron_ingot reached my pockets than the 4 in the output', [9, 10, 12]])
})

// An output that cooks one more item between the route's read of the slot and its take click.
function growingOutput (f, env) {
  env.bot.transfer = async (o) => {
    if (o.sourceStart === 2) {
      for (const on of [f.window.slots, f.server]) on[2] = { ...on[2], count: on[2].count + 1 }
      o = { ...o, count: f.window.slots[2].count }
    }
    f.transfer(o)
  }
}

test('smelt and the furnace tool name the items that reached the pockets beyond the output they read', async () => {
  for (const legacy of [false, true]) {
    const s = furnaceWindow({ input: stack('iron_ore', 2), fuel: stack('coal', 1), output: stack('iron_ingot', 4), pockets: [stack('iron_ore', 6)], legacy })
    const smeltEnv = furnaceEnv(s).env
    growingOutput(s, smeltEnv)
    const smelt = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, smeltEnv)
    assert.deepStrictEqual([smelt.took, smelt.note, s.pocket('iron_ingot')], ['4 iron_ingot', '1 more iron_ingot reached my pockets than the 4 in the output', 5], `smelt, legacy ${legacy}`)

    const f = furnaceWindow({ output: stack('iron_ingot', 6), legacy })
    const furnace = furnaceEnv(f).env
    growingOutput(f, furnace)
    const reply = await awaitRoute('/furnace', { take: 'output' }, furnace)
    assert.deepStrictEqual([reply.took, reply.note, f.pocket('iron_ingot')], ['6 iron_ingot', '1 more iron_ingot reached my pockets than the 6 in the output slot', 7], `furnace, legacy ${legacy}`)
  }
})

test('smelt names the items that left the pockets beyond the ones it put in', async () => {
  for (const legacy of [false, true]) {
    const f = furnaceWindow({ pockets: [stack('iron_ore', 8), stack('coal', 1)], legacy })
    const { env } = furnaceEnv(f)
    f.window.putInput =async (itemType, metadata, count) => f.transfer({ itemType, count: count + 1, sourceStart: 3, sourceEnd: 39, destStart: 0, destEnd: 1 }, 'input')
    const reply = await awaitRoute('/smelt', { item: 'iron_ore', count: '6' }, env)
    assert.deepStrictEqual([reply.loaded, reply.note, f.pocket('iron_ore')], [6, '1 more iron_ore left my pockets than the 6 put in', 1], `legacy ${legacy}`)
  }
})

const listeners = (...emitters) => emitters.map((on) => Object.fromEntries(on.eventNames().map((e) => [e, on.listenerCount(e)])))

test('1.7.10 smelt that throws partway leaves no listener on the bot or its client', async () => {
  const f = furnaceWindow({ pockets: [stack('iron_ore', 8), stack('coal', 1)], legacy: true })
  const { env } = furnaceEnv(f)
  const before = listeners(f.bot, f.client)
  let during = null
  f.window.putFuel = async () => {
    during = listeners(f.bot, f.client)
    throw new Error('the window closed')
  }
  assert.strictEqual(await refusal('/smelt', { item: 'iron_ore', count: '8' }, env), 'the window closed')
  assert.deepStrictEqual(during, [{ ...before[0], windowClose: 1 }, { ...before[1], set_slot: 1, window_items: 1 }], 'control: the route listens while the window is open')
  assert.deepStrictEqual(listeners(f.bot, f.client), before)
  assert.ok(f.window.closed, 'the window stays open')
})

test('1.7.10 the furnace tool reads a take that moved nothing without waiting and calls nothing unconfirmed', async () => {
  const f = furnaceWindow({ input: stack('iron_ore', 10), legacy: true })
  const { env } = furnaceEnv(f)
  env.bot.transfer = async () => { throw new Error('the window closed') }
  assert.strictEqual(await refusal('/furnace', { take: 'input', count: '10' }, env), 'the window closed')
  assert.deepStrictEqual([f.packets, f.clock.now()], [[], 0])
})
