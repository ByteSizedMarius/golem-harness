'use strict'
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const registry = require('prismarine-registry')('1.21.11')
const ChatMessage = require('prismarine-chat')(registry)
const { WAKE_KINDS, serverLines, rateLimit, foldQuiet, quietText } = require('../lib/server-msg')
const { createChatLog } = require('../lib/chat-log')
const { loadBotFunctions, botSource, balanced } = require('./helpers')

// emitEvent, serverMessage and the GET /cursors handler of bot.js over one set of bot.js variables, before spawn.
function cursorsHarness () {
  const ctx = loadBotFunctions(['emitEvent', 'serverMessage'], {
    console: { log () {} },
    bot: { registry },
    WAKE_KINDS,
    serverLines,
    foldQuiet,
    quietText,
    serverLine: null,
    serverWakes: rateLimit({ max: 6, windowMs: 60000 }),
    quietServer: [],
    streams: { eventSeq: 0, eventsServed: 0, wakeEv: 0 },
    eventLog: [],
    lastTickSnap: null,
    shared: { ready: false },
    BOOT_ID: 'b0',
    chatLog: createChatLog({ self: () => 'Claude' }),
    ok: (res, body) => { res.body = body },
    err: (res, e) => { res.error = e }
  })
  const src = botSource()
  const at = src.indexOf("app.get('/cursors'")
  assert.ok(at >= 0, 'the /cursors handler not found in bot.js')
  const handle = vm.runInContext(`(req, res) => ${balanced(src, src.indexOf('=>', at))}`, ctx)
  const cursors = () => {
    const res = {}
    handle({ query: {} }, res)
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
    return JSON.parse(JSON.stringify(res.body))
  }
  const say = (text) => ctx.serverMessage(ChatMessage.fromNotch(JSON.stringify({ text })), 'system')
  return { ctx, cursors, say }
}

test('GET /cursors answers before spawn, leaves chat unread and lets a quiet server line keep folding', () => {
  const { ctx, cursors, say } = cursorsHarness()
  ctx.chatLog.push('Halbes', 'are you there?', 'chat')
  ctx.chatLog.push('Halbes', 'hello?', 'chat')
  ctx.emitEvent('hurt', 'ouch')
  say('Lag spike')
  assert.deepStrictEqual(cursors(), { boot: 'b0', chat: 2, ev: 2, wakeEv: 1 })
  assert.deepStrictEqual(ctx.chatLog.unread(), { lines: 2, from: ['Halbes'] })
  say('Lag spike')
  assert.deepStrictEqual(ctx.eventLog.map((e) => e.msg), ['ouch', 'Lag spike (seen 2 times)'])
  assert.strictEqual(ctx.lastTickSnap, null)
})

test('wakeEv names the newest event that wakes wait_events and skips quiet ones', () => {
  const { ctx, cursors, say } = cursorsHarness()
  assert.deepStrictEqual(cursors(), { boot: 'b0', chat: 0, ev: 0, wakeEv: 0 })
  ctx.emitEvent('hurt', 'ouch')
  say('World saved')
  assert.deepStrictEqual(cursors(), { boot: 'b0', chat: 0, ev: 2, wakeEv: 1 })
  ctx.emitEvent('nightfall', 'dusk')
  assert.deepStrictEqual(cursors(), { boot: 'b0', chat: 0, ev: 3, wakeEv: 3 })
})
