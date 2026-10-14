'use strict'

const crypto = require('node:crypto')
const { signRequest, proof, createNonceCache, NonceCacheFull } = require('./sig')

const UNAUTHORIZED = { ok: false, error: 'unauthorized' }
const BUSY = { ok: false, error: 'too many requests, try again later' }
const WINDOW_MS = 30000
const NONCE_TTL_MS = 60000
const NONCE_MAX = 100000
const PROVEN_BODY_CAP = 16 * 1024 * 1024
// Unix ms in canonical decimal: no sign, leading zero, fraction, exponent or whitespace.
const TIME = /^[1-9][0-9]{0,15}$/
const NONCE = /^[0-9a-f]{32}$/
const SIG = /^[0-9a-f]{64}$/

// The value of a header sent exactly once, else undefined.
function single (req, name) {
  const values = req.headersDistinct && req.headersDistinct[name]
  return Array.isArray(values) && values.length === 1 && typeof values[0] === 'string' ? values[0] : undefined
}

const matches = (re, v) => typeof v === 'string' && re.test(v)

// Records the nonce of a correctly signed request. False when the cache has no room for it.
function isAllowedRequest (req, port, token, { now, cache }) {
  if (typeof token !== 'string' || token === '') return false
  const host = single(req, 'host')
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  const time = single(req, 'x-golem-time')
  const nonce = single(req, 'x-golem-nonce')
  const sig = single(req, 'x-golem-sig')
  if (!matches(TIME, time) || !matches(NONCE, nonce) || !matches(SIG, sig)) return false
  if (!(Math.abs(Number(time) - now) <= WINDOW_MS)) return false
  const expected = Buffer.from(signRequest(token, req.method, req.url, time, nonce), 'hex')
  if (!crypto.timingSafeEqual(expected, Buffer.from(sig, 'hex'))) return false
  try {
    return !cache.seen(nonce, now)
  } catch (e) {
    if (e instanceof NonceCacheFull) return false
    throw e
  }
}

// Holds the body back until the response ends, then sends it whole with an X-Golem-Proof over its bytes.
function proveResponses (res, token, nonce) {
  const { writeHead, write, end } = res
  const chunks = []
  let size = 0
  let head = null
  let dropped = false

  function hold (chunk, encoding) {
    if (chunk === undefined || chunk === null || dropped) return
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk)
    size += buf.length
    if (size > PROVEN_BODY_CAP) {
      dropped = true
      chunks.length = 0
      res.destroy()
      return
    }
    chunks.push(buf)
  }

  res.writeHead = function (...args) {
    head = args
    return this
  }
  res.write = function (chunk, encoding, callback) {
    hold(chunk, encoding)
    const done = typeof encoding === 'function' ? encoding : callback
    if (typeof done === 'function') process.nextTick(done)
    return !dropped
  }
  res.end = function (chunk, encoding, callback) {
    if (typeof chunk === 'function') [callback, chunk] = [chunk, undefined]
    else if (typeof encoding === 'function') [callback, encoding] = [encoding, undefined]
    hold(chunk, encoding)
    Object.assign(res, { writeHead, write, end })
    if (dropped) return res
    const body = Buffer.concat(chunks)
    res.setHeader('X-Golem-Proof', proof(token, nonce, body))
    if (head) writeHead.apply(res, head)
    return end.call(res, body, callback)
  }
}

// A request signed before bootMs may already have run in an earlier process, whose nonces are gone.
function apiGuard (port, token, { nonceMax = NONCE_MAX, bootMs = Date.now() } = {}) {
  const cache = createNonceCache({ ttlMs: NONCE_TTL_MS, max: nonceMax })
  return (req, res, next) => {
    const now = Date.now()
    if (Number(single(req, 'x-golem-time')) < bootMs) return res.status(401).json(UNAUTHORIZED)
    if (!isAllowedRequest(req, port, token, { now, cache })) {
      return cache.full(now) ? res.status(429).json(BUSY) : res.status(401).json(UNAUTHORIZED)
    }
    proveResponses(res, token, single(req, 'x-golem-nonce'))
    next()
  }
}

module.exports = { isAllowedRequest, apiGuard }
