'use strict'

// ---- async jobs registry (long actions run in background; driver keeps reacting) ----
const { createJobs } = require('../jobs')
const { deathLedger } = require('../deaths')

let bot, emitEvent, safeStop, stopCollect, stopPath

const deaths = deathLedger()
const jobs = createJobs({ stop: () => { safeStop(); stopCollect() }, emit: (name, msg) => emitEvent('job', name + ': ' + msg), deaths })
// Ends the running job and its walk for a reflex that needs the body, naming the reflex in the job's takenBy.
function yieldJob (reflex, why) {
  if (!jobs.yieldTo({ reflex, why })) return
  try { bot.stopDigging() } catch (e) {}
  stopPath()
}

function createJobBoard (ctx) {
  Object.assign(ctx, { deaths, jobs, yieldJob })
}

function bindJobBoard (ctx) {
  ({ bot, emitEvent, safeStop, stopCollect, stopPath } = ctx)
}

module.exports = { createJobBoard, bindJobBoard }
