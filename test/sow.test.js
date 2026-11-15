'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const WorldSync = require('prismarine-world/src/worldsync')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const { botConstant, loadBotFunctions, routeHandler, fakeClock } = require('./helpers')

const key = (p) => `${p.x},${p.y},${p.z}`

// A bot env over stone below y 64 and air above, with the named blocks at their 'x,y,z' cells.
function plotWorld (blocks, { unseen = [], feet = new Vec3(0.5, 64, 0.5), onRay = () => {} } = {}) {
  const cells = new Map(Object.entries(blocks))
  const blockAt = (p) => {
    const c = p.floored()
    const name = cells.get(key(c)) || (c.y < 64 ? 'stone' : 'air')
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState, 0), { position: c })
  }
  const bot = Object.assign(new EventEmitter(), {
    registry,
    entity: { position: feet, width: 0.6, height: 1.8 },
    blockAt,
    world: { raycast: (...ray) => WorldSync.prototype.raycast.apply({ getBlock: blockAt }, ray) },
    // The body stands on full blocks here.
    pathfinder: { startCell: (pos) => pos.floored() }
  })
  const hidden = new Set(unseen)
  const planKnown = (p) => !hidden.has(key(p))
  bot.pathfinder.movements = loadBotFunctions(['knownMoves'], { bot, ck: (x, y, z) => `${x},${y},${z}`, PLAN_KNOWN: new Map(), planKnown }).knownMoves(new Movements(bot))
  const counted = {
    prototype: {
      raycast (...ray) {
        onRay()
        return WorldSync.prototype.raycast.apply(this, ray)
      }
    }
  }
  return { bot, goals, Vec3, POUR_REACH: botConstant('POUR_REACH'), WorldSync: counted }
}

const plotGoal = (plot, blocks, opts) => loadBotFunctions(['sowWalkGoal'], plotWorld(blocks, opts)).sowWalkGoal(plot)

const PLOT = new Vec3(3, 63, 0)
const ends = (goal, ...nodes) => nodes.map((n) => goal.isEnd(n))

test('a sow stand reaches the plot top only within 4.5 of the point its look ray hits', () => {
  const plot = new Vec3(3, 64, 0)
  const env = plotWorld({ '3,64,0': 'farmland' })
  const { sowStand } = loadBotFunctions(['sowStand'], env)
  const block = env.bot.blockAt(plot)
  // An eye d from the aim at the plot's low x, z corner, 1.6825 above its top.
  const corner = new Vec3(3.1, 64.9375, 0.1)
  const eye = (d) => {
    const h = Math.sqrt(d * d - 1.6825 ** 2) / Math.SQRT2
    return corner.offset(-h, 1.6825, -h)
  }
  assert.deepStrictEqual([4.6, 4.4].map((d) => !!sowStand(eye(d), plot, block).aim), [false, true])
})

test('a sow walk ends on a path beside the bed and on the terrace edge one level up', () => {
  assert.deepStrictEqual(ends(plotGoal(PLOT, { '3,63,0': 'farmland' }), new Vec3(2, 64, 0)), [true], 'beside the bed')
  assert.deepStrictEqual(ends(plotGoal(PLOT, { '3,63,0': 'farmland', '2,64,0': 'stone' }), new Vec3(2, 65, 0)), [true], 'one level up')
})

test('a sow walk never ends where a stop off the cell centre leaves the plot top out of reach', () => {
  // From -1,64,1 the centre eye reaches the top and the eye 0.2 off towards -x and +z does not.
  const goal = plotGoal(PLOT, { '3,63,0': 'farmland' })
  assert.deepStrictEqual(ends(goal, new Vec3(-1, 64, 1), new Vec3(0, 64, 1)), [false, true])
})

test('a sow walk never ends one level below the bed, where the eye is under the farmland top', () => {
  const high = new Vec3(3, 64, 0)
  const goal = plotGoal(high, { '3,64,0': 'farmland', '2,63,0': 'air', '4,64,0': 'stone' })
  assert.deepStrictEqual(ends(goal, new Vec3(2, 63, 0), new Vec3(4, 65, 0)), [false, true])
})

test('a sow walk never ends in water', () => {
  const water = plotGoal(PLOT, { '3,63,0': 'farmland', '2,63,0': 'water' })
  const dry = plotGoal(PLOT, { '3,63,0': 'farmland', '2,63,0': 'air' })
  assert.deepStrictEqual([...ends(water, new Vec3(2, 63, 0)), ...ends(dry, new Vec3(2, 63, 0))], [false, true])
})

test('a sow walk never ends in a crop it has seen, and ends on bare farmland and in a crop it has not seen', () => {
  const field = { '3,63,0': 'farmland', '2,63,0': 'farmland' }
  const stand = new Vec3(2, 64, 0)
  const wheat = plotGoal(PLOT, { ...field, '2,64,0': 'wheat' })
  const bare = plotGoal(PLOT, field)
  const unseen = plotGoal(PLOT, { ...field, '2,64,0': 'wheat' }, { unseen: ['2,64,0'] })
  assert.deepStrictEqual([wheat, bare, unseen].map((goal) => goal.isEnd(stand)), [false, true, true])
})

test('a sow walk reads an unseen block on the look ray as open air', () => {
  const wall = { '3,63,0': 'farmland', '2,64,0': 'stone', '2,65,0': 'stone' }
  const stand = new Vec3(1, 64, 0)
  const seen = plotGoal(PLOT, wall)
  const unseen = plotGoal(PLOT, wall, { unseen: ['2,64,0', '2,65,0'] })
  assert.deepStrictEqual([seen.isEnd(stand), unseen.isEnd(stand)], [false, true])
})

test('a sow walk never ends on a bottom slab from whose eye, half a block lower, a wall hides the plot top', () => {
  const plot = new Vec3(3, 64, 2)
  const field = { '3,64,2': 'farmland', '2,64,2': 'stone' }
  const stand = new Vec3(0, 64, 2)
  const slab = plotGoal(plot, { ...field, '0,63,2': 'stone_slab' })
  const block = plotGoal(plot, field)
  assert.deepStrictEqual([slab.isEnd(stand), block.isEnd(stand)], [false, true])
})

test('a sow walk ends on its start cell only when the plot top is in reach of the body where it stands', () => {
  const plot = new Vec3(4, 66, 2)
  const field = { '4,66,2': 'farmland', '0,66,0': 'stone' }
  const start = new Vec3(0, 67, 0)
  const corner = plotGoal(plot, field, { feet: new Vec3(0.05, 67, 0.05) })
  const centre = plotGoal(plot, field, { feet: new Vec3(0.5, 67, 0.5) })
  assert.deepStrictEqual([corner.isEnd(start), centre.isEnd(start)], [false, true])
})

test('a sow walk casts no look ray from a cell too far from the plot', () => {
  const rays = []
  const goal = plotGoal(PLOT, { '3,63,0': 'farmland' }, { onRay: () => rays.push('ray') })
  rays.length = 0
  assert.deepStrictEqual([goal.isEnd(new Vec3(10, 64, 0)), rays], [false, []])
})

const DEFAULT = 'default'

const PACE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pace.js'), 'utf8')
// The pacePlacements of lib/pace.js on a fake clock.
const pacedOn = (clock) => vm.runInNewContext(`${PACE_SOURCE}\npacePlacements`, { module: {}, setTimeout: clock.setTimeout, Date: { now: clock.now } })
const { PLACE_GAP_MS } = require('../lib/pace')

// Runs /sow `runs` times on a fake clock over stone below y 64 and air above, with blocks keyed by 'x,y,z'.
// A job it replaced runs until `replaced` ms and holds the movements named `inPlace` until then.
// pockets fill the hotbar from slot 37, and hand is the hotbar slot held at the start.
// With restartAt, each run after the first starts restartAt ms after the one before started, or when it ends if that comes sooner.
async function sowJob ({ query = {}, blocks = {}, feet = new Vec3(0.5, 64, 1.5), held = 'wheat_seeds', count = 16, pockets = [], hand = 0, unseen = [], dark = new Set(), ignore = [], stands = [], stay = false, fuse = false, combat = null, onClick = () => {}, onPace = () => {}, onWalk = () => {}, onLook = () => {}, onEquip = () => {}, throwAfter = Infinity, runs = 1, walkMs = 100, think = 10000, replaced = null, inPlace = null, cancelAt = null, restartAt = null } = {}) {
  const clock = fakeClock()
  const paced = pacedOn(clock)((click) => click())
  const world = new Map(Object.entries(blocks))
  const hidden = new Set(unseen)
  const seen = (c) => !hidden.has(key(c))
  const lit = (c) => seen(c) && !dark.has(key(c))
  const nameAt = (c) => world.get(key(c)) || (c.y < 64 ? 'stone' : 'air')
  const cellAt = (c) => Object.assign(Block.fromStateId(registry.blocksByName[nameAt(c)].defaultState, 0), { position: new Vec3(c.x, c.y, c.z) })
  const unseenReads = []
  const clicks = []
  const clickTimes = []
  const moves = []
  const walks = []
  const plans = []
  const log = []
  const server = { planted: 0 }
  const inventory = Object.assign(new EventEmitter(), { hotbarStart: 36, slots: [], items: () => inventory.slots.filter(Boolean) })
  inventory.slots[36] = { name: held, count, slot: 36 }
  pockets.forEach((name, i) => { inventory.slots[37 + i] = { name, count: 1, slot: 37 + i } })
  const looks = []
  let equips = 0
  const setCount = (n) => {
    const old = inventory.slots[36]
    inventory.slots[36] = n ? { name: held, count: n, slot: 36 } : null
    inventory.emit('updateSlot', 36, old, inventory.slots[36])
  }
  const getBlock = (c) => (seen(c) ? {} : { name: 'unknown' })
  const shared = { ready: true }
  const defaultMoves = { name: DEFAULT, getBlock }
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: feet, width: 0.6, height: 1.8 },
    inventory,
    quickBarSlot: hand,
    time: { age: 0 },
    waitForTicks: (n) => new Promise((resolve) => clock.setTimeout(resolve, 50 * n)),
    blockAt: (c) => {
      if (!seen(c)) unseenReads.push(key(c))
      return cellAt(c)
    },
    pathfinder: {
      goal: null,
      movements: inPlace ? { name: inPlace, getBlock } : defaultMoves,
      thinkTimeout: think,
      setMovements: (m) => {
        moves.push(m.name)
        bot.pathfinder.movements = m
      },
      startCell: (pos) => pos.floored(),
      goto: (goal) => new Promise((resolve, reject) => {
        bot.pathfinder.goal = goal
        log.push('walk')
        plans.push({ at: clock.now(), moves: bot.pathfinder.movements.name })
        clock.setTimeout(() => {
          // The movements a walk ends with are the ones its last plan used.
          walks.push({ moves: bot.pathfinder.movements.name, think: bot.pathfinder.thinkTimeout })
          onWalk(walks.length, bot, shared, hidden)
          if (fuse) return reject(Object.assign(new Error('refused: a creeper fuse is lit by the way'), { reason: 'fuse' }))
          if (stay) return resolve()
          const end = stands.find((c) => goal.isEnd(c))
          if (!end) return reject(Object.assign(new Error('No path to the goal!'), { name: 'NoPath' }))
          bot.pathfinder.goal = null
          bot.entity.position = end.offset(0.5, 0, 0.5)
          resolve()
        }, walkMs)
      })
    },
    // A seed's look aims at the top face of its plot.
    lookAt: async (aim) => {
      looks.push({ at: clock.now(), plot: key(aim.floored()) })
      onLook(looks.length, bot, env, key(aim.floored()))
    },
    equip: async (it) => {
      onEquip(++equips, bot, env)
      bot.quickBarSlot = it.slot - 36
    },
    activateBlock: async (b) => {
      const p = b.position
      const crop = p.offset(0, 1, 0)
      const plants = !ignore.includes(key(p)) && nameAt(p) === 'farmland' && nameAt(crop) === 'air' && bot.heldItem?.name === 'wheat_seeds'
      clicks.push(key(p))
      clickTimes.push(clock.now())
      clock.setTimeout(() => {
        bot.emit('blockUpdate', cellAt(p), cellAt(p))
        const was = cellAt(crop)
        if (plants) world.set(key(crop), 'wheat')
        bot.emit('blockUpdate', was, cellAt(crop))
        if (!plants) return
        server.planted++
        clock.setTimeout(() => setCount(inventory.slots[36].count - 1), 1)
      }, plants ? 30 : 45)
      onClick(clicks.length, job, world)
    }
  })
  Object.defineProperty(bot, 'heldItem', { get: () => inventory.slots[inventory.hotbarStart + bot.quickBarSlot] })
  clock.setInterval(() => { bot.time.age++; bot.emit('time') }, 50)
  const started = []
  if (replaced !== null) {
    const old = { id: 6, status: 'running' }
    started.push(old)
    clock.setTimeout(() => {
      if (inPlace) bot.pathfinder.setMovements(defaultMoves)
      old.status = 'cancelled'
    }, replaced)
  }
  let paces = 0
  let job = null
  let result
  let error
  let ended = null
  const env = {
    bot,
    Vec3,
    goals,
    shared,
    guardState: { hand: null },
    digLock: { holder: null },
    reflexes: combat ? [combat] : [],
    bunkerHolds: () => false,
    seesLit: lit,
    seenNow: lit,
    cellKnown: (c) => {
      if (clicks.length >= throwAfter) throw new Error('the world went away')
      return seen(c)
    },
    leafInTheWay: () => null,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    Date: { now: clock.now },
    POUR_REACH: botConstant('POUR_REACH'),
    SEED_ANSWER_MS: botConstant('SEED_ANSWER_MS'),
    SEED_ANSWER_CAP_MS: botConstant('SEED_ANSWER_CAP_MS'),
    SEED_DROP_MS: botConstant('SEED_DROP_MS'),
    SOW_BAND: botConstant('SOW_BAND'),
    stopPath: () => {
      log.push('stopPath')
      bot.pathfinder.goal = null
    },
    sowPace: (click) => {
      log.push('pace')
      onPace(++paces, job, world)
      return paced(click)
    },
    jobs: {
      start: (name, fn) => {
        for (const j of started) if (j.status === 'running') j.cancelled = true
        const own = job = { id: 7 + started.length, name, status: 'running', cancelled: false, note: '', progress: (msg) => { own.note = msg } }
        started.push(own)
        Promise.resolve().then(() => fn(own)).then((r) => { result = r }, (e) => { error = e }).finally(() => {
          own.status = 'done'
          ended = clock.now()
        })
        return { id: 7 }
      },
      list: () => started.map(({ id, status }) => ({ id, status }))
    },
    ok: (res, body) => { res.body = { ok: true, ...body } }
  }
  const { handle, res } = routeHandler('/sow', env)
  const step = async () => {
    await new Promise(setImmediate)
    clock.advance(10)
  }
  for (let run = 0; run < runs; run++) {
    job = null
    await handle({ query: { item: 'wheat_seeds', x: '1', z: '0', w: '3', d: '3', ...query } }, res)
    const own = job
    if (own && cancelAt !== null) clock.setTimeout(() => { own.cancelled = true }, cancelAt)
    const next = restartAt !== null && run < runs - 1 ? clock.now() + restartAt : Infinity
    while (own && own.status !== 'done' && clock.now() < Math.min(next, 120000)) await step()
  }
  while (started.some((j) => j.status === 'running' && 'note' in j) && clock.now() < 120000) await step()
  const { movements, thinkTimeout, goal } = bot.pathfinder
  // Counts the pending timers other than the age tick, after another ms on the clock.
  const timersAfter = async (ms) => {
    for (const end = clock.now() + ms; clock.now() < end;) await step()
    return clock.pending() - 1
  }
  return { reply: res.body, refusal: res.error, result: result && JSON.parse(JSON.stringify(result)), error, note: job ? job.note : '', ended, clicks, clickTimes, looks, moves, walks, plans, log, server, unseenReads, goal, after: { moves: movements.name, think: thinkTimeout }, timersAfter }
}

// A 3 by 3 bed of farmland beside the default feet.
const BED = Object.fromEntries([1, 2, 3].flatMap((x) => [0, 1, 2].map((z) => [`${x},63,${z}`, 'farmland'])))
const times = (list, k) => list.filter((c) => c === k).length

test('sow plants every plot of a flat bed once, one paced click each, and the server planted as many as it counts', async () => {
  const { reply, result, clicks, server, moves, log, note } = await sowJob({ blocks: BED })
  assert.deepStrictEqual(reply, { ok: true, job: 7 })
  assert.strictEqual(result.sown, 9)
  assert.strictEqual(server.planted, 9)
  assert.deepStrictEqual(clicks.slice().sort(), Object.keys(BED).sort())
  assert.strictEqual(times(log, 'pace'), 9)
  assert.deepStrictEqual(result, { sown: 9, occupied: 0, missed: [], refused: [], lost: [], unseen: 0, unseenAt: [], unreached: [], open: 0, left: 7 })
  assert.strictEqual(note, 'sown 9, occupied 0, missed 0, refused 0, lost 0, unseen 0, unreached 0, left 7')
  assert.deepStrictEqual(moves, [])
})

// Farmland two rows deep at y 65, 64 and 63 down along x, with a stand path at z -1 and the feet on stone at the top.
const TERRACES = { blocks: { '0,64,0': 'stone', '0,65,0': 'stone', '0,64,1': 'stone', '0,65,1': 'stone', '2,65,-1': 'stone', '4,64,-1': 'stone' }, stands: [new Vec3(2, 66, -1), new Vec3(4, 65, -1), new Vec3(6, 64, -1)], feet: new Vec3(0.5, 66, 0.5), query: { w: '6', d: '2' } }
for (const [x, y] of Object.entries({ 1: 65, 2: 65, 3: 64, 4: 64, 5: 63, 6: 63 })) {
  for (const z of [0, 1]) {
    TERRACES.blocks[`${x},${y},${z}`] = 'farmland'
    if (y === 65) TERRACES.blocks[`${x},64,${z}`] = 'stone'
  }
}

test('sow plants a terraced bed level by level from the highest, walking to stands on the paths beside it', async () => {
  const { result, clicks, server, log } = await sowJob(TERRACES)
  assert.strictEqual(result.sown, 12)
  assert.strictEqual(server.planted, 12)
  assert.deepStrictEqual(clicks.map((c) => Number(c.split(',')[1])), [65, 65, 65, 65, 64, 64, 64, 64, 63, 63, 63, 63])
  assert.strictEqual(new Set(clicks).size, 12)
  assert.ok(times(log, 'walk') >= 2, log.join(' '))
})

test('every sow walk keeps the movements the job found', async () => {
  const { result, walks, moves } = await sowJob(TERRACES)
  assert.strictEqual(result.sown, 12)
  assert.ok(walks.length >= 2, JSON.stringify(walks))
  assert.deepStrictEqual([moves, [...new Set(walks.map((w) => w.moves))]], [[], [DEFAULT]])
})

// One plot out of reach of the default feet and one stand beside it.
const FAR = { blocks: { '6,63,0': 'farmland' }, stands: [new Vec3(5, 64, 0)], query: { w: '6', d: '1' } }

test('a sow that replaced a job holding the forestry or cage movements plans its first walk once that job wound down and put the default ones back', async () => {
  for (const inPlace of ['forestry', 'cage']) {
    const { result, plans } = await sowJob({ ...FAR, replaced: 1000, inPlace })
    assert.deepStrictEqual([result.sown, plans.map((p) => [p.moves, p.at >= 1000])], [1, [[DEFAULT, true]]], inPlace)
  }
})

test('a sow waits 5 s at most for a replaced job that does not wind down, and not at all when it replaced none', async () => {
  const alone = await sowJob({ blocks: BED })
  const held = await sowJob({ blocks: BED, replaced: Infinity })
  assert.ok(alone.clickTimes[0] < 100, alone.clickTimes.join(' '))
  assert.ok(held.clickTimes[0] >= 5000 && held.clickTimes[0] < 5100, held.clickTimes.join(' '))
})

test('a sow cancelled while it waits for a replaced job stops waiting at once and clicks nothing', async () => {
  const { result, clicks, ended } = await sowJob({ blocks: BED, replaced: Infinity, cancelAt: 500 })
  assert.deepStrictEqual([clicks.length, result.stopped, ended < 600], [0, 'cancelled', true], String(ended))
})

test('no sow job sets or restores the pathfinder think budget', async () => {
  const { walks, after } = await sowJob({ ...TERRACES, think: 6000 })
  assert.ok(walks.length >= 2, JSON.stringify(walks))
  assert.deepStrictEqual([...new Set(walks.map((w) => w.think)), after.think], [6000, 6000])
})

test('a level no stand reaches costs two walks, lists all its plots in unreached, and the level below still gets planted', async () => {
  const blocks = { '1,63,0': 'farmland', '2,63,0': 'farmland', '3,63,0': 'farmland', '6,64,0': 'farmland', '7,64,0': 'farmland', '8,64,0': 'farmland' }
  const { result, log } = await sowJob({ blocks, query: { w: '8', d: '1' } })
  assert.deepStrictEqual([times(log, 'walk'), result.unreached.slice().sort(), result.sown], [2, ['6,64,0', '7,64,0', '8,64,0'], 3])
})

test('a level split by a wall has its near side planted and its far side listed in unreached after two walks', async () => {
  const blocks = { '1,63,0': 'farmland', '2,63,0': 'farmland', '5,63,0': 'farmland', '6,63,0': 'farmland', '8,64,0': 'stone', '8,65,0': 'stone', '10,63,0': 'farmland', '11,63,0': 'farmland' }
  const { result, clicks, log } = await sowJob({ blocks, stands: [new Vec3(4, 64, 1)], query: { w: '11', d: '1' } })
  assert.deepStrictEqual([clicks, result.unreached.slice().sort(), times(log, 'walk')], [['1,63,0', '2,63,0', '5,63,0', '6,63,0'], ['10,63,0', '11,63,0'], 3])
})

test('a sow walk that leaves no plot in reach lists only its own plot in unreached, and the next walk goes to the next plot of the level', async () => {
  const stand = new Vec3(12, 64, 1)
  const reaches = []
  const onWalk = (n, bot) => reaches.push(bot.pathfinder.goal.isEnd(stand))
  const { result, clicks } = await sowJob({ blocks: { '6,63,0': 'farmland', '11,63,0': 'farmland', '12,63,0': 'farmland' }, stands: [stand], onWalk, query: { w: '12', d: '1' } })
  assert.deepStrictEqual([result.unreached, clicks, reaches], [['6,63,0'], ['12,63,0', '11,63,0'], [false, true]])
})

test('a cancel during the pace gap before a click plants nothing more', async () => {
  const { result, clicks } = await sowJob({ blocks: BED, onPace: (n, job) => { if (n === 3) job.cancelled = true } })
  assert.deepStrictEqual([clicks.length, result.sown, result.stopped, result.open], [2, 2, 'cancelled', 7])
})

test('plots in reach gone out of lit sight stop sow with the sight refusal and stay open, listed nowhere', async () => {
  const dark = new Set()
  const fade = (n) => { if (n === 1) for (const z of [0, 1, 2]) dark.add(`3,63,${z}`) }
  const { result, clicks } = await sowJob({ blocks: BED, dark, onClick: fade })
  assert.deepStrictEqual([clicks.length, result.open, result.unreached, result.missed, result.lost], [6, 3, [], [], []])
  assert.match(result.stopped ?? '', /light it/)
})

test('sow counts a plot whose crop cell it sees taken as occupied and never clicks it', async () => {
  const { result, clicks } = await sowJob({ blocks: { ...BED, '2,64,1': 'wheat' } })
  assert.deepStrictEqual([result.occupied, result.sown, times(clicks, '2,63,1')], [1, 8, 0])
})

test('sow lists an ignored click in missed and never clicks that plot again', async () => {
  const { result, clicks } = await sowJob({ blocks: BED, ignore: ['2,63,1'] })
  assert.deepStrictEqual([result.missed, result.sown, times(clicks, '2,63,1')], [['2,63,1'], 8, 1])
})

test('sow lists a plot it sees turned to dirt in lost and never clicks it', async () => {
  const { result, clicks } = await sowJob({ blocks: BED, onClick: (n, job, world) => { if (n === 1) world.set('3,63,2', 'dirt') } })
  assert.deepStrictEqual([result.lost, result.sown, times(clicks, '3,63,2')], [['3,63,2'], 8, 0])
})

test('sow counts a column it never saw in unseen, reads none of its cells and names none in its reply or note', async () => {
  const column = [...Array(11).keys()].map((i) => `3,${59 + i},2`)
  const run = await sowJob({ blocks: BED, unseen: column })
  assert.deepStrictEqual([run.result.unseen, run.result.sown, run.unseenReads], [1, 8, []])
  const text = JSON.stringify([run.reply, run.result, run.note, run.error?.message ?? null])
  assert.doesNotMatch(text, /3,6\d,2/)
})

test('sow counts a column in unseen when the only cells it saw there are air', async () => {
  const run = await sowJob({ blocks: BED, unseen: ['3,60,2', '3,61,2', '3,62,2', '3,63,2'] })
  assert.deepStrictEqual([run.result.unseen, run.result.sown, run.unseenReads], [1, 8, []])
})

test('sow keeps the columns it planted out of unseen after a walk takes them out of sight', async () => {
  const hide = (n, bot, shared, hidden) => { for (const x of [1, 2, 3]) for (let y = 59; y <= 69; y++) hidden.add(`${x},${y},0`) }
  const { result, clicks } = await sowJob({ blocks: { '1,63,0': 'farmland', '2,63,0': 'farmland', '3,63,0': 'farmland', '6,63,0': 'farmland' }, stands: [new Vec3(5, 64, 0)], onWalk: hide, query: { w: '6', d: '1' } })
  assert.deepStrictEqual([clicks, result.sown, result.unseen], [['1,63,0', '2,63,0', '3,63,0', '6,63,0'], 4, 0])
})

test('sow lists its unseen columns as runs along x, then the rest as runs along z, each ordered by z and x', async () => {
  const columns = ['4,3', '5,3', '6,3', '6,1', '6,2', '4,1']
  const unseen = columns.flatMap((c) => { const [x, z] = c.split(','); return [...Array(11).keys()].map((i) => `${x},${59 + i},${z}`) })
  const { result } = await sowJob({ blocks: BED, unseen, query: { w: '6', d: '4' } })
  assert.deepStrictEqual([result.sown, result.unseen, result.unseenAt], [9, 6, ['4..6,3', '4,1', '6,1..2']])
})

test('sow tries a plot again after the guard reflex took the hand back before the click, and clicks it once', async () => {
  const swap = (n, bot) => { if (n === 1) bot.quickBarSlot = 1 }
  const { result, clicks, looks } = await sowJob({ blocks: BED, pockets: ['iron_sword'], onLook: swap })
  assert.deepStrictEqual([result.sown, result.missed, result.refused, result.stopped, clicks.length, new Set(clicks).size], [9, [], [], undefined, 9, 9])
  assert.strictEqual(looks[1].plot, looks[0].plot)
  assert.ok(looks[1].at - looks[0].at >= PLACE_GAP_MS, looks.map((l) => l.at).join(' '))
})

test('sow tries a plot again after another action took the hand lease and held its own item before the click', async () => {
  const take = (n, bot, env) => {
    if (n !== 1) return
    const { guardState, digLock, setTimeout, clearTimeout } = env
    loadBotFunctions(['holdHand'], { guardState, digLock, setTimeout, clearTimeout }).holdHand()
    bot.quickBarSlot = 1
  }
  const { result, clicks } = await sowJob({ blocks: BED, pockets: ['bread'], onLook: take })
  assert.deepStrictEqual([result.sown, result.missed, result.refused, result.stopped, clicks.length, new Set(clicks).size], [9, [], [], undefined, 9, 9])
})

// At the first look another action leases the hand and ends the lease holdMs later.
const takeHand = (holdMs, onEnd = () => {}) => (n, bot, env) => {
  if (n !== 1) return
  const { guardState, digLock, setTimeout, clearTimeout } = env
  const { holdHand, endHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState, digLock, setTimeout, clearTimeout })
  const lease = holdHand()
  const end = lease.end
  lease.end = () => {
    onEnd(env.Date.now())
    end()
  }
  bot.quickBarSlot = 1
  setTimeout(() => endHand(lease), holdMs)
}

test('sow tries a plot again only after the action that took the hand ended its lease', async () => {
  const ends = []
  const { result, clicks, looks } = await sowJob({ blocks: BED, pockets: ['bread'], onLook: takeHand(800, (t) => ends.push(t)) })
  assert.deepStrictEqual([ends.map((t) => t - looks[0].at), looks[1].at >= ends[0]], [[800], true])
  assert.deepStrictEqual([result.sown, result.refused, clicks.length, new Set(clicks).size, looks[1].plot], [9, [], 9, 9, looks[0].plot])
})

test('a sow retry leaves the hand to an action that let it go and took it again until that action ends its lease', async () => {
  const ends = []
  const take = (n, bot, env) => {
    if (n !== 1) return
    const { guardState, digLock, setTimeout, clearTimeout } = env
    const { holdHand, endHand } = loadBotFunctions(['holdHand', 'endHand'], { guardState, digLock, setTimeout, clearTimeout })
    const t0 = env.Date.now()
    const lease = () => {
      const held = holdHand()
      const end = held.end
      held.end = () => {
        ends.push(env.Date.now() - t0)
        end()
      }
      return held
    }
    const first = lease()
    bot.quickBarSlot = 1
    setTimeout(() => endHand(first), 20)
    setTimeout(() => {
      const second = lease()
      setTimeout(() => endHand(second), 1500)
    }, 50)
  }
  const { result, clicks, clickTimes, looks, timersAfter } = await sowJob({ blocks: BED, pockets: ['bread'], onLook: take })
  assert.deepStrictEqual([ends, looks[1].plot, clicks[0], clickTimes[0] - looks[0].at >= 1550], [[20, 1550], looks[0].plot, looks[0].plot, true])
  assert.deepStrictEqual([result.sown, result.refused, clicks.length, new Set(clicks).size], [9, [], 9, 9])
  assert.strictEqual(await timersAfter(3000), 0)
})

test('a cancel while sow waits for the hand to try a plot again ends it at once, with no click and no timer left', async () => {
  const { result, clicks, looks, ended, timersAfter } = await sowJob({ blocks: BED, pockets: ['bread'], onLook: takeHand(800), cancelAt: 400 })
  assert.deepStrictEqual([result.stopped, result.sown, clicks.length, looks.length], ['cancelled', 0, 0, 1])
  assert.ok(ended < 500, `ended at ${ended}`)
  assert.strictEqual(await timersAfter(3000), 0)
})

test('a sow started while a cancelled one waits for the hand clicks its first plot before the other action lets the hand go', async () => {
  const { result, clicks, clickTimes } = await sowJob({ blocks: BED, pockets: ['bread'], onLook: takeHand(1500), runs: 2, restartAt: 400 })
  assert.ok(clickTimes[0] >= 400 && clickTimes[0] < 600, clickTimes.join(' '))
  assert.deepStrictEqual([result.sown, new Set(clicks).size, clicks.length], [9, 9, 9])
})

test('sow tries a plot again after the equip of its seed threw', async () => {
  const fail = (n) => { if (n === 1) throw new Error('destination full') }
  const { result, clicks } = await sowJob({ blocks: BED, pockets: ['iron_sword'], hand: 1, onEquip: fail })
  assert.deepStrictEqual([result.sown, result.missed, result.refused, result.stopped, clicks.length, new Set(clicks).size], [9, [], [], undefined, 9, 9])
})

const TAKEN = 'the guard reflex took the hand back from the wheat_seeds (holding iron_sword), nothing planted, retry'
// The guard swaps the sword in at every look at one of the plots.
const swapAt = (plots) => (n, bot, env, plot) => { if (plots.includes(plot)) bot.quickBarSlot = 1 }

test('sow lists a plot in refused with its refusal after three refusals before its click, and plants the rest', async () => {
  const { result, clicks, looks } = await sowJob({ blocks: BED, pockets: ['iron_sword'], onLook: swapAt(['2,63,1']) })
  const tries = looks.filter((l) => l.plot === '2,63,1')
  assert.deepStrictEqual(result, { sown: 8, occupied: 0, missed: [], refused: [`2,63,1: ${TAKEN}`], lost: [], unseen: 0, unseenAt: [], unreached: [], open: 0, left: 8 })
  assert.deepStrictEqual([times(clicks, '2,63,1'), tries.length], [0, 3])
  assert.ok(tries.every((l, i) => i === 0 || l.at - tries[i - 1].at >= PLACE_GAP_MS), tries.map((l) => l.at).join(' '))
})

test('sow stops with the refusal after three plots in a row end in refused, and keeps what it did', async () => {
  const { result, clicks } = await sowJob({ blocks: BED, pockets: ['iron_sword'], onLook: swapAt(['1,63,0', '1,63,2', '2,63,1']) })
  assert.deepStrictEqual(result, { sown: 1, occupied: 0, missed: [], refused: ['1,63,0', '1,63,2', '2,63,1'].map((p) => `${p}: ${TAKEN}`), lost: [], unseen: 0, unseenAt: [], unreached: [], open: 5, left: 15, stopped: TAKEN })
  assert.deepStrictEqual(clicks, ['1,63,1'])
})

test('the note sow ends with counts the plots in refused', async () => {
  const { note } = await sowJob({ blocks: BED, pockets: ['iron_sword'], onLook: swapAt(['2,63,1']) })
  assert.strictEqual(note, 'sown 8, occupied 0, missed 0, refused 1, lost 0, unseen 0, unreached 0, left 8')
})

test('three plots in a row ending in refused as the last plots of the bed end sow without stopped', async () => {
  const { result } = await sowJob({ blocks: BED, pockets: ['iron_sword'], onLook: swapAt(['3,63,0', '3,63,1', '3,63,2']) })
  assert.deepStrictEqual([result.sown, result.refused.length, result.open, result.stopped], [6, 3, 0, undefined])
})

test('a plot found occupied between refused plots starts their count again, and a lost or unreached one does not', async () => {
  // The survey after pace 7 sees the change, while at pace 8 only the click on 2,63,1 does.
  const cases = [
    ['occupied', ['1,63,0', '1,63,2', '2,63,0', '2,63,2'], 7, (world) => world.set('2,64,1', 'wheat'), { occupied: 1, stopped: undefined }],
    ['lost', ['1,63,0', '1,63,2', '2,63,0'], 7, (world) => world.set('2,63,1', 'dirt'), { lost: ['2,63,1'], stopped: TAKEN }],
    ['unreached', ['1,63,0', '1,63,2', '2,63,0'], 8, (world) => world.set('2,64,1', 'wheat'), { unreached: ['2,63,1'], stopped: TAKEN }]
  ]
  for (const [name, refusing, at, change, want] of cases) {
    const onPace = (n, job, world) => { if (n === at) change(world) }
    const { result } = await sowJob({ blocks: BED, pockets: ['iron_sword'], onLook: swapAt(refusing), onPace })
    assert.deepStrictEqual(Object.keys(want).map((k) => result[k]), Object.values(want), name)
  }
})

test('a plot sown or missed between refused plots starts their count again', async () => {
  const refusing = ['1,63,0', '1,63,2', '2,63,0', '2,63,2']
  const cases = [
    ['sown', {}, 5, []],
    ['missed', { ignore: ['2,63,1'] }, 4, ['2,63,1']]
  ]
  for (const [name, opts, sown, missed] of cases) {
    const { result } = await sowJob({ blocks: BED, pockets: ['iron_sword'], onLook: swapAt(refusing), ...opts })
    assert.deepStrictEqual([result.sown, result.missed, result.refused.length, result.stopped, result.open], [sown, missed, 4, undefined, 0], name)
  }
})

test('a sole claim taken during the seed equip ends sow with its busy refusal and no second try', async () => {
  let equips = 0
  const claim = (n, bot, env) => {
    equips = n
    if (n > 1) return
    const held = env.digLock.holder = { what: 'the bunker build', sole: true }
    env.setTimeout(() => { if (env.digLock.holder === held) env.digLock.holder = null }, 300)
  }
  const { result, clicks, looks } = await sowJob({ blocks: BED, pockets: ['iron_sword'], hand: 1, onEquip: claim })
  assert.deepStrictEqual([equips, looks.length, clicks.length, result.refused, result.stopped], [1, 0, 0, [], 'busy: the bunker build is running, nothing planted'])
})

test('a sole claim or a fire pour holding the hand before a click ends sow with its busy refusal and no second try', async () => {
  const claim = (env) => { env.digLock.holder = { what: 'the bunker build', sole: true } }
  const pour = (env) => { env.guardState.hand = Object.assign(new Promise(() => {}), { owner: 'fire', end () {} }) }
  const cases = [
    ['a claim at the next plot', { onLook: (n, bot, env) => { if (n === 2) claim(env) } }, 2, /^busy: the bunker build is running/],
    ['a pour', { onLook: (n, bot, env) => { if (n === 2) pour(env) } }, 2, /pouring water on the fire/]
  ]
  for (const [name, opts, clicked, refusal] of cases) {
    const { result, clicks, looks } = await sowJob({ blocks: BED, ...opts })
    assert.deepStrictEqual([clicks.length, looks.length, result.missed], [clicked, clicked, []], name)
    assert.match(result.stopped ?? '', refusal, name)
  }
})

test('a fight before a click ends sow with the fighting refusal and no second try', async () => {
  let fighting = false
  const combat = { name: 'combat', fightBusy: () => fighting, _threat: null }
  const { result, clicks, looks } = await sowJob({ blocks: BED, combat, onClick: (n) => { if (n === 2) fighting = true } })
  assert.deepStrictEqual([clicks.length, looks.length, result.sown, result.missed], [2, 2, 2, []])
  assert.match(result.stopped ?? '', /^refused: fighting/)
})

test('a refusal after the click went out ends sow and that plot gets no second click', async () => {
  const { result, clicks } = await sowJob({ blocks: BED, onClick: (n) => { if (n === 2) throw new Error('the connection broke after the click') } })
  assert.deepStrictEqual([clicks.length, new Set(clicks).size, result.sown, result.missed, result.stopped], [2, 2, 1, [], 'the connection broke after the click'])
})

// 6,63,0 lies out of reach of the default feet.
const ROW = { '1,63,0': 'farmland', '2,63,0': 'farmland', '3,63,0': 'farmland', '6,63,0': 'farmland' }

test('sow lists a plot whose stands lie in water or behind a wall in unreached and plants the rest', async () => {
  const blocks = { '1,63,0': 'farmland', '2,63,0': 'farmland', '3,63,0': 'farmland', '5,63,0': 'farmland', '4,63,0': 'water', '5,64,1': 'stone', '5,65,1': 'stone' }
  const stands = [new Vec3(4, 63, 0), new Vec3(5, 64, 2)]
  const { result, clicks } = await sowJob({ blocks, stands, query: { w: '5', d: '1' } })
  assert.deepStrictEqual([result.unreached, result.sown, result.unseen, times(clicks, '5,63,0')], [['5,63,0'], 3, 0, 0])
})

test('sow clears the goal of a walk that ended without arriving and lists its plot in unreached', async () => {
  const { result, log, goal } = await sowJob({ blocks: ROW, query: { w: '6', d: '1' }, stay: true })
  assert.deepStrictEqual([result.unreached, goal, times(log, 'walk')], [['6,63,0'], null, 1])
  assert.strictEqual(log[log.indexOf('walk') + 1], 'stopPath')
})

test('a lit fuse refusing the walk to a higher plot lists it nowhere, the plots below in reach get planted, and the fuse ends the job', async () => {
  const { result, clicks } = await sowJob({ blocks: { ...ROW, '6,63,0': 'stone', '6,64,0': 'farmland' }, query: { w: '6', d: '1' }, fuse: true })
  assert.deepStrictEqual([result.sown, result.unreached, times(clicks, '6,64,0')], [3, [], 0])
  assert.match(result.stopped, /fuse/)
})

test('sow ends with stopped once the last seed is planted and counts the plots left open', async () => {
  const { result, server } = await sowJob({ blocks: BED, count: 4 })
  assert.deepStrictEqual([result.sown, server.planted, result.left, result.stopped, result.open], [4, 4, 0, 'out of wheat_seeds', 5])
})

test('a cancel ends sow between plots and counts the plots left open', async () => {
  const { result, clicks } = await sowJob({ blocks: BED, onClick: (n, job) => { if (n === 2) job.cancelled = true } })
  assert.deepStrictEqual([result.sown, clicks.length, result.stopped, result.open], [2, 2, 'cancelled', 7])
})

test('a sow job started after a cancelled one clicks no sooner than the placement gap after the last click of the old one', async () => {
  const { clicks, clickTimes } = await sowJob({ blocks: BED, runs: 2, onClick: (n, job) => { if (n === 2) job.cancelled = true } })
  assert.strictEqual(new Set(clicks).size, 9)
  assert.ok(clickTimes[2] - clickTimes[1] >= PLACE_GAP_MS, clickTimes.join(' '))
})

test('a sow job that throws ends with its error after one click and sets no movements', async () => {
  const { error, moves, clicks } = await sowJob({ blocks: BED, throwAfter: 1 })
  assert.match(error?.message ?? '', /the world went away/)
  assert.deepStrictEqual([clicks.length, moves], [1, []])
})

test('sow refuses a rectangle side over 16 and an item it does not carry, and starts no job', async () => {
  for (const query of [{ w: '17' }, { d: '0' }, { item: 'carrot' }]) {
    const { refusal, reply, moves } = await sowJob({ blocks: BED, query })
    assert.ok(refusal && !reply, JSON.stringify(query))
    assert.deepStrictEqual(moves, [], JSON.stringify(query))
  }
})

test('sow refuses a carried item that is planted on no block, naming it, and starts no job', async () => {
  const { refusal, reply, moves } = await sowJob({ blocks: BED, held: 'stone', query: { item: 'stone' } })
  assert.deepStrictEqual([reply, moves], [undefined, []])
  assert.match(refusal?.message ?? '', /\bstone\b/)
})
