'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { TOOLS } = require('../mcp/tools')
const { createChatLog } = require('../lib/chat-log')
const { createReply, bindReply } = require('../lib/routes/reply')
const { loadBotFunctions, mcpServer, call, textOf, tickFrom } = require('./helpers')

const refusal = (mob) => `refused: fighting ${mob}, the guard reflex holds the hand. Ways out: goto, pillar, bunker, or switching the combat reflex off with reflexes(name: 'combat', on: '0').`

// The fight gates by route, over a zombie fight whose busy, seen, inBunker and err the caller sets.
function fightGate (busy, { seen = true, inBunker = () => false, err = (res, e) => { res.body = { ok: false, error: e.message, reason: e.reason } } } = {}) {
  const zombie = { id: 7, name: 'zombie' }
  const combat = { name: 'combat', fightBusy: busy, _threat: { e: zombie, cls: 'hostile' }, fairFill: () => ({}) }
  const gates = new Map()
  const app = { all: (route, gate) => gates.set(route, gate) }
  const env = { TOOLS, err, reflexes: [combat], bot: { entities: { 7: zombie } }, entityPerceptible: () => seen, bunkerHolds: inBunker }
  loadBotFunctions(['installFightGate'], env).installFightGate(app)
  return gates
}

// What the gate of route does with a request: 'ungated', 'passed', or the reply it sent.
function through (gates, route, res = {}) {
  const gate = gates.get(route)
  if (!gate) return 'ungated'
  let passed = false
  gate({ query: {} }, res, () => { passed = true })
  return passed ? 'passed' : res.body
}

test('world-work routes answer the fight refusal while the combat reflex is busy, combat and escape routes stay open', () => {
  let busy = true
  const gates = fightGate(() => busy)
  for (const route of ['/placeitem', '/digat', '/mine', '/gather', '/lookat', '/gesture']) {
    assert.deepStrictEqual(through(gates, route), { ok: false, error: refusal('zombie'), reason: 'fighting' }, route)
  }
  for (const route of ['/strike', '/shoot', '/guard', '/hold', '/bunker', '/eat', '/equip', '/goto', '/follow', '/climb', '/pillar', '/stop', '/brace', '/stance', '/reflexes', '/state']) {
    assert.strictEqual(through(gates, route), 'ungated', route)
  }
  busy = false
  assert.strictEqual(through(gates, '/placeitem'), 'passed')
})

test('the fight refusal names an unseen mob as something', () => {
  assert.deepStrictEqual(through(fightGate(() => true, { seen: false }), '/placeitem'), { ok: false, error: refusal('something'), reason: 'fighting' })
})

test('world work passes while the body stands in its bunker, however busy the combat reflex is', () => {
  let inside = true
  const gates = fightGate(() => true, { inBunker: () => inside })
  for (const route of ['/placeitem', '/digat', '/mine']) assert.strictEqual(through(gates, route), 'passed', route)
  inside = false
  assert.deepStrictEqual(through(gates, '/placeitem'), { ok: false, error: refusal('zombie'), reason: 'fighting' })
})

test('a placement batch during a guard fight and after its DOWN event reaches no hand until wait_events', { timeout: 20000 }, async () => {
  // bot.js: the real reply layer and fight gate over a fight the test runs, and a placeitem that records its clicks.
  const ctx = { chatLog: createChatLog({ self: 'Claude' }), eventLog: [], streams: { eventSeq: 0, wakeEv: 0 }, BOOT_ID: 'b0' }
  createReply(ctx)
  bindReply(ctx)
  let fighting = false
  const gates = fightGate(() => fighting, { err: ctx.err })
  const emit = (kind, msg) => {
    const ev = { id: ++ctx.streams.eventSeq, t: Date.now(), kind, msg, data: null }
    ctx.eventLog.push(ev)
    ctx.streams.wakeEv = ev.id
  }
  const clicks = []
  const reply = (url) => {
    let body
    const res = { req: { query: {} }, json: (b) => { body = b } }
    if (url.pathname === '/tick') ctx.send(res, tickFrom({ boot: 'b0', chat: [], events: ctx.eventLog }, url))
    else if (through(gates, url.pathname, res) === 'passed' && url.pathname === '/placeitem') {
      clicks.push(fighting ? 'during the fight' : 'after the fight')
      ctx.ok(res, { placed: 'dirt' })
    } else if (body === undefined) ctx.ok(res, { route: url.pathname })
    return body
  }
  const { srv } = mcpServer({ reply })
  const place = async () => (await call(srv, 'placeitem', { x: 2, y: 64, z: 2, name: 'dirt' })).result.content.map((c) => c.text).join('\n')

  fighting = true
  emit('threat', 'zombie E ~3 closing fast, engaging [guard]')
  const during = []
  for (let i = 0; i < 9; i++) during.push(await place())
  fighting = false
  emit('combat', 'zombie is DOWN')
  const after = []
  for (let i = 0; i < 3; i++) after.push(await place())
  assert.deepStrictEqual(clicks, [])
  assert.ok(during[0].includes(refusal('zombie')), `the bot's own refusal: ${during[0]}`)
  for (const text of [...during.slice(1), ...after]) assert.match(text, /^refused: unread fight events \(threat\)\./)

  const read = textOf(await call(srv, 'wait_events', { timeout: 1 }))
  assert.ok(read.includes('zombie is DOWN'), read)
  assert.ok(!(await place()).startsWith('refused'))
  assert.deepStrictEqual(clicks, ['after the fight'])
})
