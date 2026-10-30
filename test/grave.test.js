'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { GRAVESTONE } = require('../lib/server-overrides')
const { awaitRoute, routeHandler, loadBotFunctions, botConstant, claimRescue } = require('./helpers')
const { stackPause, STACK_GAP_MS, STACK_JITTER_MS } = require('../lib/pace')

const GRAVE_ID = 7
const IDS = { iron_pickaxe: 1, cobblestone: 2, bread: 3, torch: 4 }
const stack = (name, count) => ({ name, type: IDS[name], count, stackSize: name === 'iron_pickaxe' ? 1 : 64 })
const GRAVE_SLOTS = 45
const POCKETS = 36
const AT = new Vec3(5, 64, 0)

// A 9x5 grave window whose withdraw and count follow mineflayer's.
function graveWindow (items, pockets = []) {
  const slots = new Array(GRAVE_SLOTS + POCKETS).fill(null)
  const set = (i, item) => { slots[i] = item && { ...item, slot: i } }
  items.forEach((s, i) => set(i, s))
  pockets.forEach((s, i) => set(GRAVE_SLOTS + i, s))
  const range = (from, to) => slots.slice(from, to).filter(Boolean)
  function transfer (itemType, count, sourceStart, sourceEnd, destStart, destEnd) {
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
    closed: false,
    inventoryStart: GRAVE_SLOTS,
    containerItems: () => range(0, GRAVE_SLOTS),
    count: (type) => range(GRAVE_SLOTS, slots.length).filter((s) => s.type === type).reduce((n, s) => n + s.count, 0),
    withdraw: async (type, metadata, count) => transfer(type, count, 0, GRAVE_SLOTS, GRAVE_SLOTS, slots.length),
    close () { window.closed = true }
  }
  const pocket = (name) => window.count(IDS[name])
  return { window, pocket }
}

function graveEnv (window, { hidden = false, graves = true } = {}) {
  const grave = { name: GRAVESTONE, type: GRAVE_ID, position: AT }
  const opened = []
  const fight = { busy: false }
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) }
  const env = {
    bot: {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      blockAt: (p) => (p.equals(AT) ? grave : { name: 'air', type: 0, position: p }),
      findBlocks: ({ matching }) => (matching.includes(GRAVE_ID) ? [AT] : []),
      pathfinder: { goto: async () => {} },
      _client: { write () {} },
      // mineflayer opens a block with a block_place.
      openBlock: async (b) => {
        opened.push(b)
        env.bot._client.write('block_place', {})
        env.bot.currentWindow = window
        return window
      }
    },
    guardState: { hand: null },
    reflexes: [{ name: 'combat', fightBusy: () => fight.busy, _threat: null }],
    bunkerHolds: () => false,
    ...timers,
    stackPause: async () => {},
    shared: { mcData: { blocksByName: graves ? { [GRAVESTONE]: { id: GRAVE_ID, name: GRAVESTONE } } : {} }, ready: true },
    seesLit: (p) => !(hidden && p.x === AT.x && p.y === AT.y && p.z === AT.z),
    goals,
    Vec3,
    GRAVESTONE,
    GRAVE_SIGHT: 32,
    round: (v) => ({ x: v.x, y: v.y, z: v.z })
  }
  loadBotFunctions(['wireHandLease'], { bot: env.bot, guardState: env.guardState, ...timers }).wireHandLease()
  return { env, opened, fight }
}

async function refusal (query, env) {
  const { handle, res } = routeHandler('/grave', env)
  await handle({ query }, res)
  assert.ok(res.error, `/grave answered ${JSON.stringify(res.body)}`)
  return res.error.message
}

test('grave refuses busy while the buried self-rescue holds the hand, before walking or opening anything', async () => {
  const g = graveWindow([stack('cobblestone', 40)])
  const { env, opened } = graveEnv(g.window)
  let walked = false
  env.bot.pathfinder.goto = async () => { walked = true }
  env.digLock = botConstant('digLock')
  claimRescue(env.digLock)
  for (const query of [{}, { take: 'all' }]) assert.strictEqual(await refusal(query, env), 'busy: the buried self-rescue is running, nothing opened', JSON.stringify(query))
  assert.deepStrictEqual([opened, walked, g.pocket('cobblestone')], [[], false, 0])
})

test('grave lists the items of the gravestone at x,y,z and of the nearest one in sight', async () => {
  const g = graveWindow([stack('iron_pickaxe', 1), stack('cobblestone', 40)])
  const want = { at: { x: 5, y: 64, z: 0 }, items: [{ name: 'iron_pickaxe', count: 1 }, { name: 'cobblestone', count: 40 }] }
  assert.deepStrictEqual(await awaitRoute('/grave', { at: '5,64,0' }, graveEnv(g.window).env), want)
  assert.deepStrictEqual(await awaitRoute('/grave', {}, graveEnv(g.window).env), want)
  assert.ok(g.window.closed, 'the window stays open')
})

test('grave take all moves every item into the pockets', async () => {
  const g = graveWindow([stack('iron_pickaxe', 1), stack('cobblestone', 64), stack('cobblestone', 10), stack('bread', 5)])
  const reply = await awaitRoute('/grave', { take: 'all' }, graveEnv(g.window).env)
  assert.deepStrictEqual(reply, { at: { x: 5, y: 64, z: 0 }, took: ['1 iron_pickaxe', '74 cobblestone', '5 bread'], items: [] })
  assert.deepStrictEqual([g.pocket('iron_pickaxe'), g.pocket('cobblestone'), g.pocket('bread')], [1, 74, 5])
  assert.ok(g.window.closed, 'the window stays open')
})

test('grave take by name moves that item and leaves the rest', async () => {
  const g = graveWindow([stack('cobblestone', 30), stack('torch', 8), stack('cobblestone', 5)])
  const reply = await awaitRoute('/grave', { take: 'cobble' }, graveEnv(g.window).env)
  assert.deepStrictEqual(reply.took, ['35 cobblestone'])
  assert.deepStrictEqual(reply.items, [{ name: 'torch', count: 8 }])
  assert.strictEqual(g.pocket('cobblestone'), 35)
  assert.match(await refusal({ take: 'bread' }, graveEnv(g.window).env), /no bread in the gravestone/)
})

test('grave reports what it took before full pockets stopped it', async () => {
  const full = Array.from({ length: POCKETS - 1 }, () => stack('torch', 64))
  const g = graveWindow([stack('cobblestone', 64), stack('bread', 5)], full)
  const reply = await awaitRoute('/grave', { take: 'all' }, graveEnv(g.window).env)
  assert.deepStrictEqual(reply.took, ['64 cobblestone'])
  assert.match(reply.stopped, /full/)
  assert.deepStrictEqual(reply.items, [{ name: 'bread', count: 5 }])
})

test('grave take moves one source slot per mineflayer call, a stack pause apart', async (t) => {
  const g = graveWindow([stack('cobblestone', 64), stack('cobblestone', 10), stack('bread', 5)])
  const calls = []
  const real = g.window.withdraw
  g.window.withdraw = async (type, metadata, count) => {
    calls.push([type, count, Date.now()])
    return real(type, metadata, count)
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  let settled = false
  const reply = awaitRoute('/grave', { take: 'all' }, { ...graveEnv(g.window).env, stackPause }).finally(() => { settled = true })
  for (let i = 0; i < 1000 && !settled; i++) {
    await new Promise(setImmediate)
    t.mock.timers.tick(5)
  }
  assert.deepStrictEqual((await reply).took, ['74 cobblestone', '5 bread'])
  assert.deepStrictEqual(calls.map(([type, count]) => [type, count]), [[IDS.cobblestone, 64], [IDS.cobblestone, 10], [IDS.bread, 5]])
  for (let i = 1; i < calls.length; i++) {
    const gap = calls[i][2] - calls[i - 1][2]
    assert.ok(gap >= STACK_GAP_MS && gap <= STACK_GAP_MS + STACK_JITTER_MS + 5, `gap ${gap} ms`)
  }
})

test('a grave closed during the stack pause stops the take and reports what moved', async () => {
  const g = graveWindow([stack('cobblestone', 64), stack('cobblestone', 10), stack('bread', 5)])
  const { env } = graveEnv(g.window)
  env.stackPause = async () => { env.bot.currentWindow = null }
  const reply = await awaitRoute('/grave', { take: 'all' }, env)
  assert.deepStrictEqual(reply, {
    at: { x: 5, y: 64, z: 0 },
    took: ['64 cobblestone'],
    stopped: 'the grave closed',
    items: [{ name: 'cobblestone', count: 10 }, { name: 'bread', count: 5 }]
  })
})

test('grave refuses during a fight before walking or opening anything', async () => {
  const g = graveWindow([stack('bread', 5)])
  const { env, opened, fight } = graveEnv(g.window)
  let walked = false
  env.bot.pathfinder.goto = async () => { walked = true }
  fight.busy = true
  assert.match(await refusal({ take: 'all' }, env), /^refused: fighting something, /)
  assert.deepStrictEqual([opened, walked], [[], false])
})

test('a fight starting during the walk or a stack pause stops the take before its next click, and the grave closes before the hand lease ends', async () => {
  const g = graveWindow([stack('cobblestone', 64), stack('cobblestone', 10), stack('bread', 5)])
  const { env, fight } = graveEnv(g.window)
  const clicks = []
  const real = g.window.withdraw
  g.window.withdraw = async (type, metadata, count) => {
    clicks.push([count, env.guardState.hand !== null])
    return real(type, metadata, count)
  }
  const leased = []
  const close = g.window.close
  g.window.close = () => { leased.push(env.guardState.hand !== null); close() }
  env.stackPause = async () => { fight.busy = true }

  assert.deepStrictEqual(await awaitRoute('/grave', { take: 'all' }, env), {
    at: { x: 5, y: 64, z: 0 },
    took: ['64 cobblestone'],
    stopped: 'a fight started',
    items: [{ name: 'cobblestone', count: 10 }, { name: 'bread', count: 5 }]
  })
  assert.deepStrictEqual(clicks, [[64, true]])
  assert.deepStrictEqual([leased, env.guardState.hand], [[true], null])

  fight.busy = false
  env.bot.pathfinder.goto = async () => { fight.busy = true }
  assert.strictEqual(await refusal({ take: 'all' }, env), 'took nothing: a fight started')
  assert.strictEqual(clicks.length, 1)
})

test('a bunker build starting during a stack pause stops the take before its next click, with what was taken kept in the reply', async () => {
  const g = graveWindow([stack('cobblestone', 64), stack('cobblestone', 10), stack('bread', 5)])
  const { env } = graveEnv(g.window)
  const digLock = botConstant('digLock')
  env.digLock = digLock
  const { claimDig } = loadBotFunctions(['claimDig'], { digLock })
  env.stackPause = async () => { claimDig('the bunker build', true).sole = true }
  assert.deepStrictEqual(await awaitRoute('/grave', { take: 'all' }, env), {
    at: { x: 5, y: 64, z: 0 },
    took: ['64 cobblestone'],
    stopped: 'busy: the bunker build is running, nothing more moved',
    items: [{ name: 'cobblestone', count: 10 }, { name: 'bread', count: 5 }]
  })
})

test('a buried self-rescue starting during the walk stops the grave at the hand, closes it and leaves its lease and shovel alone', async () => {
  const g = graveWindow([stack('cobblestone', 10)])
  const { env } = graveEnv(g.window)
  const digLock = botConstant('digLock')
  env.digLock = digLock
  env.bot.heldItem = { name: 'iron_shovel' }
  const { holdHand, endHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState: env.guardState, digLock, setTimeout, clearTimeout })
  let rescue = null
  env.bot.pathfinder.goto = async () => {
    claimRescue(digLock)
    rescue = holdHand(digLock.holder)
  }
  try {
    for (const query of [{}, { take: 'all' }]) {
      endHand(rescue)
      digLock.holder = null
      g.window.closed = false
      assert.strictEqual(await refusal(query, env), 'busy: the buried self-rescue is running, nothing done', JSON.stringify(query))
      assert.ok(g.window.closed, `${JSON.stringify(query)} left the grave open`)
      assert.strictEqual(env.guardState.hand, rescue, `${JSON.stringify(query)} ended the rescue's lease`)
    }
    assert.deepStrictEqual([g.window.containerItems().length, g.pocket('cobblestone')], [1, 0])
    assert.strictEqual(env.bot.heldItem.name, 'iron_shovel')
  } finally { endHand(rescue) }
})

test('a buried self-rescue that stops the walk to the grave gets it refused busy, with the grave not opened', async () => {
  const g = graveWindow([stack('cobblestone', 10)])
  const { env, opened } = graveEnv(g.window)
  const digLock = botConstant('digLock')
  env.digLock = digLock
  let rescue = false
  // The rescue's stopPath clears the goal, and mineflayer-pathfinder's goto fails with GoalChanged.
  env.bot.pathfinder.goto = async () => {
    if (rescue) claimRescue(digLock)
    throw Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' })
  }
  assert.strictEqual(await refusal({}, env), 'The goal was changed before it could be completed!', 'control: a goal changed with no claim')
  rescue = true
  for (const query of [{}, { take: 'all' }]) {
    digLock.holder = null
    const { handle, res } = routeHandler('/grave', env)
    await handle({ query }, res)
    assert.strictEqual(res.error && res.error.message, 'busy: the buried self-rescue is running, nothing opened', JSON.stringify(query))
    assert.strictEqual(res.error.reason, 'busy', JSON.stringify(query))
  }
  assert.deepStrictEqual([opened, g.pocket('cobblestone')], [[], 0])
})

test('grave refuses a gravestone out of lit sight without naming it or opening it', async () => {
  const g = graveWindow([stack('iron_pickaxe', 1)])
  const at = graveEnv(g.window, { hidden: true })
  const atError = await refusal({ at: '5,64,0', take: 'all' }, at.env)
  assert.match(atError, /not in my sight/)
  assert.doesNotMatch(atError, /gravestone|iron_pickaxe/)
  const nearest = graveEnv(g.window, { hidden: true })
  const nearestError = await refusal({ take: 'all' }, nearest.env)
  assert.match(nearestError, /no gravestone in sight/)
  assert.doesNotMatch(nearestError, /5,64,0|iron_pickaxe/)
  assert.deepStrictEqual([at.opened, nearest.opened], [[], []])
  assert.strictEqual(g.pocket('iron_pickaxe'), 0)
  const seen = graveEnv(g.window)
  await awaitRoute('/grave', { at: '5,64,0' }, seen.env)
  assert.strictEqual(seen.opened.length, 1, 'control: a lit grave in sight opens')
})

test('grave refuses on a server without gravestones', async () => {
  const g = graveWindow([stack('bread', 1)])
  assert.match(await refusal({}, graveEnv(g.window, { graves: false }).env), /no gravestones/)
})
