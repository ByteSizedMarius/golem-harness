'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { awaitRoute, loadBotFunctions, walkingBody } = require('./helpers')

const START = new Vec3(0.5, 64, 0.5)
// Where items thrown by a body at START facing north land.
const DROP = new Vec3(0, 64, -2)
const ck = (x, y, z) => `${x},${y},${z}`
const TYPES = { cobblestone: 1, dirt: 2, diamond: 3, diamond_pickaxe: 4 }
const stack = (name, count) => ({ name, type: TYPES[name], count, stackSize: 64 })

// A body at at (START) facing north on the real pathfinder over the floor plus cells, walking by body.moves. tossed holds
// each toss's count, pauses the tosses before each stack pause, and walks each plan's cells.
async function tossingBody (t, stacks, cells = {}, at = START) {
  const { bot, plan } = await walkingBody(t, at.clone(), cells)
  const body = { bot, moves: bot.pathfinder.movements, tossed: [], pauses: [], walks: [] }
  Object.assign(bot.entity, { yaw: 0, pitch: 0 })
  bot.inventory = { items: () => stacks.filter((s) => s.count > 0) }
  bot.toss = async (type, metadata, count) => {
    body.tossed.push(count)
    for (const s of stacks.filter((s) => s.type === type)) {
      const k = Math.min(count, s.count)
      s.count -= k
      count -= k
    }
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
    stackPause: async () => { body.pauses.push(body.tossed.length) }
  }
  return body
}

// knownMoves over the cells known(p) holds.
function knowing (body, known) {
  const { knownMoves } = loadBotFunctions(['knownMoves'], { ck, knownCell: known, PLAN_KNOWN: new Map() })
  body.moves = knownMoves(body.moves)
}

test('toss throws the item named exactly before one whose name only contains it', async (t) => {
  const stacks = [stack('diamond_pickaxe', 1), stack('diamond', 5)]
  const reply = await awaitRoute('/toss', { name: 'diamond' }, (await tossingBody(t, stacks)).env)
  assert.deepStrictEqual(reply, { tossed: 'diamond', count: 5, toward: null })
  assert.deepStrictEqual(stacks.map((s) => s.count), [1, 0])
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
