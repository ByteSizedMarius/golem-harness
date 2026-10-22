'use strict'

let chatLog, eventLog, streams, BOOT_ID

// The newest non-quiet events each reply names.
const WAKE_RECENT = 20
// [id, kind, t] of the newest WAKE_RECENT non-quiet events, oldest first, and the wakeEv it was read at.
let recent = null

// ?brief=1 on ANY endpoint strips null/undefined fields from the reply — LLM pilots pay
// by the token and "reason":null earns nothing. Empty ARRAYS survive on purpose: law 2
// makes [] a statement ("looked, found none") and silence a different one ("didn't look").
// (Suggested by bones_ham — the harness's first outside pilot — 07-21. Fairness untouched.)
const debrief = (v) => {
  if (Array.isArray(v)) return v.map(debrief)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === undefined) continue
      out[k] = debrief(val)
    }
    return out
  }
  return v
}
// The boot id and the newest non-quiet events, for the MCP server's waiting events line.
function wakeEvents () {
  if (!recent || recent.ev !== streams.wakeEv) {
    const list = []
    for (let i = eventLog.length - 1; i >= 0 && list.length < WAKE_RECENT; i--) {
      if (!eventLog[i].quiet) list.push([eventLog[i].id, eventLog[i].kind, eventLog[i].t])
    }
    recent = { ev: streams.wakeEv, list: list.reverse() }
  }
  return { boot: BOOT_ID, recent: recent.list }
}
// Adds the unread chat count and senders and the wake events to each JSON reply.
const send = (res, body) => {
  const out = chatLog.withUnread(body)
  res.json(out !== null && typeof out === 'object' && !Array.isArray(out) ? { ...out, wakeEvents: wakeEvents() } : out)
}
const ok = (res, data) => {
  const body = { ok: true, ...data }
  send(res, res.req && res.req.query && res.req.query.brief === '1' ? debrief(body) : body)
}
const err = (res, e) => send(res, { ok: false, error: e.message || String(e), ...(e.reason && { reason: e.reason }) })

function createReply (ctx) {
  Object.assign(ctx, { debrief, send, ok, err })
}

function bindReply (ctx) {
  ({ chatLog, eventLog, streams, BOOT_ID } = ctx)
  recent = null
}

module.exports = { createReply, bindReply }
