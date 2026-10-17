'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { sectionColumns, floorPhrase } = require('../lib/section')
const { botConstant, facings, runRoute } = require('./helpers')

const O = { x: 0, y: 64, z: 0 }
const key = (x, y, z) => `${x},${y},${z}`

// A corridor east along z 0. open[d] = [lo, rock]: the bot sees open air from lo up to 65, rock
// stands at rock and below, and the air between them is air the bot does not see. known(p) is
// whether the bot sees a cell.
function scene (open, { known = () => false } = {}) {
  const cells = new Set()
  for (const [d, [lo]] of Object.entries(open)) for (let y = lo; y <= 65; y++) cells.add(key(Number(d), y, 0))
  return {
    open: (x, y, z) => cells.has(key(x, y, z)),
    wet: () => false,
    known,
    blockAt: (p) => {
      const col = open[p.x]
      return col && p.y > col[1] ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' }
    }
  }
}

const columns = (open, opts) => sectionColumns({ o: O, dx: 1, dz: 0, len: Object.keys(open).length - 1, up: 8, down: 12, ...scene(open, opts) })

test('a cell under the lowest open cell is a floor only when the bot sees it', () => {
  // Rock right under the lowest open cell of both columns.
  const open = { 0: [64, 63], 1: [61, 60] }
  assert.deepStrictEqual(columns(open, { known: () => true }).map((c) => c.under), ['solid', 'solid'], 'control: seen rock')
  assert.deepStrictEqual(columns(open).map((c) => c.under), ['unknown', 'unknown'], 'unseen rock')
  assert.deepStrictEqual(columns(open, { known: (p) => p.x === 1 }).map((c) => c.under), ['unknown', 'solid'])
  assert.strictEqual(floorPhrase(columns(open), O.y), 'floor: floor unknown at d0–1')
})

test('unseen air under the lowest open cell gives floor unknown, never a floor', () => {
  const known = () => true
  const floored = columns({ 0: [64, 63], 1: [64, 63], 2: [61, 60], 3: [61, 60] }, { known })
  assert.strictEqual(floorPhrase(floored, O.y), 'floor: level d0–1, down 3 at d2–3', 'control: rock under the open cells')
  // The ground lies 58 blocks below the lowest open cell at d2 and d3.
  const hollow = columns({ 0: [64, 63], 1: [64, 63], 2: [61, 3], 3: [61, 3] }, { known })
  assert.deepStrictEqual(hollow.map((c) => c.under), ['solid', 'solid', 'unknown', 'unknown'])
  assert.strictEqual(floorPhrase(hollow, O.y), 'floor: level d0–1, floor unknown at d2–3')
})

test('open air that goes on under the frame drops below it', () => {
  const cols = columns({ 0: [64, 63], 1: [40, 30] }, { known: () => true })
  assert.strictEqual(cols[1].lo, O.y - 12, 'control: the column is open to the frame bottom')
  assert.strictEqual(cols[1].under, 'air')
  assert.strictEqual(floorPhrase(cols, O.y), 'floor: level d0, drops below the frame at d1')
})

// runs[d] holds the open [lo, hi] spans at x d, wet the [d, y] water cells, the rest is seen rock.
function layers (runs, wet = []) {
  const cells = new Set()
  for (const [d, spans] of Object.entries(runs)) for (const [lo, hi] of spans) for (let y = lo; y <= hi; y++) cells.add(key(Number(d), y, 0))
  const water = new Set(wet.map(([d, y]) => key(d, y, 0)))
  return sectionColumns({
    o: O, dx: 1, dz: 0, len: Object.keys(runs).length - 1, up: 8, down: 12,
    open: (x, y, z) => cells.has(key(x, y, z)),
    wet: (x, y, z) => water.has(key(x, y, z)),
    known: () => true,
    blockAt: (p) => (cells.has(key(p.x, p.y, p.z)) ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' })
  })
}

const TUNNEL = [64, 65]

test('a column measures the open run at the body\'s level, never a cave under its floor', () => {
  const cols = layers({ 0: [TUNNEL], 1: [TUNNEL], 2: [TUNNEL], 3: [[56, 57], TUNNEL], 4: [TUNNEL] })
  assert.deepStrictEqual([cols[3].lo, cols[3].hi], TUNNEL)
  assert.strictEqual(floorPhrase(cols, O.y), 'floor: level d0–4')
})

test('water in a cave under the floor is not water in the passage', () => {
  const runs = { 0: [TUNNEL], 1: [[56, 57], TUNNEL] }
  assert.strictEqual(layers(runs, [[1, 64]])[1].water, true, 'control: water in the tunnel')
  assert.strictEqual(layers(runs, [[1, 56]])[1].water, false)
})

test('the passage ends at a column whose open cells do not join it', () => {
  const cols = layers({ 0: [TUNNEL], 1: [TUNNEL], 2: [[56, 57]] })
  assert.strictEqual(cols[2].lo, null)
})

test('a passage that steps down is followed below the body\'s level', () => {
  const cols = layers({ 0: [[64, 66]], 1: [[63, 65]], 2: [[62, 64]], 3: [[61, 63]] })
  assert.strictEqual(floorPhrase(cols, O.y), 'floor: level d0, down 1 at d1, down 2 at d2, down 3 at d3')
})

// Air at x 0..2, y 64..65, z 0 in stone all round, every open cell at light level light.
function closedRoom (light, yaw = 0) {
  const air = (p) => p.x >= 0 && p.x <= 2 && p.z === 0 && (p.y === 64 || p.y === 65)
  return {
    bot: {
      entity: { position: new Vec3(0.5, 64, 0.5), yaw },
      blockAt: (p) => (air(p) ? { name: 'air', boundingBox: 'empty', light, skyLight: 0 } : { name: 'stone', boundingBox: 'block', light: 0, skyLight: 0 }),
      time: { timeOfDay: 6000 },
      game: { minY: -64, height: 384 }
    },
    ck: (x, y, z) => x + ',' + y + ',' + z,
    Vec3,
    sectionColumns,
    floorPhrase,
    SEEN: new Set(),
    ESTIMATED_LIGHT: new Map(),
    SIGHT_MEMO: { t: 0, cells: new Map() },
    SIGHT_MS: botConstant('SIGHT_MS')
  }
}

test('the section of a lit closed room underground reads its floor and where it seals', () => {
  const body = runRoute('/section', { dir: 'e' }, closedRoom(15))
  assert.strictEqual(body.summary, 'Section E from (0,64,0): floor: level d0–2; headroom 2; sealed from d3.')
})

test('the section of the same room in total darkness knows only the cells within two blocks', () => {
  const body = runRoute('/section', { dir: 'e' }, closedRoom(0))
  assert.strictEqual(body.summary, 'Section E from (0,64,0): floor: level d0–1, floor unknown at d2; headroom 2; out of sight from d3.')
})

test('the section without a dir runs the way the bot faces', () => {
  const DIR = { '0,-1': 'n', '0,1': 's', '1,0': 'e', '-1,0': 'w' }
  for (const { name, yaw, step } of facings()) {
    const faced = runRoute('/section', {}, closedRoom(15, yaw)).summary
    assert.strictEqual(faced, runRoute('/section', { dir: DIR[step.join()] }, closedRoom(15, yaw)).summary, `facing ${name}`)
  }
})
