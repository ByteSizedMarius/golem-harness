'use strict'

const { SHELTER } = require('../shelter')
const { soleDig } = require('./dig-lock')

let bot, bunker, solidAt, BUNKER_GROUND, digMs, BUNKER_DIG_MS, equipPickFor, SIDES, placeFiller, fillers, jumpPlace, centerOnCell, mobClass

// True once the body has risen or sunk out of a mob's reach.
function outOfReach () {
  return bunker.reached >= (bunker.mode === 'up' ? SHELTER.SAFE_HEIGHT : SHELTER.SAFE_DEPTH)
}

// Why the build has to end now, or null. Out of reach, a hit no longer ends it.
function buildStop () {
  return bunker.stop === 'hit while building' && outOfReach() ? null : bunker.stop
}

// Digs up to three cells down, judging each one only once the body stands on it.
async function digIn (claim) {
  const o = bot.entity.position.floored()
  const ground = (b) => /water|lava/.test(b.name) ? `${b.name} under the feet`
    : !solidAt(b.position) ? 'an opening under the feet'
      : !BUNKER_GROUND.test(b.name) ? `${b.name} under the feet is not natural ground`
        : digMs(b) > BUNKER_DIG_MS ? `${b.name} under the feet digs too slowly` : null
  let dug = 0
  let placed = 0
  let ended = null
  // A stop, or a rescue that took the dig over, ends the build in the cell the body has reached.
  const halted = () => ({ at: o.offset(0, -dug, 0), dug, placed, stopped: buildStop() })
  for (let dy = -1; dy >= -3; dy--) {
    if (buildStop()) return { at: bot.entity.position.floored(), dug, placed, stopped: buildStop() }
    const b = bot.blockAt(o.offset(0, dy, 0))
    ended = ground(b)
    if (ended) break
    await equipPickFor(b.name)
    if (buildStop()) return halted()
    await soleDig(claim, b)
    dug++
    const landed = () => bot.entity.onGround && Math.floor(bot.entity.position.y + 0.01) <= o.y + dy
    for (let i = 0; i < 20 && !landed(); i++) await bot.waitForTicks(1)
    if (!landed()) return { at: bot.entity.position.floored(), dug, placed, stopped: 'the body did not drop into the shaft' }
    if (Math.floor(bot.entity.position.y + 0.01) < o.y + dy) return { at: bot.entity.position.floored(), dug, placed, stopped: 'the body fell through an opening under the shaft' }
    bunker.reached = dug
    const wet = SIDES.flatMap(([dx, dz]) => [0, 1].map((h) => bot.blockAt(o.offset(dx, dy + h, dz)))).filter((s) => s && /water|lava/.test(s.name))
    for (const s of wet) {
      if (claim.takenBy) return halted()
      if ((await placeFiller(s.position)) === 'placed') placed++
    }
    if (wet.length) { ended = `${wet[0].name} beside the body`; break }
  }
  const at = o.offset(0, -dug, 0)
  if (buildStop()) return { at, dug, placed, stopped: buildStop() }
  if (dug < SHELTER.SAFE_DEPTH) return { at, dug, placed, stopped: ended }
  bunker.cell = at
  const walls = SIDES.flatMap(([dx, dz]) => [at.offset(dx, 0, dz), at.offset(dx, 1, dz)])
  for (const c of walls) {
    if (claim.takenBy) return halted()
    if (!solidAt(c) && (await placeFiller(c)) === 'placed') placed++
  }
  if (claim.takenBy) return halted()
  const cap = at.offset(0, 2, 0)
  let capped = await placeFiller(cap)
  // A cap with nothing solid beside it goes against a prop set on the shaft's rim.
  if (capped === null) {
    if (claim.takenBy) return halted()
    const prop = SIDES.map(([dx, dz]) => cap.offset(dx, 0, dz)).find((c) => solidAt(c.offset(0, -1, 0)))
    if (prop && (await placeFiller(prop)) === 'placed') {
      placed++
      if (claim.takenBy) return halted()
      capped = await placeFiller(cap)
    }
  }
  if (capped === 'placed') placed++
  return { at, dug, placed, gaps: [cap, at.offset(0, -1, 0), ...walls].filter(c => !solidAt(c)), exit: [cap].filter(solidAt), ...(ended && { ended }) }
}

// Pillars height blocks and builds the shell around the body on top.
async function pillarShell (height) {
  let placed = 0
  for (let i = 0; i < height; i++) {
    if (buildStop()) return { at: bot.entity.position.floored(), placed, stopped: buildStop() }
    const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    const item = fillers()[0]
    if (!item || !below || !(await jumpPlace(below, item, true))) return { at: bot.entity.position.floored(), placed, stopped: 'a pillar block did not place' }
    placed++
    bunker.reached = placed
  }
  const top = bot.entity.position.floored()
  bunker.cell = top
  await centerOnCell()
  const onTop = () => bot.entity.position.floored().equals(top)
  const put = async (cell) => {
    if (buildStop() || !onTop()) return false
    const r = await placeFiller(cell)
    if (r === 'placed') placed++
    return r !== null
  }
  const ring = (dy) => SIDES.map(([dx, dz]) => top.offset(dx, dy, dz))
  for (const cell of [...ring(-1), ...ring(0), ...ring(1)]) await put(cell)
  const roof = top.offset(0, 2, 0)
  if (!(await put(roof))) {
    const prop = ring(2).find(c => solidAt(c.offset(0, -1, 0)))
    if (prop && await put(prop)) await put(roof)
  }
  const ledge = SIDES.find(([dx, dz]) => solidAt(top.offset(dx, -1, dz)))
  return {
    at: top,
    placed,
    gaps: [top.offset(0, -1, 0), ...ring(0), ...ring(1), roof].filter(c => !solidAt(c)),
    exit: ledge ? [top.offset(ledge[0], 0, ledge[1]), top.offset(ledge[0], 1, ledge[1])].filter(solidAt) : [],
    stopped: buildStop() || (onTop() ? undefined : 'the body left the pillar top')
  }
}

// A mob's hit after the pick and before the body is out of reach stops the build. An arrow does not
// stop a dig-in, which takes the body out of its line.
function onBuildHit (attrib) {
  const cls = attrib && attrib.entity && !attrib.envHit ? mobClass(attrib.entity) : null
  if (attrib && attrib.ranged && bunker.mode === 'down') return
  if (!bunker.stop && bunker.mode && ['hostile', 'creeper', 'heavy', 'provokable'].includes(cls) && !outOfReach()) bunker.stop = 'hit while building'
}

function createBunkerBuild (ctx) {
  Object.assign(ctx, { digIn, pillarShell, onBuildHit })
}

function bindBunkerBuild (ctx) {
  ({ bot, bunker, solidAt, BUNKER_GROUND, digMs, BUNKER_DIG_MS, equipPickFor, SIDES, placeFiller, fillers, jumpPlace, centerOnCell, mobClass } = ctx)
}

module.exports = { createBunkerBuild, bindBunkerBuild }
