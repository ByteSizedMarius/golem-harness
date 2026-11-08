'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals, Movements, startCell } = require('mineflayer-pathfinder')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const Item = require('prismarine-item')(registry)
const { botConstant, claimRescue, routeHandler, routeJobs } = require('./helpers')
const { entityInCell } = require('../lib/shelter')

const inLake = (c) => c.x >= 1 && c.x <= 12 && c.z >= -4 && c.z <= 4
function ground (c) {
  if (inLake(c)) return c.y <= 61 ? 'stone' : c.y <= 63 ? 'water' : 'air'
  return c.y <= 63 ? 'stone' : 'air'
}

// The mock pathfinder moves the body to the goal's stand cell nearest it, with walk 'empty' nowhere. A cell in blocks holds a name or [name, properties].
function lakeWorld (feet, dirt, { hidden, blocks, walk, onGround = true, carried = [] }) {
  const cells = new Map([...dirt.map((p) => [`${p.x},${p.y},${p.z}`, 'dirt']), ...Object.entries(blocks)])
  const blockAt = (p) => {
    const c = p.floored()
    const cell = cells.get(`${c.x},${c.y},${c.z}`) || ground(c)
    const [name, properties] = Array.isArray(cell) ? cell : [cell]
    const block = properties ? Block.fromProperties(registry.blocksByName[name].id, properties, 0) : Block.fromStateId(registry.blocksByName[name].defaultState, 0)
    return Object.assign(block, { position: c })
  }
  const solid = (c) => blockAt(c).boundingBox === 'block'
  const log = { digs: [], stops: 0 }
  const pocket = { name: 'dirt', count: 0 }
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: feet, width: 0.6, height: 1.8, onGround },
    heldItem: null,
    inventory: { items: () => [pocket, ...carried] },
    waitForTicks: async () => {},
    blockAt,
    findBlocks: ({ matching }) => [...cells.keys()].map((k) => new Vec3(...k.split(',').map(Number)))
      .filter((p) => typeof matching === 'function' ? matching(blockAt(p)) : matching.includes(blockAt(p).type)),
    world: {
      // The ray passes through water.
      raycast (from, dir, range) {
        for (let d = 0; d <= range; d += 0.02) {
          const c = from.plus(dir.scaled(d)).floored()
          if (solid(c)) return { position: c, face: 1 }
        }
        return null
      }
    },
    pathfinder: {
      goal: null,
      movements: new Movements({ registry }),
      startCell: (pos) => startCell(bot, pos),
      async goto (goal) {
        // The walk ends at once where the goal holds at the floored cell, which clears the goal, or at the planner's start node, an empty path that keeps it.
        const here = bot.entity.position
        if (goal.isEnd(here.floored())) return
        if (goal.isEnd(bot.pathfinder.startCell(here)) || walk === 'empty') { bot.pathfinder.goal = goal; return }
        const ends = []
        for (let x = -12; x <= 12; x++) {
          for (let y = 60; y <= 66; y++) {
            for (let z = -6; z <= 6; z++) {
              const c = new Vec3(x, y, z)
              if (!solid(c) && !solid(c.offset(0, 1, 0)) && solid(c.offset(0, -1, 0)) && goal.isEnd(c)) ends.push(c)
            }
          }
        }
        const away = (c) => here.distanceTo(c.offset(0.5, 0, 0.5))
        const end = ends.sort((a, b) => away(a) - away(b))[0]
        // The pathfinder keeps a goal it found no path to.
        if (!end || walk === 'noPath') { bot.pathfinder.goal = goal; throw new Error('No path to the goal!') }
        bot.entity.position = end.offset(0.5, 0, 0.5)
      }
    },
    async dig (b) {
      log.digs.push({ at: `${b.position.x},${b.position.y},${b.position.z}`, head: blockAt(bot.entity.position.offset(0, 1, 0)).name })
      cells.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air')
      pocket.count++
    }
  })
  const env = {
    bot,
    require,
    goals,
    entityInCell,
    shared: { mcData: registry, forestryMoves: null },
    // The exact block, else every block holding it as whole _-separated words.
    resolveBlockIds: (name) => registry.blocksByName[name] ? [registry.blocksByName[name].id] : Object.values(registry.blocksByName).filter((b) => `_${b.name}_`.includes(`_${name}_`)).map((b) => b.id),
    emitEvent () {},
    seesLit: () => true,
    leafInTheWay: () => null,
    cellKnown: () => true,
    seenNow: (p) => !hidden.includes(`${p.x},${p.y},${p.z}`),
    GATHER_MAX_DROP: 2,
    GATHER_MAX_RISE: 4,
    PICK_TIER: botConstant('PICK_TIER'),
    LEGACY_1710: false,
    digLock: botConstant('digLock'),
    digScope: new AsyncLocalStorage(),
    LEGACY_DIG_CONFIRM_MS: botConstant('LEGACY_DIG_CONFIRM_MS'),
    legs: { mark: () => 0 },
    bunker: { building: false },
    watchedWork: (work) => work(),
    pastUnstuck: (walk) => walk(),
    stopPath () { log.stops++; bot.pathfinder.goal = null },
    centerOnCell: async () => true,
    canStepOutTo: () => false,
    collectSafely: async (b) => {
      await bot.pathfinder.goto(new goals.GoalLookAtBlock(b.position, bot.world))
      await bot.dig(b)
    }
  }
  return { env, log }
}

async function gather (feet, dirt, { amount = 1, hidden = [], blocks = {}, walk, onGround, carried, query = {} } = {}) {
  const w = lakeWorld(feet, dirt, { hidden, blocks, walk, onGround, carried })
  let job = null
  const progress = []
  w.env.jobs = { start: (name, fn) => { job = fn({ name, cancelled: false, progress: (m) => progress.push(m) }); return { id: 1 } } }
  const { handle, res } = routeHandler('/gather', w.env)
  handle({ query: { resource: 'dirt', amount: String(amount), ...query } }, res)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { result: await job, goal: w.env.bot.pathfinder.goal, progress, ...w.log }
}

// The body stands on the shore, two cells from the water.
const SHORE = new Vec3(-1.5, 64, 0.5)

const LAKEBED = new Vec3(2, 62, 0)

test('gather passes over dirt on the lakebed for dry dirt farther away and says what it left under water', async () => {
  const r = await gather(SHORE, [LAKEBED, new Vec3(-6, 63, 0)], { amount: 2 })
  assert.deepStrictEqual(r.digs, [{ at: '-6,63,0', head: 'air' }])
  assert.strictEqual(r.result.gathered, 1)
  assert.match(r.result.reason, /1 seen under water/)
})

test('gather with only lakebed dirt in sight digs nothing and says it lies under water', async () => {
  const r = await gather(SHORE, [LAKEBED])
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.result.ok, false)
  assert.match(r.result.reason, /1 seen under water/)
})

test('gather digs shore dirt beside the water from dry land when the body swims beside it', async () => {
  const r = await gather(new Vec3(2.5, 62, 0.5), [new Vec3(0, 63, 0)])
  assert.deepStrictEqual(r.digs, [{ at: '0,63,0', head: 'air' }])
  assert.strictEqual(r.result.gathered, 1)
})

test('gather leaves an island of dirt it can reach only with its head under water', async () => {
  const r = await gather(SHORE, [new Vec3(7, 63, 0)])
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.result.ok, false)
})

test('gather reads water it does not see over a block as dry and never counts it', async () => {
  const r = await gather(SHORE, [LAKEBED], { hidden: ['2,63,0'] })
  assert.deepStrictEqual(r.digs, [{ at: '2,62,0', head: 'air' }])
  assert.strictEqual(r.result.reason, undefined)
})

// The body stands on the lakebed with its head under water.
const BESIDE_ISLAND = new Vec3(6.5, 62, 0.5)
const ISLAND = new Vec3(7, 63, 0)

test('gather never digs an island from the water when the walk to it ends where it started, and drops that walk\'s goal', async () => {
  const r = await gather(BESIDE_ISLAND, [ISLAND], { walk: 'empty' })
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.result.ok, false)
  assert.ok(r.progress.includes('skip @ 7,63,0: the walk ended out of reach of it (spots with my head under water don\'t count)'), r.progress.join('\n'))
  assert.strictEqual(r.goal, null)
})

test('gather digs dirt in reach of the slab the body stands on', async () => {
  const r = await gather(new Vec3(0.5, 64.5, 0.5), [new Vec3(1, 66, 0)], { blocks: { '0,64,0': 'smooth_stone_slab', '1,67,0': 'stone' } })
  assert.deepStrictEqual(r.digs, [{ at: '1,66,0', head: 'air' }])
})

test('gather digs pit dirt in reach from the farmland cell the body stands in but not from the cell above it', async () => {
  const r = await gather(new Vec3(0.5, 64.9375, 0.5), [new Vec3(-3, 62, 0)], { blocks: { '0,64,0': 'farmland', '-1,63,0': 'air', '-2,63,0': 'air', '-3,63,0': 'air' } })
  assert.deepStrictEqual(r.digs, [{ at: '-3,62,0', head: 'air' }])
})

// Dirt in reach of a walk that starts one cell above the body, not of one that starts in the body's cell.
const ABOVE_ONLY = new Vec3(-3, 67, -3)
const SKIP_ABOVE_ONLY = 'skip @ -3,67,-3: the walk ended out of reach of it (spots with my head under water don\'t count)'

test('gather plans from the snow cell the body stands in, as the pathfinder does, and leaves dirt in reach only from above it', async () => {
  const r = await gather(new Vec3(0.5, 64.25, 0.5), [ABOVE_ONLY], { blocks: { '0,64,0': ['snow', { layers: 3 }] }, walk: 'empty' })
  assert.deepStrictEqual(r.digs, [])
  assert.ok(r.progress.includes(SKIP_ABOVE_ONLY), r.progress.join('\n'))
})

test('gather plans from the ladder cell the body stands in at its floor and leaves dirt in reach only from above it', async () => {
  const r = await gather(new Vec3(0.5, 64, 0.5), [ABOVE_ONLY], { blocks: { '0,64,0': 'ladder' }, walk: 'empty' })
  assert.deepStrictEqual(r.digs, [])
  assert.ok(r.progress.includes(SKIP_ABOVE_ONLY), r.progress.join('\n'))
})

test('gather plans from the slab cell the body is in while off the ground and from the cell above it on the ground', async () => {
  const at = new Vec3(0.5, 64.5, 0.5)
  const slab = { '0,64,0': 'smooth_stone_slab' }
  assert.deepStrictEqual((await gather(at, [ABOVE_ONLY], { blocks: slab, walk: 'empty' })).digs, [{ at: '-3,67,-3', head: 'air' }], 'control: on the ground')
  const r = await gather(at, [ABOVE_ONLY], { blocks: slab, walk: 'empty', onGround: false })
  assert.deepStrictEqual(r.digs, [])
  assert.ok(r.progress.includes(SKIP_ABOVE_ONLY), r.progress.join('\n'))
})

// A cobblestone wall runs along x 0, and the body at 0.0125,64,0.5 touches its west side.
const WALL = Object.fromEntries([-2, -1, 0, 1, 2].map((z) => [`0,64,${z}`, ['cobblestone_wall', { up: 'false', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }]]))

test('gather digs dirt in reach of the cell the pathfinder starts from beside a wall the body touches', async () => {
  const r = await gather(new Vec3(0.0125, 64, 0.5), [new Vec3(-5, 63, 0)], { blocks: WALL })
  assert.deepStrictEqual(r.digs, [{ at: '-5,63,0', head: 'air' }])
})

const stoneSilkPick = () => Object.assign(Item.fromNotch({
  itemId: registry.itemsByName.stone_pickaxe.id,
  itemCount: 1,
  components: [{ type: 'enchantments', data: { enchantments: [{ id: registry.enchantmentsByName.silk_touch.id, level: 1 }] } }],
  removeComponents: []
}), { slot: 36 })

test('gather with silk names the silk refusal and the ore under water when the only ore it can dig dry is refused for it', async () => {
  const r = await gather(SHORE, [], { blocks: { '-6,63,0': 'diamond_ore', '2,62,0': 'coal_ore' }, carried: [stoneSilkPick()], query: { resource: 'ore', silk: '1' } })
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.result.reason, 'refusing to dig diamond_ore: the stone_pickaxe with silk touch does not harvest it, 1 refused for silk touch, 1 ore seen under water (gathered 0/1)')
})

test('gather with silk never counts ore under water that the silk touch pick does not harvest', async () => {
  const r = await gather(SHORE, [], { blocks: { '-6,63,0': 'diamond_ore', '2,62,0': 'diamond_ore' }, carried: [stoneSilkPick()], query: { resource: 'diamond_ore', silk: '1' } })
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.result.reason, 'refusing to dig diamond_ore: the stone_pickaxe with silk touch does not harvest it, 1 refused for silk touch (gathered 0/1)')
})

test('gather with silk names both the ore refused for silk touch and the ore it could not reach', async () => {
  const r = await gather(SHORE, [], { blocks: { '-6,63,0': 'diamond_ore', '-10,63,0': 'coal_ore' }, walk: 'noPath', carried: [stoneSilkPick()], query: { resource: 'ore', silk: '1' } })
  assert.deepStrictEqual(r.digs, [])
  assert.ok(r.progress.includes('skip @ -6,63,0: refusing to dig diamond_ore: the stone_pickaxe with silk touch does not harvest it'), r.progress.join('\n'))
  assert.strictEqual(r.result.reason, 'no ore left that I can dig, 1 refused for silk touch and the rest unreachable or failed (gathered 0/1)')
})

test('gather with silk names the ore refused for silk touch beside the ore it could not reach and the ore under water', async () => {
  const r = await gather(SHORE, [], { blocks: { '-6,63,0': 'diamond_ore', '-10,63,0': 'coal_ore', '2,62,0': 'coal_ore' }, walk: 'noPath', carried: [stoneSilkPick()], query: { resource: 'ore', silk: '1' } })
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.result.reason, 'no ore among the nearest I see that I can dig without diving, 1 seen under water, 1 refused for silk touch (gathered 0/1)')
})

test('gather leaves bank dirt under grass whose only open face looks onto the water', async () => {
  const r = await gather(SHORE, [new Vec3(0, 63, 0)], { blocks: { '0,64,0': 'grass_block' } })
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.result.ok, false)
})

test('gather skips a target with no leaf beside it at once when its look walk fails, with no walk near it', async () => {
  const w = lakeWorld(SHORE, [new Vec3(0, 63, 0)], { hidden: [], blocks: { '0,64,0': 'grass_block' } })
  const walks = []
  const goto = w.env.bot.pathfinder.goto
  w.env.bot.pathfinder.goto = (goal) => { walks.push(goal); return goto(goal) }
  let job = null
  const progress = []
  w.env.jobs = { start: (name, fn) => { job = fn({ name, cancelled: false, progress: (m) => progress.push(m) }); return { id: 1 } } }
  const { handle, res } = routeHandler('/gather', w.env)
  handle({ query: { resource: 'dirt', amount: '1' } }, res)
  assert.strictEqual((await job).gathered, 0)
  assert.strictEqual(walks.length, 1)
  assert.ok(progress.some((m) => m.startsWith('skip unreachable @ 0,63,0: ')), progress.join('\n'))
})

test('gather passes over dirt whose walk a lit fuse refused, digs it on a later pass, and names the fuse when nothing else is left', async () => {
  const FUSE = 'refused: a fuse hissed W ~5 and this walk closes on it, the guard stays up. Walk away from it, or walk again once the fuse is out.'
  // refuses(n) tells whether the nth goto is refused for the fuse.
  const run = async (dirt, amount, refuses) => {
    const w = lakeWorld(SHORE, dirt, { hidden: [], blocks: {} })
    const goto = w.env.bot.pathfinder.goto
    let n = 0
    w.env.bot.pathfinder.goto = (goal) => refuses(n++) ? Promise.reject(Object.assign(new Error(FUSE), { reason: 'fuse' })) : goto(goal)
    let job = null
    const progress = []
    w.env.jobs = { start: (name, fn) => { job = fn({ name, cancelled: false, progress: (m) => progress.push(m) }); return { id: 1 } } }
    const { handle, res } = routeHandler('/gather', w.env)
    handle({ query: { resource: 'dirt', amount: String(amount) } }, res)
    return { result: await job, digs: w.log.digs.map((d) => d.at), progress }
  }
  const later = await run([new Vec3(-6, 63, 3), new Vec3(-10, 63, 0)], 2, (n) => n === 0)
  assert.deepStrictEqual([later.result.gathered, later.digs], [2, ['-10,63,0', '-6,63,3']], later.progress.join('\n'))
  assert.ok(later.progress.includes(`skip for now @ -6,63,3: ${FUSE}`), later.progress.join('\n'))
  const alone = await run([new Vec3(-6, 63, 0)], 1, () => true)
  assert.deepStrictEqual([alone.result.gathered, alone.result.reason], [0, `${FUSE} (gathered 0/1)`])
})

test('gather walks past a cell beside dirt under grass that cannot see it to one that sees its open face', async () => {
  const r = await gather(SHORE, [new Vec3(-6, 63, 0)], { blocks: { '-6,64,0': 'grass_block', '-7,63,0': 'air', '-8,63,0': 'air' } })
  assert.deepStrictEqual(r.digs, [{ at: '-6,63,0', head: 'air' }])
})

test('gather stops the pathfinder when the walk to a target fails', async () => {
  const r = await gather(SHORE, [new Vec3(-10, 63, 0)], { walk: 'noPath' })
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.stops, 1)
  assert.strictEqual(r.goal, null)
})

// A gather of the nearer of two shore dirt blocks whose walks run walk(goal, job, goto), goto being the rig's own walk.
async function cancelledGather (walk) {
  const w = lakeWorld(SHORE, [new Vec3(-6, 63, 0), new Vec3(-8, 63, 0)], { hidden: [], blocks: {} })
  const job = { name: 'gather dirt x1', cancelled: false, progress () {} }
  const seen = { walks: 0, collects: 0 }
  const goto = w.env.bot.pathfinder.goto
  w.env.bot.pathfinder.goto = async (goal) => { seen.walks++; await walk(goal, job, goto) }
  const collect = w.env.collectSafely
  w.env.collectSafely = async (b) => { seen.collects++; await collect(b) }
  let run = null
  w.env.jobs = { start: (name, fn) => { run = fn(job); return { id: 1 } } }
  const { handle, res } = routeHandler('/gather', w.env)
  handle({ query: { resource: 'dirt', amount: '1' } }, res)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  return { result: await run, ...seen, ...w.log }
}

test('a gather whose walk a /stop cuts short walks nowhere else and ends cancelled', async () => {
  const r = await cancelledGather(async (goal, job) => {
    job.cancelled = true
    throw new Error('Path was stopped before it could be completed!')
  })
  assert.strictEqual(r.walks, 1)
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.result.reason, 'cancelled')
})

test('a gather cancelled by the end of a walk that arrived digs nothing', async () => {
  const r = await cancelledGather(async (goal, job, goto) => {
    await goto(goal)
    job.cancelled = true
  })
  assert.strictEqual(r.collects, 0)
  assert.strictEqual(r.walks, 1)
  assert.deepStrictEqual(r.digs, [])
  assert.strictEqual(r.result.reason, 'cancelled')
})

test('gather during the buried self-rescue answers busy naming it and starts no job', async () => {
  const { env } = lakeWorld(SHORE, [new Vec3(-6, 63, 0)], { hidden: [], blocks: {} })
  const query = { resource: 'dirt', amount: '1' }
  assert.deepStrictEqual((await routeJobs('/gather', query, env)).started, ['gather dirt x1'], 'control: no rescue')
  claimRescue(env.digLock)
  const r = await routeJobs('/gather', query, env)
  assert.deepStrictEqual([r.error && r.error.reason, r.started], ['busy', []])
  assert.match(r.error.message, /^busy: the buried self-rescue is running\b/)
})
