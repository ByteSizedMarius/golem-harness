'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const { botSource, balanced, botConstant } = require('./helpers')

// The bot.js health listener on a full-health body whose every hit is an environmental fall.
function hurtRig () {
  const events = []
  const env = {
    bot: { health: 20, food: 20 },
    lastHp: 20,
    lastHurtEmit: 0,
    fight: { lastHit: null, lastAttrib: null, swingWait: null },
    lowFoodWarned: false,
    bunker: { building: false },
    BIG_HIT: botConstant('BIG_HIT'),
    waterState: () => null,
    emitEvent: (kind, msg) => { if (kind === 'hurt') events.push(msg) }
  }
  const src = botSource()
  const at = src.indexOf("bot.on('health', async () =>")
  const body = at < 0 ? '' : balanced(src, src.indexOf('=>', at))
  assert.ok(body, 'the hurt listener not found in bot.js')
  const listener = vm.runInContext(`(async () => ${body})`, vm.createContext(env))
  async function hit (dmg) {
    env.bot.health -= dmg
    env.fight.lastAttrib = { t: Date.now(), desc: 'fall', entity: null, ranged: false, env: true }
    await listener()
  }
  return { events, hit }
}

test('a hit of 4 or more damage emits a hurt event inside the throttle window, two smaller hits emit once', async () => {
  const { events, hit } = hurtRig()
  await hit(1)
  await hit(1)
  await hit(5)
  assert.deepStrictEqual(events.map((m) => m.match(/^took (\S+) /)[1]), ['1', '5'])
})

test('the first health update of a session counts no hit, a lower one after it freezes the body', async () => {
  const { createAlarms, bindAlarms, wireBodyAlarms } = require('../lib/bot/alarms')
  const bot = new EventEmitter()
  const hurt = []
  let froze = 0
  const fight = { lastHit: null, lastAttrib: null, swingWait: null }
  const ctx = {
    bot,
    fight,
    bunker: { building: false },
    reflexes: [],
    mobClass: () => null,
    waterState: () => null,
    freezeBody: () => { froze++ },
    emitEvent: (kind, msg) => { if (kind === 'hurt') hurt.push(msg) }
  }
  createAlarms(ctx)
  bindAlarms(ctx)
  wireBodyAlarms()
  const update = async (hp) => {
    Object.assign(bot, { health: hp, food: 20 })
    await Promise.all(bot.listeners('health').map((f) => f()))
  }
  // A relaunch at 12 HP.
  await update(12)
  assert.deepStrictEqual({ hurt, froze, lastHit: fight.lastHit }, { hurt: [], froze: 0, lastHit: null }, 'the first update')
  await update(9)
  assert.deepStrictEqual({ hurt: hurt.map((m) => m.match(/^took (\S+) /)[1]), froze, dmg: fight.lastHit && fight.lastHit.dmg }, { hurt: ['3'], froze: 1, dmg: 3 })
})

test('a hit with no attribution in lava freezes the body and names the lava', async () => {
  const id = require.resolve('../lib/bot/alarms')
  delete require.cache[id]
  const { createAlarms, bindAlarms, wireBodyAlarms } = require(id)
  delete require.cache[id]
  const bot = new EventEmitter()
  Object.assign(bot, { health: 20, food: 20 })
  const hurt = []
  let froze = 0
  const ctx = {
    bot,
    fight: { lastHit: null, lastAttrib: null, swingWait: null },
    bunker: { building: false },
    reflexes: [],
    mobClass: () => null,
    waterState: () => ({ inWater: false, submerged: false, inLava: true, current: false, buried: false, oxygen: 20 }),
    freezeBody: () => { froze++ },
    emitEvent: (kind, msg) => { if (kind === 'hurt') hurt.push(msg) }
  }
  createAlarms(ctx)
  bindAlarms(ctx)
  wireBodyAlarms()
  const update = () => Promise.all(bot.listeners('health').map((f) => f()))
  await update()
  bot.health -= 2
  await update()
  assert.deepStrictEqual({ hurt, froze }, { hurt: ['took 2 damage (LAVA) — HP 18/20 — FROZE all action; assess before moving'], froze: 1 })
})

// The hurt events of a fresh alarms module wired to a dry or submerged body with the given food and oxygen, burning
// or not and just landed from a fall or not, after one 1-damage environmental hit with the given attribution, by
// default an untyped one with no hostile within 4.
async function envHit ({ food, oxygen, submerged, burning = false, inFire = false, landed = false, attrib = { desc: 'no attacker named, no hostile within 4', untyped: true } }) {
  const id = require.resolve('../lib/bot/alarms')
  delete require.cache[id]
  const { createAlarms, bindAlarms, wireBodyAlarms } = require(id)
  delete require.cache[id]
  const bot = new EventEmitter()
  Object.assign(bot, { health: 20, food, oxygenLevel: oxygen, entity: { onGround: true, metadata: [burning ? 0x01 : 0] } })
  const fight = { lastHit: null, lastAttrib: null, swingWait: null }
  const hurt = []
  const ctx = {
    bot,
    fight,
    bunker: { building: false },
    reflexes: [],
    mobClass: () => null,
    waterState: () => ({ inWater: submerged, submerged, inLava: false, inFire, current: false, buried: false, oxygen }),
    swimUp: () => {},
    emitEvent: (kind, msg) => { if (kind === 'hurt') hurt.push(msg) }
  }
  createAlarms(ctx)
  bindAlarms(ctx)
  wireBodyAlarms()
  const update = () => Promise.all(bot.listeners('health').map((f) => f()))
  await update()
  if (landed) {
    bot.entity.onGround = false
    bot.emit('move')
    bot.entity.onGround = true
    bot.emit('move')
  }
  bot.health -= 1
  fight.lastAttrib = { t: Date.now(), entity: null, ranged: false, env: true, ...attrib }
  await update()
  return hurt
}

test('a hit with no attacker named says starving at food 0', async () => {
  assert.deepStrictEqual(await envHit({ food: 0, oxygen: 20, submerged: false }), ['took 1 damage (starving), HP 19/20'])
})

test('a hit with no attacker named keeps its text at food 0 right after a fall', async () => {
  assert.deepStrictEqual(await envHit({ food: 0, oxygen: 20, submerged: false, landed: true }), ['took 1 damage (no attacker named, no hostile within 4), HP 19/20'])
})

test('a hit with no attacker named keeps its text at food 0 while burning', async () => {
  assert.deepStrictEqual(await envHit({ food: 0, oxygen: 20, submerged: false, burning: true, attrib: { desc: 'no attacker named, on fire', untyped: true } }), ['took 1 damage (no attacker named, on fire), HP 19/20'])
})

test('a hit with no attacker named keeps its text at food 0 in a fire block before the on-fire flag arrives', async () => {
  assert.deepStrictEqual(await envHit({ food: 0, oxygen: 20, submerged: false, inFire: true, attrib: { desc: 'no attacker named, in fire', untyped: true } }), ['took 1 damage (no attacker named, in fire), HP 19/20'])
})

test('a hit with no attacker named says drowning under water at oxygen 0', async () => {
  assert.deepStrictEqual(await envHit({ food: 20, oxygen: 0, submerged: true }), ['took 1 damage (drowning), HP 19/20'])
})

test('a hit with no attacker named keeps its text under water with oxygen and food left', async () => {
  assert.deepStrictEqual(await envHit({ food: 1, oxygen: 1, submerged: true }), ['took 1 damage (no attacker named, no hostile within 4), HP 19/20'])
})

test('a hit the server names a damage type for keeps that type at food 0', async () => {
  assert.deepStrictEqual(await envHit({ food: 0, oxygen: 20, submerged: false, attrib: { desc: 'fall' } }), ['took 1 damage (fall), HP 19/20'])
})
