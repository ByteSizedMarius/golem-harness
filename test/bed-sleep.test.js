'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { createSerializer, createDeserializer, states } = require('minecraft-protocol')
const registryFor = require('prismarine-registry')
const bed = require('mineflayer/lib/plugins/bed')
const { TOOLS } = require('../mcp/tools')
const { GRAVESTONE } = require('../lib/server-overrides')
const { LEGACY_CLICK_REACH } = require('../lib/bot/legacy-1710')
const { crumbCentre, nametagGoal } = require('../lib/walk')
const { loadBotFunctions, botConstant, routeHandler, runRoute } = require('./helpers')

const BOT_ID = 7
const FOOT = new Vec3(30, 150, 40)
const HEAD = new Vec3(30, 150, 41)
const FOOT_CELL = { x: 30, y: 150, z: 40 }
// Where a 1.7.10 server puts a body that clicked the foot, and where it stands it up again.
const IN_BED = new Vec3(30.5, 150.94, 41.9)
const BESIDE = new Vec3(29.5, 150.1, 40.5)
const LEAVE_MS = 50
const CHEST = { name: 'chest', position: new Vec3(18, 150, 40) }

function serverReads (version, { name, ...params }) {
  const buf = createSerializer({ state: states.PLAY, isServer: false, version }).createPacketBuffer({ name, params })
  return createDeserializer({ state: states.PLAY, isServer: true, version }).parsePacketBuffer(buf).data
}

// done records each click, open, craft, placement and use that reaches mineflayer.
// Each click waits lookMs before it reaches the server.
function sleeper ({ version = '1.21.11', legacy = false, answerMs = botConstant('BED_ANSWER_MS'), lookMs = 0 } = {}) {
  const bot = new EventEmitter()
  bot.registry = registryFor(version)
  bot.supportFeature = bot.registry.supportFeature
  bot.entity = { id: BOT_ID, position: new Vec3(28.5, 150, 40.5) }
  bot.blockAt = (p) => (p.floored().equals(FOOT) || p.floored().equals(HEAD) ? { name: 'red_bed', position: p.floored() } : { name: 'air', position: p.floored() })
  const server = { sleeps: true, stands: true, wakes: true }
  const written = []
  const done = []
  const events = []
  const logs = []
  // The server's position packet.
  const place = (p) => {
    bot.entity.position = p.clone()
    bot.emit('forcedMove')
  }
  bot._client = new EventEmitter()
  bot._client.write = (name, params) => {
    written.push({ name, ...params })
    if (name === 'entity_action' && server.stands) {
      setImmediate(() => {
        if (server.wakes) bot.emit('entityWake', bot.entity)
        place(BESIDE)
      })
    }
  }
  bed(bot)
  const pathfinder = { goal: null }
  pathfinder.setGoal = (goal) => { pathfinder.goal = goal }
  bot.pathfinder = pathfinder
  bot.activateBlock = async (block) => {
    if (lookMs) await new Promise((resolve) => setTimeout(resolve, lookMs))
    done.push(['click', block.name])
    if (bot.isABed(block) && server.sleeps) {
      setImmediate(() => {
        place(IN_BED)
        bot.emit('entitySleep', bot.entity)
      })
    }
  }
  bot.openBlock = async (block) => { done.push(['open', block.name]); return { block } }
  bot.craft = async (recipe) => { done.push(['craft', recipe]) }
  bot._genericPlace = async (ref) => { done.push(['place', ref.name]) }
  bot.useOn = (target) => { done.push(['use', target.name]) }
  const shared = { bed: null }
  const env = {
    bot,
    shared,
    emitEvent: (kind, msg, data, { quiet = false } = {}) => { events.push({ kind, msg, quiet }) },
    err: (res, e) => { res.body = { ok: false, error: e.message } },
    TOOLS,
    BED_CLICK: botConstant('BED_CLICK'),
    BED_ANSWER_MS: answerMs,
    BED_TOP: botConstant('BED_TOP'),
    LEAVE_BED_MS: LEAVE_MS,
    LEGACY_1710: legacy,
    LEGACY_CLICK_REACH,
    console: { log: (line) => logs.push(line) },
    setTimeout,
    clearTimeout
  }
  const fns = loadBotFunctions(['wireBed', 'installBedGate'], env)
  fns.wireBed()
  bot.emit('spawn')
  return { bot, server, written, done, events, logs, shared, fns, place }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, LEAVE_MS * 2))

async function goToBed (s) {
  await s.bot.activateBlock(s.bot.blockAt(FOOT))
  await settle()
}

function bedGates (s) {
  const gates = new Map()
  s.fns.installBedGate({ all: (route, gate) => gates.set(route, gate) })
  return gates
}

async function through (gates, route) {
  const gate = gates.get(route)
  if (!gate) return 'ungated'
  const res = {}
  let passed = false
  await gate({ query: {} }, res, () => { passed = true })
  return passed ? 'passed' : res.body
}

const leaves = (written) => written.filter((p) => p.name === 'entity_action')

test('the bot\'s own bed click that the server answers with sleep puts the body in the clicked bed, with a quiet sleep event', async () => {
  const s = sleeper()
  await goToBed(s)
  assert.deepStrictEqual({ ...s.shared.bed }, FOOT_CELL)
  assert.deepStrictEqual(s.events, [{ kind: 'sleep', msg: 'in bed at 30,150,40', quiet: true }])
})

test('a sleep the server reports without the bot\'s own bed click leaves the body awake', async () => {
  const s = sleeper()
  s.bot.emit('entitySleep', s.bot.entity)
  assert.strictEqual(s.bot.isSleeping, true, 'control: mineflayer reads it as sleep')
  assert.strictEqual(s.shared.bed, null)
  assert.deepStrictEqual(s.events, [])
})

test('the server placing the body in the clicked bed counts as sleep without a sleep packet', async () => {
  const s = sleeper()
  s.server.sleeps = false
  await goToBed(s)
  assert.strictEqual(s.shared.bed, null, 'control: no answer, no sleep')
  s.place(IN_BED)
  assert.deepStrictEqual({ ...s.shared.bed }, FOOT_CELL)
})

test('a body the server stands on the bed top after its bed click stays awake', async () => {
  const s = sleeper()
  s.server.sleeps = false
  await goToBed(s)
  s.place(new Vec3(30.5, 150.5625, 40.5))
  assert.strictEqual(s.shared.bed, null)
  s.place(IN_BED)
  assert.deepStrictEqual({ ...s.shared.bed }, FOOT_CELL, 'control: the sleeping spot')
})

test('a bed click counts from the moment it leaves, however long the look before it takes', async () => {
  const s = sleeper({ answerMs: 30, lookMs: 60 })
  await goToBed(s)
  assert.deepStrictEqual({ ...s.shared.bed }, FOOT_CELL)
})

test('a sleep counts as the answer to the bed click until the window after the next server time packet closes', async () => {
  const lagging = sleeper({ answerMs: 30 })
  lagging.server.sleeps = false
  await goToBed(lagging)
  lagging.place(IN_BED)
  assert.deepStrictEqual({ ...lagging.shared.bed }, FOOT_CELL, 'an answer past the window, before the next time packet')
  const late = sleeper({ answerMs: 30 })
  late.server.sleeps = false
  await goToBed(late)
  late.bot.emit('time')
  await settle()
  late.place(IN_BED)
  assert.strictEqual(late.shared.bed, null, 'an answer past the window after the time packet')
})

test('a position packet off the bed keeps the body in bed while mineflayer reads it asleep', async () => {
  const s = sleeper()
  await goToBed(s)
  s.place(new Vec3(26.5, 150, 40.5))
  assert.strictEqual(s.bot.isSleeping, true)
  assert.deepStrictEqual({ ...s.shared.bed }, FOOT_CELL)
})

test('the wake, or a position packet out of the bed while mineflayer reads the body awake, ends the sleep, and a wake the pilot did not ask for wakes the pilot', async () => {
  for (const [label, sleeps, end] of [['wake', true, (s) => s.bot.emit('entityWake', s.bot.entity)], ['position', false, (s) => s.place(BESIDE)]]) {
    const s = sleeper()
    s.server.sleeps = sleeps
    await goToBed(s)
    if (!sleeps) s.place(IN_BED)
    end(s)
    assert.strictEqual(s.shared.bed, null, label)
    assert.deepStrictEqual(s.events.at(-1), { kind: 'wake', msg: 'out of the bed at 30,150,40', quiet: false }, label)
  }
})

test('a body route for a body in bed sends leave_bed and runs once the server stands the body up, with a quiet wake', async () => {
  const s = sleeper()
  const gates = bedGates(s)
  await goToBed(s)
  assert.strictEqual(await through(gates, '/chest'), 'passed')
  assert.strictEqual(s.shared.bed, null)
  assert.deepStrictEqual(s.bot.entity.position, BESIDE)
  assert.deepStrictEqual(leaves(s.written), [{ name: 'entity_action', entityId: BOT_ID, actionId: 'leave_bed', jumpBoost: 0 }])
  assert.deepStrictEqual(s.events.at(-1), { kind: 'wake', msg: 'out of the bed at 30,150,40', quiet: true })
})

test('the position packet that answers leave_bed stands the body up without a wake', async () => {
  const s = sleeper()
  const gates = bedGates(s)
  await goToBed(s)
  s.server.wakes = false
  assert.strictEqual(await through(gates, '/chest'), 'passed')
  assert.strictEqual(s.bot.isSleeping, true, 'control: mineflayer still reads sleep')
  assert.strictEqual(s.shared.bed, null)
})

test('body routes that arrive together for a body in bed share one leave_bed', async () => {
  const s = sleeper()
  const gates = bedGates(s)
  await goToBed(s)
  const replies = await Promise.all(['/chest', '/goto', '/craft'].map((route) => through(gates, route)))
  assert.deepStrictEqual(replies, ['passed', 'passed', 'passed'])
  assert.strictEqual(leaves(s.written).length, 1)
})

test('stop or a death forgets the bed without a packet', async () => {
  const s = sleeper()
  const gates = bedGates(s)
  await goToBed(s)
  assert.strictEqual(await through(gates, '/stop'), 'passed')
  assert.strictEqual(s.shared.bed, null, 'stop')
  const dead = sleeper()
  await goToBed(dead)
  dead.bot.emit('death')
  assert.strictEqual(dead.shared.bed, null, 'death')
  assert.deepStrictEqual([...leaves(s.written), ...leaves(dead.written)], [])
})

test('a goal set for a body in bed, as a flee sets it, leaves the bed once, and a cleared goal or an awake body sends nothing', async () => {
  const awake = sleeper()
  awake.bot.pathfinder.setGoal(new goals.GoalBlock(20, 150, 40))
  assert.deepStrictEqual(awake.written, [], 'awake')
  const s = sleeper()
  await goToBed(s)
  s.bot.pathfinder.setGoal(null)
  assert.deepStrictEqual(leaves(s.written), [], 'a cleared goal')
  const flee = new goals.GoalBlock(20, 150, 40)
  s.bot.pathfinder.setGoal(flee)
  s.bot.pathfinder.setGoal(flee)
  assert.strictEqual(s.bot.pathfinder.goal, flee)
  assert.strictEqual(leaves(s.written).length, 1)
  await settle()
  assert.strictEqual(s.shared.bed, null)
  const kept = sleeper()
  await goToBed(kept)
  kept.server.stands = false
  kept.bot.pathfinder.setGoal(flee)
  await settle()
  assert.deepStrictEqual(kept.logs, ['[bed] in bed at 30,150,40'], 'a body the server keeps in bed')
})

test('a follow that re-arms its goal for a body in bed leaves the bed', async () => {
  const s = sleeper()
  await goToBed(s)
  const player = { username: 'Alex', position: new Vec3(20.5, 150, 40.5) }
  const { armFollow } = loadBotFunctions(['armFollow'], { bot: s.bot, goals, crumbCentre, nametagGoal, ck: (x, y, z) => `${x},${y},${z}` })
  armFollow({ range: 2 }, { ent: player, tier: 'seen' })
  assert.ok(s.bot.pathfinder.goal instanceof goals.GoalFollow)
  assert.strictEqual(leaves(s.written).length, 1)
  await settle()
  assert.strictEqual(s.shared.bed, null)
})

test('a strike or an item use for a body in bed never reaches mineflayer', async () => {
  const s = sleeper()
  Object.assign(s.bot, {
    controlState: {},
    heldItem: null,
    setControlState () {},
    attack: (e) => { s.done.push(['attack', e.name]) },
    activateItem: () => { s.done.push(['item']) },
    deactivateItem () {},
    consume: async () => {}
  })
  loadBotFunctions(['itemUseCosts'], { bot: s.bot, shared: s.shared, MOVES: botConstant('MOVES'), lowerGuard () {} }).itemUseCosts()
  await goToBed(s)
  s.done.length = 0
  s.bot.attack({ name: 'zombie' })
  s.bot.activateItem()
  assert.deepStrictEqual(s.done, [])
  s.bot.emit('entityWake', s.bot.entity)
  s.bot.attack({ name: 'zombie' })
  s.bot.activateItem()
  assert.deepStrictEqual(s.done, [['attack', 'zombie'], ['item']], 'control: awake')
})

test('a body route refuses in bed at the bed cell when the server keeps the body in bed, and the route never runs', async () => {
  const s = sleeper()
  const gates = bedGates(s)
  await goToBed(s)
  s.server.stands = false
  for (const route of ['/goto', '/chest', '/activate', '/craft']) {
    assert.deepStrictEqual(await through(gates, route), { ok: false, error: 'in bed at 30,150,40' }, route)
  }
  assert.deepStrictEqual({ ...s.shared.bed }, FOOT_CELL)
})

test('an awake body passes every body route without a packet, and routes that leave the body alone have no bed gate', async () => {
  const s = sleeper()
  const gates = bedGates(s)
  for (const route of ['/goto', '/chest', '/grave', '/useon', '/placeitem']) assert.strictEqual(await through(gates, route), 'passed', route)
  for (const route of ['/state', '/events', '/brace']) assert.strictEqual(await through(gates, route), 'ungated', route)
  assert.deepStrictEqual(s.written, [])
})

test('every opener and click leaves the bed first, and refuses without reaching mineflayer when the server keeps the body in bed', async () => {
  const calls = [
    ['click', (bot) => bot.activateBlock(CHEST)],
    ['open', (bot) => bot.openBlock(CHEST)],
    ['craft', (bot) => bot.craft('planks', 1, { name: 'crafting_table' })],
    ['place', (bot) => bot._genericPlace({ name: 'stone' }, new Vec3(0, 1, 0), {})],
    ['use', (bot) => bot.useOn({ name: 'sheep' })]
  ]
  for (const [kind, act] of calls) {
    const s = sleeper()
    await goToBed(s)
    s.server.stands = false
    s.done.length = 0
    await assert.rejects(act(s.bot), { message: 'in bed at 30,150,40' }, kind)
    assert.deepStrictEqual(s.done, [], kind)
    s.server.stands = true
    await act(s.bot)
    assert.strictEqual(s.done[0][0], kind)
    assert.strictEqual(s.shared.bed, null, kind)
  }
})

test('leave_bed reaches the server as the version reads it', async () => {
  for (const [version, actionId] of [['1.21.11', 'leave_bed'], ['1.21.4', 2]]) {
    const s = sleeper({ version })
    await goToBed(s)
    await through(bedGates(s), '/goto')
    const [packet] = leaves(s.written)
    assert.deepStrictEqual(serverReads(version, packet), { name: 'entity_action', params: { entityId: BOT_ID, actionId, jumpBoost: 0 } }, version)
  }
})

test('on 1.7.10 a window opens within 6 blocks of the feet, and a block past that is refused by name without a click', async () => {
  const s = sleeper({ legacy: true })
  s.bot.entity.position = new Vec3(20.5, 150, 40.5)
  const at = (y) => ({ name: GRAVESTONE, position: new Vec3(20, y, 40) })
  await s.bot.openBlock(at(155))
  assert.deepStrictEqual(s.done, [['open', GRAVESTONE]])
  await assert.rejects(s.bot.openBlock(at(156)), { message: `the ${GRAVESTONE} at 20,156,40 is out of reach, 6.5 blocks from your feet` })
  assert.deepStrictEqual(s.done, [['open', GRAVESTONE]])
  s.bot.entity.position = new Vec3(24.38, 150, 40.5)
  await s.bot.openBlock(CHEST)
  assert.deepStrictEqual(s.done.at(-1), ['open', 'chest'], 'level, 5.90 from the feet')
  s.bot.entity.position = new Vec3(24.52, 150, 40.5)
  await assert.rejects(s.bot.openBlock(CHEST), { message: 'the chest at 18,150,40 is out of reach, 6.0 blocks from your feet' }, 'level, 6.04 from the feet')
  const later = sleeper({ legacy: false })
  later.bot.entity.position = new Vec3(20.5, 150, 40.5)
  await later.bot.openBlock(at(156))
  assert.deepStrictEqual(later.done, [['open', GRAVESTONE]], 'a 1.21.11 server has its own reach')
})

test('grave names a gravestone out of reach after the walk instead of waiting for its window', async () => {
  const s = sleeper({ legacy: true })
  const gb = { name: GRAVESTONE, type: 9, position: new Vec3(20, 156, 40) }
  s.bot.entity.position = new Vec3(20.5, 150, 40.5)
  s.bot.blockAt = (p) => (p.equals(gb.position) ? gb : { name: 'air', type: 0, position: p })
  s.bot.findBlocks = () => [gb.position]
  s.bot.pathfinder = { goto: async () => {} }
  const env = {
    bot: s.bot,
    shared: { ...s.shared, ready: true, mcData: { blocksByName: { [GRAVESTONE]: { id: 9, name: GRAVESTONE } } } },
    reflexes: [{ name: 'combat', fightBusy: () => false, _threat: null }],
    bunkerHolds: () => false,
    guardState: { hand: null },
    seesLit: () => true,
    goals,
    Vec3,
    GRAVESTONE,
    GRAVE_SIGHT: 32
  }
  const { handle, res } = routeHandler('/grave', env)
  await handle({ query: {} }, res)
  assert.strictEqual(res.error && res.error.message, `the ${GRAVESTONE} at 20,156,40 is out of reach, 6.5 blocks from your feet`)
  assert.deepStrictEqual(s.done, [])
})

test('state names the bed the body sleeps in, and says nothing of beds while awake', async () => {
  const s = sleeper()
  Object.assign(s.bot.entity, { yaw: 0, pitch: 0, onGround: true })
  Object.assign(s.bot, { health: 20, food: 20, oxygenLevel: 20, experience: { level: 0 }, game: { gameMode: 'survival' }, blockAtCursor: () => null })
  const state = () => runRoute('/state', {}, {
    bot: s.bot,
    shared: Object.assign(s.shared, { ready: true }),
    insideBlock: () => null,
    skyClock: () => ({ dimension: 'overworld' }),
    waterState: () => null,
    heldInfo: () => null,
    round: (v) => ({ x: v.x, y: v.y, z: v.z })
  })
  assert.strictEqual('sleeping' in state(), false)
  await goToBed(s)
  assert.deepStrictEqual(state().sleeping, { x: 30, y: 150, z: 40 })
})
