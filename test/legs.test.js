'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { QUIET_MS, LONG_QUIET_MS, legLedger, takenText, laneBlocks } = require('../lib/leg-ledger')
const { routeDeadline } = require('../lib/walk')
const { isDoor, doorCrossing } = require('../lib/doors')
const { entityInCell } = require('../lib/shelter')
const Block = require('prismarine-block')('1.21.11')
const { SPRINT_FLOOR } = require('../lib/sprint')
const { loadBotFunctions, combatReflexIn, awaitRoute, routeHandler, laneAt, botConstant, walkingBody, wireListeners } = require('./helpers')

const KLASSES = ['discretionary', 'interrupt', 'emergency']
const lane = (over) => laneBlocks({ klass: 'discretionary', bunker: false, laneHeld: false, hard: false, jobRunning: false, meleeThreat: false, ...over })

test('the ledger names the last reflex that took the legs since a mark, and a stop names nobody', () => {
  const legs = legLedger()
  const m = legs.mark()
  assert.strictEqual(legs.takenSince(m), null, 'control: nothing taken yet')
  legs.take('combat', 'flee')
  legs.take('lava_watch', 'back away from lava')
  assert.deepStrictEqual(legs.takenSince(m), { reflex: 'lava_watch', why: 'back away from lava' })
  assert.strictEqual(legs.takenSince(legs.mark()), null, 'a take before the mark counts')
  legs.take(null)
  assert.strictEqual(legs.takenSince(m), null, 'the pilot stop still names the reflex before it')
})

test('the quiet after a reflex take lasts 3 s, 5 s after the hurt freeze or a lava take, and the pilot stop leaves none', () => {
  const legs = legLedger()
  assert.strictEqual(legs.quietUntil(), 0, 'control: nothing taken yet')
  legs.take('unstuck', 'break a pathing wedge', 1000)
  assert.strictEqual(legs.quietUntil(), 1000 + QUIET_MS)
  legs.take('hurt', 'freeze after an unexplained hit', 2000)
  assert.strictEqual(legs.quietUntil(), 2000 + LONG_QUIET_MS)
  legs.take('lava_watch', 'back away from lava', 3000)
  assert.strictEqual(legs.quietUntil(), 3000 + LONG_QUIET_MS)
  legs.take(null)
  assert.strictEqual(legs.quietUntil(), 0)
  assert.deepStrictEqual([QUIET_MS, LONG_QUIET_MS], [3000, 5000])
})

test('takenText names the reflex and what it took the legs for', () => {
  assert.strictEqual(takenText({ reflex: 'combat', why: 'flee' }), 'the combat reflex took the legs to flee')
  assert.strictEqual(takenText({ reflex: 'unstuck', why: null }), 'the unstuck reflex took the legs')
})

test('with no job running the lane decides as before', () => {
  for (const klass of KLASSES) assert.strictEqual(lane({ klass }), false, `${klass} with a free lane`)
  assert.strictEqual(lane({ klass: 'discretionary', laneHeld: true }), true, 'discretionary under a held lane')
  assert.strictEqual(lane({ klass: 'interrupt', laneHeld: true }), false, 'interrupt under a soft lane')
  assert.strictEqual(lane({ klass: 'interrupt', laneHeld: true, hard: true }), true, 'interrupt under a hard lane')
  assert.strictEqual(lane({ klass: 'emergency', laneHeld: true, hard: true }), false, 'emergency under a hard lane')
  for (const klass of KLASSES) assert.strictEqual(lane({ klass, bunker: true }), true, `${klass} while a bunker holds`)
})

test('a running job keeps the legs from all but emergencies until a threat is in melee range', () => {
  assert.strictEqual(lane({ klass: 'discretionary' }), false, 'control: no job')
  assert.strictEqual(lane({ klass: 'discretionary', jobRunning: true }), true, 'discretionary during a job')
  assert.strictEqual(lane({ klass: 'interrupt', jobRunning: true }), true, 'interrupt during a job')
  assert.strictEqual(lane({ klass: 'emergency', jobRunning: true }), false, 'emergency during a job')
  assert.strictEqual(lane({ klass: 'discretionary', jobRunning: true, meleeThreat: true }), false, 'discretionary with a threat in melee range')
  assert.strictEqual(lane({ klass: 'interrupt', jobRunning: true, meleeThreat: true }), false, 'interrupt with a threat in melee range')
})

test('a pillar top holds the legs from every flee but an emergency at disengage health with a mob in melee reach', async () => {
  const entity = { position: new Vec3(0.5, 64, 0.5) }
  const env = {
    bot: { entity, blockAt: (p) => ({ name: 'stone', boundingBox: 'block', position: p }) },
    bunker: { building: false },
    BUNKER_WALK: 'refused while a bunker is being built',
    legs: legLedger(),
    takenText,
    perch: { cell: null },
    claimLane: () => ({}),
    releaseLane () {},
    fillers: () => [{ name: 'dirt', count: 64 }],
    pillarHeight: (height) => ({ height, safe: 2, why: 'flat ground' }),
    BUNKER_MAX_HEIGHT: 6,
    knownCell: () => false,
    jumpPlace: async () => {
      entity.position = entity.position.offset(0, 1, 0)
      return true
    }
  }
  await awaitRoute('/pillar', { height: '3' }, env)
  const { perchHolds } = loadBotFunctions(['perchHolds'], env)
  const onTop = (over) => lane({ perch: perchHolds(), ...over })
  for (const klass of KLASSES) assert.strictEqual(onTop({ klass }), true, `${klass} on the pillar top`)
  assert.strictEqual(onTop({ klass: 'interrupt', hpMelee: true }), true, 'an interrupt at disengage health')
  assert.strictEqual(onTop({ klass: 'emergency', hpMelee: true }), false, 'an emergency at disengage health')
  Object.assign(entity, { position: new Vec3(0.5, 68.18, 0.5), onGround: false })
  assert.strictEqual(onTop({ klass: 'discretionary' }), true, 'a jump on the pillar top')
  entity.position = new Vec3(1.5, 67.5, 0.5)
  assert.strictEqual(onTop({ klass: 'discretionary' }), false, 'once the body stepped off into the air beside it')
  assert.strictEqual(env.perch.cell, null)
})

test('each level of a pilot pillar holds the legs as a pillar top while the next level goes up', async () => {
  const entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  // Per level, the lane answers for each class and for an emergency at disengage health with a mob in melee reach.
  const levels = []
  const env = {
    bot: { entity, blockAt: (p) => ({ name: 'stone', boundingBox: 'block', position: p }) },
    bunker: { building: false },
    BUNKER_WALK: 'refused while a bunker is being built',
    legs: legLedger(),
    takenText,
    perch: { cell: null },
    claimLane: () => ({}),
    releaseLane () {},
    fillers: () => [{ name: 'dirt', count: 64 }],
    pillarHeight: (height) => ({ height, safe: 2, why: 'flat ground' }),
    BUNKER_MAX_HEIGHT: 6,
    knownCell: () => false,
    jumpPlace: async () => {
      const perch = perchHolds()
      levels.push([...KLASSES.map((klass) => lane({ klass, perch })), lane({ klass: 'emergency', hpMelee: true, perch })])
      entity.position = entity.position.offset(0, 1, 0)
      return true
    }
  }
  const { perchHolds } = loadBotFunctions(['perchHolds'], { bot: env.bot, perch: env.perch })
  assert.deepStrictEqual(await awaitRoute('/pillar', { height: '3' }, env), { placed: 3, rose: 3, y: 67 })
  assert.deepStrictEqual(levels[0], [false, false, false, false], 'control: the ground under the first level is no pillar top')
  assert.deepStrictEqual(levels.slice(1), [[true, true, true, false], [true, true, true, false]])
})

// Runs /pillar 3 high with step in place of each jumpPlace, returning res and the lane's state before, during and after.
async function pillarOverLane (step, over = {}) {
  const entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  const lane = laneAt(entity, null)
  const answers = { before: lane.laneBlocks('discretionary'), during: [] }
  const env = {
    bot: { entity, blockAt: (p) => ({ name: 'stone', boundingBox: p.y < entity.position.y ? 'block' : 'empty', position: p }) },
    bunker: lane.bunker,
    BUNKER_WALK: 'refused while a bunker is being built',
    legs: legLedger(),
    takenText,
    perch: lane.perch,
    claimLane: lane.claimLane,
    releaseLane: lane.releaseLane,
    fillers: () => [{ name: 'dirt', count: 64 }],
    pillarHeight: (height) => ({ height, safe: 2, why: 'flat ground' }),
    BUNKER_MAX_HEIGHT: 6,
    knownCell: () => false,
    jumpPlace: async () => {
      answers.during.push(lane.laneBlocks('discretionary'))
      await step({ env, lane, entity, level: answers.during.length })
      entity.position = entity.position.offset(0, 1, 0)
      return true
    },
    ...over
  }
  const { handle, res } = routeHandler('/pillar', env)
  await handle({ query: { height: '3' } }, res)
  return { ...answers, held: lane.pilotLane.until > 0, token: lane.pilotLane.token, res }
}

test('a pilot pillar holds the soft lane from its first level, so a discretionary take cannot cut it off', async () => {
  const r = await pillarOverLane(() => {})
  assert.strictEqual(r.res.error, undefined)
  assert.deepStrictEqual([r.before, r.during, r.held], [false, [true, true, true], false], 'free before, held in every level, free after')
})

test('a pilot pillar keeps the interrupt and emergency classes open under its soft lane', async () => {
  const classes = []
  await pillarOverLane(({ lane }) => { classes.push(['interrupt', 'emergency'].map((klass) => lane.laneBlocks(klass))) })
  assert.deepStrictEqual(classes[0], [false, false])
})

test('a pilot pillar releases its lane when it ends, stops, is refused or throws', async () => {
  const ends = {
    done: [() => {}, {}],
    stopped: [({ env }) => { env.legs.take('combat', 'flee') }, {}],
    thrown: [() => { throw new Error('jump failed') }, {}],
    bunker: [({ env }) => { env.bunker.building = true }, {}]
  }
  for (const [why, [step, over]] of Object.entries(ends)) {
    const r = await pillarOverLane(step, over)
    assert.ok(r.during.length > 0 && r.during.every(Boolean), `control: ${why} held the lane`)
    assert.deepStrictEqual([r.held, r.token], [false, null], `${why} left the lane held`)
  }
})

test('a pilot pillar leaves a lane a later claim took over', async () => {
  const r = await pillarOverLane(({ lane }) => { lane.claimLane('goto', 300000) })
  assert.strictEqual(r.held, true, 'the goto claim outlives the pillar')
})

test('a stopped walk names the reflex that took the legs during it, nothing else does', () => {
  const legs = legLedger()
  const { namedStop } = loadBotFunctions(['namedStop'], { legs, takenText })
  const mark = legs.mark()
  const stopped = { arrived: false, reason: 'stopped', hint: 'check /jobs, wait a beat, try again' }
  assert.deepStrictEqual(namedStop(stopped, mark), stopped, 'control: no reflex took the legs')
  legs.take('combat', 'take cover')
  const r = namedStop(stopped, mark)
  assert.strictEqual(r.takenBy, 'the combat reflex took the legs to take cover')
  assert.strictEqual(r.hint, stopped.hint)
  const stalled = { arrived: false, reason: 'stalled', hint: 'h' }
  assert.deepStrictEqual(namedStop(stalled, mark), stalled, 'a walk that ended for another reason')
  assert.deepStrictEqual(namedStop(stopped, legs.mark()), stopped, 'a take before the route began')
})

test('every take of the legs ends the walk routes begun before it, and the route mark names the reflex', () => {
  const legs = legLedger()
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5) }
  bot.pathfinder = { goal: null }
  const { walkRoute, namedStop } = loadBotFunctions(['walkRoute', 'namedStop'], { bot, legs, takenText, routeDeadline, stopPath () {} })
  const stopped = { reason: 'stopped' }
  const route = walkRoute()
  assert.strictEqual(route.stopped(), false, 'control: nothing took the legs')
  legs.take('lava_watch', 'back away from lava')
  assert.strictEqual(route.stopped(), true)
  assert.strictEqual(namedStop(stopped, route.mark).takenBy, 'the lava_watch reflex took the legs to back away from lava')
  route.end()
  const next = walkRoute()
  assert.strictEqual(next.stopped(), false, 'a take before the route began')
  legs.take(null)
  assert.strictEqual(next.stopped(), true, 'the pilot stop ends it too')
  assert.strictEqual(namedStop(stopped, next.mark).takenBy, undefined, 'and names nobody')
  next.end()
})

// The leg and job takes of one melee swing at a zombie 2 blocks off, under a stance that chases or not.
async function meleeSwing ({ chase, goal }) {
  const zombie = { id: 7, name: 'zombie', position: new Vec3(2.5, 64, 0.5) }
  const takes = []
  let waits = 0
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 7: zombie },
    health: 20,
    food: 20,
    inventory: { items: () => [], slots: [] },
    heldItem: null,
    pathfinder: { goal, isMoving: () => !!goal, setGoal (g) { this.goal = g } },
    lookAt: async () => {},
    waitForTicks: async () => {},
    attack () {}
  }
  const env = {
    bot,
    STANCES: { s: { fleeDist: 16, bowBand: [7, 24], chase, engage: 'closers' } },
    fight: { stance: 's', lastHit: { dmg: 0, t: 0 }, lastAttackT: 0 },
    LEGACY_1710: false,
    guardState: { up: false, slot: -1, pilot: false },
    mobHurt: { wait: () => 0 },
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false },
    shared: { mcData: null },
    goals,
    headFree: () => true,
    compass: () => 'E',
    emitEvent () {},
    mobClass: () => 'hostile',
    airFlood: () => ({}),
    knownCell: () => true,
    entityPerceptible: () => true,
    nearHostiles: () => [],
    inMeleeReach: () => true,
    meleeAim: (e, y) => e.position.offset(0, y, 0),
    disengageHp: () => 8,
    yieldJob: (reflex, why) => takes.push(['job', reflex, why]),
    takeLegs: (reflex, why) => takes.push(['legs', reflex, why]),
    threatWhy: (what) => what,
    laneBlocks: () => false,
    laneNarrate () {},
    drawAndLoose: async () => false,
    perchStrike: () => false,
    holdRun: { on: false },
    SPRINT_FLOOR,
    strikeRun: { lane: null },
    // The zombie dies after the first swing.
    setTimeout: (fn) => {
      if (++waits === 2) delete bot.entities[7]
      setImmediate(fn)
    }
  }
  loadBotFunctions(['chargedSwing'], env)
  const combat = combatReflexIn(env)
  combat._threat = { e: zombie, cls: 'hostile', dist: 2, confirmed: false }
  await combat.act(bot)
  return { takes, goal: bot.pathfinder.goal }
}

test('a melee fight ends the running job but leaves a walk its legs, and a chase stance takes them by name', async () => {
  const walk = new goals.GoalNear(20, 64, 0, 0)
  const melee = ['job', 'combat', 'fight in melee range']
  assert.deepStrictEqual(await meleeSwing({ chase: false, goal: walk }), { takes: [melee], goal: walk })
  assert.deepStrictEqual(await meleeSwing({ chase: true, goal: walk }), { takes: [melee, ['legs', 'combat', 'fight in melee range']], goal: null })
  assert.deepStrictEqual(await meleeSwing({ chase: true, goal: null }), { takes: [melee], goal: null }, 'no goal to take')
})

const LADDER_ID = 65

// wayHint and insideBlock for a body at pos over stone up to y 63 plus cells ('x,y,z' -> [name, properties]). lit says
// which cells the bot sees lit, and ladders the ladder cells it sees, or with ladder true the one at -2,64,1.
function senses ({ pos = new Vec3(0.5, 64, 0.5), cells = {}, lit = () => true, ladder = false, ladders = ladder ? [new Vec3(-2, 64, 1)] : [] } = {}) {
  const bot = {
    entity: { position: pos, width: 0.6, height: 1.8 },
    blockAt (p) {
      const c = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const [name, props] = cells[`${c.x},${c.y},${c.z}`] || [c.y <= 63 ? 'stone' : 'air', {}]
      const b = Block.fromProperties(name, props, 0)
      b.position = c
      return b
    }
  }
  const ctx = loadBotFunctions(['wayHint', 'insideBlock'], {
    bot,
    Vec3,
    isDoor,
    doorCrossing,
    entityInCell,
    cellKnown: lit,
    knownCell: lit,
    seenNow: (p) => ctx.bodyTouches(p) || lit(p),
    resolveBlockIds: (name) => (name === 'ladder' ? [LADDER_ID] : []),
    // Nearest first, as findBlocks hands them out.
    findVisible: (ids, maxDist, count) => (ids.includes(LADDER_ID) && maxDist === 16 ? ladders : [])
      .map((p) => ({ pos: p, dist: pos.distanceTo(p) })).sort((a, b) => a.dist - b.dist).slice(0, count)
  })
  return { bot, wayHint: ctx.wayHint, insideBlock: ctx.insideBlock, lit, touches: ctx.bodyTouches }
}

// The x,y,z cells a hint names.
const namedCells = (hint) => [...(hint || '').matchAll(/(-?\d+),(-?\d+),(-?\d+)/g)].map((m) => new Vec3(+m[1], +m[2], +m[3]))

const EAST = { cell: new Vec3(10, 64, 0) }
const openDoor = (half) => ['oak_door', { open: true, half, facing: 'east', hinge: 'left' }]

test('a walk that found no way names the last lit cell short of the dark, one a torch can be placed in', () => {
  assert.strictEqual(senses().wayHint(EAST), null, 'control: every cell lit')
  const s = senses({ lit: (p) => p.x <= 2 })
  const hint = s.wayHint(EAST)
  assert.strictEqual(hint, 'too dark for me past 2,64,0: a torch there would light the way')
  const [cell] = namedCells(hint)
  assert.ok(s.lit(cell), 'the named cell is known')
  const floor = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => cell.offset(dx, dy, dz))
  assert.ok(floor.some((n) => s.lit(n) && s.bot.blockAt(n).boundingBox === 'block'), 'a seen solid block below or beside it')
})

test('a dark hint names no dark cell behind the bot', () => {
  const s = senses({ lit: (p) => p.x >= -1 })
  assert.match(s.wayHint({ cell: new Vec3(-10, 64, 0) }) || '', /^too dark for me past /, 'control: the goal lies past the dark')
  assert.strictEqual(s.wayHint(EAST), null)
})

test('an unseen way gets a dark hint only when its edge lies within 6 blocks', () => {
  const s = senses({ lit: (p) => p.x <= 2 })
  assert.match(s.wayHint(EAST, { x: 6, y: 64, z: 0 }) || '', /^too dark for me past /, 'control: an edge 6 away')
  assert.strictEqual(s.wayHint(EAST, { x: 7, y: 64, z: 0 }), null)
})

test('a dark hint never names a cell that already holds a torch', () => {
  const cells = { '2,64,0': ['torch', {}], '2,65,1': ['stone', {}] }
  const hint = senses({ cells, lit: (p) => p.x <= 2 }).wayHint(EAST)
  assert.match(hint || '', /^too dark for me past /, 'control: another cell can hold one')
  assert.ok(!namedCells(hint).some((c) => c.equals(new Vec3(2, 64, 0))), hint)
})

test('a dark hint never names the cells the body stands in', () => {
  const hint = senses({ cells: { '-1,65,0': ['stone', {}] }, lit: (p) => p.x <= 0 }).wayHint(EAST)
  assert.ok(!namedCells(hint).some((c) => c.x === 0 && c.z === 0 && c.y >= 64 && c.y <= 65), hint)
})

test('a walk that found no way names an open door seen now whose far side is unknown', () => {
  const cells = { '1,64,0': openDoor('lower'), '1,65,0': openDoor('upper') }
  assert.strictEqual(senses({ cells }).wayHint(EAST), null, 'control: both sides of the door known')
  assert.match(senses({ cells, lit: (p) => p.x <= 1 }).wayHint(EAST), /^the way runs through the door at 1,64,0: gaze through it/)
  const shut = { '1,64,0': ['oak_door', { open: false, half: 'lower', facing: 'east', hinge: 'left' }], '1,65,0': ['oak_door', { open: false, half: 'upper', facing: 'east', hinge: 'left' }] }
  assert.doesNotMatch(senses({ cells: shut, lit: (p) => p.x <= 1 }).wayHint(EAST) || '', /door/, 'a closed door')
})

test('a door hint looks only past the door along its passage, never at the frame beside it', () => {
  const frame = { '1,64,1': ['stone', {}], '1,65,1': ['stone', {}], '1,64,-1': ['stone', {}], '1,65,-1': ['stone', {}] }
  const cells = { ...frame, '1,64,0': openDoor('lower'), '1,65,0': openDoor('upper') }
  const pos = new Vec3(2.5, 64, 0.5)
  assert.match(senses({ pos, cells, lit: (p) => p.x >= 1 }).wayHint({ cell: new Vec3(-10, 64, 0) }) || '', /^the way runs through the door at 1,64,0: gaze through it/, 'control: the cell the bot came from unknown')
  assert.strictEqual(senses({ pos, cells, lit: (p) => !(p.x === 1 && p.z !== 0) }).wayHint(EAST), null)
})

test('a walk that found no way names a ladder in sight when the goal lies 2 or more above the feet or its y is unknown', () => {
  const climb = 'ladder at -2,64,1: walk to it and climb it'
  assert.strictEqual(senses().wayHint({ cell: new Vec3(10, 70, 0) }), null, 'control: no ladder in sight')
  const s = senses({ ladder: true })
  assert.strictEqual(s.wayHint({ cell: new Vec3(10, 66, 0) }), climb)
  assert.strictEqual(s.wayHint({ toward: { x: 40, y: undefined, z: 0 } }), climb, 'a goal y unknown')
  assert.strictEqual(s.wayHint({ cell: new Vec3(10, 65, 0) }), null, '1 above')
  assert.strictEqual(s.wayHint({ cell: new Vec3(10, 60, 0) }), null, 'a goal below')
})

test('a ladder hint names no ladder below the feet', () => {
  const shaft = [60, 61, 62, 63].map((y) => new Vec3(1, y, 0))
  const up = { cell: new Vec3(10, 70, 0) }
  assert.strictEqual(senses({ ladders: shaft }).wayHint(up), null)
  assert.strictEqual(senses({ ladders: [...shaft, new Vec3(-3, 64, 2)] }).wayHint(up), 'ladder at -3,64,2: walk to it and climb it', 'control: one at the feet')
})

test('the way hints come door first, then the ladder, then the dark', () => {
  const cells = { '1,64,0': openDoor('lower'), '1,65,0': openDoor('upper') }
  const hint = senses({ cells, lit: (p) => p.x <= 1, ladder: true }).wayHint({ cell: new Vec3(10, 70, 0) })
  assert.match(hint, /^the way runs through the door at 1,64,0: gaze through it\. ladder at -2,64,1: walk to it and climb it\. too dark for me past -?\d+,\d+,-?\d+: a torch there would light the way$/)
})

test('a way hint never names a cell the bot does not know', () => {
  // An open door at 2,64,1 and the cells past x 2 are hidden.
  const cells = { '2,64,1': openDoor('lower'), '2,65,1': openDoor('upper') }
  const hidden = (p) => p.x > 2 || (p.x === 2 && p.z === 1 && p.y >= 64)
  for (const pos of [new Vec3(0.5, 64, 0.5), new Vec3(0.5, 64, 2.5), new Vec3(0.5, 64, -0.5)]) {
    const s = senses({ pos, cells, lit: (p) => !hidden(p) })
    for (const r of [EAST, { cell: new Vec3(9, 64, 1) }, { toward: { x: 30, y: undefined, z: 30 } }]) {
      const hint = s.wayHint(r)
      assert.ok(hint, `control: a hint from ${pos} toward ${JSON.stringify(r)}`)
      for (const c of namedCells(hint)) assert.ok(!hidden(c) || s.touches(c), `${hint} from ${pos}`)
      assert.doesNotMatch(hint, /door/, `the hidden door, from ${pos}`)
    }
  }
})

test('insideBlock names a block whose collision box the body is inside, and nothing it rests on or presses against', () => {
  const inside = (pos, cells) => {
    const r = senses({ pos, cells }).insideBlock()
    return r && JSON.parse(JSON.stringify(r))
  }
  const face = { '10,64,0': ['stone', {}], '10,65,0': ['stone', {}] }
  assert.deepStrictEqual(inside(new Vec3(9.8, 64, 0.5), face), { name: 'stone', x: 10, y: 64, z: 0 }, 'control: 0.1 into the stone')
  assert.strictEqual(inside(new Vec3(9.7, 64, 0.5), face), null, 'pressed against its face')
  assert.strictEqual(inside(new Vec3(0.5, 64.0625, 0.5), { '0,64,0': ['white_carpet', {}] }), null, 'on carpet')
  assert.strictEqual(inside(new Vec3(0.5, 64.5, 0.5), { '0,64,0': ['stone_slab', { type: 'bottom' }] }), null, 'on a slab')
  const wall = { '0,64,0': ['cobblestone_wall', { up: true }] }
  assert.strictEqual(inside(new Vec3(0.5, 65.5, 0.5), wall), null, 'on top of a wall')
  assert.deepStrictEqual(inside(new Vec3(0.5, 64, 0.5), wall), { name: 'cobblestone_wall', x: 0, y: 64, z: 0 })
})

test('insideBlock never names a diagonal cell the body overlaps in the dark', () => {
  const cells = { '1,64,1': ['stone', {}] }
  const pos = new Vec3(0.8, 64, 0.8)
  assert.strictEqual(senses({ pos, cells }).insideBlock().name, 'stone', 'control: in the light')
  assert.strictEqual(senses({ pos, cells, lit: () => false }).insideBlock(), null)
})

const ck = (x, y, z) => x + ',' + y + ',' + z
// The feet y on column x of a 1-wide stair cut down into the stone.
const stairFeet = (x) => 64 - Math.min(5, Math.max(0, x))
// The stair's air: the feet cell and the two over it on columns 1 to 5, below the open ground at y 64.
const STAIR = Object.fromEntries([1, 2, 3, 4, 5].flatMap((x) => [0, 1, 2].map((dy) => stairFeet(x) + dy).filter((y) => y <= 63).map((y) => [`${x},${y},0`, ['air', {}]])))

// The body's moves down the stair along z 0.5, a tenth of a block apart, each drop over three airborne moves.
function* stairMoves () {
  let y = 64
  for (let k = 5; k <= 55; k++) {
    const x = k / 10
    // The body rests on the highest column under its 0.6 wide box, the one its west edge is over.
    const feet = stairFeet(Math.floor((k - 3) / 10))
    if (feet < y) for (const dy of [0.25, 0.5, 0.75]) yield [x, y - dy, false]
    y = feet
    yield [x, y, true]
  }
}

test('a goto finds its way back up a dark stair the body just walked down', async (t) => {
  const { bot, plan } = await walkingBody(t, new Vec3(0.5, 64, 0.5), STAIR)
  const SEEN = new Set()
  wireListeners({
    bot,
    Vec3,
    ck,
    SEEN,
    SEEN_CAP: 1000,
    seenEdits: 0,
    OLDEST: new WeakMap(),
    SURFACE: new Map(),
    SURFACE_CAP: 1000,
    surfaceEdits: 0,
    STATIONS: new Map(),
    STATION_CAP: 1000,
    STATION_RE: botConstant('STATION_RE'),
    stationEdits: 0,
    bodyMarkedAt: null
  }, 'move')
  for (const [x, y, onGround] of stairMoves()) {
    bot.entity.position = new Vec3(x, y, 0.5)
    bot.entity.onGround = onGround
    bot.emit('move')
  }
  assert.deepStrictEqual(bot.entity.position, new Vec3(5.5, 59, 0.5), 'control: the walk ends at the bottom')
  const top = new goals.GoalBlock(0, 64, 0)
  assert.strictEqual(plan(top).status, 'success', 'control: the stair climbs with every cell known')
  const { knownMoves } = loadBotFunctions(['knownMoves'], { ck, knownCell: (p) => SEEN.has(ck(p.x, p.y, p.z)), PLAN_KNOWN: new Map() })
  const result = plan(top, knownMoves(bot.pathfinder.movements))
  assert.strictEqual(result.status, 'success')
  assert.deepStrictEqual(result.path.map((p) => [Math.floor(p.x), p.y, Math.floor(p.z)]), [[4, 60, 0], [3, 61, 0], [2, 62, 0], [1, 63, 0], [0, 64, 0]])
})
