'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Physics } = require('prismarine-physics')

const WALL_ARM = ['cobblestone_wall', { up: 'false', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }]
const WALL_POST = ['cobblestone_wall', { up: 'true', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }]
const door = (half) => ['oak_door', { facing: 'east', half, hinge: 'left', open: 'false', powered: 'false' }]

// A body at pos under the real pathfinder, on a stone floor at y 63 with the blocks in cells ('x,y,z' -> [name, properties]).
async function body (pos, cells) {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.write = () => {}
  client.end = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  bot.loadPlugin(pathfinder)
  await once(bot, 'inject_allowed')
  const Block = require('prismarine-block')(bot.registry)
  Object.assign(bot, {
    entity: { position: pos, velocity: new Vec3(0, 0, 0), width: 0.6, height: 1.8, onGround: true },
    entities: {},
    game: { minY: -64 },
    inventory: { items: () => [] },
    clearControlStates () {},
    blockAt (p) {
      const c = p.floored()
      const [name, props] = cells[`${c.x},${c.y},${c.z}`] || [c.y <= 63 ? 'stone' : 'air', {}]
      const b = Block.fromProperties(name, props, 0)
      b.position = c
      return b
    }
  })
  const moves = new Movements(bot)
  bot.registry.blocksArray.forEach((b) => { if (b.name.endsWith('_door') && !b.name.includes('iron')) moves.openable.add(b.id) })
  moves.canOpenDoors = true
  moves.canDig = false
  const plan = (goal) => bot.pathfinder.getPathFromTo(moves, bot.entity.position, goal).next().value.result
  return { bot, plan, moves }
}

function wallLine (x, at) {
  const cells = {}
  for (let z = -2; z <= 2; z++) cells[`${x},64,${z}`] = at(z)
  return cells
}

test('a path through a door aims at the centre of the door cell and of every cell after it', async () => {
  const cells = {}
  for (let z = -2; z <= 2; z++) {
    cells[`2,64,${z}`] = z === 0 ? door('lower') : ['stone', {}]
    cells[`2,65,${z}`] = z === 0 ? door('upper') : ['stone', {}]
  }
  const { plan } = await body(new Vec3(0.5, 64, 0.5), cells)
  const result = plan(new goals.GoalBlock(5, 64, 0))
  assert.strictEqual(result.status, 'success')
  const at = result.path.findIndex((n) => n.toPlace.length > 0)
  assert.deepStrictEqual(result.path.slice(at).map((n) => [n.x, n.y, n.z]), [[2.5, 64, 0.5], [3.5, 64, 0.5], [4.5, 64, 0.5], [5.5, 64, 0.5]])
})

test('a body flush against a wall plans from the free cell it stands in, not from inside the wall', async () => {
  for (const [label, middle] of [['against an arm', WALL_ARM], ['into a post', WALL_POST]]) {
    const { plan } = await body(new Vec3(0.0125, 64, 0.5), wallLine(0, (z) => (z === 0 ? middle : WALL_ARM)))
    const result = plan(new goals.GoalBlock(2, 64, 0))
    assert.strictEqual(result.status, 'success', label)
    assert.ok(Math.floor(result.path[0].x) < 0, `${label}: the first step stays west of the wall`)
    assert.ok(result.path.some((n) => Math.abs(Math.floor(n.z)) > 2), `${label}: the path rounds the wall's end`)
  }
})

test('a stop beside a wall leaves the body flush instead of centring it into the wall', async () => {
  const { bot } = await body(new Vec3(0.0125, 64, 0.5), wallLine(0, () => WALL_ARM))
  bot.pathfinder.setGoal(new goals.GoalBlock(0, 64, 0))
  bot.emit('physicsTick')
  assert.strictEqual(bot.pathfinder.goal, null, 'control: the goal was reached and the body stopped')
  assert.deepStrictEqual([bot.entity.position.x, bot.entity.position.z], [0.0125, 0.5])
})

// The real pathfinder's first-tick control states from x 0 towards x 6.
async function firstTick (cells) {
  const { bot, moves } = await body(new Vec3(0.5, 64, 0.5), cells)
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  Object.assign(bot.entity, { yaw: 0, pitch: 0, effects: {}, attributes: {} })
  Object.assign(bot, {
    physics: Physics(bot.registry, { getBlock: (p) => bot.blockAt(p) }),
    jumpTicks: 0,
    jumpQueued: false,
    controlState: controls,
    setControlState (k, v) { controls[k] = v },
    look: async () => {},
    inventory: { items: () => [], slots: [] }
  })
  bot.pathfinder.setMovements(moves)
  bot.pathfinder.setGoal(new goals.GoalBlock(6, 64, 0))
  bot.emit('physicsTick')
  return controls
}

// A trench at x 1 and 2, then floor at x 3 to 6.
function trench (floor) {
  const cells = {}
  for (let z = -8; z <= 8; z++) {
    for (let y = 50; y <= 63; y++) cells[`1,${y},${z}`] = cells[`2,${y},${z}`] = ['air', {}]
    for (let x = 3; x <= 6; x++) cells[`${x},63,${z}`] = floor
  }
  return cells
}

// A one-block step up at x 1, then floor at x 2 to 6.
function step (floor) {
  const cells = {}
  for (let z = -8; z <= 8; z++) {
    cells[`1,64,${z}`] = ['stone', {}]
    for (let x = 2; x <= 6; x++) cells[`${x},63,${z}`] = floor
  }
  return cells
}

test('the pathfinder sprint jumps a gap that lands on a field', async () => {
  const stone = await firstTick(trench(['stone', {}]))
  assert.deepStrictEqual([stone.forward, stone.sprint, stone.jump], [true, true, true], 'control: a sprint jump onto stone')
  const field = await firstTick(trench(['farmland', { moisture: 7 }]))
  assert.deepStrictEqual([field.forward, field.sprint, field.jump], [true, true, true])
})

test('the pathfinder sprint jumps a step up beside a field', async () => {
  const stone = await firstTick(step(['stone', {}]))
  assert.deepStrictEqual([stone.forward, stone.sprint, stone.jump], [true, true, true], 'control: a sprint jump up beside stone')
  const field = await firstTick(step(['farmland', { moisture: 7 }]))
  assert.deepStrictEqual([field.forward, field.sprint, field.jump], [true, true, true])
})
