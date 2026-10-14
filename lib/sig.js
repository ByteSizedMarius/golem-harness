'use strict'

const crypto = require('node:crypto')

const HEX64 = /^[0-9a-f]{64}$/

class NonceCacheFull extends Error {
  constructor () {
    super('nonce cache is full')
    this.name = 'NonceCacheFull'
  }
}

const hmacHex = (token, text) => crypto.createHmac('sha256', Buffer.from(token, 'utf8')).update(text, 'utf8').digest('hex')

function canonical (method, pathQuery, time, nonce) {
  return `${method}\n${pathQuery}\n${time}\n${nonce}`
}

function signRequest (token, method, pathQuery, time, nonce) {
  return hmacHex(token, canonical(method, pathQuery, time, nonce))
}

function proof (token, nonce, bodyBuffer) {
  return hmacHex(token, `${nonce}\n${crypto.createHash('sha256').update(bodyBuffer).digest('hex')}`)
}

function verifyProof (token, nonce, bodyBuffer, header) {
  if (typeof header !== 'string' || !HEX64.test(header)) return false
  return crypto.timingSafeEqual(Buffer.from(proof(token, nonce, bodyBuffer), 'hex'), Buffer.from(header, 'hex'))
}

function createNonceCache ({ ttlMs, max } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive integer')
  if (!Number.isInteger(max) || max < 1) throw new TypeError('max must be a positive integer')
  // Nonce -> the time it was recorded, oldest first.
  const recorded = new Map()

  function evictExpired (now) {
    for (const [nonce, at] of recorded) {
      if (now - at <= ttlMs) break
      recorded.delete(nonce)
    }
  }

  return {
    // True for a nonce recorded in the last ttlMs, else records it.
    seen (nonce, now) {
      evictExpired(now)
      const at = recorded.get(nonce)
      if (at !== undefined) {
        if (now - at <= ttlMs) return true
        recorded.delete(nonce)
      }
      if (recorded.size >= max) throw new NonceCacheFull()
      recorded.set(nonce, now)
      return false
    },
    full (now) {
      evictExpired(now)
      return recorded.size >= max
    }
  }
}

module.exports = { canonical, signRequest, proof, verifyProof, createNonceCache, NonceCacheFull }
