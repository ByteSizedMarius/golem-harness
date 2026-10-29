'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { routeWithin, walkersTo, planFlee, creeperCover, walkFlood, groundCell } = require('../lib/flee')
const { mobFamily, expireConfirmed } = require('../lib/shelter')
const { isDoor } = require('../lib/doors')
const { takenText } = require('../lib/leg-ledger')
const rules = require('../lib/combat-rules')
const legacy1710 = require('../lib/bot/legacy-1710')
const { loadBotFunctions, fakeClock, combatReflexIn, botConstant, botObject, laneAt, routeHandler, runRoute } = require('./helpers')
const Block = require('prismarine-block')(require('prismarine-registry')('1.21.11'))

const ck = (x, y, z) => x + ',' + y + ',' + z
const version = (legacy) => (legacy ? '1.7.10' : '1.21.11')
const HERE = new Vec3(0.5, 64, 0.5)
const FULL = [[0, 0, 0, 1, 1, 1]]
const FENCE = [[0, 0, 0.375, 1, 1.5, 0.625]]

// Ground at y 63 everywhere. extra(p) names the block placed at p: 'stone', 'fence' or nothing.
function blockAt (extra) {
  return (p) => {
    const kind = p.y < 64 ? 'stone' : extra(p)
    return { name: kind === 'fence' ? 'oak_fence' : kind || 'air', boundingBox: kind ? 'block' : 'empty', shapes: kind === 'fence' ? FENCE : kind ? FULL : [], position: p }
  }
}
const ring = (kind, height) => (p) => Math.max(Math.abs(p.x), Math.abs(p.z)) === 4 && p.y >= 64 && p.y < 64 + height ? kind : null
const open = () => null
const guardFight = (over) => ({ stance: 'guard', lastHit: { dmg: 0, t: 0 }, lastAttackT: 0, ...over })

// The sword-block raises and lowerings, the swings, the flee classes and the [combat] guard lines of three 1.7.10
// fight cycles against mob, which closed 1 block in the last second and stands out of melee reach. The body
// carries only a sword. over.bot and over.env replace entries of the bot and the env, and an undefined env entry
// loads the bot.js function of that name. over.guard replaces entries of the guard state. over.seenAt is where the
// body last perceived mob. over.cycle(combat, env) runs as each wait of the act starts, over.next(combat, bot) after the act.
// With over.flee the real fleeFrom runs after each class is recorded.
async function standoff (extra, mob, over = {}) {
  const fight = standoffFight(extra, mob, over)
  await fight.combat.act(fight.bot)
  if (over.next) await over.next(fight.combat, fight.bot)
  return fight.result()
}

// The body, env and combat reflex of standoff before the act runs.
function standoffFight (extra, mob, over = {}) {
  const lines = []
  const fled = []
  let raises = 0
  let lowers = 0
  let swings = 0
  let cycles = 0
  const sword = { name: 'iron_sword' }
  const bot = {
    entity: { position: HERE, onGround: true },
    entities: { [mob.id]: mob },
    health: 20,
    food: 20,
    inventory: { items: () => [sword], slots: [] },
    heldItem: sword,
    quickBarSlot: 0,
    pathfinder: { goal: null, isMoving: () => false, setGoal (g) { this.goal = g } },
    blockAt: blockAt(extra),
    lookAt: async () => {},
    waitForTicks: async () => {},
    setControlState () {},
    attack () { swings++ },
    activateItem () { raises++ },
    deactivateItem () { lowers++ },
    controlState: {},
    ...over.bot
  }
  const dist = mob.position.distanceTo(bot.entity.position)
  const env = {
    bot,
    Vec3,
    goals,
    ck,
    routeWithin,
    walkersTo,
    groundCell,
    walkFlood,
    mobFamily,
    console: { log: (line) => lines.push(line) },
    STANCES: { guard: { fleeDist: 16, bowBand: [7, 24], chase: false, engage: 'closers' } },
    fight: guardFight(),
    LEGACY_1710: true,
    MOVES: botConstant('MOVES'),
    LEGACY_HIT_MS: botConstant('LEGACY_HIT_MS'),
    mobHurt: { wait: () => 0 },
    noCritReason: rules.noCritReason,
    JUMP_FALL_TICKS: rules.JUMP_FALL_TICKS,
    JUMP_TICKS: rules.JUMP_TICKS,
    AGGRO_CONFIRMED: new Map(),
    bunker: { building: false },
    shared: { mcData: null },
    HITBOX_1710: legacy1710.HITBOX_1710,
    GUARD_REACH: botConstant('GUARD_REACH'),
    GUARD_STEPS: botConstant('GUARD_STEPS'),
    CREEPER_DROP: botConstant('CREEPER_DROP'),
    SWING_REACH: rules.SWING_REACH,
    WALK_MEMO: botConstant('WALK_MEMO'),
    REACH_MEMO: botConstant('REACH_MEMO'),
    WALK_STEPS: botConstant('WALK_STEPS'),
    WALK_CAP: botConstant('WALK_CAP'),
    RANGED: botConstant('RANGED'),
    isDoor,
    cellKnown: () => true,
    knownCell: () => true,
    headFree: () => true,
    compass: () => 'E',
    emitEvent () {},
    mobClass: () => 'hostile',
    airFlood: () => ({}),
    entityPerceptible: () => true,
    nearHostiles: () => [],
    inMeleeReach: () => false,
    disengageHp: () => 8,
    yieldJob () {},
    takeLegs () {},
    threatWhy: (what) => what,
    laneBlocks: () => false,
    laneNarrate () {},
    drawAndLoose: async () => false,
    perch: { cell: null },
    perchStrike: () => false,
    holdRun: { on: false },
    strikeRun: { lane: null },
    setTimeout: (fn) => {
      if (over.cycle) over.cycle(combat, env)
      if (++cycles === 3) delete bot.entities[mob.id]
      setImmediate(fn)
    }
  }
  for (const [k, v] of Object.entries(over.env || {})) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  env.guardState = Object.assign(botObject('guardState', env), over.guard)
  const load = Object.entries(over.env || {}).filter(([, v]) => v === undefined).map(([k]) => k)
  loadBotFunctions(['standoffGuard', 'fleeWorld', 'creeperRoute', 'walksToBody', 'bodyWalksTo', 'walkBudget', 'rangedInSight', 'meleeSwing', 'chargedSwing', 'legsMoving', ...load], env)
  const combat = combatReflexIn(env)
  const flee = combat.fleeFrom
  combat.fleeFrom = (b, e, why, klass) => {
    fled.push(klass)
    if (over.flee) return flee.call(combat, b, e, why, klass)
  }
  combat._hist.set(mob.id, { d: dist + 1, t: Date.now() - 1000, closes: 3, logT: 0 })
  combat._threat = { e: mob, cls: 'hostile', dist, confirmed: env.AGGRO_CONFIRMED.has(mob.id) }
  if (over.seenAt) combat._seenAt.set(mob.id, over.seenAt)
  const result = () => ({ raises, lowers, swings, fled, lines: lines.filter((l) => l.startsWith('[combat] guard')) })
  return { bot, env, combat, result }
}

const zombie = (x) => ({ id: 7, name: 'zombie', width: 0.6, height: 1.95, position: new Vec3(x, 64, 0.5) })
const IN_REACH = { inMeleeReach: () => true }
// The bot.js melee reach rule in place of the stub.
const REACH_RULE = { inMeleeReach: undefined, SWING_REACH: rules.SWING_REACH }
const skeleton = (x) => ({ id: 8, name: 'skeleton', position: new Vec3(x, 64, 0.5) })

// A 2-high wall around the floor from (x0, z0) to (x1, z1), with door.kind at the door cell.
const room = (x0, z0, x1, z1, door = null) => (p) => {
  if (p.y > 65 || p.x < x0 - 1 || p.x > x1 + 1 || p.z < z0 - 1 || p.z > z1 + 1) return null
  if (door && p.x === door.x && p.z === door.z) return door.kind
  return p.x === x0 - 1 || p.x === x1 + 1 || p.z === z0 - 1 || p.z === z1 + 1 ? 'stone' : null
}

// A door's upper half reads closed, as a 1.7.10 server sends it.
function roomBlockAt (blocks) {
  const plain = blockAt((p) => (blocks(p) === 'stone' ? 'stone' : null))
  return (p) => {
    const kind = p.y >= 64 && blocks(p)
    if (kind !== 'door' && kind !== 'open door') return plain(p)
    const half = p.y === 65 ? 'upper' : 'lower'
    return { name: 'oak_door', boundingBox: 'block', position: p, getProperties: () => ({ half, open: half === 'lower' && kind === 'open door' }) }
  }
}

test('a closing zombie raises the 1.7.10 sword block only when it can walk to the body over seen cells', async () => {
  const inside = await standoff(ring('stone', 3), zombie(3.5))
  assert.ok(inside.raises > 0, 'control: a zombie in the same room')
  assert.match(inside.lines[0], /^\[combat\] guard up vs zombie ~3: closing\b/)
  assert.match(inside.lines[inside.lines.length - 1], /^\[combat\] guard down vs zombie\b/)
  for (const [wall, extra] of [['a closed stone wall', ring('stone', 3)], ['a fence', ring('fence', 1)]]) {
    const outside = await standoff(extra, zombie(5.5))
    assert.strictEqual(outside.raises, 0, `a zombie behind ${wall} raised the guard`)
    assert.deepStrictEqual(outside.lines, [], `a zombie behind ${wall}`)
  }
})

test('a skeleton raises the 1.7.10 sword block only in line of sight within 15, and holds it steady with no bow', async () => {
  const seen = await standoff(open, skeleton(10.5))
  assert.deepStrictEqual({ raises: seen.raises, lowers: seen.lowers }, { raises: 1, lowers: 1 }, 'a skeleton in sight 10 off over three cycles')
  assert.match(seen.lines[0], /^\[combat\] guard up vs skeleton ~10: a skeleton in sight within 15$/)
  const wall = (p) => p.x === 5 && p.y >= 64 && p.y < 67 ? 'stone' : null
  assert.strictEqual((await standoff(wall, skeleton(10.5))).raises, 0, 'a skeleton behind a wall')
  assert.strictEqual((await standoff(open, skeleton(20.5))).raises, 0, 'a skeleton 20 off')
})

test('the 1.7.10 sword block the standoff raised holds through an update of the held sword and ends for another sword', async () => {
  let changed
  const up = []
  await standoff(open, skeleton(10.5), {
    bot: { on: (event, fn) => { if (event === 'heldItemChanged') changed = fn } },
    env: { wireGuardDrop: undefined },
    cycle: (combat, env) => {
      if (!env.guardState.up || up.length) return
      env.wireGuardDrop()
      changed({ name: 'iron_sword' })
      up.push(env.guardState.up)
      changed({ name: 'stone_sword' })
      up.push(env.guardState.up)
    }
  })
  assert.deepStrictEqual(up, [true, false], 'the block after an update of the iron_sword, then after a stone_sword in its slot')
})

test('a body on a walk raises no 1.21.11 shield or 1.7.10 sword block against a skeleton in sight', async () => {
  const shield = (controlState) => standoff(open, skeleton(10.5), {
    bot: { controlState, inventory: { items: () => [{ name: 'iron_sword' }], slots: { 45: { name: 'shield' } } } },
    env: { LEGACY_1710: false }
  })
  assert.ok((await shield({})).raises > 0, 'control: a 1.21.11 body standing still')
  assert.strictEqual((await shield({ forward: true })).raises, 0, '1.21.11 shield')
  const sword = await standoff(open, skeleton(10.5), { bot: { controlState: { forward: true } } })
  assert.strictEqual(sword.raises, 0, '1.7.10 sword block')
})

test('a zombie in melee reach raises the 1.7.10 sword block only in sight or with a walk to the body', async () => {
  assert.ok((await standoff(open, zombie(3.5), { env: IN_REACH })).raises > 0, 'control: a zombie in sight 3 off')
  const wall = (p) => p.x === 2 && p.y >= 64 && p.y < 67 ? 'stone' : null
  assert.strictEqual((await standoff(wall, zombie(3.5), { env: IN_REACH })).raises, 0, 'a zombie behind a wall 3 off')
})

test('a zombie in melee reach out of sight holds the 1.7.10 sword block by where the body last saw it', async () => {
  const wall = (p) => p.x === 2 && p.y >= 64 && p.y < 67 ? 'stone' : null
  const env = { ...IN_REACH, entityPerceptible: () => false }
  const beside = await standoff(wall, zombie(3.5), { env, seenAt: new Vec3(-1.5, 64, 0.5) })
  assert.ok(beside.raises > 0, 'last seen on the body side of the wall, now behind it')
  const behind = await standoff(wall, zombie(-1.5), { env, seenAt: new Vec3(3.5, 64, 0.5) })
  assert.strictEqual(behind.raises, 0, 'last seen behind the wall, now on the body side')
  assert.strictEqual((await standoff(open, zombie(-1.5), { env })).raises, 0, 'never seen')
})

test('the standoff looks at a zombie out of sight only where the body last saw it', async () => {
  const looks = []
  const bot = { lookAt: async (p) => { looks.push(p.x) } }
  const env = { entityPerceptible: () => false }
  await standoff(open, zombie(5.5), { bot, env })
  assert.deepStrictEqual(looks, [], 'a look at a zombie never seen')
  await standoff(open, zombie(5.5), { bot, env, seenAt: new Vec3(-4.5, 64, 0.5) })
  assert.ok(looks.length > 0 && looks.every((x) => x === -4.5), `looks at x ${looks}`)
})

test('the bow never draws on a zombie out of sight', async () => {
  const items = [{ name: 'iron_sword' }, { name: 'bow' }, { name: 'arrow' }]
  const run = (seen) => standoff(open, zombie(8.5), {
    bot: { inventory: { items: () => items, slots: [] } },
    env: { drawAndLoose: undefined, entityPerceptible: () => seen },
    guard: { up: true, slot: 0, pilot: true },
    seenAt: new Vec3(8.5, 64, 0.5)
  })
  assert.ok((await run(true)).lowers > 0, 'control: the block comes down for the bow in sight')
  assert.strictEqual((await run(false)).lowers, 0)
})

test('a bow with no line of sight to its target leaves the 1.7.10 sword block up', async () => {
  const items = [{ name: 'iron_sword' }, { name: 'bow' }, { name: 'arrow' }]
  const raised = { up: true, slot: 0, pilot: true }
  const wall = (p) => p.x === 5 && p.y >= 64 && p.y < 67 ? 'stone' : null
  const run = (extra) => standoff(extra, zombie(8.5), {
    bot: { inventory: { items: () => items, slots: [] } },
    env: { drawAndLoose: undefined },
    guard: raised
  })
  assert.ok((await run(open)).lowers > 0, 'control: a clear line lowers the block for the bow')
  assert.deepStrictEqual(await run(wall), { raises: 0, lowers: 0, swings: 0, fled: [], lines: [] })
})

test('a body 2 above a zombie strikes it at disengage health and never flees', async () => {
  const perch = { perch: { cell: null }, perchStrike: undefined, ...REACH_RULE, PERCH_MELEE: botConstant('PERCH_MELEE'), PERCH_DROP: botConstant('PERCH_DROP') }
  const ground = await standoff(open, zombie(2.5), { bot: { health: 6 }, env: perch })
  assert.deepStrictEqual({ swings: ground.swings, fled: ground.fled }, { swings: 0, fled: ['emergency'] }, 'control: on the ground it flees')
  const pillar = (p) => p.x === 0 && p.z === 0 && p.y < 66 ? 'stone' : null
  const top = { entity: { position: new Vec3(0.5, 66, 0.5), onGround: true }, health: 6 }
  const r = await standoff(pillar, zombie(1.5), { bot: top, env: perch })
  assert.ok(r.swings > 0, 'no swing from the pillar top')
  assert.deepStrictEqual(r.fled, [])
})

test('a body on its pillar top at disengage health strikes a zombie out of sight only where it last saw it below', async () => {
  const perch = { perch: { cell: null }, perchStrike: undefined, ...REACH_RULE, PERCH_MELEE: botConstant('PERCH_MELEE'), PERCH_DROP: botConstant('PERCH_DROP'), entityPerceptible: () => false }
  const pillar = (p) => p.x === 0 && p.z === 0 && p.y < 66 ? 'stone' : null
  const top = () => ({ entity: { position: new Vec3(0.5, 66, 0.5), onGround: true }, health: 6 })
  const never = await standoff(pillar, zombie(1.5), { bot: top(), env: perch })
  assert.deepStrictEqual(never.fled, ['emergency'], 'a zombie never seen')
  const below = await standoff(pillar, zombie(1.5), { bot: top(), env: perch, seenAt: new Vec3(1.5, 64, 0.5) })
  assert.deepStrictEqual(below.fled, [], 'control: last seen below the pillar')
})

test('a 1.7.10 body on its pillar top over a pack of three swings without a jump and keeps the perch', async () => {
  const cell = new Vec3(0, 66, 0)
  const perch = { cell }
  const pack = [zombie(1.5), { ...zombie(-0.5), id: 8 }, { ...zombie(2.5), id: 9 }]
  // A 1.7.10 jump off the pillar top at y 66.
  const entity = { position: new Vec3(0.5, 66, 0.5), onGround: true }
  let vy = 0
  let jumps = 0
  const top = {
    entity,
    health: 20,
    setControlState (c, s) {
      if (c !== 'jump' || !s || !entity.onGround) return
      jumps++
      vy = 0.42
      entity.onGround = false
    },
    waitForTicks: async (n) => {
      for (let i = 0; i < n && !entity.onGround; i++) {
        const y = Math.max(66, entity.position.y + vy)
        vy = (vy - 0.08) * 0.98
        entity.position = new Vec3(0.5, y, 0.5)
        entity.onGround = y === 66
      }
    }
  }
  const pillar = (p) => p.x === 0 && p.z === 0 && p.y < 66 ? 'stone' : null
  const env = { perch, perchStrike: undefined, ...IN_REACH, PERCH_MELEE: botConstant('PERCH_MELEE'), PERCH_DROP: botConstant('PERCH_DROP'), nearHostiles: () => pack.map((e) => ({ e, at: e.position })), liveEntities: () => [] }
  const r = await standoff(pillar, pack[0], { bot: top, env })
  assert.ok(r.swings > 0, 'no swing from the pillar top')
  assert.deepStrictEqual({ fled: r.fled, jumps, cell: perch.cell }, { fled: [], jumps: 0, cell })
})

// The bow draws and flee count of a bow-carrying body at entity in lane against a skeleton 10 out and two zombies.
async function skeletonPack (extra, entity, lane) {
  const draws = []
  const sk = skeleton(10.5)
  const pack = [sk, { ...zombie(-2.5), id: 9 }, { ...zombie(-3.5), id: 10 }]
  const items = [{ name: 'iron_sword' }, { name: 'bow' }, { name: 'arrow' }]
  const r = await standoff(extra, sk, {
    bot: { entity, inventory: { items: () => items, slots: [] } },
    env: {
      nearHostiles: () => pack.map((e) => ({ e, at: e.position })),
      liveEntities: () => [],
      bowLine: () => true,
      drawAndLoose: async (e) => { draws.push(e.name); return false },
      perch: lane.perch,
      perchHolds: lane.perchHolds,
      laneBlocks: lane.laneBlocks,
      laneNarrate: lane.laneNarrate
    },
    flee: true
  })
  return { draws, flees: r.fled.length }
}

test('a body on its pillar top shoots a skeleton when the pack of three it cannot flee holds it there', async () => {
  const entity = { position: new Vec3(0.5, 66, 0.5), onGround: true }
  const lane = laneAt(entity, null)
  const cell = new Vec3(0, 66, 0)
  lane.perch.cell = cell
  const pillar = (p) => p.x === 0 && p.z === 0 && p.y < 66 ? 'stone' : null
  const r = await skeletonPack(pillar, entity, lane)
  assert.ok(r.draws.length > 0 && r.flees > 0, `no bow draw from the pillar top, ${JSON.stringify(r)}`)
  assert.ok(r.draws.every((name) => name === 'skeleton'), JSON.stringify(r))
  assert.strictEqual(lane.perch.cell, cell)
})

test('a body on the ground with a job running ends the fight at the pack flee the job holds back and draws no bow', async () => {
  const entity = { position: HERE, onGround: true }
  const r = await skeletonPack(open, entity, laneAt(entity, null, true))
  assert.deepStrictEqual(r, { draws: [], flees: 1 })
})

test('the combat reflex swings at a zombie only once its look ray meets the hitbox within 3 of the eye', async () => {
  // The look ray from the eye at 65.62 to 1.2 above the zombie's feet meets the box 2.5 and 3.6 out.
  const near = await standoff(open, zombie(3.37), { env: REACH_RULE })
  assert.ok(near.swings > 0, 'control: no swing at a hitbox 2.5 from the eye')
  const far = await standoff(open, zombie(4.48), { env: REACH_RULE })
  assert.strictEqual(far.swings, 0, 'a swing at a hitbox 3.6 from the eye')
  assert.ok(far.raises > 0, 'no standoff guard against a hitbox 3.6 from the eye')
})

test('a creeper the body perceives behind a zombie in reach ends the melee and is fled, one behind a wall is not', async () => {
  // The zombie in reach, the creeper 5 out behind it. The reflex picked the zombie before the creeper came.
  const fight = async (seen) => {
    const z = zombie(2.5)
    const creeper = { id: 9, name: 'creeper', seen, position: new Vec3(5.5, 64, 0.5) }
    const entities = { 7: z, 9: creeper }
    const picked = []
    const r = await standoff(open, z, {
      bot: { entities },
      env: {
        ...IN_REACH,
        expireConfirmed,
        CONFIRMED_MS: botConstant('CONFIRMED_MS'),
        CONFIRMED_HORIZON: botConstant('CONFIRMED_HORIZON'),
        fight: guardFight({ threatDebugUntil: 0 }),
        liveEntities: () => Object.values(entities),
        mobClass: (e) => (e.name === 'creeper' ? 'creeper' : 'hostile'),
        entityPerceptible: (e) => e.seen !== false,
        entityEngageable: () => true
      },
      // The next reflex pass.
      next: async (combat, bot) => {
        if (!combat.check(bot)) return
        picked.push(combat._threat.e.name)
        await combat.act(bot)
      }
    })
    return { swings: r.swings, fled: r.fled, picked }
  }
  assert.deepStrictEqual(await fight(true), { swings: 0, fled: ['emergency'], picked: ['creeper'] })
  const walled = await fight(false)
  assert.ok(walled.swings > 0, 'no swing at the zombie with the creeper behind a wall')
  assert.deepStrictEqual({ fled: walled.fled, picked: walled.picked }, { fled: [], picked: [] })
})

// confirmed holds the ids of the mobs that hit the body. body replaces entries of the bot.
function scored (blocks, mobs, confirmed = [], over = {}, body = {}) {
  const events = []
  const entities = Object.fromEntries(mobs.map((m) => [m.id, m]))
  const fight = standoffFight(open, mobs[0], {
    bot: { entities, blockAt: roomBlockAt(blocks), ...body },
    env: {
      AGGRO_CONFIRMED: new Map(confirmed.map((id) => [id, { name: entities[id].name, t: Date.now(), ranged: false }])),
      expireConfirmed,
      CONFIRMED_MS: botConstant('CONFIRMED_MS'),
      CONFIRMED_COOL_MS: botConstant('CONFIRMED_COOL_MS'),
      CONFIRMED_HORIZON: botConstant('CONFIRMED_HORIZON'),
      fight: guardFight({ threatDebugUntil: 0 }),
      liveEntities: () => Object.values(entities),
      entityPerceptible: (e) => e.seen !== false,
      entityEngageable: () => true,
      emitEvent (kind, line) { if (kind === 'threat') events.push(line) },
      ...over
    }
  })
  const { bot, combat } = fight
  for (const m of mobs) combat._hist.set(m.id, { d: m.position.distanceTo(HERE) + 1, t: Date.now() - 1000, closes: 3, logT: 0 })
  const fires = combat.check(bot)
  return { fires, threat: combat._threat ? combat._threat.e.name : null, watched: events.filter((l) => l.startsWith('watched:')), events, fight }
}

test('the reflex watches a skeleton outside the wall of a closed room and scores a farther zombie at the open door', () => {
  // The skeleton stands in sight behind the east wall, the zombie outside the open door in the west wall.
  const r = scored(room(-2, -3, 0, 3, { x: -3, z: 0, kind: 'open door' }), [zombie(-4.5), skeleton(2.5)])
  assert.deepStrictEqual({ fires: r.fires, threat: r.threat }, { fires: true, threat: 'zombie' })
  assert.strictEqual(r.watched.length, 1, JSON.stringify(r.watched))
  assert.match(r.watched[0], /^watched: skeleton beyond ~2\b/)
})

test('the reflex scores a zombie outside the wall of a closed room once it hit the body, in sight or not', () => {
  const closed = room(-2, -3, 0, 3)
  const unproven = scored(closed, [zombie(2.5)])
  assert.deepStrictEqual({ fires: unproven.fires, threat: unproven.threat }, { fires: false, threat: null }, 'control: a zombie that never hit the body')
  for (const seen of [true, false]) {
    const r = scored(closed, [{ ...zombie(2.5), seen }], [7])
    assert.deepStrictEqual({ fires: r.fires, threat: r.threat, watched: r.watched }, { fires: true, threat: 'zombie', watched: [] }, `seen ${seen}`)
  }
})

test('the reflex scores a zombie closing over ground the body has not seen', () => {
  const r = scored(() => null, [zombie(5.5)], [], { cellKnown: (p) => !(p.y === 63 && p.x >= 1 && p.x <= 5) })
  assert.deepStrictEqual({ fires: r.fires, threat: r.threat, watched: r.watched }, { fires: true, threat: 'zombie', watched: [] })
})

test('the reflex scores and strikes a zombie in reach below a pillar top with no walk to the body', async () => {
  const pillar = (p) => p.x === 0 && p.z === 0 && p.y < 66 ? 'stone' : null
  const top = { entity: { position: new Vec3(0.5, 66, 0.5), onGround: true } }
  const perch = { perch: { cell: null }, perchStrike: undefined, ...REACH_RULE, PERCH_MELEE: botConstant('PERCH_MELEE'), PERCH_DROP: botConstant('PERCH_DROP') }
  const r = scored(pillar, [zombie(1.5)], [], perch, top)
  assert.strictEqual(r.fight.env.walksToBody(new Vec3(1.5, 64, 0.5), { steps: 12, drop: botConstant('CREEPER_DROP') }), false, 'control: a walk to the body')
  assert.deepStrictEqual({ fires: r.fires, threat: r.threat, watched: r.watched }, { fires: true, threat: 'zombie', watched: [] })
  await r.fight.combat.act(r.fight.bot)
  assert.ok(r.fight.result().swings > 0, 'no swing from the pillar top')
})

// A closed room from (-1, -1) to (1, 1) with 3-high walls, and with window a 1-high gap at eye height in its east wall.
const shutRoom = (window) => (p) => {
  if (p.y > 66 || Math.max(Math.abs(p.x), Math.abs(p.z)) !== 2) return null
  return window && p.x === 2 && p.z === 0 && p.y === 65 ? null : 'stone'
}

test('the vanguard reflex scores a skeleton at the window of a closed room as in shooting range and stays inside', async () => {
  const sk = { ...skeleton(5.5), width: 0.6, height: 1.99 }
  const chases = []
  const vanguard = {
    STANCES: { vanguard: { fleeDist: 12, bowBand: [7, 24], chase: true, engage: 'closers' } },
    fight: guardFight({ stance: 'vanguard', threatDebugUntil: 0 }),
    sprintBlock: () => 'beyond 8'
  }
  const pathfinder = { goal: null, isMoving: () => false, setGoal (g) { this.goal = g; if (g) chases.push(g) } }
  const r = scored(shutRoom(true), [sk], [], vanguard, { pathfinder })
  assert.deepStrictEqual({ fires: r.fires, threat: r.threat, watched: r.watched }, { fires: true, threat: 'skeleton', watched: [] })
  await r.fight.combat.act(r.fight.bot)
  assert.deepStrictEqual(r.events, ['skeleton E ~5 in sight, shooting range [vanguard]'])
  assert.deepStrictEqual(chases, [])
  const walled = scored(shutRoom(false), [sk], [], vanguard, { pathfinder })
  assert.deepStrictEqual({ fires: walled.fires, threat: walled.threat }, { fires: false, threat: null }, 'a skeleton with no clear line')
  assert.match(walled.watched[0] || '', /^watched: skeleton beyond ~5\b/)
})

// Lava at the feet over the ring 3 to 4 out, open ground beyond it.
const lavaRing = (p) => p.y === 64 && [3, 4].includes(Math.max(Math.abs(p.x), Math.abs(p.z)))
  ? { name: 'lava', boundingBox: 'empty', shapes: [], position: p }
  : blockAt(open)(p)

test('the reflex scores and counts in the pack a ranged mob with no walk in sight within its range', () => {
  // Whether the reflex scores mob and whether the pack counts it, on blocks.
  const ranged = (mob, at) => {
    const r = scored(open, [mob], [], { nearHostiles: undefined }, { blockAt: at })
    return { fires: r.fires, threat: r.threat, pack: Array.from(r.fight.env.nearHostiles({}, 16, new Map()), (h) => h.e.name) }
  }
  const across = (name, x, over = {}) => ({ id: 9, name, width: 0.6, height: 1.8, position: new Vec3(x, 64, 0.5), ...over })
  const fenced = blockAt(ring('fence', 1))
  assert.deepStrictEqual(ranged(across('zombie', 6.5), lavaRing), { fires: false, threat: null, pack: [] }, 'control: a zombie across the lava')
  assert.deepStrictEqual(ranged(across('blaze', 6.5), lavaRing), { fires: true, threat: 'blaze', pack: ['blaze'] }, 'a blaze across the lava')
  assert.deepStrictEqual(ranged(across('pillager', 6.5), fenced), { fires: true, threat: 'pillager', pack: ['pillager'] }, 'a pillager behind a fence')
  assert.deepStrictEqual(ranged(across('pillager', 10.5), fenced), { fires: false, threat: null, pack: [] }, 'a pillager 10 off, beyond its 8')
  const trident = { heldItem: { name: 'trident' } }
  assert.deepStrictEqual(ranged(across('drowned', 6.5, trident), lavaRing), { fires: true, threat: 'drowned', pack: ['drowned'] }, 'a drowned with a trident')
  assert.deepStrictEqual(ranged(across('drowned', 6.5), lavaRing), { fires: false, threat: null, pack: [] }, 'a drowned with no trident')
})

test('a zombie on a ledge 6 high is watched and left out of the pack, a creeper there scores and counts', () => {
  // Each edge of the ledge is a drop of 6.
  const ledge = (p) => p.x >= 3 && p.y <= 69 ? 'stone' : null
  const mobClass = (e) => (e.name === 'creeper' ? 'creeper' : 'hostile')
  const on = (name) => {
    const r = scored(ledge, [{ id: 9, name, width: 0.6, height: 1.8, position: new Vec3(4.5, 70, 0.5) }], [], { nearHostiles: undefined, mobClass })
    return { fires: r.fires, watched: r.watched, pack: Array.from(r.fight.env.nearHostiles({}, 16, new Map()), (h) => h.e.name) }
  }
  assert.deepStrictEqual(on('creeper'), { fires: true, watched: [], pack: ['creeper'] }, 'a creeper')
  const zombie = on('zombie')
  assert.deepStrictEqual({ fires: zombie.fires, pack: zombie.pack }, { fires: false, pack: [] }, 'a zombie')
  assert.match(zombie.watched[0] || '', /^watched: zombie above ~7\b/)
})

test('the reflex recomputes the walk flood to the body once a second has passed', () => {
  const clock = fakeClock()
  let floods = 0
  const r = scored(open, [zombie(5.5)], [], { Date: { now: clock.now }, walkersTo: (...a) => { floods++; return walkersTo(...a) } })
  assert.strictEqual(floods, 1, 'control: the first check')
  clock.advance(500)
  r.fight.combat.check(r.fight.bot)
  assert.strictEqual(floods, 1, 'a flood recomputed within the second')
  clock.advance(1000)
  r.fight.combat.check(r.fight.bot)
  assert.strictEqual(floods, 2)
})

test('one check pass floods once per drop limit for ten zombies outside a closed room', () => {
  const drops = []
  const zombies = Array.from({ length: 10 }, (_, i) => ({ ...zombie(0), id: 20 + i, position: new Vec3(6.5 + 2 * i, 64, 0.5) }))
  const r = scored(room(-2, -3, 0, 3), zombies, [], { walkersTo: (world, to, o) => { drops.push(o.maxDrop); return walkersTo(world, to, o) } })
  assert.deepStrictEqual({ fires: r.fires, watched: r.watched.length }, { fires: false, watched: 10 })
  assert.deepStrictEqual(drops, [3])
})

test('a zombie sealed in a stone room 20 off has no walk, for at most 23 sight checks per column of the open field', () => {
  // Stone walls 3 high and a roof at y 67 round the floor from (18, -2) to (22, 2).
  const sealed = (p) => p.x >= 17 && p.x <= 23 && Math.abs(p.z) <= 3 && p.y <= 67 && (p.y === 67 || p.x === 17 || p.x === 23 || Math.abs(p.z) === 3) ? 'stone' : null
  const checks = new Map()
  const env = {
    bot: { entity: { position: HERE }, blockAt: blockAt(sealed) },
    Vec3,
    ck,
    isDoor,
    walkersTo,
    groundCell,
    cellKnown: (p) => {
      const column = p.x + ',' + p.z
      checks.set(column, (checks.get(column) || 0) + 1)
      return true
    },
    WALK_MEMO: botConstant('WALK_MEMO'),
    WALK_STEPS: botConstant('WALK_STEPS'),
    WALK_CAP: botConstant('WALK_CAP')
  }
  const { walksToBody, walkBudget } = loadBotFunctions(['walksToBody', 'walkBudget'], env)
  const zombie = new Vec3(20.5, 64, 0.5)
  assert.strictEqual(walksToBody(zombie, { steps: walkBudget(zombie), drop: botConstant('CREEPER_DROP') }), false)
  // A field column pays for its ground block and the 22 cells above it that could floor a drop of up to 22.
  // The columns round the body and beside the room also serve flood cells at other heights.
  const over = [...checks].filter(([column, n]) => {
    const [x, z] = column.split(',').map(Number)
    const aside = Math.max(Math.abs(x), Math.abs(z)) <= 2 || (x >= 16 && x <= 24 && Math.abs(z) <= 4)
    return n > 23 && !aside
  })
  assert.deepStrictEqual(over.slice(0, 5), [], `${over.length} of ${checks.size} columns over`)
})

async function vanguardFight (at, seen, x, env = {}) {
  const chases = []
  const legs = []
  let sprints = 0
  const z = zombie(x)
  const entities = { 7: z }
  const r = await standoff(open, z, {
    bot: {
      entities,
      blockAt: at,
      pathfinder: { goal: null, isMoving: () => false, setGoal (g) { this.goal = g; if (g) chases.push(g) } },
      // A sprint opener skips the timer that removes the zombie on its third wait.
      setControlState (c, s) {
        if (c !== 'sprint' || !s) return
        sprints++
        delete entities[7]
      }
    },
    env: {
      AGGRO_CONFIRMED: new Map([[7, { name: 'zombie', t: Date.now(), ranged: false }]]),
      STANCES: { vanguard: { fleeDist: 12, bowBand: [7, 24], chase: true, engage: 'closers' } },
      fight: guardFight({ stance: 'vanguard' }),
      entityPerceptible: () => seen,
      takeLegs (reflex, why) { legs.push(why) },
      runCells: rules.runCells,
      RUN_COAST: legacy1710.RUN_COAST,
      RUN_TICKS: rules.RUN_TICKS,
      ...env
    }
  })
  return { swings: r.swings, chases: chases.length, sprints, legs }
}

test('the vanguard reflex neither chases nor swings at a zombie that hit the body from behind a wall', async () => {
  const wall = (p) => p.x === 2 && p.y >= 64 && p.y < 67 ? 'stone' : null
  const fight = (seen, x, env) => vanguardFight(blockAt(seen ? open : wall), seen, x, env)
  const NONE = { swings: 0, chases: 0, sprints: 0, legs: [] }
  // A walk to the zombie, then a 1.7.10 sprint opener.
  for (const sprintBlock of [() => 'beyond 8', () => null]) {
    const chased = await fight(true, 5.5, { sprintBlock })
    assert.ok(chased.chases + chased.sprints > 0 && chased.legs.includes('chase'), `control: no chase in sight, ${JSON.stringify(chased)}`)
    assert.deepStrictEqual(await fight(false, 5.5, { sprintBlock }), NONE, `a chase behind the wall, run ${sprintBlock()}`)
  }
  for (const legacy of [true, false]) {
    const reach = { ...IN_REACH, LEGACY_1710: legacy, meleeAim: undefined, HITBOX_1710: legacy1710.HITBOX_1710 }
    assert.ok((await fight(true, 3.5, reach)).swings > 0, `control: no swing in sight on ${version(legacy)}`)
    assert.deepStrictEqual(await fight(false, 3.5, reach), NONE, `a swing behind the wall on ${version(legacy)}`)
  }
})

test('the vanguard reflex chases a zombie in sight over open ground and through an open door, not through a window', async () => {
  // The zombie stands east of the room's east wall.
  const field = roomBlockAt(() => null)
  const door = roomBlockAt(room(-1, -1, 1, 1, { x: 2, z: 0, kind: 'open door' }))
  const closed = roomBlockAt(room(-1, -1, 1, 1))
  for (const sprintBlock of [() => 'beyond 8', () => null]) {
    const run = sprintBlock() ? 'a goal' : 'a sprint opener'
    for (const [where, at, x] of [['open ground', field, 5.5], ['an open door', door, 4.5]]) {
      const chased = await vanguardFight(at, true, x, { sprintBlock })
      assert.ok(chased.chases + chased.sprints > 0 && chased.legs.includes('chase'), `control: no chase over ${where} with ${run}, ${JSON.stringify(chased)}`)
    }
    const walled = await vanguardFight(closed, true, 4.5, { sprintBlock })
    assert.deepStrictEqual({ chases: walled.chases, sprints: walled.sprints, chase: walled.legs.includes('chase') }, { chases: 0, sprints: 0, chase: false }, `a chase through a window with ${run}`)
  }
})

test('the vanguard reflex does not chase a zombie on a ledge 3 high or 2 deep in a pit', async () => {
  const places = [
    ['on a ledge 3 high', (p) => p.y < 64 || (p.x >= 3 && p.y <= 66), new Vec3(4.5, 67, 0.5)],
    ['2 deep in a pit', (p) => p.y < 64 && !(p.x >= 3 && p.x <= 4 && Math.abs(p.z) <= 1 && p.y >= 62), new Vec3(3.5, 62, 0.5)]
  ]
  for (const [where, stone, position] of places) for (const sprintBlock of [() => 'beyond 8', () => null]) {
    const chases = []
    const legs = []
    const z = { id: 7, name: 'zombie', width: 0.6, height: 1.95, position }
    const entities = { 7: z }
    await standoff(open, z, {
      bot: {
        entities,
        blockAt: (p) => Object.assign(Block.fromProperties(stone(p) ? 'stone' : 'air', {}, 0), { position: p }),
        pathfinder: { goal: null, isMoving: () => false, setGoal (g) { this.goal = g; if (g) chases.push(g) } },
        // A sprint opener skips the timer that removes the zombie on its third wait.
        setControlState (c, s) {
          if (c !== 'sprint' || !s) return
          legs.push('sprint')
          delete entities[7]
        }
      },
      env: {
        AGGRO_CONFIRMED: new Map([[7, { name: 'zombie', t: Date.now(), ranged: false }]]),
        STANCES: { vanguard: { fleeDist: 12, bowBand: [7, 24], chase: true, engage: 'closers' } },
        fight: guardFight({ stance: 'vanguard' }),
        takeLegs (reflex, why) { legs.push(why) },
        sprintBlock,
        runCells: rules.runCells,
        RUN_COAST: legacy1710.RUN_COAST,
        RUN_TICKS: rules.RUN_TICKS
      }
    })
    const run = sprintBlock() ? 'a goal' : 'a sprint opener'
    assert.deepStrictEqual({ chases: chases.length, legs }, { chases: 0, legs: [] }, `${where} with ${run}`)
  }
})

test('the vanguard reflex sets no chase goal while the body stands inside its bunker', async () => {
  // The chase goals and leg takings against a zombie in sight 6 out, for a body whose last bunker is cell.
  const chase = async (cell) => {
    const chases = []
    const legs = []
    const entity = { position: HERE, onGround: true }
    const lane = laneAt(entity, cell)
    await standoff(open, zombie(6.5), {
      bot: { entity, pathfinder: { goal: null, isMoving: () => false, setGoal (g) { this.goal = g; if (g) chases.push(g) } } },
      env: {
        STANCES: { vanguard: { fleeDist: 12, bowBand: [7, 24], chase: true, engage: 'closers' } },
        fight: guardFight({ stance: 'vanguard' }),
        sprintBlock: () => 'beyond 8',
        takeLegs (reflex, why) { legs.push(why) },
        bunker: lane.bunker,
        laneBlocks: lane.laneBlocks,
        laneNarrate: lane.laneNarrate
      }
    })
    return { chases: chases.length, legs }
  }
  const outside = await chase(null)
  assert.ok(outside.chases > 0 && outside.legs.includes('chase'), `control: no chase outside a bunker, ${JSON.stringify(outside)}`)
  assert.deepStrictEqual(await chase(new Vec3(0, 64, 0)), { chases: 0, legs: [] })
})

test('the vanguard reflex keeps a pilot walk\'s goal with a zombie in reach while the walk holds the lane', async () => {
  // The legs taken and whether the walk's goal survived a zombie in reach, lane claimed or not.
  const fight = async (claimed) => {
    const legs = []
    const entity = { position: HERE, onGround: true }
    const lane = laneAt(entity, null)
    if (claimed) lane.claimLane('goto', 300000)
    const walk = new goals.GoalBlock(20, 64, 0)
    const { bot, combat } = standoffFight(open, zombie(3.5), {
      bot: { entity, pathfinder: { goal: walk, isMoving: () => true, setGoal (g) { this.goal = g } } },
      env: {
        ...IN_REACH,
        STANCES: { vanguard: { fleeDist: 12, bowBand: [7, 24], chase: true, engage: 'closers' } },
        fight: guardFight({ stance: 'vanguard' }),
        takeLegs (reflex, why) { legs.push(why) },
        laneBlocks: lane.laneBlocks,
        laneNarrate: lane.laneNarrate
      }
    })
    await combat.act(bot)
    return { legs, kept: bot.pathfinder.goal === walk }
  }
  assert.deepStrictEqual(await fight(false), { legs: ['fight in melee range'], kept: false }, 'control: no lane held')
  assert.deepStrictEqual(await fight(true), { legs: [], kept: true })
})

// ---- the hand during a fight ----

test('the combat reflex is busy through a standoff, the melee, a flee, a cover move and the gap before it fires again', async () => {
  for (const env of [{}, IN_REACH]) {
    const busy = []
    await standoff(open, zombie(3.5), { env, cycle: (combat, { bot }) => { if (bot.entities[7]) busy.push(combat.fightBusy()) } })
    assert.ok(busy.length > 0 && busy.every(Boolean), `${env === IN_REACH ? 'melee' : 'standoff'}: ${busy}`)
  }
  const mob = zombie(5.5)
  await standoff(open, mob, {
    next: (combat, bot) => {
      assert.strictEqual(combat.fightBusy(), false, 'the fought mob is gone')
      bot.entities[mob.id] = mob
      assert.strictEqual(combat.fightBusy(), true, 'the act ended with its threat alive')
      combat._threat = null
      assert.strictEqual(combat.fightBusy(), false, 'control: no threat scored')
      combat.on = false
      assert.strictEqual(combat.fightBusy(), false, 'the reflex switched off')
    }
  })
  // A flee at disengage health, and a cover move behind a wall east of the body, each with no threat scored after.
  const fled = standoffFight(open, zombie(2.5), {
    bot: { health: 6 },
    env: { planFlee, creeperCover, takenText, reflexes: [], stopPath () {}, fleeLog: undefined },
    flee: true
  })
  await fled.combat.act(fled.bot)
  fled.combat._threat = null
  assert.ok(fled.bot.pathfinder.goal, 'control: the body fled')
  assert.strictEqual(fled.combat.fightBusy(), true, 'a flee')
  const wall = (p) => p.x === 2 && (p.z === 1 || p.z === 2) ? 'stone' : null
  const covered = standoffFight(wall, skeleton(8.5), { env: { holdsWater: () => false, gridWalk: undefined, stopPath () {} } })
  covered.combat.takeCover(covered.bot, skeleton(8.5), 'skeleton')
  covered.combat._threat = null
  assert.deepStrictEqual({ cover: !!covered.bot.pathfinder.goal, fled: covered.result().fled }, { cover: true, fled: [] }, 'control: the body took cover')
  assert.strictEqual(covered.combat.fightBusy(), true, 'a cover move')
})

test('the guard log names every real raise and lowering with its cause, and leaves out the swing cycle', async () => {
  // A walk lowers the block after the first standoff cycle, and the next cycle raises it again.
  let walked = false
  const lowerOnce = (combat, env) => {
    if (walked || !env.guardState.up) return
    walked = true
    env.lowerGuard('for a walk')
  }
  const r = await standoff(ring('stone', 3), zombie(3.5), { env: { lowerGuard: undefined }, cycle: lowerOnce })
  assert.strictEqual(r.lines.length, 4, r.lines.join('\n'))
  assert.match(r.lines[0], /^\[combat\] guard up vs zombie ~3: closing\b/)
  assert.strictEqual(r.lines[1], '[combat] guard down for a walk')
  assert.match(r.lines[2], /^\[combat\] guard up vs zombie ~3: closing\b/)
  assert.strictEqual(r.lines[3], '[combat] guard down vs zombie: the fight ended')
  const melee = await standoff(open, zombie(3.5), { env: IN_REACH })
  assert.ok(melee.swings > 0 && melee.raises > 1, `control: ${JSON.stringify(melee)}`)
  assert.deepStrictEqual(melee.lines.filter((l) => l !== '[combat] guard down vs zombie: the fight ended'), [])
})

test('a fight that starts between the pre-action check and the placement click gets the sword only after the click', async () => {
  const order = []
  const torch = { name: 'torch' }
  const mob = zombie(2.5)
  let act = null
  const fight = standoffFight(open, mob, {
    env: IN_REACH,
    bot: {
      inventory: { items: () => [{ name: 'iron_sword' }, torch], slots: [] },
      _client: { write () {} },
      async equip (item) {
        order.push(`equip ${item.name}`)
        fight.bot.heldItem = item
        // The fight starts as the torch comes into the hand.
        if (item === torch) act = fight.combat.act(fight.bot)
        await new Promise(setImmediate)
      },
      async placeBlock () {
        order.push(`click with ${fight.bot.heldItem.name}`)
        fight.bot._client.write('block_place', {})
        // The server confirms the placement once the sword is in hand, or after 1 s.
        for (const end = Date.now() + 1000; Date.now() < end && !order.includes('equip iron_sword');) await new Promise(setImmediate)
        order.push('confirmed')
      }
    }
  })
  loadBotFunctions(['wireHandLease'], fight.env).wireHandLease()
  const { handle, res } = routeHandler('/placeitem', {
    bot: fight.bot,
    guardState: fight.env.guardState,
    require,
    LEGACY_1710: true,
    cellKnown: () => true,
    bodyTouches: () => false,
    occupant: () => null,
    seenNow: () => true,
    isSoftCover: () => false,
    isInteractive: () => false,
    reachToPlace: async () => {},
    clearSoftCover: async () => {},
    passageAxis: () => null,
    stampOwnEdit () {},
    reflexes: [{ name: 'combat', fightBusy: () => act !== null }],
    setTimeout,
    clearTimeout
  })
  await handle({ query: { x: '1', y: '64', z: '0', name: 'torch' } }, res)
  await act
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(order, ['equip torch', 'click with torch', 'equip iron_sword', 'confirmed'])
})

// holdHand and endHand over guardState, on the global timers.
const handLease = (guardState) => loadBotFunctions(['holdHand', 'endHand'], {
  guardState,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id)
})
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }

test('a pilot lease whose click never comes ends after 2 s, and the reflex then puts the sword in hand', { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const torch = { name: 'torch' }
  const equips = []
  const fight = standoffFight(open, zombie(2.5), {
    env: IN_REACH,
    bot: {
      heldItem: torch,
      inventory: { items: () => [{ name: 'iron_sword' }, torch], slots: [] },
      async equip (item) { equips.push(item.name); fight.bot.heldItem = item }
    }
  })
  handLease(fight.env.guardState).holdHand()
  const act = fight.combat.act(fight.bot)
  await settle()
  t.mock.timers.tick(1999)
  await settle()
  assert.deepStrictEqual(equips, [], 'the sword went into the hand while the lease held')
  t.mock.timers.tick(1)
  await act
  assert.strictEqual(equips[0], 'iron_sword')
  assert.strictEqual(fight.env.guardState.hand, null)
})

test('a renewed pilot lease holds the hand 2 s from the renewal, and a renewal after its end does nothing', () => {
  const clock = fakeClock()
  const guardState = { hand: null }
  const { holdHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  const lease = holdHand()
  clock.advance(1500)
  lease.renew()
  clock.advance(1999)
  assert.strictEqual(guardState.hand, lease, 'the lease ended before 2 s after the renewal')
  clock.advance(1)
  assert.strictEqual(guardState.hand, null)
  lease.renew()
  assert.strictEqual(clock.pending(), 0, 'a renewal after the end started a timer')
  const first = holdHand()
  const second = holdHand()
  first.renew()
  assert.strictEqual(clock.pending(), 1, 'a replaced lease started a timer')
  assert.strictEqual(guardState.hand, second)
})

test('a stop ends the pilot lease on the hand at once', async () => {
  const guardState = botObject('guardState', { console })
  const lease = handLease(guardState).holdHand()
  runRoute('/stop', {}, { bot: { clearControlStates () {} }, bunker: {}, legs: { take () {} }, stopFollow () {}, stopPath () {}, clearLane () {}, jobs: { stopAll: () => 0 }, guardState })
  assert.strictEqual(guardState.hand, null)
  assert.strictEqual(await Promise.race([lease.then(() => 'ended'), new Promise(setImmediate).then(() => 'held')]), 'ended')
})

test('the bow goes into the hand only once the pilot lease on it ends', async () => {
  const guardState = botObject('guardState', { console })
  const { holdHand, endHand } = handLease(guardState)
  const order = []
  const target = skeleton(8.5)
  const bot = {
    entity: { position: HERE },
    entities: { 8: target },
    heldItem: { name: 'torch' },
    inventory: { items: () => [{ name: 'bow' }, { name: 'arrow' }] },
    async equip (item) { order.push(`equip ${item.name}`); bot.heldItem = item },
    lookAt: async () => {},
    waitForTicks: async () => {},
    activateItem () { order.push('draw') },
    deactivateItem () { order.push('loose') }
  }
  const env = { bot, guardState, losClear: () => true, entityPerceptible: () => true, reflexes: [{ name: 'combat', fairFill: () => ({}) }], setTimeout: (fn) => setImmediate(fn) }
  const { drawAndLoose } = loadBotFunctions(['drawAndLoose'], env)
  const lease = holdHand()
  const shot = drawAndLoose(target)
  await settle()
  order.push('click')
  endHand(lease)
  assert.strictEqual(await shot, true)
  assert.deepStrictEqual(order, ['click', 'equip bow', 'draw', 'loose'])
})

test('the standoff raises no 1.21.11 shield while the pilot holds the hand', async () => {
  const shield = { bot: { inventory: { items: () => [{ name: 'iron_sword' }], slots: { 45: { name: 'shield' } } } }, env: { LEGACY_1710: false } }
  assert.ok((await standoff(open, skeleton(10.5), shield)).raises > 0, 'control: no lease')
  const fight = standoffFight(open, skeleton(10.5), shield)
  const { holdHand, endHand } = handLease(fight.env.guardState)
  const lease = holdHand()
  await fight.combat.act(fight.bot)
  endHand(lease)
  assert.strictEqual(fight.result().raises, 0)
})

test('a pilot guard order logs its raise and its lowering', () => {
  for (const legacy of [true, false]) {
    const lines = []
    const guardState = botObject('guardState', { console: { log: (line) => lines.push(line) } })
    const env = {
      bot: { heldItem: { name: 'iron_sword' }, quickBarSlot: 0, inventory: { slots: { 45: { name: 'shield' } } }, activateItem () {}, deactivateItem () {} },
      shared: { ready: true },
      LEGACY_1710: legacy,
      guardState,
      legsMoving: () => false
    }
    runRoute('/guard', { on: '1' }, env)
    runRoute('/guard', { on: '0' }, env)
    assert.deepStrictEqual(lines, ['[combat] guard up by pilot guard', '[combat] guard down by pilot guard'], version(legacy))
  }
})

test('a death or a dimension change logs the lowering of a raised guard and ends the pilot order', () => {
  const lines = []
  const guardState = botObject('guardState', { console: { log: (line) => lines.push(line) } })
  Object.assign(guardState, { up: true, pilot: true })
  const env = { reflexes: [{ name: 'combat' }, { name: 'bunker' }], AGGRO_CONFIRMED: new Map(), fight: {}, bunker: {}, guardState }
  loadBotFunctions(['resetThreatState'], env).resetThreatState()
  assert.deepStrictEqual([guardState.up, guardState.pilot], [false, false])
  assert.deepStrictEqual(lines, ['[combat] guard down for a death or a dimension change'])
})
