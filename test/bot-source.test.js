'use strict'
// Requiring bot.js connects to a server.
const test = require('node:test')
const assert = require('node:assert')
const { botSource, codeOnly, balanced } = require('./helpers')

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
