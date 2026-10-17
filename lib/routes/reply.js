'use strict'

let chatLog

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
// Adds the unread chat count and senders to each JSON reply.
const send = (res, body) => res.json(chatLog.withUnread(body))
const ok = (res, data) => {
  const body = { ok: true, ...data }
  send(res, res.req && res.req.query && res.req.query.brief === '1' ? debrief(body) : body)
}
const err = (res, e) => send(res, { ok: false, error: e.message || String(e), ...(e.reason && { reason: e.reason }) })

function createReply (ctx) {
  Object.assign(ctx, { debrief, send, ok, err })
}

function bindReply (ctx) {
  ({ chatLog } = ctx)
}

module.exports = { createReply, bindReply }
