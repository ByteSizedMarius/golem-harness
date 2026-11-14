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

const FIELD = 'field'
const CONSIDERATE = 'considerate'

const PACE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pace.js'), 'utf8')
// The pacePlacements of lib/pace.js on a fake clock.
const pacedOn = (clock) => vm.runInNewContext(`${PACE_SOURCE}\npacePlacements`, { module: {}, setTimeout: clock.setTimeout, Date: { now: clock.now } })
const { PLACE_GAP_MS } = require('../lib/pace')

// Runs /sow `runs` times on a fake clock over stone below y 64 and air above, with blocks keyed by 'x,y,z'.
async function sowJob ({ query = {}, blocks = {}, feet = new Vec3(0.5, 64, 1.5), held = 'wheat_seeds', count = 16, unseen = [], dark = new Set(), ignore = [], stands = [], stay = false, fuse = false, onClick = () => {}, onPace = () => {}, onWalk = () => {}, throwAfter = Infinity, runs = 1, walkMs = 100, think = 10000, replaced = null } = {}) {
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
  const log = []
  const server = { planted: 0 }
  const inventory = Object.assign(new EventEmitter(), { hotbarStart: 36, slots: [], items: () => inventory.slots.filter(Boolean) })
  inventory.slots[36] = { name: held, count, slot: 36 }
  const setCount = (n) => {
    const old = inventory.slots[36]
    inventory.slots[36] = n ? { name: held, count: n, slot: 36 } : null
    inventory.emit('updateSlot', 36, old, inventory.slots[36])
  }
  const getBlock = (c) => (seen(c) ? {} : { name: 'unknown' })
  const shared = { fieldMoves: { name: FIELD, getBlock }, considerateMoves: { name: CONSIDERATE, getBlock } }
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: feet, width: 0.6, height: 1.8 },
    inventory,
    quickBarSlot: 0,
    time: { age: 0 },
    blockAt: (c) => {
      if (!seen(c)) unseenReads.push(key(c))
      return cellAt(c)
    },
    pathfinder: {
      goal: null,
      movements: shared.considerateMoves,
      thinkTimeout: think,
      setMovements: (m) => {
        moves.push(m.name)
        bot.pathfinder.movements = m
      },
      startCell: (pos) => pos.floored(),
      goto: (goal) => new Promise((resolve, reject) => {
        bot.pathfinder.goal = goal
        log.push('walk')
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
    lookAt: async () => {},
    equip: async (it) => { bot.quickBarSlot = it.slot - 36 },
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
      bot.pathfinder.setMovements(shared.considerateMoves)
      old.status = 'cancelled'
    }, replaced)
  }
  let paces = 0
  let job = null
  let result
  let error
  let done = false
  const env = {
    bot,
    Vec3,
    goals,
    shared,
    guardState: { hand: null },
    reflexes: [],
    seesLit: lit,
    seenNow: lit,
    cellKnown: (c) => {
      if (clicks.length >= throwAfter) throw new Error('the world went away')
      return seen(c)
    },
    leafInTheWay: () => null,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
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
      onPace(++paces, job)
      return paced(click)
    },
    jobs: {
      start: (name, fn) => {
        const own = job = { id: 7 + started.length, name, status: 'running', cancelled: false, notes: [], progress: (msg) => own.notes.push(msg) }
        started.push(own)
        Promise.resolve().then(() => fn(own)).then((r) => { result = r }, (e) => { error = e }).finally(() => {
          own.status = 'done'
          done = true
        })
        return { id: 7 }
      },
      list: () => started.map(({ id, status }) => ({ id, status }))
    },
    ok: (res, body) => { res.body = { ok: true, ...body } }
  }
  const { handle, res } = routeHandler('/sow', env)
  for (let run = 0; run < runs; run++) {
    job = null
    done = false
    await handle({ query: { item: 'wheat_seeds', x: '1', z: '0', w: '3', d: '3', ...query } }, res)
    while (job && !done && clock.now() < 120000) {
      await new Promise(setImmediate)
      clock.advance(10)
    }
  }
  const { movements, thinkTimeout, goal } = bot.pathfinder
  return { reply: res.body, refusal: res.error, result: result && JSON.parse(JSON.stringify(result)), error, notes: job ? job.notes : [], clicks, clickTimes, moves, walks, log, server, unseenReads, goal, after: { moves: movements.name, think: thinkTimeout } }
}

// A 3 by 3 bed of farmland beside the default feet.
const BED = Object.fromEntries([1, 2, 3].flatMap((x) => [0, 1, 2].map((z) => [`${x},63,${z}`, 'farmland'])))
const times = (list, k) => list.filter((c) => c === k).length

test('sow plants every plot of a flat bed once, one paced click each, and the server planted as many as it counts', async () => {
  const { reply, result, clicks, server, moves, log, notes } = await sowJob({ blocks: BED })
  assert.deepStrictEqual(reply, { ok: true, job: 7 })
  assert.strictEqual(result.sown, 9)
  assert.strictEqual(server.planted, 9)
  assert.deepStrictEqual(clicks.slice().sort(), Object.keys(BED).sort())
  assert.strictEqual(times(log, 'pace'), 9)
  assert.deepStrictEqual(result, { sown: 9, occupied: 0, missed: [], lost: [], unseen: 0, unreached: [], open: 0, left: 7 })
  assert.strictEqual(notes[notes.length - 1], 'sown 9, occupied 0, missed 0, lost 0, unseen 0, unreached 0, left 7')
  assert.deepStrictEqual(moves, [FIELD, CONSIDERATE])
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

test('every sow walk plans with the field movements, also after the cleanup of a replaced job reset them between walks', async () => {
  const putBack = (n, bot, shared) => bot.pathfinder.setMovements(shared.considerateMoves)
  const { result, walks } = await sowJob({ ...TERRACES, onWalk: putBack })
  assert.strictEqual(result.sown, 12)
  assert.ok(walks.length >= 2, JSON.stringify(walks))
  assert.deepStrictEqual(walks.filter((w) => w.moves !== FIELD), [])
})

// 6,63,0 lies out of reach of the default feet.
const FAR = { blocks: { '6,63,0': 'farmland' }, stands: [new Vec3(5, 64, 0)], query: { w: '6', d: '1' } }

test('a sow that replaced a job waits for it to wind down before it sets the field movements', async () => {
  const { result, walks } = await sowJob({ ...FAR, walkMs: 2000, replaced: 1000 })
  assert.deepStrictEqual([result.sown, walks.map((w) => w.moves)], [1, [FIELD]])
})

test('a sow waits 5 s at most for a replaced job that does not wind down, and not at all when it replaced none', async () => {
  const alone = await sowJob({ blocks: BED })
  const held = await sowJob({ blocks: BED, replaced: Infinity })
  assert.ok(alone.clickTimes[0] < 100, alone.clickTimes.join(' '))
  assert.ok(held.clickTimes[0] >= 5000 && held.clickTimes[0] < 5100, held.clickTimes.join(' '))
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

test('sow counts a column it never saw in unseen, reads none of its cells and names none in its reply or notes', async () => {
  const column = [...Array(11).keys()].map((i) => `3,${59 + i},2`)
  const run = await sowJob({ blocks: BED, unseen: column })
  assert.deepStrictEqual([run.result.unseen, run.result.sown, run.unseenReads], [1, 8, []])
  const text = JSON.stringify([run.reply, run.result, run.notes, run.error?.message ?? null])
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

test('two sow jobs in a row each walk with the field movements and leave the default movements', async () => {
  const { moves, walks, after } = await sowJob({ blocks: ROW, query: { w: '6', d: '1' }, runs: 2 })
  assert.deepStrictEqual(moves, [FIELD, CONSIDERATE, FIELD, CONSIDERATE])
  assert.deepStrictEqual(walks.map((w) => w.moves), [FIELD, FIELD])
  assert.strictEqual(after.moves, CONSIDERATE)
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

test('a collect that started on the field movements puts the default movements back once their sow has ended', async () => {
  const restored = async (sowEnds) => {
    const shared = { mcData: { blocksArray: [] }, fieldMoves: { name: FIELD }, considerateMoves: { name: CONSIDERATE }, fieldOwner: {} }
    const bot = {
      on () {},
      removeListener () {},
      tool: {},
      collectBlock: { movements: null, async collect () { if (sowEnds) shared.fieldOwner = null } },
      pathfinder: { movements: shared.fieldMoves, setMovements (m) { bot.pathfinder.movements = m } }
    }
    class Movements { constructor () { this.openable = new Set() } }
    const env = { bot, Movements, shared, knownMoves: (m) => m, watchedWork: (work) => work(), pastUnstuck: (walk) => walk(), abandonCollect () {}, collectLock: botConstant('collectLock'), digLock: botConstant('digLock'), holdCollectTool: async () => {}, digToolFor: () => null }
    await loadBotFunctions(['collectSafely'], env).collectSafely({ type: 7, name: 'coal_ore', shapes: [[0, 0, 0, 1, 1, 1]] }, 'mine coal_ore')
    return bot.pathfinder.movements.name
  }
  assert.deepStrictEqual([await restored(true), await restored(false)], [CONSIDERATE, FIELD])
})

test('sow puts the default movements back after a job that threw', async () => {
  const { error, moves, clicks } = await sowJob({ blocks: BED, throwAfter: 1 })
  assert.match(error?.message ?? '', /the world went away/)
  assert.deepStrictEqual([clicks.length, moves], [1, [FIELD, CONSIDERATE]])
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
