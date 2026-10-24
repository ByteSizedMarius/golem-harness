'use strict'
// blockat reads a sign's text as plain lines, whatever shape the text components arrive in.
const test = require('node:test')
const assert = require('node:assert')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const { runRoute } = require('./helpers')

const str = (value) => ({ type: 'string', value })
const list = (type, value) => ({ type: 'list', value: { type, value } })
const side = (messages) => ({ type: 'compound', value: { messages } })

function blockatSign (front, back = list('string', ['', '', '', ''])) {
  const sign = Block.fromStateId(registry.blocksByName.oak_sign.defaultState, 0)
  sign.entity = { type: 'compound', value: { front_text: side(front), back_text: side(back) } }
  const env = { require, bot: { blockAt: () => sign }, bodyTouches: () => true }
  return runRoute('/blockat', { x: '1', y: '64', z: '0' }, env).text
}

test('blockat gives plain string sign lines as they are', () => {
  assert.deepStrictEqual(blockatSign(list('string', ['a', 'b', '', '']), list('string', ['c', '', '', ''])), { front: 'a\nb\n\n', back: 'c\n\n\n' })
})

test('blockat flattens compound sign lines into plain text', () => {
  // The line shape a 1.7.10 server behind ViaProxy sends.
  const live = { text: str(''), extra: list('string', ['probe']) }
  const nested = { text: str('a'), extra: list('compound', [{ text: str('b'), extra: list('compound', [{ text: str('c') }]) }, { text: str('d') }]) }
  // A list of mixed tags wraps each element in a compound under the empty key.
  const mixed = { text: str('e'), extra: list('compound', [{ '': str('f') }, { '': { type: 'compound', value: { text: str('g') } } }]) }
  const textless = { extra: list('string', ['h']) }
  const empty = { text: str('') }
  assert.deepStrictEqual(blockatSign(list('compound', [live, nested, empty, empty])).front, 'probe\nabcd\n\n')
  assert.deepStrictEqual(blockatSign(list('compound', [mixed, textless, { '': str('i') }, {}])).front, 'efg\nh\ni\n')
})

test('blockat reads a number in a sign line as its digits', () => {
  const counted = { text: str('n'), extra: list('int', [7]) }
  assert.deepStrictEqual(blockatSign(list('compound', [counted, {}, {}, {}])).front, 'n7\n\n\n')
})
