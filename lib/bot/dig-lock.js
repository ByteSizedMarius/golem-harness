'use strict'

let bot

// The claim of the running dig, null when none runs. rawDig and rawStop are bot.dig and bot.stopDigging behind the guard.
const digLock = { holder: null, rawDig: null, rawStop: null }

function busyError (held) {
  return Object.assign(new Error(`busy: ${held.what} is running, nothing dug`), { reason: 'busy' })
}

function claimDig (what, take = false) {
  const held = digLock.holder
  if (held && !take) throw busyError(held)
  if (held) {
    held.takenBy = what
    if (held.stop) held.stop()
  }
  digLock.holder = { what, takenBy: null, stop: null }
  return digLock.holder
}

function releaseDig (claim) {
  if (claim && digLock.holder === claim) digLock.holder = null
}

function soleClaim () {
  const held = digLock.holder
  return held && held.sole ? held : null
}

function digBusy () {
  const sole = soleClaim()
  if (sole) throw busyError(sole)
}

// mineflayer's dig reads bot.lookAt before its first await.
function afterLook (atLook, dig, args) {
  const look = bot.lookAt
  bot.lookAt = (...l) => look(...l).then((r) => { atLook(); return r })
  try {
    return dig(...args)
  } finally {
    bot.lookAt = look
  }
}

// Digs block for the sole claim, past the guard.
function soleDig (claim, block) {
  claim.block = block
  return afterLook(() => { if (digLock.holder !== claim) throw new Error(`${claim.what} ended, nothing dug`) }, digLock.rawDig, [block])
}

// While a sole claim is held, bot.dig refuses busy, also a dig begun earlier whose look ends after the claim.
// mineflayer assigns bot.stopDigging on every dig, and the setter stores it in rawStop.
function wireDigGuard () {
  bot.once('spawn', () => {
    const dig = bot.dig
    digLock.rawDig = dig
    digLock.rawStop = bot.stopDigging
    bot.dig = async (...a) => {
      digBusy()
      return afterLook(digBusy, dig, a)
    }
    const stop = (...a) => {
      const sole = soleClaim()
      if (sole && bot.targetDigBlock && bot.targetDigBlock === sole.block) return
      return digLock.rawStop(...a)
    }
    Object.defineProperty(bot, 'stopDigging', { configurable: true, enumerable: true, get: () => stop, set: (f) => { digLock.rawStop = f } })
  })
}

function bindDigLock (ctx) {
  ({ bot } = ctx)
}

module.exports = { digLock, claimDig, releaseDig, soleClaim, digBusy, afterLook, soleDig, bindDigLock, wireDigGuard }
