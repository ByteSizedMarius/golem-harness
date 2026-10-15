'use strict'
// The pilot's todo list, a JSON file of { next, items } with items oldest first.

const fs = require('node:fs')

const TODO_CAP = 30

class TodoFull extends Error {}

const validItem = (x, next) => x !== null && typeof x === 'object' && Number.isInteger(x.id) && x.id >= 1 && x.id < next &&
  typeof x.text === 'string' && x.text !== '' && (x.who === undefined || typeof x.who === 'string') && Number.isFinite(Date.parse(x.at))

function load (file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { next: 1, items: [] }
    throw e
  }
  const data = JSON.parse(raw)
  if (data === null || typeof data !== 'object' || !Number.isInteger(data.next) || data.next < 1 || !Array.isArray(data.items) ||
    !data.items.every((x) => validItem(x, data.next))) throw new TypeError('the todo file is malformed')
  return { next: data.next, items: data.items }
}

function save (file, data) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// Returns the new item's id.
function add (file, text, who, at) {
  const data = load(file)
  if (data.items.length >= TODO_CAP) throw new TodoFull(`the todo list is full at ${TODO_CAP} items, mark one done or drop one first`)
  const item = { id: data.next, text, ...(who && { who }), at: at.toISOString() }
  save(file, { next: data.next + 1, items: [...data.items, item] })
  return item.id
}

// False when no open item has id.
function remove (file, id) {
  const data = load(file)
  const items = data.items.filter((x) => x.id !== id)
  if (items.length === data.items.length) return false
  save(file, { next: data.next, items })
  return true
}

function age (ms) {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return `${m}m`
  return m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim()

function render (items, now) {
  if (!items.length) return 'Todo list: empty.'
  const lines = items.map((x) => `#${x.id} [${x.who ? oneLine(x.who) + ', ' : ''}${age(now - Date.parse(x.at))}] ${oneLine(x.text)}`)
  return ['Todo list, oldest first:', ...lines].join('\n')
}

module.exports = { TODO_CAP, TodoFull, load, add, remove, render }
