'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createChatLog } = require('../lib/chat-log')
const { createReply, bindReply } = require('../lib/routes/reply')
const { mcpServer, call, textOf, errorText, isToolError, tickFrom } = require('./helpers')

// A bot.js process: its event store, its replies through the real reply layer, and the routes the bot was asked.
function botProcess (boot = 'b0') {
  const ctx = { chatLog: createChatLog({ self: () => 'Claude' }), eventLog: [], streams: { eventSeq: 0, wakeEv: 0 }, BOOT_ID: boot }
  createReply(ctx)
  const routes = []
  const emit = (kind, { quiet = false, t = Date.now() } = {}) => {
    const ev = { id: ++ctx.streams.eventSeq, t, kind, msg: `${kind}-msg-${ctx.streams.eventSeq}`, data: null, ...(quiet && { quiet }) }
    ctx.eventLog.push(ev)
    if (!quiet) ctx.streams.wakeEv = ev.id
    return ev
  }
  const respond = (url) => {
    bindReply(ctx)
    routes.push(url.pathname)
    let body
    const res = { req: { query: {} }, json: (b) => { body = b } }
    if (url.pathname === '/tick') ctx.send(res, tickFrom({ boot, chat: [], events: ctx.eventLog }, url))
    else if (url.pathname === '/events') ctx.ok(res, { cursor: ctx.streams.eventSeq, events: ctx.eventLog })
    else ctx.ok(res, { route: url.pathname })
    return body
  }
  return { emit, respond, routes }
}

const reply = (holder) => (url) => holder.current.respond(url)

function tailOf (r) {
  const tails = r.result.content.map((c) => c.text).filter((t) => t.startsWith('Waiting events:'))
  assert.ok(tails.length <= 1, `${tails.length} tails`)
  return tails[0] ?? null
}

test('a tool reply after a waking event names its kind and wait_events, a quiet event adds nothing', async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  proc.emit('server', { quiet: true })
  assert.strictEqual(tailOf(await call(srv, 'state', {})), null)
  proc.emit('nightfall')
  const r = await call(srv, 'state', {})
  assert.strictEqual(tailOf(r), 'Waiting events: nightfall. Read them with wait_events.')
  assert.ok(!JSON.stringify(r).includes('wakeEvents'))
  assert.ok(!JSON.stringify(r).includes('nightfall-msg'), 'an event text reached the tail')
})

test('wait_events ends the tail, and the next waking event brings it back', async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  proc.emit('nightfall')
  assert.ok(tailOf(await call(srv, 'state', {})), 'control')
  assert.ok(textOf(await call(srv, 'wait_events', { timeout: 1 })).includes('nightfall-msg'))
  assert.strictEqual(tailOf(await call(srv, 'state', {})), null)
  proc.emit('hostile')
  assert.strictEqual(tailOf(await call(srv, 'state', {})), 'Waiting events: hostile. Read them with wait_events.')
})

test('the tail counts each kind in the order it first arrived and names at most 6 kinds', async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  for (const kind of ['nightfall', 'hostile', 'hostile', 'threat', 'combat']) proc.emit(kind)
  assert.strictEqual(tailOf(await call(srv, 'state', {})), 'Waiting events: nightfall, 2 hostile, threat, combat. Read them with wait_events.')
  for (const kind of ['hurt', 'low_food', 'death', 'bunker']) proc.emit(kind)
  assert.strictEqual(tailOf(await call(srv, 'state', {})), 'Waiting events: nightfall, 2 hostile, threat, combat, hurt, low_food and 2 more. Read them with wait_events.')
})

test('a kind name in the tail is flattened and its paths redacted', async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  proc.emit('night\nfall')
  proc.emit('C:/Users/alice/kindleak')
  const tail = tailOf(await call(srv, 'state', {}))
  assert.match(tail, /^Waiting events: night fall, <path>\./)
  assert.ok(!tail.includes('kindleak'))
})

test('a bot restart drops the events of the old process from the tail', async () => {
  const holder = { current: botProcess('b0') }
  const { srv } = mcpServer({ reply: reply(holder) })
  holder.current.emit('nightfall')
  assert.ok(tailOf(await call(srv, 'state', {})), 'control')
  holder.current = botProcess('b1')
  assert.strictEqual(tailOf(await call(srv, 'state', {})), null)
  holder.current.emit('hostile')
  assert.strictEqual(tailOf(await call(srv, 'state', {})), 'Waiting events: hostile. Read them with wait_events.')
})

test('a backlog over 50 events keeps the tail through a tick until wait_events has paged through it', { timeout: 20000 }, async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  for (let i = 0; i < 60; i++) proc.emit(i < 50 ? 'hostile' : 'nightfall')
  assert.ok(tailOf(await call(srv, 'state', {})), 'control')
  await call(srv, 'tick', {})
  assert.ok(tailOf(await call(srv, 'state', {})), 'after a tick')
  await call(srv, 'wait_events', { timeout: 1 })
  assert.strictEqual(tailOf(await call(srv, 'state', {})), 'Waiting events: 10 nightfall. Read them with wait_events.')
  await call(srv, 'wait_events', { timeout: 1 })
  assert.strictEqual(tailOf(await call(srv, 'state', {})), null)
})

test('a reply the server handles late keeps a kind that a newer reply already named', async () => {
  const proc = botProcess()
  let release
  const held = new Promise((resolve) => { release = resolve })
  let holding = true
  const { srv } = mcpServer({
    reply: async (url) => {
      const body = proc.respond(url)
      if (url.pathname === '/state' && holding) {
        holding = false
        await held
      }
      return body
    }
  })
  const late = call(srv, 'state', {})
  await new Promise((resolve) => setImmediate(resolve))
  while (!proc.routes.includes('/state')) await new Promise((resolve) => setImmediate(resolve))
  proc.emit('combat')
  assert.strictEqual(tailOf(await call(srv, 'scene', {})), 'Waiting events: combat. Read them with wait_events.', 'control')
  release()
  assert.strictEqual(tailOf(await late), 'Waiting events: combat. Read them with wait_events.')
  assert.strictEqual(tailOf(await call(srv, 'inventory', {})), 'Waiting events: combat. Read them with wait_events.')
})

test('tick and wait_events replies carry no tail', { timeout: 20000 }, async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  for (let i = 0; i < 60; i++) proc.emit('hostile')
  assert.ok(tailOf(await call(srv, 'state', {})), 'control')
  assert.strictEqual(tailOf(await call(srv, 'tick', {})), null, 'tick')
  assert.strictEqual(tailOf(await call(srv, 'wait_events', { timeout: 1 })), null, 'wait_events')
  assert.ok(tailOf(await call(srv, 'state', {})), 'control: 10 events still wait')
})

// ---- the gate on world work ----

const TORCH = { x: 2, y: 64, z: 2, name: 'torch' }
const REFUSAL = /^refused: unread fight events \(threat, combat\)\. Reading them with wait_events or tick lifts this\. Ways out meanwhile: goto, pillar, bunker\.$/

test('a world-work call is refused without reaching the bot while a fresh fight event is unread, a combat tool passes', { timeout: 20000 }, async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  proc.emit('nightfall')
  await call(srv, 'state', {})
  assert.ok(!isToolError(await call(srv, 'placeitem', TORCH)), 'control: no fight event')
  proc.emit('threat')
  proc.emit('combat')
  await call(srv, 'state', {})
  proc.routes.length = 0
  const r = await call(srv, 'placeitem', TORCH)
  assert.ok(isToolError(r))
  assert.match(errorText(r), REFUSAL)
  assert.deepStrictEqual(proc.routes, [], 'the refused call reached the bot')
  assert.ok(!isToolError(await call(srv, 'strike', { name: 'zombie' })), 'a combat tool')
  assert.deepStrictEqual(proc.routes, ['/strike'])
  await call(srv, 'wait_events', { timeout: 1 })
  assert.ok(!isToolError(await call(srv, 'placeitem', TORCH)), 'after wait_events')
  assert.deepStrictEqual(proc.routes.filter((r) => r !== '/tick'), ['/strike', '/placeitem'])
})

test('a tick that shows the fight events lifts the refusal', async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  proc.emit('threat')
  proc.emit('combat')
  await call(srv, 'state', {})
  assert.match(errorText(await call(srv, 'placeitem', TORCH)), REFUSAL, 'control')
  await call(srv, 'tick', {})
  const r = await call(srv, 'placeitem', TORCH)
  assert.ok(!isToolError(r), errorText(r))
})

test('an events reply carries the tail, and reading events leaves the refusal', async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  proc.emit('threat')
  proc.emit('combat')
  await call(srv, 'state', {})
  assert.strictEqual(tailOf(await call(srv, 'events', { since: 0 })), 'Waiting events: threat, combat. Read them with wait_events.')
  assert.match(errorText(await call(srv, 'placeitem', TORCH)), REFUSAL)
})

test('goto, follow, climb and pillar reach the bot while a fresh fight event is unread', { timeout: 20000 }, async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  proc.emit('threat')
  await call(srv, 'state', {})
  assert.ok(isToolError(await call(srv, 'placeitem', TORCH)), 'control: world work is refused')
  proc.routes.length = 0
  for (const [tool, args] of [['goto', { x: 20, z: 20 }], ['follow', { name: 'Steve' }], ['climb', {}], ['pillar', { height: 3 }]]) {
    const r = await call(srv, tool, args)
    assert.ok(!isToolError(r), `${tool}: ${errorText(r)}`)
  }
  assert.deepStrictEqual(proc.routes, ['/goto', '/follow', '/climb', '/pillar'])
})

test('a refuel or lane event shows in the tail and gates nothing', async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  proc.emit('refuel')
  proc.emit('lane')
  assert.strictEqual(tailOf(await call(srv, 'state', {})), 'Waiting events: refuel, lane. Read them with wait_events.')
  const r = await call(srv, 'placeitem', TORCH)
  assert.ok(!isToolError(r), errorText(r))
  assert.ok(proc.routes.includes('/placeitem'))
})

test('a fight event over 60 s old shows in the tail and gates nothing', async () => {
  const proc = botProcess()
  const { srv } = mcpServer({ reply: reply({ current: proc }) })
  proc.emit('threat', { t: Date.now() - 3600000 })
  proc.emit('combat', { t: Date.now() - 61000 })
  assert.strictEqual(tailOf(await call(srv, 'state', {})), 'Waiting events: threat, combat. Read them with wait_events.')
  const r = await call(srv, 'placeitem', TORCH)
  assert.ok(!isToolError(r), errorText(r))
  assert.ok(proc.routes.includes('/placeitem'))
})
