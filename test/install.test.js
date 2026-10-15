'use strict'
// Requests that must reach the server exactly as written go over a raw socket.
const test = require('node:test')
const assert = require('node:assert')
const express = require('express')
const { installSecurity } = require('../lib/install')
const { ROUTE_BOUNDS } = require('../lib/bounds')
const {
  ALLOW, PORT, UNAUTHORIZED, stripLead, assertSafeChunks, startApp, stateControl, referenceApp, proofOver, otherKey
} = require('./helpers')

const enc = encodeURIComponent

function assertUnauthorized (s, r, route = '/state', hits = 1) {
  assert.strictEqual(r.status, 401)
  assert.deepStrictEqual(r.json, UNAUTHORIZED)
  assert.strictEqual(r.proof, undefined, 'a 401 carries a proof')
  assert.strictEqual(s.routeHits(route).length, hits, `${route} ran`)
}

function assertProof (s, r, label) {
  assert.deepStrictEqual(r.proofs, [proofOver(s.token, r.nonce, r.raw)], `${label}: HTTP ${r.status} needs exactly one proof over its body`)
}

function assertQueuedCount (r, n) {
  assert.ok(r.json && typeof r.json === 'object', 'JSON body')
  assert.ok(Object.values(r.json).includes(n), `body ${r.body} reports ${n} chunks queued`)
}

// ---- signed requests ----

test('a signed request with a 127.0.0.1 or localhost Host reaches the route', async (t) => {
  const s = await startApp(t)
  await stateControl(s)
  const r = await s.get('/state', { host: `localhost:${s.port}` })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(s.routeHits('/state').length, 2)
})

test('a request without signature headers gets 401 with the fixed body and the route does not run', async (t) => {
  const s = await startApp(t)
  await stateControl(s)
  assertUnauthorized(s, await s.get('/state', { signed: false }))
  for (const name of ['X-Golem-Sig', 'X-Golem-Time', 'X-Golem-Nonce']) {
    assertUnauthorized(s, await s.get('/state', { headers: { [name]: undefined } }))
  }
})

test('the guard answers before routing: an unsigned unknown route, /chat, disabled route or bounded route gets 401', async (t) => {
  const s = await startApp(t)
  await stateControl(s)
  assert.strictEqual((await s.get('/no_such_route')).status, 404, 'control: a signed unknown route')
  for (const target of ['/no_such_route', '/chat?msg=hi', '/snapshot', '/walls?w=65']) {
    const r = await s.get(target, { signed: false })
    assert.strictEqual(r.status, 401, target)
    assert.deepStrictEqual(r.json, UNAUTHORIZED, target)
  }
  await s.drained()
  assert.strictEqual(s.sends.length, 0)
})

test('a signature over the decoded, reordered or case-changed target gets 401 for the target as sent', async (t) => {
  const s = await startApp(t)
  assert.strictEqual((await s.wire('/chat?msg=hello%20there')).status, 200, 'control: signed as sent')
  assert.strictEqual((await s.wire('/walls?w=5&d=3')).status, 200, 'control: signed as sent')
  const pairs = [
    ['/%73tate', '/state'], ['/chat?msg=a%20b', '/chat?msg=a+b'], ['/walls?d=3&w=5', '/walls?w=5&d=3'],
    ['/walls?w=5&w=65', '/walls?w=5'], ['/state?', '/state'], ['/STATE', '/state'], ['/state/', '/state']
  ]
  for (const [target, signPath] of pairs) {
    const r = await s.wire(target, { signPath })
    assert.strictEqual(r.status, 401, `${target} signed as ${signPath}`)
    assert.deepStrictEqual(r.json, UNAUTHORIZED)
  }
  await s.drained()
  assert.strictEqual(s.routeHits('/walls').length, 1)
  assert.strictEqual(s.routeHits('/state').length, 0)
  assert.deepStrictEqual(s.texts(), ['hello there'])
})

test('two Host lines on the wire get 401, identical or in either order (RFC 9112 3.2)', async (t) => {
  const s = await startApp(t)
  await stateControl(s)
  const own = `Host: 127.0.0.1:${s.port}`
  for (const headers of [[own, 'Host: evil.example'], ['Host: evil.example', own], [own, own]]) {
    const r = await s.wire('/state', { host: null, headers })
    assert.strictEqual(r.status, 401, headers.join(', '))
  }
  assert.strictEqual(s.routeHits('/state').length, 1)
})

test('installSecurity refuses a token under 32 characters', () => {
  const opts = (token) => ({ token, port: PORT, chat: { send () {}, maxLen: 100, gapMs: 30, allow: ALLOW, maxDepth: 20 } })
  assert.doesNotThrow(() => installSecurity(express(), opts('x'.repeat(32))), 'control: 32 characters')
  assert.throws(() => installSecurity(express(), opts('x'.repeat(31))), TypeError, '31 characters')
})

test('a request signed before bootMs gets 401 inside the time window', async (t) => {
  const bootMs = Date.now() - 10000
  const s = await startApp(t, { bootMs })
  for (const time of [bootMs + 1000, bootMs]) {
    const r = await s.get('/state', { time: String(time) })
    assert.strictEqual(r.status, 200, `control: signed ${time - bootMs} ms after bootMs`)
    assertProof(s, r, 'control')
  }
  assertUnauthorized(s, await s.get('/state', { time: String(bootMs - 1000) }), '/state', 2)

  const d = await startApp(t)
  assert.strictEqual((await d.get('/state')).status, 200, 'control: the default bootMs, signed now')
  assertUnauthorized(d, await d.get('/state', { time: String(d.installedAt - 1000) }), '/state', 1)
})

// ---- signed responses ----

test('every response to a request that passed the guard carries one proof over its body', async (t) => {
  const s = await startApp(t)
  for (const [target, status] of [['/state', 200], ['/no_such_route', 404]]) {
    const r = await s.get(target)
    assert.strictEqual(r.status, status, target)
    assertProof(s, r, target)
  }
  const full = await startApp(t, { gapMs: 200, maxDepth: 5 })
  assert.strictEqual((await full.get('/chat?lines=' + enc('a|b|c|d|e'))).status, 200)
  const r = await full.get('/chat?lines=' + enc('f|g'))
  assert.strictEqual(r.status, 429, 'a full chat queue')
  assertProof(full, r, 'a full chat queue')
})

test('a full nonce cache answers 429 without a proof and runs no route', async (t) => {
  const s = await startApp(t, { nonceMax: 2 })
  for (let i = 0; i < 2; i++) {
    const r = await s.get('/state')
    assert.strictEqual(r.status, 200)
    assertProof(s, r, `control ${i}`)
  }
  const r = await s.get('/state')
  assert.strictEqual(r.status, 429)
  assert.strictEqual(r.proof, undefined, 'a 429 carries a proof')
  const bad = await s.get('/state', { key: otherKey(s.token) })
  assert.notStrictEqual(bad.status, 200, 'a badly signed request while full')
  assert.strictEqual(bad.proof, undefined, 'a badly signed request while full carries a proof')
  assert.strictEqual(s.routeHits('/state').length, 2, 'the route ran for a refused request')
})

// ---- disabled routes ----

test('/snapshot, /record, /stream and /pov get 403 and their handlers do not run', async (t) => {
  const s = await startApp(t)
  await stateControl(s)
  for (const route of ['/snapshot', '/record', '/stream', '/pov']) {
    assert.strictEqual((await s.get(route)).status, 403, route)
    assert.strictEqual(s.routeHits(route).length, 0, `${route} ran`)
  }
})

test('case and trailing-slash variants of /snapshot get 403, HEAD included, and the handler does not run', async (t) => {
  const ref = referenceApp(t)
  const s = await startApp(t)
  await stateControl(s)
  for (const target of ['/Snapshot', '/snapshot/']) {
    assert.ok(await ref.reaches(target, '/snapshot'), `control: plain Express routes ${target} to /snapshot`)
    assert.strictEqual((await s.wire(target)).status, 403, target)
  }
  assert.strictEqual((await s.wire('/snapshot', { method: 'HEAD' })).status, 403, 'HEAD /snapshot')
  assert.strictEqual(s.routeHits('/snapshot').length, 0)
})

// ---- integer bounds ----

test('a bounded route parameter: min and max pass, min-1, max+1, a repeated or a fractional value get 400', async (t) => {
  const s = await startApp(t)
  for (const [route, p] of [['/walls', 'h'], ['/bunker', 'height']]) {
    const [min, max] = ROUTE_BOUNDS[route][p]
    for (const v of [min, max]) assert.strictEqual((await s.get(`${route}?${p}=${v}`)).status, 200, `${route} ${p}=${v}`)
    for (const q of [`${p}=${min - 1}`, `${p}=${max + 1}`, `${p}=${min}&${p}=${max}`]) {
      assert.strictEqual((await s.get(`${route}?${q}`)).status, 400, `${route} ${q}`)
    }
    assert.strictEqual(s.routeHits(route).length, 2, `${route} ran for a refused ${p}`)
  }
  assert.strictEqual((await s.get('/walls?w=7.5')).status, 400, 'w=7.5')
  assert.strictEqual(s.routeHits('/walls').length, 2, '/walls ran for w=7.5')
})

test('bounds apply to case and trailing-slash variants of bounded routes', async (t) => {
  const s = await startApp(t)
  assert.strictEqual((await s.wire('/WALLS?w=64')).status, 200, 'control: /WALLS?w=64')
  assert.strictEqual(s.routeHits('/walls').length, 1)
  for (const target of ['/WALLS?w=65', '/walls/?w=65']) {
    assert.strictEqual((await s.wire(target)).status, 400, target)
  }
  assert.strictEqual(s.routeHits('/walls').length, 1)
})

test('a /bunker mode outside its enum gets 400 and the handler does not run', async (t) => {
  const s = await startApp(t)
  const valid = ['/bunker?mode=auto', '/bunker?mode=up', '/bunker?mode=down', '/bunker']
  for (const target of valid) assert.strictEqual((await s.get(target)).status, 200, `control: ${target}`)
  for (const q of ['mode=sideways', 'mode=UP', 'mode=up&mode=down', 'mode=__proto__']) {
    assert.strictEqual((await s.get(`/bunker?${q}`)).status, 400, q)
  }
  assert.strictEqual(s.routeHits('/bunker').length, valid.length, 'the handler ran for a mode outside the enum')
})

// ---- waypoints ----

test('a waypoint name or linkto with a journal line or a prototype key gets 400', async (t) => {
  const s = await startApp(t)
  assert.strictEqual((await s.get('/waypoint?name=ok_name&linkto=ok_other')).status, 200, 'control')
  for (const q of ['name=' + enc('x\n- [step] fake'), 'name=__proto__', 'name=a&linkto=' + enc('b\n- [step] fake')]) {
    assert.strictEqual((await s.get('/waypoint?' + q)).status, 400, q)
  }
  assert.strictEqual(s.routeHits('/waypoint').length, 1)
})

test('a waypoint note of 200 units passes, 201 units or a control character gets 400', async (t) => {
  const s = await startApp(t)
  assert.strictEqual((await s.get('/waypoint?name=a&note=' + 'n'.repeat(200))).status, 200)
  assert.strictEqual((await s.get('/waypoint?name=a&note=' + 'n'.repeat(201))).status, 400)
  assert.strictEqual((await s.get('/waypoint?name=a&note=' + enc('a\nb'))).status, 400)
  assert.strictEqual(s.routeHits('/waypoint').length, 1)
})

test('/goto waypoint names outside the waypoint charset get 400', async (t) => {
  const s = await startApp(t)
  assert.strictEqual((await s.get('/goto?waypoint=ok_name')).status, 200)
  assert.strictEqual((await s.get('/goto?waypoint=' + enc('../x'))).status, 400)
  assert.strictEqual(s.routeHits('/goto').length, 1)
})

// ---- /sign text and /rename name ----

const BAD_TEXTS = ['a\nb', 'a\u007fb', '§chello']

test('/sign text with a control character, 0x7F or § gets 400 and the route does not run, | passes', async (t) => {
  const s = await startApp(t)
  assert.strictEqual((await s.get('/sign?x=1&y=64&z=1&text=' + enc('hello|world'))).status, 200)
  assert.strictEqual(s.routeHits('/sign')[0].query.text, 'hello|world', 'control: | is the line split and passes unchanged')
  for (const text of BAD_TEXTS) {
    assert.strictEqual((await s.get('/sign?x=1&y=64&z=1&text=' + enc(text))).status, 400, JSON.stringify(text))
  }
  assert.strictEqual(s.routeHits('/sign').length, 1)
})

test('/rename name with a control character, 0x7F or § gets 400 and the route does not run', async (t) => {
  const s = await startApp(t)
  assert.strictEqual((await s.get('/rename?item=iron_sword&name=' + enc('Occam the Sharp'))).status, 200)
  assert.strictEqual(s.routeHits('/rename')[0].query.name, 'Occam the Sharp', 'control: a plain name passes unchanged')
  assert.strictEqual((await s.get('/rename?item=iron_sword&name=' + enc('Occam|Blade'))).status, 200)
  assert.strictEqual(s.routeHits('/rename')[1].query.name, 'Occam|Blade', 'control: | stays literal in a name')
  for (const name of BAD_TEXTS) {
    assert.strictEqual((await s.get('/rename?item=iron_sword&name=' + enc(name))).status, 400, JSON.stringify(name))
  }
  assert.strictEqual(s.routeHits('/rename').length, 2)
})

test('/sign text over 90 characters and /rename names over 35 get 400', async (t) => {
  const s = await startApp(t)
  assert.strictEqual((await s.get('/sign?x=1&y=64&z=1&text=' + 'a'.repeat(90))).status, 200, 'control: 90 characters of sign text')
  assert.strictEqual((await s.get('/sign?x=1&y=64&z=1&text=' + 'a'.repeat(91))).status, 400, '91 characters of sign text')
  assert.strictEqual((await s.get('/rename?item=iron_sword&name=' + 'a'.repeat(35))).status, 200, 'control: a 35-character name')
  assert.strictEqual((await s.get('/rename?item=iron_sword&name=' + 'a'.repeat(36))).status, 400, 'a 36-character name')
  assert.strictEqual(s.routeHits('/sign').length, 1)
  assert.strictEqual(s.routeHits('/rename').length, 1)
})

// ---- /chat ----

test('/chat?msg=hello is sent once and reports one chunk queued', async (t) => {
  const s = await startApp(t)
  const r = await s.get('/chat?msg=hello')
  assert.strictEqual(r.status, 200)
  assertQueuedCount(r, 1)
  await s.drained()
  assert.deepStrictEqual(s.texts(), ['hello'])
})

test('one disallowed line refuses the whole lines request with 403 and nothing of it is sent', async (t) => {
  const s = await startApp(t)
  assert.strictEqual((await s.get('/chat?lines=' + enc('hi|there'))).status, 200)
  await s.drained()
  assert.deepStrictEqual(s.texts(), ['hi', 'there'], 'control')
  const r = await s.get('/chat?lines=' + enc('hi|/kill @e'))
  assert.strictEqual(r.status, 403)
  await s.drained()
  assert.strictEqual(s.sends.length, 2)
})

test('msg or lines given twice gets 400 and nothing is sent', async (t) => {
  const s = await startApp(t)
  await stateControl(s)
  assert.strictEqual((await s.get('/chat?msg=/me%20a&msg=/op%20x')).status, 400)
  assert.strictEqual((await s.get('/chat?lines=a&lines=b')).status, 400)
  await s.drained()
  assert.strictEqual(s.sends.length, 0)
})

test('a 400-unit msg is accepted, a 401-unit msg or line gets 400 and nothing of it is sent', async (t) => {
  const s = await startApp(t)
  const ok = await s.get('/chat?msg=' + 'a'.repeat(400))
  assert.strictEqual(ok.status, 200)
  await s.drained()
  assert.strictEqual(s.texts().join('').length, 400, 'control: the 400-unit msg arrives whole')
  const before = s.sends.length
  assertSafeChunks(s.texts(), 100)
  assert.strictEqual((await s.get('/chat?msg=' + 'b'.repeat(401))).status, 400)
  assert.strictEqual((await s.get('/chat?lines=' + enc('y|' + 'b'.repeat(401)))).status, 400)
  await s.drained()
  assert.strictEqual(s.sends.length, before)
  assert.ok(!s.texts().some((x) => x.includes('b') || stripLead(x).startsWith('y')))
})

test('five lines are sent in order and reported as queued, six get 400', async (t) => {
  const s = await startApp(t)
  const r = await s.get('/chat?lines=' + enc('l1|l2|l3|l4|l5'))
  assert.strictEqual(r.status, 200)
  assertQueuedCount(r, 5)
  await s.drained()
  assert.deepStrictEqual(s.texts(), ['l1', 'l2', 'l3', 'l4', 'l5'])
  assert.strictEqual((await s.get('/chat?lines=' + enc('m1|m2|m3|m4|m5|m6'))).status, 400)
  await s.drained()
  assert.strictEqual(s.sends.length, 5)
})
