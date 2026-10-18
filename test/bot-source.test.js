'use strict'
// Requiring bot.js connects to a server.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT, botSource, codeOnly, balanced } = require('./helpers')

const src = botSource()
const code = codeOnly(src)

test('bot.js registers no /batch route', () => {
  assert.match(src, /app\.get\(\s*['"`]\/state['"`]/, 'control: the route pattern matches an existing route')
  assert.doesNotMatch(src, /app\.(get|use|all|post|put|patch|delete)\(\s*['"`]\/batch\b/)
})

test('bot.js binds the control API to 127.0.0.1 with no env override', () => {
  const listens = [...code.matchAll(/\bapp\.listen\(/g)].map((m) => m.index + m[0].length)
  assert.ok(listens.length >= 1, 'app.listen( not found')
  for (const from of listens) {
    const to = from - 2 + balanced(code, from - 1, '(').length
    // The host argument is the literal alone, ended by the next argument or the closing parenthesis.
    const host = /^\s*[^,]+,\s*(['"])127\.0\.0\.1\1(?=\s*(,|$))/.exec(src.slice(from, to))
    // codeOnly keeps a string literal's quotes and blanks its text.
    const literal = host && /(['"]) {9}\1$/.test(code.slice(from, from + host[0].length))
    assert.ok(literal, `app.listen(${src.slice(from, to)}`)
  }
  assert.doesNotMatch(src, /BIND_HOST/)
})

test('bot.js reads its settings from the process environment with no .env loader', () => {
  assert.match(src, /\bprocess\.env\.GOLEM_TOKEN\b/, 'control: bot.js reads the process environment')
  assert.doesNotMatch(src, /['"`/]\.env\b/)
  assert.doesNotMatch(src, /loadEnvFile/)
  assert.doesNotMatch(src, /dotenv/)
})

// ASVS 13.3.1
test('bot.js deletes GOLEM_TOKEN from process.env before it requires any module', () => {
  const bot = codeOnly(fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8'))
  const read = /^const\s+GOLEM_TOKEN\s*=\s*process\.env\.GOLEM_TOKEN\s*\|\|\s*(['"])\1[ \t;]*\r?\n/m
  // The gate's body lines are indented or blank.
  const gate = /if\s*\(\s*GOLEM_TOKEN\.length\s*<[^)]*\)\s*\{\r?\n(?:[ \t].*\r?\n|\r?\n)*?\}[ \t;]*\r?\n/
  const del = /delete\s+process\.env\.GOLEM_TOKEN[ \t;]*\r?$/
  // codeOnly blanks comment lines to whitespace.
  const gap = /(?:[ \t]*\r?\n)*[ \t]*/.source
  assert.match(bot, read, 'control: the token read is found')
  assert.match(bot, new RegExp('^' + gate.source, 'm'), 'control: the gate is found')
  const trio = new RegExp(read.source + gap + gate.source + gap + del.source, 'm').exec(bot)
  assert.ok(trio, 'the token read, the gate and the delete are not consecutive statements')
  const first = bot.search(/\brequire\s*\(/)
  const end = trio.index + trio[0].length
  assert.ok(first < 0 || first > end, `bot.js:${bot.slice(0, first).split('\n').length} requires a module before the delete`)
})
