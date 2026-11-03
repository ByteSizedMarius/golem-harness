'use strict'
// The combat reflex floods its shared flood's successor a slice at a time between reflex ticks.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { loadBotFunctions, botConstant, combatReflexIn } = require('./helpers')

const AIR = { name: 'air', boundingBox: 'empty' }
const STONE = { name: 'stone', boundingBox: 'block' }
const WATER = { name: 'water', boundingBox: 'empty' }
const ck = (x, y, z) => x + ',' + y + ',' + z

const room = (p) => p.x >= -3 && p.x <= 8 && p.y >= 64 && p.y <= 66 && p.z >= -3 && p.z <= 3

function body (open, wet = () => false) {
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: (p) => (wet(p) ? WATER : open(p) ? AIR : STONE)
  })
}

const plain = (f) => ({
  cells: [...f.cells].sort(),
  liquid: [...f.liquid].sort(),
  capped: f.capped,
  cut: f.cut,
  reached: f.reached && f.reached.toString(),
  seed: f.seed.toString(),
  unknown: f.unknown,
  walls: f.walls && [...f.walls.keys()].sort()
})

test('a flood paused after every cell ends with the cells and answer of one flood run through', () => {
  const corridor = (p) => p.y >= 64 && p.y <= 65 && p.z === 0 && p.x >= 0 && p.x <= 9
  const ford = (p) => corridor(p) && p.x >= 3 && p.x <= 5
  const rows = [
    ['a closed room, every wall known', room, () => false, { known: () => true }],
    ['a closed room with an unseen wall', room, () => false, { known: (p) => !(p.x === 9 && p.y === 65) }],
    ['a closed room keeping its walls', room, () => false, { keepWalls: true }],
    ['a field cut by the radius', (p) => p.y >= 64, () => false, { radius: 4, known: () => true }],
    ['a field at the cap', (p) => p.y >= 64, () => false, { cap: 40 }],
    ['a corridor through water', corridor, ford, {}],
    ['a corridor to a target', corridor, ford, { targets: new Set([ck(8, 64, 0)]), known: () => true }]
  ]
  for (const [what, open, wet, opts] of rows) {
    const { airFlood, airFloodSteps } = loadBotFunctions(['airFlood', 'airFloodSteps'], { bot: body(open, wet), ck, Vec3 })
    const o = { radius: 20, cap: 15000, ...opts }
    const whole = plain(airFlood(o))
    const flood = airFloodSteps(o)
    let pauses = 0
    while (!flood.step(() => true)) pauses++
    assert.ok(pauses > 0, `${what}: control, the flood paused`)
    assert.deepStrictEqual(plain(flood.result()), whole, what)
  }
})

// floods() counts the airFlood runs fairFill makes synchronously.
function reflexRig () {
  const bot = body(room)
  let t = 1e6
  let floods = 0
  const env = {
    bot,
    Vec3,
    ck,
    knownCell: () => true,
    Date: { now: () => t++ },
    setImmediate,
    FILL_SLICE_MS: botConstant('FILL_SLICE_MS'),
    WALK_MEMO: botConstant('WALK_MEMO'),
    REACH_MEMO: botConstant('REACH_MEMO'),
    reflexes: []
  }
  loadBotFunctions(['airFlood', 'wireFloodDrops'], env)
  const airFlood = env.airFlood
  env.airFlood = (o) => { floods++; return airFlood(o) }
  const combat = combatReflexIn(env)
  env.reflexes.push(combat)
  env.wireFloodDrops()
  // A flood run through from seed, as fairFill floods it.
  const fresh = (seed) => airFlood({ seed, radius: 20, cap: 15000, known: () => true, knownOnly: true })
  return { bot, combat, fresh, floods: () => floods }
}

async function turns (done, n = 1000) {
  for (let i = 0; i < n && !done(); i++) await new Promise(setImmediate)
}

test('the fill\'s successor floods between reflex ticks once the body moved 1.5 blocks and takes over with a fresh flood\'s cells', async () => {
  const r = reflexRig()
  const first = r.combat.fairFill(r.bot)
  assert.strictEqual(r.floods(), 1, 'control: the first fill')
  r.bot.entity.position = new Vec3(2.1, 64, 0.5)
  assert.strictEqual(r.combat.fairFill(r.bot), first, 'the fill within 3 blocks of its seed')
  const seed = r.combat._nextFill && r.combat._nextFill.seed
  await turns(() => r.combat._fill !== first)
  assert.notStrictEqual(r.combat._fill, first, 'the successor never took over')
  assert.strictEqual(r.floods(), 1, 'a synchronous flood ran')
  assert.deepStrictEqual(plain(r.combat._fill), plain(r.fresh(seed)))
  assert.strictEqual(r.combat.fairFill(r.bot), r.combat._fill, 'the successor is reused')
  assert.strictEqual(r.combat._nextFill, null, 'a successor started while the body comes up to the fill\'s seed ahead of it')
})

test('the fill\'s successor seeds 2 blocks past the body along its move, or at the body when that cell lies outside the fill', () => {
  const seedAfter = (from, to) => {
    const r = reflexRig()
    r.bot.entity.position = new Vec3(from + 0.5, 64, 0.5)
    r.combat.fairFill(r.bot)
    r.bot.entity.position = new Vec3(to + 0.5, 64, 0.5)
    r.combat.fairFill(r.bot)
    return r.combat._nextFill.seed.toString()
  }
  assert.strictEqual(seedAfter(0, 2), '(4, 64, 0)')
  assert.strictEqual(seedAfter(2, 0), '(-2, 64, 0)')
  assert.strictEqual(seedAfter(6, 8), '(8, 64, 0)', 'the room ends at x 8')
})

test('a reflex tick 3 blocks from the fill\'s seed finishes the successor in flight and runs no flood of its own', async () => {
  const r = reflexRig()
  r.combat.fairFill(r.bot)
  r.bot.entity.position = new Vec3(2.1, 64, 0.5)
  r.combat.fairFill(r.bot)
  await new Promise(setImmediate)
  const sliced = r.combat._nextFill && r.combat._nextFill.flood.cells.size
  const seed = r.combat._nextFill && r.combat._nextFill.seed
  r.bot.entity.position = new Vec3(3.7, 64, 0.5)
  const fill = r.combat.fairFill(r.bot)
  assert.strictEqual(r.floods(), 1, 'the reflex tick ran a flood of its own')
  assert.ok(sliced > 1 && sliced < fill.cells.size, `control: the successor flooded a slice, ${sliced} of ${fill.cells.size} cells`)
  assert.deepStrictEqual(plain(fill), plain(r.fresh(seed)), 'the cells of a fresh flood from the successor\'s seed')
})

test('a block change in or beside the successor\'s flood drops it, one away from it keeps it, a loaded column within a fill\'s radius drops that fill', async () => {
  // The fill floods 20 around x 1 and its successor 20 around x 5.
  const successor = () => {
    const r = reflexRig()
    r.bot.entity.position = new Vec3(1.5, 64, 0.5)
    r.combat.fairFill(r.bot)
    r.bot.entity.position = new Vec3(3.1, 64, 0.5)
    r.combat.fairFill(r.bot)
    assert.ok(r.combat._nextFill, 'control: a successor in flight')
    return r
  }
  const update = (r, x, y, z) => {
    const b = { ...STONE, position: new Vec3(x, y, z) }
    r.bot.emit('blockUpdate', b, b)
  }
  const far = successor()
  update(far, 30, 64, 0)
  assert.ok(far.combat._nextFill, 'a block change far from both fills')
  // The successor has flooded its seed alone.
  for (const [what, x, y, z] of [['in', 5, 64, 0], ['beside', 5, 63, 0]]) {
    const r = successor()
    update(r, x, y, z)
    assert.strictEqual(r.combat._nextFill, null, what)
    await turns(() => false, 50)
    assert.strictEqual(r.combat._fill, null, `${what}: the dropped successor took over`)
  }
  const load = (x) => {
    const r = successor()
    r.bot.emit('chunkColumnLoad', new Vec3(x, 0, 0))
    return [r.combat._fill !== null, r.combat._nextFill !== null]
  }
  assert.deepStrictEqual(load(16), [false, false], 'a column 16 east')
  assert.deepStrictEqual(load(-48), [true, true], 'a column 48 west')
  assert.deepStrictEqual(load(-32), [false, true], 'a column 32 west, within reach of the fill alone')
  assert.deepStrictEqual(load(48), [true, true], 'a column 48 east')
})
