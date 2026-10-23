'use strict'
// The online players come from the tab list packets, the bot itself left out.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const { wiredSource, loadBotFunctions } = require('./helpers')

// UUIDs shortened to their first block, as measured through ViaProxy on 1.7.10.
const PROBE_TAB = '7ffc6632'
const PROBE_ENTITY = '3f0ca0c8'
const CLAUDE_SERVER = '40aa0aa3'
const CLAUDE_TAB = 'e55406cc'

function tabList () {
  const client = new EventEmitter()
  const lines = [...wiredSource().matchAll(/^bot\._client\.on\('(?:player_info|player_remove)', ([A-Za-z_$][\w$]*)\)$/gm)]
  assert.strictEqual(lines.length, 2, 'one wired player_info and one wired player_remove listener')
  const code = lines.map((m) => m[0]).join('\n')
  const ctx = loadBotFunctions([...lines.map((m) => m[1]), 'onlineNames'], { bot: { username: 'Claude', _client: client }, ONLINE: new Map() }, code)
  vm.runInContext(code, ctx)
  return { client, names: () => [...ctx.onlineNames()] }
}

// Action 63 as the 1.21.11 client decodes it.
const ADD = { _value: 63, add_player: true, initialize_chat: true, update_game_mode: true, update_listed: true, update_latency: true, update_display_name: true, update_hat: false, update_list_order: false }
const add = (uuid, name, listed, latency) => ({ action: ADD, data: [{ uuid, player: { name, properties: [] }, gamemode: 0, listed, latency }] })
const latency = (uuid, ms) => ({ action: { _value: 16, update_latency: true }, data: [{ uuid, latency: ms }] })
const listed = (uuid, value) => ({ action: { _value: 8, update_listed: true }, data: [{ uuid, listed: value }] })
const remove = (uuid) => ({ players: [uuid] })

test('a player shows once from the tab add to the quit, through the adds and removes that come with its entity', () => {
  const { client, names } = tabList()
  const seen = []
  const step = (packet, name = 'player_info') => {
    client.emit(name, packet)
    seen.push(names())
  }
  step(add(CLAUDE_SERVER, 'Claude', 1, -1))
  step(add(CLAUDE_TAB, 'Claude', 1, 3))
  step(remove(CLAUDE_SERVER), 'player_remove')
  step(add(PROBE_TAB, 'Probe', 1, 1000))
  step(add(PROBE_ENTITY, 'Probe', 1, -1))
  step(remove(PROBE_ENTITY), 'player_remove')
  step(latency(PROBE_TAB, 2))
  step(add(PROBE_ENTITY, 'Probe', 0, -1))
  step(remove(PROBE_ENTITY), 'player_remove')
  step(latency(PROBE_TAB, 35))
  step(remove(PROBE_TAB), 'player_remove')
  assert.deepStrictEqual(seen, [[], [], [], ['Probe'], ['Probe'], ['Probe'], ['Probe'], ['Probe'], ['Probe'], ['Probe'], []])
})

test('a tab entry shows only while its last listed value is 1', () => {
  const { client, names } = tabList()
  const seen = []
  const step = (packet) => {
    client.emit('player_info', packet)
    seen.push(names())
  }
  step(add(PROBE_TAB, 'Probe', 0, 1000))
  step(listed(PROBE_TAB, 1))
  step(latency(PROBE_TAB, 2))
  step(listed(PROBE_TAB, 0))
  step(latency(PROBE_TAB, 3))
  assert.deepStrictEqual(seen, [[], ['Probe'], ['Probe'], [], []])
})

test('an update for a uuid the tab list never added shows nothing', () => {
  const { client, names } = tabList()
  client.emit('player_info', listed(PROBE_TAB, 1))
  client.emit('player_info', latency(PROBE_TAB, 2))
  assert.deepStrictEqual(names(), [])
  client.emit('player_info', { action: { _value: 1, add_player: true }, data: [{ uuid: PROBE_TAB, player: { name: 'Probe', properties: [] } }] })
  assert.deepStrictEqual(names(), [], 'the listed value sent before the add is not kept')
})
