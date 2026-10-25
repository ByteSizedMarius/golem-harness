'use strict'

const { createChatLog } = require('../chat-log')
const { WAKE_KINDS, serverLines, rateLimit, foldQuiet, quietText } = require('../server-msg')

let bot, chatPointer, deaths, whereIs, shared

// ---- chat capture (so the driver can hear the world, not just speak to it) ----
const chatLog = createChatLog({ self: () => bot && bot.username })
// After spawn a line carries where its speaker is and where the bot stands. A lookup error leaves both out.
function pushChat(from, message, kind) {
  const line = chatLog.push(from, message, kind)
  if (!line) return
  const pointsAt = pointerOf(from, message)
  if (pointsAt) line.pointsAt = pointsAt
  if (shared.ready) {
    try {
      const { name, note, ...where } = whereIs(from)
      const p = bot.entity.position
      Object.assign(line, { where: note === undefined ? where : { live: false, unseen: true }, me: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } })
    } catch (e) {}
  }
  console.log(`[chat] <${from}> ${message}`)
}
// A pointer error leaves the line without one.
const pointerOf = (from, message) => { try { return chatPointer(from, message) } catch (e) { return null } }
function wireChatCapture () {
  bot.on('chat', (username, message) => pushChat(username, message, 'chat'))
  bot.on('whisper', (username, message) => pushChat(username, message, 'whisper'))
}

// Every system line no player wrote, as a server event. Deaths, joins, leaves and achievements wake the pilot,
// at most 6 a minute, and every other line arrives quiet. A name in them is player-chosen text.
const serverWakes = rateLimit({ max: 6, windowMs: 60000 })
// The quiet server events no reply carried yet, oldest first, as foldQuiet counts them, each with its event ev.
const quietServer = []
let serverLine = null
function serverMessage (msg, position) {
  try {
    if (position !== 'system') return
    serverLine ??= serverLines(bot.registry.language || {})
    const line = serverLine(msg)
    if (!line) return
    if (line.kind === 'death' && line.text.startsWith(bot.username + ' ')) deaths.heard(line.text)
    if (WAKE_KINDS.includes(line.kind) && serverWakes.take(Date.now())) return emitEvent('server', line.text, { kind: line.kind })
    while (quietServer.length && quietServer[0].ev.id <= streams.eventsServed) quietServer.shift()
    const folded = foldQuiet(quietServer, line.text)
    if (folded) Object.assign(folded.ev, { msg: quietText(folded), data: { ...folded.ev.data, repeats: folded.repeats, merged: folded.merged } })
    else {
      // The MCP server merges the counts of the events that carry the same text.
      const ev = emitEvent('server', line.text, { kind: line.kind, text: line.text, repeats: 0, merged: 0 }, { quiet: true })
      if (ev) quietServer.push({ text: line.text, repeats: 0, merged: 0, ev })
    }
  } catch (e) {}
}
function wireServerMessages () {
  bot.on('message', serverMessage)
}

// ---- event stream (interrupts for the driver: damage, death, threats, night, hunger) ----
const streams = {}
streams.eventSeq = 0
const eventLog = []
// The newest event id a /tick or /events reply carried.
streams.eventsServed = 0
// The id of the newest event that is not quiet.
streams.wakeEv = 0
// A quiet event rides along with the next wake of wait_events and wakes nothing itself. Returns the event, null
// when it could not be logged.
function emitEvent(kind, msg, data, { quiet = false } = {}) {
  try {
    console.log('[event] ' + kind + ' ' + msg)   // stdout line so the log-tailing Monitor wakes the driver
    const ev = { id: ++streams.eventSeq, t: Date.now(), kind, msg, data: data || null, ...(quiet && { quiet }) }
    eventLog.push(ev)
    if (eventLog.length > 400) eventLog.splice(0, eventLog.length - 400)
    if (!quiet) streams.wakeEv = ev.id
    return ev
  } catch (e) { return null }
}

// ---- AMBIENT PULSE (the change-gated awareness stream): a lean [pulse] log the driver reads AT ITS
// OWN PACE via /pulse — deliberately NOT tailed by the Monitor, so it never interrupts. The narrator
// reflex writes a line only when something salient CHANGES (day-phase, HP/food, a new hostile, a big
// move), turning my strobe of glances into a slow film I can catch up on whenever I next look. ----
streams.pulseSeq = 0
const pulseLog = []
function logPulse (msg) {
  try {
    console.log('[pulse] ' + msg)            // distinct prefix; the Monitor does NOT grep [pulse]
    pulseLog.push({ id: ++streams.pulseSeq, t: Date.now(), msg })
    if (pulseLog.length > 200) pulseLog.splice(0, pulseLog.length - 200)
  } catch (e) {}
}

function createStreams (ctx) {
  Object.assign(ctx, { chatLog, streams, eventLog, emitEvent, pulseLog, logPulse })
}

function bindStreams (ctx) {
  ({ bot, chatPointer, deaths, whereIs, shared } = ctx)
}

module.exports = { createStreams, bindStreams, wireChatCapture, wireServerMessages }
