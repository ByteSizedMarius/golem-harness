'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { createChatLog } = require('../lib/chat-log')
const { playerNamed } = require('../lib/players')
const { crumbCentre } = require('../lib/walk')
const { loadBotFunctions, routeHandler } = require('./helpers')

const SELF = 'Claude'
const ME = new Vec3(0.3, 64, 0.7)
const WALL_X = 10
const ck = (x, y, z) => x + ',' + y + ',' + z
// Objects from the bot.js context carry its own Object prototype.
const plain = (v) => JSON.parse(JSON.stringify(v))
const steve = (x, y, z) => ({ id: 7, type: 'player', name: 'player', username: 'Steve', position: new Vec3(x, y, z), metadata: [0] })

// Lit open air at noon, with a stone wall across x WALL_X when walled.
const blockAt = (walled) => (pos) => {
  const p = pos.floored()
  const stone = walled && p.x === WALL_X
  return { name: stone ? 'stone' : 'air', boundingBox: stone ? 'block' : 'empty', position: p, light: stone ? 0 : 15, skyLight: stone ? 0 : 15 }
}

// pushChat over the bot's real whereIs and sight, the bot at ME with the given player entities.
function chatRig ({ players = [], walled = false, ready = true, reflexes = [{ name: 'combat', fairFill: () => ({ cells: new Set() }) }] } = {}) {
  const chatLog = createChatLog({ self: SELF })
  const env = {
    console: { log () {} },
    chatLog,
    pointerOf: () => null,
    shared: { ready },
    bot: { entity: { position: ME }, entities: Object.fromEntries(players.map((p) => [p.id, p])), blockAt: blockAt(walled), time: { timeOfDay: 6000 }, game: { dimension: 'overworld' } },
    playerNamed,
    staleEntities: new Set(),
    playerCrumbs: {},
    reflexes,
    crumbCentre,
    ck,
    Vec3,
    ESTIMATED_LIGHT: new Map()
  }
  const { pushChat } = loadBotFunctions(['pushChat'], env)
  // The line as logged, without id, t and age, or null when none was logged.
  const say = (from, msg, kind = 'chat') => {
    const before = chatLog.cursor
    pushChat(from, msg, kind)
    if (chatLog.cursor === before) return null
    const [line] = chatLog.read(before)
    const { id, t, age, ...rest } = plain(line)
    return rest
  }
  return { say, chatLog }
}

const ME_ROUNDED = { x: 0, y: 64, z: 1 }

test('a chat line from a player in sight carries their position, distance and bearing and where the bot stood', () => {
  const { say } = chatRig({ players: [steve(13.3, 64, -2.6)] })
  assert.deepStrictEqual(say('Steve', 'over here'), {
    from: 'Steve', msg: 'over here', kind: 'chat',
    where: { live: true, pos: { x: 13, y: 64, z: -3 }, dist: 13, bearing: 'E' },
    me: ME_ROUNDED
  })
})

test('a whisper carries the same', () => {
  const { say } = chatRig({ players: [steve(13.3, 64, -2.6)] })
  assert.deepStrictEqual(say('Steve', 'psst', 'whisper'), {
    from: 'Steve', msg: 'psst', kind: 'whisper',
    where: { live: true, pos: { x: 13, y: 64, z: -3 }, dist: 13, bearing: 'E' },
    me: ME_ROUNDED
  })
})

test('a speaker known only by the nametag gives a rough distance and a bearing, no position', () => {
  const { say } = chatRig({ players: [steve(31.2, 64, 1.3)], walled: true })
  assert.deepStrictEqual(say('Steve', 'hello'), { from: 'Steve', msg: 'hello', kind: 'chat', where: { live: true, nametag: true, dist: 30, bearing: 'E' }, me: ME_ROUNDED })
})

test('a speaker never seen this session is flagged unseen', () => {
  const { say } = chatRig()
  assert.deepStrictEqual(say('Alex', 'anyone home?'), { from: 'Alex', msg: 'anyone home?', kind: 'chat', where: { live: false, unseen: true }, me: ME_ROUNDED })
})

test('a player loaded behind a wall past the nametag range leaks no position, distance or bearing', () => {
  const open = chatRig({ players: [steve(70.5, 64, 0.5)] }).say('Steve', 'hi')
  assert.strictEqual(open.where.live && typeof open.where.pos, 'object', 'control: in sight without the wall')
  const line = chatRig({ players: [steve(70.5, 64, 0.5)], walled: true }).say('Steve', 'hi')
  assert.deepStrictEqual(line.where, { live: false, unseen: true })
  assert.doesNotMatch(JSON.stringify(line), /"pos"|"dist"|"bearing"|\b7[01]\b/)
})

test('a line before spawn and a line whose lookup throws are logged without the situation', () => {
  const before = chatRig({ players: [steve(13.3, 64, -2.6)], ready: false })
  assert.deepStrictEqual(before.say('Steve', 'are you there?'), { from: 'Steve', msg: 'are you there?', kind: 'chat' })
  const broken = chatRig({ players: [steve(13.3, 64, -2.6)], reflexes: [] })
  assert.deepStrictEqual(broken.say('Steve', 'hello?'), { from: 'Steve', msg: 'hello?', kind: 'chat' })
  assert.strictEqual(broken.chatLog.cursor, 1)
})

test('the bot\'s own chat line stays out of the log', () => {
  const { say, chatLog } = chatRig({ players: [steve(13.3, 64, -2.6)] })
  assert.strictEqual(say(SELF, 'on my way'), null)
  assert.strictEqual(chatLog.cursor, 0)
})

test('a read gives each line its age in whole seconds and leaves the stored line as it was', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 })
  const log = createChatLog({ self: SELF })
  const line = log.push('Steve', 'hi', 'chat')
  assert.deepStrictEqual(log.read(0), [{ id: 1, t: 1000000, from: 'Steve', msg: 'hi', kind: 'chat', age: 0 }])
  t.mock.timers.tick(2999)
  assert.strictEqual(log.read(0)[0].age, 2)
  t.mock.timers.tick(1)
  assert.strictEqual(log.read(0)[0].age, 3)
  assert.deepStrictEqual(line, { id: 1, t: 1000000, from: 'Steve', msg: 'hi', kind: 'chat' })
})

test('tick and chatlog carry each line\'s situation and age', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 })
  const { chatLog, say } = chatRig({ players: [steve(13.3, 64, -2.6)] })
  say('Steve', 'over here')
  t.mock.timers.tick(4200)
  const expected = {
    id: 1, t: 1000000, from: 'Steve', msg: 'over here', kind: 'chat',
    where: { live: true, pos: { x: 13, y: 64, z: -3 }, dist: 13, bearing: 'E' },
    me: ME_ROUNDED,
    age: 4
  }

  const tick = routeHandler('/tick', {
    shared: { ready: true },
    bot: { entity: { position: ME }, health: 20, food: 20, experience: { level: 0 }, heldItem: null, oxygenLevel: 20 },
    waterState: () => null,
    reflexes: [{ name: 'combat', fairFill: () => ({ cells: new Set() }) }],
    liveEntities: () => [],
    HOSTILE_NAMES: new Set(),
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    BOOT_ID: 'b0',
    chatLog,
    streams: { eventSeq: 0, eventsServed: 0 },
    eventLog: [],
    jobs: { list: () => [] },
    lastTickSnap: null
  })
  tick.handle({ query: { chat: '0' } }, tick.res)
  assert.strictEqual(tick.res.error, undefined, tick.res.error && tick.res.error.message)
  assert.deepStrictEqual(plain(tick.res.body.chat.messages), [expected])

  const chatlog = routeHandler('/chatlog', { chatLog })
  chatlog.handle({ query: { since: '0' } }, chatlog.res)
  assert.deepStrictEqual(plain(chatlog.res.body.messages), [expected])
})
