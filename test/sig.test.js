'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { signRequest, proof, verifyProof, createNonceCache, NonceCacheFull } = require('../lib/sig')
const { hmac, sha256 } = require('./helpers')

const VECTOR = {
  token: '7d4e2b9c0a1f3e5d6c8b7a9f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d',
  method: 'GET',
  pathQuery: '/chat?msg=T%C5%8Dky%C5%8D+%2Fme',
  time: '1760270400000',
  nonce: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  sig: 'c3dd619f4f22cc742c09362500379ed42fa17879e8bab10a5d67e4e816500af0',
  body: Buffer.from('{"ok":true,"msg":"Tōkyō"}', 'utf8'),
  proof: 'cc5e21a34f86efbffd28946ea0b74c24fb01573287fb00cf2ae0b495b852faa5'
}
const HEX64 = /^[0-9a-f]{64}$/
const TTL = 60000

test('signRequest matches a fixed vector as lowercase hex', () => {
  const { token, method, pathQuery, time, nonce } = VECTOR
  assert.strictEqual(hmac(token, `${method}\n${pathQuery}\n${time}\n${nonce}`), VECTOR.sig, 'vector')
  const sig = signRequest(token, method, pathQuery, time, nonce)
  assert.strictEqual(sig, VECTOR.sig)
  assert.match(sig, HEX64)
})

test('proof matches a fixed vector as lowercase hex', () => {
  assert.strictEqual(hmac(VECTOR.token, `${VECTOR.nonce}\n${sha256(VECTOR.body)}`), VECTOR.proof, 'vector')
  const p = proof(VECTOR.token, VECTOR.nonce, VECTOR.body)
  assert.strictEqual(p, VECTOR.proof)
  assert.match(p, HEX64)
})

test('verifyProof refuses a missing or malformed header without throwing', () => {
  assert.strictEqual(verifyProof(VECTOR.token, VECTOR.nonce, VECTOR.body, VECTOR.proof), true)
  for (const header of [undefined, VECTOR.proof.slice(0, -1), [VECTOR.proof], 'z'.repeat(64)]) {
    assert.strictEqual(verifyProof(VECTOR.token, VECTOR.nonce, VECTOR.body, header), false, JSON.stringify(header))
  }
})

test('verifyProof refuses a proof for another body, nonce or token', () => {
  const { token, nonce, body } = VECTOR
  assert.strictEqual(verifyProof(token, nonce, body, VECTOR.proof), true)
  const otherBody = Buffer.from('{"ok":true,"msg":"Tokyo"}', 'utf8')
  const otherNonce = '0f1e2d3c4b5a69788796a5b4c3d2e1f1'
  const otherToken = token.slice(0, -1) + '0'
  assert.strictEqual(verifyProof(token, nonce, otherBody, VECTOR.proof), false)
  assert.strictEqual(verifyProof(token, otherNonce, body, VECTOR.proof), false)
  assert.strictEqual(verifyProof(otherToken, nonce, body, VECTOR.proof), false)
})

// ---- the nonce cache ----

function assertCacheFull (fn) {
  let thrown = false
  let err
  try { fn() } catch (e) { thrown = true; err = e }
  assert.ok(thrown, 'seen must throw NonceCacheFull when the cache is full')
  const matches = err === NonceCacheFull || (typeof NonceCacheFull === 'function' && err instanceof NonceCacheFull)
  assert.ok(matches, `thrown ${err && err.name}: ${err && err.message} is not NonceCacheFull`)
}

test('a cache of max 3 takes three fresh nonces and throws NonceCacheFull on the fourth', () => {
  const cache = createNonceCache({ ttlMs: TTL, max: 3 })
  assert.strictEqual(cache.full(0), false, 'an empty cache is not full')
  assert.strictEqual(cache.seen('1'.repeat(32), 0), false)
  assert.strictEqual(cache.seen('2'.repeat(32), 0), false)
  assert.strictEqual(cache.full(0), false, 'two live entries out of three is not full')
  assert.strictEqual(cache.seen('3'.repeat(32), 0), false)
  assert.strictEqual(cache.full(0), true, 'three live entries out of three is full')
  assertCacheFull(() => cache.seen('4'.repeat(32), 1000))
  assert.strictEqual(cache.full(1000), true)
})

test('after the ttl the entries expire, the cache is no longer full and a fresh nonce is accepted', () => {
  const cache = createNonceCache({ ttlMs: TTL, max: 3 })
  for (const n of ['1', '2', '3']) assert.strictEqual(cache.seen(n.repeat(32), 0), false)
  assertCacheFull(() => cache.seen('4'.repeat(32), 1000))
  assert.strictEqual(cache.full(TTL + 1000), false, 'all three entries are older than the ttl')
  // The nonce refused at 1000 was never recorded.
  assert.strictEqual(cache.seen('4'.repeat(32), TTL + 1000), false)
  assert.strictEqual(cache.seen('5'.repeat(32), TTL + 1000), false)
  assert.strictEqual(cache.seen('4'.repeat(32), TTL + 2000), true, 'the accepted nonce is now recorded')
})

test('only expired entries free room, live ones stay and still count', () => {
  const cache = createNonceCache({ ttlMs: TTL, max: 3 })
  assert.strictEqual(cache.seen('1'.repeat(32), 0), false)
  assert.strictEqual(cache.seen('2'.repeat(32), 30000), false)
  assert.strictEqual(cache.seen('3'.repeat(32), 30000), false)
  assert.strictEqual(cache.full(30000), true)
  // At 61000 only the nonce from 0 has expired.
  assert.strictEqual(cache.full(61000), false)
  assert.strictEqual(cache.seen('4'.repeat(32), 61000), false)
  assert.strictEqual(cache.full(61000), true)
  assertCacheFull(() => cache.seen('5'.repeat(32), 62000))
  assert.strictEqual(cache.seen('2'.repeat(32), 62000), true, 'a live nonce was evicted to make room')
})
