'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { noJumpReason, passedNodes, step, RUN, MIN_FOOD } = require('../lib/sprint')
const { loadBotFunctions } = require('./helpers')

const EAST = { dx: 1, dz: 0 }

const AIR = { name: 'air', boundingBox: 'empty' }
const STONE = { name: 'stone', boundingBox: 'block' }
const WATER = { name: 'water', boundingBox: 'empty' }
const FARMLAND = { name: 'farmland', boundingBox: 'block' }
const WHEAT = { name: 'wheat', boundingBox: 'empty' }

// Flat stone up to y 63, plus the cells in extra ('x,y,z' -> block).
const world = (extra = {}) => (p) => extra[`${p.x},${p.y},${p.z}`] || (p.y <= 63 ? STONE : AIR)
// A pathfinder node: feet at y, x and z at the cell centre.
const node = (x, y, z, work = {}) => ({ x: x + 0.5, y, z: z + 0.5, toBreak: work.toBreak || [], toPlace: work.toPlace || [] })
// Nodes east from x 1 to x n on y 64.
const east = (n) => Array.from({ length: n }, (_, i) => node(i + 1, 64, 0))

function jumps (over = {}) {
  return noJumpReason({ path: east(6), pos: new Vec3(0.5, 64, 0.5), onGround: true, blockAt: world(), inWater: false, food: 20, fighting: false, ...over }) === null
}

test('the body sprint jumps along a straight, flat run with room overhead', () => {
  assert.strictEqual(jumps(), true)
  assert.strictEqual(jumps({ path: east(RUN) }), true, `exactly ${RUN} nodes`)
})

test('it lets go before a turn, a step, a drop or work on the path', () => {
  const run = east(6)
  const turn = [...run.slice(0, 2), node(2, 64, 1), node(2, 64, 2)]
  const up = [...run.slice(0, 2), node(3, 65, 0), node(4, 65, 0)]
  const down = [...run.slice(0, 2), node(3, 63, 0), node(4, 63, 0)]
  const door = [...run.slice(0, 2), node(3, 64, 0, { toPlace: [{ useOne: true }] }), node(4, 64, 0)]
  const diagonal = [node(1, 64, 1), node(2, 64, 2), node(3, 64, 3), node(4, 64, 4)]
  for (const [label, path] of [['a turn', turn], ['a step up', up], ['a drop', down], ['a door', door], ['a diagonal', diagonal], ['a short path', east(RUN - 1)]]) {
    assert.strictEqual(jumps({ path }), false, label)
  }
})

test('it never jumps under a low ceiling or into water along the run', () => {
  assert.strictEqual(jumps({ blockAt: world({ '3,66,0': STONE }) }), false, 'a ceiling 3 above a node')
  assert.strictEqual(jumps({ blockAt: world({ '0,66,0': STONE }) }), false, 'a ceiling 3 above the body')
  assert.strictEqual(jumps({ blockAt: world({ '6,66,0': STONE }) }), true, 'control: a ceiling past the run')
  assert.strictEqual(jumps({ blockAt: world({ '2,64,0': WATER }) }), false, 'water on the run')
})

test('it never jumps over a field or where a hop lands on one', () => {
  assert.strictEqual(jumps({ blockAt: world({ '2,63,0': FARMLAND }) }), false, 'farmland under the run')
  assert.strictEqual(jumps({ blockAt: world({ '5,63,0': FARMLAND }) }), false, 'farmland one cell past the run')
  assert.strictEqual(jumps({ blockAt: world({ '3,64,0': WHEAT }) }), false, 'a crop on the run')
  assert.strictEqual(jumps({ blockAt: world({ '6,63,0': FARMLAND }) }), true, 'control: farmland out of a hop\'s reach')
})

test('it never jumps in water, hungry, in a fight, off the ground, or off the line', () => {
  assert.strictEqual(jumps({ inWater: true }), false)
  assert.strictEqual(jumps({ food: MIN_FOOD - 1 }), false)
  assert.strictEqual(jumps({ food: MIN_FOOD }), true, `control: food ${MIN_FOOD}`)
  assert.strictEqual(jumps({ fighting: true }), false)
  assert.strictEqual(jumps({ onGround: false }), false)
  assert.strictEqual(jumps({ pos: new Vec3(0.5, 64, 1.5) }), false, 'a block to the side')
  assert.strictEqual(jumps({ pos: new Vec3(2.5, 64, 0.5) }), false, 'past the first node')
})

test('a hop ticks off the nodes it passed on a straight run, never the last one or past a turn', () => {
  const run = east(6)
  assert.strictEqual(passedNodes(run, new Vec3(0.8, 64, 0.5), EAST), 0, 'short of the first node')
  assert.strictEqual(passedNodes(run, new Vec3(3.6, 65.2, 0.6), EAST), 3, 'in the air past three nodes')
  assert.strictEqual(passedNodes(run, new Vec3(9.5, 64, 0.5), EAST), 5, 'the last node stays')
  const turn = [...run.slice(0, 3), node(3, 64, 1)]
  assert.strictEqual(passedNodes(turn, new Vec3(4.5, 64.5, 0.5), EAST), 2, 'the corner node stays')
  assert.strictEqual(passedNodes(run, new Vec3(3.2, 62, 0.5), EAST), 0, 'fallen below the run')
  assert.strictEqual(passedNodes(run, new Vec3(3.6, 65.2, 0.6), { dx: 0, dz: 1 }), 0, 'a run along another direction')
})

test('the corner node stays while the body is short of it, so the hop never cuts the corner', () => {
  const turn = [...east(3), node(3, 64, 1), node(3, 64, 2)]
  assert.strictEqual(passedNodes(turn, new Vec3(3.1, 64.6, 0.5), EAST), 2, '0.4 short of the corner')
  assert.strictEqual(passedNodes(turn.slice(2), new Vec3(3.1, 64.6, 0.5), EAST), 0, 'the corner first on the live path')
  assert.deepStrictEqual(step(turn[0], turn[1]), EAST, 'control: the run goes east')
})

// sprintTick of bot.js over a fake bot walking east along path.
function sprintBot (path, { sprint = true, moving = true, pos = new Vec3(0.5, 64, 0.5), onGround = true, cells = {} } = {}) {
  const controls = {}
  const logs = []
  const clock = { t: 1000000 }
  const bot = new EventEmitter()
  Object.assign(bot, {
    entity: { position: pos, onGround, isInWater: false },
    food: 20,
    pathfinder: { isMoving: () => moving, goal: {} },
    getControlState: (k) => (k === 'sprint' ? sprint : !!controls[k]),
    setControlState: (k, v) => { controls[k] = v },
    blockAt: world(cells)
  })
  const env = {
    bot, ready: true, livePath: path, hopping: false, hopDir: null, jumpHeld: false, sprintSaid: { line: null, goal: null, at: 0 },
    reflexes: [{ name: 'combat', active: false, _fleeUntil: 0 }], noJumpReason, passedNodes, nodeStep: step,
    console: { log: (s) => logs.push(s) }, Date: { now: () => clock.t }, closeDoorsBehind () {}
  }
  const ctx = loadBotFunctions(['sprintTick', 'skipPassedNodes', 'hookTicks', 'beforePathfinder', 'afterPathfinder'], env)
  return { env, controls, ctx, logs, clock, setMoving: (m) => { moving = m } }
}

test('sprintTick holds jump only while the pathfinder sprints along the path', () => {
  for (const [label, opts, jump] of [['sprinting', {}, true], ['walking', { sprint: false }, undefined], ['no path', { moving: false }, undefined]]) {
    const { ctx, controls } = sprintBot(east(6), opts)
    ctx.sprintTick()
    assert.strictEqual(controls.jump, jump, label)
  }
})

test('sprintTick declines the jump over a field and logs why', () => {
  const { ctx, controls, logs } = sprintBot(east(6), { cells: { '2,63,0': FARMLAND } })
  ctx.sprintTick()
  assert.deepStrictEqual([controls.jump, logs], [undefined, ['[sprint] no jump: farmland at 0 64 0']])
})

test('the [sprint] line comes once per walk, then for a changed decision at most every 5 s, never mid-hop', () => {
  const h = sprintBot(east(6))
  h.ctx.sprintTick()
  h.ctx.sprintTick()
  assert.deepStrictEqual(h.logs, ['[sprint] jump held at 0 64 0'], 'one line for an unchanged decision')
  h.env.bot.food = MIN_FOOD - 1
  h.ctx.sprintTick()
  assert.strictEqual(h.logs.length, 1, 'a change within 5 s waits')
  h.clock.t += 5000
  h.ctx.sprintTick()
  assert.deepStrictEqual(h.logs.slice(1), ['[sprint] no jump: too hungry at 0 64 0'], 'the change 5 s on')
  h.env.bot.pathfinder.goal = {}
  h.env.bot.entity.onGround = false
  h.ctx.sprintTick()
  assert.strictEqual(h.logs.length, 2, 'a tick in the air decides nothing')
  h.env.bot.entity.onGround = true
  h.ctx.sprintTick()
  assert.strictEqual(h.logs.length, 3, 'a new walk logs at once')
  const walker = sprintBot(east(6), { sprint: false })
  walker.ctx.sprintTick()
  assert.deepStrictEqual(walker.logs, ['[sprint] no jump: not sprinting at 0 64 0'])
})

test('the nodes a hop passed leave the live path, the ones after its landing stay, and a walk without a hop keeps all', () => {
  const path = east(6)
  const { env, ctx } = sprintBot(path)
  ctx.sprintTick()
  assert.strictEqual(env.hopping, true)
  env.bot.entity.position = new Vec3(2.9, 65.1, 0.5)
  env.bot.entity.onGround = false
  ctx.skipPassedNodes()
  assert.deepStrictEqual(path.map((n) => n.x), [3.5, 4.5, 5.5, 6.5], 'the hop passed two nodes')
  env.bot.entity.position = new Vec3(3.2, 64, 0.5)
  env.bot.entity.onGround = true
  ctx.skipPassedNodes()
  assert.deepStrictEqual([path.length, env.hopping], [4, false], 'landed short of the next node')
  const still = east(6)
  const walker = sprintBot(still, { sprint: false, pos: new Vec3(2.9, 64, 0.5) })
  walker.ctx.sprintTick()
  walker.ctx.skipPassedNodes()
  assert.strictEqual(still.length, 6)
})

test('a path reset or a stopped pathfinder mid-hop lets go of jump, sprint and forward', () => {
  for (const [label, end] of [['a reset on the ground', 'reset'], ['a reset in the air', 'air'], ['the pathfinder stopped', 'stop']]) {
    const h = sprintBot(east(6))
    h.ctx.hookTicks()
    h.ctx.sprintTick()
    Object.assign(h.controls, { sprint: true, forward: true })
    assert.strictEqual(h.controls.jump, true, `${label}: control, the hop holds jump`)
    if (end === 'air') {
      h.env.bot.entity.onGround = false
      h.ctx.sprintTick()
    }
    if (end === 'stop') {
      h.setMoving(false)
      h.ctx.sprintTick()
    } else h.env.bot.emit('path_reset', 'block_updated')
    assert.deepStrictEqual([h.controls.jump, h.controls.sprint, h.controls.forward, h.env.hopping], [false, false, false, false], label)
  }
  const walker = sprintBot(east(6), { sprint: false })
  walker.ctx.hookTicks()
  walker.ctx.sprintTick()
  walker.controls.forward = true
  walker.env.bot.emit('path_reset', 'goal_moved')
  assert.strictEqual(walker.controls.forward, true, 'a walk without a hop keeps the states the pathfinder set')
})

test('under the real plugin loader the hop hooks run around the pathfinder\'s own tick listener', async () => {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.write = () => {}
  client.end = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  bot.loadPlugin(pathfinder)
  const ctx = loadBotFunctions(['hookTicks', 'beforePathfinder', 'afterPathfinder'], { bot })
  ctx.hookTicks()
  await once(bot, 'inject_allowed')
  const ticks = bot.listeners('physicsTick')
  const own = ticks.findIndex((fn) => fn.name === 'monitorMovement')
  assert.ok(own >= 0, 'control: the pathfinder listens to physicsTick')
  assert.ok(ticks.indexOf(ctx.beforePathfinder) < own, 'the passed-node splice runs before the pathfinder steers')
  assert.ok(ticks.indexOf(ctx.afterPathfinder) > own, 'the hop runs after the pathfinder set its control states')
})
