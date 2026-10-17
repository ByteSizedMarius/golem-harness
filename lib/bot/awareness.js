'use strict'

const { playerNamed, playersAround, presenceUpdate, presenceText } = require('../players')
const { crumbCentre } = require('../walk')
const { POINT_RANGE, deictic, lookedAt } = require('../deixis')

let bot, entityPerceptible, compass, nametagVisible, shared, reflexes, seesLit, resetThreatState, follow, emitEvent

// ---- player locator (07-14, the helmsman's ask: "so we avoid 'where I am' and in case we ever get
// lost from each-other"). Consented co-op sense: live position when the server tracks them,
// last-seen breadcrumb (pos + age + heading) when out of range. Breadcrumbs update every 5s.
const playerCrumbs = Object.create(null)
// The ids of the entities loaded at the last dimension change that the server has not updated since.
const staleEntities = new Set()
function wireStaleEntities () {
  for (const ev of ['entitySpawn', 'entityMoved', 'entityUpdate', 'entityGone']) bot.on(ev, (e) => { if (e) staleEntities.delete(e.id) })
}
// The entities besides the body that the server updated since the last dimension change.
function liveEntities () {
  return Object.values(bot.entities).filter(e => e && e !== bot.entity && !staleEntities.has(e.id))
}
// The player named name by their entity. bot.players can lack the entity of a player the server tracks.
function playerEntity (name) {
  return playerNamed(bot.entities, name, (e) => staleEntities.has(e.id))
}
function trackedPlayers () {
  return playersAround(bot.entities, bot.entity, (e) => staleEntities.has(e.id))
}
// How the bot perceives player en: seen with the exact distance, by the nametag from its 5-block cube, or null.
function playerSighting (en, fill) {
  const me = bot.entity.position
  if (entityPerceptible(en, fill)) return { tier: 'seen', dist: Math.round(en.position.distanceTo(me)), bearing: compass(en.position.x - me.x, en.position.z - me.z) }
  if (!nametagVisible(en)) return null
  const c = crumbCentre(en.position)
  return { tier: 'nametag', dist: Math.round(c.distanceTo(me) / 5) * 5, bearing: compass(c.x - me.x, c.z - me.z) }
}
// The block a chat line points at with "here", "there", "this" or "that": the one its speaker looks at as
// it arrives, when the bot sees the speaker within POINT_RANGE and sees that block too. Else null.
function chatPointer (from, msg) {
  if (!shared.ready || !deictic(msg)) return null
  const en = playerEntity(from)
  if (!en || en.position.distanceTo(bot.entity.position) > POINT_RANGE) return null
  if (!entityPerceptible(en, reflexes.find(r => r.name === 'combat').fairFill(bot))) return null
  const eye = en.position.offset(0, en.crouching ? 1.27 : 1.62, 0)
  const hit = lookedAt(eye, en.headYaw ?? en.yaw, en.pitch, (p) => bot.blockAt(p))
  if (!hit || !seesLit(hit.cell, 64)) return null
  return { block: hit.block.name, x: hit.cell.x, y: hit.cell.y, z: hit.cell.z }
}
// A crumb's nametag is true when the player was known only by the nametag.
function recordCrumbs () {
  try {
    let fill = null
    for (const en of trackedPlayers()) {
      const name = en.username
      const seen = entityPerceptible(en, fill ??= reflexes.find(r => r.name === 'combat').fairFill(bot))
      if (!seen && !nametagVisible(en)) continue
      const prev = playerCrumbs[name]
      const pos = seen ? en.position.clone() : crumbCentre(en.position)
      playerCrumbs[name] = { pos, t: Date.now(), nametag: !seen, prev: prev ? { pos: prev.pos, t: prev.t } : null }
    }
  } catch (e) {}
}
function wireCrumbRecording () {
  setInterval(recordCrumbs, 5000)
}
let crumbDimension = null
function forgetCrumbsElsewhere () {
  if (bot.game.dimension === crumbDimension) return
  crumbDimension = bot.game.dimension
  for (const name of Object.keys(playerCrumbs)) delete playerCrumbs[name]
  staleEntities.clear()
  for (const e of Object.values(bot.entities)) if (e !== bot.entity) staleEntities.add(e.id)
  resetThreatState()
}
function wireCrumbForget () {
  bot.on('game', forgetCrumbsElsewhere)
}
// What the last presence event said about each player name.
const presence = new Map()
// True once the first player entity was logged against bot.players.
let playersLogged = false
// Emits a player event on each presence change, except for the followed player, whom follow reports.
function presenceTick () {
  try {
    const around = trackedPlayers()
    if (!playersLogged && around.length) {
      playersLogged = true
      const players = bot.players || {}
      const withEntity = Object.keys(players).filter(n => players[n] && players[n].entity)
      console.log(`[players] bot.players: ${Object.keys(players).join(', ') || 'none'} (with an entity: ${withEntity.join(', ') || 'none'}), player entities: ${around.map(e => e.username).join(', ')}`)
    }
    let fill = null
    const sightings = []
    for (const en of around) {
      const s = playerSighting(en, fill ??= reflexes.find(r => r.name === 'combat').fairFill(bot))
      if (s) sightings.push({ name: en.username, ...s })
    }
    const quiet = new Set(follow.followState ? [follow.followState.name] : [])
    for (const ev of presenceUpdate(presence, sightings, { now: Date.now(), quiet })) emitEvent('player', presenceText(ev), ev)
  } catch (e) {}
}
function wirePresenceTick () {
  setInterval(() => { if (shared.ready && bot.entity) presenceTick() }, 2000)
}
function crumbFix (c, me) {
  const agoSec = Math.round((Date.now() - c.t) / 1000)
  const bearing = compass(c.pos.x - me.x, c.pos.z - me.z)
  if (c.nametag) return { agoSec, dist: Math.round(c.pos.distanceTo(me) / 5) * 5, bearing }
  return { lastSeen: { x: Math.round(c.pos.x), y: Math.round(c.pos.y), z: Math.round(c.pos.z) }, agoSec, dist: +c.pos.distanceTo(me).toFixed(0), bearing }
}
// The nearest entity named name within radius that the body perceives, or undefined.
function nearestSeen (name, radius) {
  const here = bot.entity.position
  const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
  return liveEntities()
    .filter(en => en.position && (en.name === name || en.displayName === name) && en.position.distanceTo(here) <= radius && entityPerceptible(en, fill))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
}
function targetSeen (en) {
  return entityPerceptible(en, reflexes.find(r => r.name === 'combat').fairFill(bot))
}
// A player in sight gets the exact position, one known by the nametag a bearing and a rough distance, else the crumb.
function whereIs (name) {
  const me = bot.entity.position
  const en = playerEntity(name)
  const s = en && playerSighting(en, reflexes.find(r => r.name === 'combat').fairFill(bot))
  if (s && s.tier === 'seen') {
    const p = en.position
    return { name, live: true, pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, dist: s.dist, bearing: s.bearing }
  }
  if (s) return { name, live: true, nametag: true, dist: s.dist, bearing: s.bearing }
  const c = playerCrumbs[name]
  if (!c) return { name, live: false, note: 'never seen this session' }
  let heading = null
  if (c.prev && c.pos.distanceTo(c.prev.pos) > 1) heading = compass(c.pos.x - c.prev.pos.x, c.pos.z - c.prev.pos.z)
  return { name, live: false, ...crumbFix(c, me), heading }
}
// Players go by their username, every other entity by its type name.
function entityLabel (en) {
  return (en.type === 'player' && en.username) || en.name || en.username || en.displayName
}

function createAwareness (ctx) {
  Object.assign(ctx, { playerCrumbs, staleEntities, liveEntities, playerEntity, trackedPlayers, playerSighting, chatPointer, recordCrumbs, forgetCrumbsElsewhere, presence, presenceTick, crumbFix, nearestSeen, targetSeen, whereIs, entityLabel })
}

function bindAwareness (ctx) {
  ({ bot, entityPerceptible, compass, nametagVisible, shared, reflexes, seesLit, resetThreatState, follow, emitEvent } = ctx)
}

module.exports = { createAwareness, bindAwareness, wireStaleEntities, wireCrumbRecording, wireCrumbForget, wirePresenceTick }
