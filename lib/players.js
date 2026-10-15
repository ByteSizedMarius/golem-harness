'use strict'

// A player enters presence at this distance or closer and leaves past PRESENCE_LEAVE.
const PRESENCE_ENTER = 60
const PRESENCE_LEAVE = 68
// The least time between two presence events about one player.
const PRESENCE_GAP_MS = 30000
// A player out of sight this long is forgotten.
const PRESENCE_FORGET_MS = 600000
// The most players presence remembers. Past it the longest unseen go first, never one perceived now.
const PRESENCE_MAX = 200
const FYI = 'FYI only, no reply or action needed.'

const never = () => false

// The entity of the player named name, or null. skip(entity) leaves an entity out.
function playerNamed (entities, name, skip = never) {
  for (const e of Object.values(entities || {})) {
    if (e && e.type === 'player' && e.username === name && !skip(e)) return e
  }
  return null
}

// The player entities other than self that have a name and a position.
function playersAround (entities, self, skip = never) {
  return Object.values(entities || {}).filter((e) => e && e !== self && e.type === 'player' && e.username && e.position && !skip(e))
}

// sightings: { name, tier: 'seen' | 'nametag', dist, bearing } for each player perceived now.
// state maps a name to what was last reported about it and is updated in place.
// A name in quiet is tracked without events. Returns the events due.
function presenceUpdate (state, sightings, { now, quiet = new Set() }) {
  const events = []
  const byName = new Map(sightings.map((s) => [s.name, s]))
  for (const name of new Set([...state.keys(), ...byName.keys()])) {
    const s = byName.get(name)
    const p = state.get(name) || { reported: 'none', near: false, lastT: -Infinity, last: null, seenT: now }
    if (s) p.seenT = now
    p.near = !!s && s.dist <= (p.near ? PRESENCE_LEAVE : PRESENCE_ENTER)
    if (p.near) p.last = { dist: s.dist, bearing: s.bearing }
    const tier = p.near ? s.tier : 'none'
    if (tier !== p.reported && now - p.lastT >= PRESENCE_GAP_MS) {
      p.reported = tier
      if (!quiet.has(name)) {
        p.lastT = now
        events.push({ name, tier, ...p.last })
      }
    }
    state.set(name, p)
  }
  for (const [name, p] of state) if (now - p.seenT > PRESENCE_FORGET_MS) state.delete(name)
  if (state.size > PRESENCE_MAX) {
    const unseen = [...state].filter(([name]) => !byName.has(name)).sort((a, b) => a[1].seenT - b[1].seenT)
    for (const [name] of unseen.slice(0, state.size - PRESENCE_MAX)) state.delete(name)
  }
  return events
}

function presenceText ({ name, tier, dist, bearing }) {
  if (tier === 'seen') return `${name} is in view, ${dist} blocks ${bearing}. ${FYI}`
  if (tier === 'nametag') return `${name} shows only by the nametag, about ${dist} blocks ${bearing}. ${FYI}`
  return `${name} is out of sight, last about ${dist} blocks ${bearing}. ${FYI}`
}

module.exports = { PRESENCE_ENTER, PRESENCE_LEAVE, PRESENCE_GAP_MS, PRESENCE_FORGET_MS, PRESENCE_MAX, playerNamed, playersAround, presenceUpdate, presenceText }
