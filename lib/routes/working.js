'use strict'

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const loadItem = require('prismarine-item')
const { enclosedDrop } = require('../drops')
const { entityInCell } = require('../shelter')
const { GRAVESTONE, overrideRecipes, craftable } = require('../server-overrides')
const { smeltYield, burnItems, COOK_PROBE_TICKS } = require('../furnace')
const { LEGACY_1710, SERVER_RECIPES } = require('../bot/config')
const { LEGACY_CRAFT_SYNC_MS, LEGACY_GRID_SYNC_MS, LEGACY_DIG_CONFIRM_MS } = require('../bot/legacy-1710')
const { claimDig, releaseDig, digBusy } = require('../bot/dig-lock')
const { stackPause } = require('../pace')
const { STRIKE_APPROACH_MS } = require('../combat-rules')

let bot, liveEntities, entityPerceptible, routeEnd, stagedGoto, round, cellKnown, xyz, shared, resolveBlockIds, nearestKnown, arrivedStation, NEIGHBOURS, bodyTouches, seesLit, fillFrom, err, collectLock, collectBusy, nearestVisible, collectSafely, ok, bunker, BUNKER_WALK, claimLane, walkRoute, namedStop, releaseLane, resolveItem, placeSpot, clearSoftCover, jobs, safeFood, foodUpdate, FOOD_UPDATE_MS, outOfSight, seenNow, holdDigTool, neededPickTier, PICK_TIER, holdHarvester, silkRefusal, occupant, isSoftCover, isInteractive, reachToPlace, passageAxis, stampOwnEdit, sneakPlace, hangFrame, afterServerAge, waitedText, send, watchedWork, stopPath, emitEvent, refuseWhileBuilding, equipPickFor, nudgeInto, macroPlaceAt, playerEntity, playerSighting, reflexes, nearestSeen, targetSeen, inMeleeReach, meleeReachGoal, meleeAim, knownBlocks, rememberedStation, skyInSight, cardinal, cardinalName, refuseWhileFighting, holdHand, endHand, lightRange, floodPassable, cellText, holdsWater, canStepOutTo, centerOnCell, legs, suffocates

// ---- MACROS subsystem helpers ----
// how far below the bot's feet we tolerate before refusing to dig down toward a target
const GATHER_MAX_DROP = 2
const GATHER_MAX_RISE = 4   // don't target logs more than ~4 above feet — out of dig-reach without
                            // climbing, so with canDig=false they just time out. Get the reachable trunk.

function itemCounts () {
  const counts = {}
  for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count
  return counts
}

function nearestDrop (radius, skip) {
  const here = bot.entity.position
  return liveEntities()
    .filter(e => e.name === 'item' && e.position && !skip.has(e.id) && e.position.distanceTo(here) <= radius && entityPerceptible(e, null))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0] || null
}

async function collectDrops (radius, route) {
  const skip = new Set()
  const missed = []
  for (;;) {
    if (routeEnd(route)) return { missed, reason: routeEnd(route) }
    const drop = nearestDrop(radius, skip)
    if (!drop) return { missed, reason: null }
    const r = await stagedGoto({ drop }, route)
    if (r.reason === 'stopped') return { missed, reason: 'stopped' }
    // A pickup lands a few ticks after the arrival.
    for (let i = 0; i < 10 && bot.entities[drop.id] && !routeEnd(route); i++) await bot.waitForTicks(2)
    if (!bot.entities[drop.id] || routeEnd(route)) continue
    skip.add(drop.id)
    const item = drop.getDroppedItem && drop.getDroppedItem()
    missed.push({ item: item ? item.name : 'item', pos: round(drop.position), reason: r.reason || 'not-picked-up' })
  }
}

// Marks each missed drop that no known cell a body fits in reaches as enclosed, with its cell.
function enclosedMisses (missed) {
  return missed.map(m => {
    const cell = enclosedDrop(m.pos, { blockAt: (p) => bot.blockAt(p), known: cellKnown })
    return cell ? { ...m, reason: 'enclosed', cell: xyz(cell) } : m
  })
}

// The collect reply's hint for drops no body reaches.
function enclosedHint (missed) {
  const cells = missed.filter(m => m.reason === 'enclosed').map(m => `${m.cell.x},${m.cell.y},${m.cell.z}`)
  return cells.length ? `enclosed at ${cells.join(' and ')}: dig to it, or place a block into its cell to push it out` : null
}

// True one tick after the first window 0 packet of names, false after ms.
async function windowZeroUpdate (names, ms) {
  const seen = await new Promise((resolve) => {
    const listeners = names.map((name) => [name, (p) => { if (name === 'set_player_inventory' || p.windowId === 0) done(true) }])
    const done = (update) => {
      clearTimeout(timer)
      for (const [name, fn] of listeners) bot._client.removeListener(name, fn)
      resolve(update)
    }
    const timer = setTimeout(() => done(false), ms)
    for (const [name, fn] of listeners) bot._client.on(name, fn)
  })
  if (seen) await bot.waitForTicks(1)
  return seen
}

// Crafts at a crafting table seen within 16 blocks, else in the 2x2 grid if the recipe fits, and never places a table.
async function craftItem (item, count) {
  const override = overrideRecipes(SERVER_RECIPES, item.name, shared.mcData.itemsByName)
  const recipesAt = (table) => override
    ? craftable(override, table, (id) => bot.inventory.count(id, null))
    : bot.recipesFor(item.id, null, 1, table)
  // Does this recipe need a 3x3 table? (craftable WITH an assumed table but not without one)
  const needsTable = !recipesAt(null).length && !!recipesAt(true).length
  // Tableless 2x2 crafting desyncs on 1.21.x: the client simulates the craft (materials down,
  // output up) but the server never performs it, and the next sync deletes the output. Route
  // every craft through a real table when one is reachable; 2x2 only as last resort.
  const canUseTable = !!recipesAt(true).length
  const tableIds = resolveBlockIds('crafting_table')
  const near = nearestKnown(tableIds, 16)
  if (needsTable && !near) throw new Error('no crafting table seen within 16, place one (place or placeitem) and craft again')
  let useTable = canUseTable && !!near
  const notes = []
  if (useTable) {
    // walk within reach of an existing table (fixes today's "table 4 blocks away" failure)
    const { x, y, z } = near.position
    let reached = true
    try { await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3)) } catch (e) {
      if (e.reason) throw e
      if (needsTable || !LEGACY_1710) throw new Error(`cannot reach the crafting table at ${x},${y},${z}`)
      reached = false
    }
    if (!needsTable && LEGACY_1710 && !(reached && nearestKnown(tableIds, 4))) {
      useTable = false
      notes.push(`the crafting table at ${x},${y},${z} is out of reach, crafted in the 2x2 grid`)
    }
  }

  const have = () => bot.inventory.items().filter(it => it.name === item.name).reduce((s, it) => s + it.count, 0)
  // count means ITEMS, not recipes (the 12-log lesson): one recipe pass may yield several
  // items (planks 4, sticks 4, torches 4) — stop as soon as we've made enough.
  let made = 0, lastErr = null, unconfirmed = false
  for (let pass = 1; made < count; pass++) {
    const at = useTable && nearestKnown(tableIds, 4)
    const t = at ? arrivedStation(at.position, (b) => b.name === 'crafting_table', 'crafting table') : null
    const recipes = recipesAt(t)
    if (!recipes.length) { lastErr = `out of materials/recipe after ${made}${useTable ? ` (table nearby: ${!!t})` : ''}`; break }
    const perCraft = (recipes[0].result && recipes[0].result.count) || 1
    const before = have()
    try { await bot.craft(recipes[0], 1, t || undefined) }
    catch (e) { lastErr = e.message; break }
    if (!LEGACY_1710) { made += perCraft; continue }
    // A rejected craft draws a window 0 window_items while bot.craft still runs.
    const synced = t
      ? await windowZeroUpdate(['set_slot', 'window_items', 'set_player_inventory'], LEGACY_CRAFT_SYNC_MS)
      : await windowZeroUpdate(['window_items'], LEGACY_GRID_SYNC_MS)
    if (t && !synced) unconfirmed = true
    const gained = have() - before
    if (gained <= 0) { lastErr = `the server made no ${item.name} on pass ${pass}`; break }
    made += gained
  }

  const nowHave = have()
  if (made === 0) throw new Error(lastErr || 'craft failed')
  if (lastErr) notes.push(lastErr)
  return {
    crafted: item.name, requested: count, made, usedTable: useTable, nowHave, note: notes.join('; ') || undefined,
    ...(unconfirmed ? { unconfirmed: `no inventory update from the server within ${LEGACY_CRAFT_SYNC_MS} ms, made and nowHave may predate the craft` } : {})
  }
}

// The items a dig of the blocks ids lands in the pockets: their drops, or the block itself.
function gatherItems (ids) {
  const names = new Set()
  for (const id of ids) {
    const blk = shared.mcData.blocks[id]
    for (const d of blk.drops) names.add(shared.mcData.items[d].name)
    if (shared.mcData.itemsByName[blk.name]) names.add(blk.name)
  }
  names.delete('air')
  return names
}

// Why a dig job stops after digging p (bared lava or water, or with a back cell a gravel or sand cap), or null.
// A gravel or sand stop steps the body into back when it can stand there, cut off once job is cancelled.
async function struckHazard (p, back = null, climbing = false, job = null) {
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const n = p.offset(dx, dy, dz)
    const b = bot.blockAt(n)
    const falling = !!back && dy === 1 && !!b && /^(gravel|sand|red_sand)$/.test(b.name)
    if (!b || !(falling || /lava|water/.test(b.name)) || !(bodyTouches(n) || seesLit(n, 8))) continue
    const at = `${n.x},${n.y},${n.z}`
    if (falling) {
      const why = `${b.name} falling from ${at}, stopping`
      if (!canStepOutTo(back)) return why
      const route = job && { expired: () => false, stopped: () => job.cancelled }
      return `${why}, ${(await nudgeInto(back, climbing, undefined, route)) ? `stepped back to ${cellText(back)}` : 'could not step back'}`
    }
    if (!b.name.includes('lava')) return `struck ${b.name} at ${at}, stopping`
    const why = await fillFrom(p)
    return `struck ${b.name} at ${at}, ${why ? `the hole stays open, ${why}` : 'filled the hole back'}`
  }
  return null
}

// The first gravel or sand block seen now in cells, or undefined.
function fallenIn (cells) {
  return cells.map((c) => bot.blockAt(c)).find((b) => b && /^(gravel|sand|red_sand)$/.test(b.name) && seenNow(b.position, 8))
}

// The busy refusal while a sole claim holds the dig lock, else null.
function busyText () {
  try { digBusy() } catch (e) { return e.message }
  return null
}

// Why a dig job stops on a dig that threw. A busy refusal reads whole, also for a dig a sole claim aborted.
function digFailed (e) {
  return e.reason === 'busy' ? e.message : busyText() || 'dig failed: ' + e.message.slice(0, 30)
}

// Ticks a dig job waits for blocks falling into its way. On 1.7.10 that covers a column of about 15 blocks falling 2
// cells, which falls whole once dug out from under, each block 2 ticks after the one below it.
const FALL_TICKS = 40
// Ticks a dig job waits after its digs before anything unseen can show falling into its way. 1.7.10 starts gravel or
// sand falling 2 ticks after the cell under it opens, and the falling block's spawn takes a tick more to arrive.
const FALL_START_TICKS = 3

// What falls into cells, named with its cell: a falling block in or over them, or gravel or sand seen now over one the
// step's digs opened, which starts falling 2 ticks after the cell opens. Else null. opened holds their cellText.
// 1.7.10 starts gravel or sand falling only when a neighbour changes, so over a cell open before the step it stays put.
function fallingInto (cells, opened) {
  const columns = new Set(cells.map((c) => `${c.x},${c.z}`))
  const low = Math.min(...cells.map((c) => c.y))
  const e = liveEntities().find((e) => e.name === 'falling_block' && e.position.y > low - 1 && columns.has(`${Math.floor(e.position.x)},${Math.floor(e.position.z)}`))
  if (e) return `a block at ${cellText(e.position.floored())}`
  for (const c of cells) {
    if (!opened.has(cellText(c))) continue
    const top = bot.blockAt(c.offset(0, 1, 0))
    // 1.7.10 lets gravel and sand fall into air, fire, water and lava only.
    if (top && /^(gravel|sand|red_sand)$/.test(top.name) && seenNow(top.position, 8) && /^((cave_|void_)?air|(soul_)?fire|water|lava)$/.test(bot.blockAt(c)?.name)) return `${top.name} at ${cellText(top.position)}`
  }
  return null
}

// Waits until nothing falls into cells and returns null, or why the dig job stops: FALL_TICKS ticks in, or on gravel or
// sand landed in the body cells. opened holds the cellText of the cells the step's digs opened. After digs it waits at
// least FALL_START_TICKS.
async function fallsLanded (cells, opened, dug = false, body = []) {
  const from = dug ? FALL_START_TICKS : 0
  if (from) await bot.waitForTicks(from)
  for (let t = from; ; t++) {
    const what = fallingInto(cells, opened)
    if (!what) {
      const b = fallenIn(body)
      return b ? `${b.name} fell onto me` : null
    }
    if (t === FALL_TICKS) return `${what} still falling after ${FALL_TICKS} ticks, stopping`
    await bot.waitForTicks(1)
  }
}

// Digs the gravel or sand that lands in a dig job's passage cells, at most 8 times, calling dug for each dig, and returns why the job stops or null.
// opened holds the cellText of the cells the step's digs opened and gains each dug cell.
// With stalled it digs none and returns stalled() instead. body passes to fallsLanded.
async function digFallen (cells, opened, pick, job, dug, stalled = null, body = []) {
  for (let digs = 0; ; digs++) {
    const falling = await fallsLanded(cells, opened, true, body)
    if (falling) return falling
    const b = fallenIn(cells)
    if (!b) return null
    if (stalled) return stalled()
    if (job.cancelled) return 'cancelled'
    if (digs === 8) return `${b.name} keeps falling into ${cellText(b.position)}, stopped after 8 digs`
    const stop = busyText() || (await pick.equip(b)) || pick.short(b)
    if (stop) return stop
    try {
      const refused = await pick.dig(b)
      if (refused) return refused
    } catch (e) { return digFailed(e) }
    dug()
    opened.add(cellText(b.position))
    const struck = await struckHazard(b.position, null, false, job)
    if (struck) return struck
  }
}

// What a dig job's stalled step names: the gravel or sand seen in cells, else stalled.
function fellText (cells, stalled) {
  const b = fallenIn(cells)
  return b ? `${b.name} fell into ${cellText(b.position)}` : stalled
}

// own is the corridor, breached the open cells already accounted for, pending the cells opened since the last report.
function breachWatch () {
  return { own: new Set(), breached: new Set(), pending: [] }
}

// Marks seen open air next to cells, corridor excluded, as breached and returns the cells that start a new opening.
function breachFrom (cells, watch) {
  const fresh = []
  for (const p of cells) {
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const n = p.offset(dx, dy, dz)
      const at = cellText(n)
      const b = bot.blockAt(n)
      if (watch.own.has(at) || watch.breached.has(at) || !floodPassable(b) || holdsWater(b) || !(bodyTouches(n) || seesLit(n, 8))) continue
      if (!NEIGHBOURS.some(([ex, ey, ez]) => watch.breached.has(cellText(n.offset(ex, ey, ez))))) fresh.push(lightRange(n, b) === Infinity ? at : `${at} (unlit)`)
      watch.breached.add(at)
    }
  }
  return fresh
}

// Names the open air beside the pending cells in one mine event.
function reportBreach (watch) {
  const fresh = breachFrom(watch.pending, watch)
  watch.pending.length = 0
  if (fresh.length) emitEvent('mine', `breached open air at ${fresh.join(' and ')}`)
}

// Digs b and returns the 1.7.10 server's answer: block replaced b, resent sent b back, item last filled held's slot.
// last waits for that slot's update too. job returns at a resend, else a resent b has until its bare-hand dig time to break.
// after runs once bot.dig resolves.
async function legacyDig (b, held, { last = false, job = false, after = () => {} } = {}) {
  const start = Date.now()
  const seen = { block: null, resent: false, slot: false, item: null, ms: 0 }
  let resolved = false
  let wake = () => {}
  const onBlock = (oldB, newB) => {
    // mineflayer's air write comes after it clears targetDigBlock and before the dig resolves.
    if (seen.block || !newB || !(bot.targetDigBlock || resolved)) return
    if (newB.name === b.name) seen.resent = true
    else seen.block = newB
    wake()
  }
  const onSlot = (s, oldItem, newItem) => {
    if (s !== held.slot) return
    seen.slot = true
    seen.item = newItem
    wake()
  }
  const event = `blockUpdate:${b.position}`
  bot.on(event, onBlock)
  if (last) bot.inventory.on('updateSlot', onSlot)
  try {
    await bot.dig(b)
    resolved = true
    after()
    const done = Date.now()
    const until = () => (seen.resent && !job ? Math.max(done, start + b.digTime(null, false, false, false)) : done) + LEGACY_DIG_CONFIRM_MS
    while (!(seen.block && (seen.slot || !last)) && !(job && seen.resent) && Date.now() < until()) {
      let timer
      await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, until() - Date.now()) })
      clearTimeout(timer)
    }
    seen.ms = Date.now() - start
    return seen
  } finally {
    bot.removeListener(event, onBlock)
    bot.inventory.removeListener('updateSlot', onSlot)
  }
}

// equip, short and dig return a stop reason, else null. equip's comes once the job's last pick is gone.
function digPick () {
  let hadPick = null
  // The pick the last equip left in hand, with how many of its type were carried then.
  let inHand = null
  let broke = null
  const carried = (type) => bot.inventory.items().filter((it) => it.type === type).length
  // A pick's last use is at maxDurability - 1 used under 1.21 data, at maxDurability used on 1.7.10.
  const lastUse = (held) => !!held && held.maxDurability > 0 && (held.durabilityUsed || 0) >= held.maxDurability - 1
  return {
    // A bunker build that began meanwhile ends the job before the dig that follows.
    async equip (b) {
      refuseWhileBuilding()
      // A torch or filler equip with a full hotbar can swap the pick out of its slot unbroken.
      if (inHand) {
        const it = bot.inventory.slots[inHand.slot]
        if (!(it && it.type === inHand.type) && carried(inHand.type) < inHand.carried) broke = inHand.name
      }
      const fits = await equipPickFor(b && b.name)
      refuseWhileBuilding()
      hadPick ??= fits !== null
      if (hadPick && fits === null) return 'no pickaxe left (tool broke)'
      const now = bot.heldItem
      inHand = now && PICK_TIER[now.name] !== undefined ? { slot: now.slot, type: now.type, name: now.name, carried: carried(now.type) } : null
      if (broke && inHand) {
        emitEvent('mine', `${broke} broke, swapped to ${now.name}`)
        broke = null
      }
      return null
    },
    // Why the held item leaves no drop of b, else null.
    short (b) {
      const need = neededPickTier(b.name)
      const held = bot.heldItem
      if (need === 0 || (held && PICK_TIER[held.name] >= need)) return null
      const tool = Object.keys(PICK_TIER).find((name) => PICK_TIER[name] === need)
      return `${b.name} at ${cellText(b.position)} needs pick tier ${need} (${tool} or better), holding ${held ? held.name : 'nothing'}`
    },
    // On 1.7.10 a dig the server resends is dug once more after an equip, if the pick then held harvests it.
    async dig (b) {
      if (LEGACY_1710) {
        for (let again = false; ; again = true) {
          const held = bot.heldItem
          const seen = await legacyDig(b, held, { last: lastUse(held), job: true })
          if (!seen.resent) return null
          const { x, y, z } = b.position
          if (again) return `the server resent the ${b.name} at ${x},${y},${z} after a second dig holding ${held ? held.name : 'nothing'}`
          const stop = (await this.equip(b)) || this.short(b)
          if (stop) return stop
        }
      }
      // bot.dig resolves before the server's slot update that shows whether the pick broke.
      const held = bot.heldItem
      if (!lastUse(held)) { await bot.dig(b); return null }
      let updated
      const update = new Promise((resolve) => { updated = resolve })
      const onSlot = (slot) => { if (slot === held.slot) updated() }
      bot.inventory.on('updateSlot', onSlot)
      let timer
      try {
        await bot.dig(b)
        await Promise.race([update, new Promise((resolve) => { timer = setTimeout(resolve, 500) })])
      } finally {
        clearTimeout(timer)
        bot.inventory.removeListener('updateSlot', onSlot)
      }
      return null
    }
  }
}

// ---- chest / container interaction ----
const CHEST_RADIUS = 12
// A left half's other half lies clockwise of its facing.
function chestPair (b) {
  const { type, facing } = (b && b.getProperties?.()) || {}
  const cw = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }[facing]
  const turn = { left: 1, right: -1 }[type]
  return cw && turn ? b.position.offset(cw[0] * turn, 0, cw[1] * turn) : null
}
// Trapped chests are left out because opening one powers redstone.
function knownChests (radius) {
  const here = bot.entity.position
  const near = knownBlocks(resolveBlockIds('chest'), radius).map(p => {
    const q = seenNow(p) ? chestPair(bot.blockAt(p)) : null
    return { pos: p, pair: q && cellKnown(q) ? q : null, dist: here.distanceTo(p.offset(0.5, 0.5, 0.5)) }
  })
  return near.filter((c, i) => {
    const half = near.slice(0, i).find(o => (o.pair && o.pair.equals(c.pos)) || (c.pair && c.pair.equals(o.pos)))
    if (half) half.pair ??= c.pos
    return !half
  })
}
function otherChests (p, radius) {
  const others = knownChests(radius).filter(c => !c.pos.equals(p) && !(c.pair && c.pair.equals(p)))
  if (!others.length) return `no other chest seen within ${radius}`
  const cell = (v) => `${v.x},${v.y},${v.z}`
  return `other chests seen within ${radius}: ` + others.map(c => `${cell(c.pos)}${c.pair ? ` and ${cell(c.pair)}` : ''} (${c.dist.toFixed(1)} away)`).join(', ')
}
// The item names of a withdraw or deposit: one, or up to 8 split by |.
function chestNames (raw) {
  const names = String(raw == null ? '' : raw).split('|').map(s => s.trim()).filter(Boolean)
  if (!names.length) throw new Error('name required')
  if (names.length > 8) throw new Error(`at most 8 names, got ${names.length}`)
  return names
}
function targetChest(q) {
  if (q.x != null && q.y != null && q.z != null) {
    const Vec3 = require('vec3').Vec3
    const p = new Vec3(Math.floor(parseFloat(q.x)), Math.floor(parseFloat(q.y)), Math.floor(parseFloat(q.z)))
    if (!seenNow(p)) {
      const remembered = rememberedStation(p, resolveBlockIds('chest'))
      if (!remembered) throw outOfSight()
      return { cb: remembered }
    }
    const b = bot.blockAt(p)
    if (!b || !b.name.includes('chest')) throw new Error(`no chest at ${q.x},${q.y},${q.z} (${b ? b.name : 'unloaded'})`)
    return { cb: b }
  }
  const radius = parseInt(q.radius || CHEST_RADIUS)
  const chests = knownChests(radius)
  if (!chests.length) throw new Error(`no chest seen within ${radius}`)
  return { cb: bot.blockAt(chests[0].pos), chests }
}

// The returned turn runs before each stack moved in win.
function stackTurns (win, what, lease) {
  let moves = 0
  return async () => {
    if (moves++) {
      await stackPause()
      if (bot.currentWindow !== win) throw new Error(`the ${what} closed`)
    }
    if (reflexes.find(r => r.name === 'combat').fightBusy()) throw new Error('a fight started')
    lease.renew()
  }
}

// Withdraws up to count of type from win, one source stack per mineflayer call. moved gets each call's count.
async function withdrawStacks (win, type, count, turn, moved) {
  const first = () => win.containerItems().find(i => i.type === type)
  for (let left = count; left > 0 && first();) {
    await turn()
    const from = first()
    if (!from) return
    const n = Math.min(left, from.count, from.stackSize)
    await win.withdraw(type, null, n)
    moved(n)
    left -= n
  }
}

const GRAVE_SIGHT = 32
// Refuses a cell out of lit sight before reading its block.
function targetGrave (q) {
  const grave = shared.mcData && shared.mcData.blocksByName[GRAVESTONE]
  if (!grave) throw new Error('this server has no gravestones')
  if (q.at == null) return nearestVisible([grave.id], GRAVE_SIGHT)
  const [x, y, z] = String(q.at).split(',').map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('at takes x,y,z')
  const p = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  if (!seesLit(p, GRAVE_SIGHT)) throw outOfSight()
  const b = bot.blockAt(p)
  if (!b || b.name !== GRAVESTONE) throw new Error(`no gravestone at ${p.x},${p.y},${p.z} (${b ? b.name : 'unloaded'})`)
  return b
}

// The cell that must change when clicking b at p with held works, null when it may work and change nothing.
function useTarget (b, p, held) {
  const props = b.getProperties()
  if ('open' in props) return p
  if (!held) return null
  if (held.endsWith('_hoe') && /^(dirt|grass_block|dirt_path|coarse_dirt|rooted_dirt)$/.test(b.name)) return p
  if ((b.name === 'farmland' && /^(wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds|carrot|potato|torchflower_seeds|pitcher_pod)$/.test(held)) ||
    (b.name === 'soul_sand' && held === 'nether_wart')) return p.offset(0, 1, 0)
  if (held === 'bone_meal' && ('age' in props || 'stage' in props)) return p
  if (held === 'bucket' && /^(water|lava)$/.test(b.name)) return p
  if (/^(water|lava)_bucket$/.test(held) && /^(cave_|void_)?air$/.test(b.name)) return p
  return null
}

// The plant above b at p that takes bone meal, when b itself has no age or stage.
function boneMealPlant (b, p) {
  const props = b.getProperties()
  if ('age' in props || 'stage' in props) return null
  const above = p.offset(0, 1, 0)
  if (!seesLit(above, 6)) throw outOfSight()
  const up = bot.blockAt(above)
  if (!up) return null
  const takes = 'stage' in up.getProperties() || /^(wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|sweet_berry_bush|torchflower_crop|pitcher_crop)$/.test(up.name)
  return takes ? up : null
}

// Runs act, then waits until the server updates the block at p, at most ms.
async function withBlockUpdate (p, ms, act) {
  let updated
  const update = new Promise((resolve) => { updated = resolve })
  const onUpdate = (old, now) => { if (now && now.position.equals(p)) updated() }
  bot.on('blockUpdate', onUpdate)
  let timer
  try {
    await act()
    await Promise.race([update, new Promise((resolve) => { timer = setTimeout(resolve, ms) })])
  } finally {
    clearTimeout(timer)
    bot.removeListener('blockUpdate', onUpdate)
  }
}

function itemFrame (name) {
  return name === 'item_frame' || name === 'glow_item_frame'
}

// The item in frame en, null for an empty frame.
function framedItem (en) {
  const at = (shared.mcData.entitiesByName[en.name]?.metadataKeys || []).indexOf('item')
  const raw = at < 0 ? null : (en.metadata || [])[at]
  return raw == null ? null : loadItem(bot.registry).fromNotch(raw)
}

// The nearest perceived frame within 16 whose fill matches filled, and the nearest one of either fill, both hanging in cell when given.
function nearestFrame (name, filled, cell = null) {
  const here = bot.entity.position
  const fill = reflexes.find(r => r.name === 'combat').fairFill(bot)
  const frames = liveEntities()
    .filter(en => en.position && (en.name === name || en.displayName === name) && en.position.distanceTo(here) <= 16 && entityPerceptible(en, fill) && (!cell || en.position.floored().equals(cell)))
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))
  return { frame: frames.find(en => !!framedItem(en) === filled), nearest: frames[0] }
}

// The block cell that at names, not the frame in it.
function frameAt (name, at) {
  if (at == null) return null
  if (!itemFrame(name)) throw new Error('at picks an item frame by its cell')
  const parts = String(at).split(',').map((s) => s.trim() === '' ? NaN : Number(s))
  if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error('at takes x,y,z')
  const [x, y, z] = parts
  return new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
}

// Runs act, then waits until the server updates entity en, at most ms of server age and until the Date.now() ms deadline.
// Resolves to {by, ticks, waited}: by is 'update', 'ticks' or 'deadline', ticks those afterServerAge counted and waited the
// ms the wait took. Null at once when act returns false.
async function withEntityUpdate (en, ms, deadline, act) {
  let came = false
  let ended
  const end = new Promise((resolve) => { ended = resolve })
  const onUpdate = (e) => {
    if (e.id !== en.id) return
    came = true
    ended('update')
  }
  bot.on('entityUpdate', onUpdate)
  let timer
  let stopAge = null
  try {
    if (await act() === false) return null
    const from = Date.now()
    stopAge = afterServerAge(ms, () => ended('ticks'))
    timer = setTimeout(() => ended('deadline'), Math.max(0, deadline - Date.now()))
    const by = await end
    const waited = Date.now() - from
    const ticks = stopAge()
    // The age update or the timer that ends the wait can run ahead of an update packet from the same tick.
    if (!came) await new Promise(setImmediate)
    return { by: came ? 'update' : by, ticks, waited }
  } finally {
    clearTimeout(timer)
    bot.removeListener('entityUpdate', onUpdate)
    if (stopAge) stopAge()
  }
}

// Walks into swing reach of the face of frame en within ms. False when halted() turned true on the way.
// Throws for a frame the walk does not reach, naming it name.
async function walkToFrame (name, en, ms, halted) {
  const goal = meleeReachGoal(en, 0.6)
  // The status of the last path the pathfinder found, and true once a success had steps.
  let last = null
  let underway = false
  // Settles on the end of the walk, failing with goto's error for a failed one.
  let over = false
  let ended
  const end = new Promise((resolve, reject) => {
    ended = (e) => {
      if (over) return
      over = true
      if (e) reject(e)
      else resolve()
    }
  })
  end.catch(() => {})
  const failed = (kind, message) => ended(Object.assign(new Error(message), { name: kind }))
  // False once another goal took the pathfinder. The unstuck ladder clears the goal and then replans this same goal object.
  let owned = true
  const listeners = {
    path_update: (r) => {
      last = r.status
      if (r.status === 'success' && r.path.length > 0) underway = true
      else if (r.status === 'success') ended()
      else if (r.status === 'noPath') failed('NoPath', 'No path to the goal!')
      else if (r.status === 'timeout') failed('Timeout', 'Took to long to decide path to goal!')
    },
    goal_reached: (g) => { if (g === goal) ended() },
    goal_updated: (g) => {
      if (g === goal) return
      owned = false
      failed('GoalChanged', 'The goal was changed before it could be completed!')
    },
    path_stop: () => failed('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.')
  }
  // A failed goto leaves the pathfinder walking.
  const unreached = (outOfTime, stopped = false) => {
    if (!stopped && bot.pathfinder.goal === goal) stopPath()
    const at = cellText(en.position.floored())
    return new Error(outOfTime || last === 'partial' ? `the walk to the ${name} at ${at} ran out of time on its way` : `no spot in walking reach puts the face of the ${name} at ${at} in swing reach`)
  }
  // A halt that only took the lane leaves the walk walking.
  const release = () => { if (owned && bot.pathfinder.goal === goal) stopPath() }
  listeners.physicsTick = () => { if (halted()) release() }
  let timer
  // Settles at ms, false when halted() holds and true for a body still in reach after its stop with no goal_reached.
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (halted()) {
        release()
        return resolve(false)
      }
      // A stop emits pathfinder events that would end the walk with their own error.
      over = true
      if (!inMeleeReach(en, 0.6)) return reject(unreached(underway))
      if (bot.pathfinder.goal === goal) stopPath()
      // The stop recentres a body more than 0.2 off its cell centre.
      if (!inMeleeReach(en, 0.6)) return reject(unreached(true, true))
      resolve(true)
    }, ms)
  })
  for (const [event, fn] of Object.entries(listeners)) bot.on(event, fn)
  try {
    let walked = await Promise.race([bot.pathfinder.goto(goal), late])
    // goto also resolves on a partial path with no steps, which ends nothing.
    if (walked === undefined && last !== null) walked = await Promise.race([end, late])
    // Only late settles with a verdict, its reach checked.
    if (walked !== undefined) return walked
  } catch (e) {
    if (halted()) {
      release()
      return false
    }
    // A Timeout is a search that ran out of think time.
    throw e.name === 'NoPath' || e.name === 'Timeout' ? unreached(e.name === 'Timeout') : e
  } finally {
    clearTimeout(timer)
    for (const [event, fn] of Object.entries(listeners)) bot.removeListener(event, fn)
  }
  if (halted()) {
    release()
    return false
  }
  // The pathfinder also resolves a search that ends on its start cell out of reach.
  if (!inMeleeReach(en, 0.6)) throw unreached(false)
  return true
}

function targetFurnace (q) {
  if (q.at == null) {
    const b = nearestKnown(resolveBlockIds('furnace'), 8)
    if (!b) throw new Error('no furnace seen within 8')
    return b
  }
  const [x, y, z] = String(q.at).split(',').map(Number)
  if (![x, y, z].every(Number.isFinite)) throw new Error('at takes x,y,z')
  const p = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  if (!seenNow(p)) {
    const remembered = rememberedStation(p, resolveBlockIds('furnace'))
    if (!remembered) throw outOfSight()
    return remembered
  }
  const b = bot.blockAt(p)
  if (!b || b.name !== 'furnace') throw new Error(`no furnace at ${p.x},${p.y},${p.z} (${b ? b.name : 'unloaded'})`)
  return b
}

function furnaceSlots (furnace) {
  const text = (i) => i ? `${i.count} ${i.name}` : null
  return { input: text(furnace.inputItem()), fuel: text(furnace.fuelItem()), output: text(furnace.outputItem()) }
}

function pocketRoom (window, item) {
  const partial = window.items().filter(i => i.type === item.type).reduce((s, i) => s + i.stackSize - i.count, 0)
  return window.emptySlotCount() * item.stackSize + partial
}

async function takeSlot (furnace, item, n) {
  await bot.transfer({ window: furnace, itemType: item.type, metadata: null, count: n,
    sourceStart: item.slot, sourceEnd: item.slot + 1, destStart: furnace.inventoryStart, destEnd: furnace.inventoryEnd })
}

// A furnace lights its fuel and cooks only an input the server has a recipe for.
async function furnaceCooks (furnace) {
  for (let t = 0; t < COOK_PROBE_TICKS; t++) {
    if (furnace.progress > 0) return true
    await bot.waitForTicks(1)
  }
  return furnace.progress > 0
}

// The walls beside a cell by x and z offset, in the order a ladder or sign tries them.
const HANGS = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }
// The wall behind a ladder or wall sign of each facing.
const BEHIND = { west: 'east', east: 'west', north: 'south', south: 'north' }

// Past the 2 s lease the guard reflex can swap the sword in before the click.
function handKept (it, done = 'placed') {
  if (bot.heldItem && bot.heldItem.name === it.name) return
  throw new Error(`the guard reflex took the hand back from the ${it.name} (holding ${bot.heldItem ? bot.heldItem.name : 'nothing'}), nothing ${done}, retry`)
}

// True for a cell in the row the feet rest on and under any part of the body's box, with the feet at feet.
function standsOn (p, feet = bot.entity.position) {
  const body = { position: feet, width: bot.entity.width, height: bot.entity.height }
  return p.y === Math.floor(feet.y - 1e-3) && entityInCell(p.offset(0, 1, 0), [body])
}

// mineflayer-collectblock's walk goal for p, minus the cells where the body stands on p or one of falls lands on it.
function collectWalkGoal (p, falls = []) {
  const goal = new goals.GoalLookAtBlock(p, bot.world)
  const sees = goal.isEnd.bind(goal)
  goal.isEnd = (node) => {
    const feet = node.offset(0.5, 0, 0.5)
    return sees(node) && !standsOn(p, feet) && !fallOnBody(falls, feet)
  }
  return goal
}

// The cell the pathfinder starts a walk from the body's position in.
function walkStart () {
  return bot.pathfinder.startCell(bot.entity.position)
}

// The gravel and sand columns seen now that a dig of p sets falling, under p, over it or beside it, each with the cells it lands in.
function fallsFrom (p) {
  // A cell not seen now counts as open down to the feet row and as floor below it, whatever block it holds.
  const feetRow = Math.floor(bot.entity.position.y)
  const open = (c) => {
    const b = bot.blockAt(c)
    if (!b) return false
    if (c.equals(p)) return true
    if (!seenNow(c)) return c.y >= feetRow
    return b.shapes.length === 0
  }
  // A column skips the dug cell p.
  const up = (c) => c.offset(0, c.offset(0, 1, 0).equals(p) ? 2 : 1, 0)
  const falls = []
  for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    // The column over p falls with one hanging under p, as its upper part.
    if (dy === 1 && falls.length) continue
    const column = []
    for (let c = p.offset(dx, dy, dz); /^(gravel|sand|red_sand)$/.test(bot.blockAt(c)?.name) && seenNow(c); c = up(c)) column.push(c)
    if (!column.length) continue
    let floor = column[0]
    while (open(floor.offset(0, -1, 0))) floor = floor.offset(0, -1, 0)
    if (floor.equals(column[0])) continue
    // A falling block that lands on a torch or another block it does not replace breaks into an item.
    const replaces = /^((cave_|void_)?air|water|lava|(soul_)?fire|short_grass|tall_grass|fern|large_fern|dead_bush|vine)$/
    if (!floor.equals(p) && seenNow(floor) && !replaces.test(bot.blockAt(floor).name)) continue
    falls.push({ column, landed: column.map((c, k) => floor.offset(0, k, 0)) })
  }
  return falls
}

// The first of falls that lands on the body with its feet at feet.
function fallOnBody (falls, feet = bot.entity.position) {
  const body = { position: feet, width: bot.entity.width, height: bot.entity.height }
  return falls.find((f) => f.landed.some((c) => entityInCell(c, [body])))
}

function burialRefusal (b, fall) {
  const { column } = fall
  const names = [...new Set(column.map((c) => bot.blockAt(c).name))].join(' and ')
  const top = column.length > 1 ? ` to ${cellText(column[column.length - 1])}` : ''
  return `refusing to dig ${b.name} at ${cellText(b.position)}: ${names} at ${cellText(column[0])}${top} would fall on me, stand clear of that column or digat ${cellText(b.position)} anyway to take the fall`
}

// Steps the body off p to the nearest cell beside it, or returns true when no cell holds it and inPlace is set.
async function stepOffDig (p, name, inPlace = false) {
  if (!standsOn(p)) return false
  const o = bot.entity.position
  const away = (c) => Math.hypot(c.x + 0.5 - o.x, c.z + 0.5 - o.z)
  const beside = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    .map(([dx, dz]) => p.offset(dx, 1, dz)).filter((c) => canStepOutTo(c)).sort((a, b) => away(a) - away(b))
  if (!beside.length && inPlace) return true
  const refused = `refusing to dig ${name} at ${cellText(p)}: my body stands on it`
  if (!beside.length) throw new Error(`${refused} and no cell beside it holds me, step off it first`)
  const to = beside[0]
  await bot.pathfinder.goto(new goals.GoalBlock(to.x, to.y, to.z))
  // The walk can end with the box still hanging over p.
  await centerOnCell(to)
  if (standsOn(p)) throw new Error(`${refused} after the step to ${cellText(to)}, step off it first`)
  return false
}

function installWorkingRoutes (app) {
  app.get('/mine', async (req, res) => {
    try {
      const name = req.query.name
      const count = parseInt(req.query.count || '1')
      const radius = parseInt(req.query.radius || '64')
      const silk = req.query.silk === '1'
      const noSilk = silk && silkRefusal(null)
      if (noSilk) return err(res, new Error(noSilk))
      const ids = resolveBlockIds(name)
      if (!ids.length) return err(res, new Error(`unknown block: ${name}`))
      if (collectLock.done) return err(res, collectBusy())
      digBusy()
      const items = gatherItems(ids)
      const pocketed = () => bot.inventory.items().reduce((s, it) => s + (items.has(it.name) ? it.count : 0), 0)
      const before = pocketed()
      let mined = 0
      // Why the collect stopped short: stalled, budget, busy, stopped, a fall onto the body or a dig refused for its tool.
      let reason = null
      for (let i = 0; i < count; i++) {
        const b = nearestVisible(ids, radius)
        if (!b) break
        const noSilk = silk && silkRefusal(b)
        if (noSilk) { reason = noSilk; break }
        // mineflayer-collectblock's walk can end on top of the block it digs.
        const onTop = await stepOffDig(b.position, b.name, true)
        const falls = fallsFrom(b.position)
        // collectblock digs where its walk ends, even under a fall.
        const walk = !onTop && (falls.length > 0 || [1, 2].every((dy) => bot.blockAt(b.position.offset(0, dy, 0))?.boundingBox === 'empty'))
        try {
          if (walk) {
            const goal = collectWalkGoal(b.position, falls)
            try {
              await watchedWork(() => bot.pathfinder.goto(goal), stopPath)
            } catch (e) {
              // When the pathfinder finds no path in time, the fall check below decides whether to dig from here.
              if (!falls.length || !['NoPath', 'Timeout'].includes(e.name)) throw e
            } finally {
              // A failed goto walks on along its partial path, and an empty path leaves the goal set.
              if (bot.pathfinder.goal === goal) stopPath()
            }
          }
          await stepOffDig(b.position, b.name, true)
          const now = fallsFrom(b.position)
          // collectblock walks to its own goal, which ignores the falls, unless that goal holds at the floored feet or the walk's start.
          const own = now.length > 0 && new goals.GoalLookAtBlock(b.position, bot.world)
          const walks = own && !own.isEnd(bot.entity.position.floored()) && !own.isEnd(walkStart())
          const fall = fallOnBody(now) || (walks && now[0])
          if (fall) { reason = burialRefusal(b, fall); break }
          await collectSafely(b, `mine ${name}`, { silk })
        } catch (e) {
          if (!e.reason) throw e
          reason = e.reason === 'busy' ? e.message : e.reason
        }
        // A collect can dig the block and then stall on the pickup.
        const after = bot.blockAt(b.position)
        if (after && after.name !== b.name) mined++
        if (reason) break
      }
      // The slot update of a pickup can land a few ticks after the drop is gone.
      for (let i = 0; i < 10 && pocketed() - before < mined; i++) await bot.waitForTicks(1)
      ok(res, { mined, requested: count, gathered: pocketed() - before, reason })
    } catch (e) { err(res, e) }
  })

  app.get('/collect', async (req, res) => {
    let lane = null
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const radius = parseInt(req.query.radius || '16')
      lane = claimLane('collect', 300000)
      const before = itemCounts()
      const route = walkRoute()
      let done
      try { done = await collectDrops(radius, route) } finally { route.end() }
      const now = itemCounts()
      const picked = {}
      for (const [name, n] of Object.entries(now)) if (n > (before[name] || 0)) picked[name] = n - (before[name] || 0)
      const missed = enclosedMisses(done.missed)
      ok(res, namedStop({ picked, missed, reason: done.reason, hint: enclosedHint(missed) }, route.mark))
    } catch (e) { err(res, e) } finally { releaseLane(lane) }
  })

  app.get('/craft', async (req, res) => {
    try {
      const item = resolveItem(req.query.item)
      if (!item) return err(res, new Error(`unknown item: ${req.query.item}`))
      const count = Math.max(1, parseInt(req.query.count || '1'))
      const asked = req.query.item
      const renamed = Object.hasOwn(shared.mcData.itemsByName, asked) && item.name !== asked ? `${asked} is ${item.name} on this server` : null
      const r = await craftItem(item, count)
      ok(res, { ...r, note: [renamed, r.note].filter(Boolean).join('; ') || undefined })
    } catch (e) { err(res, e) }
  })

  app.get('/place', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const name = req.query.name
      const it = bot.inventory.items().find(i => i.name === name)
      if (!it) return err(res, new Error(`no ${name} in inventory`))
      await bot.equip(it, 'hand')
      const spot = placeSpot()
      if (!spot) return err(res, new Error('no valid adjacent ground spot (need air-over-solid beside me, clear of my body) — for an exact cell use /placeitem?name=&x=&y=&z= instead'))
      const below = spot.offset(0, -1, 0)
      await clearSoftCover(spot)
      await bot.lookAt(spot.offset(0.5, 0.5, 0.5), true)
      await bot.placeBlock(bot.blockAt(below), new Vec3(0, 1, 0))
      ok(res, { placed: name, at: round(spot), on: round(below) })
    } catch (e) { err(res, e) }
  })

  app.get('/equip', async (req, res) => {
    try {
      const piece = /(?:^|_)(helmet|chestplate|elytra|leggings|boots)$/.exec(req.query.name)
      const dest = req.query.dest || (piece ? { helmet: 'head', chestplate: 'torso', elytra: 'torso', leggings: 'legs', boots: 'feet' }[piece[1]] : 'hand')
      // Via turns the click on the off-hand slot into a drop, and the item lands on the ground.
      if (LEGACY_1710 && String(dest) === 'off-hand') return err(res, new Error('1.7.10 has no off-hand'))
      const it = bot.inventory.items().find(i => i.name === req.query.name)
      if (!it) return err(res, new Error(`no ${req.query.name}`))
      const worn = !req.query.dest && dest !== 'hand' && bot.inventory.slots[bot.getEquipmentDestSlot(dest)]
      if (worn) return err(res, new Error(`already wearing ${worn.name} on ${dest}, dest: "${dest}" swaps it`))
      await bot.equip(it, dest)
      ok(res, { equipped: req.query.name, dest })
    } catch (e) { err(res, e) }
  })

  // GET /eat?food=<name>: equips the named food, or the most filling safeFood, eats it and puts the held item back.
  // A running job equips its tool again mid-meal, which ends the meal early.
  app.get('/eat', async (req, res) => {
    try {
      const job = jobs.list().find(j => j.status === 'running' && !j.cancelled)
      if (job) return err(res, Object.assign(new Error(`busy: job ${job.id} ${job.name} holds the hand`), { reason: 'busy' }))
      const want = req.query.food
      const items = bot.inventory.items()
      let food = null
      if (want) food = items.find(i => i.name === want) || items.find(i => i.name.includes(want))
      if (!food) food = safeFood()
      if (!food) {
        const foods = (shared.mcData && shared.mcData.foods) || {}
        const risky = [...new Set(items.filter(i => foods[i.type]).map(i => i.name))]
        return err(res, new Error(risky.length ? `no safe food in inventory, ${risky.join(', ')} only when named in food` : 'no food in inventory'))
      }
      const prevHeld = bot.heldItem
      const before = bot.food
      const was = { food: bot.food, saturation: bot.foodSaturation }
      const lease = holdHand()
      let update = null
      try {
        await bot.equip(food, 'hand')
        // mineflayer gives up on a meal after 2.5 s, and the full-hunger bite below holds 2.1 s.
        lease.renew(3000)
        // mineflayer's consume ends on any held-item change, which can come before the server's update.
        update = foodUpdate(was, food.name)
        try {
          await bot.consume()
        } catch (e) {
          // Golden apples + chorus fruit are edible at FULL hunger in vanilla; mineflayer's
          // consume() guard refuses ("Food is full"). Hold right-click instead. (07-18: that
          // refusal blocked the emergency heal seconds before death #4.)
          if (/full/i.test(e.message) && /golden_apple|chorus_fruit/.test(food.name)) {
            bot.activateItem()
            await new Promise(r => setTimeout(r, 2100))
            try { bot.deactivateItem() } catch (e2) {}
          } else throw e
        }
        lease.renew()
        try { if (prevHeld && prevHeld.type !== food.type) await bot.equip(prevHeld, 'hand') } catch (e) {}
      } catch (e) {
        if (update) update.cancel()
        throw e
      } finally { endHand(lease) }
      const { confirmed, changed, countBefore, countNow } = await update
      if (!changed) {
        const foodText = bot.food === before ? `${before}/20 before and after` : `${before}/20 before and ${bot.food}/20 after`
        return err(res, Object.assign(new Error(`no meal seen within ${FOOD_UPDATE_MS} ms: ${food.name} ${countBefore} before and ${countNow} after, food ${foodText}. The pockets may show items the server does not hold.`), { reason: 'no_meal' }))
      }
      ok(res, { ate: food.name, foodBefore: before, foodNow: bot.food, ...(confirmed ? {} : { unconfirmed: `no food update from the server within ${FOOD_UPDATE_MS} ms, foodNow may predate the meal` }) })
    } catch (e) { err(res, e) }
  })

  // dig a specific block by coordinate (no-op if already air)
  app.get('/digat', async (req, res) => {
    let lease = null
    let claim = null
    const takenOver = () => new Error(`${claim.takenBy} took over ${claim.what}, nothing dug`)
    const ownClaim = () => { if (claim.takenBy) throw takenOver() }
    // A takeover stops the walk in progress.
    const walk = async (work) => {
      claim.stop = stopPath
      try { await work() } finally { claim.stop = null }
      ownClaim()
    }
    try {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      const silk = req.query.silk === '1'
      const noSilk = silk && silkRefusal(null)
      if (noSilk) return err(res, new Error(noSilk))
      const Vec3 = require('vec3').Vec3
      const p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
      if (!cellKnown(p) && !bodyTouches(p)) return err(res, outOfSight())
      // A second dig, walk or hand lease would cut this one short.
      claim = claimDig(`digat ${cellText(p)}`)
      // only WALK if out of arm's reach — a deliberately positioned pilot digs from where they stand
      // (the old unconditional goto failed on ore embedded in rock with no walkable cell within 3)
      const far = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.2
      // A cell only remembered is judged once the walk there ends.
      if (!seenNow(p) && far()) await walk(() => bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3)))
      if (!seenNow(p)) return err(res, outOfSight())
      const b = bot.blockAt(p)
      if (!b || /^(cave_|void_)?air$/.test(b.name)) return ok(res, { already: 'air', at: round(p) })
      claim.what = `digat ${b.name} at ${cellText(p)}`
      const silkBlock = silk && silkRefusal(b)
      if (silkBlock) return err(res, new Error(silkBlock))
      if (far()) await walk(() => bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3)))
      await walk(() => stepOffDig(p, b.name, true))
      refuseWhileFighting()
      lease = holdHand()
      // holdDigTool swallows a failed equip.
      await holdDigTool(b, { silk })
      ownClaim()
      const needTier = neededPickTier(b.name)
      const heldTier = bot.heldItem ? PICK_TIER[bot.heldItem.name] : undefined
      if (needTier > 0 && (heldTier === undefined || heldTier < needTier)) {
        return err(res, new Error(`refusing to dig ${b.name} holding ${bot.heldItem ? bot.heldItem.name : 'nothing'} — drop would be destroyed (need pick tier ${needTier})`))
      }
      const unheld = await holdHarvester(b, { silk })
      ownClaim()
      if (unheld) return err(res, new Error(unheld))
      // A body already in p is buried there, whatever falls in after the dig.
      const fall = req.query.anyway !== '1' && fallOnBody(fallsFrom(p))
      if (fall && !(entityInCell(p, [bot.entity]) && suffocates(b))) return err(res, new Error(burialRefusal(b, fall)))
      // Slow equips can use up the 2 s lease before the dig's look and start.
      if (!lease.renew(Math.min(bot.digTime(b) + 500, 30000))) return err(res, new Error('lost the hand during the equip, nothing dug, retry'))
      // mineflayer resolves the dig on its own air write, before the server confirms.
      const held = bot.heldItem
      const lastUse = !!held && held.maxDurability > 0 && (held.durabilityUsed || 0) >= held.maxDurability
      // The 1.7.10 confirm wait needs no hand.
      let seen = null
      if (LEGACY_1710) seen = await legacyDig(b, held, { last: lastUse, after: () => endHand(lease) })
      else { await bot.dig(b); endHand(lease) }
      if (seen && seen.resent && !seen.block) return err(res, new Error(`the server resent the ${b.name} at ${p.x},${p.y},${p.z} and had not broken it after ${seen.ms} ms`))
      // ?then=blockat (bones_ham, 07-21): act+verify in one trip — what does the cell hold
      // now? (air = clean dig; anything else = sand/gravel fell in, water flowed, etc.)
      const verify = (req.query.then === 'blockat')
        ? (() => { const nb = bot.blockAt(p); return { name: nb ? nb.name : '?', at: round(p) } })()
        : undefined
      if (!LEGACY_1710) return ok(res, { dug: b.name, at: round(p), with: bot.heldItem ? bot.heldItem.name : null, verify })
      const now = seen.block && !/^(cave_|void_)?air$/.test(seen.block.name) ? { now: seen.block.name } : {}
      const broke = seen.slot && !seen.item ? { toolBroke: true } : {}
      const unconfirmed = seen.block ? {} : { unconfirmed: `no block update from the server within ${LEGACY_DIG_CONFIRM_MS} ms` }
      ok(res, { dug: b.name, at: round(p), with: held ? held.name : null, ...now, ...broke, ...unconfirmed, verify })
    } catch (e) {
      // A takeover can abort this dig or its walk.
      err(res, claim && claim.takenBy ? takenOver() : e)
    } finally {
      endHand(lease)
      releaseDig(claim)
    }
  })

  app.get('/placeitem', async (req, res) => {
    let lease = null
    try {
      const Vec3 = require('vec3').Vec3
      const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
      const name = req.query.name
      const it = bot.inventory.items().find(i => i.name === name)
      if (!it) return err(res, new Error(`no ${name} in inventory`))
      const known = (p) => cellKnown(p) || bodyTouches(p)
      if (!known(new Vec3(x, y, z))) return err(res, outOfSight())
      const taken = occupant(new Vec3(x, y, z))
      if (taken) return err(res, new Error(`cell occupied by ${taken}`))
      const faceDir = (req.query.face || '').toUpperCase()
      const aim = faceDir ? { N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0] }[faceDir] : null
      if (faceDir && !aim) return err(res, new Error('face must be N, S, E or W'))
      // ref: prefer the block below (top-face place); else chain sideways off any solid
      // neighbor — courses in mid-air (roof stairs, ridge lines) grow E/W from the gable
      // ends with nothing underneath them. An interactive neighbour serves only when nothing else does.
      let sides = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      // A 1.7.10 ladder hangs on the wall whose side is clicked, whatever the look.
      const ladder = LEGACY_1710 && name === 'ladder'
      const frame = itemFrame(name)
      const wanted = (ladder || frame) && faceDir ? { N: 'north', S: 'south', E: 'east', W: 'west' }[faceDir] : null
      // A 1.7.10 server refuses a frame clicked on a top face.
      const frameOnWall = frame && (!!wanted || LEGACY_1710)
      if (ladder) {
        const below = seenNow(new Vec3(x, y - 1, z)) && bot.blockAt(new Vec3(x, y - 1, z))
        const shaft = below && below.name === 'ladder' ? BEHIND[below.getProperties().facing] : null
        const order = wanted ? [wanted] : [...(shaft ? [shaft] : []), ...Object.keys(HANGS)]
        sides = order.map(w => [HANGS[w][0], 0, HANGS[w][1]])
      }
      if (frameOnWall) sides = (wanted ? [wanted] : Object.keys(HANGS)).map(w => [HANGS[w][0], 0, HANGS[w][1]])
      // The frame the body perceives on face f of the cell. objectData indexes down, up, north, south, west, east.
      const hangsOn = (f) => {
        const side = f.y ? (f.y < 0 ? 0 : 1) : f.z ? (f.z < 0 ? 2 : 3) : (f.x < 0 ? 4 : 5)
        return liveEntities().find(en => itemFrame(en.name) && en.objectData === side && en.position.floored().equals(new Vec3(x, y, z)) && targetSeen(en))
      }
      let ref = null
      let faceVec = null
      let interactive = null
      let framedWall = null
      for (const [dx, dy, dz] of sides) {
        const np = new Vec3(x + dx, y + dy, z + dz)
        const nb = seenNow(np) && bot.blockAt(np)
        if (!nb || nb.boundingBox !== 'block' || isSoftCover(nb)) continue
        if (frameOnWall && hangsOn(new Vec3(-dx, -dy, -dz))) { framedWall = framedWall || [nb, new Vec3(-dx, -dy, -dz)]; continue }
        if (!isInteractive(nb)) { ref = nb; faceVec = new Vec3(-dx, -dy, -dz); break }
        interactive = interactive || [nb, new Vec3(-dx, -dy, -dz)]
      }
      if (!ref && interactive) [ref, faceVec] = interactive
      // Every wall holds a frame, and the check after the look refuses.
      if (!ref && framedWall) [ref, faceVec] = framedWall
      if (!ref && ladder) return err(res, new Error(wanted ? `no solid wall ${wanted} of the cell for a ladder` : 'a ladder needs a solid wall beside the cell'))
      if (!ref && frameOnWall) return err(res, new Error(wanted ? `no solid wall ${wanted} of the cell for a frame` : 'a frame needs a solid wall beside the cell'))
      if (!ref) return err(res, new Error('nothing solid I can see below or beside the target to place against'))
      await reachToPlace(new Vec3(x, y, z))
      const takenThere = occupant(new Vec3(x, y, z))
      if (takenThere) return err(res, new Error(`cell occupied by ${takenThere}`))
      await clearSoftCover(new Vec3(x, y, z))
      refuseWhileFighting()
      lease = holdHand()
      await bot.equip(it, 'hand')
      lease.renew()
      // face= (07-14): deliberate orientation for stairs & other facing blocks. The server derives
      // `facing` from the placer's yaw at click time (high side follows the gaze), so face=N means
      // "steps ascend toward north." We aim the body at a far compass point, then click with
      // forceLook:'ignore' so _genericPlace doesn't re-aim at the reference face and clobber it.
      let FD = ladder || frame ? null : aim
      // A door or gate in a fence or wall line looks across the line from the body's side.
      const axis = /(_door|_fence_gate)$/.test(name) ? passageAxis(new Vec3(x, y, z)) : null
      const feet = bot.entity.position
      if (!FD && axis) FD = axis === 'x' ? [feet.x < x + 0.5 ? 16 : -16, 0] : [0, feet.z < z + 0.5 ? 16 : -16]
      let frameFacing = null
      if (FD) {
        await bot.lookAt(new Vec3(x + 0.5 + FD[0], bot.entity.position.y + 1.6, z + 0.5 + FD[1]), true)
        await bot.waitForTicks(2)  // rotation PACKET goes out on the next physics tick — click too
                                   // fast and the server orients the stair by the stale rotation
                                   // (calibration row proved it: each stair wore the PREVIOUS aim)
        handKept(it)
        stampOwnEdit({ x, y, z })  // _placeBlockWithOptions bypasses the wrapped bot.placeBlock, stamp by hand
        await sneakPlace(ref, () => bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore', half: 'bottom' }))
      } else if (frame) {
        // hangFrame counts only a frame that spawns after this look.
        await bot.lookAt(ref.position.offset(0.5 + faceVec.x * 0.5, 0.5 + faceVec.y * 0.5, 0.5 + faceVec.z * 0.5), true)
        await bot.waitForTicks(2)
        const held = hangsOn(faceVec)
        // The 1.7.10 server hangs a second frame on a face that holds one.
        if (held) return err(res, new Error(`the ${held.name} at ${cellText(held.position.floored())} already hangs on that face`))
        handKept(it)
        stampOwnEdit({ x, y, z })
        frameFacing = await sneakPlace(ref, () => hangFrame(ref, faceVec, new Vec3(x, y, z), name))
      } else {
        await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
        handKept(it)
        try {
          await sneakPlace(ref, () => bot.placeBlock(ref, faceVec))
        } catch (e) {
          // placeBlock times out on a ladder the server refuses.
          if (!ladder || !/did not fire within timeout/.test(e.message)) throw e
          const side = faceVec.x ? (faceVec.x < 0 ? 'east' : 'west') : (faceVec.z < 0 ? 'south' : 'north')
          throw new Error(`the server refused the ladder on the ${side} wall`)
        }
      }
      // The facing the server set, with the wanted axis when it is off.
      let facing
      const placedBlock = (axis || ladder) && bot.blockAt(new Vec3(x, y, z))
      const got = placedBlock && /(_door|_fence_gate)$/.test(placedBlock.name) ? placedBlock.getProperties().facing : null
      if (got) facing = /^(east|west)$/.test(got) === (axis === 'x') ? got : `${got}, wanted ${axis === 'x' ? 'east-west' : 'north-south'}`
      const hung = ladder && placedBlock && placedBlock.name === 'ladder' ? placedBlock.getProperties().facing : null
      if (hung) facing = hung
      if (frameFacing) facing = frameFacing
      // The wall the server hung a ladder or frame on, with the wanted one when it is off.
      const back = (hung || frameFacing) && BEHIND[hung || frameFacing]
      const wall = back ? (!wanted || back === wanted ? back : `${back}, wanted ${wanted}`) : undefined
      // ?then=blockat (bones_ham, 07-21): fold act+verify into one trip. Scoped fairness —
      // you may always verify the one cell you just acted on (you clicked its neighbor with
      // line of sight); this also cures the close-range /blockat blindness for self-checks.
      const verify = (req.query.then === 'blockat')
        ? (() => { const b = frame ? { name } : bot.blockAt(new Vec3(x, y, z)); return { name: b ? b.name : '?', at: { x, y, z } } })()
        : undefined
      ok(res, { placed: name, at: { x, y, z }, face: faceDir || undefined, facing, wall, verify })
    } catch (e) {
      // then=blockat turns the notorious blockUpdate FALSE-FAIL (the block stands, the
      // event never fired) into an honest answer: the error AND what the cell holds now.
      if (req.query.then === 'blockat' && /blockUpdate|refused the ladder/i.test(String(e && e.message))) {
        try {
          const Vec3 = require('vec3').Vec3
          const vx = Math.floor(parseFloat(req.query.x)), vy = Math.floor(parseFloat(req.query.y)), vz = Math.floor(parseFloat(req.query.z))
          const b = bot.blockAt(new Vec3(vx, vy, vz))
          return send(res, { ok: false, error: e.message, verify: { name: b ? b.name : '?', at: { x: vx, y: vy, z: vz } } })
        } catch (e2) {}
      }
      err(res, e)
    } finally { endHand(lease) }
  })

  // /sign?x=&y=&z=&text=&face=&wall=&item= — place a sign and WRITE it, one motion (07-17, the attic
  // library: a shared world deserves labels). `text` is URL-encoded; `|` splits lines (max 4,
  // ~15 chars each). Top-face place = standing sign (face= aims it like stairs); a sideways-only
  // reference makes a wall sign naturally, and wall= hangs one on that neighbour, as face= does for
  // a ladder. A just-placed sign is editable exactly once — write immediately or hold your peace.
  app.get('/sign', async (req, res) => {
    let lease = null
    try {
      const Vec3 = require('vec3').Vec3
      const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
      const text = (req.query.text || '').replace(/\|/g, '\n')
      const itName = req.query.item || 'oak_sign'
      const faceDir = (req.query.face || '').toUpperCase()
      const FD = faceDir && { N: [0, -16], S: [0, 16], E: [16, 0], W: [-16, 0] }[faceDir]
      if (faceDir && !FD) return err(res, new Error('face must be N, S, E or W'))
      const wallDir = (req.query.wall || '').toUpperCase()
      const wanted = wallDir ? { N: 'north', S: 'south', E: 'east', W: 'west' }[wallDir] : null
      if (wallDir && !wanted) return err(res, new Error('wall must be N, S, E or W'))
      if (faceDir && wanted) return err(res, new Error('face aims a standing sign, wall hangs one: pass one'))
      const it = bot.inventory.items().find(i => i.name === itName)
      if (!it) return err(res, new Error(`no ${itName} in inventory`))
      const known = (p) => cellKnown(p) || bodyTouches(p)
      if (!known(new Vec3(x, y, z))) return err(res, outOfSight())
      const taken = occupant(new Vec3(x, y, z))
      if (taken) return err(res, new Error(`cell occupied by ${taken}`))
      // A wanted wall is the only neighbour tried, else the floor and then each wall in HANGS order.
      const sides = (wanted ? [wanted] : Object.keys(HANGS)).map(w => [HANGS[w][0], 0, HANGS[w][1]])
      let ref = null
      let faceVec = null
      for (const [dx, dy, dz] of wanted ? sides : [[0, -1, 0], ...sides]) {
        const np = new Vec3(x + dx, y + dy, z + dz)
        const nb = seenNow(np) && bot.blockAt(np)
        if (nb && nb.boundingBox === 'block' && !isSoftCover(nb)) { ref = nb; faceVec = new Vec3(-dx, -dy, -dz); break }
      }
      if (!ref) return err(res, new Error(wanted ? `no solid wall ${wanted} of the cell for a sign` : 'nothing solid I can see below or beside the target to place against'))
      await reachToPlace(new Vec3(x, y, z))
      const takenThere = occupant(new Vec3(x, y, z))
      if (takenThere) return err(res, new Error(`cell occupied by ${takenThere}`))
      await clearSoftCover(new Vec3(x, y, z))
      refuseWhileFighting()
      lease = holdHand()
      await bot.equip(it, 'hand')
      lease.renew()
      // SNEAK while placing: the natural home of a label is ON a chest lid, and a bare click on
      // an interactable reference OPENS it instead of placing (the first /sign ever attempted
      // proved this on its own museum). Sneak-place works against everything; always sneak.
      bot.setControlState('sneak', true)
      try {
        if (FD) {
          // a standing sign FACES the placer, so aim OPPOSITE the wanted face before clicking
          await bot.lookAt(new Vec3(x + 0.5 - FD[0], bot.entity.position.y + 1.6, z + 0.5 - FD[1]), true)
          await bot.waitForTicks(2)
          handKept(it)
          stampOwnEdit({ x, y, z })
          await bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore' })
        } else {
          await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
          handKept(it)
          // The sign check below decides whether the sign landed, not placeBlock's 5 s timeout.
          try { await bot.placeBlock(ref, faceVec) }
          catch (e) { if (!/did not fire within timeout/.test(e.message)) throw e }
        }
      } finally { bot.setControlState('sneak', false) }
      await bot.waitForTicks(3)
      const sb = bot.blockAt(new Vec3(x, y, z))
      if (!sb || !sb.name.includes('sign')) return err(res, new Error(`placed, but found ${sb ? sb.name : 'nothing'} at the target — sign lost?`))
      await bot.updateSign(sb, text)
      const hung = /_wall_sign$/.test(sb.name) ? sb.getProperties().facing : null
      // The wall the server hung the sign on, with the wanted one when it is off.
      const wall = hung ? (!wanted || BEHIND[hung] === wanted ? BEHIND[hung] : `${BEHIND[hung]}, wanted ${wanted}`) : wanted ? `none, wanted ${wanted}` : undefined
      ok(res, { placed: itName, at: { x, y, z }, face: faceDir || undefined, wall, facing: hung || undefined, wrote: text.split('\n') })
    } catch (e) { err(res, e) } finally { endHand(lease) }
  })

  // GET /gather?resource=&amount=&radius= : background job that repeatedly finds the
  // nearest matching block and mines it. GUARDRAILS: capped radius (default 40, hard-max
  // 64); never dig straight down (skip any target >~2 below feet, prefer at/above feet or
  // side-reachable); skip candidates pathfinder can't reach and try the next nearest;
  // stop when 'amount' collected or no reachable target remains.
  app.get('/gather', (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const resource = req.query.resource
      if (!resource) return err(res, new Error('resource required'))
      const amount = Math.max(1, parseInt(req.query.amount || '16'))
      let radius = parseInt(req.query.radius || '40')
      if (!Number.isFinite(radius) || radius <= 0) radius = 40
      radius = Math.min(radius, 64)                 // hard-max 64
      const silk = req.query.silk === '1'
      const noSilk = silk && silkRefusal(null)
      if (noSilk) return err(res, new Error(noSilk))
      const ids = resolveBlockIds(resource)
      if (!ids.length) return err(res, new Error(`unknown block: ${resource}`))
      digBusy()

      const { id } = jobs.start(`gather ${resource} x${amount}`, async (job) => {
        // A dig whose drop never reaches the pockets counts nothing.
        const items = gatherItems(ids)
        const pocketed = () => bot.inventory.items().reduce((s, it) => s + (items.has(it.name) ? it.count : 0), 0)
        const before = pocketed()
        let gathered = 0
        let dug = 0
        let stop = null
        const tried = new Set()                     // positions we've given up on
        // Tried positions refused for silk touch.
        const silkRefused = new Set()
        let lastSilkRefusal = null
        const key = (p) => `${p.x},${p.y},${p.z}`
        // A block under water drowns the body during the dig and the chase after its drop.
        const underWater = (p) => seenNow(p.offset(0, 1, 0), radius) && holdsWater(bot.blockAt(p.offset(0, 1, 0)))
        const startT = Date.now()
        let iters = 0
        let noProgress = 0                          // consecutive iterations with no mine (circuit breaker)
        // FORESTRY: harvesting wood → walk like a lumberjack (clear leaves+logs to travel) and
        // reach the whole trunk, not just the bottom few. Restored to considerate nav in finally.
        const isWood = ids.some(i => { const n = shared.mcData.blocks[i] && shared.mcData.blocks[i].name; return !!n && (n.endsWith('_log') || n.endsWith('_wood')) })
        const maxRise = isWood ? 24 : GATHER_MAX_RISE
        const usingForestry = isWood && !!shared.forestryMoves
        // forestry pathfinding is heavier (canDig opens dig-moves at every node), so a truly
        // awkward floating log can eat the full 10s think budget before we skip it. Fail fast:
        // drop the think budget while gathering wood so unreachable targets are abandoned quickly.
        const forestry = {}
        if (usingForestry) { shared.forestryOwner = forestry; bot.pathfinder.setMovements(shared.forestryMoves); bot.pathfinder.thinkTimeout = 3000; job.progress('forestry nav: may clear leaves+logs') }
        try {
        while (gathered < amount) {
          if (job.cancelled) { stop = 'cancelled'; job.progress(stop); break }
          if (++iters > amount * 8 + 40 || Date.now() - startT > 180000) { stop = 'watchdog: stopping (iter/time bound)'; job.progress(stop); break }
          const feetY = Math.floor(bot.entity.position.y)
          // pull a batch so we can pick a SAFE candidate (not the raw nearest)
          const cands = bot.findBlocks({ matching: ids, maxDistance: radius, count: 40 })
          const here = bot.entity.position
          const visible = cands
            .filter(p => !tried.has(key(p)))
            .map(p => ({ p, dist: here.distanceTo(p), drop: feetY - p.y }))
            // GUARDRAIL: never dig straight down. Refuse anything more than ~2 below feet
            // (a shaft); keep only targets at/above feet or reachable from the side.
            .filter(o => o.drop <= GATHER_MAX_DROP && o.drop >= -maxRise)
            .filter(o => seesLit(o.p, radius))         // FAIRNESS: only what a player here could see
          const wet = visible.filter(({ p }) => underWater(p)).length
          const ranked = visible.filter(({ p }) => !underWater(p)).sort((a, b) => a.dist - b.dist)
          if (!ranked.length) {
            stop = lastSilkRefusal && [...tried].every((k) => silkRefused.has(k)) ? lastSilkRefusal
              : wet ? `no ${resource} among the nearest I see that I can dig without diving, ${wet} seen under water (gathered ${gathered}/${amount})`
                : `no reachable ${resource} left (gathered ${gathered}/${amount})`
            job.progress(stop)
            break
          }
          let progressed = false
          for (const { p } of ranked) {
            const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
            if (!b || !ids.includes(b.type)) { tried.add(key(p)); continue }
            const noSilk = silk && silkRefusal(b)
            if (noSilk) {
              tried.add(key(p))
              silkRefused.add(key(p))
              lastSilkRefusal = noSilk
              job.progress(`skip @ ${p.x},${p.y},${p.z}: ${noSilk}`)
              if (silkRefusal(null)) { stop = noSilk; break }
              continue
            }
            const openTop = [1, 2].every((dy) => bot.blockAt(b.position.offset(0, dy, 0))?.boundingBox === 'empty')
            const goal = openTop ? collectWalkGoal(b.position) : new goals.GoalNear(p.x, p.y, p.z, 2)
            const reaches = goal.isEnd.bind(goal)
            const sees = new goals.GoalLookAtBlock(b.position, bot.world)
            // End only where collectblock's own walk would stop, with the head out of water.
            goal.isEnd = (node) => reaches(node) && sees.isEnd(node) && !holdsWater(bot.blockAt(node.offset(0, 1, 0)))
            try {
              // approach from a reachable spot, then collect (dig into a face, not a shaft)
              await stepOffDig(b.position, b.name)
              await watchedWork(() => bot.pathfinder.goto(goal), stopPath)
            } catch (e) {
              // A failed goto leaves the pathfinder walking its partial path.
              if (bot.pathfinder.goal === goal) stopPath()
              // GUARDRAIL: unreachable candidate -> skip, try next nearest, don't flail
              tried.add(key(p))
              job.progress(`skip unreachable @ ${p.x},${p.y},${p.z}: ${e.message}`)
              continue
            }
            // An empty path resolves the walk wherever the body stands, from the floored cell or the planner's start node.
            if (!goal.isEnd(bot.entity.position.floored()) && !goal.isEnd(walkStart())) {
              // The empty path leaves the goal set.
              if (bot.pathfinder.goal === goal) stopPath()
              tried.add(key(p))
              job.progress(`skip @ ${p.x},${p.y},${p.z}: the walk ended out of reach of it (spots with my head under water don't count)`)
              continue
            }
            try {
              await stepOffDig(b.position, b.name)
              await collectSafely(b, job.name, { wait: true, silk })
              dug++
              // The slot update of a pickup can land a few ticks after the drop is gone.
              for (let i = 0; i < 10 && pocketed() - before <= gathered; i++) await bot.waitForTicks(1)
              const now = pocketed() - before
              progressed = now > gathered
              gathered = now
              job.progress(progressed ? `gathered ${resource} ${gathered}/${amount} @ ${p.x},${p.y},${p.z}` : `dug ${resource} @ ${p.x},${p.y},${p.z}, nothing picked up`)
            } catch (e) {
              tried.add(key(p))
              job.progress(`dig failed @ ${p.x},${p.y},${p.z}: ${e.message}`)
              if (e.name === 'NoSilk') {
                silkRefused.add(key(p))
                lastSilkRefusal = e.message
                if (silkRefusal(null)) stop = e.message
              }
            }
            break                                   // re-scan from the new position each mine
          }
          if (stop) break
          // CIRCUIT BREAKER: one iteration tries every visible candidate, so an iteration with
          // no mine means nothing is reachable from here right now. A few of those in a row = this
          // spot is tapped out (or a target keeps timing out) → stop cleanly and let the driver
          // reposition, instead of grinding the same unreachable logs.
          if (progressed) noProgress = 0
          else if (++noProgress >= 3) {
            stop = `spot tapped out — no reachable ${resource} in ${noProgress} passes (gathered ${gathered}/${amount})`
            job.progress(stop)
            break
          }
        }
        const have = pocketed()
        emitEvent('gather', `${gathered > 0 ? 'done' : 'failed'} ${resource} gathered=${gathered}`, { inventoryMatching: have })
        const result = { gathered, dug, requested: amount, inventoryMatching: have }
        if (gathered <= 0) Object.assign(result, { ok: false, reason: dug ? `dug ${dug} ${resource}, nothing reached the pockets` : stop })
        else if (gathered < amount) result.reason = stop
        return result
        } finally {
          // A replaced gather's finally runs after its successor set up forestry.
          if (usingForestry && shared.forestryOwner === forestry) {
            shared.forestryOwner = null
            if (shared.considerateMoves) { bot.pathfinder.setMovements(shared.considerateMoves); bot.pathfinder.thinkTimeout = shared.thinkTimeout }
          }
        }
      })
      ok(res, { job: id })
    } catch (e) { err(res, e) }
  })

  // GET /dig_tunnel?dir=&length=&torch=&anyway= : a 1x2 corridor dug ahead block by block, taking wall ore its pick harvests, stopping at lava or water in sight or laid bare, bedrock, a floor gap, a full inventory, a block its pick cannot harvest or a block still falling into the way FALL_TICKS ticks after the digs.
  // Without anyway it also stops at gravel or sand in sight over the head cell ahead, set falling by a dig or fallen into the way. With anyway it digs out what falls in, up to 8 times a step.
  app.get('/dig_tunnel', async (req, res) => {
    try {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      digBusy()
      const Vec3 = require('vec3').Vec3
      const dirParam = (req.query.dir || '').toLowerCase()
      const [dx, dz] = cardinal(dirParam, bot.entity.yaw)
      const length = Math.min(Math.max(1, parseInt(req.query.length || '12')), 64)
      const torchEvery = req.query.torch != null ? parseInt(req.query.torch) : 5   // 0 disables torches
      const perp = dx !== 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]]                 // wall offsets across the travel axis
      const dirName = cardinalName(dirParam, bot.entity.yaw)
      const anyway = req.query.anyway === '1'

      const { id } = jobs.start(`dig_tunnel ${dirName} x${length}`, async (job) => {
        let dug = 0, stop = null
        const found = {}
        const skipped = {}
        const note = (n, p) => { found[n] = (found[n] || 0) + 1; emitEvent('mine', `struck ${n} @ ${p.x},${p.y},${p.z}`) }
        const skip = (n, why) => { skipped[n] = (skipped[n] || 0) + 1; emitEvent('mine', `left ${why}`) }
        const isHazard = (b) => b && (b.name.includes('lava') || b.name.includes('water'))
        const pick = digPick()
        const breach = breachWatch()

        for (let step = 0; step < length && !stop; step++) {
          if (job.cancelled) { stop = 'cancelled'; break }
          const base = bot.entity.position.floored()
          const ahead = base.offset(dx, 0, dz), aheadHead = ahead.offset(0, 1, 0), aheadFloor = ahead.offset(0, -1, 0)
          const corridor = [base, base.offset(0, 1, 0), ahead, aheadHead, aheadFloor]
          for (const p of corridor) breach.own.add(cellText(p))
          if (step === 0) breachFrom(corridor, breach)
          const cap = aheadHead.offset(0, 1, 0)
          // Lava or water seen now that digging ahead would lay bare.
          for (const p of [ahead.offset(dx, 0, dz), aheadHead.offset(dx, 0, dz), aheadFloor, cap]) {
            const hb = bot.blockAt(p); if (isHazard(hb) && seenNow(p)) { stop = `${hb.name} ahead — stopping short of it`; break }
          }
          // Gravel or sand seen now that would fall into the dug head cell.
          const cb = bot.blockAt(cap)
          if (!stop && !anyway && cb && seenNow(cap) && /^(gravel|sand|red_sand)$/.test(cb.name)) stop = `${cb.name} overhead, stopping (would bury me), anyway digs through`
          if (stop) break
          stop = await pick.equip()
          if (stop) break
          const opened = new Set()
          for (const p of [aheadHead, ahead]) {                 // dig head then feet
            const b = bot.blockAt(p)
            if (!b) continue
            if (/^(cave_|void_)?air$/.test(b.name)) { breach.pending.push(p); continue }
            if (b.name === 'bedrock') { stop = 'hit bedrock'; break }
            if (job.cancelled) { stop = 'cancelled'; break }
            stop = (await pick.equip(b)) || pick.short(b)
            if (stop) break
            try { stop = await pick.dig(b) } catch (e) { stop = digFailed(e); break }
            if (stop) break
            if (b.name.includes('ore')) note(b.name, p)
            dug++; breach.pending.push(p); opened.add(cellText(p))
            stop = await struckHazard(p, anyway ? null : base.offset(-dx, 0, -dz), false, job)
            if (stop) break
          }
          const stalled = () => `cannot advance: ${fellText([ahead, aheadHead], 'nudge stalled')}`
          if (!stop) stop = await digFallen([aheadHead, ahead], opened, pick, job, () => { dug++ }, !anyway && stalled)
          if (stop) break
          const fb = bot.blockAt(aheadFloor)                    // keep a solid floor so we don't fall / breach a drop
          if (!fb || fb.boundingBox !== 'block') {
            const why = await fillFrom(aheadFloor)
            if (why) { stop = `gap in floor, ${why}`; break }
            await pick.equip()
          }
          // A block can start falling into the way after the digs.
          stop = await fallsLanded([aheadHead, ahead], opened)
          if (stop) break
          if (!(await nudgeInto(ahead, false))) { stop = stalled(); break }
          reportBreach(breach)                                  // the step gives the server time to resend a refused dig
          const here = bot.entity.position.floored()            // grab ore now exposed in the corridor walls (adjacent, fair)
          for (const [ox, oz] of perp) for (const oy of [0, 1]) {
            const wp = here.offset(ox, oy, oz)
            const wb = bot.blockAt(wp)
            if (stop || !wb || !wb.name.includes('ore')) continue
            if (job.cancelled) { stop = 'cancelled'; break }
            breach.own.add(cellText(wp))
            stop = await pick.equip(wb)
            if (stop) break
            const low = pick.short(wb)
            if (low) { skip(wb.name, low); continue }
            // A dig that threw left the ore in place.
            try { stop = await pick.dig(wb) } catch (e) {
              stop = job.cancelled ? 'cancelled' : busyText()
              if (stop) break
              continue
            }
            if (stop) break
            note(wb.name, wp)
            dug++; breach.pending.push(wp)
            stop = await struckHazard(wp)
          }
          if (stop) break
          if (torchEvery > 0 && step % torchEvery === 0) { await macroPlaceAt(here.x - dx, here.y, here.z - dz, ['torch'], false); await pick.equip() }
          if (bot.inventory.emptySlotCount() === 0) { stop = 'inventory full'; break }
          job.progress(`step ${step + 1}/${length}, dug ${dug}, ores ${JSON.stringify(found)}`)
        }
        reportBreach(breach)
        const stopped = stop || 'length reached'
        const left = Object.keys(skipped).length ? `, skipped=${JSON.stringify(skipped)}` : ''
        emitEvent('mine', `tunnel done: dug ${dug}, stopped=${stopped}, ores=${JSON.stringify(found)}${left}`)
        return { dug, stopped, found, skipped }
      })
      ok(res, { job: id })
    } catch (e) { err(res, e) }
  })

  // GET /dig_stair?dir=&up=&steps=&torch=&anyway= : mine an ASCENDING (up=1, default) or descending (up=-1)
  // staircase — the fair way to climb out of a deep cave without swimming a water elevator. Each
  // step digs the 2-high (3 for headroom going up) passage at the next diagonal position and steps
  // onto it. STOPS on water/lava it sees or a dig lays bare, or a block still falling into the passage
  // FALL_TICKS ticks after the digs, or a block that fell onto the body going up. Without anyway it also stops on gravel/sand it sees in or over the passage,
  // a dig sets falling or that fell in. With anyway it digs out what falls in, up to 8 times a step.
  // Places a tread from andesite/cobble/dirt if the step is missing, torches the climb.
  app.get('/dig_stair', async (req, res) => {
    try {
      if (bunker.building) return err(res, new Error(BUNKER_WALK))
      digBusy()
      const Vec3 = require('vec3').Vec3
      const dirParam = (req.query.dir || '').toLowerCase()
      const [dx, dz] = cardinal(dirParam, bot.entity.yaw)
      const up = parseInt(req.query.up || '1') >= 1 ? 1 : -1  // up=0 means DOWN (a pilot burned a staircase on `0 >= 0`)
      const steps = Math.min(Math.max(1, parseInt(req.query.steps || '24')), 24)
      const torchEvery = req.query.torch != null ? parseInt(req.query.torch) : 4
      const dirName = cardinalName(dirParam, bot.entity.yaw)
      const anyway = req.query.anyway === '1'

      const { id } = jobs.start(`dig_stair ${up > 0 ? 'up' : 'down'} ${dirName} x${steps}`, async (job) => {
        let dug = 0, stop = null, climbed = 0
        const isHazard = (b) => b && (b.name.includes('lava') || b.name.includes('water'))
        const fally = (b) => b && (b.name === 'gravel' || b.name === 'sand' || b.name === 'red_sand')
        const pick = digPick()
        const breach = breachWatch()
        // (per-step movement uses the shared module-scope nudgeInto — see above the /dig_tunnel route)
        for (let s = 0; s < steps && !stop; s++) {
          if (job.cancelled) { stop = 'cancelled'; break }
          const b0 = bot.entity.position.floored()
          const nx = b0.x + dx, nz = b0.z + dz, ny = b0.y + up
          const tread = new Vec3(nx, ny - 1, nz), feet = new Vec3(nx, ny, nz), head = new Vec3(nx, ny + 1, nz), above = new Vec3(nx, ny + 2, nz)
          // ASCENDING needs LAUNCH clearance too: the climb-nudge jumps from the CURRENT cell, so the
          // block above my own head must be open or the jump hits it and the nudge stalls (the 07-11
          // "cannot climb: nudge stalled under a low ceiling" bug).
          const launch = up > 0 ? [new Vec3(b0.x, b0.y + 2, b0.z)] : []
          const corridor = [b0, b0.offset(0, 1, 0), ...launch, above, head, feet, tread]
          for (const p of corridor) breach.own.add(cellText(p))
          if (s === 0) breachFrom(corridor, breach)
          // Lava, water or fall-blocks seen now that this step would dig or lay bare.
          for (const p of [...launch, ...launch.map((l) => l.offset(0, 1, 0)), feet, head, above, new Vec3(nx + dx, ny, nz + dz), new Vec3(nx + dx, ny + 1, nz + dz)]) {
            const hb = bot.blockAt(p)
            if (!seenNow(p)) continue
            if (isHazard(hb)) { stop = `${hb.name} ahead — stopping short`; break }
            if (fally(hb) && !anyway) { stop = `${hb.name} overhead — stopping (would bury me), anyway digs through`; break }
          }
          if (stop) break
          stop = await pick.equip()
          if (stop) break
          const passage = [...launch, above, head, feet]
          const opened = new Set()
          for (const p of passage) {   // clear the FULL 2-tall passage + head clearance.
            // Descending needs `above` (nx,ny+2) dug too: the bot is 2 blocks tall, so stepping into
            // the next-lower cell its head sweeps through ny+2 — leave that solid and it's walled in
            // at head height and can't move in (the real cause of the old descend stall).
            const bb = bot.blockAt(p)
            if (!bb) continue
            if (/^(cave_|void_)?air$/.test(bb.name)) { breach.pending.push(p); continue }
            if (bb.name === 'bedrock') { stop = 'hit bedrock'; break }
            if (job.cancelled) { stop = 'cancelled'; break }
            stop = (await pick.equip(bb)) || pick.short(bb)
            if (stop) break
            try { stop = await pick.dig(bb) } catch (e) { stop = digFailed(e); break }
            if (stop) break
            dug++; breach.pending.push(p); opened.add(cellText(p))
            // Descending, the step back is a climb.
            stop = await struckHazard(p, anyway ? null : b0.offset(-dx, -up, -dz), up < 0, job)
            if (stop) break
          }
          const stalled = () => (up > 0 ? 'cannot climb' : 'cannot descend') + ': ' + fellText([feet, head, ...launch, above], 'nudge stalled at ' + Math.floor(bot.entity.position.y))
          // Ascending, a fall through the launch cell lands in the body's own cells, which the self-rescue digs out.
          const body = up > 0 ? [b0, b0.offset(0, 1, 0)] : []
          if (!stop) stop = await digFallen(passage, opened, pick, job, () => { dug++ }, !anyway && stalled, body)
          if (stop) break
          const tb = bot.blockAt(tread)                                      // need a tread to stand on
          if (!tb || tb.boundingBox !== 'block') {
            const why = await fillFrom(tread)
            if (why) { stop = `no step to stand on, ${why}`; break }
            await pick.equip()
          }
          // A block can start falling into the way after the digs.
          stop = await fallsLanded(passage, opened, false, body)
          if (stop) break
          if (!(await nudgeInto(feet, up > 0))) { stop = stalled(); break }
          reportBreach(breach)                                  // the step gives the server time to resend a refused dig
          climbed += up
          if (torchEvery > 0 && s % torchEvery === 0) { await macroPlaceAt(b0.x, b0.y, b0.z, ['torch'], false); await pick.equip() }
          if (bot.inventory.emptySlotCount() === 0) { stop = 'inventory full'; break }
          const y = Math.floor(bot.entity.position.y)
          job.progress(`step ${s + 1}/${steps}, y=${y}, dug ${dug}`)
          if (up > 0 && skyInSight()) { stop = 'sky in sight'; break }
        }
        reportBreach(breach)
        const stopped = stop || 'steps done'
        emitEvent('mine', `dig_stair ${up > 0 ? 'up' : 'down'} done: climbed ${climbed}, dug ${dug}, y=${Math.floor(bot.entity.position.y)}, stopped=${stopped}`)
        return { climbed, dug, stopped, endY: Math.floor(bot.entity.position.y) }
      })
      ok(res, { job: id })
    } catch (e) { err(res, e) }
  })

  // GET /toss?name=&count=&to= : drop an item for a player to pick up (hand off tools/loot). Faces
  // the named player first (via ?to=) so the item lands near them, then tosses. count defaults to
  // the whole stack. This is how the bot GIVES — the co-op other half of the helmsman handing me things.
  app.get('/toss', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const name = req.query.name
      if (!name) return err(res, new Error('name required'))
      const toward = req.query.to
      const towardEntity = toward && playerEntity(toward)
      if (towardEntity && playerSighting(towardEntity, reflexes.find(r => r.name === 'combat').fairFill(bot))) {
        try { await bot.lookAt(towardEntity.position.offset(0, 0.4, 0), true) } catch (e) {}
      }
      const items = bot.inventory.items()
      const item = items.find(i => i.name === name) || items.find(i => i.name.includes(name))
      if (!item) return err(res, new Error(`no ${name} in inventory`))
      const n = req.query.count != null ? Math.min(parseInt(req.query.count), item.count) : item.count
      await bot.toss(item.type, null, n)
      ok(res, { tossed: item.name, count: n, toward: toward || null })
    } catch (e) { err(res, e) }
  })

  // /useon?name=<entity>&item=<item> — right-click a creature with a held item: shears on
  // sheep, bucket on cow, saddle on horse. The husbandry verb (07-14, built pen-side with the
  // first flock waiting). Walks into reach if needed; nearest matching entity in sight within 16.
  // An item frame target is the nearest empty one, or the empty one in the at cell.
  app.get('/useon', async (req, res) => {
    const mark = legs.mark()
    let lease = null
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const ename = req.query.name
      const iname = req.query.item
      const cell = frameAt(ename, req.query.at)
      const it = bot.inventory.items().find(i => i.name === iname)
      if (!it) return err(res, new Error(`no ${iname} in inventory`))
      const here = bot.entity.position
      const frames = itemFrame(ename) && nearestFrame(ename, false, cell)
      const target = frames ? frames.frame : nearestSeen(ename, 16)
      if (!target && frames && frames.nearest) {
        const framed = framedItem(frames.nearest).name
        const reason = cell ? `the ${ename} at ${cellText(cell)} holds ${framed}: strike it to take it out` : `every ${ename} in sight holds an item: strike one to take it out`
        return ok(res, { ok: false, used: null, on: ename, at: round(frames.nearest.position.floored()), framed, reason })
      }
      if (!target) return err(res, new Error(cell ? `no ${ename} in sight at ${cellText(cell)}` : `no ${ename} in sight within 16`))
      if (frames && target.objectData == null) return err(res, new Error(`the ${ename} at ${cellText(target.position.floored())} has no known facing, its reach is unknown`))
      if (frames && !inMeleeReach(target, 0.6)) {
        if (!await walkToFrame(ename, target, STRIKE_APPROACH_MS, () => legs.mark() !== mark)) return ok(res, namedStop({ used: null, on: ename, reason: 'stopped' }, mark))
      } else if (!frames && target.position.distanceTo(here) > 3) {
        // A NoPath or Timeout goto leaves the pathfinder walking.
        let stopped = false
        const to = new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2)
        await bot.pathfinder.goto(to).catch((e) => {
          if (legs.mark() !== mark) stopped = true
          else {
            if ((e.name === 'NoPath' || e.name === 'Timeout') && bot.pathfinder.goal === to) stopPath()
            throw e
          }
        })
        if (stopped) return ok(res, namedStop({ used: null, on: ename, reason: 'stopped' }, mark))
      }
      refuseWhileFighting()
      lease = holdHand()
      await bot.equip(it, 'hand')
      lease.renew()
      await bot.lookAt(frames ? meleeAim(target, 0.6) : target.position.offset(0, 0.6, 0), true)
      await bot.waitForTicks(2)
      if (!liveEntities().includes(target) || !targetSeen(target)) return ok(res, { used: null, on: ename, reason: 'lost sight', note: 'lost sight of it' })
      if (frames && !inMeleeReach(target, 0.6)) return err(res, new Error(`the ${ename} at ${cellText(target.position.floored())} stays out of swing reach from here`))
      if (!inMeleeReach(target, 0.6)) return ok(res, { used: null, on: ename, note: 'target left reach' })
      if (!frames) {
        handKept(it, 'used')
        await bot.useOn(target)
        endHand(lease)
        return ok(res, { used: iname, on: ename, at: round(target.position) })
      }
      // The server time the click gives the frame update.
      const frameWaitMs = 500
      // The route has no deadline of its own.
      const wait = await withEntityUpdate(target, frameWaitMs, Date.now() + 5000, async () => {
        handKept(it, 'used')
        const used = await bot.useOn(target)
        endHand(lease)
        return used
      })
      const shown = framedItem(target)
      const framed = shown ? shown.name : null
      const out = { used: iname, on: ename, at: round(target.position.floored()), framed }
      if (wait.by !== 'update') Object.assign(out, { ok: false, reason: `the server sent no frame update within ${waitedText(frameWaitMs, wait)}, the frame shows ${framed || 'nothing'}` })
      else if (framed !== iname) Object.assign(out, { ok: false, reason: framed ? `the frame holds ${framed}` : 'the frame still shows empty' })
      ok(res, out)
    } catch (e) { err(res, e) } finally { endHand(lease) }
  })

  app.get('/chest', async (req, res) => {
    try {
      const { cb, chests } = targetChest(req.query)
      let chest
      try {
        await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
        chest = await bot.openContainer(arrivedStation(cb.position, (b) => b.name.includes('chest'), 'chest'))
      } catch (e) {
        e.message = `cannot open the chest at ${cb.position.x},${cb.position.y},${cb.position.z}: ${e.message}; ${otherChests(cb.position, parseInt(req.query.radius || CHEST_RADIUS))}`
        throw e
      }
      const items = chest.containerItems().map(i => ({ name: i.name, count: i.count }))
      chest.close()
      const list = chests && { chests: chests.map(c => ({ at: round(c.pos), ...(c.pair ? { pair: round(c.pair) } : {}), dist: Math.round(c.dist * 10) / 10 })) }
      ok(res, { at: round(cb.position), items, ...list })
    } catch (e) { err(res, e) }
  })
  // GET /withdraw?name=&count=: name is one item name or up to 8 split by |. Takes count (default the item's stack size) of each from one chest opening.
  app.get('/withdraw', async (req, res) => {
    try {
      const names = chestNames(req.query.name)
      const count = req.query.count != null ? parseInt(req.query.count) : null
      const { cb } = targetChest(req.query)
      refuseWhileFighting()
      await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
      const chest = await bot.openContainer(arrivedStation(cb.position, (b) => b.name.includes('chest'), 'chest'))
      const lease = holdHand()
      const withdrew = [], missing = []
      const turn = stackTurns(chest, 'chest', lease)
      let name
      try {
        for (name of names) {
          const item = chest.containerItems().find(i => i.name === name) || chest.containerItems().find(i => i.name.includes(name))
          if (!item) { missing.push(name); continue }
          const got = { item: item.name, count: 0 }
          await withdrawStacks(chest, item.type, count ?? item.stackSize, turn, (n) => {
            if (!got.count) withdrew.push(got)
            got.count += n
          })
        }
      } catch (e) {
        if (withdrew.length) e.message = `withdrew ${withdrew.map(w => `${w.item} ${w.count}`).join(', ')}; then ${name}: ${e.message}`
        throw e
      } finally {
        chest.close()
        endHand(lease)
      }
      if (!withdrew.length) return err(res, new Error(`no ${names.join('|')} in chest; ${otherChests(cb.position, parseInt(req.query.radius || CHEST_RADIUS))}`))
      ok(res, { withdrew, ...(missing.length ? { missing } : {}) })
    } catch (e) { err(res, e) }
  })
  // GET /deposit?name=&count=: name is one item name or up to 8 split by |. Moves count (default all) of each from one chest opening.
  app.get('/deposit', async (req, res) => {
    try {
      const names = chestNames(req.query.name)
      const want = req.query.count != null ? parseInt(req.query.count) : Infinity
      const { cb } = targetChest(req.query)
      refuseWhileFighting()
      await bot.pathfinder.goto(new goals.GoalNear(cb.position.x, cb.position.y, cb.position.z, 2))
      const chest = await bot.openContainer(arrivedStation(cb.position, (b) => b.name.includes('chest'), 'chest'))
      const lease = holdHand()
      const deposited = [], missing = []
      const turn = stackTurns(chest, 'chest', lease)
      let kind, before, transferring = false
      const held = () => chest.containerItems().filter(i => i.name === kind).reduce((s, i) => s + i.count, 0)
      try {
        for (const name of names) {
          // bot.inventory takes the pockets of an open window only once it closes.
          const items = chest.items()
          const exact = items.filter(it => it.name === name)
          const matches = exact.length ? exact : items.filter(it => it.name.includes(name))
          if (!matches.length) { missing.push(name); continue }
          let remaining = want
          for (kind of new Set(matches.map(it => it.name))) {
            if (remaining <= 0) break
            before = held()
            let count = 0
            for (const it of matches.filter(m => m.name === kind)) {
              if (remaining <= 0) break
              await turn()
              const now = chest.items().find(i => i.slot === it.slot && i.type === it.type)
              if (!now) continue
              const take = Math.min(now.count, remaining)
              transferring = true
              await chest.deposit(it.type, null, take)
              transferring = false
              count += take; remaining -= take
            }
            deposited.push({ item: kind, count, inChestNow: held() })
          }
        }
      } catch (e) {
        const inChest = held()
        const others = otherChests(cb.position, parseInt(req.query.radius || CHEST_RADIUS))
        const prior = deposited.length ? `deposited ${deposited.map(d => `${d.item} ${d.count}`).join(', ')}; then ${kind}: ` : ''
        return err(res, new Error(`${prior}deposited ${inChest - before} then failed${transferring ? ' (chest full?)' : ''}: ${e.message}; ${kind} in chest now ${inChest}; ${others}`))
      } finally {
        chest.close()
        endHand(lease)
      }
      if (!deposited.length) return err(res, new Error(`no ${names.join('|')} in inventory`))
      ok(res, { deposited, ...(missing.length ? { missing } : {}) })
    } catch (e) { err(res, e) }
  })

  // took counts what reached the pockets.
  app.get('/grave', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const take = req.query.take
      const gb = targetGrave(req.query)
      if (!gb) return err(res, new Error(`no gravestone in sight within ${GRAVE_SIGHT}`))
      refuseWhileFighting()
      await bot.pathfinder.goto(new goals.GoalNear(gb.position.x, gb.position.y, gb.position.z, 2))
      const grave = await bot.openBlock(gb)
      const lease = holdHand()
      try {
        const at = round(gb.position)
        const items = () => grave.containerItems().map(i => ({ name: i.name, count: i.count }))
        if (take == null) return ok(res, { at, items: items() })
        const all = grave.containerItems()
        const exact = all.filter(i => i.name === take)
        const named = take === 'all' ? all : exact.length ? exact : all.filter(i => i.name.includes(take))
        if (!named.length) throw new Error(`no ${take} in the gravestone`)
        const took = []
        const turn = stackTurns(grave, 'grave', lease)
        let stopped
        for (const type of new Set(named.map(i => i.type))) {
          const n = named.filter(i => i.type === type).reduce((s, i) => s + i.count, 0)
          const before = grave.count(type, null)
          try { await withdrawStacks(grave, type, n, turn, () => {}) } catch (e) { stopped = e.message }
          const moved = grave.count(type, null) - before
          if (moved > 0) took.push(`${moved} ${named.find(i => i.type === type).name}`)
          if (stopped) break
        }
        if (!took.length) throw new Error(`took nothing${stopped ? `: ${stopped}` : ''}`)
        ok(res, { at, took, stopped, items: items() })
      } finally {
        grave.close()
        endHand(lease)
      }
    } catch (e) { err(res, e) }
  })

  // /activate?x=&y=&z= (07-15, built to claim my bed) — generic block right-click: beds (set spawn),
  // levers, buttons, anything interactive that isn't an entity (/useon) or a door (pathfinder+manners
  // own those). LOS-gated like /blockat — I only press what I can see. Walks into reach if needed.
  // Door/gate activations still flow through the manners wrap (this calls the same wrapped function),
  // so even a manual /activate on a door gets remembered and closed behind me.
  app.get('/activate', async (req, res) => {
    try {
      const Vec3 = require('vec3').Vec3
      const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) return err(res, new Error('unloaded chunk'))
      if (!seesLit({ x, y, z }, 20)) return err(res, outOfSight())
      if (bot.entity.position.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) > 3.5) {
        await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2))
      }
      await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
      await bot.waitForTicks(2)
      await bot.activateBlock(b)
      const out = { activated: b.name, at: { x, y, z } }
      // The walk into reach can leave the block out of sight.
      if (seesLit({ x, y, z }, 20)) out.properties = (bot.blockAt(new Vec3(x, y, z)) || b).getProperties()
      ok(res, out)
    } catch (e) { err(res, e) }
  })

  // GET /fish?count=&x=&y=&z= — the rod verb (07-16, first cast day). Casts the held fishing_rod;
  // mineflayer's bot.fish() reels itself when the bobber bites. Aim: the given cell must be WATER
  // I can SEE (a player casts at water in view; waitForTicks(2) respects the tick race), else cast
  // along current facing. Background job like the dig verbs; each catch is named by pocket-diff and
  // emitted — bites land ~20-30s apart, well under alarm-economy spam. A /job_stop lands between
  // casts (an in-flight cast reels itself out on its own bite; fishing holds no pathfinder to stop).
  app.get('/fish', (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const Vec3 = require('vec3').Vec3
      const count = Math.min(32, Math.max(1, parseInt(req.query.count || '1')))
      if (!bot.inventory.items().find(i => i.name === 'fishing_rod')) return err(res, new Error('no fishing_rod in inventory'))
      let aim = null
      if ([req.query.x, req.query.y, req.query.z].every(v => v !== undefined)) {
        const x = Math.floor(parseFloat(req.query.x)), y = Math.floor(parseFloat(req.query.y)), z = Math.floor(parseFloat(req.query.z))
        const wb = bot.blockAt(new Vec3(x, y, z))
        if (!seesLit({ x, y, z }, 30)) return err(res, new Error('that cell is not in my sight: walk to the bank first'))
        if (!wb || !wb.name.includes('water')) return err(res, new Error(`aim cell is ${wb ? wb.name : 'unloaded'} — point me at water`))
        aim = new Vec3(x + 0.5, y + 0.9, z + 0.5)
      }
      const pockets = () => { const m = {}; for (const it of bot.inventory.items()) m[it.name] = (m[it.name] || 0) + it.count; return m }
      const { id } = jobs.start(`fish x${count}`, async (job) => {
        const rod = bot.inventory.items().find(i => i.name === 'fishing_rod')
        await bot.equip(rod, 'hand')
        if (!LEGACY_1710) await bot.waitForTicks(13)      // slot-change cooldown (the /strike lesson), which 1.7.10 lacks
        const caught = []
        for (let i = 0; i < count; i++) {
          if (job.cancelled) break
          if (aim) { await bot.lookAt(aim, true); await bot.waitForTicks(2) }
          const before = pockets()
          try { await bot.fish() } catch (e) {
            job.progress(`cast ${i + 1} failed: ${e.message}`)
            emitEvent('fish', `cast failed — ${(e.message || '').slice(0, 60)}`)
            break
          }
          await new Promise(r => setTimeout(r, 700))      // let the flying loot land in the pockets
          const after = pockets()
          const gained = Object.keys(after).filter(k => (after[k] || 0) > (before[k] || 0) && k !== 'fishing_rod')
          const what = gained.length ? gained.map(k => `${k} x${after[k] - (before[k] || 0)}`).join(', ') : 'something (pockets full? nothing landed)'
          caught.push(...gained)
          job.progress(`${i + 1}/${count}: ${what}`)
          emitEvent('fish', `caught ${what} (${i + 1}/${count})`)
        }
        return { caught }
      })
      ok(res, { job: id, casts: count, aimed: !!aim })
    } catch (e) { err(res, e) }
  })

  // GET /use?x=&y=&z=[&item=name] — the universal RIGHT-CLICK: equip item (optional) and activate it
  // on the block. Unlocks the whole interaction layer: till (hoe), sow (seeds), bone meal, fill/pour
  // bucket, open/close doors, shear sheep... For liquids (no activatable block) it aims and uses the
  // held item instead. Walks closer only if out of arm's reach (digat's lesson).
  // Replies ok false when a click that should change a cell (useTarget) left it as it was.
  app.get('/use', async (req, res) => {
    try {
      let p = new Vec3(Math.floor(parseFloat(req.query.x)), Math.floor(parseFloat(req.query.y)), Math.floor(parseFloat(req.query.z)))
      if (![p.x, p.y, p.z].every(Number.isFinite)) return err(res, new Error('x, y, z required'))
      let b = bot.blockAt(p)
      if (!b) return err(res, new Error('block not loaded'))
      if (!seesLit(p, 6)) return err(res, outOfSight())
      if (req.query.item) {
        const it = bot.inventory.items().find(i => i.name === String(req.query.item))
        if (!it) return err(res, new Error('not carrying ' + req.query.item))
        await bot.equip(it, 'hand')
      }
      const held = bot.heldItem ? bot.heldItem.name : null
      const plant = held === 'bone_meal' && boneMealPlant(b, p)
      if (plant) {
        p = plant.position
        b = plant
      }
      const eyeDist = bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5))
      if (eyeDist > 4.2) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2))
      await bot.lookAt(p.offset(0.5, 0.5, 0.5), true)
      // activateBlock with a bucket pours nothing, on 1.21.11 and on 1.7.10.
      // Crops, saplings and grass have no collision box but take the click themselves (bone meal).
      const bucket = !!bot.heldItem && bot.heldItem.name.endsWith('bucket')
      const rawUse = bucket || b.name.includes('water') || b.name.includes('lava') || /^(cave_|void_)?air$/.test(b.name)
      const target = useTarget(b, p, held)
      const was = target && bot.blockAt(target)
      await withBlockUpdate(target || p, 500, async () => {
        if (rawUse) {
          bot.activateItem()
          await new Promise(r => setTimeout(r, 300))
          try { bot.deactivateItem() } catch (e) {}
        } else {
          await bot.activateBlock(b)
        }
      })
      const out = { used: held || 'empty hand', on: b.name, at: round(p) }
      // The walk into reach can leave the block out of sight.
      if (seenNow(p)) out.now = (bot.blockAt(p) || {}).name
      const after = target && bot.blockAt(target)
      const grown = held === 'bone_meal' && after && seenNow(target) ? after.getProperties() : {}
      const growth = 'age' in grown ? 'age' : 'stage' in grown ? 'stage' : null
      if (growth) out[growth] = Number(grown[growth])
      if (was && after && after.stateId === was.stateId && seenNow(target)) {
        if (growth === 'stage') out.note = 'a sapling grows on some uses only'
        else Object.assign(out, { ok: false, reason: `nothing changed at ${target.x},${target.y},${target.z}, still ${was.name}` })
      }
      ok(res, out)
    } catch (e) { err(res, e) }
  })

  // ---- MACROS: high-level verbs with guardrails baked in, run ASYNC via jobs.start ----

  // GET /enchant?item=&slot= : walk to the nearest enchanting table and enchant. The pilot's
  // query→act→verify grammar in one verb: WITHOUT slot it puts the item + lapis in, reads the
  // three offers (level cost, lapis cost, enchant name when resolvable), takes everything back
  // out, and reports — the LOOK. WITH slot=0|1|2 it commits that offer (consumes 1-3 lapis and
  // 1-3 of MY levels; needs my level ≥ the shown cost). Lapis must be in my pockets — the table
  // window keeps nothing between opens. (Forged 07-20, the day the body learned to enchant.)
  app.get('/enchant', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const itemName = req.query.item
      const slot = req.query.slot === undefined ? null : parseInt(req.query.slot)
      if (!itemName) return err(res, new Error('item required'))
      const tb = nearestKnown(resolveBlockIds('enchanting_table'), 16)
      if (!tb) return err(res, new Error('no enchanting table seen within 16'))
      await bot.pathfinder.goto(new goals.GoalNear(tb.position.x, tb.position.y, tb.position.z, 2))
      const item = bot.inventory.items().find(i => i.name === itemName)
      if (!item) return err(res, new Error(`no ${itemName} in pockets`))
      const lapis = bot.inventory.items().find(i => i.name === 'lapis_lazuli')
      if (!lapis) return err(res, new Error('no lapis_lazuli in pockets — the table burns 1-3 per enchant'))
      const table = await bot.openEnchantmentTable(arrivedStation(tb.position, (b) => b.name === 'enchanting_table', 'enchanting table'))
      try {
        // find both WITHIN the open window — slot ids remap once a window opens, so the
        // bot.inventory handles located above would point moveSlotItem at the wrong cells
        const wItem = table.slots.find(s => s && s.name === itemName && s.slot >= 2)
        const wLapis = table.slots.find(s => s && s.name === 'lapis_lazuli' && s.slot >= 2)
        if (!wItem) throw new Error(`${itemName} not visible in the table window`)
        if (!wLapis) throw new Error('lapis not visible in the table window')
        await table.putTargetItem(wItem)
        await table.putLapis(wLapis)
        // 1.21 quirk: the plugin's 'ready' event NEVER fires (it compares "expected" property
        // packets against "actual" ones modern servers no longer send) — poll the offers array
        // directly instead; the data itself arrives fine.
        const offersUp = () => (table.enchantments || []).some(e => e.level > 0)
        const offerDeadline = Date.now() + 6000
        while (!offersUp() && Date.now() < offerDeadline) await new Promise(r => setTimeout(r, 250))
        if (!offersUp()) throw new Error('offers never arrived')
        const enchName = (id) => {
          const e = (shared.mcData.enchantmentsArray || []).find(x => x.id === id)
          return e ? e.name : (id === -1 ? '?' : `#${id}`)
        }
        const offers = (table.enchantments || []).map((e, i) => (
          { slot: i, levelCost: e.level, lapisCost: i + 1, enchant: enchName(e.expected ? e.expected.enchant : -1) }))
        const myLevel = bot.experience.level
        if (slot === null) {
          emitEvent('enchant', `offers for ${itemName}: ${offers.map(o => `#${o.slot} lv${o.levelCost} ${o.enchant}`).join(' | ')} (me: lv${myLevel})`)
          ok(res, { offers, myLevel, lapisHeld: lapis.count, note: 'call again with slot=0|1|2 to commit' })
        } else {
          const chosen = offers[slot]
          if (!chosen || chosen.levelCost < 0) throw new Error(`slot ${slot} holds no offer`)
          if (myLevel < chosen.levelCost) throw new Error(`offer needs level ${chosen.levelCost}, I am ${myLevel}`)
          if (lapis.count < chosen.lapisCost) throw new Error(`offer needs ${chosen.lapisCost} lapis, I hold ${lapis.count}`)
          // commit with a direct packet — table.enchant() awaits the same dead 'ready' event
          bot._client.write('enchant_item', { windowId: table.id, enchantment: slot })
          await new Promise(r => setTimeout(r, 1000))   // let the server apply + resync slot 0
          const result = table.slots[0]
          emitEvent('enchant', `${itemName} enchanted: ${chosen.enchant} (slot ${slot}, lv${chosen.levelCost}) — now lv${bot.experience.level}`)
          ok(res, { enchanted: itemName, offer: chosen, myLevelNow: bot.experience.level, resultNbt: !!(result && result.nbt) })
        }
      } finally {
        try { if (table.targetItem()) await table.takeTargetItem() } catch (e) {}
        try { const l = table.slots[1]; if (l) await bot.putAway(l.slot) } catch (e) {}
        try { table.close() } catch (e) {}
      }
    } catch (e) { err(res, e) }
  })

  // GET /rename?item=&name= : walk to the nearest anvil and christen an item. Costs 1 of MY
  // levels (the anvil's rename fee) and wears the anvil a step; name caps at 35 chars. The
  // mineflayer plugin streams the name a character at a time like a vanilla client typing.
  // (Forged 07-21, the day the blades got names — Occam was first.)
  app.get('/rename', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const itemName = req.query.item
      const newName = req.query.name
      if (!itemName || !newName) return err(res, new Error('item and name required'))
      // exact-match resolve skips the damaged variants — an anvil is an anvil, gather all three
      const anvilIds = ['anvil', 'chipped_anvil', 'damaged_anvil'].flatMap(n => resolveBlockIds(n))
      const ab = nearestKnown(anvilIds, 16)
      if (!ab) return err(res, new Error('no anvil seen within 16'))
      await bot.pathfinder.goto(new goals.GoalNear(ab.position.x, ab.position.y, ab.position.z, 2))
      const item = bot.inventory.items().find(i => i.name === itemName)
      if (!item) return err(res, new Error(`no ${itemName} in pockets`))
      const anvil = await bot.openAnvil(arrivedStation(ab.position, (b) => /anvil$/.test(b.name), 'anvil'))
      try {
        await anvil.rename(item, newName)
        emitEvent('rename', `${itemName} christened "${newName}" — now lv${bot.experience.level}`)
        ok(res, { renamed: itemName, name: newName, myLevelNow: bot.experience.level })
      } finally {
        try { anvil.close() } catch (e) {}
      }
    } catch (e) { err(res, e) }
  })

  // GET /smelt?item=&fuel=&count= : loads the nearest furnace and returns without waiting for the burn.
  app.get('/smelt', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const inputName = req.query.item
      const fuelName = req.query.fuel || 'coal'
      const want = Math.max(1, parseInt(req.query.count || '1'))
      if (!inputName) return err(res, new Error('item required'))
      if (burnItems(fuelName) == null) return err(res, new Error(`no known burn time for ${fuelName}`))
      const fb = targetFurnace({})
      await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
      const furnace = await bot.openFurnace(arrivedStation(fb.position, (b) => b.name === 'furnace', 'furnace'))
      try {
        // The flame bar arrives after the window.
        await bot.waitForTicks(2)
        const step = (what) => console.log(`[smelt] ${what} ${JSON.stringify(furnaceSlots(furnace))}`)
        step('opened')
        const pocketCount = (name) => furnace.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0)
        const inItem = furnace.items().find(i => i.name === inputName)
        if (!inItem) throw new Error(`no ${inputName} to smelt`)
        const curIn = furnace.inputItem()
        if (curIn && curIn.name !== inputName) throw new Error(`the furnace is busy with ${curIn.count} ${curIn.name}`)
        const n = Math.min(want, pocketCount(inputName), inItem.stackSize - (curIn ? curIn.count : 0))
        if (n < 1) throw new Error(`the furnace input is full with ${curIn.count} ${curIn.name}`)
        const fuelIn = furnace.fuelItem()
        if (!fuelIn && !pocketCount(fuelName)) throw new Error(`no ${fuelName} for fuel`)
        // A fuel slot holding another item is used as it is.
        const per = burnItems(fuelIn ? fuelIn.name : fuelName)
        if (per == null) throw new Error(`no known burn time for the ${fuelIn.count} ${fuelIn.name} in the fuel slot`)
        // The flame shows the share of one fuel item left to burn, taken as the fuel in use.
        const burning = (furnace.fuel || 0) * per
        let took, note
        const out = furnace.outputItem()
        if (out && out.name === smeltYield(inputName) && pocketRoom(furnace, out) >= out.count) {
          await takeSlot(furnace, out, out.count)
          took = `${out.count} ${out.name}`
          step('took output')
        } else if (out) {
          note = `left ${out.count} ${out.name} in the output`
        }
        await furnace.putInput(inItem.type, null, n)
        step('loaded input')
        const total = (curIn ? curIn.count : 0) + n
        const pocketFuel = furnace.items().find(i => i.name === fuelName)
        if (pocketFuel && (!fuelIn || fuelIn.name === fuelName)) {
          const held = fuelIn ? fuelIn.count : 0
          const add = Math.min(pocketCount(fuelName), Math.ceil((total - burning) / per) - held, pocketFuel.stackSize - held)
          if (add > 0) {
            await furnace.putFuel(pocketFuel.type, null, add)
            step('loaded fuel')
          }
        }
        // A stall behind an occupied output says nothing about the recipe.
        if (!furnace.outputItem() && !await furnaceCooks(furnace)) {
          const back = furnace.inputItem()
          const held = back.count
          const moved = Math.min(held, pocketRoom(furnace, back))
          await takeSlot(furnace, back, moved)
          step('no recipe')
          const fuelLeft = furnace.fuelItem()
          const left = [held > moved && `${held - moved} ${inputName} in the input`, fuelLeft && `the ${fuelLeft.count} ${fuelLeft.name} in the fuel slot`].filter(Boolean)
          throw Object.assign(new Error(`this server does not smelt ${inputName}: took ${moved} ${inputName} back${left.length ? `, left ${left.join(' and ')}` : ''}`), { reason: 'no-recipe' })
        }
        const fuelNow = furnace.fuelItem()
        const covers = Math.round((burning + (fuelNow ? fuelNow.count * per : 0)) * 100) / 100
        // A furnace smelts one item every 10 s.
        ok(res, { at: round(fb.position), loaded: n, ...furnaceSlots(furnace), took, note,
          doneInSec: Math.round(Math.min(total, covers) * 10), fuelFor: covers < total ? covers : undefined })
      } finally {
        furnace.close()
      }
    } catch (e) { err(res, e) }
  })

  // GET /furnace?at=&take=&count= : lists a furnace's slots, or takes one slot into the pockets.
  app.get('/furnace', async (req, res) => {
    try {
      if (!shared.ready) return err(res, new Error('not ready'))
      const take = req.query.take
      if (take != null && !['input', 'fuel', 'output'].includes(take)) return err(res, new Error('take is input, fuel or output'))
      const fb = targetFurnace(req.query)
      await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
      const furnace = await bot.openFurnace(arrivedStation(fb.position, (b) => b.name === 'furnace', 'furnace'))
      try {
        if (take == null) {
          // mineflayer reads a bar as 0 until a value arrives after its total.
          await bot.waitForTicks(2)
          const share = (v) => typeof v === 'number' ? Math.round(v * 100) / 100 : undefined
          return ok(res, { at: round(fb.position), ...furnaceSlots(furnace), progress: share(furnace.progress), fuelLeft: share(furnace.fuel) })
        }
        const item = { input: furnace.inputItem(), fuel: furnace.fuelItem(), output: furnace.outputItem() }[take]
        if (!item) throw new Error(`the ${take} slot is empty`)
        // The output slot accepts no items back.
        const n = take === 'output' ? item.count : Math.min(parseInt(req.query.count || item.count), item.count)
        if (pocketRoom(furnace, item) < n) throw new Error(`no room in your pockets for ${n} ${item.name}`)
        await takeSlot(furnace, item, n)
        console.log(`[furnace] took ${n} ${item.name} ${JSON.stringify(furnaceSlots(furnace))}`)
        ok(res, { at: round(fb.position), took: `${n} ${item.name}`, ...furnaceSlots(furnace) })
      } finally {
        furnace.close()
      }
    } catch (e) { err(res, e) }
  })
}

function createWorkingRoutes (ctx) {
  Object.assign(ctx, { installWorkingRoutes, itemFrame, framedItem, nearestFrame, frameAt, withEntityUpdate, walkToFrame })
}

function bindWorkingRoutes (ctx) {
  ({ bot, liveEntities, entityPerceptible, routeEnd, stagedGoto, round, cellKnown, xyz, shared, resolveBlockIds, nearestKnown, arrivedStation, NEIGHBOURS, bodyTouches, seesLit, fillFrom, err, collectLock, collectBusy, nearestVisible, collectSafely, ok, bunker, BUNKER_WALK, claimLane, walkRoute, namedStop, releaseLane, resolveItem, placeSpot, clearSoftCover, jobs, safeFood, foodUpdate, FOOD_UPDATE_MS, outOfSight, seenNow, holdDigTool, neededPickTier, PICK_TIER, holdHarvester, silkRefusal, occupant, isSoftCover, isInteractive, reachToPlace, passageAxis, stampOwnEdit, sneakPlace, hangFrame, afterServerAge, waitedText, send, watchedWork, stopPath, emitEvent, refuseWhileBuilding, equipPickFor, nudgeInto, macroPlaceAt, playerEntity, playerSighting, reflexes, nearestSeen, targetSeen, inMeleeReach, meleeReachGoal, meleeAim, knownBlocks, rememberedStation, skyInSight, cardinal, cardinalName, refuseWhileFighting, holdHand, endHand, lightRange, floodPassable, cellText, holdsWater, canStepOutTo, centerOnCell, legs, suffocates } = ctx)
}

module.exports = { createWorkingRoutes, bindWorkingRoutes }
