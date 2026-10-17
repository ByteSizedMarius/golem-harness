'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { POINT_RANGE, deictic, lookedAt } = require('../lib/deixis')
const { playerNamed } = require('../lib/players')
const { loadBotFunctions } = require('./helpers')

const AIR = { name: 'air' }
const block = (name) => ({ name })

// Flat stone up to y 63, with the named cells in extra.
const flat = (extra = {}) => (p) => extra[`${p.x},${p.y},${p.z}`] || (p.y <= 63 ? block('stone') : AIR)

// mineflayer yaw and pitch that look from eye toward target.
function aim (eye, target) {
  const d = target.minus(eye)
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) }
}

test('the deictic words are here, there, this and that, as whole words only', () => {
  for (const msg of ['put it here', 'There!', 'is this one ok', 'that chest']) assert.ok(deictic(msg), msg)
  for (const msg of ['where are you', 'thistle', 'hello', 'other']) assert.ok(!deictic(msg), msg)
})

test('a look stops at the first block it meets, through air and water, and not past its reach', () => {
  const eye = new Vec3(0.5, 65.62, 0.5)
  const { yaw, pitch } = aim(eye, new Vec3(6.5, 63.5, 0.5))
  const hit = lookedAt(eye, yaw, pitch, flat())
  assert.deepStrictEqual([hit.block.name, hit.cell.x, hit.cell.y, hit.cell.z], ['stone', 5, 63, 0])
  const pond = lookedAt(eye, yaw, pitch, flat({ '5,63,0': block('water') }))
  assert.deepStrictEqual([pond.cell.x, pond.cell.y], [6, 63], 'water is looked through')
  const grass = lookedAt(eye, yaw, pitch, flat({ '4,64,0': block('short_grass') }))
  assert.deepStrictEqual([grass.block.name, grass.cell.x], ['short_grass', 4], 'grass stops the look as the crosshair does')
  const sky = aim(eye, new Vec3(40.5, 70, 0.5))
  const far = flat({ '35,69,0': block('stone') })
  assert.ok(lookedAt(eye, sky.yaw, sky.pitch, far, 40), 'control: a longer reach')
  assert.strictEqual(lookedAt(eye, sky.yaw, sky.pitch, far), null, `a block past ${POINT_RANGE}`)
  assert.strictEqual(lookedAt(eye, yaw, pitch, () => null), null, 'unloaded world')
})

test('a look passes water, lava and a bubble column', () => {
  const eye = new Vec3(0.5, 65.62, 0.5)
  const { yaw, pitch } = aim(eye, new Vec3(6.5, 63.5, 0.5))
  for (const name of ['water', 'lava', 'bubble_column']) {
    const hit = lookedAt(eye, yaw, pitch, flat({ '5,63,0': block(name) }))
    assert.deepStrictEqual([hit.block.name, hit.cell.x], ['stone', 6], `${name} is looked through`)
  }
})

test('a filled cauldron stops a look', () => {
  const eye = new Vec3(0.5, 65.62, 0.5)
  const { yaw, pitch } = aim(eye, new Vec3(6.5, 63.5, 0.5))
  for (const name of ['water_cauldron', 'lava_cauldron']) {
    const hit = lookedAt(eye, yaw, pitch, flat({ '5,63,0': block(name) }))
    assert.deepStrictEqual([hit.block.name, hit.cell.x], [name, 5], `${name} stops the look`)
  }
})

// chatPointer for Steve at (0.5, 64, 0.5) looking at the stone at (5, 63, 0), with the bot at (0.5, 64, 6.5).
// A crouching Steve looks from 1.27 up at the chest at (5, 64, 0), over which a look from 1.62 up passes.
function pointer ({ seen = true, sees = () => true, far = false, crouching = false } = {}) {
  const pos = new Vec3(far ? 40.5 : 0.5, 64, 0.5)
  const eye = pos.offset(0, crouching ? 1.27 : 1.62, 0)
  const { yaw, pitch } = aim(eye, crouching ? new Vec3(5.5, 64.9, 0.5) : new Vec3(far ? 45.5 : 5.5, 63.9, 0.5))
  const steve = { id: 7, type: 'player', username: 'Steve', position: pos, crouching, headYaw: yaw, yaw: yaw + 1, pitch }
  const env = {
    shared: { ready: true },
    bot: { entity: { position: new Vec3(0.5, 64, 6.5) }, entities: { 7: steve }, blockAt: flat(crouching ? { '5,64,0': block('chest') } : {}) },
    playerNamed,
    staleEntities: new Set(),
    reflexes: [{ name: 'combat', fairFill: () => ({}) }],
    entityPerceptible: () => seen,
    seesLit: (p) => sees(p),
    deictic,
    lookedAt,
    POINT_RANGE
  }
  return (msg) => JSON.parse(JSON.stringify(loadBotFunctions(['chatPointer'], env).chatPointer('Steve', msg)))
}

test('a chat line from a visible speaker points at the block they look at, by their head', () => {
  assert.deepStrictEqual(pointer()('put it here'), { block: 'stone', x: 5, y: 63, z: 0 })
  assert.strictEqual(pointer()('hello'), null, 'no deictic word')
})

test('a crouching speaker looks from the crouched eye', () => {
  assert.deepStrictEqual(pointer({ crouching: true })('put it here'), { block: 'chest', x: 5, y: 64, z: 0 })
})

test('a hidden speaker, one past the range, or a block the bot cannot see attaches nothing', () => {
  assert.ok(pointer()('there'), 'control')
  assert.strictEqual(pointer({ seen: false })('there'), null, 'hidden speaker')
  assert.strictEqual(pointer({ far: true })('there'), null, 'speaker past the range')
  assert.strictEqual(pointer({ sees: () => false })('there'), null, 'block out of the bot\'s sight')
})
