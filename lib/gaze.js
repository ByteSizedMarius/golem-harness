'use strict'
const { shortestTurn } = require('./head')

const deg = (d) => d * Math.PI / 180
// Blocks along the remaining path to the point the gaze rests on.
const AHEAD = 4
const DEADBAND = deg(12)
const MAX_OFF_WALK = deg(45)
// How long a forced look or an item use holds off the walking gaze.
const HOLD_MS = 1500
// A step shorter than this horizontally has no heading.
const MIN_FLAT_STEP = 0.1

// The horizontal unit vector from a toward b, null when b lies almost straight above or below a.
function flatStep (a, b) {
  const v = b.minus(a)
  v.y = 0
  const len = v.norm()
  return len > MIN_FLAT_STEP ? v.scaled(1 / len) : null
}

// The heading of the path's last step that moves horizontally, null when none does.
function pathHeading (body, path) {
  for (let i = path.length - 1; i >= 0; i--) {
    const heading = flatStep(i === 0 ? body : path[i - 1], path[i])
    if (heading) return heading
  }
  return null
}

// The look at the point AHEAD blocks along the path (run on along heading when shorter), one block above its floor.
function aheadLook (bot, path, heading) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
  const lookAt = (floor) => {
    const delta = floor.offset(0, 1, 0).minus(eye)
    return { yaw: Math.atan2(-delta.x, -delta.z), pitch: Math.atan2(delta.y, Math.hypot(delta.x, delta.z)) }
  }
  let from = bot.entity.position
  let left = AHEAD
  for (const node of path) {
    const d = from.distanceTo(node)
    if (d >= left) return lookAt(from.plus(node.minus(from).scaled(left / d)))
    left -= d
    from = node
  }
  return path.length > 0 && heading ? lookAt(from.plus(heading.scaled(left))) : null
}

// Installs bot.presentedLook, the look mineflayer eases the move packets toward, a steady gaze while the pathfinder walks.
function installGaze (bot) {
  let path = []
  let heading = null
  let gaze = null
  let heldUntil = 0
  // The latest forced look, { yaw, pitch, latest } with latest() true until another look call.
  let forced = null
  let eating = 0
  bot.on('path_update', (r) => {
    path = r.path
    heading = pathHeading(bot.entity.position, path)
  })
  const hold = (look = null) => {
    heldUntil = Date.now() + HOLD_MS
    forced = look
  }
  const held = () => Date.now() < heldUntil
  const onPath = () => bot.pathfinder.isMoving() && !held() && !eating && !bot.targetDigBlock &&
    !bot.pathfinder.isMining() && !bot.pathfinder.isBuilding() && !bot.usingHeldItem

  bot.presentedLook = () => {
    // The pathfinder's per-tick look cuts a forced sweep short and turns the real look back to the walking yaw.
    if (forced && held() && !eating && bot.pathfinder.isMoving() && !forced.latest()) {
      gaze = null
      return { yaw: forced.yaw, pitch: forced.pitch }
    }
    if (!onPath()) {
      gaze = null
      return { yaw: bot.entity.yaw, pitch: bot.entity.pitch }
    }
    gaze = gaze || bot.sentLook()
    const ahead = aheadLook(bot, path, heading)
    if (ahead && Math.hypot(shortestTurn(ahead.yaw - gaze.yaw), ahead.pitch - gaze.pitch) > DEADBAND) gaze = ahead
    const off = Math.max(-MAX_OFF_WALK, Math.min(MAX_OFF_WALK, shortestTurn(gaze.yaw - bot.entity.yaw)))
    gaze = { yaw: bot.entity.yaw + off, pitch: gaze.pitch }
    return gaze
  }

  const holdForUse = () => {
    const pending = held() ? forced : null
    hold(pending)
    if (!pending) bot.showRealLook()
  }
  const activateItem = bot.activateItem
  bot.activateItem = (...args) => {
    holdForUse()
    return activateItem(...args)
  }
  // consume() activates the item without bot.activateItem.
  const consume = bot.consume
  bot.consume = async (...args) => {
    holdForUse()
    // Any entity status clears usingHeldItem mid-bite.
    eating++
    try {
      return await consume(...args)
    } finally {
      eating--
    }
  }
  return { hold }
}

module.exports = { installGaze, HOLD_MS }
