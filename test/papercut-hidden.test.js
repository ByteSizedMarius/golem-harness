'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createServer } = require('../mcp/server')
const { PORT, MCP_TOKEN, fakeBot, call, textOf, errorText } = require('./helpers')

const RUN = '20261015-120000'
const NOW = new Date('2026-10-15T12:34:56.789Z')
const entry = (text) => `2026-10-15T12:34:56Z | pilot | ${RUN}\n${text}\n\n`
const TEXT_MAX = 600

function runDir (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-papercut-hidden-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, RUN)
  fs.mkdirSync(dir)
  return { dir, file: path.join(dir, 'papercuts.log') }
}

const server = (papercutsFile) => createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch, papercutsFile, now: () => NOW })
const read = (file) => fs.readFileSync(file, 'utf8')

function assertToolError (r, message) {
  assert.ok(r && r.result && r.result.isError === true, `expected a tool error, got ${JSON.stringify(r).slice(0, 300)}`)
  assert.strictEqual(errorText(r), message)
}

// Every Default_Ignorable_Code_Point character, then U+2800.
function invisibles () {
  const chars = []
  for (let c = 0; c <= 0x10ffff; c++) {
    const s = String.fromCodePoint(c)
    if (/\p{Default_Ignorable_Code_Point}/u.test(s)) chars.push(s)
  }
  chars.push('⠀')
  return chars
}

// CWE-117
test('papercut drops variation selectors after the text', async (t) => {
  const { file } = runDir(t)
  const srv = server(file)
  assert.strictEqual(textOf(await call(srv, 'papercut', { text: 'ok' })), 'noted', 'control')
  assert.strictEqual(textOf(await call(srv, 'papercut', { text: 'ok️︎\u{e0100}\u{e01ef}' })), 'noted')
  assert.strictEqual(read(file), entry('ok') + entry('ok'))
})

// CWE-117
test('papercut text made only of default-ignorable characters and U+2800 is empty and writes nothing', async (t) => {
  const { file } = runDir(t)
  const srv = server(file)
  assert.strictEqual(textOf(await call(srv, 'papercut', { text: 'plain words' })), 'noted', 'control')
  const before = read(file)
  const texts = ['️', 'ㅤ', 'ᅟᅠﾠ', '᠋᠌᠍᠎᠏', '\u{e0100}\u{e01ef}',
    '⠀', ' ㅤ ⠀ ️ ', '͏឴឵⁥￰']
  for (const text of texts) {
    assertToolError(await call(srv, 'papercut', { text }), 'papercut text is empty')
  }
  assert.strictEqual(read(file), before)
})

// CWE-117
test('papercut drops every default-ignorable character and U+2800 between two letters', async (t) => {
  const { file } = runDir(t)
  assert.strictEqual(textOf(await call(server(file), 'papercut', { text: 'xy' })), 'noted', 'control')
  const chars = invisibles()
  const chunks = ['']
  for (const c of chars) {
    if (chunks[chunks.length - 1].length + c.length > TEXT_MAX - 2) chunks.push('')
    chunks[chunks.length - 1] += c
  }
  for (const chunk of chunks) {
    const first = chunk.codePointAt(0).toString(16)
    assert.strictEqual(textOf(await call(server(file), 'papercut', { text: `x${chunk}y` })), 'noted', `chunk from U+${first}`)
  }
  const hidden = new Set(chars)
  const kept = [...new Set([...read(file)].filter((c) => hidden.has(c)))].map((c) => `U+${c.codePointAt(0).toString(16)}`)
  assert.strictEqual(kept.length, 0, `${kept.length} kept, ${kept.slice(0, 8).join(' ')}`)
  assert.strictEqual(read(file), entry('xy').repeat(chunks.length + 1))
})

// CWE-770
test('failed writes count toward the 20-entry limit', async (t) => {
  const { dir, file } = runDir(t)
  assert.strictEqual(textOf(await call(server(file), 'papercut', { text: 'control' })), 'noted', 'control')
  fs.rmSync(file)
  t.mock.method(console, 'error', () => {})
  const srv = server(dir)
  for (let i = 1; i <= 20; i++) {
    assertToolError(await call(srv, 'papercut', { text: `entry ${i}` }), 'the papercut could not be written')
  }
  assertToolError(await call(srv, 'papercut', { text: 'entry 21' }), 'papercut limit reached')
  assert.deepStrictEqual(fs.readdirSync(dir), [])
})

// CWE-770
test('refused text never reaches the write and does not count toward the limit', async (t) => {
  const { file } = runDir(t)
  const srv = server(file)
  for (let i = 0; i < 25; i++) {
    assertToolError(await call(srv, 'papercut', { text: ' ​ ' }), 'papercut text is empty')
  }
  for (let i = 1; i <= 20; i++) {
    assert.strictEqual(textOf(await call(srv, 'papercut', { text: `entry ${i}` })), 'noted', `entry ${i}`)
  }
  assertToolError(await call(srv, 'papercut', { text: 'entry 21' }), 'papercut limit reached')
})
