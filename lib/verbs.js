'use strict'

// How long a route counts as running after its handler began, the length of the pilot lane a walk claims.
const VERB_BUDGET_MS = 300000

// Wraps the handler of every route app.get registers from here on. running(now) is how many of them have not
// settled and began less than VERB_BUDGET_MS before now.
function countVerbs (app) {
  const started = new Set()
  const get = app.get.bind(app)
  app.get = (path, ...handlers) => {
    if (!handlers.length) return get(path)
    const handler = handlers.pop()
    return get(path, ...handlers, async (req, res, next) => {
      const run = { at: Date.now() }
      started.add(run)
      try {
        return await handler(req, res, next)
      } finally {
        started.delete(run)
      }
    })
  }
  return {
    running (now = Date.now()) {
      let n = 0
      for (const run of started) if (now - run.at < VERB_BUDGET_MS) n++
      return n
    }
  }
}

module.exports = { VERB_BUDGET_MS, countVerbs }
