'use strict'
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const { Vec3 } = require('vec3')
const shelter = require('../lib/shelter')
const { botSource, balanced, botConstant, loadBotFunctions, shelterEnv } = require('./helpers')

const ME = new Vec3(0.5, 64, 0.5)
const zombie = (id) => ({ id, name: 'zombie', type: 'hostile', position: new Vec3(5.5, 64, 0.5) })

// Each test leaves entity 1 stale, as after a dimension change, and then lets the server update it.

test('collect skips a drop of the dimension before until the server updates it', () => {
  const drop = { id: 1, name: 'item', position: new Vec3(3.5, 64, 0.5) }
  const env = {
    bot: { entity: { position: ME }, entities: { 1: drop } },
    staleEntities: new Set([1]),
    airFlood: () => ({}),
    entityPerceptible: () => true
  }
  const { nearestDrop } = loadBotFunctions(['nearestDrop'], env)
  assert.strictEqual(nearestDrop(8, new Set()), null)
  env.staleEntities.delete(1)
  assert.strictEqual(nearestDrop(8, new Set()), drop, 'updated since')
})

test('the hostile alarm says nothing of a mob of the dimension before until the server updates it', () => {
  const src = botSource()
  const at = src.indexOf('const considerMob = ')
  const consider = balanced(src, at)
  const scan = balanced(src, src.indexOf('setInterval(() =>', at))
  assert.ok(consider && scan, 'the hostile alarm not found in bot.js')
  const events = []
  const env = {
    bot: { entity: { position: ME }, entities: { 1: zombie(1) } },
    staleEntities: new Set([1]),
    HOSTILE: new Set(['zombie']),
    warnedMobs: new Set(),
    nightFired: false,
    reflexes: [{ name: 'combat', fairFill: () => ({}) }],
    entityPerceptible: () => true,
    round: (p) => p,
    emitEvent: (kind, msg) => events.push(kind)
  }
  const ctx = loadBotFunctions(['liveEntities'], env)
  const tick = vm.runInContext(`const considerMob = (en) => ${consider}\n;(() => ${scan})`, ctx)
  tick()
  assert.deepStrictEqual(events, [])
  env.staleEntities.delete(1)
  tick()
  assert.deepStrictEqual(events, ['hostile'], 'updated since')
})

test('the hostile alarm says nothing when the perception flood throws', () => {
  const src = botSource()
  const consider = balanced(src, src.indexOf('const considerMob = '))
  assert.ok(consider, 'the hostile alarm not found in bot.js')
  const events = []
  const env = {
    bot: { entity: { position: ME }, entities: {} },
    HOSTILE: new Set(['zombie']),
    warnedMobs: new Set(),
    reflexes: [{ name: 'combat', fairFill: () => { throw new Error('flood failed') } }],
    entityPerceptible: () => true,
    round: (p) => p,
    emitEvent: (kind) => events.push(kind)
  }
  const ctx = loadBotFunctions(['liveEntities'], env)
  const considerMob = vm.runInContext(`(en) => ${consider}`, ctx)
  considerMob(zombie(1))
  assert.deepStrictEqual(events, [])
  assert.strictEqual(env.warnedMobs.has(1), false, 'not marked warned, so the alarm can still fire later')
})

test('the narrator says nothing of a mob of the dimension before until the server updates it', () => {
  const src = botSource()
  const at = src.search(/\bname\s*:\s*['"]narrator['"]/)
  const literal = at < 0 ? '' : balanced(src, src.lastIndexOf('{', at))
  assert.ok(literal, 'the narrator not found in bot.js')
  const bot = { entity: { position: ME }, entities: {}, health: 20, food: 20 }
  const env = {
    bot,
    staleEntities: new Set([1]),
    HOSTILE_NAMES: new Set(['zombie']),
    dayPhase: () => 'day',
    compass: () => 'E',
    reflexes: [{ name: 'combat', fairFill: () => ({ cells: new Set() }) }],
    entityPerceptible: () => true
  }
  const ctx = loadBotFunctions(['liveEntities'], env)
  const narrator = vm.runInContext(`(${literal})`, ctx)
  assert.strictEqual(narrator.check(bot), false, 'control: the first pulse seeds the baseline')
  bot.entities[1] = zombie(1)
  assert.strictEqual(narrator.check(bot), false)
  env.staleEntities.delete(1)
  assert.strictEqual(narrator.check(bot), true, 'updated since')
  assert.match(narrator._msg, /hostile zombie E ~5/)
})

// The bunker reflex, the hit attribution and the dimension change of bot.js, at 5 HP a second after a
// zombie's hit, with entity 1 a zombie 3 blocks east that the body sees when seen and last perceived there.
function threatScene (seen = true) {
  const zombie = { id: 1, name: 'zombie', cls: 'hostile', seen, position: new Vec3(3.5, 64, 0.5), seenAt: new Vec3(3.5, 64, 0.5) }
  const { env } = shelterEnv({ 1: zombie }, [])
  Object.assign(env.reflexes[0], { _fleeT: 0, _fleeCls: null, _fleeUntil: 0, _coverUntil: 0 })
  env.reflexes.push({ name: 'bunker', _spent: false })
  Object.assign(env.bot, { health: 5, game: { dimension: 'overworld' } })
  Object.assign(env, {
    bunker: { cell: null },
    guardState: { up: false, slot: -1, pilot: false },
    playerCrumbs: {},
    crumbDimension: 'overworld',
    lastHit: { dmg: 3, t: Date.now() - 1000, cls: 'hostile' },
    BUNKER_HP: botConstant('BUNKER_HP'),
    bunkerHolds: () => false,
    chooseShelter: shelter.chooseShelter
  })
  const ctx = loadBotFunctions(['bunkerReflexDecide', 'nearestHostile', 'shelterInputs', 'forgetCrumbsElsewhere'], env)
  const enterNether = () => {
    env.bot.game.dimension = 'the_nether'
    ctx.forgetCrumbsElsewhere()
  }
  return { env, ctx, zombie, enterNether }
}

test('a hostile of the dimension before neither drives the bunker reflex nor takes a sourceless hit', () => {
  const { env, ctx, zombie, enterNether } = threatScene()
  assert.ok(ctx.bunkerReflexDecide(), 'control: the zombie in sight')
  assert.strictEqual(ctx.nearestHostile(), zombie, 'control: a sourceless hit is pinned on it')
  enterNether()
  env.lastHit = { dmg: 3, t: Date.now(), cls: 'hostile' }
  assert.strictEqual(ctx.bunkerReflexDecide(), null)
  assert.strictEqual(ctx.nearestHostile(), undefined)
})

test('a new mob the next dimension gives the id of a mob that hit the body is not confirmed aggro', () => {
  const { env, ctx, enterNether } = threatScene(false)
  env.AGGRO_CONFIRMED.set(1, { name: 'zombie', t: Date.now() })
  const names = () => Array.from(ctx.shelterInputs('auto').threats, (t) => t.name)
  assert.deepStrictEqual(names(), ['zombie'], 'control: the mob that hit counts unseen')
  enterNether()
  env.bot.entities[1] = { id: 1, name: 'skeleton', cls: 'hostile', seen: false, position: new Vec3(3.5, 64, 0.5) }
  env.staleEntities.delete(1)
  assert.deepStrictEqual(names(), [])
})

test('no scan of bot.js reads the raw entity table besides the live one and the dimension change', () => {
  const scans = botSource().split('\n').filter((l) => /Object\.(values|entries|keys)\(bot\.entities\)|for \(const \w+ in bot\.entities\)/.test(l))
  assert.strictEqual(scans.length, 2, scans.join('\n'))
})
