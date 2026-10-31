'use strict'
// mine and gather take logs from trees only.
const test = require('node:test')
const assert = require('node:assert')
const { performance } = require('node:perf_hooks')
const { Vec3 } = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')
const { botConstant, loadBotFunctions, walkingBody } = require('./helpers')

const ck = (x, y, z) => x + ',' + y + ',' + z
const LOG = { axis: 'y' }
const LEAVES = { distance: '1', persistent: 'false', waterlogged: 'false' }

// The verdict woodClass gives the log at, over cells ('x,y,z' -> name, air elsewhere), every cell known but the hidden ones.
function classOf (cells, at, hidden = []) {
  const env = {
    bot: { blockAt: (p) => ({ name: cells[ck(p.x, p.y, p.z)] || 'air', position: p }) },
    cellKnown: (p) => !hidden.includes(ck(p.x, p.y, p.z)),
    ck,
    Vec3
  }
  return loadBotFunctions(['woodClass'], env).woodClass(new Vec3(...at))
}

const column = (cells, x, z, from, to, name) => { for (let y = from; y <= to; y++) cells[ck(x, y, z)] = name }

test('a 2x2 jungle trunk with its leaves only at the top reads natural, and unclear without them', () => {
  const trunk = {}
  for (const [x, z] of [[0, 0], [1, 0], [0, 1], [1, 1]]) column(trunk, x, z, 64, 73, 'jungle_log')
  const crowned = { ...trunk }
  for (const [x, z] of [[0, 0], [1, 0], [0, 1], [1, 1]]) crowned[ck(x, 74, z)] = 'jungle_leaves'
  assert.strictEqual(classOf(crowned, [0, 64, 0]), 'natural')
  assert.strictEqual(classOf(trunk, [0, 64, 0]), 'unclear')
})

test('a bent acacia trunk reads natural across its diagonal step', () => {
  const cells = { '0,64,0': 'acacia_log', '0,65,0': 'acacia_log', '1,66,1': 'acacia_log', '1,67,1': 'acacia_log', '1,68,1': 'acacia_leaves' }
  assert.strictEqual(classOf(cells, [0, 64, 0]), 'natural')
})

test('a torch on a natural trunk keeps it natural, and planks there make it built', () => {
  const tree = { '0,64,0': 'oak_log', '0,65,0': 'oak_log', '0,66,0': 'oak_log', '0,67,0': 'oak_leaves' }
  assert.strictEqual(classOf({ ...tree, '1,65,0': 'wall_torch' }, [0, 64, 0]), 'natural')
  assert.strictEqual(classOf({ ...tree, '1,65,0': 'oak_planks' }, [0, 64, 0]), 'built')
})

test('a log reads unclear when its leaves or the planks beside it are out of sight, or its group runs past 128 logs', () => {
  const tree = { '0,64,0': 'oak_log', '0,65,0': 'oak_log', '0,66,0': 'oak_leaves' }
  assert.strictEqual(classOf(tree, [0, 64, 0], ['0,66,0']), 'unclear')
  assert.strictEqual(classOf({ '0,64,0': 'oak_log', '1,64,0': 'oak_planks' }, [0, 64, 0], ['1,64,0']), 'unclear')
  const tall = {}
  for (const [x, z] of [[0, 0], [1, 0], [0, 1], [1, 1]]) column(tall, x, z, 64, 99, 'oak_log')
  tall[ck(0, 100, 0)] = 'oak_leaves'
  assert.strictEqual(classOf(tall, [0, 64, 0]), 'unclear')
})

// A wall of stone across x 2 from z -15 to 15 holding a pillar of oak logs under planks at z 0, and a tree at x 6.
function walledGrove () {
  const cells = {}
  for (let z = -15; z <= 15; z++) column(cells, 2, z, 64, 67, ['stone', {}])
  Object.assign(cells, {
    '2,64,0': ['oak_log', LOG],
    '2,65,0': ['oak_log', LOG],
    '2,66,0': ['oak_planks', {}],
    '6,64,0': ['oak_log', LOG],
    '6,65,0': ['oak_log', LOG],
    '6,66,0': ['oak_leaves', LEAVES]
  })
  return cells
}

const broken = (r) => r.path.flatMap((n) => n.toBreak.map((p) => ck(p.x, p.y, p.z)))
const PILLAR = ['2,64,0', '2,65,0']

test('a collect of a tree log plans around a built log of its kind, and cuts through it with natural logs off', async (t) => {
  const { bot, plan, shared } = await walkingBody(t, new Vec3(0.5, 64, 0.5), walledGrove())
  const cageOf = async (natural) => {
    let cage = null
    bot.collectBlock = { movements: null, async collect () { cage = this.movements } }
    bot.tool = { equipForBlock: async () => {} }
    const env = { bot, collectLock: botConstant('collectLock'), digLock: botConstant('digLock'), knownMoves: (m) => m, Movements, shared, watchedWork: (work) => work(), abandonCollect () {}, cellKnown: () => true, ck, Vec3 }
    const fns = loadBotFunctions(['collectSafely', 'naturalLogsOnly'], env)
    const logs = natural ? fns.naturalLogsOnly() : null
    await fns.collectSafely(bot.blockAt(new Vec3(6, 64, 0)), 'mine oak_log', { exclude: logs?.weight })
    logs?.end()
    return cage
  }
  const goal = new goals.GoalBlock(5, 64, 0)
  const cut = plan(goal, await cageOf(false))
  assert.deepStrictEqual(PILLAR.map((k) => broken(cut).includes(k)), [true, true], 'control: the cage cuts the pillar')
  const around = plan(goal, await cageOf(true))
  assert.strictEqual(around.status, 'success')
  assert.deepStrictEqual(broken(around).filter((k) => PILLAR.includes(k)), [])
})

test('a forestry plan with the gather\'s natural logs entry goes around a built log', async (t) => {
  const { bot, plan, shared } = await walkingBody(t, new Vec3(0.5, 64, 0.5), walledGrove())
  const goal = new goals.GoalBlock(5, 64, 0)
  assert.deepStrictEqual(PILLAR.map((k) => broken(plan(goal, shared.forestryMoves)).includes(k)), [true, true], 'control: forestry cuts the pillar')
  const logs = loadBotFunctions(['naturalLogsOnly'], { bot, cellKnown: () => true, ck, Vec3 }).naturalLogsOnly()
  shared.forestryMoves.exclusionAreasBreak.push(logs.weight)
  const around = plan(goal, shared.forestryMoves)
  logs.end()
  assert.strictEqual(around.status, 'success')
  assert.deepStrictEqual(broken(around).filter((k) => PILLAR.includes(k)), [])
})

test('a forestry plan through a dense grove judges its logs within the gather\'s planning budget', async (t) => {
  // Oak trees 4 logs high every 3 blocks from x 3 to 45 and z -12 to 12, every other cell up to y 68 filled with leaves.
  const cells = {}
  for (let x = 1; x <= 46; x++) {
    for (let z = -13; z <= 13; z++) {
      const trunk = x % 3 === 0 && z % 3 === 0
      for (let y = 64; y <= 68; y++) cells[ck(x, y, z)] = trunk && y <= 67 ? ['oak_log', LOG] : ['oak_leaves', LEAVES]
    }
  }
  const { bot, plan, shared } = await walkingBody(t, new Vec3(0.5, 64, 0.5), cells)
  const logs = loadBotFunctions(['naturalLogsOnly'], { bot, cellKnown: () => true, ck, Vec3 }).naturalLogsOnly()
  shared.forestryMoves.exclusionAreasBreak.push(logs.weight)
  bot.pathfinder.thinkTimeout = 3000
  const t0 = performance.now()
  const r = plan(new goals.GoalBlock(47, 64, 0), shared.forestryMoves)
  const ms = performance.now() - t0
  logs.end()
  assert.strictEqual(r.status, 'success', `planned in ${Math.round(ms)} ms`)
  assert.ok(ms < 3000, `planned in ${Math.round(ms)} ms`)
})
