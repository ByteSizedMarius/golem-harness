'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const { botConstant, loadBotFunctions } = require('./helpers')

const AIR = Block.fromStateId(registry.blocksByName.air.defaultState, 0)
const statesOf = (name) => {
  const b = registry.blocksByName[name]
  return Array.from({ length: b.maxStateId - b.minStateId + 1 }, (_, i) => Block.fromStateId(b.minStateId + i, 0))
}
const blockOf = (name) => Block.fromStateId(registry.blocksByName[name].defaultState, 0)

const STONE = blockOf('stone')
const GRAVEL = blockOf('gravel')
const key = (p) => `${p.x},${p.y},${p.z}`

// The world around a body at (0, 64, 0): head and feet in its own column, cells ('x,y,z' -> block) elsewhere, air
// in the rest.
function world (head, feet, cells) {
  const at = { ...cells, '0,65,0': head, '0,64,0': feet }
  return (p) => at[key(p)] || AIR
}

// A body standing at (0, 64, 0) with head in its head cell and feet in its feet cell. log holds the legs it takes
// and the cells it steps to, in order, digs the blocks it digs. A step reaches its cell when nudge resolves true.
function body (head, feet = AIR, { cells = {}, known = () => true, lastFeet = null, nudge = async () => true } = {}) {
  const digs = []
  const log = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    oxygenLevel: 20,
    blockAt: world(head, feet, cells),
    dig: async (b) => { digs.push(b.name) }
  }
  const env = {
    bot,
    OPENABLE: botConstant('OPENABLE'),
    equipPickFor: async () => {},
    knownCell: known,
    takeLegs: () => { log.push('legs') },
    stopPath: () => {},
    nudgeInto: (c) => { log.push(`step ${key(c)}`); return nudge() },
    lastFeet,
    stepOut: null
  }
  return {
    buried: () => loadBotFunctions(['waterState'], env).waterState().buried,
    digOutHead: () => loadBotFunctions(['digOutHead'], env).digOutHead(),
    // Settles once the step started last and any dig it falls back to have begun.
    stepped: () => env.stepOut,
    digs,
    log
  }
}

// Floors (stone under each cell) for a body to stand in the given feet cells.
const floors = (...feet) => Object.fromEntries(feet.map(([x, y, z]) => [`${x},${y - 1},${z}`, STONE]))
// Stone in the feet and head cells of all four columns beside the body.
const walled = Object.fromEntries([[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([x, z]) => [[`${x},64,${z}`, STONE], [`${x},65,${z}`, STONE]]))

const slab = (type) => statesOf('oak_slab').find((b) => b.getProperties().type === type && !b.getProperties().waterlogged)

test('a head in glass, a sign, a stair or a half slab is not buried', () => {
  for (const head of [blockOf('glass'), blockOf('oak_sign'), blockOf('oak_stairs'), slab('bottom')]) {
    assert.strictEqual(body(head).buried(), false, `${head.name} ${JSON.stringify(head.getProperties())}`)
  }
})

test('a head in gravel or a double slab is buried', () => {
  assert.strictEqual(body(blockOf('gravel')).buried(), true, 'gravel')
  assert.strictEqual(body(slab('double')).buried(), true, 'double oak_slab')
})

test('a body standing in a doorway is not buried and the rescue leaves the door', async () => {
  for (const open of [false, true]) {
    const doors = statesOf('oak_door').filter((b) => b.getProperties().open === open && b.getProperties().facing === 'north')
    const upper = doors.find((b) => b.getProperties().half === 'upper')
    const lower = doors.find((b) => b.getProperties().half === 'lower')
    const b = body(upper, lower)
    assert.strictEqual(b.buried(), false, `open ${open}`)
    assert.strictEqual(await b.digOutHead(), false, `open ${open}`)
    assert.deepStrictEqual(b.digs, [], `open ${open}`)
  }
})

test('the rescue digs out gravel in the head cell, never bedrock', async () => {
  const gravel = body(blockOf('gravel'))
  assert.strictEqual(await gravel.digOutHead(), true, 'gravel')
  assert.deepStrictEqual(gravel.digs, ['gravel'])
  const bedrock = body(blockOf('bedrock'))
  assert.strictEqual(await bedrock.digOutHead(), false, 'bedrock')
  assert.deepStrictEqual(bedrock.digs, [])
})

// Starts the rescue of b, waits for its step and returns what the body did.
async function rescue (b) {
  assert.strictEqual(await b.digOutHead(), true, 'the rescue starts')
  await b.stepped()
  return { log: b.log, digs: b.digs }
}

test('a body buried in gravel steps back to the column it came from and digs nothing', async () => {
  const b = body(GRAVEL, AIR, { cells: floors([1, 64, 0], [-1, 64, 0]), lastFeet: new Vec3(-1, 64, 0) })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step -1,64,0'], digs: [] })
})

test('a buried body whose last column is not beside it steps to a neighbour it can stand in', async () => {
  const b = body(GRAVEL, AIR, { cells: floors([2, 64, 0], [0, 64, -1]), lastFeet: new Vec3(2, 64, 0) })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step 0,64,-1'], digs: [] })
})

test('a buried body with rock or unseen cells beside it digs the head block', async () => {
  const rock = body(GRAVEL, AIR, { cells: { ...floors([1, 64, 0], [-1, 64, 0], [0, 64, 1], [0, 64, -1]), ...walled } })
  assert.deepStrictEqual(await rescue(rock), { log: [], digs: ['gravel'] }, 'rock')
  const unseen = body(GRAVEL, AIR, { cells: floors([1, 64, 0]), known: (p) => key(p) !== '1,64,0' })
  assert.deepStrictEqual(await rescue(unseen), { log: [], digs: ['gravel'] }, 'unseen')
})

test('a step-out skips a neighbour under gravel the body knows of', async () => {
  const cells = { ...floors([1, 64, 0], [-1, 64, 0]), '1,66,0': GRAVEL }
  assert.deepStrictEqual(await rescue(body(GRAVEL, AIR, { cells })), { log: ['legs', 'step -1,64,0'], digs: [] }, 'seen')
  const unseen = body(GRAVEL, AIR, { cells, known: (p) => key(p) !== '1,66,0' })
  assert.deepStrictEqual(await rescue(unseen), { log: ['legs', 'step 1,64,0'], digs: [] }, 'unseen')
})

test('a step down beside the feet goes only where the cell above it is open', async () => {
  const b = body(GRAVEL, AIR, { cells: { ...floors([1, 63, 0], [-1, 63, 0]), '1,65,0': STONE } })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step -1,63,0'], digs: [] })
})

test('hits during one step-out start no second step and no dig', async () => {
  let arrive
  const b = body(GRAVEL, AIR, { cells: floors([1, 64, 0]), nudge: () => new Promise((resolve) => { arrive = resolve }) })
  assert.strictEqual(await b.digOutHead(), true, 'first hit')
  const step = b.stepped()
  assert.strictEqual(await b.digOutHead(), true, 'second hit')
  assert.deepStrictEqual({ log: b.log, digs: b.digs }, { log: ['legs', 'step 1,64,0'], digs: [] }, 'stepping')
  arrive(true)
  await step
  assert.deepStrictEqual({ log: b.log, digs: b.digs }, { log: ['legs', 'step 1,64,0'], digs: [] }, 'arrived')
})

test('a step-out that does not reach its cell digs the head block', async () => {
  const b = body(GRAVEL, AIR, { cells: floors([1, 64, 0]), nudge: async () => false })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step 1,64,0'], digs: ['gravel'] })
})

test('a step-out that throws digs the head block', async () => {
  const b = body(GRAVEL, AIR, { cells: floors([1, 64, 0]), nudge: async () => { throw new Error('lookAt failed') } })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step 1,64,0'], digs: ['gravel'] })
})

test('a step-out skips a neighbour over a ladder or a half slab, or with fire or a cobweb in it', async () => {
  const cells = floors([1, 64, 0], [-1, 64, 0])
  const steps = {}
  for (const [block, at] of [[blockOf('ladder'), '-1,63,0'], [slab('bottom'), '-1,63,0'], [blockOf('fire'), '-1,64,0'], [blockOf('cobweb'), '-1,64,0']]) {
    steps[`${block.name} at ${at}`] = (await rescue(body(GRAVEL, AIR, { cells: { ...cells, [at]: block }, lastFeet: new Vec3(-1, 64, 0) }))).log
  }
  const away = ['legs', 'step 1,64,0']
  assert.deepStrictEqual(steps, { 'ladder at -1,63,0': away, 'oak_slab at -1,63,0': away, 'fire at -1,64,0': away, 'cobweb at -1,64,0': away })
})

// The alarm listeners on a body at (0, 64, 0) with its head in gravel, over cells. walk moves the body, hit lands
// a 3-damage hit with the given attribution, and log and digs record what the body did.
function wiredBody (t, cells) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { createAlarms, bindAlarms, wireTrailMarks, wireBodyAlarms } = require('../lib/bot/alarms')
  const { suffocates, holdsWater } = loadBotFunctions(['suffocates', 'holdsWater'], {})
  const log = []
  const digs = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    health: 20,
    food: 20,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: world(GRAVEL, AIR, cells),
    dig: async (b) => { digs.push(b.name) }
  })
  const fight = { lastHit: null, lastAttrib: null, swingWait: null }
  const ctx = {
    bot,
    fight,
    bunker: { building: false },
    reflexes: [],
    mobClass: () => 'hostile',
    CONFIRMED_HORIZON: 16,
    emitEvent: () => {},
    waterState: () => ({ buried: true }),
    freezeBody: () => { log.push('freeze') },
    suffocates,
    holdsWater,
    OPENABLE: botConstant('OPENABLE'),
    equipPickFor: async () => {},
    markTrail: () => {},
    markBody: () => {},
    knownCell: () => true,
    takeLegs: () => { log.push('legs') },
    stopPath: () => {},
    nudgeInto: async (c) => { log.push(`step ${key(c)}`); return true }
  }
  createAlarms(ctx)
  bindAlarms(ctx)
  wireTrailMarks()
  wireBodyAlarms()
  const health = () => Promise.all(bot.listeners('health').map((f) => f()))
  return {
    walk (x, y, z) {
      const was = bot.entity.position
      bot.entity.position = new Vec3(x, y, z)
      bot.emit('move', was)
    },
    async hit (attrib) {
      await health()
      bot.health -= 3
      fight.lastAttrib = { t: Date.now(), ranged: false, ...attrib }
      await health()
      await new Promise((resolve) => setImmediate(resolve))
    },
    log,
    digs
  }
}

test('a jump in place keeps the column the feet came from as the step-out', async (t) => {
  const b = wiredBody(t, floors([1, 64, 0], [-1, 64, 0]))
  b.walk(-0.5, 64, 0.5)
  b.walk(0.5, 64, 0.5)
  b.walk(0.5, 65.2, 0.5)
  b.walk(0.5, 64, 0.5)
  await b.hit({ desc: 'no attacker named, no hostile within 4', entity: null, env: true })
  assert.deepStrictEqual({ log: b.log, digs: b.digs }, { log: ['legs', 'step -1,64,0'], digs: [] })
})

test('a buried body hit by a hostile in reach steps out without freezing', async (t) => {
  const b = wiredBody(t, floors([1, 64, 0]))
  await b.hit({ desc: 'zombie 3 E', entity: { name: 'zombie', position: new Vec3(3.5, 64, 0.5) }, env: false })
  assert.deepStrictEqual({ log: b.log, digs: b.digs }, { log: ['legs', 'step 1,64,0'], digs: [] })
})
