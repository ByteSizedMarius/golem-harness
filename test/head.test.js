'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { headFree } = require('../lib/head')
const { combatReflexIn } = require('./helpers')

// The look calls of each act cycle against a zombie standing 12 blocks off, the stare distance of the guard stance.
async function stareCycles (moving) {
  const zombie = { id: 7, name: 'zombie', position: new Vec3(12.5, 64, 0.5) }
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 7: zombie },
    health: 20,
    food: 20,
    inventory: { items: () => [], slots: [] },
    heldItem: null,
    pathfinder: { isMoving: () => moving },
    lookAt: async () => { looks[looks.length - 1]++ }
  }
  const looks = [0]
  const env = {
    bot,
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    stance: 'guard',
    LEGACY_1710: false,
    guardState: { up: false, slot: -1, pilot: false },
    lastHit: { dmg: 0, t: 0 },
    lastAttackT: 0,
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false },
    mcData: null,
    goals,
    headFree,
    compass: () => 'E',
    emitEvent () {},
    mobClass: () => 'hostile',
    entityPerceptible: () => true,
    entityEngageable: () => true,
    airFlood: () => ({ cells: new Set() }),
    losClear: () => true,
    nearHostiles: () => [],
    meleeReach: () => 3.2,
    yieldJob () {},
    drawAndLoose: async () => false,
    laneBlocks: () => false,
    laneNarrate () {},
    // Each 250 ms wait ends a cycle. The zombie leaves after three.
    setTimeout: (fn) => {
      if (looks.length === 3) delete bot.entities[7]
      else looks.push(0)
      setImmediate(fn)
    }
  }
  const combat = combatReflexIn(env)
  combat._threat = { e: zombie, cls: 'hostile', dist: 12, confirmed: false }
  await combat.act(bot)
  return looks
}

test('the head is free only while the pathfinder walks no path', () => {
  assert.strictEqual(headFree({ pathfinder: { isMoving: () => false } }), true)
  assert.strictEqual(headFree({ pathfinder: { isMoving: () => true } }), false)
})

test('the combat stare at a standoff mob turns the head only while the body is not walking', async () => {
  assert.deepStrictEqual(await stareCycles(false), [1, 1, 1], 'control: standing still')
  assert.deepStrictEqual(await stareCycles(true), [0, 0, 0])
})
