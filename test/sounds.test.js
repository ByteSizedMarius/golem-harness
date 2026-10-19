'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { classifySound } = require('../lib/sounds')
const { LEGACY_STRIKE_MS, LEGACY_STRIKE_RANGE } = require('../lib/bot/legacy-1710')
const { loadBotFunctions, functionSource } = require('./helpers')
const mcData = require('minecraft-data')('1.21.11')

const LEGACY = { legacy1710: true }
const MODERN = { legacy1710: false }
const BOTH = [LEGACY, MODERN]
const version = (opts) => (opts.legacy1710 ? '1.7.10' : '1.21.11')

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
  assert.notStrictEqual(r, input, `never the input itself on ${version(opts)}`)
  const ok = FIXED.has(r) || ENTITY_NAMES.has(r) || r === stepCategory(opts)
  assert.ok(ok, `category ${JSON.stringify(r)} for ${JSON.stringify(input).slice(0, 80)} on ${version(opts)} is not a fixed category`)
}

test('a namespace prefix does not change the species', () => {
  for (const opts of BOTH) {
    for (const name of ['minecraft_1.21:entity.zombie.hurt', 'entity.zombie.hurt']) {
      assert.strictEqual(classify(name, opts), 'zombie', `${name} on ${version(opts)}`)
    }
  }
})

test('the species comes from entity.<species>.*', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:entity.skeleton.ambient', opts), 'skeleton', version(opts))
    assert.strictEqual(classify('minecraft:entity.magma_cube.squish_small', opts), 'magma_cube', version(opts))
  }
})

test('a verbatim mob.witch name gives witch', () => {
  for (const opts of BOTH) assert.strictEqual(classify('mob.witch.idle', opts), 'witch', version(opts))
})

test('zombie_pigman gives zombified_piglin', () => {
  for (const opts of BOTH) assert.strictEqual(classify('entity.zombie_pigman.ambient', opts), 'zombified_piglin', version(opts))
})

test('big and small falls give fall, never hostile', () => {
  for (const opts of BOTH) {
    for (const name of ['minecraft:entity.hostile.big_fall', 'minecraft:entity.player.small_fall']) {
      assert.strictEqual(classify(name, opts), 'fall', `${name} on ${version(opts)}`)
    }
  }
})

test('player hurt and death give player', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:entity.player.hurt', opts), 'player', version(opts))
    assert.strictEqual(classify('minecraft:entity.player.death', opts), 'player', version(opts))
  }
})

test('splashes, boats and cave ambience are dropped', () => {
  for (const opts of BOTH) {
    for (const name of ['minecraft:entity.generic.splash', 'minecraft:entity.boat.paddle_water', 'minecraft:ambient.cave']) {
      assert.strictEqual(classify(name, opts), null, `${name} on ${version(opts)}`)
    }
  }
})

test('thunder from both names gives thunder', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:entity.lightning_bolt.thunder', opts), 'thunder', version(opts))
    assert.strictEqual(classify('ambient.weather.thunder', opts), 'thunder', version(opts))
  }
})

function ears (extra = {}) {
  const raised = []
  const texts = []
  const { onSound } = loadBotFunctions(['onSound'], {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) } },
    classifySound,
    LEGACY_1710: true,
    HEARD: [],
    dangerHeard: {},
    lastThunder: 0,
    lastThunderPos: null,
    LEGACY_STRIKE_MS,
    LEGACY_STRIKE_RANGE,
    emitEvent: (type, text) => { raised.push(type); texts.push(text) },
    ...extra
  })
  return { onSound, raised, texts }
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

test('on 1.21.11 an explosion where thunder just struck raises its hear event', () => {
  const strike = new Vec3(20.5, 64, 0.5)
  const { onSound, raised } = ears({ LEGACY_1710: false })
  onSound('minecraft:entity.lightning_bolt.thunder', strike)
  onSound('minecraft:entity.generic.explode', strike.offset(1, 0, 0))
  assert.deepStrictEqual(raised, ['hear'])
})

test('a danger sound raises at most one hear event per category within the throttle window', () => {
  // The window is the number the gate compares a category's last hear stamp against.
  const gate = /dangerHeard[^\n]*?>=?\s*(\d+)/.exec(functionSource('onSound'))
  assert.ok(gate, 'the danger gate in onSound')
  const window = Number(gate[1])
  let now = Date.now()
  const { onSound, raised } = ears({ Date: { now: () => now } })
  const lava = 'minecraft:block.lava.ambient'
  const explode = 'minecraft:entity.generic.explode'
  const at = new Vec3(8.5, 64, 0.5)
  const heard = (name) => {
    const before = raised.length
    onSound(name, at)
    return raised.length - before
  }
  assert.strictEqual(heard(lava), 1, 'control: the first lava sound')
  now += window
  assert.strictEqual(heard(lava), 0, 'lava again on the last ms of the window')
  assert.strictEqual(heard(explode), 1, 'an explosion inside the lava window')
  now += 1
  assert.strictEqual(heard(lava), 1, 'lava again once the window has passed')
})

test('extinguish_fire gives lava or fizz on 1.7.10 only', () => {
  const name = 'minecraft:entity.generic.extinguish_fire'
  assert.strictEqual(classify(name, LEGACY), 'lava or fizz')
  assert.notStrictEqual(classify(name, MODERN), 'lava')
  assert.notStrictEqual(classify(name, MODERN), 'lava or fizz')
})

test('a 1.7.10 extinguish_fire raises one hear event that reads lava or fizz', () => {
  const { onSound, raised, texts } = ears()
  onSound('minecraft:entity.generic.extinguish_fire', new Vec3(-5.5, 64, 0.5))
  assert.deepStrictEqual(raised, ['hear'])
  assert.ok(texts[0].startsWith('LAVA OR FIZZ '), texts[0])
})

test('a music_disc name is never filed as lava', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:block.lava.ambient', opts), 'lava', `control: a lava sound on ${version(opts)}`)
    assert.notStrictEqual(classify('minecraft:music_disc.lava_chicken', opts), 'lava', version(opts))
  }
})

test('names a 1.7.10 server sends give their category, and a block sound only a fixed one', () => {
  for (const opts of BOTH) {
    assert.strictEqual(classify('minecraft:entity.donkey.hurt', opts), 'donkey', `mob.horse.donkey.hit on ${version(opts)}`)
    assertAllowed('minecraft:block.stone.break', classify('minecraft:block.stone.break', opts), opts)
  }
})

// ---- hostile input ----

test('prototype keys give null', () => {
  const names = ['__proto__', 'entity.constructor.ambient']
  for (const opts of BOTH) {
    for (const name of names) assert.strictEqual(classify(name, opts), null, `${name} on ${version(opts)}`)
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
    for (const name of names) assert.strictEqual(classify(name, opts), null, `${name} on ${version(opts)}`)
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
      assert.doesNotThrow(() => { r = classifySound(input, opts) }, `${typeof input} on ${version(opts)}`)
      assert.strictEqual(r, null, `${typeof input} on ${version(opts)}`)
    }
  }
})
