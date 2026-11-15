'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { Physics, PlayerState } = require('prismarine-physics')
const registry = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')(registry)

// A body resting on a face overlaps it by the rounding of its position.
const TOLERANCE = 1e-7
// A body stopped by a face ends within this of it.
const FLUSH = 1e-12
const NORTH_WEST = Math.PI / 4

const world = (cells, floorY = 149) => ({
  getBlock (p) {
    const c = p.floored()
    const [name, props] = cells[`${c.x},${c.y},${c.z}`] || [c.y <= floorY ? 'stone' : 'air', {}]
    const b = Block.fromProperties(name, props, 0)
    b.position = c
    return b
  }
})

const column = (x, z) => ({ [`${x},150,${z}`]: ['stone', {}], [`${x},151,${z}`]: ['stone', {}] })

// A point given across a wall (a) and along it (b), for a wall facing x or one facing z.
const at = (facingZ, a, y, b) => facingZ ? new Vec3(b, y, a) : new Vec3(a, y, b)
const cellKey = (p) => `${p.x},${p.y},${p.z}`

function run (w, pos, yaw, { sprint = false, forward = true, jump = false, velocity = new Vec3(0, 0, 0), ticks = 20 } = {}) {
  const physics = Physics(registry, w)
  const controls = { forward, back: false, left: false, right: false, jump, sprint, sneak: false }
  const bot = {
    version: registry.version.minecraftVersion,
    entity: { position: pos.clone(), velocity, onGround: velocity.y === 0, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw, pitch: 0, effects: {}, attributes: {} },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    inventory: { slots: [] }
  }
  const trail = []
  for (let i = 0; i < ticks; i++) {
    physics.simulatePlayer(new PlayerState(bot, controls), w).apply(bot)
    trail.push(bot.entity.position.clone())
  }
  return trail
}

// How far the body got into any block in cells over the whole trail, negative for the gap it kept.
function deepest (w, cells, trail) {
  let depth = -Infinity
  for (const key of Object.keys(cells)) {
    const block = w.getBlock(new Vec3(...key.split(',').map(Number)))
    for (const [x0, y0, z0, x1, y1, z1] of block.shapes) {
      const c = block.position
      for (const p of trail) {
        const into = Math.min(
          Math.min(p.x + 0.3, c.x + x1) - Math.max(p.x - 0.3, c.x + x0),
          Math.min(p.y + 1.8, c.y + y1) - Math.max(p.y, c.y + y0),
          Math.min(p.z + 0.3, c.z + z1) - Math.max(p.z - 0.3, c.z + z0)
        )
        depth = Math.max(depth, into)
      }
    }
  }
  return depth
}

function intoColumn (x, z, pos, yaw) {
  const cells = column(x, z)
  const w = world(cells)
  for (const sprint of [false, true]) {
    const depth = deepest(w, cells, run(w, pos, yaw, { sprint }))
    assert.ok(depth <= TOLERANCE, `${sprint ? 'sprinting' : 'walking'}: ${depth} inside the column`)
    assert.ok(depth >= -FLUSH, `${sprint ? 'sprinting' : 'walking'}: stopped ${-depth} short of the column`)
  }
}

test('a body heading north-west along the east face of a column at x 31 never enters it', () => {
  intoColumn(31, -64, new Vec3(32.5, 150, -63.2), NORTH_WEST)
})

test('a body heading north-west along the east face of a column at x 1 never enters it', () => {
  intoColumn(1, -94, new Vec3(2.5, 150, -93.2), NORTH_WEST)
})

test('a body heading north-east along the west face of a column at x -32 never enters it', () => {
  intoColumn(-32, -64, new Vec3(-32.5, 150, -63.2), -NORTH_WEST)
})

test('a body heading north-west along the south face of a column at z 31 never enters it', () => {
  intoColumn(5, 31, new Vec3(5.8, 150, 32.5), NORTH_WEST)
})

test('a body heading south-west along the north face of a column at z -32 never enters it', () => {
  intoColumn(5, -32, new Vec3(5.8, 150, -32.5), Math.PI - NORTH_WEST)
})

test('control: a body heading north-west along the east face of a column at x -29 never enters it', () => {
  intoColumn(-29, -64, new Vec3(-27.5, 150, -63.2), NORTH_WEST)
})

test('control: a body heading north-west along the east face of a column at x 41 never enters it', () => {
  intoColumn(41, -64, new Vec3(42.5, 150, -63.2), NORTH_WEST)
})

// A body heading north-west along a 2-high wall from -64 to -66 along it.
function slide (wall, facingZ, sprint) {
  const cells = {}
  for (const b of [-64, -65, -66]) for (const y of [150, 151]) cells[cellKey(at(facingZ, wall, y, b))] = ['stone', {}]
  const w = world(cells)
  const trail = run(w, at(facingZ, wall + 1.5, 150, -63.2), NORTH_WEST, { sprint, ticks: 40 })
  const end = trail.at(-1)
  return { depth: deepest(w, cells, trail), along: facingZ ? end.x : end.z }
}

for (const facingZ of [false, true]) {
  const axis = facingZ ? 'z' : 'x'
  test(`a body sliding along a 3-block wall at ${axis} 31 crosses its seams as it does along the same wall at ${axis} 41`, () => {
    for (const sprint of [false, true]) {
      const at31 = slide(31, facingZ, sprint)
      const at41 = slide(41, facingZ, sprint)
      const say = `${sprint ? 'sprinting' : 'walking'}: at ${axis} 31 ${JSON.stringify(at31)}, at ${axis} 41 ${JSON.stringify(at41)}`
      assert.ok(at31.depth <= TOLERANCE, say)
      assert.ok(Math.abs(at31.along - at41.along) < 1e-6, say)
      assert.ok(at31.along < -66.3, say)
    }
  })
}

// A body heading north-west beside a wall from y 141 to 151 walks off a floor at y 149 that ends at -64.
function ledge (wall, facingZ, sprint) {
  const cells = {}
  for (let b = -72; b <= -60; b++) {
    for (let y = 141; y <= 151; y++) cells[cellKey(at(facingZ, wall, y, b))] = ['stone', {}]
    if (b >= -64) for (let a = wall + 1; a <= wall + 3; a++) cells[cellKey(at(facingZ, a, 149, b))] = ['stone', {}]
  }
  const w = world(cells, 140)
  const end = run(w, at(facingZ, wall + 1.5, 150, -63.2), NORTH_WEST, { sprint, ticks: 60 }).at(-1)
  return { y: end.y, along: facingZ ? end.x : end.z }
}

for (const facingZ of [false, true]) {
  const axis = facingZ ? 'z' : 'x'
  test(`a body walking off a ledge along a wall at ${axis} 31 falls as it does along the same wall at ${axis} 41`, () => {
    for (const sprint of [false, true]) {
      const at31 = ledge(31, facingZ, sprint)
      const at41 = ledge(41, facingZ, sprint)
      const say = `${sprint ? 'sprinting' : 'walking'}: at ${axis} 31 ${JSON.stringify(at31)}, at ${axis} 41 ${JSON.stringify(at41)}`
      assert.ok(at31.y === 141 && at41.y === 141, say)
      assert.ok(Math.abs(at31.along - at41.along) < 1e-6, say)
    }
  })
}

test('control: a body walking west onto a bottom slab at x 31 steps up and never enters it', () => {
  const slab = ['stone_slab', { type: 'bottom', waterlogged: false }]
  const cells = Object.fromEntries([-66, -65, -64, -63, -62].map((z) => [`31,150,${z}`, slab]))
  const w = world(cells)
  for (const yaw of [Math.PI / 2, NORTH_WEST]) {
    for (const sprint of [false, true]) {
      const trail = run(w, new Vec3(32.5, 150, -63.5), yaw, { sprint })
      const say = `yaw ${yaw.toFixed(2)}, ${sprint ? 'sprinting' : 'walking'}`
      assert.ok(deepest(w, cells, trail) <= TOLERANCE, say)
      assert.ok(trail.some((p) => p.y === 150.5), `${say}: never on the slab`)
      assert.ok(trail.at(-1).x < 30.7, `${say}: stopped at ${trail.at(-1)}`)
    }
  }
})

test('a body walking through a doorway along its jamb at x 31 never enters the jamb', () => {
  const cells = {}
  for (let x = 28; x <= 36; x++) {
    cells[`${x},152,-64`] = ['stone', {}]
    if (x !== 32) Object.assign(cells, column(x, -64))
  }
  const w = world(cells)
  for (const sprint of [false, true]) {
    const trail = run(w, new Vec3(32.5, 150, -63.2), Math.PI / 6, { sprint, ticks: 25 })
    const say = `${sprint ? 'sprinting' : 'walking'}, ends at ${trail.at(-1)}`
    assert.ok(deepest(w, cells, trail) <= TOLERANCE, say)
    assert.ok(trail.at(-1).z < -64.3, say)
  }
})

const ladderUnderCeiling = () => {
  const cells = { '0,15,0': ['ladder', {}], '0,16,0': ['ladder', {}], '0,17,0': ['ladder', {}] }
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) cells[`${x},18,${z}`] = ['stone', {}]
  return world(cells, 14)
}

test('a body climbing a ladder from y 15.85 keeps its head out of a ceiling at y 18', () => {
  const trail = run(ladderUnderCeiling(), new Vec3(0.5, 15.85, 0.5), 0, { forward: false, jump: true, velocity: new Vec3(0, 0.42, 0) })
  const head = Math.max(...trail.map((p) => p.y + 1.8))
  assert.ok(head <= 18 + TOLERANCE, `head at ${head}`)
  assert.ok(head >= 18 - FLUSH, `head at ${head}`)
})

test('a body climbing a ladder from y 15.85 into a ceiling at y 18 walks off under it west and north', () => {
  for (const yaw of [Math.PI / 2, 0]) {
    const trail = run(ladderUnderCeiling(), new Vec3(0.5, 15.85, 0.5), yaw, { jump: true, velocity: new Vec3(0, 0.42, 0) })
    const end = trail.at(-1)
    assert.ok((yaw ? end.x : end.z) < 0, `yaw ${yaw.toFixed(2)}: ends at ${end}`)
  }
})

test('a body overlapping a column sideways by 1e-6 stops at the column\'s face', () => {
  const cells = column(41, -64)
  const w = world(cells)
  const trail = run(w, new Vec3(42.5, 150, -62.7 - 1e-6), Math.PI / 2)
  assert.ok(trail.at(-1).x >= 42.3 - TOLERANCE, `ends at ${trail.at(-1)}`)
})

test('a body overlapping the edge of a block by 1e-6 stands on it', () => {
  const w = world({ '41,149,-64': ['stone', {}] }, 140)
  const trail = run(w, new Vec3(42.3 - 1e-6, 150, -63.5), 0, { forward: false })
  assert.ok(trail.every((p) => p.y === 150), `ends at ${trail.at(-1)}`)
})
