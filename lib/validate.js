'use strict'

class BadParam extends Error {
  constructor (message) {
    super(message)
    this.name = 'BadParam'
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/
const NAME = /^[A-Za-z0-9 _-]{1,64}$/
const INT = /^-?[0-9]{1,15}$/
// __proto__, constructor, toString and the other keys every plain object inherits.
const INHERITED = new Set(Object.getOwnPropertyNames(Object.prototype))

function checkText (s, { max, allowControl = false } = {}) {
  if (typeof s !== 'string') throw new BadParam('expected a single text value')
  if (s.length > max) throw new BadParam(`longer than ${max} characters`)
  if (!allowControl && CONTROL.test(s)) throw new BadParam('control characters are not allowed')
  return s
}

function checkName (s) {
  if (typeof s !== 'string' || !NAME.test(s) || INHERITED.has(s)) {
    throw new BadParam('names are 1-64 characters of A-Z a-z 0-9 space _ -')
  }
  return s
}

function checkInt (v, min, max) {
  if (typeof v !== 'string' || !INT.test(v)) throw new BadParam('expected a single whole number')
  const n = Number(v)
  if (n < min || n > max) throw new BadParam(`must be between ${min} and ${max}`)
  return n
}

module.exports = { BadParam, checkText, checkName, checkInt }
