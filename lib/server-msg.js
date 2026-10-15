'use strict'

// The kinds of server lines that wake the pilot, by the prefix of their translate key.
const KINDS = [
  [/^death\./, 'death'],
  [/^multiplayer\.player\.joined/, 'joined'],
  [/^multiplayer\.player\.left$/, 'left'],
  [/^chat\.type\.(advancement\.|achievement$)/, 'achievement']
]
const WAKE_KINDS = KINDS.map(([, kind]) => kind)
// Lines a player wrote: chat, emotes, /say, team chat and whispers.
const TALK_KEYS = /^(chat\.type\.(text|emote|announcement|team\.)|commands\.message\.display\.)/
// mineflayer's default chat and whisper patterns, by which it hears a plain line as a player's, and the emote.
const SPEAKER = '(?:\\(.{1,15}\\)|\\[.{1,15}\\]|.){0,5}?(\\w+)'
const PLAIN_TALK = [
  new RegExp(`^${SPEAKER}\\s?[>:\\-»\\]\\)~]+\\s(.*)$`),
  new RegExp(`^${SPEAKER} whispers(?: to you)?:? (.*)$`),
  new RegExp(`^\\[${SPEAKER} -> \\w+\\s?\\] (.*)$`),
  /^\* [A-Za-z0-9_]{1,16} /
]
// 1.7.10 formats the 1.21 language lacks.
const LEGACY_FORMATS = { 'chat.type.achievement': '%s has just earned the achievement %s' }
// The first name in a plain server line is a player name.
const PLAYER_NAME = '[A-Za-z0-9_]{1,16}'
// The most quiet server events waiting to be sent. Past it a new line merges into the newest.
const QUIET_MAX = 20

const kindOf = (key) => (KINDS.find(([re]) => re.test(key)) || [])[1] || null
const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined)

function fill (format, args) {
  let next = 0
  return format.replace(/%(?:(\d+)\$)?s/g, (_, n) => args[n ? n - 1 : next++] ?? '')
}

// A component that only wraps one other, as converted chat often arrives.
const unwrap = (m) => (m.translate === undefined && !m.text && Array.isArray(m.extra) && m.extra.length === 1 ? unwrap(m.extra[0]) : m)

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The plain-text form of each waking kind, built from the language's formats: a whole line that starts with a
// player name.
function plainForms (language) {
  const forms = []
  for (const [key, format] of Object.entries({ ...LEGACY_FORMATS, ...language })) {
    const kind = kindOf(key)
    if (!kind || !/^%(1\$)?s /.test(format)) continue
    const parts = format.split(/%(?:\d+\$)?s/)
    const body = parts.map(escape).reduce((re, part, i) => re + (i === 1 ? `${PLAYER_NAME}` : '(?:.+?)') + part)
    forms.push([new RegExp(`^${body}$`), kind])
  }
  return forms
}

// Reads server lines from system chat components in one language.
function serverLines (language) {
  const forms = plainForms(language)
  // { kind, text } for a line no player wrote, kind 'other' when it is no death, join, leave or achievement.
  // Null for player talk and blank lines. msg is a prismarine-chat ChatMessage.
  return function serverLine (msg) {
    const core = unwrap(msg)
    if (typeof core.translate === 'string') {
      const key = core.translate
      if (TALK_KEYS.test(key)) return null
      const args = (core.with || []).map((a) => a.toString())
      const format = own(language, key) ?? own(LEGACY_FORMATS, key)
      const text = typeof format === 'string' ? fill(format, args) : `${key}: ${args.join(', ')}`
      return { kind: kindOf(key) || 'other', text }
    }
    const text = msg.toString()
    if (!text.trim() || PLAIN_TALK.some((re) => re.test(text))) return null
    const form = forms.find(([re]) => re.test(text))
    return { kind: form ? form[1] : 'other', text }
  }
}

// At most max takes per windowMs. take(now) is false when the window is full.
function rateLimit ({ max, windowMs }) {
  const taken = []
  return {
    take (now) {
      while (taken.length && now - taken[0] >= windowMs) taken.shift()
      if (taken.length >= max) return false
      taken.push(now)
      return true
    }
  }
}

// Counts a quiet line on the newest of pending, the quiet server events not sent yet, oldest first, each
// { text, repeats, merged }: as a repeat when it says the same, as merged once pending holds QUIET_MAX.
// Returns that newest one, or null when the line needs an event of its own.
function foldQuiet (pending, text) {
  const last = pending[pending.length - 1]
  if (last && last.text === text) last.repeats++
  else if (pending.length >= QUIET_MAX) last.merged++
  else return null
  return last
}

function quietText ({ text, repeats, merged }) {
  const notes = []
  if (repeats) notes.push(`seen ${repeats + 1} times`)
  if (merged) notes.push(`${merged} later server lines merged into this one`)
  return notes.length ? `${text} (${notes.join(', and ')})` : text
}

module.exports = { WAKE_KINDS, QUIET_MAX, serverLines, rateLimit, foldQuiet, quietText }
