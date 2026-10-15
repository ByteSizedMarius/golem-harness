'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createServer, redact, PATH_TOKEN } = require('../mcp/server')
const { TOOLS } = require('../mcp/tools')
const { ROUTE_BOUNDS } = require('../lib/bounds')
const {
  HUNG, PORT, MCP_TOKEN, proofOver, timed, delay, rawReply, mcpServer, manualFixture, call, rpc, callReq, isToolError, isRpcError, assertOk,
  textOf, errorText, LOCAL_TOOLS, validValue, requiredArgs, toolNamed, chatTool, paramsOfType, mcpChatControl, assertSigned,
  baseEnv, assertEntryServes, assertEntryRefuses, fakeBot, runEntry
} = require('./helpers')

const FORBIDDEN_ROUTES = ['/snapshot', '/record', '/pov', '/threatdebug', '/pathdebug', '/stream', '/batch']
const FORBIDDEN_NAME = /snapshot|record|pov|stream|threatdebug|pathdebug|batch/i
const EMOJI = '\u{1F600}'

const radiusTool = () => {
  const t = TOOLS.find((x) => x.route === '/find' && x.params && x.params.radius) || TOOLS.find((x) => x.params && x.params.radius)
  assert.ok(t, 'a tool with a radius param')
  return t
}

// ---- the tool table ----

test('no tool takes a URL, path, route, raw query or step list', () => {
  assert.ok(TOOLS.length > 0)
  const banned = ['url', 'uri', 'path', 'route', 'endpoint', 'raw', 'do', 'step', 'steps', 'query', 'qs', 'querystring']
  for (const t of TOOLS) {
    for (const k of Object.keys(t.params)) assert.ok(!banned.includes(k.toLowerCase()), `${t.name}.${k}`)
  }
})

test('tools/list lists exactly the table, then wait_events and manual, and no forbidden tool or route', async () => {
  const { srv } = mcpServer()
  const r = await rpc(srv, 'tools/list', {})
  assert.ok(r && r.result && Array.isArray(r.result.tools), 'tools/list result')
  const tools = r.result.tools
  assert.deepStrictEqual(tools.map((t) => t.name), [...TOOLS.map((t) => t.name), ...LOCAL_TOOLS])
  for (const t of tools) {
    assert.doesNotMatch(t.name, FORBIDDEN_NAME)
    assert.ok(t.inputSchema && t.inputSchema.type === 'object', `${t.name} inputSchema`)
  }
  for (const t of TOOLS) assert.ok(!FORBIDDEN_ROUTES.includes(t.route), `${t.name} -> ${t.route}`)
})

test('initialize advertises tools and no resources', async () => {
  const { srv } = mcpServer()
  const r = await srv.handle({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
  assert.strictEqual(r.jsonrpc, '2.0')
  assert.strictEqual(r.id, 7)
  assert.ok(r.result && r.result.capabilities && r.result.capabilities.tools, 'tools capability')
  assert.strictEqual(r.result.capabilities.resources, undefined)
})

test('the bunker tool and the /bunker route share their bounds', () => {
  const numeric = Object.entries(toolNamed('bunker').params).filter(([, s]) => s.type === 'int' || s.type === 'num')
  assert.ok(numeric.length > 0, 'bunker has a numeric param')
  assert.ok(ROUTE_BOUNDS['/bunker'], 'ROUTE_BOUNDS has /bunker')
  for (const [k, spec] of numeric) assert.deepStrictEqual(ROUTE_BOUNDS['/bunker'][k], [spec.min, spec.max], `/bunker ${k}`)
})

test('every manual file is at most 4000 bytes and DRIVING.md lists exactly the manual topics', () => {
  const dir = path.join(__dirname, '..', 'manual')
  const files = fs.readdirSync(dir)
  assert.ok(files.length > 0, 'manual/ holds files')
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 4000, `${f} is over 4000 bytes`)
  const line = /^Topics for manual\(topic\): (.+)$/m.exec(fs.readFileSync(path.join(__dirname, '..', 'DRIVING.md'), 'utf8'))
  assert.ok(line, 'DRIVING.md has a topics line')
  assert.deepStrictEqual(line[1].split(', ').sort(), files.map((f) => f.replace(/\.md$/, '')).sort())
})

// manual replies skip the path redaction.
test('no manual file holds a drive or UNC path', () => {
  const pathToken = new RegExp(PATH_TOKEN.source)
  assert.match('see C:/Users/x', pathToken, 'control')
  const dir = path.join(__dirname, '..', 'manual')
  for (const f of fs.readdirSync(dir)) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), pathToken, f)
})

// ---- requests ----

test('the chat tool sends one signed GET to 127.0.0.1:<port>/chat', async () => {
  const { srv, calls } = mcpServer()
  assertOk(await call(srv, chatTool().name, { msg: 'hello' }))
  assert.strictEqual(calls.length, 1)
  const c = calls[0]
  assert.strictEqual(c.method, 'GET')
  assert.strictEqual(c.url.protocol, 'http:')
  assert.strictEqual(c.url.host, `127.0.0.1:${PORT}`)
  assert.strictEqual(c.url.pathname, '/chat')
  assert.deepStrictEqual(c.url.searchParams.getAll('msg'), ['hello'])
  assertSigned(c)
})

test('the signature covers the query as sent, also with characters URLSearchParams encodes', async () => {
  const { srv, calls } = mcpServer()
  assertOk(await call(srv, chatTool().name, { msg: 'Tōkyō & /me | 100%' }))
  assert.strictEqual(calls.length, 1)
  assertSigned(calls[0])
  assert.deepStrictEqual(calls[0].url.searchParams.getAll('msg'), ['Tōkyō & /me | 100%'])
})

test('every request carries a fresh nonce', async () => {
  const { srv, calls } = mcpServer()
  for (let i = 0; i < 20; i++) assertOk(await call(srv, chatTool().name, { msg: `m${i}` }))
  assert.strictEqual(calls.length, 20)
  for (const c of calls) assertSigned(c)
  assert.strictEqual(new Set(calls.map((c) => c.nonce)).size, 20)
})

test('a msg holding &lines= or other URL syntax arrives as one msg param, decoded exactly', async () => {
  const { srv, calls } = mcpServer()
  await mcpChatControl(srv, calls)
  const msg = '../../snapshot?x=1#frag&lines=%2Fop+/op&GOLEM_TOKEN=x\\..\\record'
  assertOk(await call(srv, chatTool().name, { msg }))
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].url.pathname, '/chat')
  assert.strictEqual(calls[0].url.hash, '')
  assert.deepStrictEqual([...calls[0].url.searchParams.keys()], ['msg'])
  assert.deepStrictEqual(calls[0].url.searchParams.getAll('msg'), [msg])
})

test('an unknown tool gets a tool error and no request', async () => {
  const { srv, calls } = mcpServer()
  await mcpChatControl(srv, calls)
  for (const name of ['nope', chatTool().name.toUpperCase(), 'toString']) {
    assert.ok(isToolError(await call(srv, name, { msg: 'hello' })), name)
  }
  assert.strictEqual(calls.length, 0)
})

test('an extra argument gets a tool error and no request', async () => {
  const { srv, calls } = mcpServer()
  await mcpChatControl(srv, calls)
  assert.ok(isToolError(await call(srv, chatTool().name, { msg: 'hi', extra: 1 })))
  assert.ok(isToolError(await call(srv, chatTool().name, JSON.parse('{"msg":"hi","__proto__":{"x":1}}'))))
  assert.strictEqual(calls.length, 0)
})

test('radius at its min and max is sent as a canonical decimal, text, null, out-of-range and fractional values get a tool error', async () => {
  const { srv, calls } = mcpServer()
  const t = radiusTool()
  const spec = t.params.radius
  const base = requiredArgs(t)
  for (const v of [spec.min, spec.max]) {
    calls.length = 0
    assertOk(await call(srv, t.name, { ...base, radius: v }))
    assert.strictEqual(calls[0].url.searchParams.get('radius'), String(v))
  }
  calls.length = 0
  for (const v of [String(validValue(spec)), null, spec.min - 1, spec.max + 1, spec.min + 0.5]) {
    assert.ok(isToolError(await call(srv, t.name, { ...base, radius: v })), JSON.stringify(v))
  }
  assert.strictEqual(calls.length, 0)
})

test('wrong types for a string param and non-object arguments get a tool error and no request', async () => {
  const { srv, calls } = mcpServer()
  await mcpChatControl(srv, calls)
  assert.ok(isToolError(await call(srv, chatTool().name, { msg: ['hi'] })), 'msg ["hi"]')
  for (const args of [['hello'], 'msg=hello']) {
    assert.ok(isToolError(await call(srv, chatTool().name, args)), JSON.stringify(args))
  }
  assert.strictEqual(calls.length, 0)
})

test('a msg of maxLen UTF-16 units passes, maxLen+1 units get a tool error and no request', async () => {
  const { srv, calls } = mcpServer()
  const { maxLen } = chatTool().params.msg
  assertOk(await call(srv, chatTool().name, { msg: 'a'.repeat(maxLen) }))
  assert.strictEqual(calls[0].url.searchParams.get('msg'), 'a'.repeat(maxLen))
  calls.length = 0
  assert.ok(isToolError(await call(srv, chatTool().name, { msg: 'a'.repeat(maxLen + 1) })), '+1')
  assert.ok(isToolError(await call(srv, chatTool().name, { msg: EMOJI.repeat(Math.ceil((maxLen + 1) / 2)) })), 'emoji')
  assert.strictEqual(calls.length, 0)
})

test('a bool param refuses strings, numbers and null', async () => {
  const { srv, calls } = mcpServer()
  const bools = paramsOfType('bool')
  assert.ok(bools.length > 0, 'a routed tool with a bool param')
  const [t, k] = bools[0]
  assertOk(await call(srv, t.name, { ...requiredArgs(t), [k]: true }))
  calls.length = 0
  for (const v of ['true', 1, null]) {
    assert.ok(isToolError(await call(srv, t.name, { ...requiredArgs(t), [k]: v })), `${t.name}.${k}=${JSON.stringify(v)}`)
  }
  assert.strictEqual(calls.length, 0)
})

test('a bunker mode outside its enum is a tool error with no request', async () => {
  const { srv, calls } = mcpServer()
  assertOk(await call(srv, 'bunker', { mode: 'down' }))
  assert.strictEqual(calls.length, 1, 'control')
  calls.length = 0
  for (const mode of ['sideways', 'UP', 'toString', ['up'], null]) {
    assert.ok(isToolError(await call(srv, 'bunker', { mode })), `mode ${JSON.stringify(mode)}`)
  }
  assert.strictEqual(calls.length, 0, 'a request went out for a bad mode')
})

test('the goto tool sends only signed GETs to its own route on 127.0.0.1', async () => {
  const { srv, calls } = mcpServer()
  const t = toolNamed('goto')
  assertOk(await call(srv, t.name, requiredArgs(t)))
  assert.ok(calls.length >= 1, 'goto sent no request')
  for (const c of calls) {
    assert.strictEqual(c.method, 'GET')
    assert.strictEqual(c.url.protocol, 'http:')
    assert.strictEqual(c.url.host, `127.0.0.1:${PORT}`)
    assert.strictEqual(c.url.pathname, t.route)
    assertSigned(c, t.name)
    for (const k of c.url.searchParams.keys()) assert.ok(k in t.params, `goto sent ${k}`)
  }
})

// ---- JSON-RPC framing ----

test('a JSON-RPC batch array gets an error and issues no request', async () => {
  const { srv, calls } = mcpServer()
  await mcpChatControl(srv, calls)
  const r = await srv.handle([callReq(chatTool().name, { msg: 'hello' }), callReq(chatTool().name, { msg: 'again' })])
  assert.strictEqual(calls.length, 0)
  assert.ok(isRpcError(r), JSON.stringify(r).slice(0, 300))
})

test('a tools/call without an id issues no request and gets no result', async () => {
  const { srv, calls } = mcpServer()
  await mcpChatControl(srv, calls)
  const r = await srv.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: chatTool().name, arguments: { msg: 'hello' } } })
  assert.strictEqual(calls.length, 0)
  assert.ok(r == null || r.result === undefined, JSON.stringify(r).slice(0, 300))
})

test('a tools/call with an id of the wrong type gets an error and issues no request', async () => {
  const { srv, calls } = mcpServer()
  await mcpChatControl(srv, calls)
  for (const id of [{}, null]) {
    const r = await srv.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: chatTool().name, arguments: { msg: 'hello' } } })
    assert.ok(isRpcError(r), `id ${JSON.stringify(id)}: ${JSON.stringify(r).slice(0, 200)}`)
  }
  assert.strictEqual(calls.length, 0)
})

test('tools/call with non-object params gets an error and issues no request', async () => {
  const { srv, calls } = mcpServer()
  await mcpChatControl(srv, calls)
  for (const params of ['x', [chatTool().name, { msg: 'hello' }], null]) {
    assert.ok(isToolError(await rpc(srv, 'tools/call', params)), JSON.stringify(params))
  }
  assert.strictEqual(calls.length, 0)
})

test('a method name differing by case or naming a prototype key gets an error and issues no request', async () => {
  const { srv, calls } = mcpServer()
  await mcpChatControl(srv, calls)
  for (const method of ['TOOLS/CALL', 'toString']) {
    const r = await rpc(srv, method, { name: chatTool().name, arguments: { msg: 'hello' } })
    assert.ok(isRpcError(r), `${JSON.stringify(method)}: ${JSON.stringify(r).slice(0, 200)}`)
  }
  assert.strictEqual(calls.length, 0)
})

// ---- signed responses ----

const MARKER = 'FORGED-7731'
const markerReply = () => ({ ok: true, note: MARKER, place: 'T\u014dky\u014d' })

test('a reply with no proof reaches the pilot as a generic tool error', async () => {
  const good = mcpServer({ reply: markerReply })
  const ok = textOf(await call(good.srv, chatTool().name, { msg: 'hello' }))
  assert.ok(ok.includes(MARKER) && ok.includes('Tōkyō'), 'control: a reply with the correct proof reaches the pilot')
  const { srv, calls } = mcpServer({ reply: markerReply, prove: () => null })
  const r = await call(srv, chatTool().name, { msg: 'hello' })
  assert.strictEqual(calls.length, 1)
  assert.ok(isToolError(r), `accepted: ${JSON.stringify(r)}`)
  const out = JSON.stringify(r)
  assert.ok(!out.includes(MARKER), 'the unverified body reached the pilot')
  assert.ok(!out.includes(MCP_TOKEN), 'the token reached the pilot')
  assert.doesNotMatch(out, /\bat .+:\d+:\d+/, 'a stack trace reached the pilot')
})

test('the proof covers the exact body bytes, not the parsed JSON', async () => {
  const good = mcpServer({ reply: markerReply })
  assert.ok(textOf(await call(good.srv, chatTool().name, { msg: 'hello' })).includes(MARKER), 'control')
  const compact = (nonce, bytes) => proofOver(MCP_TOKEN, nonce, Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8'))), 'utf8'))
  const { srv } = mcpServer({ reply: markerReply, serialize: (v) => JSON.stringify(v, null, 2), prove: compact })
  const r = await call(srv, chatTool().name, { msg: 'hello' })
  assert.ok(isToolError(r), `accepted: ${JSON.stringify(r)}`)
  assert.ok(!JSON.stringify(r).includes(MARKER))
})

// ---- redaction ----

test('redaction replaces only the path token, up to the next whitespace or quote', () => {
  assert.strictEqual(redact('hello'), 'hello')
  assert.strictEqual(redact('saved to d:/tmp/shot.png now'), 'saved to <path> now')
  assert.strictEqual(redact('see C:/Users/x and "C:\\x" ok'), 'see <path> and "<path>" ok')
  assert.strictEqual(redact('share \\\\server\\share\\f.txt rest'), 'share <path> rest')
  assert.strictEqual(redact('https://x.example/a then C:/b'), 'https://x.example/a then <path>')
  assert.strictEqual(redact('https://x.y/C:/z ok'), 'https://x.y/<path> ok')
  assert.strictEqual(redact('https://minecraft.wiki/w/C ok'), 'https://minecraft.wiki/w/C ok')
})

test('redact removes drive paths not preceded by a letter or digit, long-path prefixes too', () => {
  assert.strictEqual(redact('hello'), 'hello')
  for (const s of ['_C:/Users/drv2', '\\\\?\\C:\\drv3\\x']) {
    const out = redact(s)
    assert.ok(!/drv\d/.test(out), `${JSON.stringify(s)} -> ${JSON.stringify(out)}`)
    assert.ok(out.includes('<path>'), JSON.stringify(out))
  }
})

test('a path in one waypoint note leaves the rest of the /waypoints graph intact', async () => {
  const tool = TOOLS.find((t) => t.route === '/waypoints')
  assert.ok(tool, 'a tool for /waypoints')
  const graph = 'home -> mine (12 blocks)\nmine note: see C:/Users/alice/x for nothing\nfarm -> home (30 blocks)'
  const { srv } = mcpServer({ reply: () => ({ ok: true, graph }) })
  const text = textOf(await call(srv, tool.name, requiredArgs(tool)))
  assert.ok(text.includes('home -> mine (12 blocks)'), text)
  assert.ok(text.includes('farm -> home (30 blocks)'), text)
  assert.ok(text.includes('<path>'), text)
  assert.ok(!text.includes('Users/alice'), text)
})

test('redact caps strings at 300 UTF-16 units and keeps the start', () => {
  assert.strictEqual(redact('a'.repeat(300)), 'a'.repeat(300))
  const out = redact('a'.repeat(1000))
  assert.ok(out.length <= 300, `${out.length} units`)
  assert.ok(out.startsWith('a'.repeat(200)))
})

test('redaction never grows a string past the 300-unit cap', () => {
  assert.strictEqual(redact('a'.repeat(300)), 'a'.repeat(300))
  const out = redact('C:/ '.repeat(75))
  assert.ok(out.length <= 300, `${out.length} units`)
})

test('redact walks nested values and leaves non-strings alone', () => {
  assert.deepStrictEqual(redact({ n: 5, b: true, z: null, s: 'ok' }), { n: 5, b: true, z: null, s: 'ok' })
  const out = redact({ a: { b: ['E:/x/y', 'fine'] }, c: 'b'.repeat(1000) })
  assert.deepStrictEqual(out.a.b, ['<path>', 'fine'])
  assert.ok(out.c.length <= 300)
})

test('redact caps and redacts object keys', () => {
  assert.deepStrictEqual(redact({ ok: 1 }), { ok: 1 })
  const out = JSON.stringify(redact({ 'C:/Users/alice/keyleak3': 1, ['k'.repeat(1000)]: 2, nested: { '\\\\srv4\\share': 3 } }))
  assert.ok(!out.includes('keyleak3'), out.slice(0, 200))
  assert.ok(!out.includes('srv4'), out.slice(0, 200))
  assert.ok(!out.includes('k'.repeat(301)))
})

test('a bot response with paths and a 1000-unit string reaches the pilot redacted and capped', async () => {
  const reply = () => ({
    ok: true,
    file: 'C:/Users/alice/x',
    share: '\\\\fileserver9\\share',
    nested: { deep: ['D:\\secret7\\y'] },
    long: 'a'.repeat(1000)
  })
  const { srv, calls } = mcpServer({ reply })
  const text = textOf(await call(srv, chatTool().name, { msg: 'hello' }))
  assert.strictEqual(calls.length, 1)
  assert.ok(text.includes('<path>'))
  assert.ok(!text.includes('Users/alice'))
  assert.ok(!text.includes('fileserver9'))
  assert.ok(!text.includes('secret7'))
  assert.ok(text.includes('a'.repeat(200)), 'the capped string still arrives')
  assert.ok(!text.includes('a'.repeat(301)))
})

// ---- structural fields and the whole-result cap ----

const resultUnits = (r) => r.result.content.reduce((n, c) => n + (typeof c.text === 'string' ? c.text.length : 0), 0)

test('the structural-field exemption is per tool: a non-structural tool caps every field at 300', async () => {
  const fields = ['graph', 'summary', 'grid', 'map', 'section', 'rows', 'scene', 'lines', 'text']
  const reply = () => Object.fromEntries([['ok', true], ...fields.map((f) => [f, f[0].repeat(5000)])])
  const { srv, calls } = mcpServer({ reply })
  const text = textOf(await call(srv, chatTool().name, { msg: 'hello' }))
  assert.strictEqual(calls.length, 1)
  for (const f of fields) assert.ok(!text.includes(f[0].repeat(301)), `${f} longer than 300 units`)
})

test('the /waypoints graph is capped at 4000 units', async () => {
  const wp = TOOLS.find((t) => t.route === '/waypoints')
  assert.ok(wp, 'a tool for /waypoints')
  const reply = () => ({ ok: true, count: 1, graph: 'g'.repeat(9000), names: ['n'.repeat(1000)] })
  const { srv, calls } = mcpServer({ reply })
  const text = textOf(await call(srv, wp.name, requiredArgs(wp)))
  assert.ok(calls.length >= 1)
  assert.ok(text.includes('g'.repeat(301)), 'control: the structural field keeps more than 300 units')
  assert.ok(!text.includes('g'.repeat(4001)), 'graph longer than 4000 units')
  assert.ok(!text.includes('n'.repeat(301)), 'a non-structural field of /waypoints longer than 300 units')
})

test('a whole tool result is capped at 32000 units', async () => {
  const shapes = [
    () => Object.fromEntries([['ok', true], ...Array.from({ length: 300 }, (_, i) => [`f${i}`, 'v'.repeat(299)])]),
    () => ({ ok: true, list: Array.from({ length: 1000 }, () => 'w'.repeat(300)) }),
    () => ({ ok: true, deep: Array.from({ length: 200 }, () => ({ a: 'x'.repeat(300), b: ['y'.repeat(300), 'z'.repeat(300)] })) })
  ]
  for (const reply of shapes) {
    const { srv } = mcpServer({ reply })
    const r = await call(srv, chatTool().name, { msg: 'hello' })
    assertOk(r)
    assert.ok(resultUnits(r) <= 32000, `${resultUnits(r)} units`)
  }
})

// ---- failing and hostile bot replies ----

test('a failing fetch reaches the pilot as a generic tool error without paths, stack or token', async () => {
  const ctl = mcpServer({ reply: () => ({ ok: false, error: 'no path found' }) })
  assert.ok(textOf(await call(ctl.srv, chatTool().name, { msg: 'hello' })).includes('no path found'), 'control: gameplay failures pass through')
  const { srv } = mcpServer({
    reply: () => {
      const e = new Error(`connect ECONNREFUSED 127.0.0.1:${PORT} C:\\Users\\alice\\secretdir7 x-golem-token=${MCP_TOKEN}`)
      e.stack = e.message + '\n    at fetchStage (C:\\Users\\alice\\src\\stackdir7\\mcp\\server.js:10:5)'
      throw e
    }
  })
  const r = await call(srv, chatTool().name, { msg: 'hello' })
  assert.ok(isToolError(r))
  const all = JSON.stringify(r)
  assert.ok(!all.includes('secretdir7'))
  assert.ok(!all.includes('stackdir7'))
  assert.ok(!all.includes(MCP_TOKEN))
  assert.ok(!all.includes('fetchStage'))
})

test('a 500 reply carrying a stack trace, as HTML or JSON, reaches the pilot without the trace', async () => {
  const html = '<!DOCTYPE html><html><body><pre>Error: boom<br> &nbsp; &nbsp;at Layer.handleRequest ' +
    '(C:\\Users\\alice\\src\\app\\node_modules\\router\\lib\\layer.js:152:17)</pre></body></html>'
  const fromHtml = mcpServer({ reply: () => rawReply(html, { status: 500, type: 'text/html; charset=utf-8' }) })
  const a = JSON.stringify(await call(fromHtml.srv, chatTool().name, { msg: 'hello' }))
  assert.ok(!a.includes('Layer.handleRequest'), a.slice(0, 300))
  assert.ok(!a.includes('node_modules'))
  const body = JSON.stringify({ ok: false, error: 'boom', stack: 'Error: boom\n    at handlerFrame9 (D:\\stackdir8\\bot.js:1:1)' })
  const fromJson = mcpServer({ reply: () => rawReply(body, { status: 500 }) })
  const b = JSON.stringify(await call(fromJson.srv, chatTool().name, { msg: 'hello' }))
  assert.ok(!b.includes('handlerFrame9'), b.slice(0, 300))
  assert.ok(!b.includes('stackdir8'))
})

test('a non-JSON 200 body never reaches the pilot', async () => {
  const { srv } = mcpServer({ reply: () => rawReply('C:/Users/alice/plainleak6 ' + 'p'.repeat(5000), { type: 'text/plain' }) })
  const all = JSON.stringify(await call(srv, chatTool().name, { msg: 'hello' }))
  assert.ok(!all.includes('plainleak6'))
  assert.ok(!all.includes('p'.repeat(10)))
})

// ---- request deadlines ----

const REQUEST_TIMEOUT = 200

test('a tool cut at its deadline answers a generic error that names state and stop and says the action may still be running', { timeout: 15000 }, async () => {
  assert.strictEqual(toolNamed('inventory').timeoutMs, undefined, 'inventory carries no timeoutMs')
  const ctl = mcpServer({ reply: async () => { await delay(50); return { ok: true, mark: 'REPLYOK' } }, requestTimeoutMs: REQUEST_TIMEOUT })
  assert.ok(textOf(await call(ctl.srv, 'inventory', {})).includes('REPLYOK'), 'control: a reply inside the deadline passes')

  const { srv, calls } = mcpServer({ reply: () => HUNG, requestTimeoutMs: REQUEST_TIMEOUT })
  const { out, ms } = await timed(call(srv, 'inventory', {}), 5000)
  assert.notStrictEqual(out, HUNG, 'still pending after 5000 ms')
  assert.strictEqual(calls.length, 1)
  assert.ok(isToolError(out), JSON.stringify(out).slice(0, 300))
  assert.ok(ms < REQUEST_TIMEOUT + 2000, `answered after ${ms} ms`)
  const text = errorText(out)
  assert.match(text, /\bstate\b/, `names state: ${text}`)
  assert.match(text, /\bstop\b/, `names stop: ${text}`)
  assert.match(text, /(may|might|could) still be (running|in progress|going)|still running/i, `says the action may still be running: ${text}`)
  const all = JSON.stringify(out)
  assert.ok(!all.includes(MCP_TOKEN), 'the error carries the token')
  assert.doesNotMatch(all, /\bat \S.*:\d+:\d+/, 'the error carries a stack frame')
  assert.doesNotMatch(all, /node:internal|\.js:\d+/, 'the error carries a source location')
})

test('a tool with timeoutMs is not cut at the request timeout', { timeout: 10000 }, async () => {
  const goto = toolNamed('goto')
  assert.ok(goto.timeoutMs > 3 * REQUEST_TIMEOUT, 'goto carries a timeoutMs above 3x the request timeout')
  const { srv, calls } = mcpServer({ reply: async () => { await delay(3 * REQUEST_TIMEOUT); return { ok: true, mark: 'REPLYOK' } }, requestTimeoutMs: REQUEST_TIMEOUT })
  const { out, ms } = await timed(call(srv, 'goto', { x: 1, y: 64, z: 1 }), 5000)
  assert.notStrictEqual(out, HUNG, 'the call was still pending after 5000 ms')
  assert.strictEqual(calls.length, 1)
  assert.ok(textOf(out).includes('REPLYOK'))
  assert.ok(ms >= 3 * REQUEST_TIMEOUT - 20, `answered after ${ms} ms, before the reply was sent`)
})

// ---- manual ----

const WATER = '# Water\n\nSurface before the bubbles run out, also in Tōkyō.\n'
const SECRET = 'SECRET-MARKER-42'

const manualTool = async (srv) => (await rpc(srv, 'tools/list', {})).result.tools.find((x) => x.name === 'manual')

function assertNoPath (r, dir) {
  const out = JSON.stringify(r)
  assert.ok(!out.includes(path.basename(path.dirname(dir))), out.slice(0, 300))
}

test('manual returns the whole topic file and sends no request', async (t) => {
  const { srv, calls } = mcpServer({ manualDir: manualFixture(t, { 'water.md': WATER }) })
  assert.strictEqual(textOf(await call(srv, 'manual', { topic: 'water' })), WATER)
  assert.strictEqual(calls.length, 0)
})

test('the manual topics are the lowercase .md file names of its dir, sorted, in the schema and the description', async (t) => {
  const dir = manualFixture(t, { 'water.md': WATER, 'legacy-1710.md': 'l', 'Upper.md': 'u', 'notes.txt': 'n' })
  const tool = await manualTool(mcpServer({ manualDir: dir }).srv)
  assert.ok(tool, 'manual missing from tools/list')
  assert.deepStrictEqual(tool.inputSchema.properties.topic.enum, ['legacy-1710', 'water'])
  assert.deepStrictEqual(tool.inputSchema.required, ['topic'])
  for (const topic of ['legacy-1710', 'water']) assert.ok(tool.description.includes(topic), topic)
})

test('manual refuses an unlisted topic, a case variant and a path, and reads nothing outside its dir', async (t) => {
  const dir = manualFixture(t, { 'water.md': WATER })
  fs.writeFileSync(path.join(path.dirname(dir), 'secret.md'), SECRET)
  const { srv, calls } = mcpServer({ manualDir: dir })
  assert.strictEqual(textOf(await call(srv, 'manual', { topic: 'water' })), WATER, 'control')
  for (const topic of ['nope', 'WATER', '../secret']) {
    const r = await call(srv, 'manual', { topic })
    assert.ok(isToolError(r), topic)
    assert.ok(!JSON.stringify(r).includes(SECRET), topic)
    assertNoPath(r, dir)
  }
  assert.strictEqual(calls.length, 0)
})

test('createServer refuses a manual dir with an oversize topic file and names the topic', (t) => {
  const dir = manualFixture(t, { 'water.md': WATER })
  assert.doesNotThrow(() => mcpServer({ manualDir: dir }), 'control')
  fs.writeFileSync(path.join(dir, 'huge.md'), 'o'.repeat(1 << 20))
  assert.throws(() => mcpServer({ manualDir: dir }), { name: 'TypeError', message: /\bhuge\b/ })
})

test('createServer refuses a manual dir with a hardlinked topic file and names the topic', (t) => {
  const dir = manualFixture(t, { 'water.md': WATER })
  assert.doesNotThrow(() => mcpServer({ manualDir: dir }), 'control')
  const outside = path.join(path.dirname(dir), 'secret.md')
  fs.writeFileSync(outside, SECRET)
  fs.linkSync(outside, path.join(dir, 'linked.md'))
  assert.throws(() => mcpServer({ manualDir: dir }), { name: 'TypeError', message: /\blinked\b/ })
})

test('manual serves each topic as it was at startup and no topic added later', async (t) => {
  const dir = manualFixture(t, { 'water.md': WATER })
  const { srv } = mcpServer({ manualDir: dir })
  fs.writeFileSync(path.join(dir, 'water.md'), SECRET)
  fs.writeFileSync(path.join(dir, 'late.md'), SECRET)
  assert.strictEqual(textOf(await call(srv, 'manual', { topic: 'water' })), WATER)
  assert.deepStrictEqual((await manualTool(srv)).inputSchema.properties.topic.enum, ['water'])
  const r = await call(srv, 'manual', { topic: 'late' })
  assert.ok(isToolError(r))
  assert.ok(!JSON.stringify(r).includes(SECRET))
})

// ---- the port and the stdio entry point ----

test('createServer refuses a port outside 1024-65535 or not an integer', () => {
  const opts = (port) => ({ port, token: MCP_TOKEN, fetch: async () => {} })
  for (const port of [1024, 65535]) assert.doesNotThrow(() => createServer(opts(port)), `control: ${port}`)
  for (const port of [1023, 65536, PORT + 0.5, String(PORT)]) assert.throws(() => createServer(opts(port)), TypeError, String(port))
})


test('the entry point serves initialize with GOLEM_TOKEN in env and exits non-zero without it, even with a token in argv', { timeout: 30000 }, async (t) => {
  await assertEntryServes(t, PORT)
  await assertEntryRefuses(t, [String(PORT)], baseEnv())
  await assertEntryRefuses(t, [String(PORT), MCP_TOKEN], baseEnv())
})

test('onToolCall gets the tool name and the sorted names of its params the call passed, never their values', async () => {
  const seen = []
  const srv = createServer({ port: PORT, token: MCP_TOKEN, fetch: fakeBot().fetch, onToolCall: (name, used) => seen.push([name, used]) })
  await call(srv, 'chat', { msg: 'meet me at the old well' })
  await call(srv, 'goto', { z: 5, x: 1, range: 2 })
  await call(srv, 'scene', { nonsense: 'say this' })
  await call(srv, 'no_such_tool', { msg: 'hi' })
  await call(srv, 'chat', ['msg'])
  assert.deepStrictEqual(seen, [['chat', ['msg']], ['goto', ['range', 'x', 'z']], ['scene', []], [null, []], ['chat', []]])
})

test('the wake log names each called tool and its passed params and holds no argument text', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-wake-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'mcp-wakes.log')
  const e = runEntry(t, [String(PORT), log], { ...baseEnv(), GOLEM_TOKEN: MCP_TOKEN })
  const calls = [callReq('papercut', { text: 'secret papercut words' }), callReq('manual', { topic: 'chat', extra: 'hidden chat words' }), callReq('nope', {})]
  for (const req of calls) e.child.stdin.write(JSON.stringify(req) + '\n')
  for (const req of calls) assert.ok(await e.response(req.id, 8000), `no reply to ${req.params.name}`)
  e.child.kill()
  await e.exited
  assert.strictEqual(fs.readFileSync(log, 'utf8'), 'tool call papercut text\ntool call manual topic\ntool call (unknown)\n')
})
