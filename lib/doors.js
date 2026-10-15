'use strict'

// How far from a door's cell the body stands before it closes the door behind it.
const CLEAR = 1.6
// Past this the door is out of reach.
const REACH = 4
// A door the body opened but never went through gets closed after this long.
const UNUSED_MS = 4000

const isDoor = (name) => /(_door|_fence_gate)$/.test(name)

// What to do now with a door the body opened at door.t: 'close', 'wait', or 'far' once out of reach.
// It marks door.through once the feet stood in its cell and keeps door.dist, the distance it last saw.
function doorStep (door, feet, now) {
  const { x, y, z } = door.pos
  if (Math.floor(feet.x) === x && Math.floor(feet.z) === z && Math.abs(Math.floor(feet.y) - y) <= 1) door.through = true
  const d = Math.hypot(x + 0.5 - feet.x, z + 0.5 - feet.z)
  const approaching = door.dist !== undefined && d < door.dist - 0.05
  door.dist = d
  if (d > REACH) return 'far'
  if (d >= CLEAR && !approaching && (door.through || now - door.t >= UNUSED_MS)) return 'close'
  return 'wait'
}

module.exports = { isDoor, doorStep }
