'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const rules = require('../lib/combat-rules')
const { HITBOX_1710, LEGACY_SNEAK_EYE } = require('../lib/bot/legacy-1710')
const { loadBotFunctions } = require('./helpers')

const mcData = require('minecraft-data')('1.21.11')
const version = (legacy) => (legacy ? '1.7.10' : '1.21.11')

// The bot.js inMeleeReach of a body with its feet at feet, in open air.
function reach (feet, legacy, { crouching = false, data = null } = {}) {
  const bot = {
    entity: { position: feet, crouching },
    blockAt: (p) => ({ name: 'air', boundingBox: 'empty', shapes: [], position: p })
  }
  const env = { bot, Vec3, shared: { mcData: data }, LEGACY_1710: legacy, HITBOX_1710, LEGACY_SNEAK_EYE, SWING_REACH: rules.SWING_REACH }
  return loadBotFunctions(['inMeleeReach'], env).inMeleeReach
}

const mob = (name, width, height, x) => ({ id: 7, name, width, height, position: new Vec3(x, 64, 0.5) })

// A slime as the 1.21.11 client holds it: the size-1 box of minecraft-data, its size in metadata, or none.
function slime (size, x) {
  const e = mob('slime', 0.52, 0.52, x)
  if (size !== undefined) e.metadata = Object.assign([], { [mcData.entitiesByName.slime.metadataKeys.indexOf('size')]: size })
  return e
}

test('melee reach takes a hitbox whose near edge sits 2.95 along the look ray and refuses one at 3.05', () => {
  for (const legacy of [false, true]) {
    const inReach = reach(new Vec3(0.5, 64, 0.5), legacy)
    // Aimed at eye height, the ray runs level and meets the box 0.4 short of the zombie's centre.
    assert.strictEqual(inReach(mob('zombie', 0.6, 1.95, 3.85), 1.62), true, `edge at 2.95 on ${version(legacy)}`)
    assert.strictEqual(inReach(mob('zombie', 0.6, 1.95, 3.95), 1.62), false, `edge at 3.05 on ${version(legacy)}`)
  }
})

test('on 1.7.10 melee reach measures a skeleton by its 1.7.10 hitbox', () => {
  // From 3 above, the ray down to 1.2 above the skeleton's feet meets the 1.21.11 box 2.96 out and the top of
  // the 1.7.10 box 3.06 out.
  const skeleton = mob('skeleton', 0.6, 1.99, 2.25)
  assert.strictEqual(reach(new Vec3(0.5, 67, 0.5), false)(skeleton), true, 'control: the 1.21.11 box')
  assert.strictEqual(reach(new Vec3(0.5, 67, 0.5), true)(skeleton), false)
})

test('melee reach scales a slime hitbox by its size', () => {
  for (const legacy of [false, true]) {
    const inReach = reach(new Vec3(0.5, 64, 0.5), legacy, { data: mcData })
    // Centred 3.6 out, a size-4 box (2.08 wide on 1.21.11, 2.4 on 1.7.10) starts within 2.5 and a size-1 box at
    // 3.2 or more.
    assert.strictEqual(inReach(slime(4, 4.1)), true, `size 4 on ${version(legacy)}`)
    assert.strictEqual(inReach(slime(1, 4.1)), false, `control: size 1 on ${version(legacy)}`)
    assert.strictEqual(inReach(slime(undefined, 4.1)), false, `no size metadata on ${version(legacy)}`)
  }
})

test('melee reach looks from the lowered eye of a sneaking body', () => {
  // From 3 above, the ray down to the zombie meets its box 3.05 out from the standing eye at 1.62 and 2.97 out
  // from the 1.7.10 sneaking eye at 1.54, and 3.09 and 2.85 out from 1.62 and 1.27 on 1.21.11.
  for (const [legacy, x] of [[true, 2.225], [false, 2.4]]) {
    const zombie = mob('zombie', 0.6, 1.95, x)
    assert.strictEqual(reach(new Vec3(0.5, 67, 0.5), legacy)(zombie), false, `standing on ${version(legacy)}`)
    assert.strictEqual(reach(new Vec3(0.5, 67, 0.5), legacy, { crouching: true })(zombie), true, `sneaking on ${version(legacy)}`)
  }
})

const frameBox = (en) => loadBotFunctions(['frameBox'], {}).frameBox(en)
// A frame in cell 6,150,-1 with the spawn objectData facing.
const frame = (objectData, position) => ({ id: 20, name: 'item_frame', width: 0.5, height: 0.5, position, objectData })

// Per facing: the box in cell 6,150,-1.
for (const [objectData, facing, lo, hi] of [
  [0, 'down', [6.125, 150.9375, -0.875], [6.875, 151, -0.125]],
  [1, 'up', [6.125, 150, -0.875], [6.875, 150.0625, -0.125]],
  [2, 'north', [6.125, 150.125, -0.0625], [6.875, 150.875, 0]],
  [3, 'south', [6.125, 150.125, -1], [6.875, 150.875, -0.9375]],
  [4, 'west', [6.9375, 150.125, -0.875], [7, 150.875, -0.125]],
  [5, 'east', [6, 150.125, -0.875], [6.0625, 150.875, -0.125]]
]) {
  test(`a frame facing ${facing} spawned at the corner of its cell, as on 1.7.10 and 1.21.11 alike, has its face against the cell side it faces away from`, () => {
    // The box array comes from the vm context.
    assert.deepStrictEqual(Array.from(frameBox(frame(objectData, new Vec3(6, 150, -1))), (v) => v.toArray()), [lo, hi])
  })
}

test('a frame without a spawn facing has no box', () => {
  assert.strictEqual(frameBox(frame(undefined, new Vec3(6, 150, -1))), null)
})

test('on 1.7.10 melee reach measures a frame by its face, not by the corner it spawned at', () => {
  // The live c2 case: 2.8 to a box around the corner, 3.6 to the face.
  assert.strictEqual(reach(new Vec3(7.5, 150, -3.5), true)(frame(2, new Vec3(6, 150, -1))), false, 'the c2 stand')
  assert.strictEqual(reach(new Vec3(6.5, 150, -1.5), true)(frame(2, new Vec3(6, 150, -1))), true, 'control: in front of the face')
  assert.strictEqual(reach(new Vec3(6.5, 150, -1.5), true)(frame(undefined, new Vec3(6, 150, -1))), false, 'no known facing')
})
