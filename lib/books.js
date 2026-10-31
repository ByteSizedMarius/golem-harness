'use strict'
// The pilot's copy of its notebooks, with null for each page it never wrote.

const fs = require('node:fs')
const { ISO_AT, writeJson } = require('./memory')

const VERSION = 1
// The tool's own cap, below the server's.
const BOOK_PAGES = 50
// UTF-16 units.
const PAGE_CAP = 256
// UTF-8 bytes over all pages.
const BOOK_BYTES = 16384
const BOOKS_CAP = 16
const ID = /^[a-z0-9-]{1,24}$/
const PAGE_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/
const INDEX_LINE = /^notebook ([a-z0-9-]{1,24})(?:\n|$)/

const isText = (p) => typeof p === 'string' && p.length <= PAGE_CAP
const isPage = (p) => isText(p) && !PAGE_CONTROL.test(p)
const isAt = (at) => typeof at === 'string' && ISO_AT.test(at) && Number.isFinite(Date.parse(at))
const isPages = (pages, ok) => Array.isArray(pages) && pages.length <= BOOK_PAGES && pages.every(ok)
const keysWithin = (x, keys) => Object.keys(x).every((k) => keys.includes(k))

function validCopy (x) {
  if (x === null || typeof x !== 'object' || !keysWithin(x, ['pages', 'at', 'pending']) ||
    !isPages(x.pages, (p) => p === null || isPage(p)) || !isAt(x.at)) return false
  if (x.pending === undefined) return true
  const p = x.pending
  // Pending pages the pilot did not write may hold a player's control characters.
  return p !== null && typeof p === 'object' && keysWithin(p, ['pages', 'wrote', 'at']) && isPages(p.pages, isText) && isAt(p.at) &&
    Array.isArray(p.wrote) && p.wrote.every((n) => Number.isInteger(n) && n >= 1 && n <= p.pages.length && isPage(p.pages[n - 1]))
}

function load (file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return new Map()
    throw e
  }
  const data = JSON.parse(raw)
  if (data === null || typeof data !== 'object' || !keysWithin(data, ['version', 'books']) || data.version !== VERSION ||
    data.books === null || typeof data.books !== 'object' || Array.isArray(data.books)) throw new TypeError('the books file is malformed')
  const ids = Object.keys(data.books)
  if (ids.length > BOOKS_CAP || !ids.every((id) => ID.test(id) && Object.hasOwn(data.books, id) &&
    validCopy(data.books[id]))) throw new TypeError('the books file is malformed')
  return new Map(ids.map((id) => [id, data.books[id]]))
}

function save (file, store) {
  writeJson(file, { version: VERSION, books: Object.fromEntries(store) })
}

function pagesOf (item) {
  if (!item || item.name !== 'writable_book') return null
  const content = item.componentMap && item.componentMap.get('writable_book_content')
  const pages = content && content.data && Array.isArray(content.data.pages)
    ? content.data.pages.map((p) => (p && typeof p.content === 'string' ? p.content : ''))
    : []
  return trimPages(pages)
}

function trimPages (pages) {
  let end = pages.length
  while (end > 0 && pages[end - 1] === '') end--
  return pages.slice(0, end)
}

function idOf (pages) {
  const m = pages.length ? INDEX_LINE.exec(pages[0]) : null
  return m ? m[1] : null
}

const samePages = (a, b) => a.length === b.length && a.every((p, i) => p === b[i])

function pageFault (text) {
  if (text.length > PAGE_CAP) return `over ${PAGE_CAP} characters, and the server discards the whole edit`
  if (PAGE_CONTROL.test(text)) return 'control characters other than a line break are not allowed'
  return null
}

function bookFault (pages) {
  if (pages.length > BOOK_PAGES) return `the book would pass ${BOOK_PAGES} pages`
  const long = pages.findIndex((p) => p.length > PAGE_CAP)
  if (long >= 0) return `page ${long + 1} of this book holds over ${PAGE_CAP} characters, and the server would discard the edit`
  if (Buffer.byteLength(pages.join(''), 'utf8') > BOOK_BYTES) return `the book would pass ${BOOK_BYTES} bytes`
  return null
}

// The page numbers where the book differs from the copy, a page the pilot never wrote counting as empty.
function changedPages (copy, pages) {
  const out = []
  for (let i = 0; i < Math.max(copy.pages.length, pages.length); i++) {
    if ((copy.pages[i] ?? '') !== (pages[i] ?? '')) out.push(i + 1)
  }
  return out
}

// Takes a pending edit into the copy once the book shows the pages it wrote.
function adopt (copy, pages) {
  const p = copy.pending
  if (!p || !p.wrote.every((n) => p.pages[n - 1] === (pages[n - 1] ?? ''))) return false
  for (const n of p.wrote) {
    while (copy.pages.length < n) copy.pages.push(null)
    copy.pages[n - 1] = p.pages[n - 1]
  }
  copy.at = p.at
  delete copy.pending
  return true
}

module.exports = { BOOKS_CAP, ID, load, save, pagesOf, trimPages, idOf, samePages, pageFault, bookFault, changedPages, adopt }
