'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { performance } = require('node:perf_hooks')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const physicsPlugin = require('mineflayer/lib/plugins/physics')
const inventoryPlugin = require('mineflayer/lib/plugins/inventory')
const conv = require('mineflayer/lib/conversions')
const { installGaze, HOLD_MS } = require('../lib/gaze')
const { smoothLook, TURN_DEG_S } = require('../lib/head')

const flush = () => new Promise(setImmediate)
const TICK_S = 0.05
const SPEED = 0.2
const STAIRS = [...'ES'.repeat(15)]
const isLook = (p) => p.name === 'look' || p.name === 'position_look'
// Notchian degrees, wrapped to [-180, 180).
const turn = (d) => ((d + 180) % 360 + 360) % 360 - 180

// A body under mineflayer's real physics and inventory plugins, its stub pathfinder walking one node per letter of steps.
async function walker (t, steps, { start = { yaw: 270, pitch: 0 }, shortcut = false, drift = 0 } = {}) {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.end = () => {}
  const packets = []
  let bot = null
  client.write = (name, data) => packets.push({
    name,
    ...data,
    real: bot.entity && { yaw: conv.toNotchianYaw(bot.entity.yaw), pitch: conv.toNotchianPitch(bot.entity.pitch) }
  })
  bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  await once(bot, 'inject_allowed')
  bot.loadPlugin(physicsPlugin)
  bot.loadPlugin(inventoryPlugin)
  let x = 0.5
  let y = 64
  let z = 0.5
  const path = steps.map((s) => {
    if (s === 'S') return new Vec3(x, y, ++z)
    if (s === 'L') return new Vec3(x, ++y, z)
    return new Vec3(++x, y += { D: -1, U: 1 }[s] ?? 0, z)
  })
  if (shortcut) path.splice(0, path.length - 1)
  Object.assign(bot, {
    physicsEnabled: false,
    isAlive: true,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, eyeHeight: 1.62, onGround: true },
    blockAt: () => ({}),
    pathfinder: { isMoving: () => path.length > 0, isMining: () => false, isBuilding: () => false }
  })
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  t.mock.method(performance, 'now', () => Date.now())
  bot.emit('login')
  client.emit('position', { x: 0.5, y: 64, z: 0.5, ...start, flags: {}, teleportId: 1 })
  const gaze = installGaze(bot)
  bot.look = smoothLook(bot, bot.look, () => false, gaze.hold)
  bot.emit('path_update', { status: 'success', path })

  let walking = true
  let legsHeld = false
  // The pathfinder's walk step: aim at the next node's centre, the node reached within 0.35.
  const step = (idle) => {
    const p = bot.entity.position
    if (path.length === 0) return
    if (Math.abs(path[0].x - p.x) <= 0.35 && Math.abs(path[0].z - p.z) <= 0.35) {
      path.shift()
      if (path.length === 0) return
    }
    const dx = path[0].x - p.x
    const dz = path[0].z + drift - p.z
    bot.look(Math.atan2(-dx, -dz), 0)
    if (idle) return
    const d = Math.hypot(dx, dz)
    if (d > 0) {
      p.x += dx / d * Math.min(SPEED, d)
      p.z += dz / d * Math.min(SPEED, d)
    }
    if (Math.floor(p.x) === Math.floor(path[0].x) && Math.floor(p.z) === Math.floor(path[0].z)) p.y = path[0].y
  }
  const tick = async (idle = false) => {
    if (walking) step(idle || legsHeld)
    bot.emit('physicsTick')
    t.mock.timers.tick(TICK_S * 1000)
    await flush()
  }
  const wire = () => {
    const p = packets.findLast(isLook)
    return { yaw: p.yaw, pitch: p.pitch }
  }
  return {
    bot,
    client,
    packets,
    path,
    wire,
    clamp: bot.physics.yawSpeed * TICK_S * 180 / Math.PI,
    pause: (on) => { walking = !on },
    // The pathfinder keeps turning the head toward its next node while the body stands still.
    holdLegs: (on) => { legsHeld = on },
    // The wire's look after each of n ticks, the look before them first. Every fourth tick the body stands still.
    walk: async (n) => {
      const trace = [wire()]
      for (let i = 0; i < n; i++) {
        await tick(i % 4 === 3)
        trace.push(wire())
      }
      return trace
    },
    // The wire's look after each tick of the walk with the nodes it had left, the tick that ends the walk excluded.
    toEnd: async () => {
      const shown = []
      for (let i = 0; path.length > 0; i++) {
        assert.ok(i < 100, 'the walk never ended')
        const left = path.length
        await tick()
        shown.push({ ...wire(), left })
      }
      shown.pop()
      return shown
    },
    ticks: async (n) => { for (let i = 0; i < n; i++) await tick() },
    until: async (promise) => {
      let done = false
      promise.then(() => { done = true })
      for (let i = 0; !done; i++) {
        assert.ok(i < 100, 'the look never resolved')
        await tick()
      }
    },
    // Degrees between the wire's look and the real one.
    off: () => {
      const w = wire()
      return Math.hypot(turn(w.yaw - conv.toNotchianYaw(bot.entity.yaw)), w.pitch - conv.toNotchianPitch(bot.entity.pitch))
    }
  }
}

function motion (trace) {
  const yaw = trace.slice(1).map((l, i) => turn(l.yaw - trace[i].yaw))
  const pitch = trace.slice(1).map((l, i) => Math.abs(l.pitch - trace[i].pitch))
  return {
    yaw,
    maxYaw: Math.max(...yaw.map(Math.abs)),
    travel: yaw.reduce((s, d) => s + Math.abs(d), 0),
    maxPitch: Math.max(...pitch)
  }
}

function assertRealOnWire (packets, label) {
  const looks = packets.filter(isLook)
  assert.ok(looks.length > 0, `${label}: no look on the wire`)
  for (const p of looks) {
    assert.ok(Math.abs(turn(p.yaw - p.real.yaw)) < 0.1 && Math.abs(p.pitch - p.real.pitch) < 0.1,
      `${label}: wire ${p.yaw.toFixed(1)}/${p.pitch.toFixed(1)}, real ${p.real.yaw.toFixed(1)}/${p.real.pitch.toFixed(1)}`)
  }
}

test('a walk along a staircase diagonal shows a steady gaze instead of the zig-zag walking yaw', async (t) => {
  const w = await walker(t, STAIRS)
  const { maxYaw, travel, maxPitch } = motion(await w.walk(60))
  const report = `max yaw step ${maxYaw.toFixed(2)}, yaw travel ${travel.toFixed(1)}, max pitch step ${maxPitch.toFixed(2)} degrees`
  t.diagnostic(report)
  assert.ok(maxYaw <= w.clamp + 1e-3, report)
  assert.ok(travel < 60, report)
  assert.ok(maxPitch <= w.clamp + 1e-3, report)
})

test('a straight walk into a right-angle corner turns the gaze once, eased and without turning back', async (t) => {
  const w = await walker(t, [...'EEEEEEEESSSSSSSS'])
  const trace = await w.walk(60)
  const { yaw, maxYaw, travel } = motion(trace)
  t.diagnostic(`max yaw step ${maxYaw.toFixed(2)}, yaw travel ${travel.toFixed(1)} degrees`)
  assert.ok(yaw.every((d) => d >= -1e-3), `the gaze turned back: ${yaw.map((d) => d.toFixed(1)).join(' ')}`)
  assert.ok(maxYaw <= w.clamp + 1e-3, `max yaw step ${maxYaw}`)
  assert.ok(Math.abs(turn(trace.at(-1).yaw - 0)) <= 12, `ends at ${trace.at(-1).yaw}, south is 0`)
})

test('a walk shorter than the gaze distance leaves a steep look facing away and turns toward its last corner', async (t) => {
  const w = await walker(t, [...'EES'], { start: { yaw: 180, pitch: 70 } })
  const shown = await w.toEnd()
  const settled = shown.slice(8)
  t.diagnostic(settled.map((l) => `${l.yaw.toFixed(0)}/${l.pitch.toFixed(0)}`).join(' '))
  assert.ok(settled.length > 4, `control: the walk lasted ${shown.length} ticks`)
  assert.ok(settled.every((l) => Math.abs(l.pitch) < 25), 'the pitch leaves the steep look and stays level to the end')
  const last = shown.at(-1)
  assert.ok(turn(last.yaw - 270) > 10, `ends at ${last.yaw}, past east toward the southern corner`)
})

// Degrees between the leftmost and rightmost yaw of looks.
function swing (looks) {
  const yaw = looks.map((l) => turn(l.yaw - looks[0].yaw))
  return Math.max(...yaw) - Math.min(...yaw)
}

function assertLevelArrival (t, shown) {
  const last = shown.filter((l) => l.left === 1)
  const report = `last node ${last.map((l) => `${l.yaw.toFixed(0)}/${l.pitch.toFixed(0)}`).join(' ')}, max pitch ` +
    `${Math.max(...shown.map((l) => Math.abs(l.pitch))).toFixed(1)}, yaw swing ${swing(last).toFixed(1)} degrees`
  t.diagnostic(report)
  assert.ok(last.length > 2, `control: the last node took ${last.length} ticks`)
  assert.ok(shown.every((l) => Math.abs(l.pitch) < 25), report)
  assert.ok(swing(last) <= 12, report)
}

test('a walk ending one block down or up keeps the gaze level and steady to the end', async (t) => {
  for (const [steps, floor] of [['EEEEED', 63], ['EEEEEU', 65]]) {
    await t.test(steps, async (t) => {
      const w = await walker(t, [...steps])
      const shown = await w.toEnd()
      assert.strictEqual(w.bot.entity.position.y, floor, 'control: the body ends on the last floor')
      assertLevelArrival(t, shown)
    })
  }
})

test('a one-node walk that drifts past the side of its node keeps the gaze steady on arrival', async (t) => {
  const w = await walker(t, [...'EEEE'], { shortcut: true, drift: 0.3 })
  const shown = await w.toEnd()
  assert.ok(Math.abs(w.bot.entity.position.z - 0.8) < 0.05, `control: the body ends at z ${w.bot.entity.position.z}`)
  assertLevelArrival(t, shown)
})

test('a walk whose multi-node part runs under a dig keeps the gaze steady on the last node despite drift', async (t) => {
  const w = await walker(t, [...'EEEEE'], { drift: 0.3 })
  w.bot.targetDigBlock = {}
  for (let i = 0; w.path.length > 1 || w.bot.entity.position.x < 4.66; i++) {
    assert.ok(i < 100, 'control: the walk never reached its last node')
    await w.ticks(1)
  }
  w.bot.targetDigBlock = null
  const shown = await w.toEnd()
  assert.ok(Math.abs(w.bot.entity.position.z - 0.8) < 0.05, `control: the body ends at z ${w.bot.entity.position.z}`)
  assertLevelArrival(t, shown)
  const last = shown.filter((l) => l.left === 1)
  assert.ok(last.every((l) => Math.abs(turn(l.yaw - 270)) <= 12), `east is 270, the last node showed ${last.map((l) => l.yaw.toFixed(0)).join(' ')}`)
})

test('a path ending in ladder steps after an eastward step looks east past its end', async (t) => {
  const w = await walker(t, [...'SEEEELL'])
  const shown = await w.toEnd()
  const last = shown.at(-1)
  t.diagnostic(`ends at ${last.yaw.toFixed(0)}/${last.pitch.toFixed(0)}`)
  assert.ok(Math.abs(turn(last.yaw - 270)) < 20, `ends at ${last.yaw}, east is 270`)
})

test('a forced look, a dig or an item use mid-path puts the real look on the wire, then the gaze eases back to the path', async (t) => {
  for (const [label, ticks, sweeps, start, end] of [
    ['forced look', 25, true, (bot) => { bot.look(bot.entity.yaw + 0.5, -0.3, true) }, () => {}],
    ['dig', 40, true, (bot) => {
      bot.targetDigBlock = {}
      bot.lookAt(bot.entity.position.offset(1, 0.5, 0), true)
    }, (bot) => { bot.targetDigBlock = null }],
    ['item use', 40, false, (bot) => bot.activateItem(), (bot) => bot.deactivateItem()],
    ['eating', 40, false, (bot) => {
      bot.game = { gameMode: 'creative' }
      bot.consume()
      // Any entity status clears usingHeldItem, here a mob dying nearby.
      bot._client.emit('entity_status', { entityId: 99, entityStatus: 3 })
    }, (bot) => bot._client.emit('entity_status', { entityId: bot.entity.id, entityStatus: 9 })]
  ]) {
    await t.test(label, async (t) => {
      const w = await walker(t, STAIRS)
      await w.walk(20)
      assert.ok(w.off() > 20, `control: the wire shows the path gaze, ${w.off().toFixed(1)} degrees off the walking yaw`)
      w.pause(true)
      const from = w.packets.length
      const before = w.wire()
      start(w.bot)
      await w.ticks(ticks)
      const first = w.packets.slice(from).find(isLook)
      if (sweeps) {
        assert.ok(Math.abs(turn(first.yaw - before.yaw)) <= TURN_DEG_S * TICK_S + 1e-3, `the sweep leaves from the shown look: ${before.yaw} to ${first.yaw}`)
      }
      assertRealOnWire(w.packets.slice(from), label)
      end(w.bot)
      w.pause(false)
      const { maxYaw, maxPitch } = motion(await w.walk(40))
      assert.ok(maxYaw <= w.clamp + 1e-3 && maxPitch <= w.clamp + 1e-3, `steps back ${maxYaw}/${maxPitch}`)
      assert.ok(w.off() > 20, `back on the path gaze, ${w.off().toFixed(1)} degrees off the walking yaw`)
    })
  }
})

test('a forced look cut short by the walking pathfinder holds its target on the wire, then the gaze returns to the path', async (t) => {
  const w = await walker(t, STAIRS)
  await w.walk(20)
  const target = { yaw: w.bot.entity.yaw + 1, pitch: -0.4 }
  const want = { yaw: conv.toNotchianYaw(target.yaw), pitch: conv.toNotchianPitch(target.pitch) }
  const p0 = w.bot.entity.position.clone()
  w.bot.look(target.yaw, target.pitch, true)
  const held = await w.walk(HOLD_MS / 1000 / TICK_S - 1)
  const { maxYaw, maxPitch } = motion(held.slice(1))
  assert.ok(maxYaw <= w.clamp + 1e-3 && maxPitch <= w.clamp + 1e-3, `steps toward the target ${maxYaw}/${maxPitch}`)
  const reached = held.findIndex((l) => Math.abs(turn(l.yaw - want.yaw)) < 0.1 && Math.abs(l.pitch - want.pitch) < 0.1)
  assert.ok(reached > 0, `the wire never showed the target ${want.yaw}/${want.pitch}, last ${held.at(-1).yaw}/${held.at(-1).pitch}`)
  assert.ok(held.slice(reached).every((l) => Math.abs(turn(l.yaw - want.yaw)) < 0.1 && Math.abs(l.pitch - want.pitch) < 0.1),
    'the wire holds the target to the end of the hold')
  assert.ok(w.off() > 20, 'control: the real look walks on')
  assert.ok(w.bot.entity.position.distanceTo(p0) > 2, 'control: the body walks on')
  const back = motion(await w.walk(40))
  assert.ok(back.maxYaw <= w.clamp + 1e-3 && back.maxPitch <= w.clamp + 1e-3, `steps back ${back.maxYaw}/${back.maxPitch}`)
  assert.ok(w.off() > 20, `back on the path gaze, ${w.off().toFixed(1)} degrees off the walking yaw`)
})

test('a bow drawn and re-aimed mid-path draws and looses along the real aim', async (t) => {
  const w = await walker(t, STAIRS)
  await w.walk(20)
  w.pause(true)
  await w.until(w.bot.lookAt(new Vec3(6, 65, -3), true))
  await w.ticks(2)
  w.bot.activateItem()
  await w.ticks(40)
  await w.until(w.bot.lookAt(new Vec3(9, 66, 2), true))
  await w.ticks(2)
  w.bot.deactivateItem()
  const use = w.packets.findIndex((p) => p.name === 'use_item')
  const release = w.packets.findIndex((p) => p.name === 'block_dig')
  const drawn = w.packets.slice(0, use).findLast(isLook)
  const loosed = w.packets.slice(0, release).findLast(isLook)
  const { rotation } = w.packets[use]
  assert.ok(Math.abs(turn(drawn.yaw - rotation.x)) < 0.1 && Math.abs(drawn.pitch - rotation.y) < 0.1,
    `drawn on the wire at ${drawn.yaw}/${drawn.pitch}, use_item ${rotation.x}/${rotation.y}`)
  assert.ok(Math.abs(turn(loosed.yaw - drawn.yaw)) > 10, 'control: the re-aim turned')
  assertRealOnWire([loosed], 'loosed')
})

test('a bow drawn while the pathfinder keeps turning the head holds the aim on the wire to the release', async (t) => {
  const w = await walker(t, STAIRS)
  await w.walk(20)
  w.holdLegs(true)
  const target = { yaw: w.bot.entity.yaw + 1, pitch: -0.4 }
  const aim = { yaw: conv.toNotchianYaw(target.yaw), pitch: conv.toNotchianPitch(target.pitch) }
  const offAim = (l) => Math.hypot(turn(l.yaw - aim.yaw), l.pitch - aim.pitch)
  await w.until(w.bot.look(target.yaw, target.pitch, true))
  await w.ticks(2)
  const looks = [w.wire()]
  const from = w.packets.length
  w.bot.activateItem()
  await w.ticks(20)
  w.bot.deactivateItem()
  const real = turn(conv.toNotchianYaw(w.bot.entity.yaw) - aim.yaw)
  assert.ok(Math.abs(real) > 20, `control: the real look walks on, ${real.toFixed(1)} degrees off the aim`)
  looks.push(...w.packets.slice(from).filter(isLook))
  const report = `wire ${looks.map((l) => `${l.yaw.toFixed(1)}/${l.pitch.toFixed(1)}`).join(' ')}, aim ${aim.yaw.toFixed(1)}/${aim.pitch.toFixed(1)}`
  assert.ok(looks.every((l, i) => i === 0 || offAim(l) <= offAim(looks[i - 1]) + 1e-3), `the wire turns away from the aim: ${report}`)
  assert.ok(offAim(looks.at(-1)) < 0.1, `released off the aim: ${report}`)
})

test('a server position correction in path mode keeps the gaze, and outside it keeps the real look', async (t) => {
  const w = await walker(t, STAIRS)
  await w.walk(20)
  const p = w.bot.entity.position
  const shown = w.wire()
  w.client.emit('position', { x: p.x, y: p.y, z: p.z, ...shown, flags: {}, teleportId: 2 })
  const { maxYaw, maxPitch } = motion(await w.walk(8))
  assert.ok(maxYaw <= w.clamp + 1e-3 && maxPitch <= w.clamp + 1e-3, `steps after the correction ${maxYaw}/${maxPitch}`)
  const dx = w.path[0].x - p.x
  const dz = w.path[0].z - p.z
  assert.ok(Math.abs(turn(conv.toNotchianYaw(w.bot.entity.yaw) - conv.toNotchianYaw(Math.atan2(-dx, -dz)))) < 0.5,
    'the real look walks toward the next node')
  assert.ok(w.off() > 20, `the wire keeps the path gaze, ${w.off().toFixed(1)} degrees off the walking yaw`)

  w.pause(true)
  w.path.length = 0
  await w.ticks(10)
  const real = w.packets.at(-1).real
  w.client.emit('position', { x: p.x, y: p.y, z: p.z, ...w.wire(), flags: {}, teleportId: 3 })
  const now = { yaw: conv.toNotchianYaw(w.bot.entity.yaw), pitch: conv.toNotchianPitch(w.bot.entity.pitch) }
  assert.ok(Math.abs(turn(now.yaw - real.yaw)) < 0.1 && Math.abs(now.pitch - real.pitch) < 0.1,
    `corrected to ${now.yaw}/${now.pitch}, real ${real.yaw}/${real.pitch}`)
})
