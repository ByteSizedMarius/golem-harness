'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const { loadBotFunctions, botConstant, routeHandler } = require('./helpers')
const { entityInCell } = require('../lib/shelter')

// The floor ore every case digs.
const ORE = new Vec3(2, 63, 0)

// True when the body's box at pos lies over the ore's column.
const overOre = (pos) => pos.x - 0.3 < ORE.x + 1 && pos.x + 0.3 > ORE.x && pos.z - 0.3 < ORE.z + 1 && pos.z + 0.3 > ORE.z

// A stone floor at y 63 holding the ore, stone at walls, air at holes, and a walk that ends 0.35 short of the goal cell nearest the ore.
function floorWorld (pos, walls = [], holes = []) {
  const solid = new Set(walls)
  const cells = new Map(holes.map((k) => [k, 'air']))
  const blockAt = (p) => {
    const c = p.floored()
    const k = `${c.x},${c.y},${c.z}`
    const name = cells.get(k) || (c.equals(ORE) ? 'iron_ore' : c.y <= 63 || solid.has(k) ? 'stone' : 'air')
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState, 0), { position: c })
  }
  const log = { walks: [], centred: [], digs: [] }
  const bot = {
    entity: { position: pos, width: 0.6, height: 1.8 },
    heldItem: null,
    inventory: { items: () => [] },
    digTime: () => 0,
    waitForTicks: async () => {},
    blockAt,
    world: {
      raycast: (from) => (Math.hypot(from.x - ORE.x - 0.5, from.z - ORE.z - 0.5) <= 2 ? { position: ORE, face: 1 } : null)
    },
    pathfinder: {
      async goto (goal) {
        log.walks.push(goal.x === undefined ? 'look' : `${goal.x},${goal.y},${goal.z}`)
        const here = bot.entity.position
        if (goal.isEnd(here.floored())) return
        const open = (c) => blockAt(c).name === 'air'
        const ends = []
        for (let x = ORE.x - 3; x <= ORE.x + 3; x++) {
          for (let z = ORE.z - 3; z <= ORE.z + 3; z++) {
            const c = new Vec3(x, 64, z)
            if (open(c) && open(c.offset(0, 1, 0)) && goal.isEnd(c)) ends.push(c)
          }
        }
        const fromOre = (c) => Math.hypot(c.x - ORE.x, c.z - ORE.z)
        const end = ends.sort((a, b) => fromOre(a) - fromOre(b))[0]
        if (!end) throw new Error('No path to the goal!')
        const mid = new Vec3(end.x + 0.5, end.y, end.z + 0.5)
        const way = mid.minus(here)
        const flat = Math.hypot(way.x, way.z)
        bot.entity.position = new Vec3(mid.x - way.x / flat * 0.35, end.y, mid.z - way.z / flat * 0.35)
      }
    },
    async dig (b) {
      log.digs.push({ at: `${b.position.x},${b.position.y},${b.position.z}`, over: overOre(bot.entity.position) })
      cells.set(`${b.position.x},${b.position.y},${b.position.z}`, 'air')
    }
  }
  const env = {
    bot,
    require,
    goals,
    entityInCell,
    LEGACY_1710: false,
    bunker: { building: false },
    digLock: botConstant('digLock'),
    stopPath () {},
    cellKnown: () => true,
    seenNow: () => true,
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    canStepOutTo: loadBotFunctions(['canStepOutTo'], { bot, knownCell: () => true }).canStepOutTo,
    centerOnCell: async (c) => { log.centred.push(`${c.x},${c.y},${c.z}`); bot.entity.position = new Vec3(c.x + 0.5, c.y, c.z + 0.5); return true },
    refuseWhileFighting () {},
    holdHand: () => ({ renew: () => true }),
    endHand () {},
    holdDigTool: async () => {},
    holdHarvester: async () => null,
    neededPickTier: () => 0,
    PICK_TIER: {}
  }
  return { bot, env, log }
}

async function digat (pos, walls, holes) {
  const w = floorWorld(pos, walls, holes)
  const { handle, res } = routeHandler('/digat', w.env)
  await handle({ query: { x: String(ORE.x), y: String(ORE.y), z: String(ORE.z) } }, res)
  return { ...w.log, error: res.error, reply: res.body }
}

// The eight cells around the ore at the feet row.
const RING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => `${ORE.x + dx},64,${ORE.z + dz}`)

// The cells around the ore from y 60 to 63, a pillar 4 high once they are air.
const PILLAR = [60, 61, 62, 63].flatMap((y) => RING.map((k) => k.replace(',64,', `,${y},`)))

test('digat steps off a floor cell the body stands on before it digs', async () => {
  const r = await digat(new Vec3(2.5, 64, 0.5))
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.walks.length, 1)
  assert.ok(RING.includes(r.walks[0]), `walked to ${r.walks[0]}`)
  assert.deepStrictEqual(r.digs, [{ at: '2,63,0', over: false }])
})

test('digat steps off a floor cell under the edge of the body\'s box', async () => {
  const r = await digat(new Vec3(3.1, 64, 0.5))
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(r.digs, [{ at: '2,63,0', over: false }])
})

test('digat digs a floor cell beside the body from where it stands', async () => {
  const r = await digat(new Vec3(3.5, 64, 0.5))
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual([r.walks, r.centred], [[], []])
  assert.deepStrictEqual(r.digs, [{ at: '2,63,0', over: false }])
})

test('digat digs a floor cell the body stands on in place with no cell beside it to stand on', async () => {
  const r = await digat(new Vec3(2.5, 64, 0.5), RING)
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual([r.walks, r.centred], [[], []])
  assert.deepStrictEqual(r.digs, [{ at: '2,63,0', over: true }])
})

test('digat digs the top block of a pillar the body stands on in place', async () => {
  const r = await digat(new Vec3(2.5, 64, 0.5), [], PILLAR)
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual([r.walks, r.centred], [[], []])
  assert.deepStrictEqual(r.digs, [{ at: '2,63,0', over: true }])
})

// The collect walks to mineflayer-collectblock's own goal and digs from where that walk ends.
async function mine (pos, walls) {
  const w = floorWorld(pos, walls)
  const collected = []
  Object.assign(w.env, {
    shared: { mcData: registry },
    resolveBlockIds: (name) => [registry.blocksByName[name].id],
    collectLock: { done: null },
    watchedWork: (work) => work(),
    stopPath () {},
    nearestVisible: () => (w.bot.blockAt(ORE).name === 'iron_ore' ? w.bot.blockAt(ORE) : null),
    collectSafely: async (b) => {
      await w.bot.pathfinder.goto(new goals.GoalLookAtBlock(b.position, w.bot.world))
      collected.push(overOre(w.bot.entity.position))
      await w.bot.dig(b)
    }
  })
  const { handle, res } = routeHandler('/mine', w.env)
  await handle({ query: { name: 'iron_ore', count: '1' } }, res)
  return { ...w.log, collected, error: res.error, reply: res.body }
}

test('mine steps off an ore the body stands on before the collect digs it', async () => {
  const r = await mine(new Vec3(2.5, 64, 0.5))
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(r.collected, [false])
  assert.strictEqual(r.reply.mined, 1)
})

test('mine walks to a floor ore 3 cells away and digs it from beside it', async () => {
  const r = await mine(new Vec3(5.5, 64, 0.5))
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(r.collected, [false])
  assert.deepStrictEqual(r.digs, [{ at: '2,63,0', over: false }])
})

test('mine digs an ore the body stands on in place with no cell beside it to stand on', async () => {
  const r = await mine(new Vec3(2.5, 64, 0.5), RING)
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual([r.walks, r.collected], [['look'], [true]])
  assert.strictEqual(r.reply.mined, 1)
})

// A gather job of the ore with the bot's own drop and rise limits, its collect as in mine.
async function gather (pos) {
  const w = floorWorld(pos)
  let job = null
  Object.assign(w.env, {
    shared: { mcData: registry, forestryMoves: null },
    resolveBlockIds: (name) => [registry.blocksByName[name].id],
    jobs: { start: (name, fn) => { job = fn({ cancelled: false, progress () {} }); return { id: 1 } } },
    emitEvent () {},
    seesLit: () => true,
    GATHER_MAX_DROP: 2,
    GATHER_MAX_RISE: 4,
    watchedWork: (work) => work(),
    stopPath () {},
    collectSafely: async (b) => {
      await w.bot.pathfinder.goto(new goals.GoalLookAtBlock(b.position, w.bot.world))
      await w.bot.dig(b)
    }
  })
  w.bot.findBlocks = () => (w.bot.blockAt(ORE).name === 'iron_ore' ? [ORE] : [])
  const { handle, res } = routeHandler('/gather', w.env)
  handle({ query: { resource: 'iron_ore', amount: '1' } }, res)
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  await job
  return w.log
}

test('gather walks to a floor block 2 cells away and digs it from beside it', async () => {
  assert.deepStrictEqual((await gather(new Vec3(4.5, 64, 0.5))).digs, [{ at: '2,63,0', over: false }])
})

test('gather steps off a block the body stands on before it digs it', async () => {
  assert.deepStrictEqual((await gather(new Vec3(2.5, 64, 0.5))).digs, [{ at: '2,63,0', over: false }])
})
