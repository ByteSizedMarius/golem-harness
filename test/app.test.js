'use strict'
// Routes registered on the createApp app stand in for the ones bot.js's installRoutes() registers,
// except in the test that installs the lib/routes groups.
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const util = require('node:util')
const { createApp } = require('../lib/app')
const { ROUTE_BOUNDS } = require('../lib/bounds')
const { bindDebugRoutes } = require('../lib/routes/debug')
const { PORT, ROOT, UNAUTHORIZED, codeOnly, hmac, newNonce, startApp, stateControl } = require('./helpers')

// A createApp app on a loopback port, with get(target) sending a GET, signed unless signed is false.
async function factoryServer (t) {
  const token = crypto.randomBytes(32).toString('hex')
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  const port = server.address().port
  const onRequests = []
  const { app, verbs } = createApp({ token, port, chat: { send () {} }, onRequest: (res) => { onRequests.push(res) } })
  server.on('request', app)
  function get (target, { signed = true } = {}) {
    const time = String(Date.now())
    const nonce = newNonce()
    const headers = signed ? { 'X-Golem-Time': time, 'X-Golem-Nonce': nonce, 'X-Golem-Sig': hmac(token, `GET\n${target}\n${time}\n${nonce}`) } : {}
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: target, headers, agent: false }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => { body += d })
        res.on('end', () => {
          let json
          try { json = JSON.parse(body) } catch {}
          resolve({ status: res.statusCode, json })
        })
      })
      req.on('error', reject)
      req.end()
    })
  }
  return { app, verbs, onRequests, get }
}

// The paths under root whose key or string value contains needle.
function stringsWith (root, needle) {
  const found = []
  const seen = new Set()
  const walk = (v, at) => {
    if (typeof v === 'string') {
      if (v.includes(needle)) found.push(at)
      return
    }
    if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) return
    seen.add(v)
    if (v instanceof Map || v instanceof Set) for (const [k, x] of v.entries()) { walk(k, `${at}<key>`); walk(x, `${at}<entry>`) }
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key === 'string' && key.includes(needle)) found.push(`${at}[${key}]`)
      const d = Object.getOwnPropertyDescriptor(v, key)
      if ('value' in d) walk(d.value, `${at}.${String(key)}`)
    }
  }
  walk(root, '')
  return found
}

function assertUnauthorized (r, label) {
  assert.strictEqual(r.status, 401, label)
  assert.deepStrictEqual(r.json, UNAUTHORIZED, label)
}

// ASVS 8.2.1
test('app-I1 an unsigned request gets 401 for a route registered after createApp, an unknown path and a fork file', async (t) => {
  const s = await startApp(t, { createApp: true })
  await stateControl(s)
  assertUnauthorized(await s.get('/state', { signed: false }), '/state')
  assert.strictEqual(s.routeHits('/state').length, 1, '/state ran unsigned')
  for (const target of ['/nope', '/bot.js', '/package.json']) assertUnauthorized(await s.get(target, { signed: false }), target)
  assertUnauthorized(await s.wire('/nope', { method: 'POST', key: null }), 'POST /nope')
})

// ASVS 8.2.1
test('app-I1 every route the lib/routes groups install answers 401 to an unsigned request', async (t) => {
  const f = await factoryServer(t)
  const routesDir = path.join(ROOT, 'lib', 'routes')
  const ctx = {}
  const groups = []
  let declared = 0
  for (const file of fs.readdirSync(routesDir).filter((name) => name.endsWith('.js'))) {
    declared += codeOnly(fs.readFileSync(path.join(routesDir, file), 'utf8')).match(/\bapp\.get\(/g)?.length ?? 0
    const mod = require(path.join(routesDir, file))
    for (const key of Object.keys(mod)) {
      const group = /^create(\w+)Routes$/.exec(key)
      if (group) {
        mod[key](ctx)
        groups.push(group[1])
      }
    }
  }
  const before = f.app.router.stack.length
  for (const group of groups) ctx[`install${group}Routes`](f.app)
  assert.strictEqual(f.app.router.stack.length - before, declared, 'routes installed')
  const fight = { threatDebugUntil: 0 }
  bindDebugRoutes({ bot: {}, fight, ok: (res, data) => res.json({ ok: true, ...data }), err: (res, e) => res.json({ ok: false, error: e.message }) })
  assert.strictEqual((await f.get('/threatdebug?secs=1')).status, 200, 'control: a signed /threatdebug')
  assert.ok(fight.threatDebugUntil > 0, 'control: the signed /threatdebug ran')
  const paths = new Set(f.app.router.stack.filter((layer) => layer.route).map((layer) => layer.route.path))
  for (const target of paths) assertUnauthorized(await f.get(target, { signed: false }), target)
})

// ASVS 2.2.1
test('app-I2 the /goto and bounds guards refuse with 400 before a route registered after createApp runs', async (t) => {
  const s = await startApp(t, { createApp: true })
  assert.strictEqual((await s.get('/goto?x=1&z=2&preview=1')).status, 200, 'control: preview=1')
  assert.strictEqual((await s.get('/goto?x=1&z=2&preview=2')).status, 400, 'preview=2')
  assert.strictEqual(s.routeHits('/goto').length, 1)
  const [min, max] = ROUTE_BOUNDS['/walls'].w
  assert.strictEqual((await s.get(`/walls?w=${min}`)).status, 200, `control: w=${min}`)
  assert.strictEqual((await s.get(`/walls?w=${max + 1}`)).status, 400, `w=${max + 1}`)
  assert.strictEqual(s.routeHits('/walls').length, 1)
})

test('app-I3 a signed /snapshot gets 403 although a /snapshot route is registered after createApp', async (t) => {
  const s = await startApp(t, { createApp: true })
  await stateControl(s)
  assert.strictEqual((await s.get('/snapshot')).status, 403)
  assert.strictEqual(s.routeHits('/snapshot').length, 0, '/snapshot ran')
})

test('app-I4 a route registered after createApp counts as running while its handler awaits', async (t) => {
  const f = await factoryServer(t)
  let release
  const held = new Promise((resolve) => { release = resolve })
  let enter
  const entered = new Promise((resolve) => { enter = resolve })
  f.app.get('/held', async (req, res) => {
    enter()
    await held
    res.json({ ok: true })
  })
  assert.strictEqual(f.verbs.running(Date.now()), 0, 'running before any request')
  const reply = f.get('/held')
  await entered
  assert.strictEqual(f.verbs.running(Date.now()), 1, 'running while the handler awaits')
  assert.strictEqual(f.onRequests.length, 1)
  release()
  assert.strictEqual((await reply).status, 200)
  assert.strictEqual(f.verbs.running(Date.now()), 0, 'running after the handler settled')
})

test('app-I4 a signed /goto calls onRequest once with its response', async (t) => {
  const s = await startApp(t, { createApp: true })
  assert.strictEqual((await s.get('/goto?x=1&z=2')).status, 200)
  assert.strictEqual(s.routeHits('/goto').length, 1)
  assert.strictEqual(s.onRequests.length, 1)
  assert.strictEqual(s.onRequests[0].req.url, '/goto?x=1&z=2')
})

test('app-I4 a signed /chat is no counted route: onRequest is not called and nothing runs', async (t) => {
  const s = await startApp(t, { createApp: true })
  assert.strictEqual((await s.get('/chat?msg=hi')).status, 200, 'control: /chat?msg=hi')
  await s.drained()
  assert.deepStrictEqual(s.texts(), ['hi'])
  assert.strictEqual(s.onRequests.length, 0)
  assert.strictEqual(s.verbs.running(Date.now()), 0)
})

// ASVS 13.3.1
test('app-I5 createApp returns only app and verbs and leaves the token in no app property, setting, export, log line or error', () => {
  const token = 'app-i5-' + crypto.randomBytes(24).toString('hex')
  const short = token.slice(0, 31)
  const chat = { send () {} }
  const levels = ['log', 'info', 'warn', 'error']
  const saved = levels.map((level) => console[level])
  const logged = []
  let ret
  let refused
  try {
    for (const level of levels) console[level] = (...args) => { logged.push(util.format(...args)) }
    ret = createApp({ token, port: PORT, chat })
    try {
      createApp({ token: short, port: PORT, chat })
    } catch (e) {
      refused = e
    }
  } finally {
    levels.forEach((level, i) => { console[level] = saved[i] })
  }
  assert.deepStrictEqual(Object.keys(ret), ['app', 'verbs'])
  assert.deepStrictEqual(Object.keys(ret.verbs), ['running'])
  const places = { verbs: ret.verbs, app: ret.app, 'app.request': ret.app.request, 'app.response': ret.app.response, 'app.locals': ret.app.locals, 'app.settings': ret.app.settings, 'lib/app.js exports': require('../lib/app') }
  for (const [label, v] of Object.entries(places)) assert.deepStrictEqual(stringsWith(v, token), [], label)
  assert.deepStrictEqual(logged.filter((line) => line.includes(short)), [], 'a log line holds the token')
  assert.ok(refused instanceof TypeError, 'control: a 31-character token is refused')
  assert.ok(!refused.message.includes(short), 'the error message holds the token')
  assert.ok(!String(refused.stack).includes(short), 'the error stack holds the token')
})

test('app-I6 createApp throws a TypeError for a token under 32 characters or a port outside 1-65535', () => {
  const chat = { send () {} }
  assert.doesNotThrow(() => createApp({ token: 'k'.repeat(32), port: PORT, chat }), 'control: 32 characters')
  for (const token of ['k'.repeat(31), '', undefined]) {
    assert.throws(() => createApp({ token, port: PORT, chat }), TypeError, `token ${JSON.stringify(token)}`)
  }
  for (const port of [0, undefined, NaN, 65536]) {
    assert.throws(() => createApp({ token: 'k'.repeat(32), port, chat }), TypeError, `port ${port}`)
  }
})

test('app-I8 /chat sends a message up to the maxLen given in chat as one line', async (t) => {
  const s = await startApp(t, { createApp: true, maxLen: 256 })
  const short = 'a'.repeat(50)
  const long = 'b'.repeat(200)
  assert.strictEqual((await s.get(`/chat?msg=${short}`)).status, 200, 'control: 50 characters')
  await s.drained()
  assert.deepStrictEqual(s.texts(), [short], 'control: 50 characters')
  assert.strictEqual((await s.get(`/chat?msg=${long}`)).status, 200, '200 characters')
  await s.drained()
  assert.deepStrictEqual(s.texts(), [short, long])
})
