'use strict'

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const { takenText } = require('../leg-ledger')
const books = require('../books')
const { digBusy } = require('../bot/dig-lock')

const BOOKS_FILE = process.env.GOLEM_BOOKS && path.isAbsolute(process.env.GOLEM_BOOKS) ? path.resolve(process.env.GOLEM_BOOKS) : null
if (process.env.GOLEM_BOOKS && !BOOKS_FILE) console.error('[book] GOLEM_BOOKS must be an absolute path, notebooks are off')
// The server's copy of an edited book came back 66 to 183 ms after the edit.
const BOOK_ECHO_MS = 3000
// Hotbar slot 0 in the inventory window.
const HOTBAR = 36

let bot, jobs, waypoints, memory, journal, cellText, seenNow, passable, standsAtWaypoint, holdHand, endHand, refuseWhileFighting, ok, err, send

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

// The book and quills in the pockets and the hotbar.
function carriedBooks () {
  const out = []
  for (let slot = 9; slot <= 44; slot++) {
    const pages = books.pagesOf(bot.inventory.slots[slot])
    if (pages) out.push({ slot, pages, id: books.idOf(pages) })
  }
  return out
}

function bookCopy () {
  if (!BOOKS_FILE) throw new Error('notebooks are off')
  try {
    return books.load(BOOKS_FILE)
  } catch (e) {
    // JSON.parse quotes the text around the fault, which can be book text.
    console.error(`[book] cannot read the books file: ${e.name === 'SyntaxError' ? 'not valid JSON' : e.message}`)
    return null
  }
}

// The fs error names the books file's path.
function saveBooks (copy, refusal) {
  try {
    books.save(BOOKS_FILE, copy)
  } catch (e) {
    console.error(`[book] cannot write the books file: ${e.message}`)
    throw new Error(refusal)
  }
}

function findBook (carried, q) {
  if (q.slot !== undefined) {
    const b = carried.find((x) => x.slot === q.slot)
    if (!b) throw new Error(`no book and quill in slot ${q.slot}`)
    return b
  }
  const named = carried.filter((x) => x.id === q.book)
  if (named.length > 1) throw new Error(`two carried books say notebook ${q.book} (slots ${named.map((x) => x.slot).join(', ')}), name one with slot`)
  if (named.length) return named[0]
  const ids = carried.map((x) => x.id).filter(Boolean)
  throw new Error(`no carried book is notebook ${q.book}${ids.length ? `, carried: ${ids.join(', ')}` : ''}`)
}

// Prefers a hotbar blank, which needs no move.
function blankBook (carried) {
  return carried.find((x) => !x.pages.length && x.slot >= HOTBAR) ?? carried.find((x) => !x.pages.length)
}

function findNotebook (carried, q) {
  const b = findBook(carried, q)
  if (q.book !== undefined && b.id !== q.book) throw new Error(`the book in slot ${b.slot} ${b.id === null ? 'holds no notebook' : `is notebook ${b.id}`}, not notebook ${q.book}`)
  return b
}

// Resolves with target once it shows the pages, else after the wait with the first other slot that changed to them, or null.
function bookEcho (target, pages) {
  return new Promise((resolve) => {
    let other = null
    const shows = (item) => {
      const got = books.pagesOf(item)
      return !!got && books.samePages(got, pages)
    }
    const seen = (slot, old, item) => {
      if (!shows(item)) return
      if (slot === target) finish(slot)
      else if (!shows(old)) other ??= slot
    }
    const finish = (slot) => {
      clearTimeout(timer)
      bot.inventory.removeListener('updateSlot', seen)
      resolve(slot)
    }
    const timer = setTimeout(() => finish(other), BOOK_ECHO_MS)
    bot.inventory.on('updateSlot', seen)
  })
}

// mineflayer's writeBook sends a packet 1.21.11 cannot encode.
async function editBook (copy, id, b, pages, wrote) {
  refuseWhileFighting()
  digBusy('written')
  if (bot.currentWindow) throw new Error('a window is open, nothing written')
  // A book clicked onto another book stays put in mineflayer while the server swaps the two.
  let slot = b.slot
  if (slot < HOTBAR) {
    slot = HOTBAR
    while (slot <= HOTBAR + 8 && bot.inventory.slots[slot]) slot++
    if (slot > HOTBAR + 8) throw new Error(`the hotbar is full, free a hotbar slot for the book in slot ${b.slot}, nothing written`)
  }
  const lease = holdHand()
  const held = bot.quickBarSlot
  try {
    if (slot !== b.slot) {
      await bot.moveSlotItem(b.slot, slot)
      await bot.waitForTicks(2)
      const moved = books.pagesOf(bot.inventory.slots[slot])
      if (bot.inventory.selectedItem || !moved || !books.samePages(moved, b.pages)) {
        // Puts the cursor item back into the slot the book left.
        if (bot.inventory.selectedItem) await bot.clickWindow(b.slot, 0, 0)
        throw new Error(`the book did not settle in slot ${slot}, nothing written`)
      }
    }
    if (!lease.renew(BOOK_ECHO_MS + 1000)) throw new Error('another action took the hand, nothing written')
    const entry = copy.get(id)
    entry.pending = { pages, wrote, at: new Date().toISOString() }
    saveBooks(copy, 'your copy could not be saved, nothing written')
    const echo = bookEcho(slot, pages)
    // A 1.7.10 server edits the held hotbar slot, a 1.21 server the slot the packet names.
    if (bot.quickBarSlot === slot - HOTBAR) bot._client.write('held_item_slot', { slotId: slot - HOTBAR })
    else bot.setQuickBarSlot(slot - HOTBAR)
    bot._client.write('edit_book', { hand: slot - HOTBAR, pages })
    const landed = await echo
    if (landed === null) throw new Error(`no echo of the edit within ${BOOK_ECHO_MS / 1000} s, it may still land`)
    if (landed !== slot) throw new Error(`the edit landed on the book in slot ${landed}`)
    books.adopt(entry, pages)
    saveBooks(copy, 'written, but your copy could not be saved')
    return slot
  } finally {
    if (held !== slot - HOTBAR && lease.renew()) bot.setQuickBarSlot(held)
    endHand(lease)
  }
}

function bookList (copy, carried) {
  const list = carried.map((b) => {
    const entry = copy && b.id !== null && copy.has(b.id) ? copy.get(b.id) : null
    const changed = entry ? books.changedPages(entry, b.pages) : []
    return {
      slot: b.slot,
      id: b.id,
      pages: b.pages.length,
      ...(b.pages.length === 0 && { blank: true }),
      ...(copy && b.id !== null && !entry && { unknown: true }),
      ...(changed.length && { changed })
    }
  })
  const notCarried = copy ? [...copy.keys()].filter((id) => !carried.some((b) => b.id === id)) : []
  return { books: list, notCarried, ...(!copy && { copy: 'unreadable' }) }
}

function bookRead (copy, carried, q) {
  const shown = 10
  const b = findNotebook(carried, q)
  const entry = copy && b.id !== null && copy.has(b.id) ? copy.get(b.id) : null
  const yours = entry ? entry.pages : []
  const last = Math.max(b.pages.length, yours.length, 1)
  const from = q.page ?? 1
  if (from > last) throw new Error(`page ${from} is past the end, the book has ${b.pages.length} pages`)
  const pages = []
  for (let n = from; n <= Math.min(last, from + shown - 1); n++) {
    const text = b.pages[n - 1] ?? null
    const mine = yours[n - 1] ?? null
    pages.push({ n, text, ...(mine !== null && mine !== (text ?? '') && { yours: mine }) })
  }
  return { slot: b.slot, id: b.id, of: b.pages.length, pages, ...(entry && { changed: books.changedPages(entry, b.pages) }) }
}

async function bookWrite (copy, carried, q) {
  const b = findNotebook(carried, q)
  if (b.id === null) throw new Error(`the book in slot ${b.slot} is no notebook, new starts one in a blank book`)
  const fault = books.pageFault(q.text)
  if (fault) throw new Error(`text: ${fault}`)
  if (q.page > b.pages.length + 1) throw new Error(`page ${q.page} is past the end, the book has ${b.pages.length} pages`)
  if (q.page === 1 && books.idOf([q.text]) !== b.id) throw new Error(`page 1 must start with "notebook ${b.id}"`)
  if (!copy.has(b.id) && copy.size >= books.BOOKS_CAP) throw new Error(`your copy holds ${books.BOOKS_CAP} notebooks, forget one first`)
  const entry = copy.get(b.id) ?? { pages: [], at: new Date().toISOString() }
  copy.set(b.id, entry)
  const mine = entry.pages[q.page - 1] ?? null
  const theirs = b.pages[q.page - 1] ?? ''
  if ((mine ?? '') !== theirs && q.text !== theirs && !q.over) {
    throw Object.assign(new Error(`page ${q.page} of notebook ${b.id} differs from your copy, write it again with over to replace it, or write the book's text to keep it`),
      { differs: { page: q.page, text: b.pages[q.page - 1] ?? null, yours: mine } })
  }
  const next = [...b.pages]
  next[q.page - 1] = q.text
  const pages = books.trimPages(next)
  const bad = books.bookFault(pages)
  if (bad) throw new Error(books.bookFault(b.pages) === bad && entry.pages.some((p) => p !== null) ? `${bad}, restore writes your copy back over it` : bad)
  const others = books.changedPages(entry, b.pages).filter((n) => n !== q.page).map((n) => ({ n, text: b.pages[n - 1] ?? null, ...(entry.pages[n - 1] != null && { yours: entry.pages[n - 1] }) }))
  const reply = { written: true, id: b.id, page: q.page, slot: b.slot, ...(others.length && { changed: others }) }
  if (books.samePages(pages, b.pages)) {
    while (entry.pages.length < q.page) entry.pages.push(null)
    entry.pages[q.page - 1] = q.text
    entry.at = new Date().toISOString()
    saveBooks(copy, 'your copy could not be saved, nothing written')
    return { ...reply, same: true }
  }
  reply.slot = await editBook(copy, b.id, b, pages, [q.page])
  return reply
}

async function bookNew (copy, carried, q) {
  const named = carried.find((x) => x.id === q.book)
  if (named) throw new Error(`the book in slot ${named.slot} is notebook ${q.book} already`)
  const entry = copy.get(q.book)
  const written = entry && entry.pages.some((p) => p !== null)
  if (entry && entry.pending && !written) throw new Error(`a new of notebook ${q.book} may still land, list shows it once it does, or forget it`)
  if (written) throw new Error(`notebook ${q.book} is in your copy already, restore writes it into a blank book`)
  if (!entry && copy.size >= books.BOOKS_CAP) throw new Error(`your copy holds ${books.BOOKS_CAP} notebooks, forget one first`)
  const page = `notebook ${q.book}${q.text ? '\n' + q.text : ''}`
  const fault = books.pageFault(page)
  if (fault) throw new Error(`page 1: ${fault}`)
  const b = q.slot !== undefined ? findBook(carried, q) : blankBook(carried)
  if (!b) throw new Error('no blank book and quill carried, craft one from a book, an ink sac and a feather')
  if (b.pages.length) throw new Error(`the book in slot ${b.slot} is not blank`)
  copy.set(q.book, { pages: [], at: new Date().toISOString() })
  return { created: q.book, slot: await editBook(copy, q.book, b, [page], [1]) }
}

async function bookRestore (copy, carried, q) {
  const entry = copy.get(q.book)
  if (!entry) throw new Error(`notebook ${q.book} is not in your copy`)
  const pages = books.trimPages(entry.pages.map((p, i) => p ?? (i === 0 ? `notebook ${q.book}` : '')))
  if (!pages.length || !entry.pages.some((p) => p !== null)) throw new Error(`your copy of notebook ${q.book} is empty`)
  const own = carried.some((x) => x.id === q.book)
  const b = q.slot !== undefined || own ? findBook(carried, q) : blankBook(carried)
  if (!b) throw new Error('no blank book and quill carried, craft one from a book, an ink sac and a feather')
  if (b.pages.length && b.id !== q.book && !q.over) throw new Error(`the book in slot ${b.slot} ${b.id ? `is notebook ${b.id}` : 'holds other text'}, over replaces it`)
  const replaced = b.pages.map((text, i) => ({ n: i + 1, text })).filter((p) => p.text !== (pages[p.n - 1] ?? ''))
  if (books.samePages(pages, b.pages)) return { restored: q.book, slot: b.slot, pages: pages.length, replaced, same: true }
  const bad = books.bookFault(pages)
  if (bad) throw new Error(bad)
  return { restored: q.book, slot: await editBook(copy, q.book, b, pages, pages.map((p, i) => i + 1)), pages: pages.length, replaced }
}

function bookForget (copy, q) {
  if (!copy.delete(q.book)) throw new Error(`notebook ${q.book} is not in your copy`)
  saveBooks(copy, 'your copy could not be saved, nothing forgotten')
  return { forgot: q.book }
}

async function bookAction (q) {
  const uses = { list: [], read: ['book', 'slot', 'page'], write: ['book', 'slot', 'page', 'text', 'over'], new: ['book', 'slot', 'text'], restore: ['book', 'slot', 'over'], forget: ['book'] }
  if (!Object.hasOwn(uses, q.action)) throw new Error(`action must be one of ${Object.keys(uses).join(', ')}`)
  for (const k of ['book', 'slot', 'page', 'text', 'over']) {
    if (q[k] !== undefined && !uses[q.action].includes(k)) throw new Error(`${k} is not for ${q.action}`)
  }
  if ((q.action === 'read' || q.action === 'write') && q.book === undefined && q.slot === undefined) throw new Error(`${q.action} needs book or slot`)
  for (const k of { write: ['page', 'text'], new: ['book'], restore: ['book'], forget: ['book'] }[q.action] ?? []) {
    if (q[k] === undefined) throw new Error(`${q.action} needs ${k}`)
  }
  const copy = bookCopy()
  if (!copy && q.action !== 'list' && q.action !== 'read') throw new Error('your copy is unreadable, nothing written')
  const carried = carriedBooks()
  // Late echoes land their pending edits here.
  if (copy && carried.filter((b) => b.id !== null && copy.has(b.id) && books.adopt(copy.get(b.id), b.pages)).length) {
    try {
      books.save(BOOKS_FILE, copy)
    } catch (e) {
      console.error(`[book] cannot write the books file: ${e.message}`)
    }
  }
  if (q.action === 'list') return bookList(copy, carried)
  if (q.action === 'read') return bookRead(copy, carried, q)
  if (q.action === 'write') return bookWrite(copy, carried, q)
  if (q.action === 'new') return bookNew(copy, carried, q)
  if (q.action === 'restore') return bookRestore(copy, carried, q)
  return bookForget(copy, q)
}

// Each call saves the whole copy it loaded at its start.
const bookTurns = { last: Promise.resolve() }

function bookInTurn (q) {
  const turn = bookTurns.last.then(() => bookAction(q))
  bookTurns.last = turn.catch(() => {})
  return turn
}

function installMemoryRoutes (app) {
  // GET /book?action=list|read|write|new|restore|forget: the pilot's notebooks, books and quills it carries.
  app.get('/book', async (req, res) => {
    try {
      const int = (v) => (v === undefined ? undefined : parseInt(v))
      const q = {
        action: req.query.action,
        book: req.query.book,
        slot: int(req.query.slot),
        page: int(req.query.page),
        text: req.query.text,
        over: req.query.over === '1' ? true : undefined
      }
      if (q.book !== undefined && !books.ID.test(q.book)) return err(res, new Error('book is a notebook id of 1 to 24 characters a-z, 0-9 and -'))
      ok(res, await bookInTurn(q))
    } catch (e) {
      if (e.differs) return send(res, { ok: false, error: e.message, ...e.differs })
      err(res, e)
    }
  })

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
  ({ bot, jobs, waypoints, memory, journal, cellText, seenNow, passable, standsAtWaypoint, holdHand, endHand, refuseWhileFighting, ok, err, send } = ctx)
}

module.exports = { createMemoryRoutes, bindMemoryRoutes }
