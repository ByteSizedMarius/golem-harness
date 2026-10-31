'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const books = require('../lib/books')
const { routeHandler, loadBotFunctions, botConstant, claimRescue, startApp, mcpServer, call, errorText, isToolError } = require('./helpers')

const INDEX = 'notebook farms\nwheat v2, page 2'
const AT = '2026-10-30T12:00:00.000Z'
const SMILE = '\u{1F600}'

function bookItem (pages) {
  const components = pages === null ? [] : [['writable_book_content', { type: 'writable_book_content', data: { pages: pages.map((content) => ({ content })) } }]]
  return { name: 'writable_book', type: 1, count: 1, componentMap: new Map(components) }
}

const copyOf = (entries) => JSON.stringify({ version: 1, books: Object.fromEntries(Object.entries(entries).map(([id, pages]) => [id, { pages, at: AT }])) })

// echo 'held' edits the held hotbar slot as on 1.7.10, 'hand' the slot the edit names as on 1.21.
function rig (t, { slots = {}, copy, echo = 'held', echoMs = 200, file = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-book-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const BOOKS_FILE = path.join(dir, 'books.json')
  if (copy !== undefined) fs.writeFileSync(BOOKS_FILE, typeof copy === 'string' ? copy : copyOf(copy))
  const inventory = new EventEmitter()
  inventory.slots = new Array(46).fill(null)
  inventory.selectedItem = null
  for (const [slot, item] of Object.entries(slots)) inventory.slots[slot] = Array.isArray(item) || item === null ? bookItem(item) : item
  const sent = []
  const server = { echo }
  const setSlot = (slot, item) => {
    const old = inventory.slots[slot]
    inventory.slots[slot] = item
    inventory.emit('updateSlot', slot, old, item)
  }
  const bot = {
    inventory,
    quickBarSlot: 0,
    currentWindow: null,
    _client: {
      write (name, data) {
        sent.push([name, JSON.parse(JSON.stringify(data))])
        if (name === 'edit_book' && server.echo !== null) {
          const slot = server.echo === 'held' ? 36 + bot.quickBarSlot : server.echo === 'hand' ? 36 + data.hand : server.echo
          setTimeout(() => setSlot(slot, bookItem(data.pages)), 5)
        }
      }
    },
    setQuickBarSlot (n) {
      if (bot.quickBarSlot === n) return
      bot.quickBarSlot = n
      bot._client.write('held_item_slot', { slotId: n })
    },
    async clickWindow (slot) { sent.push(['click', slot]) },
    async moveSlotItem (from, to) {
      sent.push(['move', from, to])
      const item = inventory.slots[from]
      inventory.slots[from] = inventory.slots[to]
      inventory.slots[to] = item
    },
    async waitForTicks () {},
    writeBook () { throw new Error('writeBook called') },
    signBook () { throw new Error('signBook called') }
  }
  const fight = { busy: false }
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) }
  const env = {
    bot,
    books,
    BOOKS_FILE: file ? BOOKS_FILE : null,
    BOOK_ECHO_MS: echoMs,
    HOTBAR: botConstant('HOTBAR'),
    bookTurns: botConstant('bookTurns'),
    console,
    guardState: { hand: null },
    reflexes: [{ name: 'combat', fightBusy: () => fight.busy, _threat: null }],
    bunkerHolds: () => false,
    send: (res, body) => { res.body = body },
    ...timers
  }
  loadBotFunctions(['wireHandLease'], { bot, guardState: env.guardState, ...timers }).wireHandLease()
  const stored = () => JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8'))
  const edits = () => sent.filter(([name]) => name === 'edit_book').map(([, data]) => data)
  return { env, bot, sent, edits, fight, setSlot, stored, server, file: BOOKS_FILE, dir }
}

async function run (r, query) {
  const { handle, res } = routeHandler('/book', r.env)
  await handle({ query }, res)
  return res
}

async function reply (r, query) {
  const res = await run(r, query)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return JSON.parse(JSON.stringify(res.body))
}

async function refused (r, query) {
  const res = await run(r, query)
  assert.ok(res.error, `/book answered ${JSON.stringify(res.body)}`)
  return res.error.message
}

test('write edits a hotbar book in place with the whole page list, one page replaced, and keeps the page once the server echoes it', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX, 'old plan', 'kit: 3 hoes'] }, copy: { farms: [INDEX, 'old plan', 'kit: 3 hoes'] } })
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', page: '2', text: 'site east of the lake\nplatform laid' }),
    { written: true, id: 'farms', page: 2, slot: 36 })
  assert.deepStrictEqual(r.sent, [
    ['held_item_slot', { slotId: 0 }],
    ['edit_book', { hand: 0, pages: [INDEX, 'site east of the lake\nplatform laid', 'kit: 3 hoes'] }]
  ])
  assert.deepStrictEqual(r.stored().books.farms.pages, [INDEX, 'site east of the lake\nplatform laid', 'kit: 3 hoes'])
  assert.strictEqual(r.stored().books.farms.pending, undefined)
  assert.deepStrictEqual(fs.readdirSync(r.dir), ['books.json'])
})

test('a page over 256 UTF-16 units, a 51st page or a book over the byte cap is refused before anything is sent', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX] }, copy: { farms: [INDEX] } })
  const full = 'a'.repeat(254) + SMILE
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', page: '2', text: full }), { written: true, id: 'farms', page: 2, slot: 36 })
  assert.match(await refused(r, { action: 'write', book: 'farms', page: '3', text: full + 'a' }), /over 256/)
  const long = rig(t, { slots: { 36: [INDEX, ...Array(49).fill('x')] }, copy: { farms: [INDEX, ...Array(49).fill('x')] } })
  assert.match(await refused(long, { action: 'write', book: 'farms', page: '51', text: 'one more' }), /50 pages/)
  const wide = 'ü'.repeat(256)
  const heavy = rig(t, { slots: { 36: [INDEX, ...Array(32).fill(wide)] }, copy: { farms: [INDEX, ...Array(32).fill(wide)] } })
  assert.match(await refused(heavy, { action: 'write', book: 'farms', page: '34', text: wide }), /16384 bytes/)
  const foreign = rig(t, { slots: { 36: [INDEX, 'b'.repeat(300)] }, copy: { farms: [INDEX] } })
  assert.match(await refused(foreign, { action: 'write', book: 'farms', page: '1', text: INDEX + '!' }), /page 2 .*over 256/)
  for (const x of [r, long, heavy, foreign]) assert.strictEqual(x.edits().length, x === r ? 1 : 0)
})

test('a write into a book a player pushed past a cap points to restore, which writes the copy back, and a cap the write itself crosses does not', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX, ...Array(50).fill('x')] }, copy: { farms: [INDEX, 'x', 'x'] } })
  assert.strictEqual(await refused(r, { action: 'write', book: 'farms', page: '2', text: 'plan' }), 'the book would pass 50 pages, restore writes your copy back over it')
  assert.strictEqual(r.edits().length, 0)
  assert.strictEqual((await reply(r, { action: 'restore', book: 'farms' })).restored, 'farms')
  assert.deepStrictEqual(r.edits(), [{ hand: 0, pages: [INDEX, 'x', 'x'] }])
  const full = rig(t, { slots: { 36: [INDEX, ...Array(49).fill('x')] }, copy: { farms: [INDEX] } })
  assert.strictEqual(await refused(full, { action: 'write', book: 'farms', page: '51', text: 'one more' }), 'the book would pass 50 pages')
})

test('a write into a book a player pushed past a cap does not point to restore while the copy holds no written page of it', async (t) => {
  for (const copy of [{}, { farms: [null] }]) {
    const r = rig(t, { slots: { 36: [INDEX, ...Array(50).fill('x')] }, copy })
    assert.strictEqual(await refused(r, { action: 'write', book: 'farms', page: '2', text: 'plan', over: '1' }), 'the book would pass 50 pages', JSON.stringify(copy))
    assert.strictEqual(r.edits().length, 0)
  }
})

test('restore refuses a copy over the byte cap with nothing sent', async (t) => {
  const wide = 'ü'.repeat(256)
  const r = rig(t, { slots: { 36: null }, copy: { farms: [INDEX, ...Array(33).fill(wide)] } })
  assert.match(await refused(r, { action: 'restore', book: 'farms' }), /16384 bytes/)
  assert.deepStrictEqual(r.edits(), [])
})

test('without an echo the write fails and stays pending, a player\'s control character on another page keeps the copy readable, and the book read later as sent counts as the pilot\'s own', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX, 'old plan', 'a\tb'] }, copy: { farms: [INDEX, 'old plan'] }, echo: null, echoMs: 30 })
  assert.match(await refused(r, { action: 'write', book: 'farms', page: '2', text: 'new plan' }), /no echo/)
  assert.deepStrictEqual(r.stored().books.farms.pages, [INDEX, 'old plan'])
  assert.doesNotThrow(() => books.load(r.file))
  assert.deepStrictEqual(await reply(r, { action: 'list' }), { books: [{ slot: 36, id: 'farms', pages: 3, changed: [3] }], notCarried: [] })
  r.setSlot(36, bookItem([INDEX, 'new plan', 'a\tb']))
  assert.deepStrictEqual(await reply(r, { action: 'list' }), { books: [{ slot: 36, id: 'farms', pages: 3, changed: [3] }], notCarried: [] })
  assert.deepStrictEqual(r.stored().books.farms.pages, [INDEX, 'new plan'])
})

test('a late edit is taken into the copy once the book shows the pages the pilot wrote, while a player changed another page', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX, 'old plan', 'kit'] }, copy: { farms: [INDEX, 'old plan', 'kit'] }, echo: null, echoMs: 30 })
  assert.match(await refused(r, { action: 'write', book: 'farms', page: '2', text: 'new plan' }), /no echo/)
  r.setSlot(36, bookItem([INDEX, 'new plan', 'their kit']))
  assert.deepStrictEqual(await reply(r, { action: 'list' }), { books: [{ slot: 36, id: 'farms', pages: 3, changed: [3] }], notCarried: [] })
  assert.deepStrictEqual(r.stored().books.farms, { pages: [INDEX, 'new plan', 'kit'], at: r.stored().books.farms.at })
})

const landed = (pages, sent) => ({ pages, at: AT, pending: { pages: sent, wrote: [2], at: AT } })

test('every carried notebook whose pending edit the book shows is taken into the copy in one list', async (t) => {
  const copy = { version: 1, books: { farms: landed([INDEX, 'old plan'], [INDEX, 'new plan']), ores: landed(['notebook ores', 'coal'], ['notebook ores', 'iron']) } }
  const r = rig(t, { slots: { 36: [INDEX, 'new plan'], 37: ['notebook ores', 'iron'] }, copy: JSON.stringify(copy) })
  assert.deepStrictEqual(await reply(r, { action: 'list' }), { books: [{ slot: 36, id: 'farms', pages: 2 }, { slot: 37, id: 'ores', pages: 2 }], notCarried: [] })
  assert.deepStrictEqual(r.stored().books, { farms: { pages: [INDEX, 'new plan'], at: AT }, ores: { pages: ['notebook ores', 'iron'], at: AT } })
})

test('a books file that cannot be saved still lets list answer from the edit the book shows', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX, 'new plan'] }, copy: JSON.stringify({ version: 1, books: { farms: landed([INDEX, 'old plan'], [INDEX, 'new plan']) } }) })
  t.mock.method(books, 'save', () => { throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }) })
  const logged = t.mock.method(console, 'error', () => {})
  assert.deepStrictEqual(await reply(r, { action: 'list' }), { books: [{ slot: 36, id: 'farms', pages: 2 }], notCarried: [] })
  assert.deepStrictEqual(logged.mock.calls.map((c) => c.arguments.join(' ')), ['[book] cannot write the books file: EPERM: operation not permitted, rename'])
})

// CWE-209
test('a books file that cannot be saved refuses a write or a forget without the path, and a write whose pending edit cannot be saved sends nothing', async (t) => {
  const fault = "EPERM: operation not permitted, rename 'C:/Users/Jane Doe/x/books.json.tmp' -> '/home/jane/books.json'"
  const same = rig(t, { slots: { 36: [INDEX, 'theirs'] }, copy: { farms: [INDEX, 'mine'], ores: ['notebook ores'] } })
  assert.deepStrictEqual(await reply(same, { action: 'write', book: 'farms', page: '2', text: 'theirs' }), { written: true, id: 'farms', page: 2, slot: 36, same: true })
  const edit = rig(t, { slots: { 36: [INDEX] }, copy: { farms: [INDEX] } })
  t.mock.method(books, 'save', () => { throw Object.assign(new Error(fault), { code: 'EPERM' }) })
  const logged = t.mock.method(console, 'error', () => {})
  const refusals = [
    await refused(same, { action: 'write', book: 'farms', page: '2', text: 'theirs' }),
    await refused(same, { action: 'forget', book: 'ores' }),
    await refused(edit, { action: 'write', book: 'farms', page: '2', text: 'plan' })
  ]
  assert.deepStrictEqual(refusals, ['your copy could not be saved, nothing written', 'your copy could not be saved, nothing forgotten', 'your copy could not be saved, nothing written'])
  assert.deepStrictEqual(edit.edits(), [])
  assert.deepStrictEqual(logged.mock.calls.map((c) => c.arguments.join(' ')), Array(3).fill(`[book] cannot write the books file: ${fault}`))
})

test('an echo onto another book fails the write naming its slot', async (t) => {
  const r = rig(t, { slots: { 36: null, 40: [INDEX] }, copy: { farms: [INDEX] }, echo: 36, echoMs: 30 })
  assert.match(await refused(r, { action: 'write', book: 'farms', page: '2', text: 'plan' }), /slot 36/)
})

test('another book showing the sent pages before the edited book echoes does not fail the write', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX], 40: [INDEX, 'old plan'] }, copy: { farms: [INDEX] }, echo: null })
  const write = r.bot._client.write
  r.bot._client.write = (name, data) => {
    write(name, data)
    if (name === 'edit_book') setTimeout(() => { r.setSlot(40, bookItem(data.pages)); r.setSlot(36, bookItem(data.pages)) }, 5)
  }
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', slot: '36', page: '2', text: 'plan' }), { written: true, id: 'farms', page: 2, slot: 36 })
})

test('a window resync that re-sends another book already showing the sent pages leaves an edit without echo unlanded', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX], 40: [INDEX, 'plan'] }, copy: { farms: [INDEX] }, echo: null, echoMs: 30 })
  const write = r.bot._client.write
  r.bot._client.write = (name, data) => {
    write(name, data)
    if (name === 'edit_book') setTimeout(() => r.bot.inventory.slots.forEach((item, slot) => r.setSlot(slot, item)), 5)
  }
  assert.match(await refused(r, { action: 'write', book: 'farms', slot: '36', page: '2', text: 'plan' }), /no echo/)
})

test('a book in the hotbar is edited where it lies, holding its slot, with no click', async (t) => {
  const r = rig(t, { slots: { 36: ['shopping list'], 38: [INDEX] }, copy: { farms: [INDEX] } })
  r.bot.quickBarSlot = 1
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', page: '2', text: 'plan' }), { written: true, id: 'farms', page: 2, slot: 38 })
  assert.deepStrictEqual(r.sent, [
    ['held_item_slot', { slotId: 2 }],
    ['edit_book', { hand: 2, pages: [INDEX, 'plan'] }],
    ['held_item_slot', { slotId: 1 }]
  ])
  assert.deepStrictEqual(books.pagesOf(r.bot.inventory.slots[36]), ['shopping list'])
})

test('a server that edits the hotbar slot the edit names writes the book being edited and leaves the book in slot 0 as it is', async (t) => {
  const r = rig(t, { slots: { 36: ['shopping list'], 38: [INDEX] }, copy: { farms: [INDEX] }, echo: 'hand' })
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', page: '2', text: 'plan' }), { written: true, id: 'farms', page: 2, slot: 38 })
  assert.deepStrictEqual(books.pagesOf(r.bot.inventory.slots[36]), ['shopping list'])
  assert.deepStrictEqual([...books.pagesOf(r.bot.inventory.slots[38])], [INDEX, 'plan'])
})

test('a pocket book with no empty hotbar slot is refused with nothing sent', async (t) => {
  const full = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [36 + i, { name: 'cobblestone', count: 64 }]))
  const r = rig(t, { slots: { ...full, 20: [INDEX] }, copy: { farms: [INDEX] } })
  assert.match(await refused(r, { action: 'write', book: 'farms', page: '2', text: 'plan' }), /free a hotbar slot/)
  assert.deepStrictEqual(r.sent, [])
  assert.deepStrictEqual(r.stored().books.farms, { pages: [INDEX], at: AT })
})

test('new and restore take a blank book in the hotbar before one in the pockets and write it where it lies', async (t) => {
  const full = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [36 + i, { name: 'cobblestone', count: 64 }]))
  const slots = { ...full, 40: null, 20: null }
  const made = rig(t, { slots, copy: {} })
  const restored = rig(t, { slots, copy: { farms: [INDEX] } })
  const answer = (res) => res.error ? res.error.message : JSON.parse(JSON.stringify(res.body))
  assert.deepStrictEqual([answer(await run(made, { action: 'new', book: 'farms' })), answer(await run(restored, { action: 'restore', book: 'farms' }))],
    [{ created: 'farms', slot: 40 }, { restored: 'farms', slot: 40, pages: 1, replaced: [] }])
  for (const r of [made, restored]) {
    assert.deepStrictEqual(r.sent.filter(([name]) => name === 'move' || name === 'click'), [])
    assert.deepStrictEqual(books.pagesOf(r.bot.inventory.slots[20]), [])
  }
})

test('a page that differs from the copy is refused with both texts, over replaces it, and other changed pages are named and kept', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX, 'theirs', 'their kit'] }, copy: { farms: [INDEX, 'mine', 'my kit'] } })
  const res = await run(r, { action: 'write', book: 'farms', page: '2', text: 'mine again' })
  assert.deepStrictEqual({ ...res.body, error: undefined }, { ok: false, error: undefined, page: 2, text: 'theirs', yours: 'mine' })
  assert.match(res.body.error, /differs from your copy/)
  assert.strictEqual(r.edits().length, 0)
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', page: '2', text: 'mine again', over: '1' }),
    { written: true, id: 'farms', page: 2, slot: 36, changed: [{ n: 3, text: 'their kit', yours: 'my kit' }] })
  assert.deepStrictEqual(r.edits(), [{ hand: 0, pages: [INDEX, 'mine again', 'their kit'] }])
  assert.deepStrictEqual(r.stored().books.farms.pages, [INDEX, 'mine again', 'my kit'])
})

test('a page with text where the copy holds none is refused with the book\'s text, over replaces it, and the book\'s own text passes', async (t) => {
  for (const mine of [[INDEX, 'plan'], [INDEX, 'plan', null]]) {
    const r = rig(t, { slots: { 36: [INDEX, 'plan', 'meet at the mill'] }, copy: { farms: mine } })
    const res = await run(r, { action: 'write', book: 'farms', page: '3', text: 'kit' })
    assert.deepStrictEqual({ ...res.body, error: undefined }, { ok: false, error: undefined, page: 3, text: 'meet at the mill', yours: null }, JSON.stringify(mine))
    assert.match(res.body.error, /^page 3 of notebook farms differs from your copy/)
    assert.strictEqual(r.edits().length, 0)
    assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', page: '3', text: 'kit', over: '1' }), { written: true, id: 'farms', page: 3, slot: 36 })
    assert.deepStrictEqual(r.edits(), [{ hand: 0, pages: [INDEX, 'plan', 'kit'] }])
  }
  const own = rig(t, { slots: { 36: [INDEX, 'plan', 'meet at the mill'] }, copy: { farms: [INDEX, 'plan'] } })
  assert.deepStrictEqual(await reply(own, { action: 'write', book: 'farms', page: '3', text: 'meet at the mill' }), { written: true, id: 'farms', page: 3, slot: 36, same: true })
  assert.deepStrictEqual(own.edits(), [])
})

test('a write that leaves the book as it is sends nothing and takes the page into the copy', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX, 'theirs'] }, copy: { farms: [INDEX, 'mine'] } })
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', page: '2', text: 'theirs' }), { written: true, id: 'farms', page: 2, slot: 36, same: true })
  assert.deepStrictEqual(r.sent, [])
  assert.deepStrictEqual(r.stored().books.farms.pages, [INDEX, 'theirs'])
})

test('list names each carried book by slot with its id, page count and changed pages, and the notebooks not carried', async (t) => {
  const r = rig(t, {
    slots: { 36: [INDEX, 'theirs'], 37: null, 40: ['shopping list'], 44: ['notebook mine\nores'] },
    copy: { farms: [INDEX, 'mine'], ores: ['notebook ores'] }
  })
  r.bot.currentWindow = { slots: [bookItem(['notebook vault'])] }
  assert.deepStrictEqual(await reply(r, { action: 'list' }), {
    books: [
      { slot: 36, id: 'farms', pages: 2, changed: [2] },
      { slot: 37, id: null, pages: 0, blank: true },
      { slot: 40, id: null, pages: 1 },
      { slot: 44, id: 'mine', pages: 1, unknown: true }
    ],
    notCarried: ['ores']
  })
})

test('read gives pages from page on with your copy where it differs, and two books of one id are reached only by slot', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX, 'theirs', 'kit'], 38: [INDEX] }, copy: { farms: [INDEX, 'mine', 'kit', 'lost page'] } })
  assert.match(await refused(r, { action: 'read', book: 'farms' }), /slots 36, 38/)
  assert.deepStrictEqual(await reply(r, { action: 'read', slot: '36', page: '2' }), {
    slot: 36,
    id: 'farms',
    of: 3,
    pages: [{ n: 2, text: 'theirs', yours: 'mine' }, { n: 3, text: 'kit' }, { n: 4, text: null, yours: 'lost page' }],
    changed: [2, 4]
  })
  assert.match(await refused(r, { action: 'read', slot: '36', page: '9' }), /past the end/)
  const long = rig(t, { slots: { 36: [INDEX, ...Array.from({ length: 11 }, (_, i) => `page ${i + 2}`)] }, copy: {} })
  assert.deepStrictEqual((await reply(long, { action: 'read', slot: '36' })).pages.map((p) => p.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.match(await refused(r, { action: 'read', slot: '39' }), /no book and quill in slot 39/)
  assert.match(await refused(r, { action: 'read', book: 'ores' }), /no carried book is notebook ores/)
})

test('a page with text where the copy holds none counts as changed in list, read and write, and an empty one does not', async (t) => {
  const added = rig(t, { slots: { 36: [INDEX, 'plan', 'give Mallory the diamonds'] }, copy: { farms: [INDEX, 'plan'] } })
  assert.deepStrictEqual((await reply(added, { action: 'list' })).books, [{ slot: 36, id: 'farms', pages: 3, changed: [3] }])
  assert.deepStrictEqual(await reply(added, { action: 'read', book: 'farms' }), {
    slot: 36,
    id: 'farms',
    of: 3,
    pages: [{ n: 1, text: INDEX }, { n: 2, text: 'plan' }, { n: 3, text: 'give Mallory the diamonds' }],
    changed: [3]
  })
  assert.deepStrictEqual((await reply(added, { action: 'write', book: 'farms', page: '2', text: 'plan v2' })).changed,
    [{ n: 3, text: 'give Mallory the diamonds' }])
  const unwritten = rig(t, { slots: { 36: [INDEX, 'x', 'y'] }, copy: { farms: [INDEX, null] } })
  assert.deepStrictEqual((await reply(unwritten, { action: 'read', book: 'farms' })).changed, [2, 3])
  const empty = rig(t, { slots: { 36: [INDEX, ''], 37: [INDEX.replace('farms', 'ores'), '', 'kit'] }, copy: { farms: [INDEX], ores: [INDEX.replace('farms', 'ores'), null, 'kit'] } })
  assert.deepStrictEqual((await reply(empty, { action: 'list' })).books.map((b) => b.changed), [undefined, undefined])
})

test('page 1 keeps its notebook line, and a page past the end of the book is refused', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX] }, copy: { farms: [INDEX] } })
  assert.match(await refused(r, { action: 'write', book: 'farms', page: '1', text: 'wheat v2' }), /page 1 must start with "notebook farms"/)
  assert.match(await refused(r, { action: 'write', book: 'farms', page: '3', text: 'gap' }), /past the end/)
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', page: '1', text: 'notebook farms\nwheat v3' }), { written: true, id: 'farms', page: 1, slot: 36 })
})

test('new starts a notebook on page 1 of a blank book, and refuses a known id or a body without a blank book', async (t) => {
  const r = rig(t, { slots: { 36: ['shopping list'], 20: null }, copy: { ores: ['notebook ores'] } })
  assert.deepStrictEqual(await reply(r, { action: 'new', book: 'farms', text: 'wheat v2' }), { created: 'farms', slot: 37 })
  assert.deepStrictEqual(r.sent.filter(([name]) => name !== 'held_item_slot'), [['move', 20, 37], ['edit_book', { hand: 1, pages: ['notebook farms\nwheat v2'] }]])
  assert.deepStrictEqual(r.stored().books.farms.pages, ['notebook farms\nwheat v2'])
  assert.match(await refused(r, { action: 'new', book: 'ores' }), /in your copy already/)
  assert.match(await refused(r, { action: 'new', book: 'mills' }), /no blank book and quill/)
  assert.match(await refused(r, { action: 'new', book: 'Farms!' }), /a-z/)
})

test('a new that never landed keeps its id taken while its edit is pending, and frees it once nothing is pending', async (t) => {
  const r = rig(t, { slots: { 36: null }, copy: {}, echo: null, echoMs: 30 })
  assert.match(await refused(r, { action: 'new', book: 'farms' }), /no echo/)
  assert.strictEqual(await refused(r, { action: 'new', book: 'farms' }), 'a new of notebook farms may still land, list shows it once it does, or forget it')
  assert.strictEqual(r.edits().length, 1)
  fs.writeFileSync(r.file, copyOf({ farms: [] }))
  r.server.echo = 'held'
  assert.deepStrictEqual(await reply(r, { action: 'new', book: 'farms' }), { created: 'farms', slot: 36 })
  assert.deepStrictEqual(r.stored().books.farms.pages, ['notebook farms'])
})

test('new refuses an id a carried book already says, naming its slot, with nothing sent', async (t) => {
  const r = rig(t, { slots: { 36: null, 40: [INDEX] }, copy: {} })
  assert.match(await refused(r, { action: 'new', book: 'farms' }), /the book in slot 40 is notebook farms already/)
  assert.deepStrictEqual(r.sent, [])
  assert.deepStrictEqual(r.stored().books, {})
})

test('new names the carried book of an id the copy did not know while a write to it is pending', async (t) => {
  const r = rig(t, { slots: { 36: ['notebook farms'], 37: null }, copy: {}, echo: null, echoMs: 30 })
  assert.match(await refused(r, { action: 'write', book: 'farms', page: '2', text: 'x' }), /no echo/)
  assert.ok(r.stored().books.farms.pending)
  assert.strictEqual(await refused(r, { action: 'new', book: 'farms' }), 'the book in slot 36 is notebook farms already')
  assert.strictEqual(r.edits().length, 1)
})

test('a notebook whose id names an Object property is created and listed', async (t) => {
  const r = rig(t, { slots: { 36: null }, copy: {} })
  assert.deepStrictEqual(await reply(r, { action: 'new', book: 'constructor' }), { created: 'constructor', slot: 36 })
  assert.deepStrictEqual(await reply(r, { action: 'list' }), { books: [{ slot: 36, id: 'constructor', pages: 1 }], notCarried: [] })
})

test('restore writes the copy into a blank book or back over its own notebook naming what it replaced, and needs over for another book', async (t) => {
  const r = rig(t, { slots: { 36: null, 40: ['shopping list'] }, copy: { farms: [INDEX, null, 'kit'] } })
  assert.deepStrictEqual(await reply(r, { action: 'restore', book: 'farms' }), { restored: 'farms', slot: 36, pages: 3, replaced: [] })
  assert.deepStrictEqual(r.edits(), [{ hand: 0, pages: [INDEX, '', 'kit'] }])
  r.setSlot(36, bookItem([INDEX, 'theirs', 'kit']))
  assert.deepStrictEqual(await reply(r, { action: 'restore', book: 'farms' }), { restored: 'farms', slot: 36, pages: 3, replaced: [{ n: 2, text: 'theirs' }] })
  assert.match(await refused(r, { action: 'restore', book: 'farms', slot: '40' }), /over/)
  assert.deepStrictEqual(await reply(r, { action: 'restore', book: 'farms', slot: '40', over: '1' }), { restored: 'farms', slot: 40, pages: 3, replaced: [{ n: 1, text: 'shopping list' }] })
  assert.deepStrictEqual(r.sent.filter(([name]) => name === 'move' || name === 'click'), [])
  assert.match(await refused(r, { action: 'restore', book: 'ores' }), /not in your copy/)
  const padded = rig(t, { slots: { 36: null }, copy: { farms: [null, 'plan'] } })
  assert.deepStrictEqual(await reply(padded, { action: 'restore', book: 'farms' }), { restored: 'farms', slot: 36, pages: 2, replaced: [] })
  assert.deepStrictEqual(padded.edits(), [{ hand: 0, pages: ['notebook farms', 'plan'] }])
})

test('restore refuses a copy without a written page as empty with nothing sent, while one with a later page written restores over the carried book with page 1 padded', async (t) => {
  const written = rig(t, { slots: { 36: [INDEX, 'theirs'] }, copy: { farms: [null, 'plan'] } })
  assert.deepStrictEqual(await reply(written, { action: 'restore', book: 'farms' }), { restored: 'farms', slot: 36, pages: 2, replaced: [{ n: 1, text: INDEX }, { n: 2, text: 'theirs' }] })
  assert.deepStrictEqual(written.edits(), [{ hand: 0, pages: ['notebook farms', 'plan'] }])
  const pending = { pages: [], at: AT, pending: { pages: ['notebook farms'], wrote: [1], at: AT } }
  for (const copy of [copyOf({ farms: [null] }), JSON.stringify({ version: 1, books: { farms: pending } })]) {
    const r = rig(t, { slots: { 36: [INDEX, 'theirs'] }, copy })
    assert.strictEqual(await refused(r, { action: 'restore', book: 'farms' }), 'your copy of notebook farms is empty', copy)
    assert.deepStrictEqual(r.edits(), [])
  }
})

test('read and write refuse a slot that holds another book than the named notebook with nothing sent, while new and restore take a blank book there', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX], 40: ['notebook ores'], 41: ['shopping list'] }, copy: { farms: [INDEX], ores: ['notebook ores'] } })
  for (const query of [{ action: 'read' }, { action: 'write', page: '2', text: 'plan' }]) {
    assert.match(await refused(r, { ...query, book: 'farms', slot: '40' }), /slot 40 is notebook ores, not notebook farms/, query.action)
    assert.match(await refused(r, { ...query, book: 'farms', slot: '41' }), /slot 41 holds no notebook, not notebook farms/, query.action)
  }
  assert.deepStrictEqual(r.sent, [])
  assert.deepStrictEqual(r.stored().books, { farms: { pages: [INDEX], at: AT }, ores: { pages: ['notebook ores'], at: AT } })
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'ores', slot: '40', page: '2', text: 'iron by the ravine' }), { written: true, id: 'ores', page: 2, slot: 40 })
  const blank = rig(t, { slots: { 37: null, 38: null }, copy: { farms: [INDEX] } })
  assert.deepStrictEqual(await reply(blank, { action: 'new', book: 'mills', slot: '37' }), { created: 'mills', slot: 37 })
  assert.deepStrictEqual(await reply(blank, { action: 'restore', book: 'farms', slot: '38' }), { restored: 'farms', slot: 38, pages: 1, replaced: [] })
})

test('forget drops a notebook from the copy', async (t) => {
  const r = rig(t, { copy: { farms: [INDEX], ores: ['notebook ores'] } })
  assert.deepStrictEqual(await reply(r, { action: 'forget', book: 'farms' }), { forgot: 'farms' })
  assert.deepStrictEqual(Object.keys(r.stored().books), ['ores'])
  assert.match(await refused(r, { action: 'forget', book: 'farms' }), /not in your copy/)
})

test('a forget sent while a write waits for its echo stays forgotten once the write lands', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX] }, copy: { farms: [INDEX], ores: ['notebook ores'] }, echo: null, echoMs: 2000 })
  const writing = reply(r, { action: 'write', book: 'farms', page: '2', text: 'plan' })
  await new Promise(setImmediate)
  assert.strictEqual(r.edits().length, 1)
  const forgetting = reply(r, { action: 'forget', book: 'ores' })
  await new Promise(setImmediate)
  assert.ok(r.stored().books.ores)
  r.setSlot(36, bookItem([INDEX, 'plan']))
  assert.deepStrictEqual(await writing, { written: true, id: 'farms', page: 2, slot: 36 })
  assert.deepStrictEqual(await forgetting, { forgot: 'ores' })
  assert.deepStrictEqual(r.stored().books, { farms: { pages: [INDEX, 'plan'], at: r.stored().books.farms.at } })
})

test('a pocket book moves into an empty hotbar slot, never onto another book, and a loaded cursor after the move stops the write and goes back to its slot', async (t) => {
  const r = rig(t, { slots: { 36: ['shopping list'], 20: [INDEX] }, copy: { farms: [INDEX] } })
  r.bot.quickBarSlot = 3
  assert.deepStrictEqual(await reply(r, { action: 'write', book: 'farms', page: '2', text: 'plan' }), { written: true, id: 'farms', page: 2, slot: 37 })
  assert.deepStrictEqual(r.sent, [['move', 20, 37], ['held_item_slot', { slotId: 1 }], ['edit_book', { hand: 1, pages: [INDEX, 'plan'] }], ['held_item_slot', { slotId: 3 }]])
  assert.deepStrictEqual(books.pagesOf(r.bot.inventory.slots[36]), ['shopping list'])
  const stuck = rig(t, { slots: { 20: [INDEX] }, copy: { farms: [INDEX] } })
  stuck.bot.moveSlotItem = async (from, to) => {
    stuck.sent.push(['move', from, to])
    stuck.bot.inventory.selectedItem = stuck.bot.inventory.slots[from]
    stuck.bot.inventory.slots[from] = null
  }
  stuck.bot.clickWindow = async (slot) => {
    stuck.sent.push(['click', slot])
    stuck.bot.inventory.slots[slot] = stuck.bot.inventory.selectedItem
    stuck.bot.inventory.selectedItem = null
  }
  assert.match(await refused(stuck, { action: 'write', book: 'farms', page: '2', text: 'plan' }), /did not settle/)
  assert.deepStrictEqual(stuck.sent, [['move', 20, 36], ['click', 20]])
  assert.deepStrictEqual(books.pagesOf(stuck.bot.inventory.slots[20]), [INDEX])
})

test('a hand taken during the pocket book move refuses the write with no edit sent and no pending edit kept', async (t) => {
  const r = rig(t, { slots: { 20: [INDEX] }, copy: { farms: [INDEX] } })
  const move = r.bot.moveSlotItem
  r.bot.moveSlotItem = async (from, to) => {
    await move(from, to)
    r.env.guardState.hand.end()
  }
  assert.match(await refused(r, { action: 'write', book: 'farms', page: '2', text: 'plan' }), /another action took the hand/)
  assert.deepStrictEqual(r.edits(), [])
  assert.deepStrictEqual(r.stored().books.farms, { pages: [INDEX], at: AT })
})

test('a change is refused with nothing sent while a window is open, a fight holds the hand or a self-rescue holds the dig lock', async (t) => {
  const open = rig(t, { slots: { 36: [INDEX] }, copy: { farms: [INDEX] } })
  open.bot.currentWindow = { slots: [] }
  assert.match(await refused(open, { action: 'write', book: 'farms', page: '2', text: 'plan' }), /window is open/)
  const fighting = rig(t, { slots: { 36: [INDEX] }, copy: { farms: [INDEX] } })
  fighting.fight.busy = true
  assert.match(await refused(fighting, { action: 'write', book: 'farms', page: '2', text: 'plan' }), /^refused: fighting/)
  const buried = rig(t, { slots: { 36: [INDEX] }, copy: { farms: [INDEX] } })
  buried.env.digLock = botConstant('digLock')
  claimRescue(buried.env.digLock)
  assert.match(await refused(buried, { action: 'write', book: 'farms', page: '2', text: 'plan' }), /^busy: /)
  for (const r of [open, fighting, buried]) assert.deepStrictEqual(r.sent, [])
})

test('an unreadable copy still lists and reads, refuses every change and stays as it is, and without a books file notebooks are off', async (t) => {
  const err = t.mock.method(console, 'error', () => {})
  const raw = '{"version": 1, "books": {"farms": secret-marker-7c'
  const r = rig(t, { slots: { 36: [INDEX] }, copy: raw })
  assert.deepStrictEqual(await reply(r, { action: 'list' }), { books: [{ slot: 36, id: 'farms', pages: 1 }], notCarried: [], copy: 'unreadable' })
  assert.deepStrictEqual((await reply(r, { action: 'read', book: 'farms' })).pages, [{ n: 1, text: INDEX }])
  for (const query of [{ action: 'write', book: 'farms', page: '2', text: 'x' }, { action: 'new', book: 'ores' }, { action: 'restore', book: 'farms' }, { action: 'forget', book: 'farms' }]) {
    assert.match(await refused(r, query), /your copy is unreadable/, query.action)
  }
  assert.strictEqual(fs.readFileSync(r.file, 'utf8'), raw)
  assert.deepStrictEqual(r.sent, [])
  for (const c of err.mock.calls) assert.doesNotMatch(c.arguments.join(' '), /secret/)
  const off = rig(t, { slots: { 36: [INDEX] }, file: false })
  assert.match(await refused(off, { action: 'list' }), /notebooks are off/)
})

function bookRouteWith (value) {
  const id = require.resolve('../lib/routes/memory')
  const before = process.env.GOLEM_BOOKS
  process.env.GOLEM_BOOKS = value
  delete require.cache[id]
  let routes
  try {
    routes = require(id)
  } finally {
    delete require.cache[id]
    if (before === undefined) delete process.env.GOLEM_BOOKS
    else process.env.GOLEM_BOOKS = before
  }
  const handlers = new Map()
  const ctx = {
    bot: { inventory: { slots: new Array(46).fill(null) } },
    ok: (res, body) => { res.body = body },
    err: (res, e) => { res.error = e },
    send: (res, body) => { res.body = body }
  }
  routes.createMemoryRoutes(ctx)
  routes.bindMemoryRoutes(ctx)
  ctx.installMemoryRoutes({ get: (route, fn) => handlers.set(route, fn) })
  return async (query) => {
    const res = {}
    await handlers.get('/book')({ query }, res)
    return res
  }
}

test('a relative GOLEM_BOOKS leaves notebooks off and logs that the path must be absolute', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-book-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const logged = t.mock.method(console, 'error', () => {})
  const absolute = await bookRouteWith(path.join(dir, 'books.json'))({ action: 'list' })
  assert.deepStrictEqual(absolute.body, { books: [], notCarried: [] })
  assert.strictEqual(logged.mock.calls.length, 0)
  const relative = await bookRouteWith('books.json')({ action: 'list' })
  assert.strictEqual(relative.error && relative.error.message, 'notebooks are off')
  assert.deepStrictEqual(logged.mock.calls.map((c) => c.arguments.join(' ')), ['[book] GOLEM_BOOKS must be an absolute path, notebooks are off'])
})

test('no reply or refusal of book names a block or entity out of sight', async (t) => {
  const r = rig(t, { slots: { 36: [INDEX], 37: null }, copy: { farms: [INDEX] } })
  const hidden = new Vec3(12, 64, 7)
  r.bot.entities = { 5: { id: 5, type: 'player', username: 'Hidalgo', position: hidden, heldItem: bookItem(['notebook vault']) } }
  r.bot.blockAt = (p) => ({ name: p.equals(hidden) ? 'chest' : 'stone', position: p })
  r.bot.findBlocks = () => [hidden]
  const replies = []
  for (const query of [
    { action: 'list' }, { action: 'read', book: 'farms' }, { action: 'read', book: 'vault' }, { action: 'read', slot: '30' },
    { action: 'write', book: 'farms', page: '2', text: 'plan' }, { action: 'write', book: 'vault', page: '1', text: 'x' },
    { action: 'new', book: 'vault' }, { action: 'new', book: 'farms' }, { action: 'restore', book: 'vault' }, { action: 'forget', book: 'vault' }
  ]) {
    const res = await run(r, query)
    replies.push(JSON.stringify(res.body ?? null) + (res.error ? res.error.message : ''))
  }
  for (const text of replies) assert.doesNotMatch(text, /Hidalgo|chest|12,64,7|"x":12/)
})

test('the copy loads only its own shape, keeps an id that names an Object property, and saves through a tmp file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-books-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'books.json')
  assert.strictEqual(books.load(file).size, 0)
  const good = { version: 1, books: { farms: { pages: [INDEX, null], at: AT } } }
  fs.writeFileSync(file, JSON.stringify(good))
  assert.deepStrictEqual([...books.load(file).keys()], ['farms'])
  const cases = [
    ['another version', { ...good, version: 2 }],
    ['an id with a capital', { version: 1, books: { Farms: good.books.farms } }],
    ['a page over 256', { version: 1, books: { farms: { pages: ['x'.repeat(257)], at: AT } } }],
    ['a page with a carriage return', { version: 1, books: { farms: { pages: ['a\rb'], at: AT } } }],
    ['51 pages', { version: 1, books: { farms: { pages: Array(51).fill('x'), at: AT } } }],
    ['17 notebooks', { version: 1, books: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`b${i}`, good.books.farms])) }],
    ['an at without milliseconds', { version: 1, books: { farms: { pages: [], at: '2026-10-30T12:00:00Z' } } }],
    ['a written pending page with a carriage return', { version: 1, books: { farms: { pages: [INDEX], at: AT, pending: { pages: [INDEX, 'a\rb'], wrote: [2], at: AT } } } }],
    ['an extra key in a notebook', { version: 1, books: { farms: { ...good.books.farms, junk: 'x' } } }],
    ['an extra key in a pending edit', { version: 1, books: { farms: { pages: [INDEX], at: AT, pending: { pages: [INDEX, 'b'], wrote: [2], at: AT, junk: 'x' } } } }],
    ['an extra top-level key', { ...good, junk: 'x' }]
  ]
  for (const [label, data] of cases) {
    fs.writeFileSync(file, JSON.stringify(data))
    assert.throws(() => books.load(file), { name: 'TypeError', message: 'the books file is malformed' }, label)
  }
  fs.writeFileSync(file, `{"version": 1, "books": {"constructor": {"pages": [], "at": "${AT}"}}}`)
  const named = books.load(file)
  assert.deepStrictEqual([...named.keys()], ['constructor'])
  books.save(file, named)
  assert.deepStrictEqual(books.load(file), named)
  const store = new Map([['farms', { pages: [INDEX], at: AT }]])
  books.save(file, store)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, books: { farms: { pages: [INDEX], at: AT } } })
  assert.deepStrictEqual(fs.readdirSync(dir), ['books.json'])
})

test('an adopted edit takes only the pages the pilot wrote into the copy', () => {
  const later = '2026-10-30T12:05:00.000Z'
  const copy = { pages: [INDEX, 'old plan'], at: AT, pending: { pages: [INDEX, 'new plan', 'a\tb'], wrote: [2], at: later } }
  assert.strictEqual(books.adopt(copy, [INDEX, 'new plan', 'a\tb']), true)
  assert.deepStrictEqual(copy, { pages: [INDEX, 'new plan'], at: later })
})

test('/book text takes a line break and refuses every other control character', async (t) => {
  const s = await startApp(t)
  const enc = encodeURIComponent
  assert.strictEqual((await s.get('/book?action=write&book=farms&page=2&text=' + enc('one\ntwo'))).status, 200)
  assert.strictEqual(s.routeHits('/book')[0].query.text, 'one\ntwo')
  for (const text of ['a\rb', 'a\tb', 'a\u007fb']) {
    assert.strictEqual((await s.get('/book?action=write&book=farms&page=2&text=' + enc(text))).status, 400, JSON.stringify(text))
  }
  assert.strictEqual(s.routeHits('/book').length, 1)
})

test('book changes wait their turn behind a running body call, list and read do not, and the notebook primer goes out once', async (t) => {
  const seen = []
  let release
  const { srv } = mcpServer({
    reply: (url) => {
      seen.push(url.pathname + url.search)
      if (url.pathname === '/goto') return new Promise((resolve) => { release = () => resolve({ ok: true }) })
      return { ok: true }
    }
  })
  t.after(() => release && release())
  const walking = call(srv, 'goto', { x: 1, z: 1 })
  for (const args of [{ action: 'write', book: 'farms', page: 2, text: 'plan' }, { action: 'new', book: 'farms' }, { action: 'restore', book: 'farms' }]) {
    assert.match(errorText(await call(srv, 'book', args)), /^busy: goto/, args.action)
  }
  const listed = await call(srv, 'book', { action: 'list' })
  assert.ok(!isToolError(listed))
  assert.match(listed.result.content.map((c) => c.text).join('\n'), /More: manual\('notebook'\)/)
  const read = await call(srv, 'book', { action: 'read', book: 'farms' })
  assert.doesNotMatch(read.result.content.map((c) => c.text).join('\n'), /More: manual/)
  release()
  await walking
  assert.ok(!isToolError(await call(srv, 'book', { action: 'write', book: 'farms', page: 2, text: 'one\ntwo' })))
  assert.ok(seen.includes('/book?action=write&book=farms&page=2&text=one%0Atwo'), JSON.stringify(seen))
})

test('book page text reaches the pilot as written, while an error and another tool\'s text still lose their paths', async (t) => {
  const page = 'C:\\Users\\x\\a.png and \\\\nas\\share\\x, ok'
  const replies = {
    read: { slot: 36, id: 'farms', of: 2, pages: [{ n: 2, text: page, yours: page + '!' }], changed: [2] },
    write3: { written: true, id: 'farms', page: 3, slot: 36, changed: [{ n: 2, text: page, yours: page + '!' }] },
    write2: { ok: false, error: 'page 2 differs, see D:\\golem\\books.json', page: 2, text: page, yours: page + '!' },
    restore: { restored: 'farms', slot: 36, pages: 2, replaced: [{ n: 2, text: page }] }
  }
  const { srv } = mcpServer({
    reply: (url) => (url.pathname === '/book' ? replies[url.searchParams.get('action') + (url.searchParams.get('page') ?? '')] : { ok: true, text: page })
  })
  const text = (r) => r.result.content.map((c) => c.text).join('\n')
  for (const args of [{ action: 'read' }, { action: 'write', page: 3, text: 'x' }, { action: 'write', page: 2, text: 'x' }, { action: 'restore' }]) {
    const shown = text(await call(srv, 'book', { book: 'farms', ...args }))
    assert.ok(shown.includes(JSON.stringify(page)), shown)
    if (args.page === 2) assert.doesNotMatch(shown, /D:|golem\\/)
  }
  assert.doesNotMatch(text(await call(srv, 'scene', {})), /Users|nas/)
})

test('book page text reaches the pilot without invisible characters and keeps its line breaks', async (t) => {
  const page = 'a\u202Eb\u200Bc\u{E0041}d\u2800\ne'
  const replies = {
    read: { slot: 36, id: 'farms', of: 2, pages: [{ n: 2, text: page, yours: page }], changed: [2] },
    write3: { written: true, id: 'farms', page: 3, slot: 36, changed: [{ n: 2, text: page, yours: page }] },
    write2: { ok: false, error: 'page 2 of notebook farms differs from your copy', page: 2, text: page, yours: page },
    restore: { restored: 'farms', slot: 36, pages: 2, replaced: [{ n: 2, text: page }] }
  }
  const { srv } = mcpServer({ reply: (url) => replies[url.searchParams.get('action') + (url.searchParams.get('page') ?? '')] })
  for (const args of [{ action: 'read' }, { action: 'write', page: 3, text: 'x' }, { action: 'write', page: 2, text: 'x' }, { action: 'restore' }]) {
    const shown = (await call(srv, 'book', { book: 'farms', ...args })).result.content.map((c) => c.text).join('\n')
    assert.ok(shown.includes(JSON.stringify('abcd\ne')), shown)
    assert.doesNotMatch(shown, /[\u202E\u200B\u{E0041}\u2800]/u)
  }
})
