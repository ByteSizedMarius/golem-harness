'use strict'
// Requiring bot.js connects to a server.
const test = require('node:test')
const assert = require('node:assert')
const { botSource } = require('./helpers')

const src = botSource()

test('bot.js registers no /batch route', () => {
  assert.match(src, /app\.get\(\s*['"`]\/state['"`]/, 'control: the route pattern matches an existing route')
  assert.doesNotMatch(src, /app\.(get|use|all|post|put|patch|delete)\(\s*['"`]\/batch\b/)
})

test('bot.js binds the control API to 127.0.0.1 with no env override', () => {
  const listens = [...src.matchAll(/\bapp\.listen\(([^)]*)/g)].map((m) => m[1])
  assert.ok(listens.length >= 1, 'app.listen( not found')
  for (const args of listens) assert.match(args, /^\s*[^,]+,\s*['"]127\.0\.0\.1['"]/, `app.listen(${args}`)
  assert.doesNotMatch(src, /BIND_HOST/)
})
