'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals, Movements, startCell } = require('mineflayer-pathfinder')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const { HUNG, botConstant, loadBotFunctions, routeHandler, waitFor, timed } = require('./helpers')
const { entityInCell } = require('../lib/shelter')

const noPath = () => Object.assign(new Error('No path to the goal!'), { name: 'NoPath' })

// A cave of stone under y 64 and air above, with blocks at the given 'x,y,z' cells, each a name or [name, properties].
// The bot sees and knows every cell but the unseen ones.
// Each walk ends in the nearest goal cell within 2 of the body, on its level or one below.
function cave (pos, blocks, { unseen = [], own = [], hold = false, stuck = false, query = {} } = {}) {
  const cells = new Map(Object.entries(blocks))
  const digs = []
  const releases = []
  const walks = []
  const blockAt = (p) => {
    const c = p.floored()
    const [name, props] = [].concat(cells.get(`${c.x},${c.y},${c.z}`) || (c.y < 64 ? 'stone' : 'air'))
    const b = props ? Block.fromProperties(name, props, 0) : Block.fromStateId(registry.blocksByName[name].defaultState, 0)
    return Object.assign(b, { position: c })
  }
  const bot = Object.assign(new EventEmitter(), {
    registry,
    entity: { position: pos, width: 0.6, height: 1.8 },
    heldItem: null,
    inventory: { items: () => [] },
    digTime: () => 0,
    waitForTicks: async () => {},
    blockAt,
    world: {
      raycast (from, dir, range) {
        for (let t = 0; t <= range; t += 0.05) {
          const c = from.plus(dir.scaled(t)).floored()
          if (blockAt(c).shapes.length) return { position: c }
        }
        return null
      }
    },
    pathfinder: {
      startCell: (p) => startCell(bot, p),
      goal: null,
      setGoal (goal) {
        walks.push(`setGoal ${goal}`)
        bot.pathfinder.goal = goal
      },
      async goto (goal) {
        walks.push('goto')
        bot.pathfinder.goal = goal
        const here = bot.entity.position
        if (stuck) return
        if (goal.isEnd(here.floored())) {
          bot.pathfinder.goal = null
          return
        }
        const open = (c) => blockAt(c).shapes.length === 0
        const ends = []
        for (let x = -2; x <= 2; x++) {
          for (let z = -2; z <= 2; z++) {
            for (const dy of [0, -1]) {
              const c = here.floored().offset(x, dy, z)
              if (open(c) && open(c.offset(0, 1, 0)) && goal.isEnd(c)) ends.push(c)
            }
          }
        }
        const end = ends.sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0]
        if (!end) throw noPath()
        bot.entity.position = end.offset(0.5, 0, 0.5)
        bot.pathfinder.goal = null
      }
    },
    async dig (b) {
      const at = `${b.position.x},${b.position.y},${b.position.z}`
      digs.push(`${at} from ${bot.entity.position.floored()}`)
      if (hold) await new Promise((resolve, reject) => releases.push({ resolve, reject }))
      cells.set(at, 'air')
    }
  })
  const known = (p) => !unseen.includes(`${p.x},${p.y},${p.z}`)
  const ck = (x, y, z) => `${x},${y},${z}`
  bot.pathfinder.movements = loadBotFunctions(['knownMoves'], { bot, ck, PLAN_KNOWN: new Map(), planKnown: known }).knownMoves(new Movements(bot))
  const { bodyTouches } = loadBotFunctions(['bodyTouches'], { bot })
  const env = {
    bot,
    require,
    goals,
    entityInCell,
    LEGACY_1710: false,
    bunker: { building: false },
    digLock: botConstant('digLock'),
    cellKnown: known,
    knownCell: known,
    seenNow: (p) => bodyTouches(p) || known(p),
    leafInTheWay: () => null,
    round: (v) => ({ x: v.x, y: v.y, z: v.z }),
    refuseWhileFighting () {},
    stopPath () { bot.pathfinder.setGoal(null) },
    holdHand: () => ({ renew: () => true }),
    endHand () {},
    holdDigTool: async () => {},
    holdHarvester: async () => null,
    neededPickTier: () => 0,
    PICK_TIER: {},
    ck,
    recentOwnEdits: new Map(own.map((k) => [k, Date.now()]))
  }
  const digat = (at) => {
    const { handle } = routeHandler('/digat', env)
    const res = {}
    const [x, y, z] = at.split(',')
    return { res, done: handle({ query: { x, y, z, ...query } }, res) }
  }
  // The collect digs through the dig guard, and the server answers each dig with air.
  const mine = async (name, count = 1) => {
    loadBotFunctions(['wireDigGuard'], { bot, digLock: env.digLock }).wireDigGuard()
    bot.emit('spawn')
    Object.assign(env, {
      shared: { mcData: registry },
      resolveBlockIds: (n) => [registry.blocksByName[n].id],
      collectLock: { done: null },
      watchedWork: (work) => work(),
      pastUnstuck: (walk) => walk(),
      digScope: new AsyncLocalStorage(),
      LEGACY_DIG_CONFIRM_MS: botConstant('LEGACY_DIG_CONFIRM_MS'),
      legs: { mark: () => 0 },
      nearestVisible: (ids) => [...cells].map(([k]) => blockAt(new Vec3(...k.split(',').map(Number)))).find((b) => ids.includes(b.type)) || null,
      collectSafely: async (b) => {
        await bot.pathfinder.goto(new goals.GoalLookAtBlock(b.position, bot.world))
        await bot.dig(b)
        bot.emit(`blockUpdate:${b.position}`, b, blockAt(b.position))
      }
    })
    const { handle, res } = routeHandler('/mine', env)
    await handle({ query: { name, count: String(count) } }, res)
    return { error: res.error, reply: res.body }
  }
  return { digat, mine, digs, releases, walks, digLock: env.digLock, bot, env }
}

async function digOnce (pos, blocks, at, opts) {
  const w = cave(pos, blocks, opts)
  const { res, done } = w.digat(at)
  await done
  return { error: res.error, reply: res.body, digs: w.digs }
}

// The body stands at 0,64,0 with its head at 0,65,0 under an ore at 0,66,0.
const UNDER = new Vec3(0.5, 64, 0.5)
const CAPPED = { '0,66,0': 'iron_ore', '0,67,0': 'gravel' }

test('digat refuses an ore over the head with seen gravel on it, naming the gravel', async () => {
  const r = await digOnce(UNDER, CAPPED, '0,66,0')
  assert.match(r.error && r.error.message, /^refusing to dig iron_ore at 0,66,0: gravel at 0,67,0 would fall on me\b/)
  assert.deepStrictEqual(r.digs, [])
})

test('digat refuses under seen gravel naming anyway, and with anyway digs it', async () => {
  const refused = await digOnce(UNDER, CAPPED, '0,66,0')
  assert.match(refused.error && refused.error.message, /\banyway\b/)
  const r = await digOnce(UNDER, CAPPED, '0,66,0', { query: { anyway: '1' } })
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(r.digs, ['0,66,0 from (0, 64, 0)'])
})

test('digat refuses under a column of sand, naming the column from its lowest to its highest cell', async () => {
  const r = await digOnce(UNDER, { '0,66,0': 'iron_ore', '0,67,0': 'sand', '0,68,0': 'sand', '0,69,0': 'sand' }, '0,66,0')
  assert.match(r.error && r.error.message, /^refusing to dig iron_ore at 0,66,0: sand at 0,67,0 to 0,69,0 would fall on me\b/)
  assert.deepStrictEqual(r.digs, [])
})

// The body's box reaches 0.15 into the open cells at 1,64,0 and 1,65,0, under an ore at 1,66,0.
const EDGE = new Vec3(0.85, 64, 0.5)
const BESIDE = { '1,66,0': 'iron_ore', '1,67,0': 'sand', '1,68,0': 'sand' }

test('digat refuses a cell beside the body when the column over it falls into the edge of the body\'s box', async () => {
  const edge = await digOnce(EDGE, BESIDE, '1,66,0')
  assert.match(edge.error && edge.error.message, /^refusing to dig iron_ore at 1,66,0: sand at 1,67,0 to 1,68,0 would fall on me\b/)
  const centred = await digOnce(UNDER, BESIDE, '1,66,0')
  assert.strictEqual(centred.error, undefined, centred.error && centred.error.message)
  assert.deepStrictEqual(centred.digs, ['1,66,0 from (0, 64, 0)'])
})

test('digat refuses a cell beside the body when the floor beside the feet is unseen', async () => {
  const unseen = [63, 62, 61, 60].map((y) => `1,${y},0`)
  const r = await digOnce(EDGE, BESIDE, '1,66,0', { unseen })
  assert.match(r.error && r.error.message, /^refusing to dig iron_ore at 1,66,0: sand at 1,67,0 to 1,68,0 would fall on me\b/)
  assert.deepStrictEqual(r.digs, [])
})

test('digat digs the head cell of a body buried in gravel, though the gravel over it falls in after', async () => {
  const r = await digOnce(UNDER, { '0,64,0': 'gravel', '0,65,0': 'gravel', '0,66,0': 'gravel' }, '0,65,0')
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(r.digs, ['0,65,0 from (0, 64, 0)'])
})

test('digat refuses a ladder in the head cell of a body on the ladder with gravel over it', async () => {
  const r = await digOnce(UNDER, { '0,64,0': 'ladder', '0,65,0': 'ladder', '0,66,0': 'gravel' }, '0,65,0')
  assert.match(r.error && r.error.message, /^refusing to dig ladder at 0,65,0: gravel at 0,66,0 would fall on me\b/)
  assert.deepStrictEqual(r.digs, [])
})

test('digat refuses a cell beside gravel that hangs over the head', async () => {
  const r = await digOnce(UNDER, { '1,66,0': 'stone', '0,66,0': 'gravel' }, '1,66,0')
  assert.match(r.error && r.error.message, /^refusing to dig stone at 1,66,0: gravel at 0,66,0 would fall on me\b/)
})

test('digat refuses a cell over gravel that hangs over the head, naming the column over the cell with it', async () => {
  const under = await digOnce(UNDER, { '0,66,0': 'gravel', '0,67,0': 'iron_ore' }, '0,67,0')
  assert.match(under.error && under.error.message, /^refusing to dig iron_ore at 0,67,0: gravel at 0,66,0 would fall on me\b/)
  assert.deepStrictEqual(under.digs, [])
  const both = await digOnce(UNDER, { '0,66,0': 'gravel', '0,67,0': 'iron_ore', '0,68,0': 'sand' }, '0,67,0')
  assert.match(both.error && both.error.message, /^refusing to dig iron_ore at 0,67,0: gravel at 0,66,0 plus sand at 0,68,0 would fall on me\b/)
  const runs = await digOnce(UNDER, { '0,66,0': 'gravel', '0,67,0': 'iron_ore', '0,68,0': 'gravel', '0,69,0': 'sand' }, '0,67,0')
  assert.match(runs.error && runs.error.message, /^refusing to dig iron_ore at 0,67,0: gravel at 0,66,0 plus gravel and sand at 0,68,0 to 0,69,0 would fall on me\b/)
})

// Cobblestone walls round the feet and head cells of a body at UNDER, so no cell beside the stone at 0,63,0 holds it.
const SHAFT = {}
for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) for (const y of [64, 65]) SHAFT[`${x},${y},${z}`] = 'cobblestone'
// Gravel at 0,62,0 hangs over air down to 0,60,0.
const HANGING = { ...SHAFT, '0,62,0': 'gravel', '0,61,0': 'air', '0,60,0': 'air' }

test('digat digs the cell under the feet in a shaft over hanging gravel the stone hides', async () => {
  const r = await digOnce(UNDER, HANGING, '0,63,0', { unseen: ['0,62,0', '0,61,0', '0,60,0'] })
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(r.digs, ['0,63,0 from (0, 64, 0)'])
})

test('digat digs under gravel that would land on a torch in the feet cell and break', async () => {
  const r = await digOnce(UNDER, { ...CAPPED, '0,64,0': 'torch' }, '0,66,0')
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(r.digs, ['0,66,0 from (0, 64, 0)'])
})

test('digat digs under gravel the bot has not seen', async () => {
  const r = await digOnce(UNDER, CAPPED, '0,66,0', { unseen: ['0,67,0'] })
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(r.digs, ['0,66,0 from (0, 64, 0)'])
})

test('digat names only the seen part of a column whose top the bot has not seen', async () => {
  const r = await digOnce(UNDER, { ...CAPPED, '0,68,0': 'gravel' }, '0,66,0', { unseen: ['0,68,0'] })
  assert.match(r.error && r.error.message, /^refusing to dig iron_ore at 0,66,0: gravel at 0,67,0 would fall on me\b/)
})

test('a digat while another runs answers busy naming the running dig, and the running dig goes on', async () => {
  const w = cave(UNDER, { '1,64,0': 'iron_ore', '1,65,0': 'stone' }, { hold: true })
  const first = w.digat('1,65,0')
  assert.ok(await waitFor(() => w.releases.length === 1, 1000), 'the first dig never started')
  const second = w.digat('1,64,0')
  assert.notStrictEqual((await timed(second.done, 1000)).out, HUNG, 'the second digat waited for the first')
  assert.deepStrictEqual(w.digs, ['1,65,0 from (0, 64, 0)'])
  assert.strictEqual(second.res.error && second.res.error.reason, 'busy')
  assert.match(second.res.error.message, /^busy: digat stone at 1,65,0 is running, nothing dug\b/)
  w.releases[0].resolve()
  await first.done
  assert.strictEqual(first.res.error, undefined, first.res.error && first.res.error.message)
  assert.strictEqual(first.res.body.dug, 'stone')
  const third = w.digat('1,64,0')
  assert.ok(await waitFor(() => w.releases.length === 2, 1000), 'the lock outlived the dig that held it')
  w.releases[1].resolve()
  await third.done
  assert.strictEqual(third.res.body.dug, 'iron_ore')
})

test('a digat whose dig another claim takes over names the taker', async () => {
  const w = cave(UNDER, { '1,65,0': 'stone' }, { hold: true })
  const { claimDig } = loadBotFunctions(['claimDig'], { digLock: w.digLock })
  const run = w.digat('1,65,0')
  assert.ok(await waitFor(() => w.releases.length === 1, 1000), 'the dig never started')
  claimDig('the buried self-rescue', true)
  w.releases[0].reject(new Error('Digging aborted'))
  await run.done
  assert.strictEqual(run.res.error && run.res.error.message, 'the buried self-rescue took over digat stone at 1,65,0, nothing dug')
  assert.match(w.digat('1,65,0').res.error?.message || '', /^busy: the buried self-rescue is running\b/)
})

test('a takeover during a digat\'s walk stops the walk, and the digat names the taker and never takes the hand', async () => {
  const w = cave(UNDER, { '6,65,0': 'stone' })
  const { claimDig } = loadBotFunctions(['claimDig'], { digLock: w.digLock })
  let stop = null
  w.bot.pathfinder.goto = () => new Promise((resolve, reject) => { stop = reject })
  w.env.stopPath = () => stop(Object.assign(new Error('Path was stopped before it could be completed! Thus, the desired goal was not reached.'), { name: 'PathStopped' }))
  let hands = 0
  w.env.holdHand = () => { hands++; return { renew: () => true } }
  const run = w.digat('6,65,0')
  assert.ok(await waitFor(() => !!stop, 1000), 'the walk never started')
  claimDig('the buried self-rescue', true)
  assert.notStrictEqual((await timed(run.done, 1000)).out, HUNG, 'the takeover left the walk running')
  assert.strictEqual(run.res.error && run.res.error.message, 'the buried self-rescue took over digat stone at 6,65,0, nothing dug')
  assert.strictEqual(hands, 0)
})

test('a digat taken over during its tool equip names the taker before the next equip', async () => {
  const w = cave(UNDER, { '1,65,0': 'stone' })
  const { claimDig } = loadBotFunctions(['claimDig'], { digLock: w.digLock })
  const equips = []
  let equipped = null
  w.env.holdDigTool = async () => { equips.push('tool'); await new Promise((resolve) => { equipped = resolve }) }
  w.env.holdHarvester = async () => { equips.push('harvester'); return null }
  const run = w.digat('1,65,0')
  assert.ok(await waitFor(() => !!equipped, 1000), 'the equip never started')
  claimDig('the buried self-rescue', true)
  equipped()
  await run.done
  assert.strictEqual(run.res.error && run.res.error.message, 'the buried self-rescue took over digat stone at 1,65,0, nothing dug')
  assert.deepStrictEqual(equips, ['tool'])
  assert.deepStrictEqual(w.digs, [])
})

test('digat of a cell seen from beyond reach digs nothing when its walk closer ends where that cell is out of sight', async () => {
  const p = new Vec3(5, 64, 0)
  for (const after of ['seen', 'unseen']) {
    const w = cave(UNDER, { '5,64,0': 'stone' })
    const seenNow = w.env.seenNow
    w.env.seenNow = (c) => (after === 'seen' || !c.equals(p) || !w.walks.length) && seenNow(c)
    const { res, done } = w.digat('5,64,0')
    await done
    const out = { error: res.error && res.error.message, digs: w.digs, walks: w.walks }
    const want = after === 'seen'
      ? { error: undefined, digs: ['5,64,0 from (2, 64, 0)'], walks: ['goto'] }
      : { error: 'not in my sight, blocked or unlit: walk closer, clear the view or light it', digs: [], walks: ['goto'] }
    assert.deepStrictEqual(out, want, after)
  }
})

// A trench the bot dug in the floor east of the body at UNDER.
const TRENCH = ['1,63,0', '2,63,0', '3,63,0']
const DUG = Object.fromEntries(TRENCH.map((k) => [k, 'air']))

test('digat walks to a cell beside the trench it dug, not into the trench', async () => {
  const w = cave(UNDER, DUG, { own: TRENCH })
  const { res, done } = w.digat('4,63,0')
  await done
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(w.digs, ['4,63,0 from (2, 64, 0)'])
})

const WALLED = { ...DUG, ...Object.fromEntries([-2, -1, 0, 1, 2].map((z) => [`2,64,${z}`, 'cobblestone'])) }

test('digat walks into the trench it dug when no other cell in reach has a path, clearing the goal between the walks', async () => {
  for (const first of ['no path', 'an empty plan']) {
    const w = cave(UNDER, WALLED, { own: TRENCH })
    const walk = w.bot.pathfinder.goto
    // The empty plan comes from a search that met the trench cell.
    if (first === 'an empty plan') {
      w.bot.pathfinder.goto = async (goal) => {
        if (w.walks.length) return walk(goal)
        w.walks.push('goto')
        w.bot.pathfinder.goal = goal
        goal.isEnd(new Vec3(1, 63, 0))
      }
    }
    const { res, done } = w.digat('4,63,0')
    await done
    assert.strictEqual(res.error, undefined, `${first}: ${res.error && res.error.message}`)
    assert.deepStrictEqual(w.digs, ['4,63,0 from (1, 63, 0)'], first)
    assert.deepStrictEqual(w.walks, ['goto', 'setGoal null', 'goto'], first)
  }
})

test('digat whose walk met no cell it dug and found no path walks once, clears its goal and digs nothing', async () => {
  const w = cave(UNDER, DUG)
  w.bot.pathfinder.goto = async (goal) => {
    w.walks.push('goto')
    w.bot.pathfinder.goal = goal
    throw noPath()
  }
  const { res, done } = w.digat('4,63,0')
  await done
  assert.match(res.error && res.error.message, /No path/)
  assert.deepStrictEqual(w.digs, [])
  assert.deepStrictEqual(w.walks, ['goto', 'setGoal null'])
  assert.strictEqual(w.bot.pathfinder.goal, null)
})

test('digat whose walk ends on an empty plan clears its goal', async () => {
  const w = cave(UNDER, { '6,65,0': 'stone' }, { stuck: true })
  const { done } = w.digat('6,65,0')
  await done
  assert.deepStrictEqual(w.walks, ['goto', 'setGoal null'])
  assert.strictEqual(w.bot.pathfinder.goal, null)
})

test('digat clears the goal of its walk into the trench when that walk ends short of it', async () => {
  for (const end of ['no path', 'an empty plan']) {
    const w = cave(UNDER, WALLED, { own: TRENCH })
    const walk = w.bot.pathfinder.goto
    w.bot.pathfinder.goto = async (goal) => {
      if (!w.walks.length) return walk(goal)
      w.walks.push('goto')
      w.bot.pathfinder.goal = goal
      if (end === 'no path') throw noPath()
    }
    const { done } = w.digat('4,63,0')
    await done
    assert.deepStrictEqual(w.walks, ['goto', 'setGoal null', 'goto', 'setGoal null'], end)
    assert.strictEqual(w.bot.pathfinder.goal, null, end)
  }
})

// The stall watch stops the walk before it rejects.
const WALK_FAILS = {
  'a timeout': () => Object.assign(new Error('Took to long to decide path to goal!'), { name: 'Timeout' }),
  'a search that outlasted the think timeout': (w) => {
    w.bot.pathfinder.setGoal(null)
    return Object.assign(new Error('stalled at 0,64,0'), { reason: 'stalled', planning: true })
  }
}

test('digat whose walk beside the trench ends in a body stall stops there and digs nothing', async () => {
  const w = cave(UNDER, WALLED, { own: TRENCH })
  w.bot.pathfinder.goto = async (goal) => {
    w.walks.push('goto')
    w.bot.pathfinder.goal = goal
    goal.isEnd(new Vec3(1, 63, 0))
    w.bot.pathfinder.setGoal(null)
    throw Object.assign(new Error('stalled at 0,64,0'), { reason: 'stalled' })
  }
  const { res, done } = w.digat('4,63,0')
  await done
  assert.strictEqual(res.error && res.error.message, 'stalled at 0,64,0')
  assert.deepStrictEqual(w.digs, [])
  assert.deepStrictEqual(w.walks, ['goto', 'setGoal null'])
})

for (const [first, fail] of Object.entries(WALK_FAILS)) {
  test(`digat walks into the trench it dug when the walk beside it ends in ${first}`, async () => {
    const w = cave(UNDER, WALLED, { own: TRENCH })
    const walk = w.bot.pathfinder.goto
    // The failed search met the trench cell.
    w.bot.pathfinder.goto = async (goal) => {
      if (w.walks.length) return walk(goal)
      w.walks.push('goto')
      w.bot.pathfinder.goal = goal
      goal.isEnd(new Vec3(1, 63, 0))
      throw fail(w)
    }
    const { res, done } = w.digat('4,63,0')
    await done
    assert.strictEqual(res.error, undefined, res.error && res.error.message)
    assert.deepStrictEqual(w.digs, ['4,63,0 from (1, 63, 0)'])
    assert.deepStrictEqual(w.walks, ['goto', 'setGoal null', 'goto'])
  })
}

// A tunnel the bot dug at y 60 to 61, ending at the wall at 6,60,0.
const TUNNEL = [1, 2, 3, 4, 5].flatMap((x) => [`${x},60,0`, `${x},61,0`])

test('digat walks into the tunnel it dug in a single walk when it can stand nowhere else in reach of the wall', async () => {
  const w = cave(UNDER, Object.fromEntries(TUNNEL.map((k) => [k, 'air'])), { own: TUNNEL })
  const end = new Vec3(5, 60, 0)
  const ends = []
  w.bot.pathfinder.goto = async (goal) => {
    w.walks.push('goto')
    w.bot.pathfinder.goal = goal
    ends.push(goal.isEnd(end))
    if (!ends[ends.length - 1]) throw noPath()
    w.bot.entity.position = end.offset(0.5, 0, 0.5)
    w.bot.pathfinder.goal = null
  }
  const { res, done } = w.digat('6,60,0')
  await done
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(w.digs, ['6,60,0 from (5, 60, 0)'])
  assert.deepStrictEqual([w.walks, ends], [['goto'], [true]])
})

test('digat walking from a cell it dug may end in another it dug, as in a tunnel', async () => {
  const tunnel = ['0,63,0', ...TRENCH, '4,63,0']
  const w = cave(new Vec3(0.5, 63, 0.5), Object.fromEntries(tunnel.map((k) => [k, 'air'])), { own: tunnel })
  const { res, done } = w.digat('5,63,0')
  await done
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(w.digs, ['5,63,0 from (2, 63, 0)'])
  assert.deepStrictEqual(w.walks, ['goto'])
})

// Cells south of the wall at 6,60,0, where 6,60,2 sees the wall's south face over 6,60,1.
const POCKET = ['6,60,1', '6,61,1', '6,60,2', '6,61,2']

test('digat walks into its tunnel in a single walk when the only other cell in reach of the wall is unseen or in lava', async () => {
  const cases = {
    unseen: [Object.fromEntries(POCKET.map((k) => [k, 'air'])), [...POCKET, '6,59,1', '6,59,2']],
    lava: [{ '6,60,1': 'lava', '6,61,1': 'air', '6,60,2': 'lava', '6,61,2': 'air' }, []]
  }
  for (const [pocket, [blocks, unseen]] of Object.entries(cases)) {
    const w = cave(UNDER, { ...Object.fromEntries(TUNNEL.map((k) => [k, 'air'])), ...blocks }, { own: TUNNEL, unseen })
    const end = new Vec3(5, 60, 0)
    const ends = []
    w.bot.pathfinder.goto = async (goal) => {
      w.walks.push('goto')
      w.bot.pathfinder.goal = goal
      ends.push(goal.isEnd(end))
      if (!ends[ends.length - 1]) throw noPath()
      w.bot.entity.position = end.offset(0.5, 0, 0.5)
      w.bot.pathfinder.goal = null
    }
    const { res, done } = w.digat('6,60,0')
    await done
    assert.strictEqual(res.error, undefined, `${pocket}: ${res.error && res.error.message}`)
    assert.deepStrictEqual([w.walks, ends], [['goto'], [true]], pocket)
  }
})

// A hill of stone from y 64 to 66 with a tunnel the bot dug along z 0 from x 0 to 5, ending at the face at 6,64,0.
const HILL = {}
for (let x = 0; x <= 12; x++) for (let z = -4; z <= 4; z++) for (const y of [64, 65, 66]) HILL[`${x},${y},${z}`] = 'stone'
const BORE = [0, 1, 2, 3, 4, 5].flatMap((x) => [`${x},64,0`, `${x},65,0`])
for (const k of BORE) HILL[k] = 'air'
const FACE_END = new Vec3(5, 64, 0)
// The roof hides the face from this open cell in reach on the hill top.
const HILL_TOP = new Vec3(6, 67, 0)
// Known open cells out of the walk's reach that see the face's south side.
const HOLLOW = ['6,64,1', '6,65,1', '6,64,2', '6,65,2']

// Each walk ends at the first of FACE_END and HILL_TOP the goal accepts.
function hill (blocks) {
  const w = cave(new Vec3(-3.5, 64, 3.5), blocks, { own: BORE })
  w.bot.pathfinder.goto = async (goal) => {
    w.walks.push('goto')
    w.bot.pathfinder.goal = goal
    const end = [FACE_END, HILL_TOP].find((c) => goal.isEnd(c))
    if (!end) throw noPath()
    w.bot.entity.position = end.offset(0.5, 0, 0.5)
    w.bot.pathfinder.goal = null
  }
  const faces = [[0.5, 0, 0.5], [0.5, 1, 0.5], [0, 0.5, 0.5], [1, 0.5, 0.5], [0.5, 0.5, 0], [0.5, 0.5, 1]]
  w.env.seenNow = (c) => faces.some(([dx, dy, dz]) => {
    const eye = w.bot.entity.position.offset(0, 1.62, 0)
    const to = c.offset(dx, dy, dz).minus(eye)
    const range = to.norm() + 0.1
    const hit = w.bot.world.raycast(eye, to.normalize(), range)
    return !!hit && hit.position.equals(c)
  })
  return w
}

test('digat digs a face in its tunnel from the tunnel when an open cell on the hill over it is in reach', async () => {
  const w = hill(HILL)
  const { res, done } = w.digat('6,64,0')
  await done
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(w.digs, ['6,64,0 from (5, 64, 0)'])
  assert.deepStrictEqual(w.walks, ['goto'])
})

test('digat whose walk shuns its tunnel never ends on the hill over the face, and walks into the tunnel after', async () => {
  const w = hill({ ...HILL, ...Object.fromEntries(HOLLOW.map((k) => [k, 'air'])) })
  const { res, done } = w.digat('6,64,0')
  await done
  assert.strictEqual(res.error, undefined, res.error && res.error.message)
  assert.deepStrictEqual(w.digs, ['6,64,0 from (5, 64, 0)'])
  assert.deepStrictEqual(w.walks, ['goto', 'setGoal null', 'goto'])
})

test('mine walks out from under a gravel-capped ore before the collect digs it', async () => {
  const w = cave(UNDER, CAPPED)
  const r = await w.mine('iron_ore')
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.reply.mined, 1)
  assert.strictEqual(w.digs.length, 1)
  assert.doesNotMatch(w.digs[0], /from \(0, 64, 0\)$/)
})

test('mine stops with the gravel named when its walk ends under the column', async () => {
  const w = cave(UNDER, CAPPED, { stuck: true })
  const r = await w.mine('iron_ore')
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(w.digs, [])
  assert.strictEqual(r.reply.mined, 0)
  assert.match(r.reply.reason, /^refusing to dig iron_ore at 0,66,0: gravel at 0,67,0 would fall on me\b/)
  assert.match(r.reply.reason, /\bdigat 0,66,0 anyway\b/)
  assert.doesNotMatch(r.reply.reason, /dig again/)
})

test('mine digs an ore whose gravel lands only in the dug cell when its walk away finds no path', async () => {
  const w = cave(UNDER, { '1,64,0': 'iron_ore', '1,65,0': 'gravel' })
  const walk = w.bot.pathfinder.goto
  let walks = 0
  w.bot.pathfinder.goto = (goal) => walks++ ? walk(goal) : Promise.reject(noPath())
  const r = await w.mine('iron_ore')
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.reply.mined, 1)
  assert.deepStrictEqual(w.digs, ['1,64,0 from (0, 64, 0)'])
})

test('mine keeps its count and names the gravel when the walk from under the column finds no path', async () => {
  const w = cave(UNDER, { '1,64,0': 'iron_ore', ...CAPPED })
  const walk = w.bot.pathfinder.goto
  w.bot.pathfinder.goto = (goal) => w.digs.length ? Promise.reject(noPath()) : walk(goal)
  const r = await w.mine('iron_ore', 2)
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.reply.mined, 1)
  assert.deepStrictEqual(w.digs, ['1,64,0 from (0, 64, 0)'])
  assert.match(r.reply.reason, /^refusing to dig iron_ore at 0,66,0: gravel at 0,67,0 would fall on me\b/)
})

function walksAfter (w, first, end) {
  let walks = 0
  w.bot.pathfinder.goto = async () => {
    if (walks++ === 0) throw first
    w.bot.entity.position = end
  }
  return () => walks
}

// An ore out of reach from the body at UNDER, with gravel over it that lands on feet at FAR_UNDER.
const FAR = { '5,66,0': 'iron_ore', '5,67,0': 'gravel' }
const FAR_UNDER = new Vec3(5.5, 64, 0.5)

test('mine digs nothing when its walk away from a fall is stopped', async () => {
  const w = cave(UNDER, FAR)
  const stopped = Object.assign(new Error('The goal was changed before it could be completed!'), { name: 'GoalChanged' })
  const walks = walksAfter(w, stopped, FAR_UNDER)
  const r = await w.mine('iron_ore')
  assert.strictEqual(r.error, stopped)
  assert.deepStrictEqual(w.digs, [])
  assert.strictEqual(walks(), 1)
})

test('mine stops with the gravel named when its walk finds no path and the ore needs another walk', async () => {
  const w = cave(UNDER, FAR)
  const walks = walksAfter(w, noPath(), FAR_UNDER)
  const r = await w.mine('iron_ore')
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(w.digs, [])
  assert.strictEqual(walks(), 1)
  assert.match(r.reply.reason, /^refusing to dig iron_ore at 5,66,0: gravel at 5,67,0 would fall on me\b/)
})

// On the slab at 0,64,0 the eye sees the ore at 3,65,0 from the slab's cell, and the stone at 1,66,0 hides it from the cell above.
test('mine digs from a slab the body stands on when the slab\'s cell sees the ore and the cell above does not', async () => {
  const w = cave(new Vec3(0.5, 64.5, 0.5), { '0,64,0': 'stone_slab', '1,66,0': 'stone', '3,65,0': 'iron_ore', '3,66,0': 'gravel' })
  w.bot.entity.onGround = true
  const r = await w.mine('iron_ore')
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.reply.mined, 1)
  assert.deepStrictEqual(w.digs, ['3,65,0 from (0, 64, 0)'])
})

// On three snow layers at 0,64,0 the stone at 1,65,0 hides the ore at 3,65,0 from the snow's cell, and the cell above sees its top.
test('mine judges the walk left to the collect from the cell of the snow layers the body stands on', async () => {
  const w = cave(new Vec3(0.5, 64.25, 0.5), { '0,64,0': ['snow', { layers: 3 }], '1,65,0': 'stone', '3,65,0': 'iron_ore', '4,65,0': 'gravel' }, { stuck: true })
  w.bot.entity.onGround = true
  const r = await w.mine('iron_ore')
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.deepStrictEqual(w.digs, [])
  assert.match(r.reply.reason, /^refusing to dig iron_ore at 3,65,0: gravel at 4,65,0 would fall on me\b/)
})

// A cobblestone wall runs along x 0, and the body at 0.0125,64,0.5 touches its west side. The ore at -5,64,0 is in reach from -1,64,0 only.
test('mine digs a gravel-capped ore in reach of the cell the pathfinder starts from beside a wall the body touches', async () => {
  const arm = ['cobblestone_wall', { up: 'false', north: 'low', south: 'low', east: 'none', west: 'none', waterlogged: 'false' }]
  const wall = Object.fromEntries([-2, -1, 0, 1, 2].map((z) => [`0,64,${z}`, arm]))
  const w = cave(new Vec3(0.0125, 64, 0.5), { ...wall, '-5,64,0': 'iron_ore', '-5,65,0': 'gravel' }, { stuck: true })
  const r = await w.mine('iron_ore')
  assert.strictEqual(r.error, undefined, r.error && r.error.message)
  assert.strictEqual(r.reply.reason, null)
  assert.deepStrictEqual(w.digs, ['-5,64,0 from (0, 64, 0)'])
})
