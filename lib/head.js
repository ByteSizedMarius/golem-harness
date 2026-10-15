'use strict'

// The pathfinder turns the head toward its next node every tick, and the yaw it sets is the walking direction.
function headFree (bot) {
  return !bot.pathfinder.isMoving()
}

module.exports = { headFree }
