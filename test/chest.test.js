'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const WorldSync = require('prismarine-world/src/worldsync')
const { awaitRoute, routeHandler, botConstant, loadBotFunctions, claimRescue, walkingBody } = require('./helpers')
const { guardWork } = require('../lib/walk')
const { stackPause, STACK_GAP_MS, STACK_JITTER_MS } = require('../lib/pace')
const { LEGACY_CLICK_REACH } = require('../lib/bot/legacy-1710')
const { TOOLS } = require('../mcp/tools')
const mcData = require('minecraft-data')('1.21.11')
const registry = require('prismarine-registry')('1.21.11')
const loadItem = require('prismarine-item')
const Item = loadItem(registry)

const CHEST_ID = 54
const IDS = { stone: 1, cobblestone: 4, sticky_piston: 29, iron_pickaxe: 257, diamond: 264, iron_ingot: 265, iron_sword: 267, stick: 280, wheat_seeds: 295, wheat: 296, ender_pearl: 368, cobbled_deepslate: 1101 }
const NAMES = Object.fromEntries(Object.entries(IDS).map(([n, id]) => [id, n]))
const CHEST_SLOTS = 27
const HERE = new Vec3(0.5, 64, 0.5)
const NEAR = new Vec3(5, 64, 0)
const FAR = new Vec3(-7, 64, 3)
// Nearer than NEAR and FAR.
const HIDDEN = new Vec3(0, 64, -3)

const stack = (name, count, stackSize = 64) => ({ name, type: IDS[name], count, stackSize })
// A chest facing north pairs its left half with the cell east of it and its right half with the cell west.
const LEFT = { type: 'left', facing: 'north' }
const RIGHT = { type: 'right', facing: 'north' }

const FRAME_ITEM = mcData.entitiesByName.item_frame.metadataKeys.indexOf('item')
// objectData and the step from the wall to the frame's own cell.
const FACES = { north: [2, 0, 0, -1], south: [3, 0, 0, 1], west: [4, -1, 0, 0], east: [5, 1, 0, 0] }
let frameIds = 100
// An item frame on face of the wall cell holding item, null for an empty one. seen says whether the body perceives it.
function frameOn (wall, face, item, seen = true) {
  const [objectData, dx, dy, dz] = FACES[face]
  const metadata = []
  metadata[FRAME_ITEM] = Item.toNotch(item ? new Item(registry.itemsByName[item].id, 1) : null)
  return { id: frameIds++, name: 'item_frame', objectData, position: wall.offset(dx, dy, dz), metadata, seen }
}

const pocketItems = (pockets, from) => pockets.flatMap((s, i) => (s.count ? [{ ...s, slot: from + i }] : []))

// A single chest whose deposit and withdraw throw mineflayer's errors.
function chestWindow (items) {
  const slots = items.map((s) => ({ ...s }))
  const window = {
    closed: false,
    pockets: [],
    containerItems: () => slots.map((s) => ({ ...s })),
    items: () => pocketItems(window.pockets, CHEST_SLOTS),
    async deposit (type, metadata, count) {
      while (count > 0) {
        const from = window.pockets.find((p) => p.type === type && p.count)
        if (!from) throw new Error(`Can't find ${NAMES[type]} in slots [${CHEST_SLOTS} - ${CHEST_SLOTS + 36}], (item id: ${type})`)
        let s = slots.find((x) => x.type === type && x.count < 64)
        if (!s) {
          if (slots.length >= CHEST_SLOTS) throw new Error('destination full')
          s = stack(NAMES[type], 0)
          slots.push(s)
        }
        const n = Math.min(count, 64 - s.count, from.count)
        s.count += n
        from.count -= n
        count -= n
      }
    },
    async withdraw (type, metadata, count) {
      while (count > 0) {
        const s = slots.find((x) => x.type === type)
        if (!s) throw new Error(`Can't find ${NAMES[type]} in slots [0 - ${CHEST_SLOTS}], (item id: ${type})`)
        const n = Math.min(count, s.count)
        s.count -= n
        count -= n
        if (!s.count) slots.splice(slots.indexOf(s), 1)
      }
    },
    close () { window.closed = true }
  }
  return window
}

// windows and states are keyed by a chest's x,y,z.
function chestEnv (chests, windows, pockets = [], states = {}) {
  const at = (p) => `${p.x},${p.y},${p.z}`
  const cells = new Set(chests.map(at))
  const opened = []
  const live = pockets.map((s) => ({ ...s }))
  // Like mineflayer's, bot.inventory takes the pockets of an open window only once it closes.
  let inventory = pocketItems(live, 9)
  for (const w of Object.values(windows)) {
    w.pockets = live
    const close = w.close
    w.close = () => { close(); inventory = pocketItems(live, 9) }
  }
  const fight = { busy: false }
  const entities = []
  const FILL = { cells: new Set() }
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) }
  const chest = (p) => ({ name: 'chest', type: CHEST_ID, position: p, shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => states[at(p)] || { type: 'single', facing: 'north' } })
  const env = {
    bot: {
      entity: { position: HERE },
      blockAt: (p) => (cells.has(at(p)) ? chest(p) : { name: 'air', type: 0, position: p, shapes: [] }),
      world: { raycast: (...ray) => WorldSync.prototype.raycast.apply({ getBlock: (p) => env.bot.blockAt(p) }, ray) },
      findBlocks: ({ matching, maxDistance }) => (matching.includes(CHEST_ID) ? chests.filter((p) => HERE.distanceTo(p) <= maxDistance) : []),
      pathfinder: {
        // Walks one cell at a time to the neighbour nearest the goal until it stands on an end cell.
        goto: async (goal) => {
          let cell = env.bot.entity.position.floored()
          for (let i = 0; i < 20 && !goal.isEnd(cell); i++) {
            cell = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => cell.offset(dx, 0, dz)).reduce((a, b) => (goal.heuristic(b) < goal.heuristic(a) ? b : a))
          }
          env.bot.entity.position = cell.offset(0.5, 0, 0.5)
        },
        startCell: (p) => p.floored()
      },
      _client: { write () {} },
      // mineflayer opens a chest with a block_place.
      openContainer: async (b) => {
        opened.push(at(b.position))
        env.bot._client.write('block_place', {})
        env.bot.currentWindow = windows[at(b.position)]
        return env.bot.currentWindow
      },
      inventory: { items: () => inventory },
      registry
    },
    guardState: { hand: null },
    reflexes: [{ name: 'combat', fightBusy: () => fight.busy, _threat: null, fairFill: (b) => { assert.strictEqual(b, env.bot, 'fairFill got another bot'); return FILL } }],
    liveEntities: () => entities,
    entityPerceptible: (en, fill) => { assert.strictEqual(fill, FILL, 'entityPerceptible got another fill'); return en.seen },
    shared: { mcData },
    loadItem,
    bunkerHolds: () => false,
    ...timers,
    stackPause: async () => {},
    cellKnown: (p) => !p.equals(HIDDEN),
    seenNow: (p) => !p.equals(HIDDEN),
    leafInTheWay: () => null,
    STATIONS: new Map(),
    ck: (x, y, z) => x + ',' + y + ',' + z,
    require,
    resolveBlockIds: (name) => (name === 'chest' ? [CHEST_ID] : []),
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    goals,
    CHEST_RADIUS: botConstant('CHEST_RADIUS'),
    CHEST_REACH: botConstant('CHEST_REACH')
  }
  loadBotFunctions(['wireHandLease'], { bot: env.bot, guardState: env.guardState, ...timers }).wireHandLease()
  return { env, opened, fight, entities }
}

async function refused (route, query, env) {
  const { handle, res } = routeHandler(route, env)
  await handle({ query }, res)
  assert.ok(res.error, `${route} answered ${JSON.stringify(res.body)}`)
  return res.error
}

async function refusal (route, query, env) {
  return (await refused(route, query, env)).message
}

// The route with the real stack pause, on t's mock clock stepped 5 ms at a time.
async function pacedRoute (t, route, query, env) {
  let settled = false
  const reply = awaitRoute(route, query, { ...env, stackPause }).finally(() => { settled = true })
  for (let i = 0; i < 1000 && !settled; i++) {
    await new Promise(setImmediate)
    t.mock.timers.tick(5)
  }
  assert.ok(settled, `${route} never answered`)
  return reply
}

// Records [count, time] for each call of window's method.
function recorded (window, method) {
  const calls = []
  const real = window[method]
  window[method] = async (type, metadata, count) => {
    calls.push([count, Date.now()])
    return real(type, metadata, count)
  }
  return calls
}

function assertStackGaps (calls) {
  for (let i = 1; i < calls.length; i++) {
    const gap = calls[i][1] - calls[i - 1][1]
    assert.ok(gap >= STACK_GAP_MS && gap <= STACK_GAP_MS + STACK_JITTER_MS + 5, `gap ${gap} ms`)
  }
}

test('chest without x,y,z lists every seen chest nearest first with the items of the nearest, and no unseen one', async () => {
  const windows = { '5,64,0': chestWindow([stack('cobblestone', 10)]), '0,64,-3': chestWindow([stack('diamond', 3)]) }
  const { env, opened } = chestEnv([NEAR, FAR, HIDDEN], windows)
  const reply = await awaitRoute('/chest', {}, env)
  assert.deepStrictEqual(reply, {
    at: { x: 5, y: 64, z: 0 },
    items: [{ name: 'cobblestone', count: 10 }],
    chests: [{ at: { x: 5, y: 64, z: 0 }, dist: 5 }, { at: { x: -7, y: 64, z: 3 }, dist: 7.6 }]
  })
  assert.deepStrictEqual(opened, ['5,64,0'])
  assert.ok(windows['5,64,0'].closed, 'the window stays open')
})

test('chest radius bounds the list', async () => {
  const { env } = chestEnv([NEAR, FAR], { '5,64,0': chestWindow([]) })
  assert.deepStrictEqual((await awaitRoute('/chest', { radius: '6' }, env)).chests, [{ at: { x: 5, y: 64, z: 0 }, dist: 5 }])
})

test('chest lists a double chest once with both cells, and two single chests side by side apart', async () => {
  const beside = new Vec3(6, 64, 0)
  const double = chestEnv([beside, NEAR, FAR], { '5,64,0': chestWindow([]) }, [], { '5,64,0': LEFT, '6,64,0': RIGHT })
  assert.deepStrictEqual((await awaitRoute('/chest', {}, double.env)).chests, [
    { at: { x: 5, y: 64, z: 0 }, pair: { x: 6, y: 64, z: 0 }, dist: 5 },
    { at: { x: -7, y: 64, z: 3 }, dist: 7.6 }
  ])
  const singles = chestEnv([beside, NEAR], { '5,64,0': chestWindow([]) })
  assert.deepStrictEqual((await awaitRoute('/chest', {}, singles.env)).chests, [
    { at: { x: 5, y: 64, z: 0 }, dist: 5 },
    { at: { x: 6, y: 64, z: 0 }, dist: 6 }
  ])
})

test('a chest whose other half is unseen lists no pair and never names that cell', async () => {
  // Its other half is HIDDEN, the cell west of it.
  const half = new Vec3(1, 64, -3)
  const windows = { '1,64,-3': chestWindow([]), '-7,64,3': chestWindow([]) }
  const { env } = chestEnv([half, HIDDEN, FAR], windows, [], { '1,64,-3': RIGHT, '0,64,-3': LEFT })
  assert.deepStrictEqual((await awaitRoute('/chest', {}, env)).chests, [
    { at: { x: 1, y: 64, z: -3 }, dist: 3.2 },
    { at: { x: -7, y: 64, z: 3 }, dist: 7.6 }
  ])
  const miss = await refusal('/withdraw', { name: 'diamond', x: '-7', y: '64', z: '3' }, env)
  assert.match(miss, /other chests seen within 12: 1,64,-3 \(7\.2 away\)$/)
  assert.doesNotMatch(miss, /0,64,-3/)
})

test('chest refuses when every chest in range is unseen, without naming or opening it', async () => {
  const { env, opened } = chestEnv([HIDDEN], { '0,64,-3': chestWindow([stack('diamond', 3)]) })
  const error = await refusal('/chest', {}, env)
  assert.match(error, /no chest seen within 12/)
  assert.doesNotMatch(error, /0,64,-3|diamond/)
  assert.deepStrictEqual(opened, [])
})

test('chest names the item of each frame in sight on the chest it opened, an empty frame as null', async () => {
  const { env, entities } = chestEnv([NEAR], { '5,64,0': chestWindow([]) })
  entities.push(frameOn(NEAR, 'north', 'oak_log'), frameOn(NEAR, 'west', null))
  assert.deepStrictEqual(await awaitRoute('/chest', { x: '5', y: '64', z: '0' }, env), { at: { x: 5, y: 64, z: 0 }, items: [], frames: ['oak_log', null] })
})

test('chest at x,y,z names the frames on the other half of a double chest, from either half', async () => {
  const beside = new Vec3(6, 64, 0)
  const states = { '5,64,0': LEFT, '6,64,0': RIGHT }
  const left = chestEnv([NEAR, beside], { '5,64,0': chestWindow([]) }, [], states)
  left.entities.push(frameOn(beside, 'north', 'oak_planks'))
  assert.deepStrictEqual(await awaitRoute('/chest', { x: '5', y: '64', z: '0' }, left.env), { at: { x: 5, y: 64, z: 0 }, items: [], frames: ['oak_planks'] })
  const right = chestEnv([NEAR, beside], { '6,64,0': chestWindow([]) }, [], states)
  right.entities.push(frameOn(NEAR, 'north', 'oak_log'))
  assert.deepStrictEqual(await awaitRoute('/chest', { x: '6', y: '64', z: '0' }, right.env), { at: { x: 6, y: 64, z: 0 }, items: [], frames: ['oak_log'] })
})

test('chest leaves out a frame on the chest the body does not perceive', async () => {
  const { env, entities } = chestEnv([NEAR], { '5,64,0': chestWindow([]) })
  entities.push(frameOn(NEAR, 'north', 'oak_log'), frameOn(NEAR, 'east', 'diamond', false))
  assert.deepStrictEqual(await awaitRoute('/chest', {}, env), {
    at: { x: 5, y: 64, z: 0 },
    items: [],
    frames: ['oak_log'],
    chests: [{ at: { x: 5, y: 64, z: 0 }, dist: 5, frames: ['oak_log'] }]
  })
})

test('each chest of the radius list names the frames in sight on it or its other half, with one sight check per frame', async () => {
  const beside = new Vec3(6, 64, 0)
  const { env, entities } = chestEnv([beside, NEAR, FAR], { '5,64,0': chestWindow([]) }, [], { '5,64,0': LEFT, '6,64,0': RIGHT })
  entities.push(frameOn(beside, 'north', 'cobblestone'), frameOn(FAR, 'south', 'diamond'), frameOn(FAR, 'east', null))
  const perceptible = env.entityPerceptible
  let checks = 0
  env.entityPerceptible = (en, fill) => { checks++; return perceptible(en, fill) }
  assert.deepStrictEqual(await awaitRoute('/chest', {}, env), {
    at: { x: 5, y: 64, z: 0 },
    items: [],
    frames: ['cobblestone'],
    chests: [
      { at: { x: 5, y: 64, z: 0 }, pair: { x: 6, y: 64, z: 0 }, dist: 5, frames: ['cobblestone'] },
      { at: { x: -7, y: 64, z: 3 }, dist: 7.6, frames: ['diamond', null] }
    ]
  })
  assert.strictEqual(checks, 3)
})

test('chest gives no frames field when no frame in sight hangs on a chest', async () => {
  const { env, entities } = chestEnv([NEAR, FAR], { '5,64,0': chestWindow([]) })
  // The first hangs in the cell north of the chest, on the wall north of that cell.
  entities.push(frameOn(new Vec3(5, 64, -2), 'south', 'oak_log'), frameOn(FAR, 'north', 'diamond', false), { id: 99, name: 'zombie', position: new Vec3(5, 64, -1), seen: true })
  assert.deepStrictEqual(await awaitRoute('/chest', {}, env), {
    at: { x: 5, y: 64, z: 0 },
    items: [],
    chests: [{ at: { x: 5, y: 64, z: 0 }, dist: 5 }, { at: { x: -7, y: 64, z: 3 }, dist: 7.6 }]
  })
})

test('chest, withdraw and deposit refuse a chest seen only through a leaf from where the walk ends, naming the leaf, without opening it', async () => {
  for (const route of ['/chest', '/withdraw', '/deposit']) {
    const { env, opened } = chestEnv([NEAR], { '5,64,0': chestWindow([stack('cobblestone', 10)]) }, [stack('cobblestone', 5)])
    let walked = false
    const asked = []
    env.bot.pathfinder.goto = async () => {
      walked = true
      env.bot.entity.position = new Vec3(3.5, 64, 0.5)
    }
    env.leafInTheWay = (p) => {
      asked.push(`${p.x},${p.y},${p.z}`)
      return walked ? { name: 'oak_leaves', position: new Vec3(4, 64, 0) } : null
    }
    assert.match(await refusal(route, { name: 'cobblestone', x: '5', y: '64', z: '0' }, env), /oak_leaves at 4,64,0 is in the way/, route)
    assert.deepStrictEqual([...new Set(asked)], ['5,64,0'], route)
    assert.deepStrictEqual(opened, [], route)
  }
})

test('withdraw takes the named item from the nearest seen chest or the one at x,y,z', async () => {
  const windows = {
    '5,64,0': chestWindow([stack('stone', 64), stack('cobblestone', 10)]),
    '-7,64,3': chestWindow([stack('diamond', 3)]),
    '0,64,-3': chestWindow([stack('cobblestone', 64)])
  }
  const { env, opened } = chestEnv([NEAR, FAR, HIDDEN], windows)
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'cobblestone', count: '4' }, env), { withdrew: [{ item: 'cobblestone', count: 4 }] })
  assert.deepStrictEqual(windows['5,64,0'].containerItems(), [stack('stone', 64), stack('cobblestone', 6)])
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'diamond', x: '-7', y: '64', z: '3' }, env), { withdrew: [{ item: 'diamond', count: 3 }] })
  assert.deepStrictEqual(opened, ['5,64,0', '-7,64,3'])
})

test('withdraw of several names opens the chest once, closes it, and lists the unknown ones as missing', async () => {
  const windows = { '5,64,0': chestWindow([stack('cobblestone', 10), stack('diamond', 3)]) }
  const { env, opened } = chestEnv([NEAR], windows)
  const reply = await awaitRoute('/withdraw', { name: ' cobblestone | diamond |', count: '4' }, env)
  assert.deepStrictEqual(reply, { withdrew: [{ item: 'cobblestone', count: 4 }, { item: 'diamond', count: 3 }] })
  assert.deepStrictEqual(windows['5,64,0'].containerItems(), [stack('cobblestone', 6)])
  assert.deepStrictEqual(opened, ['5,64,0'])
  assert.ok(windows['5,64,0'].closed, 'the window stays open')

  const partial = { '5,64,0': chestWindow([stack('cobblestone', 10)]) }
  const second = chestEnv([NEAR], partial)
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'cobblestone|emerald', count: '2' }, second.env), {
    withdrew: [{ item: 'cobblestone', count: 2 }],
    missing: ['emerald']
  })
  assert.deepStrictEqual(second.opened, ['5,64,0'])
  assert.ok(partial['5,64,0'].closed, 'the window stays open')
})

test('withdraw of several names that fails partway closes the window and names what already moved', async () => {
  const windows = { '5,64,0': chestWindow([stack('cobblestone', 10), stack('diamond', 3)]) }
  const real = windows['5,64,0'].withdraw
  windows['5,64,0'].withdraw = async (type, metadata, count) => {
    if (type === IDS.diamond) throw new Error('destination full')
    return real(type, metadata, count)
  }
  const { env, opened } = chestEnv([NEAR], windows)
  assert.strictEqual(await refusal('/withdraw', { name: 'cobblestone|diamond' }, env), 'withdrew cobblestone 10; then diamond: destination full')
  assert.deepStrictEqual(opened, ['5,64,0'])
  assert.ok(windows['5,64,0'].closed, 'the window stays open')
})

test('withdraw and deposit refuse more than 8 names before walking or opening anything', async () => {
  const names = 'a|b|c|d|e|f|g|h|i'
  const { env, opened } = chestEnv([NEAR], { '5,64,0': chestWindow([]) }, [stack('cobblestone', 1)])
  let walked = false
  env.bot.pathfinder.goto = async () => { walked = true }
  assert.match(await refusal('/withdraw', { name: names }, env), /at most 8 names/)
  assert.match(await refusal('/deposit', { name: names }, env), /at most 8 names/)
  assert.deepStrictEqual([opened, walked], [[], false])
})

test('deposit puts every matching stack into the nearest seen chest and reports the count now in it', async () => {
  const windows = { '5,64,0': chestWindow([stack('cobblestone', 10)]), '0,64,-3': chestWindow([]) }
  const pockets = [stack('cobblestone', 20), stack('stone', 3), stack('cobblestone', 5)]
  const { env, opened } = chestEnv([NEAR, FAR, HIDDEN], windows, pockets)
  assert.deepStrictEqual(await awaitRoute('/deposit', { name: 'cobblestone' }, env), { deposited: [{ item: 'cobblestone', count: 25, inChestNow: 35 }] })
  assert.deepStrictEqual(windows['5,64,0'].containerItems(), [stack('cobblestone', 35)])
  assert.deepStrictEqual(opened, ['5,64,0'])
})

test('deposit of several names opens the chest once, closes it, and lists the unknown ones as missing', async () => {
  const windows = { '5,64,0': chestWindow([stack('cobblestone', 10)]) }
  const pockets = [stack('cobblestone', 20), stack('diamond', 2)]
  const { env, opened } = chestEnv([NEAR], windows, pockets)
  assert.deepStrictEqual(await awaitRoute('/deposit', { name: 'cobblestone|emerald|diamond' }, env), {
    deposited: [{ item: 'cobblestone', count: 20, inChestNow: 30 }, { item: 'diamond', count: 2, inChestNow: 2 }],
    missing: ['emerald']
  })
  assert.deepStrictEqual(windows['5,64,0'].containerItems(), [stack('cobblestone', 30), stack('diamond', 2)])
  assert.deepStrictEqual(opened, ['5,64,0'])
  assert.ok(windows['5,64,0'].closed, 'the window stays open')
})

test('deposit of an exact item name moves only that item and counts only it in the chest', async () => {
  const windows = { '5,64,0': chestWindow([stack('wheat_seeds', 3)]) }
  const { env } = chestEnv([NEAR], windows, [stack('wheat_seeds', 7), stack('wheat', 5)])
  assert.deepStrictEqual(await awaitRoute('/deposit', { name: 'wheat' }, env), { deposited: [{ item: 'wheat', count: 5, inChestNow: 5 }] })
  assert.deepStrictEqual(windows['5,64,0'].containerItems(), [stack('wheat_seeds', 3), stack('wheat', 5)])
})

test('withdraw takes the one item whose name holds the name as whole words, never one that only contains it', async () => {
  const both = chestWindow([stack('sticky_piston', 2), stack('stick', 10)])
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'stick' }, chestEnv([NEAR], { '5,64,0': both }).env), { withdrew: [{ item: 'stick', count: 10 }] })
  assert.deepStrictEqual(both.containerItems(), [stack('sticky_piston', 2)])

  const pistons = chestWindow([stack('sticky_piston', 2)])
  const e = await refused('/withdraw', { name: 'stick' }, chestEnv([NEAR], { '5,64,0': pistons }).env)
  assert.deepStrictEqual([e.message, e.reason], ['no stick in chest (names containing stick: sticky_piston); no other chest seen within 12', 'no_match'])
  assert.deepStrictEqual(pistons.containerItems(), [stack('sticky_piston', 2)])

  const ingots = chestWindow([stack('sticky_piston', 2), stack('iron_ingot', 5)])
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'iron' }, chestEnv([NEAR], { '5,64,0': ingots }).env), { withdrew: [{ item: 'iron_ingot', count: 5, asked: 'iron' }] })
})

test('withdraw and deposit refuse a name several items hold as whole words, naming them and moving nothing', async () => {
  const chest = chestWindow([stack('diamond', 3), stack('iron_pickaxe', 1, 1), stack('iron_ingot', 5)])
  const { env, opened } = chestEnv([NEAR], { '5,64,0': chest })
  const withdrew = await refused('/withdraw', { name: 'diamond|iron' }, env)
  assert.deepStrictEqual([withdrew.message, withdrew.reason], ['refused: iron matches several items in chest (iron_ingot, iron_pickaxe), name one in full', 'ambiguous'])
  assert.deepStrictEqual(chest.containerItems(), [stack('diamond', 3), stack('iron_pickaxe', 1, 1), stack('iron_ingot', 5)])
  assert.ok(chest.closed, 'the window stays open')

  const pockets = chestEnv([NEAR], { '5,64,0': chestWindow([]) }, [stack('iron_ingot', 5), stack('iron_pickaxe', 1, 1)])
  let walked = false
  pockets.env.bot.pathfinder.goto = async () => { walked = true }
  const deposited = await refused('/deposit', { name: 'iron' }, pockets.env)
  assert.deepStrictEqual([deposited.message, deposited.reason], ['refused: iron matches several items in inventory (iron_ingot, iron_pickaxe), name one in full', 'ambiguous'])
  assert.deepStrictEqual([pockets.opened, walked, opened], [[], false, ['5,64,0']])
})

test('withdraw and deposit refuse a name item names only contain, naming the closest', async () => {
  const chest = chestWindow([stack('stone', 64), stack('cobblestone', 10)])
  const { env } = chestEnv([NEAR], { '5,64,0': chest }, [stack('cobblestone', 20), stack('cobbled_deepslate', 4)])
  assert.strictEqual(await refusal('/withdraw', { name: 'cobble' }, env), 'no cobble in chest (names containing cobble: cobblestone); no other chest seen within 12')
  const e = await refused('/deposit', { name: 'cobble' }, env)
  assert.deepStrictEqual([e.message, e.reason], ['no cobble in inventory (names containing cobble: cobblestone, cobbled_deepslate)', 'no_match'])
  assert.deepStrictEqual(chest.containerItems(), [stack('stone', 64), stack('cobblestone', 10)])
})

test('deposit of several names that fails partway closes the window and names what already moved', async () => {
  const full = [...Array.from({ length: CHEST_SLOTS - 2 }, () => stack('stone', 64)), stack('cobblestone', 50)]
  const windows = { '5,64,0': chestWindow(full) }
  const { env, opened } = chestEnv([NEAR, FAR], windows, [stack('diamond', 5), stack('stone', 70)])
  const error = await refusal('/deposit', { name: 'diamond|stone' }, env)
  assert.match(error, /^deposited diamond 5; then stone: deposited 0 then failed \(chest full\?\): destination full; /)
  assert.match(error, /other chests seen within 12: -7,64,3 \(9\.5 away\)$/)
  assert.deepStrictEqual(opened, ['5,64,0'])
  assert.ok(windows['5,64,0'].closed, 'the window stays open')
})

test('withdraw and deposit move one stack per mineflayer call, a stack pause apart', async (t) => {
  const chest = chestWindow([stack('cobblestone', 64), stack('cobblestone', 64), stack('cobblestone', 10)])
  const withdrawn = recorded(chest, 'withdraw')
  const deposited = recorded(chest, 'deposit')
  const { env } = chestEnv([NEAR], { '5,64,0': chest }, [stack('stone', 64), stack('stone', 20)])
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  assert.deepStrictEqual(await pacedRoute(t, '/withdraw', { name: 'cobblestone', count: '100' }, env), { withdrew: [{ item: 'cobblestone', count: 100 }] })
  assert.deepStrictEqual(withdrawn.map(([count]) => count), [64, 36])
  assertStackGaps(withdrawn)
  assert.deepStrictEqual(await pacedRoute(t, '/deposit', { name: 'stone' }, env), { deposited: [{ item: 'stone', count: 84, inChestNow: 84 }] })
  assert.deepStrictEqual(deposited.map(([count]) => count), [64, 20])
  assertStackGaps(deposited)
})

test('withdraw without count takes one stack of each item, and a count spans stacks, each from one chest opening', async () => {
  const fourStacks = () => chestWindow(Array.from({ length: 4 }, () => stack('cobblestone', 64)))
  const single = fourStacks()
  const one = chestEnv([NEAR], { '5,64,0': single })
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'cobblestone' }, one.env), { withdrew: [{ item: 'cobblestone', count: 64 }] })
  assert.deepStrictEqual(single.containerItems(), Array.from({ length: 3 }, () => stack('cobblestone', 64)))
  assert.deepStrictEqual(one.opened, ['5,64,0'])

  const small = chestWindow([stack('ender_pearl', 16, 16), stack('ender_pearl', 16, 16), stack('iron_sword', 1, 1), stack('iron_sword', 1, 1)])
  const stackOf = chestEnv([NEAR], { '5,64,0': small })
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'ender_pearl|iron_sword' }, stackOf.env), {
    withdrew: [{ item: 'ender_pearl', count: 16 }, { item: 'iron_sword', count: 1 }]
  })
  assert.deepStrictEqual(small.containerItems(), [stack('ender_pearl', 16, 16), stack('iron_sword', 1, 1)])

  const spanned = fourStacks()
  const withdrawn = recorded(spanned, 'withdraw')
  const many = chestEnv([NEAR], { '5,64,0': spanned })
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'cobblestone', count: '200' }, many.env), { withdrew: [{ item: 'cobblestone', count: 200 }] })
  assert.deepStrictEqual(withdrawn.map(([count]) => count), [64, 64, 64, 8])
  assert.deepStrictEqual(spanned.containerItems(), [stack('cobblestone', 56)])
  assert.deepStrictEqual(many.opened, ['5,64,0'])
})

test('a chest closed during the stack pause stops withdraw and deposit, and the error names what moved', async () => {
  const chest = chestWindow([stack('cobblestone', 64), stack('cobblestone', 64)])
  const { env } = chestEnv([NEAR], { '5,64,0': chest }, [stack('stone', 64), stack('stone', 20)])
  env.stackPause = async () => { env.bot.currentWindow = null }
  assert.strictEqual(await refusal('/withdraw', { name: 'cobblestone', count: '128' }, env), 'withdrew cobblestone 64; then cobblestone: the chest closed')
  assert.deepStrictEqual(chest.containerItems(), [stack('cobblestone', 64)])
  const error = await refusal('/deposit', { name: 'stone' }, env)
  assert.match(error, /^deposited 64 then failed: the chest closed; stone in chest now 64; /)
  assert.ok(chest.closed, 'the window stays open')
})

test('withdraw and deposit refuse during a fight before walking or opening anything', async () => {
  const { env, opened, fight } = chestEnv([NEAR], { '5,64,0': chestWindow([stack('cobblestone', 10)]) }, [stack('stone', 5)])
  let walked = false
  env.bot.pathfinder.goto = async () => { walked = true }
  fight.busy = true
  assert.match(await refusal('/withdraw', { name: 'cobblestone' }, env), /^refused: fighting something, /)
  assert.match(await refusal('/deposit', { name: 'stone' }, env), /^refused: fighting something, /)
  assert.deepStrictEqual([opened, walked], [[], false])
})

test('withdraw and deposit refuse busy while the buried self-rescue holds the hand, before walking or opening anything', async () => {
  const { env, opened } = chestEnv([NEAR], { '5,64,0': chestWindow([stack('cobblestone', 10)]) }, [stack('stone', 5)])
  let walked = false
  env.bot.pathfinder.goto = async () => { walked = true }
  env.digLock = botConstant('digLock')
  claimRescue(env.digLock)
  assert.strictEqual(await refusal('/withdraw', { name: 'cobblestone' }, env), 'busy: the buried self-rescue is running, nothing withdrawn')
  assert.strictEqual(await refusal('/deposit', { name: 'stone' }, env), 'busy: the buried self-rescue is running, nothing deposited')
  assert.deepStrictEqual([opened, walked], [[], false])
})

test('a buried self-rescue starting during the walk stops withdraw and deposit at the hand, closes the chest and leaves its lease and shovel alone', async () => {
  const chest = chestWindow([stack('cobblestone', 10)])
  const { env } = chestEnv([NEAR], { '5,64,0': chest }, [stack('stone', 5)])
  const digLock = botConstant('digLock')
  env.digLock = digLock
  env.bot.heldItem = { name: 'iron_shovel' }
  const { holdHand, endHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState: env.guardState, digLock, setTimeout, clearTimeout })
  let rescue = null
  env.bot.pathfinder.goto = async () => {
    env.bot.entity.position = new Vec3(3.5, 64, 0.5)
    claimRescue(digLock)
    rescue = holdHand(digLock.holder)
  }
  try {
    for (const [route, name] of [['/withdraw', 'cobblestone'], ['/deposit', 'stone']]) {
      endHand(rescue)
      digLock.holder = null
      chest.closed = false
      assert.strictEqual(await refusal(route, { name }, env), 'busy: the buried self-rescue is running, nothing done', route)
      assert.ok(chest.closed, `${route} left the chest open`)
      assert.strictEqual(env.guardState.hand, rescue, `${route} ended the rescue's lease`)
    }
    assert.deepStrictEqual(chest.containerItems(), [stack('cobblestone', 10)])
    assert.strictEqual(env.bot.heldItem.name, 'iron_shovel')
  } finally { endHand(rescue) }
})

test('a buried self-rescue taking the hand during a stack pause stops withdraw and deposit before their next click, and leaves its lease and shovel alone', async () => {
  const chest = chestWindow([stack('cobblestone', 64), stack('cobblestone', 64)])
  const { env } = chestEnv([NEAR], { '5,64,0': chest }, [stack('stone', 64), stack('stone', 20)])
  const digLock = botConstant('digLock')
  env.digLock = digLock
  const { holdHand, endHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState: env.guardState, digLock, setTimeout, clearTimeout })
  const clicks = []
  for (const method of ['withdraw', 'deposit']) {
    const real = chest[method]
    chest[method] = async (type, metadata, count) => {
      clicks.push(method)
      return real(type, metadata, count)
    }
  }
  let rescue = null
  env.stackPause = async () => {
    claimRescue(digLock)
    rescue = holdHand(digLock.holder)
    env.bot.heldItem = { name: 'iron_shovel' }
  }
  try {
    const withdrew = await refused('/withdraw', { name: 'cobblestone', count: '128' }, env)
    assert.strictEqual(withdrew.message, 'withdrew cobblestone 64; then cobblestone: busy: the buried self-rescue is running, nothing more moved')
    assert.strictEqual(withdrew.reason, 'busy')
    assert.strictEqual(env.guardState.hand, rescue, 'withdraw ended the rescue\'s lease')
    endHand(rescue)
    digLock.holder = null
    const deposited = await refused('/deposit', { name: 'stone' }, env)
    assert.match(deposited.message, /^deposited 64 then failed: busy: the buried self-rescue is running, nothing more moved; stone in chest now 64; /)
    assert.strictEqual(deposited.reason, 'busy')
    assert.strictEqual(env.guardState.hand, rescue, 'deposit ended the rescue\'s lease')
    assert.deepStrictEqual(clicks, ['withdraw', 'deposit'])
    assert.strictEqual(env.bot.heldItem.name, 'iron_shovel')
    assert.ok(chest.closed, 'the window stays open')
  } finally { endHand(rescue) }
})

test('withdraw during the pour of the fire reflex is refused at the gate before it walks or opens a chest, and the pour keeps the hand', async () => {
  const { env, opened } = chestEnv([NEAR], { '5,64,0': chestWindow([stack('cobblestone', 10)]) })
  let walked = false
  env.bot.pathfinder.goto = async () => { walked = true }
  const { holdHand, endHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState: env.guardState, setTimeout, clearTimeout })
  const gates = new Map()
  const gateEnv = { TOOLS, err: (res, e) => { res.error = e }, reflexes: env.reflexes, bot: env.bot, entityPerceptible: () => true, bunkerHolds: env.bunkerHolds, guardState: env.guardState }
  loadBotFunctions(['installFightGate'], gateEnv).installFightGate({ all: (route, gate) => gates.set(route, gate) })
  const pour = holdHand('fire')
  try {
    const { handle, res } = routeHandler('/withdraw', env)
    let passed = false
    gates.get('/withdraw')({ query: { name: 'cobblestone' } }, res, () => { passed = true })
    if (passed) await handle({ query: { name: 'cobblestone' } }, res)
    assert.deepStrictEqual([res.error?.message, res.error?.reason], ['refused: pouring water on the fire, the fire reflex holds the hand. Retry in a moment.', 'busy'])
    assert.deepStrictEqual([opened, walked], [[], false])
    assert.strictEqual(pour.renew(), true, 'the pour lost the hand')
  } finally { endHand(pour) }
})

test('a buried self-rescue that stops the walk of withdraw and deposit gets them refused busy, with no chest opened', async () => {
  const { env, opened } = chestEnv([NEAR], { '5,64,0': chestWindow([stack('cobblestone', 10)]) }, [stack('stone', 5)])
  const digLock = botConstant('digLock')
  env.digLock = digLock
  let rescue = false
  // The rescue's stopPath clears the goal, and mineflayer-pathfinder's goto fails with GoalChanged.
  env.bot.pathfinder.goto = async () => {
    if (rescue) claimRescue(digLock)
    throw Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' })
  }
  assert.strictEqual(await refusal('/withdraw', { name: 'cobblestone' }, env), 'The goal was changed before it could be completed!', 'control: a goal changed with no claim')
  rescue = true
  for (const [route, name, skipped] of [['/withdraw', 'cobblestone', 'withdrawn'], ['/deposit', 'stone', 'deposited']]) {
    digLock.holder = null
    const e = await refused(route, { name }, env)
    assert.strictEqual(e.message, `busy: the buried self-rescue is running, nothing ${skipped}`, route)
    assert.strictEqual(e.reason, 'busy', route)
  }
  assert.deepStrictEqual(opened, [])
})

test('a bunker build starting during a stack pause stops withdraw and deposit before their next click', async () => {
  const chest = chestWindow([stack('cobblestone', 64), stack('cobblestone', 64)])
  const { env } = chestEnv([NEAR], { '5,64,0': chest }, [stack('stone', 64), stack('stone', 20)])
  const digLock = botConstant('digLock')
  env.digLock = digLock
  const { claimDig } = loadBotFunctions(['claimDig'], { digLock })
  const clicks = []
  for (const method of ['withdraw', 'deposit']) {
    const real = chest[method]
    chest[method] = async (type, metadata, count) => {
      clicks.push(method)
      return real(type, metadata, count)
    }
  }
  env.stackPause = async () => { claimDig('the bunker build', true).sole = true }
  const withdrew = await refused('/withdraw', { name: 'cobblestone', count: '128' }, env)
  assert.strictEqual(withdrew.message, 'withdrew cobblestone 64; then cobblestone: busy: the bunker build is running, nothing more moved')
  assert.strictEqual(withdrew.reason, 'busy')
  digLock.holder = null
  const deposited = await refused('/deposit', { name: 'stone' }, env)
  assert.match(deposited.message, /^deposited 64 then failed: busy: the bunker build is running, nothing more moved; stone in chest now 64; /)
  assert.strictEqual(deposited.reason, 'busy')
  assert.deepStrictEqual(clicks, ['withdraw', 'deposit'])
  assert.ok(chest.closed, 'the window stays open')
})

test('a fight starting during the walk or a stack pause stops withdraw and deposit before their next click, and the chest closes before the hand lease ends', async () => {
  const chest = chestWindow([stack('cobblestone', 64), stack('cobblestone', 64)])
  const { env, fight } = chestEnv([NEAR], { '5,64,0': chest }, [stack('stone', 64), stack('stone', 20)])
  const clicks = []
  for (const method of ['withdraw', 'deposit']) {
    const real = chest[method]
    chest[method] = async (type, metadata, count) => {
      clicks.push([method, count, env.guardState.hand !== null])
      return real(type, metadata, count)
    }
  }
  const leased = []
  const close = chest.close
  chest.close = () => { leased.push(env.guardState.hand !== null); close() }
  env.stackPause = async () => { fight.busy = true }

  assert.strictEqual(await refusal('/withdraw', { name: 'cobblestone', count: '128' }, env), 'withdrew cobblestone 64; then cobblestone: a fight started')
  fight.busy = false
  assert.match(await refusal('/deposit', { name: 'stone' }, env), /^deposited 64 then failed: a fight started; stone in chest now 64; /)
  assert.deepStrictEqual(clicks, [['withdraw', 64, true], ['deposit', 64, true]])
  assert.deepStrictEqual([leased, env.guardState.hand], [[true, true], null])

  fight.busy = false
  env.bot.pathfinder.goto = async () => { fight.busy = true }
  assert.strictEqual(await refusal('/withdraw', { name: 'cobblestone' }, env), 'a fight started')
  assert.strictEqual(clicks.length, 2)
})

test('withdraw moves what a chest stack holds after the stack pause', async () => {
  const chest = chestWindow([stack('cobblestone', 64), stack('cobblestone', 64)])
  const { env } = chestEnv([NEAR], { '5,64,0': chest })
  const take = chest.withdraw
  env.stackPause = () => take(IDS.cobblestone, null, 54)
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'cobblestone', count: '128' }, env), { withdrew: [{ item: 'cobblestone', count: 74 }] })
  assert.deepStrictEqual(chest.containerItems(), [])
})

test('deposit moves what a pocket stack holds after the stack pause', async () => {
  const chest = chestWindow([])
  const { env } = chestEnv([NEAR], { '5,64,0': chest }, [stack('stone', 64), stack('stone', 20)])
  env.stackPause = async () => { chest.pockets[1].count = 5 }
  assert.deepStrictEqual(await awaitRoute('/deposit', { name: 'stone' }, env), { deposited: [{ item: 'stone', count: 69, inChestNow: 69 }] })
})

test('deposit into a full half of a double chest names neither of its cells and another double by both', async () => {
  const full = Array.from({ length: CHEST_SLOTS }, () => stack('stone', 64))
  const windows = { '6,64,0': chestWindow(full) }
  const states = { '5,64,0': LEFT, '6,64,0': RIGHT, '-8,64,3': LEFT, '-7,64,3': RIGHT }
  const { env, opened } = chestEnv([NEAR, new Vec3(6, 64, 0), FAR, new Vec3(-8, 64, 3)], windows, [stack('diamond', 5)], states)
  const error = await refusal('/deposit', { name: 'diamond', x: '6', y: '64', z: '0' }, env)
  assert.match(error, /^deposited 0 then failed \(chest full\?\): destination full; diamond in chest now 0; /)
  assert.match(error, /other chests seen within 12: -7,64,3 and -8,64,3 \(10\.5 away\)$/)
  assert.doesNotMatch(error, /5,64,0|6,64,0/)
  assert.deepStrictEqual(opened, ['6,64,0'])
})

test('a failing chest, withdraw or deposit names the other seen chests and no unseen one', async () => {
  const unopened = chestEnv([NEAR, FAR, HIDDEN], {})
  unopened.env.bot.openContainer = async () => { throw new Error('Event windowOpen did not fire within timeout of 20000ms') }
  const shut = await refusal('/chest', {}, unopened.env)
  assert.match(shut, /^cannot open the chest at 5,64,0: /)
  assert.match(shut, /other chests seen within 12: -7,64,3 \(9\.5 away\)$/)
  assert.doesNotMatch(shut, /0,64,-3/)

  const stocked = { '5,64,0': chestWindow([stack('cobblestone', 10)]), '0,64,-3': chestWindow([stack('diamond', 3)]) }
  const lacking = chestEnv([NEAR, FAR, HIDDEN], stocked)
  assert.match(await refusal('/withdraw', { name: 'diamond' }, lacking.env), /^no diamond in chest; other chests seen within 12: -7,64,3 \(9\.5 away\)$/)
  assert.deepStrictEqual(lacking.opened, ['5,64,0'])
  assert.ok(stocked['5,64,0'].closed, 'withdraw: the window stays open')

  const pocketsFull = { '5,64,0': chestWindow([stack('cobblestone', 10)]) }
  pocketsFull['5,64,0'].withdraw = async () => { throw new Error('destination full') }
  assert.strictEqual(await refusal('/withdraw', { name: 'cobblestone' }, chestEnv([NEAR], pocketsFull).env), 'destination full')
  assert.ok(pocketsFull['5,64,0'].closed, 'withdraw into full pockets: the window stays open')

  const full = [...Array.from({ length: CHEST_SLOTS - 1 }, () => stack('stone', 64)), stack('cobblestone', 50)]
  const windows = { '5,64,0': chestWindow(full) }
  const { env, opened } = chestEnv([NEAR, FAR, HIDDEN], windows, [stack('cobblestone', 20)])
  const error = await refusal('/deposit', { name: 'cobblestone' }, env)
  assert.match(error, /^deposited 14 then failed/)
  assert.match(error, /cobblestone in chest now 64/)
  assert.match(error, /other chests seen within 12: -7,64,3 \(9\.5 away\)$/)
  assert.doesNotMatch(error, /0,64,-3/)
  assert.deepStrictEqual(opened, ['5,64,0'])
  assert.ok(windows['5,64,0'].closed, 'deposit: the window stays open')
})

test('chest at an unseen x,y,z refuses without naming or opening it, and names a seen block that is no chest', async () => {
  const { env, opened } = chestEnv([HIDDEN], { '0,64,-3': chestWindow([stack('diamond', 3)]) })
  const error = await refusal('/chest', { x: '0', y: '64', z: '-3' }, env)
  assert.match(error, /not in my sight, blocked or unlit/)
  assert.doesNotMatch(error, /chest|diamond/)
  assert.deepStrictEqual(opened, [])
  assert.strictEqual(await refusal('/chest', { x: '1', y: '64', z: '0' }, env), 'no chest at 1,64,0 (air)')
})

test('chest at a negative fractional x,y,z opens the chest in the cell that holds the point', async () => {
  const { env, opened } = chestEnv([new Vec3(-4, 64, -1)], { '-4,64,-1': chestWindow([stack('cobblestone', 10)]) })
  const reply = await awaitRoute('/chest', { x: '-3.5', y: '64.2', z: '-0.5' }, env)
  assert.deepStrictEqual([reply.at, opened], [{ x: -4, y: 64, z: -1 }, ['-4,64,-1']])
})

// A chest on a 2-high stone pillar, the feet at y 63.
const RAISED = new Vec3(0, 65, 0)
const SINGLE = ['chest', { facing: 'north', type: 'single', waterlogged: 'false' }]
function raisedWorld (cells = {}) {
  return new Proxy({}, {
    get (_, k) {
      if (typeof k !== 'string') return undefined
      if (cells[k]) return cells[k]
      const [x, y, z] = k.split(',').map(Number)
      if (x === 0 && z === 0 && y >= 63 && y <= 65) return y === 65 ? SINGLE : ['stone', {}]
      return [y <= 62 ? 'stone' : 'air', {}]
    }
  })
}

// A 3 by 3 grid of points on each face of a cell, as offsets from its corner, with the face's axis and whether it faces up the axis.
const FACE_POINTS = []
for (let k = 0; k < 3; k++) {
  for (const up of [0, 1]) {
    for (const u of [0.2, 0.5, 0.8]) {
      for (const v of [0.2, 0.5, 0.8]) {
        const q = [0, 0, 0]
        q[k] = up
        q[(k + 1) % 3] = u
        q[(k + 2) % 3] = v
        FACE_POINTS.push({ k: 'xyz'[k], up, q: new Vec3(...q) })
      }
    }
  }
}

// chestEnv on the real planner, whose goto leaves the goal set where mineflayer-pathfinder's goto does.
async function plannedChestEnv (t, feet, world, at, items = [], pockets = []) {
  const walk = await walkingBody(t, feet, world)
  // The Timeout case runs out this budget.
  walk.bot.pathfinder.thinkTimeout = 1000
  const { env, opened } = chestEnv([at], { [`${at.x},${at.y},${at.z}`]: chestWindow(items) }, pockets)
  const { bot } = env
  const { pathfinder } = walk.bot
  const named = (name, message) => Object.assign(new Error(message), { name })
  const walks = []
  const watch = {
    bot: walk.bot,
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    guardWork,
    watchScope: new AsyncLocalStorage(),
    reflexes: [{ name: 'unstuck', active: false }],
    litFuse: () => null
  }
  pathfinder.goto = loadBotFunctions(['watchGoto', 'stopPath'], watch).watchGoto(async (goal) => {
    pathfinder.setGoal(goal)
    let result
    for (const step of pathfinder.getPathFromTo(pathfinder.movements, bot.entity.position, goal)) result = step.result
    const { status, path } = result
    walks.push(path.length)
    if (!path.length) {
      if (goal.isEnd(bot.entity.position.floored())) pathfinder.setGoal(null)
      return
    }
    if (status === 'noPath') throw named('NoPath', 'No path to the goal!')
    if (status === 'timeout') throw named('Timeout', 'Took to long to decide path to goal!')
    const end = path[path.length - 1]
    bot.entity.position = new Vec3(end.x, end.y, end.z)
    pathfinder.setGoal(null)
  })
  const raycast = (...ray) => WorldSync.prototype.raycast.apply({ getBlock: (p) => walk.bot.blockAt(p) }, ray)
  Object.assign(bot, { entity: walk.bot.entity, blockAt: walk.bot.blockAt, world: { raycast }, pathfinder })
  // Whether a line from the eye reaches a point of FACE_POINTS on a face of p turned to it, crossing only empty cells besides p.
  const sees = (eye, p) => FACE_POINTS.some(({ k, up, q }) => {
    const point = p.plus(q)
    if ((eye[k] - point[k]) * (up ? 1 : -1) <= 0) return false
    const steps = Math.ceil(eye.distanceTo(point) / 0.05)
    for (let i = 1; i < steps; i++) {
      const c = eye.plus(point.minus(eye).scaled(i / steps)).floored()
      if (!c.equals(p) && walk.bot.blockAt(c).boundingBox !== 'empty') return false
    }
    return true
  })
  const open = bot.openContainer
  bot.openContainer = async (b) => {
    const feet = bot.entity.position
    if (!sees(feet.offset(0, 1.62, 0), b.position)) throw new Error(`the chest is out of sight from ${feet}`)
    if (feet.distanceTo(b.position.offset(0.5, 0.5, 0.5)) >= LEGACY_CLICK_REACH) throw new Error(`the chest is out of reach from ${feet}`)
    return open(b)
  }
  return { env, opened, walks, pathfinder }
}

// Turns an offset x, z from the chest so the corridor at local +x lies on side.
const TURNS = { '+x': (x, z) => [x, z], '-x': (x, z) => [-x, -z], '+z': (x, z) => [-z, x], '-z': (x, z) => [z, -x] }
const UNTURNS = { '+x': TURNS['+x'], '-x': TURNS['-x'], '+z': TURNS['-z'], '-z': TURNS['+z'] }
const FACING = { '+x': 'east', '-x': 'west', '+z': 'south', '-z': 'north' }
const SIDES = Object.keys(TURNS)
// A chest at 0,y,0 in stone beside a 1-wide corridor 2 high on side, from 2 cells before it to 8 past it, the feet at y 63.
function corridorWorld (side, y) {
  return new Proxy({}, {
    get (_, k) {
      if (typeof k !== 'string') return undefined
      const [wx, wy, wz] = k.split(',').map(Number)
      const [x, z] = UNTURNS[side](wx, wz)
      if (wy <= 62) return ['stone', {}]
      if (wy >= 66) return ['air', {}]
      if (x === 0 && z === 0 && wy === y) return ['chest', { facing: FACING[side], type: 'single', waterlogged: 'false' }]
      return [x === 1 && z >= -2 && z <= 8 && wy <= 64 ? 'air' : 'stone', {}]
    }
  })
}
// The feet in the corridor of corridorWorld, along cells past the cell beside the chest.
function corridorFeet (side, along) {
  const [x, z] = TURNS[side](1, along)
  return new Vec3(x + 0.5, 63, z + 0.5)
}
const cellQuery = (p) => ({ name: 'cobblestone', x: String(p.x), y: String(p.y), z: String(p.z) })
async function chestWalk (route, query, planned) {
  const { handle, res } = routeHandler(route, planned.env)
  await handle({ query }, res)
  const { x, y, z } = planned.env.bot.entity.position
  const goal = planned.pathfinder.goal
  return { walks: planned.walks, opened: planned.opened, goal: goal && goal.constructor.name, feet: [x, y, z], error: res.error && res.error.message }
}
const walked = (steps, cell, feet) => ({ walks: [steps], opened: [cell], goal: null, feet: [feet.x, feet.y, feet.z], error: undefined })

test('chest opens a chest in the wall beside a 1-wide corridor from the cell beside it without a step, on each side and at both heights', async (t) => {
  const got = {}
  const want = {}
  for (const side of SIDES) {
    for (const y of [63, 64]) {
      const at = new Vec3(0, y, 0)
      const feet = corridorFeet(side, 0)
      got[`${side} y ${y}`] = await chestWalk('/chest', cellQuery(at), await plannedChestEnv(t, feet, corridorWorld(side, y), at))
      want[`${side} y ${y}`] = walked(0, `0,${y},0`, feet)
    }
  }
  assert.deepStrictEqual(got, want)
})

test('chest walks from 4 and from 8 cells down a corridor to 3 cells down before opening a chest in its wall, at both heights', async (t) => {
  const cases = [[4, 63, 1, 3], [4, 64, 1, 3], [8, 63, 5, 3], [8, 64, 5, 3]]
  const got = {}
  const want = {}
  for (const side of SIDES) {
    for (const [from, y, steps, end] of cases) {
      const at = new Vec3(0, y, 0)
      const key = `${side} y ${y} from ${from}`
      got[key] = await chestWalk('/chest', cellQuery(at), await plannedChestEnv(t, corridorFeet(side, from), corridorWorld(side, y), at))
      want[key] = walked(steps, `0,${y},0`, corridorFeet(side, end))
    }
  }
  assert.deepStrictEqual(got, want)
})

test('chest walks before opening a chest whose centre is more than 4.2 from the eye but in click reach of the feet', async (t) => {
  const at = new Vec3(0, 63, 0)
  const centre = at.offset(0.5, 0.5, 0.5)
  const feet = corridorFeet('+x', 4)
  assert.ok(feet.offset(0, 1.62, 0).distanceTo(centre) > 4.2, 'the eye is in human reach')
  assert.ok(feet.distanceTo(centre) < LEGACY_CLICK_REACH - Math.SQRT1_2, 'the feet are out of click reach')
  const { walks, opened } = await chestWalk('/chest', cellQuery(at), await plannedChestEnv(t, feet, corridorWorld('+x', 63), at))
  assert.ok(walks[0] >= 1, `walked ${walks[0]} steps`)
  assert.deepStrictEqual(opened, ['0,63,0'])
})

const AT_RAISED = { x: '0', y: '65', z: '0' }

test('chest and deposit open a chest 2 above the floor from a cell beside it without a step, and leave no goal set', async (t) => {
  for (const feet of [new Vec3(1.5, 63, 1.5), new Vec3(1.5, 63, 0.5)]) {
    for (const route of ['/chest', '/deposit']) {
      const planned = await plannedChestEnv(t, feet, raisedWorld(), RAISED, [], [stack('cobblestone', 5)])
      assert.deepStrictEqual(await chestWalk(route, cellQuery(RAISED), planned), walked(0, '0,65,0', feet), `${route} from ${feet}`)
    }
  }
})

test('withdraw walks from 4 and from 8 cells away to 3 cells away before opening a chest 2 above the floor', async (t) => {
  for (const [from, steps] of [[4, 1], [8, 5]]) {
    const planned = await plannedChestEnv(t, new Vec3(from + 0.5, 63, 0.5), raisedWorld(), RAISED, [stack('cobblestone', 10)])
    assert.deepStrictEqual(await chestWalk('/withdraw', cellQuery(RAISED), planned), walked(steps, '0,65,0', new Vec3(3.5, 63, 0.5)), `from ${from}`)
  }
})

test('chest opens a chest already in reach and sight without a step', async (t) => {
  const feet = new Vec3(-0.5, 63, 0.5)
  const { env, opened, walks, pathfinder } = await plannedChestEnv(t, feet, raisedWorld(), RAISED)
  await awaitRoute('/chest', AT_RAISED, env)
  assert.deepStrictEqual([walks, opened, env.bot.entity.position, pathfinder.goal], [[0], ['0,65,0'], feet, null])
})

test('chest opens a chest on a pillar 4 above a slab floor from a slab beside it without a step', async (t) => {
  const at = new Vec3(0, 67, 0)
  const world = new Proxy({}, {
    get (_, k) {
      if (typeof k !== 'string') return undefined
      const [x, y, z] = k.split(',').map(Number)
      if (x === 0 && z === 0 && y >= 63 && y <= 67) return y === 67 ? SINGLE : ['stone', {}]
      if (y === 63) return ['stone_slab', { type: 'bottom', waterlogged: 'false' }]
      return [y <= 62 ? 'stone' : 'air', {}]
    }
  })
  const feet = new Vec3(2.5, 63.5, 0.5)
  assert.deepStrictEqual(await chestWalk('/chest', cellQuery(at), await plannedChestEnv(t, feet, world, at)), walked(0, '0,67,0', feet))
})

test('chest, withdraw and deposit refuse a chest out of sight from where a walk on an empty plan ends, clear its goal and open nothing', async (t) => {
  // The feet stand in a 1-cell room of stone 3 high, with the chest 1 cell beyond its wall.
  const at = new Vec3(0, 63, 0)
  const world = new Proxy({}, {
    get (_, k) {
      if (typeof k !== 'string') return undefined
      const [x, y, z] = k.split(',').map(Number)
      if (y <= 62) return ['stone', {}]
      if (y >= 66) return ['air', {}]
      if (x === 0 && y === 63 && z === 0) return SINGLE
      return [x === 2 && z === 0 && y <= 64 ? 'air' : 'stone', {}]
    }
  })
  const feet = new Vec3(2.5, 63, 0.5)
  for (const route of ['/chest', '/withdraw', '/deposit']) {
    const planned = await plannedChestEnv(t, feet, world, at, [stack('cobblestone', 10)], [stack('cobblestone', 5)])
    const { error, ...rest } = await chestWalk(route, cellQuery(at), planned)
    assert.match(String(error), /the chest at 0,63,0 is out of reach or sight from 2,63,0, where the walk ended/, route)
    assert.deepStrictEqual(rest, { walks: [0], opened: [], goal: null, feet: [2.5, 63, 0.5] }, route)
  }
})

test('chest, withdraw and deposit leave no goal set after a walk that ends in NoPath or Timeout under the watch on every goto', async (t) => {
  // Stone walls 3 high around a 2-cell pen hide the chest from the NoPath feet.
  const pen = {}
  for (let x = 1; x <= 4; x++) {
    for (let z = -1; z <= 1; z++) {
      if (z === 0 && (x === 2 || x === 3)) continue
      for (let y = 63; y <= 65; y++) pen[`${x},${y},${z}`] = ['stone', {}]
    }
  }
  const high = new Vec3(0, 72, 0)
  // Each plan leads to the cell nearest the chest.
  const cases = [
    ['NoPath', new Vec3(3.5, 63, 0.5), raisedWorld(pen), RAISED, /No path to the goal!/, 1],
    ['Timeout', new Vec3(4.5, 63, 0.5), raisedWorld({ '0,72,0': SINGLE }), high, /Took to long to decide path to goal!/, 3]
  ]
  for (const [outcome, feet, world, at, failed, steps] of cases) {
    for (const route of ['/chest', '/withdraw', '/deposit']) {
      const planned = await plannedChestEnv(t, feet, world, at, [stack('cobblestone', 10)], [stack('cobblestone', 5)])
      const { error, ...rest } = await chestWalk(route, cellQuery(at), planned)
      assert.match(String(error), failed, `${outcome} ${route}`)
      assert.deepStrictEqual(rest, { walks: [steps], opened: [], goal: null, feet: [feet.x, feet.y, feet.z] }, `${outcome} ${route}`)
    }
  }
})
