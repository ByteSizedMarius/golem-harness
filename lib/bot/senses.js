'use strict'

const fs = require('fs')
const { Vec3 } = require('vec3')
const { classifySound } = require('../sounds')
const { ambientChange, sameVein } = require('../wake')
const { LEGACY_1710, ROOT } = require('./config')

let bot, compass, emitEvent, ck, seenNow, shared, findVisible

// ---- SOUND TABLE PIN (07-15): the audio twin of the viewer atlas bug, finally dead. minecraft-data's
// 1.21.11 sounds.json is shifted off the REAL game registry (all 1838 ids wrong — a stale extra entry
// near the top cascades the whole file). The 07-13 "phantom on Peaceful" decoded: pig.saddle was
// entity.pig.step, chicken.hurt was entity.chicken.step, phantom.swoop was entity.pig.ambient —
// real animals near the helmsman, misheard. sounds-1.21.11.json is ground truth, generated from the helmsman's own
// 1.21.11.jar data generator (registries.json protocol_ids). mineflayer's sound.js resolves packet
// soundIds via bot.registry.sounds, so overriding that table is the whole fix.
function wireSoundTablePin () {
  bot.once('spawn', () => {
    try {
      if (bot.version === '1.21.11') {
        const fixed = JSON.parse(fs.readFileSync(ROOT + '/sounds-1.21.11.json', 'utf8'))
        bot.registry.sounds = fixed
        console.log('[bot] sound table pinned: ' + Object.keys(fixed).length + ' real 1.21.11 ids')
      } else {
        console.log('[bot] sound table pin SKIPPED — version ' + bot.version + ' has no ground-truth table; hearings may drift')
      }
    } catch (e) { console.log('[bot] sound table pin failed: ' + e.message) }
  })
}

// ---- EARS: the server only sends sounds a player would hear, so hearing is fair by construction.
// Danger tier (lava / fuse / explosion) emits an event at most once per 45s per category — enough
// to wake me, impossible to flood me. Everything else lands in a rolling buffer read via /listen
// and a one-line Hear: in /scene. Entity sounds are categorized by SPECIES, counted not streamed.
const HEARD = []
const dangerHeard = {}
let lastThunder = 0
let lastThunderPos = null
function onSound(name, position) {
  try {
    const n = String(name)
    const cat = classifySound(n, { legacy1710: LEGACY_1710 })
    if (!cat) return
    if (cat === 'thunder') { lastThunder = Date.now(); lastThunderPos = position || null }
    const here = bot.entity.position
    const dist = position ? Math.round(position.distanceTo(here)) : null
    const dir = position ? compass(position.x - here.x, position.z - here.z) : '?'
    HEARD.push({ cat, dir, dist, t: Date.now() })
    if (HEARD.length > 80) HEARD.shift()
    // 1.7.10 lightning plays an explosion where its thunder struck.
    if (cat === 'explosion' && position && lastThunderPos && Date.now() - lastThunder < 2000 &&
      position.distanceTo(lastThunderPos) <= 2) return
    if (cat === 'lava' || cat === 'fuse' || cat === 'explosion') {
      if (Date.now() - (dangerHeard[cat] || 0) > 45000) {
        dangerHeard[cat] = Date.now()
        emitEvent('hear', `${cat.toUpperCase()} ${dir} ~${dist} — heard it`)
      }
    }
  } catch (e) {}
}
function wireHearing () {
  bot.on('soundEffectHeard', (name, position) => onSound(name, position))
}
function hearSummary(windowMs) {
  const now = Date.now()
  const fresh = HEARD.filter(h => now - h.t < windowMs)
  if (!fresh.length) return null
  const byCat = {}
  for (const h of fresh) {
    const g = byCat[h.cat] || (byCat[h.cat] = { n: 0, nearest: Infinity, dirs: {} })
    g.n++; g.dirs[h.dir] = (g.dirs[h.dir] || 0) + 1
    if (h.dist != null && h.dist < g.nearest) g.nearest = h.dist
  }
  return Object.entries(byCat).sort((a, b) => b[1].n - a[1].n).slice(0, 5)
    .map(([c, g]) => `${c} ${Object.entries(g.dirs).sort((a, b) => b[1] - a[1])[0][0]}${g.nearest < Infinity ? ' ~' + g.nearest : ''}${g.n > 1 ? ' (x' + g.n + ')' : ''}`)
    .join('; ')
}

// ---- FELT WORLD-CHANGES: blockUpdate near me, with my OWN digs/places filtered out (bot.dig and
// bot.placeBlock are wrapped once to stamp their cells). Digested — one [event] line per 6s burst
// at most; the co-player's pickaxe becomes something I feel instead of stale-map surprise.
const recentOwnEdits = new Map()
const stampOwnEdit = (p) => { if (p) { recentOwnEdits.set(ck(p.x, p.y, p.z), Date.now()); if (recentOwnEdits.size > 500) { const c = Date.now() - 20000; for (const [k, t] of recentOwnEdits) if (t < c) recentOwnEdits.delete(k) } } }
// (07-14) wrap at SPAWN, not module scope — bot.dig/placeBlock are plugin-injected and racing
// them here lost this boot ("reading 'bind' of undefined"), which would have narrated every own
// dig/place as a world-change.
function wireOwnEditStamps () {
  bot.once('spawn', () => {
    try {
      const origDig = bot.dig.bind(bot)
      bot.dig = (block, ...a) => { try { stampOwnEdit(block && block.position) } catch (e) {} ; return origDig(block, ...a) }
      const origPlace = bot.placeBlock.bind(bot)
      bot.placeBlock = (ref, face) => { try { stampOwnEdit(ref.position.plus(face)) } catch (e) {} ; return origPlace(ref, face) }
    } catch (e) { console.log('[bot] own-edit wrap skipped:', e.message) }
  })
}

let changeBuf = []
let lastChangeEmit = 0
function noteWorldChange (oldB, newB) {
  try {
    if (!oldB || !newB || oldB.name === newB.name) return
    const p = newB.position || (oldB && oldB.position)
    if (!p) return
    const d = bot.entity.position.distanceTo(p)
    if (d > 16) return
    const own = recentOwnEdits.get(ck(p.x, p.y, p.z))
    if (own && Date.now() - own < 8000) return
    if (!seenNow(p)) return
    changeBuf.push({ from: oldB.name, to: newB.name, dir: compass(p.x - bot.entity.position.x, p.z - bot.entity.position.z), d: Math.round(d), t: Date.now() })
    if (changeBuf.length > 200) changeBuf.splice(0, changeBuf.length - 200)
  } catch (e) {}
}
function wireWorldChangeNotes () {
  bot.on('blockUpdate', noteWorldChange)
}
function worldChangeEvent () {
  try {
    if (!changeBuf.length || Date.now() - lastChangeEmit < 6000) return
    const batch = changeBuf; changeBuf = []
    const byKind = {}
    for (const c of batch) {
      const k = `${c.from}→${c.to}`
      const g = byKind[k] || (byKind[k] = { n: 0, dirs: {}, nearest: Infinity })
      g.n++; g.dirs[c.dir] = (g.dirs[c.dir] || 0) + 1
      if (c.d < g.nearest) g.nearest = c.d
    }
    const line = Object.entries(byKind).sort((a, b) => b[1].n - a[1].n).slice(0, 3)
      .map(([k, g]) => `${k}${g.n > 1 ? ' x' + g.n : ''} ${Object.entries(g.dirs).sort((a, b) => b[1] - a[1])[0][0]} ~${g.nearest}`)
      .join('; ')
    lastChangeEmit = Date.now()
    emitEvent('world', `changed near me: ${line}`, null, { quiet: batch.every(c => ambientChange(c.from, c.to)) })
  } catch (e) {}
}
function wireWorldChangeEvents () {
  setInterval(worldChangeEvent, 3000)
}

// ---- ORE CALLOUT: passive prospector sense (07-17, "your ore senses need tuning" — the helmsman).
// A player's eyes are always on; the pilot's /find only fires when asked. Every 4s, sweep ore in
// lit sight within 12 and announce anything new. Announced set is pruned by distance+age so it
// can't OOM (the SEEN lesson).
const ORE_ANNOUNCED = new Map()   // "x,y,z" -> { t, name }
let ORE_IDS = null
function oreCallout () {
  try {
    if (!shared.ready || !bot.entity || !shared.mcData) return
    if (!ORE_IDS) ORE_IDS = Object.values(shared.mcData.blocksByName)
      .filter(b => /_ore$/.test(b.name) || b.name === 'ancient_debris').map(b => b.id)
    const here = bot.entity.position
    for (const [k, ore] of ORE_ANNOUNCED) {                    // prune: >10min old or >48 away
      const [x, y, z] = k.split(',').map(Number)
      if (Date.now() - ore.t > 600000 || here.distanceTo(new Vec3(x, y, z)) > 48) ORE_ANNOUNCED.delete(k)
    }
    const fresh = {}
    for (const v of findVisible(ORE_IDS, 12, 12)) {
      const k = `${v.pos.x},${v.pos.y},${v.pos.z}`
      if (ORE_ANNOUNCED.has(k)) continue
      const b = bot.blockAt(v.pos)
      // A block of a vein already announced is recorded without a callout.
      const known = !!b && sameVein(ORE_ANNOUNCED, b.name, v.pos)
      ORE_ANNOUNCED.set(k, { t: Date.now(), name: b ? b.name : null })
      if (!b || known) continue
      const dx = v.pos.x - Math.floor(here.x), dy = v.pos.y - Math.floor(here.y), dz = v.pos.z - Math.floor(here.z)
      const dir = dx === 0 && dz === 0 ? (dy < 0 ? 'below' : dy > 1 ? 'above' : 'here') : compass(dx, dz)
      const g = fresh[b.name] = fresh[b.name] || { n: 0, dir, d: Math.round(v.dist), y: v.pos.y }
      g.n++
    }
    for (const [name, g] of Object.entries(fresh))
      emitEvent('ore', `${name}${g.n > 1 ? ' x' + g.n : ''} in view ${g.dir} ~${g.d} (y${g.y})`)
  } catch (e) {}
}
function wireOreCallout () {
  setInterval(oreCallout, 4000)
}

function createSenses (ctx) {
  Object.assign(ctx, { HEARD, dangerHeard, onSound, hearSummary, recentOwnEdits, stampOwnEdit, noteWorldChange, worldChangeEvent, ORE_ANNOUNCED, oreCallout })
}

function bindSenses (ctx) {
  ({ bot, compass, emitEvent, ck, seenNow, shared, findVisible } = ctx)
}

module.exports = { createSenses, bindSenses, wireSoundTablePin, wireHearing, wireOwnEditStamps, wireWorldChangeNotes, wireWorldChangeEvents, wireOreCallout }
