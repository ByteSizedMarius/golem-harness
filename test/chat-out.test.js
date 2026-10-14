'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { planChat, createChatQueue } = require('../lib/chat-out')
const { ALLOW, stripLead, serverCommand, assertNoForeignCommand, assertSafeChunks } = require('./helpers')

const OPTS = { maxLen: 100, allow: ALLOW }
const EMOJI = '\u{1F600}'

function plan (text, opts = OPTS) {
  const r = planChat(text, opts)
  assert.ok(r && typeof r === 'object', 'planChat returns an object')
  return r
}

function lines (text, opts = OPTS) {
  const r = plan(text, opts)
  assert.strictEqual(r.error, undefined, `unexpected error ${r.error}`)
  assert.ok(Array.isArray(r.lines), 'lines array')
  return r.lines
}

function refused (text, status, opts = OPTS) {
  const r = plan(text, opts)
  assert.strictEqual(r.status, status)
  assert.strictEqual(typeof r.error, 'string')
  assert.strictEqual(r.lines, undefined)
}

function sentOrRefused (text, opts = OPTS) {
  const r = plan(text, opts)
  if (r.error !== undefined) {
    assert.ok([400, 403].includes(r.status), `status ${r.status}`)
    return []
  }
  return r.lines
}

test('plain text plans one line, unchanged', () => {
  assert.deepStrictEqual(lines('hello'), ['hello'])
})

test('a newline starts neither a second line nor a command', () => {
  assert.deepStrictEqual(lines('hello'), ['hello'])
  const out = lines('hello\n/op x')
  assert.strictEqual(out.length, 1)
  assert.ok(out[0].startsWith('hello'))
  assertSafeChunks(out, 100)
  assert.ok(!stripLead(out[0]).startsWith('/'))
})

test('leading control or whitespace before a command is refused with 403', () => {
  assert.deepStrictEqual(lines('/me waves'), ['/me waves'])
  refused(' /op Alice', 403)
  refused('\t/op x', 403)
})

test('Unicode whitespace and format characters before / are refused with 403', () => {
  assert.deepStrictEqual(lines('/me waves'), ['/me waves'])
  for (const lead of [' ', '​']) refused(lead + '/op x', 403)
})

test('allowlisted commands pass, case-insensitive', () => {
  assert.deepStrictEqual(lines('/me waves'), ['/me waves'])
  assert.deepStrictEqual(lines('/tell Bob hi'), ['/tell Bob hi'])
  const up = lines('/ME waves')
  assert.strictEqual(up.length, 1)
  assert.strictEqual(up[0].toLowerCase(), '/me waves')
})

test('commands off the allowlist are refused with 403', () => {
  assert.deepStrictEqual(lines('/me waves'), ['/me waves'])
  refused('/op Claude', 403)
})

test('the command word must equal an allowlist entry, not share a prefix', () => {
  assert.deepStrictEqual(lines('/w Bob hi'), ['/w Bob hi'])
  refused('/whitelist add x', 403)
  refused('/', 403)
})

test('the allowlist comes from the options', () => {
  assert.deepStrictEqual(lines('/me waves'), ['/me waves'])
  refused('/me waves', 403, { maxLen: 100, allow: ['tell'] })
})

test('an allowed command word glued to a control or format char never becomes another command', () => {
  assert.deepStrictEqual(lines('/me waves'), ['/me waves'])
  for (const text of ['/tell\u0007op x', '/me​/op x', '/me\u007f op x']) {
    const out = sentOrRefused(text)
    assertSafeChunks(out, 100)
    assertNoForeignCommand(out)
  }
})

test('a character whose normalisation yields / never produces a foreign command', () => {
  assert.deepStrictEqual(lines('§chello'), ['chello'])
  const out = sentOrRefused('／op x')
  assertSafeChunks(out, 100)
  assertNoForeignCommand(out)
})

test('characters below 0x20, 0x7F and the section sign never appear in a line', () => {
  assert.deepStrictEqual(lines('hello'), ['hello'])
  assert.deepStrictEqual(lines('§chello'), ['chello'])
  const out = lines('a\u0000b\u0007c\u007fd§e')
  assertSafeChunks(out, 100)
  assert.ok(out.join('').includes('a'))
  assert.ok(out.join('').includes('e'))
})

test('a command hidden behind the chunk boundary never leads a chunk', () => {
  assert.deepStrictEqual(lines('hello'), ['hello'])
  for (const sep of [' ', ' ']) {
    const out = lines('a'.repeat(99) + sep + '/op Alice')
    assert.ok(out.length >= 2, 'long chat is split, not cut')
    assertSafeChunks(out, 100)
    for (const c of out) assert.ok(!stripLead(c).startsWith('/'), JSON.stringify(c))
    assertNoForeignCommand(out)
    assert.ok((out.join('').match(/a/g) || []).length >= 99)
    assert.ok(out.some((c) => c.includes('Alice')))
  }
})

test('surrogate pairs at the chunk boundary are never split', () => {
  assert.deepStrictEqual(lines('hello'), ['hello'])
  for (const text of ['a'.repeat(99) + EMOJI.repeat(20), '/tell Bob ' + 'a'.repeat(89) + EMOJI.repeat(20)]) {
    const out = lines(text)
    assertSafeChunks(out, 100)
    assert.strictEqual(out.join('').split(EMOJI).length - 1, 20, JSON.stringify(text.slice(0, 12)))
  }
})

test('chunk size follows the maxLen option', () => {
  assert.deepStrictEqual(lines('hello'), ['hello'])
  const out = lines('a'.repeat(250), { maxLen: 50, allow: ALLOW })
  assert.ok(out.length >= 5)
  assertSafeChunks(out, 50)
  assert.strictEqual((out.join('').match(/a/g) || []).length, 250)
})

// ---- whispers ----

test('a long whisper repeats /tell and the target in every chunk', () => {
  assert.deepStrictEqual(lines('/tell Bob hi'), ['/tell Bob hi'])
  const out = lines('/tell Bob ' + 'x'.repeat(300))
  assert.ok(out.length >= 4)
  assertSafeChunks(out, 100)
  for (const c of out) assert.ok(c.startsWith('/tell Bob '), JSON.stringify(c))
  assert.strictEqual((out.join('').match(/x/g) || []).length, 300)
  // ' /op Alice' straddles the first chunk boundary.
  const hidden = lines('/tell Bob ' + 'a'.repeat(85) + ' /op Alice ' + 'b'.repeat(50))
  assertSafeChunks(hidden, 100)
  for (const c of hidden) assert.ok(c.startsWith('/tell Bob '), JSON.stringify(c))
})

test('a long whisper with runs of spaces keeps the target as the server reads it', () => {
  assert.deepStrictEqual(lines('/tell Bob hi'), ['/tell Bob hi'])
  const out = sentOrRefused('/tell   Bob    ' + 'y '.repeat(140))
  for (const c of out) {
    const normal = stripLead(c).replace(/[\t\n\u000b\f\r ]+/g, ' ')
    assert.ok(normal.startsWith('/tell Bob '), JSON.stringify(c))
  }
})

test('a whisper whose target cannot fit in a chunk never goes public', () => {
  assert.deepStrictEqual(lines('/tell Bob hi'), ['/tell Bob hi'])
  assert.ok(lines('/tell ' + 'B'.repeat(90) + ' secret words here').length > 0, 'control: a 90-char target fits')
  for (const n of [90, 120]) {
    const out = sentOrRefused('/tell ' + 'B'.repeat(n) + ' secret words here')
    for (const c of out) assert.strictEqual(serverCommand(c), 'tell', `n ${n}: ${JSON.stringify(c)}`)
  }
})

test('a whisper written with an NBSP or tab separator never goes public', () => {
  assert.deepStrictEqual(lines('/tell Bob hi'), ['/tell Bob hi'])
  for (const sep of [' ', '\t']) {
    const out = sentOrRefused('/tell' + sep + 'Bob ' + 'secret '.repeat(40))
    for (const c of out) assert.notStrictEqual(serverCommand(c), null, `${JSON.stringify(sep)}: public chunk ${JSON.stringify(c)}`)
    assertNoForeignCommand(out)
  }
})

// ---- the queue ----

function harness ({ gapMs = 2500, maxDepth = 20, hold = false } = {}) {
  const log = []
  const pending = []
  const sleep = (ms) => {
    log.push(['sleep', ms])
    return new Promise((resolve) => (hold ? pending.push(resolve) : setImmediate(resolve)))
  }
  const send = (text) => { log.push(['send', text]) }
  const q = createChatQueue({ send, gapMs, sleep, maxDepth })
  const sends = () => log.filter((e) => e[0] === 'send').map((e) => e[1])
  async function until (n) {
    for (let i = 0; i < 10000 && sends().length < n; i++) {
      if (pending.length) pending.shift()()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  async function settle () {
    for (let i = 0; i < 200; i++) {
      if (pending.length) pending.shift()()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return { q, log, sends, until, settle }
}

test('enqueue returns the chunks queued and delivers them in order', async () => {
  const h = harness()
  assert.strictEqual(h.q.enqueue(['a', 'b']), 2)
  assert.strictEqual(h.q.enqueue(['c']), 1)
  await h.until(3)
  assert.deepStrictEqual(h.sends(), ['a', 'b', 'c'])
})

test('consecutive sends are separated by at least gapMs of sleep, across enqueues', async () => {
  const gapMs = 2500
  const h = harness({ gapMs })
  h.q.enqueue(['a', 'b'])
  h.q.enqueue(['c'])
  h.q.enqueue(['d'])
  await h.until(4)
  assert.deepStrictEqual(h.sends(), ['a', 'b', 'c', 'd'])
  let slept = null
  for (const [kind, v] of h.log) {
    if (kind === 'sleep' && slept !== null) slept += v
    if (kind === 'send') {
      // The queue subtracts the real time since the last send from gapMs.
      if (slept !== null) assert.ok(slept >= gapMs - 5, `only ${slept} ms between sends`)
      slept = 0
    }
  }
})

test('a full queue accepts up to maxDepth and refuses the overflowing request whole', async () => {
  const h = harness({ maxDepth: 3, hold: true })
  assert.strictEqual(h.q.enqueue(['a', 'b', 'c']), 3)
  assert.throws(() => h.q.enqueue(['d', 'e']),
    (e) => e instanceof Error && (e.name === 'QueueFull' || e.constructor.name === 'QueueFull'))
  await h.until(3)
  await h.settle()
  assert.deepStrictEqual(h.sends(), ['a', 'b', 'c'])
})

test('the queue accepts again once drained', async () => {
  const h = harness({ maxDepth: 2, hold: true })
  assert.strictEqual(h.q.enqueue(['a', 'b']), 2)
  assert.throws(() => h.q.enqueue(['x', 'y', 'z']))
  await h.until(2)
  await h.settle()
  assert.strictEqual(h.q.enqueue(['c']), 1)
  await h.until(3)
  assert.deepStrictEqual(h.sends(), ['a', 'b', 'c'])
})
