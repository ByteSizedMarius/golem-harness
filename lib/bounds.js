'use strict'

const { BadParam, checkInt } = require('./validate')
const { TOOLS } = require('../mcp/tools')

function toolRanges (type, range) {
  const out = {}
  for (const { route, params } of TOOLS) {
    for (const [param, spec] of Object.entries(params)) if (spec.type === type) (out[route] ??= {})[param] = range(spec)
  }
  return out
}

// Inclusive ranges.
const ROUTE_BOUNDS = toolRanges('int', ({ min, max }) => [min, max])
// Integer params no tool sends.
const HTTP_BOUNDS = { '/pathdebug': { secs: [1, 120] }, '/threatdebug': { secs: [1, 300] }, '/dig_stair': { steps: [1, 96] } }
for (const [route, params] of Object.entries(HTTP_BOUNDS)) Object.assign(ROUTE_BOUNDS[route] ??= {}, params)

// Max exclusive, at the far edge of the schema's last whole block.
const ROUTE_COORDS = toolRanges('num', ({ min, max }) => [min, max + 1])
const NUMBER = /^-?(?:[0-9]{1,15}(?:\.[0-9]{1,25})?|\.[0-9]{1,25})(?:e[+-]?[0-9]{1,3})?$/i

function checkCoord (v, min, max) {
  if (typeof v !== 'string' || !NUMBER.test(v)) throw new BadParam('expected a single number')
  const n = Number(v)
  if (!(n >= min && n < max)) throw new BadParam(`must be at least ${min} and below ${max}`)
  return n
}

// req.route.path is the table key Express matched, also for /WALLS or /walls/.
function rangeGuard (table, check) {
  return (req, res, next) => {
    for (const [param, [min, max]] of Object.entries(table[req.route.path])) {
      const v = req.query[param]
      if (v === undefined) continue
      try {
        check(v, min, max)
      } catch (e) {
        if (!(e instanceof BadParam)) throw e
        return res.status(400).json({ ok: false, error: `${param}: ${e.message}` })
      }
    }
    next()
  }
}

const boundsGuard = rangeGuard(ROUTE_BOUNDS, checkInt)
const coordGuard = rangeGuard(ROUTE_COORDS, checkCoord)

function requireCoords (names) {
  return (req, res, next) => {
    const gone = names.find((n) => req.query[n] === undefined)
    if (gone !== undefined) return res.status(400).json({ ok: false, error: `${gone}: required` })
    next()
  }
}

module.exports = { ROUTE_BOUNDS, ROUTE_COORDS, boundsGuard, coordGuard, requireCoords }
