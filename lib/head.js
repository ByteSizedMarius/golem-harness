'use strict'

// The pathfinder turns the head toward its next node every tick, and the yaw it sets is the walking direction.
function headFree (bot) {
  return !bot.pathfinder.isMoving()
}

// A player's fast deliberate turn.
const TURN_DEG_S = 300
const FIGHT_TURN_DEG_S = 900
const TICK_MS = 50

// physicsTick stops while the bot is dead, mounted or in an unloaded chunk.
function nextTick (bot) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      bot.removeListener('physicsTick', done)
      resolve()
    }
    const timer = setTimeout(done, 2 * TICK_MS)
    bot.once('physicsTick', done)
  })
}

function shortestTurn (d) {
  return ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
}

// Sweeps forced looks only, since mineflayer already eases unforced ones.
// A sweep starts from the look other players see.
// onForced gets each forced look as { yaw, pitch, latest }, latest() true until the next look call.
function smoothLook (bot, look, fighting, onForced) {
  let latest = 0
  return async function (yaw, pitch, force) {
    const turn = ++latest
    if (!force) return look(yaw, pitch, force)
    onForced({ yaw, pitch, latest: () => turn === latest })
    const degS = fighting() ? FIGHT_TURN_DEG_S : TURN_DEG_S
    const maxStep = degS * TICK_MS / 1000 * Math.PI / 180
    const shown = bot.sentLook()
    const yaw0 = bot.entity.yaw + shortestTurn(shown.yaw - bot.entity.yaw)
    const pitch0 = shown.pitch
    const dYaw = shortestTurn(yaw - yaw0)
    const dPitch = pitch - pitch0
    const steps = Math.ceil(Math.hypot(dYaw, dPitch) / maxStep)
    for (let i = 1; i < steps; i++) {
      await look(yaw0 + dYaw * i / steps, pitch0 + dPitch * i / steps, true)
      await nextTick(bot)
      if (turn !== latest) return
    }
    return look(yaw0 + dYaw, pitch, force)
  }
}

module.exports = { headFree, smoothLook, shortestTurn, TURN_DEG_S, FIGHT_TURN_DEG_S }
