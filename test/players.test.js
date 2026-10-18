'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { crumbCentre, nametagGoal, routeDeadline } = require('../lib/walk')
const { PRESENCE_GAP_MS, PRESENCE_FORGET_MS, PRESENCE_MAX, playerNamed, playersAround, presenceUpdate, presenceText } = require('../lib/players')
const { QUIET_MS, LONG_QUIET_MS, legLedger } = require('../lib/leg-ledger')
const { countVerbs } = require('../lib/verbs')
const { isDoor, panelAcross, doorCrossing } = require('../lib/doors')
const { expireConfirmed } = require('../lib/shelter')
const { createReflexes, bindReflexes } = require('../lib/bot/reflexes')
const { loadBotFunctions, combatReflexIn, botConstant } = require('./helpers')

const ME = new Vec3(0.5, 64, 0.5)
const player = (id, username, position) => ({ id, type: 'player', name: 'player', username, position })
// Objects from the bot.js context carry its own Object prototype.
const plain = (v) => JSON.parse(JSON.stringify(v))

// ---- the lookup by entity ----

test('a player is found among the entities by username while bot.players lacks the entity', () => {
  const steve = player(7, 'Steve', new Vec3(5, 64, 5))
  const entities = { 1: { id: 1, type: 'mob', name: 'zombie', position: ME }, 7: steve }
  assert.strictEqual(playerNamed(entities, 'Steve'), steve)
  assert.strictEqual(playerNamed(entities, 'Alex'), null)
  assert.strictEqual(playerNamed(entities, 'Steve', (e) => e.id === 7), null, 'a skipped entity')
  const env = { bot: { players: { Steve: { username: 'Steve' } }, entities }, playerNamed, staleEntities: new Set() }
  assert.strictEqual(loadBotFunctions(['playerEntity'], env).playerEntity('Steve'), steve)
})

test('the players around leave out the bot itself and entities without a name', () => {
  const self = player(1, 'Claude', ME)
  const steve = player(7, 'Steve', new Vec3(5, 64, 5))
  const entities = { 1: self, 7: steve, 8: { id: 8, type: 'player', position: ME }, 9: { id: 9, type: 'mob', name: 'cow', position: ME } }
  assert.deepStrictEqual(playersAround(entities, self), [steve])
})

// ---- where ----

function whereEnv ({ seen, nametag }) {
  return {
    bot: { entity: { position: ME }, entities: { 7: player(7, 'Steve', new Vec3(13.3, 64, -2.6)) } },
    playerNamed,
    staleEntities: new Set(),
    playerCrumbs: {},
    reflexes: [{ name: 'combat', fairFill: () => ({}) }],
    entityPerceptible: () => seen,
    nametagVisible: () => nametag,
    crumbCentre,
    compass: (dx, dz) => (Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'E' : 'W') : (dz > 0 ? 'S' : 'N'))
  }
}

test('where gives a player in sight exactly, one known by the nametag roughly, and a hidden one only as never seen', () => {
  const where = (gate) => plain(loadBotFunctions(['whereIs'], whereEnv(gate)).whereIs('Steve'))
  assert.deepStrictEqual(where({ seen: true, nametag: true }), { name: 'Steve', live: true, pos: { x: 13, y: 64, z: -3 }, dist: 13, bearing: 'E' }, 'control: in sight')
  assert.deepStrictEqual(where({ seen: false, nametag: true }), { name: 'Steve', live: true, nametag: true, dist: 10, bearing: 'E' })
  assert.deepStrictEqual(where({ seen: false, nametag: false }), { name: 'Steve', live: false, note: 'never seen this session' })
})

test('entities name a player by username and a mob by its type', () => {
  const { entityLabel } = loadBotFunctions(['entityLabel'], {})
  assert.strictEqual(entityLabel(player(7, 'Steve', ME)), 'Steve')
  assert.strictEqual(entityLabel({ type: 'hostile', name: 'zombie' }), 'zombie')
})

test('scene names a player by username, never counts one named like a mob as a threat, and leaves a hidden one out', () => {
  const hidden = player(9, 'Alex', new Vec3(5.5, 64, 0.5))
  const entities = {
    1: { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(4.5, 64, 0.5) },
    7: player(7, 'Steve', new Vec3(6.5, 64, 0.5)),
    8: player(8, 'zombie', new Vec3(3.5, 64, 0.5)),
    9: hidden
  }
  const env = {
    bot: { entity: { position: ME }, entities },
    HOSTILE_NAMES: new Set(['zombie']),
    staleEntities: new Set(),
    entityPerceptible: (en) => en !== hidden,
    compass: () => 'E'
  }
  const { threats, groups } = plain(loadBotFunctions(['sceneEntities'], env).sceneEntities(ME, {}))
  assert.deepStrictEqual(Object.keys(groups).sort(), ['Steve', 'zombie'])
  assert.strictEqual(groups.zombie.count, 2, 'the zombie and the player named zombie')
  assert.deepStrictEqual(threats, [{ name: 'zombie', dir: 'E', dist: 4 }], 'only the mob is a threat')
  assert.ok(!JSON.stringify(groups).includes('Alex'), 'the hidden player stays hidden')
})

test('players named __proto__, constructor or toString are scene groups like any other, and the threats still read', () => {
  const names = ['__proto__', 'constructor', 'toString']
  const entities = { 1: { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(4.5, 64, 0.5) } }
  names.forEach((name, i) => { entities[i + 2] = player(i + 2, name, new Vec3(6.5 + i, 64, 0.5)) })
  const env = { bot: { entity: { position: ME }, entities }, HOSTILE_NAMES: new Set(['zombie']), staleEntities: new Set(), entityPerceptible: () => true, compass: () => 'E' }
  const ctx = loadBotFunctions(['sceneEntities'], env)
  const { threats, groups } = ctx.sceneEntities(ME, {})
  assert.deepStrictEqual(Object.keys(groups).sort(), [...names, 'zombie'].sort())
  for (const name of names) assert.strictEqual(groups[name].count, 1, name)
  assert.deepStrictEqual(plain(threats), [{ name: 'zombie', dir: 'E', dist: 4 }])
  assert.strictEqual(vm.runInContext('({}).count', ctx), undefined, 'nothing reached Object.prototype')
})

test('scene leaves out the entities of the dimension before until the server updates them', () => {
  const entities = { 1: { id: 1, type: 'hostile', name: 'zombie', position: new Vec3(4.5, 64, 0.5) }, 7: player(7, 'Steve', new Vec3(6.5, 64, 0.5)) }
  const env = { bot: { entity: { position: ME }, entities }, HOSTILE_NAMES: new Set(['zombie']), staleEntities: new Set([1, 7]), entityPerceptible: () => true, compass: () => 'E' }
  const ctx = loadBotFunctions(['sceneEntities'], env)
  assert.deepStrictEqual(plain(ctx.sceneEntities(ME, {})), { threats: [], groups: {} })
  env.staleEntities.delete(1)
  assert.deepStrictEqual(plain(ctx.sceneEntities(ME, {}).threats), [{ name: 'zombie', dir: 'E', dist: 4 }], 'updated since')
})

// ---- presence ----

const seenAt = (name, dist, bearing = 'E') => ({ name, tier: 'seen', dist, bearing })

test('presence speaks once per change between in view, nametag only and out of sight', () => {
  const state = new Map()
  const at = (now, sightings) => presenceUpdate(state, sightings, { now })
  assert.deepStrictEqual(at(0, [seenAt('Steve', 12)]), [{ name: 'Steve', tier: 'seen', dist: 12, bearing: 'E' }])
  assert.deepStrictEqual(at(2000, [seenAt('Steve', 14)]), [], 'no change')
  assert.deepStrictEqual(at(40000, [{ name: 'Steve', tier: 'nametag', dist: 20, bearing: 'N' }]), [{ name: 'Steve', tier: 'nametag', dist: 20, bearing: 'N' }])
  assert.deepStrictEqual(at(80000, []), [{ name: 'Steve', tier: 'none', dist: 20, bearing: 'N' }])
  assert.deepStrictEqual(at(82000, []), [])
})

test('presence says at most one thing per player per 30 s, and the state it ends in', () => {
  const state = new Map()
  const at = (now, sightings) => presenceUpdate(state, sightings, { now })
  assert.strictEqual(at(0, [seenAt('Steve', 12)]).length, 1)
  assert.deepStrictEqual(at(5000, []), [], 'out of sight 5 s later')
  assert.deepStrictEqual(at(10000, [seenAt('Steve', 12)]), [], 'back before the gap ran out')
  assert.deepStrictEqual(at(20000, []), [])
  assert.deepStrictEqual(at(PRESENCE_GAP_MS, []).map((e) => e.tier), ['none'])
})

test('presence enters at 60 blocks or closer and leaves only past 68', () => {
  const state = new Map()
  const at = (now, dist) => presenceUpdate(state, [seenAt('Steve', dist)], { now }).map((e) => e.tier)
  assert.deepStrictEqual(at(0, 61), [])
  assert.deepStrictEqual(at(1000, 60), ['seen'])
  assert.deepStrictEqual(at(40000, 68), [], 'inside the leave band')
  assert.deepStrictEqual(at(80000, 69), ['none'])
  assert.deepStrictEqual(at(120000, 64), [], 'past the enter band')
})

test('presence keeps quiet about a followed player and picks up from there', () => {
  const state = new Map()
  const quiet = new Set(['Steve'])
  assert.deepStrictEqual(presenceUpdate(state, [seenAt('Steve', 12)], { now: 0, quiet }), [])
  assert.deepStrictEqual(presenceUpdate(state, [seenAt('Steve', 12)], { now: 1000 }), [], 'unfollowed while still in view')
  assert.strictEqual(presenceUpdate(state, [], { now: 2000 }).length, 1)
})

test('presence forgets a player out of sight past 10 minutes and keeps at most its cap, never one perceived now', () => {
  const state = new Map()
  presenceUpdate(state, [seenAt('Steve', 12)], { now: 0 })
  presenceUpdate(state, [], { now: 60000 })
  presenceUpdate(state, [], { now: PRESENCE_FORGET_MS })
  assert.ok(state.has('Steve'), 'control: out of sight just under 10 minutes')
  presenceUpdate(state, [], { now: PRESENCE_FORGET_MS + 1 })
  assert.strictEqual(state.size, 0)
  for (let i = 0; i < PRESENCE_MAX + 50; i++) presenceUpdate(state, [seenAt(`p${i}`, 12)], { now: 1000 + i })
  assert.strictEqual(state.size, PRESENCE_MAX)
  assert.ok(state.has(`p${PRESENCE_MAX + 49}`) && !state.has('p0'), 'the longest unseen went first')
  const crowd = Array.from({ length: PRESENCE_MAX + 10 }, (_, i) => seenAt(`c${i}`, 12))
  presenceUpdate(state, crowd, { now: 5000 })
  assert.ok(crowd.every((s) => state.has(s.name)), 'everyone perceived now stays')
})

test('presence text is an FYI and gives a nametag player no coordinates', () => {
  for (const tier of ['seen', 'nametag', 'none']) {
    const text = presenceText({ name: 'Steve', tier, dist: 15, bearing: 'NE' })
    assert.match(text, /no reply or action needed/, tier)
    assert.match(text, /^Steve .*15 blocks NE/, tier)
  }
})

// presenceTick over a bot with Steve's entity at position, perceived as gate says.
function presenceEnv (position, gate) {
  const events = []
  const env = {
    bot: { entity: { position: ME }, players: {}, entities: { 7: player(7, 'Steve', position) } },
    console: { log () {} },
    playersAround,
    presenceUpdate,
    presenceText,
    staleEntities: new Set(),
    presence: new Map(),
    playersLogged: true,
    follow: { followState: null },
    reflexes: [{ name: 'combat', fairFill: () => ({}) }],
    entityPerceptible: () => gate.seen,
    nametagVisible: () => gate.nametag,
    crumbCentre,
    compass: (dx, dz) => (Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'E' : 'W') : (dz > 0 ? 'S' : 'N')),
    emitEvent: (kind, msg, data) => events.push({ kind, msg, data: plain(data) })
  }
  return { env, events, ctx: loadBotFunctions(['presenceTick'], env) }
}

test('a hidden player gets no presence event, and a nametag one only a rounded distance', () => {
  const at = new Vec3(13.3, 64, -2.6)
  const seen = presenceEnv(at, { seen: true, nametag: true })
  seen.ctx.presenceTick()
  assert.deepStrictEqual(seen.events.map((e) => e.data), [{ name: 'Steve', tier: 'seen', dist: 13, bearing: 'E' }], 'control: in sight')
  const hidden = presenceEnv(at, { seen: false, nametag: false })
  hidden.ctx.presenceTick()
  assert.deepStrictEqual(hidden.events, [])
  const tagged = presenceEnv(at, { seen: false, nametag: true })
  tagged.ctx.presenceTick()
  assert.deepStrictEqual(tagged.events.map((e) => e.data), [{ name: 'Steve', tier: 'nametag', dist: 10, bearing: 'E' }])
  assert.doesNotMatch(tagged.events[0].msg, /13|-3|-2\.6/)
})

test('presence skips the followed player', () => {
  const { env, events, ctx } = presenceEnv(new Vec3(5, 64, 5), { seen: true, nametag: true })
  env.follow.followState = { name: 'Steve' }
  ctx.presenceTick()
  assert.deepStrictEqual(events, [])
})

test('a player who hit the body is scored only inside the threatdebug window, and outside it the lower reflexes run', async () => {
  const steve = player(7, 'Steve', new Vec3(3.5, 64, 0.5))
  const bot = { entity: { position: ME }, entities: { 7: steve } }
  const fight = { stance: 'guard', threatDebugUntil: 0 }
  const env = {
    bot,
    Vec3,
    fight,
    expireConfirmed,
    console: { log () {} },
    CONFIRMED_HORIZON: botConstant('CONFIRMED_HORIZON'),
    CONFIRMED_MS: botConstant('CONFIRMED_MS'),
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    AGGRO_CONFIRMED: new Map([[7, { name: 'player', t: Date.now() }]]),
    bunker: { building: false },
    liveEntities: () => [steve],
    mobClass: () => 'player',
    airFlood: () => ({}),
    knownCell: () => true,
    entityPerceptible: () => true,
    entityEngageable: () => true,
    holdRun: { on: false },
    emitEvent () {}
  }
  const combat = combatReflexIn(env)
  const fired = []
  combat.act = async () => { fired.push('combat') }
  const unstuck = { name: 'unstuck', on: true, active: false, check: () => true, act: async () => { fired.push('unstuck') } }
  const ctx = {}
  createReflexes(ctx)
  bindReflexes({ bot, shared: { ready: true } })
  ctx.reflexes.push(combat, unstuck)
  let tick = null
  const setInterval = globalThis.setInterval
  globalThis.setInterval = (fn) => { tick = fn; return 0 }
  try { ctx.startReflexes() } finally { globalThis.setInterval = setInterval }
  assert.strictEqual(combat.check(bot), false, 'outside the window')
  tick()
  await new Promise(setImmediate)
  fight.threatDebugUntil = Date.now() + 60000
  assert.strictEqual(combat.check(bot), true, 'inside the window')
  assert.strictEqual(combat._threat.e, steve)
  tick()
  await new Promise(setImmediate)
  assert.deepStrictEqual(fired, ['unstuck', 'combat'])
})

// ---- follow ----

// A follow supervisor over a fake bot. The player is at position and perceived as gate says. With door, the
// real doorway drill runs against an open oak door one cell east of the body, else a stub counts the drills.
// Pilot routes register on app. With holdPause, the drill's 700 ms pause waits until the test calls pauses.shift().
function followHarness ({ position = new Vec3(10.5, 64, 0.5), gate = { seen: true }, door = false, holdPause = false } = {}) {
  const bot = new EventEmitter()
  bot.entity = { position: ME.clone() }
  let moving = false
  // Every goal and control state set, in order. A stop or unfollow marks where it came.
  const log = []
  bot.pathfinder = {
    goal: null,
    setGoal (g) { this.goal = g; log.push(['goal', g]) },
    isMoving: () => moving
  }
  const controls = {}
  bot.setControlState = (k, v) => { controls[k] = v; log.push([k, v]) }
  bot.clearControlStates = () => { for (const k of Object.keys(controls)) controls[k] = false }
  const doorAt = new Vec3(1, 64, 0)
  Object.assign(bot, {
    findBlocks: () => [doorAt],
    blockAt: (p) => (p.equals(doorAt) ? { name: 'oak_door', position: doorAt, shapes: [], getProperties: () => ({ facing: 'east', hinge: 'left', open: true, half: 'lower' }) } : { name: 'air', position: p }),
    lookAt: async () => { if (bot.onLook) bot.onLook() },
    activateBlock: async () => {},
    waitForTicks: async () => {}
  })
  const steve = player(7, 'Steve', position)
  const events = []
  let drills = 0
  const combat = { name: 'combat', active: false, _fleeUntil: 0, _coverUntil: 0, fairFill: () => ({}) }
  const job = { running: false }
  const routes = {}
  const app = { get (path, ...handlers) { routes[path] = handlers[handlers.length - 1] } }
  const pauses = []
  const env = {
    bot,
    goals,
    require,
    reflexes: [combat],
    bunker: { building: false },
    pilotLane: { until: 0 },
    jobs: { running: () => job.running },
    legs: legLedger(),
    verbs: countVerbs(app),
    routeDeadline,
    swimUpUntil: 0,
    shared: { mcData: { blocksByName: { oak_door: { id: 5, name: 'oak_door' } } } },
    cellKnown: () => true,
    isDoor,
    panelAcross,
    doorCrossing,
    follow: { followState: null },
    console: { log () {} },
    setTimeout: (fn, ms) => (ms === 700 && holdPause ? pauses.push(fn) : setImmediate(fn)),
    playerEntity: (name) => (name === 'Steve' ? steve : null),
    playerSighting: () => (gate.seen ? { tier: 'seen' } : gate.nametag ? { tier: 'nametag' } : null),
    crumbCentre,
    nametagGoal,
    ck: (x, y, z) => x + ',' + y + ',' + z,
    emitEvent: (kind, msg) => events.push({ kind, msg }),
    stopPath: () => { bot.pathfinder.goal = null },
    wayHint: () => null,
    WALK_HINTS: { 'no-path': 'no known way there' }
  }
  if (!door) env.doorwayCommit = async () => { drills++; return false }
  const ctx = loadBotFunctions(['followTick', 'armFollow', 'followTarget', 'stopFollow'], env)
  const st = { name: 'Steve', range: 2, goal: null, lastPos: ME.clone(), lastT: Date.now(), drilling: false, lostT: 0, told: false, warnT: 0 }
  ctx.armFollow(st, ctx.followTarget(st))
  env.follow.followState = st
  return {
    env, bot, st, steve, events, gate, combat, job, app, routes, controls, log, pauses,
    drills: () => drills,
    setMoving: (m) => { moving = m },
    tick: () => ctx.followTick(st),
    arm: () => ctx.armFollow(st, ctx.followTarget(st)),
    // What /stop and /unfollow do to a follow.
    stop: () => { env.legs.take(null); ctx.stopFollow(); env.stopPath(); bot.clearControlStates(); log.push(['stop']) },
    unfollow: () => { ctx.stopFollow(); bot.pathfinder.goal = null; bot.clearControlStates(); log.push(['stop']) },
    // The stall clock and the lost clock as if ms had passed.
    age: (ms) => { st.lastT -= ms; if (st.lostT) st.lostT -= ms }
  }
}

// What the follow set after the stop or unfollow: goals and control states turned on.
const setAfterStop = (log) => log.slice(log.findIndex(([k]) => k === 'stop') + 1).filter(([k, v]) => k !== 'stop' && v)

test('follow parked beside its player stays on with its goal, wedged far from them it runs the drill', async () => {
  const near = followHarness({ position: new Vec3(2.5, 64, 0.5) })
  const goal = near.bot.pathfinder.goal
  for (let i = 0; i < 5; i++) {
    near.age(10000)
    await near.tick()
  }
  assert.deepStrictEqual([near.drills(), near.env.follow.followState === near.st, near.bot.pathfinder.goal === goal], [0, true, true])

  const atRest = followHarness()
  atRest.age(10000)
  await atRest.tick()
  assert.strictEqual(atRest.drills(), 0, 'a body at rest far from the player is not wedged')

  const wedged = followHarness()
  wedged.setMoving(true)
  wedged.age(10000)
  await wedged.tick()
  assert.strictEqual(wedged.drills(), 1, 'control: moving without progress')
  assert.ok(wedged.bot.pathfinder.goal instanceof goals.GoalFollow, 're-armed after the drill')
})

test('a follow whose search found no way says what blocks it, once per 30 s, while the player is out of range', async () => {
  const ladder = 'ladder at -2,64,1: walk to it and climb it'
  for (const status of ['noPath', 'timeout']) {
    const h = followHarness()
    const asked = []
    h.env.wayHint = (r) => { asked.push(r.cell && [r.cell.x, r.cell.y, r.cell.z]); return ladder }
    await h.tick()
    assert.deepStrictEqual(h.events, [], `${status}: control, no search failed yet`)
    h.bot.emit('path_update', { status, path: [] })
    await h.tick()
    await h.tick()
    assert.deepStrictEqual(h.events, [{ kind: 'follow', msg: `no way found to Steve: ${ladder}` }], status)
    assert.deepStrictEqual(asked, [[10, 64, 0]], `${status}: the way toward the player in sight`)
    h.st.warnT -= 30001
    await h.tick()
    assert.strictEqual(h.events.length, 2, `${status}: again after 30 s`)
  }
  const plain = followHarness()
  plain.bot.emit('path_update', { status: 'noPath', path: [] })
  await plain.tick()
  assert.deepStrictEqual(plain.events.map((e) => e.msg), ['no way found to Steve: no known way there'], 'nothing to name')
  const near = followHarness({ position: new Vec3(2.5, 64, 0.5) })
  near.bot.emit('path_update', { status: 'noPath', path: [] })
  await near.tick()
  assert.deepStrictEqual(near.events, [], 'the player in range')
  const found = followHarness()
  found.bot.emit('path_update', { status: 'success', path: [] })
  await found.tick()
  assert.deepStrictEqual(found.events, [], 'a search that found a way')
})

test('a follow holds one path listener, a re-arm forgets the last search, and unfollow removes the listener', () => {
  const h = followHarness()
  assert.strictEqual(h.bot.listenerCount('path_update'), 1)
  h.bot.emit('path_update', { status: 'noPath', path: [] })
  assert.strictEqual(h.st.pathStatus, 'noPath', 'control: the search for the armed goal')
  h.arm()
  assert.deepStrictEqual([h.bot.listenerCount('path_update'), h.st.pathStatus], [1, null])
  h.unfollow()
  assert.strictEqual(h.bot.listenerCount('path_update'), 0)
})

test('follow holds through a lost sight without walking to the hidden player, says so once, and resumes when they show', async () => {
  const h = followHarness()
  h.gate.seen = false
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, null, 'the goal toward the hidden player is cleared')
  h.age(13000)
  await h.tick()
  await h.tick()
  assert.deepStrictEqual(h.events.map((e) => e.msg), ['lost sight of Steve, still following and going on once they show again'])
  assert.strictEqual(h.env.follow.followState, h.st)
  h.gate.seen = true
  await h.tick()
  assert.ok(h.bot.pathfinder.goal instanceof goals.GoalFollow)
  assert.strictEqual(h.bot.pathfinder.goal.entity, h.steve)
  assert.deepStrictEqual(h.events.map((e) => e.msg).slice(1), ['Steve is back in view, following again'])
})

test('follow by the nametag alone heads for the cube centre, never the player, re-aims when the cube changes and follows the player once seen', async () => {
  const h = followHarness({ position: new Vec3(12.2, 64.3, 1.7), gate: { nametag: true } })
  const at = () => { const g = h.bot.pathfinder.goal; return [g instanceof goals.GoalFollow, g.x, g.y, g.z] }
  const first = h.bot.pathfinder.goal
  assert.deepStrictEqual(at(), [false, 12, 62, 2], 'the centre of the cube, not the player\'s cell 12,64,1')
  h.steve.position = new Vec3(13.9, 63.1, 0.2)
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, first, 'a step inside the cube changes nothing')
  h.steve.position = new Vec3(17.2, 64, 1)
  await h.tick()
  assert.deepStrictEqual(at(), [false, 17, 62, 2], 'the next cube')
  h.gate.seen = true
  await h.tick()
  assert.ok(h.bot.pathfinder.goal instanceof goals.GoalFollow, 'in sight')
  assert.strictEqual(h.bot.pathfinder.goal.entity, h.steve)
})

test('follow re-arms a goal a reflex cleared once the reflex is done, and not during a fight, a held lane, a job or a walk someone else set', async () => {
  const h = followHarness()
  h.bot.pathfinder.goal = null
  h.combat.active = true
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, null, 'a fight')
  h.combat.active = false
  h.combat._fleeUntil = Date.now() + 6000
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, null, 'a flee latch')
  h.combat._fleeUntil = 0
  h.combat._coverUntil = Date.now() + 4000
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, null, 'a cover latch')
  h.combat._coverUntil = 0
  h.env.legs.take('unstuck', 'break a pathing wedge', Date.now() - QUIET_MS + 1000)
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, null, 'the quiet after a reflex took the legs')
  h.env.legs.take('unstuck', 'break a pathing wedge', Date.now() - QUIET_MS - 1)
  h.env.pilotLane.until = Date.now() + 60000
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, null, 'a held lane')
  h.env.pilotLane.until = 0
  h.job.running = true
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, null, 'a running job between its own goals')
  h.job.running = false
  const other = new goals.GoalNear(-20, 64, 0, 2)
  h.bot.pathfinder.goal = other
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, other, 'a walk someone else set')
  h.bot.pathfinder.goal = null
  await h.tick()
  assert.ok(h.bot.pathfinder.goal instanceof goals.GoalFollow, 'the cleared goal re-armed')
  assert.deepStrictEqual(h.events, [], 'follow says nothing about waiting')
})

test('follow holds while the body stands in a finished bunker and re-arms once it stepped out', async () => {
  const h = followHarness()
  h.bot.pathfinder.goal = null
  h.env.bunker.cell = ME.floored()
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, null, 'in the shelter')
  h.bot.entity.position = ME.offset(1, 0, 0)
  await h.tick()
  assert.ok(h.bot.pathfinder.goal instanceof goals.GoalFollow, 'out of the shelter')
})

test('follow waits 5 s after the hurt freeze or a lava take before it walks again', async () => {
  for (const reflex of ['hurt', 'lava_watch']) {
    const h = followHarness()
    h.bot.pathfinder.goal = null
    h.env.legs.take(reflex, 'stop', Date.now() - LONG_QUIET_MS + 1000)
    await h.tick()
    assert.strictEqual(h.bot.pathfinder.goal, null, `${reflex}: 4 s after`)
    h.env.legs.take(reflex, 'stop', Date.now() - LONG_QUIET_MS - 1)
    await h.tick()
    assert.ok(h.bot.pathfinder.goal instanceof goals.GoalFollow, `${reflex}: past 5 s`)
    assert.deepStrictEqual(h.events, [], `${reflex}: nothing said`)
  }
})

test('follow waits out a pilot verb that walks and then acts, and re-arms once the verb settled', async () => {
  const h = followHarness()
  let acted
  h.app.get('/digat', async (req, res) => {
    h.bot.pathfinder.setGoal(new goals.GoalNear(3, 64, 0, 1))
    h.bot.pathfinder.goal = null
    await new Promise((resolve) => { acted = resolve })
    res.json({ ok: true })
  })
  const reply = h.routes['/digat']({ query: {} }, { json () {} })
  assert.strictEqual(h.bot.pathfinder.goal, null, 'control: the verb walked and cleared its goal')
  await h.tick()
  assert.strictEqual(h.bot.pathfinder.goal, null, 'no follow goal while the verb acts')
  acted()
  await reply
  await h.tick()
  assert.ok(h.bot.pathfinder.goal instanceof goals.GoalFollow, 're-armed once the verb replied')
})

test('a stop or unfollow during the drill\'s pause or its nudge leaves no goal and no control state set', async () => {
  for (const end of ['stop', 'unfollow']) {
    const paused = followHarness({ door: true, holdPause: true })
    paused.setMoving(true)
    paused.age(10000)
    const drill = paused.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(paused.pauses.length, 1, `${end}: control, the drill pauses`)
    paused[end]()
    paused.pauses.shift()()
    await drill
    assert.deepStrictEqual(setAfterStop(paused.log), [], `${end} during the pause`)
    assert.strictEqual(paused.bot.pathfinder.goal, null)

    const nudged = followHarness({ door: true })
    nudged.setMoving(true)
    nudged.age(10000)
    nudged.bot.onLook = () => { nudged.bot.onLook = null; nudged[end]() }
    await nudged.tick()
    assert.ok(nudged.log.some(([k]) => k === 'stop'), `${end}: control, the nudge began`)
    assert.deepStrictEqual(setAfterStop(nudged.log), [], `${end} during the nudge`)
    assert.deepStrictEqual([nudged.bot.pathfinder.goal, nudged.controls.forward || false], [null, false])
  }
})
