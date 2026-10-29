'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const Item = require('prismarine-item')(registry)
const { createJobs } = require('../lib/jobs')
const { deathLedger } = require('../lib/deaths')
const { HUNG, botConstant, fakeClock, loadBotFunctions, routeHandler, timed, waitFor } = require('./helpers')

const AIR = Block.fromStateId(registry.blocksByName.air.defaultState, 0)
const statesOf = (name) => {
  const b = registry.blocksByName[name]
  return Array.from({ length: b.maxStateId - b.minStateId + 1 }, (_, i) => Block.fromStateId(b.minStateId + i, 0))
}
const blockOf = (name) => Block.fromStateId(registry.blocksByName[name].defaultState, 0)

const STONE = blockOf('stone')
const GRAVEL = blockOf('gravel')
const key = (p) => `${p.x},${p.y},${p.z}`
const middle = (c, y) => new Vec3(c.x + 0.5, y, c.z + 0.5)

// A bot at pos with head at (0, 65, 0), feet at (0, 64, 0), cells ('x,y,z' -> block) elsewhere and air in the rest.
// Its dig follows mineflayer's digging plugin, and stopDigging misses a dig until look(p) for its cell resolves. A dig
// clears its cell at once, or with hold once the test finishes it from releases. digs holds the names it started on.
function diggingBot (head, feet, cells, { hold = false, look = () => {}, pos = new Vec3(0.5, 64, 0.5) } = {}) {
  const at = new Map(Object.entries({ ...cells, '0,65,0': head, '0,64,0': feet }))
  const digs = []
  const releases = []
  let pending = null
  const noop = () => {}
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: pos },
    oxygenLevel: 20,
    heldItem: null,
    targetDigBlock: null,
    blockAt: (p) => Object.assign(Block.fromStateId((at.get(key(p)) || AIR).stateId, 0), { position: p }),
    digTime: (b) => b.digTime(bot.heldItem ? bot.heldItem.type : null, false, false, false),
    lookAt: async (p) => look(p),
    stopDigging: noop,
    async dig (b) {
      await bot.lookAt(b.position)
      if (bot.targetDigBlock) bot.stopDigging()
      digs.push(b.name)
      bot.targetDigBlock = b
      return new Promise((resolve, reject) => {
        const settle = (end) => {
          if (pending !== dig) return
          pending = null
          bot.targetDigBlock = null
          end()
        }
        const dig = {
          finish: () => settle(() => { at.set(key(b.position), AIR); resolve() }),
          fail: (e) => settle(() => reject(e))
        }
        pending = dig
        bot.stopDigging = () => {
          if (!bot.targetDigBlock) return
          bot.stopDigging = noop
          if (pending) pending.fail(new Error('Digging aborted'))
        }
        if (hold) releases.push(dig)
        else dig.finish()
      })
    }
  })
  bot.on('death', () => {
    try { bot.stopDigging() } catch (e) {}
  })
  return { bot, at, digs, releases }
}

// A body standing at pos, the middle of (0, 64, 0) unless given, with head in (0, 65, 0), feet in (0, 64, 0) and the
// own-edit stamps and the dig guard wired over its dig in bot.js order. log holds the legs it takes and the cells it
// steps to, in order, digs the blocks it digs, stamps the cells stamped as its own edits, lines its log lines and
// events its events. A step reaches its cell when nudge resolves true, and leaves the body in its middle unless nudge
// moved it. center(cell) stands in for centring on a cell and by default moves the body to its middle. tools are its
// items, picked from by the real dig tool choice, and equip stands in for that choice without tools. legs gets the
// reflex and the reason each time the rescue takes the legs. legacy makes it a 1.7.10 body.
function body (head, feet = AIR, { cells = {}, pos, legacy = false, known = () => true, lastFeet = null, nudge = async () => true, center = null, hold = false, look, tools = null, equip = async () => {}, holdHand = () => ({ renew: () => true }), endHand = () => {}, stopPath = () => {}, legs = () => {}, timers = {} } = {}) {
  const { bot, at, digs, releases } = diggingBot(head, feet, cells, { hold, look, pos })
  const centre = center || (async (c) => { bot.entity.position = middle(c, bot.entity.position.y); return true })
  const log = []
  const lines = []
  const events = []
  const env = {
    bot,
    digLock: botConstant('digLock'),
    RESCUE_MS: botConstant('RESCUE_MS'),
    RESCUE_NAME: botConstant('RESCUE_NAME'),
    setTimeout,
    clearTimeout,
    ...timers,
    console: { log: (line) => lines.push(line) },
    emitEvent: (kind, msg) => events.push(`${kind}: ${msg}`),
    holdHand,
    endHand,
    knownCell: known,
    LEGACY_1710: legacy,
    takeLegs: (reflex, why) => { log.push('legs'); legs(reflex, why) },
    stopPath,
    async nudgeInto (c) {
      log.push(`step ${key(c)}`)
      const from = bot.entity.position
      const reached = await nudge()
      if (reached && bot.entity.position === from) bot.entity.position = middle(c, c.y)
      return reached
    },
    centerOnCell: (c = bot.entity.position.floored()) => centre(c),
    lastFeet,
    rescue: null,
    lastGiveUp: null,
    stuck: null
  }
  if (legacy) env.LEGACY_SMOTHER_DY = botConstant('LEGACY_SMOTHER_DY')
  if (tools) {
    Object.assign(bot, { inventory: { items: () => tools, slots: [], hotbarStart: 36 }, async equip (it) { bot.heldItem = it } })
    Object.assign(env, { PICK_TIER: botConstant('PICK_TIER'), DIG_TOOL: botConstant('DIG_TOOL'), LEGACY_HAND_DIG: botConstant('LEGACY_HAND_DIG') })
  } else env.holdDigTool = equip
  const stamps = []
  env.stampOwnEdit = (p) => stamps.push(key(p))
  bot.placeBlock = async () => {}
  const wired = loadBotFunctions(['wireOwnEditStamps', 'wireDigGuard'], env)
  wired.wireOwnEditStamps()
  wired.wireDigGuard()
  bot.emit('spawn')
  return {
    buried: () => loadBotFunctions(['waterState'], env).waterState().buried,
    digOutHead: () => loadBotFunctions(['digOutHead'], env).digOutHead(),
    // Settles once the rescue started last has ended.
    stepped: () => env.rescue,
    digat (at) {
      const { handle, res } = routeHandler('/digat', {
        bot,
        require,
        bunker: { building: false },
        digLock: env.digLock,
        cellKnown: known,
        knownCell: known,
        LEGACY_1710: false,
        round: (v) => ({ x: v.x, y: v.y, z: v.z }),
        stopPath () {},
        refuseWhileFighting () {},
        holdHand: () => ({ renew: () => true }),
        endHand () {},
        holdDigTool: async () => {},
        holdHarvester: async () => null,
        neededPickTier: () => 0,
        PICK_TIER: {}
      })
      const [x, y, z] = at.split(',')
      return handle({ query: { x, y, z } }, res).then(() => res)
    },
    bot,
    at,
    digLock: env.digLock,
    releases,
    digs,
    stamps,
    log,
    lines,
    events
  }
}

// Floors (stone under each cell) for a body to stand in the given feet cells.
const floors = (...feet) => Object.fromEntries(feet.map(([x, y, z]) => [`${x},${y - 1},${z}`, STONE]))
// Stone in the feet and head cells of all four columns beside the body.
const walled = Object.fromEntries([[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([x, z]) => [[`${x},64,${z}`, STONE], [`${x},65,${z}`, STONE]]))

const slab = (type) => statesOf('oak_slab').find((b) => b.getProperties().type === type && !b.getProperties().waterlogged)

test('a head in glass, a sign, a stair or a half slab is not buried', () => {
  for (const head of [blockOf('glass'), blockOf('oak_sign'), blockOf('oak_stairs'), slab('bottom')]) {
    assert.strictEqual(body(head).buried(), false, `${head.name} ${JSON.stringify(head.getProperties())}`)
  }
})

test('a head in gravel or a double slab is buried', () => {
  assert.strictEqual(body(blockOf('gravel')).buried(), true, 'gravel')
  assert.strictEqual(body(slab('double')).buried(), true, 'double oak_slab')
})

test('a body off-centre beside gravel at eye height is buried until its eye corners leave the gravel column', () => {
  for (const [x, z] of [[1.2, 0.5], [1.2, 1.2]]) {
    assert.strictEqual(body(GRAVEL, AIR, { pos: new Vec3(x, 64, z) }).buried(), true, `${x}, ${z}`)
  }
  assert.strictEqual(body(GRAVEL, AIR, { pos: new Vec3(1.3, 64, 0.5) }).buried(), false, '1.3, 0.5')
})

test('on 1.7.10 a body whose eye sits just under gravel is buried, on 1.21 it is not', () => {
  const at = { cells: { '0,66,0': GRAVEL }, pos: new Vec3(0.5, 64.35, 0.5) }
  assert.strictEqual(body(AIR, AIR, { ...at, legacy: true }).buried(), true, '1.7.10')
  assert.strictEqual(body(AIR, AIR, at).buried(), false, '1.21')
})

test('a sleeping body with its head in gravel is not buried', () => {
  const b = body(GRAVEL)
  b.bot.isSleeping = true
  assert.strictEqual(b.buried(), false)
})

test('a body standing in a doorway is not buried and the rescue leaves the door', async () => {
  for (const open of [false, true]) {
    const doors = statesOf('oak_door').filter((b) => b.getProperties().open === open && b.getProperties().facing === 'north')
    const upper = doors.find((b) => b.getProperties().half === 'upper')
    const lower = doors.find((b) => b.getProperties().half === 'lower')
    const b = body(upper, lower)
    assert.strictEqual(b.buried(), false, `open ${open}`)
    assert.strictEqual(await b.digOutHead(), false, `open ${open}`)
    assert.deepStrictEqual(b.digs, [], `open ${open}`)
  }
})

// Starts the rescue of b, waits for it to end and returns what the body did.
async function rescue (b) {
  assert.strictEqual(await b.digOutHead(), true, 'the rescue starts')
  await b.stepped()
  return { log: b.log, digs: b.digs }
}

test('the rescue digs out gravel in the head cell', async () => {
  const gravel = body(GRAVEL)
  assert.deepStrictEqual((await rescue(gravel)).digs, ['gravel'])
  assert.strictEqual(gravel.at.get('0,65,0'), AIR)
})

test('a bedrock head with no cell to step out to gives up once and leaves a running digat and the legs alone', async () => {
  let now = 0
  const b = body(blockOf('bedrock'), AIR, { cells: walled, hold: true, timers: { Date: { now: () => now } } })
  const digat = b.digat('1,64,0')
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'control: the digat dig started')
  for (const t of [0, 500]) {
    now = t
    assert.strictEqual(await b.digOutHead(), false, `the hit at ${t} ms started a rescue`)
  }
  assert.deepStrictEqual({ log: b.log, digging: b.bot.targetDigBlock && b.bot.targetDigBlock.name }, { log: [], digging: 'stone' })
  b.releases[0].finish()
  const { out } = await timed(digat, 1000)
  assert.deepStrictEqual([out.error && out.error.message, !!out.body], [undefined, true])
  assert.strictEqual(b.at.get('1,64,0'), AIR)
  assert.deepStrictEqual(b.events, ['buried: the buried self-rescue gave up: the head block bedrock cannot be dug'])
  assert.strictEqual(b.lines.filter((l) => l.startsWith('[buried] gave up: ')).length, 1)
})

// Puts block into cell p of b with the block update mineflayer emits for it.
function change (b, p, block) {
  const was = b.bot.blockAt(p)
  b.at.set(key(p), block)
  b.bot.emit(`blockUpdate:${p}`, was, b.bot.blockAt(p))
}

test('after two failed digs of its gravel a hit starts no rescue until new gravel falls into the head cell', async () => {
  const b = body(GRAVEL, AIR, { cells: walled, hold: true })
  const head = new Vec3(0, 65, 0)
  assert.strictEqual(await b.digOutHead(), true)
  for (const n of [1, 2]) {
    assert.ok(await waitFor(() => b.releases.length === n, 1000), `dig ${n} never started`)
    b.releases[n - 1].fail(new Error('Block not in view'))
  }
  await b.stepped()
  assert.strictEqual(await b.digOutHead(), false, 'the same gravel')
  change(b, head, GRAVEL)
  assert.strictEqual(await b.digOutHead(), false, 'the same gravel sent again')
  change(b, head, AIR)
  change(b, head, GRAVEL)
  assert.strictEqual(await b.digOutHead(), true, 'new gravel')
  assert.ok(await waitFor(() => b.releases.length === 3, 1000), 'the dig of the new gravel never started')
  b.releases[2].finish()
  await b.stepped()
  assert.deepStrictEqual({ log: b.log, head: b.at.get('0,65,0') }, { log: ['legs', 'legs'], head: AIR })
})

test('a job the rescue cancels ends naming the buried self-rescue', async () => {
  const emitted = []
  const jobs = createJobs({ stop () {}, emit: (name, msg) => emitted.push(`${name}: ${msg}`), deaths: deathLedger() })
  jobs.start('dig_tunnel e x12', async (job) => {
    while (!job.cancelled) await new Promise((resolve) => setTimeout(resolve, 2))
  })
  await rescue(body(GRAVEL, AIR, { cells: walled, legs: (reflex, why) => jobs.yieldTo({ reflex, why }) }))
  assert.ok(await waitFor(() => emitted.length === 1, 1000), 'the job never ended')
  assert.deepStrictEqual(emitted, ['dig_tunnel e x12: cancelled, the buried self-rescue reflex took the legs to free a head buried in a block'])
})

test('a body buried in gravel steps back to the column it came from and digs nothing', async () => {
  const b = body(GRAVEL, AIR, { cells: floors([1, 64, 0], [-1, 64, 0]), lastFeet: new Vec3(-1, 64, 0) })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step -1,64,0'], digs: [] })
})

test('a buried body whose last column is not beside it steps to a neighbour it can stand in', async () => {
  const b = body(GRAVEL, AIR, { cells: floors([2, 64, 0], [0, 64, -1]), lastFeet: new Vec3(2, 64, 0) })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step 0,64,-1'], digs: [] })
})

test('a buried body with rock or unseen cells beside it digs the head block', async () => {
  const rock = body(GRAVEL, AIR, { cells: { ...floors([1, 64, 0], [-1, 64, 0], [0, 64, 1], [0, 64, -1]), ...walled } })
  assert.deepStrictEqual(await rescue(rock), { log: ['legs'], digs: ['gravel'] }, 'rock')
  const unseen = body(GRAVEL, AIR, { cells: floors([1, 64, 0]), known: (p) => key(p) !== '1,64,0' })
  assert.deepStrictEqual(await rescue(unseen), { log: ['legs'], digs: ['gravel'] }, 'unseen')
})

test('a step-out skips a neighbour under gravel the body knows of', async () => {
  const cells = { ...floors([1, 64, 0], [-1, 64, 0]), '1,66,0': GRAVEL }
  assert.deepStrictEqual(await rescue(body(GRAVEL, AIR, { cells })), { log: ['legs', 'step -1,64,0'], digs: [] }, 'seen')
  const unseen = body(GRAVEL, AIR, { cells, known: (p) => key(p) !== '1,66,0' })
  assert.deepStrictEqual(await rescue(unseen), { log: ['legs', 'step 1,64,0'], digs: [] }, 'unseen')
})

test('a step down beside the feet goes only where the cell above it is open', async () => {
  const b = body(GRAVEL, AIR, { cells: { ...floors([1, 63, 0], [-1, 63, 0]), '1,65,0': STONE } })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step -1,63,0'], digs: [] })
})

test('hits during one step-out start no second step and no dig', async () => {
  let arrive
  const b = body(GRAVEL, AIR, { cells: floors([1, 64, 0]), nudge: () => new Promise((resolve) => { arrive = resolve }) })
  assert.strictEqual(await b.digOutHead(), true, 'first hit')
  const step = b.stepped()
  assert.strictEqual(await b.digOutHead(), true, 'second hit')
  assert.deepStrictEqual({ log: b.log, digs: b.digs }, { log: ['legs', 'step 1,64,0'], digs: [] }, 'stepping')
  arrive(true)
  await step
  assert.deepStrictEqual({ log: b.log, digs: b.digs }, { log: ['legs', 'step 1,64,0'], digs: [] }, 'arrived')
})

test('a step-out that does not reach its cell digs the head block', async () => {
  const b = body(GRAVEL, AIR, { cells: floors([1, 64, 0]), nudge: async () => false })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step 1,64,0'], digs: ['gravel'] })
})

test('a step-out that leaves the eye in the gravel column counts only once the centring clears it', async () => {
  for (const [reaches, digs] of [[false, ['gravel']], [true, []]]) {
    const b = body(GRAVEL, AIR, {
      cells: floors([1, 64, 0]),
      nudge: async () => { b.bot.entity.position = new Vec3(1.2, 64, 0.5); return true },
      center: async (c) => { if (reaches) b.bot.entity.position = middle(c, 64); return reaches }
    })
    assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step 1,64,0'], digs }, `centring reaches ${reaches}`)
    assert.strictEqual(b.lines.includes('[buried] out (stepped)'), reaches, b.lines.join('\n'))
    assert.strictEqual(b.at.get('0,65,0'), reaches ? GRAVEL : AIR, `centring reaches ${reaches}`)
  }
})

test('an off-centre body beside gravel with nothing to step to digs the gravel when centring falls short', async () => {
  const b = body(GRAVEL, AIR, { pos: new Vec3(1.2, 64, 0.5), center: async () => false })
  assert.deepStrictEqual(await rescue(b), { log: ['legs'], digs: ['gravel'] })
  assert.strictEqual(b.at.get('0,65,0'), AIR)
  assert.ok(b.lines.some((l) => l.startsWith('[buried] start, smothered by gravel at 0,65,0')), b.lines.join('\n'))
})

test('an off-centre body beside gravel centres in its own cell before any step-out and digs nothing', async () => {
  const centred = []
  const b = body(GRAVEL, AIR, {
    cells: floors([2, 64, 0]),
    pos: new Vec3(1.2, 64, 0.5),
    center: async (c) => { centred.push(key(c)); b.bot.entity.position = middle(c, 64); return true }
  })
  assert.deepStrictEqual(await rescue(b), { log: ['legs'], digs: [] })
  assert.deepStrictEqual(centred, ['1,64,0'])
  assert.ok(b.lines.includes('[buried] out (centred)'), b.lines.join('\n'))
})

test('an off-centre body beside a head block it cannot dig centres first and gets out without giving up', async () => {
  const centred = []
  const b = body(blockOf('bedrock'), AIR, {
    pos: new Vec3(1.2, 64, 0.5),
    center: async (c) => { centred.push(key(c)); b.bot.entity.position = middle(c, 64); return true }
  })
  assert.deepStrictEqual(await rescue(b), { log: ['legs'], digs: [] })
  assert.deepStrictEqual(centred, ['1,64,0'])
  assert.ok(b.lines.includes('[buried] out (centred)'), b.lines.join('\n'))
  assert.deepStrictEqual(b.events, [])
})

test('a body with its feet in gravel digs out beside gravel without centring in place first', async () => {
  const centred = []
  const b = body(GRAVEL, AIR, {
    cells: { '1,64,0': GRAVEL },
    pos: new Vec3(1.2, 64, 0.5),
    center: async (c) => { centred.push(key(c)); b.bot.entity.position = middle(c, 64); return true }
  })
  assert.deepStrictEqual(await rescue(b), { log: ['legs'], digs: ['gravel', 'gravel'] })
  assert.deepStrictEqual(centred, [])
  assert.deepStrictEqual([b.at.get('0,65,0'), b.at.get('1,64,0')], [AIR, AIR])
})

test('after a failed step-out beside a head block it cannot dig a hit starts no rescue until the step-out cell changes', async () => {
  const b = body(blockOf('bedrock'), AIR, { cells: floors([1, 64, 0], [-1, 64, 0]), nudge: async () => false })
  assert.strictEqual(await b.digOutHead(), true, 'control: the first hit starts the rescue')
  await b.stepped()
  for (const n of [2, 3]) assert.strictEqual(await b.digOutHead(), false, `hit ${n} started a rescue`)
  assert.deepStrictEqual(b.log, ['legs', 'step 1,64,0'])
  b.at.set('1,65,0', STONE)
  assert.strictEqual(await b.digOutHead(), true, 'another step-out cell')
  await b.stepped()
  assert.deepStrictEqual(b.log, ['legs', 'step 1,64,0', 'legs', 'step -1,64,0'])
})

test('after a give-up on a block that smothers an off-centre eye only a change of that block lifts the hold', async () => {
  const neighbour = new Vec3(0, 65, 0)
  const b = body(blockOf('bedrock'), AIR, { pos: new Vec3(1.2, 64, 0.5), center: async () => false })
  assert.strictEqual(await b.digOutHead(), true, 'control: the first hit starts the rescue')
  await b.stepped()
  assert.strictEqual(await b.digOutHead(), false, 'the same block')
  change(b, new Vec3(1, 65, 0), blockOf('glass'))
  assert.strictEqual(await b.digOutHead(), false, 'a change of the centre head cell')
  change(b, neighbour, GRAVEL)
  assert.strictEqual(await b.digOutHead(), true, 'a change of the smothering block')
  await b.stepped()
  assert.deepStrictEqual(b.digs, ['gravel'])
})

test('a step-out that throws digs the head block', async () => {
  const b = body(GRAVEL, AIR, { cells: floors([1, 64, 0]), nudge: async () => { throw new Error('lookAt failed') } })
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step 1,64,0'], digs: ['gravel'] })
})

test('a step-out skips a neighbour over a ladder or a half slab, or with fire or a cobweb in it', async () => {
  const cells = floors([1, 64, 0], [-1, 64, 0])
  const steps = {}
  for (const [block, at] of [[blockOf('ladder'), '-1,63,0'], [slab('bottom'), '-1,63,0'], [blockOf('fire'), '-1,64,0'], [blockOf('cobweb'), '-1,64,0']]) {
    steps[`${block.name} at ${at}`] = (await rescue(body(GRAVEL, AIR, { cells: { ...cells, [at]: block }, lastFeet: new Vec3(-1, 64, 0) }))).log
  }
  const away = ['legs', 'step 1,64,0']
  assert.deepStrictEqual(steps, { 'ladder at -1,63,0': away, 'oak_slab at -1,63,0': away, 'fire at -1,64,0': away, 'cobweb at -1,64,0': away })
})

test('a digat during the rescue answers busy and leaves the rescue dig running', async () => {
  const b = body(GRAVEL, AIR, { cells: walled, hold: true })
  assert.strictEqual(await b.digOutHead(), true)
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'the rescue dig never started')
  const res = await b.digat('0,65,0')
  assert.strictEqual(res.error && res.error.message, 'busy: the buried self-rescue is running, nothing dug')
  b.releases[0].finish()
  await b.stepped()
  assert.deepStrictEqual(b.digs, ['gravel'])
  assert.strictEqual(b.at.get('0,65,0'), AIR)
  assert.strictEqual(b.digLock.holder, null)
})

const BUSY = 'busy: the buried self-rescue is running, nothing dug'
const STONE_BESIDE = new Vec3(1, 65, 0)

async function headCleared (b, dig) {
  dig.finish()
  assert.notStrictEqual((await timed(b.stepped(), 1000)).out, HUNG, 'the rescue never ended')
  assert.strictEqual(b.at.get('0,65,0'), AIR)
}

test('a dig from outside during the rescue dig answers busy and leaves the rescue dig running', async () => {
  const b = body(GRAVEL, AIR, { cells: walled, hold: true })
  assert.strictEqual(await b.digOutHead(), true)
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'the rescue dig never started')
  const { out } = await timed(b.bot.dig(b.bot.blockAt(STONE_BESIDE)).catch((e) => e), 1000)
  assert.deepStrictEqual([out.message, out.reason], [BUSY, 'busy'])
  await headCleared(b, b.releases[0])
  assert.deepStrictEqual(b.digs, ['gravel'])
})

test('a stopDigging from outside during the rescue dig leaves it running', async () => {
  const b = body(GRAVEL, AIR, { cells: walled, hold: true })
  assert.strictEqual(await b.digOutHead(), true)
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'the rescue dig never started')
  b.bot.stopDigging()
  await headCleared(b, b.releases[0])
  assert.deepStrictEqual(b.digs, ['gravel'])
})

test('a dig whose look began before the rescue answers busy once its look ends during the rescue dig', async () => {
  let looked = null
  const look = (p) => key(p) === key(STONE_BESIDE) ? new Promise((resolve) => { looked = resolve }) : undefined
  const b = body(GRAVEL, AIR, { cells: walled, hold: true, look })
  const outside = b.bot.dig(b.bot.blockAt(STONE_BESIDE)).catch((e) => e)
  assert.ok(await waitFor(() => looked, 1000), 'control: the outside dig began its look')
  assert.strictEqual(await b.digOutHead(), true)
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'the rescue dig never started')
  looked()
  assert.strictEqual((await timed(outside, 1000)).out.message, BUSY)
  await headCleared(b, b.releases[0])
  assert.deepStrictEqual(b.digs, ['gravel'])
})

test('a dig refused at the end of its look leaves no own-edit stamp on its cell', async () => {
  let looked = null
  const look = (p) => key(p) === key(STONE_BESIDE) ? new Promise((resolve) => { looked = resolve }) : undefined
  const b = body(GRAVEL, AIR, { cells: walled, hold: true, look })
  const outside = b.bot.dig(b.bot.blockAt(STONE_BESIDE)).catch((e) => e)
  assert.ok(await waitFor(() => looked, 1000), 'control: the outside dig began its look')
  assert.strictEqual(await b.digOutHead(), true)
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'the rescue dig never started')
  looked()
  assert.strictEqual((await timed(outside, 1000)).out.message, BUSY)
  assert.ok(b.stamps.includes('0,65,0'), 'control: the rescue dig stamps its cell')
  assert.ok(!b.stamps.includes(key(STONE_BESIDE)), 'the refused dig stamped its cell')
  await headCleared(b, b.releases[0])
})

test('an outside dig aborted by the rescue whose error handler stops digging leaves the rescue dig running', async () => {
  const b = body(GRAVEL, AIR, { cells: walled, hold: true })
  const outside = b.bot.dig(b.bot.blockAt(STONE_BESIDE)).catch(async () => {
    await waitFor(() => b.releases.length === 2, 1000)
    b.bot.stopDigging()
  })
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'control: the outside dig started')
  assert.strictEqual(await b.digOutHead(), true)
  assert.notStrictEqual((await timed(outside, 1000)).out, HUNG, 'the outside dig was never aborted')
  await headCleared(b, b.releases[1])
  assert.deepStrictEqual(b.digs, ['stone', 'gravel'])
})

test('a dig under way when the rescue starts is stopped before the step-out', async () => {
  let digging = null
  const b = body(GRAVEL, AIR, { cells: { ...floors([1, 64, 0]), '2,65,0': STONE }, hold: true, nudge: async () => { digging = b.bot.targetDigBlock; return true } })
  const outside = b.bot.dig(b.bot.blockAt(new Vec3(2, 65, 0))).catch((e) => e)
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'control: the outside dig started')
  assert.deepStrictEqual((await rescue(b)).log, ['legs', 'step 1,64,0'])
  assert.strictEqual(digging, null, 'a dig was under way at the step-out')
  assert.strictEqual((await outside).message, 'Digging aborted')
})

test('the rescue takes over a running digat, which names it, and digs the head block', async () => {
  const b = body(GRAVEL, AIR, { cells: walled, hold: true })
  const digat = b.digat('1,64,0')
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'control: the digat dig started')
  assert.strictEqual(await b.digOutHead(), true)
  const { out } = await timed(digat, 1000)
  assert.strictEqual(out.error && out.error.message, 'the buried self-rescue took over digat stone at 1,64,0, nothing dug')
  assert.ok(await waitFor(() => b.releases.length === 2, 1000), 'the rescue dig never started')
  await headCleared(b, b.releases[1])
  assert.deepStrictEqual(b.digs, ['stone', 'gravel'])
  assert.strictEqual(b.at.get('1,64,0'), STONE)
})

test('a buried body carrying a pick and a shovel digs gravel with the shovel', async () => {
  const pick = new Item(registry.itemsByName.iron_pickaxe.id, 1)
  const shovel = new Item(registry.itemsByName.iron_shovel.id, 1)
  const b = body(GRAVEL, AIR, { cells: walled, tools: [pick, shovel] })
  b.bot.heldItem = pick
  assert.deepStrictEqual((await rescue(b)).digs, ['gravel'])
  assert.strictEqual(b.bot.heldItem, shovel)
  assert.ok(b.lines.some((l) => /^\[buried\] digging head gravel with iron_shovel, ~\d+ ms$/.test(l)), b.lines.join('\n'))
})

test('a rescue whose digs of one block fail twice gives up and frees the dig lock', async () => {
  const b = body(GRAVEL, AIR, { cells: walled, hold: true })
  assert.strictEqual(await b.digOutHead(), true)
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'the first dig never started')
  b.releases[0].fail(new Error('Block not in view'))
  assert.ok(await waitFor(() => b.releases.length === 2, 1000), 'the second dig never started')
  b.releases[1].fail(new Error('Block not in view'))
  await b.stepped()
  assert.deepStrictEqual(b.digs, ['gravel', 'gravel'])
  assert.deepStrictEqual(b.events, ['buried: the buried self-rescue gave up: two digs of the head block gravel failed: Block not in view'])
  assert.strictEqual(b.digLock.holder, null)
})

test('a block that falls into the head cell after a dig gets two digs of its own', async () => {
  const b = body(GRAVEL, AIR, { cells: walled, hold: true })
  assert.strictEqual(await b.digOutHead(), true)
  const started = async (n) => assert.ok(await waitFor(() => b.releases.length === n, 1000), `dig ${n} never started`)
  await started(1)
  b.releases[0].fail(new Error('Block not in view'))
  await started(2)
  b.releases[1].finish()
  b.at.set('0,65,0', GRAVEL)
  await started(3)
  b.releases[2].fail(new Error('Block not in view'))
  await started(4)
  b.releases[3].finish()
  await b.stepped()
  assert.deepStrictEqual(b.events, [])
  assert.ok(b.lines.includes('[buried] out (head clear)'), b.lines.join('\n'))
})

// holdHand and endHand over leases, each with the ms of its renews and whether it ended. Renews of the first lost
// leases return false.
function hands ({ lost = 0 } = {}) {
  const leases = []
  return {
    leases,
    holdHand () {
      const lease = { renews: [], ended: false }
      const gone = leases.length < lost
      lease.renew = (ms) => { lease.renews.push(ms); return !gone && !lease.ended }
      leases.push(lease)
      return lease
    },
    endHand (lease) { if (lease) lease.ended = true }
  }
}

// Runs the rescue of b and returns its leases as they stood during its dig.
async function leasesAtDig (b, hand) {
  assert.strictEqual(await b.digOutHead(), true)
  assert.ok(await waitFor(() => b.releases.length === 1, 1000), 'the rescue dig never started')
  const held = hand.leases.map((l) => ({ ...l }))
  b.releases[0].finish()
  await b.stepped()
  return held
}

test('the rescue digs under a hand lease that covers the dig and ends it once over', async () => {
  const hand = hands()
  const b = body(GRAVEL, AIR, { cells: walled, hold: true, holdHand: hand.holdHand, endHand: hand.endHand })
  const held = await leasesAtDig(b, hand)
  assert.strictEqual(held.length, 1, 'the rescue dig ran under no lease from holdHand')
  assert.strictEqual(held[0].ended, false, 'the lease ended before the dig')
  assert.ok(held[0].renews.length === 1 && held[0].renews[0] >= b.bot.digTime(GRAVEL), `renews ${held[0].renews}`)
  assert.deepStrictEqual(hand.leases.map((l) => l.ended), [true], 'the hand stayed leased after the rescue')
})

test('a rescue whose hand lease was taken leases the hand again for its dig', async () => {
  const hand = hands({ lost: 1 })
  const b = body(GRAVEL, AIR, { cells: walled, hold: true, holdHand: hand.holdHand, endHand: hand.endHand })
  const held = await leasesAtDig(b, hand)
  assert.strictEqual(held.length, 2, 'the dig ran without the hand')
  assert.ok(!held[1].ended && held[1].renews.length === 1 && held[1].renews[0] >= b.bot.digTime(GRAVEL), JSON.stringify(held[1]))
  assert.strictEqual(hand.leases[1].ended, true, 'the hand stayed leased after the rescue')
})

test('the rescue stops the walk under way before it digs', async () => {
  let stopped = null
  const b = body(GRAVEL, AIR, { cells: walled, stopPath: () => { stopped = [...b.digs] } })
  assert.deepStrictEqual((await rescue(b)).digs, ['gravel'])
  assert.deepStrictEqual(stopped, [], 'the walk was never stopped')
})

test('a body freed at the head digs out the gravel its feet stand in when no cell beside it is open', async () => {
  const b = body(GRAVEL, GRAVEL, { cells: walled })
  assert.deepStrictEqual(await rescue(b), { log: ['legs'], digs: ['gravel', 'gravel'] })
  assert.strictEqual(b.at.get('0,64,0'), AIR)
  assert.ok(b.lines.includes('[buried] out (feet clear)'), b.lines.join('\n'))
})

test('a body whose head cell fills again while it digs its feet free digs that block too before it reports out', async () => {
  const b = body(GRAVEL, GRAVEL, { cells: walled, hold: true })
  assert.strictEqual(await b.digOutHead(), true)
  const started = async (n) => assert.ok(await waitFor(() => b.releases.length === n, 1000), `dig ${n} never started`)
  await started(1)
  b.releases[0].finish()
  await started(2)
  b.at.set('0,65,0', GRAVEL)
  b.releases[1].finish()
  await started(3)
  b.releases[2].finish()
  await b.stepped()
  assert.deepStrictEqual(b.digs, ['gravel', 'gravel', 'gravel'])
  assert.strictEqual(b.at.get('0,65,0'), AIR)
  assert.ok(b.lines.includes('[buried] out (head clear)'), b.lines.join('\n'))
})

test('a body a hair under its feet cell frees its head and leaves the floor', async () => {
  const b = body(GRAVEL, AIR, { cells: { ...walled, ...floors([0, 64, 0]) } })
  b.bot.entity.position = new Vec3(0.5, 63.9999, 0.5)
  assert.deepStrictEqual(await rescue(b), { log: ['legs'], digs: ['gravel'] })
  assert.ok(b.lines.includes('[buried] out (head clear)'), b.lines.join('\n'))
})

test('a body a hair under its feet cell steps out to the open cell beside it and digs nothing', async () => {
  const b = body(GRAVEL, AIR, { cells: floors([1, 64, 0]) })
  b.bot.entity.position = new Vec3(0.5, 63.9999, 0.5)
  assert.deepStrictEqual(await rescue(b), { log: ['legs', 'step 1,64,0'], digs: [] })
})

test('a body a hair under its feet cell that gave up on an undiggable head gives up once and starts no rescue on the next hit', async () => {
  const b = body(blockOf('bedrock'))
  b.bot.entity.position = new Vec3(0.5, 63.9999, 0.5)
  const gaveUp = () => b.lines.filter((l) => l.startsWith('[buried] gave up: ')).length
  assert.strictEqual(await b.digOutHead(), false, 'first hit')
  assert.strictEqual(gaveUp(), 1, 'control: the first hit gave up')
  assert.strictEqual(await b.digOutHead(), false, 'second hit')
  assert.deepStrictEqual({ log: b.log, gaveUp: gaveUp() }, { log: [], gaveUp: 1 })
})

test('a rescue ends its dig at its deadline or at death and frees the dig lock for the next dig', async () => {
  // Ends a rescue by end during its dig, then digs once more.
  const ended = async (end) => {
    const clock = fakeClock()
    const b = body(GRAVEL, AIR, { cells: walled, hold: true, timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } })
    assert.strictEqual(await b.digOutHead(), true)
    assert.ok(await waitFor(() => b.releases.length === 1, 1000), `${end}: the dig never started`)
    if (end === 'deadline') clock.advance(botConstant('RESCUE_MS'))
    else b.bot.emit('death')
    await b.stepped()
    assert.strictEqual(b.bot.targetDigBlock, null, `${end}: the rescue dig outlived the rescue`)
    assert.strictEqual(b.at.get('0,65,0'), GRAVEL, end)
    assert.strictEqual(b.digLock.holder, null, end)
    const next = b.bot.dig(b.bot.blockAt(STONE_BESIDE))
    assert.ok(await waitFor(() => b.releases.length === 2, 1000), `${end}: the next dig never started`)
    b.releases[1].finish()
    await next
    assert.deepStrictEqual(b.digs, ['gravel', 'stone'], end)
    return b
  }
  const stuck = await ended('deadline')
  assert.match(stuck.events.join('\n'), /^buried: the buried self-rescue gave up: still buried after \d+ s$/)
  const dying = await ended('death')
  assert.deepStrictEqual(dying.events, [])
  assert.ok(dying.lines.includes('[buried] gave up: died'), dying.lines.join('\n'))
})

test('a rescue dig still turning to look when the rescue ends at its deadline or at death never starts', async () => {
  for (const end of ['deadline', 'death']) {
    const clock = fakeClock()
    let looked = null
    const b = body(GRAVEL, AIR, { cells: walled, hold: true, look: () => new Promise((resolve) => { looked = resolve }), timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } })
    assert.strictEqual(await b.digOutHead(), true)
    assert.ok(await waitFor(() => looked, 1000), `${end}: the dig never began its look`)
    if (end === 'deadline') clock.advance(botConstant('RESCUE_MS'))
    else b.bot.emit('death')
    assert.ok(await waitFor(() => { clock.advance(50); return b.digLock.holder === null }, 1000), `${end}: the dig lock never freed`)
    looked()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepStrictEqual({ digs: b.digs, digging: !!b.bot.targetDigBlock }, { digs: [], digging: false }, end)
  }
})

test('a body that moved to another cell between hits gives up again, with one event per 3 s for the same reason', async () => {
  let now = 0
  const bedrock = blockOf('bedrock')
  const b = body(bedrock, AIR, { cells: { '1,65,0': bedrock }, timers: { Date: { now: () => now } } })
  const gaveUp = () => b.lines.filter((l) => l.startsWith('[buried] gave up: ')).length
  for (const [t, dx] of [[0, 0], [500, 1], [3001, -1]]) {
    now = t
    b.bot.entity.position = b.bot.entity.position.offset(dx, 0, 0)
    assert.strictEqual(await b.digOutHead(), false, `the hit at ${t} ms started a rescue`)
  }
  assert.deepStrictEqual(b.events, Array(2).fill('buried: the buried self-rescue gave up: the head block bedrock cannot be dug'))
  assert.strictEqual(gaveUp(), 3, 'control: each move gives up again')
  b.bot.entity.position = b.bot.entity.position.offset(0.3, 0, 0)
  assert.strictEqual(await b.digOutHead(), false)
  assert.strictEqual(gaveUp(), 3, 'a move within the feet cell gave up again')
})

// The alarm listeners on a body at (0, 64, 0) with its head in gravel, over cells. walk moves the body, hit lands
// a hit of dmg (3 unless given) with the given attribution (none for null), log and digs record what the body did,
// hurt holds the hurt events and lines the log lines. Each body gets a fresh alarms module with no hurt throttle
// running. A step reaches its cell and leaves the body in its middle. center(cell) stands in for centring on a cell
// and by default moves the body to its middle. With controls the body keeps its control states there and freezes
// and steps with the real freezeBody and nudgeInto.
function wiredBody (t, cells, { hold = false, equip = async () => {}, controls = null, center = null } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const id = require.resolve('../lib/bot/alarms')
  delete require.cache[id]
  const { createAlarms, bindAlarms, wireTrailMarks, wireBodyAlarms } = require(id)
  delete require.cache[id]
  const log = []
  const hurt = []
  const lines = []
  t.mock.method(console, 'log', (line) => lines.push(line))
  const { bot, at, digs, releases } = diggingBot(GRAVEL, AIR, cells, { hold })
  const { suffocates, smotherBlock, waterState, holdsWater } = loadBotFunctions(['suffocates', 'waterState', 'holdsWater'], { bot, LEGACY_1710: false })
  Object.assign(bot, { health: 20, food: 20 })
  const fight = { lastHit: null, lastAttrib: null, swingWait: null }
  const ctx = {
    bot,
    fight,
    bunker: { building: false },
    reflexes: [],
    mobClass: () => 'hostile',
    CONFIRMED_HORIZON: 16,
    emitEvent: (kind, msg) => { if (kind === 'hurt') hurt.push(msg) },
    waterState,
    freezeBody: () => { log.push('freeze') },
    suffocates,
    smotherBlock,
    holdsWater,
    holdDigTool: equip,
    holdHand: () => ({ renew: () => true }),
    endHand () {},
    markTrail: () => {},
    markBody: () => {},
    knownCell: () => true,
    takeLegs: () => { log.push('legs') },
    stopPath: () => {},
    nudgeInto: async (c) => { log.push(`step ${key(c)}`); bot.entity.position = middle(c, c.y); return true },
    centerOnCell: center || (async (c = bot.entity.position.floored()) => { bot.entity.position = middle(c, bot.entity.position.y); return true })
  }
  if (controls) {
    Object.assign(bot, { setControlState: (c, on) => { controls[c] = on }, clearControlStates: () => { for (const c in controls) controls[c] = false } })
    ctx.freezeBody = loadBotFunctions(['freezeBody'], { bot, takeLegs: ctx.takeLegs, stopPath: ctx.stopPath }).freezeBody
    ctx.nudgeInto = loadBotFunctions(['nudgeInto'], { bot, bunker: ctx.bunker, swimUpUntil: 0, require, setTimeout }).nudgeInto
  }
  createAlarms(ctx)
  bindAlarms(ctx)
  const { digLock, bindDigLock, wireDigGuard } = require('../lib/bot/dig-lock')
  bindDigLock(ctx)
  wireDigGuard()
  bot.emit('spawn')
  wireTrailMarks()
  wireBodyAlarms()
  const health = () => Promise.all(bot.listeners('health').map((f) => f()))
  return {
    walk (x, y, z) {
      const was = bot.entity.position
      bot.entity.position = new Vec3(x, y, z)
      bot.emit('move', was)
    },
    async hit (attrib, dmg = 3) {
      await health()
      bot.health -= dmg
      fight.lastAttrib = attrib && { t: Date.now(), ranged: false, ...attrib }
      await health()
      await new Promise((resolve) => setImmediate(resolve))
    },
    // Settles once no rescue holds the dig lock.
    ended: () => waitFor(() => digLock.holder === null, 1000),
    at,
    releases,
    log,
    digs,
    hurt,
    lines
  }
}

const SOURCELESS = { desc: 'no attacker named, no hostile within 4', entity: null, env: true }

test('a jump in place keeps the column the feet came from as the step-out', async (t) => {
  const b = wiredBody(t, floors([1, 64, 0], [-1, 64, 0]))
  b.walk(-0.5, 64, 0.5)
  b.walk(0.5, 64, 0.5)
  b.walk(0.5, 65.2, 0.5)
  b.walk(0.5, 64, 0.5)
  await b.hit(SOURCELESS)
  assert.deepStrictEqual({ log: b.log, digs: b.digs }, { log: ['legs', 'step -1,64,0'], digs: [] })
})

test('a buried body hit by a hostile in reach steps out without freezing', async (t) => {
  const b = wiredBody(t, floors([1, 64, 0]))
  await b.hit({ desc: 'zombie 3 E', entity: { name: 'zombie', position: new Vec3(3.5, 64, 0.5) }, env: false })
  assert.deepStrictEqual({ log: b.log, digs: b.digs }, { log: ['legs', 'step 1,64,0'], digs: [] })
})

test('a buried body hit with no attacker named says what it suffocates in', async (t) => {
  const b = wiredBody(t, floors([1, 64, 0]))
  await b.hit({ ...SOURCELESS, untyped: true }, 1)
  assert.deepStrictEqual(b.hurt, ['took 1 damage (suffocating inside gravel), HP 19/20'])
})

test('a body off-centre beside gravel at eye height hit with no attacker named says it suffocates in the gravel and starts the rescue', async (t) => {
  const b = wiredBody(t, {})
  b.walk(1.2, 64, 0.5)
  await b.hit({ ...SOURCELESS, untyped: true }, 1)
  assert.deepStrictEqual(b.hurt, ['took 1 damage (suffocating inside gravel), HP 19/20'])
  assert.strictEqual(b.log[0], 'legs', 'the rescue never started')
  assert.ok(await b.ended(), 'the rescue never ended')
})

test('a buried body hit with no attribution says what it suffocates in and steps out unfrozen', async (t) => {
  const b = wiredBody(t, floors([1, 64, 0]))
  await b.hit(null, 1)
  assert.deepStrictEqual({ hurt: b.hurt, log: b.log }, { hurt: ['took 1 damage (suffocating inside gravel), HP 19/20'], log: ['legs', 'step 1,64,0'] })
})

test('a step-out under way reaches its cell through a hit with no attribution', async (t) => {
  const controls = {}
  const b = wiredBody(t, floors([1, 64, 0]), { controls })
  await b.hit(SOURCELESS)
  assert.strictEqual(controls.forward, true, 'control: the step-out holds forward')
  await b.hit(null, 1)
  if (controls.forward) b.walk(1.5, 64, 0.5)
  assert.ok(await b.ended(), 'the rescue never ended')
  assert.ok(b.lines.includes('[buried] out (stepped)'), b.lines.join('\n'))
})

test('a step-out that stops with the eye still in the gravel column is not out and digs the gravel', async (t) => {
  const controls = {}
  const b = wiredBody(t, floors([1, 64, 0]), { controls, center: async () => false })
  await b.hit(SOURCELESS)
  assert.strictEqual(controls.forward, true, 'control: the step-out holds forward')
  b.walk(1.2, 64, 0.5)
  assert.ok(await b.ended(), 'the rescue never ended')
  assert.ok(!b.lines.includes('[buried] out (stepped)'), b.lines.join('\n'))
  assert.deepStrictEqual(b.digs, ['gravel'])
  assert.strictEqual(b.at.get('0,65,0'), AIR)
})

test('a buried body hit after a nearby swing keeps the swing in its text', async (t) => {
  const b = wiredBody(t, floors([1, 64, 0]))
  await b.hit({ desc: 'no attacker named, Steve swung nearby', entity: null, env: true }, 1)
  assert.deepStrictEqual(b.hurt, ['took 1 damage (no attacker named, Steve swung nearby), HP 19/20'])
})

test('a buried body hit for more than suffocation deals keeps its text', async (t) => {
  const b = wiredBody(t, floors([1, 64, 0]))
  await b.hit({ ...SOURCELESS, untyped: true }, 7)
  assert.deepStrictEqual(b.hurt, ['took 7 damage (no attacker named, no hostile within 4), HP 13/20'])
})

test('a buried body hit with no attribution for more than suffocation deals names no suffocation and steps out unfrozen', async (t) => {
  const b = wiredBody(t, floors([1, 64, 0]))
  await b.hit(null, 7)
  assert.deepStrictEqual(b.hurt, ['took 7 damage (unknown \u2014 look around), HP 13/20'])
  assert.deepStrictEqual(b.log, ['legs', 'step 1,64,0'])
})

test('a rescue dig that outlasts two hits starts once and clears the head cell', async (t) => {
  const b = wiredBody(t, walled, { hold: true })
  for (let i = 0; i < 3; i++) await b.hit({ ...SOURCELESS, untyped: true }, 1)
  assert.deepStrictEqual(b.digs, ['gravel'])
  b.releases[0].finish()
  assert.ok(await b.ended(), 'the rescue never ended')
  assert.strictEqual(b.at.get('0,65,0'), AIR)
  assert.ok(b.lines.includes('[buried] out (head clear)'), b.lines.join('\n'))
})

test('the hurt handler returns while the rescue is under way and counts each hit from the last', async (t) => {
  let equipped
  const b = wiredBody(t, walled, { equip: () => new Promise((resolve) => { equipped = resolve }) })
  for (let i = 0; i < 2; i++) assert.notStrictEqual((await timed(b.hit(SOURCELESS), 1000)).out, HUNG, `hit ${i + 1} waited on the rescue`)
  assert.deepStrictEqual(b.hurt, ['took 3 damage (no attacker named, no hostile within 4), HP 17/20'])
  equipped()
  assert.ok(await b.ended(), 'the rescue never ended')
  assert.deepStrictEqual(b.digs, ['gravel'])
})
