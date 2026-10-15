'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { once } = require('node:events')
const express = require('express')
const { VERB_BUDGET_MS, countVerbs } = require('../lib/verbs')
const { waitFor } = require('./helpers')

test('a route counts as running from its request until its handler settles, a failing one included', async (t) => {
  const app = express()
  const verbs = countVerbs(app)
  assert.strictEqual(typeof app.get('env'), 'string', 'app.get with one argument still reads a setting')
  let finish
  app.get('/craft', async (req, res) => {
    await new Promise((resolve) => { finish = resolve })
    res.json({ ok: true })
  })
  app.get('/broken', async () => { throw new Error('broke') })
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const reply = fetch(`${base}/craft`)
  assert.ok(await waitFor(() => finish, 2000), 'control: the handler runs')
  assert.strictEqual(verbs.running(), 1)
  finish()
  assert.strictEqual((await reply).status, 200)
  assert.strictEqual(verbs.running(), 0)
  assert.strictEqual((await fetch(`${base}/broken`)).status, 500)
  assert.strictEqual(verbs.running(), 0)
})

test('a route that hangs past its budget stops counting as running', async (t) => {
  const app = express()
  const verbs = countVerbs(app)
  let began
  app.get('/digat', async () => {
    began = Date.now()
    await new Promise(() => {})
  })
  const server = app.listen(0, '127.0.0.1')
  t.after(() => { server.closeAllConnections(); server.close() })
  await once(server, 'listening')
  fetch(`http://127.0.0.1:${server.address().port}/digat`).catch(() => {})
  assert.ok(await waitFor(() => began, 2000), 'control: the handler runs')
  assert.strictEqual(verbs.running(began + VERB_BUDGET_MS - 1000), 1, 'control: within its budget')
  assert.strictEqual(verbs.running(began + VERB_BUDGET_MS + 1000), 0)
})
