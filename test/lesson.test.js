'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createServer } = require('../mcp/server')
const { PORT, MCP_TOKEN, fakeBot, call, rpc, textOf, errorText, baseEnv, runEntry } = require('./helpers')

const RUN = '20261015-120000'
const NOW = new Date('2026-10-15T12:34:56.789Z')
const HEADER = `2026-10-15T12:34:56Z | pilot | ${RUN}`
const HEADER_LINE = new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ \\| pilot \\| ${RUN} \\| for rules$`)
const entry = (text, place) => `${HEADER}${place === undefined ? '' : ` | for ${place}`}\n${text}\n\n`

function runDir (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-lesson-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, RUN)
  fs.mkdirSync(dir)
  return { root, dir, file: path.join(dir, 'lessons.log') }
}

const server = (lessonsFile) => createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch, lessonsFile, now: () => NOW })
const lesson = (srv, args) => call(srv, 'note', { kind: 'lesson', ...args })
const read = (file) => fs.readFileSync(file, 'utf8')
const tree = (root) => fs.readdirSync(root, { recursive: true }).map((p) => p.split(path.sep).join('/')).sort()

function assertToolError (r, message) {
  assert.ok(r && r.result && r.result.isError === true, `expected a tool error, got ${JSON.stringify(r).slice(0, 300)}`)
  assert.strictEqual(errorText(r), message)
}

test('lesson appends one entry stamped with the time, the run dir and where it belongs', async (t) => {
  const { file } = runDir(t)
  const srv = server(file)
  fs.writeFileSync(file, entry('earlier'))
  assert.strictEqual(textOf(await lesson(srv, { text: 'sand falls when the block below goes' })), 'noted')
  assert.strictEqual(textOf(await lesson(srv, { text: 'chests need air above', for: 'building' })), 'noted')
  assert.strictEqual(read(file), entry('earlier') + entry('sand falls when the block below goes') + entry('chests need air above', 'building'))
})

// CWE-117
test('lesson text lands on one line and a for outside letters, digits, - and _ is refused', async (t) => {
  const { file } = runDir(t)
  const srv = server(file)
  assert.strictEqual(textOf(await lesson(srv, { text: 'plain words', for: 'wait_events' })), 'noted', 'control')
  assert.strictEqual(textOf(await lesson(srv, { text: ' one \n two \u2028 three\u200b ' })), 'noted')
  const before = read(file)
  for (const place of ['rules | pilot', 'rules\nforged', 'rules\u200b', 'a b']) {
    assertToolError(await lesson(srv, { text: 'note', for: place }), 'for takes a manual topic, a tool name or rules')
  }
  assert.strictEqual(read(file), before)
  assert.strictEqual(before, entry('plain words', 'wait_events') + entry('one two three'))
})

test('lesson refuses empty and over-long text and an over-long for, and writes nothing', async (t) => {
  const { file } = runDir(t)
  const srv = server(file)
  assert.strictEqual(textOf(await lesson(srv, { text: 'x'.repeat(600), for: 'f'.repeat(32) })), 'noted', 'control')
  const before = read(file)
  for (const text of [' \u00a0\u3000 ', '\u200b\u2028\n\r\u202e\u0085']) {
    assertToolError(await lesson(srv, { text }), 'lesson text is empty')
  }
  assert.strictEqual((await lesson(srv, { text: 'x'.repeat(601) })).result.isError, true, '601 characters')
  assert.strictEqual((await lesson(srv, { text: 'x', for: 'f'.repeat(33) })).result.isError, true, 'for of 33 characters')
  assert.strictEqual(read(file), before)
})

// CWE-770
test('the stdio server writes to GOLEM_LESSONS and accepts at most 20 lessons per process', { timeout: 20000 }, async (t) => {
  const { file } = runDir(t)
  const e = runEntry(t, [String(PORT)], { ...baseEnv(), GOLEM_TOKEN: MCP_TOKEN, GOLEM_LESSONS: file })
  const texts = Array.from({ length: 21 }, (_, i) => `entry ${i + 1}`)
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'note', arguments: { kind: 'lesson', text: ' \u200b ' } } },
    ...texts.map((text, i) => ({ jsonrpc: '2.0', id: 3 + i, method: 'tools/call', params: { name: 'note', arguments: { kind: 'lesson', text, for: 'rules' } } }))
  ]
  e.child.stdin.write(lines.map((l) => JSON.stringify(l) + '\n').join(''))
  const replies = []
  for (const { id } of lines.slice(1)) {
    const r = await e.response(id, 8000)
    assert.ok(r && r.result, `no tools/call result for id ${id}`)
    replies.push(r.result.content.map((c) => c.text).join('\n'))
  }
  assert.strictEqual(replies[0], 'lesson text is empty')
  const answers = replies.slice(1)
  assert.strictEqual(answers.filter((a) => a === 'noted').length, 20, answers.join(', '))
  assert.strictEqual(answers.filter((a) => a === 'lesson limit reached').length, 1, answers.join(', '))
  const parts = read(file).split('\n')
  assert.strictEqual(parts.length, 20 * 3 + 1)
  const written = []
  for (let i = 0; i < 20 * 3; i += 3) {
    assert.match(parts[i], HEADER_LINE)
    assert.strictEqual(parts[i + 2], '')
    written.push(parts[i + 1])
  }
  assert.strictEqual(new Set(written).size, 20)
  for (const w of written) assert.ok(texts.includes(w), w)
})

// CWE-770
test('lessons and papercuts count toward separate limits', async (t) => {
  const { dir, file } = runDir(t)
  const papercuts = path.join(dir, 'papercuts.log')
  const srv = createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch, papercutsFile: papercuts, lessonsFile: file, now: () => NOW })
  for (let i = 1; i <= 20; i++) assert.strictEqual(textOf(await call(srv, 'note', { kind: 'papercut', text: `cut ${i}` })), 'noted', `cut ${i}`)
  assertToolError(await call(srv, 'note', { kind: 'papercut', text: 'cut 21' }), 'papercut limit reached')
  for (let i = 1; i <= 20; i++) assert.strictEqual(textOf(await lesson(srv, { text: `lesson ${i}` })), 'noted', `lesson ${i}`)
  assertToolError(await lesson(srv, { text: 'lesson 21' }), 'lesson limit reached')
})

// CWE-73
test('without lessonsFile, lesson answers lessons are off and writes nothing', async (t) => {
  const { root, file } = runDir(t)
  assert.strictEqual(textOf(await lesson(server(file), { text: 'control' })), 'noted', 'control')
  const before = tree(root)
  const cwd = process.cwd()
  const env = process.env.GOLEM_LESSONS
  process.chdir(root)
  process.env.GOLEM_LESSONS = path.join(root, 'from-env.log')
  try {
    const srv = createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch, now: () => NOW })
    assertToolError(await lesson(srv, { text: 'note', for: 'rules' }), 'lessons are off')
  } finally {
    process.chdir(cwd)
    if (env === undefined) delete process.env.GOLEM_LESSONS
    else process.env.GOLEM_LESSONS = env
  }
  assert.deepStrictEqual(tree(root), before)
})

// CWE-209
test('a lesson write failure answers a generic error without the path', async (t) => {
  const { dir, file } = runDir(t)
  assert.strictEqual(textOf(await lesson(server(file), { text: 'control' })), 'noted', 'control')
  t.mock.method(console, 'error', () => {})
  assertToolError(await lesson(server(dir), { text: 'into a directory' }), 'the lesson could not be written')
})

test('createServer refuses a relative lessonsFile', () => {
  assert.throws(() => server('lessons.log'), /lessonsFile must be an absolute path/)
})

test('tools/list names note with kind required and an optional text and for', async (t) => {
  const { file } = runDir(t)
  const withFile = (await rpc(server(file), 'tools/list', {})).result.tools
  const without = (await rpc(createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch }), 'tools/list', {})).result.tools
  const note = withFile.find((x) => x.name === 'note')
  assert.ok(note, 'control: note is listed with lessonsFile')
  assert.strictEqual(note.inputSchema.properties.text.maxLength, 600)
  assert.strictEqual(note.inputSchema.properties.for.maxLength, 32)
  assert.deepStrictEqual(note.inputSchema.required, ['kind'])
  assert.deepStrictEqual(without.map((x) => x.name), withFile.map((x) => x.name))
})
