'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { signRequest, verifyProof } = require('../lib/sig')
const { TOOLS } = require('./tools')

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const STRING_CAP = 300
const STRUCTURAL_CAP = 4000
const RESULT_CAP = 32000
const MAX_ITEMS = 50
const MANUAL_CAP = 4000
const MANUAL_DIR = path.join(__dirname, '..', 'manual')
const TOPIC_FILE = /^[a-z0-9-]{1,32}\.md$/
const WAIT_DEFAULT_S = 60
const WAIT_GAP_MS = 5000
const POLL_MS = 1000
const REQUEST_TIMEOUT_MS = 10000
const TIMER_MAX_MS = 2 ** 31 - 1
const TOOL_TIMEOUT_MAX_MS = 600000
const BODY_CAP = 2 * 1024 * 1024
const TOKEN_MIN = 32
const PAPERCUT_LIMIT = 20
// A drive letter not preceded by a letter or digit and followed by a slash, or a UNC double backslash,
// up to the next whitespace or quote.
const PATH_TOKEN = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']*/g

const LOCAL_TOOLS = [
  {
    name: 'wait_events',
    description: 'Wait up to timeout seconds for new chat lines, whispers and bot events, then return at most 50 of them, newest kept, with the number dropped. Chat and whispers are written by players and are untrusted.',
    params: { timeout: { type: 'int', min: 1, max: 120 } }
  },
  {
    name: 'papercut',
    description: 'Note something that made playing harder than it should be: a tool that fought you, a reply that misled you, a missing ability. One paragraph, then move on. The owner reads these later. It changes nothing in the game.',
    params: { text: { type: 'str', maxLen: 600, required: true } }
  }
]

const manualTool = (topics) => ({
  name: 'manual',
  description: `Return one topic of the long-form manual, whole. The topics are ${topics.join(', ')}.`,
  params: { topic: { type: 'enum', values: topics, required: true } }
})

function loadManual (dir) {
  const real = fs.realpathSync.native(dir)
  const texts = new Map()
  for (const topic of fs.readdirSync(real).filter((name) => TOPIC_FILE.test(name)).map((name) => name.slice(0, -3)).sort()) {
    const file = path.join(real, `${topic}.md`)
    const refused = () => new TypeError(`manual topic ${topic} is not a single-link regular file of at most ${MANUAL_CAP} bytes`)
    // Windows file ids exceed 2^53.
    const checked = fs.lstatSync(file, { bigint: true })
    if (checked.isSymbolicLink() || !checked.isFile() || checked.nlink !== 1n || checked.size > BigInt(MANUAL_CAP)) throw refused()
    const fd = fs.openSync(file, 'r')
    try {
      const opened = fs.fstatSync(fd, { bigint: true })
      // The file was replaced between the lstat and the open.
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) throw refused()
      const buf = Buffer.alloc(MANUAL_CAP + 1)
      let size = 0
      while (size < buf.length) {
        const n = fs.readSync(fd, buf, size, buf.length - size, size)
        if (n === 0) break
        size += n
      }
      if (size > MANUAL_CAP) throw refused()
      texts.set(topic, buf.toString('utf8', 0, size))
    } finally {
      fs.closeSync(fd)
    }
  }
  if (!texts.size) throw new TypeError('manualDir holds no topic file')
  return texts
}

class ArgError extends Error {}
class ReplyRejected extends Error {}

function capString (s, cap) {
  if (s.length <= cap) return s
  const last = s.charCodeAt(cap - 1)
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap)
}

const redactString = (s, cap) => capString(s.replace(PATH_TOKEN, '<path>'), cap)

// U+2800 renders blank but is not whitespace.
const flatText = (s) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u{2800}]/gu, '').replace(/\s+/g, ' ').trim()

// The top-level string fields named in structural are capped at STRUCTURAL_CAP, every other string at STRING_CAP.
function redact (value, structural = []) {
  if (typeof value === 'string') return redactString(value, STRING_CAP)
  if (Array.isArray(value)) return value.map((v) => redact(v))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [redact(k), structural.includes(k) && typeof v === 'string' ? redactString(v, STRUCTURAL_CAP) : redact(v)]))
  }
  return value
}

// Keeps the leading fields and items of value that fit in budget units of JSON. Null for a scalar over budget.
function fitJson (value, budget) {
  const size = JSON.stringify(value).length
  if (size <= budget) return { value, size }
  if (value === null || typeof value !== 'object' || budget < 2) return null
  const array = Array.isArray(value)
  const kept = []
  let used = 2
  for (const [k, v] of array ? value.entries() : Object.entries(value)) {
    const head = (kept.length ? 1 : 0) + (array ? 0 : JSON.stringify(k).length + 1)
    const part = fitJson(v, budget - used - head)
    if (!part) break
    kept.push(array ? part.value : [k, part.value])
    used += head + part.size
    if (part.value !== v) break
  }
  return { value: array ? kept : Object.fromEntries(kept), size: used }
}

// Keeps the newest MAX_ITEMS entries of each named list and records the count dropped beside it.
function trimLists (body, lists = []) {
  for (const dotted of lists) {
    const keys = dotted.split('.')
    const key = keys.pop()
    let parent = body
    for (const k of keys) parent = parent !== null && typeof parent === 'object' ? parent[k] : undefined
    if (parent === null || typeof parent !== 'object' || !Array.isArray(parent[key])) continue
    const list = parent[key]
    if (list.length <= MAX_ITEMS) continue
    parent[key] = list.slice(-MAX_ITEMS)
    parent[key + 'Dropped'] = list.length - MAX_ITEMS
  }
  return body
}

function checkSpec (tool, name, spec) {
  const bounded = (n) => typeof n === 'number' && Number.isFinite(n)
  const ok = {
    int: () => Number.isInteger(spec.min) && Number.isInteger(spec.max),
    num: () => bounded(spec.min) && bounded(spec.max),
    str: () => Number.isInteger(spec.maxLen) && spec.maxLen > 0,
    bool: () => true,
    enum: () => Array.isArray(spec.values) && spec.values.length > 0 && spec.values.every((v) => typeof v === 'string')
  }[spec.type]
  if (!ok || !ok()) throw new TypeError(`tool ${tool.name}: parameter ${name} has no valid type and bounds`)
}

function schemaOf (spec) {
  switch (spec.type) {
    case 'int': return { type: 'integer', minimum: spec.min, maximum: spec.max }
    case 'num': return { type: 'number', minimum: spec.min, maximum: spec.max }
    case 'str': return { type: 'string', minLength: 1, maxLength: spec.maxLen }
    case 'bool': return { type: 'boolean' }
    case 'enum': return { type: 'string', enum: spec.values }
  }
}

function listing (tool) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(tool.params)) {
    properties[name] = spec.desc ? { ...schemaOf(spec), description: spec.desc } : schemaOf(spec)
    if (spec.required) required.push(name)
  }
  const inputSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length) inputSchema.required = required
  return { name: tool.name, description: tool.description, inputSchema }
}

function validValue (spec, v) {
  switch (spec.type) {
    case 'int': return Number.isInteger(v) && v >= spec.min && v <= spec.max
    case 'num': return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max
    case 'str': return typeof v === 'string' && v.length >= 1 && v.length <= spec.maxLen
    case 'bool': return typeof v === 'boolean'
    case 'enum': return typeof v === 'string' && spec.values.includes(v)
  }
  return false
}

function describeSpec (spec) {
  switch (spec.type) {
    case 'int': return `an integer ${spec.min} to ${spec.max}`
    case 'num': return `a number ${spec.min} to ${spec.max}`
    case 'str': return `a string of 1 to ${spec.maxLen} characters`
    case 'bool': return 'true or false'
    case 'enum': return `one of ${spec.values.join(', ')}`
  }
}

function checkArgs (tool, args) {
  if (args === undefined) args = {}
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new ArgError('arguments must be an object')
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.params, key)) throw new ArgError(`unknown argument: ${capString(key, 64)}`)
  }
  const values = {}
  for (const [name, spec] of Object.entries(tool.params)) {
    const v = Object.hasOwn(args, name) ? args[name] : undefined
    if (v === undefined) {
      if (spec.required) throw new ArgError(`${name} is required`)
      continue
    }
    if (!validValue(spec, v)) throw new ArgError(`${name} must be ${describeSpec(spec)}`)
    values[name] = v
  }
  return values
}

function toQuery (tool, values) {
  const query = new URLSearchParams()
  for (const name of Object.keys(tool.params)) {
    const v = values[name]
    if (v === undefined || v === false) continue
    query.set(name, v === true ? '1' : String(v))
  }
  return query
}

const textResult = (text, isError = false) => (isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] })
function jsonResult (value, isError = false) {
  const text = JSON.stringify(value)
  if (text.length <= RESULT_CAP) return textResult(text, isError)
  const note = `Trimmed: the reply was ${text.length} characters, over the ${RESULT_CAP}-character limit. Fields and list items after the cut are left out.`
  const result = textResult(JSON.stringify(fitJson(value, RESULT_CAP - note.length).value), isError)
  result.content.push({ type: 'text', text: note })
  return result
}
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

const isCursor = (c) => Number.isInteger(c) && c >= 0

const usableTick = (t) => t !== null && typeof t === 'object' &&
  t.chat !== null && typeof t.chat === 'object' && Array.isArray(t.chat.messages) && isCursor(t.chat.cursor) &&
  t.events !== null && typeof t.events === 'object' && Array.isArray(t.events.list) && isCursor(t.events.cursor)

function botFailure (e) {
  if (e instanceof ReplyRejected) return 'the bot reply failed verification'
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'the bot did not answer in time'
  return 'the bot is not reachable'
}

// The error of a tool call cut at its deadline.
const cutMessage = (timeoutMs) =>
  `the bot did not answer within ${+(timeoutMs / 1000).toFixed(1)} s, and the action may still be running. Call state to see what the body is doing, or stop to end it.`

// The body bytes, or null once they pass cap.
async function readCapped (body, cap) {
  const chunks = []
  let size = 0
  if (body) {
    for await (const chunk of body) {
      size += chunk.length
      if (size > cap) return null
      chunks.push(chunk)
    }
  }
  return Buffer.concat(chunks)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

// Settles with promise, or rejects with the abort reason once signal aborts, whether or not promise heeds it.
function untilAborted (promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

// onWake runs after every return of wait_events. onToolCall runs on every tools/call with the name from
// the tool table, null for a name outside it.
function createServer ({ port, token, fetch, manualDir = MANUAL_DIR, onWake = () => {}, onToolCall = () => {}, requestTimeoutMs = REQUEST_TIMEOUT_MS, papercutsFile, now = () => new Date() }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError('port must be an integer 1024-65535')
  if (typeof token !== 'string' || token === '') throw new TypeError('token must be a non-empty string')
  if (typeof fetch !== 'function') throw new TypeError('fetch must be a function')
  if (typeof manualDir !== 'string' || manualDir === '') throw new TypeError('manualDir must be a path')
  if (typeof onWake !== 'function') throw new TypeError('onWake must be a function')
  if (typeof onToolCall !== 'function') throw new TypeError('onToolCall must be a function')
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > TIMER_MAX_MS) {
    throw new TypeError(`requestTimeoutMs must be an integer 1-${TIMER_MAX_MS}`)
  }
  if (papercutsFile !== undefined && (typeof papercutsFile !== 'string' || !path.isAbsolute(papercutsFile))) {
    throw new TypeError('papercutsFile must be an absolute path')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  const manual = loadManual(manualDir)
  const tools = [...TOOLS, ...LOCAL_TOOLS, manualTool([...manual.keys()])]
  const byName = new Map()
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new TypeError(`duplicate tool ${tool.name}`)
    for (const [name, spec] of Object.entries(tool.params)) checkSpec(tool, name, spec)
    if (tool.timeoutMs !== undefined && !(Number.isInteger(tool.timeoutMs) && tool.timeoutMs >= 1 && tool.timeoutMs <= TOOL_TIMEOUT_MAX_MS)) {
      throw new TypeError(`tool ${tool.name}: timeoutMs must be an integer 1-${TOOL_TIMEOUT_MAX_MS}`)
    }
    byName.set(tool.name, tool)
  }
  const listed = tools.map(listing)
  const closing = new AbortController()
  // boot is the bot.js process the cursors belong to, null before the first tick that names one.
  const cursor = { chat: 0, ev: 0, boot: null }
  let waiting = false
  let lastReturn = -Infinity
  let papercuts = 0

  // Throws ReplyRejected for a reply without a valid X-Golem-Proof. timeoutMs covers the body too.
  async function getJson (route, query, timeoutMs = requestTimeoutMs) {
    const expiry = new AbortController()
    const timer = setTimeout(() => expiry.abort(new DOMException('the bot did not answer in time', 'TimeoutError')), timeoutMs)
    const signal = AbortSignal.any([closing.signal, expiry.signal])
    try {
      return await untilAborted(fetchJson(route, query, signal), signal)
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchJson (route, query, signal) {
    const qs = query.toString()
    const url = new URL(`http://127.0.0.1:${port}${route}${qs ? '?' + qs : ''}`)
    const time = String(Date.now())
    const nonce = crypto.randomBytes(16).toString('hex')
    const res = await fetch(url.href, {
      method: 'GET',
      headers: { 'X-Golem-Time': time, 'X-Golem-Nonce': nonce, 'X-Golem-Sig': signRequest(token, 'GET', url.pathname + url.search, time, nonce) },
      redirect: 'error',
      signal
    })
    const raw = await readCapped(res.body, BODY_CAP)
    if (raw === null) return { status: res.status, body: { ok: false, error: 'the bot reply was too large' } }
    if (!verifyProof(token, nonce, raw, res.headers.get('x-golem-proof'))) throw new ReplyRejected()
    if (res.status >= 500) return { status: res.status, body: { ok: false, error: `the bot failed with HTTP ${res.status}` } }
    try {
      return { status: res.status, body: JSON.parse(raw.toString('utf8')) }
    } catch {
      return { status: res.status, body: { ok: false, error: `the bot answered HTTP ${res.status} without JSON` } }
    }
  }

  async function callRouted (tool, values) {
    const timeoutMs = tool.timeoutMs ?? requestTimeoutMs
    let reply
    try {
      reply = await getJson(tool.route, toQuery(tool, values), timeoutMs)
    } catch (e) {
      return textResult(e && e.name === 'TimeoutError' ? cutMessage(timeoutMs) : botFailure(e), true)
    }
    return jsonResult(redact(trimLists(reply.body, tool.lists), tool.structural), reply.status !== 200)
  }

  async function waitEvents ({ timeout = WAIT_DEFAULT_S }) {
    if (waiting) return textResult('wait_events is already running', true)
    waiting = true
    try {
      return await gather(Date.now() + timeout * 1000, lastReturn + WAIT_GAP_MS)
    } finally {
      lastReturn = Date.now()
      waiting = false
      onWake()
    }
  }

  // Polls /tick until activity came in and earliest has passed, or until deadline.
  async function gather (deadline, earliest) {
    const start = { ...cursor }
    const items = []
    const notes = []
    let dropped = 0
    let status
    let restarted = false
    for (;;) {
      let tick = null
      status = 'the bot is not ready'
      try {
        tick = (await getJson('/tick', new URLSearchParams({ chat: String(cursor.chat), ev: String(cursor.ev) }))).body
      } catch (e) {
        if (e instanceof ReplyRejected) {
          // The next call fetches again what this one gathered.
          Object.assign(cursor, start)
          await sleep(Math.min(earliest, deadline) - Date.now())
          return textResult(botFailure(e), true)
        }
        status = botFailure(e)
      }
      if (usableTick(tick)) {
        const boot = typeof tick.boot === 'string' ? tick.boot : null
        const newProcess = boot !== null && cursor.boot !== null && boot !== cursor.boot
        // A tick asked with the old process's cursors skipped the new process's first lines.
        if (newProcess || tick.chat.cursor < cursor.chat || tick.events.cursor < cursor.ev) {
          // Every restart moves the cursors to the newest process. Only the first one in a call asks again
          // at once, so a boot that changes on every reply cannot spin.
          if (boot !== null) cursor.boot = boot
          cursor.chat = 0
          cursor.ev = 0
          status = 'the bot restarted'
          if (!restarted) {
            restarted = true
            notes.push('the bot restarted, chat and events from before the restart are gone')
            if (Date.now() < deadline && !closing.signal.aborted) continue
          }
        } else {
          if (boot !== null) cursor.boot = boot
          cursor.chat = tick.chat.cursor
          cursor.ev = tick.events.cursor
          const said = tick.chat.messages.map((m) => ({ t: m.t, type: m.kind === 'whisper' ? 'whisper' : 'chat', from: m.from, msg: m.msg }))
          const happened = tick.events.list.map((e) => ({ t: e.t, type: 'event', kind: e.kind, msg: e.msg }))
          items.push(...redact([...said, ...happened].sort((a, b) => a.t - b.t).map(({ t, ...item }) => item)))
          if (items.length > MAX_ITEMS) dropped += items.splice(0, items.length - MAX_ITEMS).length
          status = 'no new activity'
        }
      }
      const now = Date.now()
      if ((items.length && now >= earliest) || now >= deadline || closing.signal.aborted) break
      await sleep(Math.min(POLL_MS, (items.length ? Math.min(earliest, deadline) : deadline) - now))
    }
    if (!items.length) return jsonResult(redact({ items, dropped, notes, status }))
    const body = { items, dropped, notes: redact(notes) }
    // Over the result cap, the oldest items are dropped and counted.
    while (items.length && JSON.stringify(body).length > RESULT_CAP) {
      items.shift()
      body.dropped++
    }
    return jsonResult(body)
  }

  function papercut ({ text }) {
    if (papercutsFile === undefined) return textResult('papercuts are off', true)
    const line = flatText(text)
    if (!line) return textResult('papercut text is empty', true)
    if (papercuts >= PAPERCUT_LIMIT) return textResult('papercut limit reached', true)
    const header = `${now().toISOString().slice(0, 19)}Z | pilot | ${path.basename(path.dirname(papercutsFile))}`
    // A failed write counts too.
    papercuts++
    try {
      fs.appendFileSync(papercutsFile, `${header}\n${line}\n\n`)
    } catch (e) {
      console.error(`[golem-mcp] cannot write the papercut: ${e.message}`)
      return textResult('the papercut could not be written', true)
    }
    return textResult('noted')
  }

  async function callTool (id, params) {
    const valid = params !== null && typeof params === 'object' && typeof params.name === 'string'
    const tool = valid ? byName.get(params.name) : undefined
    onToolCall(tool ? tool.name : null)
    if (!valid) return rpcError(id, -32602, 'invalid params')
    if (!tool) return rpcError(id, -32602, 'unknown tool')
    let values
    try {
      values = checkArgs(tool, params.arguments)
    } catch (e) {
      if (!(e instanceof ArgError)) throw e
      return rpcResult(id, textResult(e.message, true))
    }
    if (tool.name === 'wait_events') return rpcResult(id, await waitEvents(values))
    if (tool.name === 'manual') return rpcResult(id, textResult(manual.get(values.topic)))
    if (tool.name === 'papercut') return rpcResult(id, papercut(values))
    return rpcResult(id, await callRouted(tool, values))
  }

  async function handle (msg) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      const id = msg !== null && typeof msg === 'object' && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null
      return rpcError(id, -32600, 'invalid request')
    }
    if (!Object.hasOwn(msg, 'id')) return null
    const id = msg.id
    if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, -32600, 'invalid request id')
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params && msg.params.protocolVersion
          return rpcResult(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'golem', version: '1.0.0' }
          })
        }
        case 'ping': return rpcResult(id, {})
        case 'tools/list': return rpcResult(id, { tools: listed })
        case 'tools/call': return await callTool(id, msg.params)
        default: return rpcError(id, -32601, 'method not found')
      }
    } catch (e) {
      console.error('[golem-mcp] ' + (e && e.stack ? e.stack : String(e)))
      return rpcError(id, -32603, 'internal error')
    }
  }

  return { handle, close: () => closing.abort() }
}

function serveStdio (srv) {
  const pending = new Set()
  const track = (p) => {
    const done = p.then(() => {}, (e) => console.error('[golem-mcp] ' + (e && e.stack ? e.stack : String(e))))
    pending.add(done)
    done.then(() => pending.delete(done))
  }
  const send = (msg) => new Promise((resolve) => process.stdout.write(JSON.stringify(msg) + '\n', () => resolve()))
  process.stdout.on('error', () => process.exit(0))
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      track(send(rpcError(null, -32700, 'parse error')))
      return
    }
    track(srv.handle(msg).then((reply) => reply && send(reply)))
  })
  rl.on('close', () => {
    srv.close()
    Promise.all([...pending]).then(() => process.exit(0))
  })
}

function main () {
  const fail = (message) => {
    console.error('[golem-mcp] ' + message)
    process.exit(2)
  }
  const args = process.argv.slice(2)
  const port = Number(args[0])
  if (args.length < 1 || args.length > 2 || !/^[1-9][0-9]{3,4}$/.test(args[0]) || port < 1024 || port > 65535) {
    fail('usage: node mcp/server.js <port 1024-65535> [<wake log>], with GOLEM_TOKEN in the environment')
  }
  const token = process.env.GOLEM_TOKEN || ''
  if (token.length < TOKEN_MIN) fail(`GOLEM_TOKEN is missing or shorter than ${TOKEN_MIN} characters`)
  // The wake log lets a supervising process count the wait_events returns and the tool calls.
  let onWake
  let onToolCall
  if (args.length === 2) {
    let fd
    try {
      fd = fs.openSync(args[1], 'a')
    } catch (e) {
      fail(`cannot open the wake log: ${e.message}`)
    }
    const logLine = (line) => {
      try {
        fs.writeSync(fd, line + '\n')
      } catch (e) {
        fail(`cannot write the wake log: ${e.message}`)
      }
    }
    onWake = () => logLine('wait_events returned')
    onToolCall = (name) => logLine(`tool call ${name === null ? '(unknown)' : name}`)
  }
  const papercutsFile = process.env.GOLEM_PAPERCUTS || undefined
  serveStdio(createServer({ port, token, fetch: globalThis.fetch, onWake, onToolCall, papercutsFile }))
}

if (require.main === module) main()

module.exports = { createServer, redact, PATH_TOKEN }
