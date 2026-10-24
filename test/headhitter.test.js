'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { Physics, PlayerState } = require('prismarine-physics')
const registry = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')(registry)
const { noJumpReason } = require('../lib/sprint')

const TICKS = 100
const STONE = Block.fromStateId(registry.blocksByName.stone.defaultState, 0)
const AIR = Block.fromStateId(registry.blocksByName.air.defaultState, 0)

// Flat stone up to y 63 with a stone ceiling at y 66 from x ceilingFrom on.
const world = (ceilingFrom) => ({
  getBlock (p) {
    const c = p.floored()
    const b = Object.create(c.y <= 63 || (c.y === 66 && c.x >= ceilingFrom) ? STONE : AIR)
    b.position = c
    return b
  }
})

// The distance a body sprinting east for TICKS ticks covers and the ticks it hits a block's side, jump(entity, world) setting the jump each tick.
function sprintEast (w, jump) {
  const physics = Physics(registry, w)
  const controls = { forward: true, back: false, left: false, right: false, jump: false, sprint: true, sneak: false }
  const bot = {
    version: registry.version.minecraftVersion,
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    inventory: { slots: [] }
  }
  let bumps = 0
  for (let i = 0; i < TICKS; i++) {
    controls.jump = jump(bot.entity, w)
    physics.simulatePlayer(new PlayerState(bot, controls), w).apply(bot)
    if (bot.entity.isCollidedHorizontally) bumps++
  }
  return { distance: bot.entity.position.x - 0.5, bumps }
}

// noJumpReason over a path of the next six cells east.
function ruled (e, w) {
  const x = Math.floor(e.position.x)
  const path = Array.from({ length: 6 }, (_, i) => ({ x: x + i + 1.5, y: 64, z: 0.5, toBreak: [], toPlace: [] }))
  return noJumpReason({ path, pos: e.position, onGround: e.onGround, blockAt: (p) => w.getBlock(p), inWater: false, food: 20, fighting: false }) === null
}

test('sprint jumps under a two-high ceiling cover more ground than a sprint walk', () => {
  const walk = sprintEast(world(-Infinity), () => false)
  const tunnel = sprintEast(world(-Infinity), ruled)
  const say = `walk ${walk.distance.toFixed(2)}, jumps ${tunnel.distance.toFixed(2)}`
  assert.ok(tunnel.distance > walk.distance, say)
  assert.strictEqual(tunnel.bumps, 0, say)
})

test('a run from open sky into a tunnel never hops into the ceiling\'s side', () => {
  const walk = sprintEast(world(8), () => false)
  const run = sprintEast(world(8), ruled)
  const held = sprintEast(world(8), (e) => e.onGround)
  assert.strictEqual(run.bumps, 0, `distance ${run.distance.toFixed(2)}`)
  assert.ok(run.distance > walk.distance, `walk ${walk.distance.toFixed(2)}, run ${run.distance.toFixed(2)}`)
  assert.ok(held.bumps > 0, 'control: a jump held on every landing hits the ceiling\'s side')
})
