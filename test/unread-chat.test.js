'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createChatLog } = require('../lib/chat-log')
const { mcpServer, call } = require('./helpers')

const SELF = 'Claude'
const SECRET = 'meet-me-at-the-well-7731'

// bot.js replies over log: /tick reads the chat after its cursor, and every reply carries the unread chat.
const replyOver = (log) => (url) => {
  if (url.pathname !== '/tick') return log.withUnread({ ok: true, route: url.pathname })
  const since = Number(url.searchParams.get('chat') || 0)
  return log.withUnread({ ok: true, boot: 'b0', chat: { cursor: log.cursor, messages: log.read(since) }, events: { cursor: 0, list: [] }, threats: [], jobs: [] })
}

function noteOf (r) {
  assert.ok(r && r.result && Array.isArray(r.result.content), JSON.stringify(r).slice(0, 300))
  const notes = r.result.content.map((c) => c.text).filter((t) => t.startsWith('Unread chat:'))
  assert.ok(notes.length <= 1, `${notes.length} notes`)
  return notes[0] ?? null
}

test('a tool reply after other players chatted counts the lines and names the senders, never the text', async () => {
  const log = createChatLog({ self: SELF })
  const { srv } = mcpServer({ reply: replyOver(log) })
  assert.strictEqual(noteOf(await call(srv, 'state', {})), null, 'control: no chat, no note')
  log.push('Halbes', SECRET, 'chat')
  log.push('Halbes', 'what are u working on?', 'chat')
  log.push('Alex', SECRET, 'whisper')
  const r = await call(srv, 'digat', { x: 1, y: 64, z: 1 })
  assert.match(noteOf(r), /^Unread chat: 3 lines from Halbes, Alex\. .*\btick\b.*\bwait_events\b/)
  const all = JSON.stringify(r)
  for (const text of [SECRET, 'working on', 'unreadChat']) assert.ok(!all.includes(text), text)
})

test('reading chat through tick or wait_events ends the note', async () => {
  for (const [reader, args] of [['tick', {}], ['wait_events', { timeout: 1 }]]) {
    const log = createChatLog({ self: SELF })
    const { srv } = mcpServer({ reply: replyOver(log) })
    log.push('Halbes', 'what are u working on?', 'chat')
    assert.ok(noteOf(await call(srv, 'state', {})), `control before ${reader}`)
    assert.strictEqual(noteOf(await call(srv, reader, args)), null, `the ${reader} reply`)
    assert.strictEqual(noteOf(await call(srv, 'state', {})), null, `after ${reader}`)
    log.push('Halbes', 'hello?', 'chat')
    assert.match(noteOf(await call(srv, 'state', {})), /\b1 line from Halbes\b/, `a line after ${reader}`)
  }
})

test('the bot\'s own chat line and server events make no note', async () => {
  const log = createChatLog({ self: SELF })
  assert.strictEqual(log.push(SELF, 'on my way', 'chat'), null)
  const events = [{ id: 1, t: 1, kind: 'server', msg: 'Halbes joined the game' }, { id: 2, t: 2, kind: 'server', msg: 'World saved', quiet: true }]
  const reply = (url) => log.withUnread(url.pathname === '/events' ? { ok: true, cursor: 2, events } : { ok: true })
  const { srv } = mcpServer({ reply })
  assert.strictEqual(noteOf(await call(srv, 'state', {})), null, 'own chat line')
  assert.strictEqual(noteOf(await call(srv, 'events', { since: 0 })), null, 'server events')
  log.push('Halbes', 'hi', 'chat')
  assert.ok(noteOf(await call(srv, 'state', {})), 'control: another player\'s line')
})

test('the note takes only the count and the sender names from a reply, flattened', async () => {
  const unreadChat = { lines: 2, from: ['Hal\nbes', 'Alex'], msg: SECRET, messages: [{ msg: SECRET }] }
  const { srv } = mcpServer({ reply: () => ({ ok: true, unreadChat }) })
  const r = await call(srv, 'state', {})
  const note = noteOf(r)
  assert.match(note, /\b2 lines from Hal bes, Alex\b/)
  assert.ok(!JSON.stringify(r).includes(SECRET))
  const bad = mcpServer({ reply: () => ({ ok: true, unreadChat: { lines: '2', from: 'Halbes' } }) })
  const r2 = await call(bad.srv, 'state', {})
  assert.strictEqual(noteOf(r2), null)
  assert.ok(!JSON.stringify(r2).includes('unreadChat'))
})
