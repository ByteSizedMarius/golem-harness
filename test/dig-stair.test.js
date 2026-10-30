'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { digJob, facings, awaitRoute, botConstant, loadBotFunctions, claimRescue, routeJobs } = require('./helpers')
const { ROUTE_BOUNDS } = require('../lib/bounds')

const UP_EAST = { dir: 'e', up: '1', steps: '2', torch: '0' }
const PICK_TYPE = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3 }
const FALLS = new Set(['gravel', 'sand', 'red_sand'])
const FALL_TICKS = botConstant('FALL_TICKS')
const FALL_START_TICKS = botConstant('FALL_START_TICKS')

// Ticks after the dig under it that a 1.7.10 falling block lands d cells down: it starts falling 2 ticks after the dig,
// then gains 0.04 of speed and keeps 0.98 of it each tick.
function landsAfter (d) {
  let bottom = 0.01
  let v = 0
  for (let t = 1; ; t++) {
    v -= 0.04
    if (bottom + v <= -d) return t + 1
    bottom += v
    v *= 0.98
  }
}

// Runs route for a body at (0, 64, 0) in stone, each pick breaking after its uses digs, and returns the result with the cells dug, the mine event texts and the feet cell it ends in.
// The server's update of the held slot follows each dig after lag ms.
// With legacy the server answers each dig after 2 ms, and resends a block dug without a pick that has uses left after 30 ms.
// canStepOutTo is the bot's own over a world the body knows and sees in full.
// nudgeInto refuses a move the body's head or feet would sweep through a solid cell on.
// The job gets cancelled during the dig of the cell cancelOn names, and at the dig of the cell busyOn names the buried self-rescue takes the dig lock.
// Gravel and sand over open cells fall at the start of each dig, wait and step, or with slow only during a step.
// The gravel and sand in the cells hung names never fall.
// With flight, gravel and sand over an open cell start falling 2 ticks after the cell opens, as a falling_block that lands
// flight(cells it falls) ticks later, under counts the steps into a cell something falls into, and the tread fill sets a
// gravel block falling from the cell fillDrop names. The blocks landOnStep names land as the next step starts.
async function watchedDig (route, query, { open = () => false, blocks = {}, picks = [{ name: 'iron_pickaxe' }], seen = () => true, lag = 0, legacy = false, cancelOn = null, busyOn = null, slow = false, flight = null, fillDrop = null, landOnStep = {}, hung = [] } = {}) {
  const key = (p) => `${p.x},${p.y},${p.z}`
  const cell = (k) => new Vec3(...k.split(',').map(Number))
  const opened = new Set(['0,64,0', '0,65,0'])
  const fallen = new Map()
  const isOpen = (p) => !fallen.has(key(p)) && (opened.has(key(p)) || open(p))
  const nameAt = (p) => fallen.get(key(p)) || (isOpen(p) ? 'air' : blocks[key(p)] || 'stone')
  const lowest = (p) => { let to = p; while (isOpen(to.offset(0, -1, 0))) to = to.offset(0, -1, 0); return to }
  const settle = () => {
    const fally = [...new Set([...Object.keys(blocks), ...fallen.keys()])].map(cell)
      .filter((p) => FALLS.has(nameAt(p)) && !hung.includes(key(p))).sort((a, b) => a.y - b.y)
    for (const p of fally) {
      const to = lowest(p)
      if (to.equals(p)) continue
      const name = nameAt(p)
      fallen.delete(key(p))
      opened.add(key(p))
      fallen.set(key(to), name)
    }
  }
  let tick = 0
  const flying = []
  const hangs = new Map()
  const under = []
  const hanging = () => [...new Set([...Object.keys(blocks), ...fallen.keys()])].map(cell)
    .filter((p) => FALLS.has(nameAt(p)) && !hung.includes(key(p)) && isOpen(p.offset(0, -1, 0))).sort((a, b) => a.y - b.y)
  const notice = () => {
    const now = new Set(hanging().map(key))
    for (const k of hangs.keys()) if (!now.has(k)) hangs.delete(k)
    for (const k of now) if (!hangs.has(k)) hangs.set(k, tick)
  }
  // A block falling in the same column below lands first and shortens the fall.
  const drop = (p, block) => {
    const below = flying.filter((e) => e.from.x === p.x && e.from.z === p.z && e.from.y < p.y).length
    flying.push({ name: 'falling_block', block, from: p, position: new Vec3(p.x + 0.5, p.y, p.z + 0.5), due: tick + flight(p.y - lowest(p).y - below) })
  }
  const tickOnce = () => {
    tick++
    for (const e of flying.filter((e) => e.due <= tick).sort((a, b) => a.from.y - b.from.y)) {
      flying.splice(flying.indexOf(e), 1)
      fallen.set(key(lowest(e.from)), e.block)
    }
    notice()
    for (const p of hanging()) {
      if (tick - hangs.get(key(p)) < 2) continue
      const block = nameAt(p)
      fallen.delete(key(p))
      opened.add(key(p))
      drop(p, block)
    }
    notice()
  }
  const fallsOn = (c) => flying.some((e) => e.from.x === c.x && e.from.z === c.z && e.from.y >= c.y) || hanging().some((p) => p.x === c.x && p.z === c.z && p.y > c.y)
  const digLock = botConstant('digLock')
  const items = picks.map((p, i) => ({ uses: Infinity, slot: 36 + i, type: PICK_TYPE[p.name], ...p }))
  const dug = []
  const events = []
  const fills = []
  const state = { cancelled: false, progress () {} }
  const inventory = Object.assign(new EventEmitter(), { emptySlotCount: () => 30, items: () => items })
  Object.defineProperty(inventory, 'slots', { get: () => { const s = new Array(46).fill(null); for (const it of items) s[it.slot] = it; return s } })
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    heldItem: null,
    inventory,
    async equip (item) { bot.heldItem = item },
    blockAt: (p) => {
      const name = nameAt(p)
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], position: p, skyLight: 0 }
    },
    async waitForTicks (n) {
      if (flight) for (let i = 0; i < n; i++) tickOnce()
      else {
        tick += n
        if (!slow) settle()
      }
    },
    async dig (b) {
      if (!slow && !flight) settle()
      dug.push(key(b.position))
      if (key(b.position) === busyOn) {
        claimRescue(digLock)
        loadBotFunctions(['digBusy'], { digLock }).digBusy()
      }
      fallen.delete(key(b.position))
      opened.add(key(b.position))
      if (flight) notice()
      if (key(b.position) === cancelOn) state.cancelled = true
      const held = bot.heldItem
      const refused = !(held && held.uses > 0)
      if (legacy) {
        setTimeout(() => {
          if (refused) opened.delete(key(b.position))
          bot.emit(`blockUpdate:${b.position}`, null, bot.blockAt(b.position))
        }, refused ? 30 : 2)
      }
      if (refused) return
      const broke = --held.uses === 0
      const wear = () => {
        if (broke) { items.splice(items.indexOf(held), 1); if (bot.heldItem === held) bot.heldItem = null }
        bot.inventory.emit('updateSlot', held.slot, held, broke ? null : held)
      }
      if (lag) setTimeout(wear, lag)
      else wear()
    }
  })
  const NEIGHBOURS = botConstant('NEIGHBOURS')
  let job = null
  await awaitRoute(route, query, {
    bot,
    require,
    NEIGHBOURS,
    PICK_TIER: botConstant('PICK_TIER'),
    LEGACY_1710: legacy,
    LEGACY_DIG_CONFIRM_MS: botConstant('LEGACY_DIG_CONFIRM_MS'),
    digLock,
    bunker: { building: false },
    jobs: { start: (n, fn) => { job = fn(state); return { id: 1 } } },
    emitEvent: (kind, text) => { if (kind === 'mine') events.push(text) },
    refuseWhileBuilding () {},
    fillFrom: async (p) => {
      fills.push(key(p))
      if (fillDrop) drop(cell(fillDrop), 'gravel')
      fillDrop = null
      return null
    },
    macroPlaceAt: async () => ({}),
    nudgeInto: async (to) => {
      for (const [k, name] of Object.entries(landOnStep)) fallen.set(k, name)
      landOnStep = {}
      if (flight && fallsOn(to)) under.push(key(to))
      if (!flight) settle()
      const from = bot.entity.position.floored()
      const swept = [to, to.offset(0, 1, 0), ...(to.y < from.y ? [to.offset(0, 2, 0)] : []), ...(to.y > from.y ? [from.offset(0, 2, 0)] : [])]
      if (!swept.every(isOpen)) return false
      bot.entity.position = new Vec3(to.x + 0.5, to.y, to.z + 0.5)
      return true
    },
    canStepOutTo: loadBotFunctions(['canStepOutTo'], { bot, knownCell: () => true, seenNow: () => true }).canStepOutTo,
    knownCell: () => false,
    skyInSight: () => false,
    lightRange: () => Infinity,
    seesLit: (p) => seen(p) && NEIGHBOURS.some(([dx, dy, dz]) => isOpen(p.offset(dx, dy, dz))),
    liveEntities: () => flying,
    FALL_TICKS,
    FALL_START_TICKS,
    setTimeout,
    clearTimeout
  })
  const result = await job
  const listeners = bot.eventNames().filter((n) => String(n).startsWith('blockUpdate:')).length + bot.inventory.listenerCount('updateSlot')
  return { ...result, dug, events, fills, listeners, at: key(bot.entity.position.floored()), ticks: tick, under }
}

const breaches = (r) => r.events.filter((t) => t.startsWith('breached'))

test('dig_stair stops once its last pick breaks', async () => {
  const r = await watchedDig('/dig_stair', UP_EAST, { picks: [{ name: 'stone_pickaxe', uses: 5 }] })
  assert.strictEqual(r.stopped, 'no pickaxe left (tool broke)')
  assert.deepStrictEqual(r.dug, ['0,66,0', '1,67,0', '1,66,0', '1,65,0', '2,68,0'], 'dug on after the pick broke')
})

test('dig_stair cancelled during a passage dig digs no further passage cell', async () => {
  const r = await watchedDig('/dig_stair', UP_EAST, { cancelOn: '1,67,0' })
  assert.deepStrictEqual([r.stopped, r.dug], ['cancelled', ['0,66,0', '1,67,0']])
})

test('dig_stair stops on a pick the server breaks 100 ms after the dig', async () => {
  const r = await watchedDig('/dig_stair', UP_EAST, { lag: 100, picks: [{ name: 'stone_pickaxe', uses: 1, maxDurability: 131, durabilityUsed: 131 }] })
  assert.strictEqual(r.stopped, 'no pickaxe left (tool broke)')
  assert.deepStrictEqual(r.dug, ['0,66,0'], 'dug on with the broken pick')
})

// The first pick breaks on the first dig.
const BREAKS = [{ name: 'stone_pickaxe', uses: 1 }, { name: 'stone_pickaxe' }]

test('on 1.7.10 dig_stair digs a block the server resent to a broken pick again with the spare, and names the swap', async () => {
  const r = await watchedDig('/dig_stair', UP_EAST, { legacy: true, lag: 10, picks: BREAKS })
  assert.strictEqual(r.stopped, 'steps done')
  assert.deepStrictEqual(r.dug, ['0,66,0', '1,67,0', '1,67,0', '1,66,0', '1,65,0', '2,68,0', '2,67,0', '2,66,0'])
  assert.deepStrictEqual(r.events.filter((t) => t.includes('swapped')), ['stone_pickaxe broke, swapped to stone_pickaxe'])
  assert.strictEqual(r.listeners, 0, 'a listener outlived the job')
})

test('on 1.7.10 dig_stair stops on a block the server resends after the second dig too', async () => {
  const r = await watchedDig('/dig_stair', UP_EAST, { legacy: true, lag: 200, picks: BREAKS })
  assert.strictEqual(r.stopped, 'the server resent the stone at 1,67,0 after a second dig holding stone_pickaxe')
  assert.deepStrictEqual(r.dug, ['0,66,0', '1,67,0', '1,67,0'])
  assert.strictEqual(r.listeners, 0, 'a listener outlived the job')
})

// Going up east one step from (0, 64, 0), the open cell at (1, 67, 1) shows once the passage's top cell is dug.
test('dig_stair names open air a dig lays bare in sight', async () => {
  const r = await watchedDig('/dig_stair', { ...UP_EAST, steps: '1' }, { open: (p) => p.x === 1 && p.y === 67 && p.z === 1 })
  assert.deepStrictEqual(breaches(r), ['breached open air at 1,67,1'])
})

test('dig_stair down from open ground names none of the open air it starts in', async () => {
  const r = await watchedDig('/dig_stair', { ...UP_EAST, up: '0', steps: '3' }, { open: (p) => p.y >= 64 })
  assert.deepStrictEqual([r.stopped, r.endY], ['steps done', 61])
  assert.ok(r.dug.includes('3,63,0'), 'control: the stair dug no cell beside the open ground')
  assert.deepStrictEqual(breaches(r), [])
})

test('dig_stair carves at most the 24 steps its tool schema allows', async () => {
  assert.deepStrictEqual(ROUTE_BOUNDS['/dig_stair'].steps, [1, 24])
  const r = await digJob('/dig_stair', { ...UP_EAST, steps: '30' })
  assert.deepStrictEqual([r.name, r.climbed], ['dig_stair up e x24', 24])
})

test('dig_stair carves its steps up or down and fills a missing step from filler', async () => {
  const up = await digJob('/dig_stair', UP_EAST)
  assert.deepStrictEqual([up.stopped, up.climbed, up.endY], ['steps done', 2, 66])
  assert.deepStrictEqual(up.dug, ['0,66,0', '1,67,0', '1,66,0', '1,65,0', '2,68,0', '2,67,0', '2,66,0'])
  assert.deepStrictEqual(up.fills, [])

  const down = await digJob('/dig_stair', { ...UP_EAST, up: '0' }, { air: ['0,64,0', '0,65,0', '1,62,0'] })
  assert.deepStrictEqual([down.stopped, down.climbed, down.endY], ['steps done', -2, 62])
  assert.deepStrictEqual(down.dug, ['1,65,0', '1,64,0', '1,63,0', '2,64,0', '2,63,0', '2,62,0'])
  assert.deepStrictEqual(down.fills, ['1,62,0'], 'the missing tread under the first step down')
})

test('dig_stair without a dir climbs and is named the way the bot faces', async () => {
  const DIR = { '0,-1': 'n', '0,1': 's', '1,0': 'e', '-1,0': 'w' }
  for (const { name, yaw, step: [dx, dz] } of facings()) {
    const r = await digJob('/dig_stair', { up: '1', steps: '1', torch: '0' }, { yaw })
    assert.deepStrictEqual(r.dug, ['0,66,0', `${dx},67,${dz}`, `${dx},66,${dz}`, `${dx},65,${dz}`], `facing ${name}`)
    assert.strictEqual(r.name, `dig_stair up ${DIR[[dx, dz].join()]} x1`, `facing ${name}`)
  }
})

test('dig_stair up stops where the sky shows, at any height', async () => {
  const deep = await digJob('/dig_stair', { ...UP_EAST, steps: '6' })
  assert.deepStrictEqual([deep.stopped, deep.endY], ['steps done', 70], 'no sky in sight')
  const r = await digJob('/dig_stair', { ...UP_EAST, steps: '6' }, { sky: (p) => p.y >= 67 })
  assert.deepStrictEqual([r.stopped, r.endY], ['sky in sight', 67])
})

test('dig_stair counts no cave air as dug', async () => {
  const up = await digJob('/dig_stair', UP_EAST, { blocks: { '1,66,0': 'cave_air', '2,68,0': 'cave_air' } })
  assert.deepStrictEqual([up.stopped, up.climbed, up.endY], ['steps done', 2, 66])
  assert.deepStrictEqual(up.dug, ['0,66,0', '1,67,0', '1,65,0', '2,67,0', '2,66,0'])
})

// Going up east from (0, 64, 0), the second dig is the passage's top cell at (1, 67, 0).
test('dig_stair names gravel over its passage only once a dig lays it bare', async () => {
  const gravel = { blocks: { '1,67,0': 'gravel', '1,68,0': 'gravel' } }
  const seen = await watchedDig('/dig_stair', UP_EAST, { ...gravel, open: (p) => p.x === 2 && p.y === 67 && p.z === 0 })
  assert.match(seen.stopped, /gravel/, 'control: gravel in sight in the passage stops the stair')
  assert.deepStrictEqual(seen.dug, [], 'control: dug under gravel in sight')

  const r = await digJob('/dig_stair', UP_EAST, gravel)
  assert.deepStrictEqual(r.dug, ['0,66,0', '1,67,0'], 'the stair stopped before the dig that laid the gravel bare')
  assert.match(r.stopped, /^gravel falling from 1,68,0\b/)
})

// Going up east from (0, 64, 0), the first dig is the launch cell at (0, 66, 0) under the gravel.
const GRAVEL_OVER_LAUNCH = { '0,67,0': 'gravel' }

test('dig_stair up stops on gravel the launch dig lays bare and steps back down to the cell behind', async () => {
  const behind = (p) => p.x === -1 && p.z === 0 && p.y >= 63 && p.y <= 65
  const r = await watchedDig('/dig_stair', UP_EAST, { blocks: GRAVEL_OVER_LAUNCH, open: behind })
  assert.deepStrictEqual([r.stopped, r.dug, r.at], ['gravel falling from 0,67,0, stopping, stepped back to -1,63,0', ['0,66,0'], '-1,63,0'])
})

test('dig_stair up steps back down only where the head clears the cell over the one behind', async () => {
  const behind = (p) => p.x === -1 && p.z === 0 && (p.y === 63 || p.y === 64)
  const r = await watchedDig('/dig_stair', UP_EAST, { blocks: GRAVEL_OVER_LAUNCH, open: behind })
  assert.deepStrictEqual([r.stopped, r.at], ['gravel falling from 0,67,0, stopping', '0,64,0'])
})

test('dig_stair up with anyway stops on what the launch dig sets falling onto the body and leaves it to the self-rescue', async () => {
  const flight = (d) => landsAfter(d) - 2
  for (const [blocks, stopped] of [[GRAVEL_OVER_LAUNCH, 'gravel fell onto me'], [{ '0,67,0': 'sand', '0,68,0': 'gravel' }, 'sand fell onto me']]) {
    const r = await watchedDig('/dig_stair', { ...UP_EAST, anyway: '1' }, { blocks, flight })
    assert.deepStrictEqual([r.stopped, r.dug, r.at], [stopped, ['0,66,0', '1,67,0', '1,66,0', '1,65,0'], '0,64,0'], JSON.stringify(blocks))
  }
})

// Going down east from (0, 64, 0), the first dig is the cell at (1, 65, 0) under the gravel, and the step back is a climb to (-1, 65, 0).
test('dig_stair down climbs back only where the cell over its own head is open', async () => {
  const blocks = { '1,66,0': 'gravel' }
  const behind = (p) => p.x === -1 && p.z === 0 && (p.y === 65 || p.y === 66)
  const open = await watchedDig('/dig_stair', { ...UP_EAST, up: '0' }, { blocks, open: (p) => behind(p) || (p.x === 0 && p.y === 66 && p.z === 0) })
  assert.deepStrictEqual([open.stopped, open.at], ['gravel falling from 1,66,0, stopping, stepped back to -1,65,0', '-1,65,0'], 'control')
  const rock = await watchedDig('/dig_stair', { ...UP_EAST, up: '0' }, { blocks, open: behind })
  assert.deepStrictEqual([rock.stopped, rock.at], ['gravel falling from 1,66,0, stopping', '0,64,0'])
})

// digJob sees a block beside open air, here the gravel over the launch cell through the air at 0,68,0.
const LAUNCH_IN_SIGHT = { air: ['0,64,0', '0,65,0', '0,68,0'], blocks: GRAVEL_OVER_LAUNCH }

test('dig_stair up stops short of gravel in sight over its launch cell naming anyway', async () => {
  const r = await digJob('/dig_stair', UP_EAST, LAUNCH_IN_SIGHT)
  assert.match(r.stopped, /^gravel overhead.*\banyway\b/)
  assert.deepStrictEqual(r.dug, [])
})

// Going up east from (0, 64, 0), the passage's top cell at (1, 67, 0) is gravel under more gravel, in sight through the air at (1, 67, 1).
const PASSAGE_GRAVEL = { blocks: { '1,67,0': 'gravel', '1,68,0': 'gravel' }, open: (p) => p.x === 1 && p.y === 67 && p.z === 1 }

test('dig_stair stops short of gravel in sight in its passage, and with anyway digs out what falls in', async () => {
  const r = await watchedDig('/dig_stair', UP_EAST, PASSAGE_GRAVEL)
  assert.match(r.stopped, /^gravel overhead\b.*, anyway digs through$/)
  assert.deepStrictEqual(r.dug, [])
  const through = await watchedDig('/dig_stair', { ...UP_EAST, anyway: '1' }, PASSAGE_GRAVEL)
  assert.deepStrictEqual([through.stopped, through.dug, through.at], ['steps done', ['0,66,0', '1,67,0', '1,66,0', '1,65,0', '1,65,0', '2,68,0', '2,67,0', '2,66,0'], '2,66,0'])
  assert.match(through.events.at(-1), /^dig_stair up done: climbed 2, dug 8,/)
})

test('dig_stair names the gravel that fell into its way when the climb stalls', async () => {
  const r = await watchedDig('/dig_stair', { ...UP_EAST, anyway: '1' }, { landOnStep: { '1,65,0': 'gravel' } })
  assert.deepStrictEqual([r.stopped, r.at], ['cannot climb: gravel fell into 1,65,0', '0,64,0'])
})

test('dig_stair with anyway stops where gravel keeps hanging over its passage', async () => {
  const r = await watchedDig('/dig_stair', { ...UP_EAST, anyway: '1' }, { ...PASSAGE_GRAVEL, slow: true })
  assert.deepStrictEqual([r.stopped, r.at, r.ticks], [`gravel at 1,68,0 still falling after ${FALL_TICKS} ticks, stopping`, '0,64,0', FALL_TICKS])
})

// Going up east from (0, 64, 0), the passage's top cell at (1, 67, 0) is open, and 1.7.10 starts gravel falling only when
// a neighbour changes, so the gravel at (1, 68, 0) over it stays put.
test('dig_stair steps under gravel hanging over a passage cell it did not open', async () => {
  const cave = { blocks: { '1,68,0': 'gravel' }, open: (p) => p.x === 1 && p.y === 67 && p.z === 0, hung: ['1,68,0'] }
  for (const anyway of ['0', '1']) {
    const r = await watchedDig('/dig_stair', { ...UP_EAST, steps: '1', anyway }, cave)
    assert.deepStrictEqual([r.stopped, r.dug, r.at], ['steps done', ['0,66,0', '1,66,0', '1,65,0'], '1,65,0'], `anyway=${anyway}`)
  }
})

// Going up east from (0, 64, 0), the missing tread at (1, 64, 0) sits under the passage and a shaft over it.
test('dig_stair steps on only once a block that starts falling during the tread fill landed', async () => {
  const shaft = (p) => p.x === 1 && p.z === 0 && (p.y === 64 || p.y >= 68)
  const flight = (d) => landsAfter(d) - 2
  const r = await watchedDig('/dig_stair', { ...UP_EAST, steps: '1' }, { open: shaft, flight, fillDrop: '1,72,0' })
  assert.deepStrictEqual([r.stopped, r.fills, r.under, r.ticks], ['steps done', ['1,64,0'], [], flight(8) + FALL_START_TICKS])
})

// Going down east from (0, 64, 0), the gravel at (1, 66, 0) over the passage falls 4 cells into the missing tread at (1, 62, 0).
test('dig_stair down with anyway steps on only once the gravel falling through its passage landed', async () => {
  const r = await watchedDig('/dig_stair', { ...UP_EAST, up: '-1', steps: '1', anyway: '1' }, { blocks: { '1,66,0': 'gravel' }, open: (p) => p.x === 1 && p.y === 62 && p.z === 0, flight: (d) => landsAfter(d) - 2 })
  assert.deepStrictEqual([r.stopped, r.at, r.under, r.ticks], ['steps done', '1,63,0', [], landsAfter(4)])
})

test('dig_stair down without anyway steps on only once gravel it cannot see falling through its passage landed', async () => {
  const r = await watchedDig('/dig_stair', { ...UP_EAST, up: '-1', steps: '1' }, { blocks: { '1,66,0': 'gravel' }, open: (p) => p.x === 1 && p.y === 62 && p.z === 0, seen: (p) => !(p.x === 1 && p.y === 66 && p.z === 0), flight: (d) => landsAfter(d) - 2 })
  assert.deepStrictEqual([r.stopped, r.at, r.under, r.ticks], ['steps done', '1,63,0', [], landsAfter(4)])
})

// Going up east from (0, 64, 0) the gravel at (1, 68, 0) falls through the passage onto the tread, and going down the
// gravel at (1, 66, 0) does.
test('dig_stair without anyway stops on gravel it could not see that fell into its way and digs nothing more', async () => {
  const flight = (d) => landsAfter(d) - 2
  const up = await watchedDig('/dig_stair', UP_EAST, { blocks: { '1,68,0': 'gravel' }, seen: (p) => !(p.x === 1 && p.y === 68 && p.z === 0), flight })
  assert.deepStrictEqual([up.stopped, up.dug, up.at], ['cannot climb: gravel fell into 1,65,0', ['0,66,0', '1,67,0', '1,66,0', '1,65,0'], '0,64,0'])
  const unseen = (p) => !(p.x === 1 && p.z === 0 && (p.y === 66 || p.y === 63))
  const dark = await watchedDig('/dig_stair', { ...UP_EAST, up: '-1' }, { blocks: { '1,66,0': 'gravel' }, seen: unseen, flight })
  assert.deepStrictEqual([dark.stopped, dark.dug, dark.at], ['cannot descend: nudge stalled at 64', ['1,65,0', '1,64,0', '1,63,0'], '0,64,0'], 'control: gravel out of sight in the feet cell')
  const down = await watchedDig('/dig_stair', { ...UP_EAST, up: '-1' }, { blocks: { '1,66,0': 'gravel' }, seen: (p) => !(p.x === 1 && p.y === 66 && p.z === 0), flight })
  assert.deepStrictEqual([down.stopped, down.dug, down.at], ['cannot descend: gravel fell into 1,63,0', ['1,65,0', '1,64,0', '1,63,0'], '0,64,0'])
})

test('dig_stair names the buried self-rescue whole when it takes the dig lock mid-job', async () => {
  const r = await watchedDig('/dig_stair', UP_EAST, { busyOn: '1,67,0' })
  assert.strictEqual(r.stopped, 'busy: the buried self-rescue is running, nothing dug')
})

test('dig_stair during the buried self-rescue answers busy naming it and starts no job', async () => {
  const env = { bot: { entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 } }, require, bunker: { building: false }, digLock: botConstant('digLock') }
  assert.deepStrictEqual((await routeJobs('/dig_stair', UP_EAST, env)).started, ['dig_stair up e x2'], 'control: no rescue')
  claimRescue(env.digLock)
  const r = await routeJobs('/dig_stair', UP_EAST, env)
  assert.deepStrictEqual([r.error && r.error.reason, r.started], ['busy', []])
  assert.match(r.error.message, /^busy: the buried self-rescue is running\b/)
})
