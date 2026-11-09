'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { AsyncLocalStorage } = require('node:async_hooks')
const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const rules = require('../lib/combat-rules')
const legacy1710 = require('../lib/bot/legacy-1710')
const { babyFlag } = require('../lib/shelter')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { watchProgress, guardWork } = require('../lib/walk')
const { panelAcross } = require('../lib/doors')
const { routeHandler, fakeClock, botConstant, walkingBody, loadBotFunctions } = require('./helpers')
const mcData = require('minecraft-data')('1.21.11')

const named = (name, message) => Object.assign(new Error(message), { name })

const FOOD = ['wheat', 'wheat_seeds', 'melon_seeds', 'carrot']

// The stack the server leaves in the hand after a click on en with held, null when it takes nothing.
function serverTake (en, held) {
  const keys = mcData.entitiesByName[en.name].metadataKeys
  const meta = en.metadata || []
  if (FOOD.includes(held.name)) return meta[keys.indexOf('baby')] || en.inLove ? null : { ...held, count: held.count - 1 }
  if (held.name === 'shears') {
    const wool = keys.indexOf('wool')
    if (wool < 0 || meta[wool] & 0x10) return null
    return { ...held, durabilityUsed: held.durabilityUsed + 1 }
  }
  if (held.name === 'bucket') return en.name !== 'cow' ? null : held.count > 1 ? { ...held, count: held.count - 1 } : { ...held, name: 'milk_bucket' }
  if (held.name === 'bowl') return en.name !== 'mooshroom' ? null : held.count > 1 ? { ...held, count: held.count - 1 } : { ...held, name: 'mushroom_stew' }
  if (held.name === 'bone') return en.name === 'wolf' ? { ...held, count: held.count - 1 } : null
  return null
}

// The items each creature breeds from on a 1.7.10 server.
const BREEDS = { cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], pig: ['carrot'], chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'nether_wart'] }

// Emits what the server shows when it takes held on en.
function serverShow (bot, en, held) {
  if (BREEDS[en.name]?.includes(held.name)) bot._client.emit('entity_status', { entityId: en.id, entityStatus: 18 })
  else if (held.name === 'shears' && en.name === 'sheep') {
    const wool = mcData.entitiesByName.sheep.metadataKeys.indexOf('wool')
    en.metadata = (en.metadata || []).slice()
    en.metadata[wool] = (en.metadata[wool] || 0) | 0x10
    bot.emit('entityUpdate', en)
  } else if (held.name === 'shears' && en.name === 'mooshroom') {
    delete bot.entities[en.id]
    bot.emit('entityGone', en)
  }
}

// A /useon rig on walkingBody's real planner, pace walking it node by node, with unseen and shapes keyed by 'x,y,z'.
async function plannedUseon (t, entities, cells = {}, feet = new Vec3(0.5, 64, 0.5), pace = null, unseen = null, shapes = null) {
  const walk = await walkingBody(t, feet, cells)
  const { pathfinder } = walk.bot
  const PLAN_KNOWN = new Map()
  if (unseen || shapes) {
    const key = (p) => `${p.x},${p.y},${p.z}`
    const knownCell = (p) => !unseen?.has(key(p)) && !shapes?.has(key(p))
    const shapeNear = (p) => shapes?.get(key(p)) ?? null
    const { knownMoves } = loadBotFunctions(['knownMoves'], { bot: walk.bot, PLAN_KNOWN, ck: (x, y, z) => `${x},${y},${z}`, knownCell, shapeNear, panelAcross })
    knownMoves(pathfinder.movements)
  }
  const clock = fakeClock()
  const used = []
  const walks = []
  const world = { clock, used, walks, pathfinder, frozen: false, answerMs: 100, answer: null, afterClick: [], ages: true, clickAt: null, replyAt: null, clicks: [], gateMs: 150 }
  const inventory = Object.assign(new EventEmitter(), { hotbarStart: 36, slots: new Array(46).fill(null), selectedItem: null, items: () => inventory.slots.filter(Boolean) })
  // As mineflayer's window updateSlot, with the held item following the selected hotbar slot.
  const setSlot = (slot, item) => {
    if (item) item.slot = slot
    const old = inventory.slots[slot]
    inventory.slots[slot] = item
    inventory.emit('updateSlot', slot, old, item)
    if (slot !== inventory.hotbarStart + bot.quickBarSlot) return
    bot.heldItem = item
    bot.emit('heldItemChanged', item)
  }
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    entity: walk.bot.entity,
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
    players: {},
    blockAt: walk.bot.blockAt,
    pathfinder,
    heldItem: null,
    quickBarSlot: 0,
    time: { age: 0 },
    inventory,
    equip: async (item) => {
      const hand = inventory.hotbarStart + bot.quickBarSlot
      const from = item.slot
      if (from === hand) return
      const was = inventory.slots[hand]
      setSlot(hand, item)
      setSlot(from, was)
    },
    lookAt: async () => {},
    waitForTicks: (n) => new Promise((resolve) => clock.setTimeout(resolve, n * 50)),
    useOn: async (en) => {
      used.push(en.id)
      world.clickAt = clock.now()
      const slot = inventory.hotbarStart + bot.quickBarSlot
      const clicked = inventory.slots[slot]
      const held = world.answer ? world.answer(clicked) : serverTake(en, clicked)
      if (held) {
        clock.setTimeout(() => {
          // The server takes from the stack still in that slot.
          if (inventory.slots[slot]?.name === clicked.name) setSlot(slot, held)
          serverShow(bot, en, clicked)
        }, world.answerMs)
      }
      for (const [ms, fn] of world.afterClick) clock.setTimeout(() => fn(slot), ms)
    },
    clearControlStates () {}
  })
  const stock = [['wheat', 64], ['wheat_seeds', 64], ['melon_seeds', 64], ['shears', 1, 0], ['bucket', 1], ['bone', 64]]
  stock.forEach(([name, count, durabilityUsed], i) => setSlot(9 + i, { name, count, durabilityUsed }))
  bot.on('physicsTick', () => PLAN_KNOWN.clear())
  clock.setInterval(() => bot.emit('physicsTick'), 50)
  clock.setInterval(() => {
    if (!world.ages) return
    bot.time.age++
    bot.emit('time')
  }, 50)
  const plan = (goal) => {
    let result
    for (const step of pathfinder.getPathFromTo(pathfinder.movements, bot.entity.position, goal)) result = step.result
    walks.push(result.path.length)
    bot.emit('path_update', result)
    return result
  }
  // The walk's gate click until its block update arrives.
  let clicking = null
  const server = new Map()
  const click = ({ x, y, z }) => {
    const key = `${x},${y},${z}`
    world.clicks.push(key)
    const open = !(server.get(key) ?? cells[key][1].open === 'true')
    server.set(key, open)
    const mine = clicking = {}
    clock.setTimeout(() => {
      cells[key] = [cells[key][0], { ...cells[key][1], open: String(open) }]
      if (clicking === mine) clicking = null
    }, world.gateMs)
  }
  if (pace) pathfinder.isBuilding = () => clicking !== null
  // A setGoal of the walking goal plans it again on the next tick, as mineflayer-pathfinder's resetPath does.
  let resetWalk = null
  const setGoal = pathfinder.setGoal
  pathfinder.setGoal = (goal, dynamic = false) => {
    setGoal(goal, dynamic)
    if (resetWalk) resetWalk(goal, dynamic)
  }
  // Settles as mineflayer-pathfinder's goto does.
  const walkPlan = (goal) => new Promise((resolve, reject) => {
    pathfinder.setGoal(goal)
    let path = null
    let dynamic = false
    let pausedUntil = 0
    resetWalk = (g, d) => {
      if (g !== goal) return
      path = null
      dynamic = d
    }
    const on = {
      goal_updated: (g) => { if (g !== goal) end(named('GoalChanged', 'The goal was changed before it could be completed!')) },
      path_stop: () => end(named('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.')),
      physicsTick () {
        if (path === null || goal.hasChanged()) {
          clicking = null
          const result = plan(goal)
          path = result.path.slice()
          if (!path.length) {
            if (!dynamic && goal.isEnd(bot.entity.position.floored())) arrive()
            return end()
          }
          if (result.status === 'noPath') return end(named('NoPath', 'No path to the goal!'))
          if (result.status === 'timeout') return end(named('Timeout', 'Took to long to decide path to goal!'))
        }
        if (world.frozen || clock.now() < pausedUntil || !path.length || clicking) return
        const shut = (path[0].toPlace || []).find((b) => b.useOne && bot.blockAt(new Vec3(b.x, b.y, b.z)).getProperties().open === false)
        if (shut) return click(shut)
        const p = bot.entity.position
        const to = new Vec3(Math.floor(path[0].x) + 0.5, path[0].y, Math.floor(path[0].z) + 0.5)
        const d = to.distanceTo(p)
        if (d > pace / 20) {
          bot.entity.position = p.plus(to.minus(p).scaled(pace / 20 / d))
          return
        }
        bot.entity.position = to
        path.shift()
        if (bot.blockAt(to).name.endsWith('_fence_gate')) pausedUntil = clock.now() + 1000
        if (!path.length && !dynamic && goal.isEnd(to.floored())) {
          arrive()
          end()
        }
      }
    }
    const arrive = () => {
      pathfinder.setGoal(null)
      bot.emit('goal_reached', goal)
    }
    const end = (e) => {
      resetWalk = null
      for (const [event, fn] of Object.entries(on)) bot.removeListener(event, fn)
      if (e) reject(e)
      else resolve()
    }
    for (const [event, fn] of Object.entries(on)) bot.on(event, fn)
  })
  pathfinder.goto = pace ? walkPlan : async (goal) => {
    pathfinder.setGoal(goal)
    const { status, path } = plan(goal)
    if (!path.length) {
      if (goal.isEnd(bot.entity.position.floored())) pathfinder.setGoal(null)
      return
    }
    if (status === 'noPath') throw named('NoPath', 'No path to the goal!')
    if (status === 'timeout') throw named('Timeout', 'Took to long to decide path to goal!')
    const end = path[path.length - 1]
    bot.entity.position = new Vec3(end.x, end.y, end.z)
    pathfinder.setGoal(null)
    bot.emit('goal_reached', goal)
  }
  const fill = {}
  const env = {
    bot,
    ok: (res, body) => {
      res.body = body
      world.replyAt = clock.now()
    },
    goals,
    Movements,
    UNSEEN_PLAN_MS: botConstant('UNSEEN_PLAN_MS'),
    shared: { ready: true, mcData },
    babyFlag,
    LEGACY_1710: false,
    HITBOX_1710: legacy1710.HITBOX_1710,
    SWING_REACH: rules.SWING_REACH,
    STRIKE_APPROACH_MS: rules.STRIKE_APPROACH_MS,
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    MELEE_GOAL_DRIFT: botConstant('MELEE_GOAL_DRIFT'),
    watchProgress: (o) => watchProgress({ ...o, clock }),
    USEON_GROUPS: botConstant('USEON_GROUPS'),
    USEON_RECENT_MS: botConstant('USEON_RECENT_MS'),
    USEON_KEEP_WITHIN: botConstant('USEON_KEEP_WITHIN'),
    USEON_AT_WITHIN: botConstant('USEON_AT_WITHIN'),
    USEON_SLOT_MS: botConstant('USEON_SLOT_MS'),
    USEON_LATE_MS: botConstant('USEON_LATE_MS'),
    USEON_BREEDS: botConstant('USEON_BREEDS'),
    useonMissed: new Map(),
    usedOn: new Map(),
    walkFailed: new Map(),
    Vec3,
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setImmediate,
    clearImmediate,
    console: { log () {} },
    liveEntities: () => Object.values(bot.entities),
    reflexes: [{ name: 'combat', fairFill: () => fill, fightBusy: () => false }],
    guardState: { hand: null },
    entityPerceptible: (e, f) => {
      assert.strictEqual(f, fill, 'entityPerceptible got another fill')
      return e.seen
    },
    legs: legLedger(),
    takenText,
    // The events of legs.js stopPath on a walking pathfinder.
    stopPath: () => {
      pathfinder.setGoal(null)
      bot.emit('goal_updated', null, false)
      bot.emit('path_stop')
    },
    round: (v) => v && { x: v.x, y: v.y, z: v.z }
  }
  return Object.assign(world, { bot, env, setSlot })
}

async function driveUseon (world, item = 'wheat', name = 'cow', at = undefined) {
  const { handle, res } = routeHandler('/useon', world.env)
  let done = false
  handle({ query: { name, item, ...(at !== undefined && { at }) } }, res).then(() => { done = true })
  for (let i = 0; i < 60000 && !done; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    world.clock.advance(10)
  }
  assert.ok(done, `no reply after ${world.clock.now()} ms`)
  return res
}

async function useon (world, item = 'wheat', name = 'cow', at = undefined) {
  const res = await driveUseon(world, item, name, at)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { ...res.body }
}

const cow = (id, x, z = 0.5) => ({ id, name: 'cow', width: 0.9, height: 1.4, seen: true, position: new Vec3(x, 64, z) })
const as = (name, en) => ({ ...en, name })
const FENCE = ['oak_fence', {}]

// Oak fences at y 64 on the border of the rectangle from x0, z0 to x1, z1, gates[x,z] in place of a fence.
function fenced (x0, z0, x1, z1, gates = {}, cells = {}) {
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      if (x === x0 || x === x1 || z === z0 || z === z1) cells[`${x},64,${z}`] = gates[`${x},${z}`] || FENCE
    }
  }
  return cells
}

// The field's fence ends every search before it runs out of think time.
const closedPen = () => fenced(-10, -8, 14, 8, {}, fenced(2, -4, 10, 4))

const skipped = (reason, left) => ({
  ok: false,
  used: null,
  on: 'cow',
  at: { x: 6, y: 64, z: 0 },
  reason,
  note: left ? `passed over for up to 5 minutes while I stay within 2 blocks of here, the next call picks another cow, ${left} left in sight` : 'passed over for up to 5 minutes while I stay within 2 blocks of here, no other cow in sight is left to pick'
})

test('useon feeds the cow outside a gated pen, then walks to the one inside', async (t) => {
  const gate = ['oak_fence_gate', { facing: 'east', open: 'false', in_wall: 'false', powered: 'false' }]
  const world = await plannedUseon(t, [cow(21, 2.5), cow(22, 6.5)], fenced(4, -3, 8, 3, { '4,0': gate }))
  const replies = [await useon(world), await useon(world)]
  assert.deepStrictEqual({ used: world.used, replies, goal: world.pathfinder.goal }, {
    used: [21, 22],
    replies: [{ used: 'wheat', on: 'cow', at: { x: 2.5, y: 64, z: 0.5 } }, { used: 'wheat', on: 'cow', at: { x: 6.5, y: 64, z: 0.5 } }],
    goal: null
  })
})

test('useon shears two sheep in a pen in turn, each over the fence from where the walk ends', async (t) => {
  const flock = [as('sheep', cow(31, 5.5)), as('sheep', cow(32, 5.5, 7.5))]
  const world = await plannedUseon(t, flock, fenced(4, -3, 8, 10))
  const notes = []
  for (let i = 0; i < 2; i++) notes.push((await useon(world, 'shears', 'sheep')).note)
  assert.deepStrictEqual({ used: world.used, notes }, { used: [31, 32], notes: [undefined, undefined] })
})

test('useon passes over a cow in a closed pen for 5 minutes, clicks nothing and takes the next cow', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5), cow(22, -6.5)], closedPen())
  const first = await useon(world)
  assert.deepStrictEqual({ first, used: world.used, goal: world.pathfinder.goal }, { first: skipped('no walk puts the cow at 6,64,0 in swing reach', 1), used: [], goal: null })
  await useon(world)
  assert.deepStrictEqual(world.used, [22])
})

test('useon refuses with a note after its only cow was passed over, clicking nothing', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5)], closedPen())
  assert.deepStrictEqual(await useon(world), skipped('no walk puts the cow at 6,64,0 in swing reach', 0))
  const refused = await useon(world)
  assert.deepStrictEqual({ refused, used: world.used, goal: world.pathfinder.goal }, {
    refused: { ok: false, used: null, on: 'cow', note: 'every cow in sight had a failed walk within the last 5 minutes, moving over 2 blocks from where the walks failed lifts their pass-overs, or at=x,y,z names one directly' },
    used: [],
    goal: null
  })
})

test('a sheep passed over after a failed walk with wheat is passed over for shears too', async (t) => {
  const world = await plannedUseon(t, [as('sheep', cow(31, 6.5)), as('sheep', cow(32, -6.5))], closedPen())
  const first = await useon(world, 'wheat', 'sheep')
  assert.strictEqual(first.note, 'passed over for up to 5 minutes while I stay within 2 blocks of here, the next call picks another sheep, 1 left in sight')
  await useon(world, 'shears', 'sheep')
  assert.deepStrictEqual(world.used, [32])
})

test('useon gives wheat seeds and then melon seeds to two different chickens, and names the seeds once both had some', async (t) => {
  const hens = [{ ...cow(21, 4.5), name: 'chicken', width: 0.4, height: 0.7 }, { ...cow(22, 4.5, 2.5), name: 'chicken', width: 0.4, height: 0.7 }]
  const world = await plannedUseon(t, hens)
  await useon(world, 'wheat_seeds', 'chicken')
  await useon(world, 'melon_seeds', 'chicken')
  const refused = await useon(world, 'wheat_seeds', 'chicken')
  assert.deepStrictEqual({ used: world.used, refused }, {
    used: [21, 22],
    refused: { ok: false, used: null, on: 'chicken', note: 'every chicken in sight was offered seeds within the last 5 minutes, at=x,y,z names one directly' }
  })
})

test('a useon whose goto resolves on an empty partial path waits out the walk that follows and feeds the cow', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5)])
  const { bot, clock, pathfinder } = world
  pathfinder.goto = async (goal) => {
    pathfinder.setGoal(goal)
    bot.emit('path_update', { status: 'partial', path: [] })
    clock.setTimeout(() => bot.emit('path_update', { status: 'success', path: [new Vec3(4.5, 64, 0.5)] }), 500)
    clock.setTimeout(() => {
      bot.entity.position = new Vec3(4.5, 64, 0.5)
      pathfinder.setGoal(null)
      bot.emit('goal_reached', goal)
    }, 1500)
  }
  const reply = await useon(world)
  assert.deepStrictEqual({ reply, used: world.used }, { reply: { used: 'wheat', on: 'cow', at: { x: 6.5, y: 64, z: 0.5 } }, used: [21] })
})

test('a useon whose cow walks 3 blocks off while the walk ends short answers it moved and passes over nothing', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5)])
  const { bot, pathfinder } = world
  const plan = pathfinder.goto
  pathfinder.goto = async (goal) => {
    pathfinder.setGoal(goal)
    bot.entities[21].position = new Vec3(9.5, 64, 0.5)
    bot.emit('path_update', { status: 'success', path: [] })
  }
  const moved = await useon(world)
  assert.deepStrictEqual({ moved, goal: pathfinder.goal }, { moved: { ok: false, used: null, on: 'cow', at: { x: 9, y: 64, z: 0 }, reason: 'it moved' }, goal: null })
  pathfinder.goto = plan
  await useon(world)
  assert.deepStrictEqual(world.used, [21])
})

test('a useon walk that ends in reach on an empty success path clicks with no goal set and replans nothing once the cow moves', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5)])
  const { bot, clock, pathfinder } = world
  let gotos = 0
  pathfinder.goto = async (goal) => {
    gotos++
    pathfinder.setGoal(goal)
    bot.entity.position = new Vec3(4.5, 64, 0.5)
    bot.emit('path_update', { status: 'success', path: [] })
  }
  // The pathfinder checks its goal's hasChanged every tick.
  const replans = []
  bot.on('physicsTick', () => { if (pathfinder.goal && pathfinder.goal.hasChanged()) replans.push(clock.now()) })
  const useOn = bot.useOn
  let goalAtClick = null
  bot.useOn = (en) => {
    goalAtClick = pathfinder.goal !== null
    return useOn(en)
  }
  const reply = await useon(world)
  bot.entities[21].position = new Vec3(7.5, 64, 0.5)
  clock.advance(1000)
  assert.deepStrictEqual({ reply, goalAtClick, goal: pathfinder.goal !== null, gotos, replans }, {
    reply: { used: 'wheat', on: 'cow', at: { x: 6.5, y: 64, z: 0.5 } },
    goalAtClick: false,
    goal: false,
    gotos: 1,
    replans: []
  })
})

test('useon walks through the door of a room to a cow 2 cells off behind its wall, and feeds it once', async (t) => {
  // Stone walls 2 high round the floor from 2, -2 to 4, 2, an oak door in the west wall at 1, 0.
  const cells = {}
  for (let x = 1; x <= 5; x++) {
    for (let z = -3; z <= 3; z++) {
      if (x !== 1 && x !== 5 && Math.abs(z) !== 3) continue
      for (const y of [64, 65]) cells[`${x},${y},${z}`] = ['stone', {}]
    }
  }
  for (const [y, half] of [[64, 'lower'], [65, 'upper']]) cells[`1,${y},0`] = ['oak_door', { facing: 'east', half, hinge: 'left', open: 'false', powered: 'false' }]
  const world = await plannedUseon(t, [cow(21, 2.5)], cells)
  const replies = [await useon(world), await useon(world)]
  assert.deepStrictEqual({ used: world.used, replies }, {
    used: [21],
    replies: [{ used: 'wheat', on: 'cow', at: { x: 2.5, y: 64, z: 0.5 } }, { ok: false, used: null, on: 'cow', note: 'every cow in sight was offered wheat within the last 5 minutes, at=x,y,z names one directly' }]
  })
})

test('useon feeds a cow it passed over once the cow stands in swing reach', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5)], closedPen())
  assert.deepStrictEqual(await useon(world), skipped('no walk puts the cow at 6,64,0 in swing reach', 0))
  world.bot.entity.position = new Vec3(1.5, 64, 0.5)
  world.bot.entities[21].position = new Vec3(3.5, 64, 0.5)
  await useon(world)
  assert.deepStrictEqual(world.used, [21])
})

test('a planner Timeout passes over nothing, and a GoalChanged without a take stays an error that passes over nothing', async (t) => {
  // With no field fence round the pen, every search runs out of think time.
  const world = await plannedUseon(t, [cow(21, 6.5)], fenced(2, -4, 10, 4))
  world.pathfinder.thinkTimeout = 1000
  const timedOut = { ok: false, used: null, on: 'cow', at: { x: 6, y: 64, z: 0 }, reason: 'the pathfinder ran out of think time on the walk to the cow at 6,64,0' }
  const replies = [await useon(world), await useon(world)]
  assert.deepStrictEqual({ replies, goal: world.pathfinder.goal, used: world.used }, { replies: [timedOut, timedOut], goal: null, used: [] })
  const changed = await plannedUseon(t, [cow(21, 6.5)])
  const { pathfinder } = changed
  const plan = pathfinder.goto
  pathfinder.goto = async () => { throw named('GoalChanged', 'The goal was changed before it could be completed!') }
  const { handle, res } = routeHandler('/useon', changed.env)
  await handle({ query: { name: 'cow', item: 'wheat' } }, res)
  assert.strictEqual(res.error && res.error.message, 'The goal was changed before it could be completed!')
  pathfinder.goto = plan
  await useon(changed)
  assert.deepStrictEqual(changed.used, [21])
})

test('useon shears a sheep, feeds it wheat and shears the other sheep, and takes the nearest cow or wolf for a bucket or a bone every call with no note', async (t) => {
  const flock = await plannedUseon(t, [as('sheep', cow(21, 2.5)), as('sheep', cow(22, 4.5))])
  for (const item of ['shears', 'wheat', 'shears']) await useon(flock, item, 'sheep')
  assert.deepStrictEqual(flock.used, [21, 21, 22])
  for (const [item, name] of [['bucket', 'cow'], ['bone', 'wolf']]) {
    const world = await plannedUseon(t, [as(name, cow(21, 2.5)), as(name, cow(22, 4.5))])
    world.setSlot(13, { name: 'bucket', count: 3 })
    const notes = []
    for (let i = 0; i < 3; i++) notes.push((await useon(world, item, name)).note)
    assert.deepStrictEqual({ used: world.used, notes }, { used: [21, 21, 21], notes: [undefined, undefined, undefined] }, item)
  }
})

test('useon on three cows feeds a different cow each call, then refuses with a note and clicks nothing', async (t) => {
  const world = await plannedUseon(t, [cow(21, 2.5), cow(22, 4.5), cow(23, 6.5)])
  for (let i = 0; i < 3; i++) await useon(world)
  const refused = await useon(world)
  assert.deepStrictEqual({ used: world.used, refused }, {
    used: [21, 22, 23],
    refused: { ok: false, used: null, on: 'cow', note: 'every cow in sight was offered wheat within the last 5 minutes, at=x,y,z names one directly' }
  })
})

test('useon passes over a cow fed wheat until 5 minutes after the feed', async (t) => {
  for (const [waitMs, next] of [[5 * 60 * 1000 - 1000, 22], [5 * 60 * 1000, 21]]) {
    const world = await plannedUseon(t, [cow(21, 2.5), cow(22, 3.0)])
    await useon(world)
    world.clock.advance(waitMs)
    await useon(world)
    assert.deepStrictEqual(world.used, [21, next], `${waitMs} ms after the feed`)
  }
})

const noWalk = 'no walk puts the cow at 6,64,0 in swing reach'

test('useon passes over a cow after a failed walk while the body stays put, and walks to it again once the body stands 3 blocks off', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5)], closedPen())
  const replies = [await useon(world), await useon(world)]
  world.bot.entity.position = new Vec3(0.5, 64, 3.5)
  replies.push(await useon(world))
  assert.deepStrictEqual({ reasons: replies.map((r) => r.reason), walks: world.walks.length, used: world.used }, { reasons: [noWalk, undefined, noWalk], walks: 2, used: [] })
})

test('useon still passes over a cow after a failed walk once the body moved 1.5 blocks', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5)], closedPen())
  await useon(world)
  world.bot.entity.position = new Vec3(0.5, 64, 2)
  const refused = await useon(world)
  assert.deepStrictEqual({ reason: refused.reason, walks: world.walks.length, used: world.used }, { reason: undefined, walks: 1, used: [] })
})

test('a useon refusal over a cow fed and a cow passed over names both, and both ways out', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5), cow(22, -2.5)], closedPen())
  await useon(world)
  await useon(world)
  const refused = await useon(world)
  assert.deepStrictEqual({ refused, used: world.used }, {
    refused: { ok: false, used: null, on: 'cow', note: 'every cow in sight was offered wheat or had a failed walk within the last 5 minutes, moving over 2 blocks from where the walks failed lifts their pass-overs, or at=x,y,z names one directly' },
    used: [22]
  })
})

test('useon with at feeds the cow nearest that point over a nearer one, and counts it fed', async (t) => {
  const world = await plannedUseon(t, [cow(21, 2.5), cow(22, 4.5)])
  const replies = [await useon(world, 'wheat', 'cow', '4,64,0'), await useon(world), await useon(world)]
  assert.deepStrictEqual({ replies, used: world.used }, {
    replies: [
      { used: 'wheat', on: 'cow', at: { x: 4.5, y: 64, z: 0.5 } },
      { used: 'wheat', on: 'cow', at: { x: 2.5, y: 64, z: 0.5 } },
      { ok: false, used: null, on: 'cow', note: 'every cow in sight was offered wheat within the last 5 minutes, at=x,y,z names one directly' }
    ],
    used: [22, 21]
  })
})

test('useon with at feeds a cow it fed within 5 minutes, and a cow it passed over after a failed walk', async (t) => {
  const fed = await plannedUseon(t, [cow(21, 2.5), cow(22, 4.5)])
  await useon(fed)
  await useon(fed, 'wheat', 'cow', '2,64,0')
  assert.deepStrictEqual(fed.used, [21, 21], 'fed within 5 minutes')
  const passed = await plannedUseon(t, [cow(21, 6.5), cow(22, -8.5)])
  const { bot, pathfinder } = passed
  const plan = pathfinder.goto
  pathfinder.goto = async (goal) => {
    pathfinder.setGoal(goal)
    bot.emit('path_update', { status: 'success', path: [] })
  }
  const short = await useon(passed)
  pathfinder.goto = plan
  await useon(passed, 'wheat', 'cow', '6,64,0')
  assert.deepStrictEqual({ short: short.reason, used: passed.used }, { short: 'the walk to the cow at 6,64,0 ended out of swing reach', used: [21] })
})

test('a failed walk to a cow picked by at passes it over', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5), cow(22, -8.5)], closedPen())
  const first = await useon(world, 'wheat', 'cow', '6,64,0')
  await useon(world)
  assert.deepStrictEqual({ first: first.reason, used: world.used }, { first: noWalk, used: [22] })
})

test('useon with at refuses when no cow stands within 2 blocks across or 2 up of the point, and clicks nothing', async (t) => {
  const world = await plannedUseon(t, [cow(21, 2.5), cow(22, 6.5)])
  const errors = []
  for (const at of ['4.5,64,3', '2,67,0']) {
    const { handle, res } = routeHandler('/useon', world.env)
    await handle({ query: { name: 'cow', item: 'wheat', at } }, res)
    errors.push(res.error && res.error.message)
  }
  assert.deepStrictEqual({ errors, walks: world.walks.length, used: world.used }, {
    errors: ['no cow in sight within 2 blocks of 4.5,64,3', 'no cow in sight within 2 blocks of 2,67,0'],
    walks: 0,
    used: []
  })
})

// A walking pace in blocks a second.
const PACE = 4.3
const GATE = ['oak_fence_gate', { facing: 'east', open: 'false', in_wall: 'false', powered: 'false' }]
const farGate = () => fenced(3, -8, 13, 8, { '13,0': GATE })
const stalled = (left) => skipped('the walk to the cow at 6,64,0 gave up out of swing reach (no block of progress in 4.5 s, or over 60 s in all)', left)

test('a useon walk follows a cow that drifts half a block twice on the way, and feeds it', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5)], {}, undefined, PACE)
  const { bot, clock } = world
  clock.setTimeout(() => { bot.entities[21].position = new Vec3(7, 64, 0.5) }, 250)
  clock.setTimeout(() => { bot.entities[21].position = new Vec3(7.5, 64, 0.5) }, 500)
  const reply = await useon(world)
  assert.deepStrictEqual({ reply, used: world.used, goal: world.pathfinder.goal, plans: world.walks.length }, { reply: { used: 'wheat', on: 'cow', at: { x: 7.5, y: 64, z: 0.5 } }, used: [21], goal: null, plans: 3 })
})

test('a useon walk to a cow drifting 0.3 blocks a tick in a gated pen clicks the gate once, walks through it open and feeds the cow', async (t) => {
  const cells = fenced(-10, -8, 14, 8, {}, fenced(4, -4, 14, 4, { '4,0': GATE }))
  const world = await plannedUseon(t, [cow(21, 13.5)], cells, undefined, PACE)
  const drifter = world.bot.entities[21]
  world.clock.setInterval(() => { drifter.position = new Vec3(13.5, 64, drifter.position.z === 0.5 ? 0.8 : 0.5) }, 50)
  const { used, on } = await useon(world)
  assert.deepStrictEqual({ used, on, fed: world.used, clicks: world.clicks, gate: cells['4,64,0'][1].open }, { used: 'wheat', on: 'cow', fed: [21], clicks: ['4,64,0'], gate: 'true' })
})

test('a useon walk through a gate on the far side of a pen goes on past 6 s while it makes progress, and feeds the cow inside', async (t) => {
  const world = await plannedUseon(t, [cow(21, 8.5)], farGate(), undefined, PACE)
  const reply = await useon(world)
  assert.deepStrictEqual({ reply, used: world.used }, { reply: { used: 'wheat', on: 'cow', at: { x: 8.5, y: 64, z: 0.5 } }, used: [21] })
  assert.ok(world.clock.now() > rules.STRIKE_APPROACH_MS, `control: the walk took ${world.clock.now()} ms`)
})

test('a useon walk that makes no progress for 4.5 s passes the cow over and leaves no goal', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5), cow(22, -6.5)], {}, undefined, PACE)
  world.clock.setTimeout(() => { world.frozen = true }, 300)
  const reply = await useon(world)
  const waited = world.clock.now() - 300
  assert.deepStrictEqual({ reply, goal: world.pathfinder.goal, used: world.used }, { reply: stalled(1), goal: null, used: [] })
  assert.ok(waited >= botConstant('COLLECT_STALL_MS') && waited < botConstant('COLLECT_STALL_MS') + 1000, `answered ${waited} ms after the body stopped`)
  world.frozen = false
  await useon(world)
  assert.deepStrictEqual(world.used, [22])
})

test('a useon walk still making progress gives up at 60 s, passes the cow over and leaves no goal', async (t) => {
  // A body at 0.35 blocks a second takes over 60 s to the gate.
  const world = await plannedUseon(t, [cow(21, 6.5)], farGate(), undefined, 0.35)
  const reply = await useon(world)
  const cap = botConstant('COLLECT_BUDGET_MS')
  assert.deepStrictEqual({ reply, goal: world.pathfinder.goal, used: world.used }, { reply: stalled(0), goal: null, used: [] })
  assert.ok(world.clock.now() >= cap && world.clock.now() < cap + 500, `answered at ${world.clock.now()} ms`)
})

test('a useon walk the unstuck reflex takes passes the cow over, naming the reflex', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5), cow(22, -6.5)])
  const { bot, env, clock, pathfinder } = world
  const plan = pathfinder.goto
  pathfinder.goto = (goal) => new Promise((resolve, reject) => {
    pathfinder.setGoal(goal)
    bot.once('path_stop', () => reject(named('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.')))
    clock.setTimeout(() => env.legs.take('unstuck', 'free the body from a wedge'), 500)
  })
  const reply = await useon(world)
  assert.deepStrictEqual({ reply, goal: pathfinder.goal }, { reply: skipped('the unstuck reflex took the legs to free the body from a wedge on the walk to the cow at 6,64,0', 1), goal: null })
  pathfinder.goto = plan
  await useon(world)
  assert.deepStrictEqual(world.used, [22])
})

test('a useon walk the unstuck reflex takes answers once the reflex is done, leaves no goal its ladder set again and passes the cow over', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5), cow(22, -6.5)])
  const { bot, env, clock, pathfinder } = world
  const unstuck = { name: 'unstuck', active: false }
  env.reflexes.push(unstuck)
  const plan = pathfinder.goto
  pathfinder.goto = (goal) => new Promise((resolve, reject) => {
    pathfinder.setGoal(goal)
    bot.once('path_stop', () => reject(named('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.')))
    clock.setTimeout(() => {
      unstuck.active = true
      env.legs.take('unstuck', 'free the body from a wedge')
      env.stopPath()
    }, 500)
    clock.setTimeout(() => pathfinder.setGoal(goal), 1500)
    clock.setTimeout(() => { unstuck.active = false }, 3000)
  })
  let atReply = null
  env.ok = (res, body) => {
    res.body = body
    atReply = { late: clock.now() >= 3000, active: unstuck.active, goal: pathfinder.goal }
  }
  const reply = await useon(world)
  clock.advance(3000)
  assert.deepStrictEqual({ reply, atReply, afterLadder: pathfinder.goal }, {
    reply: skipped('the unstuck reflex took the legs to free the body from a wedge on the walk to the cow at 6,64,0', 1),
    atReply: { late: true, active: false, goal: null },
    afterLadder: null
  })
  pathfinder.goto = plan
  await useon(world)
  assert.deepStrictEqual({ used: world.used, goal: pathfinder.goal }, { used: [22], goal: null })
})

// Cells the bot has not seen across the field from fence to fence at x 2 and 3, floor to head.
function unseenStrip () {
  const unseen = new Set()
  for (const x of [2, 3]) {
    for (let z = -7; z <= 7; z++) {
      for (const y of [63, 64, 65]) unseen.add(`${x},${y},${z}`)
    }
  }
  return unseen
}

test('a useon walk with no known way past unseen ground names that ground, passes over nothing and takes the same cow next call', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5), cow(22, -6.5)], fenced(-10, -8, 14, 8), undefined, null, unseenStrip())
  const blocked = { ok: false, used: null, on: 'cow', at: { x: 6, y: 64, z: 0 }, reason: 'unseen ground lies between me and the cow at 6,64,0' }
  const replies = [await useon(world), await useon(world)]
  assert.deepStrictEqual({ replies, passedOver: [...world.env.walkFailed.keys()], goal: world.pathfinder.goal, used: world.used }, {
    replies: [blocked, blocked],
    passedOver: [],
    goal: null,
    used: []
  })
})

test('a useon walk whose plan past unseen ground runs out of time says so, passes over nothing and takes the same cow next call', async (t) => {
  const world = await plannedUseon(t, [cow(21, 6.5), cow(22, -6.5)], fenced(-10, -8, 14, 8), undefined, null, unseenStrip())
  // A negative budget ends the search at its first step.
  world.env.UNSEEN_PLAN_MS = -1
  const outOfTime = { ok: false, used: null, on: 'cow', at: { x: 6, y: 64, z: 0 }, reason: 'the search for a way past unseen ground to the cow at 6,64,0 ran out of time' }
  const replies = [await useon(world), await useon(world)]
  assert.deepStrictEqual({ replies, passedOver: [...world.env.walkFailed.keys()], goal: world.pathfinder.goal, used: world.used }, {
    replies: [outOfTime, outOfTime],
    passedOver: [],
    goal: null,
    used: []
  })
})

// The field with a cow at 6,64,0 walled in stone but for window at 5,64,0, a gap seen through from the 1-deep pit at 4,63,0.
function walledCow (window) {
  const cells = fenced(-10, -8, 14, 8)
  for (let x = 5; x <= 7; x++) {
    for (let z = -1; z <= 1; z++) {
      for (const y of [64, 65]) cells[`${x},${y},${z}`] = ['stone', {}]
    }
  }
  delete cells['6,64,0']
  cells['5,64,0'] = [window, {}]
  cells['4,63,0'] = ['air', {}]
  return cells
}

test('a useon plan past unseen ground answers the same over an unseen stone or air in the way of the swing, and reads no unseen block', async (t) => {
  const blocked = { ok: false, used: null, on: 'cow', at: { x: 6, y: 64, z: 0 }, reason: 'unseen ground lies between me and the cow at 6,64,0' }
  const replies = []
  const reads = []
  for (const window of ['stone', 'air']) {
    const unseen = unseenStrip().add('5,64,0')
    const world = await plannedUseon(t, [cow(21, 6.5)], walledCow(window), undefined, null, unseen)
    const { bot, pathfinder } = world
    // The unseen cells the route reads while the unseen-ground search runs.
    const read = new Set()
    let open = false
    const blockAt = bot.blockAt
    bot.blockAt = (p) => {
      const c = p.floored()
      if (open && unseen.has(`${c.x},${c.y},${c.z}`)) read.add(`${c.x},${c.y},${c.z}`)
      return blockAt(p)
    }
    const search = pathfinder.getPathFromTo
    pathfinder.getPathFromTo = function * (moves, ...rest) {
      const steps = search.call(this, moves, ...rest)
      for (;;) {
        open = moves !== pathfinder.movements
        const step = steps.next()
        open = false
        if (step.done) return
        yield step.value
      }
    }
    replies.push(await useon(world))
    reads.push([...read])
  }
  assert.deepStrictEqual({ replies, reads }, { replies: [blocked, blocked], reads: [[], []] })
})

test('a useon plan past unseen ground swings through no open gate it knows only by its shape, and passes the cow over', async (t) => {
  const cells = walledCow('air')
  cells['5,64,0'] = ['oak_fence_gate', { facing: 'east', open: 'true', in_wall: 'false', powered: 'false' }]
  const world = await plannedUseon(t, [cow(21, 6.5)], cells, undefined, null, unseenStrip(), new Map([['5,64,0', 'solid']]))
  assert.deepStrictEqual({ reply: await useon(world), used: world.used }, { reply: skipped(noWalk, 0), used: [] })
})

test('a useon walk that ends out of swing reach once a block shows in the swing line plans once more and feeds the cow from another cell', async (t) => {
  const pillar = ['5,64,0', '5,65,0']
  for (const how of ['placed on the way', 'seen on the way']) {
    const cells = fenced(-10, -8, 14, 8)
    const unseen = new Set()
    if (how === 'seen on the way') {
      for (const k of pillar) {
        cells[k] = ['stone', {}]
        unseen.add(k)
      }
    }
    const world = await plannedUseon(t, [cow(21, 6.5)], cells, undefined, PACE, unseen)
    const { watchGoto } = loadBotFunctions(['watchGoto'], { ...world.env, guardWork: (work, o) => guardWork(work, { ...o, clock: world.clock }), watchScope: new AsyncLocalStorage(), litFuse: () => null })
    world.pathfinder.goto = watchGoto(world.pathfinder.goto)
    const ends = []
    world.bot.on('path_update', (r) => ends.push(r.path.length ? r.path[r.path.length - 1].floored().toArray() : null))
    world.bot.once('path_update', () => {
      for (const k of pillar) cells[k] = ['stone', {}]
      unseen.clear()
    })
    const reply = await useon(world)
    assert.deepStrictEqual({ reply, firstEnd: ends[0], plans: world.walks.length, passedOver: [...world.env.walkFailed.keys()], used: world.used }, {
      reply: fedAt(6.5),
      firstEnd: [3, 64, 0],
      plans: 2,
      passedOver: [],
      used: [21]
    }, how)
    assert.ok(world.replyAt < botConstant('COLLECT_STALL_MS'), `${how}: answered at ${world.replyAt} ms`)
  }
})

test('a useon reach goal reads a cell the bot has not seen as open air, under a node and beside the body', async (t) => {
  const hidden = { '3,63,0': ['oak_slab', { type: 'bottom', waterlogged: 'false' }], '1,64,0': FENCE }
  const judged = async (cells, unseen) => {
    const world = await plannedUseon(t, [cow(21, 4.3)], cells, new Vec3(1.1, 64, 0.5), null, unseen)
    const { meleeReachGoal } = loadBotFunctions(['meleeReachGoal'], { ...world.env })
    const goal = meleeReachGoal(world.bot.entities[21], 0.6, true)
    const nodes = []
    for (let x = -1; x <= 6; x++) {
      for (let z = -1; z <= 1; z++) nodes.push(new Vec3(x, 64, z))
    }
    return nodes.map((n) => `${n} ${goal.heuristic(n).toFixed(3)} ${goal.isEnd(n)}`)
  }
  assert.deepStrictEqual(await judged({ ...hidden }, new Set(Object.keys(hidden))), await judged({}, new Set()))
})

test('a useon reach goal counts a fence it knows only by its shape as a wall, and passes over the cow behind it', async (t) => {
  const pen = fenced(4, -3, 8, 3)
  const cells = fenced(-10, -8, 14, 8, {}, { ...pen })
  const known = await plannedUseon(t, [cow(21, 5.5)], cells)
  assert.deepStrictEqual(await useon(known), fedAt(5.5), 'control: a seen fence')
  const shapes = new Map(Object.keys(pen).map((k) => [k, 'solid']))
  const world = await plannedUseon(t, [cow(21, 5.5)], cells, undefined, null, null, shapes)
  const reply = await useon(world)
  assert.deepStrictEqual({ reason: reply.reason, used: world.used }, { reason: 'no walk puts the cow at 5,64,0 in swing reach', used: [] })
})

test('useon feeds a cow past a block it has not seen in the swing line from where it stands, with no walk', async (t) => {
  const wall = ['1,64,0', '1,65,0']
  const cells = fenced(-10, -8, 14, 8)
  for (const k of wall) cells[k] = ['stone', {}]
  const world = await plannedUseon(t, [cow(21, 2.5)], cells, undefined, PACE, new Set(wall))
  const reply = await useon(world)
  assert.deepStrictEqual({ reply, plans: world.walks.length, at: world.bot.entity.position.toArray(), used: world.used }, {
    reply: fedAt(2.5),
    plans: 0,
    at: [0.5, 64, 0.5],
    used: [21]
  })
})

test('a useon that ends stopped or loses sight of its cow leaves that cow first in line', async (t) => {
  const stopped = await plannedUseon(t, [cow(21, 6.5), cow(22, 9.5)])
  const { pathfinder } = stopped
  const plan = pathfinder.goto
  pathfinder.goto = (goal) => new Promise((resolve, reject) => {
    pathfinder.setGoal(goal)
    stopped.bot.once('path_stop', () => reject(named('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.')))
    stopped.clock.setTimeout(() => {
      stopped.env.legs.take(null)
      stopped.env.stopPath()
    }, 500)
  })
  assert.deepStrictEqual(await useon(stopped), { used: null, on: 'cow', reason: 'stopped' })
  pathfinder.goto = plan
  await useon(stopped)
  assert.deepStrictEqual(stopped.used, [21], 'after a stop')
  const lost = await plannedUseon(t, [cow(21, 6.5), cow(22, 9.5)])
  const lostPlan = lost.pathfinder.goto
  lost.pathfinder.goto = async (goal) => {
    await lostPlan(goal)
    lost.bot.entities[21].seen = false
  }
  assert.strictEqual((await useon(lost)).reason, 'lost sight')
  lost.bot.entities[21].seen = true
  lost.pathfinder.goto = lostPlan
  await useon(lost)
  assert.deepStrictEqual(lost.used, [21], 'after lost sight')
})

const meta = (name, key, value) => {
  const m = []
  m[mcData.entitiesByName[name].metadataKeys.indexOf(key)] = value
  return m
}
const calf = (id, x) => ({ ...cow(id, x), metadata: meta('cow', 'baby', true) })
const tookNothing = 'the server took nothing within 0.5 s of the click'
const notFed = `${tookNothing}, the cow may be a baby, in love or on its breeding cooldown`
const fedAt = (x) => ({ used: 'wheat', on: 'cow', at: { x, y: 64, z: 0.5 } })
const ignored = (left) => ({
  ok: false,
  used: null,
  on: 'cow',
  at: { x: 2, y: 64, z: 0 },
  reason: notFed,
  note: `passed over for wheat for up to 5 minutes, ${left ? `the next call picks another cow, ${left} left in sight` : 'no other cow in sight is left to pick'}, at=x,y,z names one directly`
})
const inLove = (id, x) => ({ ...cow(id, x), inLove: true })

test('a useon click the server ignores passes that cow over, says the server took nothing and names the next pick', async (t) => {
  const world = await plannedUseon(t, [inLove(21, 2.5), cow(22, 4.5)])
  const replies = [await useon(world), await useon(world)]
  assert.deepStrictEqual({ replies, used: world.used }, { replies: [ignored(1), fedAt(4.5)], used: [21, 22] })
})

test('a useon reply to an ignored click lands 500 to 510 ms after the click, also while the server sends no ages', async (t) => {
  const delays = []
  for (const ages of [true, false]) {
    const world = await plannedUseon(t, [inLove(21, 2.5)])
    world.ages = ages
    await useon(world)
    delays.push(world.replyAt - world.clickAt)
  }
  assert.deepStrictEqual(delays.map((d) => d >= 500 && d <= 510), [true, true], `replies ${delays.join(' and ')} ms after the click`)
})

test('a useon counts no pickup into the clicked wheat as a use', async (t) => {
  const world = await plannedUseon(t, [inLove(21, 2.5), cow(22, 4.5)])
  const { slots } = world.bot.inventory
  world.afterClick = [[200, (slot) => world.setSlot(slot, { ...slots[slot], count: slots[slot].count + 1 })]]
  const reply = await useon(world)
  assert.deepStrictEqual({ reply, recent: [...world.env.usedOn.keys()], wheat: slots[36].count }, { reply: ignored(1), recent: ['21 wheat'], wheat: 65 })
})

test('a useon counts no guard swap in the window as a use and answers through it, and counts the take that follows it', async (t) => {
  const got = []
  for (const en of [inLove(21, 2.5), cow(21, 2.5)]) {
    const world = await plannedUseon(t, [en, cow(22, 4.5)])
    const { bot, setSlot } = world
    const { slots } = bot.inventory
    world.answerMs = 400
    world.afterClick = [
      [100, () => setSlot(20, { name: 'stick', count: 1 })],
      [150, (slot) => {
        const wheat = slots[slot]
        setSlot(slot, { name: 'iron_sword', count: 1 })
        setSlot(15, wheat)
      }],
      [250, (slot) => {
        const wheat = slots[15]
        setSlot(15, null)
        setSlot(slot, wheat)
      }],
      [300, () => {
        bot.quickBarSlot = 1
        setSlot(37, { name: 'iron_sword', count: 1 })
      }],
      [350, () => {
        bot.quickBarSlot = 0
        bot.heldItem = slots[36]
        bot.emit('heldItemChanged', bot.heldItem)
      }]
    ]
    const reply = await useon(world)
    got.push({ reply, after: world.replyAt - world.clickAt, recent: world.env.usedOn.size })
  }
  assert.deepStrictEqual(got, [
    { reply: ignored(1), after: 500, recent: 1 },
    { reply: fedAt(2.5), after: 400, recent: 1 }
  ])
})

test('a useon records the pass-over at the click, and a take 1.4 s after it, past the ok:false reply, records nothing more', async (t) => {
  const world = await plannedUseon(t, [cow(21, 2.5), cow(22, 4.5)])
  world.answerMs = 1400
  const first = await useon(world)
  world.clock.advance(1000)
  const recorded = world.env.usedOn.get('21 wheat')?.time - world.clickAt
  world.answerMs = 100
  const next = await useon(world)
  assert.deepStrictEqual({ first, recorded, next, used: world.used }, { first: ignored(1), recorded: 0, next: fedAt(4.5), used: [21, 22] })
})

// The route's listeners for the server's answer to a click.
const watchers = (bot) => ({ slot: bot.inventory.listenerCount('updateSlot'), update: bot.listenerCount('entityUpdate'), gone: bot.listenerCount('entityGone'), status: bot._client.listenerCount('entity_status') })

test('a useon leaves no watch for the server\'s answer once its window closes, it sees a take or its click throws', async (t) => {
  const pairs = [['wheat', () => cow(21, 2.5)], ['shears', () => as('sheep', cow(21, 2.5))], ['shears', () => as('mooshroom', cow(21, 2.5))], ['bucket', () => cow(21, 2.5)]]
  const got = []
  const want = []
  for (const [item, creature] of pairs) {
    for (const exit of ['closed', 'taken', 'thrown']) {
      const en = creature()
      const world = await plannedUseon(t, [en])
      const before = watchers(world.bot)
      if (exit === 'closed') world.answer = () => null
      if (exit === 'taken' && en.name === 'mooshroom') world.answer = (held) => ({ ...held })
      if (exit === 'thrown') world.bot.useOn = async () => { throw new Error('the click failed') }
      const res = await driveUseon(world, item, en.name)
      const pair = `${item} on ${en.name} ${exit}`
      got.push({ pair, answer: res.error ? res.error.message : res.body.used, left: watchers(world.bot) })
      want.push({ pair, answer: exit === 'thrown' ? 'the click failed' : exit === 'taken' ? item : null, left: before })
    }
  }
  assert.deepStrictEqual(got, want)
})

test('useon passes over a calf for wheat and feeds the adult cow beside it, then names the calf in its refusal', async (t) => {
  const world = await plannedUseon(t, [calf(21, 2.5), cow(22, 3.5)])
  const fed = await useon(world)
  const refused = await useon(world)
  assert.deepStrictEqual({ fed, refused, used: world.used }, {
    fed: { used: 'wheat', on: 'cow', at: { x: 3.5, y: 64, z: 0.5 } },
    refused: { ok: false, used: null, on: 'cow', note: 'every cow in sight is a baby or was offered wheat within the last 5 minutes, at=x,y,z names one directly' },
    used: [22]
  })
  const calves = await plannedUseon(t, [calf(21, 2.5)])
  assert.deepStrictEqual({ refused: await useon(calves), used: calves.used }, { refused: { ok: false, used: null, on: 'cow', note: 'every cow in sight is a baby' }, used: [] })
})

test('useon passes over a sheared sheep for shears and shears the one beside it', async (t) => {
  // Wool 30 is a sheared red sheep, 3 an unsheared light blue one.
  const flock = [{ ...as('sheep', cow(31, 2.5)), metadata: meta('sheep', 'wool', 30) }, { ...as('sheep', cow(32, 4.5)), metadata: meta('sheep', 'wool', 3) }]
  const world = await plannedUseon(t, flock)
  const sheared = await useon(world, 'shears', 'sheep')
  const refused = await useon(world, 'shears', 'sheep')
  assert.deepStrictEqual({ sheared, refused, used: world.used }, {
    sheared: { used: 'shears', on: 'sheep', at: { x: 4.5, y: 64, z: 0.5 } },
    refused: { ok: false, used: null, on: 'sheep', note: 'every sheep in sight is sheared or was offered shears within the last 5 minutes, at=x,y,z names one directly' },
    used: [32]
  })
})

test('useon with at on a calf clicks it with wheat, says the server took nothing and passes the calf over', async (t) => {
  const world = await plannedUseon(t, [calf(21, 2.5), cow(22, 6.5)])
  const reply = await useon(world, 'wheat', 'cow', '2,64,0')
  assert.deepStrictEqual({ reply, used: world.used, recent: [...world.env.usedOn.keys()] }, {
    reply: ignored(1),
    used: [21],
    recent: ['21 wheat']
  })
})

test('a useon counts a bucket on a cow once the slot holds milk, and not a resend of the same bucket', async (t) => {
  const milked = await plannedUseon(t, [cow(21, 2.5)])
  const resent = await plannedUseon(t, [cow(21, 2.5)])
  resent.answer = (held) => ({ ...held })
  assert.deepStrictEqual({ milked: await useon(milked, 'bucket'), resent: await useon(resent, 'bucket') }, {
    milked: { used: 'bucket', on: 'cow', at: { x: 2.5, y: 64, z: 0.5 } },
    resent: { ok: false, used: null, on: 'cow', at: { x: 2, y: 64, z: 0 }, reason: tookNothing }
  })
})

test('a useon counts a bowl on a mooshroom once the slot holds mushroom stew, and not a resend of the same bowl', async (t) => {
  const stewed = await plannedUseon(t, [as('mooshroom', cow(21, 2.5))])
  const resent = await plannedUseon(t, [as('mooshroom', cow(21, 2.5))])
  for (const world of [stewed, resent]) world.setSlot(15, { name: 'bowl', count: 1 })
  resent.answer = (held) => ({ ...held })
  assert.deepStrictEqual({ stewed: await useon(stewed, 'bowl', 'mooshroom'), resent: await useon(resent, 'bowl', 'mooshroom') }, {
    stewed: { used: 'bowl', on: 'mooshroom', at: { x: 2.5, y: 64, z: 0.5 } },
    resent: { ok: false, used: null, on: 'mooshroom', at: { x: 2, y: 64, z: 0 }, reason: tookNothing }
  })
})

test('a useon answers a slot update 450 ms after the click as a use and not one 600 ms after it', async (t) => {
  const replies = []
  for (const ms of [450, 600]) {
    const world = await plannedUseon(t, [cow(21, 2.5)])
    world.answerMs = ms
    replies.push({ reply: await useon(world), recent: world.env.usedOn.size })
  }
  assert.deepStrictEqual(replies, [
    { reply: fedAt(2.5), recent: 1 },
    { reply: ignored(0), recent: 1 }
  ])
})

test('a useon counts no love hearts a cow shows after its window for the next click, on a cow in love', async (t) => {
  const world = await plannedUseon(t, [cow(21, 2.5), inLove(22, 4.5)])
  world.answerMs = 900
  const first = await useon(world)
  const hearts = world.clickAt + 900
  const second = await useon(world)
  assert.deepStrictEqual({ first, second, heartsInWindow: hearts > world.clickAt && hearts < world.replyAt, used: world.used }, {
    first: ignored(1),
    second: { ...ignored(0), at: { x: 4, y: 64, z: 0 } },
    heartsInWindow: true,
    used: [21, 22]
  })
})

test('a useon counts shears that shear the sheep and wear nothing as a use', async (t) => {
  const world = await plannedUseon(t, [as('sheep', cow(31, 2.5))])
  world.answer = (held) => ({ ...held })
  const reply = await useon(world, 'shears', 'sheep')
  assert.deepStrictEqual({ reply, worn: world.bot.inventory.slots[36].durabilityUsed }, { reply: { used: 'shears', on: 'sheep', at: { x: 2.5, y: 64, z: 0.5 } }, worn: 0 })
})

// The three window clicks of mineflayer's equip of a sword from slot 20 into the clicked slot, from ms after the click.
function swordSwap (world, ms) {
  const inv = world.bot.inventory
  world.setSlot(20, { name: 'iron_sword', count: 1 })
  return [
    [ms, () => {
      inv.selectedItem = inv.slots[20]
      world.setSlot(20, null)
    }],
    // As prismarine-windows swapSelectedItem, the slot update comes before the cursor takes the clicked stack.
    [ms + 20, (slot) => {
      const held = inv.slots[slot]
      world.setSlot(slot, inv.selectedItem)
      inv.selectedItem = held
    }],
    [ms + 50, () => {
      world.setSlot(20, inv.selectedItem)
      inv.selectedItem = null
    }]
  ]
}

test('a useon counts a take that lands in another slot after a guard swap moved the clicked stack, for a bucket and for wheat on a cow', async (t) => {
  const got = []
  for (const item of ['bucket', 'wheat']) {
    const world = await plannedUseon(t, [cow(21, 2.5)])
    const { slots } = world.bot.inventory
    world.answer = () => null
    world.afterClick = [...swordSwap(world, 100), [200, () => {
      world.setSlot(20, item === 'bucket' ? { name: 'milk_bucket', count: 1 } : { ...slots[20], count: slots[20].count - 1 })
      if (item === 'wheat') world.bot._client.emit('entity_status', { entityId: 21, entityStatus: 18 })
    }]]
    got.push({ reply: await useon(world, item), after: world.replyAt - world.clickAt })
  }
  assert.deepStrictEqual(got, [{ reply: { used: 'bucket', on: 'cow', at: { x: 2.5, y: 64, z: 0.5 } }, after: 200 }, { reply: fedAt(2.5), after: 200 }])
})

test('a useon counts no guard swap that moves the clicked bucket as a take', async (t) => {
  const world = await plannedUseon(t, [cow(21, 2.5)])
  world.answer = () => null
  world.afterClick = swordSwap(world, 100)
  const reply = await useon(world, 'bucket')
  assert.deepStrictEqual({ reply, after: world.replyAt - world.clickAt, bucket: world.bot.inventory.slots[20]?.name }, {
    reply: { ok: false, used: null, on: 'cow', at: { x: 2, y: 64, z: 0 }, reason: tookNothing },
    after: 500,
    bucket: 'bucket'
  })
})

test('a useon counts wheat a cow eats as a use when a pickup into the stack hides the take', async (t) => {
  const world = await plannedUseon(t, [cow(21, 2.5)])
  world.answer = (held) => ({ ...held })
  const reply = await useon(world)
  assert.deepStrictEqual({ reply, wheat: world.bot.inventory.slots[36].count }, { reply: fedAt(2.5), wheat: 64 })
})

test('a useon counts shears on a mooshroom as a use once the mooshroom is gone', async (t) => {
  const world = await plannedUseon(t, [as('mooshroom', cow(21, 2.5))])
  world.answer = (held) => ({ ...held })
  assert.deepStrictEqual(await useon(world, 'shears', 'mooshroom'), { used: 'shears', on: 'mooshroom', at: { x: 2.5, y: 64, z: 0.5 } })
})

test('a useon counts wheat a horse takes by the count, and wheat a cow takes only by its love hearts', async (t) => {
  const got = []
  for (const name of ['horse', 'cow']) {
    const world = await plannedUseon(t, [as(name, cow(21, 2.5))])
    world.answer = () => null
    world.afterClick = [[100, (slot) => world.setSlot(slot, { ...world.bot.inventory.slots[slot], count: 63 })]]
    got.push({ name, used: (await useon(world, 'wheat', name)).used })
  }
  assert.deepStrictEqual(got, [{ name: 'horse', used: 'wheat' }, { name: 'cow', used: null }])
})

test('a useon bucket take within 5 s of an earlier click the server took nothing for notes that click, and not 5 s on', async (t) => {
  const got = []
  for (const waitMs of [0, 5000]) {
    const world = await plannedUseon(t, [cow(21, 2.5)])
    world.answer = () => null
    const missed = await useon(world, 'bucket')
    world.answer = null
    world.clock.advance(waitMs)
    got.push({ waitMs, missed: missed.used, taken: await useon(world, 'bucket') })
  }
  const milked = { used: 'bucket', on: 'cow', at: { x: 2.5, y: 64, z: 0.5 } }
  assert.deepStrictEqual(got, [
    { waitMs: 0, missed: null, taken: { ...milked, note: 'the bucket taken may belong to the earlier click on the cow at 2,64,0' } },
    { waitMs: 5000, missed: null, taken: milked }
  ])
})
