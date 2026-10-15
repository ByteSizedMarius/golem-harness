'use strict'

// The chat lines and whispers players sent the bot, numbered from 1, the newest max of them kept.
function createChatLog ({ self, max = 300 }) {
  const lines = []
  let cursor = 0
  let readTo = 0
  // The count and senders of the lines logged since the last read, null when there are none.
  function unread () {
    const fresh = lines.filter((m) => m.id > readTo)
    return fresh.length ? { lines: fresh.length, from: [...new Set(fresh.map((m) => m.from))] } : null
  }
  return {
    get cursor () { return cursor },
    // The logged line, or null for the bot's own chat line.
    push (from, msg, kind) {
      if (kind === 'chat' && from === self) return null
      const line = { id: ++cursor, t: Date.now(), from, msg, kind }
      lines.push(line)
      if (lines.length > max) lines.splice(0, lines.length - max)
      return line
    },
    // Marks every line logged so far as read.
    read (since) {
      readTo = cursor
      return lines.filter((m) => m.id > since)
    },
    unread,
    withUnread (body) {
      const u = unread()
      return u && body !== null && typeof body === 'object' && !Array.isArray(body) ? { ...body, unreadChat: u } : body
    }
  }
}

module.exports = { createChatLog }
