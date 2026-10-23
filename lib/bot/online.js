'use strict'

let bot

// The tab list by uuid. ViaProxy adds a second, short-lived uuid for a name right before its player entity spawns.
const ONLINE = new Map()

function playerInfo (packet) {
  for (const item of packet.data) {
    if (packet.action.add_player && !ONLINE.has(item.uuid)) ONLINE.set(item.uuid, {})
    const entry = ONLINE.get(item.uuid)
    if (!entry) continue
    if (packet.action.add_player) entry.name = item.player.name
    if (packet.action.update_listed) entry.listed = item.listed
  }
}

function playerRemove (packet) {
  for (const uuid of packet.players) ONLINE.delete(uuid)
}

function onlineNames () {
  const names = new Set()
  for (const { name, listed } of ONLINE.values()) if (name && listed === 1 && name !== bot.username) names.add(name)
  return [...names]
}

function wireOnline () {
  bot._client.on('player_info', playerInfo)
  bot._client.on('player_remove', playerRemove)
}

function createOnline (ctx) {
  Object.assign(ctx, { onlineNames })
}

function bindOnline (ctx) {
  ({ bot } = ctx)
}

module.exports = { createOnline, bindOnline, wireOnline }
