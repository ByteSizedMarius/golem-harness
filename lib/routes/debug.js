'use strict'

let bot, ok, err, fight

function endPathTap (tap) {
  clearTimeout(tap.timer)
  for (const [ev, fn] of Object.entries(tap.handlers)) bot.removeListener(ev, fn)
  if (bot.pathdebugTap === tap) bot.pathdebugTap = null
}

function installDebugRoutes (app) {
  // /pathdebug?secs=30 — tap the pathfinder's event stream into bot.log for N seconds.
  // Built 07-14 night for the doors-v2 hunt: stalls with no error and no movement need the
  // planner's own words — path_update statuses and especially path_reset REASONS.
  app.get('/pathdebug', (req, res) => {
    try {
      const secs = Math.min(120, parseInt(req.query.secs || '30'))
      const handlers = {
        path_update: (r) => console.log(`[pathdebug] update: status=${r && r.status} pathLen=${r && r.path && r.path.length} cost=${r && r.cost}`),
        path_reset: (reason) => console.log(`[pathdebug] RESET: ${reason}`),
        goal_updated: (goal, dynamic) => console.log(`[pathdebug] goal set (dynamic=${!!dynamic})`),
        goal_reached: () => console.log('[pathdebug] goal REACHED')
      }
      if (bot.pathdebugTap) endPathTap(bot.pathdebugTap)
      for (const [ev, fn] of Object.entries(handlers)) bot.on(ev, fn)
      const tap = { handlers }
      tap.timer = setTimeout(() => endPathTap(tap), secs * 1000)
      bot.pathdebugTap = tap
      ok(res, { tapping: secs })
    } catch (e) { err(res, e) }
  })

  // /threatdebug?secs=60 — Peaceful-friendly validation: the combat watcher also SCORES players
  // (narrate-only, weapons hard-refused in the reflex) so the helmsman can charge the machine and we
  // watch the math call it.
  app.get('/threatdebug', (req, res) => {
    try {
      const secs = Math.min(300, parseInt(req.query.secs || '60'))
      fight.threatDebugUntil = Date.now() + secs * 1000
      ok(res, { scoringPlayersFor: secs, note: 'narrate-only — weapons never target players' })
    } catch (e) { err(res, e) }
  })
}

function createDebugRoutes (ctx) {
  Object.assign(ctx, { installDebugRoutes })
}

function bindDebugRoutes (ctx) {
  ({ bot, ok, err, fight } = ctx)
}

module.exports = { createDebugRoutes, bindDebugRoutes }
