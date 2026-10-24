'use strict'
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createServer } = require('../mcp/server')
const { PORT, MCP_TOKEN, fakeBot, call, rpc, textOf, errorText, baseEnv, runEntry } = require('./helpers')

const RUN = '20261015-120000'
const NOW = new Date('2026-10-15T12:34:56.789Z')
const HEADER = `2026-10-15T12:34:56Z | pilot | ${RUN}`
const HEADER_LINE = new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ \\| pilot \\| ${RUN}$`)
const entry = (text) => `${HEADER}\n${text}\n\n`

function runDir (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-papercut-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, RUN)
  fs.mkdirSync(dir)
  return { root, dir, file: path.join(dir, 'papercuts.log') }
}

const server = (papercutsFile) => createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch, papercutsFile, now: () => NOW })
const papercut = (srv, args) => call(srv, 'note', { kind: 'papercut', ...args })
const read = (file) => fs.readFileSync(file, 'utf8')
const tree = (root) => fs.readdirSync(root, { recursive: true }).map((p) => p.split(path.sep).join('/')).sort()

function assertToolError (r, message) {
  assert.ok(r && r.result && r.result.isError === true, `expected a tool error, got ${JSON.stringify(r).slice(0, 300)}`)
  assert.strictEqual(errorText(r), message)
}

test('papercut appends one three-line entry stamped with the time and the run dir', async (t) => {
  const { file } = runDir(t)
  fs.writeFileSync(file, entry('earlier'))
  assert.strictEqual(textOf(await papercut(server(file), { text: 'the craft tool fought me' })), 'noted')
  assert.strictEqual(read(file), entry('earlier') + entry('the craft tool fought me'))
})

// CWE-117
test('papercut text lands on one line without line breaks, controls or format characters', async (t) => {
  const { file } = runDir(t)
  const srv = server(file)
  assert.strictEqual(textOf(await papercut(srv, { text: 'plain words' })), 'noted', 'control')
  const text = ' \u200b one \n two \r\n three \u2028 four \u2029 five \u0085 six \u202esev\u200benth\u00a0\u2003eight \n2026-01-01T00:00:00Z | pilot | x '
  assert.strictEqual(textOf(await papercut(srv, { text })), 'noted')
  assert.strictEqual(read(file), entry('plain words') + entry('one two three four five six seventh eight 2026-01-01T00:00:00Z | pilot | x'))
})

test('papercut refuses empty and over-long text and writes nothing', async (t) => {
  const { file } = runDir(t)
  const srv = server(file)
  assert.strictEqual(textOf(await papercut(srv, { text: 'x'.repeat(600) })), 'noted', 'control')
  const before = read(file)
  for (const text of [' \u00a0\u3000 ', '\u200b\u2028\n\r\u202e\u0085']) {
    assertToolError(await papercut(srv, { text }), 'papercut text is empty')
  }
  const long = await papercut(srv, { text: 'x'.repeat(601) })
  assert.strictEqual(long.result.isError, true, '601 characters')
  assert.strictEqual(read(file), before)
})

// CWE-770
test('the stdio server writes to GOLEM_PAPERCUTS and accepts at most 20 entries per process', { timeout: 20000 }, async (t) => {
  const { file } = runDir(t)
  const e = runEntry(t, [String(PORT)], { ...baseEnv(), GOLEM_TOKEN: MCP_TOKEN, GOLEM_PAPERCUTS: file })
  const texts = Array.from({ length: 21 }, (_, i) => `entry ${i + 1}`)
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'note', arguments: { kind: 'papercut', text: ' \u200b ' } } },
    ...texts.map((text, i) => ({ jsonrpc: '2.0', id: 3 + i, method: 'tools/call', params: { name: 'note', arguments: { kind: 'papercut', text } } }))
  ]
  e.child.stdin.write(lines.map((l) => JSON.stringify(l) + '\n').join(''))
  const replies = []
  for (const { id } of lines.slice(1)) {
    const r = await e.response(id, 8000)
    assert.ok(r && r.result, `no tools/call result for id ${id}`)
    replies.push(r.result.content.map((c) => c.text).join('\n'))
  }
  assert.strictEqual(replies[0], 'papercut text is empty')
  const answers = replies.slice(1)
  assert.strictEqual(answers.filter((a) => a === 'noted').length, 20, answers.join(', '))
  assert.strictEqual(answers.filter((a) => a === 'papercut limit reached').length, 1, answers.join(', '))
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

// CWE-73
test('without papercutsFile, papercut answers papercuts are off and writes nothing', async (t) => {
  const { root, file } = runDir(t)
  assert.strictEqual(textOf(await papercut(server(file), { text: 'control' })), 'noted', 'control')
  const before = tree(root)
  const cwd = process.cwd()
  const env = process.env.GOLEM_PAPERCUTS
  process.chdir(root)
  process.env.GOLEM_PAPERCUTS = path.join(root, 'from-env.log')
  try {
    const srv = createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch, now: () => NOW })
    assertToolError(await papercut(srv, { text: 'note' }), 'papercuts are off')
  } finally {
    process.chdir(cwd)
    if (env === undefined) delete process.env.GOLEM_PAPERCUTS
    else process.env.GOLEM_PAPERCUTS = env
  }
  assert.deepStrictEqual(tree(root), before)
})

// CWE-73
test('papercut text that looks like a path is written as text into the configured file', async (t) => {
  const { root, dir, file } = runDir(t)
  const srv = server(file)
  const escape = `../../papercut-${crypto.randomBytes(8).toString('hex')}`
  for (const text of [escape, 'C:/Windows/x']) assert.strictEqual(textOf(await papercut(srv, { text })), 'noted', text)
  assert.strictEqual(read(file), entry(escape) + entry('C:/Windows/x'))
  assert.deepStrictEqual(tree(root), [RUN, `${RUN}/papercuts.log`])
  assert.ok(!fs.existsSync(path.resolve(dir, escape)), 'a file was created at the text as a path')
})

// CWE-209
test('a write failure answers a generic error without the path', async (t) => {
  const { dir, file } = runDir(t)
  assert.strictEqual(textOf(await papercut(server(file), { text: 'control' })), 'noted', 'control')
  assertToolError(await papercut(server(dir), { text: 'into a directory' }), 'the papercut could not be written')
})

test('tools/list names the same tools with and without papercutsFile, note with kind papercut included', async (t) => {
  const { file } = runDir(t)
  const listed = async (srv) => (await rpc(srv, 'tools/list', {})).result.tools
  const withFile = await listed(server(file))
  const without = await listed(createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch }))
  const note = withFile.find((x) => x.name === 'note')
  assert.ok(note, 'control: note is listed with papercutsFile')
  assert.ok(note.inputSchema.properties.kind.enum.includes('papercut'))
  assert.strictEqual(note.inputSchema.properties.text.maxLength, 600)
  assert.deepStrictEqual(note.inputSchema.required, ['kind'])
  assert.deepStrictEqual(without.map((x) => x.name), withFile.map((x) => x.name))
})
