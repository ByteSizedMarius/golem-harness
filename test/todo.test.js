'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createServer } = require('../mcp/server')
const { TODO_CAP } = require('../lib/todo')
const { PORT, MCP_TOKEN, fakeBot, call, textOf, errorText, baseEnv, runEntry } = require('./helpers')

const START = Date.parse('2026-10-15T12:00:00Z')

function todoFile (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-todo-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, file: path.join(root, 'todo.json') }
}

function server (file, clock = { ms: START }, reply) {
  return createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot({ reply }).fetch, todoFile: file, now: () => new Date(clock.ms) })
}

function assertToolError (r) {
  assert.ok(r && r.result && r.result.isError === true, `expected a tool error, got ${JSON.stringify(r).slice(0, 300)}`)
  return errorText(r)
}

const openLines = (text) => text.split('\n').filter((l) => l.startsWith('#'))

test('todo adds items, lists them oldest first with who and age, and done and drop remove them', async (t) => {
  const { file } = todoFile(t)
  const clock = { ms: START }
  const srv = server(file, clock)
  assert.match(textOf(await call(srv, 'todo', { action: 'list' })), /empty/)
  assert.match(textOf(await call(srv, 'todo', { action: 'add', text: 'bake bread', who: 'Halbes' })), /^Added #1\./)
  clock.ms += 3 * 3600 * 1000
  await call(srv, 'todo', { action: 'add', text: 'empty the\nfurnace' })
  await call(srv, 'todo', { action: 'add', text: 'wood for the owner', who: 'byte' })
  clock.ms += 5 * 60 * 1000
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'list' }))),
    ['#1 [Halbes, 3h] bake bread', '#2 [5m] empty the furnace', '#3 [byte, 5m] wood for the owner'])
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'done', id: 1 }))), ['#2 [5m] empty the furnace', '#3 [byte, 5m] wood for the owner'])
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'drop', id: 3 }))), ['#2 [5m] empty the furnace'])
  assert.deepStrictEqual(openLines(assertToolError(await call(srv, 'todo', { action: 'done', id: 3 }))), ['#2 [5m] empty the furnace'])
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).items
  assert.deepStrictEqual(stored.map((x) => x.text), ['empty the furnace'])
})

test('the list shows high priority first and low last, oldest first within a level', async (t) => {
  const { file } = todoFile(t)
  const clock = { ms: START }
  const srv = server(file, clock)
  await call(srv, 'todo', { action: 'add', text: 'tidy the chest', priority: 'low' })
  await call(srv, 'todo', { action: 'add', text: 'bake bread', who: 'byte', priority: 'normal' })
  await call(srv, 'todo', { action: 'add', text: 'fence the farm', priority: 'high' })
  clock.ms += 2 * 3600 * 1000
  await call(srv, 'todo', { action: 'add', text: 'wood for the owner', who: 'byte', priority: 'high' })
  await call(srv, 'todo', { action: 'add', text: 'label the signs', priority: 'low' })
  clock.ms += 5 * 60 * 1000
  const lines = textOf(await call(srv, 'todo', { action: 'list' })).split('\n')
  assert.deepStrictEqual(lines, ['Todo list, high priority first, then oldest first:', '#3 [high, 2h] fence the farm',
    '#4 [high, byte, 5m] wood for the owner', '#2 [byte, 2h] bake bread', '#1 [low, 2h] tidy the chest', '#5 [low, 5m] label the signs'])
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')).items[1], 'priority'), 'normal is not stored')
})

test('the priority action moves an item between levels and refuses an unknown id', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  for (const text of ['bake bread', 'smelt the iron', 'fence the farm']) await call(srv, 'todo', { action: 'add', text })
  const high = textOf(await call(srv, 'todo', { action: 'priority', id: 3, priority: 'high' })).split('\n')
  assert.deepStrictEqual([high[0], ...high.slice(2)], ['#3 is now high.', '#3 [high, 0m] fence the farm', '#1 [0m] bake bread', '#2 [0m] smelt the iron'])
  await call(srv, 'todo', { action: 'priority', id: 1, priority: 'low' })
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'priority', id: 3, priority: 'normal' }))).slice(1),
    ['#2 [0m] smelt the iron', '#3 [0m] fence the farm', '#1 [low, 0m] bake bread'])
  const missing = assertToolError(await call(srv, 'todo', { action: 'priority', id: 9, priority: 'high' }))
  assert.match(missing, /^No open todo has id 9\.\nTodo list/)
  assert.strictEqual(openLines(missing).length, 3)
})

test('priority is refused outside add and the priority action, and the priority action needs id and priority', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  await call(srv, 'todo', { action: 'add', text: 'bake bread' })
  const before = fs.readFileSync(file, 'utf8')
  for (const args of [{ action: 'done', id: 1, priority: 'high' }, { action: 'drop', id: 1, priority: 'low' }, { action: 'list', priority: 'high' },
    { action: 'priority', priority: 'high' }, { action: 'priority', id: 1 }, { action: 'priority', id: 1, priority: 'high', text: 'x' },
    { action: 'add', text: 'smelt the iron', id: 1 }]) {
    assertToolError(await call(srv, 'todo', args))
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before)
})

test('a file without priorities or with normal written out loads those items at normal and stores normal as no key', async (t) => {
  const { file } = todoFile(t)
  const at = new Date(START).toISOString()
  fs.writeFileSync(file, JSON.stringify({ next: 3, items: [{ id: 1, text: 'bake bread', at, priority: 'normal' }, { id: 2, text: 'smelt the iron', who: 'byte', at }] }))
  const srv = server(file)
  await call(srv, 'todo', { action: 'add', text: 'tidy the chest', priority: 'low' })
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'list' }))),
    ['#1 [0m] bake bread', '#2 [byte, 0m] smelt the iron', '#3 [low, 0m] tidy the chest'])
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')).items[0], 'priority'), 'normal is not stored')
})

test('a file with an unknown priority is refused as malformed', async (t) => {
  const { file } = todoFile(t)
  fs.writeFileSync(file, JSON.stringify({ next: 2, items: [{ id: 1, text: 'bake bread', at: new Date(START).toISOString(), priority: 'urgent' }] }))
  assert.strictEqual(assertToolError(await call(server(file), 'todo', { action: 'list' })), 'the todo list could not be read')
})

test('an add with who reminds the pilot to tell them it is queued, one without who does not', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  const asked = textOf(await call(srv, 'todo', { action: 'add', text: 'keep track of wheat', who: 'byte' })).split('\n')
  assert.deepStrictEqual(asked.slice(0, 2), ['Added #1.', 'Tell byte it is queued if you have not.'])
  const own = textOf(await call(srv, 'todo', { action: 'add', text: 'smelt the iron' }))
  assert.match(own, /^Added #2\.\nTodo list/)
  assert.doesNotMatch(own, /Tell/)
})

test('a fresh server reads the list an earlier one wrote and keeps counting ids', async (t) => {
  const { file } = todoFile(t)
  await call(server(file), 'todo', { action: 'add', text: 'seeds for Halbes' })
  await call(server(file), 'todo', { action: 'done', id: 1 })
  await call(server(file), 'todo', { action: 'add', text: 'smelt the iron' })
  assert.deepStrictEqual(openLines(textOf(await call(server(file), 'todo', { action: 'list' }))), ['#2 [0m] smelt the iron'])
})

// CWE-770
test('add refuses an item past the cap and leaves the file unchanged', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  for (let i = 1; i <= TODO_CAP; i++) textOf(await call(srv, 'todo', { action: 'add', text: `item ${i}` }))
  const before = fs.readFileSync(file, 'utf8')
  const text = assertToolError(await call(srv, 'todo', { action: 'add', text: 'one too many' }))
  assert.match(text, /full/)
  assert.strictEqual(openLines(text).length, TODO_CAP)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before)
})

test('without todoFile, todo answers todos are off and writes nothing', async (t) => {
  const { root } = todoFile(t)
  const srv = createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch })
  assert.strictEqual(assertToolError(await call(srv, 'todo', { action: 'add', text: 'bake bread' })), 'todos are off')
  assert.deepStrictEqual(fs.readdirSync(root), [])
})

test('the boot reply ends with the open list', async (t) => {
  const { file } = todoFile(t)
  const reply = () => ({ ok: true, health: 20 })
  const srv = server(file, undefined, reply)
  await call(srv, 'todo', { action: 'add', text: 'bake bread', who: 'Halbes' })
  const content = (await call(srv, 'boot', {})).result.content
  assert.deepStrictEqual(JSON.parse(content[0].text), { ok: true, health: 20 })
  assert.deepStrictEqual(openLines(content[content.length - 1].text), ['#1 [Halbes, 0m] bake bread'])
  const off = createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot({ reply }).fetch })
  assert.strictEqual((await call(off, 'boot', {})).result.content.length, 1, 'no list without todoFile')
})

test('the stdio server keeps the todo list in GOLEM_TODO', { timeout: 20000 }, async (t) => {
  const { file } = todoFile(t)
  const e = runEntry(t, [String(PORT)], { ...baseEnv(), GOLEM_TOKEN: MCP_TOKEN, GOLEM_TODO: file })
  e.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'todo', arguments: { action: 'add', text: 'bake bread' } } }) + '\n')
  const r = await e.response(1, 8000)
  assert.ok(r && r.result && !r.result.isError, JSON.stringify(r))
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items.map((x) => x.text), ['bake bread'])
})
