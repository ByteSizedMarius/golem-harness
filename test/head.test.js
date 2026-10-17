'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { EventEmitter } = require('node:events')
const { headFree, smoothLook, TURN_DEG_S, FIGHT_TURN_DEG_S } = require('../lib/head')
const { combatReflexIn } = require('./helpers')

const deg = (d) => d * Math.PI / 180
const flush = () => new Promise(setImmediate)

// A bot at yaw 0 whose smoothed look records each call to the inner look.
function turner (fighting = false) {
  const bot = new EventEmitter()
  bot.entity = { yaw: 0, pitch: 0 }
  const looks = []
  const look = async (yaw, pitch, force) => {
    looks.push({ yaw, pitch, force })
    bot.entity.yaw = yaw
    bot.entity.pitch = pitch
  }
  return { bot, looks, look: smoothLook(bot, look, () => fighting) }
}

// Emits physics ticks until the turn resolves.
async function ticksUntil (bot, turn) {
  let done = false
  turn.then(() => { done = true })
  let ticks = 0
  for (await flush(); !done; await flush()) {
    assert.ok(ticks < 100, 'the turn never resolved')
    ticks++
    bot.emit('physicsTick')
  }
  return ticks
}

function widestStep (looks) {
  let prev = { yaw: 0, pitch: 0 }
  let widest = 0
  for (const l of looks) {
    widest = Math.max(widest, Math.hypot(l.yaw - prev.yaw, l.pitch - prev.pitch) * 180 / Math.PI)
    prev = l
  }
  return widest
}

// The look calls of each act cycle against a zombie standing 12 blocks off, the stare distance of the guard stance.
async function stareCycles (moving) {
  const zombie = { id: 7, name: 'zombie', position: new Vec3(12.5, 64, 0.5) }
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 7: zombie },
    health: 20,
    food: 20,
    inventory: { items: () => [], slots: [] },
    heldItem: null,
    pathfinder: { isMoving: () => moving },
    lookAt: async () => { looks[looks.length - 1]++ }
  }
  const looks = [0]
  const env = {
    bot,
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    fight: { stance: 'guard', lastHit: { dmg: 0, t: 0 }, lastAttackT: 0 },
    LEGACY_1710: false,
    guardState: { up: false, slot: -1, pilot: false },
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false },
    shared: { mcData: null },
    goals,
    headFree,
    compass: () => 'E',
    emitEvent () {},
    mobClass: () => 'hostile',
    entityPerceptible: () => true,
    entityEngageable: () => true,
    airFlood: () => ({ cells: new Set() }),
    knownCell: () => true,
    losClear: () => true,
    nearHostiles: () => [],
    inMeleeReach: () => false,
    disengageHp: () => 8,
    yieldJob () {},
    drawAndLoose: async () => false,
    perchStrike: () => false,
    holdRun: { on: false },
    strikeRun: { lane: null },
    laneBlocks: () => false,
    laneNarrate () {},
    // Each 250 ms wait ends a cycle. The zombie leaves after three.
    setTimeout: (fn) => {
      if (looks.length === 3) delete bot.entities[7]
      else looks.push(0)
      setImmediate(fn)
    }
  }
  const combat = combatReflexIn(env)
  combat._threat = { e: zombie, cls: 'hostile', dist: 12, confirmed: false }
  await combat.act(bot)
  return looks
}

test('the head is free only while the pathfinder walks no path', () => {
  assert.strictEqual(headFree({ pathfinder: { isMoving: () => false } }), true)
  assert.strictEqual(headFree({ pathfinder: { isMoving: () => true } }), false)
})

test('the combat stare at a standoff mob turns the head only while the body is not walking', async () => {
  assert.deepStrictEqual(await stareCycles(false), [1, 1, 1], 'control: standing still')
  assert.deepStrictEqual(await stareCycles(true), [0, 0, 0])
})

test('a forced turn of 170 degrees sweeps over several ticks and ends forced on its target', async () => {
  const { bot, looks, look } = turner()
  const ticks = await ticksUntil(bot, look(deg(170), deg(-20), true))
  assert.strictEqual(ticks, Math.ceil(Math.hypot(170, 20) / (TURN_DEG_S / 20)) - 1)
  assert.ok(widestStep(looks) <= TURN_DEG_S / 20 + 1e-9, `widest step ${widestStep(looks)} degrees`)
  assert.ok(Math.abs(bot.entity.yaw - deg(170)) < 1e-9 && Math.abs(bot.entity.pitch - deg(-20)) < 1e-9)
  assert.ok(looks.every((l) => l.force === true))
})

test('a forced turn of 3 degrees goes out in one look without waiting for a tick', async () => {
  const { bot, looks, look } = turner()
  assert.strictEqual(await ticksUntil(bot, look(deg(3), 0, true)), 0)
  assert.strictEqual(looks.length, 1)
  assert.ok(Math.abs(looks[0].yaw - deg(3)) < 1e-9 && looks[0].force === true)
})

test('a forced turn takes the short way round', async () => {
  const { bot, looks, look } = turner()
  bot.entity.yaw = deg(170)
  await ticksUntil(bot, look(deg(-170), 0, true))
  assert.strictEqual(looks.length, 2, 'control: 20 degrees take two steps')
  assert.ok(Math.abs(bot.entity.yaw - deg(190)) < 1e-9)
})

test('a new target mid-turn ends the old sweep and wins', async () => {
  const { bot, looks, look } = turner()
  const first = look(deg(170), 0, true)
  for (let i = 0; i < 3; i++) { await flush(); bot.emit('physicsTick') }
  await flush()
  const firstSteps = looks.length
  assert.ok(firstSteps >= 3 && Math.abs(bot.entity.yaw) < deg(170), 'control: the first sweep is under way')
  const at = bot.entity.yaw
  const second = look(deg(-30), 0, true)
  await ticksUntil(bot, Promise.all([first, second]))
  assert.ok(looks.slice(firstSteps).every((l) => l.yaw < at), 'no step heads back toward 170')
  assert.ok(Math.abs(bot.entity.yaw - deg(-30)) < 1e-9)
})

test('an unforced look passes straight through and ends a forced sweep', async () => {
  const { bot, looks, look } = turner()
  const sweep = look(deg(170), 0, true)
  await flush()
  await look(deg(90), 0, false)
  await ticksUntil(bot, sweep)
  assert.deepStrictEqual(looks.slice(1), [{ yaw: deg(90), pitch: 0, force: false }])
})

test('a forced turn while the combat reflex fights sweeps at the fight speed', async () => {
  const calm = turner(false)
  const fight = turner(true)
  const calmTicks = await ticksUntil(calm.bot, calm.look(deg(170), 0, true))
  const fightTicks = await ticksUntil(fight.bot, fight.look(deg(170), 0, true))
  assert.strictEqual(fightTicks, Math.ceil(170 / (FIGHT_TURN_DEG_S / 20)) - 1)
  assert.ok(fightTicks < calmTicks, `${fightTicks} ticks fighting, ${calmTicks} calm`)
  assert.ok(widestStep(fight.looks) <= FIGHT_TURN_DEG_S / 20 + 1e-9)
  assert.ok(Math.abs(fight.bot.entity.yaw - deg(170)) < 1e-9)
})
