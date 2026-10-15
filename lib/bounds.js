'use strict'

const { BadParam, checkInt } = require('./validate')

const SIZE = [1, 64]
const RADIUS = [1, 64]
const COUNT = [1, 576]
const RANGE = [1, 32]
const GOTO_RANGE = [0, 32]
const BUNKER_HEIGHT = [2, 6]

const ROUTE_BOUNDS = {
  '/outline': { w: SIZE, d: SIZE },
  '/roof': { w: SIZE, d: SIZE },
  '/walls': { w: SIZE, d: SIZE, h: SIZE },
  '/build': { w: SIZE, d: SIZE, h: SIZE },
  '/find': { radius: RADIUS },
  '/collect': { radius: RADIUS },
  '/mine': { radius: RADIUS, count: COUNT },
  '/craft': { count: COUNT },
  '/smelt': { count: COUNT },
  '/furnace': { count: COUNT },
  '/withdraw': { count: COUNT },
  '/deposit': { count: COUNT },
  '/toss': { count: COUNT },
  '/gather': { amount: COUNT },
  '/goto': { range: GOTO_RANGE },
  '/follow': { range: RANGE },
  '/bunker': { height: BUNKER_HEIGHT }
}

// The world border and the 1.21 build height, each max exclusive.
const COORD_BOUNDS = { x: [-30000000, 30000000], y: [-64, 320], z: [-30000000, 30000000] }
const NUMBER = /^-?(?:[0-9]{1,15}(?:\.[0-9]{1,25})?|\.[0-9]{1,25})(?:e[+-]?[0-9]{1,3})?$/i

function checkCoord (v, min, max) {
  if (typeof v !== 'string' || !NUMBER.test(v)) throw new BadParam('expected a single number')
  const n = Number(v)
  if (!(n >= min && n < max)) throw new BadParam(`must be at least ${min} and below ${max}`)
  return n
}

// req.route.path is the ROUTE_BOUNDS key Express matched, also for /WALLS or /walls/.
function boundsGuard (req, res, next) {
  for (const [param, [min, max]] of Object.entries(ROUTE_BOUNDS[req.route.path])) {
    const v = req.query[param]
    if (v === undefined) continue
    try {
      checkInt(v, min, max)
    } catch (e) {
      if (!(e instanceof BadParam)) throw e
      return res.status(400).json({ ok: false, error: `${param}: ${e.message}` })
    }
  }
  next()
}

function coordGuard (req, res, next) {
  for (const [param, [min, max]] of Object.entries(COORD_BOUNDS)) {
    const v = req.query[param]
    if (v === undefined) continue
    try {
      checkCoord(v, min, max)
    } catch (e) {
      if (!(e instanceof BadParam)) throw e
      return res.status(400).json({ ok: false, error: `${param}: ${e.message}` })
    }
  }
  next()
}

module.exports = { ROUTE_BOUNDS, COORD_BOUNDS, boundsGuard, coordGuard }
