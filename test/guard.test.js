'use strict'
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const { isAllowedRequest } = require('../lib/guard')
const { createNonceCache } = require('../lib/sig')
const { PORT, guardRequest, newNonce, otherKey } = require('./helpers')

const TOKEN = crypto.randomBytes(32).toString('hex')
const NOW = 1760270400000
const TTL = 60000

const freshCache = (max = 100000) => createNonceCache({ ttlMs: TTL, max })
const request = (opts = {}) => guardRequest({ token: TOKEN, port: PORT, url: '/state?x=1', time: String(NOW), ...opts })
const allowed = (req, { token = TOKEN, now = NOW, cache = freshCache() } = {}) => isAllowedRequest(req, PORT, token, { now, cache })

function control () {
  assert.strictEqual(allowed(request()), true, 'a correctly signed request must pass')
}

test('a wrong signature is refused', () => {
  control()
  const sig = request().headers['x-golem-sig']
  const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
  for (const bad of [flipped, sig.slice(0, -1), sig.toUpperCase()]) {
    assert.strictEqual(allowed(request({ headers: { 'x-golem-sig': bad } })), false, JSON.stringify(bad))
  }
  assert.strictEqual(allowed(request({ sign: { token: otherKey(TOKEN) } })), false, 'signed with another token')
})

test('a signature over another path, query or method is refused', () => {
  control()
  for (const sign of [{ url: '/tick?x=1' }, { url: '/state?x=2' }, { method: 'POST' }]) {
    assert.strictEqual(allowed(request({ sign })), false, JSON.stringify(sign))
  }
})

test('a time 29 s off the clock is allowed, 31 s behind or ahead is refused', () => {
  control()
  for (const skew of [-29000, 29000]) {
    assert.strictEqual(allowed(request({ time: String(NOW + skew) })), true, `skew ${skew}`)
  }
  assert.strictEqual(allowed(request({ time: String(NOW - 31000) })), false)
  assert.strictEqual(allowed(request({ time: String(NOW + 31000) })), false)
})

test('a replayed nonce is refused, also on another path or under a new time and signature', () => {
  const cache = freshCache()
  const req = request()
  assert.strictEqual(allowed(req, { cache }), true)
  assert.strictEqual(allowed(req, { cache, now: NOW + 1000 }), false)
  const nonce = req.headers['x-golem-nonce']
  assert.strictEqual(allowed(request({ nonce, time: String(NOW + 2000) }), { cache, now: NOW + 2000 }), false, 'same nonce under a new time and signature')
  assert.strictEqual(allowed(request({ nonce, url: '/chat?msg=hello' }), { cache, now: NOW + 1000 }), false, 'same nonce on another path')
})

test('a spent nonce stays spent for 60 s: a replay 58 s later inside the 30 s time window is refused', () => {
  const cache = freshCache()
  const req = request({ time: String(NOW + 29000) })
  assert.strictEqual(allowed(req, { cache, now: NOW }), true, 'accepted while its time is 29 s ahead')
  assert.strictEqual(allowed(req, { cache, now: NOW + 58000 }), false, 'replayed 58 s later, 29 s behind')
})

test('a malformed nonce is refused, even when correctly signed', () => {
  control()
  for (const nonce of ['a'.repeat(31), 'A'.repeat(32), 'g'.repeat(32)]) {
    assert.strictEqual(allowed(request({ nonce })), false, JSON.stringify(nonce))
  }
})

test('a malformed time is refused, even when correctly signed', () => {
  control()
  const n = String(NOW)
  for (const time of ['1.76e12', n + '.0', '+' + n, '0' + n, ' ' + n]) {
    assert.strictEqual(allowed(request({ time })), false, JSON.stringify(time))
  }
})

test('repeated signing headers are refused, as distinct values or joined', () => {
  control()
  for (const name of ['x-golem-time', 'x-golem-nonce', 'x-golem-sig']) {
    const req = request()
    const value = req.headers[name]
    const twice = request({ nonce: req.headers['x-golem-nonce'], headers: { [name]: [value, value] } })
    assert.strictEqual(allowed(twice), false, `${name} twice`)
  }
  const req = request()
  const sig = req.headers['x-golem-sig']
  const joined = request({ nonce: req.headers['x-golem-nonce'], headers: { 'x-golem-sig': `${sig}, ${sig}` } })
  assert.strictEqual(allowed(joined), false, 'one header line holding the signature twice')
})

test('the token itself never authorizes, in any header or query param', () => {
  control()
  const unsigned = { 'x-golem-sig': undefined, 'x-golem-time': undefined, 'x-golem-nonce': undefined }
  assert.strictEqual(allowed(request({ headers: { ...unsigned, 'x-golem-token': TOKEN } })), false, 'x-golem-token')
  // The token as the signature, with a valid time and nonce.
  assert.strictEqual(allowed(request({ headers: { 'x-golem-sig': TOKEN } })), false)
  assert.strictEqual(allowed(request({ url: `/state?token=${TOKEN}`, headers: unsigned })), false, '?token=')
})

test('a correct signature with a foreign Host is refused', () => {
  control()
  for (const host of [`evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`, undefined]) {
    assert.strictEqual(allowed(request({ headers: { host } })), false, String(host))
  }
})

test('an empty configured token never authorizes', () => {
  control()
  assert.strictEqual(allowed(request({ sign: { token: '' } }), { token: '' }), false)
})

test('a nonce is recorded only after its signature verified', () => {
  const cache = freshCache(2)
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(allowed(request({ sign: { token: otherKey(TOKEN) } }), { cache }), false, `bad request ${i}`)
  }
  assert.strictEqual(cache.full(NOW), false, 'badly signed requests filled the cache')
  const nonce = newNonce()
  assert.strictEqual(allowed(request({ nonce, sign: { token: otherKey(TOKEN) } }), { cache }), false)
  assert.strictEqual(allowed(request({ nonce }), { cache }), true, 'a nonce first sent with a bad signature was recorded')
  assert.strictEqual(allowed(request(), { cache }), true)
  assert.strictEqual(allowed(request({ nonce }), { cache }), false, 'control: the verified nonce is now a replay')
})
