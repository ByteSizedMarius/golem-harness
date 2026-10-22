'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const MC_DATA = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')(require('prismarine-registry')('1.21.11'))
const { fleeHeading, planFlee, creeperCover, routeWithin, walkersTo, walkFlood, groundCell } = require('../lib/flee')
const { isDoor } = require('../lib/doors')
const { expireConfirmed } = require('../lib/shelter')
const { legLedger, takenText } = require('../lib/leg-ledger')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { loadBotFunctions, combatReflexIn, botConstant, botSource, balanced, reflexIn, fakeClock, laneAt } = require('./helpers')

const HERE = new Vec3(0, 64, 0)
const near = (a, b) => Math.abs(a - b) < 1e-9

test('a lone threat sends the flee straight away from it', () => {
  const h = fleeHeading(HERE, new Vec3(5, 64, 0), [])
  assert.ok(near(h.x, -1) && near(h.z, 0), JSON.stringify(h))
})

test('a second mob bends the flee away from both, the nearer one pushing harder', () => {
  const east = new Vec3(5, 64, 0)
  const lone = fleeHeading(HERE, east, [])
  assert.ok(near(lone.z, 0), 'control: straight west')
  const h = fleeHeading(HERE, east, [new Vec3(0, 64, 5)])
  assert.ok(h.x < 0 && h.z < 0 && near(h.x, h.z), `away from east and south equally, got ${JSON.stringify(h)}`)
  const closer = fleeHeading(HERE, east, [new Vec3(0, 64, 2)])
  assert.ok(closer.z < closer.x, `the mob at 2 outweighs the one at 5, got ${JSON.stringify(closer)}`)
  assert.ok(near(Math.hypot(closer.x, closer.z), 1), 'a unit heading')
})

test('a mob straight down the naive flee line turns the flee aside', () => {
  const h = fleeHeading(HERE, new Vec3(4, 64, 0.5), [new Vec3(-4, 64, 0)])
  assert.ok(Math.abs(h.z) > Math.abs(h.x), `the flee runs between them, got ${JSON.stringify(h)}`)
})

test('pushes that cancel out fall back to straight away from the threat', () => {
  const h = fleeHeading(HERE, new Vec3(3, 64, 0), [new Vec3(-3, 64, 0)])
  assert.ok(near(h.x, -1) && near(h.z, 0), JSON.stringify(h))
})

test('a hostile the body does not perceive never enters the flee', () => {
  const mob = (id, x, seen) => ({ id, name: 'zombie', cls: 'hostile', seen, position: new Vec3(x, 64, 0) })
  const entities = { 1: mob(1, 5, true), 2: mob(2, -5, false), 3: mob(3, 3, true) }
  const env = {
    bot: { entity: { position: HERE }, entities },
    mobClass: (e) => e.cls,
    AGGRO_CONFIRMED: new Map(),
    staleEntities: new Set(),
    entityPerceptible: (e) => e.seen,
    entityEngageable: () => true,
    walksToBody: () => true,
    CREEPER_DROP
  }
  const { nearHostiles } = loadBotFunctions(['nearHostiles'], env)
  const seenAt = new Map()
  const ids = (radius) => [...nearHostiles({}, radius, seenAt)].map((h) => h.e.id)
  assert.deepStrictEqual(ids(16), [1, 3])
  env.AGGRO_CONFIRMED.set(2, { t: Date.now() })
  assert.deepStrictEqual(ids(16), [1, 3], 'a mob that hit the body and was never seen')
  seenAt.set(2, new Vec3(-5, 64, 0))
  assert.deepStrictEqual(ids(16), [1, 2, 3], 'a mob that hit the body counts unseen')
  assert.deepStrictEqual(ids(4), [3], 'only the mob within the radius')
  env.staleEntities.add(1)
  assert.deepStrictEqual(ids(16), [2, 3], 'a mob left over from the dimension before')
})

test('a hidden mob that hit the body counts within the radius by where the body last saw it', () => {
  const zombie = { id: 2, name: 'zombie', cls: 'hostile', position: null }
  const env = {
    bot: { entity: { position: HERE }, entities: { 2: zombie } },
    mobClass: (e) => e.cls,
    AGGRO_CONFIRMED: new Map([[2, { t: Date.now() }]]),
    staleEntities: new Set(),
    entityPerceptible: () => false,
    entityEngageable: () => true
  }
  const { nearHostiles } = loadBotFunctions(['nearHostiles'], env)
  // The mobs within 16 and the spot each counts at, with the zombie standing at x and last seen at seen.
  const within = (x, seen) => {
    zombie.position = new Vec3(x, 64, 0)
    return Array.from(nearHostiles({}, 16, new Map([[2, new Vec3(seen, 64, 0)]])), (h) => [h.e.id, h.at.x])
  }
  assert.deepStrictEqual(within(-20, -5), [[2, -5]], 'last seen within 16, now beyond it')
  assert.deepStrictEqual(within(-5, -20), [], 'last seen beyond 16, now within it')
})

const ck = (x, y, z) => x + ',' + y + ',' + z
const inArea = (x, z) => Math.abs(x) <= 40 && Math.abs(z) <= 40
// Ground at y 63 over the area, bedrock under y 40. lava, water and unknown pick cells out.
const plateau = (over = {}) => ({ solid: (x, y, z) => y < 40 || (inArea(x, z) && y < 64), lava: () => false, water: () => false, unknown: () => false, ...over })

function blockAt (w) {
  return (p) => {
    const lava = w.lava(p.x, p.y, p.z)
    const solid = !lava && w.solid(p.x, p.y, p.z)
    const water = !lava && !solid && w.water(p.x, p.y, p.z)
    return { name: lava ? 'lava' : solid ? 'stone' : water ? 'water' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], position: p }
  }
}

// The flee from threat, the takenBy it leaves and the events it emits, with the bot and the combat reflex it ran on.
// A threat with seen false is one the body does not perceive.
// over replaces entries of the env the combat reflex runs over.
function fleeIn (w, threat, ally = null, over = {}) {
  const logs = []
  const events = []
  const legs = legLedger()
  const mark = legs.mark()
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: blockAt(w),
    pathfinder: { goal: null, setGoal (g) { this.goal = g } },
    controlState: {},
    setControlState (c, s) { this.controlState[c] = s }
  }
  const env = {
    bot,
    Vec3,
    goals,
    ck,
    planFlee,
    creeperCover,
    routeWithin,
    walkersTo,
    groundCell,
    isDoor,
    WALK_MEMO: botConstant('WALK_MEMO'),
    WALK_STEPS: botConstant('WALK_STEPS'),
    WALK_CAP: botConstant('WALK_CAP'),
    CREEPER_DROP: botConstant('CREEPER_DROP'),
    RANGED: botConstant('RANGED'),
    AGGRO_CONFIRMED: new Map(),
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    fight: { stance: 'guard' },
    shared: { mcData: MC_DATA },
    console: { log: (line) => logs.push(line) },
    setTimeout () {},
    cellKnown: (p) => !w.unknown(p.x, p.y, p.z),
    reflexes: [{ name: 'flee_to_player', on: true, ally: () => ally }],
    nearHostiles: () => [],
    airFlood: () => ({}),
    knownCell: () => true,
    mobClass: () => 'creeper',
    laneBlocks: () => false,
    laneNarrate () {},
    entityPerceptible: (e) => e.seen !== false,
    takenText,
    takeLegs: (reflex, why) => legs.take(reflex, why),
    stopPath () { bot.pathfinder.setGoal(null) },
    emitEvent: (kind, msg) => events.push({ kind, msg }),
    LEGACY_1710: false,
    ...over
  }
  loadBotFunctions(['fleeWorld', 'fleeLog', 'threatWhy', 'creeperSwelling', 'walksToBody', 'rangedInSight'], env)
  const combat = combatReflexIn(env)
  // The body last perceived threat where it stands.
  combat._seenAt.set(threat.id, threat.position.clone())
  const held = combat.fleeFrom(bot, threat, null, 'emergency')
  const g = bot.pathfinder.goal
  const taken = legs.takenSince(mark)
  return {
    bot,
    combat,
    held,
    goal: g && { x: Math.floor(g.x), y: Math.floor(g.y), z: Math.floor(g.z) },
    logs,
    events: events.map((e) => e.kind),
    messages: events.map((e) => e.msg),
    combatEvents: events.filter((e) => e.kind === 'combat').map((e) => e.msg),
    takenBy: taken && takenText(taken)
  }
}

const creeper = (x, y, z, seen = true) => ({ id: 9, name: 'creeper', seen, position: new Vec3(x, y, z) })

function assertSafe (w, g) {
  assert.ok(g, 'no flee goal')
  assert.ok(w.solid(g.x, g.y - 1, g.z) && !w.solid(g.x, g.y, g.z) && !w.solid(g.x, g.y + 1, g.z), `no floor at ${JSON.stringify(g)}`)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = g.x + dx
    const z = g.z + dz
    assert.ok(!w.unknown(x, g.y, z), `an unknown cell beside ${JSON.stringify(g)}`)
    const floored = [0, 1, 2, 3, 4].some((d) => w.solid(x, g.y - d, z))
    assert.ok(floored, `a drop over 3 beside ${JSON.stringify(g)}`)
  }
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) {
    assert.ok(!w.lava(g.x + dx, g.y + dy, g.z + dz), `lava within 2 of ${JSON.stringify(g)}`)
  }
}

test('a flee runs to a safe cell, never into a ravine, beside a drop, near lava or beside unknown cells', () => {
  // A ravine 24 deep over x -30 to -6, lava at x -5 to -1 and z -16 to -12, everything beyond z 9 unseen.
  const w = plateau({
    solid: (x, y, z) => y < 40 || (inArea(x, z) && y < 64 && !(x >= -30 && x <= -6)),
    lava: (x, y, z) => y === 63 && x >= -5 && x <= -1 && z >= -16 && z <= -12,
    unknown: (x, y, z) => z > 9
  })
  const r = fleeIn(w, creeper(5.5, 64, 0.5))
  assert.strictEqual(r.held, undefined)
  assertSafe(w, r.goal)
  const d = Math.hypot(r.goal.x - 0, r.goal.z - 0)
  assert.ok(d >= 8 && r.goal.x < 0, `the goal ${JSON.stringify(r.goal)} lies 8 or more away from the creeper side`)
  assert.strictEqual(r.logs.filter((l) => l.startsWith('[flee]')).length, 1, 'one [flee] line')
})

test('a flee never ends under water, and wades across water one deep', () => {
  // West of x -4 water stands depth deep on a floor that low.
  const lake = (depth) => plateau({
    solid: (x, y, z) => y < 40 || (inArea(x, z) && y < (x <= -4 ? 64 - depth : 64)),
    water: (x, y, z) => inArea(x, z) && x <= -4 && y >= 64 - depth && y < 64
  })
  const pond = lake(2)
  const r = fleeIn(pond, creeper(5.5, 64, 0.5))
  assert.ok(r.goal, 'no flee goal')
  const g = r.goal
  assert.ok(!pond.water(g.x, g.y, g.z) && !pond.water(g.x, g.y + 1, g.z), `the goal ${JSON.stringify(g)} lies in the pond`)
  assert.ok(pond.solid(g.x, g.y - 1, g.z), `no floor at ${JSON.stringify(g)}`)
  // Water one deep everywhere west of x -4 but a dry field from x -8 on.
  const ford = plateau({
    solid: (x, y, z) => lake(1).solid(x, y, z) || (inArea(x, z) && x <= -8 && y < 64),
    water: (x, y, z) => x > -8 && lake(1).water(x, y, z)
  })
  const across = fleeIn(ford, creeper(5.5, 64, 0.5))
  assert.ok(across.goal && across.goal.x <= -8, `the flee stops short of the ford: ${JSON.stringify(across.goal)}`)
})

test('with no safe cell in reach the body holds its ground', () => {
  // A ridge one block wide from the body to the creeper, 24 above the ground.
  const w = plateau({ solid: (x, y, z) => y < 40 || (x >= 0 && x <= 3 && z === 0 && y < 64) })
  const r = fleeIn(w, creeper(3.5, 64, 0.5))
  assert.strictEqual(r.held, 'held')
  assert.strictEqual(r.goal, null, 'a goal off the ridge')
  assert.ok(r.logs.some((l) => l.startsWith('[flee]')), 'no [flee] line')
  const stand = 'the combat reflex took the legs to stand still, no safe cell to flee to: creeper E ~3, same level'
  assert.strictEqual(r.takenBy, stand)
  assert.deepStrictEqual(r.combatEvents, [stand])
})

test('a creeper flee names the creeper, its bearing, distance and level in takenBy and in one combat event', () => {
  const r = fleeIn(plateau(), creeper(6.5, 66, 0.5))
  assert.ok(r.goal, 'control: the flee found a goal')
  const fled = 'the combat reflex took the legs to flee: creeper E ~6, 2 above'
  assert.strictEqual(r.takenBy, fled)
  assert.deepStrictEqual(r.combatEvents, [fled])
})

test('a creeper flee and a stand each raise at most one combat event per 8 s', () => {
  const pinnacle = plateau({ solid: (x, y, z) => y < 40 || (x === 0 && z === 0 && y < 64) })
  const field = plateau({ solid: (x, y, z) => y < 40 || (Math.abs(x) <= 9 && Math.abs(z) <= 9 && y < 64) })
  for (const [label, w] of [['flee', field], ['stand', pinnacle]]) {
    let clock = 1e6
    const at = []
    const r = fleeIn(w, creeper(5.5, 64, 0.5), null, {
      Date: { now: () => clock },
      emitEvent: (kind) => { if (kind === 'combat') at.push(clock - 1e6) }
    })
    // True when the reflex flees or stands again ms later.
    const again = (ms) => {
      clock += ms
      r.combat._fleeUntil = r.combat._holdUntil = 0
      r.bot.pathfinder.goal = null
      return r.combat.fleeFrom(r.bot, creeper(5.5, 64, 0.5), null, 'emergency') === 'held' || !!r.bot.pathfinder.goal
    }
    assert.ok(again(7000), `control: the ${label} 7 s later`)
    assert.ok(again(1001), `control: the ${label} 8.001 s after the first`)
    assert.deepStrictEqual(at, [0, 8001], label)
  }
})

test('a flee the pillar top holds back keeps the body still and raises a combat event naming the creeper', () => {
  const r = fleeIn(plateau(), creeper(5.5, 64, 0.5), null, { laneBlocks: () => true, perchHolds: () => true })
  assert.strictEqual(r.goal, null)
  assert.deepStrictEqual(r.combatEvents, ['the combat reflex kept the body on the pillar top instead of a flee: creeper E ~5, same level'])
})

test('a body inside its bunker starts no flee, not even from a creeper beside it', () => {
  // Ground 25 wide, which keeps the flee plan fast.
  const patch = plateau({ solid: (x, y, z) => y < 64 && Math.abs(x) <= 12 && Math.abs(z) <= 12 })
  const flee = (cell) => {
    // fleeIn stands the body at (0.5, 64, 0.5).
    const lane = laneAt({ position: new Vec3(0.5, 64, 0.5) }, cell)
    return fleeIn(patch, creeper(5.5, 64, 0.5), null, { laneBlocks: lane.laneBlocks, laneNarrate: lane.laneNarrate, perchHolds: lane.perchHolds })
  }
  const outside = flee(null)
  assert.ok(outside.goal && outside.takenBy, `control: no flee outside a bunker, ${JSON.stringify(outside)}`)
  const inside = flee(new Vec3(0, 64, 0))
  assert.deepStrictEqual([inside.goal, inside.takenBy, inside.events], [null, null, []])
})

test('a swelling creeper is fled to a seen corner within a few steps that hides the body from its eyes, else far', () => {
  const swelling = (seen = true) => {
    const metadata = []
    metadata[MC_DATA.entitiesByName.creeper.metadataKeys.indexOf('swell_dir')] = 1
    return { ...creeper(3.5, 64, 0.5, seen), metadata }
  }
  // A stone column 3 high in the cell south of the body, beside the creeper's line to it.
  const column = (x, y, z) => x === 0 && z === 1 && y >= 64 && y <= 66
  const corner = plateau({ solid: (x, y, z) => plateau().solid(x, y, z) || column(x, y, z) })
  const hidden = fleeIn(corner, swelling())
  assert.deepStrictEqual(hidden.goal, { x: -1, y: 64, z: 1 })
  assert.strictEqual(hidden.takenBy, 'the combat reflex took the legs to break its sight: creeper E ~3, same level')
  const far = (w, threat) => {
    const r = fleeIn(w, threat)
    assert.ok(r.goal && Math.hypot(r.goal.x, r.goal.z) >= 8, `the goal ${JSON.stringify(r.goal)} lies under 8 away`)
  }
  far(corner, creeper(3.5, 64, 0.5))
  far(plateau(), swelling())
  far(plateau({ ...corner, unknown: column }), swelling())
  far(corner, swelling(false))
})

test('a 1.7.10 creeper, 0.1 taller than a 1.21.11 one, sees over cover that hides the body from the 1.21.11 one', () => {
  const metadata = []
  metadata[MC_DATA.entitiesByName.creeper.metadataKeys.indexOf('swell_dir')] = 1
  // The creeper on a block 7 east, a stone pillar two high 5 east.
  const w = plateau({ solid: (x, y, z) => plateau().solid(x, y, z) || (z === 0 && ((x === 7 && y === 64) || (x === 5 && y <= 65))) })
  const goal = (legacy) => fleeIn(w, { ...creeper(7.5, 65, 0.5), metadata }, null, { LEGACY_1710: legacy }).goal
  assert.deepStrictEqual(goal(false), { x: 3, y: 64, z: 0 })
  assert.deepStrictEqual(goal(true), { x: 4, y: 64, z: 0 })
})

test('a creeper back within 3 of the cover is fled again 1 s after the cover move, a far flee holds its legs for 6 s', async () => {
  let clock = 1e6
  const column = (x, y, z) => x === 0 && z === 1 && y >= 64 && y <= 66
  const corner = plateau({ solid: (x, y, z) => plateau().solid(x, y, z) || column(x, y, z) })
  // The first flee goal from threat, and the goal of the reflex pass 1 s later, with the body on the first goal
  // and threat 2 south of it.
  const again = async (threat) => {
    const r = fleeIn(corner, threat, null, {
      Date: { now: () => clock },
      STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
      fight: { stance: 'guard' },
      LEGACY_1710: false,
      guardState: { up: false, slot: -1, pilot: false }
    })
    const bot = r.bot
    bot.entity.position = new Vec3(r.goal.x + 0.5, r.goal.y, r.goal.z + 0.5)
    bot.entities = { 9: threat }
    bot.inventory = { items: () => [] }
    bot.pathfinder.goal = null
    threat.position = bot.entity.position.offset(0, 0, 2)
    clock += 1000
    r.combat._threat = { e: threat, cls: 'creeper', dist: 2, confirmed: false }
    await r.combat.act(bot)
    return { first: r.goal, next: bot.pathfinder.goal }
  }
  const metadata = []
  metadata[MC_DATA.entitiesByName.creeper.metadataKeys.indexOf('swell_dir')] = 1
  const cover = await again({ ...creeper(3.5, 64, 0.5), metadata })
  assert.deepStrictEqual(cover.first, { x: -1, y: 64, z: 1 }, 'control: the cover move')
  assert.ok(cover.next, 'no flee 1 s after the cover move, with the creeper 2 from the body')
  const far = await again(creeper(3.5, 64, 0.5))
  assert.ok(Math.hypot(far.first.x, far.first.z) >= 8, `control: the far flee, got ${JSON.stringify(far.first)}`)
  assert.strictEqual(far.next, null, 'a new flee goal within the 6 s of a far flee')
})

test('the sprint of a cover move ends with its 1 s hold, and an earlier flee never ends the sprint of a later one', () => {
  const column = (x, y, z) => x === 0 && z === 1 && y >= 64 && y <= 66
  const corner = plateau({ solid: (x, y, z) => plateau().solid(x, y, z) || column(x, y, z) })
  const metadata = []
  metadata[MC_DATA.entitiesByName.creeper.metadataKeys.indexOf('swell_dir')] = 1
  const clock = fakeClock()
  const timers = { Date: { now: clock.now }, setTimeout: clock.setTimeout }
  const cover = fleeIn(corner, { ...creeper(3.5, 64, 0.5), metadata }, null, timers)
  assert.deepStrictEqual(cover.goal, { x: -1, y: 64, z: 1 }, 'control: the cover move')
  assert.strictEqual(cover.bot.controlState.sprint, true, 'control: the cover move sprints')
  clock.advance(1000)
  assert.strictEqual(cover.bot.controlState.sprint, false, 'still sprinting 1 s after the cover move')
  // A far flee, then one more 3 s later once a reset cleared the latch, as after a death.
  const far = fleeIn(corner, creeper(3.5, 64, 0.5), null, timers)
  assert.strictEqual(far.bot.controlState.sprint, true, 'control: the far flee sprints')
  clock.advance(3000)
  far.combat._fleeUntil = 0
  far.combat.fleeFrom(far.bot, creeper(3.5, 64, 0.5), null, 'emergency')
  clock.advance(3500)
  assert.strictEqual(far.bot.controlState.sprint, true, 'the first far flee ended the sprint of the second')
  clock.advance(3000)
  assert.strictEqual(far.bot.controlState.sprint, false, 'still sprinting 6 s after the second far flee')
})

test('a flee from a threat the body does not perceive names no mob', () => {
  const r = fleeIn(plateau(), creeper(6.5, 66, 0.5, false))
  assert.ok(r.goal, 'control: the flee found a goal')
  assert.strictEqual(r.takenBy, 'the combat reflex took the legs to flee')
  assert.deepStrictEqual(r.combatEvents, ['the combat reflex took the legs to flee'])
  const ridge = fleeIn(plateau({ solid: (x, y, z) => y < 40 || (x >= 0 && x <= 3 && z === 0 && y < 64) }), creeper(3.5, 64, 0.5, false))
  assert.strictEqual(ridge.takenBy, 'the combat reflex took the legs to stand still, no safe cell to flee to')
  assert.deepStrictEqual(ridge.combatEvents, [ridge.takenBy])
})

test('a flee from a threat out of sight runs from where the body last saw it, and one never seen is held', () => {
  const r = fleeIn(plateau(), creeper(5.5, 64, 0.5))
  assert.ok(r.goal && r.goal.x < 0, `control: the flee from the creeper in sight east, got ${JSON.stringify(r.goal)}`)
  // Last seen east, the creeper now stands west out of sight.
  const again = (seenAt) => {
    r.combat._fleeUntil = 0
    r.combat._seenAt.clear()
    if (seenAt) r.combat._seenAt.set(9, seenAt)
    r.bot.pathfinder.goal = null
    const held = r.combat.fleeFrom(r.bot, creeper(-5.5, 64, 0.5, false), null, 'emergency')
    return { held, goal: r.bot.pathfinder.goal }
  }
  const moved = again(new Vec3(5.5, 64, 0.5))
  assert.ok(moved.goal && moved.goal.x < 0, `the flee runs from the hidden position, got ${JSON.stringify(moved.goal)}`)
  const never = again(null)
  assert.strictEqual(never.held, 'held')
  assert.strictEqual(never.goal, null, 'a flee from a threat never perceived')
})

test('a flee runs to a player only along a route that passes no lava', () => {
  const ally = { username: 'Steve', position: new Vec3(-10.5, 64, 0.5) }
  const open = plateau()
  const toPlayer = fleeIn(open, creeper(5.5, 64, 0.5), ally)
  assert.ok(toPlayer.goal && Math.hypot(toPlayer.goal.x + 10, toPlayer.goal.z) <= 2, `control: the goal ${JSON.stringify(toPlayer.goal)} beside the player`)
  assert.deepStrictEqual(toPlayer.events.filter((k) => k === 'flee_to_player'), ['flee_to_player'])
  const trench = plateau({ lava: (x, y, z) => x === -5 && y === 63 })
  const r = fleeIn(trench, creeper(5.5, 64, 0.5), ally)
  assertSafe(trench, r.goal)
  assert.ok(r.goal.x > -5, `the goal ${JSON.stringify(r.goal)} lies past the lava`)
  assert.deepStrictEqual(r.events.filter((k) => k === 'flee_to_player'), [])
})

test('a flee runs to a player in sight, never to one walled off, sneaking or known by the nametag alone, and never names one', () => {
  // A stone shell around the player's two cells at x -11, z 0.
  const shell = (x, y, z) => x >= -12 && x <= -10 && z >= -1 && z <= 1 && y >= 64 && y <= 66 && !(x === -11 && z === 0 && y <= 65)
  const walled = plateau({ solid: (x, y, z) => plateau().solid(x, y, z) || shell(x, y, z) })
  const flee = (w, crouching) => {
    const steve = { id: 7, type: 'player', username: 'Steve', crouching, metadata: [0], position: new Vec3(-10.5, 64, 0.5) }
    const bot = { username: 'Claude', entity: { position: new Vec3(0.5, 64, 0.5) }, entities: { 7: steve }, blockAt: blockAt(w) }
    const reflex = reflexIn('flee_to_player', { bot, Vec3, ck, staleEntities: new Set(), lightRange: () => Infinity })
    const { airFlood } = loadBotFunctions(['airFlood'], { bot, Vec3, ck })
    const ally = reflex.ally(bot, bot.entity.position, new Vec3(5.5, 64, 0.5), airFlood({ radius: 28, cap: 15000 }))
    return { ally, ...fleeIn(w, creeper(5.5, 64, 0.5), null, { reflexes: [reflex], airFlood }) }
  }
  const seen = flee(plateau(), false)
  assert.strictEqual(seen.ally && seen.ally.username, 'Steve', 'control: in sight')
  assert.deepStrictEqual(seen.events.filter((k) => k === 'flee_to_player'), ['flee_to_player'])
  for (const crouching of [true, false]) {
    const hidden = flee(walled, crouching)
    assert.strictEqual(hidden.ally, undefined, crouching ? 'sneaking' : 'by the nametag')
    assert.deepStrictEqual(hidden.events.filter((k) => k === 'flee_to_player'), [])
    assert.doesNotMatch(JSON.stringify([hidden.logs, hidden.messages]), /Steve/)
  }
})

// One check pass over a creeper at `at` that closes on the body: whether it scores, the distance it scores at and
// the starts of the walks to the body it tried. A hidden creeper hit the body out of sight, last seen at
// hidden.seenAt, null for never.
function creeperPass (w, at, hidden = null) {
  const e = creeper(at.x, at.y, at.z, !hidden)
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, entities: { 9: e }, blockAt: blockAt(w) }
  const routes = []
  const env = {
    bot,
    Vec3,
    ck,
    routeWithin: (world, from, ...rest) => {
      routes.push(from)
      return routeWithin(world, from, ...rest)
    },
    expireConfirmed,
    console: { log () {} },
    cellKnown: () => true,
    CREEPER_DROP: botConstant('CREEPER_DROP'),
    CONFIRMED_HORIZON: botConstant('CONFIRMED_HORIZON'),
    CONFIRMED_MS: botConstant('CONFIRMED_MS'),
    CONFIRMED_COOL_MS: botConstant('CONFIRMED_COOL_MS'),
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    fight: { stance: 'guard', threatDebugUntil: 0 },
    AGGRO_CONFIRMED: new Map(hidden ? [[9, { name: 'creeper', t: Date.now() }]] : []),
    bunker: { building: false },
    liveEntities: () => [e],
    mobClass: () => 'creeper',
    airFlood: () => ({}),
    knownCell: () => true,
    entityPerceptible: (en) => en.seen,
    entityEngageable: () => true,
    holdRun: { on: false },
    emitEvent () {}
  }
  loadBotFunctions(['creeperRoute'], env)
  const combat = combatReflexIn(env)
  const d = e.position.distanceTo(bot.entity.position)
  // Three samples of closing already taken.
  combat._hist.set(9, { d: d + 2, t: Date.now() - 1000, closes: 3, logT: Date.now() })
  if (hidden && hidden.seenAt) combat._seenAt.set(9, hidden.seenAt)
  const threat = combat.check(bot)
  return { threat, dist: threat ? combat._threat.dist : null, routes }
}
const creeperCheck = (w, at) => creeperPass(w, at).threat

test('a creeper below a cliff with no walk up is watched, one within 8 or with a walk up is fled', () => {
  // The cliff top stands at y 64 for x up to 2, the ground below it at y 59.
  const cliff = (x, y, z) => y < 40 || (inArea(x, z) && y < (x <= 2 ? 64 : 59))
  const below = new Vec3(7.5, 59, 0.5)
  assert.strictEqual(creeperCheck(plateau({ solid: cliff }), below), false, 'the creeper 8.6 below the cliff')
  assert.strictEqual(creeperCheck(plateau({ solid: cliff }), new Vec3(3.5, 59, 0.5)), true, 'the creeper 5.8 below the cliff')
  // A ramp at z 2 climbs from the ground at x 7 to the top at x 3.
  const ramp = (x, y, z) => cliff(x, y, z) || (z === 2 && x >= 3 && x <= 7 && y < 64 - (x - 3))
  assert.strictEqual(creeperCheck(plateau({ solid: ramp }), below), true, 'the creeper with the ramp')
})

// The cliff top stands at y 64 for x up to 2, the ground below it at y 59, with no walk up.
const CLIFF = plateau({ solid: (x, y, z) => y < 40 || (inArea(x, z) && y < (x <= 2 ? 64 : 59)) })
// On the cliff top 10 from the body with a flat walk to it, and 8.6 off below the cliff.
const TOP = new Vec3(-9.5, 64, 0.5)
const BELOW = new Vec3(7.5, 59, 0.5)

test('a creeper that hit the body out of sight is scored and walked from where the body last saw it, one never seen stays a threat with no walk', () => {
  const body = new Vec3(0.5, 64, 0.5)
  const fromTop = creeperPass(CLIFF, BELOW, { seenAt: TOP })
  assert.deepStrictEqual(fromTop, { threat: true, dist: TOP.distanceTo(body), routes: [TOP.floored()] }, 'last seen on the cliff top, now below it')
  const fromBelow = creeperPass(CLIFF, TOP, { seenAt: BELOW })
  assert.deepStrictEqual(fromBelow, { threat: false, dist: null, routes: [BELOW.floored()] }, 'last seen below the cliff, now on its top')
  const never = creeperPass(CLIFF, TOP, { seenAt: null })
  assert.strictEqual(never.threat, true, 'never seen')
  assert.ok(!Number.isFinite(never.dist), `a distance ${never.dist} from a creeper never seen`)
  assert.deepStrictEqual(never.routes, [], 'never seen')
})

// The draws ('shoot') and flees ('flee') of one combat pass under stance against a creeper dist east.
async function creeperAct (stance, dist, loosed) {
  const did = []
  const e = creeper(0.5 + dist, 64, 0.5)
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, entities: { 9: e }, inventory: { items: () => [], slots: [] } }
  const env = {
    bot,
    Vec3,
    fight: { stance },
    STANCES: vm.runInNewContext(`(${balanced(botSource(), botSource().indexOf('const STANCES = '))})`),
    LEGACY_1710: false,
    guardState: { up: false, slot: -1, pilot: false },
    bunker: { building: false },
    strikeRun: { lane: null },
    airFlood: () => ({}),
    knownCell: () => true,
    entityPerceptible: () => true,
    drawAndLoose: async () => { did.push('shoot'); return loosed },
    emitEvent () {}
  }
  loadBotFunctions(['compass'], env)
  const combat = combatReflexIn(env)
  combat.fleeFrom = () => { did.push('flee') }
  combat._threat = { e, cls: 'creeper', dist, confirmed: false }
  await combat.act(bot)
  return did
}

test('the reflex flees a creeper within 16 on guard, 12 on vanguard and 8 on skirmish, and shoots one farther out or flees', async () => {
  for (const [stance, fleeDist] of [['guard', 16], ['vanguard', 12], ['skirmish', 8]]) {
    assert.deepStrictEqual(await creeperAct(stance, fleeDist, true), ['flee'], `${stance} at ${fleeDist}`)
    assert.deepStrictEqual(await creeperAct(stance, fleeDist + 1, true), ['shoot'], `${stance} at ${fleeDist + 1}`)
    assert.deepStrictEqual(await creeperAct(stance, fleeDist + 1, false), ['shoot', 'flee'], `${stance} at ${fleeDist + 1}, no arrow loosed`)
  }
})

// seen says whether the body perceives the zombie that hit it.
async function hitNarration (seen) {
  const events = []
  const zombie = { id: 4, name: 'zombie', position: new Vec3(6.5, 64, 0.5) }
  const solid = (p) => p.y < 64 || (p.x === -2 && p.z === 0 && p.y < 67)
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 4: zombie },
    inventory: { items: () => [] },
    food: 20,
    blockAt: (p) => ({ name: solid(p) ? 'stone' : 'air', boundingBox: solid(p) ? 'block' : 'empty' }),
    pathfinder: { goal: null, setGoal (g) { this.goal = g } }
  }
  const env = {
    bot,
    Vec3,
    goals,
    fight: { stance: 'guard' },
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    LEGACY_1710: false,
    guardState: { up: false, slot: -1, pilot: false },
    bunker: { building: false },
    airFlood: () => ({}),
    knownCell: () => true,
    cellKnown: () => true,
    ck,
    isDoor,
    walkFlood,
    entityPerceptible: (e) => e !== zombie || seen,
    strikeRun: { lane: null },
    laneBlocks: () => false,
    takeLegs () {},
    stopPath () {},
    emitEvent: (kind, msg) => events.push(msg)
  }
  loadBotFunctions(['compass', 'losClear', 'threatWhy', 'fleeWorld'], env)
  const combat = combatReflexIn(env)
  // Off skips the melee loop.
  combat.on = false
  combat._threat = { e: zombie, cls: 'hostile', dist: 6, confirmed: true }
  await combat.act(bot)
  const acted = events.splice(0)
  // The body saw the zombie where it stands before it went out of sight.
  combat._seenAt.set(zombie.id, zombie.position.clone())
  combat.takeCover(bot, zombie, 'zombie E ~6')
  assert.ok(bot.pathfinder.goal, 'control: the body took cover')
  return { acted, covered: events }
}

// One melee pass against a zombie 6 out that hit the body and dies mid-pass. seen sets whether the body
// perceives the zombie, a player's seen whether it perceives that player.
async function meleePass ({ seen = true, pack = [], players = [] } = {}) {
  const events = []
  const fled = []
  const zombie = { id: 4, name: 'zombie', position: new Vec3(6.5, 64, 0.5) }
  const bot = {
    username: 'Claude',
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 4: zombie, ...Object.fromEntries(players.map((p) => [p.id, p])) },
    health: 20,
    food: 20,
    inventory: { items: () => [], slots: [] },
    lookAt: async () => {}
  }
  const env = {
    bot,
    Vec3,
    goals,
    fight: { stance: 'guard' },
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    LEGACY_1710: false,
    guardState: { up: false, slot: -1, pilot: false },
    bunker: { building: false },
    AGGRO_CONFIRMED: new Map(),
    airFlood: () => ({}),
    knownCell: () => true,
    entityPerceptible: (e) => (e === zombie ? seen : e.seen),
    liveEntities: () => Object.values(bot.entities),
    nearHostiles: () => pack,
    mobClass: () => 'hostile',
    disengageHp: () => 0,
    inMeleeReach: () => false,
    perchStrike: () => false,
    holdRun: { on: false },
    strikeRun: { lane: null },
    headFree: () => { delete bot.entities[4]; return false },
    setTimeout: (fn) => fn(),
    emitEvent: (kind, msg) => { if (kind === 'combat') events.push(msg) }
  }
  loadBotFunctions(['compass'], env)
  const combat = combatReflexIn(env)
  combat.fleeFrom = (b, e, why) => { fled.push(why) }
  combat._threat = { e: zombie, cls: 'hostile', dist: 6, confirmed: true }
  await combat.act(bot)
  return { events, fled }
}

test('an outnumbered body holds the line only beside a player it sees, and a hidden one changes nothing', async () => {
  const pack = [1, 2, 3].map((id) => ({ e: { id, name: 'zombie' }, at: new Vec3(id, 64, 0) }))
  const steve = (seen) => ({ id: 8, type: 'player', username: 'Steve', seen, position: new Vec3(3.5, 64, 0.5) })
  const beside = await meleePass({ pack, players: [steve(true)] })
  assert.deepStrictEqual(beside.fled, [], 'control: no withdrawal beside a player in sight')
  assert.ok(beside.events.some((m) => /HOLDING/.test(m)), `control: ${beside.events}`)
  const alone = await meleePass({ pack })
  const hidden = await meleePass({ pack, players: [steve(false)] })
  assert.deepStrictEqual(hidden, alone)
  assert.strictEqual(hidden.fled.length, 1)
  assert.doesNotMatch(JSON.stringify(hidden), /ally|HOLDING|Steve/)
})

test('a zombie that dies out of sight raises no DOWN line, one that dies in sight does', async () => {
  assert.deepStrictEqual((await meleePass({ seen: true })).events, ['zombie is DOWN'], 'control: in sight')
  assert.deepStrictEqual((await meleePass({ seen: false })).events, [])
})

test('a hit by a zombie out of sight is narrated without its name, bearing or distance', async () => {
  const seen = await hitNarration(true)
  assert.ok(seen.acted.length === 1 && seen.acted[0].includes('zombie'), `control: ${seen.acted}`)
  assert.ok(seen.covered.length === 1 && seen.covered[0].includes('zombie'), `control: ${seen.covered}`)
  const unseen = await hitNarration(false)
  assert.strictEqual(unseen.acted.length, 1, 'the hit is still narrated')
  assert.doesNotMatch(unseen.acted[0], /zombie|~\d|\b(?:N|S|E|W|NE|NW|SE|SW)\b/)
  assert.strictEqual(unseen.covered.length, 1)
  assert.doesNotMatch(unseen.covered[0], /zombie|~\d/)
})

// Two stone walls two high beside the body at (0, 64, 0): one east at x 2, z 1 to 2, one north at z -2, x -1 to 0.
const coverWalls = (p) => p.y < 64 || (p.y < 66 && ((p.x === 2 && (p.z === 1 || p.z === 2)) || (p.z === -2 && (p.x === -1 || p.x === 0))))
const EAST = new Vec3(8.5, 64, 0.5)

// The cover cell the combat reflex takes from a skeleton that hit the body, after one watch pass with the
// skeleton at EAST in sight. moved is where it then stands out of sight, known which cells the body knows,
// kelp which open cells hold kelp.
function coverFrom ({ moved = null, known = () => true, kelp = () => false }) {
  const skeleton = { id: 5, name: 'skeleton', position: EAST.clone() }
  let inSight = true
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 5: skeleton },
    blockAt: (p) => ({ name: coverWalls(p) ? 'stone' : kelp(p) ? 'kelp' : 'air', boundingBox: coverWalls(p) ? 'block' : 'empty' }),
    pathfinder: { goal: null, setGoal (g) { this.goal = g } }
  }
  const env = {
    bot,
    Vec3,
    goals,
    console: { log () {} },
    expireConfirmed,
    CONFIRMED_HORIZON: botConstant('CONFIRMED_HORIZON'),
    CONFIRMED_MS: botConstant('CONFIRMED_MS'),
    CONFIRMED_COOL_MS: botConstant('CONFIRMED_COOL_MS'),
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    fight: { stance: 'guard', threatDebugUntil: 0 },
    AGGRO_CONFIRMED: new Map([[5, { name: 'skeleton', t: Date.now(), ranged: true }]]),
    bunker: { building: false },
    holdRun: { on: false },
    liveEntities: () => [skeleton],
    mobClass: () => 'hostile',
    perchStrike: () => false,
    inMeleeReach: () => false,
    airFlood: () => ({}),
    knownCell: (p) => known(p),
    cellKnown: (p) => known(p),
    ck,
    isDoor,
    walkFlood,
    entityPerceptible: (e) => e !== skeleton || inSight,
    entityEngageable: () => true,
    laneBlocks: () => false,
    laneNarrate () {},
    takeLegs () {},
    stopPath () {},
    emitEvent () {}
  }
  loadBotFunctions(['compass', 'losClear', 'threatWhy', 'fleeWorld'], env)
  const combat = combatReflexIn(env)
  assert.strictEqual(combat.check(bot), true, 'control: the watch pass scores the skeleton')
  if (moved) { skeleton.position = moved; inSight = false }
  combat.takeCover(bot, skeleton, 'skeleton E ~8')
  const g = bot.pathfinder.goal
  assert.ok(g, 'control: the body took cover')
  const cell = { x: g.x, y: g.y, z: g.z }
  const fromEast = env.losClear(EAST.offset(0, 1.62, 0), new Vec3(cell.x + 0.5, cell.y + 1.62, cell.z + 0.5))
  return { cell, fromEast }
}

test('cover from a skeleton that walked out of sight hides the body from where it was last seen', () => {
  assert.strictEqual(coverFrom({}).fromEast, false, 'control: cover from the skeleton in sight')
  const r = coverFrom({ moved: new Vec3(0.5, 64, -8.5) })
  assert.strictEqual(r.fromEast, false, `the cover ${JSON.stringify(r.cell)} stands in the sightline from the last seen spot`)
})

test('cover is never a cell the body does not know', () => {
  const nearest = coverFrom({}).cell
  assert.deepStrictEqual(nearest, { x: 0, y: 64, z: 1 }, 'control: the nearest cover')
  const r = coverFrom({ known: (p) => !(p.x === 0 && p.z === 1) })
  assert.notDeepStrictEqual({ x: r.cell.x, z: r.cell.z }, { x: 0, z: 1 }, 'cover in an unknown cell')
  assert.strictEqual(r.fromEast, false, `the cover ${JSON.stringify(r.cell)} stands in the sightline`)
})

test('cover is never a cell hidden only by a block the body does not know', () => {
  // The east wall unknown, the north wall known.
  const eastWall = (p) => p.x === 2 && (p.z === 1 || p.z === 2) && p.y >= 64
  const r = coverFrom({ known: (p) => !eastWall(p) })
  assert.notDeepStrictEqual(r.cell, { x: 0, y: 64, z: 1 }, 'cover behind the unknown east wall')
})

test('cover is never a cell holding kelp', () => {
  const r = coverFrom({ kelp: (p) => p.x === 0 && p.y === 64 && p.z === 1 })
  assert.notDeepStrictEqual(r.cell, { x: 0, y: 64, z: 1 }, 'cover in the kelp')
  assert.strictEqual(r.fromEast, false, `the cover ${JSON.stringify(r.cell)} stands in the sightline`)
})

// Stone walls 3 high around the floor from (x0, z0) to (x1, z1), open wherever gap is true.
const walledRoom = (x0, z0, x1, z1, gap = () => false) => plateau({
  solid: (x, y, z) => plateau().solid(x, y, z) || (y >= 64 && y <= 66 && !gap(x, y, z) &&
    (((x === x0 - 1 || x === x1 + 1) && z >= z0 - 1 && z <= z1 + 1) || ((z === z0 - 1 || z === z1 + 1) && x >= x0 - 1 && x <= x1 + 1)))
})
// A window at eye height in the east wall at x 3, too high for a walk through it.
const WINDOW = (x, y, z) => x === 3 && y === 65 && z === 0
// The body stands at (0, 64, 0) inside this room.
const HALL = walledRoom(-12, -7, 2, 7, WINDOW)
const zombieAt = (x) => ({ id: 4, name: 'zombie', position: new Vec3(x, 64, 0.5) })
const HOSTILE = { mobClass: () => 'hostile' }

test('a zombie seen through the window of a closed room is held against, not fled, and a second pass narrates nothing new', () => {
  const said = []
  const r = fleeIn(HALL, zombieAt(4.5), null, { ...HOSTILE, emitEvent: (kind, msg) => said.push(msg) })
  const stand = 'the combat reflex held, no flee, it has no walk to me: zombie E ~4, same level'
  assert.deepStrictEqual([r.held, r.goal, said], ['held', null, [stand]])
  assert.deepStrictEqual(r.logs.filter((l) => l.startsWith('[flee]')), ['[flee] from zombie at (4,64,0): no walk to the body, holding'])
  assert.strictEqual(r.combat.fleeFrom(r.bot, zombieAt(4.5), null, 'emergency'), 'held', 'the next pass')
  assert.deepStrictEqual([r.bot.pathfinder.goal, said], [null, [stand]], 'the next pass')
})

test('a pilot walk goes on while a creeper idles behind the wall within 8', () => {
  const r = fleeIn(HALL, creeper(4.5, 64, 0.5))
  assert.strictEqual(r.held, 'held', 'control: held, no flee')
  const walk = new goals.GoalBlock(-10, 64, 5)
  r.bot.pathfinder.setGoal(walk)
  for (let pass = 1; pass <= 3; pass++) {
    assert.strictEqual(r.combat.fleeFrom(r.bot, creeper(4.5, 64, 0.5), null, 'emergency'), 'held', `pass ${pass}`)
    assert.strictEqual(r.bot.pathfinder.goal, walk, `pass ${pass}`)
  }
  assert.ok(!r.takenBy, `the hold took the legs: ${r.takenBy}`)
})

test('a zombie inside the room is fled', () => {
  const r = fleeIn(HALL, zombieAt(2.5), null, HOSTILE)
  assert.strictEqual(r.held, undefined)
  assert.ok(r.bot.pathfinder.goal instanceof goals.GoalBlock, `no flee goal, ${JSON.stringify(r.logs)}`)
})

test('a skeleton behind the wall that shot the body is fled', () => {
  const skeleton = { id: 5, name: 'skeleton', position: new Vec3(4.5, 64, 0.5) }
  const r = fleeIn(HALL, skeleton, null, { ...HOSTILE, AGGRO_CONFIRMED: new Map([[5, { name: 'skeleton', t: Date.now(), ranged: true }]]) })
  assert.strictEqual(r.held, undefined)
  assert.ok(r.bot.pathfinder.goal instanceof goals.GoalBlock, `no flee goal, ${JSON.stringify(r.logs)}`)
})

// The hostiles within 16 of a body at (0.5, 64, 0.5) in w, every mob perceived and none of them confirmed.
function hostilesIn (w, mobs) {
  const env = {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, entities: Object.fromEntries(mobs.map((m) => [m.id, m])), blockAt: blockAt(w) },
    Vec3,
    ck,
    isDoor,
    routeWithin,
    walkersTo,
    groundCell,
    cellKnown: () => true,
    WALK_MEMO: botConstant('WALK_MEMO'),
    WALK_STEPS: botConstant('WALK_STEPS'),
    WALK_CAP: botConstant('WALK_CAP'),
    CREEPER_DROP,
    RANGED: botConstant('RANGED'),
    mobClass: (e) => e.name === 'creeper' ? 'creeper' : 'hostile',
    shared: { mcData: MC_DATA },
    AGGRO_CONFIRMED: new Map(),
    staleEntities: new Set(),
    entityPerceptible: () => true,
    entityEngageable: () => true
  }
  return loadBotFunctions(['nearHostiles'], env).nearHostiles({}, 16, new Map())
}
const mob = (id, name, x, z) => ({ id, name, position: new Vec3(x, 64, z) })

test('zombies behind the wall make no pack with the one inside the room, so no outnumbered flee', async () => {
  const inside = [mob(1, 'zombie', -3.5, 0.5), mob(2, 'zombie', -3.5, 3.5), mob(3, 'zombie', -3.5, -2.5)]
  const all = hostilesIn(HALL, inside)
  assert.strictEqual(all.length, 3, 'control: three inside')
  assert.strictEqual((await meleePass({ pack: all })).fled.length, 1, 'control: three inside make a withdrawal')
  const walled = hostilesIn(HALL, [inside[0], mob(2, 'zombie', 5.5, 3.5), mob(3, 'zombie', 5.5, -2.5)])
  assert.deepStrictEqual(Array.from(walled, (h) => h.e.id), [1])
  assert.deepStrictEqual((await meleePass({ pack: walled })).fled, [])
})

test('a swelling creeper behind the wall with no walk is a near hostile, the same creeper not swelling is not', () => {
  const metadata = []
  metadata[MC_DATA.entitiesByName.creeper.metadataKeys.indexOf('swell_dir')] = 1
  const behind = creeper(5.5, 64, 0.5)
  assert.deepStrictEqual(Array.from(hostilesIn(HALL, [{ ...behind, metadata }]), (h) => h.e.id), [behind.id])
  assert.deepStrictEqual(Array.from(hostilesIn(HALL, [behind]), (h) => h.e.id), [], 'control: not swelling')
})

test('skeletons in sight through a slit window make a pack of 3 with the zombie inside, and the withdrawal stays inside the room', async () => {
  // A slit at eye height along the east wall, too high for a walk through it.
  const slit = walledRoom(-12, -7, 2, 7, (x, y, z) => x === 3 && y === 65 && Math.abs(z) <= 3)
  const zombie = mob(1, 'zombie', 2.5, 0.5)
  const pack = hostilesIn(slit, [zombie, mob(2, 'skeleton', 6.5, 2.5), mob(3, 'skeleton', 6.5, -1.5)])
  assert.deepStrictEqual(Array.from(pack, (h) => h.e.id), [1, 2, 3])
  const { fled } = await meleePass({ pack })
  assert.strictEqual(fled.length, 1)
  assert.match(fled[0], /^OUTNUMBERED 3 /)
  const others = pack.filter((h) => h.e.id !== zombie.id)
  const r = fleeIn(slit, zombie, null, { ...HOSTILE, nearHostiles: () => others })
  assert.ok(r.goal, `no flee goal, ${JSON.stringify(r.logs)}`)
  assert.ok(r.goal.x >= -12 && r.goal.x <= 2 && Math.abs(r.goal.z) <= 7, `the flee left the room for ${JSON.stringify(r.goal)}`)
})

test('a withdrawal from a mob at a slit window flees while two zombies inside the room walk to the body', () => {
  const slit = walledRoom(-12, -7, 2, 7, (x, y, z) => x === 3 && y === 65 && Math.abs(z) <= 3)
  const inside = hostilesIn(slit, [mob(3, 'zombie', 0.5, 5.5), mob(4, 'zombie', 0.5, -4.5)])
  assert.strictEqual(inside.length, 2, 'control: both zombies walk to the body')
  for (const name of ['skeleton', 'zombie']) {
    const r = fleeIn(slit, mob(2, name, 6.5, 0.5), null, { ...HOSTILE, nearHostiles: () => inside })
    assert.strictEqual(r.held, undefined, `${name}: ${JSON.stringify(r.logs)}`)
    assert.ok(r.bot.pathfinder.goal instanceof goals.GoalBlock, `${name}: no flee goal, ${JSON.stringify(r.logs)}`)
  }
})

test('a low-HP disengage from a skeleton at the window that never hit the body flees with nothing else around', () => {
  const r = fleeIn(HALL, mob(5, 'skeleton', 6.5, 0.5), null, HOSTILE)
  assert.strictEqual(r.held, undefined, JSON.stringify(r.logs))
  assert.ok(r.bot.pathfinder.goal instanceof goals.GoalBlock, `no flee goal, ${JSON.stringify(r.logs)}`)
})

test('a zombie at the window is fled while a swelling creeper with no walk is near', () => {
  // nearHostiles keeps a swelling creeper whatever its walk.
  const swelling = mob(9, 'creeper', 5.5, 3.5)
  const r = fleeIn(HALL, zombieAt(4.5), null, { ...HOSTILE, nearHostiles: () => [{ e: swelling, at: swelling.position }] })
  assert.strictEqual(r.held, undefined, JSON.stringify(r.logs))
  assert.ok(r.bot.pathfinder.goal instanceof goals.GoalBlock, `no flee goal, ${JSON.stringify(r.logs)}`)
})

test('a skeleton behind a wall the body never saw is in sight, behind a seen wall it is not', () => {
  const pillar = plateau({ solid: (x, y, z) => plateau().solid(x, y, z) || (x === 3 && z === 0 && y >= 64 && y <= 66) })
  const inSight = (wallSeen) => loadBotFunctions(['rangedInSight'], {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: blockAt(pillar) },
    Vec3,
    ck,
    isDoor,
    RANGED: botConstant('RANGED'),
    cellKnown: (p) => wallSeen || p.x !== 3
  }).rangedInSight({ name: 'skeleton' }, new Vec3(6.5, 64, 0.5))
  assert.deepStrictEqual({ unseen: inSight(false), seen: inSight(true) }, { unseen: true, seen: false })
})

test('a creeper 2 outside the wall with a walk of 15 through the door is fled within a flee distance of 16, held within 8', () => {
  const doored = walledRoom(-12, -7, 2, 7, (x, y, z) => WINDOW(x, y, z) || (x === 3 && z === 6 && y <= 65))
  const flee = (stance, fleeDist) => fleeIn(doored, creeper(5.5, 64, 0.5), null, { fight: { stance }, STANCES: { [stance]: { fleeDist } } })
  const guard = flee('guard', 16)
  assert.strictEqual(guard.held, undefined, 'guard')
  assert.ok(guard.bot.pathfinder.goal instanceof goals.GoalBlock, `guard: no flee goal, ${JSON.stringify(guard.logs)}`)
  const skirmish = flee('skirmish', 8)
  assert.deepStrictEqual([skirmish.held, skirmish.goal], ['held', null], 'skirmish')
})

test('a creeper within the flee distance over ground the body has not seen is fled, not held', () => {
  const dark = plateau({ unknown: (x, y, z) => y === 63 && x >= 1 && x <= 10 })
  const r = fleeIn(dark, creeper(10.5, 64, 0.5))
  assert.strictEqual(r.held, undefined, JSON.stringify(r.logs))
  assert.ok(r.bot.pathfinder.goal instanceof goals.GoalBlock, `no flee goal, ${JSON.stringify(r.logs)}`)
})

test('cover from a skeleton shooting through a window stays inside the room, never in a hidden cell beyond its wall', () => {
  // A window runs the length of the east wall at eye height, and a stone post 2 high stands at (2, 2).
  const room = walledRoom(0, -2, 2, 2, (x, y, z) => x === 3 && y === 65 && Math.abs(z) <= 2)
  const w = plateau({ solid: (x, y, z) => room.solid(x, y, z) || (x === 2 && z === 2 && y >= 64 && y <= 65) })
  const skeleton = { id: 5, name: 'skeleton', position: new Vec3(6.5, 64, 0.5) }
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 5: skeleton },
    blockAt: blockAt(w),
    pathfinder: { goal: null, setGoal (g) { this.goal = g } }
  }
  const env = {
    bot,
    Vec3,
    goals,
    ck,
    isDoor,
    walkFlood,
    airFlood: () => ({}),
    knownCell: () => true,
    cellKnown: () => true,
    entityPerceptible: () => true,
    laneBlocks: () => false,
    laneNarrate () {},
    takeLegs () {},
    stopPath () {},
    emitEvent () {}
  }
  loadBotFunctions(['compass', 'losClear', 'threatWhy', 'fleeWorld'], env)
  const eye =skeleton.position.offset(0, 1.62, 0)
  assert.strictEqual(env.losClear(eye, new Vec3(-1.5, 65.62, 0.5)), false, 'control: the cell 2 west, beyond the wall, is hidden')
  combatReflexIn(env).takeCover(bot, skeleton, 'skeleton E ~6')
  const g = bot.pathfinder.goal
  assert.deepStrictEqual(g && { x: g.x, y: g.y, z: g.z }, { x: 1, y: 64, z: 2 })
})

// A real 1.21.11 block: cell(x, y, z) as [name, properties], stone below y 64 and air above where it gives null.
const realBlockAt = (cell) => (p) => {
  const [name, props] = cell(p.x, p.y, p.z) || [p.y < 64 ? 'stone' : 'air', {}]
  return Object.assign(Block.fromProperties(name, props, 0), { position: p })
}

function walkCheck (cell, body) {
  const env = {
    bot: { entity: { position: body }, blockAt: realBlockAt(cell) },
    Vec3,
    ck,
    isDoor,
    walkersTo,
    groundCell,
    cellKnown: () => true,
    WALK_MEMO: botConstant('WALK_MEMO'),
    WALK_STEPS: botConstant('WALK_STEPS'),
    WALK_CAP: botConstant('WALK_CAP')
  }
  const { walksToBody, walkBudget } = loadBotFunctions(['walksToBody', 'walkBudget'], env)
  return (at, drop = 3) => walksToBody(at, { steps: walkBudget(at), drop })
}

const CREEPER_DROP = botConstant('CREEPER_DROP')

test('a zombie on the bed of a moat three deep walks to the body', () => {
  // Water from y 61 to 63 in the column x 3, stone banks up to y 63 on either side.
  const moat = (x, y) => (x === 3 && y >= 61 && y <= 63 ? ['water', { level: 0 }] : null)
  const walks = walkCheck(moat, new Vec3(0.5, 64, 0.5))
  const zombie = new Vec3(3.5, 61, 0.5)
  assert.deepStrictEqual([walks(zombie, 3), walks(zombie, CREEPER_DROP)], [true, true])
})

test('every hostile walks to a body swimming in deep water, at any depth', () => {
  // A pool 7 wide, water from y 60 to 63.
  const pool = (x, y, z) => (Math.abs(x) <= 3 && Math.abs(z) <= 3 && y >= 60 && y <= 63 ? ['water', { level: 0 }] : null)
  const zombie = new Vec3(6.5, 64, 0.5)
  for (const y of [62.4, 61.4, 60.4]) {
    const walks = walkCheck(pool, new Vec3(0.5, y, 0.5))
    assert.deepStrictEqual([walks(zombie, 3), walks(zombie, CREEPER_DROP)], [true, true], `the body's feet at y ${y}`)
  }
})

test('a mob walking along the shore of a deep ocean walks to the body anywhere within the walk budget', () => {
  // Land for x below 3, water 25 deep beyond it.
  const ocean = (x, y) => (x >= 3 && y >= 39 && y <= 63 ? ['water', { level: 0 }] : null)
  const walks = walkCheck(ocean, new Vec3(0.5, 64, 0.5))
  for (const z of [28, 29, 40]) assert.strictEqual(walks(new Vec3(2.5, 64, z + 0.5), CREEPER_DROP), true, `${z} along the shore`)
})

test('a zombie on carpet under a ceiling 2 high walks to the body', () => {
  // Carpet on the floor at y 64, a stone ceiling at y 66.
  const hall = (x, y) => (y === 64 ? ['white_carpet', {}] : y === 66 ? ['stone', {}] : null)
  const walks = walkCheck(hall, new Vec3(0.5, 64.0625, 0.5))
  assert.strictEqual(walks(new Vec3(3.5, 64.0625, 0.5)), true)
})

test('a zombie walks to a body in the air above its floor', () => {
  const zombie = new Vec3(3.5, 64, 0.5)
  for (const y of [66.5, 74.5]) assert.strictEqual(walkCheck(() => null, new Vec3(0.5, y, 0.5))(zombie), true, `the body at y ${y}`)
})

test('a mob outside a closed room has no walk to the body inside it, airborne or on carpet', () => {
  // Stone walls 3 high round the floor from (-2, -2) to (2, 2), carpet inside, and a door at (3, 0) when door is set.
  const room = (door) => (x, y, z) => {
    if (y < 64 || y > 66 || Math.abs(x) > 3 || Math.abs(z) > 3) return null
    if (door && x === 3 && z === 0 && y <= 65) return ['oak_door', { half: y === 64 ? 'lower' : 'upper', open: door === 'open', facing: 'east', hinge: 'left' }]
    if (Math.abs(x) === 3 || Math.abs(z) === 3) return ['stone', {}]
    return y === 64 ? ['white_carpet', {}] : null
  }
  for (const [label, at] of [['zombie', new Vec3(5.5, 64, 0.5)], ['skeleton', new Vec3(0.5, 64, 5.5)]]) {
    for (const body of [new Vec3(0.5, 64.0625, 0.5), new Vec3(0.5, 67, 0.5)]) {
      assert.strictEqual(walkCheck(room('open'), body)(new Vec3(5.5, 64, 0.5)), true, `control: through the open door, the body at y ${body.y}`)
      assert.strictEqual(walkCheck(room(null), body)(at, CREEPER_DROP), false, `a ${label}, the body at y ${body.y}`)
      assert.strictEqual(walkCheck(room('closed'), body)(at, CREEPER_DROP), false, `a ${label} past the closed door, the body at y ${body.y}`)
    }
  }
})

test('a zombie in a water hole outside a sealed room has no walk to the body inside it', () => {
  // A 1-deep water hole at (5, 63, 0) and, with walls, stone walls 3 high round the floor from (-2, -2) to (2, 2).
  const field = (walls) => (x, y, z) => {
    if (x === 5 && y === 63 && z === 0) return ['water', { level: 0 }]
    return walls && y >= 64 && y <= 66 && Math.max(Math.abs(x), Math.abs(z)) === 3 ? ['stone', {}] : null
  }
  const zombie = new Vec3(5.5, 63, 0.5)
  assert.strictEqual(walkCheck(field(false), new Vec3(0.5, 64, 0.5))(zombie), true, 'control: no walls')
  assert.strictEqual(walkCheck(field(true), new Vec3(0.5, 64, 0.5))(zombie, CREEPER_DROP), false)
})

test('a door that opens gives the mob behind it and the body walks on the next check, with no clock advance', () => {
  // Stone walls 3 high round the floor from (-2, -2) to (2, 2), an oak door at (3, 0) shut until opened.
  let opened = false
  const door = (y) => ['oak_door', { half: y === 64 ? 'lower' : 'upper', open: opened, facing: 'east', hinge: 'left' }]
  const cell = (x, y, z) => {
    if (y < 64 || y > 66 || Math.max(Math.abs(x), Math.abs(z)) !== 3) return null
    return x === 3 && z === 0 && y <= 65 ? door(y) : ['stone', {}]
  }
  const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: realBlockAt(cell) })
  const env = {
    bot,
    Vec3,
    ck,
    isDoor,
    walkersTo,
    walkFlood,
    groundCell,
    cellKnown: () => true,
    knownCell: () => true,
    Date: { now: () => 5000 },
    reflexes: [{ name: 'combat', _fill: null }],
    touchesFill: () => false,
    WALK_MEMO: botConstant('WALK_MEMO'),
    REACH_MEMO: botConstant('REACH_MEMO'),
    WALK_STEPS: botConstant('WALK_STEPS'),
    WALK_CAP: botConstant('WALK_CAP')
  }
  const { walksToBody, bodyWalksTo, walkBudget, wireFloodDrops } = loadBotFunctions(['walksToBody', 'bodyWalksTo', 'walkBudget', 'wireFloodDrops'], env)
  wireFloodDrops()
  const zombie = new Vec3(5.5, 64, 0.5)
  const walks = () => ({ mob: walksToBody(zombie, { steps: walkBudget(zombie), drop: 3 }), body: bodyWalksTo(zombie, walkBudget(zombie)) })
  assert.deepStrictEqual(walks(), { mob: false, body: false }, 'control: the door shut')
  const shut = bot.blockAt(new Vec3(3, 64, 0))
  opened = true
  bot.emit('blockUpdate', shut, bot.blockAt(new Vec3(3, 64, 0)))
  assert.deepStrictEqual(walks(), { mob: true, body: true })
})

test('cover from a skeleton lies through an open door', () => {
  // Stone walls 3 high round the body's cell at (0, 64, 0), an open door in the west wall.
  const cell = (x, y, z) => {
    if (y < 64 || y > 66 || Math.abs(x) > 1 || Math.abs(z) > 1 || (x === 0 && z === 0)) return null
    if (x === -1 && z === 0 && y <= 65) return ['oak_door', { half: y === 64 ? 'lower' : 'upper', open: true, facing: 'west', hinge: 'left' }]
    return ['stone', {}]
  }
  const skeleton = { id: 5, name: 'skeleton', position: new Vec3(6.5, 64, 0.5) }
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 5: skeleton },
    blockAt: realBlockAt(cell),
    pathfinder: { goal: null, setGoal (g) { this.goal = g } }
  }
  const env = {
    bot,
    Vec3,
    goals,
    ck,
    isDoor,
    walkFlood,
    airFlood: () => ({}),
    knownCell: () => true,
    cellKnown: () => true,
    entityPerceptible: () => true,
    laneBlocks: () => false,
    laneNarrate () {},
    takeLegs () {},
    stopPath () {},
    emitEvent () {}
  }
  loadBotFunctions(['compass', 'losClear', 'threatWhy', 'fleeWorld'], env)
  const combat = combatReflexIn(env)
  combat.fleeFrom = () => {}
  combat.takeCover(bot, skeleton, 'skeleton E ~6')
  const g = bot.pathfinder.goal
  assert.deepStrictEqual(g && { x: g.x, y: g.y, z: g.z }, { x: -2, y: 64, z: 0 })
})
