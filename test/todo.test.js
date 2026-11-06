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

test('current marks one item, moves the mark off any other, and the list shows that item first with the age of its mark', async (t) => {
  const { file } = todoFile(t)
  const clock = { ms: START }
  const srv = server(file, clock)
  await call(srv, 'todo', { action: 'add', text: 'fence the farm', priority: 'high' })
  await call(srv, 'todo', { action: 'add', text: 'bake bread', who: 'byte' })
  await call(srv, 'todo', { action: 'add', text: 'replant the farm plot', priority: 'low' })
  clock.ms += 2 * 3600 * 1000
  assert.match(textOf(await call(srv, 'todo', { action: 'current', id: 3 })), /^#3 is now current\./)
  clock.ms += 5 * 60 * 1000
  assert.deepStrictEqual(textOf(await call(srv, 'todo', { action: 'list' })).split('\n'), ['Todo list, the current task first, then high priority, then oldest first:',
    '#3 [current 5m, low, 2h] replant the farm plot', '#1 [high, 2h] fence the farm', '#2 [byte, 2h] bake bread'])
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'current', id: 2 }))),
    ['#2 is now current.', '#2 [current 0m, byte, 2h] bake bread', '#1 [high, 2h] fence the farm', '#3 [low, 2h] replant the farm plot'])
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items.filter((x) => x.current).map((x) => x.id), [2])
})

test('done or drop on the current item leaves no item current', async (t) => {
  for (const action of ['done', 'drop']) {
    const { file } = todoFile(t)
    const srv = server(file)
    for (const text of ['bake bread', 'smelt the iron']) await call(srv, 'todo', { action: 'add', text })
    assert.match(textOf(await call(srv, 'todo', { action: 'current', id: 2 })), /^#2 is now current\./)
    const lines = textOf(await call(srv, 'todo', { action, id: 2 })).split('\n')
    assert.deepStrictEqual(lines.slice(1), ['Todo list, high priority first, then oldest first:', '#1 [0m] bake bread'], action)
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).items.every((x) => !Object.hasOwn(x, 'current')), action)
  }
})

test('current needs the id of an open item and takes no text, who or priority', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  await call(srv, 'todo', { action: 'add', text: 'bake bread' })
  assert.match(textOf(await call(srv, 'todo', { action: 'current', id: 1 })), /^#1 is now current\./)
  const before = fs.readFileSync(file, 'utf8')
  assert.match(assertToolError(await call(srv, 'todo', { action: 'current', id: 9 })), /^No open todo has id 9\.\nTodo list/)
  for (const args of [{ action: 'current' }, { action: 'current', id: 1, text: 'x' }, { action: 'current', id: 1, who: 'byte' },
    { action: 'current', id: 1, priority: 'high' }]) {
    assertToolError(await call(srv, 'todo', args))
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before)
})

test('a file with two current items is refused as malformed', async (t) => {
  const { file } = todoFile(t)
  const at = new Date(START).toISOString()
  fs.writeFileSync(file, JSON.stringify({ next: 3, items: [{ id: 1, text: 'bake bread', at, current: at }, { id: 2, text: 'smelt the iron', at, current: at }] }))
  assert.strictEqual(assertToolError(await call(server(file), 'todo', { action: 'list' })), 'the todo list could not be read')
})

test('a file with current false loads that item as not current and stores it without the key', async (t) => {
  const { file } = todoFile(t)
  fs.writeFileSync(file, JSON.stringify({ next: 2, items: [{ id: 1, text: 'bake bread', at: new Date(START).toISOString(), current: false }] }))
  const srv = server(file)
  assert.deepStrictEqual(textOf(await call(srv, 'todo', { action: 'list' })).split('\n'), ['Todo list, high priority first, then oldest first:', '#1 [0m] bake bread'])
  await call(srv, 'todo', { action: 'add', text: 'smelt the iron' })
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')).items[0], 'current'), 'false is not stored')
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

test('an add whose rename is refused once while another process holds the file still lands in the list', async (t) => {
  const { root, file } = todoFile(t)
  const rename = fs.renameSync
  let refused = false
  t.mock.method(fs, 'renameSync', function (...args) {
    if (!refused) {
      refused = true
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    }
    return rename.apply(this, args)
  })
  const r = await call(server(file), 'todo', { action: 'add', text: 'bake bread' })
  t.mock.restoreAll()
  assert.ok(refused)
  assert.match(textOf(r), /^Added #1\./)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items.map((x) => x.text), ['bake bread'])
  assert.deepStrictEqual(fs.readdirSync(root), ['todo.json'])
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

test('the boot reply lists the current task first', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  for (const text of ['idle the nights', 'replant the farm plot']) await call(srv, 'todo', { action: 'add', text })
  await call(srv, 'todo', { action: 'current', id: 2 })
  const content = (await call(server(file, undefined, () => ({ ok: true })), 'boot', {})).result.content
  assert.deepStrictEqual(openLines(content[content.length - 1].text), ['#2 [current 0m, 0m] replant the farm plot', '#1 [0m] idle the nights'])
})

// ---- text caps ----

const SMILE = '\u{1F600}'
const AT = new Date(START).toISOString()
const items = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).items

// CWE-770
test('I1: a todo text of 400 units is kept and shown whole, 401 units or a who of 33 is refused and stores nothing', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'add', text: 'bake bread' }))), ['#1 [0m] bake bread'], 'control')
  const plain = 'a'.repeat(399) + 'Z'
  const astral = SMILE.repeat(200)
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'add', text: plain }))), ['#1 [0m] bake bread', `#2 [0m] ${plain}`])
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'add', text: astral, who: 'w'.repeat(32) }))),
    ['#1 [0m] bake bread', `#2 [0m] ${plain}`, `#3 [${'w'.repeat(32)}, 0m] ${astral}`])
  assert.deepStrictEqual(items(file).map((x) => x.text), ['bake bread', plain, astral])
  const before = fs.readFileSync(file, 'utf8')
  assert.strictEqual(assertToolError(await call(srv, 'todo', { action: 'add', text: 'b'.repeat(401) })), 'text must be a string of 1 to 400 characters')
  assert.strictEqual(assertToolError(await call(srv, 'todo', { action: 'add', text: astral + 'x' })), 'text must be a string of 1 to 400 characters')
  assert.strictEqual(assertToolError(await call(srv, 'todo', { action: 'add', text: 'fine', who: 'w'.repeat(33) })), 'who must be a string of 1 to 32 characters')
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before)
})

// CWE-400, operator-owned bytes
test('I5: a hand-edited todo file renders flat and cut to the caps everywhere, and an add keeps its texts byte for byte', async (t) => {
  const { file } = todoFile(t)
  fs.writeFileSync(file, JSON.stringify({ next: 2, items: [{ id: 1, text: 'bake bread', at: AT }] }))
  const srv = server(file, undefined, () => ({ ok: true }))
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'list' }))), ['#1 [0m] bake bread'], 'control')
  // The who's 32nd unit is the first half of a surrogate pair.
  const who = 'W'.repeat(31) + SMILE.repeat(84) + 'W'
  const hand = [
    { id: 1, text: 'L'.repeat(5000), who, at: AT },
    { id: 2, text: 'ring\u0007bell', at: AT },
    { id: 3, text: 'zero\u200bwidth', at: AT },
    { id: 4, text: 'bake bread', at: AT }
  ]
  assert.strictEqual(who.length, 200)
  fs.writeFileSync(file, JSON.stringify({ next: 5, items: hand }))
  const shown = [`#1 [${'W'.repeat(31)}, 0m] ${'L'.repeat(400)}`, '#2 [0m] ring bell', '#3 [0m] zerowidth', '#4 [0m] bake bread']
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'list' }))), shown, 'todo list')
  const boot = (await call(srv, 'boot', {})).result.content
  assert.deepStrictEqual(openLines(boot.slice(1).map((c) => c.text).join('\n')), shown, 'boot')
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'add', text: 'smelt the iron' }))), [...shown, '#5 [0m] smelt the iron'], 'add')
  assert.deepStrictEqual(items(file).slice(0, 4), hand)
})

// CWE-770
test('I6: a todo file of 100 items shows the first 30 and how many more the file holds, and keeps all 100', async (t) => {
  const { file } = todoFile(t)
  const many = (n) => JSON.stringify({ next: n + 1, items: Array.from({ length: n }, (_, i) => ({ id: i + 1, text: `item ${i + 1}`, at: AT })) })
  const lines = Array.from({ length: 30 }, (_, i) => `#${i + 1} [0m] item ${i + 1}`)
  fs.writeFileSync(file, many(30))
  const srv = server(file)
  assert.deepStrictEqual(textOf(await call(srv, 'todo', { action: 'list' })).split('\n').slice(1), lines, 'control: 30 items, no more line')
  fs.writeFileSync(file, many(100))
  assert.deepStrictEqual(textOf(await call(srv, 'todo', { action: 'list' })).split('\n').slice(1), [...lines, '70 more in the todo file'])
  assert.strictEqual(items(file).length, 100)
})

// CWE-20, operator-owned bytes
test('I10: a hand-edited todo file with next above 1000000 or two items of one id is refused as unreadable and left byte for byte', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  fs.writeFileSync(file, JSON.stringify({ next: 1000000, items: [{ id: 1, text: 'bake bread', at: AT }, { id: 999999, text: 'smelt the iron', at: AT }] }))
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'list' }))), ['#1 [0m] bake bread', '#999999 [0m] smelt the iron'], 'control: next 1000000')
  t.mock.method(console, 'error', () => {})
  const cases = [
    ['next 1000001', '{"next":1000001,"items":[{"id":1,"text":"bake bread","at":"' + AT + '"}]}'],
    ['next 2^53', '{"next":9007199254740992,"items":[{"id":1,"text":"bake bread","at":"' + AT + '"}]}'],
    ['two items of id 1', '{"next":3,"items":[{"id":1,"text":"bake bread","at":"' + AT + '"},{"id":1,"text":"smelt the iron","at":"' + AT + '"}]}']
  ]
  const replyOf = (r) => (r.result.isError === true ? errorText(r) : `loaded: ${errorText(r).slice(0, 100)}`)
  const got = []
  for (const [label, raw] of cases) {
    fs.writeFileSync(file, raw)
    got.push([label,
      replyOf(await call(srv, 'todo', { action: 'list' })),
      replyOf(await call(srv, 'todo', { action: 'add', text: 'fence the farm' })),
      replyOf(await call(srv, 'todo', { action: 'done', id: 1 })),
      fs.readFileSync(file, 'utf8') === raw ? 'file kept' : 'file changed'])
  }
  assert.deepStrictEqual(got, cases.map(([label]) => [label, 'the todo list could not be read', 'the todo list could not be read or written',
    'the todo list could not be read or written', 'file kept']))
})

// CWE-20, operator-owned bytes
test('I10: add against a todo file whose next is 1000000 is refused as used up and leaves the file byte for byte', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  fs.writeFileSync(file, JSON.stringify({ next: 999999, items: [{ id: 1, text: 'bake bread', at: AT }] }))
  assert.match(textOf(await call(srv, 'todo', { action: 'add', text: 'smelt the iron' })), /^Added #999999\./, 'control')
  const raw = JSON.stringify({ next: 1000000, items: [{ id: 1, text: 'bake bread', at: AT }, { id: 999998, text: 'smelt the iron', at: AT }] })
  fs.writeFileSync(file, raw)
  assert.match(assertToolError(await call(srv, 'todo', { action: 'add', text: 'fence the farm' })), /used up/)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), raw)
})

// CWE-532, operator-owned bytes
test('I11: a todo file that is not valid JSON is reported unreadable and none of its text reaches stderr', async (t) => {
  const { file } = todoFile(t)
  const srv = server(file)
  fs.writeFileSync(file, JSON.stringify({ next: 2, items: [{ id: 1, text: 'bake bread MARKER-7f3a', at: AT }] }))
  assert.deepStrictEqual(openLines(textOf(await call(srv, 'todo', { action: 'list' }))), ['#1 [0m] bake bread MARKER-7f3a'], 'control')
  const logged = []
  t.mock.method(console, 'error', (...args) => { logged.push(args.map(String).join(' ')) })
  t.mock.method(process.stderr, 'write', (chunk) => {
    logged.push(String(chunk))
    return true
  })
  console.error('capture check')
  assert.deepStrictEqual(logged.splice(0), ['capture check'], 'control: stderr is captured')
  // JSON.parse quotes an input this short whole in its message.
  fs.writeFileSync(file, '{"next":MARKER-7f3a}')
  const list = assertToolError(await call(srv, 'todo', { action: 'list' }))
  const add = assertToolError(await call(srv, 'todo', { action: 'add', text: 'fence the farm' }))
  t.mock.restoreAll()
  assert.deepStrictEqual([list, add], ['the todo list could not be read', 'the todo list could not be read or written'])
  assert.deepStrictEqual(logged.filter((line) => line.includes('MARKER-7f3a')), [])
})

test('the stdio server keeps the todo list in GOLEM_TODO', { timeout: 20000 }, async (t) => {
  const { file } = todoFile(t)
  const e = runEntry(t, [String(PORT)], { ...baseEnv(), GOLEM_TOKEN: MCP_TOKEN, GOLEM_TODO: file })
  e.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'todo', arguments: { action: 'add', text: 'bake bread' } } }) + '\n')
  const r = await e.response(1, 8000)
  assert.ok(r && r.result && !r.result.isError, JSON.stringify(r))
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items.map((x) => x.text), ['bake bread'])
})
