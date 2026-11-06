'use strict'
// The pilot's todo list, a JSON file of { next, items } with items oldest first.

const fs = require('node:fs')
const { writeJson } = require('./memory')
const { flatText } = require('./flat-text')

const TODO_CAP = 30
// UTF-16 units of an item's text and who.
const TEXT_CAP = 400
const WHO_CAP = 32
// The todo tool's id param stops here.
const ID_MAX = 999999

class TodoFull extends Error {}

// Normal priority is stored as no priority.
const RANK = { high: 0, low: 2 }

const level = (priority) => Object.hasOwn(RANK, priority) ? { priority } : {}

const validItem = (x, next) => x !== null && typeof x === 'object' && Number.isInteger(x.id) && x.id >= 1 && x.id < next &&
  typeof x.text === 'string' && x.text !== '' && (x.who === undefined || typeof x.who === 'string') && Number.isFinite(Date.parse(x.at)) &&
  (x.priority === undefined || x.priority === 'normal' || Object.hasOwn(RANK, x.priority)) &&
  (x.current === undefined || x.current === false || (typeof x.current === 'string' && Number.isFinite(Date.parse(x.current))))

function load (file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { next: 1, items: [] }
    throw e
  }
  const data = JSON.parse(raw)
  if (data === null || typeof data !== 'object' || !Number.isInteger(data.next) || data.next < 1 || data.next > ID_MAX + 1 || !Array.isArray(data.items) ||
    !data.items.every((x) => validItem(x, data.next)) || new Set(data.items.map((x) => x.id)).size !== data.items.length ||
    data.items.filter((x) => x.current).length > 1) throw new TypeError('the todo file is malformed')
  return { next: data.next, items: data.items.map(({ priority, current, ...x }) => ({ ...x, ...level(priority), ...(current && { current }) })) }
}

// Returns the new item's id.
function add (file, text, who, at, priority) {
  const data = load(file)
  if (data.items.length >= TODO_CAP) throw new TodoFull(`the todo list is full at ${TODO_CAP} items, mark one done or drop one first`)
  if (data.next > ID_MAX) throw new TodoFull(`todo ids are used up at ${ID_MAX}`)
  const item = { id: data.next, text, ...(who && { who }), at: at.toISOString(), ...level(priority) }
  writeJson(file, { next: data.next + 1, items: [...data.items, item] })
  return item.id
}

// False when no open item has id.
function remove (file, id) {
  const data = load(file)
  const items = data.items.filter((x) => x.id !== id)
  if (items.length === data.items.length) return false
  writeJson(file, { next: data.next, items })
  return true
}

// False when no open item has id.
function setPriority (file, id, priority) {
  const data = load(file)
  const item = data.items.find((x) => x.id === id)
  if (!item) return false
  delete item.priority
  Object.assign(item, level(priority))
  writeJson(file, data)
  return true
}

// False when no open item has id.
function setCurrent (file, id, at) {
  const data = load(file)
  const item = data.items.find((x) => x.id === id)
  if (!item) return false
  for (const x of data.items) delete x.current
  item.current = at.toISOString()
  writeJson(file, data)
  return true
}

function age (ms) {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return `${m}m`
  return m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

// Never cuts between the halves of a surrogate pair.
function cut (s, cap) {
  if (s.length <= cap) return s
  const last = s.charCodeAt(cap - 1)
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap)
}

const flatCut = (s, cap) => cut(flatText(cut(s, 8 * cap)), cap)

// At most TODO_CAP items and only whole ones that fit in room units, then a count of the rest.
function render (items, now, room = Infinity) {
  if (!items.length) return 'Todo list: empty.'
  const rank = (x) => RANK[x.priority] ?? 1
  const lines = [...items].sort((a, b) => Boolean(b.current) - Boolean(a.current) || rank(a) - rank(b) || a.id - b.id).slice(0, TODO_CAP)
    .map((x) => {
      const who = x.who === undefined ? '' : flatCut(x.who, WHO_CAP)
      return `#${x.id} [${x.current ? `current ${age(now - Date.parse(x.current))}, ` : ''}${x.priority ? x.priority + ', ' : ''}${who ? who + ', ' : ''}${age(now - Date.parse(x.at))}] ${flatCut(x.text, TEXT_CAP)}`
    })
  const head = items.some((x) => x.current) ? 'Todo list, the current task first, then high priority, then oldest first:' : 'Todo list, high priority first, then oldest first:'
  const more = (shown) => shown < lines.length ? [`${items.length - shown} more, call todo`] : shown < items.length ? [`${items.length - shown} more in the todo file`] : []
  const text = (shown) => [head, ...lines.slice(0, shown), ...more(shown)].join('\n')
  let shown = lines.length
  while (shown > 0 && text(shown).length > room) shown--
  return text(shown)
}

module.exports = { TODO_CAP, TEXT_CAP, WHO_CAP, TodoFull, load, add, remove, setPriority, setCurrent, render }
