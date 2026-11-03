'use strict'
// A pilot walk that closes on a lit creeper fuse is refused before the body moves.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { AsyncLocalStorage } = require('node:async_hooks')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { guardWork } = require('../lib/walk')
const { FUSE_REACH, FUSE_NEAR, closesOnFuse } = require('../lib/plan')
const { classifySound } = require('../lib/sounds')
const registry = require('prismarine-registry')('1.21.11')
const { loadBotFunctions, botConstant, routeHandler } = require('./helpers')

const SWELL = registry.entitiesByName.creeper.metadataKeys.indexOf('swell_dir')
// A creeper x blocks east of the body, swelling at swell 1 and with its fuse out at -1.
function creeper (x, swell, seen = true, id = 9) {
  const metadata = []
  metadata[SWELL] = swell
  return { id, type: 'hostile', name: 'creeper', seen, position: new Vec3(x + 0.5, 64, 0.5), metadata }
}
// A creeper's fuse heard ago ms before now, x blocks east of the body.
const heard = (x, ago) => ({ t: Date.now() - ago, at: new Vec3(x + 0.5, 64, 0.5), tnt: false })
const east = (x) => new goals.GoalBlock(x, 64, 0)
const REFUSED = (what) => `refused: ${what} and this walk closes on it, the guard stays up. Walk away from it, or walk again once the fuse is out.`

// Each plan runs along z 0 to the goal's x as floored nodes, as the planner returns them, unless path is given.
function fuseBody ({ entities = [], fuses = [], path = null } = {}) {
  const walks = []
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
    pathfinder: {
      goal: null,
      thinkTimeout: 10000,
      setGoal (g) {
        this.goal = g
        if (g) walks.push(g)
      }
    }
  })
  const line = (g) => Array.from({ length: Math.abs(Math.floor(g.x)) }, (_, i) => new Vec3(Math.sign(g.x) * (i + 1), 64, 0))
  const env = {
    bot,
    FUSES: fuses,
    FUSE_MS: botConstant('FUSE_MS'),
    TNT_FUSE_MS: botConstant('TNT_FUSE_MS'),
    FUSE_REACH,
    FUSE_NEAR,
    closesOnFuse,
    staleEntities: new Set(),
    shared: { mcData: registry },
    reflexes: [{ name: 'combat', fairFill: () => ({}) }],
    entityPerceptible: (e) => e.seen,
    planPath: async (g) => ({ status: 'success', path: path || line(g) })
  }
  return { bot, env, walks }
}

async function walkTo (x, opts, before = () => {}) {
  const b = fuseBody(opts)
  const { walkOnce } = loadBotFunctions(['walkOnce'], {
    ...b.env,
    bunker: { building: false },
    walkAttempt: async (bot, g) => { bot.pathfinder.setGoal(g); return 'done' },
    serverSettled: async () => {}
  })
  before(b)
  const route = { expired: () => false, stopped: () => false }
  const end = await walkOnce(east(x), route, 1000).catch((e) => e)
  return { end, walks: b.walks.length }
}

function earsOf (b) {
  return loadBotFunctions(['onSound'], Object.assign(b.env, {
    classifySound,
    LEGACY_1710: false,
    HEARD: [],
    dangerHeard: {},
    lastThunder: 0,
    lastThunderPos: null,
    emitEvent () {}
  })).onSound
}

test('a goto toward a swelling creeper within 7 is refused naming it, sets no goal, and a goto away from it walks', async () => {
  const toward = await walkTo(10, { entities: [creeper(4, 1)] })
  assert.strictEqual(toward.walks, 0, 'the walk set a goal')
  assert.deepStrictEqual([toward.end.reason, toward.end.message], ['fuse', REFUSED('a creeper swells E ~4')])
  assert.deepStrictEqual(await walkTo(-10, { entities: [creeper(4, 1)] }), { end: 'done', walks: 1 })
})

test('a goto toward a creeper walks once its fuse is out or it is gone, and toward one 7 or more off or out of sight', async () => {
  const rows = [
    ['the fuse out', [creeper(4, -1)]],
    ['the creeper gone', []],
    ['the creeper 8 off', [creeper(8, 1)]],
    ['the creeper out of sight', [creeper(4, 1, false)]]
  ]
  for (const [what, entities] of rows) assert.deepStrictEqual(await walkTo(10, { entities }), { end: 'done', walks: 1 }, what)
})

test('a fuse heard within 1.5 s refuses a goto toward it as a swelling creeper does, an older one does not', async () => {
  for (const ago of [0, 1000]) {
    const toward = await walkTo(10, { fuses: [heard(4, ago)] })
    assert.deepStrictEqual([toward.end.reason, toward.end.message, toward.walks], ['fuse', REFUSED('a fuse hissed E ~4'), 0], `${ago} ms ago`)
  }
  assert.deepStrictEqual(await walkTo(-10, { fuses: [heard(4, 0)] }), { end: 'done', walks: 1 }, 'a goto away')
  assert.deepStrictEqual(await walkTo(10, { fuses: [heard(4, 1600)] }), { end: 'done', walks: 1 }, '1.6 s ago')
})

test('a walk closes on a fuse by the cell centres it walks through, not the floored nodes the planner returns', async () => {
  const fuse = (x, z) => [{ t: Date.now(), at: new Vec3(x, 64, z), tnt: false }]
  const north = Array.from({ length: 8 }, (_, i) => new Vec3(0, 64, -1 - i))
  assert.deepStrictEqual(await walkTo(10, { fuses: fuse(-2.5, 0.5), path: north }), { end: 'done', walks: 1 }, 'north past a fuse 3 west')
  const southEast = [[1, 0], [2, -1], [3, -2], [4, -3], [5, -4], [6, -5]].map(([x, z]) => new Vec3(x, 64, z))
  const past = await walkTo(10, { fuses: fuse(3.5, 3.5), path: southEast })
  assert.deepStrictEqual([past.end.reason, past.walks], ['fuse', 0], 'past a fuse 3 east and 3 south, 0.6 nearer at the first centre')
})

test('a heard TNT fuse refuses a goto toward it for 4 s, a creeper fuse for 1.5 s', async () => {
  const hiss = (name, ago) => (b) => {
    earsOf(b)(name, new Vec3(4.5, 64, 0.5))
    b.env.FUSES[0].t -= ago
  }
  const refused = async (name, ago) => (await walkTo(10, {}, hiss(name, ago))).end.reason === 'fuse'
  assert.deepStrictEqual(await Promise.all([refused('minecraft:entity.creeper.primed', 1000), refused('minecraft:entity.creeper.primed', 1600)]), [true, false], 'control: a creeper fuse')
  assert.deepStrictEqual(await Promise.all([refused('minecraft:entity.tnt.primed', 3500), refused('minecraft:entity.tnt.primed', 4100)]), [true, false])
})

test('a heard fuse stays lit beside a seen creeper that is not swelling, and a creeper seen swelling at it stands in for it', async () => {
  const twoCreepers = await walkTo(10, { fuses: [heard(5, 0)], entities: [creeper(4, -1), creeper(5, 1, false, 10)] })
  assert.deepStrictEqual([twoCreepers.end.message, twoCreepers.walks], [REFUSED('a fuse hissed E ~5'), 0], 'an idle creeper seen 1 from the hiss of an unseen swelling one')
  const seenSwelling = await walkTo(10, { fuses: [heard(5, 0)], entities: [creeper(4, 1)] })
  assert.deepStrictEqual([seenSwelling.end.message, seenSwelling.walks], [REFUSED('a creeper swells E ~4'), 0])
})

test('a heard fuse goes out with an explosion heard at it or a creeper seen swelling at it that dies or goes, not with an idle one that dies', async () => {
  const at = new Vec3(4.5, 64, 0.5)
  const after = (event) => (b) => {
    const onSound = earsOf(b)
    onSound('minecraft:entity.creeper.primed', at)
    event(b, onSound)
  }
  const walks = async (event, entities = []) => (await walkTo(10, { entities }, after(event))).walks
  assert.strictEqual(await walks(() => {}), 0, 'control: the hiss alone')
  assert.strictEqual(await walks((b, onSound) => onSound('minecraft:entity.generic.explode', at)), 1, 'an explosion at the hiss')
  assert.strictEqual(await walks((b, onSound) => onSound('minecraft:entity.generic.explode', at.offset(3, 0, 0))), 0, 'an explosion 3 from the hiss')
  const watched = (event, e) => (b) => {
    loadBotFunctions(['fuseOut', 'wireFuseOut'], b.env).wireFuseOut()
    b.bot.emit(event, e)
  }
  for (const event of ['entityGone', 'entityDead']) {
    assert.strictEqual(await walks(watched(event, creeper(4, 1))), 1, `a creeper seen swelling at the hiss, ${event}`)
    assert.strictEqual(await walks(watched(event, creeper(4, 1, false))), 0, `an unseen swelling creeper at the hiss, ${event}`)
    assert.strictEqual(await walks(watched(event, creeper(4, -1))), 0, `an idle creeper seen at the hiss, ${event}`)
  }
})

test('a pilot pathfinder goto toward a swelling creeper is refused before it sets a goal, one away from it walks', async () => {
  const b = fuseBody({ entities: [creeper(4, 1)] })
  const env = {
    ...b.env,
    require,
    goals,
    Vec3,
    COLLECT_STALL_MS: botConstant('COLLECT_STALL_MS'),
    COLLECT_BUDGET_MS: botConstant('COLLECT_BUDGET_MS'),
    guardWork,
    watchScope: new AsyncLocalStorage()
  }
  const { watchGoto } = loadBotFunctions(['watchGoto', 'stopPath'], env)
  b.bot.pathfinder.goto = watchGoto(async (g) => { b.bot.pathfinder.setGoal(g) })
  await assert.rejects(b.bot.pathfinder.goto(east(10)), { reason: 'fuse', message: REFUSED('a creeper swells E ~4') })
  assert.strictEqual(b.walks.length, 0, 'the goto set a goal')
  await b.bot.pathfinder.goto(east(-10))
  assert.strictEqual(b.walks.length, 1)
})

test('a follow of a player past a swelling creeper is refused and arms nothing, one of a player behind the body arms', async () => {
  const follow = async (x) => {
    const b = fuseBody({ entities: [creeper(4, 1)] })
    const steve = { id: 7, type: 'player', username: 'Steve', position: new Vec3(x + 0.5, 64, 0.5) }
    let armed = 0
    const { handle, res } = routeHandler('/follow', {
      ...b.env,
      goals,
      refuseWhilePouring () {},
      bunker: { building: false },
      follow: {},
      followTarget: () => ({ ent: steve }),
      stopFollow () {},
      armFollow () { armed++ },
      followTick: async () => {},
      setInterval: () => 0
    })
    await handle({ query: { name: 'Steve' } }, res)
    return { error: res.error && [res.error.reason, res.error.message], body: res.body && { ...res.body }, armed }
  }
  assert.deepStrictEqual(await follow(10), { error: ['fuse', REFUSED('a creeper swells E ~4')], body: undefined, armed: 0 })
  assert.deepStrictEqual(await follow(-10), { error: undefined, body: { following: 'Steve', range: 2, supervised: true }, armed: 1 })
})
