'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { GRAVESTONE } = require('../lib/server-overrides')
const { awaitRoute, routeHandler } = require('./helpers')

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
  const env = {
    bot: {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      blockAt: (p) => (p.equals(AT) ? grave : { name: 'air', type: 0, position: p }),
      findBlocks: ({ matching }) => (matching.includes(GRAVE_ID) ? [AT] : []),
      pathfinder: { goto: async () => {} },
      openBlock: async (b) => { opened.push(b); return window }
    },
    mcData: { blocksByName: graves ? { [GRAVESTONE]: { id: GRAVE_ID, name: GRAVESTONE } } : {} },
    seesLit: (p) => !(hidden && p.x === AT.x && p.y === AT.y && p.z === AT.z),
    ready: true,
    goals,
    Vec3,
    GRAVESTONE,
    GRAVE_SIGHT: 32,
    round: (v) => ({ x: v.x, y: v.y, z: v.z })
  }
  return { env, opened }
}

async function refusal (query, env) {
  const { handle, res } = routeHandler('/grave', env)
  await handle({ query }, res)
  assert.ok(res.error, `/grave answered ${JSON.stringify(res.body)}`)
  return res.error.message
}

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
