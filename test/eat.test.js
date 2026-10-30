'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const registry = require('prismarine-registry')('1.21.11')
const Item = require('prismarine-item')(registry)
const { loadBotFunctions, botConstant, routeHandler, fakeClock, claimRescue } = require('./helpers')

const stack = (name, count) => new Item(registry.itemsByName[name].id, count)

// A body at food 6 carrying stacks, its timers on a fake clock. During a meal, server(bot, items, clock) stands in
// for the server: a set_slot replaces an Item in items, an update_health sets the food level and emits health.
function body (stacks, server = () => {}) {
  const clock = fakeClock()
  const items = stacks.slice()
  const bot = Object.assign(new EventEmitter(), { food: 6, foodSaturation: 0, heldItem: null })
  bot.inventory = { items: () => items }
  bot.equip = async (item) => { bot.heldItem = item }
  bot.consume = async () => { server(bot, items, clock) }
  const env = {
    bot,
    shared: { mcData: { foods: registry.foods } },
    RISKY_FOODS: botConstant('RISKY_FOODS'),
    FOOD_UPDATE_MS: botConstant('FOOD_UPDATE_MS'),
    jobs: { list: () => [] },
    guardState: { hand: null },
    digLock: botConstant('digLock'),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  }
  return { bot, items, clock, env }
}

// Runs done() to its end, stepping the clock 10 ms at a time.
async function settle (clock, done) {
  let end = false
  done.then(() => { end = true }, () => { end = true })
  while (!end && clock.now() < 10000) {
    await new Promise(setImmediate)
    clock.advance(10)
  }
  await new Promise(setImmediate)
  assert.ok(end, 'no reply within 10 s')
  return done
}

async function eat (b, query = {}) {
  const { handle, res } = routeHandler('/eat', b.env)
  await settle(b.clock, handle({ query }, res))
  return res
}

// The server's update_health raising food to food, ms after the bite.
const fedAt = (ms, food) => (bot, items, clock) => clock.setTimeout(() => {
  bot.food = food
  bot.emit('health')
}, ms)

// The server's set_slot for the stack at index i holding count, ms after the bite.
const slotAt = (ms, i, count) => (bot, items, clock) => clock.setTimeout(() => { items[i] = stack(items[i].name, count) }, ms)

test('eat answers ok false naming the count and food level when the count stays and no food update comes', async () => {
  const b = body([stack('cooked_beef', 18)])
  b.bot.food = 0
  const res = await eat(b)
  assert.strictEqual(res.body, undefined, `eat answered ${JSON.stringify(res.body)}`)
  assert.strictEqual(res.error.reason, 'no_meal')
  assert.strictEqual(res.error.message, `no meal seen within ${b.env.FOOD_UPDATE_MS} ms: cooked_beef 18 before and 18 after, food 0/20 before and after. The pockets may show items the server does not hold.`)
})

test('eat answers the error of a cancelled consume and leaves no food-update listener', async () => {
  const b = body([stack('cooked_beef', 18)])
  b.bot.consume = async () => { throw new Error('Consuming cancelled') }
  const { handle, res } = routeHandler('/eat', b.env)
  await handle({ query: {} }, res)
  assert.strictEqual(res.body, undefined, `eat answered ${JSON.stringify(res.body)}`)
  assert.strictEqual(res.error.message, 'Consuming cancelled')
  assert.strictEqual(b.bot.listenerCount('health'), 0)
})

test('eat waits for the food update of a meal whose consume ended early', async () => {
  const b = body([stack('cooked_beef', 18)], (...a) => { slotAt(1600, 0, 17)(...a); fedAt(1700, 8)(...a) })
  const res = await eat(b)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.strictEqual(res.body.foodNow, 8)
  assert.strictEqual(res.body.unconfirmed, undefined)
})

test('eat reads the food count by name after the stack and the held item change', async () => {
  const b = body([stack('iron_sword', 1), stack('cooked_beef', 18)], slotAt(0, 1, 17))
  b.bot.heldItem = b.items[0]
  const res = await eat(b)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.strictEqual(b.bot.heldItem.name, 'iron_sword')
  assert.match(res.body.unconfirmed, /no food update/)
})

test('eat answers ok false when the pockets lose more than one without a food update', async () => {
  const b = body([stack('cooked_beef', 18)], slotAt(0, 0, 10))
  const res = await eat(b)
  assert.strictEqual(res.body, undefined, `eat answered ${JSON.stringify(res.body)}`)
  assert.strictEqual(res.error.reason, 'no_meal')
  assert.match(res.error.message, /cooked_beef 18 before and 10 after/)
})

test('eat answers ok with unconfirmed when the pockets lose the one eaten and no food update comes', async () => {
  const b = body([stack('cooked_beef', 2)], slotAt(0, 0, 1))
  const res = await eat(b)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.strictEqual(res.body.foodNow, 6)
  assert.match(res.body.unconfirmed, /no food update/)
})

// A body holding an iron shovel under the hand lease of the buried self-rescue, recording its equips and bites.
function rescueBody (server) {
  const b = body([stack('iron_shovel', 1), stack('cooked_beef', 18)], server)
  b.bot.heldItem = b.items[0]
  b.done = []
  const consume = b.bot.consume
  b.bot.equip = async (item) => { b.done.push(`equip ${item.name}`); b.bot.heldItem = item }
  b.bot.consume = async () => { b.done.push('bite'); await consume() }
  b.lease = { end: () => b.done.push('lease ended') }
  b.env.guardState.hand = b.lease
  return b
}

test('eat refuses busy while the buried self-rescue holds the hand and leaves its shovel and lease alone', async () => {
  const b = rescueBody()
  claimRescue(b.env.digLock)
  const res = await eat(b)
  assert.strictEqual(res.body, undefined, `eat answered ${JSON.stringify(res.body)}`)
  assert.strictEqual(res.error.reason, 'busy')
  assert.strictEqual(res.error.message, 'busy: the buried self-rescue is running, nothing eaten')
  assert.deepStrictEqual(b.done, [])
  assert.strictEqual(b.bot.heldItem.name, 'iron_shovel')
  assert.strictEqual(b.env.guardState.hand, b.lease)
})

test('eat takes the hand and eats once the buried self-rescue ends', async () => {
  const b = rescueBody(slotAt(0, 1, 17))
  const { holdHand, endHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState: b.env.guardState, digLock: b.env.digLock, setTimeout: b.clock.setTimeout, clearTimeout: b.clock.clearTimeout })
  b.env.guardState.hand = null
  claimRescue(b.env.digLock)
  const rescue = holdHand(b.env.digLock.holder)
  // The rescue's own end: its lease, then its claim.
  endHand(rescue)
  b.env.digLock.holder = null
  const res = await eat(b)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.strictEqual(res.body.ate, 'cooked_beef')
  assert.deepStrictEqual(b.done, ['equip cooked_beef', 'bite', 'equip iron_shovel'])
  assert.strictEqual(b.env.guardState.hand, null)
})

test('eat refuses busy and puts nothing back once the buried self-rescue takes the hand mid-bite, naming the unconfirmed meal', async () => {
  const b = body([stack('iron_sword', 1), stack('cooked_beef', 18), stack('iron_shovel', 1)])
  b.bot.heldItem = b.items[0]
  const { holdHand } = loadBotFunctions(['holdHand'], { guardState: b.env.guardState, digLock: b.env.digLock, setTimeout: b.clock.setTimeout, clearTimeout: b.clock.clearTimeout })
  let rescue = null
  b.bot.consume = async () => {
    slotAt(0, 1, 17)(b.bot, b.items, b.clock)
    claimRescue(b.env.digLock)
    rescue = holdHand(b.env.digLock.holder)
    // The rescue renews its lease for each dig, past the food update wait.
    rescue.renew(10000)
    b.bot.heldItem = b.items[2]
  }
  const res = await eat(b)
  assert.strictEqual(res.body, undefined, `eat answered ${JSON.stringify(res.body)}`)
  assert.strictEqual(res.error.reason, 'busy')
  assert.strictEqual(res.error.message, `ate cooked_beef, food 6/20 (no food update from the server within ${b.env.FOOD_UPDATE_MS} ms, food may predate the meal), then busy: the buried self-rescue is running, nothing put back in hand`)
  assert.strictEqual(b.bot.heldItem.name, 'iron_shovel')
  assert.strictEqual(b.env.guardState.hand, rescue)
  assert.strictEqual(b.bot.listenerCount('health'), 0)
})

test('eat refuses busy and bites nothing once the buried self-rescue takes the hand during the food equip', async () => {
  const b = body([stack('iron_sword', 1), stack('cooked_beef', 18), stack('iron_shovel', 1)])
  b.bot.heldItem = b.items[0]
  const { holdHand } = loadBotFunctions(['holdHand'], { guardState: b.env.guardState, digLock: b.env.digLock, setTimeout: b.clock.setTimeout, clearTimeout: b.clock.clearTimeout })
  const done = []
  let rescue = null
  b.bot.equip = async (item) => {
    done.push(`equip ${item.name}`)
    b.bot.heldItem = item
    claimRescue(b.env.digLock)
    rescue = holdHand(b.env.digLock.holder)
  }
  b.bot.consume = async () => { done.push('bite') }
  const res = await eat(b)
  assert.strictEqual(res.body, undefined, `eat answered ${JSON.stringify(res.body)}`)
  assert.strictEqual(res.error.reason, 'busy')
  assert.strictEqual(res.error.message, 'busy: the buried self-rescue is running, nothing eaten')
  assert.deepStrictEqual(done, ['equip cooked_beef'])
  assert.strictEqual(b.env.guardState.hand, rescue)
  assert.strictEqual(b.bot.listenerCount('health'), 0)
})

// A body holding an iron sword whose bite, run by server, starts the bunker build. done records its equips and bites.
function bunkerBite (server) {
  const b = body([stack('iron_sword', 1), stack('cooked_beef', 18)])
  b.bot.heldItem = b.items[0]
  const { claimDig } = loadBotFunctions(['claimDig'], { digLock: b.env.digLock })
  b.done = []
  b.bot.equip = async (item) => { b.done.push(`equip ${item.name}`); b.bot.heldItem = item }
  b.bot.consume = async () => {
    b.done.push('bite')
    server(b.bot, b.items, b.clock)
    claimDig('the bunker build', true).sole = true
  }
  return b
}

test('eat refuses busy and puts nothing back once the bunker build starts mid-bite, naming the meal the server confirmed', async () => {
  const b = bunkerBite(fedAt(100, 9))
  const res = await eat(b)
  assert.strictEqual(res.body, undefined, `eat answered ${JSON.stringify(res.body)}`)
  assert.strictEqual(res.error.reason, 'busy')
  assert.strictEqual(res.error.message, 'ate cooked_beef, food 9/20, then busy: the bunker build is running, nothing put back in hand')
  assert.deepStrictEqual(b.done, ['equip cooked_beef', 'bite'])
  assert.strictEqual(b.bot.listenerCount('health'), 0)
})

test('eat refuses busy once the bunker build starts mid-bite, naming a bite the server never answered', async () => {
  const b = bunkerBite(() => {})
  const res = await eat(b)
  assert.strictEqual(res.error.reason, 'busy')
  assert.strictEqual(res.error.message, `no meal seen within ${b.env.FOOD_UPDATE_MS} ms: cooked_beef 18 before and 18 after, food 6/20 before and after, then busy: the bunker build is running, nothing put back in hand. The pockets may show items the server does not hold.`)
  assert.deepStrictEqual(b.done, ['equip cooked_beef', 'bite'])
})

test('refuel after a fight reports a bite that changed nothing', async () => {
  const b = body([stack('cooked_beef', 18)])
  const events = []
  const ctx = loadBotFunctions(['refuelAfterFight'], { ...b.env, emitEvent: (kind, msg) => events.push([kind, msg]) })
  await settle(b.clock, ctx.refuelAfterFight())
  assert.deepStrictEqual(events, [['refuel', `no meal seen within ${b.env.FOOD_UPDATE_MS} ms of the bite after the fight: cooked_beef 18 before and 18 after, food 6/20. The pockets may show items the server does not hold.`]])
})
