'use strict'

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { soleClaim, digBusy } = require('./dig-lock')

let perceived, compass, emitEvent, skyInSight, dayPhase, liveEntities, HOSTILE_NAMES, entityPerceptible, reflexes, logPulse, raySweep, terrainClass, bunker, takeLegs, stopPath
let shared, legs, waterState, holdHand, endHand, withBucketTurn, BUCKET_WAIT_CAP_MS, stampOwnEdit

// current_watch: warn the instant FLOWING water (a current that pushes) comes within ~2 blocks —
// the exact hazard that dragged me under and that I'm otherwise blind to. Change-gated: fires ONCE
// on ENTERING a current zone (re-arms when clear), so it never spams. Flow = a water block whose
// metadata != 0 (0 is a still source). Emits a [reflex] the Monitor tails, so I'm woken before it grabs me.
const currentWatchReflex = {
  name: 'current_watch', on: true, active: false,
  // _quietUntil holds the alarm off for the water a fire reflex pour lets flow.
  _near: false, _dir: null, _dist: 9, _quietUntil: 0,
  check (bot) {
    if (Date.now() < this._quietUntil) return false
    let near = false, dir = null, dist = 9
    try {
      const p = bot.entity.position.floored()
      for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) {
        const c = new Vec3(p.x + dx, p.y + dy, p.z + dz)
        const b = bot.blockAt(c)
        if (b && b.name === 'water' && b.metadata !== 0 && perceived(c)) {   // flowing, not a still source
          const d = Math.abs(dx) + Math.abs(dz)
          if (d < dist) { dist = d; dir = dx === 0 && dz === 0 ? (dy < 0 ? 'below' : dy > 1 ? 'above' : 'here') : compass(dx, dz) }
          near = true
        }
      }
    } catch (e) {}
    this._dir = dir; this._dist = dist
    // edge-gate + COOLDOWN: spreading water flickers at the range boundary, so "newly entering"
    // could re-trigger every tick (machine-gunned 12 events on 07-12) — one alarm per episode.
    const fire = near && !this._near && Date.now() - (this._lastFire || 0) > 15000
    if (fire) this._lastFire = Date.now()
    this._near = near
    return fire
  },
  async act (bot) {
    emitEvent('current', `flowing water ${this._dir || 'near'} ~${this._dist} — CURRENT, it can push you`, { dir: this._dir, dist: this._dist })
  }
}

// narrator: the ambient-awareness pulse. check() diffs a salient snapshot against the last pulse; when
// something meaningful shifts (day-phase, HP/food swing, a new perceptible hostile within 16, a >14-block move) it
// logPulse()s a lean line. Change-gated + rate-capped (>=2.5s) so it's holistic, not spammy — and it's
// PULL (I read /pulse when I look), never a push interrupt. Toggle off via /reflexes if I want silence.
const narratorReflex = {
  name: 'narrator', on: true, active: false,
  _last: null, _lastT: 0, _minGap: 2500, _msg: '',
  check (bot) {
    try {
      const now = Date.now()
      const pos = bot.entity.position
      const snap = {
        phase: bot.time && skyInSight() ? dayPhase(bot.time.timeOfDay) : null,
        health: Math.round(bot.health), food: Math.round(bot.food),
        pos: pos.clone(), hostiles: new Set()
      }
      let fresh = null, fill = null
      try {
        for (const e of liveEntities()) {
          if (!e.position) continue
          const nm = String(e.name || e.displayName || '').toLowerCase()
          if (!HOSTILE_NAMES.has(nm)) continue
          const d = e.position.distanceTo(pos)
          if (d > 16 || !entityPerceptible(e, fill ??= reflexes.find(r => r.name === 'combat').fairFill(bot))) continue
          snap.hostiles.add(e.id)
          // The nearest hostile the last pulse did not hold.
          if (this._last && !this._last.hostiles.has(e.id) && (!fresh || d < fresh.d)) fresh = { e, d, nm }
        }
      } catch (e) {}
      if (!this._last) { this._last = snap; return false }        // seed baseline on first tick
      if (now - this._lastT < this._minGap) return false          // rate cap

      const L = this._last, ch = []
      // Without the sky in sight the last phase seen stands.
      if (snap.phase === null) snap.phase = L.phase
      else if (snap.phase !== L.phase) ch.push(snap.phase)
      if (L.health - snap.health >= 2) ch.push(`HP ${L.health}→${snap.health}`)
      else if (snap.health - L.health >= 4) ch.push(`HP up ${L.health}→${snap.health}`)
      if (L.food - snap.food >= 2) ch.push(`food ${L.food}→${snap.food}`)
      if (fresh) ch.push(`hostile ${fresh.nm} ${compass(fresh.e.position.x - pos.x, fresh.e.position.z - pos.z)} ~${Math.round(fresh.d)}`)
      if (snap.pos.distanceTo(L.pos) >= 14) ch.push(`at (${Math.floor(snap.pos.x)},${Math.floor(snap.pos.z)})`)

      if (!ch.length) return false                                // nothing salient — keep the baseline
      this._msg = ch.join('; '); this._last = snap; this._lastT = now
      return true
    } catch (e) { return false }
  },
  async act () { logPulse(this._msg) }
}

// ---- TREK SENSE (07-16, designed trail-side with the helmsman: "spot the environment as it
// changes and point out some things" on long ranges). The passenger-window sense: while the body
// TRAVELS, sweep the retina along the direction of MOTION every ~20 blocks and fingerprint the
// country — biome, terrain classes in view, and BUILT blocks out in the wild. Speak ONE compact
// [event] scan line ONLY when the fingerprint CHANGES (throttled 15s). Silence = same country,
// not "didn't look". Never touches the controls.
const trekReflex = {
  name: 'trek', on: true, active: false,
  _lastPos: null, _fp: null, _lastSayT: 0,
  check (bot) {
    try {
      const p = bot.entity.position
      if (this._lastPos && p.distanceTo(this._lastPos) < 20) return false
      let moving = false
      try { moving = bot.pathfinder.isMoving() || !!bot.pathfinder.goal } catch (e) {}
      if (!moving) { this._lastPos = p.clone(); return false }   // parked: keep the anchor fresh, stay quiet
      return true
    } catch (e) { return false }
  },
  async act (bot) {
    try {
      const p = bot.entity.position
      const from = this._lastPos
      this._lastPos = p.clone()
      let yaw = bot.entity.yaw                                   // sweep along MOTION, not the head
      if (from) { const dx = p.x - from.x, dz = p.z - from.z; if (Math.hypot(dx, dz) > 2) yaw = Math.atan2(-dx, -dz) }
      const sweep = raySweep({ yaw, pitch: 0, maxDist: 96 })
      const classes = new Set(); const built = new Set()
      let builtSample = null
      for (const h of sweep.hits) {
        const cls = terrainClass(h.name)
        classes.add(cls)
        if (cls === 'structure' && !h.name.includes('torch')) {
          built.add(h.name)
          if (!builtSample || h.dist < builtSample.dist) builtSample = h
        }
      }
      let biome = '?'
      try { const b = bot.blockAt(p.floored()); if (b && b.biome && b.biome.name) biome = b.biome.name } catch (e) {}
      const fp = { biome, cls: [...classes].sort().join('|'), built: [...built].sort().join('|') }
      const prev = this._fp
      this._fp = fp
      const parts = []
      if (!prev) parts.push(`trek baseline: ${biome.replace(/_/g, ' ')}; in view ${[...classes].join(', ') || 'nothing near'}`)
      else {
        if (fp.biome !== prev.biome) parts.push(`entering ${biome.replace(/_/g, ' ')}`)
        const oldCls = new Set(prev.cls.split('|'))
        const newCls = [...classes].filter(c => !oldCls.has(c))
        if (newCls.length) parts.push(`now in view: ${newCls.join(', ')}`)
        const oldBuilt = new Set(prev.built.split('|'))
        const newBuilt = [...built].filter(b => !oldBuilt.has(b))
        if (newBuilt.length && builtSample) {
          let dir = ''
          try { if (builtSample.pos) dir = ' ' + compass(builtSample.pos.x - p.x, builtSample.pos.z - p.z) } catch (e) {}
          parts.push(`BUILT blocks${dir} ~${Math.round(builtSample.dist)}: ${newBuilt.slice(0, 3).join(', ')} — structure?`)
        }
      }
      if (parts.length && Date.now() - this._lastSayT > 15000) {
        this._lastSayT = Date.now()
        emitEvent('scan', parts.join('; '))
      }
    } catch (e) {}
  }
}

// LAVA WATCH (07-17, death #3 autopsy: flowing lava advanced into a path that was air at plan
// time — the pathfinder's plan-time safety cannot see a moving hazard, and the flee latch sprints
// a committed vector.
// Perceived lava in the near shell = kill goal + controls NOW, back away, tell the pilot.)
const lavaWatchReflex = {
  name: 'lava_watch', on: true, active: false, _coolUntil: 0, _hit: null,
  check (bot) {
    if (Date.now() < this._coolUntil) return false
    try {
      const p = bot.entity.position.floored()
      let hit = null
      for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
        const c = new Vec3(p.x + dx, p.y + dy, p.z + dz)
        const b = bot.blockAt(c)
        const d = Math.abs(dx) + Math.abs(dz)
        if (b && b.name === 'lava' && (!hit || d < hit.d) && perceived(c)) {
          hit = { dx, dz, d, dir: dx === 0 && dz === 0 ? (dy < 0 ? 'below' : dy > 1 ? 'above' : 'here') : compass(dx, dz) }
        }
      }
      this._hit = hit
      return !!hit
    } catch (e) {}
    return false
  },
  async act (bot) {
    const h = this._hit
    // Parked next to STATIC lava (a dam, a pit wall): same cell, hazard no nearer than last
    // fire = re-firing every 4s only kills pilot goals and floods the log (07-17 churn-pit
    // spam loop). Warn happened already — stand down 30s and leave the call to the pilot.
    // Flowing lava still breaks through: it gets CLOSER, so h.d drops and we act.
    const posNow = bot.entity.position.floored()
    if (this._lastPos && posNow.equals(this._lastPos) && this._lastD != null && h.d >= this._lastD) {
      this._coolUntil = Date.now() + 30000
      this._lastD = h.d
      return
    }
    this._lastPos = posNow; this._lastD = h.d
    this._coolUntil = Date.now() + 4000
    try {
      if (bunker.building) {
        emitEvent('lava', `LAVA ${h.dir} ~${h.d}, not moving while the bunker is built`)
        return
      }
      takeLegs('lava_watch', 'back away from lava')
      stopPath()                                           // whatever the plan was, it ends here
      const here = bot.entity.position
      if (h.d === 0) {
        // standing in/over it: nearest non-lava, non-solid neighbor cell, fast
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const feet = bot.blockAt(new Vec3(Math.floor(here.x) + ax, Math.floor(here.y), Math.floor(here.z) + az))
          if (feet && feet.name !== 'lava' && feet.boundingBox === 'empty') {
            bot.pathfinder.setGoal(new goals.GoalNear(here.x + ax, here.y, here.z + az, 0))
            break
          }
        }
      } else {
        bot.pathfinder.setGoal(new goals.GoalNear(here.x - h.dx * 3, here.y, here.z - h.dz * 3, 1))
      }
      emitEvent('lava', `LAVA ${h.dir} ~${h.d} — STOPPED, backing off; route around it deliberately`)
    } catch (e) {}
  }
}

// How long the fire reflex rests after a pour it did not take back or one that left the body burning.
const FIRE_COOL_MS = 10000
// The longest the fire reflex waits for the on-fire flag to clear before it takes the water back.
const FIRE_OUT_MS = 1000
// The water a pour spreads drains within this long after the take-back.
const FIRE_FLOW_MS = 3000
// Water flows at most this many cells from its source.
const FIRE_FLOW_REACH = 7
// A biome colder than this snows instead of raining (vanilla's Biome.coldEnoughToSnow).
const SNOW_TEMP = 0.15

function burning (bot) {
  return !!(bot.entity.metadata?.[0] & 0x01)
}
function rainedOn (bot) {
  if (!bot.isRaining) return false
  const p = bot.entity.position.floored()
  const biome = bot.blockAt(p)?.biome
  if (!biome?.has_precipitation || biome.temperature < SNOW_TEMP) return false
  for (let y = p.y + 2; y < bot.game.minY + bot.game.height; y++) {
    const b = bot.blockAt(new Vec3(p.x, y, p.z))
    if (!b || b.boundingBox === 'block' || b.name === 'water' || b.name === 'lava') return false
  }
  return true
}
function fireOut (bot) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      bot.removeListener('entityUpdate', onUpdate)
      resolve()
    }
    const onUpdate = (e) => { if (e === bot.entity && !burning(bot)) done() }
    const timer = setTimeout(done, FIRE_OUT_MS)
    bot.on('entityUpdate', onUpdate)
    if (!burning(bot)) done()
  })
}
function useHeld (bot) {
  bot.activateItem()
  bot.deactivateItem()
}
// Stamps the water changes of a pour at feet as the body's own edits until the returned stop runs.
function stampFlow (bot, feet) {
  const onBlock = (old, now) => {
    const p = now?.position
    if (!p || p.y > feet.y || Math.max(Math.abs(p.x - feet.x), Math.abs(p.z - feet.z)) > FIRE_FLOW_REACH) return
    if (old?.name === 'water' || now.name === 'water') stampOwnEdit(p)
  }
  // Ahead of the world-change notes, which skip a stamped cell.
  bot.prependListener('blockUpdate', onBlock)
  return () => bot.removeListener('blockUpdate', onBlock)
}

// FIRE: a burning body pours a carried water bucket at its feet and takes the water back.
const fireReflex = {
  name: 'fire', on: true, active: false, _coolUntil: 0, _legs: -1,
  check (bot) {
    const now = Date.now()
    if (now < this._coolUntil || !burning(bot) || shared.bed || bunker.building || !bot.entity.onGround) return false
    if (/nether/.test(bot.game.dimension) || !bot.inventory.items().some((i) => i.name === 'water_bucket')) return false
    // Another reflex keeps the legs it took until its quiet ends.
    if (legs.quietUntil() > now && legs.takenSince(this._legs)) return false
    // A combat flee, cover or hold keeps its goal past that quiet.
    const combat = reflexes.find((r) => r.name === 'combat')
    if (Math.max(combat._fleeUntil, combat._coverUntil, combat._holdUntil) > now) return false
    const ws = waterState()
    if (!ws || ws.inWater || ws.inLava || soleClaim() || rainedOn(bot)) return false
    const p = bot.entity.position.floored()
    const feet = bot.blockAt(p)
    // Over a gap the water lands below the feet.
    return !!feet && /^((cave_)?air|fire)$/.test(feet.name) && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block'
  },
  async act (bot) {
    takeLegs('fire', 'pour water on the fire')
    this._legs = legs.mark()
    stopPath()
    const prevHeld = bot.heldItem
    const lease = holdHand()
    let feet
    let msg
    let turned = false
    let unflow = null
    try {
      await bot.equip(bot.inventory.items().find((i) => i.name === 'water_bucket'), 'hand')
      digBusy('poured')
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      feet = bot.entity.position.floored()
      const at = `${feet.x},${feet.y},${feet.z}`
      const taken = `poured water at ${at}, the hand was taken before the water came back`
      if (!lease.renew(BUCKET_WAIT_CAP_MS + 1000) || bot.heldItem?.name !== 'water_bucket') msg = `the hand was taken before the pour at ${at}`
      else {
        unflow = stampFlow(bot, feet)
        currentWatchReflex._quietUntil = Infinity
        if (!(await withBucketTurn(() => useHeld(bot), feet))) msg = `the water bucket did not empty at ${at}`
        else if (!lease.renew(FIRE_OUT_MS + BUCKET_WAIT_CAP_MS)) msg = taken
        else {
          await fireOut(bot)
          if (bot.heldItem?.name !== 'bucket' || !lease.renew(BUCKET_WAIT_CAP_MS + 1000)) msg = taken
          else {
            await bot.look(bot.entity.yaw, -Math.PI / 2, true)
            turned = await withBucketTurn(() => useHeld(bot), feet)
            msg = `poured water at ${at}${turned ? ' and picked it up again' : ', the bucket did not fill again'}${burning(bot) ? ', still burning' : ''}`
          }
        }
      }
      if (lease.renew() && prevHeld && prevHeld.name !== 'water_bucket') {
        // An equip from the pockets can move the item held before.
        const again = bot.inventory.items().find((i) => i.type === prevHeld.type)
        try { if (again) await bot.equip(again, 'hand') } catch (e) {}
      }
    } finally {
      endHand(lease)
      if (!turned || burning(bot)) this._coolUntil = Date.now() + FIRE_COOL_MS
      if (unflow) {
        currentWatchReflex._quietUntil = Date.now() + FIRE_FLOW_MS
        setTimeout(unflow, FIRE_FLOW_MS)
      }
    }
    emitEvent('fire', `on fire, ${msg}`, { at: { x: feet.x, y: feet.y, z: feet.z } })
  }
}

function createWatchReflexes (ctx) {
  Object.assign(ctx, { currentWatchReflex, narratorReflex, trekReflex, lavaWatchReflex, fireReflex })
}

function bindWatchReflexes (ctx) {
  ({ perceived, compass, emitEvent, skyInSight, dayPhase, liveEntities, HOSTILE_NAMES, entityPerceptible, reflexes, logPulse, raySweep, terrainClass, bunker, takeLegs, stopPath } = ctx);
  ({ shared, legs, waterState, holdHand, endHand, withBucketTurn, BUCKET_WAIT_CAP_MS, stampOwnEdit } = ctx)
}

module.exports = { createWatchReflexes, bindWatchReflexes }
