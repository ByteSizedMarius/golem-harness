'use strict'
const test = require('node:test')
const assert = require('node:assert')
const registry = require('prismarine-registry')('1.21.11')
const ChatMessage = require('prismarine-chat')(registry)
const { WAKE_KINDS, QUIET_MAX, serverLines, rateLimit, foldQuiet, quietText } = require('../lib/server-msg')
const { loadBotFunctions } = require('./helpers')

const line = serverLines(registry.language)
const chat = (json) => ChatMessage.fromNotch(JSON.stringify(json))
const tr = (translate, ...args) => ({ translate, with: args.map((a) => (typeof a === 'string' ? { text: a } : a)) })

test('deaths, joins, leaves and achievements are server lines by their 1.21.11 translate keys', () => {
  assert.deepStrictEqual(line(chat(tr('death.attack.mob', 'Steve', tr('entity.minecraft.zombie')))), { kind: 'death', text: 'Steve was slain by Zombie' })
  assert.deepStrictEqual(line(chat(tr('death.fell.accident.generic', 'Steve'))), { kind: 'death', text: 'Steve fell from a high place' })
  assert.deepStrictEqual(line(chat(tr('multiplayer.player.joined', 'Steve'))), { kind: 'joined', text: 'Steve joined the game' })
  assert.deepStrictEqual(line(chat(tr('multiplayer.player.left', 'Steve'))), { kind: 'left', text: 'Steve left the game' })
  assert.deepStrictEqual(line(chat(tr('chat.type.advancement.task', 'Steve', '[Stone Age]'))), { kind: 'achievement', text: 'Steve has made the advancement [Stone Age]' })
})

test('the 1.7.10 achievement key and a wrapped component are server lines too', () => {
  assert.deepStrictEqual(line(chat(tr('chat.type.achievement', 'Steve', tr('achievement.openInventory')))),
    { kind: 'achievement', text: 'Steve has just earned the achievement achievement.openInventory' })
  assert.deepStrictEqual(line(chat({ text: '', extra: [tr('multiplayer.player.joined', 'Steve')] })), { kind: 'joined', text: 'Steve joined the game' })
  assert.deepStrictEqual(line(chat(tr('death.attack.someMod', 'Steve', 'Golem'))), { kind: 'death', text: 'death.attack.someMod: Steve, Golem' })
})

test('a 1.7.10 achievement that ViaVersion sends with the format as its key is an achievement line', () => {
  const name = { color: 'green', translate: 'Taking Inventory' }
  const hover = { action: 'show_text', value: { text: '', extra: [name, { '': '\n' }, { italic: 1, translate: 'Achievement' }, { '': '\n' }, { translate: "Press 'E' to open your inventory" }] } }
  const json = {
    translate: '%s has just earned the achievement %s',
    with: [
      { text: 'Claude', click_event: { action: 'suggest_command', value: '/msg Claude ', command: '/msg Claude ' } },
      { text: '[', color: 'green', hover_event: hover, extra: [{ ...name, hover_event: hover }, { '': ']' }] }
    ]
  }
  assert.deepStrictEqual(line(chat(json)), { kind: 'achievement', text: 'Claude has just earned the achievement [Taking Inventory]' })
})

test('plain-text server lines are read by their wording', () => {
  const rows = [
    ['Steve was slain by Zombie', 'death'],
    ['Steve drowned', 'death'],
    ['Steve joined the game', 'joined'],
    ['Steve left the game', 'left'],
    ['Steve has just earned the achievement [Taking Inventory]', 'achievement'],
    ['Steve has made the advancement [Stone Age]', 'achievement']
  ]
  for (const [text, kind] of rows) assert.deepStrictEqual(line(chat({ text })), { kind, text }, text)
})

test('player chat stays chat however much it reads like a server line', () => {
  assert.strictEqual(line(chat({ text: 'Alex was slain by Zombie' })).kind, 'death', 'control')
  for (const json of [
    tr('chat.type.text', 'Steve', 'Alex was slain by Zombie'),
    tr('chat.type.emote', 'Steve', 'joined the game'),
    tr('chat.type.announcement', 'Steve', 'Alex left the game'),
    tr('commands.message.display.incoming', 'Steve', 'Alex joined the game'),
    { text: '<Steve> Alex was slain by Zombie' },
    { text: 'Eve: was slain by Zombie' },
    { text: '<Eve> Bob joined the game' },
    { text: '[Server] Alex joined the game' },
    { text: '* Steve joined the game' },
    { text: 'Steve whispers to you: Alex joined the game' },
    { text: ' ' }
  ]) {
    const msg = chat(json)
    assert.strictEqual(line(msg), null, msg.toString())
  }
})

test('any other system line is a server line of kind other, a key the language lacks included', () => {
  assert.deepStrictEqual(line(chat(tr('commands.time.set', '6000'))), { kind: 'other', text: 'Set the time to 6000' })
  assert.deepStrictEqual(line(chat({ text: 'World saved' })), { kind: 'other', text: 'World saved' })
  assert.deepStrictEqual(line(chat(tr('mod.backup.done', '3'))), { kind: 'other', text: 'mod.backup.done: 3' })
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.deepStrictEqual(line(chat(tr(key, 'Steve'))), { kind: 'other', text: `${key}: Steve` }, key)
  }
})

// serverMessage of bot.js over the events it logs, with served set to the event id the last reply carried.
function serverHarness () {
  const events = []
  const env = {
    bot: { registry },
    WAKE_KINDS,
    serverLines,
    foldQuiet,
    quietText,
    serverLine: null,
    serverWakes: rateLimit({ max: 6, windowMs: 60000 }),
    quietServer: [],
    streams: { eventsServed: 0 },
    emitEvent: (kind, msg, data, opts = {}) => {
      const ev = { id: events.length + 1, kind, msg, data: JSON.parse(JSON.stringify(data)), quiet: !!opts.quiet }
      events.push(ev)
      return ev
    }
  }
  const { serverMessage } = loadBotFunctions(['serverMessage'], env)
  return { env, events, serverMessage }
}

test('a death wakes the pilot, the 7th in a minute arrives quiet, and the same line as player chat is no server event', () => {
  const { events, serverMessage } = serverHarness()
  const died = chat(tr('death.attack.mob', 'Steve', tr('entity.minecraft.zombie')))
  serverMessage(died, 'chat')
  serverMessage(died, 'game_info')
  assert.deepStrictEqual(events, [])
  for (let i = 0; i < 7; i++) serverMessage(died, 'system')
  assert.deepStrictEqual(events[0], { id: 1, kind: 'server', msg: 'Steve was slain by Zombie', data: { kind: 'death' }, quiet: false })
  assert.deepStrictEqual(events.map((e) => e.quiet), [false, false, false, false, false, false, true])
  assert.strictEqual(events[6].msg, 'Steve was slain by Zombie')
})

test('an unknown system line arrives quiet as a server event', () => {
  const { events, serverMessage } = serverHarness()
  serverMessage(chat({ text: 'World saved' }), 'system')
  assert.deepStrictEqual(events, [{ id: 1, kind: 'server', msg: 'World saved', data: { kind: 'other', text: 'World saved', repeats: 0, merged: 0 }, quiet: true }])
})

test('quiet server lines merge repeats and, past the bound, later lines into the newest unsent event, saying how many', () => {
  const { env, events, serverMessage } = serverHarness()
  const say = (text) => serverMessage(chat({ text }), 'system')
  say('Lag spike')
  say('Lag spike')
  say('Lag spike')
  assert.deepStrictEqual(events.map((e) => e.msg), ['Lag spike (seen 3 times)'])
  assert.deepStrictEqual({ ...events[0].data }, { kind: 'other', text: 'Lag spike', repeats: 2, merged: 0 }, 'the counts the MCP server merges by')
  for (let i = 1; i < QUIET_MAX; i++) say(`line ${i}`)
  assert.strictEqual(events.length, QUIET_MAX, 'control: the bound is full')
  for (let i = 0; i < 1000; i++) say(`flood ${i}`)
  assert.strictEqual(events.length, QUIET_MAX, 'the bound holds')
  assert.strictEqual(events[QUIET_MAX - 1].msg, `line ${QUIET_MAX - 1} (1000 later server lines merged into this one)`)
  env.streams.eventsServed = events.length
  say('after the reply')
  assert.deepStrictEqual([events.length, events[QUIET_MAX].msg], [QUIET_MAX + 1, 'after the reply'], 'a sent event merges nothing more')
  assert.strictEqual(events[QUIET_MAX - 1].msg, `line ${QUIET_MAX - 1} (1000 later server lines merged into this one)`)
})

test('the rate limit takes max lines per window', () => {
  const limit = rateLimit({ max: 2, windowMs: 1000 })
  assert.deepStrictEqual([limit.take(0), limit.take(10), limit.take(20), limit.take(30)], [true, true, false, false])
  assert.strictEqual(limit.take(1000), true)
  assert.strictEqual(limit.take(1010), true)
  assert.strictEqual(limit.take(1020), false)
})
