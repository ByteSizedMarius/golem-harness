'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { awaitRoute, routeHandler, botConstant } = require('./helpers')

const CHEST_ID = 54
const IDS = { stone: 1, cobblestone: 4, diamond: 264 }
const NAMES = Object.fromEntries(Object.entries(IDS).map(([n, id]) => [id, n]))
const CHEST_SLOTS = 27
const HERE = new Vec3(0.5, 64, 0.5)
const NEAR = new Vec3(5, 64, 0)
const FAR = new Vec3(-7, 64, 3)
// Nearer than NEAR and FAR.
const HIDDEN = new Vec3(0, 64, -3)

const stack = (name, count) => ({ name, type: IDS[name], count })

// A single chest whose deposit fills partial stacks, then empty slots, then fails like mineflayer's.
function chestWindow (items) {
  const slots = items.map((s) => ({ ...s }))
  const window = {
    closed: false,
    containerItems: () => slots.map((s) => ({ ...s })),
    async deposit (type, metadata, count) {
      while (count > 0) {
        let s = slots.find((x) => x.type === type && x.count < 64)
        if (!s) {
          if (slots.length >= CHEST_SLOTS) throw new Error('destination full')
          s = { name: NAMES[type], type, count: 0 }
          slots.push(s)
        }
        const n = Math.min(count, 64 - s.count)
        s.count += n
        count -= n
      }
    },
    async withdraw (type, metadata, count) {
      slots.find((x) => x.type === type).count -= count
    },
    close () { window.closed = true }
  }
  return window
}

// windows maps a chest's x,y,z to its window.
function chestEnv (chests, windows, pockets = []) {
  const at = (p) => `${p.x},${p.y},${p.z}`
  const cells = new Set(chests.map(at))
  const opened = []
  const env = {
    bot: {
      entity: { position: HERE },
      blockAt: (p) => (cells.has(at(p)) ? { name: 'chest', type: CHEST_ID, position: p } : { name: 'air', type: 0, position: p }),
      findBlocks: ({ matching, maxDistance }) => (matching.includes(CHEST_ID) ? chests.filter((p) => HERE.distanceTo(p) <= maxDistance) : []),
      pathfinder: { goto: async () => {} },
      openContainer: async (b) => { opened.push(at(b.position)); return windows[at(b.position)] },
      inventory: { items: () => pockets }
    },
    cellKnown: (p) => !p.equals(HIDDEN),
    seenNow: (p) => !p.equals(HIDDEN),
    STATIONS: new Map(),
    ck: (x, y, z) => x + ',' + y + ',' + z,
    require,
    resolveBlockIds: (name) => (name === 'chest' ? [CHEST_ID] : []),
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    goals,
    CHEST_RADIUS: botConstant('CHEST_RADIUS')
  }
  return { env, opened }
}

async function refusal (route, query, env) {
  const { handle, res } = routeHandler(route, env)
  await handle({ query }, res)
  assert.ok(res.error, `${route} answered ${JSON.stringify(res.body)}`)
  return res.error.message
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

test('chest lists a double chest once, by its nearer half', async () => {
  const { env } = chestEnv([new Vec3(6, 64, 0), NEAR, FAR], { '5,64,0': chestWindow([]) })
  assert.deepStrictEqual((await awaitRoute('/chest', {}, env)).chests.map((c) => c.at), [{ x: 5, y: 64, z: 0 }, { x: -7, y: 64, z: 3 }])
})

test('chest refuses when every chest in range is unseen, without naming or opening it', async () => {
  const { env, opened } = chestEnv([HIDDEN], { '0,64,-3': chestWindow([stack('diamond', 3)]) })
  const error = await refusal('/chest', {}, env)
  assert.match(error, /no chest seen within 12/)
  assert.doesNotMatch(error, /0,64,-3|diamond/)
  assert.deepStrictEqual(opened, [])
})

test('withdraw takes the named item, matched as a substring, from the nearest seen chest or the one at x,y,z', async () => {
  const windows = {
    '5,64,0': chestWindow([stack('stone', 64), stack('cobblestone', 10)]),
    '-7,64,3': chestWindow([stack('diamond', 3)]),
    '0,64,-3': chestWindow([stack('cobblestone', 64)])
  }
  const { env, opened } = chestEnv([NEAR, FAR, HIDDEN], windows)
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'cobble', count: '4' }, env), { withdrew: 'cobblestone', count: 4 })
  assert.deepStrictEqual(windows['5,64,0'].containerItems(), [stack('stone', 64), stack('cobblestone', 6)])
  assert.deepStrictEqual(await awaitRoute('/withdraw', { name: 'diamond', x: '-7', y: '64', z: '3' }, env), { withdrew: 'diamond', count: 3 })
  assert.deepStrictEqual(opened, ['5,64,0', '-7,64,3'])
})

test('deposit puts every matching stack into the nearest seen chest and reports the count now in it', async () => {
  const windows = { '5,64,0': chestWindow([stack('cobblestone', 10)]), '0,64,-3': chestWindow([]) }
  const pockets = [stack('cobblestone', 20), stack('stone', 3), stack('cobblestone', 5)]
  const { env, opened } = chestEnv([NEAR, FAR, HIDDEN], windows, pockets)
  assert.deepStrictEqual(await awaitRoute('/deposit', { name: 'cobble' }, env), { deposited: 25, item: 'cobble', inChestNow: 35 })
  assert.deepStrictEqual(windows['5,64,0'].containerItems(), [stack('cobblestone', 35)])
  assert.deepStrictEqual(opened, ['5,64,0'])
})

test('a failing chest, withdraw or deposit names the other seen chests and no unseen one', async () => {
  const unopened = chestEnv([NEAR, FAR, HIDDEN], {})
  unopened.env.bot.openContainer = async () => { throw new Error('Event windowOpen did not fire within timeout of 20000ms') }
  const shut = await refusal('/chest', {}, unopened.env)
  assert.match(shut, /^cannot open the chest at 5,64,0: /)
  assert.match(shut, /other chests seen within 12: -7,64,3 \(7\.6 away\)$/)
  assert.doesNotMatch(shut, /0,64,-3/)

  const stocked = { '5,64,0': chestWindow([stack('cobblestone', 10)]), '0,64,-3': chestWindow([stack('diamond', 3)]) }
  const lacking = chestEnv([NEAR, FAR, HIDDEN], stocked)
  assert.match(await refusal('/withdraw', { name: 'diamond' }, lacking.env), /^no diamond in chest; other chests seen within 12: -7,64,3 \(7\.6 away\)$/)
  assert.deepStrictEqual(lacking.opened, ['5,64,0'])
  assert.ok(stocked['5,64,0'].closed, 'withdraw: the window stays open')

  const full = [...Array.from({ length: CHEST_SLOTS - 1 }, () => stack('stone', 64)), stack('cobblestone', 50)]
  const windows = { '5,64,0': chestWindow(full) }
  const { env, opened } = chestEnv([NEAR, FAR, HIDDEN], windows, [stack('cobblestone', 20)])
  const error = await refusal('/deposit', { name: 'cobblestone' }, env)
  assert.match(error, /^deposited 14 then failed/)
  assert.match(error, /cobblestone in chest now 64/)
  assert.match(error, /other chests seen within 12: -7,64,3 \(7\.6 away\)$/)
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
