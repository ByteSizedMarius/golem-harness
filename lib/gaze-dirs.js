'use strict'

// The point each /gaze dir looks at, as an offset from the feet.
const GAZE_DIRS = {
  n: [0, 1.62, -10], ne: [10, 1.62, -10], e: [10, 1.62, 0], se: [10, 1.62, 10],
  s: [0, 1.62, 10], sw: [-10, 1.62, 10], w: [-10, 1.62, 0], nw: [-10, 1.62, -10],
  up: [0.01, 13, 0.01], down: [0.01, -9, 0.01]
}

module.exports = { GAZE_DIRS }
