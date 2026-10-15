'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { fleeHeading } = require('../lib/flee')
const { loadBotFunctions } = require('./helpers')

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
