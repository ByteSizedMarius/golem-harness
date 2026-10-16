'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { legLedger } = require('../lib/legs')
const { entityInCell } = require('../lib/shelter')
const { botConstant, reflexIn, loadBotFunctions } = require('./helpers')

const key = (p) => `${p.x},${p.y},${p.z}`
const FULL = [[0, 0, 0, 1, 1, 1]]
const SHAPES = {
  air: [],
  cobblestone_wall: [[0.25, 0, 0.25, 0.75, 1.5, 0.75]],
  chest: [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]]
}

// A stone floor below y 64. The walk moves 0.2 a tick at the goal and stalls while the body overlaps a block.
function world ({ blocks = {}, at = new Vec3(0.5, 64, 0.5), goal, pockets = [], crumbs = [] }) {
  const cells = new Map(Object.entries(blocks))
  const open = new Set()
  const nameAt = (p) => cells.get(key(p)) ?? (p.y < 64 ? 'stone' : 'air')
  const blockAt = (p) => {
    const c = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = nameAt(c)
    const isOpen = open.has(key(c))
    const shapes = SHAPES[name] ?? (isOpen ? [] : FULL)
    return { name, position: c, shapes, boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'bedrock', getProperties: () => ({ open: isOpen }) }
  }
  const overlaps = (pos) => {
    for (let x = Math.floor(pos.x - 0.3); x <= Math.floor(pos.x + 0.3); x++) {
      for (let y = Math.floor(pos.y); y <= Math.floor(pos.y + 1.79); y++) {
        for (let z = Math.floor(pos.z - 0.3); z <= Math.floor(pos.z + 0.3); z++) {
          for (const s of blockAt(new Vec3(x, y, z)).shapes) {
            if (pos.x + 0.3 > x + s[0] && pos.x - 0.3 < x + s[3] && pos.z + 0.3 > z + s[2] && pos.z - 0.3 < z + s[5] &&
              pos.y + 1.8 > y + s[1] && pos.y < y + s[4]) return true
          }
        }
      }
    }
    return false
  }

  const bot = new EventEmitter()
  bot.entity = { position: at.clone(), yaw: 0, width: 0.6, height: 1.8 }
  bot.blockAt = blockAt
  const controls = {}
  bot.setControlState = (c, v) => { controls[c] = v }
  bot.clearControlStates = () => { for (const c of Object.keys(controls)) controls[c] = false }
  bot.lookAt = async (t) => {
    const p = bot.entity.position
    bot.entity.yaw = Math.atan2(-(t.x - p.x), -(t.z - p.z))
  }
  const move = (d) => {
    const p = bot.entity.position
    const next = p.offset(-Math.sin(bot.entity.yaw) * d, 0, -Math.cos(bot.entity.yaw) * d)
    if (!overlaps(next) || overlaps(p)) bot.entity.position = next
  }
  let target = null
  bot.pathfinder = {
    get goal () { return target },
    setGoal (g) {
      target = g
      bot.emit('goal_updated', g, false)
    },
    stop () {
      target = null
      bot.emit('path_stop')
    },
    isMoving: () => !!target
  }
  const tick = () => {
    if (controls.forward) return move(0.1)
    if (!target || overlaps(bot.entity.position)) return
    bot.lookAt({ x: target.x + 0.5, z: target.z + 0.5 })
    move(0.2)
  }
  bot.waitForTicks = async (n) => { for (let i = 0; i < n; i++) tick() }

  const digs = []
  bot.dig = async (b) => {
    digs.push(key(b.position))
    cells.set(key(b.position), 'air')
  }
  bot.activateBlock = async (b) => {
    for (const dy of [0, 1]) open.add(key(b.position.offset(0, dy, 0)))
  }
  const items = pockets.map((i) => ({ ...i }))
  bot.inventory = { items: () => items.filter((i) => i.count > 0) }
  bot.equip = async (item) => { bot.heldItem = item }
  bot.placeBlock = async (ref, face) => {
    cells.set(key(ref.position.plus(face)), bot.heldItem.name)
    bot.heldItem.count--
  }

  const events = []
  const env = {
    bot,
    Vec3,
    legs: legLedger(),
    console: { log () {} },
    emitEvent: (kind, msg) => { events.push(msg) },
    cellKnown: () => true,
    equipPickFor: async () => false,
    clearSoftCover: async () => {},
    solidAt: (p) => blockAt(p).boundingBox === 'block',
    entityInCell,
    blockers: () => [],
    NEIGHBOURS: botConstant('NEIGHBOURS'),
    UNSTUCK_WATCH_TICKS: botConstant('UNSTUCK_WATCH_TICKS'),
    OPENABLE: botConstant('OPENABLE'),
    CONTAINERS: botConstant('CONTAINERS')
  }
  const reflex = reflexIn('unstuck', env)
  reflex._crumbs = crumbs
  bot.pathfinder.setGoal(goal)
  return { bot, reflex, events, digs, nameAt: (x, y, z) => nameAt(new Vec3(x, y, z)), items }
}

const EAST = new goals.GoalNear(6, 64, 0, 1)
const PLANK_WALL = { '1,64,0': 'oak_planks', '1,65,0': 'oak_planks' }

test('unstuck steps a body out of a wall post into the nearest free cell and replans from there', async () => {
  const w = world({ blocks: { '0,64,0': 'cobblestone_wall' }, at: new Vec3(0.5, 64, 0.3), goal: new goals.GoalNear(0, 64, -8, 1) })
  await w.reflex.act(w.bot)
  assert.deepStrictEqual(w.events, ['unstuck: replanned the walk from 0,64,-1'])
  await w.bot.waitForTicks(100)
  assert.ok(w.bot.entity.position.z < -6, `the walk went on, at z ${w.bot.entity.position.z}`)
})

test('unstuck steps back to the last cell the walk made progress in when a replan stays stuck', async () => {
  const w = world({
    blocks: { '1,64,1': 'stone' },
    goal: new goals.GoalNear(10, 64, 14, 1),
    crumbs: [new Vec3(-3, 64, 0), new Vec3(-2, 64, 0), new Vec3(0, 64, 0)]
  })
  await w.reflex.act(w.bot)
  assert.deepStrictEqual(w.events, ['unstuck: stepped back to -2,64,0'])
  await w.bot.waitForTicks(100)
  assert.ok(w.bot.entity.position.z > 12, `the walk went on past the corner, at z ${w.bot.entity.position.z}`)
})

test('unstuck opens a closed door in front and walks through', async () => {
  const w = world({ blocks: { '1,64,0': 'oak_door', '1,65,0': 'oak_door' }, goal: EAST })
  await w.reflex.act(w.bot)
  assert.deepStrictEqual(w.events, ['unstuck: opened the oak_door at 1,64,0'])
  assert.ok(w.bot.entity.position.x > 2, `the walk went through, at x ${w.bot.entity.position.x}`)
})

test('unstuck breaks the wall it presses against, walks through and puts the same blocks back', async () => {
  const w = world({ blocks: PLANK_WALL, goal: EAST, pockets: [{ name: 'oak_planks', count: 4 }] })
  await w.reflex.act(w.bot)
  assert.deepStrictEqual(w.events, ['unstuck: broke oak_planks at 1,64,0 and oak_planks at 1,65,0 to get through, put them back'])
  assert.deepStrictEqual([w.nameAt(1, 64, 0), w.nameAt(1, 65, 0)], ['oak_planks', 'oak_planks'])
  assert.ok(w.bot.entity.position.x > 2, `the body is through, at x ${w.bot.entity.position.x}`)
  assert.strictEqual(w.items[0].count, 2)
})

test('unstuck breaks nothing it cannot put back, and stops the walk saying where it is stuck', async () => {
  const w = world({ blocks: PLANK_WALL, goal: EAST, pockets: [{ name: 'cobblestone', count: 64 }] })
  await w.reflex.act(w.bot)
  assert.deepStrictEqual(w.events, ['unstuck: stuck at 0,64,0 against oak_planks at 1,64,0, tried replan, break refused (no oak_planks in pockets to put back)'])
  assert.deepStrictEqual(w.digs, [])
  assert.strictEqual(w.bot.pathfinder.goal, null, 'the walk is stopped')
})

test('the boxed-in check beside a pit the bot has not seen answers the same whatever its depth', () => {
  // A body walled in on three sides, with open feet and head cells to the east over a pit that ends at floorY.
  const verdict = (floorY, seen) => {
    const open = (p) => (p.x === 0 || p.x === 1) && p.z === 0 && (p.y === 64 || p.y === 65 || (p.x === 1 && p.y > floorY && p.y < 64))
    const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt: (p) => (open(p) ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' }) }
    return loadBotFunctions(['hasLegalMove'], { bot, Vec3, knownCell: seen }).hasLegalMove()
  }
  const all = () => true
  assert.deepStrictEqual([verdict(60, all), verdict(33, all)], [true, false], 'control: a floor in reach, and a pit too deep to drop into')
  const unseenPit = (p) => !(p.x === 1 && p.y < 64)
  assert.strictEqual(verdict(33, unseenPit), verdict(60, unseenPit))
})

test('unstuck never breaks a container or a door, even with the block in its pockets', async () => {
  const cases = [
    { blocks: { '1,64,0': 'chest', '1,65,0': 'stone' }, pockets: [{ name: 'chest', count: 1 }, { name: 'stone', count: 1 }], why: 'the chest at 1,64,0 is a container' },
    { blocks: { '1,64,0': 'iron_door', '1,65,0': 'iron_door' }, pockets: [{ name: 'iron_door', count: 2 }], why: 'the iron_door at 1,64,0 is a door' }
  ]
  for (const c of cases) {
    const w = world({ blocks: c.blocks, goal: EAST, pockets: c.pockets })
    await w.reflex.act(w.bot)
    assert.deepStrictEqual(w.digs, [], c.why)
    assert.strictEqual(w.events.length, 1, c.why)
    assert.ok(w.events[0].endsWith(`break refused (${c.why})`), w.events[0])
  }
})
