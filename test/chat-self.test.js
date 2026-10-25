'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')

// The configured name stays the default, Claude.
delete process.env.MC_USER
const { createStreams, bindStreams, wireChatCapture } = require('../lib/bot/streams')

test('the chat log drops the bot\'s own lines by the name the server gave it, not the configured one', () => {
  const bot = Object.assign(new EventEmitter(), { username: 'Nick' })
  const ctx = { bot, chatPointer: () => null, shared: { ready: false } }
  createStreams(ctx)
  bindStreams(ctx)
  wireChatCapture()
  bot.emit('chat', 'Nick', 'on my way')
  bot.emit('chat', 'Claude', 'hi')
  assert.deepStrictEqual(ctx.chatLog.read(0).map((m) => m.from), ['Claude'])
})
