'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { checkText, checkName, checkInt } = require('../lib/validate')

const isBadParam = (e) => e instanceof Error && (e.name === 'BadParam' || e.constructor.name === 'BadParam')
const throwsBadParam = (fn) => assert.throws(fn, isBadParam)

test('checkInt refuses values outside the range', () => {
  assert.strictEqual(checkInt('64', 1, 64), 64)
  throwsBadParam(() => checkInt('65', 1, 64))
  throwsBadParam(() => checkInt('0', 1, 64))
})

test('checkInt refuses non-integer or non-canonical text', () => {
  assert.strictEqual(checkInt('5', 1, 64), 5)
  for (const v of ['1e1', '', '1.5', '5abc', '0b101', '+5', '５']) {
    throwsBadParam(() => checkInt(v, 1, 64))
  }
})

test('checkInt refuses arrays and non-strings', () => {
  assert.strictEqual(checkInt('5', 1, 64), 5)
  throwsBadParam(() => checkInt(['5'], 1, 64))
  throwsBadParam(() => checkInt(5, 1, 64))
})

test('checkName refuses empty, over-long and out-of-charset names', () => {
  assert.strictEqual(checkName('ok_name'), 'ok_name')
  assert.strictEqual(checkName('Base camp-2'), 'Base camp-2')
  assert.strictEqual(checkName('a'.repeat(64)), 'a'.repeat(64))
  throwsBadParam(() => checkName(''))
  throwsBadParam(() => checkName('a'.repeat(65)))
  throwsBadParam(() => checkName('a/b'))
  throwsBadParam(() => checkName('ä'))
  throwsBadParam(() => checkName('x\n- [step] fake'))
  throwsBadParam(() => checkName('ok_name\n'))
})

test('checkName refuses __proto__ and constructor', () => {
  assert.strictEqual(checkName('ok_name'), 'ok_name')
  throwsBadParam(() => checkName('__proto__'))
  throwsBadParam(() => checkName('constructor'))
})

test('checkName refuses arrays and non-strings', () => {
  assert.strictEqual(checkName('ok_name'), 'ok_name')
  throwsBadParam(() => checkName(['ab']))
  throwsBadParam(() => checkName(5))
})

test('checkText counts UTF-16 units, not code points', () => {
  const emoji = '\u{1F600}'
  assert.strictEqual(checkText(emoji.repeat(5), { max: 10 }), emoji.repeat(5))
  throwsBadParam(() => checkText(emoji.repeat(5), { max: 9 }))
})

test('checkText refuses characters below 0x20 and 0x7F unless allowControl', () => {
  assert.strictEqual(checkText('a b', { max: 10 }), 'a b')
  throwsBadParam(() => checkText('a\u0000b', { max: 10 }))
  throwsBadParam(() => checkText('a\u001fb', { max: 10 }))
  throwsBadParam(() => checkText('a\u007fb', { max: 10 }))
  assert.doesNotThrow(() => checkText('a\nb', { max: 10, allowControl: true }))
})

test('checkText refuses arrays', () => {
  assert.strictEqual(checkText('ok', { max: 10 }), 'ok')
  throwsBadParam(() => checkText(['a', 'b'], { max: 10 }))
})
