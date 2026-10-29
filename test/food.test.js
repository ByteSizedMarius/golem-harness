'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const registry = require('prismarine-registry')('1.21.11')
const Item = require('prismarine-item')(registry)
const { createJobs } = require('../lib/jobs')
const { deathLedger } = require('../lib/deaths')
const { loadBotFunctions, botConstant, routeHandler, awaitRoute, fakeClock, delay } = require('./helpers')

const FOOD_UPDATE_MS = botConstant('FOOD_UPDATE_MS')

// A body at food 10 carrying names. update(bot) runs once a meal ends, standing in for the server.
function body (names, update = () => {}) {
  const items = names.map((n) => new Item(registry.itemsByName[n].id, 1))
  const bot = Object.assign(new EventEmitter(), { food: 10, foodSaturation: 0, heldItem: null, eaten: [] })
  bot.inventory = { items: () => items }
  bot.equip = async (item) => { bot.heldItem = item }
  bot.consume = async () => { bot.eaten.push(bot.heldItem.name); update(bot) }
  return bot
}

// The server's update_health for a meal, 20 ms after it ends.
const fed = (food, saturation) => (bot) => setTimeout(() => {
  bot.food = food
  bot.foodSaturation = saturation
  bot.emit('health')
}, 20)

const env = (bot, extra = {}) => ({
  bot,
  shared: { mcData: { foods: registry.foods } },
  RISKY_FOODS: botConstant('RISKY_FOODS'),
  FOOD_UPDATE_MS,
  jobs: createJobs({ stop () {}, emit () {}, deaths: deathLedger() }),
  guardState: { hand: null },
  setTimeout,
  clearTimeout,
  ...extra
})

test('eat without a name picks a safe food over more filling rotten flesh', async () => {
  const bot = body(['rotten_flesh', 'carrot'], fed(13, 3.6))
  const reply = await awaitRoute('/eat', {}, env(bot))
  assert.strictEqual(reply.ate, 'carrot')
  assert.deepStrictEqual(bot.eaten, ['carrot'])
})

test('eat refuses rotten flesh unless the pilot names it', async () => {
  const bot = body(['rotten_flesh'], fed(14, 0.8))
  const { handle, res } = routeHandler('/eat', env(bot))
  await handle({ query: {} }, res)
  assert.match(res.error.message, /^no safe food in inventory, rotten_flesh/)
  assert.deepStrictEqual(bot.eaten, [])
  const reply = await awaitRoute('/eat', { food: 'rotten_flesh' }, env(bot))
  assert.strictEqual(reply.ate, 'rotten_flesh')
  assert.deepStrictEqual(bot.eaten, ['rotten_flesh'])
})

test('eat replies with the food level of the update that follows the meal', async () => {
  const bot = body(['bread'], fed(15, 6))
  const reply = await awaitRoute('/eat', {}, env(bot))
  assert.strictEqual(reply.foodBefore, 10)
  assert.strictEqual(reply.foodNow, 15)
  assert.strictEqual(reply.unconfirmed, undefined)
  assert.strictEqual(bot.listenerCount('health'), 0)
})

test('eat says the food level is unconfirmed when no update arrives', async () => {
  const clock = fakeClock()
  const bot = body(['bread'], (b) => b.inventory.items().splice(0, 1))
  const { handle, res } = routeHandler('/eat', env(bot, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }))
  const done = handle({ query: {} }, res)
  await delay(10)
  assert.strictEqual(res.body, undefined, 'replied before the wait ended')
  clock.advance(FOOD_UPDATE_MS)
  await done
  assert.strictEqual(res.body.foodNow, 10)
  assert.match(res.body.unconfirmed, /no food update/)
})

test('eat refuses while a job holds the hand, naming the job', async () => {
  const clock = fakeClock()
  const bot = body(['iron_pickaxe', 'bread'])
  const pick = bot.inventory.items()[0]
  bot.heldItem = pick
  // The job equips its pick again mid-meal, and mineflayer ends the consume on a held-item change.
  bot.consume = async () => { bot.heldItem = pick }
  const e = env(bot, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  e.jobs.start('dig_tunnel e x12', () => new Promise(() => {}))
  const { handle, res } = routeHandler('/eat', e)
  const done = handle({ query: {} }, res)
  await delay(10)
  clock.advance(FOOD_UPDATE_MS)
  await done
  assert.ok(res.error, `eat answered ${JSON.stringify(res.body)}`)
  assert.strictEqual(res.error.message, 'busy: job 1 dig_tunnel e x12 holds the hand')
  assert.strictEqual(res.error.reason, 'busy')
  assert.strictEqual(bot.heldItem, pick)
})

// refuelAfterFight over bot, with the event texts it emits and their kinds.
function refuel (bot) {
  const events = []
  const kinds = []
  const ctx = loadBotFunctions(['refuelAfterFight'], env(bot, { guardState: { hand: null }, emitEvent: (kind, msg) => { kinds.push(kind); events.push(msg) } }))
  return { run: () => ctx.refuelAfterFight(), events, kinds }
}

test('refuel after a fight eats nothing when rotten flesh is the only food', async () => {
  const bot = body(['rotten_flesh'])
  const r = refuel(bot)
  await r.run()
  assert.deepStrictEqual(bot.eaten, [])
  assert.deepStrictEqual(r.events, [])
})

test('refuel after a fight reports the food level of the update that follows the meal', async () => {
  const bot = body(['rotten_flesh', 'carrot'], fed(13, 3.6))
  const r = refuel(bot)
  await r.run()
  assert.deepStrictEqual(bot.eaten, ['carrot'])
  assert.strictEqual(r.events.length, 1)
  assert.match(r.events[0], /^refueled on carrot after the fight, food 13\/20$/)
  assert.deepStrictEqual(r.kinds, ['refuel'])
})

test('refuel after a fight takes the previous item back in hand when the meal fails', async () => {
  const bot = body(['iron_sword', 'carrot'])
  bot.heldItem = bot.inventory.items()[0]
  bot.consume = async () => { throw new Error('Consuming cancelled') }
  await assert.rejects(refuel(bot).run(), /Consuming cancelled/)
  assert.strictEqual(bot.heldItem.name, 'iron_sword')
  assert.strictEqual(bot.listenerCount('health'), 0)
})
