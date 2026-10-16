'use strict'

// The most time between a death and the server's death line about it.
const LINE_MS = 5000

// since(mark) is the last death's server line within LINE_MS, else its died text, or null with no death after mark().
function deathLedger (now = Date.now) {
  let count = 0
  let at = 0
  let text = null
  let line = null
  const ledger = {
    died (msg) { count++; at = now(); text = msg },
    heard (msg) { line = { msg, at: now() } },
    mark: () => count,
    since (mark) {
      if (count <= mark) return null
      return line && Math.abs(line.at - at) <= LINE_MS ? line.msg : text
    },
    // The JSON reply of res leads with died when the body dies before it is sent.
    watch (res) {
      const mark = count
      const json = res.json.bind(res)
      res.json = (body) => {
        const died = ledger.since(mark)
        return json(died ? { died, ...body } : body)
      }
    }
  }
  return ledger
}

module.exports = { deathLedger }
