'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { ROUTE_BOUNDS } = require('../lib/bounds')
const { goals } = require('mineflayer-pathfinder')
const { GRAVESTONE } = require('../lib/server-overrides')
const { startApp, routeHandler, runRoute, awaitRoute, fakeClock, fakeFile, toolNamed } = require('./helpers')

const PROTO_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty']

function assertRefused (r, param, label) {
  assert.strictEqual(r.status, 400, label)
  assert.ok(r.json && r.json.ok === false && typeof r.json.error === 'string', `${label}: ${r.body}`)
  assert.ok(r.json.error.startsWith(`${param}: `), `${label}: ${r.body}`)
}

// The reply a handler run by routeHandler gave, copied out of its context.
function replyIn (res) {
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return JSON.parse(JSON.stringify(res.body))
}

// ---- table lookups (CWE-1321) ----

test('/stance set and /gaze dir take every value the MCP tool offers, a prototype key gets 400 and the handler does not run', async (t) => {
  const s = await startApp(t)
  for (const [route, p, tool] of [['/stance', 'set', 'stance'], ['/gaze', 'dir', 'gaze']]) {
    const values = toolNamed(tool).params[p].values
    for (const v of values) assert.strictEqual((await s.get(`${route}?${p}=${v}`)).status, 200, `control: ${route}?${p}=${v}`)
    for (const v of PROTO_KEYS) assertRefused(await s.get(`${route}?${p}=${v}`), p, `${route}?${p}=${v}`)
    assert.strictEqual(s.routeHits(route).length, values.length, `${route} ran for a prototype key`)
  }
})

test('/gaze dir folds case before the table check: N and Up pass the guard', async (t) => {
  const s = await startApp(t)
  for (const v of ['N', 'Up']) assert.strictEqual((await s.get(`/gaze?dir=${v}`)).status, 200, `dir=${v}`)
  assert.strictEqual(s.routeHits('/gaze').length, 2)
})

// ---- perception ----

test('/find with xray=1 replies as without it for a block only the raw index holds', () => {
  const here = new Vec3(0, 64, 0)
  const ore = new Vec3(3, 60, 0)
  const env = (visible) => ({
    shared: { ready: true },
    resolveBlockIds: () => [56],
    bot: { entity: { position: here }, findBlocks: () => [ore], blockAt: () => ({ name: 'diamond_ore' }) },
    findVisible: () => visible.map((pos) => ({ pos, dist: pos.distanceTo(here) })),
    cropAge: () => ({})
  })
  assert.strictEqual(runRoute('/find', { name: 'diamond_ore' }, env([ore])).count, 1, 'control: a block in sight')
  const hidden = runRoute('/find', { name: 'diamond_ore' }, env([]))
  assert.strictEqual(hidden.count, 0, 'control: a block out of sight')
  assert.deepStrictEqual(runRoute('/find', { name: 'diamond_ore', xray: '1' }, env([])), hidden)
})

test('/entities with all=1 replies as without it for a mob the perception fill does not perceive', () => {
  const here = new Vec3(0, 64, 0)
  const zombie = { type: 'hostile', name: 'zombie', position: new Vec3(5, 64, 0) }
  const env = (perceived) => ({
    shared: { ready: true },
    bot: { entity: { position: here } },
    reflexes: [{ name: 'combat', fairFill: () => ({}) }],
    liveEntities: () => [zombie],
    entityPerceptible: () => perceived,
    entityLabel: (en) => en.name,
    round: (p) => ({ x: p.x, y: p.y, z: p.z })
  })
  assert.strictEqual(runRoute('/entities', {}, env(true)).count, 1, 'control: a perceived mob')
  const unseen = runRoute('/entities', {}, env(false))
  assert.strictEqual(unseen.count, 0, 'control: a mob not perceived')
  assert.deepStrictEqual(runRoute('/entities', { all: '1' }, env(false)), unseen)
})

// ---- integers (ASVS 2.2.1) ----

const INT_PARAMS = [
  ['/strike', 'max'], ['/shoot', 'max'], ['/brace', 'sec'], ['/hold', 'sec'],
  ['/pillar', 'height'], ['/pathdebug', 'secs'], ['/threatdebug', 'secs'], ['/journal', 'n']
]

test('combat, pillar, debug and journal integers outside their bounds or not whole numbers get 400 and the handler does not run', async (t) => {
  const s = await startApp(t)
  for (const [route, p] of INT_PARAMS) {
    const bound = ROUTE_BOUNDS[route] && ROUTE_BOUNDS[route][p]
    assert.ok(Array.isArray(bound), `${route} ${p} has no bound`)
    const [min, max] = bound
    for (const v of [min, max]) assert.strictEqual((await s.get(`${route}?${p}=${v}`)).status, 200, `control: ${route}?${p}=${v}`)
    for (const v of [min - 1, max + 1, 'abc']) assertRefused(await s.get(`${route}?${p}=${v}`), p, `${route}?${p}=${v}`)
    assert.strictEqual(s.routeHits(route).length, 2, `${route} ran for a refused ${p}`)
  }
})

// ---- coordinates ----

const COORD_ROUTES = [
  ['/outline', ['x', 'z']], ['/walls', ['x', 'z']], ['/build', ['x', 'z']], ['/roof', ['x', 'y', 'z']], ['/lookat', ['x', 'y', 'z']]
]
const AT = { x: 1, y: 64, z: 1 }
const query = (names, extra = '') => [...names.map((n) => `${n}=${AT[n]}`), extra].filter(Boolean).join('&')

test('a building route or /lookat without a required coordinate gets 400 naming it and the handler does not run', async (t) => {
  const s = await startApp(t)
  for (const [route, names] of COORD_ROUTES) {
    assert.strictEqual((await s.get(`${route}?${query(names)}`)).status, 200, `control: ${route}?${query(names)}`)
    for (const gone of names) {
      const r = await s.get(`${route}?${query(names.filter((n) => n !== gone))}`)
      assert.strictEqual(r.status, 400, `${route} without ${gone}`)
      assert.deepStrictEqual(r.json, { ok: false, error: `${gone}: required` }, `${route} without ${gone}`)
    }
    assert.strictEqual(s.routeHits(route).length, 1, `${route} ran without a required coordinate`)
  }
})

test('a coordinate that is no finite number, or a y or base outside the build height, gets 400 and the handler does not run', async (t) => {
  const s = await startApp(t)
  for (const [route, names] of COORD_ROUTES) {
    const others = names.filter((n) => n !== 'x')
    const bad = [['x', `x=1e999&${query(others)}`]]
    if (route === '/walls' || route === '/build') bad.push(['base', query(names, 'base=abc')])
    else bad.push(['y', query(names.filter((n) => n !== 'y'), 'y=320')])
    assert.strictEqual((await s.get(`${route}?${query(names)}`)).status, 200, `control: ${route}?${query(names)}`)
    for (const [p, q] of bad) assertRefused(await s.get(`${route}?${q}`), p, `${route}?${q}`)
    assert.strictEqual(s.routeHits(route).length, 1, `${route} ran for a bad coordinate`)
  }
})

// ---- coordinates per route ----

// Routes that read x, y and z with no default.
const XYZ_ROUTES = ['/lookat', '/blockat', '/digat', '/placeitem', '/sign', '/activate', '/use']
// Routes that read x, y and z all three or none, with the rest of their query.
const ALL_OR_NONE = [['/waypoint', 'name=a'], ['/fish', ''], ['/chest', ''], ['/withdraw', 'name=a'], ['/deposit', 'name=a']]
const XYZ = 'x=1&y=64&z=1'
const SUBSETS = [['x'], ['y', 'z']]

test('a coordinate a route never reads passes its guard, one it reads is checked', async (t) => {
  const s = await startApp(t)
  const ignored = [
    '/goto?x=1&z=1&base=abc', '/outline?x=1&z=1&base=abc', '/lookat?x=1&y=64&z=1&base=999',
    '/walls?x=1&z=1&y=abc', '/build?x=1&z=1&y=abc', '/walls?x=1&z=1&y=320', '/build?x=1&z=1&y=320',
    ...XYZ_ROUTES.map((route) => `${route}?${XYZ}&base=abc`),
    ...ALL_OR_NONE.map(([route, rest]) => `${route}?${[rest, XYZ, 'base=abc'].filter(Boolean).join('&')}`)
  ]
  for (const target of ignored) assert.strictEqual((await s.get(target)).status, 200, target)
  for (const route of ['/walls', '/build']) assertRefused(await s.get(`${route}?x=1&z=1&base=abc`), 'base', `${route} base=abc`)
  assert.strictEqual(s.hits.length, ignored.length, 'a handler ran for a bad base')
})

test('a route reading x, y and z with no default refuses each one missing or bad before the handler', async (t) => {
  const s = await startApp(t)
  for (const route of XYZ_ROUTES) {
    assert.strictEqual((await s.get(`${route}?${XYZ}`)).status, 200, `control: ${route}?${XYZ}`)
    for (const gone of ['x', 'y', 'z']) {
      const q = query(['x', 'y', 'z'].filter((n) => n !== gone))
      const r = await s.get(`${route}?${q}`)
      assert.strictEqual(r.status, 400, `${route}?${q}`)
      assert.deepStrictEqual(r.json, { ok: false, error: `${gone}: required` }, `${route}?${q}`)
    }
    for (const [p, v] of [['z', 'Infinity'], ['y', '320'], ['x', '1e999']]) {
      const q = query(['x', 'y', 'z'].filter((n) => n !== p), `${p}=${v}`)
      assertRefused(await s.get(`${route}?${q}`), p, `${route}?${q}`)
    }
    assert.strictEqual(s.routeHits(route).length, 1, `${route} ran without a valid x, y and z`)
  }
})

test('/waypoint, /fish, /chest, /withdraw and /deposit take x, y and z all three or none', async (t) => {
  const s = await startApp(t)
  const target = (route, rest, q) => `${route}?${[rest, q].filter(Boolean).join('&')}`
  for (const [route, rest] of ALL_OR_NONE) {
    for (const q of ['', XYZ]) assert.strictEqual((await s.get(target(route, rest, q))).status, 200, `control: ${target(route, rest, q)}`)
    for (const given of SUBSETS) {
      const url = target(route, rest, query(given))
      const r = await s.get(url)
      const missing = ['x', 'y', 'z'].filter((n) => !given.includes(n)).map((n) => `${n}: required`)
      assert.strictEqual(r.status, 400, url)
      assert.ok(r.json && r.json.ok === false && missing.includes(r.json.error), `${url}: ${r.body}`)
    }
    for (const [p, q] of [['y', 'x=1&y=-65&z=1'], ['z', 'x=1&y=64&z=abc']]) {
      assertRefused(await s.get(target(route, rest, q)), p, target(route, rest, q))
    }
    assert.strictEqual(s.routeHits(route).length, 2, `${route} ran for one or two coordinates or a bad one`)
  }
})

// ---- /pathdebug ----

test('/pathdebug holds one tap: repeated calls leave one listener per event, removed once the last call\'s secs pass', () => {
  const EVENTS = ['path_update', 'path_reset', 'goal_updated', 'goal_reached']
  const clock = fakeClock()
  const bot = new EventEmitter()
  for (const ev of EVENTS) bot.on(ev, () => {})
  const counts = () => EVENTS.map((ev) => bot.listenerCount(ev))
  const { handle } = routeHandler('/pathdebug', { bot, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, console: { log () {} } })
  const tap = () => {
    const res = {}
    handle({ query: { secs: '5' } }, res)
    return replyIn(res)
  }
  assert.deepStrictEqual(tap(), { tapping: 5 }, 'control')
  assert.deepStrictEqual(counts(), [2, 2, 2, 2], 'control: one tap adds one listener per event')
  for (let i = 0; i < 8; i++) tap()
  clock.advance(3000)
  assert.deepStrictEqual(tap(), { tapping: 5 })
  assert.deepStrictEqual(counts(), [2, 2, 2, 2], 'after 10 calls')
  assert.strictEqual(clock.pending(), 1, 'timers of replaced taps')
  clock.advance(4999)
  assert.deepStrictEqual(counts(), [2, 2, 2, 2], 'before the last call\'s 5 s')
  clock.advance(1)
  assert.deepStrictEqual(counts(), [1, 1, 1, 1], 'after the last call\'s 5 s')
})

// ---- /grave and /furnace ----

const RAW_AT = '0x5, +64.9 ,0.5'
const STATION = new Vec3(5, 64, 0)

// The env of /grave and /furnace with a block named name at STATION and every cell in sight.
function stationEnv (name) {
  const block = { name, type: 7, position: STATION }
  const window = { containerItems: () => [], inputItem: () => null, fuelItem: () => null, outputItem: () => null, close () {} }
  return {
    bot: {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      blockAt: (p) => (p.equals(STATION) ? block : { name: 'air', type: 0, position: p }),
      pathfinder: { goto: async () => {} },
      openBlock: async () => window,
      openFurnace: async () => window,
      waitForTicks: async () => {}
    },
    shared: { ready: true, mcData: { blocksByName: { [GRAVESTONE]: { id: 7, name: GRAVESTONE } } } },
    seesLit: () => true,
    seenNow: () => true,
    STATIONS: new Map(),
    ck: (x, y, z) => x + ',' + y + ',' + z,
    resolveBlockIds: () => [7],
    goals,
    Vec3,
    GRAVESTONE,
    GRAVE_SIGHT: 32,
    round: (v) => ({ x: v.x, y: v.y, z: v.z })
  }
}

test('/grave and /furnace name the cell an at value parses to in their errors, never the raw value', async () => {
  for (const [route, name, what] of [['/grave', GRAVESTONE, 'gravestone'], ['/furnace', 'furnace', 'furnace']]) {
    assert.deepStrictEqual((await awaitRoute(route, { at: RAW_AT }, stationEnv(name))).at, { x: 5, y: 64, z: 0 }, `control: ${route} at=${RAW_AT}`)
    const { handle, res } = routeHandler(route, stationEnv('stone'))
    await handle({ query: { at: RAW_AT } }, res)
    assert.ok(res.error, `${route} answered ${JSON.stringify(res.body)}`)
    assert.strictEqual(res.error.message, `no ${what} at 5,64,0 (stone)`, route)
  }
})

// ---- /journal ----

const JOURNAL_TAIL = 65536

function journal (text, n) {
  const file = fakeFile(text)
  return { reply: runRoute('/journal', { n: String(n) }, { fs: file.fs }), bytes: file.bytesRead() }
}

test('/journal keeps the first line of its 64 KiB tail whole when the tail starts with it and drops a line the cut splits', () => {
  const kept = 'first kept '.padEnd(JOURNAL_TAIL - 1 - 'second\nthird\n'.length - 1, 'k')
  assert.strictEqual(`\n${kept}\nsecond\nthird\n`.length, JOURNAL_TAIL, 'control: the cut lands on the newline before kept')
  const atStart = journal(`old line\n${kept}\nsecond\nthird\n`, 30)
  assert.ok(atStart.bytes <= JOURNAL_TAIL, `read ${atStart.bytes} bytes`)
  assert.deepStrictEqual(atStart.reply.lines, [kept, 'second', 'third'], 'cut on a line start')
  const split = journal(`old line\ncut ${'c'.repeat(JOURNAL_TAIL)}\nsecond\nthird\n`, 30)
  assert.ok(split.bytes <= JOURNAL_TAIL, `read ${split.bytes} bytes`)
  assert.deepStrictEqual(split.reply.lines, ['second', 'third'], 'cut inside a line')
})

test('/journal reads at most the last 64 KiB of a 1 MiB journal and replies with its last n lines', () => {
  assert.deepStrictEqual(journal('first\nsecond\n\nthird\n', 1).reply, { count: 1, lines: ['third'] }, 'a 3-line journal')
  assert.deepStrictEqual(journal(null, 1).reply.lines, [], 'control: no journal file')
  const lines = []
  for (let i = 0, size = 0; size < 1024 * 1024; i++) {
    lines.push(`line ${String(i).padStart(6, '0')}`)
    size += lines[lines.length - 1].length + 1
  }
  const text = lines.join('\n') + '\n'
  for (const n of [50, 1]) {
    const { reply, bytes } = journal(text, n)
    assert.deepStrictEqual(reply.lines, lines.slice(-n), `n=${n}`)
    assert.ok(bytes <= JOURNAL_TAIL, `n=${n}: read ${bytes} bytes of a ${text.length}-byte journal`)
  }
})
