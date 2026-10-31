'use strict'
// Requiring bot.js connects to a server.
const assert = require('node:assert')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const vm = require('node:vm')
const { performance } = require('node:perf_hooks')
const express = require('express')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const shelter = require('../lib/shelter')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { createLane, bindLane } = require('../lib/bot/lane')
const { installSecurity } = require('../lib/install')
const { countVerbs } = require('../lib/verbs')
const { createApp } = require('../lib/app')
const { createServer } = require('../mcp/server')
const { TOOLS } = require('../mcp/tools')
const { createConnection, bindConnection, wireConnectionSpawn } = require('../lib/bot/connection')

const ROOT = path.join(__dirname, '..')
const ALLOW = ['me', 'tell', 'msg', 'w']
const UNAUTHORIZED = { ok: false, error: 'unauthorized' }
const UNAUTHORIZED_BODY = JSON.stringify(UNAUTHORIZED)
const ILLEGAL = /[\u0000-\u001f\u007f§]/
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const HUNG = Symbol('hung')

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex')
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const newNonce = () => crypto.randomBytes(16).toString('hex')
const otherKey = (token) => token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor (cond, ms) {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await delay(5)
  return cond()
}

// A clock whose timers run only in advance(ms), in time order.
function fakeClock () {
  let t = 0
  let seq = 0
  const timers = new Map()
  const add = (fn, ms, every) => {
    timers.set(++seq, { fn, at: t + ms, every: every ? ms : 0 })
    return seq
  }
  return {
    now: () => t,
    setInterval: (fn, ms) => add(fn, ms, true),
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearInterval: (id) => timers.delete(id),
    clearTimeout: (id) => timers.delete(id),
    pending: () => timers.size,
    advance (ms) {
      const end = t + ms
      for (;;) {
        let next = null
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x]
        if (!next) break
        const [id, x] = next
        t = x.at
        if (x.every) x.at += x.every
        else timers.delete(id)
        x.fn()
      }
      t = end
    }
  }
}

async function timed (promise, ms) {
  let timer
  const t0 = Date.now()
  const out = await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(HUNG), ms) })])
  clearTimeout(timer)
  return { out, ms: Date.now() - t0 }
}

// ---- outbound chat ----

const stripLead = (s) => s.replace(/^[\u0000- ]+/, '')

function serverCommand (chunk) {
  const s = stripLead(chunk).replace(/[\t\n\u000b\f\r ]+/g, ' ')
  return s.startsWith('/') ? s.slice(1).split(' ')[0].toLowerCase() : null
}

// The command a chunk reads as when Unicode whitespace and format characters count as leading too.
function strictCommand (chunk) {
  const s = chunk.replace(/^[\u0000- \s\p{Cf}]+/u, '')
  return s.startsWith('/') ? s.slice(1).split(/[\s\p{Cf}]/u)[0].toLowerCase() : null
}

function assertNoForeignCommand (chunks) {
  for (const c of chunks) {
    for (const w of [serverCommand(c), strictCommand(c)]) {
      if (w !== null) assert.ok(ALLOW.includes(w), `chunk ${JSON.stringify(c)} runs /${w}`)
    }
  }
}

function assertSafeChunks (chunks, maxLen) {
  for (const c of chunks) {
    assert.strictEqual(typeof c, 'string')
    assert.ok(c.length > 0, 'empty chunk')
    assert.ok(c.length <= maxLen, `chunk of ${c.length} units exceeds ${maxLen}`)
    assert.doesNotMatch(c, ILLEGAL)
    assert.doesNotMatch(c, LONE_SURROGATE)
  }
}

// sign changes only the signed fields, headers the sent ones (null drops one, an array repeats it).
function guardRequest ({ token, port, method = 'GET', url = '/state', time, nonce = newNonce(), sign = {}, headers = {} }) {
  const s = { token, method, url, time, nonce, ...sign }
  const fields = {
    host: `127.0.0.1:${port}`,
    'x-golem-time': time,
    'x-golem-nonce': nonce,
    'x-golem-sig': hmac(s.token, `${s.method}\n${s.url}\n${s.time}\n${s.nonce}`),
    ...headers
  }
  const h = {}
  const headersDistinct = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    const list = Array.isArray(v) ? v : [v]
    headersDistinct[k] = list
    h[k] = k === 'host' ? list[0] : list.join(', ')
  }
  return { method, url, headers: h, headersDistinct }
}

// ---- installSecurity on a fresh Express app ----

// Recording handlers stand in for bot.js's own routes.
const DUMMY_ROUTES = [
  '/state', '/tick', '/chatlog', '/walls', '/outline', '/roof', '/build', '/find', '/mine', '/collect', '/craft',
  '/smelt', '/furnace', '/chest', '/withdraw', '/deposit', '/gather', '/toss', '/goto', '/follow',
  '/waypoint', '/waypoints', '/snapshot', '/record', '/stream', '/pov', '/sign', '/rename', '/bunker',
  '/strike', '/shoot', '/brace', '/hold', '/pillar', '/pathdebug', '/threatdebug', '/journal', '/lookat', '/stance', '/gaze',
  '/scene', '/section', '/passages', '/map', '/entities', '/listen', '/blockat', '/pulse', '/events', '/bridging', '/tidy',
  '/dig_tunnel', '/dig_stair', '/digat', '/enchant', '/placeitem', '/equip', '/activate', '/use', '/fish', '/reflexes',
  '/gesture', '/job', '/job_stop', '/guard', '/where', '/place', '/eat', '/useon', '/grave'
]

function parseResponse (buf) {
  const sep = buf.indexOf('\r\n\r\n')
  if (sep < 0) return { status: 0, headers: '', body: '', bytes: Buffer.alloc(0), json: undefined, proofs: [] }
  const head = buf.subarray(0, sep).toString('latin1')
  const proofs = head.split('\r\n').slice(1).filter((l) => /^x-golem-proof:/i.test(l)).map((l) => l.slice(l.indexOf(':') + 1).trim())
  let body = buf.subarray(sep + 4)
  if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
    const parts = []
    let i = 0
    while (i < body.length) {
      const nl = body.indexOf('\r\n', i)
      const size = parseInt(body.subarray(i, nl).toString('latin1'), 16)
      if (!size) break
      parts.push(body.subarray(nl + 2, nl + 2 + size))
      i = nl + 2 + size + 2
    }
    body = Buffer.concat(parts)
  }
  const text = body.toString('utf8')
  let json
  try { json = JSON.parse(text) } catch {}
  return { status: parseInt(head.split(' ')[1], 10), headers: head, body: text, bytes: body, json, proofs }
}

function rawRequest (port, lines) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const sock = net.connect(port, '127.0.0.1', () => sock.write(lines.join('\r\n') + '\r\n\r\n'))
    sock.on('data', (d) => chunks.push(d))
    sock.on('end', () => resolve(parseResponse(Buffer.concat(chunks))))
    sock.on('error', reject)
  })
}

async function startApp (t, { gapMs = 30, maxDepth = 20, maxLen = 100, token = crypto.randomBytes(32).toString('hex'), bootMs, nonceMax, createApp: viaCreateApp = false } = {}) {
  if (viaCreateApp && (bootMs !== undefined || nonceMax !== undefined)) throw new TypeError('startApp: createApp takes no bootMs or nonceMax')
  const sends = []
  const hits = []
  const onRequests = []
  let app = viaCreateApp ? null : express()
  const server = viaCreateApp ? http.createServer() : http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  // The chat queue sleeps only while it holds unsent lines.
  let sleeping = 0
  const sleep = (ms) => {
    sleeping++
    return new Promise((resolve) => setTimeout(() => { sleeping--; resolve() }, ms))
  }
  const send = (text) => { sends.push({ text, t: performance.now() }) }
  const chat = { send, sleep, maxLen, gapMs, allow: ALLOW, maxDepth }
  const opts = { token, port, chat }
  if (bootMs !== undefined) opts.bootMs = bootMs
  if (nonceMax !== undefined) opts.nonceMax = nonceMax
  const installedAt = Date.now()
  let verbs
  if (viaCreateApp) {
    ({ app, verbs } = createApp({ token, port, chat, onRequest: (res) => { onRequests.push(res) } }))
    server.on('request', app)
  } else installSecurity(app, opts)
  for (const route of DUMMY_ROUTES) {
    app.get(route, (req, res) => {
      hits.push({ route, url: req.url, query: { ...req.query } })
      res.json({ ok: true, route })
    })
  }

  // signPath, signMethod and key change only what the signature covers.
  function get (target, { signed = true, host, time = String(Date.now()), nonce = newNonce(), signPath = target, signMethod = 'GET', key = token, headers: extra = {} } = {}) {
    return new Promise((resolve, reject) => {
      const headers = {}
      if (signed) {
        headers['X-Golem-Time'] = time
        headers['X-Golem-Nonce'] = nonce
        headers['X-Golem-Sig'] = hmac(key, `${signMethod}\n${signPath}\n${time}\n${nonce}`)
      }
      if (host !== undefined) headers.Host = host
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) delete headers[k]
        else headers[k] = v
      }
      const req = http.request({ host: '127.0.0.1', port, path: target, method: 'GET', headers, agent: false }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          const body = raw.toString('utf8')
          let json
          try { json = JSON.parse(body) } catch {}
          const proofs = res.headersDistinct['x-golem-proof'] || []
          resolve({ status: res.statusCode, body, json, raw, nonce, proof: res.headers['x-golem-proof'], proofs })
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  // A null host or key leaves out the Host line or the signing headers.
  function build (target, { key = token, host = `127.0.0.1:${port}`, method = 'GET', headers = [], time = String(Date.now()),
    nonce = newNonce(), sig, signMethod = method, signPath = target } = {}) {
    const lines = [`${method} ${target} HTTP/1.1`]
    if (host !== null) lines.push(`Host: ${host}`)
    if (key !== null) {
      const s = sig !== undefined ? sig : hmac(key, `${signMethod}\n${signPath}\n${time}\n${nonce}`)
      lines.push(`X-Golem-Time: ${time}`, `X-Golem-Nonce: ${nonce}`, `X-Golem-Sig: ${s}`)
    }
    lines.push(...headers, 'Connection: close')
    return { lines, nonce }
  }
  const sendRaw = (lines) => rawRequest(port, lines)
  async function wire (target, opts) {
    const { lines, nonce } = build(target, opts)
    return { ...(await sendRaw(lines)), lines, nonce }
  }

  const routeHits = (route) => hits.filter((h) => h.route === route)
  const texts = () => sends.map((s) => s.text)
  async function drained () {
    assert.ok(await waitFor(() => sleeping === 0, 5000), 'the chat queue never drained')
  }
  return { token, port, sends, texts, hits, routeHits, get, build, send: sendRaw, wire, drained, gapMs, installedAt, verbs, onRequests }
}

async function stateControl (s) {
  const r = await s.get('/state')
  assert.strictEqual(r.status, 200, 'control: a signed request must succeed')
  assert.strictEqual(s.routeHits('/state').length, 1)
}

async function chatControl (s) {
  const r = await s.get('/chat?msg=hello')
  assert.strictEqual(r.status, 200, 'control: /chat?msg=hello')
  await s.drained()
  assert.deepStrictEqual(s.texts(), ['hello'])
}

// Shows which route plain Express, without installSecurity, gives each path.
function referenceApp (t) {
  const hits = []
  const app = express()
  for (const route of [...DUMMY_ROUTES, '/chat']) {
    app.get(route, (req, res) => { hits.push(route); res.json({ ok: true }) })
  }
  const server = http.createServer(app)
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  async function reaches (target, route) {
    await ready
    const port = server.address().port
    const before = hits.filter((h) => h === route).length
    await rawRequest(port, [`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'])
    return hits.filter((h) => h === route).length > before
  }
  return { reaches }
}

const proofOver = (token, nonce, bytes) => hmac(token, `${nonce}\n${sha256(bytes)}`)

// ---- the MCP server over a fake bot ----

const PORT = 3000
const MCP_TOKEN = 'k'.repeat(24) + 'Q9zTOKENm4rk3r' + 'k'.repeat(26)
const RAW = Symbol('raw')

// proof(nonce, bytes) gives the X-Golem-Proof value, null for none.
const rawReply = (body, { status = 200, type = 'application/json', proof } = {}) => ({ [RAW]: true, body, status, type, proof })

// The /tick reply of proc ({ boot, chat, events }) after the request's cursors.
function tickFrom (proc, url) {
  const chat = Number(url.searchParams.get('chat') || 0)
  const ev = Number(url.searchParams.get('ev') || 0)
  return {
    ok: true,
    boot: proc.boot,
    chat: { cursor: proc.chat.length, messages: proc.chat.filter((m) => m.id > chat) },
    events: { cursor: proc.events.length, list: proc.events.filter((e) => e.id > ev) },
    threats: [],
    jobs: []
  }
}

const tickReply = (messages, events = []) => (url) => (url.pathname === '/tick' ? tickFrom({ chat: messages, events }, url) : { ok: true, route: url.pathname })

const chatLine = (id, msg) => ({ id, t: id, from: 'Alice', msg, kind: 'chat' })
const eventLine = (id, msg) => ({ id, t: id, kind: 'note', msg })

function botProcess (boot, tag, chats, events) {
  const pad = (i) => String(i + 1).padStart(3, '0')
  return {
    boot,
    chat: Array.from({ length: chats }, (_, i) => chatLine(i + 1, `${tag}-chat-${pad(i)}`)),
    events: Array.from({ length: events }, (_, i) => eventLine(i + 1, `${tag}-ev-${pad(i)}`))
  }
}

const tickOf = (holder) => (url) => (url.pathname === '/tick' ? tickFrom(holder.current, url) : { ok: true })

const missing = (text, lines) => lines.filter((l) => !text.includes(l.msg)).map((l) => l.msg)

// reply(url) gives a JSON value, a rawReply, HUNG or a promise of one of them.
function fakeBot ({ token = MCP_TOKEN, reply = tickReply([chatLine(1, 'hi there')]), prove = (nonce, bytes) => proofOver(token, nonce, bytes), serialize = JSON.stringify } = {}) {
  const calls = []
  async function fetch (input, init = {}) {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    const method = init.method || 'GET'
    const time = headers.get('x-golem-time')
    const nonce = headers.get('x-golem-nonce')
    const sig = headers.get('x-golem-sig')
    const sigOk = sig !== null && sig === hmac(token, `${method}\n${url.pathname}${url.search}\n${time}\n${nonce}`)
    calls.push({ url, method, headers: [...headers.entries()], time, nonce, sig, sigOk, at: Date.now() })
    // One macrotask per reply lets timers run under a tight polling loop.
    await new Promise((resolve) => setImmediate(resolve))
    if (!sigOk) return new Response(UNAUTHORIZED_BODY, { status: 401, headers: { 'content-type': 'application/json' } })
    const out = await reply(url)
    if (out === HUNG) return new Promise(() => {})
    const r = out && out[RAW] ? out : rawReply(serialize(out), { proof: prove })
    const bytes = Buffer.from(r.body, 'utf8')
    const h = { 'content-type': r.type }
    const p = (r.proof || ((n, b) => proofOver(token, n, b)))(nonce, bytes)
    if (p !== null && p !== undefined) h['x-golem-proof'] = p
    return new Response(bytes, { status: r.status, headers: h })
  }
  return { fetch, calls }
}

function mcpServer ({ reply, prove, serialize, manualDir, requestTimeoutMs, ...rest } = {}) {
  const f = fakeBot({ reply, prove, serialize })
  const opts = { ...rest, port: PORT, token: MCP_TOKEN, fetch: f.fetch }
  if (manualDir !== undefined) opts.manualDir = manualDir
  if (requestTimeoutMs !== undefined) opts.requestTimeoutMs = requestTimeoutMs
  return { srv: createServer(opts), calls: f.calls }
}

function manualFixture (t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-manual-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'manual')
  fs.mkdirSync(dir)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}

let nextId = 1
const callReq = (name, args) => ({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })
const call = (srv, name, args) => srv.handle(callReq(name, args))
const rpc = (srv, method, params) => srv.handle({ jsonrpc: '2.0', id: nextId++, method, params })
const isToolError = (r) => !!r && (r.error != null || (r.result != null && r.result.isError === true))
const isRpcError = (r) => (!!r && r.error != null) || (Array.isArray(r) && r.length > 0 && r.every((x) => x && x.error != null))

function assertOk (r) {
  assert.ok(r && r.result && r.error == null, `expected a result, got ${JSON.stringify(r).slice(0, 300)}`)
  assert.notStrictEqual(r.result.isError, true, `tool error: ${JSON.stringify(r.result).slice(0, 300)}`)
}

function textOf (r) {
  assertOk(r)
  assert.ok(Array.isArray(r.result.content))
  return r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}

function errorText (r) {
  if (r.error != null) return [r.error.message, JSON.stringify(r.error.data ?? '')].join('\n')
  return r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}

const LOCAL_TOOLS = ['wait_events', 'note', 'todo', 'manual']
const routedTools = () => TOOLS.filter((t) => t.route != null && !LOCAL_TOOLS.includes(t.name))

function validValue (spec) {
  switch (spec.type) {
    case 'int': return Math.max(1, Math.ceil(spec.min ?? 1))
    case 'num': return Math.max(1, spec.min ?? 1)
    case 'str': return 'a'
    case 'bool': return true
    case 'enum': return spec.values[0]
    default: throw new Error('unknown param type ' + spec.type)
  }
}

function requiredArgs (tool) {
  const args = {}
  for (const [k, spec] of Object.entries(tool.params || {})) if (spec.required) args[k] = validValue(spec)
  return args
}

const toolNamed = (name) => {
  const found = TOOLS.find((x) => x.name === name)
  assert.ok(found, `${name} in TOOLS`)
  return found
}

const chatTool = () => {
  const t = TOOLS.find((x) => x.route === '/chat' && x.params && x.params.msg)
  assert.ok(t, 'a tool for /chat with a msg param')
  return t
}

function paramsOfType (type) {
  const out = []
  for (const t of routedTools()) {
    for (const [k, spec] of Object.entries(t.params || {})) if (spec.type === type) out.push([t, k, spec])
  }
  return out
}

async function mcpChatControl (srv, calls) {
  assertOk(await call(srv, chatTool().name, { msg: 'hello' }))
  assert.strictEqual(calls.length, 1)
  calls.length = 0
}

function assertSigned (c, label = '') {
  assert.match(String(c.nonce), /^[0-9a-f]{32}$/, `${label} nonce ${c.nonce}`)
  assert.match(String(c.time), /^[0-9]+$/, `${label} time ${c.time}`)
  assert.ok(Math.abs(Number(c.time) - c.at) <= 5000, `${label} time ${c.time} is not the current Unix ms`)
  assert.ok(c.sigOk, `${label} X-Golem-Sig does not match ${c.method} ${c.url.pathname}${c.url.search}`)
  for (const [k, v] of c.headers) {
    assert.notStrictEqual(k, 'x-golem-token', label)
    assert.ok(!v.includes(MCP_TOKEN), `${label} header ${k} carries the token`)
  }
  assert.ok(!c.url.href.includes(MCP_TOKEN), `${label} URL carries the token`)
}

// ---- the MCP server's stdio entry point ----

const SERVER_JS = path.join(ROOT, 'mcp', 'server.js')
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }

function baseEnv () {
  const env = {}
  for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[k] !== undefined) env[k] = process.env[k]
  return env
}

function runEntry (t, args, env) {
  const child = spawn(process.execPath, [SERVER_JS, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => { out += d })
  child.stderr.resume()
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  async function response (id, ms) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      for (const line of out.split('\n')) {
        try {
          const msg = JSON.parse(line)
          if (msg && msg.id === id) return msg
        } catch {}
      }
      if (child.exitCode !== null) return null
      await delay(20)
    }
    return null
  }
  return { child, exited, response }
}

async function assertEntryServes (t, port) {
  const e = runEntry(t, [String(port)], { ...baseEnv(), GOLEM_TOKEN: MCP_TOKEN })
  e.child.stdin.write(JSON.stringify(INIT) + '\n')
  const r = await e.response(1, 8000)
  assert.ok(r && r.result, `port ${port}: no initialize result`)
  e.child.kill()
}

async function assertEntryRefuses (t, args, env) {
  const e = runEntry(t, args, env)
  const { out: code } = await timed(e.exited, 8000)
  assert.notStrictEqual(code, HUNG, `${args.join(' ')} kept running`)
  assert.ok(typeof code === 'number' && code !== 0, `${args.join(' ')} exited with ${code}`)
}

// ---- bot.js source ----

let botSrc
function botSource () {
  if (botSrc !== undefined) return botSrc
  const files = [path.join(ROOT, 'bot.js')]
  for (const dir of ['lib/bot', 'lib/routes'].map((d) => path.join(ROOT, d))) {
    if (!fs.existsSync(dir)) continue
    files.push(...fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(dir, f)))
  }
  botSrc = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  return botSrc
}

// The dedented bodies of the wire* pieces in the order wireEarly, then wireRuntime, calls them.
function wiredSource () {
  const src = botSource()
  const body = (name) => {
    const m = new RegExp(`^function ${name} \\(\\) \\{\\r?\\n([\\s\\S]*?)^\\}\\r?$`, 'm').exec(src)
    if (!m) throw new Error(`no bot source declares function ${name} ()`)
    return m[1]
  }
  return ['wireEarly', 'wireRuntime'].flatMap((table) => body(table).split(/\r?\n/).filter(Boolean).map((line) => {
    const call = /^ {2}(wire[A-Z][\w$]*)\(\)$/.exec(line)
    if (!call) throw new Error(`${table} line is no wire* call: ${line}`)
    return body(call[1]).replace(/^ {2}/gm, '')
  })).join('')
}

const NOT_CALLEES = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'void',
  'delete', 'await', 'async', 'new', 'in', 'of', 'instanceof', 'throw', 'case', 'yield', 'super', 'import', 'else', 'do',
  'require'])
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'new', 'else', 'do',
  'yield', 'await', 'instanceof'])

// src with comments, string and regex literals and template text blanked to spaces, newlines and offsets kept.
function codeOnly (src) {
  const out = src.split('')
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  const regexAt = (i) => {
    let k = i - 1
    while (k >= 0 && /\s/.test(out[k])) k--
    if (k < 0) return true
    if (!/[\w$]/.test(out[k])) return !/[)\]'"`]/.test(out[k])
    const word = /[\w$]+$/.exec(out.slice(Math.max(0, k - 11), k + 1).join(''))[0]
    return REGEX_AFTER.has(word)
  }
  const holes = []
  let depth = 0
  let i = 0
  const template = () => {
    const from = i
    while (i < src.length && src[i] !== '`' && !(src[i] === '$' && src[i + 1] === '{')) i += src[i] === '\\' ? 2 : 1
    blank(from, Math.min(i, src.length))
    if (src[i] === '$') {
      holes.push(depth++)
      i += 2
    } else i++
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 2
      const to = end < 2 ? src.length : end
      blank(i, to)
      i = to
    } else if (c === "'" || c === '"' || (c === '/' && regexAt(i))) {
      let j = i + 1
      let cls = false
      while (j < src.length && src[j] !== '\n' && (cls || src[j] !== c)) {
        if (src[j] === '\\') j++
        else if (c === '/' && src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        j++
      }
      blank(i + 1, Math.min(j, src.length))
      i = j + 1
    } else if (c === '`') {
      i++
      template()
    } else if (c === '}' && holes.length && holes[holes.length - 1] === depth - 1) {
      holes.pop()
      depth--
      i++
      template()
    } else {
      if (c === '{') depth++
      else if (c === '}') depth--
      i++
    }
  }
  return out.join('')
}

// Every identifier in a parameter list or destructuring pattern, keys and default-value references included.
function patternNames (text) {
  return [...text.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0])
}

// Every `name (` in code with its parenthesised group, and whether a body follows the group.
function* parenNames (code) {
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const group = balanced(code, open, '(')
    yield { name: m[1], params: group, definition: /^\s*(?:\{|=>)/.test(code.slice(open + group.length)) }
  }
}

let topNames
// Every name a bot source declares in column 0.
function topLevelNames () {
  if (topNames) return topNames
  const src = codeOnly(botSource())
  topNames = new Set()
  for (const m of src.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)/gm)) topNames.add(m[1] || m[2])
  for (const m of src.matchAll(/^(?:const|let|var)\s*([{[])/gm)) {
    const pattern = balanced(src, m.index, m[1]).slice(1, -1)
    // Keys of a { key: name } pattern count as declared too.
    for (const n of patternNames(pattern)) topNames.add(n)
  }
  for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)(.*)$/gm)) {
    topNames.add(m[1])
    let depth = 0
    for (const [k, c] of [...m[2]].entries()) {
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) depth--
      else if (c === ',' && depth === 0) {
        const next = /^\s*([A-Za-z_$][\w$]*)/.exec(m[2].slice(k + 1))
        if (next) topNames.add(next[1])
      }
    }
  }
  return topNames
}

// Names code binds itself: declarations, parameters, catch bindings, assignment targets and its own functions and methods.
function localNames (code) {
  const names = new Set()
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s*([{[])/g)) patternNames(balanced(code, m.index, m[1])).forEach((n) => names.add(n))
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:=(?![=>])|=>)/g)) names.add(m[1])
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) patternNames(m[1]).forEach((n) => names.add(n))
  for (const p of parenNames(code)) {
    if (!p.definition || ['if', 'for', 'while', 'switch', 'with'].includes(p.name)) continue
    if (!NOT_CALLEES.has(p.name)) names.add(p.name)
    patternNames(p.params).forEach((n) => names.add(n))
  }
  return names
}

// The source of the top-level bot.js function `name`, up to the first `}` in column 0.
function functionSource (name) {
  const src = botSource()
  const m = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(|^(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`, 'm').exec(src)
  if (!m) return ''
  const end = src.indexOf('\n}', m.index)
  return src.slice(m.index, end < 0 ? src.length : end + 2)
}

// Skips comments and '- or "-quoted strings, not template literals.
function balanced (text, from, open = '{') {
  const close = open === '{' ? '}' : ')'
  const start = text.indexOf(open, from)
  if (from < 0 || start < 0) return ''
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i < 0) return ''
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
      if (i <= 0) return ''
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      i = j
    } else if (c === open) depth++
    else if (c === close && --depth === 0) return text.slice(start, i + 1)
  }
  return ''
}

function botConstant (name) {
  const m = new RegExp(`^const ${name} = (.+)$`, 'm').exec(botSource())
  assert.ok(m, `const ${name} not found in bot.js`)
  return vm.runInNewContext(`(${m[1]})`)
}

// A fresh copy of the object literal bot.js declares as const name, its methods run over env.
function botObject (name, env) {
  const src = botSource()
  const at = src.search(new RegExp(`^const ${name} = \\{`, 'm'))
  const literal = at < 0 ? '' : balanced(src, at)
  assert.ok(literal, `const ${name} not found in bot.js`)
  return vm.runInContext(`(${literal})`, vm.createContext(env))
}

// An empty ground-top memory and its limits as bot.js keeps them.
function groundMemory () {
  return { GROUND_TOP: new Map(), GROUND_SPAN: botConstant('GROUND_SPAN'), SURFACE_DEPTH: botConstant('SURFACE_DEPTH') }
}

// A body at pos on the real pathfinder with the walk's legs, over a stone floor plus cells ('x,y,z' -> [name, properties]).
async function walkingBody (t, pos, cells = {}) {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.write = () => {}
  client.end = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  bot.loadPlugin(pathfinder)
  await once(bot, 'inject_allowed')
  const Block = require('prismarine-block')(bot.registry)
  Object.assign(bot, {
    version: '1.21.11',
    entity: { position: pos, velocity: new Vec3(0, 0, 0), width: 0.6, height: 1.8, onGround: true },
    entities: {},
    game: { minY: -64, height: 384, dimension: 'overworld' },
    inventory: { items: () => [] },
    clearControlStates () {},
    async placeBlock () {},
    blockAt (p) {
      const c = p.floored()
      const [name, props] = cells[`${c.x},${c.y},${c.z}`] || [c.y <= 63 ? 'stone' : 'air', {}]
      const b = Block.fromProperties(name, props, 0)
      b.position = c
      return b
    }
  })
  const ctx = { bot, knownMoves: (m) => m, navPlaced: [], startReflexes () {}, vecStr: (p) => `${p.x},${p.y},${p.z}` }
  createConnection(ctx)
  bindConnection(ctx)
  wireConnectionSpawn()
  // Keeps the spawn's mob scan interval from ever running.
  t.mock.timers.enable({ apis: ['setInterval'] })
  bot.emit('spawn')
  t.mock.timers.reset()
  // The default 40 ms tick ends in 'partial' on a loaded machine.
  const plan = (goal, moves = bot.pathfinder.movements) => {
    bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
    return bot.pathfinder.getPathFromTo(moves, bot.entity.position, goal).next().value.result
  }
  return { bot, plan, shared: ctx.shared }
}

let freeNames
function sourceNames () {
  freeNames ??= new Set([...codeOnly(botSource()).matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)].map((m) => m[0]))
  return freeNames
}

// Loads names and every bot.js function they or code (run later in the returned context) reach over env, failing on
// unknown callees and unused env keys.
function loadBotFunctions (names, env, code = '') {
  for (const key of Object.keys(env)) assert.ok(sourceNames().has(key), `env key ${key} occurs in no bot source`)
  const ctx = vm.createContext(env)
  const declared = topLevelNames()
  const loaded = new Set()
  const sources = []
  const reach = (body, caller) => {
    const text = codeOnly(body)
    const locals = localNames(text)
    for (const { name, definition } of parenNames(text)) {
      if (declared.has(name)) visit(name)
      else if (!(definition || name in env || locals.has(name) || NOT_CALLEES.has(name) || name in globalThis)) assert.fail(`${caller} calls ${name}, which no bot source declares`)
    }
  }
  const visit = (name) => {
    if (loaded.has(name) || name in env) return
    loaded.add(name)
    const body = functionSource(name)
    if (!/^(?:async\s+)?function\b/.test(body)) return
    // Unless env has its own, fleeWorld sees every cell now.
    if (name === 'fleeWorld') {
      env.OPENABLE ??= botConstant('OPENABLE')
      env.seenNow ??= () => true
      env.seesShape ??= () => true
    }
    // Unless env has its own, soleClaim reads a free dig lock.
    if (name === 'soleClaim') env.digLock ??= botConstant('digLock')
    sources.push(body)
    reach(body, name)
  }
  for (const name of names) {
    assert.ok(functionSource(name), `${name} not found in bot.js`)
    visit(name)
  }
  reach(code, 'the caller')
  vm.runInContext(sources.join('\n'), ctx)
  return ctx
}

// The bot.js GET handler for route, run over env with the bot.js functions it reaches, and its res.
function routeHandler (route, env) {
  const src = botSource()
  const at = src.indexOf(`app.get('${route}'`)
  const arrow = src.indexOf('=>', at)
  const handler = at < 0 ? '' : balanced(src, arrow)
  assert.ok(handler, `the ${route} handler not found in bot.js`)
  const async = /\basync\b/.test(src.slice(at, arrow)) ? 'async ' : ''
  const code = `(${async}(req, res) => ${handler})`
  const ctx = loadBotFunctions([], { ok: (res, body) => { res.body = body }, err: (res, e) => { res.error = e }, OPENABLE: botConstant('OPENABLE'), ...env }, code)
  // Module code has Node's Buffer, a vm context does not.
  ctx.Buffer ??= Buffer
  return { handle: vm.runInContext(code, ctx), res: {} }
}

// An fs over one file holding text, null for a missing one. bytesRead() counts the bytes it handed out.
function fakeFile (text) {
  const data = text === null ? null : Buffer.from(text, 'utf8')
  let bytes = 0
  let cursor = 0
  const exists = () => {
    if (!data) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  }
  const fs = {
    statSync () { exists(); return { size: data.length, isFile: () => true } },
    openSync () { exists(); cursor = 0; return 7 },
    readSync (fd, buf, a, b, c) {
      exists()
      const opts = a !== null && typeof a === 'object' ? a : { offset: a, length: b, position: c }
      const offset = opts.offset ?? 0
      const length = opts.length ?? buf.byteLength - offset
      const from = opts.position == null ? cursor : Number(opts.position)
      const chunk = data.subarray(from, from + length)
      buf.set(chunk, offset)
      if (opts.position == null) cursor = from + chunk.length
      bytes += chunk.length
      return chunk.length
    },
    closeSync () {},
    readFileSync (p, enc) {
      exists()
      bytes += data.length
      return enc ? data.toString(typeof enc === 'string' ? enc : enc.encoding) : Buffer.from(data)
    }
  }
  return { fs, bytesRead: () => bytes }
}

function replyOf (res) {
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return JSON.parse(JSON.stringify(res.body))
}

// The reply of the bot.js GET handler for route on query, run over env with the bot.js functions it reaches.
function runRoute (route, query, env) {
  const { handle, res } = routeHandler(route, env)
  handle({ query }, res)
  return replyOf(res)
}

// runRoute for a handler that replies after it awaits.
async function awaitRoute (route, query, env) {
  const { handle, res } = routeHandler(route, env)
  await handle({ query }, res)
  return replyOf(res)
}

// awaitRoute through countVerbs and ledger.watch, returning the reply as the client receives it.
async function hookedRoute (route, query, env, ledger) {
  const { handle, res } = routeHandler(route, { ...env, ok: (r, body) => r.json({ ok: true, ...body }) })
  res.json = (body) => { res.body = body }
  const app = { get: (path, h) => { app.handler = h } }
  countVerbs(app, ledger.watch)
  app.get(route, handle)
  await app.handler({ query }, res, () => {})
  return replyOf(res)
}

let botCode
// Where botSource() declares the name key of the reflex named name, skipping strings and comments, else -1.
function reflexAt (name) {
  botCode ??= codeOnly(botSource())
  for (const m of botSource().matchAll(new RegExp(`\\bname\\s*:\\s*['"]${name}['"]`, 'g'))) if (botCode[m.index] === 'n') return m.index
  return -1
}

// The bot.js reflex named name, evaluated over env with the bot.js functions it reaches.
function reflexIn (name, env) {
  const src = botSource()
  const at = reflexAt(name)
  const literal = at < 0 ? '' : balanced(src, src.lastIndexOf('{', at))
  assert.ok(literal, `the ${name} reflex not found in bot.js`)
  const code = `(${literal})`
  return vm.runInContext(code, loadBotFunctions([], env, code))
}

function bunkerReflexIn (env) {
  const src = botSource()
  const at = reflexAt('bunker')
  const literal = at < 0 ? '' : balanced(src, src.lastIndexOf('{', at))
  assert.ok(literal, 'the bunker reflex not found in bot.js')
  return vm.runInContext(`(${literal})`, vm.createContext(env))
}

// The combat reflex of bot.js, evaluated over env. Unless env has its own, every cell is in sight now and soleClaim
// reads env.digLock, a free one when env has none.
function combatReflexIn (env) {
  const src = botSource()
  const at = reflexAt('combat')
  const literal = at < 0 ? '' : balanced(src, src.lastIndexOf('{', at))
  assert.ok(literal, 'the combat reflex not found in bot.js')
  env.OPENABLE ??= botConstant('OPENABLE')
  env.seenNow ??= () => true
  env.seesShape ??= () => true
  env.soleClaim ??= loadBotFunctions(['soleClaim'], { digLock: env.digLock || botConstant('digLock') }).soleClaim
  return vm.runInContext(`(${literal})`, vm.createContext(env))
}

// Runs the wire pieces' bot.on and bot.once lines for event over env, in the bot's order.
function wireListeners (env, event) {
  const lines = [...wiredSource().matchAll(new RegExp(`^bot\\.(?:on|once)\\('${event}', ([A-Za-z_$][\\w$]*)\\)$`, 'gm'))]
  assert.ok(lines.length, `no wired ${event} listener`)
  const code = lines.map((m) => m[0]).join('\n')
  vm.runInContext(code, loadBotFunctions(lines.map((m) => m[1]), env, code))
}

// ---- bunker fakes over sliced bot.js functions ----

const HERE = new Vec3(0.5, 64, 0.5)

// seenAt is where the body last perceived an entity, ages[id] the ms since its hit, and a confirmed id missing from
// entities is unloaded.
function shelterInputsAmong (entities, confirmed, ages = {}) {
  const { env, fills } = shelterEnv(entities, confirmed, ages)
  const input = loadBotFunctions(['shelterInputs'], env).shelterInputs('auto')
  return { input, names: Array.from(input.threats, (t) => t.name), fills: fills(), confirmed: env.AGGRO_CONFIRMED }
}

// The env shelterInputs runs over, with fills() the number of fairFill calls so far.
function shelterEnv (entities, confirmed, ages = {}) {
  const FILL = { cells: new Set() }
  let fills = 0
  const env = {
    bot: { entity: { position: HERE }, entities, blockAt: (p) => ({ name: 'dirt', position: p }) },
    reflexes: [{
      name: 'combat',
      fairFill (b) { fills++; assert.strictEqual(b, env.bot, 'fairFill got another bot'); return FILL },
      _seenAt: new Map(Object.values(entities).filter((e) => e.seenAt).map((e) => [e.id, e.seenAt])),
      perceivedAt (e, seen) { return seen ? e.position : this._seenAt.get(e.id) || null }
    }],
    staleEntities: new Set(),
    AGGRO_CONFIRMED: new Map(confirmed.map((id) => [id, { name: entities[id] ? entities[id].name : 'zombie', t: Date.now() - (ages[id] || 0) }])),
    expireConfirmed: shelter.expireConfirmed,
    SHELTER: shelter.SHELTER,
    CONFIRMED_HORIZON: botConstant('CONFIRMED_HORIZON'),
    CONFIRMED_MS: botConstant('CONFIRMED_MS'),
    BUNKER_HEIGHT: 3,
    BUNKER_MAX_HEIGHT: botConstant('BUNKER_MAX_HEIGHT'),
    mobClass: (e) => e.cls,
    shared: { mcData: null },
    losClear: () => false,
    entityPerceptible: (e, fill) => { assert.strictEqual(fill, FILL, 'entityPerceptible got another fill'); return e.seen },
    babyFlag: shelter.babyFlag,
    liquidProblem: () => null,
    digInProblem: () => null,
    pillarProblem: () => null,
    pillarHeight: (height) => ({ height, safe: shelter.SHELTER.SAFE_HEIGHT, why: 'flat ground' }),
    digMs: () => 800,
    seenNow: () => true,
    BUNKER_DIG_MS: botConstant('BUNKER_DIG_MS'),
    downBuildMs: shelter.downBuildMs,
    upBuildMs: shelter.upBuildMs
  }
  return { env, fills: () => fills }
}

// pillarProblem(height) for a body at (0, 64, 0) on a 5x5 floor at y 63, plus the solid cells in extra and
// the snow layers in snow. The body has never seen the cells in unseen, and does not see the cells in outOfSight now.
function pillarProblemWith (extra, height = 3, unseen = [], outOfSight = [], snow = []) {
  const solid = new Set(extra)
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) solid.add(`${x},63,${z}`)
  const isSolid = (p) => solid.has(`${p.x},${p.y},${p.z}`)
  const isSnow = (p) => snow.includes(`${p.x},${p.y},${p.z}`)
  const hidden = new Set(unseen)
  const away = new Set([...unseen, ...outOfSight])
  const env = {
    bot: {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      blockAt: (p) => ({ name: isSnow(p) ? 'snow' : isSolid(p) ? 'stone' : 'air', boundingBox: isSnow(p) || isSolid(p) ? 'block' : 'empty', position: p })
    },
    solidAt: isSolid,
    knownCell: (p) => !hidden.has(`${p.x},${p.y},${p.z}`),
    seenNow: (p) => !away.has(`${p.x},${p.y},${p.z}`),
    isSoftCover: (b) => b.name === 'snow',
    fillers: () => [{ name: 'dirt', count: 64 }]
  }
  return loadBotFunctions(['pillarProblem'], env).pillarProblem(height)
}

const column = (x, z, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${x},${from + i},${z}`)

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const mobClass = (e) => e.cls
const BUILD_HIT = { entity: { id: 9, name: 'zombie', cls: 'hostile' }, desc: 'zombie' }
const threat = (name, dist) => ({ name, baby: false, dist })

// scenes answer shelterInputs in call order, the last one repeating.
function buildHarness ({ scenes = [{}], centred = true } = {}) {
  const log = []
  const lines = []
  const combat = { name: 'combat', active: false, _fleeUntil: 0, _coverUntil: 0 }
  const bunker = { building: false, stop: null, cell: null, mode: null, reached: 0 }
  let asked = 0
  const scene = () => scenes[Math.min(asked, scenes.length - 1)]
  const env = {
    bunker,
    reflexes: [combat],
    SHELTER: shelter.SHELTER,
    BUNKER_WALK: 'refused while a bunker is being built, the stop tool ends the build',
    BUNKER_HALTS: botConstant('BUNKER_HALTS'),
    bunkerSummary: shelter.bunkerSummary,
    mobClass,
    digLock: botConstant('digLock'),
    console: { log: (line) => lines.push(line) },
    bot: Object.assign(new EventEmitter(), {
      pathfinder: { setGoal () {}, goto: async () => {}, setMovements () {} },
      clearControlStates () {},
      waitForTicks: async () => {},
      targetDigBlock: null,
      stopDigging () { this.targetDigBlock = null }
    }),
    jobs: { stopAll () {} },
    legs: legLedger(),
    safeStop () {},
    stopFollow () {},
    liquidProblem: () => null,
    digInProblem: () => (scene().problems && scene().problems.down) || null,
    xyz: (v) => ({ x: v.x, y: v.y, z: v.z }),
    async centerOnCell () { log.push('centerOnCell'); return centred },
    shelterInputs (requested, height) {
      log.push('shelterInputs')
      const s = scene()
      asked++
      const up = { height, safe: shelter.SHELTER.SAFE_HEIGHT, why: 'flat ground' }
      return { requested, threats: s.threats || [], problems: { down: null, up: null, ...s.problems }, buildMs: { down: 2930, up: 1300 }, up }
    },
    chooseShelter (input) {
      const r = shelter.chooseShelter(input)
      log.push(`chooseShelter ${r.mode || 'refuse'}`)
      return r
    },
    async digIn () {
      log.push('digIn')
      if (bunker.stop) return { at: new Vec3(0, 64, 0), dug: 0, placed: 0, stopped: bunker.stop }
      bunker.cell = new Vec3(0, 61, 0)
      return { at: bunker.cell, dug: 3, placed: 1, gaps: [], exit: [] }
    },
    async pillarShell (height) {
      log.push('pillarShell')
      if (bunker.stop) return { at: new Vec3(0, 64, 0), placed: 0, stopped: bunker.stop }
      bunker.cell = new Vec3(0, 64 + height, 0)
      return { at: bunker.cell, placed: height + 13, gaps: [], exit: [] }
    }
  }
  const ctx = loadBotFunctions(['buildBunker', 'onBuildHit', 'bunkerHolds'], env)
  return { ctx, env, log, lines, combat, bunker }
}

// Each halt as it arrives: the pilot's stop through /stop, a death through the death event.
const halt = {
  'stopped by the pilot': (h) => { h.bunker.stop = 'stopped by the pilot' },
  'the body died': (h) => { h.env.bot.emit('death') }
}
const HALT_REASONS = Object.keys(halt)

// When during[k] returns false, the body does not drop into the k-th dug cell (0-based).
function digHarness (during = {}, bunker = { building: true, stop: null, cell: null, mode: 'down', reached: 0 }, open = [], digLock = botConstant('digLock')) {
  const entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  const air = new Set(open)
  const isOpen = (p) => air.has(`${p.x},${p.y},${p.z}`)
  let digs = 0
  const env = {
    bunker,
    SHELTER: shelter.SHELTER,
    SIDES,
    BUNKER_GROUND: botConstant('BUNKER_GROUND'),
    BUNKER_DIG_MS: botConstant('BUNKER_DIG_MS'),
    digMs: () => 750,
    mobClass,
    bot: {
      entity,
      blockAt: (p) => ({ name: isOpen(p) ? 'air' : 'dirt', position: p }),
      async dig (b) {
        const k = digs++
        if (during[k] && during[k](ctx) === false) return
        entity.position = new Vec3(0.5, b.position.y, 0.5)
      },
      waitForTicks: async () => {}
    },
    equipPickFor: async () => {},
    placeFiller: async () => 'placed',
    solidAt: (p) => !isOpen(p),
    digLock
  }
  digLock.rawDig = env.bot.dig
  const ctx = loadBotFunctions(['digIn', 'onBuildHit', 'claimDig'], env)
  const digIn = ctx.digIn
  ctx.digIn = (claim = Object.assign(ctx.claimDig('the bunker build', true), { sole: true })) => digIn(claim)
  return { ctx, bunker }
}

// The k-th placing (0-based) fails when during[k] returns false.
function pillarHarness (during = {}, bunker = { building: true, stop: null, cell: null, mode: 'up', reached: 0 }) {
  const entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  let places = 0
  const env = {
    bunker,
    SHELTER: shelter.SHELTER,
    SIDES,
    mobClass,
    bot: { entity, blockAt: (p) => ({ name: 'dirt', position: p, boundingBox: 'block' }) },
    fillers: () => [{ name: 'dirt', count: 64 }],
    async jumpPlace () {
      const k = places++
      if (during[k] && during[k](ctx) === false) return false
      entity.position = entity.position.offset(0, 1, 0)
      return true
    },
    centerOnCell: async () => true,
    placeFiller: async () => 'placed',
    solidAt: () => true
  }
  const ctx = loadBotFunctions(['pillarShell', 'onBuildHit'], env)
  return { ctx, bunker }
}

// bunkerReflexDecide for a body at 5 HP hit by a mob 1 s ago, after a flee of the given class and age.
function bunkerDecider (fleeCls, fleeAgoMs) {
  const now = Date.now()
  const combat = { name: 'combat', _fleeCls: fleeCls, _fleeT: now - fleeAgoMs }
  const env = {
    reflexes: [combat, { name: 'bunker', _spent: false }],
    bunkerHolds: () => false,
    bot: { health: 5 },
    BUNKER_HP: 8,
    fight: { lastHit: { dmg: 3, t: now - 1000, cls: 'hostile' } },
    shelterInputs: () => ({ requested: 'auto', threats: [{ ...threat('zombie', 30), entity: {} }], problems: { down: null, up: null }, buildMs: { down: 2930, up: 1300 } }),
    chooseShelter: shelter.chooseShelter
  }
  const d = loadBotFunctions(['bunkerReflexDecide'], env).bunkerReflexDecide()
  return d && d.build === true ? 'build' : d
}

// The flees the bunker reflex starts after a build that returned built.
async function actAfter (built) {
  const flees = []
  const near = { id: 7, name: 'zombie' }
  const env = {
    reflexes: [{ name: 'combat', fleeFrom (b, entity, why, klass) { flees.push({ entity, why, klass }) } }],
    emitEvent () {},
    takeLegs () {},
    buildBunker: async () => built,
    bunkerSummary: shelter.bunkerSummary,
    shelterInputs: () => ({ requested: 'auto', threats: [{ ...threat('zombie', 6), entity: near }] }),
    bunkerReflexDecide: () => null,
    BUNKER_HALTS: botConstant('BUNKER_HALTS'),
    BUNKER_HEIGHT: 3,
    BUNKER_REARM_HP: 12
  }
  await bunkerReflexIn(env).act({ health: 5 })
  for (const f of flees) {
    assert.strictEqual(f.entity, near, 'fled from another entity')
    assert.strictEqual(f.klass, 'emergency', 'the flee is not an emergency')
  }
  return flees
}

const stoppedBuild = (why) => ({ mode: 'up', at: { x: 0, y: 65, z: 0 }, sealed: false, dug: 0, placed: 1, height: 3, gaps: [], exit: [], stopped: why })

// The bot's lane for a body at entity whose last bunker is cell, unclaimed but for a job when job is true.
function laneAt (entity, cell, job = false) {
  const lane = {}
  createLane(lane)
  bindLane({ bot: { entity }, hpMelee: () => false, jobs: { running: () => job }, meleeThreat: () => null, emitEvent () {} })
  Object.assign(lane.bunker, { building: false, stop: null, cell })
  lane.perch.cell = null
  lane.clearLane()
  return lane
}

// ---- build verb fakes ----

// The build routes' env: no threat, every cell known, and seenNow following over.cellKnown unless over sets its own.
function buildVerbEnv (bot, over = {}) {
  const registry = { cobblestone: { id: 1, name: 'cobblestone' }, oak_planks: { id: 2, name: 'oak_planks' } }
  return {
    bot,
    Vec3,
    goals,
    shared: { ready: true, mcData: { blocksByName: registry, itemsByName: registry } },
    SERVER_OVERRIDES: null,
    legs: legLedger(),
    takenText,
    bunker: { building: false },
    fight: { lastHit: { dmg: 0, t: 0 } },
    meleeThreat: () => false,
    claimLane: () => ({}),
    releaseLane () {},
    cellKnown: () => true,
    seenNow: over.cellKnown || (() => true),
    isSoftCover: () => false,
    entityInCell: shelter.entityInCell,
    blockers: () => [],
    OPENABLE: botConstant('OPENABLE'),
    BUILD_FAIL_LIST: botConstant('BUILD_FAIL_LIST'),
    BUILD_REACH: botConstant('BUILD_REACH'),
    BUILD_WALK_CURES: botConstant('BUILD_WALK_CURES'),
    digLock: botConstant('digLock'),
    ...over
  }
}

// ---- dig fakes ----

// digInProblem for a body on the ground at (0, 64, 0), with air from y 64 up and in caves, dirt elsewhere.
function digInProblemWith ({ caves = [], known = (p) => p.y >= 63 } = {}) {
  const open = new Set(caves)
  const isOpen = (p) => p.y >= 64 || open.has(`${p.x},${p.y},${p.z}`)
  const env = {
    bot: {
      entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
      blockAt: (p) => ({ name: isOpen(p) ? 'air' : 'dirt', boundingBox: isOpen(p) ? 'empty' : 'block', position: p })
    },
    SIDES,
    BUNKER_GROUND: botConstant('BUNKER_GROUND'),
    BUNKER_DIG_MS: botConstant('BUNKER_DIG_MS'),
    solidAt: (p) => !isOpen(p),
    isSoftCover: () => false,
    digMs: () => 750,
    knownCell: known,
    seenNow: known,
    fillers: () => [{ name: 'dirt', count: 64 }]
  }
  return loadBotFunctions(['digInProblem'], env).digInProblem()
}

// A yaw facing each cardinal, with the step [dx, dz] along the bot's forward vector at that yaw.
function facings () {
  const { lookVec } = loadBotFunctions(['lookVec'], { Vec3 })
  return [['north', 0], ['west', Math.PI / 2], ['south', Math.PI], ['east', -Math.PI / 2]].map(([name, yaw]) => {
    const v = lookVec(yaw, 0)
    return { name, yaw, step: Math.abs(v.x) >= Math.abs(v.z) ? [Math.sign(v.x), 0] : [0, Math.sign(v.z)] }
  })
}

// Runs a dig job route for a body at (0, 64, 0) facing yaw in dark stone, returning its result with the cells dug and filled and the job's name.
async function digJob (route, query, { air = ['0,64,0', '0,65,0'], blocks = {}, known = [], sky = () => false, yaw = 0 } = {}) {
  const key = (p) => `${p.x},${p.y},${p.z}`
  const open = new Set(air)
  const nameAt = (p) => (open.has(key(p)) ? 'air' : blocks[key(p)] || 'stone')
  const dug = []
  const fills = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw },
    inventory: { emptySlotCount: () => 30 },
    blockAt: (p) => {
      const name = nameAt(p)
      return { name, boundingBox: ['air', 'cave_air', 'lava', 'water'].includes(name) ? 'empty' : 'block', position: p, skyLight: 0 }
    },
    async waitForTicks () {},
    async dig (b) { dug.push(key(b.position)); open.add(key(b.position)) }
  }
  const NEIGHBOURS = botConstant('NEIGHBOURS')
  let job = null
  let name = null
  await awaitRoute(route, query, {
    bot,
    require,
    LEGACY_1710: false,
    bunker: { building: false },
    jobs: { start: (n, fn) => { name = n; job = fn({ cancelled: false, progress () {} }); return { id: 1 } } },
    emitEvent () {},
    refuseWhileBuilding () {},
    equipPickFor: async () => {},
    fillFrom: async (cell) => { fills.push(key(cell)); return null },
    macroPlaceAt: async () => ({}),
    nudgeInto: async (cell) => { bot.entity.position = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5); return true },
    NEIGHBOURS,
    digLock: botConstant('digLock'),
    cellKnown: (p) => known.includes(key(p)),
    knownCell: (p) => known.includes(key(p)),
    skyInSight: () => sky(bot.entity.position),
    seesLit: (p) => NEIGHBOURS.some(([dx, dy, dz]) => open.has(key(p.offset(dx, dy, dz)))),
    liveEntities: () => [],
    FALL_TICKS: botConstant('FALL_TICKS'),
    FALL_START_TICKS: botConstant('FALL_START_TICKS'),
    ck: botConstant('ck'),
    sameVein: require('../lib/wake').sameVein,
    shared: {},
    ORE_IDS: botConstant('ORE_IDS')
  })
  return { ...(await job), dug, fills, name }
}

// Takes digLock as the buried self-rescue takes it.
function claimRescue (digLock) {
  loadBotFunctions(['claimDig'], { digLock }).claimDig('the buried self-rescue', true).sole = true
}

// What route answers on query over env, and the names of the jobs it started.
async function routeJobs (route, query, env) {
  const started = []
  const { handle, res } = routeHandler(route, { jobs: { start: (name) => { started.push(name); return { id: started.length } } }, ...env })
  await handle({ query }, res)
  return { error: res.error, started }
}

module.exports = {
  ROOT, ALLOW, UNAUTHORIZED, UNAUTHORIZED_BODY, ILLEGAL, LONE_SURROGATE, HUNG, PORT, MCP_TOKEN,
  hmac, sha256, newNonce, otherKey, delay, waitFor, fakeClock, timed, proofOver,
  stripLead, serverCommand, strictCommand, assertNoForeignCommand, assertSafeChunks,
  guardRequest, DUMMY_ROUTES, rawRequest, startApp, stateControl, chatControl, referenceApp,
  rawReply, tickFrom, tickReply, tickOf, chatLine, eventLine, botProcess, missing,
  fakeBot, mcpServer, manualFixture, callReq, call, rpc, isToolError, isRpcError, assertOk, textOf, errorText,
  LOCAL_TOOLS, routedTools, validValue, requiredArgs, toolNamed, chatTool, paramsOfType, mcpChatControl, assertSigned,
  baseEnv, runEntry, assertEntryServes, assertEntryRefuses,
  botSource, codeOnly, wiredSource, functionSource, balanced, botConstant, botObject, groundMemory, walkingBody, loadBotFunctions, routeHandler, fakeFile, runRoute, awaitRoute, hookedRoute, reflexIn, bunkerReflexIn, combatReflexIn, wireListeners,
  HERE, shelterInputsAmong, shelterEnv, pillarProblemWith, column,
  BUILD_HIT, threat, buildHarness, halt, HALT_REASONS, digHarness, pillarHarness, bunkerDecider, actAfter, stoppedBuild, laneAt,
  buildVerbEnv, digInProblemWith, facings, digJob, claimRescue, routeJobs
}
