'use strict'

const fs = require('fs')
const { Vec3 } = require('vec3')
const { takenText } = require('../leg-ledger')

let bot, jobs, waypoints, memory, journal, cellText, seenNow, passable, standsAtWaypoint, ok, err

// Drops the tail's first line when the file is longer than max.
function fileTail (file, max) {
  const size = fs.statSync(file).size
  const len = Math.min(size, max)
  const buf = Buffer.alloc(len)
  const fd = fs.openSync(file, 'r')
  let got
  try {
    got = fs.readSync(fd, buf, 0, len, size - len)
  } finally {
    fs.closeSync(fd)
  }
  const tail = buf.subarray(0, got)
  if (len === size) return tail.toString('utf8')
  const nl = tail.indexOf(0x0a)
  return nl < 0 ? '' : tail.subarray(nl + 1).toString('utf8')
}

// Why c is no cell to stand in by the cells in sight now, '' when it is one, null when a cell out of sight leaves it open.
function standFault (c) {
  const up = c.offset(0, 1, 0), down = c.offset(0, -1, 0)
  const known = (p) => !!bot.blockAt(p) && seenNow(p)
  if (known(c) && !passable(c)) return bot.blockAt(c).name
  if (known(up) && !passable(up)) return bot.blockAt(up).name + ' above'
  // An open feet cell in sight shows the floor under it.
  const floorKnown = known(down) || (known(c) && !!bot.blockAt(down))
  if (floorKnown && bot.blockAt(down).boundingBox !== 'block') return 'no floor'
  return known(c) && known(up) && floorKnown ? '' : null
}
// On a distance tie, level cells win, then cells above.
function standBeside (c) {
  const ring = []
  for (const dy of [0, 1, -1]) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) ring.push(c.offset(dx, dy, dz))
  return ring.sort((a, b) => a.distanceSquared(c) - b.distanceSquared(c)).find((p) => standFault(p) === '') || null
}

function installMemoryRoutes (app) {
  app.get('/job_stop', (req, res) => { const stopped = jobs.stop(parseInt(req.query.id)); ok(res, { stopped }) })

  // ---- jobs HTTP surface ----
  app.get('/jobs', (req, res) => {
    try {
      ok(res, { jobs: jobs.list() })
    } catch (e) { err(res, e) }
  })

  app.get('/job', (req, res) => {
    try {
      const id = parseInt(req.query.id)
      if (!id) return err(res, new Error('missing id'))
      const j = jobs.get(id)
      if (!j) return err(res, new Error(`no job ${id}`))
      const takenBy = j.takenBy ? takenText(j.takenBy) : undefined
      const died = j.died || undefined
      if (req.query.verbose) {
        return ok(res, { job: {
          id: j.id, name: j.name, status: j.status, note: j.note, takenBy, died,
          result: j.result, error: j.error, started: j.started, finished: j.finished || null
        } })
      }
      ok(res, { job: {
        id: j.id, name: j.name, status: j.status, note: j.note, takenBy, died,
        error: j.error, result: (j.status === 'done' ? j.result : null)
      } })
    } catch (e) { err(res, e) }
  })

  // ---- MEMORY endpoints: waypoints + journal ----
  // GET /waypoint?name=&x=&y=&z=  -> if x/y/z given, store that; else if stored, return it;
  //                                  else stamp the cell the bot stands in.
  // GET /waypoint?name=[&x=&y=&z=][&note=][&kind=place|resource][&rm=1][&linkto=<wp>]
  //  - rm=1 DELETES (the resource-hygiene verb: a mined-out vein waypoint is a lie — remove it)
  //  - note/kind update in place without moving the point
  //  - linkto asserts a walked edge (use ONLY for traversals you actually made)
  app.get('/waypoint', (req, res) => {
    try {
      const name = req.query.name
      if (!name) return err(res, new Error('name required'))
      if (req.query.rm === '1') {
        const gone = waypoints.remove(name)
        if (gone) journal('waypoint', 'removed ' + name)
        if (memory.lastWaypoint === name) memory.lastWaypoint = null
        return ok(res, { removed: gone ? name : null })
      }
      const extra = {}
      if (req.query.note != null) extra.note = String(req.query.note)
      if (req.query.kind != null) extra.kind = String(req.query.kind) === 'resource' ? 'resource' : 'place'
      const hasCoords = req.query.x != null && req.query.y != null && req.query.z != null
      const existing = waypoints.get(name)
      let wp = null, from, moved
      if (hasCoords) {
        let at = { x: parseFloat(req.query.x), y: parseFloat(req.query.y), z: parseFloat(req.query.z) }
        const cell = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
        const why = standFault(cell)
        if (why) {
          const beside = standBeside(cell)
          const named = `(${cellText(cell)})`
          if (!beside) return err(res, new Error(`${named} is no cell to stand in (${why}) and no cell beside it is known to be one`))
          at = { x: beside.x, y: beside.y, z: beside.z }
          moved = `from ${named}, no cell to stand in (${why})`
        }
        wp = waypoints.set(name, at, extra)
        from = 'coords'
      } else if (existing && (extra.note != null || extra.kind != null)) {
        wp = waypoints.set(name, existing, extra)               // annotate in place
        from = 'updated'
      } else if (existing) {
        wp = existing; from = 'stored'
      } else {
        wp = waypoints.set(name, bot.entity.position.floored(), extra)
        from = 'current'
        if (memory.lastWaypoint && memory.lastWaypoint !== name && standsAtWaypoint(memory.lastWaypoint)) waypoints.link(memory.lastWaypoint, name)
        memory.lastWaypoint = name
      }
      if (req.query.linkto) { const okd = waypoints.link(name, String(req.query.linkto)); if (okd) journal('waypoint', 'linked ' + name + ' <-> ' + req.query.linkto) }
      if (from !== 'stored') journal('waypoint', from + ' ' + name + ' = ' + JSON.stringify({ x: wp.x, y: wp.y, z: wp.z }))
      return ok(res, { name, at: wp, from, ...(moved && { moved }) })
    } catch (e) { err(res, e) }
  })

  // GET /waypoints -> list all stored waypoints
  app.get('/waypoints', (req, res) => {
    try {
      const all = waypoints.list()
      const names = Object.keys(all)
      // the world-graph in a dozen lines: name (kind) coords — note; <-> neighbors (walked edges)
      const graph = names.map(n => {
        const w = all[n]
        const links = Object.keys(w.links || {})
        return `${n}${w.kind === 'resource' ? ' [RESOURCE — perishable, verify]' : ''} (${w.x},${w.y},${w.z})` +
          (w.note ? ` — ${w.note}` : '') + (links.length ? ` <-> ${links.join(', ')}` : '')
      }).join('\n')
      if (req.query.verbose) return ok(res, { count: names.length, graph, waypoints: all })
      return ok(res, { count: names.length, graph, names })
    } catch (e) { err(res, e) }
  })

  // GET /journal?n= -> return the last ~30 (or n) journal lines
  app.get('/journal', (req, res) => {
    try {
      let raw = ''
      try {
        raw = fileTail('journal.md', 65536)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      const lines = raw.split('\n').filter(l => l.length)
      const n = parseInt(req.query.n || '30')
      const tail = lines.slice(-n)
      return ok(res, { count: tail.length, lines: tail })
    } catch (e) { err(res, e) }
  })
}

function createMemoryRoutes (ctx) {
  Object.assign(ctx, { installMemoryRoutes })
}

function bindMemoryRoutes (ctx) {
  ({ bot, jobs, waypoints, memory, journal, cellText, seenNow, passable, standsAtWaypoint, ok, err } = ctx)
}

module.exports = { createMemoryRoutes, bindMemoryRoutes }
