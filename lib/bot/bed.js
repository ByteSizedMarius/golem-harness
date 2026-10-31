'use strict'

const { LEGACY_1710 } = require('./config')
const { LEGACY_CLICK_REACH } = require('./legacy-1710')
const { TOOLS, LEAVE_BED_MS } = require('../../mcp/tools')

let bot, shared, emitEvent, err

// A sleep counts as the answer to the bot's bed click until this long after the next server time packet.
const BED_ANSWER_MS = 5000
// A sleeper's feet sit above the bed's top (0.94 over the bed cell on 1.7.10).
const BED_TOP = 0.5625
// The bot's last bed click, the end of its answer window, and the leave_bed in flight.
const BED_CLICK = { at: null, until: -Infinity, leave: null }

// shared.bed is set only by the server's answer to the bot's own bed click.
function wireBed () {
  bot.on('time', () => { if (BED_CLICK.until === Infinity) BED_CLICK.until = Date.now() + BED_ANSWER_MS })
  bot.on('sleep', () => { if (Date.now() <= BED_CLICK.until) bedTaken() })
  bot.on('wake', bedLeft)
  bot.on('death', forgetBed)
  bot.on('forcedMove', () => {
    if (!sleepingSpot(bot.entity.position)) {
      if (!bot.isSleeping) bedLeft()
    } else if (Date.now() <= BED_CLICK.until) bedTaken()
  })
  bot.once('spawn', () => {
    bot.activateBlock = outOfBedFirst(notingBedClicks(bot.activateBlock.bind(bot)))
    bot.openBlock = outOfBedFirst(inClickReach(bot.openBlock.bind(bot)))
    bot.craft = outOfBedFirst(bot.craft.bind(bot))
    bot._genericPlace = outOfBedFirst(bot._genericPlace)
    bot.useOn = outOfBedFirst(bot.useOn)
    bot.pathfinder.setGoal = outOfBedOnGoal(bot.pathfinder.setGoal)
  })
}
function sleepingSpot (p) {
  const b = bot.blockAt(p.floored())
  return !!b && bot.isABed(b) && p.y - b.position.y > BED_TOP
}
function bedTaken () {
  if (shared.bed) return
  const { x, y, z } = BED_CLICK.at
  shared.bed = { x, y, z }
  emitEvent('sleep', `in bed at ${x},${y},${z}`, { at: { x, y, z } }, { quiet: true })
}
function bedLeft () {
  if (!shared.bed) return
  const { x, y, z } = shared.bed
  shared.bed = null
  emitEvent('wake', `out of the bed at ${x},${y},${z}`, { at: { x, y, z } }, { quiet: !!BED_CLICK.leave })
}
function forgetBed () {
  shared.bed = null
}
function notingBedClicks (activate) {
  return async (block, ...a) => {
    const out = await activate(block, ...a)
    if (block && bot.isABed(block)) Object.assign(BED_CLICK, { at: block.position.floored(), until: Infinity })
    return out
  }
}
async function leaveBed () {
  if (!shared.bed) return
  BED_CLICK.leave ??= standUp().finally(() => { BED_CLICK.leave = null })
  await BED_CLICK.leave
  if (shared.bed) {
    const { x, y, z } = shared.bed
    throw new Error(`in bed at ${x},${y},${z}`)
  }
}
// The server answers leave_bed with a position packet, and not always with a wake.
function standUp () {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      bot.removeListener('forcedMove', answered)
      resolve()
    }
    const answered = () => {
      bedLeft()
      done()
    }
    const timer = setTimeout(done, LEAVE_BED_MS)
    bot.on('forcedMove', answered)
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: bot.registry.version['>=']('1.21.6') ? 'leave_bed' : 2, jumpBoost: 0 })
  })
}
function outOfBedFirst (act) {
  return async (...a) => {
    await leaveBed()
    return act(...a)
  }
}
function outOfBedOnGoal (setGoal) {
  return (goal, dynamic) => {
    if (goal && shared.bed) leaveBed().catch((e) => console.log(`[bed] ${e.message}`))
    return setGoal(goal, dynamic)
  }
}
function inClickReach (open) {
  return async (block, ...a) => {
    const d = bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5))
    if (LEGACY_1710 && d >= LEGACY_CLICK_REACH) {
      const { x, y, z } = block.position
      throw new Error(`the ${block.name} at ${x},${y},${z} is out of reach, ${d.toFixed(1)} blocks from your feet`)
    }
    return open(block, ...a)
  }
}
function installBedGate (app) {
  const gate = async (req, res, next) => {
    try {
      await leaveBed()
    } catch (e) {
      return err(res, e)
    }
    next()
  }
  for (const tool of TOOLS) if (tool.body) app.all(tool.route, gate)
  app.all('/stop', (req, res, next) => {
    forgetBed()
    next()
  })
}

function createBed (ctx) {
  Object.assign(ctx, { installBedGate })
}

function bindBed (ctx) {
  ({ bot, shared, emitEvent, err } = ctx)
}

module.exports = { createBed, bindBed, wireBed }
