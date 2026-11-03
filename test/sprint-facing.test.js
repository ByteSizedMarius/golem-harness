'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { performance } = require('node:perf_hooks')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const physicsPlugin = require('mineflayer/lib/plugins/physics')
const entitiesPlugin = require('mineflayer/lib/plugins/entities')
const conv = require('mineflayer/lib/conversions')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { installGaze } = require('../lib/gaze')
const { smoothLook, shortestTurn } = require('../lib/head')

const flush = () => new Promise(setImmediate)
const TICK_MS = 50
// A walk settles at about 0.216 blocks per tick, a sprint at about 0.281.
const WALK_MAX = 0.23
const SPRINT_MIN = 0.26
const deg = (d) => d * Math.PI / 180
const EAST = deg(-90)
const WEST = deg(90)
// 45 degrees, plus the rounding of the wire's float yaw.
const LIMIT = 45.01
const offDeg = (notchian, yaw) => Math.abs(shortestTurn(deg(notchian) - deg(conv.toNotchianYaw(yaw)))) * 180 / Math.PI
const isLook = (p) => p.name === 'look' || p.name === 'position_look'
const isMove = (p) => isLook(p) || p.name === 'position' || p.name === 'flying'

// A body at 0.5 64 0.5 facing yaw under mineflayer's physics, gaze and head sweeps, on stone up to y 63 except where hole(x, y) is true.
async function body (t, { yaw = EAST, fighting = false, plugins = [physicsPlugin], hole = () => false, extra = {} } = {}) {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.end = () => {}
  const packets = []
  client.write = (name, data) => packets.push({ name, ...data })
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  await once(bot, 'inject_allowed')
  for (const plugin of plugins) bot.loadPlugin(plugin)
  const Block = require('prismarine-block')(bot.registry)
  const STONE = Block.fromStateId(bot.registry.blocksByName.stone.defaultState, 0)
  const AIR = Block.fromStateId(bot.registry.blocksByName.air.defaultState, 0)
  Object.assign(bot, {
    version: '1.21.11',
    isAlive: true,
    entity: {
      id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6,
      onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
      elytraFlying: false, effects: {}, attributes: {}
    },
    entities: {},
    game: { minY: -64, height: 384, dimension: 'overworld' },
    inventory: { slots: [], items: () => [] },
    blockAt (p) {
      const c = p.floored()
      const b = Object.create(c.y <= 63 && !hole(c.x, c.y) ? STONE : AIR)
      b.position = c
      return b
    },
    ...extra
  })
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  t.mock.method(performance, 'now', () => Date.now())
  bot.emit('login')
  client.emit('position', { x: 0.5, y: 64, z: 0.5, yaw: conv.toNotchianYaw(yaw), pitch: 0, flags: {}, teleportId: 1 })
  const gaze = installGaze(bot)
  bot.look = smoothLook(bot, bot.look, () => fighting, gaze.hold)

  const tick = async () => {
    packets.push({ name: 'tick' })
    t.mock.timers.tick(TICK_MS)
    await flush()
  }
  return {
    bot,
    client,
    packets,
    tick,
    // The horizontal step of each of n ticks.
    async ticks (n) {
      const steps = []
      for (let i = 0; i < n; i++) {
        const p0 = bot.entity.position.clone()
        await tick()
        steps.push(Math.hypot(bot.entity.position.x - p0.x, bot.entity.position.z - p0.z))
      }
      return steps
    },
    async until (promise) {
      let done = false
      promise.then(() => { done = true })
      for (let i = 0; !done; i++) {
        assert.ok(i < 100, 'the look never resolved')
        await tick()
      }
    },
    sprintActions: (from) => packets.slice(from).filter((p) => p.name === 'entity_action').map((p) => p.actionId),
    wireYaw: () => packets.findLast(isLook).yaw,
    looks: (from) => packets.slice(from).filter(isLook)
  }
}

// A body on flat stone under mineflayer's physics, its stub pathfinder looking and steering per tick like mineflayer-pathfinder.
async function runner (t, { yaw = EAST, fighting = false, rewrite = false, plugins } = {}) {
  const path = []
  let planned = null
  const r = await body(t, { yaw, fighting, plugins, extra: { pathfinder: { isMoving: () => path.length > 0, isMining: () => false, isBuilding: () => false } } })
  const { bot } = r
  bot.on('physicsTick', () => {
    const p = bot.entity.position
    if (planned) {
      path.splice(0, path.length, ...planned)
      planned = null
      bot.emit('path_update', { status: 'success', path })
    }
    if (path.length > 0 && Math.abs(path[0].x - p.x) <= 0.35 && Math.abs(path[0].z - p.z) <= 0.35) path.shift()
    if (path.length === 0) {
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
      return
    }
    bot.look(Math.atan2(-(path[0].x - p.x), -(path[0].z - p.z)), 0)
    bot.setControlState('forward', true)
    if (rewrite) bot.setControlState('sprint', false)
    bot.setControlState('sprint', true)
  })
  await r.tick()
  return {
    ...r,
    // Starts a walk of n nodes along the unit step (dx, dz) from the body's cell.
    walk (dx, dz, n) {
      const c = bot.entity.position.floored()
      planned = Array.from({ length: n }, (_, i) => new Vec3(c.x + 0.5 + dx * (i + 1), 64, c.z + 0.5 + dz * (i + 1)))
    }
  }
}

test('a forced look 180 degrees off the walk keeps the body at walking speed and sends no start_sprinting', async (t) => {
  const r = await runner(t, { fighting: true })
  await r.until(r.bot.look(WEST, 0, true))
  const from = r.packets.length
  r.walk(1, 0, 40)
  const steps = await r.ticks(20)
  assert.ok(offDeg(r.wireYaw(), WEST) < 1, `control: the wire holds the look back, ${r.wireYaw()}`)
  assert.ok(r.bot.entity.position.x > 3, `control: the body walks east, x ${r.bot.entity.position.x}`)
  assert.deepStrictEqual(r.sprintActions(from), [], 'sprint actions while the head looks back')
  const fastest = Math.max(...steps.slice(8))
  assert.ok(fastest < WALK_MAX, `a step of ${fastest.toFixed(3)} blocks per tick`)
})

test('a walk whose shown yaw stays within 45 degrees of the walk sprints', async (t) => {
  for (const [label, look] of [['the walking gaze', null], ['a forced look 40 degrees off', EAST + deg(40)]]) {
    await t.test(label, async (t) => {
      const r = await runner(t, { fighting: true })
      if (look !== null) await r.until(r.bot.look(look, 0, true))
      const from = r.packets.length
      r.walk(1, 0, 40)
      const steps = await r.ticks(20)
      const worst = Math.max(...r.looks(from).map((p) => offDeg(p.yaw, EAST)))
      assert.ok(worst <= LIMIT, `control: the wire turned ${worst.toFixed(1)} degrees off the walk`)
      assert.deepStrictEqual(r.sprintActions(from), ['start_sprinting'])
      const slowest = Math.min(...steps.slice(10))
      assert.ok(slowest > SPRINT_MIN, `a step of ${slowest.toFixed(3)} blocks per tick`)
    })
  }
})

test('a sprint request rewritten every tick sends one start_sprinting, not one per write', async (t) => {
  const r = await runner(t, { rewrite: true })
  const from = r.packets.length
  r.walk(1, 0, 40)
  await r.ticks(20)
  assert.deepStrictEqual(r.sprintActions(from), ['start_sprinting'])
})

test('a sprint request without forward sends no start_sprinting', async (t) => {
  const r = await runner(t)
  r.bot.on('physicsTick', () => r.bot.setControlState('sprint', true))
  const from = r.packets.length
  await r.ticks(5)
  assert.strictEqual(r.bot.getControlState('sprint'), true, 'control: the sprint is requested')
  assert.deepStrictEqual(r.sprintActions(from), [])
})

test('a respawn or a new login sends the sprint state again on the next tick', async (t) => {
  for (const event of ['respawn', 'login']) {
    await t.test(event, async (t) => {
      const r = await runner(t)
      r.walk(1, 0, 40)
      await r.ticks(10)
      assert.deepStrictEqual(r.sprintActions(0).slice(-1), ['start_sprinting'], 'control: the walk sprints')
      const from = r.packets.length
      r.bot.emit(event)
      const p = r.bot.entity.position
      r.client.emit('position', { x: p.x, y: p.y, z: p.z, yaw: conv.toNotchianYaw(EAST), pitch: 0, flags: {}, teleportId: 2 })
      await r.ticks(3)
      assert.deepStrictEqual(r.sprintActions(from), ['start_sprinting'])
    })
  }
})

test('a hit while sprinting sends start_sprinting again on the next tick, a hit with the sprint held off sends none', async (t) => {
  for (const [label, look, resent] of [['sprinting', null, ['start_sprinting']], ['looking back', WEST, []]]) {
    await t.test(label, async (t) => {
      const r = await runner(t, { fighting: true, plugins: [entitiesPlugin, physicsPlugin] })
      if (look !== null) await r.until(r.bot.look(look, 0, true))
      r.walk(1, 0, 40)
      await r.ticks(10)
      assert.deepStrictEqual(r.sprintActions(0).filter((a) => a === 'start_sprinting').length, look === null ? 1 : 0, 'control')
      const from = r.packets.length
      r.bot.attack({ id: 7 })
      await r.ticks(2)
      assert.ok(r.packets.slice(from).some((p) => p.name === 'use_entity'), 'control: the hit went out')
      assert.deepStrictEqual(r.sprintActions(from), resent)
    })
  }
})

test('entity_action goes out before the move packet of its tick', async (t) => {
  const r = await runner(t)
  const from = r.packets.length
  r.walk(1, 0, 8)
  await r.ticks(40)
  const ticks = []
  for (const p of r.packets.slice(from)) {
    if (p.name === 'tick') ticks.push([])
    else if (p.name === 'entity_action') ticks.at(-1).push(p.actionId)
    else if (isMove(p)) ticks.at(-1).push('move')
  }
  assert.deepStrictEqual(ticks.filter((k) => k.length > 1), [['start_sprinting', 'move'], ['stop_sprinting', 'move']])
})

test('a flee turns the head from the held combat look to the walk at the fight turn speed, and the sprint comes back', async (t) => {
  // The combat look rests on a mob east of the body, and the flee runs west.
  const flee = async (t, turn) => {
    const r = await runner(t, { fighting: true })
    await r.until(r.bot.look(EAST, 0.3, true))
    const from = r.packets.length
    r.walk(-1, 0, 40)
    if (turn) r.bot.faceWalk()
    const sprintAt = []
    const offs = []
    for (let i = 0; i < 16; i++) {
      await r.ticks(1)
      offs.push(offDeg(r.wireYaw(), WEST))
      sprintAt.push(r.sprintActions(from).length > 0)
    }
    return { r, from, offs, sprinting: sprintAt.indexOf(true) }
  }
  await t.test('held look, no turn', async (t) => {
    const { sprinting } = await flee(t, false)
    assert.strictEqual(sprinting, -1, 'control: the held look keeps the sprint off')
  })
  await t.test('turned', async (t) => {
    const { r, from, offs, sprinting } = await flee(t, true)
    const report = `wire off the walk per tick ${offs.map((o) => o.toFixed(0)).join(' ')}`
    assert.ok(offs.findIndex((o) => o <= LIMIT) <= 3, report)
    assert.ok(offs.slice(4).every((o) => o <= LIMIT), report)
    assert.ok(sprinting >= 0 && sprinting <= 3, `the sprint came back on tick ${sprinting}, ${report}`)
    assert.deepStrictEqual(r.sprintActions(from), ['start_sprinting'], report)
  })
})

// A body walking east under the real pathfinder toward a gap of air at x from to x to, 14 deep and endless along z.
async function gapRunner (t, { from, to }) {
  const r = await body(t, { fighting: true, plugins: [physicsPlugin, pathfinder], hole: (x, y) => x >= from && x <= to && y >= 50 })
  const moves = new Movements(r.bot)
  moves.canDig = false
  r.bot.pathfinder.setMovements(moves)
  r.bot.pathfinder.tickTimeout = r.bot.pathfinder.thinkTimeout
  r.bot.pathfinder.searchRadius = 24
  return r
}

test('a gap only a sprint jump clears, taken with a forced look held 180 degrees off, is never jumped short', async (t) => {
  for (const width of [2, 3]) {
    await t.test(`${width} blocks wide`, async (t) => {
      const r = await gapRunner(t, { from: 4, to: 3 + width })
      await r.until(r.bot.look(WEST, 0, true))
      let planned = null
      r.bot.once('path_update', (u) => { planned = u.path.map((n) => ({ x: n.x, parkour: !!n.parkour })) })
      let reached = false
      r.bot.once('goal_reached', () => { reached = true })
      const goal = 4 + width + 3
      r.bot.pathfinder.setGoal(new goals.GoalBlock(goal, 64, 0))
      const wire = []
      let low = 64
      // The x of the first ground contact after the first take-off.
      let landed = null
      let airborne = false
      for (let i = 0; i < 200 && !reached && low > 60; i++) {
        await r.tick()
        wire.push(offDeg(r.wireYaw(), WEST))
        const { position: p, onGround } = r.bot.entity
        low = Math.min(low, p.y)
        if (!onGround) airborne = true
        else if (airborne && landed === null) landed = p.x
      }
      assert.ok(planned && planned.some((n) => n.parkour && n.x === 4.5 + width), `control: a jump over the gap, ${JSON.stringify(planned)}`)
      assert.ok(wire.slice(0, 15).every((o) => o < 1), `control: the wire holds the look back, ${wire.slice(0, 15).map((o) => o.toFixed(0)).join(' ')}`)
      assert.ok(low > 63.9, `the body fell to y ${low.toFixed(2)} at x ${r.bot.entity.position.x.toFixed(2)}`)
      assert.ok(landed > 4 + width - 0.3, `the first jump landed at x ${landed?.toFixed(2)}, short of the far side at x ${4 + width}`)
      assert.ok(reached, `the goal was never reached, the body stands at ${r.bot.entity.position}`)
    })
  }
})
