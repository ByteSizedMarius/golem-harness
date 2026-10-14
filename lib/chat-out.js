'use strict'

const { performance } = require('node:perf_hooks')

// Control characters, and § which starts a formatting code.
const ILLEGAL = /[\x00-\x1f\x7f\xa7]/g
// Leading characters that can hide a command slash: everything up to 0x20, Unicode spaces and
// invisible format characters.
const GAP = /[\x00-\x20\s\p{Cf}]*/uy
const LEAD = /^[\x00-\x20\s\p{Cf}]+/u
const TRAIL = /[\x00-\x20\s\p{Cf}]+$/u
// Commands whose first argument is the receiving player.
const TARGETED = new Set(['tell', 'msg', 'w'])
const MIN_LEN = 8

class QueueFull extends Error {
  constructor () {
    super('chat queue is full')
    this.name = 'QueueFull'
  }
}

function skipGap (text, p) {
  GAP.lastIndex = p
  GAP.exec(text)
  return GAP.lastIndex
}

// End of the chunk from p: the last space within budget, else a hard cut outside a surrogate pair.
// Advances past p for any budget of at least 2.
function cut (text, p, budget) {
  const end = p + budget
  if (end >= text.length) return text.length
  const space = text.lastIndexOf(' ', end)
  if (space > p) return space
  const high = text.charCodeAt(end - 1)
  return high >= 0xd800 && high <= 0xdbff ? end - 1 : end
}

// guardSlash: a chunk after the first that would open with a slash gets a '.' in front.
function chunks (text, budget, guardSlash) {
  const out = []
  let p = 0
  while ((p = skipGap(text, p)) < text.length) {
    const prefix = guardSlash && out.length > 0 && text[p] === '/' ? '.' : ''
    const end = cut(text, p, budget - prefix.length)
    out.push(prefix + text.slice(p, end).replace(TRAIL, ''))
    p = end
  }
  return out
}

// Every chunk of a long command repeats the command and its target player.
function planCommand (line, maxLen, allow) {
  const word = line.slice(1).split(' ', 1)[0]
  const command = word.toLowerCase()
  if (!allow.includes(command)) return { error: `command not allowed: /${word.slice(0, 32)}`, status: 403 }
  let head = '/' + command
  let rest = line.slice(1 + word.length).trimStart()
  if (TARGETED.has(command) && rest) {
    const target = rest.split(' ', 1)[0]
    head += ' ' + target
    rest = rest.slice(target.length).trimStart()
  }
  if (!rest) return head.length <= maxLen ? { lines: [head] } : { error: 'command too long', status: 400 }
  head += ' '
  if (head.length + rest.length <= maxLen) return { lines: [head + rest] }
  if (maxLen - head.length < 2) return { error: 'command head too long to split the message', status: 400 }
  return { lines: chunks(rest, maxLen - head.length, false).map((piece) => head + piece) }
}

function planChat (text, { maxLen, allow }) {
  if (!Number.isInteger(maxLen) || maxLen < MIN_LEN) throw new TypeError(`maxLen must be an integer of at least ${MIN_LEN}`)
  if (!Array.isArray(allow)) throw new TypeError('allow must be an array of command words')
  if (typeof text !== 'string') return { error: 'expected text', status: 400 }
  const line = text.replace(ILLEGAL, '').replace(LEAD, '').replace(TRAIL, '')
  if (!line) return { error: 'nothing to say', status: 400 }
  if (line.startsWith('/')) return planCommand(line, maxLen, allow)
  return { lines: chunks(line, maxLen, true) }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createChatQueue ({ send, gapMs, sleep = realSleep, maxDepth }) {
  if (typeof send !== 'function') throw new TypeError('send must be a function')
  if (!Number.isFinite(gapMs) || gapMs < 0) throw new TypeError('gapMs must be a non-negative number')
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function')
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new TypeError('maxDepth must be a positive integer')
  const queue = []
  let lastSent = null
  let pumping = false

  async function pump () {
    pumping = true
    try {
      while (queue.length) {
        if (lastSent !== null) {
          const wait = Math.ceil(gapMs - (performance.now() - lastSent))
          if (wait > 0) await sleep(wait)
        }
        const text = queue.shift()
        lastSent = performance.now()
        try {
          send(text)
        } catch (e) {
          console.log('[chat] send failed: ' + e.message)
        }
      }
    } finally {
      pumping = false
    }
  }

  return {
    // Throws QueueFull, and queues nothing, when the lines do not all fit.
    enqueue (lines) {
      if (queue.length + lines.length > maxDepth) throw new QueueFull()
      queue.push(...lines)
      if (!pumping) pump().catch((e) => console.log('[chat] queue stopped: ' + e.message))
      return lines.length
    }
  }
}

module.exports = { planChat, createChatQueue, QueueFull }
