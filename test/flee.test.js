'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { fleeHeading, planFlee, routeWithin } = require('../lib/flee')
const { expireConfirmed } = require('../lib/shelter')
const { loadBotFunctions, combatReflexIn, botConstant } = require('./helpers')

const HERE = new Vec3(0, 64, 0)
const near = (a, b) => Math.abs(a - b) < 1e-9

test('a lone threat sends the flee straight away from it', () => {
  const h = fleeHeading(HERE, new Vec3(5, 64, 0), [])
  assert.ok(near(h.x, -1) && near(h.z, 0), JSON.stringify(h))
})

test('a second mob bends the flee away from both, the nearer one pushing harder', () => {
  const east = new Vec3(5, 64, 0)
  const lone = fleeHeading(HERE, east, [])
  assert.ok(near(lone.z, 0), 'control: straight west')
  const h = fleeHeading(HERE, east, [new Vec3(0, 64, 5)])
  assert.ok(h.x < 0 && h.z < 0 && near(h.x, h.z), `away from east and south equally, got ${JSON.stringify(h)}`)
  const closer = fleeHeading(HERE, east, [new Vec3(0, 64, 2)])
  assert.ok(closer.z < closer.x, `the mob at 2 outweighs the one at 5, got ${JSON.stringify(closer)}`)
  assert.ok(near(Math.hypot(closer.x, closer.z), 1), 'a unit heading')
})

test('a mob straight down the naive flee line turns the flee aside', () => {
  const h = fleeHeading(HERE, new Vec3(4, 64, 0.5), [new Vec3(-4, 64, 0)])
  assert.ok(Math.abs(h.z) > Math.abs(h.x), `the flee runs between them, got ${JSON.stringify(h)}`)
})

test('pushes that cancel out fall back to straight away from the threat', () => {
  const h = fleeHeading(HERE, new Vec3(3, 64, 0), [new Vec3(-3, 64, 0)])
  assert.ok(near(h.x, -1) && near(h.z, 0), JSON.stringify(h))
})

test('a hostile the body does not perceive never enters the flee', () => {
  const mob = (id, x, seen) => ({ id, name: 'zombie', cls: 'hostile', seen, position: new Vec3(x, 64, 0) })
  const entities = { 1: mob(1, 5, true), 2: mob(2, -5, false), 3: mob(3, 3, true) }
  const env = {
    bot: { entity: { position: HERE }, entities },
    mobClass: (e) => e.cls,
    AGGRO_CONFIRMED: new Map(),
    staleEntities: new Set(),
    entityPerceptible: (e) => e.seen,
    entityEngageable: () => true
  }
  const { nearHostiles } = loadBotFunctions(['nearHostiles'], env)
  assert.deepStrictEqual([...nearHostiles({}, 16)].map((e) => e.id), [1, 3])
  env.AGGRO_CONFIRMED.set(2, { t: Date.now() })
  assert.deepStrictEqual([...nearHostiles({}, 16)].map((e) => e.id), [1, 2, 3], 'a mob that hit the body counts unseen')
  assert.deepStrictEqual([...nearHostiles({}, 4)].map((e) => e.id), [3], 'only the mob within the radius')
  env.staleEntities.add(1)
  assert.deepStrictEqual([...nearHostiles({}, 16)].map((e) => e.id), [2, 3], 'a mob left over from the dimension before')
})

const ck = (x, y, z) => x + ',' + y + ',' + z
const inArea = (x, z) => Math.abs(x) <= 40 && Math.abs(z) <= 40
// Ground at y 63 over the area, bedrock under y 40. lava and unknown pick cells out.
const plateau = (over = {}) => ({ solid: (x, y, z) => y < 40 || (inArea(x, z) && y < 64), lava: () => false, unknown: () => false, ...over })

function blockAt (w) {
  return (p) => {
    const lava = w.lava(p.x, p.y, p.z)
    const solid = !lava && w.solid(p.x, p.y, p.z)
    return { name: lava ? 'lava' : solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: p }
  }
}

function fleeIn (w, threat, ally = null) {
  const logs = []
  const events = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: blockAt(w),
    pathfinder: { goal: null, setGoal (g) { this.goal = g } },
    setControlState () {}
  }
  const env = {
    bot,
    Vec3,
    goals,
    ck,
    planFlee,
    fleeHeading,
    console: { log: (line) => logs.push(line) },
    setTimeout () {},
    cellKnown: (p) => !w.unknown(p.x, p.y, p.z),
    reflexes: [{ name: 'flee_to_player', on: true, ally: () => ally }],
    nearHostiles: () => [],
    airFlood: () => ({}),
    knownCell: () => true,
    mobClass: () => 'creeper',
    laneBlocks: () => false,
    laneNarrate () {},
    takeLegs () {},
    stopPath () {},
    compass: () => 'W',
    emitEvent: (kind) => events.push(kind)
  }
  loadBotFunctions(['fleeWorld', 'fleeLog'], env)
  const held = combatReflexIn(env).fleeFrom(bot, threat, null, 'emergency')
  const g = bot.pathfinder.goal
  return { held, goal: g && { x: Math.floor(g.x), y: Math.floor(g.y), z: Math.floor(g.z) }, logs, events }
}

const creeper = (x, y, z) => ({ id: 9, name: 'creeper', position: new Vec3(x, y, z) })

function assertSafe (w, g) {
  assert.ok(g, 'no flee goal')
  assert.ok(w.solid(g.x, g.y - 1, g.z) && !w.solid(g.x, g.y, g.z) && !w.solid(g.x, g.y + 1, g.z), `no floor at ${JSON.stringify(g)}`)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = g.x + dx
    const z = g.z + dz
    assert.ok(!w.unknown(x, g.y, z), `an unknown cell beside ${JSON.stringify(g)}`)
    const floored = [0, 1, 2, 3, 4].some((d) => w.solid(x, g.y - d, z))
    assert.ok(floored, `a drop over 3 beside ${JSON.stringify(g)}`)
  }
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) {
    assert.ok(!w.lava(g.x + dx, g.y + dy, g.z + dz), `lava within 2 of ${JSON.stringify(g)}`)
  }
}

test('a flee runs to a safe cell, never into a ravine, beside a drop, near lava or beside unknown cells', () => {
  // A ravine 24 deep over x -30 to -6, lava at x -5 to -1 and z -16 to -12, everything beyond z 9 unseen.
  const w = plateau({
    solid: (x, y, z) => y < 40 || (inArea(x, z) && y < 64 && !(x >= -30 && x <= -6)),
    lava: (x, y, z) => y === 63 && x >= -5 && x <= -1 && z >= -16 && z <= -12,
    unknown: (x, y, z) => z > 9
  })
  const r = fleeIn(w, creeper(5.5, 64, 0.5))
  assert.strictEqual(r.held, undefined)
  assertSafe(w, r.goal)
  const d = Math.hypot(r.goal.x - 0, r.goal.z - 0)
  assert.ok(d >= 8 && r.goal.x < 0, `the goal ${JSON.stringify(r.goal)} lies 8 or more away from the creeper side`)
  assert.strictEqual(r.logs.filter((l) => l.startsWith('[flee]')).length, 1, 'one [flee] line')
})

test('with no safe cell in reach the body holds its ground', () => {
  // A one-block pinnacle 24 above the ground.
  const w = plateau({ solid: (x, y, z) => y < 40 || (x === 0 && z === 0 && y < 64) })
  const r = fleeIn(w, creeper(3.5, 64, 0.5))
  assert.strictEqual(r.held, 'held')
  assert.strictEqual(r.goal, null, 'a goal off the pinnacle')
  assert.ok(r.logs.some((l) => l.startsWith('[flee]')), 'no [flee] line')
})

test('a flee runs to a player only along a route that passes no lava', () => {
  const ally = { username: 'Steve', position: new Vec3(-10.5, 64, 0.5) }
  const open = plateau()
  const toPlayer = fleeIn(open, creeper(5.5, 64, 0.5), ally)
  assert.ok(toPlayer.goal && Math.hypot(toPlayer.goal.x + 10, toPlayer.goal.z) <= 2, `control: the goal ${JSON.stringify(toPlayer.goal)} beside the player`)
  assert.deepStrictEqual(toPlayer.events, ['flee_to_player'])
  const trench = plateau({ lava: (x, y, z) => x === -5 && y === 63 })
  const r = fleeIn(trench, creeper(5.5, 64, 0.5), ally)
  assertSafe(trench, r.goal)
  assert.ok(r.goal.x > -5, `the goal ${JSON.stringify(r.goal)} lies past the lava`)
  assert.deepStrictEqual(r.events, [])
})

function creeperCheck (w, at) {
  const e = creeper(at.x, at.y, at.z)
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, entities: { 9: e }, blockAt: blockAt(w) }
  const env = {
    bot,
    Vec3,
    ck,
    routeWithin,
    expireConfirmed,
    console: { log () {} },
    cellKnown: () => true,
    CREEPER_DROP: botConstant('CREEPER_DROP'),
    CONFIRMED_HORIZON: botConstant('CONFIRMED_HORIZON'),
    CONFIRMED_MS: botConstant('CONFIRMED_MS'),
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    stance: 'guard',
    threatDebugUntil: 0,
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false },
    liveEntities: () => [e],
    mobClass: () => 'creeper',
    airFlood: () => ({}),
    entityPerceptible: () => true,
    knownCell: () => true,
    entityEngageable: () => true,
    emitEvent () {}
  }
  loadBotFunctions(['creeperRoute'], env)
  const combat = combatReflexIn(env)
  const d = e.position.distanceTo(bot.entity.position)
  // Three samples of closing already taken.
  combat._hist.set(9, { d: d + 2, t: Date.now() - 1000, closes: 3, logT: Date.now() })
  return combat.check(bot)
}

test('a creeper below a cliff with no walk up is watched, one within 8 or with a walk up is fled', () => {
  // The cliff top stands at y 64 for x up to 2, the ground below it at y 59.
  const cliff = (x, y, z) => y < 40 || (inArea(x, z) && y < (x <= 2 ? 64 : 59))
  const below = new Vec3(7.5, 59, 0.5)
  assert.strictEqual(creeperCheck(plateau({ solid: cliff }), below), false, 'the creeper 8.6 below the cliff')
  assert.strictEqual(creeperCheck(plateau({ solid: cliff }), new Vec3(3.5, 59, 0.5)), true, 'the creeper 5.8 below the cliff')
  // A ramp at z 2 climbs from the ground at x 7 to the top at x 3.
  const ramp = (x, y, z) => cliff(x, y, z) || (z === 2 && x >= 3 && x <= 7 && y < 64 - (x - 3))
  assert.strictEqual(creeperCheck(plateau({ solid: ramp }), below), true, 'the creeper with the ramp')
})
