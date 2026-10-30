'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { goals } = require('mineflayer-pathfinder')
const rules = require('../lib/combat-rules')
const legacy1710 = require('../lib/bot/legacy-1710')
const { isDoor } = require('../lib/doors')
const { routeWithin, walkersTo, groundCell, walkFlood } = require('../lib/flee')
const { expireConfirmed, babyFlag } = require('../lib/shelter')
const { legLedger, takenText } = require('../lib/leg-ledger')
const { createLane } = require('../lib/bot/lane')
const vm = require('node:vm')
const { routeHandler, runRoute, awaitRoute, fakeClock, toolNamed, botConstant, botSource, balanced, loadBotFunctions, combatReflexIn, wireListeners, botObject, claimRescue } = require('./helpers')
const mcData = require('minecraft-data')('1.21.11')
const registry = require('prismarine-registry')('1.21.11')
const loadItem = require('prismarine-item')
const Item = loadItem(registry)
const Block = require('prismarine-block')(registry)
const Entity = require('prismarine-entity')(registry)
const FRAME_ITEM = mcData.entitiesByName.item_frame.metadataKeys.indexOf('item')

// seen says whether the body perceives the zombie.
const zombie = (x, seen = true) => ({ id: 7, name: 'zombie', width: 0.6, height: 1.95, seen, position: new Vec3(x, 64, 0.5) })

// did records the body's actions in order: walk, jump, swing, draw, use. hits holds each swing's time, the
// server's fall distance and whether the body stood on the ground. The floor is at y 63, solid cells
// start at y ceiling, and a walk ends 2 west of its goal, or of the aim point's cell for a melee reach goal.
// stop() runs the /stop handler over the world's leg ledger and pilot lane. stops() counts the calls of env.stopPath.
function verbWorld (entities, { legacy = false, ceiling = Infinity, recentre = false } = {}) {
  const clock = fakeClock()
  const did = []
  const hits = []
  const controls = {}
  let vy = 0
  let fall = 0
  // One tick of a jump, with the fall distance a 1.7.10 server keeps from the positions it receives.
  const tick = () => {
    const e = bot.entity
    if (controls.jump && e.onGround) {
      vy = 0.42
      e.onGround = false
    }
    if (e.onGround) return
    const y0 = e.position.y
    let y = y0 + vy
    if (y > ceiling - 1.8) {
      y = ceiling - 1.8
      vy = 0
    }
    vy = (vy - 0.08) * 0.98
    if (y <= 64) {
      y = 64
      vy = 0
      e.onGround = true
    }
    e.position = new Vec3(e.position.x, y, e.position.z)
    fall = e.onGround ? 0 : fall + Math.max(0, y0 - y)
  }
  clock.setInterval(tick, 50)
  clock.setInterval(() => bot.emit('physicsTick'), 50)
  const solid = (p) => p.y < 64 || p.y >= ceiling
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
    players: {},
    food: 20,
    heldItem: null,
    inventory: { items: () => ['iron_sword', 'bow', 'arrow', 'shears'].map((name) => ({ name })) },
    pathfinder: {
      goto: async (goal) => {
        did.push('walk')
        const at = goal.aim ? goal.aim.floored() : goal
        bot.entity.position = new Vec3(at.x - 1.5, 64, at.z + 0.5)
      },
      isMoving: () => false
    },
    blockAt: (p) => ({ name: solid(p) ? 'stone' : 'air', boundingBox: solid(p) ? 'block' : 'empty', shapes: solid(p) ? [[0, 0, 0, 1, 1, 1]] : [], position: p }),
    setControlState (c, s) {
      controls[c] = s
      if (c === 'jump' && s) did.push('jump')
    },
    equip: async (item) => { bot.heldItem = item },
    lookAt: async () => {},
    waitForTicks: (n) => new Promise((resolve) => clock.setTimeout(resolve, n * 50)),
    attack () {
      did.push('swing')
      hits.push({ t: clock.now(), fall, onGround: bot.entity.onGround })
    },
    useOn: async () => { did.push('use') },
    clearControlStates () {}
  })
  const fill = {}
  const mobHurt = rules.hurtWindows(clock.now)
  mobHurt.wire(bot)
  const lane = {}
  createLane(lane)
  lane.clearLane()
  lane.strikeRun.lane = null
  let stops = 0
  // The events of legs.js stopPath on a walking pathfinder: setGoal(null) clears the goal and emits goal_updated, then the
  // latched stop emits path_stop. With recentre, fullStop then moves the body to its cell centre on each axis it stands
  // more than 0.2 off.
  const pathStop = () => {
    stops++
    bot.pathfinder.goal = null
    bot.emit('goal_updated', null, false)
    bot.emit('path_stop')
    if (!recentre) return
    const p = bot.entity.position
    const centre = (v) => Math.abs(v - Math.floor(v) - 0.5) > 0.2 ? Math.floor(v) + 0.5 : v
    bot.entity.position = new Vec3(centre(p.x), p.y, centre(p.z))
  }
  const env = {
    bot,
    goals,
    shared: { ready: true, mcData },
    babyFlag,
    HEAVY_MELEE: botConstant('HEAVY_MELEE'),
    PROVOKABLE: botConstant('PROVOKABLE'),
    LEGACY_1710: legacy,
    LEGACY_HIT_MS: 550,
    mobHurt,
    knownCell: () => true,
    cellKnown: () => true,
    ck: (x, y, z) => x + ',' + y + ',' + z,
    isDoor,
    routeWithin,
    walkersTo,
    groundCell,
    walkFlood,
    WALK_MEMO: botConstant('WALK_MEMO'),
    REACH_MEMO: botConstant('REACH_MEMO'),
    WALK_STEPS: botConstant('WALK_STEPS'),
    WALK_CAP: botConstant('WALK_CAP'),
    perch: { cell: null },
    console: { log () {} },
    noCritReason: rules.noCritReason,
    noRunReason: rules.noRunReason,
    runCells: rules.runCells,
    RUN_COAST: legacy1710.RUN_COAST,
    JUMP_FALL_TICKS: rules.JUMP_FALL_TICKS,
    JUMP_TICKS: rules.JUMP_TICKS,
    RUN_MAX: rules.RUN_MAX,
    RUN_TICKS: rules.RUN_TICKS,
    SWING_REACH: rules.SWING_REACH,
    HITBOX_1710: legacy1710.HITBOX_1710,
    Vec3,
    fight: { lastAttackT: 0 },
    STRIKE_SWING_MS: rules.STRIKE_SWING_MS,
    STRIKE_APPROACH_MS: rules.STRIKE_APPROACH_MS,
    strikeBudgetMs: rules.strikeBudgetMs,
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setImmediate,
    liveEntities: () => Object.values(bot.entities),
    reflexes: [{ name: 'combat', fairFill: () => fill, fightBusy: () => false }],
    guardState: { hand: null },
    entityPerceptible: (e, f) => {
      assert.strictEqual(f, fill, 'entityPerceptible got another fill')
      return e.seen
    },
    drawAndLoose: async () => { did.push('draw'); return true },
    legs: legLedger(),
    takenText,
    pilotLane: lane.pilotLane,
    claimLane: lane.claimLane,
    releaseLane: lane.releaseLane,
    strikeRun: lane.strikeRun,
    stopPath: pathStop,
    round: (v) => v && { x: v.x, y: v.y, z: v.z }
  }
  const stop = () => runRoute('/stop', {}, {
    bot,
    bunker: {},
    legs: env.legs,
    stopFollow () {},
    stopPath: () => env.stopPath(),
    clearLane: lane.clearLane,
    jobs: { stopAll: () => 0 },
    guardState: { hand: null }
  })
  // A goto that never arrives and, as mineflayer-pathfinder's, fails with GoalChanged a timer turn after another goal replaces g.
  const gotoUntilChanged = (g) => new Promise((resolve, reject) => {
    did.push('walk')
    bot.pathfinder.goal = g
    const changed = (n) => {
      if (n === g) return
      bot.removeListener('goal_updated', changed)
      clock.setTimeout(() => reject(Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' })), 0)
    }
    bot.on('goal_updated', changed)
  })
  return { bot, env, clock, did, hits, stop, stops: () => stops, gotoUntilChanged }
}

// Advances the fake clock 10 ms a step until route answers, ten minutes at most.
async function drive (route, query, { env, clock }) {
  const { handle, res } = routeHandler(route, env)
  let done = false
  handle({ query }, res).then(() => { done = true })
  for (let i = 0; i < 60000 && !done; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    clock.advance(10)
  }
  assert.ok(done, `no reply after ${clock.now()} ms`)
  return res
}

// Each approach to the unkillable zombie 10 blocks off takes walkMs, or never arrives when walkMs is null. The
// zombie backs off to 10 blocks after each swing.
async function strikeRun (walkMs) {
  const world = verbWorld([zombie(10.5)])
  const { bot } = world
  const arrive = bot.pathfinder.goto
  let walk = null
  bot.pathfinder.goto = (goal) => new Promise((resolve, reject) => {
    walk = reject
    if (walkMs !== null) world.clock.setTimeout(() => arrive(goal).then(resolve), walkMs)
  })
  const attack = bot.attack
  bot.attack = () => {
    attack()
    bot.entities[7].position = bot.entity.position.offset(10, 0, 0)
  }
  world.env.stopPath = () => { if (walk) walk(new Error('Path was stopped before it could be completed')) }
  const res = await drive('/strike', { name: 'zombie', max: '5' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { reply: res.body, at: world.clock.now() }
}

test('/strike ends at its own budget, before the tool timeout, however long its approaches take', async () => {
  const budget = rules.strikeBudgetMs(5)
  const timeout = toolNamed('strike').timeoutMs
  assert.ok(budget < timeout, `the budget ${budget} ms is not under the tool timeout ${timeout} ms`)
  const slow = await strikeRun(5900)
  assert.strictEqual(slow.reply.swings, 5, 'control: five swings after slow approaches')
  assert.ok(slow.at <= budget, `five swings answered at ${slow.at} ms, past the budget ${budget} ms`)
  const stuck = await strikeRun(null)
  assert.strictEqual(stuck.reply.swings, 0)
  assert.strictEqual(stuck.reply.reason, 'budget')
  assert.ok(stuck.at <= budget, `an approach that never arrives answered at ${stuck.at} ms, past the budget ${budget} ms`)
})

test('strike, shoot and useon answer a zombie behind a wall as they answer no zombie, and act on one in sight', async () => {
  for (const [route, query, act] of [
    ['/strike', { name: 'zombie' }, 'swing'],
    ['/shoot', { name: 'zombie' }, 'draw'],
    ['/useon', { name: 'zombie', item: 'shears' }, 'use']
  ]) {
    const seen = verbWorld([zombie(6.5)])
    const done = await drive(route, query, seen)
    assert.strictEqual(done.error, undefined, `${route} control: ${done.error && done.error.message}`)
    assert.ok(seen.did.includes(act), `${route} control: did ${seen.did.join(', ')}`)
    const none = await drive(route, query, verbWorld([]))
    assert.ok(none.error, `${route} with no zombie`)
    const hidden = verbWorld([zombie(6.5, false)])
    const refused = await drive(route, query, hidden)
    assert.strictEqual(refused.error && refused.error.message, none.error.message, `${route} behind a wall`)
    assert.deepStrictEqual(hidden.did, [], `${route} behind a wall`)
  }
})

// A 2-high wall around the floor from (x0, z0) to (x1, z1), with door.kind at the door cell.
const room = (x0, z0, x1, z1, door = null) => (p) => {
  if (p.y > 65 || p.x < x0 - 1 || p.x > x1 + 1 || p.z < z0 - 1 || p.z > z1 + 1) return null
  if (door && p.x === door.x && p.z === door.z) return door.kind
  return p.x === x0 - 1 || p.x === x1 + 1 || p.z === z0 - 1 || p.z === z1 + 1 ? 'stone' : null
}

// A door's upper half reads closed, as a 1.7.10 server sends it.
function roomWorld (entities, blocks) {
  const world = verbWorld(entities)
  const { bot } = world
  const floor = bot.blockAt
  bot.blockAt = (p) => {
    const kind = p.y >= 64 && blocks(p)
    if (kind === 'stone') return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p }
    if (!kind) return floor(p)
    const half = p.y === 65 ? 'upper' : 'lower'
    return { name: 'oak_door', boundingBox: 'block', position: p, getProperties: () => ({ half, facing: 'west', hinge: 'left', open: half === 'lower' && kind === 'open door' }) }
  }
  const attack = bot.attack
  bot.attack = (en) => {
    attack()
    world.did.push(`hit ${en.id}`)
  }
  return world
}

test('a strike refuses a zombie in sight behind a wall it has no walk around', async () => {
  const world = roomWorld([zombie(3.5)], room(-1, -1, 1, 1))
  const res = await drive('/strike', { name: 'zombie' }, world)
  assert.match(res.error ? res.error.message : `no refusal, did ${world.did.join(', ')}`, /^zombie at 3,64,0 has no walk to me, behind a wall or a closed door$/)
  assert.deepStrictEqual(world.did, [])
})

test('a strike passes a nearer zombie behind a wall for one with a walk to the body', async () => {
  const reachable = { ...zombie(0), id: 8, position: new Vec3(-2.5, 64, -3.5) }
  const world = roomWorld([zombie(2.5), reachable], room(-6, -6, 0, 2))
  const res = await drive('/strike', { name: 'zombie' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(world.did, ['walk', 'swing', 'hit 8'])
})

test('a strike walks and swings over open ground and through an open door, and refuses one behind a closed door', async () => {
  const field = roomWorld([zombie(6.5)], () => null)
  const fieldRes = await drive('/strike', { name: 'zombie' }, field)
  assert.strictEqual(fieldRes.error, undefined, fieldRes.error && fieldRes.error.message)
  assert.deepStrictEqual(field.did, ['walk', 'swing', 'hit 7'], 'open ground')
  const open = roomWorld([zombie(4.5)], room(-1, -1, 1, 1, { x: 2, z: 0, kind: 'open door' }))
  const openRes = await drive('/strike', { name: 'zombie' }, open)
  assert.strictEqual(openRes.error, undefined, openRes.error && openRes.error.message)
  assert.deepStrictEqual(open.did, ['walk', 'swing', 'hit 7'], 'an open door')
  const closed = roomWorld([zombie(4.5)], room(-1, -1, 1, 1, { x: 2, z: 0, kind: 'door' }))
  const closedRes = await drive('/strike', { name: 'zombie' }, closed)
  assert.match(closedRes.error ? closedRes.error.message : `no refusal, did ${closed.did.join(', ')}`, /^zombie at 4,64,0 has no walk to me/)
  assert.deepStrictEqual(closed.did, [], 'a closed door')
})

test('a strike walks to a zombie across unseen ground on the surface, and refuses one across ground it knows nothing of', async () => {
  const unseen = (p) => p.y === 63 && p.x >= 1 && p.x <= 6
  const surface = roomWorld([zombie(6.5)], () => null)
  surface.env.cellKnown = (p) => !unseen(p)
  const res = await drive('/strike', { name: 'zombie' }, surface)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(surface.did, ['walk', 'swing', 'hit 7'], 'unseen ground on the surface')
  const unknown = roomWorld([zombie(6.5)], () => null)
  unknown.env.cellKnown = unknown.env.knownCell = (p) => !unseen(p)
  const refused = await drive('/strike', { name: 'zombie' }, unknown)
  assert.match(refused.error ? refused.error.message : `no refusal, did ${unknown.did.join(', ')}`, /^zombie at 6,64,0 has no walk to me$/)
  assert.deepStrictEqual(unknown.did, [])
})

test('a strike refuses a zombie behind a wall the body has not seen, naming no wall', async () => {
  const world = roomWorld([zombie(3.5)], room(-1, -1, 1, 1))
  world.env.cellKnown = world.env.knownCell = (p) => !(p.y >= 64 && (Math.abs(p.x) === 2 || Math.abs(p.z) === 2))
  const res = await drive('/strike', { name: 'zombie' }, world)
  assert.match(res.error ? res.error.message : `no refusal, did ${world.did.join(', ')}`, /^zombie at 3,64,0 has no walk to me$/)
  assert.deepStrictEqual(world.did, [])
})

// verbWorld over real 1.21.11 blocks from cell, a GoalBlock walk ending on its cell and any other at near(goal) when given.
function realWorld (entities, cell, near = null) {
  const world = verbWorld(entities)
  const { bot } = world
  bot.blockAt = (p) => {
    const [name, props] = cell(p.x, p.y, p.z) || [p.y < 64 ? 'stone' : 'air', {}]
    return Object.assign(Block.fromProperties(name, props, 0), { position: p })
  }
  const walk = bot.pathfinder.goto
  bot.pathfinder.goto = async (goal) => {
    if (!(goal instanceof goals.GoalBlock) && !near) return walk(goal)
    world.did.push('walk')
    bot.entity.position = goal instanceof goals.GoalBlock ? new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5) : near(goal)
  }
  return world
}

test('a strike walks to the fence of a pen and swings at a sheep inside it', async () => {
  // Oak fences round the floor from (5, -2) to (7, 2).
  const pen = (x, y, z) => y === 64 && x >= 4 && x <= 8 && Math.abs(z) <= 3 && (x === 4 || x === 8 || Math.abs(z) === 3) ? ['oak_fence', {}] : null
  const sheep = { id: 9, name: 'sheep', width: 0.9, height: 1.3, seen: true, position: new Vec3(5.5, 64, 0.5) }
  const world = realWorld([sheep], pen, () => new Vec3(3.5, 64, 0.5))
  const res = await drive('/strike', { name: 'sheep' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(world.did, ['walk', 'swing'])
})

test('a useon walks to the fence of a pen and shears a sheep inside it', async () => {
  // Oak fences round the floor from (5, -2) to (7, 2).
  const pen = (x, y, z) => y === 64 && x >= 4 && x <= 8 && Math.abs(z) <= 3 && (x === 4 || x === 8 || Math.abs(z) === 3) ? ['oak_fence', {}] : null
  const sheep = { id: 9, name: 'sheep', width: 0.9, height: 1.3, seen: true, position: new Vec3(5.5, 64, 0.5) }
  const world = realWorld([sheep], pen, () => new Vec3(3.5, 64, 0.5))
  const res = await drive('/useon', { name: 'sheep', item: 'shears' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(world.did, ['walk', 'use'])
})

test('a zombie 2 off behind a stone wall or a closed door is out of melee reach', () => {
  const reach = (cell) => {
    const world = realWorld([zombie(2.5)], (x, y, z) => x === 1 && z === 0 && (y === 64 || y === 65) ? cell(y) : null)
    return loadBotFunctions(['inMeleeReach'], { ...world.env }).inMeleeReach(world.bot.entities[7])
  }
  const door = (open) => (y) => ['oak_door', { half: y === 64 ? 'lower' : 'upper', open, facing: 'east', hinge: 'left' }]
  assert.strictEqual(reach(() => ['air', {}]), true, 'control: open ground')
  assert.strictEqual(reach(() => ['stone', {}]), false, 'a stone wall')
  assert.strictEqual(reach(door(false)), false, 'a closed door')
})

// A pit from (3, -1) to (4, 1), its floor at y 61.
const pit = (x, y, z) => x >= 3 && x <= 4 && Math.abs(z) <= 1 && (y === 62 || y === 63) ? ['air', {}] : null

test('a strike refuses a zombie 2 deep in a pit out of melee reach', async () => {
  const world = realWorld([{ ...zombie(0), position: new Vec3(3.5, 62, 0.5) }], pit)
  const res = await drive('/strike', { name: 'zombie' }, world)
  assert.match(res.error ? res.error.message : `no refusal, did ${world.did.join(', ')}`, /^zombie at 3,62,0 has no walk to me/)
  assert.deepStrictEqual(world.did, [])
})

test('a strike refuses a zombie in a water hole outside a sealed room', async () => {
  // Stone walls 3 high round the floor from (-1, -1) to (1, 1), a 1-deep water hole at (4, 63, 0).
  const sealed = (x, y, z) => {
    if (x === 4 && y === 63 && z === 0) return ['water', { level: 0 }]
    return y >= 64 && y <= 66 && Math.max(Math.abs(x), Math.abs(z)) === 2 ? ['stone', {}] : null
  }
  const world = realWorld([{ ...zombie(0), position: new Vec3(4.5, 63, 0.5) }], sealed)
  const res = await drive('/strike', { name: 'zombie' }, world)
  assert.match(res.error ? res.error.message : `no refusal, did ${world.did.join(', ')}`, /^zombie at 4,63,0 has no walk to me, behind a wall or a closed door$/)
  assert.deepStrictEqual(world.did, [])
})

test('a strike swings in place at a zombie over a fence already in melee reach', async () => {
  // Oak fences round the floor from (5, -2) to (7, 2).
  const pen = (x, y, z) => y === 64 && x >= 4 && x <= 8 && Math.abs(z) <= 3 && (x === 4 || x === 8 || Math.abs(z) === 3) ? ['oak_fence', {}] : null
  const world = realWorld([zombie(5.5)], pen)
  world.bot.entity.position = new Vec3(3.5, 64, 0.5)
  const res = await drive('/strike', { name: 'zombie' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(world.did, ['swing'])
})

test('a kill walks to the drops over open ground, and not out of a closed room or into a pit', async () => {
  // killed, note and did after a strike that kills the zombie in sight.
  const kill = async (world) => {
    world.bot.attack = () => { world.did.push('swing'); delete world.bot.entities[7] }
    const res = await drive('/strike', { name: 'zombie' }, world)
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
    return { killed: res.body.killed, note: res.body.note, did: world.did }
  }
  const field = await kill(realWorld([zombie(2.5)], () => null))
  assert.deepStrictEqual(field, { killed: true, note: 'walked to drops', did: ['swing', 'walk'] }, 'control: open ground')
  // A room from (-1, -1) to (1, 1) with 3-high walls, a 1-high window at (2, 65, 0) and a stone block outside it at (3, 64, 0).
  const shut = (x, y, z) => {
    if (x === 3 && y === 64 && z === 0) return ['stone', {}]
    if (y < 64 || y > 66 || Math.max(Math.abs(x), Math.abs(z)) !== 2) return null
    return x === 2 && y === 65 && z === 0 ? null : ['stone', {}]
  }
  const room = realWorld([{ ...zombie(0), position: new Vec3(3.5, 65, 0.5) }], shut)
  room.bot.entity.position = new Vec3(1.5, 64, 0.5)
  const out = 'the drops lie out of walking reach, left them'
  assert.deepStrictEqual(await kill(room), { killed: true, note: out, did: ['swing'] }, 'through the window')
  const rim = realWorld([{ ...zombie(0), position: new Vec3(3.5, 62, 0.5) }], pit)
  rim.bot.entity.position = new Vec3(2.5, 64, 0.5)
  assert.deepStrictEqual(await kill(rim), { killed: true, note: out, did: ['swing'] }, 'into the pit')
})

test('a strike refuses a zombie on a ledge 3 or 4 high in sight but out of reach, naming no wall', async () => {
  for (const high of [3, 4]) {
    const ledge = (x, y, z) => x >= 3 && x <= 8 && Math.abs(z) <= 3 && y >= 64 && y < 64 + high ? ['stone', {}] : null
    const world = realWorld([{ ...zombie(0), position: new Vec3(3.5, 64 + high, 0.5) }], ledge)
    const res = await drive('/strike', { name: 'zombie' }, world)
    assert.match(res.error ? res.error.message : `no refusal, did ${world.did.join(', ')}`, new RegExp(`^zombie at 3,${64 + high},0 has no walk to me$`), `${high} high`)
    assert.deepStrictEqual(world.did, [], `${high} high`)
  }
})

test('a kill struck from the rim of a ditch 1 deep walks down to the drops, also after a swing at a jump', async () => {
  // A ditch from (3, -1) to (4, 1), its floor at y 62.
  const ditch = (x, y, z) => x >= 3 && x <= 4 && Math.abs(z) <= 1 && y === 63 ? ['air', {}] : null
  for (const y of [63, 64.25]) {
    const world = realWorld([{ ...zombie(0), position: new Vec3(3.5, y, 0.5) }], ditch)
    world.bot.entity.position = new Vec3(2.5, 64, 0.5)
    world.bot.attack = () => { world.did.push('swing'); delete world.bot.entities[7] }
    const res = await drive('/strike', { name: 'zombie' }, world)
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
    const got = { note: res.body.note, did: world.did, at: world.bot.entity.position }
    assert.deepStrictEqual(got, { note: 'walked to drops', did: ['swing', 'walk'], at: new Vec3(3.5, 63, 0.5) }, `struck at y ${y}`)
  }
})

test('nearestSeen checks its candidates nearest first and stops at the first that passes', () => {
  const world = verbWorld([6.5, 2.5, 4.5, 8.5].map((x, i) => ({ ...zombie(x), id: 10 + i })))
  const { nearestSeen } = loadBotFunctions(['nearestSeen'], { ...world.env })
  const checked = []
  const found = nearestSeen('zombie', 16, (en) => {
    checked.push(en.id)
    return en.id !== 11
  })
  assert.deepStrictEqual({ found: found && found.id, checked }, { found: 12, checked: [11, 12] })
})

test('a useon whose zombie goes out of sight on the walk uses nothing and gives no position', async () => {
  const world = verbWorld([zombie(6.5)])
  const walk = world.bot.pathfinder.goto
  world.bot.pathfinder.goto = async (goal) => {
    await walk(goal)
    Object.assign(world.bot.entities[7], { seen: false, position: new Vec3(9.5, 64, 3.5) })
  }
  const res = await drive('/useon', { name: 'zombie', item: 'shears' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual({ ...res.body }, { used: null, on: 'zombie', reason: 'lost sight', note: 'lost sight of it' })
  assert.deepStrictEqual(world.did, ['walk'])
})

test('a useon refuses a fight that starts on the walk, before the item goes into the hand', async () => {
  let fighting = false
  let equipped = false
  const world = verbWorld([zombie(6.5)])
  world.env.reflexes[0].fightBusy = () => fighting
  world.env.bunker = { building: false }
  const walk = world.bot.pathfinder.goto
  world.bot.pathfinder.goto = async (goal) => {
    await walk(goal)
    fighting = true
  }
  world.bot.equip = async () => { equipped = true }
  const res = await drive('/useon', { name: 'zombie', item: 'shears' }, world)
  assert.match(res.error ? res.error.message : `no refusal, did ${world.did.join(', ')}`, /^refused: fighting something, the guard reflex holds the hand\./)
  assert.deepStrictEqual({ equipped, did: world.did, hand: world.env.guardState.hand }, { equipped: false, did: ['walk'], hand: null })
})

// An empty frame has no item key, as a 1.21.11 server sends it. objectData 4 faces west, toward the body.
function frame (id, x, item, seen = true, objectData = 4) {
  const metadata = []
  if (item) metadata[FRAME_ITEM] = Item.toNotch(new Item(registry.itemsByName[item].id, 1))
  return { id, name: 'item_frame', width: 0.5, height: 0.5, seen, position: new Vec3(x, 65, 0.5), metadata, objectData }
}

// hold(en, item) is the server changing what frame en holds, sent as an entity update. The server ticks every tickMs,
// sends its age every ageEvery ticks, arriving ageLag ms after the tick, and a position update of each item every 60.
// stall(ms) halts its ticks for ms, proxy(ms) holds its ages for ms and then delivers them at once, returning the held
// ages, and server(ms, fn) runs the server update fn ms from now, or at the end of a stall running then.
function frameWorld (frames, { tickMs = 50, ageLag = 0, ...opts } = {}) {
  const world = verbWorld(frames, opts)
  const { bot, env, clock } = world
  bot.registry = registry
  bot.time = { age: 0 }
  world.ageEvery = 20
  let ticks = 0
  let stallEnd = -Infinity
  let held = null
  const sendAge = (age) => {
    bot.time.age = age
    bot.emit('time')
  }
  clock.setInterval(() => {
    if (clock.now() < stallEnd) return
    ticks++
    if (ticks % world.ageEvery === 0) {
      const age = ticks
      if (held) held.push(age)
      else if (ageLag) clock.setTimeout(() => sendAge(age), ageLag)
      else sendAge(age)
    }
    if (ticks % 60 === 0) for (const e of Object.values(bot.entities)) if (e.name === 'item') bot.emit('entityMoved', e)
  }, tickMs)
  world.stall = (ms) => { stallEnd = clock.now() + ms }
  world.proxy = (ms) => {
    const ages = []
    held = ages
    clock.setTimeout(() => {
      held = null
      ages.forEach(sendAge)
    }, ms)
    return ages
  }
  world.server = (ms, fn) => clock.setTimeout(function run () {
    if (clock.now() < stallEnd) clock.setTimeout(run, stallEnd - clock.now())
    else fn()
  }, ms)
  Object.assign(env, { shared: { ready: true, mcData }, loadItem })
  const items = bot.inventory.items
  bot.inventory.items = () => [...items(), { name: 'wheat' }]
  const equip = bot.equip
  bot.equip = async (item) => {
    world.did.push(`equip ${item.name}`)
    return equip(item)
  }
  world.hold = (en, item) => setImmediate(() => {
    en.metadata[FRAME_ITEM] = Item.toNotch(item ? new Item(registry.itemsByName[item].id, 1) : null)
    bot.emit('entityUpdate', en)
  })
  return world
}

// framedBy(en) names the item the server frames after the click, undefined for no update.
async function frameWheat (frames, framedBy = () => undefined, query = {}) {
  const world = frameWorld(frames)
  world.bot.useOn = async (en) => {
    world.did.push(`use ${en.id}`)
    const item = framedBy(en)
    if (item !== undefined) world.hold(en, item)
  }
  const res = await drive('/useon', { name: 'item_frame', item: 'wheat', ...query }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { reply: { ...res.body }, did: world.did }
}

test('useon puts the item into an empty frame and names what the frame holds after the server update', async () => {
  const framed = await frameWheat([frame(20, 2.5, null)], () => 'wheat')
  assert.deepStrictEqual(framed.reply, { used: 'wheat', on: 'item_frame', at: { x: 2, y: 65, z: 0 }, framed: 'wheat' })
  assert.deepStrictEqual(framed.did, ['equip wheat', 'use 20'])
  const other = await frameWheat([frame(20, 2.5, null)], () => 'iron_sword')
  assert.deepStrictEqual([other.reply.ok, other.reply.framed], [false, 'iron_sword'])
  assert.match(other.reply.reason, /iron_sword/)
})

test('useon picks the nearest empty frame past a filled one', async () => {
  const empty = frame(21, 4.5, null)
  empty.metadata[FRAME_ITEM] = Item.toNotch(null)
  const { reply, did } = await frameWheat([frame(20, 2.5, 'stick'), empty], () => 'wheat')
  assert.deepStrictEqual([reply.ok, reply.at, reply.framed], [undefined, { x: 4, y: 65, z: 0 }, 'wheat'])
  assert.ok(did.includes('use 21'), did.join(', '))
})

test('useon with only filled frames in sight walks, equips and clicks nothing, and names what the nearest holds', async () => {
  const { reply, did } = await frameWheat([frame(20, 4.5, 'stick'), frame(21, 6.5, 'wheat'), frame(22, 2.5, null, false)], () => 'wheat')
  assert.deepStrictEqual([reply.ok, reply.used, reply.on, reply.at, reply.framed], [false, null, 'item_frame', { x: 4, y: 65, z: 0 }, 'stick'])
  assert.strictEqual(typeof reply.reason, 'string')
  assert.deepStrictEqual(did, [])
  const none = await drive('/useon', { name: 'item_frame', item: 'wheat' }, frameWorld([]))
  const hidden = await drive('/useon', { name: 'item_frame', item: 'wheat' }, frameWorld([frame(20, 2.5, 'stick', false)]))
  assert.strictEqual(hidden.error && hidden.error.message, none.error.message)
})

test('useon without a frame update within 10 ticks confirms nothing', async () => {
  const { reply } = await frameWheat([frame(20, 2.5, null)])
  assert.deepStrictEqual([reply.ok, reply.used, reply.framed], [false, 'wheat', null])
  assert.strictEqual(reply.reason, 'the server sent no frame update within 10 ticks, the frame shows nothing')
})

test('a useon does not click once the guard reflex took the hand back after the equip, on a creature or a frame', async () => {
  for (const [query, world] of [
    [{ name: 'zombie', item: 'shears' }, verbWorld([zombie(2.5)])],
    [{ name: 'item_frame', item: 'wheat' }, frameWorld([frame(20, 2.5, null)])]
  ]) {
    let held = null
    world.bot.lookAt = async () => {
      held = world.env.guardState.hand
      world.bot.heldItem = { name: 'iron_sword' }
    }
    const res = await drive('/useon', query, world)
    assert.match(res.error && res.error.message, new RegExp(`^the guard reflex took the hand back from the ${query.item} \\(holding iron_sword\\), nothing used, retry$`), query.name)
    assert.deepStrictEqual(world.did.filter((d) => d.startsWith('use')), [], `${query.name} clicked`)
    assert.ok(held, `${query.name}: no hand lease at the look`)
    assert.strictEqual(world.env.guardState.hand, null, `${query.name} kept the lease`)
  }
})

test('a useon gives the hand back once the click is sent, before it waits for the frame update', async () => {
  const creature = verbWorld([zombie(2.5)])
  const frameW = frameWorld([frame(20, 2.5, null)])
  const seen = {}
  for (const [query, world] of [
    [{ name: 'zombie', item: 'shears' }, creature],
    [{ name: 'item_frame', item: 'wheat' }, frameW]
  ]) {
    const { guardState } = world.env
    world.bot.useOn = async () => {
      world.did.push('use')
      seen[query.name] = { atClick: guardState.hand !== null }
      world.clock.setTimeout(() => { seen[query.name].inWait = guardState.hand }, 100)
      return 'clicked'
    }
    world.env.ok = (res, body) => {
      seen[query.name].atReply = guardState.hand
      res.body = body
    }
    const res = await drive('/useon', query, world)
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
  }
  const held = (s) => ({ atClick: s.atClick, ...(s.inWait === undefined ? {} : { inWait: s.inWait !== null }), atReply: s.atReply !== null })
  assert.deepStrictEqual(
    { zombie: held(seen.zombie), frame: held(seen.item_frame) },
    { zombie: { atClick: true, atReply: false }, frame: { atClick: true, inWait: false, atReply: false } }
  )
})

test('a useon gives the hand back when it ends after the equip without a click, on a creature or a frame', async () => {
  const sight = (en) => ({ lookAt: async () => { en.seen = false } })
  const reach = (en) => ({ lookAt: async () => { en.position = new Vec3(8.5, en.position.y, en.position.z) } })
  const cases = [
    ['lost sight', sight, (res) => res.body.reason],
    [{ zombie: 'target left reach', item_frame: 'the item_frame at 8,65,0 stays out of swing reach from here' }, reach, (res) => res.body ? res.body.note : res.error.message],
    ['the equip timed out', () => ({ equip: async () => { throw new Error('the equip timed out') } }), (res) => res.error.message]
  ]
  for (const [endings, arrange, said] of cases) {
    for (const [query, world] of [
      [{ name: 'zombie', item: 'shears' }, verbWorld([zombie(2.5)])],
      [{ name: 'item_frame', item: 'wheat' }, frameWorld([frame(20, 2.5, null)])]
    ]) {
      const { guardState } = world.env
      const ends = typeof endings === 'string' ? endings : endings[query.name]
      Object.assign(world.bot, arrange(Object.values(world.bot.entities)[0]))
      let held = null
      const equip = world.bot.equip
      world.bot.equip = async (item) => {
        held = guardState.hand
        return equip(item)
      }
      const res = await drive('/useon', query, world)
      assert.strictEqual(said(res), ends, `${query.name}: ${ends}`)
      assert.deepStrictEqual(world.did.filter((d) => d.startsWith('use')), [], `${query.name}: ${ends} clicked`)
      assert.ok(held, `${query.name}: ${ends}: no hand lease at the equip`)
      assert.strictEqual(guardState.hand, null, `${query.name}: ${ends} kept the lease`)
    }
  }
})

test('a useon renews its hand lease after the equip, so a slow equip and a slow look keep the hand to the click', async () => {
  for (const [query, world] of [
    [{ name: 'zombie', item: 'shears' }, verbWorld([zombie(2.5)])],
    [{ name: 'item_frame', item: 'wheat' }, frameWorld([frame(20, 2.5, null)])]
  ]) {
    const { guardState } = world.env
    const slow = (ms) => new Promise((resolve) => world.clock.setTimeout(resolve, ms))
    const equip = world.bot.equip
    let leased = null
    let atClick = null
    world.bot.equip = async (item) => {
      leased = guardState.hand
      await slow(1500)
      return equip(item)
    }
    world.bot.lookAt = () => slow(1000)
    world.bot.useOn = async () => { atClick = guardState.hand }
    const res = await drive('/useon', query, world)
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
    assert.ok(leased, `${query.name}: no hand lease at the equip`)
    assert.strictEqual(atClick, leased, `${query.name}: the lease was lost before the click`)
  }
})

// Item 30 is the wheat a frame drops. Without wheat it holds no item metadata yet, as mineflayer spawns it.
function wheatDrop (position, wheat = true, count = 1) {
  const drop = Object.assign(new Entity(30), { name: 'item', width: 0.25, height: 0.25, seen: true, position })
  if (wheat) giveWheat(drop, count)
  return drop
}

function giveWheat (drop, count = 1) {
  drop.metadata[registry.supportFeature('metadataIxOfItem')] = Item.toNotch(new Item(registry.itemsByName.wheat.id, count))
}

test('a strike on a frame swings once at the nearest filled frame whatever max says, and walks to the dropped item', async () => {
  for (const legacy of [false, true]) {
    const world = frameWorld([frame(21, 2.5, null), frame(20, 3.5, 'wheat')], { legacy })
    const sprints = []
    const control = world.bot.setControlState
    world.bot.setControlState = (c, s) => {
      if (c === 'sprint' && s) sprints.push(c)
      control.call(world.bot, c, s)
    }
    world.bot.attack = (en) => {
      world.did.push(`swing ${en.id}`)
      world.hold(en, null)
      world.bot.entities[30] = wheatDrop(en.position.clone())
    }
    const res = await drive('/strike', { name: 'item_frame', item: 'iron_sword', max: '3' }, world)
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
    const { swings, killed, dropped, at, note } = res.body
    assert.deepStrictEqual({ swings, killed, dropped, at }, { swings: 1, killed: false, dropped: 'wheat', at: { x: 3, y: 65, z: 0 } }, `1.7.10 ${legacy}`)
    assert.strictEqual(typeof note, 'string')
    // The face of frame 20 sits 3.3 off the eye.
    assert.deepStrictEqual(world.did.filter((d) => !d.startsWith('jump')), ['walk', 'equip iron_sword', 'swing 20', 'walk'], `1.7.10 ${legacy}`)
    assert.deepStrictEqual(sprints, [], `1.7.10 ${legacy}`)
  }
})

// The live c2 frame, spawned at the corner of its cell facing north. Its face sits about 3.6 from the eye, the corner 2.8.
test('a 1.7.10 strike on a frame whose corner sits in reach walks to its face, then swings', async () => {
  const world = frameWorld([Object.assign(frame(20, 6, 'wheat', true, 2), { position: new Vec3(6, 64, -1) })], { legacy: true })
  world.bot.entity.position = new Vec3(7.5, 64, -3.5)
  world.bot.attack = (en) => {
    world.did.push(`swing ${en.id}`)
    world.hold(en, null)
  }
  const res = await drive('/strike', { name: 'item_frame', item: 'iron_sword', at: '6,64,-1' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual([res.body.swings, res.body.at, res.body.dropped], [1, { x: 6, y: 64, z: -1 }, 'wheat'], res.body.note)
  assert.deepStrictEqual(world.did, ['walk', 'equip iron_sword', 'swing 20'])
})

test('a 1.7.10 useon on a frame whose corner sits in reach walks to its face, then clicks', async () => {
  // The corner 2.7 off the feet, the face of the west-facing frame 3.3 off the eye.
  const world = frameWorld([Object.assign(frame(20, 3, null), { position: new Vec3(3, 65, 0) })], { legacy: true })
  world.bot.useOn = async (en) => {
    world.did.push(`use ${en.id}`)
    world.hold(en, 'wheat')
  }
  const res = await drive('/useon', { name: 'item_frame', item: 'wheat' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual([res.body.ok, res.body.framed], [undefined, 'wheat'], res.body.reason)
  assert.deepStrictEqual(world.did, ['walk', 'equip wheat', 'use 20'])
})

// A pathfinder walk that stays put on a goal its start cell meets, else ends on the floor cell within 4 of cell that
// meets the goal with the lowest heuristic.
function reachWalk (world, cell) {
  return async (goal) => {
    world.did.push('walk')
    if (goal.isEnd(world.bot.entity.position.floored())) return
    let best = null
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        const c = new Vec3(cell.x + dx, 64, cell.z + dz)
        if (goal.isEnd(c) && (!best || goal.heuristic(c) < goal.heuristic(best))) best = c
      }
    }
    assert.ok(best, 'no floor cell meets the goal')
    world.bot.entity.position = best.offset(0.5, 0, 0.5)
  }
}

test('strike and useon walk from 2 above a frame facing up, whose face lies out of swing reach there, then act', async () => {
  // From 2 above, the face sits 3.46 below the eye.
  for (const legacy of [false, true]) {
    for (const [route, item, fill, act] of [['/strike', 'iron_sword', 'wheat', 'swing 20'], ['/useon', 'wheat', null, 'use 20']]) {
      const world = frameWorld([Object.assign(frame(20, 3, fill, true, 1), { position: new Vec3(3, 64, 0) })], { legacy })
      world.bot.entity.position = new Vec3(3.5, 66, 0.5)
      world.bot.pathfinder.goto = reachWalk(world, new Vec3(3, 64, 0))
      world.bot.attack = (en) => {
        world.did.push(`swing ${en.id}`)
        world.hold(en, null)
      }
      world.bot.useOn = async (en) => {
        world.did.push(`use ${en.id}`)
        world.hold(en, 'wheat')
      }
      const res = await drive(route, { name: 'item_frame', item }, world)
      assert.strictEqual(res.error, undefined, res.error && `${route} on 1.7.10 ${legacy}: ${res.error.message}`)
      assert.deepStrictEqual(world.did, ['walk', `equip ${item}`, act], `${route} on 1.7.10 ${legacy}`)
    }
  }
})

test('strike and useon walk from off the centre of a cell whose centre has the frame in swing reach, then act', async () => {
  for (const [route, item, fill, act] of [['/strike', 'iron_sword', 'wheat', 'swing 20'], ['/useon', 'wheat', null, 'use 20']]) {
    const world = frameWorld([Object.assign(frame(20, 3, fill), { position: new Vec3(3, 65, 0) })])
    // The face sits in reach of the centre of cell 1,64,-1 and out of reach of the body 0.45 west and north of it.
    world.bot.entity.position = new Vec3(1.05, 64, -0.95)
    world.bot.pathfinder.goto = reachWalk(world, new Vec3(3, 64, 0))
    world.bot.attack = (en) => {
      world.did.push(`swing ${en.id}`)
      world.hold(en, null)
    }
    world.bot.useOn = async (en) => {
      world.did.push(`use ${en.id}`)
      world.hold(en, 'wheat')
    }
    const res = await drive(route, { name: 'item_frame', item }, world)
    assert.strictEqual(res.error, undefined, res.error && `${route}: ${res.error.message}`)
    assert.deepStrictEqual(world.did, ['walk', `equip ${item}`, act], route)
  }
})

// The listeners on each bot event a walk listens to.
const pathListeners = (bot) => Object.fromEntries(['path_update', 'goal_reached', 'goal_updated', 'path_stop', 'physicsTick'].map((e) => [e, bot.listenerCount(e)]))
const NO_PATH_LISTENERS = { path_update: 0, goal_reached: 0, goal_updated: 0, path_stop: 0, physicsTick: 0 }

test('strike and useon on a frame no walk puts in swing reach say so, when the walk runs out of time, finds no path or stays on a cell out of reach', async () => {
  for (const [route, item, fill] of [['/strike', 'iron_sword', 'wheat'], ['/useon', 'wheat', null]]) {
    for (const [label, walk] of [
      ['out of time', () => new Promise(() => {})],
      ['no path', async () => { throw Object.assign(new Error('No path to the goal!'), { name: 'NoPath' }) }],
      // The pathfinder resolves a search whose best cell is the start, as for a walled-in body.
      ['an empty path', async () => {}]
    ]) {
      const world = frameWorld([frame(20, 3.5, fill)])
      world.bot.pathfinder.goto = (goal) => {
        world.did.push('walk')
        world.bot.pathfinder.goal = goal
        return walk(goal)
      }
      const res = await drive(route, { name: 'item_frame', item }, world)
      assert.strictEqual(res.error ? res.error.message : `no error, note ${res.body.note}`, 'no spot in walking reach puts the face of the item_frame at 3,65,0 in swing reach', `${route} ${label}`)
      assert.deepStrictEqual({ did: world.did, stops: world.stops(), listening: pathListeners(world.bot) }, { did: ['walk'], stops: 1, listening: NO_PATH_LISTENERS }, `${route} ${label}`)
      assert.ok(world.clock.now() <= rules.STRIKE_APPROACH_MS + 100, `${route} ${label} answered at ${world.clock.now()} ms`)
    }
  }
})

test('strike and useon on a frame say the walk ran out of time on its way after a path with steps, a partial one or a replan out of think time, no spot after a noPath or an empty success, walk on past an empty partial, and act once the body stops in reach', async () => {
  const steps = [new Vec3(2, 64, 0), new Vec3(1, 64, 0)]
  const onWay = 'the walk to the item_frame at 3,65,0 ran out of time on its way'
  const noSpot = 'no spot in walking reach puts the face of the item_frame at 3,65,0 in swing reach'
  for (const [route, item, fill, act] of [['/strike', 'iron_sword', 'wheat', 'swing 20'], ['/useon', 'wheat', null, 'use 20']]) {
    // Each update is a path_update's status and path, reached for the body arriving in reach, or arrived for the body
    // stopping in reach with no goal_reached. A null said is a walk that acts.
    for (const [updates, said] of [
      [[['success', steps]], onWay],
      [[['partial', steps]], onWay],
      [[['partial', []]], onWay],
      [[['success', steps], ['timeout', []]], onWay],
      [[['success', steps], 'arrived'], null],
      [[['partial', []], ['timeout', []]], onWay],
      [[['partial', []], ['noPath', []]], noSpot],
      [[['partial', []], ['success', steps], 'reached'], null],
      [[['partial', steps], ['noPath', steps]], noSpot],
      [[['success', []]], noSpot]
    ]) {
      const label = `${route} ${updates.map((u) => typeof u === 'string' ? u : `${u[0]} with ${u[1].length} steps`).join(', ')}`
      const world = frameWorld([frame(20, 3.5, fill)])
      // As goto, it resolves on an empty path or goal_reached and fails on a noPath or timeout with steps.
      world.bot.pathfinder.goto = (goal) => new Promise((resolve, reject) => {
        world.did.push('walk')
        world.bot.pathfinder.goal = goal
        updates.forEach((u, i) => world.clock.setTimeout(() => {
          if (typeof u === 'string') world.bot.entity.position = new Vec3(1.5, 64, 0.5)
          if (u === 'arrived') return
          if (u === 'reached') {
            world.bot.emit('goal_reached', goal)
            return resolve()
          }
          const [status, path] = u
          world.bot.emit('path_update', { status, path })
          if (path.length === 0) resolve()
          else if (status === 'noPath') reject(Object.assign(new Error('No path to the goal!'), { name: 'NoPath' }))
          else if (status === 'timeout') reject(Object.assign(new Error('Took to long to decide path to goal!'), { name: 'Timeout' }))
        }, 500 * (i + 1)))
      })
      world.bot.attack = (en) => {
        world.did.push(`swing ${en.id}`)
        world.hold(en, null)
      }
      world.bot.useOn = async (en) => {
        world.did.push(`use ${en.id}`)
        world.hold(en, 'wheat')
      }
      const res = await drive(route, { name: 'item_frame', item }, world)
      if (said === null) {
        assert.strictEqual(res.error, undefined, res.error && `${label}: ${res.error.message}`)
        // Only a body that stopped in reach leaves the pathfinder a goal to stop.
        const stops = updates.includes('arrived') ? 1 : 0
        assert.deepStrictEqual({ did: world.did, stops: world.stops(), listening: pathListeners(world.bot) }, { did: ['walk', `equip ${item}`, act], stops, listening: NO_PATH_LISTENERS }, label)
      } else {
        assert.strictEqual(res.error ? res.error.message : `no error, note ${res.body.note}`, said, label)
        assert.deepStrictEqual({ did: world.did, stops: world.stops(), listening: pathListeners(world.bot) }, { did: ['walk'], stops: 1, listening: NO_PATH_LISTENERS }, label)
      }
      assert.ok(world.clock.now() >= 500 * updates.length, `${label} answered at ${world.clock.now()} ms`)
    }
  }
})

test('strike and useon on a frame whose walk runs out of time in swing reach act only when the stop leaves the body in reach, and stop the walk once', async () => {
  for (const [route, item, fill, act] of [['/strike', 'iron_sword', 'wheat', 'swing 20'], ['/useon', 'wheat', null, 'use 20']]) {
    // The stop recentres a body 0.4 off its cell centre, which leaves reach of the face from cell 0,64,0 and keeps it from cell 1,64,0.
    for (const [x, kept] of [[0.9, false], [1.9, true]]) {
      const label = `${route} from ${x}`
      const world = frameWorld([frame(20, 3.5, fill)], { recentre: true })
      const en = world.bot.entities[20]
      const { inMeleeReach } = loadBotFunctions(['inMeleeReach'], { ...world.env })
      const at = new Vec3(x, 64, 0.5)
      assert.deepStrictEqual([inMeleeReach(en, 0.6, at), inMeleeReach(en, 0.6, new Vec3(Math.floor(x) + 0.5, 64, 0.5))], [true, kept], `${label} control: in reach before the recentre`)
      world.bot.pathfinder.goto = (goal) => new Promise(() => {
        world.did.push('walk')
        world.bot.pathfinder.goal = goal
        world.bot.entity.position = at
      })
      world.bot.attack = (e) => {
        world.did.push(`swing ${e.id}`)
        world.hold(e, null)
      }
      world.bot.useOn = async (e) => {
        world.did.push(`use ${e.id}`)
        world.hold(e, 'wheat')
      }
      const res = await drive(route, { name: 'item_frame', item }, world)
      if (kept) assert.strictEqual(res.error, undefined, res.error && `${label}: ${res.error.message}`)
      else assert.strictEqual(res.error ? res.error.message : `no error, did ${world.did.join(', ')}`, 'the walk to the item_frame at 3,65,0 ran out of time on its way', label)
      assert.deepStrictEqual({ did: world.did, stops: world.stops(), listening: pathListeners(world.bot) }, { did: kept ? ['walk', `equip ${item}`, act] : ['walk'], stops: 1, listening: NO_PATH_LISTENERS }, label)
    }
  }
})

test('a stop during the walk to a frame ends a strike or a useon as stopped', async () => {
  for (const [route, item, fill] of [['/strike', 'iron_sword', 'wheat'], ['/useon', 'wheat', null]]) {
    const world = frameWorld([frame(20, 3.5, fill)])
    world.bot.pathfinder.goto = () => new Promise((resolve, reject) => {
      world.did.push('walk')
      world.env.stopPath = () => reject(Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' }))
      world.clock.setTimeout(world.stop, 500)
    })
    const res = await drive(route, { name: 'item_frame', item }, world)
    assert.strictEqual(res.error, undefined, res.error && `${route}: ${res.error.message}`)
    assert.deepStrictEqual({ reason: res.body.reason, did: world.did, listening: pathListeners(world.bot) }, { reason: 'stopped', did: ['walk'], listening: NO_PATH_LISTENERS }, route)
    if (route === '/useon') assert.deepStrictEqual({ ...res.body }, { used: null, on: 'item_frame', reason: 'stopped' })
  }
})

// The unstuck ladder takes the legs and clears the goal at 500 ms, and 2 ticks later replans the same goal object g.
const unstuckReplan = (world, g) => {
  world.clock.setTimeout(() => {
    world.env.legs.take('unstuck', 'free the body from a wedge')
    world.bot.pathfinder.goal = null
    world.bot.emit('goal_updated', null, false)
  }, 500)
  world.clock.setTimeout(() => {
    world.bot.pathfinder.goal = g
    world.bot.emit('goal_updated', g, false)
  }, 600)
}

test('a strike or a useon on a frame whose walk the unstuck reflex clears and replans ends as stopped and leaves its walk alone', async () => {
  for (const [route, item, fill] of [['/strike', 'iron_sword', 'wheat'], ['/useon', 'wheat', null]]) {
    const world = frameWorld([frame(20, 3.5, fill)])
    let goal = null
    world.bot.pathfinder.goto = (g) => {
      goal = g
      unstuckReplan(world, g)
      return world.gotoUntilChanged(g)
    }
    const res = await drive(route, { name: 'item_frame', item }, world)
    assert.strictEqual(res.error, undefined, res.error && `${route}: ${res.error.message}`)
    // Past the replan and its physicsTicks.
    world.clock.advance(500)
    assert.deepStrictEqual({ reason: res.body.reason, did: world.did, stops: world.stops(), kept: world.bot.pathfinder.goal === goal, listening: pathListeners(world.bot) }, { reason: 'stopped', did: ['walk'], stops: 0, kept: true, listening: NO_PATH_LISTENERS }, route)
  }
})

test('a strike whose frame walk loses the lane to a verb that leaves the pathfinder alone ends as stopped and stops its walk once', async () => {
  for (const [label, fails] of [['runs out of time', false], ['finds no path', true]]) {
    const world = frameWorld([frame(20, 3.5, 'wheat')])
    // /brace takes the lane at 500 ms, and a failed goto leaves the pathfinder walking.
    world.bot.pathfinder.goto = (g) => new Promise((resolve, reject) => {
      world.did.push('walk')
      world.bot.pathfinder.goal = g
      world.clock.setTimeout(() => world.env.claimLane('brace', 8000, true), 500)
      if (fails) world.clock.setTimeout(() => reject(Object.assign(new Error('No path to the goal!'), { name: 'NoPath' })), 1000)
    })
    const res = await drive('/strike', { name: 'item_frame', item: 'iron_sword' }, world)
    assert.strictEqual(res.error, undefined, res.error && `${label}: ${res.error.message}`)
    assert.deepStrictEqual({ reason: res.body.reason, did: world.did, stops: world.stops(), goal: world.bot.pathfinder.goal, listening: pathListeners(world.bot) }, { reason: 'stopped', did: ['walk'], stops: 1, goal: null, listening: NO_PATH_LISTENERS }, label)
  }
})

test('a strike or a useon whose walk reaches its goal right after another verb or a reflex took the body ends as stopped before the equip', async () => {
  // /shoot claims the lane and leaves the pathfinder alone.
  const shoot = (world) => world.env.claimLane('shoot', 8000)
  const unstuck = (world) => world.env.legs.take('unstuck', 'free the body from a wedge')
  for (const [label, world, route, query, take, at] of [
    ['a strike on a frame', frameWorld([frame(20, 3.5, 'wheat')]), '/strike', { name: 'item_frame', item: 'iron_sword' }, shoot, new Vec3(1.5, 64, 0.5)],
    ['a useon on a frame', frameWorld([frame(20, 3.5, null)]), '/useon', { name: 'item_frame', item: 'wheat' }, unstuck, new Vec3(1.5, 64, 0.5)],
    ['a strike on a zombie', verbWorld([zombie(6.5)]), '/strike', { name: 'zombie' }, shoot, new Vec3(5, 64, 0.5)]
  ]) {
    // The take and the arrival in reach both fall at 520 ms, between two physicsTicks. The pathfinder clears its goal on goal_reached.
    world.bot.pathfinder.goto = (g) => new Promise((resolve) => {
      world.did.push('walk')
      world.bot.pathfinder.goal = g
      world.clock.setTimeout(() => {
        take(world)
        world.bot.entity.position = at
        world.bot.pathfinder.goal = null
        world.bot.emit('goal_reached', g)
        resolve()
      }, 520)
    })
    const res = await drive(route, query, world)
    assert.strictEqual(res.error, undefined, res.error && `${label}: ${res.error.message}`)
    assert.deepStrictEqual({ reason: res.body.reason, did: world.did, held: world.bot.heldItem, stops: world.stops(), listening: pathListeners(world.bot) }, { reason: 'stopped', did: ['walk'], held: null, stops: 0, listening: NO_PATH_LISTENERS }, label)
  }
})

test('a strike whose walk to a frame or a zombie loses the lane to /brace stops the pathfinder on the next physicsTick', async () => {
  for (const [label, world, query] of [
    ['frame', frameWorld([frame(20, 3.5, 'wheat')]), { name: 'item_frame', item: 'iron_sword' }],
    ['zombie', verbWorld([zombie(6.5)]), { name: 'zombie' }]
  ]) {
    let stoppedAt = null
    const stopPath = world.env.stopPath
    world.env.stopPath = () => {
      stoppedAt ??= world.clock.now()
      stopPath()
    }
    // As goto, it fails once the goal changes. /brace takes the lane at 500 ms, and physicsTicks fall on every 50 ms.
    world.bot.pathfinder.goto = (g) => new Promise((resolve, reject) => {
      world.did.push('walk')
      world.bot.pathfinder.goal = g
      const changed = (n) => {
        if (n === g) return
        world.bot.removeListener('goal_updated', changed)
        reject(Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' }))
      }
      world.bot.on('goal_updated', changed)
      world.clock.setTimeout(() => world.env.claimLane('brace', 8000, true), 500)
    })
    const res = await drive('/strike', query, world)
    assert.strictEqual(res.error, undefined, res.error && `${label}: ${res.error.message}`)
    assert.deepStrictEqual({ reason: res.body.reason, did: world.did, held: world.bot.heldItem, stops: world.stops(), goal: world.bot.pathfinder.goal, listening: pathListeners(world.bot) }, { reason: 'stopped', did: ['walk'], held: null, stops: 1, goal: null, listening: NO_PATH_LISTENERS }, label)
    assert.ok(stoppedAt !== null && stoppedAt <= 600, `${label} stopped the walk at ${stoppedAt} ms`)
  }
})

test('a strike walk to a zombie or a frame whose time runs out a moment after another goal took the pathfinder leaves that goal alone', async () => {
  for (const [label, world, query, at] of [
    ['zombie', verbWorld([zombie(6.5)]), { name: 'zombie' }, null],
    ['frame in reach', frameWorld([frame(20, 3.5, 'wheat')]), { name: 'item_frame', item: 'iron_sword' }, new Vec3(1.9, 64, 0.5)],
    ['frame out of reach', frameWorld([frame(20, 3.5, 'wheat')]), { name: 'item_frame', item: 'iron_sword' }, null]
  ]) {
    const other = new goals.GoalBlock(9, 64, 9)
    // The other goal lands 1 ms before the walk's time runs out, and goto fails with GoalChanged 1 ms after that time.
    world.bot.pathfinder.goto = (g) => new Promise((resolve, reject) => {
      world.bot.pathfinder.goal = g
      if (at) world.bot.entity.position = at
      world.clock.setTimeout(() => {
        world.bot.pathfinder.goal = other
        world.bot.emit('goal_updated', other, false)
        world.clock.setTimeout(() => reject(Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' })), 2)
      }, rules.STRIKE_APPROACH_MS - 1)
    })
    await drive('/strike', query, world)
    assert.deepStrictEqual({ stops: world.stops(), kept: world.bot.pathfinder.goal === other }, { stops: 0, kept: true }, label)
  }
})

test('a stop during the useon walk to a creature ends as stopped', async () => {
  const world = verbWorld([zombie(6.5)])
  world.bot.pathfinder.goto = () => new Promise((resolve, reject) => {
    world.did.push('walk')
    world.env.stopPath = () => reject(Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' }))
    world.clock.setTimeout(world.stop, 500)
  })
  const res = await drive('/useon', { name: 'zombie', item: 'shears' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual({ ...res.body, did: world.did }, { used: null, on: 'zombie', reason: 'stopped', did: ['walk'] })
})

// The goto failures that leave the pathfinder walking the best path it found.
const walkingFails = [['NoPath', 'No path to the goal!'], ['Timeout', 'Took to long to decide path to goal!']]

test('a strike or a useon on a creature whose goto finds no path or times out stops the pathfinder before it answers', async () => {
  for (const [route, query] of [['/strike', { name: 'zombie' }], ['/useon', { name: 'zombie', item: 'shears' }]]) {
    for (const [name, message] of walkingFails) {
      const world = verbWorld([zombie(6.5)])
      world.bot.pathfinder.goto = async (goal) => {
        world.did.push('walk')
        world.bot.pathfinder.goal = goal
        throw Object.assign(new Error(message), { name })
      }
      const res = await drive(route, query, world)
      assert.deepStrictEqual({ error: res.error && res.error.message, did: world.did, stops: world.stops() }, { error: message, did: ['walk'], stops: 1 }, `${route} ${name}`)
    }
  }
})

test('a strike or a useon walk to a creature whose goto finds no path or times out a moment after another goal took the pathfinder leaves that goal alone', async () => {
  for (const [route, query] of [['/strike', { name: 'zombie' }], ['/useon', { name: 'zombie', item: 'shears' }]]) {
    for (const [name, message] of walkingFails) {
      const world = verbWorld([zombie(6.5)])
      const other = new goals.GoalBlock(9, 64, 9)
      world.bot.pathfinder.goto = (g) => new Promise((resolve, reject) => {
        world.bot.pathfinder.goal = g
        world.clock.setTimeout(() => {
          world.bot.pathfinder.goal = other
          world.bot.emit('goal_updated', other, false)
          world.clock.setTimeout(() => reject(Object.assign(new Error(message), { name })), 1)
        }, 500)
      })
      await drive(route, query, world)
      assert.deepStrictEqual({ stops: world.stops(), kept: world.bot.pathfinder.goal === other }, { stops: 0, kept: true }, `${route} ${name}`)
    }
  }
})

test('a strike or a useon on a frame whose goto times out stops the pathfinder and says the walk ran out of time on its way', async () => {
  for (const [route, item, fill] of [['/strike', 'iron_sword', 'wheat'], ['/useon', 'wheat', null]]) {
    const world = frameWorld([frame(20, 3.5, fill)])
    world.bot.pathfinder.goto = async (goal) => {
      world.did.push('walk')
      world.bot.pathfinder.goal = goal
      throw Object.assign(new Error(walkingFails[1][1]), { name: 'Timeout' })
    }
    const res = await drive(route, { name: 'item_frame', item }, world)
    assert.deepStrictEqual({ error: res.error ? res.error.message : `no error, note ${res.body.note}`, did: world.did, stops: world.stops() }, { error: 'the walk to the item_frame at 3,65,0 ran out of time on its way', did: ['walk'], stops: 1 }, route)
  }
})

test('a useon looks at the face of a frame facing north, on the far side of its cell', async () => {
  const world = frameWorld([Object.assign(frame(20, 3, null, true, 2), { position: new Vec3(3, 65, 0) })])
  world.bot.entity.position = new Vec3(3.5, 64, -1.5)
  const looks = []
  world.bot.lookAt = async (p) => { looks.push(p.toArray()) }
  world.bot.useOn = async (en) => {
    world.did.push(`use ${en.id}`)
    world.hold(en, 'wheat')
  }
  const res = await drive('/useon', { name: 'item_frame', item: 'wheat' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(looks, [[3.5, 65.5, 0.96875]])
  assert.deepStrictEqual(world.did, ['equip wheat', 'use 20'])
})

test('strike and useon refuse a frame of unknown facing before any walk, and say so', async () => {
  for (const [route, item, fill] of [['/strike', 'iron_sword', 'wheat'], ['/useon', 'wheat', null]]) {
    const unknown = frame(20, 2.5, fill)
    delete unknown.objectData
    const world = frameWorld([unknown])
    const res = await drive(route, { name: 'item_frame', item }, world)
    assert.strictEqual(res.error ? res.error.message : `no error, did ${world.did.join(', ')}`, 'the item_frame at 2,65,0 has no known facing, its reach is unknown', route)
    assert.deepStrictEqual(world.did, [], route)
  }
})

test('a frame keeps the objectData of its spawn once mineflayer has made its entity', async () => {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.write = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false, plugins: { entities: true } })
  // bot.js wires before mineflayer injects its plugins.
  loadBotFunctions(['wireDamageTypes', 'keepFrameFacing'], { bot }).wireDamageTypes()
  await once(bot, 'inject_allowed')
  const spawn = (entityId, name, objectData) => client.emit('spawn_entity', {
    entityId, objectUUID: `uuid-${entityId}`, type: mcData.entitiesByName[name].id, x: 6, y: 150, z: -1, pitch: 0, yaw: 0, headPitch: 0, objectData, velocity: { x: 0, y: 0, z: 0 }
  })
  spawn(2663, 'item_frame', 2)
  spawn(2664, 'glow_item_frame', 3)
  spawn(2665, 'zombie', 0)
  assert.deepStrictEqual([2663, 2664, 2665].map((id) => [bot.entities[id].name, bot.entities[id].objectData]), [['item_frame', 2], ['glow_item_frame', 3], ['zombie', undefined]])
})

test('a strike or a useon on a frame that leaves swing reach after the walk reached it names the frame, on 1.7.10 too', async () => {
  for (const legacy of [false, true]) {
    for (const [route, item, fill] of [['/strike', 'iron_sword', 'wheat'], ['/useon', 'wheat', null]]) {
      const world = frameWorld([frame(20, 3.5, fill)], { legacy })
      world.bot.pathfinder.goto = reachWalk(world, new Vec3(3, 64, 0))
      world.bot.lookAt = async () => { world.bot.entities[20].position.y = 69 }
      const res = await drive(route, { name: 'item_frame', item }, world)
      assert.strictEqual(res.error ? res.error.message : `no error, note ${res.body.note}`, 'the item_frame at 3,69,0 stays out of swing reach from here', `${route} on 1.7.10 ${legacy}`)
      assert.deepStrictEqual(world.did, ['walk', `equip ${item}`], `${route} on 1.7.10 ${legacy}`)
    }
  }
})

test('a strike on a frame counts a frame update queued in the tick of the age update that ends its wait, and goes on to the drop', async () => {
  const world = frameWorld([frame(20, 3.5, 'wheat')], { legacy: true })
  world.bot.attack = (en) => {
    world.did.push(`swing ${en.id}`)
    // The first age update after the swing opens the 10 ticks and the second closes them.
    let ages = 0
    const onTime = () => {
      if (++ages < 2) return
      world.bot.removeListener('time', onTime)
      world.hold(en, null)
    }
    world.bot.on('time', onTime)
    world.bot.entities[30] = wheatDrop(en.position.clone())
  }
  const res = await drive('/strike', { name: 'item_frame', item: 'iron_sword' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual([res.body.swings, res.body.dropped], [1, 'wheat'], res.body.note)
  assert.deepStrictEqual(world.did.filter((d) => !d.startsWith('jump')), ['walk', 'equip iron_sword', 'swing 20', 'walk'])
})

// A 1.7.10 strike at a wheat frame or a useon of wheat on an empty one, with answer(world, en) as the server's answer to
// the swing or the click. ageless sends no server age at all, and the other opts go to frameWorld. actT and replyT are
// the clock at the act and at the reply.
async function frameAct (route, answer, { ageless = false, ...opts } = {}) {
  const strike = route === '/strike'
  const world = frameWorld([frame(20, 3.5, strike ? 'wheat' : null)], { legacy: true, ...opts })
  if (ageless) {
    world.ageEvery = Infinity
    world.bot.time.age = null
  }
  let actT = null
  const act = (en) => {
    actT = world.clock.now()
    answer(world, en)
  }
  world.bot.attack = act
  world.bot.useOn = async (en) => act(en)
  const res = await drive(route, { name: 'item_frame', item: strike ? 'iron_sword' : 'wheat' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { reply: res.body, actT, replyT: world.clock.now() }
}

test('a strike or a useon on a frame counts the frame update the server sends at the end of a 2 s stall right after the act', async () => {
  const stalled = (item) => (world, en) => {
    world.stall(2000)
    world.server(0, () => {
      world.hold(en, item)
      if (!item) world.bot.entities[30] = wheatDrop(en.position.clone())
    })
  }
  const strike = await frameAct('/strike', stalled(null))
  assert.strictEqual(strike.reply.dropped, 'wheat', strike.reply.note)
  const useon = await frameAct('/useon', stalled('wheat'))
  assert.deepStrictEqual([useon.reply.ok, useon.reply.framed], [undefined, 'wheat'], useon.reply.reason)
})

test('a strike or a useon on a frame counts the frame update that follows the burst of stale server ages a proxy stall over the act queued', async () => {
  // The proxy holds the act and the server's ages for 2 s and then delivers both ages at once. The server answers the act
  // 50 ms later, as live after a 2 s stall.
  const held = (item) => (world, en) => {
    const age = world.bot.time.age
    world.ageEvery = Infinity
    world.clock.setTimeout(() => {
      for (const stale of [age + 20, age + 40]) {
        world.bot.time.age = stale
        world.bot.emit('time')
      }
      world.ageEvery = 20
      world.clock.setTimeout(() => {
        world.hold(en, item)
        if (!item) world.bot.entities[30] = wheatDrop(en.position.clone())
      }, 50)
    }, 2000)
  }
  const strike = await frameAct('/strike', held(null))
  assert.strictEqual(strike.reply.dropped, 'wheat', strike.reply.note)
  const useon = await frameAct('/useon', held('wheat'))
  assert.deepStrictEqual([useon.reply.ok, useon.reply.framed], [undefined, 'wheat'], useon.reply.reason)
})

// ms as the seconds a frame reply names.
const seconds = (ms) => Math.round(ms / 100) / 10

test('a strike or a useon on a frame the server never updates says so once 10 ticks of server age passed the act, and within the deadline without any age', async () => {
  for (const route of ['/strike', '/useon']) {
    const ticking = await frameAct(route, () => {})
    const said = (r) => r.reply.reason || r.reply.note
    assert.match(said(ticking), /^the server sent no frame update within 10 ticks, /, route)
    // The server sends its age once a second. The first age after the act opens the 10 ticks, the next one closes them.
    const waited = ticking.replyT - ticking.actT
    assert.ok(waited >= 1000 && waited <= 2050, `${route} answered ${waited} ms after the act`)
    const ageless = await frameAct(route, () => {}, { ageless: true })
    // /strike waits out its own deadline, /useon 5 s from just before the click.
    const deadline = route === '/strike' ? rules.strikeBudgetMs(1) : ageless.actT + 5000
    const none = `the server sent no frame update within ${seconds(deadline - ageless.actT)} s (no tick from the server), `
    assert.ok(said(ageless).startsWith(none), `${route} without any age said: ${said(ageless)}`)
    assert.ok(ageless.replyT <= deadline + 20, `${route} without any age answered at ${ageless.replyT} ms, past ${deadline} ms`)
  }
})

test('a strike or a useon on a frame whose server stops sending ages after 5 ticks names the ticks it counted by the deadline', async () => {
  for (const route of ['/strike', '/useon']) {
    // From the act the server sends its age every 5 ticks, and none after the second of those.
    const { reply, actT } = await frameAct(route, (world) => {
      world.ageEvery = 5
      let ages = 0
      world.bot.on('time', function onTime () {
        if (++ages < 2) return
        world.bot.removeListener('time', onTime)
        world.ageEvery = Infinity
      })
    })
    const deadline = route === '/strike' ? rules.strikeBudgetMs(1) : actT + 5000
    const short = `the server sent no frame update within ${seconds(deadline - actT)} s (5 of 10 ticks counted), `
    const said = reply.reason || reply.note
    assert.ok(said.startsWith(short), `${route} said: ${said}`)
  }
})

test('a strike or a useon on a frame counts only the ticks up to its deadline when an age arrives in the turn the deadline ends the wait', async () => {
  for (const route of ['/strike', '/useon']) {
    // The server sends 5 ticks of age, then none. One age of 20 more ticks arrives in the step after the deadline's.
    const { reply } = await frameAct(route, (world) => {
      world.ageEvery = 5
      let ages = 0
      world.bot.on('time', function onTime () {
        if (++ages < 2) return
        world.bot.removeListener('time', onTime)
        world.ageEvery = Infinity
      })
      const deadline = route === '/strike' ? rules.strikeBudgetMs(1) : world.clock.now() + 5000
      world.clock.setTimeout(() => {
        world.bot.time.age += 20
        world.bot.emit('time')
      }, deadline - world.clock.now() + 10)
    })
    const said = reply.reason || reply.note
    assert.match(said, /^the server sent no frame update within [\d.]+ s \(5 of 10 ticks counted\), /, route)
  }
})

// The server's answer to the act of a frameAct on route: the strike's frame gives up its wheat as a drop, the useon's
// frame takes the wheat.
function frameAnswer (route, world, en) {
  const strike = route === '/strike'
  world.hold(en, strike ? null : 'wheat')
  if (strike) world.bot.entities[30] = wheatDrop(en.position.clone())
}

function assertCounted (route, reply, label) {
  if (route === '/strike') assert.strictEqual(reply.dropped, 'wheat', `${label}: ${reply.note}`)
  else assert.deepStrictEqual([reply.ok, reply.framed], [undefined, 'wheat'], `${label}: ${reply.reason}`)
}

test('a strike or a useon on a frame counts the frame update that beats the next age after a proxy stall that queued one stale age', async () => {
  for (const route of ['/strike', '/useon']) {
    let held
    // The proxy holds the act and the server's ages until 100 ms after the server sends its next age, then delivers
    // both. The server answers the act 50 ms later, 850 ms before its following age.
    const { reply } = await frameAct(route, (world, en) => {
      const ms = 1000 - world.clock.now() % 1000 + 100
      held = world.proxy(ms)
      world.clock.setTimeout(() => frameAnswer(route, world, en), ms + 50)
    })
    assert.strictEqual(held.length, 1, `${route}: control, the proxy held one age`)
    assertCounted(route, reply, route)
  }
})

test('a strike or a useon on a frame waits 10 ticks of server time on a slow server whose ages arrive late', async () => {
  // Ticks take 80 ms and each age arrives 300 ms after its tick, 1600 ms after the one before.
  const slow = { tickMs: 80, ageLag: 300 }
  for (const route of ['/strike', '/useon']) {
    // The server answers 8 ticks after the act, 640 ms on the wall clock.
    const late = await frameAct(route, (world, en) => world.server(8 * 80, () => frameAnswer(route, world, en)), slow)
    assertCounted(route, late.reply, `${route} answered after 8 ticks`)
    const never = await frameAct(route, () => {}, slow)
    assert.match(never.reply.reason || never.reply.note, /^the server sent no frame update within 10 ticks, /, route)
    // The first age after the act opens the 10 ticks and the next one closes them. The first age of all arrives at 1900 ms.
    const waited = never.replyT - never.actT
    assert.ok(waited >= 1600 && waited <= 3550, `${route} answered ${waited} ms after the act`)
  }
})

test('a strike or a useon on a frame waits through a catch-up burst of server ages up to its deadline and no longer', async () => {
  // A server catching up runs its ticks 10 ms apart, so every age arrives in under half its ticks' time.
  const catchUp = { tickMs: 10 }
  for (const route of ['/strike', '/useon']) {
    // The answer comes 200 ticks after the act.
    const late = await frameAct(route, (world, en) => world.server(2000, () => frameAnswer(route, world, en)), catchUp)
    assertCounted(route, late.reply, `${route} answered after 200 ticks`)
    const never = await frameAct(route, () => {}, catchUp)
    // /strike waits out its own deadline, /useon 5 s from just before the click.
    const deadline = route === '/strike' ? rules.strikeBudgetMs(1) : never.actT + 5000
    const said = never.reply.reason || never.reply.note
    const uncounted = `the server sent no frame update within ${seconds(deadline - never.actT)} s (0 of 10 ticks counted), `
    assert.ok(said.startsWith(uncounted), `${route} said: ${said}`)
    assert.ok(never.replyT >= deadline - 50 && never.replyT <= deadline + 20, `${route} answered at ${never.replyT} ms, deadline ${deadline} ms`)
  }
})

// A 1.7.10 strike at the wheat frame at x frameX, 3 east of the body, and y frameY. The swing drops item 30, stack
// wheat, at the frame, and flight ms later the server moves it to each of mid a second apart, then to lands. bob
// then moves it 0.25 up or down every second. stall [at, ms] halts the server for ms from at ms after the drop. From 10
// ticks after the drop the server takes it once the body's box grown by 1 reaches it. pickup 'pockets
// first' puts rise wheat into the pockets and removes the drop 2 ticks later, 'entity first' removes the drop and puts
// the wheat into the pockets 3 ticks later, and 'vanish' only removes it. onCell ends a walk to a cell on that cell,
// else 2 west of it, and noPath fails it with an Error without a reason. late spawns the drop without its item and
// sends the item a tick later. hides takes the drop out of sight as it moves. stopMs sends a /stop that many ms after
// the drop. other lays item 31, one wheat, there from the start. onApproach runs as the walk to the frame starts and
// onWalk as each walk to the drop starts, given the world, the strike's deadline, gone(id) removing entity id and
// pocket(n) putting n wheat into the pockets, and the walk's goal. The server sends its age every ageEvery ticks, and
// with ageAfter sends none, the age unknown, until that many ms after the drop.
async function strikeDrop (lands, { blocks = null, onCell = true, noPath = false, frameX = 3.5, frameY = 65, late = false, hides = false, flight = 250, mid = [], bob = false, stall = null, stopMs = null, pickup = 'entity first', stack = 1, rise = stack, other = null, onApproach = null, onWalk = null, ageEvery = 20, ageAfter = null } = {}) {
  const world = frameWorld([frame(20, frameX, 'wheat')], { legacy: true })
  const { bot, clock, did } = world
  world.ageEvery = ageAfter === null ? ageEvery : Infinity
  if (ageAfter !== null) bot.time.age = null
  const deadline = clock.now() + rules.strikeBudgetMs(1)
  // The pockets hold a full stack of wheat, and a pickup fills a second one.
  const wheat = [{ name: 'wheat', count: 64 }]
  const items = bot.inventory.items
  bot.inventory.items = () => [...items().filter((i) => i.name !== 'wheat'), ...wheat]
  const pocket = (n = rise) => wheat.push({ name: 'wheat', count: n })
  const gone = (id) => {
    bot.emit('entityGone', bot.entities[id])
    delete bot.entities[id]
  }
  const hooks = { ...world, deadline, gone, pocket }
  if (other) bot.entities[31] = Object.assign(wheatDrop(other), { id: 31 })
  bot.entities[20].position.y = frameY
  // The real reach check refuses a frame out of melee reach.
  if (frameY !== 65) world.env.inMeleeReach = () => true
  if (blocks) {
    const floor = bot.blockAt
    bot.blockAt = (p) => blocks(p) ? { name: 'air', boundingBox: 'empty', position: p } : floor(p)
  }
  const walk = bot.pathfinder.goto
  bot.pathfinder.goto = async (goal) => {
    if (!(goal instanceof goals.GoalBlock)) {
      if (onApproach) await onApproach(hooks)
      return walk(goal)
    }
    if (noPath) throw new Error('No path to the goal!')
    if (onWalk) await onWalk(hooks, goal)
    if (!onCell) return walk(goal)
    did.push('walk')
    bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5)
  }
  let dropT = Infinity
  bot.attack = (en) => {
    did.push(`swing ${en.id}`)
    world.hold(en, null)
    dropT = clock.now()
    bot.entities[30] = wheatDrop(en.position.clone(), !late, stack)
    if (late) clock.setTimeout(() => giveWheat(bot.entities[30], stack), 50)
    if (stopMs !== null) clock.setTimeout(world.stop, stopMs)
    if (stall) clock.setTimeout(() => world.stall(stall[1]), stall[0])
    if (ageAfter !== null) clock.setTimeout(() => { world.ageEvery = ageEvery }, ageAfter)
    // The server's update that puts item 30 at p.
    const move = (p) => {
      const item = bot.entities[30]
      if (!item) return null
      item.position = p
      bot.emit('entityMoved', item)
      return item
    }
    const land = () => {
      const item = move(lands)
      if (!item) return
      if (hides) item.seen = false
      let up = false
      if (bob) {
        clock.setInterval(() => {
          up = !up
          if (bot.entities[30]) move(bot.entities[30].position.offset(0, up ? 0.25 : -0.25, 0))
        }, 1000)
      }
    }
    const fly = (i) => () => {
      if (i === mid.length) land()
      else if (move(mid[i])) world.server(1000, fly(i + 1))
    }
    world.server(flight, fly(0))
  }
  let taken = false
  clock.setInterval(() => {
    const item = bot.entities[30]
    if (!item || taken || clock.now() < dropT + 500) return
    const d = item.position.minus(bot.entity.position)
    if (Math.abs(d.x) < 1.425 && Math.abs(d.z) < 1.425 && d.y > -0.75 && d.y < 2.3) {
      taken = true
      if (pickup === 'pockets first') {
        pocket()
        clock.setTimeout(() => gone(30), 100)
        return
      }
      gone(30)
      if (pickup === 'entity first') clock.setTimeout(pocket, 150)
    }
  }, 50)
  const res = await drive('/strike', { name: 'item_frame', item: 'iron_sword' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { note: res.body.note, lying: !!bot.entities[30], ...(res.body.reason && { reason: res.body.reason }) }
}

test('a strike on a frame walks onto its drop where the drop lands, and says it picked the drop up only once the body did', async () => {
  const lands = new Vec3(5.2, 64, 0.5)
  // A pit 2 deep from (5, -1) to (6, 1).
  const pit = (p) => p.x >= 5 && p.x <= 6 && Math.abs(p.z) <= 1 && (p.y === 62 || p.y === 63)
  const got = {
    onCell: await strikeDrop(lands),
    short: await strikeDrop(lands, { onCell: false }),
    pit: await strikeDrop(new Vec3(5.2, 62, 0.5), { blocks: pit })
  }
  assert.deepStrictEqual(got, {
    onCell: { note: 'picked up the drop, the frame stays empty', lying: false },
    short: { note: 'walked to the drop, it still lies at 5,64,0, the frame stays empty', lying: true },
    pit: { note: 'the drop at 5,62,0 lies out of walking reach, left it, the frame stays empty', lying: true }
  })
})

test('a strike on a frame judges a drop flying over a drop-off where it comes to rest, and takes one in flight next to the body', async () => {
  // Holes 2 deep from (3, -1) to (4, 1) under the frame and from (3, 4) to (4, 5).
  const under = (p) => p.x >= 3 && p.x <= 4 && Math.abs(p.z) <= 1 && (p.y === 62 || p.y === 63)
  const beyond = (p) => p.x >= 3 && p.x <= 4 && p.z >= 4 && p.z <= 5 && (p.y === 62 || p.y === 63)
  // A live frame drop's first position update came 998 to 1051 ms after its spawn.
  const flight = 1050
  assert.deepStrictEqual({
    floor: await strikeDrop(new Vec3(3.6, 64, 4.6), { blocks: under, flight }),
    hole: await strikeDrop(new Vec3(3.6, 62, 4.6), { blocks: (p) => under(p) || beyond(p), flight }),
    nextTo: await strikeDrop(new Vec3(9.2, 64, 4.6), { frameX: 1.5, flight })
  }, {
    floor: { note: 'picked up the drop, the frame stays empty', lying: false },
    hole: { note: 'the drop at 3,62,4 lies out of walking reach, left it, the frame stays empty', lying: true },
    nextTo: { note: 'picked up the drop, the frame stays empty', lying: false }
  })
})

test('a strike on a frame waits out a server stall before its drop first moves or in mid-flight, and picks the drop up where it lands', async () => {
  // A hole 2 deep from (3, -1) to (4, 1) under the frame.
  const under = (p) => p.x >= 3 && p.x <= 4 && Math.abs(p.z) <= 1 && (p.y === 62 || p.y === 63)
  const lands = new Vec3(3.6, 64, 4.6)
  assert.deepStrictEqual({
    spawn: await strikeDrop(lands, { blocks: under, flight: 1050, stall: [0, 1600] }),
    flight: await strikeDrop(lands, { blocks: under, flight: 1050, mid: [new Vec3(3.6, 64.5, 1.4)], stall: [1150, 1600] })
  }, {
    spawn: { note: 'picked up the drop, the frame stays empty', lying: false },
    flight: { note: 'picked up the drop, the frame stays empty', lying: false }
  })
})

test('a strike on a frame judges a drop at rest only once it lands, with the server age every 60 ticks or none before the drop', async () => {
  // The drop flies 4 s on position updates 20 ticks apart.
  const mid = [new Vec3(3.8, 65.2, 1.3), new Vec3(4.2, 64.8, 2.1), new Vec3(4.6, 64.5, 2.9), new Vec3(5, 64.2, 3.7)]
  const walked = async (opts) => {
    const walks = []
    const onWalk = (hooks, goal) => { walks.push(`${goal.x},${goal.y},${goal.z}`) }
    return { ...await strikeDrop(new Vec3(5.2, 64, 4.6), { flight: 1050, mid, onWalk, ...opts }), walks }
  }
  const landed = { note: 'picked up the drop, the frame stays empty', lying: false, walks: ['5,64,4'] }
  assert.deepStrictEqual({
    control: await walked({}),
    slow: await walked({ ageEvery: 60 }),
    ageless: await walked({ ageAfter: 1500 })
  }, { control: landed, slow: landed, ageless: landed })
})

test('a strike on a frame names no place for a drop still moving at its deadline, and a stop ends the wait for it', async () => {
  const pit = (p) => p.x >= 5 && p.x <= 6 && Math.abs(p.z) <= 1 && (p.y === 62 || p.y === 63)
  const lands = new Vec3(5.2, 62, 0.5)
  assert.deepStrictEqual({
    deadline: await strikeDrop(lands, { blocks: pit, bob: true }),
    stop: await strikeDrop(lands, { blocks: pit, bob: true, stopMs: 3000 })
  }, {
    deadline: { note: 'the drop was still moving when the time ran out, the frame stays empty', lying: true },
    stop: { note: 'stopped before the drop, the frame stays empty', lying: true, reason: 'stopped' }
  })
})

test('a strike on a frame waits out a drop whose item arrives a tick after its spawn, and picks it up', async () => {
  assert.deepStrictEqual(await strikeDrop(new Vec3(5.2, 64, 0.5), { late: true }), { note: 'picked up the drop, the frame stays empty', lying: false })
})

test('a strike on a frame lets go of a drop that slides out of sight, and names no place for it', async () => {
  assert.deepStrictEqual(await strikeDrop(new Vec3(5.2, 64, 0.5), { hides: true }), { note: 'lost sight of the drop, the frame stays empty', lying: true })
})

test('a strike on a frame 5 above the floor walks to the floor under its falling drop', async () => {
  assert.deepStrictEqual(await strikeDrop(new Vec3(5.2, 64, 0.5), { frameY: 69 }), { note: 'picked up the drop, the frame stays empty', lying: false })
})

test('a walk to a frame drop or to the drops of a kill that fails without a reason gives up, never claims the walk', async () => {
  const drop = await strikeDrop(new Vec3(5.2, 64, 0.5), { noPath: true })
  const world = realWorld([zombie(2.5)], () => null)
  world.bot.attack = () => { delete world.bot.entities[7] }
  world.bot.pathfinder.goto = async () => { throw new Error('No path to the goal!') }
  const res = await drive('/strike', { name: 'zombie' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual({ drop, kill: { note: res.body.note, reason: res.body.reason } }, {
    drop: { note: 'the walk to the drop gave up, the frame stays empty', lying: true, reason: 'no path' },
    kill: { note: 'the walk to the drops gave up', reason: 'no path' }
  })
})

test('a walk to a frame drop whose goto finds no path or times out stops the pathfinder once, and one that loses the lane to /brace stops it on the next physicsTick', async () => {
  const gaveUp = { note: 'the walk to the drop gave up, the frame stays empty', lying: true, reason: 'no path' }
  for (const [name, message] of walkingFails) {
    let world = null
    const onWalk = (hooks, goal) => {
      world = hooks
      hooks.bot.pathfinder.goal = goal
      throw Object.assign(new Error(message), { name })
    }
    const got = await strikeDrop(new Vec3(5.2, 64, 0.5), { onWalk })
    assert.deepStrictEqual({ ...got, stops: world.stops(), goal: world.bot.pathfinder.goal }, { ...gaveUp, stops: 1, goal: null }, name)
  }
  let world = null, claimAt = null, stoppedAt = null
  const onWalk = (hooks, goal) => {
    world = hooks
    claimAt = hooks.clock.now() + 100
    hooks.clock.setTimeout(() => hooks.env.claimLane('brace', 8000, true), 100)
    hooks.bot.once('path_stop', () => { stoppedAt = hooks.clock.now() })
    return hooks.gotoUntilChanged(goal)
  }
  const got = await strikeDrop(new Vec3(5.2, 64, 0.5), { onWalk })
  assert.deepStrictEqual({ ...got, stops: world.stops(), goal: world.bot.pathfinder.goal }, { note: 'stopped before the drop, the frame stays empty', lying: true, reason: 'stopped', stops: 1, goal: null })
  assert.ok(stoppedAt - claimAt <= 100, `the lane went at ${claimAt} ms and the walk stopped at ${stoppedAt} ms`)
})

test('a strike on a frame says it picked the drop up once the pockets gain it, before or after the drop leaves', async () => {
  const lands = new Vec3(5.2, 64, 0.5)
  assert.deepStrictEqual({
    pockets: await strikeDrop(lands, { pickup: 'pockets first' }),
    entity: await strikeDrop(lands, { pickup: 'entity first' })
  }, {
    pockets: { note: 'picked up the drop, the frame stays empty', lying: false },
    entity: { note: 'picked up the drop, the frame stays empty', lying: false }
  })
})

test('a strike on a frame does not take wheat picked up on the walk to the frame or to the drop for the drop', async () => {
  const take = ({ bot, gone, pocket }) => {
    if (!bot.entities[31]) return
    gone(31)
    pocket(1)
  }
  assert.deepStrictEqual({
    approach: await strikeDrop(new Vec3(9.2, 64, 0.5), { onCell: false, frameX: 7.5, other: new Vec3(3.5, 64, 0.5), onApproach: take }),
    walk: await strikeDrop(new Vec3(5.2, 64, 0.5), { onCell: false, other: new Vec3(4.5, 64, 2.5), onWalk: take })
  }, {
    approach: { note: 'walked to the drop, it still lies at 9,64,0, the frame stays empty', lying: true },
    walk: { note: 'walked to the drop, it still lies at 5,64,0, the frame stays empty', lying: true }
  })
})

test('a strike on a frame says it lost sight of a drop that left its sight before the server removed it', async () => {
  const unseen = ({ bot, gone }) => {
    bot.entities[30].seen = false
    gone(30)
  }
  assert.deepStrictEqual(await strikeDrop(new Vec3(5.2, 64, 0.5), { onWalk: unseen }), { note: 'lost sight of the drop, the frame stays empty', lying: false })
})

test('a strike on a frame says the drop merged into a seen wheat within 1 block of where it vanished, and gone past that', async () => {
  const lands = new Vec3(5.2, 64, 0.5)
  assert.deepStrictEqual({
    near: await strikeDrop(lands, { pickup: 'vanish', other: new Vec3(5.9, 64, 0.5) }),
    far: await strikeDrop(lands, { pickup: 'vanish', other: new Vec3(6.7, 64, 0.5) })
  }, {
    near: { note: 'the drop merged into the item at 5,64,0, the frame stays empty', lying: false },
    far: { note: 'the drop is gone, not into the pockets, the frame stays empty', lying: false }
  })
})

test('a strike on a frame waits out a slot update that lands after the strike deadline', async () => {
  // Each walk lasts until 60 ms before the deadline or 5.9 s, and the drop slides 3 east during every walk but the last.
  const slow = async ({ bot, clock, deadline }) => {
    const end = Math.min(clock.now() + 5900, deadline - 60)
    await new Promise((resolve) => clock.setTimeout(resolve, end - clock.now()))
    const item = bot.entities[30]
    if (end < deadline - 60) item.position = item.position.offset(3, 0, 0)
  }
  assert.deepStrictEqual(await strikeDrop(new Vec3(5.2, 64, 0.5), { onWalk: slow }), { note: 'picked up the drop, the frame stays empty', lying: false })
})

test('a strike on a frame says the drop is gone when the server removes it and the pockets gain nothing, as when another player takes it', async () => {
  assert.deepStrictEqual(await strikeDrop(new Vec3(5.2, 64, 0.5), { pickup: 'vanish' }), { note: 'the drop is gone, not into the pockets, the frame stays empty', lying: false })
})

test('a strike on a frame says the drop is gone when the server removes it and the pockets gain less than it held', async () => {
  assert.deepStrictEqual(await strikeDrop(new Vec3(5.2, 64, 0.5), { stack: 3, rise: 1 }), { note: 'the drop is gone, not into the pockets, the frame stays empty', lying: false })
})

test('a 1.7.10 strike on a frame counts the frame update the server sends during the swing', async () => {
  const world = frameWorld([frame(20, 2.5, 'wheat')], { legacy: true })
  world.bot.attack = (en) => {
    world.did.push(`swing ${en.id}`)
    en.metadata[FRAME_ITEM] = Item.toNotch(null)
    world.bot.emit('entityUpdate', en)
  }
  const res = await drive('/strike', { name: 'item_frame', item: 'iron_sword' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual([res.body.swings, res.body.dropped], [1, 'wheat'], res.body.note)
})

test('a strike refuses when every frame in sight is empty', async () => {
  const world = frameWorld([frame(21, 2.5, null), frame(20, 3.5, 'wheat', false)])
  const res = await drive('/strike', { name: 'item_frame', item: 'iron_sword' }, world)
  assert.ok(res.error, 'a strike at an empty frame')
  assert.match(res.error.message, /holds an item/)
  assert.deepStrictEqual(world.did, [])
  const seenOnly = await drive('/strike', { name: 'item_frame', item: 'iron_sword' }, frameWorld([frame(21, 2.5, null)]))
  assert.strictEqual(res.error.message, seenOnly.error.message)
})

// Each swing empties the frame it hits.
async function strikeFrame (world, query) {
  world.bot.attack = (en) => {
    world.did.push(`swing ${en.id}`)
    world.hold(en, null)
  }
  return drive('/strike', { name: 'item_frame', item: 'iron_sword', ...query }, world)
}

test('a strike with at swings at the filled frame in that cell past a nearer one', async () => {
  const world = frameWorld([frame(20, 2.5, 'wheat'), frame(21, 4.5, 'stick')])
  const res = await strikeFrame(world, { at: '4,65,0' })
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual([res.body.dropped, res.body.at], ['stick', { x: 4, y: 65, z: 0 }])
  assert.deepStrictEqual(world.did.filter((d) => d.startsWith('swing')), ['swing 21'])
})

test('a useon with at fills the empty frame in that cell past a nearer one', async () => {
  const { reply, did } = await frameWheat([frame(20, 2.5, null), frame(21, 4.5, null)], () => 'wheat', { at: '4,65,0' })
  assert.deepStrictEqual([reply.ok, reply.at, reply.framed], [undefined, { x: 4, y: 65, z: 0 }, 'wheat'])
  assert.deepStrictEqual(did.filter((d) => d.startsWith('use')), ['use 21'])
})

test('strike and useon with at answer a frame hidden in that cell as they answer no frame there', async () => {
  for (const [route, item, fill] of [['/strike', 'iron_sword', 'stick'], ['/useon', 'wheat', null]]) {
    // Frame 20 at 2,65,0 is the nearer frame that at must pass over.
    const ask = async (...far) => {
      const world = frameWorld([frame(20, 2.5, fill), ...far])
      const res = await drive(route, { name: 'item_frame', item, at: '4,65,0' }, world)
      return { error: res.error, did: world.did }
    }
    const seen = await ask(frame(21, 4.5, fill))
    assert.strictEqual(seen.error, undefined, `${route} control: ${seen.error && seen.error.message}`)
    const none = await ask()
    assert.ok(none.error, `${route} with no frame at 4,65,0, did ${none.did.join(', ')}`)
    const hidden = await ask(frame(21, 4.5, fill, false))
    assert.strictEqual(hidden.error && hidden.error.message, none.error.message, route)
    assert.deepStrictEqual(hidden.did, [], route)
  }
})

test('a strike with at refuses an empty frame in that cell, and a useon with at names what a filled one holds', async () => {
  const world = frameWorld([frame(20, 2.5, 'wheat'), frame(21, 4.5, null)])
  const res = await strikeFrame(world, { at: '4,65,0' })
  assert.match(res.error ? res.error.message : `no refusal, did ${world.did.join(', ')}`, /4,65,0/)
  assert.deepStrictEqual(world.did, [])
  const { reply, did } = await frameWheat([frame(20, 2.5, null), frame(21, 4.5, 'stick')], () => 'wheat', { at: '4,65,0' })
  assert.deepStrictEqual([reply.ok, reply.used, reply.at, reply.framed], [false, null, { x: 4, y: 65, z: 0 }, 'stick'])
  assert.match(reply.reason, /4,65,0/)
  assert.deepStrictEqual(did, [])
})

test('strike and useon refuse at on anything but an item frame, and a malformed at, before any walk', async () => {
  for (const [route, query, world, text] of [
    ['/strike', { name: 'zombie', at: '6,64,0' }, () => verbWorld([zombie(6.5)])],
    ['/useon', { name: 'zombie', item: 'shears', at: '6,64,0' }, () => verbWorld([zombie(6.5)])],
    ['/strike', { name: 'item_frame', item: 'iron_sword', at: '2,65' }, () => frameWorld([frame(20, 2.5, 'wheat')]), /^at takes x,y,z$/],
    ['/useon', { name: 'item_frame', item: 'wheat', at: '2,65' }, () => frameWorld([frame(20, 2.5, null)]), /^at takes x,y,z$/],
    ['/strike', { name: 'item_frame', item: 'iron_sword', at: '4,,0' }, () => frameWorld([frame(20, 2.5, 'wheat')]), /^at takes x,y,z$/],
    ['/useon', { name: 'item_frame', item: 'wheat', at: '4,a,0' }, () => frameWorld([frame(20, 2.5, null)]), /^at takes x,y,z$/],
    ['/strike', { name: 'item_frame', item: 'iron_sword', at: ' ,1,2' }, () => frameWorld([frame(20, 2.5, 'wheat')]), /^at takes x,y,z$/],
    ['/strike', { name: 'item_frame', item: 'iron_sword', at: '4,65,0,9' }, () => frameWorld([frame(20, 2.5, 'wheat')]), /^at takes x,y,z$/],
    ['/useon', { name: 'item_frame', item: 'wheat', at: '4,65,0,9' }, () => frameWorld([frame(20, 2.5, null)]), /^at takes x,y,z$/]
  ]) {
    const w = world()
    const res = await drive(route, query, w)
    assert.ok(res.error, `${route} ${query.name} at=${query.at}, did ${w.did.join(', ')}`)
    if (text) assert.match(res.error.message, text, `${route} at=${query.at}`)
    assert.deepStrictEqual(w.did, [], `${route} ${query.name} at=${query.at}`)
  }
})

test('entities name what each frame in sight holds, null for an empty one', () => {
  const { env } = frameWorld([frame(20, 2.5, 'wheat'), frame(21, 4.5, null), zombie(6.5)])
  const { entities } = runRoute('/entities', {}, env)
  assert.deepStrictEqual(entities.map((e) => [e.name, e.framed]), [['item_frame', 'wheat'], ['item_frame', null], ['zombie', undefined]])
})

test('a frame spawned at the corner of cell 85,65,0 shows as cell 85, and a strike at 85,65,0 hits it', async () => {
  const world = frameWorld([frame(20, 85, 'wheat')])
  world.bot.entities[20].position = new Vec3(85, 65, 0)
  world.bot.entity.position = new Vec3(82.5, 64, 0.5)
  assert.deepStrictEqual(runRoute('/entities', {}, world.env).entities.map((e) => e.pos), [{ x: 85, y: 65, z: 0 }])
  const res = await strikeFrame(world, { at: '85,65,0' })
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual([res.body.dropped, res.body.at], ['wheat', { x: 85, y: 65, z: 0 }])
})

test('a shot counts only once an arrow is loosed, and a kill only once the body sees the target die', async () => {
  const shoot = async (draw) => {
    const world = verbWorld([zombie(6.5)])
    world.env.drawAndLoose = async () => draw(world.bot)
    return (await drive('/shoot', { name: 'zombie' }, world)).body
  }
  const noLine = await shoot(() => false)
  assert.deepStrictEqual([noLine.shotsFired, noLine.killed], [0, false])
  // seen sets whether the body sees the zombie die.
  const dies = (seen) => (bot) => { bot.entities[7].seen = seen; delete bot.entities[7]; return true }
  const inSight = await shoot(dies(true))
  assert.deepStrictEqual([inSight.shotsFired, inSight.killed, inSight.outcome], [1, true, 'dead'], 'control: died in sight')
  const unseen = await shoot(dies(false))
  assert.deepStrictEqual([unseen.shotsFired, unseen.killed, unseen.outcome], [1, false, 'lost sight'])
})

test('a strike counts a kill and walks to the drops only once the body sees the target die', async () => {
  // seen sets whether the body sees the zombie die from the swing.
  const strike = async (seen) => {
    const world = verbWorld([zombie(2.5)])
    world.bot.attack = () => { world.did.push('swing'); world.bot.entities[7].seen = seen; delete world.bot.entities[7] }
    const res = await drive('/strike', { name: 'zombie' }, world)
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
    return { reply: res.body, did: world.did }
  }
  const inSight = await strike(true)
  assert.deepStrictEqual([inSight.reply.killed, inSight.reply.note, inSight.did], [true, 'walked to drops', ['swing', 'walk']], 'control: died in sight')
  const unseen = await strike(false)
  assert.deepStrictEqual([unseen.reply.killed, unseen.reply.reason, unseen.reply.note, unseen.did], [false, 'lost sight', 'lost sight of it', ['swing']])
})

test('a strike whose zombie goes out of sight swings no more and ends with lost sight', async () => {
  const walked = verbWorld([zombie(6.5)])
  walked.bot.pathfinder.goto = async () => { walked.did.push('walk'); walked.bot.entities[7].seen = false }
  const early = (await drive('/strike', { name: 'zombie', max: '2' }, walked)).body
  assert.deepStrictEqual({ swings: early.swings, reason: early.reason }, { swings: 0, reason: 'lost sight' })
  assert.deepStrictEqual(walked.did, ['walk'])
  const swung = verbWorld([zombie(2.5)])
  swung.bot.attack = () => { swung.did.push('swing'); swung.bot.entities[7].seen = false }
  const late = (await drive('/strike', { name: 'zombie', max: '2' }, swung)).body
  assert.deepStrictEqual({ swings: late.swings, reason: late.reason }, { swings: 1, reason: 'lost sight' })
})

test('a 1.7.10 strike with headroom swings on the way down from a jump, and under a 2-high ceiling never jumps', async () => {
  const open = verbWorld([zombie(2.5)], { legacy: true })
  await drive('/strike', { name: 'zombie', max: '3' }, open)
  assert.strictEqual(open.hits.length, 3)
  for (const hit of open.hits) assert.ok(hit.fall > 0 && !hit.onGround, `a swing at fall distance ${hit.fall}, on the ground ${hit.onGround}`)
  const low = verbWorld([zombie(2.5)], { legacy: true, ceiling: 66 })
  await drive('/strike', { name: 'zombie', max: '3' }, low)
  assert.strictEqual(low.hits.length, 3, 'control: three swings under the ceiling')
  assert.deepStrictEqual(low.did, ['swing', 'swing', 'swing'])
})

// The /hold reply on query and the actions and hits of a body with a sword, on 1.7.10 when legacy is true. walls(p)
// marks the stone cells above the floor, and a zombie that the body sees when seen is true steps from 6 off to 2 off
// after 1 s. raise(world) runs on each raise of the sword block. extra goes into the route's env last.
async function holdAt (query, walls, seen = true, legacy = true, raise = () => {}, extra = {}) {
  const world = verbWorld([zombie(0.5, seen)], { legacy })
  const { bot, env, clock } = world
  const z = bot.entities[7]
  z.position = new Vec3(0.5, 64, 6.5)
  clock.setTimeout(() => { z.position = new Vec3(0.5, 64, 2.5) }, 1000)
  const floor = bot.blockAt
  bot.blockAt = (p) => (walls(p) ? { name: 'stone', boundingBox: 'block', position: p } : floor(p))
  Object.assign(bot, { health: 20, quickBarSlot: 0, controlState: {}, activateItem () { raise(world) }, deactivateItem () {} })
  Object.assign(env, {
    MOVES: botConstant('MOVES'),
    holdRun: { on: false },
    pilotLane: { token: null },
    claimLane: () => (env.pilotLane.token = {}),
    perch: { cell: null },
    guardState: botObject('guardState', { console }),
    STANCES: { guard: { fleeDist: 16 } },
    fight: { ...env.fight, stance: 'guard' },
    nearHostiles: () => [],
    mobClass: (e) => (e.name === 'zombie' ? 'hostile' : 'passive'),
    disengageHp: () => 8,
    SWING_REACH: rules.SWING_REACH,
    HOLD_MAX_S: rules.HOLD_MAX_S,
    OPENABLE: botConstant('OPENABLE'),
    isDoor
  }, extra)
  const res = await drive('/hold', query, world)
  return { res, did: world.did, hits: world.hits, bot }
}

test('hold on 1.7.10 strikes a zombie it sees step into reach in a 1-wide doorway, and refuses in the open without anywhere', async () => {
  const doorway = (p) => p.z === 0 && Math.abs(p.x) === 1 && (p.y === 64 || p.y === 65)
  const held = await holdAt({ sec: '3' }, doorway)
  assert.strictEqual(held.res.error, undefined, held.res.error && held.res.error.message)
  assert.strictEqual(held.res.body.spot, 'doorway')
  assert.strictEqual(held.res.body.ended, 'time')
  assert.ok(held.res.body.swings > 0 && held.did.includes('swing'), `swings ${held.res.body.swings}`)
  const unseen = await holdAt({ sec: '3' }, doorway, false)
  assert.deepStrictEqual([unseen.res.body.swings, unseen.did], [0, []], 'a zombie it does not see')
  const field = await holdAt({ sec: '3' }, () => false)
  assert.ok(field.res.error, 'held in the open')
  assert.deepStrictEqual(field.did, [])
  const anywhere = await holdAt({ sec: '3', anywhere: '1' }, () => false)
  assert.strictEqual(anywhere.res.body && anywhere.res.body.spot, 'anywhere')
})

test('strike, shoot, useon and hold refuse busy while the buried self-rescue holds the dig lock, before any walk, equip or act', async () => {
  const busy = (skipped) => `busy: the buried self-rescue is running, nothing ${skipped}`
  for (const [route, query, skipped] of [
    ['/strike', { name: 'zombie' }, 'struck'],
    ['/shoot', { name: 'zombie' }, 'loosed'],
    ['/useon', { name: 'zombie', item: 'shears' }, 'used']
  ]) {
    const world = verbWorld([zombie(6.5)])
    world.env.digLock = botConstant('digLock')
    claimRescue(world.env.digLock)
    world.bot.heldItem = { name: 'iron_shovel' }
    const res = await drive(route, query, world)
    assert.strictEqual(res.error && res.error.message, busy(skipped), route)
    assert.strictEqual(res.error.reason, 'busy', route)
    assert.deepStrictEqual(world.did, [], route)
    assert.strictEqual(world.bot.heldItem.name, 'iron_shovel', route)
  }
  const digLock = botConstant('digLock')
  claimRescue(digLock)
  const doorway = (p) => p.z === 0 && Math.abs(p.x) === 1 && (p.y === 64 || p.y === 65)
  const held = await holdAt({ sec: '3' }, doorway, true, true, () => {}, { digLock })
  assert.strictEqual(held.res.error && held.res.error.message, busy('held'))
  assert.strictEqual(held.res.error.reason, 'busy')
  assert.deepStrictEqual([held.did, held.bot.heldItem], [[], null])
})

test('useon uses nothing once the buried self-rescue takes the hand during its equip, and leaves the rescue\'s lease alone', async () => {
  const world = verbWorld([zombie(6.5)])
  const digLock = botConstant('digLock')
  world.env.digLock = digLock
  const { holdHand } = loadBotFunctions(['holdHand'], { guardState: world.env.guardState, digLock, setTimeout: world.clock.setTimeout, clearTimeout: world.clock.clearTimeout })
  let rescue = null
  world.bot.equip = async (item) => {
    world.did.push(`equip ${item.name}`)
    world.bot.heldItem = item
    claimRescue(digLock)
    rescue = holdHand(digLock.holder)
  }
  const res = await drive('/useon', { name: 'zombie', item: 'shears' }, world)
  assert.strictEqual(res.error && res.error.message, 'busy: the buried self-rescue is running, nothing used')
  assert.strictEqual(res.error.reason, 'busy')
  assert.deepStrictEqual(world.did, ['walk', 'equip shears'])
  assert.strictEqual(world.env.guardState.hand, rescue)
})

test('a 1.7.10 sword block a hold raised holds through an update of the held sword and ends when another sword takes its slot', async () => {
  const up = []
  const doorway = (p) => p.z === 0 && Math.abs(p.x) === 1 && (p.y === 64 || p.y === 65)
  await holdAt({ sec: '1' }, doorway, true, true, ({ bot, env, clock }) => {
    if (up.length) return
    clock.setTimeout(() => {
      loadBotFunctions(['wireGuardDrop'], env).wireGuardDrop()
      bot.emit('heldItemChanged', { name: bot.heldItem.name })
      up.push(env.guardState.up)
      bot.emit('heldItemChanged', { name: 'stone_sword' })
      up.push(env.guardState.up)
    }, 10)
  })
  assert.deepStrictEqual(up, [true, false], 'the block after an update of the held sword, then after a stone_sword in its slot')
})

test('hold on 1.21.11 swings without a jump, a full sword charge apart', async () => {
  const doorway = (p) => p.z === 0 && Math.abs(p.x) === 1 && (p.y === 64 || p.y === 65)
  const held = await holdAt({ sec: '5' }, doorway, true, false)
  assert.ok(held.hits.length >= 2, `control: ${held.hits.length} swings`)
  assert.ok(!held.did.includes('jump'), `did ${held.did.join(', ')}`)
  // A sword recharges in 12.5 ticks.
  for (let i = 1; i < held.hits.length; i++) assert.ok(held.hits[i].t - held.hits[i - 1].t >= 625, `swings ${held.hits[i].t - held.hits[i - 1].t} ms apart`)
})

// The reply and the cells (as "x,z") a 1.7.10 strike crosses on a sprint opener at a zombie 6 off, plus the ticks
// it ran. The body sprints 0.29 blocks a tick toward where it last looked, and step(zombie, tick) runs on each tick.
async function sprintOpener (step) {
  const world = verbWorld([zombie(6.5)], { legacy: true })
  const { bot, clock } = world
  const z = bot.entities[7]
  const held = {}
  const set = bot.setControlState
  bot.setControlState = (c, s) => { held[c] = s; set.call(bot, c, s) }
  let look = null
  bot.lookAt = async (p) => { look = p }
  const cells = new Set()
  let ticks = 0
  clock.setInterval(() => {
    if (!held.forward || !held.sprint || !look) return
    const p = bot.entity.position
    const d = Math.hypot(look.x - p.x, look.z - p.z)
    bot.entity.position = p.offset((look.x - p.x) / d * 0.29, 0, (look.z - p.z) / d * 0.29)
    cells.add(`${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.z)}`)
    step(z, ++ticks)
  }, 50)
  const res = await drive('/strike', { name: 'zombie' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { reply: res.body, cells: [...cells], ticks }
}

test('a 1.7.10 sprint opener keeps to the checked line once its zombie steps off it', async () => {
  const line = (cells) => cells.every((c) => c.endsWith(',0'))
  const still = await sprintOpener(() => {})
  assert.strictEqual(still.reply.swings, 1, 'control: a sprint hit')
  assert.ok(line(still.cells) && still.ticks > 3, `control: ran ${still.ticks} ticks over ${still.cells.join(' ')}`)
  const aside = await sprintOpener((z, tick) => { if (tick === 3) z.position = new Vec3(6.5, 64, 4.5) })
  assert.ok(line(aside.cells), `ran off the checked line over ${aside.cells.join(' ')}`)
})

test('a 1.7.10 sprint opener stops once its zombie goes out of sight', async () => {
  const hidden = await sprintOpener((z, tick) => { if (tick === 3) z.seen = false })
  assert.strictEqual(hidden.ticks, 3, 'ran on after the zombie went out of sight')
  assert.strictEqual(hidden.reply.reason, 'lost sight')
})

test('a 1.7.10 sprint opener needs food above 6 and names hunger when it is not', () => {
  const blockAt = (p) => (p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' })
  const flat = { from: new Vec3(0.5, 64, 0.5), to: new Vec3(4.5, 64, 0.5), blockAt, known: () => true }
  assert.strictEqual(rules.noRunReason({ ...flat, food: 7 }), null, 'control: a fed body runs')
  assert.strictEqual(rules.noRunReason({ ...flat, food: 6 }), 'too hungry')
})

test('a 1.7.10 sprint opener refuses a run through fire or a cobweb', () => {
  const run = (hazard) => rules.noRunReason({
    from: new Vec3(0.5, 64, 0.5),
    to: new Vec3(4.5, 64, 0.5),
    food: 20,
    known: () => true,
    blockAt: (p) => {
      if (p.y < 64) return { name: 'stone', boundingBox: 'block' }
      return { name: p.x === 2 && p.y === 64 && p.z === 0 ? hazard : 'air', boundingBox: 'empty' }
    }
  })
  assert.strictEqual(run('air'), null, 'control: a clear run')
  assert.strictEqual(run('cobweb'), 'blocked on the way')
  assert.strictEqual(run('fire'), 'blocked on the way')
})

test('a 1.7.10 strike swing waits out the hurt window of its target, from its last hurt animation', async () => {
  const world = verbWorld([zombie(2.5)], { legacy: true })
  let hurtAt = null
  const attack = world.bot.attack
  world.bot.attack = () => {
    attack()
    // Something else hurts the zombie 300 ms after the first swing.
    if (world.hits.length === 1) {
      world.clock.setTimeout(() => {
        hurtAt = world.clock.now()
        world.bot.emit('entityHurt', world.bot.entities[7])
      }, 300)
    }
  }
  await drive('/strike', { name: 'zombie', max: '2' }, world)
  const [first, second] = world.hits.map((h) => h.t)
  assert.ok(hurtAt !== null && second > hurtAt, 'control: the hurt animation came between the swings')
  assert.ok(second - first >= 500, `swings ${second - first} ms apart`)
  assert.ok(second - hurtAt >= 500, `a swing ${second - hurtAt} ms after the hurt animation`)
})

// verbWorld's 1.7.10 world after a spawn and /guard on=1, the iron sword in hand. did also records each raise and
// lowering of the sword block and each forward or sprint switched on.
function guardedWorld (entities) {
  const world = verbWorld(entities, { legacy: true })
  const { bot, env, did } = world
  const set = bot.setControlState
  Object.assign(bot, {
    controlState: {},
    quickBarSlot: 0,
    heldItem: { name: 'iron_sword' },
    setControlState (c, s) {
      if (s && (c === 'forward' || c === 'sprint')) did.push(c)
      bot.controlState[c] = s
      set.call(bot, c, s)
    },
    activateItem () { did.push('raise') },
    deactivateItem () { did.push('lower') },
    consume: async () => {}
  })
  Object.assign(env, {
    MOVES: botConstant('MOVES'),
    guardState: botObject('guardState', { console }),
    reflexes: [...env.reflexes, { name: 'bunker' }],
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false, cell: null },
    fight: { ...env.fight, lastHit: null }
  })
  wireListeners(env, 'spawn')
  wireListeners(env, 'death')
  bot.emit('spawn')
  assert.deepStrictEqual(runRoute('/guard', { on: '1' }, env), { guarding: true })
  return world
}

test('a 1.7.10 sword block the pilot raised comes down before a swing and stays down', async () => {
  const world = guardedWorld([zombie(2.5)])
  await drive('/strike', { name: 'zombie', max: '2' }, world)
  assert.deepStrictEqual(world.did.filter((a) => a !== 'jump'), ['raise', 'lower', 'swing', 'swing'])
})

test("the pilot's 1.7.10 sword block order ends with a death, and with anything but a sword in hand outside a fight", () => {
  const died = guardedWorld([])
  died.bot.emit('death')
  assert.deepStrictEqual([died.env.guardState.up, died.env.guardState.pilot], [false, false])
  const { bot, env } = guardedWorld([])
  const src = botSource()
  const held = balanced(src, src.indexOf('=>', src.indexOf("bot.on('heldItemChanged'")))
  const changed = vm.runInContext(`((item) => ${held})`, env)
  env.reflexes[0].active = true
  changed({ name: 'bow' })
  assert.strictEqual(env.guardState.pilot, true, 'a bow the combat reflex took ended the order')
  env.reflexes[0].active = false
  bot.heldItem = { name: 'iron_pickaxe' }
  changed(bot.heldItem)
  assert.strictEqual(env.guardState.pilot, false, 'a pickaxe in hand kept the order')
})

test('a 1.7.10 sword block the pilot raised holds through an update of the held sword and ends when another sword takes its slot', () => {
  const { bot, env } = guardedWorld([])
  const src = botSource()
  const held = balanced(src, src.indexOf('=>', src.indexOf("bot.on('heldItemChanged'")))
  const changed = vm.runInContext(`((item) => ${held})`, env)
  changed({ name: 'iron_sword' })
  assert.strictEqual(env.guardState.up, true, 'an update of the raised iron_sword dropped the block')
  bot.heldItem = { name: 'stone_sword' }
  changed(bot.heldItem)
  assert.strictEqual(env.guardState.up, false, 'a stone_sword in the slot of the raised iron_sword kept the block')
})

// The combat reflex wired into world after foe hit the body, checked every 300 ms and acting while no act runs.
function combatIn (world, foe) {
  const { bot, env, clock } = world
  Object.assign(env, {
    AGGRO_CONFIRMED: new Map([[foe.id, { name: foe.name, t: 0 }]]),
    expireConfirmed,
    CONFIRMED_MS: botConstant('CONFIRMED_MS'),
    CONFIRMED_COOL_MS: botConstant('CONFIRMED_COOL_MS'),
    CONFIRMED_HORIZON: botConstant('CONFIRMED_HORIZON'),
    fight: { ...env.fight, threatDebugUntil: 0, stance: 'guard' },
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    guardState: botObject('guardState', { console }),
    bunker: { building: false },
    holdRun: { on: false },
    mobClass: (e) => (['zombie', 'spider'].includes(e.name) ? 'hostile' : 'passive'),
    entityEngageable: () => true,
    nearHostiles: () => [],
    perchStrike: () => false,
    disengageHp: () => 8,
    compass: () => 'E',
    headFree: () => true,
    emitEvent () {},
    yieldJob () {},
    takeLegs () {},
    threatWhy: (what) => what,
    laneBlocks: () => false,
    laneNarrate () {},
    GUARD_STEPS: botConstant('GUARD_STEPS')
  })
  // The strike and the reflex share one meleeSwing and its last swing time, as in bot.js.
  loadBotFunctions(['meleeSwing', 'inMeleeReach', 'losClear'], env)
  const combat = combatReflexIn(env)
  combat.fairFill = env.reflexes[0].fairFill
  clock.setInterval(() => {
    if (combat.active || !combat.check(bot)) return
    combat.active = true
    combat.act(bot).finally(() => { combat.active = false })
  }, 300)
  return combat
}

test('a 1.7.10 strike on a zombie that hit the body swings once per hurt window, and the combat reflex swings none', async () => {
  const world = verbWorld([zombie(2.5)], { legacy: true })
  const { bot, clock, hits } = world
  const z = bot.entities[7]
  let raises = 0
  Object.assign(bot, { health: 20, quickBarSlot: 0, activateItem () { raises++ }, deactivateItem () {} })
  // The server shows the hurt animation 2 ticks after a hit.
  const attack = bot.attack
  bot.attack = () => {
    attack()
    clock.setTimeout(() => bot.emit('entityHurt', z), 100)
  }
  const combat = combatIn(world, z)
  const res = await drive('/strike', { name: 'zombie', max: '5' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.strictEqual(res.body.swings, 5, 'control: five strike swings')
  assert.ok(combat.active, 'control: the combat reflex was acting on the zombie')
  assert.strictEqual(hits.length, res.body.swings, 'the combat reflex swung beside the strike')
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i].t - hits[i - 1].t >= 500, `swings ${hits[i].t - hits[i - 1].t} ms apart`)
  assert.strictEqual(raises, 0, 'the combat reflex raised the sword block during the strike')
})

test('a stop between strike swings ends the strike as stopped, naming no reflex', async () => {
  const world = verbWorld([zombie(2.5)])
  const attack = world.bot.attack
  world.bot.attack = () => {
    attack()
    if (world.hits.length === 1) world.stop()
  }
  const res = await drive('/strike', { name: 'zombie', max: '5' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual({ swings: res.body.swings, reason: res.body.reason, takenBy: res.body.takenBy }, { swings: 1, reason: 'stopped', takenBy: undefined })
  assert.strictEqual(world.hits.length, 1)
})

test('a stop during a shoot volley ends it as stopped and frees the lane', async () => {
  const world = verbWorld([zombie(6.5)])
  const z = world.bot.entities[7]
  let shots = 0
  world.env.drawAndLoose = async () => {
    shots++
    z.position = z.position.offset(1, 0, 0)
    if (shots === 1) world.stop()
    return true
  }
  const res = await drive('/shoot', { name: 'zombie', max: '8' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual({ shotsFired: res.body.shotsFired, outcome: res.body.outcome }, { shotsFired: 1, outcome: 'stopped' })
  assert.strictEqual(shots, 1)
  assert.deepStrictEqual([world.env.pilotLane.token, world.env.strikeRun.lane], [null, null])
})

test('a shoot refused before its first shot leaves the lane another verb holds', async () => {
  const refusals = {
    'no target in sight': (world) => { world.bot.entities = {} },
    'a player': (world) => { world.bot.entities[7].type = 'player' },
    'no bow': (world) => { world.bot.inventory.items = () => [{ name: 'arrow' }] },
    'no arrows': (world) => { world.bot.inventory.items = () => [{ name: 'bow' }] }
  }
  for (const [why, setUp] of Object.entries(refusals)) {
    const world = verbWorld([zombie(6.5)])
    setUp(world)
    const held = world.env.claimLane('goto', 60000)
    await drive('/shoot', { name: 'zombie' }, world)
    assert.strictEqual(world.env.pilotLane.token, held, `${why} released the lane held before`)
    assert.strictEqual(world.env.pilotLane.why, 'goto', `${why} overwrote the lane`)
    assert.strictEqual(world.env.strikeRun.lane, null, why)
    assert.deepStrictEqual(world.did, [], why)
  }
})

test('a stop during a pillar ends it as stopped after the block in hand', async () => {
  const entity = { position: new Vec3(0.5, 64, 0.5) }
  const legs = legLedger()
  const lane = {}
  createLane(lane)
  const bunker = { building: false }
  const stop = () => runRoute('/stop', {}, { bot: { clearControlStates () {} }, bunker, legs, stopFollow () {}, stopPath () {}, clearLane: lane.clearLane, jobs: { stopAll: () => 0 }, guardState: { hand: null } })
  let placed = 0
  const r = await awaitRoute('/pillar', { height: '3' }, {
    bot: { entity, blockAt: (p) => ({ name: 'stone', boundingBox: p.y < entity.position.y ? 'block' : 'empty', position: p }) },
    bunker,
    legs,
    claimLane: lane.claimLane,
    releaseLane: lane.releaseLane,
    takenText,
    perch: { cell: null },
    fillers: () => [{ name: 'dirt', count: 64 }],
    pillarHeight: (height) => ({ height, safe: 2, why: 'flat ground' }),
    BUNKER_MAX_HEIGHT: 6,
    knownCell: () => true,
    jumpPlace: async () => {
      entity.position = entity.position.offset(0, 1, 0)
      if (++placed === 1) stop()
      return true
    }
  })
  assert.deepStrictEqual(r, { placed: 1, rose: 1, stopped: 'stopped by the pilot' })
})

test('the post-fight refuel waits while a shoot volley holds the hand, and runs without one', async () => {
  // A spider that hit the body stands in reach and dies after 3 s, the shoot target 6 off steps back a block a shot.
  const fightBeside = () => {
    const spider = { id: 8, name: 'spider', width: 1.4, height: 0.9, seen: true, position: new Vec3(2.5, 64, 0.5) }
    const world = verbWorld([zombie(6.5), spider], { legacy: true })
    const { bot, env, clock } = world
    Object.assign(bot, { food: 10, health: 20, quickBarSlot: 0, activateItem () {}, deactivateItem () {} })
    const refuels = []
    env.refuelAfterFight = async () => { refuels.push(clock.now()) }
    env.drawAndLoose = async () => {
      bot.entities[7].position = bot.entities[7].position.offset(1, 0, 0)
      return true
    }
    combatIn(world, spider)
    clock.setTimeout(() => { delete bot.entities[8] }, 3000)
    return { world, refuels }
  }
  const alone = fightBeside()
  while (alone.world.clock.now() < 6000) {
    await new Promise((resolve) => setImmediate(resolve))
    alone.world.clock.advance(10)
  }
  assert.strictEqual(alone.refuels.length, 1, 'control: the refuel after the fight')
  const volley = fightBeside()
  const res = await drive('/shoot', { name: 'zombie', max: '8' }, volley.world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  const answered = volley.world.clock.now()
  assert.ok(answered > 3500, `control: the volley ran past the fight, answered at ${answered} ms`)
  assert.deepStrictEqual(volley.refuels.filter((t) => t < answered), [], 'the refuel swapped the hand during the volley')
})

test('a combat flee that takes the legs during a strike approach ends the strike as stopped, naming the reflex', async () => {
  const world = verbWorld([zombie(10.5)])
  const { env, clock } = world
  let walk = null
  world.bot.pathfinder.goto = () => new Promise((resolve, reject) => { walk = reject })
  env.stopPath = () => { if (walk) walk(new Error('Path was stopped before it could be completed')) }
  const { takeLegs } = loadBotFunctions(['takeLegs'], { legs: env.legs, yieldJob () {} })
  clock.setTimeout(() => {
    takeLegs('combat', 'flee from zombie')
    env.stopPath()
  }, 1000)
  const res = await drive('/strike', { name: 'zombie', max: '3' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual({ swings: res.body.swings, reason: res.body.reason, takenBy: res.body.takenBy },
    { swings: 0, reason: 'stopped', takenBy: 'the combat reflex took the legs to flee from zombie' })
})

test('a strike without the named item refuses and names the ways out, a carried sword or axe first', async () => {
  const refusal = async (items) => {
    const { handle, res } = routeHandler('/strike', {
      shared: { ready: true },
      legs: legLedger(),
      frameAt: () => null,
      strikeRun: { lane: null },
      releaseLane () {},
      bot: { inventory: { items: () => items.map((name) => ({ name })) }, removeListener () {} }
    })
    await handle({ query: { name: 'zombie' } }, res)
    return res.error && res.error.message
  }
  const no = 'refused: no iron_sword in your pockets to strike with. Ways out:'
  const ways = 'goto, bunker, or the combat reflex, which flees at low health while it is on.'
  assert.strictEqual(await refusal([]), `${no} ${ways}`)
  assert.strictEqual(await refusal(['iron_pickaxe']), `${no} ${ways}`, 'a pickaxe is no weapon')
  assert.strictEqual(await refusal(['iron_pickaxe', 'stone_sword']), `${no} strike(item: 'stone_sword'), ${ways}`)
  assert.strictEqual(await refusal(['wooden_axe']), `${no} strike(item: 'wooden_axe'), ${ways}`)
})
