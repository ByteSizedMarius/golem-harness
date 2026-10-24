'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { MOD_TOPICS } = require('../mcp/server')
const { PORT, MCP_TOKEN, mcpServer, manualFixture, call, rpc, isToolError, textOf, baseEnv, runEntry } = require('./helpers')

const MANUAL = path.join(__dirname, '..', 'manual')
const WATER = '# Water\n\nSurface before the bubbles run out.\n'
const GRAVES = '# Graves\n\n## Key rules\n\n- GRAVE-MARKER-17.\n'
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }

const manualTool = async (srv) => (await rpc(srv, 'tools/list', {})).result.tools.find((x) => x.name === 'manual')
const fixture = (t) => manualFixture(t, { 'water.md': WATER, 'graves.md': GRAVES })

test('a gated topic is withheld unless topics names it', async (t) => {
  const dir = fixture(t)
  const withheld = mcpServer({ manualDir: dir }).srv
  const tool = await manualTool(withheld)
  assert.deepStrictEqual(tool.inputSchema.properties.topic.enum, ['water'])
  assert.ok(!tool.description.includes('graves'), tool.description)
  const r = await call(withheld, 'manual', { topic: 'graves' })
  assert.ok(isToolError(r))
  assert.ok(!JSON.stringify(r).includes('GRAVE-MARKER-17'), JSON.stringify(r).slice(0, 300))
  assert.strictEqual(textOf(await call(withheld, 'manual', { topic: 'water' })), WATER)

  const served = mcpServer({ manualDir: dir, topics: ['graves'] }).srv
  const enabled = await manualTool(served)
  assert.deepStrictEqual(enabled.inputSchema.properties.topic.enum, ['graves', 'water'])
  assert.ok(enabled.description.includes('graves'), enabled.description)
  assert.strictEqual(textOf(await call(served, 'manual', { topic: 'graves' })), GRAVES)
  assert.strictEqual(textOf(await call(served, 'manual', { topic: 'water' })), WATER)
})

test('topics ignores a name that is no gated topic', async (t) => {
  const dir = fixture(t)
  const tool = await manualTool(mcpServer({ manualDir: dir, topics: ['nope', 'water'] }).srv)
  assert.deepStrictEqual(tool.inputSchema.properties.topic.enum, ['water'])
})

test('createServer refuses topics that is not an array of names, without echoing it', (t) => {
  const dir = fixture(t)
  assert.doesNotThrow(() => mcpServer({ manualDir: dir, topics: [] }), 'control')
  for (const topics of ['graves', [1]]) {
    assert.throws(() => mcpServer({ manualDir: dir, topics }), (e) => e instanceof TypeError && /\btopics\b/.test(e.message) && !e.message.includes('graves'), JSON.stringify(topics))
  }
})

test('the grave tool brings up the graves key rules only while graves is served', async () => {
  const primer = (r) => r.result.content.map((c) => c.text).find((x) => /\nMore: manual\('[a-z0-9-]+'\)$/.test(x)) ?? null
  const bot = (topics) => mcpServer({ reply: () => ({ ok: true }), topics }).srv
  assert.match(primer(await call(bot(['graves']), 'grave', { take: 'all' })) ?? '', /\nMore: manual\('graves'\)$/)
  assert.strictEqual(primer(await call(bot(undefined), 'grave', { take: 'all' })), null)
})

test('createServer refuses a gated topic with broken key rules even when it is not served', (t) => {
  const dir = manualFixture(t, { 'water.md': WATER, 'graves.md': '# Graves\n\nNo rules here.\n' })
  assert.throws(() => mcpServer({ manualDir: dir }), { name: 'TypeError', message: /\bgraves\b/ })
})

test('createServer refuses broken key rules in a topic no tool primes', (t) => {
  const rules = (n) => Array.from({ length: n }, (_, i) => `- Rule ${i + 1}.`).join('\n')
  const start = (death) => mcpServer({ manualDir: manualFixture(t, { 'water.md': WATER, 'death.md': death }) })
  assert.doesNotThrow(() => start(`# Death\n\n## Key rules\n\n${rules(2)}\n`), 'control')
  assert.doesNotThrow(() => start('# Death\n\nNo heading.\n'), 'no heading')
  for (const death of [`# Death\n\n## Key rules\n\n${rules(4)}\n`, '# Death\n\n## Key rules\n\nNo rules.\n', `# Death\n\nIntro.\n\n## Key rules\n\n${rules(2)}\n`]) {
    assert.throws(() => start(death), { name: 'TypeError', message: /\bdeath\b/ }, death)
  }
})

test('every gated topic ships as a manual file', () => {
  assert.ok(MOD_TOPICS.length > 0)
  for (const topic of MOD_TOPICS) assert.ok(fs.statSync(path.join(MANUAL, `${topic}.md`)).isFile(), topic)
})

test('GOLEM_TOPICS names the gated topics the entry point serves, and an odd value still starts it', async (t) => {
  const listsGraves = async (value) => {
    const env = { ...baseEnv(), GOLEM_TOKEN: MCP_TOKEN }
    if (value !== undefined) env.GOLEM_TOPICS = value
    const e = runEntry(t, [String(PORT)], env)
    e.child.stdin.write(JSON.stringify(INIT) + '\n')
    e.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    const r = await e.response(2, 8000)
    e.child.kill()
    assert.ok(r && r.result, `GOLEM_TOPICS=${value}: no tools/list result`)
    return r.result.tools.find((x) => x.name === 'manual').inputSchema.properties.topic.enum.includes('graves')
  }
  assert.strictEqual(await listsGraves('graves'), true)
  assert.strictEqual(await listsGraves(',,graves,'), true)
  assert.strictEqual(await listsGraves(''), false)
  assert.strictEqual(await listsGraves(undefined), false)
  assert.strictEqual(await listsGraves('nope'), false)
})
