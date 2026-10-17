'use strict'

let bot, shared

// ---- REFLEX LAYER (cannibalized from Mindcraft's modes.js): always-on node-process reflexes that
// run WITHOUT a model call. Each reflex does a cheap check() every ~300ms; when it fires, act() runs
// in the background (an `active` guard stops re-entry) and emits a [reflex] line the Monitor tails —
// so the pilot is woken organically, not by polling. Priority = array order, one reflex acts per tick.
// The survival reflexes (self_preservation, self_defense, …) will slot in here for the survival ramp;
// for now the spine + `unstuck` (useful even on Peaceful). Toggle any reflex via /reflexes. ----
const reflexes = []
function reflexFire (r) {
  if (r.active) return
  r.active = true
  Promise.resolve().then(() => r.act(bot))
    .catch(e => console.log('[reflex] ' + r.name + ' error: ' + e.message))
    .finally(() => { r.active = false })
}
let reflexTimer = null
function startReflexes () {
  if (reflexTimer) clearInterval(reflexTimer)
  reflexTimer = setInterval(() => {
    if (!shared.ready || !bot.entity) return
    for (const r of reflexes) {
      if (!r.on || r.active) continue
      let hit = false
      try { hit = r.check(bot) } catch (e) {}
      if (hit) { reflexFire(r); break }              // one reflex per tick, priority by array order
    }
  }, 300)
}

function createReflexes (ctx) {
  Object.assign(ctx, { reflexes, startReflexes })
}

function bindReflexes (ctx) {
  ({ bot, shared } = ctx)
}

module.exports = { createReflexes, bindReflexes }
