'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { digJob, facings, awaitRoute, botConstant, claimRescue, loadBotFunctions, routeJobs } = require('./helpers')

const EAST = { dir: 'e', length: '2', torch: '0' }

// why is what fillFrom answers for the open floor cell at 1,63,0, null when the fill works.
async function tunnelOverGap (why) {
  const key = (p) => `${p.x},${p.y},${p.z}`
  const open = new Set(['0,64,0', '0,65,0', '1,63,0'])
  const air = (p) => open.has(key(p))
  const dug = []
  const steps = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    inventory: { emptySlotCount: () => 30 },
    blockAt: (p) => ({ name: air(p) ? 'air' : 'stone', boundingBox: air(p) ? 'empty' : 'block', position: p, skyLight: 0 }),
    async waitForTicks () {},
    async dig (b) { dug.push(key(b.position)); open.add(key(b.position)) }
  }
  const NEIGHBOURS = botConstant('NEIGHBOURS')
  let job = null
  await awaitRoute('/dig_tunnel', EAST, {
    bot,
    require,
    NEIGHBOURS,
    LEGACY_1710: false,
    digLock: botConstant('digLock'),
    bunker: { building: false },
    jobs: { start: (name, fn) => { job = fn({ cancelled: false, progress () {} }); return { id: 1 } } },
    emitEvent () {},
    refuseWhileBuilding () {},
    equipPickFor: async () => {},
    fillFrom: async () => why,
    macroPlaceAt: async () => ({}),
    nudgeInto: async (cell) => { steps.push(key(cell)); bot.entity.position = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5); return true },
    knownCell: () => false,
    seesLit: (p) => NEIGHBOURS.some(([dx, dy, dz]) => air(p.offset(dx, dy, dz))),
    liveEntities: () => [],
    FALL_TICKS,
    FALL_START_TICKS,
    ck: botConstant('ck'),
    sameVein: require('../lib/wake').sameVein,
    shared: {},
    ORE_IDS: botConstant('ORE_IDS')
  })
  return { ...(await job), dug, steps }
}

const NO_BOX = new Set(['air', 'cave_air', 'seagrass', 'kelp', 'kelp_plant', 'bubble_column'])
const FALLS = new Set(['gravel', 'sand', 'red_sand'])
const PICK_TYPE = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3 }
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
// The ticks a 1.7.10 falling block d cells over its floor stays in the air.
const AIRBORNE = (d) => landsAfter(d) - 2

// Runs route for a body at (0, 64, 0) in stone, each pick breaking after its uses digs, and returns the result with the cells dug, the mine event texts and the feet cell it ends in.
// The server's update of the held slot follows each dig after lag ms.
// With legacy the server answers each dig after 2 ms, and resends a block dug without a pick that has uses left after 30 ms.
// Each step into the next cell takes nudgeMs.
// stepOut answers canStepOutTo, by default true for open feet and head cells over a solid floor.
// The job gets cancelled during the dig of the cell cancelOn names or during the dig cancelAt counts, and a step whose route is stopped fails.
// The dig of the cell abortOn names throws without digging it, and of the cell busyOn names the buried self-rescue takes the dig lock.
// The dig of the cell rescueOn names starts the buried self-rescue, which takes the dig lock without refusing that dig.
// Gravel and sand over open cells fall at the start of each dig, wait and step, or with slow only during a step. Water flows down with them.
// The gravel and sand in the cells hung names never fall.
// With flight, gravel and sand over an open cell start falling 2 ticks after the cell opens, as a falling_block that lands
// flight(cells it falls) ticks later, under counts the steps into a cell something falls into, and the floor fill sets a
// gravel block falling from the cell fillDrop names. The blocks landOnStep names land as the next step starts.
async function watchedDig (route, query, { open = () => false, blocks = {}, picks = [{ name: 'iron_pickaxe' }], seen = () => true, unlit = [], lag = 0, legacy = false, nudgeMs = 0, stepOut = null, cancelOn = null, cancelAt = null, abortOn = null, busyOn = null, rescueOn = null, slow = false, flight = null, fillDrop = null, landOnStep = {}, hung = [] } = {}) {
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
    for (let flowed = true; flowed;) {
      flowed = false
      for (const p of [...Object.keys(blocks), ...fallen.keys()].map(cell)) {
        if (nameAt(p) === 'water' && isOpen(p.offset(0, -1, 0))) { fallen.set(key(p.offset(0, -1, 0)), 'water'); flowed = true }
      }
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
      return { name, boundingBox: NO_BOX.has(name) ? 'empty' : 'block', position: p, skyLight: 0 }
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
      if (key(b.position) === cancelOn || dug.length === cancelAt) state.cancelled = true
      if (key(b.position) === rescueOn) claimRescue(digLock)
      if (key(b.position) === abortOn) throw new Error('Digging aborted')
      if (key(b.position) === busyOn) {
        claimRescue(digLock)
        loadBotFunctions(['digBusy'], { digLock }).digBusy()
      }
      fallen.delete(key(b.position))
      opened.add(key(b.position))
      if (flight) notice()
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
    nudgeInto: async (to, climbing, timeoutMs, route = null) => {
      if (route && route.stopped()) return false
      for (const [k, name] of Object.entries(landOnStep)) fallen.set(k, name)
      landOnStep = {}
      if (flight && fallsOn(to)) under.push(key(to))
      if (!flight) settle()
      if (nudgeMs) await new Promise((resolve) => setTimeout(resolve, nudgeMs))
      if ([to, to.offset(0, 1, 0)].some((p) => bot.blockAt(p).boundingBox === 'block')) return false
      bot.entity.position = new Vec3(to.x + 0.5, to.y, to.z + 0.5)
      return true
    },
    canStepOutTo: stepOut || ((c) => isOpen(c) && isOpen(c.offset(0, 1, 0)) && !isOpen(c.offset(0, -1, 0))),
    knownCell: () => false,
    skyInSight: () => false,
    lightRange: (p) => (unlit.includes(key(p)) ? 4 : Infinity),
    seesLit: (p) => seen(p) && NEIGHBOURS.some(([dx, dy, dz]) => isOpen(p.offset(dx, dy, dz))),
    liveEntities: () => flying,
    FALL_TICKS,
    FALL_START_TICKS,
    ck: botConstant('ck'),
    sameVein: require('../lib/wake').sameVein,
    shared: {},
    ORE_IDS: botConstant('ORE_IDS'),
    setTimeout,
    clearTimeout
  })
  const result = await job
  const listeners = bot.eventNames().filter((n) => String(n).startsWith('blockUpdate:')).length + bot.inventory.listenerCount('updateSlot')
  return { ...result, dug, events, fills, listeners, at: key(bot.entity.position.floored()), ticks: tick, under }
}

const breaches = (r) => r.events.filter((t) => t.startsWith('breached'))

test('dig_tunnel stops once its last pick breaks and digs on without one from the start', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, length: '4' }, { picks: [{ name: 'stone_pickaxe', uses: 3 }] })
  assert.strictEqual(r.stopped, 'no pickaxe left (tool broke)')
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0', '2,65,0'], 'dug on after the pick broke')
  assert.match(r.events.at(-1), /^tunnel done: dug 3, stopped=no pickaxe left \(tool broke\)/)

  const bare = await watchedDig('/dig_tunnel', EAST, { picks: [] })
  assert.strictEqual(bare.stopped, 'length reached', 'control: a tunnel begun without a pick stopped')
})

test('dig_tunnel stops on a pick the server breaks 100 ms after the dig', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { lag: 100, picks: [{ name: 'stone_pickaxe', uses: 1, maxDurability: 131, durabilityUsed: 131 }] })
  assert.strictEqual(r.stopped, 'no pickaxe left (tool broke)')
  assert.deepStrictEqual(r.dug, ['1,65,0'], 'dug on with the broken pick')
})

test('dig_tunnel stops at ore ahead its pick is too low for', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { picks: [{ name: 'wooden_pickaxe' }], blocks: { '1,64,0': 'iron_ore' } })
  assert.strictEqual(r.stopped, 'iron_ore at 1,64,0 needs pick tier 1 (stone_pickaxe or better), holding wooden_pickaxe')
  assert.deepStrictEqual(r.dug, ['1,65,0'])
})

// Going east one step from (0, 64, 0), the wall ore at (1, 64, 1) borders cells the body does not touch.
const WALL_ORE = { ...EAST, length: '1' }
const oreBeside = (cells, extra = {}) => ({ blocks: { '1,64,1': 'iron_ore' }, open: (p) => cells.includes(`${p.x},${p.y},${p.z}`), ...extra })

test('dig_tunnel names open air a dig lays bare in sight, and whether it is lit', async () => {
  const r = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside(['1,64,2']))
  assert.ok(r.dug.includes('1,64,1'), 'control: the wall ore was not dug')
  assert.deepStrictEqual(breaches(r), ['breached open air at 1,64,2'])

  const dark = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside(['1,64,2'], { unlit: ['1,64,2'] }))
  assert.deepStrictEqual(breaches(dark), ['breached open air at 1,64,2 (unlit)'])
})

test('dig_tunnel cancelled during a face dig digs no wall ore after it', async () => {
  const r = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside([], { cancelOn: '1,64,0' }))
  assert.deepStrictEqual([r.stopped, r.dug], ['cancelled', ['1,65,0', '1,64,0']])

  const control = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside([]))
  assert.ok(control.dug.includes('1,64,1'), 'control: the wall ore was not dug')
})

test('dig_tunnel cancelled during a head dig digs no feet cell', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { cancelOn: '1,65,0' })
  assert.deepStrictEqual([r.stopped, r.dug], ['cancelled', ['1,65,0']])
})

// The lava at (1, 64, 2) behind the wall ore lies open to the air at (1, 64, 3).
const LAVA_BEHIND_ORE = oreBeside(['1,64,3'], { blocks: { '1,64,1': 'iron_ore', '1,64,2': 'lava' } })

test('dig_tunnel fills nothing for a wall ore whose dig threw, and stops if the job was cancelled', async () => {
  const control = await watchedDig('/dig_tunnel', WALL_ORE, LAVA_BEHIND_ORE)
  assert.deepStrictEqual([control.stopped, control.fills], ['struck lava at 1,64,2, filled the hole back', ['1,64,1']], 'control: the bared lava was not filled')

  const thrown = await watchedDig('/dig_tunnel', WALL_ORE, { ...LAVA_BEHIND_ORE, abortOn: '1,64,1' })
  assert.deepStrictEqual([thrown.stopped, thrown.fills], ['length reached', []])

  const cancelled = await watchedDig('/dig_tunnel', WALL_ORE, { ...LAVA_BEHIND_ORE, abortOn: '1,64,1', cancelOn: '1,64,1' })
  assert.deepStrictEqual([cancelled.stopped, cancelled.fills], ['cancelled', []])
})

test('dig_tunnel stops naming the buried self-rescue when it aborts a wall ore dig', async () => {
  const thrown = await watchedDig('/dig_tunnel', EAST, oreBeside([], { abortOn: '1,64,1' }))
  assert.strictEqual(thrown.stopped, 'length reached', 'control: no rescue')
  const r = await watchedDig('/dig_tunnel', EAST, oreBeside([], { abortOn: '1,64,1', rescueOn: '1,64,1' }))
  assert.deepStrictEqual([r.stopped, r.dug], ['busy: the buried self-rescue is running, nothing dug', ['1,65,0', '1,64,0', '1,64,1']])
})

test('dig_tunnel names no open air it neither sees nor touches', async () => {
  const r = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside(['1,64,2'], { seen: (p) => !(p.x === 1 && p.y === 64 && p.z === 2) }))
  assert.ok(r.dug.includes('1,64,1'), 'control: the wall ore was not dug')
  assert.deepStrictEqual(breaches(r), [])
})

test('dig_tunnel names no water plant or bubble column as open air', async () => {
  for (const name of ['seagrass', 'kelp', 'kelp_plant', 'bubble_column']) {
    const r = await watchedDig('/dig_tunnel', WALL_ORE, { blocks: { '1,64,1': 'iron_ore', '1,64,2': name } })
    assert.ok(r.dug.includes('1,64,1'), 'control: the wall ore was not dug')
    assert.deepStrictEqual(breaches(r), [], name)
  }
})

test('dig_tunnel names two openings beside one dug cell in one event', async () => {
  const r = await watchedDig('/dig_tunnel', WALL_ORE, oreBeside(['1,63,1', '1,64,2']))
  assert.deepStrictEqual(breaches(r), ['breached open air at 1,63,1 and 1,64,2'])
})

test('dig_tunnel names none of the open air beside where it starts', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, length: '3' }, { open: (p) => p.z === 1 && (p.y === 64 || p.y === 65) })
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(breaches(r), [])
})

// The first pick breaks on the first dig.
const BREAKS = [{ name: 'stone_pickaxe', uses: 1 }, { name: 'stone_pickaxe' }]

test('on 1.7.10 dig_tunnel digs a block the server resent to a broken pick again with the spare, and names the swap', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { legacy: true, lag: 10, picks: BREAKS })
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0', '1,64,0', '2,65,0', '2,64,0'])
  assert.deepStrictEqual(r.events.filter((t) => t.includes('swapped')), ['stone_pickaxe broke, swapped to stone_pickaxe'])
  assert.strictEqual(r.listeners, 0, 'a listener outlived the job')
})

// The pick breaks on the step's second dig, and the server's slot update lands during the step after the dig's answer.
test('on 1.7.10 dig_tunnel names the swap for a break the server shows between two digs', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { legacy: true, lag: 10, nudgeMs: 20, picks: [{ name: 'stone_pickaxe', uses: 2 }, { name: 'stone_pickaxe' }] })
  assert.deepStrictEqual([r.stopped, r.dug], ['length reached', ['1,65,0', '1,64,0', '2,65,0', '2,64,0']], 'control: a dig was refused')
  assert.deepStrictEqual(r.events.filter((t) => t.includes('swapped')), ['stone_pickaxe broke, swapped to stone_pickaxe'])
})

test('on 1.21.11 dig_tunnel names the swap to a spare when its pick breaks', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { picks: BREAKS })
  assert.deepStrictEqual([r.stopped, r.dug], ['length reached', ['1,65,0', '1,64,0', '2,65,0', '2,64,0']], 'control: a dig was refused')
  assert.deepStrictEqual(r.events.filter((t) => t.includes('swapped')), ['stone_pickaxe broke, swapped to stone_pickaxe'])
})

test('on 1.7.10 dig_tunnel stops on a face or wall block the server resends after the second dig too', async () => {
  const face = await watchedDig('/dig_tunnel', EAST, { legacy: true, lag: 200, picks: BREAKS })
  assert.strictEqual(face.stopped, 'the server resent the stone at 1,64,0 after a second dig holding stone_pickaxe')
  assert.deepStrictEqual(face.dug, ['1,65,0', '1,64,0', '1,64,0'])
  assert.strictEqual(face.listeners, 0, 'a listener outlived the job')

  const wall = await watchedDig('/dig_tunnel', WALL_ORE, { legacy: true, lag: 200, picks: [{ name: 'stone_pickaxe', uses: 2 }], blocks: { '1,64,1': 'iron_ore' } })
  assert.strictEqual(wall.stopped, 'the server resent the iron_ore at 1,64,1 after a second dig holding stone_pickaxe')
  assert.deepStrictEqual(wall.dug, ['1,65,0', '1,64,0', '1,64,1', '1,64,1'])
})

test('dig_tunnel digs the face ahead into rock the bot knows nothing of', async () => {
  const r = await digJob('/dig_tunnel', EAST)
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0', '2,65,0', '2,64,0'])
})

test('dig_tunnel without a dir digs and is named the way the bot faces', async () => {
  const DIR = { '0,-1': 'n', '0,1': 's', '1,0': 'e', '-1,0': 'w' }
  for (const { name, yaw, step: [dx, dz] } of facings()) {
    const r = await digJob('/dig_tunnel', { length: '1', torch: '0' }, { yaw })
    assert.deepStrictEqual([r.dug, r.name], [[`${dx},65,${dz}`, `${dx},64,${dz}`], `dig_tunnel ${DIR[[dx, dz].join()]} x1`], `facing ${name}`)
  }
})

test('dig_tunnel counts no cave air as dug', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { blocks: { '1,65,0': 'cave_air', '2,64,0': 'cave_air' } })
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(r.dug, ['1,64,0', '2,65,0'])
})

test('dig_tunnel stops at bedrock and at a floor gap it cannot fill', async () => {
  const bedrock = await digJob('/dig_tunnel', EAST, { blocks: { '2,64,0': 'bedrock' } })
  assert.strictEqual(bedrock.stopped, 'hit bedrock')
  assert.deepStrictEqual(bedrock.dug, ['1,65,0', '1,64,0', '2,65,0'])

  const filled = await tunnelOverGap(null)
  assert.strictEqual(filled.stopped, 'length reached', 'control: the tunnel stopped at a filled gap')
  assert.deepStrictEqual(filled.steps, ['1,64,0', '2,64,0'], 'control: the tunnel did not step over a filled gap')

  const gap = await tunnelOverGap('no filler blocks carried')
  assert.strictEqual(gap.stopped, 'gap in floor, no filler blocks carried')
  assert.deepStrictEqual(gap.dug, ['1,65,0', '1,64,0'])
  assert.deepStrictEqual(gap.steps, [], 'stepped over the open floor')
})

test('dig_tunnel names lava behind unseen stone only once a dig lays it bare, and fills the hole back', async () => {
  const lava = { blocks: { '2,64,0': 'lava' } }
  const seen = await digJob('/dig_tunnel', EAST, { ...lava, air: ['0,64,0', '0,65,0', '3,64,0'] })
  assert.match(seen.stopped, /lava/, 'control: lava in sight ahead stops the tunnel')
  assert.deepStrictEqual(seen.dug, [], 'control: dug toward lava in sight')

  const r = await digJob('/dig_tunnel', EAST, lava)
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0'], 'the tunnel stopped before the dig that laid the lava bare')
  assert.match(r.stopped, /^struck lava at 2,64,0\b/)
  assert.deepStrictEqual(r.fills, ['1,64,0'], 'the hole onto the lava was not filled back')
})

test('dig_tunnel stops at water a dig lays bare and leaves the hole open', async () => {
  const r = await digJob('/dig_tunnel', EAST, { blocks: { '2,65,0': 'water' } })
  assert.deepStrictEqual(r.dug, ['1,65,0'])
  assert.match(r.stopped, /^struck water at 2,65,0\b/)
  assert.deepStrictEqual(r.fills, [])
})

// Going east from (0, 64, 0), the gravel at (1, 66, 0) sits over the face's head cell.
const GRAVEL_OVER_FACE = { blocks: { '1,66,0': 'gravel' } }

test('dig_tunnel stops on gravel a face dig lays bare over its head cell and digs nothing after', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, GRAVEL_OVER_FACE)
  assert.deepStrictEqual([r.stopped, r.dug, r.at], ['gravel falling from 1,66,0, stopping', ['1,65,0'], '0,64,0'])
})

// The gravel over the head cell ahead shows through the air at 1,67,0.
const FACE_IN_SIGHT = { open: (p) => p.x === 1 && p.y === 67 && p.z === 0, ...GRAVEL_OVER_FACE }

test('dig_tunnel stops short of gravel in sight over the head cell ahead naming anyway, and with anyway digs out what falls in', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, FACE_IN_SIGHT)
  assert.deepStrictEqual([r.stopped, r.dug], ['gravel overhead, stopping (would bury me), anyway digs through', []])
  const through = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, FACE_IN_SIGHT)
  assert.deepStrictEqual([through.stopped, through.dug, through.at], ['length reached', ['1,65,0', '1,64,0', '1,64,0', '2,65,0', '2,64,0'], '2,64,0'])
})

test('dig_tunnel with anyway stops after 8 digs of gravel that keeps falling into its passage', async () => {
  const blocks = {}
  for (let y = 66; y < 76; y++) blocks[`1,${y},0`] = 'gravel'
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { blocks })
  assert.strictEqual(r.stopped, 'gravel keeps falling into 1,65,0, stopped after 8 digs')
  assert.strictEqual(r.dug.length, 2 + 8)
  assert.match(r.events.at(-1), /^tunnel done: dug 10,/)
  const cancelled = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { blocks, cancelAt: 2 + 8 })
  assert.deepStrictEqual([cancelled.stopped, cancelled.dug.length], ['cancelled', 2 + 8], 'a cancel during the 8th re-dig')
})

test('dig_tunnel names the gravel that fell into its way when the step stalls', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { landOnStep: { '1,64,0': 'gravel' } })
  assert.deepStrictEqual([r.stopped, r.at], ['cannot advance: gravel fell into 1,64,0', '0,64,0'])
})

test('dig_tunnel with anyway stops where gravel keeps hanging over its way', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { ...FACE_IN_SIGHT, slow: true })
  assert.deepStrictEqual([r.stopped, r.at, r.ticks], [`gravel at 1,66,0 still falling after ${FALL_TICKS} ticks, stopping`, '0,64,0', FALL_TICKS])
})

// 1.7.10 starts gravel falling only when a neighbour changes, so the gravel at 1,66,0 over the open cells ahead stays put.
test('dig_tunnel with anyway steps under gravel hanging over a cell it did not open', async () => {
  const cave = (p) => p.x === 1 && p.z === 0 && (p.y === 64 || p.y === 65)
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { ...GRAVEL_OVER_FACE, open: cave, hung: ['1,66,0'] })
  assert.deepStrictEqual([r.stopped, r.dug, r.at], ['length reached', ['2,65,0', '2,64,0'], '2,64,0'])
})

// The gravel over the face falls 4 cells, through the passage into the 2-deep hole under it.
const FACE_OVER_HOLE = { blocks: { '1,66,0': 'gravel' }, open: (p) => p.x === 1 && p.z === 0 && [62, 63, 67].includes(p.y) }

test('dig_tunnel with anyway steps on only once the gravel falling through its way landed', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { ...FACE_OVER_HOLE, flight: AIRBORNE })
  assert.deepStrictEqual([r.stopped, r.under, r.ticks], ['length reached', [], landsAfter(4) + FALL_START_TICKS])
})

test('dig_tunnel with anyway waits for gravel it cannot see falling into its way and digs it out', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { ...GRAVEL_OVER_FACE, seen: (p) => !(p.x === 1 && p.y === 66 && p.z === 0), flight: AIRBORNE })
  assert.deepStrictEqual([r.stopped, r.under, r.dug], ['length reached', [], ['1,65,0', '1,64,0', '1,64,0', '2,65,0', '2,64,0']])
})

test('dig_tunnel with anyway stops when a block keeps falling over its way', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { ...GRAVEL_OVER_FACE, flight: () => 1000 })
  assert.deepStrictEqual([r.stopped, r.at, r.under, r.ticks], [`a block at 1,66,0 still falling after ${FALL_TICKS} ticks, stopping`, '0,64,0', [], FALL_TICKS])
})

// The gravel at 1,66,0 stays out of sight.
const UNSEEN_OVER_FACE = { ...GRAVEL_OVER_FACE, seen: (p) => !(p.x === 1 && p.y === 66 && p.z === 0) }

test('dig_tunnel without anyway steps on only once gravel it cannot see falling through its way landed', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { ...FACE_OVER_HOLE, ...UNSEEN_OVER_FACE, flight: AIRBORNE })
  assert.deepStrictEqual([r.stopped, r.under, r.ticks], ['length reached', [], landsAfter(4) + FALL_START_TICKS])
})

test('dig_tunnel without anyway stops naming a block it cannot see that keeps falling over its way', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { ...UNSEEN_OVER_FACE, flight: () => 1000 })
  assert.deepStrictEqual([r.stopped, r.at, r.under], [`a block at 1,66,0 still falling after ${FALL_TICKS} ticks, stopping`, '0,64,0', []])
})

test('dig_tunnel without anyway stops on gravel it could not see that fell into its way and digs nothing more', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { ...UNSEEN_OVER_FACE, flight: AIRBORNE })
  assert.deepStrictEqual([r.stopped, r.dug, r.at], ['cannot advance: gravel fell into 1,64,0', ['1,65,0', '1,64,0'], '0,64,0'])
})

test('dig_tunnel names no gravel it cannot see hanging over its way', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { ...UNSEEN_OVER_FACE, slow: true })
  assert.deepStrictEqual([r.stopped, r.at, r.ticks], ['cannot advance: gravel fell into 1,64,0', '0,64,0', FALL_START_TICKS])
})

test('dig_tunnel with anyway steps on only once a block that starts falling during the floor fill landed', async () => {
  const shaft = (p) => p.x === 1 && p.z === 0 && (p.y === 63 || p.y >= 66)
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { open: shaft, flight: AIRBORNE, fillDrop: '1,70,0' })
  assert.deepStrictEqual([r.stopped, r.fills, r.under, r.ticks], ['length reached', ['1,63,0'], [], AIRBORNE(7) + 2 * FALL_START_TICKS])
})

// Water over a gravel column over the face follows the gravel down.
test('dig_tunnel with anyway stops at water that follows the gravel it digs out, counting each dig', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { blocks: { '1,66,0': 'gravel', '1,67,0': 'water' } })
  assert.deepStrictEqual([r.stopped, r.dug, r.at], ['struck water at 1,65,0, stopping', ['1,65,0', '1,64,0', '1,64,0'], '0,64,0'])
  assert.match(r.events.at(-1), /^tunnel done: dug 3,/)
})

test('dig_tunnel names the buried self-rescue whole when it takes the dig lock mid-job', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { busyOn: '1,64,0' })
  assert.strictEqual(r.stopped, 'busy: the buried self-rescue is running, nothing dug')
})

test('dig_tunnel names the buried self-rescue whole when it aborts a dig mid-job', async () => {
  const aborted = await watchedDig('/dig_tunnel', EAST, { abortOn: '1,64,0' })
  assert.strictEqual(aborted.stopped, 'dig failed: Digging aborted', 'control: no rescue')
  const r = await watchedDig('/dig_tunnel', EAST, { abortOn: '1,64,0', rescueOn: '1,64,0' })
  assert.strictEqual(r.stopped, 'busy: the buried self-rescue is running, nothing dug')
})

test('dig_tunnel with anyway digs out no fallen gravel once the buried self-rescue runs', async () => {
  const r = await watchedDig('/dig_tunnel', { ...EAST, anyway: '1' }, { ...FACE_IN_SIGHT, rescueOn: '1,64,0' })
  assert.deepStrictEqual([r.stopped, r.dug], ['busy: the buried self-rescue is running, nothing dug', ['1,65,0', '1,64,0']])
})

test('dig_tunnel digs on past gravel over a wall ore it digs', async () => {
  const r = await watchedDig('/dig_tunnel', WALL_ORE, { blocks: { '1,64,1': 'iron_ore', '1,65,1': 'gravel' } })
  assert.strictEqual(r.stopped, 'length reached')
  assert.ok(r.dug.includes('1,64,1'), 'control: the wall ore was not dug')
})

test('after a gravel stop dig_tunnel steps back to the cell behind when it can stand there', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { ...GRAVEL_OVER_FACE, open: (p) => p.x === -1 && p.z === 0 && (p.y === 64 || p.y === 65) })
  assert.deepStrictEqual([r.stopped, r.at], ['gravel falling from 1,66,0, stopping, stepped back to -1,64,0', '-1,64,0'])

  const stuck = await watchedDig('/dig_tunnel', EAST, { ...GRAVEL_OVER_FACE, stepOut: () => true })
  assert.deepStrictEqual([stuck.stopped, stuck.at], ['gravel falling from 1,66,0, stopping, could not step back', '0,64,0'])
})

test('dig_tunnel cancelled during the dig that bares gravel does not step back', async () => {
  const r = await watchedDig('/dig_tunnel', EAST, { ...GRAVEL_OVER_FACE, cancelOn: '1,65,0', open: (p) => p.x === -1 && p.z === 0 && (p.y === 64 || p.y === 65) })
  assert.deepStrictEqual([r.stopped, r.at], ['gravel falling from 1,66,0, stopping, could not step back', '0,64,0'])
})

test('dig_tunnel during the buried self-rescue answers busy naming it and starts no job', async () => {
  const env = { bot: { entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 } }, require, bunker: { building: false }, digLock: botConstant('digLock') }
  assert.deepStrictEqual((await routeJobs('/dig_tunnel', EAST, env)).started, ['dig_tunnel e x2'], 'control: no rescue')
  claimRescue(env.digLock)
  const r = await routeJobs('/dig_tunnel', EAST, env)
  assert.deepStrictEqual([r.error && r.error.reason, r.started], ['busy', []])
  assert.match(r.error.message, /^busy: the buried self-rescue is running\b/)
})
