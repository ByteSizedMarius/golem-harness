'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { classifySound } = require('../lib/sounds')
const { loadBotFunctions } = require('./helpers')
const mcData = require('minecraft-data')('1.21.11')

const LEGACY = { legacy1710: true }
const MODERN = { legacy1710: false }
const BOTH = [LEGACY, MODERN]

const ENTITY_NAMES = new Set(Object.keys(mcData.entitiesByName))
const FIXED = new Set(['witch', 'slime', 'zombified_piglin', 'fall', 'player', 'thunder', 'lava', 'fuse', 'explosion', 'water'])

function classify (name, opts) {
  const r = classifySound(name, opts)
  assert.ok(r === null || typeof r === 'string', `result for ${JSON.stringify(name)} is a string or null, got ${typeof r}`)
  return r
}

const stepCategory = (opts) => classify('minecraft:block.stone.step', opts)

function assertAllowed (input, r, opts) {
  if (r === null) return
  assert.notStrictEqual(r, input, 'never the input itself')
  const ok = FIXED.has(r) || ENTITY_NAMES.has(r) || r === stepCategory(opts)
  assert.ok(ok, `category ${JSON.stringify(r)} for ${JSON.stringify(input).slice(0, 80)} is not a fixed category`)
}

test('a namespace prefix does not change the species', () => {
  for (const opts of BOTH) {
    for (const name of ['minecraft_1.21:entity.zombie.hurt', 'entity.zombie.hurt']) {
      assert.strictEqual(classify(name, opts), 'zombie', name)
    }
  }
})

test('the species comes from entity.<species>.*', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:entity.skeleton.ambient', opts), 'skeleton')
    assert.strictEqual(classify('minecraft:entity.magma_cube.squish_small', opts), 'magma_cube')
  }
})

test('a verbatim mob.witch name gives witch', () => {
  for (const opts of BOTH) assert.strictEqual(classify('mob.witch.idle', opts), 'witch')
})

test('zombie_pigman gives zombified_piglin', () => {
  for (const opts of BOTH) assert.strictEqual(classify('entity.zombie_pigman.ambient', opts), 'zombified_piglin')
})

test('big and small falls give fall, never hostile', () => {
  for (const opts of BOTH) {
    for (const name of ['minecraft:entity.hostile.big_fall', 'minecraft:entity.player.small_fall']) {
      assert.strictEqual(classify(name, opts), 'fall', name)
    }
  }
})

test('player hurt and death give player', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:entity.player.hurt', opts), 'player')
    assert.strictEqual(classify('minecraft:entity.player.death', opts), 'player')
  }
})

test('splashes, boats and cave ambience are dropped', () => {
  for (const opts of BOTH) {
    for (const name of ['minecraft:entity.generic.splash', 'minecraft:entity.boat.paddle_water', 'minecraft:ambient.cave']) {
      assert.strictEqual(classify(name, opts), null, name)
    }
  }
})

test('thunder from both names gives thunder', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:entity.lightning_bolt.thunder', opts), 'thunder')
    assert.strictEqual(classify('ambient.weather.thunder', opts), 'thunder')
  }
})

// The bot's onSound for a body at the origin on a 1.7.10 server, and the types of the events it raised.
function ears () {
  const raised = []
  const { onSound } = loadBotFunctions(['onSound'], {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) } },
    classifySound,
    LEGACY_1710: true,
    HEARD: [],
    dangerHeard: {},
    lastThunder: 0,
    lastThunderPos: null,
    emitEvent: (type) => raised.push(type)
  })
  return { onSound, raised }
}

test('the explosion 1.7.10 lightning plays where its thunder struck raises no hear event, one elsewhere does', () => {
  const thunder = 'minecraft:entity.lightning_bolt.thunder'
  const explode = 'minecraft:entity.generic.explode'
  const strike = new Vec3(20.5, 64, 0.5)
  const control = ears()
  control.onSound(explode, strike)
  assert.deepStrictEqual(control.raised, ['hear'], 'control: an explosion with no thunder before it')
  const atStrike = ears()
  atStrike.onSound(thunder, strike)
  atStrike.onSound(explode, strike.offset(1, 0, 0))
  assert.deepStrictEqual(atStrike.raised, [], 'an explosion 1 from the strike')
  const elsewhere = ears()
  elsewhere.onSound(thunder, strike)
  elsewhere.onSound(explode, strike.offset(0, 0, 3))
  assert.deepStrictEqual(elsewhere.raised, ['hear'], 'an explosion 3 from the strike')
})

test('extinguish_fire gives lava under legacy1710 only', () => {
  assert.strictEqual(classify('minecraft:entity.generic.extinguish_fire', LEGACY), 'lava')
  assert.notStrictEqual(classify('minecraft:entity.generic.extinguish_fire', MODERN), 'lava')
})

test('a music_disc name is never filed as lava', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:block.lava.ambient', opts), 'lava', 'control: a lava sound')
    assert.notStrictEqual(classify('minecraft:music_disc.lava_chicken', opts), 'lava')
  }
})

test('names a 1.7.10 server sends give their category, and a block sound only a fixed one', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:entity.donkey.hurt', opts), 'donkey', 'mob.horse.donkey.hit')
    assertAllowed('minecraft:block.stone.break', classify('minecraft:block.stone.break', opts), opts)
  }
})

// ---- hostile input ----

test('prototype keys give null', () => {
  const names = ['__proto__', 'entity.constructor.ambient']
  for (const opts of BOTH) {
    for (const name of names) assert.strictEqual(classify(name, opts), null, name)
  }
})

test('an unknown species is never echoed', () => {
  const names = [
    'entity.ignore_all_previous_instructions.ambient',
    'mob.op_me.idle',
    'minecraft_1.21:entity.zombiex.ambient',
    'entity.notzombie.ambient'
  ]
  for (const opts of BOTH) {
    for (const name of names) assert.strictEqual(classify(name, opts), null, name)
  }
})

test('non-string input gives null and does not throw', () => {
  const inputs = [
    null,
    ['minecraft:entity.zombie.ambient'],
    { toString () { return 'minecraft:entity.zombie.ambient' } },
    Symbol('entity.zombie.ambient')
  ]
  for (const opts of BOTH) {
    for (const input of inputs) {
      let r
      assert.doesNotThrow(() => { r = classifySound(input, opts) }, String(typeof input))
      assert.strictEqual(r, null, String(typeof input))
    }
  }
})
