'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { runRoute } = require('./helpers')

const AIR = { name: 'air', boundingBox: 'empty' }
const STONE = { name: 'stone', boundingBox: 'block' }
const CHEST = { name: 'chest', boundingBox: 'block' }

// A chest at (-304,63,76) in a stone nook open only to the east, under a block at y 65, on a stone floor at y 62.
function waypointAt (x, y, z, position = new Vec3(-299.5, 63, 76.5)) {
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
    journal () {},
    lastWaypoint: null,
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

test('a waypoint stamped without coordinates stores the cell the bot stands in', () => {
  const { reply, stored } = waypointAt(undefined, undefined, undefined, new Vec3(-300.97, 63.94, 76.96))
  assert.deepStrictEqual(JSON.parse(JSON.stringify(stored)), [{ name: 'base', at: { x: -301, y: 63, z: 76 } }])
  assert.deepStrictEqual([reply.from, reply.at], ['current', { x: -301, y: 63, z: 76 }])
})
