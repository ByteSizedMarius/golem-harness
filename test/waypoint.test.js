'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { resolveTarget, arrivedAt } = require('../lib/walk')
const { runRoute, awaitRoute } = require('./helpers')

const AIR = { name: 'air', boundingBox: 'empty', shapes: [] }
const STONE = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
const CHEST = { name: 'chest', boundingBox: 'block' }

// A chest at (-304,63,76) in a stone nook open only to the east, under a block at y 65, on a stone floor at y 62.
function waypointAt (x, y, z, position = new Vec3(-299.5, 63, 76.5), seenNow = () => true) {
  const solid = new Set(['-305,63,76', '-304,63,75', '-304,63,77', '-304,65,76'])
  const blockAt = (p) => {
    const k = `${p.x},${p.y},${p.z}`
    if (k === '-304,63,76') return CHEST
    return p.y <= 62 || solid.has(k) ? STONE : AIR
  }
  const stored = []
  const env = {
    bot: { entity: { position }, blockAt },
    Vec3,
    cellKnown: () => true,
    seenNow,
    journal () {},
    memory: { lastWaypoint: null },
    waypoints: { get: () => undefined, set: (name, at) => { stored.push({ name, at }); return at }, link () {} }
  }
  const at = x === undefined ? {} : { x: String(x), y: String(y), z: String(z) }
  const reply = runRoute('/waypoint', { name: 'base', ...at }, env)
  return { reply, stored }
}

test('a waypoint set on a chest moves to the cell beside it to stand in', () => {
  const kept = waypointAt(-302.5, 63, 76.5)
  assert.deepStrictEqual(kept.reply.at, { x: -302.5, y: 63, z: 76.5 }, 'control: a cell to stand in stays as given')
  assert.strictEqual(kept.reply.moved, undefined)
  const { reply, stored } = waypointAt(-304, 63, 76)
  assert.deepStrictEqual(reply.at, { x: -303, y: 63, z: 76 })
  assert.deepStrictEqual(JSON.parse(JSON.stringify(stored)), [{ name: 'base', at: { x: -303, y: 63, z: 76 } }])
  assert.match(reply.moved, /chest/)
})

test('a waypoint on a chest seen before and out of sight now stays as given and names no block', () => {
  assert.match(waypointAt(-304, 63, 76).reply.moved, /chest/, 'control: in sight')
  const { reply, stored } = waypointAt(-304, 63, 76, undefined, () => false)
  assert.doesNotMatch(JSON.stringify(reply), /chest|stone/)
  assert.strictEqual(reply.moved, undefined)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(stored)), [{ name: 'base', at: { x: -304, y: 63, z: 76 } }])
})

test('a waypoint stamped without coordinates stores the cell the bot stands in', () => {
  const { reply, stored } = waypointAt(undefined, undefined, undefined, new Vec3(-300.97, 63.94, 76.96))
  assert.deepStrictEqual(JSON.parse(JSON.stringify(stored)), [{ name: 'base', at: { x: -301, y: 63, z: 76 } }])
  assert.deepStrictEqual([reply.from, reply.at], ['current', { x: -301, y: 63, z: 76 }])
})

test('a goto to coordinates forgets the last waypoint, so the next waypoint reached links no edge to it', async () => {
  const links = []
  const memory = { lastWaypoint: 'home' }
  const env = {
    bot: { entity: { position: new Vec3(3.5, 64, 2.5) } },
    shared: { ready: true },
    bunker: { building: false },
    claimLane: () => ({}),
    releaseLane () {},
    walkRoute: () => ({ end () {}, walked: () => 0, mark: 0 }),
    stagedGoto: async () => ({ arrived: true, reason: null }),
    doorBeside: () => null,
    journal () {},
    memory,
    waypoints: { link: (a, b) => { links.push([a, b]) } }
  }
  await awaitRoute('/goto', { x: '9', z: '9', preview: '1' }, env)
  assert.strictEqual(memory.lastWaypoint, 'home', 'control: a preview walks nothing')
  await awaitRoute('/goto', { x: '9', z: '9' }, env)
  await awaitRoute('/goto', { waypoint: 'mine' }, env)
  assert.deepStrictEqual([links, memory.lastWaypoint], [[], 'mine'])
})

test('a waypoint goto links the edge from the last waypoint only when the walk begins there', async () => {
  const links = []
  const memory = { lastWaypoint: 'home' }
  const spots = { home: new Vec3(0, 64, 0), mine: new Vec3(20, 64, 0) }
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: (p) => (p.y <= 63 ? STONE : AIR) }
  let gaveUpAt = null
  const env = {
    bot,
    shared: { ready: true },
    bunker: { building: false },
    claimLane: () => ({}),
    releaseLane () {},
    walkRoute: () => ({ end () {}, walked: () => 0, mark: 0 }),
    resolveTarget,
    arrivedAt,
    walkSources: () => ({ blockAt: bot.blockAt, column: { minY: 60, maxY: 70 }, waypoint: (name) => spots[name], cellKnown: () => true }),
    stagedGoto: async (q) => {
      if (gaveUpAt) {
        bot.entity.position = gaveUpAt
        return { arrived: false, reason: 'stalled' }
      }
      bot.entity.position = spots[q.waypoint].offset(0.5, 0, 0.5)
      return { arrived: true, reason: null }
    },
    doorBeside: () => null,
    journal () {},
    memory,
    waypoints: { link: (a, b) => { links.push([a, b]) } }
  }
  await awaitRoute('/goto', { waypoint: 'mine' }, env)
  assert.deepStrictEqual(links, [['home', 'mine']], 'control: a walk from home to mine')
  // A follow or a flee carries the body away from mine.
  bot.entity.position = new Vec3(12.5, 64, 7.5)
  await awaitRoute('/goto', { waypoint: 'home' }, env)
  gaveUpAt = new Vec3(9.5, 64, 0.5)
  await awaitRoute('/goto', { waypoint: 'mine' }, env)
  assert.strictEqual(memory.lastWaypoint, 'home', 'control: a walk from home that gave up')
  gaveUpAt = null
  await awaitRoute('/goto', { waypoint: 'mine' }, env)
  assert.deepStrictEqual([links, memory.lastWaypoint], [[['home', 'mine']], 'mine'])
})

test('a waypoint stamped where the bot stands links the last waypoint only while the bot stands on it', () => {
  const links = []
  const memory = { lastWaypoint: 'home' }
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: (p) => (p.y <= 63 ? STONE : AIR) }
  const env = {
    bot,
    resolveTarget,
    arrivedAt,
    walkSources: () => ({ blockAt: bot.blockAt, column: { minY: 60, maxY: 70 }, waypoint: (name) => (name === 'home' ? new Vec3(0, 64, 0) : undefined), cellKnown: () => true }),
    journal () {},
    memory,
    waypoints: { get: () => undefined, set: (name, at) => at, link: (a, b) => { links.push([a, b]) } }
  }
  runRoute('/waypoint', { name: 'porch' }, env)
  assert.deepStrictEqual(links, [['home', 'porch']], 'control: stamped on home')
  memory.lastWaypoint = 'home'
  // A follow or a flee carries the body away from home.
  bot.entity.position = new Vec3(12.5, 64, 7.5)
  runRoute('/waypoint', { name: 'camp' }, env)
  assert.deepStrictEqual([links, memory.lastWaypoint], [[['home', 'porch']], 'camp'])
})
