'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { awaitRoute, routeHandler, loadBotFunctions, walkingBody } = require('./helpers')

const START = new Vec3(0.5, 64, 0.5)
// Where items thrown by a body at START facing north land.
const DROP = new Vec3(0, 64, -2)
const ck = (x, y, z) => `${x},${y},${z}`
const TYPES = { cobblestone: 1, dirt: 2, diamond: 3, diamond_pickaxe: 4, diamond_sword: 5, stone: 6 }
const NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]))
const stack = (name, count) => ({ name, type: TYPES[name], count, stackSize: 64 })
// Where a toss leaves the hand of a body at p.
const hand = (p, legacy = false) => p.offset(0, legacy ? 1.188 : 1.32, 0)

let nextId = 100
// Sends the stack of item entity e as count items of type.
function drop (bot, e, type, count) {
  e.getDroppedItem = () => ({ type, name: NAMES[type], count })
  bot.emit('itemDrop', e)
}

function serveItem (bot, type, count, at, { spawnMs = 5, dataMs = 10, id = nextId++, legacy = false } = {}) {
  const e = bot.entities[id] || { id, name: 'item', position: at, getDroppedItem: () => null }
  setTimeout(() => { bot.entities[id] = e; bot.emit('entitySpawn', e) }, spawnMs)
  setTimeout(() => {
    if (legacy) drop(bot, e, TYPES.stone, 1)
    drop(bot, e, type, count)
  }, dataMs)
  return e
}

function slowStep (bot, ms) {
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = async (goal) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return goto(goal)
  }
}

function pickUp (bot, player, e, ms) {
  setTimeout(() => {
    bot.emit('playerCollect', player, e)
    setTimeout(() => bot.emit('entityGone', e), 60)
  }, ms)
}

const STEVE = { id: 7, name: 'player', username: 'Steve', position: DROP }

// body.serve(type, count, i) lists the item entities the server spawns for toss i.
async function tossingBody (t, stacks, cells = {}, at = START, legacy = false) {
  const { bot, plan } = await walkingBody(t, at.clone(), cells)
  const body = { bot, moves: bot.pathfinder.movements, tossed: [], pauses: [], walks: [] }
  body.serve = (type, count) => [{ type, count }]
  Object.assign(bot.entity, { yaw: 0, pitch: 0 })
  bot.inventory = { items: () => stacks.filter((s) => s.count > 0) }
  bot.toss = async (type, metadata, count) => {
    const served = body.serve(type, count, body.tossed.length)
    body.tossed.push(count)
    for (const s of stacks.filter((s) => s.type === type)) {
      const k = Math.min(count, s.count)
      s.count -= k
      count -= k
    }
    for (const d of served) serveItem(bot, d.type, d.count, hand(bot.entity.position, legacy), { legacy })
  }
  bot.pathfinder.goto = async (goal) => {
    const result = plan(goal, body.moves)
    body.walks.push(result.path.map((p) => [Math.floor(p.x), p.y, Math.floor(p.z)]))
    if (result.status !== 'success') {
      bot.pathfinder.setGoal(goal)
      throw Object.assign(new Error('No path to the goal!'), { name: 'NoPath' })
    }
    const [x, y, z] = body.walks[body.walks.length - 1].at(-1)
    bot.entity.position = new Vec3(x + 0.5, y, z + 0.5)
  }
  body.env = {
    bot,
    shared: { ready: true },
    goals,
    Vec3,
    legs: legLedger(),
    takenText,
    stopPath: () => bot.pathfinder.setGoal(null),
    stackPause: async () => { body.pauses.push(body.tossed.length) },
    setTimeout,
    staleEntities: new Set()
  }
  return body
}

// knownMoves over the cells known(p) holds, with no cell made out by its shape alone.
function knowing (body, known) {
  const { knownMoves } = loadBotFunctions(['knownMoves'], { bot: body.bot, ck, knownCell: known, shapeNear: () => null, PLAN_KNOWN: new Map() })
  body.moves = knownMoves(body.moves)
}

test('toss throws the item named exactly before one whose name only contains it', async (t) => {
  const stacks = [stack('diamond_pickaxe', 1), stack('diamond', 5)]
  const reply = await awaitRoute('/toss', { name: 'diamond' }, (await tossingBody(t, stacks)).env)
  assert.deepStrictEqual(reply, { tossed: 'diamond', count: 5, toward: null })
  assert.deepStrictEqual(stacks.map((s) => s.count), [1, 0])
})

test('toss refuses a name several items hold as whole words, naming them and tossing nothing', async (t) => {
  const body = await tossingBody(t, [stack('diamond_pickaxe', 1), stack('diamond_sword', 1)])
  const { handle, res } = routeHandler('/toss', body.env)
  await handle({ query: { name: 'diamond' } }, res)
  assert.deepStrictEqual([res.error?.message, res.error?.reason], ['refused: diamond matches several items in inventory (diamond_sword, diamond_pickaxe), name one in full', 'ambiguous'])
  assert.deepStrictEqual(body.tossed, [])
})

test('toss drops a count over one stack from several stacks, a stack pause apart', async (t) => {
  const stacks = [stack('cobblestone', 64), stack('dirt', 10), stack('cobblestone', 64), stack('cobblestone', 64)]
  const body = await tossingBody(t, stacks)
  const reply = await awaitRoute('/toss', { name: 'cobblestone', count: '150' }, body.env)
  assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: 150, toward: null })
  assert.deepStrictEqual(body.tossed, [64, 64, 22])
  assert.deepStrictEqual(body.pauses, [1, 2])
  assert.deepStrictEqual(stacks.map((s) => s.count), [0, 10, 0, 42])
})

test('toss counts the items the server threw, not the ones it asked to throw', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64)])
  body.serve = (type) => [{ type, count: 30 }, { type, count: 10 }]
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: 40, sent: 64, unconfirmed: '24 of 64 sent not seen thrown within 1000 ms', toward: null })
})

test('toss with no thrown item seen claims no count', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64)])
  body.serve = () => []
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: null, sent: 64, unconfirmed: 'no thrown cobblestone seen within 1000 ms', toward: null })
})

test('toss on 1.7.10 counts each thrown item by its real stack after the stone placeholder', async (t) => {
  for (const [name, count] of [['cobblestone', 64], ['stone', 64], ['stone', 1]]) {
    const body = await tossingBody(t, [stack(name, count)], {}, START, true)
    const reply = await awaitRoute('/toss', { name }, body.env)
    assert.deepStrictEqual(reply, { tossed: name, count, toward: null }, `${name} x${count}`)
  }
})

test('toss on 1.7.10 counts singles that merge into one item once, by the stacks they spawned with', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 10)], {}, START, true)
  const { bot } = body
  body.serve = (type) => {
    const singles = Array.from({ length: 10 }, () => serveItem(bot, type, 1, hand(START, true), { legacy: true }))
    // As live: the survivor shows the merged stack 100 ms after the spawn, the merged ones go 50 ms after that.
    setTimeout(() => {
      drop(bot, singles[0], type, 10)
      setTimeout(() => { for (const e of singles.slice(1)) bot.emit('entityGone', e) }, 50)
    }, 105)
    return []
  }
  slowStep(bot, 300)
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: 10, toward: null })
})

test('toss counts a thrown stack destroyed without a collect, as in lava', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64)])
  const { bot } = body
  body.serve = (type, count) => {
    const e = serveItem(bot, type, count, hand(START))
    setTimeout(() => bot.emit('entityGone', e), 100)
    return []
  }
  slowStep(bot, 200)
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: 64, toward: null })
})

test('toss reports at most the count it sent and notes more of the item seen thrown at the hand', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64)])
  body.serve = (type, count) => [{ type, count }, { type, count: 10 }]
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: 64, note: '10 more cobblestone seen thrown at the hand than the 64 sent', toward: null })
})

test('toss leaves out drops that are not its own throws', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64), stack('cobblestone', 64)])
  const { bot } = body
  const lying = { id: 50, name: 'item', position: hand(START), getDroppedItem: () => null }
  bot.entities[lying.id] = lying
  body.serve = (type, count, i) => {
    if (i > 0) return [{ type, count: 30 }]
    // Decoys around the first throw: a known item, a drop at the feet, a throw 3 blocks off and dirt at the hand.
    serveItem(bot, type, 10, hand(START), { id: lying.id })
    serveItem(bot, type, 5, START.offset(0.2, 0.1, 0.2))
    serveItem(bot, type, 7, hand(START).offset(3, 0, 0))
    serveItem(bot, TYPES.dirt, 9, hand(START))
    return [{ type, count }]
  }
  // A throw at the hand that lands after the first throw's deadline and before the second throw.
  body.env.stackPause = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100))
    serveItem(bot, TYPES.cobblestone, 11, hand(START), { spawnMs: 0, dataMs: 5 })
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const reply = await awaitRoute('/toss', { name: 'cobblestone', count: '128' }, body.env)
  assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: 94, sent: 128, unconfirmed: '34 of 128 sent not seen thrown within 1000 ms', toward: null })
})

test('toss leaves out a drop of its item 0.7 blocks from the hand, as one mined in the next cell', async (t) => {
  for (const legacy of [false, true]) {
    const body = await tossingBody(t, [stack('cobblestone', 64)], {}, START, legacy)
    body.serve = (type, count) => {
      serveItem(body.bot, type, 5, hand(START, legacy).offset(0.7, 0, 0), { legacy })
      return [{ type, count }]
    }
    const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
    assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: 64, toward: null }, `legacy ${legacy}`)
  }
})

test('toss leaves the listeners on the bot and its client as it found them', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64)])
  const { bot } = body
  const listeners = () => [bot, bot._client].map((on) => Object.fromEntries(on.eventNames().map((e) => [e, on.listenerCount(e)])))
  const before = listeners()
  let during = null
  body.serve = (type, count) => {
    during = listeners()
    return [{ type, count }]
  }
  assert.strictEqual((await awaitRoute('/toss', { name: 'cobblestone' }, body.env)).count, 64)
  assert.deepStrictEqual([during[0].entitySpawn - (before[0].entitySpawn ?? 0), during[0].itemDrop - (before[0].itemDrop ?? 0)], [1, 1], 'control: the route listens while it tosses')
  assert.deepStrictEqual(listeners(), before)
})

test('toss counts a thrown stack a player picks up before the read', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64)])
  const { bot } = body
  body.serve = (type, count) => {
    pickUp(bot, STEVE, serveItem(bot, type, count, hand(START)), 2000)
    return []
  }
  slowStep(bot, 2100)
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: 64, toward: null })
})

test('toss steps back from the drop through known cells only', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64), stack('cobblestone', 64)])
  await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.deepStrictEqual(body.bot.entity.position.floored(), new Vec3(0, 64, 2), 'control: with every cell known the body walks straight back')

  body.bot.entity.position = START.clone()
  knowing(body, (p) => p.z <= 0)
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.strictEqual(reply.stayed, undefined)
  assert.ok(body.walks[1].every(([, , z]) => z <= 0), `walked ${JSON.stringify(body.walks[1])}`)
  assert.ok(body.bot.entity.position.floored().distanceTo(DROP) > 3, `ended at ${body.bot.entity.position}`)
})

const STAYED = /^no known cell more than 3 blocks from the drop/

test('toss names why the body stayed when no known cell lies clear of the drop', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64)])
  knowing(body, (p) => p.x === 0 && p.z === 0)
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.strictEqual(reply.count, 64)
  assert.match(reply.stayed, STAYED)
  assert.deepStrictEqual(body.bot.entity.position, START)
  assert.strictEqual(body.bot.pathfinder.goal, null, 'the pathfinder walks the partial plan of a goal left set')
})

test('toss on a pillar top stays rather than step down more than one block', async (t) => {
  const pillar = { '0,64,0': ['stone', {}], '0,65,0': ['stone', {}], '0,66,0': ['stone', {}] }
  const top = new Vec3(0.5, 67, 0.5)
  const body = await tossingBody(t, [stack('cobblestone', 64)], pillar, top)
  knowing(body, (p) => Math.abs(p.x) <= 4 && Math.abs(p.z) <= 4 && p.y >= 62)
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.match(reply.stayed, STAYED)
  assert.deepStrictEqual(body.bot.entity.position, top)
  assert.strictEqual(body.bot.pathfinder.goal, null)
})

test('toss down a one-wide tunnel toward its open end stays rather than walk across the drop', async (t) => {
  const body = await tossingBody(t, [stack('cobblestone', 64)])
  knowing(body, (p) => p.x === 0 && p.z >= -10 && p.z <= 0)
  const reply = await awaitRoute('/toss', { name: 'cobblestone' }, body.env)
  assert.match(reply.stayed, STAYED)
  assert.ok(body.walks.flat().every(([, , z]) => z >= 0), `planned ${JSON.stringify(body.walks)}`)
  assert.deepStrictEqual(body.bot.entity.position, START)
})

test('toss stops between stacks once a reflex takes the legs, names it and skips the step back', async (t) => {
  const stacks = [stack('cobblestone', 64), stack('cobblestone', 64), stack('cobblestone', 64)]
  const body = await tossingBody(t, stacks)
  body.env.stackPause = async () => { body.env.legs.take('combat', 'fight a zombie') }
  const reply = await awaitRoute('/toss', { name: 'cobblestone', count: '150' }, body.env)
  assert.deepStrictEqual(reply, { tossed: 'cobblestone', count: 64, toward: null, reason: 'stopped', takenBy: takenText({ reflex: 'combat', why: 'fight a zombie' }) })
  assert.deepStrictEqual(body.walks, [])
})
