'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const pace = require('../lib/pace')
const { isDoor } = require('../lib/doors')
const { expireConfirmed } = require('../lib/shelter')
const vm = require('node:vm')
const { routeHandler, runRoute, fakeClock, toolNamed, botConstant, botSource, balanced, loadBotFunctions, combatReflexIn, wireListeners } = require('./helpers')

// seen says whether the body perceives the zombie.
const zombie = (x, seen = true) => ({ id: 7, name: 'zombie', width: 0.6, height: 1.95, seen, position: new Vec3(x, 64, 0.5) })

// did records the body's actions in order: walk, jump, swing, draw, use. hits holds each swing's time, the
// server's fall distance and whether the body stood on the ground. The floor is at y 63, solid cells
// start at y ceiling, and a walk ends 2 west of its goal.
function verbWorld (entities, { legacy = false, ceiling = Infinity } = {}) {
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
        bot.entity.position = new Vec3(goal.x - 1.5, 64, goal.z + 0.5)
      },
      isMoving: () => false
    },
    blockAt: (p) => ({ name: solid(p) ? 'stone' : 'air', boundingBox: solid(p) ? 'block' : 'empty', position: p }),
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
    useOn: async () => { did.push('use') }
  })
  const fill = {}
  const env = {
    bot,
    goals,
    ready: true,
    LEGACY_1710: legacy,
    LEGACY_HIT_MS: 550,
    mobHurt: pace.hurtWindows(bot, clock.now),
    knownCell: () => true,
    perch: { cell: null },
    console: { log () {} },
    noCritReason: pace.noCritReason,
    noRunReason: pace.noRunReason,
    runCells: pace.runCells,
    RUN_COAST: pace.RUN_COAST,
    JUMP_FALL_TICKS: pace.JUMP_FALL_TICKS,
    JUMP_TICKS: pace.JUMP_TICKS,
    RUN_MAX: pace.RUN_MAX,
    RUN_TICKS: pace.RUN_TICKS,
    SWING_REACH: pace.SWING_REACH,
    HITBOX_1710: pace.HITBOX_1710,
    Vec3,
    mcData: null,
    lastAttackT: 0,
    STRIKE_SWING_MS: pace.STRIKE_SWING_MS,
    STRIKE_APPROACH_MS: pace.STRIKE_APPROACH_MS,
    strikeBudgetMs: pace.strikeBudgetMs,
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    liveEntities: () => Object.values(bot.entities),
    reflexes: [{ name: 'combat', fairFill: () => fill }],
    entityPerceptible: (e, f) => {
      assert.strictEqual(f, fill, 'entityPerceptible got another fill')
      return e.seen
    },
    drawAndLoose: async () => { did.push('draw'); return true },
    claimLane: () => ({}),
    releaseLane () {},
    strikeRun: { lane: null },
    stopPath () {},
    round: (v) => v && { x: v.x, y: v.y, z: v.z }
  }
  return { bot, env, clock, did, hits }
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
  const budget = pace.strikeBudgetMs(5)
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
// after 1 s.
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

test('a sprint opener keeps to the checked line once its zombie steps off it', async () => {
  const line = (cells) => cells.every((c) => c.endsWith(',0'))
  const still = await sprintOpener(() => {})
  assert.strictEqual(still.reply.swings, 1, 'control: a sprint hit')
  assert.ok(line(still.cells) && still.ticks > 3, `control: ran ${still.ticks} ticks over ${still.cells.join(' ')}`)
  const aside = await sprintOpener((z, tick) => { if (tick === 3) z.position = new Vec3(6.5, 64, 4.5) })
  assert.ok(line(aside.cells), `ran off the checked line over ${aside.cells.join(' ')}`)
})

test('a sprint opener stops once its zombie goes out of sight', async () => {
  const hidden = await sprintOpener((z, tick) => { if (tick === 3) z.seen = false })
  assert.strictEqual(hidden.ticks, 3, 'ran on after the zombie went out of sight')
  assert.strictEqual(hidden.reply.reason, 'lost sight')
})

test('a sprint opener needs food above 6 and names hunger when it is not', () => {
  const blockAt = (p) => (p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' })
  const flat = { from: new Vec3(0.5, 64, 0.5), to: new Vec3(4.5, 64, 0.5), blockAt, known: () => true }
  assert.strictEqual(pace.noRunReason({ ...flat, food: 7 }), null, 'control: a fed body runs')
  assert.strictEqual(pace.noRunReason({ ...flat, food: 6 }), 'too hungry')
})

test('a strike swing waits out the hurt window of its target, from its last hurt animation', async () => {
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
    guardState: { up: false, slot: -1, pilot: false },
    reflexes: [...env.reflexes, { name: 'bunker' }],
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false, cell: null },
    lastHit: null
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

test('a 1.7.10 strike on a zombie that hit the body swings once per hurt window, and the combat reflex swings none', async () => {
  const world = verbWorld([zombie(2.5)], { legacy: true })
  const { bot, env, clock, hits } = world
  const z = bot.entities[7]
  let raises = 0
  Object.assign(bot, { health: 20, quickBarSlot: 0, activateItem () { raises++ }, deactivateItem () {} })
  // The server shows the hurt animation 2 ticks after a hit.
  const attack = bot.attack
  bot.attack = () => {
    attack()
    clock.setTimeout(() => bot.emit('entityHurt', z), 100)
  }
  Object.assign(env, {
    AGGRO_CONFIRMED: new Map([[z.id, { name: 'zombie', t: 0 }]]),
    expireConfirmed,
    CONFIRMED_MS: botConstant('CONFIRMED_MS'),
    CONFIRMED_HORIZON: botConstant('CONFIRMED_HORIZON'),
    threatDebugUntil: 0,
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    stance: 'guard',
    guardState: { up: false, slot: -1, pilot: false },
    bunker: { building: false },
    holdRun: { on: false },
    mobClass: (e) => (e.name === 'zombie' ? 'hostile' : 'passive'),
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
  // The reflex loop of bot.js: a check every 300 ms, an act while none runs.
  clock.setInterval(() => {
    if (combat.active || !combat.check(bot)) return
    combat.active = true
    combat.act(bot).finally(() => { combat.active = false })
  }, 300)
  const res = await drive('/strike', { name: 'zombie', max: '5' }, world)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.strictEqual(res.body.swings, 5, 'control: five strike swings')
  assert.ok(combat.active, 'control: the combat reflex was acting on the zombie')
  assert.strictEqual(hits.length, res.body.swings, 'the combat reflex swung beside the strike')
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i].t - hits[i - 1].t >= 500, `swings ${hits[i].t - hits[i - 1].t} ms apart`)
  assert.strictEqual(raises, 0, 'the combat reflex raised the sword block during the strike')
})
