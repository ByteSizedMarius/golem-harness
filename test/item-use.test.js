'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Item = require('prismarine-item')(registry)
const { botConstant, loadBotFunctions, routeHandler, awaitRoute, runRoute, wireListeners } = require('./helpers')

const MOVES = botConstant('MOVES')
const item = (name) => new Item(registry.itemsByName[name].id, 1)

// A body after a spawn, at food 10, carrying bread, a bow and arrows, and a shield in the off hand. log records
// each move control that changes, each item use and release, each swing and each meal. walk() sets the controls
// a running pathfinder walk sets on every tick. An item use or release throws bot.fault once it is set.
function body () {
  const log = []
  const items = ['bread', 'bow', 'arrow'].map(item)
  const bot = Object.assign(new EventEmitter(), {
    food: 10,
    foodSaturation: 0,
    heldItem: null,
    quickBarSlot: 0,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    controlState: {},
    inventory: { items: () => items, slots: { 45: item('shield') } },
    setControlState (c, s) {
      if (MOVES.includes(c) && !!bot.controlState[c] !== s) log.push(`${c} ${s}`)
      bot.controlState[c] = s
    },
    equip: async (it) => { bot.heldItem = it },
    lookAt: async () => {},
    waitForTicks: async () => {},
    activateItem (offHand) {
      if (bot.fault) throw bot.fault
      log.push(`use ${offHand ? 'shield' : bot.heldItem.name}`)
    },
    deactivateItem () {
      if (bot.fault) throw bot.fault
      log.push('release')
    },
    // The server's update_health for the meal follows 20 ms after it ends.
    consume: async () => {
      log.push('eat')
      walk()
      bot.attack()
      await new Promise((resolve) => setImmediate(resolve))
      log.push('ate')
      setTimeout(() => {
        bot.food = 15
        bot.emit('health')
      }, 20)
    },
    attack () { log.push('swing') }
  })
  const walk = () => {
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
  }
  const env = {
    bot,
    ready: true,
    LEGACY_1710: false,
    MOVES,
    mcData: { foods: registry.foods },
    RISKY_FOODS: botConstant('RISKY_FOODS'),
    FOOD_UPDATE_MS: botConstant('FOOD_UPDATE_MS'),
    guardState: { up: false, slot: -1, pilot: false },
    reflexes: [{ name: 'combat' }, { name: 'bunker' }],
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false, cell: null },
    lastHit: null,
    setTimeout,
    clearTimeout
  }
  wireListeners(env, 'spawn')
  bot.emit('spawn')
  return { bot, env, log, walk }
}

test('a meal holds a running walk still until it ends, and drops a swing meanwhile', async () => {
  const { env, log, walk } = body()
  walk()
  const reply = await awaitRoute('/eat', {}, env)
  assert.strictEqual(reply.ate, 'bread')
  assert.deepStrictEqual(log, ['forward true', 'sprint true', 'forward false', 'sprint false', 'eat', 'ate', 'forward true', 'sprint true'])
})

test('a bow draw holds a running walk still until the arrow is loosed, and drops a swing meanwhile', async () => {
  const { bot, env, log, walk } = body()
  const target = { id: 7, name: 'skeleton', position: new Vec3(10.5, 64, 0.5) }
  bot.entities[7] = target
  // The draw's wait, through which the walk sets its controls every tick.
  env.setTimeout = (fn) => {
    walk()
    bot.attack()
    setImmediate(fn)
  }
  const ctx = loadBotFunctions(['drawAndLoose'], { ...env, bowLine: () => true })
  walk()
  assert.strictEqual(await ctx.drawAndLoose(target), true)
  assert.deepStrictEqual(log, ['forward true', 'sprint true', 'forward false', 'sprint false', 'use bow', 'release', 'forward true', 'sprint true'])
})

test('a bow draw that throws hands the walk its legs back and the error to the caller', () => {
  const { bot, log, walk } = body()
  bot.heldItem = item('bow')
  walk()
  bot.fault = new Error('socket closed')
  assert.throws(() => bot.activateItem(), bot.fault)
  bot.setControlState('forward', false)
  assert.deepStrictEqual(log, ['forward true', 'sprint true', 'forward false', 'sprint false', 'forward true', 'sprint true', 'forward false'])
})

test('a bow release that throws hands the walk its legs back and the error to the caller', () => {
  const { bot, log, walk } = body()
  bot.heldItem = item('bow')
  walk()
  bot.activateItem()
  bot.fault = new Error('socket closed')
  assert.throws(() => bot.deactivateItem(), bot.fault)
  bot.setControlState('forward', false)
  assert.deepStrictEqual(log, ['forward true', 'sprint true', 'forward false', 'sprint false', 'use bow', 'forward true', 'sprint true', 'forward false'])
})

test('a 1.21 shield comes down before a walk or a sprint, and a moving body raises none', () => {
  const { bot, env, log } = body()
  assert.deepStrictEqual(runRoute('/guard', { on: '1' }, env), { guarding: true })
  bot.setControlState('forward', true)
  bot.setControlState('forward', false)
  assert.deepStrictEqual(runRoute('/guard', { on: '1' }, env), { guarding: true })
  bot.setControlState('sprint', true)
  const moves = ['use shield', 'release', 'forward true', 'forward false', 'use shield', 'release', 'sprint true']
  assert.deepStrictEqual(log, moves)
  const { handle, res } = routeHandler('/guard', env)
  handle({ query: { on: '1' } }, res)
  assert.match(res.error.message, /moving/)
  assert.deepStrictEqual(log, moves)
})
