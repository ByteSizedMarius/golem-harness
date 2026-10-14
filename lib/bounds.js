'use strict'

const { BadParam, checkInt } = require('./validate')

const SIZE = [1, 64]
const RADIUS = [1, 64]
const COUNT = [1, 576]
const RANGE = [1, 32]
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
  '/withdraw': { count: COUNT },
  '/deposit': { count: COUNT },
  '/toss': { count: COUNT },
  '/gather': { amount: COUNT },
  '/goto': { range: RANGE },
  '/come': { range: RANGE },
  '/follow': { range: RANGE },
  '/goto_wp': { range: RANGE },
  '/safe_goto': { range: RANGE },
  '/bunker': { height: BUNKER_HEIGHT }
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

module.exports = { ROUTE_BOUNDS, boundsGuard }
