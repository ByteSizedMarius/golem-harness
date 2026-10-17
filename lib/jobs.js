'use strict'
const { takenText } = require('./legs')

// Finished jobs the registry keeps, the newest ones. Running jobs always stay.
const KEEP_FINISHED = 10

// Background jobs, at most one running. stop() halts the pathfinder and any collect, emit(name, msg) reports an end.
function createJobs ({ stop, emit, deaths }) {
  let jobSeq = 0
  const registry = new Map()
  // A cancelled job still winding down counts as stopped.
  const running = () => [...registry.values()].filter((j) => j.status === 'running' && !j.cancelled)
  function stopAll () {
    const live = running()
    for (const j of live) j.cancelled = true
    stop()
    return live.length
  }
  // Cancels the running job for the reflex that took the legs. True when one was running.
  function yieldTo (taken) {
    const live = running()
    for (const j of live) {
      j.cancelled = true
      j.takenBy = taken
    }
    return live.length > 0
  }
  function finish (job, status, mark) {
    job.status = job.cancelled ? 'cancelled' : status
    job.finished = Date.now()
    job.died = deaths.since(mark)
    const by = job.takenBy ? `, ${takenText(job.takenBy)}` : ''
    const died = job.died ? `, died: ${job.died}` : ''
    emit(job.name, job.status + (job.error ? ' ' + job.error : '') + by + died)
    const finished = [...registry.values()].filter((j) => j.status !== 'running')
    for (const j of finished.slice(0, -KEEP_FINISHED)) registry.delete(j.id)
  }
  function start (name, fn) {
    stopAll()
    const job = {
      id: ++jobSeq, name, status: 'running', cancelled: false, takenBy: null,
      note: '', result: null, error: null, started: Date.now()
    }
    // Progress is stored, never emitted.
    job.progress = (msg) => { job.note = msg }
    registry.set(job.id, job)
    const mark = deaths.mark()
    Promise.resolve()
      .then(() => fn(job))
      .then((r) => { job.result = r; finish(job, 'done', mark) })
      .catch((e) => { job.error = e && e.message ? e.message : String(e); finish(job, 'error', mark) })
    return { id: job.id }
  }
  function stopOne (id) {
    const j = registry.get(id)
    if (!j || j.status !== 'running') return false
    j.cancelled = true
    stop()
    return true
  }
  const get = (id) => registry.get(id) || null
  const list = () => [...registry.values()].map((j) => ({
    id: j.id, name: j.name, status: j.status, note: j.note, cancelled: j.cancelled,
    ...(j.takenBy && { takenBy: takenText(j.takenBy) })
  }))
  return { start, get, list, stop: stopOne, stopAll, yieldTo, running: () => running().length > 0 }
}

module.exports = { createJobs }
