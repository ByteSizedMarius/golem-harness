'use strict'

// How far from a door's cell the body stands before it closes the door behind it.
const CLEAR = 1.6
// Past this the door is out of reach.
const REACH = 4
// A door the body opened but never went through gets closed after this long.
const UNUSED_MS = 4000

const isDoor = (name) => /(_door|_fence_gate)$/.test(name)

const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' }
const axisOf = (dir) => (dir === 'east' || dir === 'west' ? 'x' : 'z')

// Whether a door's panel or a closed gate's bar crosses a walk along axis, per DoorBlock.getShape on 1.21 and 1.7.10.
function panelAcross (name, { facing, hinge, open }, axis) {
  if (name.endsWith('_fence_gate')) return !open
  const turned = !open ? facing : hinge === 'right' ? CCW[facing] : CW[facing]
  return axisOf(turned) === axis
}

// The axis through the doorway, and the [dx, dz] offset from the door cell to the feet's side.
function doorCrossing ({ facing }, door, feet, walkable) {
  const along = axisOf(facing)
  const open = (axis, s) => (axis === 'x' ? walkable(s, 0) : walkable(0, s))
  const other = along === 'x' ? 'z' : 'x'
  // A door set sideways into a wall passes across its facing.
  const axis = !open(along, 1) && !open(along, -1) && open(other, 1) && open(other, -1) ? other : along
  const s = (axis === 'x' ? feet.x - door.x : feet.z - door.z) > 0.5 ? 1 : -1
  return { axis, side: axis === 'x' ? [s, 0] : [0, s] }
}

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

module.exports = { isDoor, doorStep, panelAcross, doorCrossing }
