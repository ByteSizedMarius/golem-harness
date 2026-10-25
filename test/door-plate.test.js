'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const { Vec3 } = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const fs = require('node:fs')
const { isDoor, panelAcross, doorCrossing, PLATE_WAIT_TICKS } = require('../lib/doors')
const { legLedger } = require('../lib/leg-ledger')
const { entityInCell } = require('../lib/shelter')
const { loadBotFunctions, reflexIn, botConstant } = require('./helpers')

const PLATE = new Vec3(1, 64, 0)
const PLATES = ['oak_pressure_plate', 'stone_pressure_plate', 'light_weighted_pressure_plate']
const key = (p) => `${p.x},${p.y},${p.z}`
const plateProps = (name, pressed) => name.includes('weighted') ? { power: pressed ? '15' : '0' } : { powered: String(pressed) }

// The walk's criterion: a shape whose z extent overlaps 0.22..0.78 stands across a walk along x.
const blocksX = (shapes) => shapes.some((s) => s[2] < 0.78 && s[5] > 0.22)

// A body at 1.5,64,0.5 under the real pathfinder, walking to 4,64,0 through an oak door in a stone wall at x 2,
// on a stone floor at y 63, driven only by physics ticks. Axis z turns the scene so the walk runs along z.
// A look takes turnTicks ticks and a click toggles the door.
// A plate puts that plate under the body. With lag, the server presses it and opens the door from the start,
// and the client sees both at the end of tick lag. A click reaches the server and comes back at once.
async function body ({ facing = 'east', hinge = 'left', open = false, axis = 'x', turnTicks = 1, refuse = false, plate, pressed = false, lag } = {}) {
  const at = (along, y, across = 0) => (axis === 'x' ? new Vec3(along, y, across) : new Vec3(across, y, along))
  const door = [at(2, 64), at(2, 65)]
  const plateAt = at(1, 64)
  const goal = at(4, 64)
  const cells = {}
  for (let s = -2; s <= 2; s++) for (const y of [64, 65]) cells[key(at(2, y, s))] = ['stone', {}]
  for (const [p, half] of [[door[0], 'lower'], [door[1], 'upper']]) {
    cells[key(p)] = ['oak_door', { facing, half, hinge, open: String(open), powered: 'false' }]
  }
  if (plate) cells[key(plateAt)] = [plate, plateProps(plate, pressed)]
  const server = { door: lag === undefined ? open : true }
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.write = () => {}
  client.end = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  bot.loadPlugin(pathfinder)
  await once(bot, 'inject_allowed')
  const Block = require('prismarine-block')(bot.registry)

  let ticks = 0
  let looking = null
  let pending = null
  // Mineflayer's look: a new look finishes the pending one, and one with no change resolves at once.
  const turn = (target) => {
    if (pending) {
      pending.resolve()
      pending = null
    }
    if (target === looking) return Promise.resolve()
    looking = target
    return new Promise((resolve) => { pending = { resolve, due: ticks + turnTicks } })
  }

  const doorOpen = () => cells[key(door[0])][1].open === 'true'
  const show = (p, props) => {
    const old = bot.blockAt(p)
    cells[key(p)][1] = { ...cells[key(p)][1], ...props }
    bot.emit('blockUpdate', old, bot.blockAt(p))
    bot.emit(`blockUpdate:${p}`, old, bot.blockAt(p))
  }
  const setDoor = (value) => {
    server.door = value
    for (const p of door) show(p, { open: String(value) })
  }

  // Each click with the server's door state when it was written.
  const writes = []
  let looks = 0
  let firstLook = null
  let reached = null
  let walked = false
  Object.assign(bot, {
    entity: { position: at(1.5, 64, 0.5), velocity: new Vec3(0, 0, 0), width: 0.6, height: 1.8, onGround: true },
    entities: {},
    game: { minY: -64, height: 384, dimension: 'overworld' },
    inventory: { items: () => [] },
    blockAt (p) {
      const c = p.floored()
      const [name, props] = cells[key(c)] || [c.y <= 63 ? 'stone' : 'air', {}]
      const b = Block.fromProperties(name, props, 0)
      b.position = c
      return b
    },
    lookAt (point) {
      looks++
      if (firstLook === null) firstLook = ticks
      return turn(key(point))
    },
    look (yaw, pitch) {
      return turn(`look ${yaw},${pitch}`)
    },
    setControlState (control, state) {
      if (control === 'forward' && state) walked = true
    },
    clearControlStates () {},
    async activateBlock (block) {
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5))
      if (refuse) throw new Error('click refused')
      writes.push(server.door)
      setDoor(!server.door)
    }
  })

  const moves = new Movements(bot)
  bot.registry.blocksArray.forEach((b) => { if (b.name.endsWith('_door') && !b.name.includes('iron')) moves.openable.add(b.id) })
  moves.canOpenDoors = true
  moves.canDig = false
  bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
  bot.pathfinder.setMovements(moves)
  bot.pathfinder.setGoal(new goals.GoalBlock(goal.x, goal.y, goal.z))

  // One physics tick, then a look due by its end finishes, then every continuation it unblocks runs,
  // then the plate's late updates arrive.
  const tick = async () => {
    ticks++
    bot.emit('physicsTick')
    if (reached === null && bot.pathfinder.isBuilding()) reached = ticks
    if (pending && ticks >= pending.due) {
      pending.resolve()
      pending = null
    }
    await new Promise(setImmediate)
    if (ticks === lag) {
      show(plateAt, plateProps(plate, true))
      for (const p of door) show(p, { open: String(server.door) })
      await new Promise(setImmediate)
    }
  }
  // Ticks until the walk starts its first look, which is the tick it enters the door.
  const reachDoor = async () => {
    for (let i = 0; i < 10 && looks === 0; i++) await tick()
    assert.ok(looks > 0, 'the walk reached the door')
  }
  return {
    bot,
    tick,
    reachDoor,
    writes,
    doorOpen,
    serverOpen: () => server.door,
    plate: () => setDoor(true),
    shapes: () => bot.blockAt(door[0]).shapes,
    now: () => ticks,
    firstLook: () => firstLook,
    reached: () => reached,
    walked: () => walked,
    resetWalked: () => { walked = false }
  }
}

test('control: a closed door stands across a walk along x and an open one leaves it clear, the other way round for a door set sideways', async () => {
  assert.strictEqual(blocksX((await body()).shapes()), true, 'closed')
  assert.strictEqual(blocksX((await body({ open: true })).shapes()), false, 'open')
  assert.strictEqual(blocksX((await body({ facing: 'south' })).shapes()), false, 'sideways closed')
  assert.strictEqual(blocksX((await body({ facing: 'south', open: true })).shapes()), true, 'sideways open')
})

test('a door a plate opens during the look before the click is left open and walked through', async () => {
  for (let turnTicks = 1; turnTicks <= 4; turnTicks++) {
    for (let after = 0; after < turnTicks; after++) {
      const at = `a ${turnTicks}-tick look, the plate after ${after} ticks`
      const w = await body({ turnTicks })
      await w.reachDoor()
      for (let i = 0; i < after; i++) await w.tick()
      w.plate()
      w.resetWalked()
      for (let i = 0; i < 3 * turnTicks + 5; i++) await w.tick()
      assert.deepStrictEqual(w.writes.filter((open) => open), [], `${at}: no click on an open door`)
      assert.strictEqual(w.doorOpen(), true, `${at}: the door ends open`)
      assert.strictEqual(w.bot.pathfinder.isBuilding(), false, `${at}: the walk left the door`)
      assert.strictEqual(w.walked(), true, `${at}: the walk went on`)
    }
  }
})

test('a closed door gets one click during a slow look and ends open', async () => {
  const w = await body({ turnTicks: 4 })
  await w.reachDoor()
  for (let i = 0; i < 20; i++) await w.tick()
  assert.deepStrictEqual(w.writes, [false])
  assert.strictEqual(w.doorOpen(), true)
  assert.strictEqual(w.walked(), true)
})

test('a door set sideways into the wall is walked through closed and clicked shut once when open', async () => {
  const closed = await body({ facing: 'south' })
  for (let i = 0; i < 10; i++) await closed.tick()
  assert.deepStrictEqual(closed.writes, [], 'closed')
  assert.strictEqual(closed.walked(), true, 'closed')

  const open = await body({ facing: 'south', open: true })
  for (let i = 0; i < 10; i++) await open.tick()
  assert.deepStrictEqual(open.writes, [true], 'open')
  assert.strictEqual(open.doorOpen(), false, 'open')
})

test('a path reset during the look leaves the door to the new path, which clicks it once', async () => {
  const w = await body({ turnTicks: 2 })
  await w.reachDoor()
  w.bot.pathfinder.setGoal(new goals.GoalBlock(4, 64, 0))
  for (let i = 0; i < 20; i++) await w.tick()
  assert.deepStrictEqual(w.writes, [false])
  assert.strictEqual(w.doorOpen(), true)
  assert.strictEqual(w.bot.pathfinder.isBuilding(), false)
  assert.strictEqual(w.walked(), true)
})

test('a refused click resets the path', async (t) => {
  t.mock.method(console, 'error', () => {})
  const w = await body({ refuse: true })
  const reasons = []
  w.bot.on('path_reset', (reason) => reasons.push(reason))
  await w.reachDoor()
  for (let i = 0; i < 5; i++) await w.tick()
  assert.strictEqual(reasons[0], 'use_error')
})

test('a door the plate under the body opens is not clicked shut while the plate update is late', async () => {
  for (const plate of PLATES) {
    for (let lag = 2; lag <= 6; lag++) {
      const at = `${plate}, the update after ${lag} ticks`
      const w = await body({ plate, lag })
      await w.tick()
      w.resetWalked()
      for (let i = 0; i < lag + 10; i++) await w.tick()
      assert.deepStrictEqual(w.writes.filter((open) => open), [], `${at}: no click on the open door`)
      assert.strictEqual(w.serverOpen(), true, `${at}: the door ends open`)
      assert.strictEqual(w.bot.pathfinder.isBuilding(), false, `${at}: the walk left the door`)
      assert.strictEqual(w.walked(), true, `${at}: the walk went on`)
    }
  }
})

test('with no plate under the body the walk looks at the door on the tick it reaches it', async () => {
  const w = await body()
  await w.reachDoor()
  assert.strictEqual(w.firstLook(), w.reached())
})

test('a plate that already reads pressed does not delay the door', async () => {
  for (const plate of PLATES) {
    const w = await body({ plate, pressed: true })
    await w.reachDoor()
    assert.strictEqual(w.firstLook(), w.reached(), plate)
    for (let i = 0; i < 10; i++) await w.tick()
    assert.deepStrictEqual(w.writes, [false], plate)
    assert.strictEqual(w.doorOpen(), true, plate)
  }
})

test('a plate that never reads pressed holds the door for a bounded wait and leaves no listener', async () => {
  const w = await body({ plate: 'oak_pressure_plate' })
  const cell = `blockUpdate:${PLATE}`
  const before = [w.bot.listenerCount(cell), w.bot.listenerCount('physicsTick')]
  for (let i = 0; i < 30; i++) await w.tick()
  // The pathfinder's PLATE_WAIT_TICKS, 20.
  assert.strictEqual(w.firstLook(), w.reached() + 20)
  assert.deepStrictEqual(w.writes, [false])
  assert.strictEqual(w.doorOpen(), true)
  assert.strictEqual(w.walked(), true)
  assert.deepStrictEqual([w.bot.listenerCount(cell), w.bot.listenerCount('physicsTick')], before)
})

test('a path reset during the plate wait leaves the door to the new path, which clicks it once', async () => {
  const w = await body({ plate: 'oak_pressure_plate' })
  for (let i = 0; i < 5; i++) await w.tick()
  assert.strictEqual(w.firstLook(), null, 'the walk is waiting on the plate')
  w.bot.pathfinder.setGoal(new goals.GoalBlock(4, 64, 0))
  const resetAt = w.now()
  for (let i = 0; i < 40; i++) await w.tick()
  // The new path reaches the door on the next tick and waits the pathfinder's PLATE_WAIT_TICKS, 20.
  assert.strictEqual(w.firstLook(), resetAt + 1 + 20)
  assert.deepStrictEqual(w.writes, [false])
  assert.strictEqual(w.doorOpen(), true)
  assert.strictEqual(w.walked(), true)
})

test('a stop during the plate wait leaves the door unclicked', async () => {
  const w = await body({ plate: 'oak_pressure_plate' })
  const probe = new goals.GoalBlock(4, 64, 0)
  let valid = true
  probe.isValid = () => valid
  w.bot.pathfinder.setGoal(probe)
  for (let i = 0; i < 3; i++) await w.tick()
  assert.strictEqual(w.firstLook(), null, 'the walk is waiting on the plate')
  valid = false
  for (let i = 0; i < 40; i++) await w.tick()
  assert.deepStrictEqual(w.writes, [])
  assert.strictEqual(w.doorOpen(), false)
  w.bot.pathfinder.setGoal(new goals.GoalBlock(4, 64, 0))
  for (let i = 0; i < 60; i++) await w.tick()
  assert.deepStrictEqual(w.writes, [false])
  assert.strictEqual(w.doorOpen(), true)
})

test('the walk clicks a door on reaching it exactly when panelAcross puts its panel across the way, for every door state on both axes', async () => {
  const registry = (await body()).bot.registry
  const Block = require('prismarine-block')(registry)
  const doors = registry.blocksArray.map((b) => b.name).filter((n) => n.endsWith('_door') && !n.includes('iron'))
  const states = []
  for (const facing of ['north', 'east', 'south', 'west']) {
    for (const hinge of ['left', 'right']) for (const open of [false, true]) states.push({ facing, hinge, open })
  }
  for (const { facing, hinge, open } of states) {
    const shapes = (name) => Block.fromProperties(name, { facing, half: 'lower', hinge, open: String(open), powered: 'false' }, 0).shapes
    for (const name of doors) assert.deepStrictEqual(shapes(name), shapes('oak_door'), `${name} ${facing} ${hinge} ${open}`)
  }
  for (const axis of ['x', 'z']) {
    for (const props of states) {
      const at = `${props.facing} ${props.hinge} ${props.open ? 'open' : 'closed'}, walking along ${axis}`
      const across = panelAcross('oak_door', { ...props, half: 'lower' }, axis)
      // The walk reads the lower half only.
      assert.strictEqual(panelAcross('oak_door', { ...props, half: 'upper' }, axis), across, `${at}: both halves`)
      const w = await body({ ...props, axis })
      for (let i = 0; i < 10; i++) await w.tick()
      assert.notStrictEqual(w.reached(), null, `${at}: the walk reached the door`)
      assert.strictEqual(w.writes.length > 0, across, at)
    }
  }
})

test('the doorway drill waits on a plate as long as the pathfinder does', () => {
  const src = fs.readFileSync(require.resolve('mineflayer-pathfinder'), 'utf8')
  assert.strictEqual(Number(/^const PLATE_WAIT_TICKS = (\d+)$/m.exec(src)?.[1]), PLATE_WAIT_TICKS)
})

// The doorway drill with the body at 1.5,64,0.5 beside an oak door at 2,64,0 facing east in a stone wall at x 2.
// A look takes turnTicks ticks and calls onLook with its start tick, and a look at the target it faces takes none.
// A plate puts that plate under the body. With lag, the server opened the door from the start,
// and the client sees the plate pressed and the door at the end of tick lag. A click reaches the server and comes back at once.
function drill ({ turnTicks = 1, plate, lag, onLook } = {}) {
  const Block = require('prismarine-block')(require('prismarine-registry')('1.21.11'))
  const server = { open: lag !== undefined }
  const shown = { open: false, pressed: false }
  let ticks = 0
  const due = new Map()
  const at = (t, fn) => due.set(t, [...(due.get(t) || []), fn])
  const tick = () => { ticks++; for (const fn of due.get(ticks) || []) fn() }
  if (lag !== undefined) at(lag, () => { shown.pressed = true; shown.open = server.open })
  const cells = {}
  for (const z of [-2, -1, 1, 2]) for (const y of [64, 65]) cells[key({ x: 2, y, z })] = () => ['stone', {}]
  for (const [y, half] of [[64, 'lower'], [65, 'upper']]) cells[key({ x: 2, y, z: 0 })] = () => ['oak_door', { facing: 'east', half, hinge: 'left', open: String(shown.open), powered: 'false' }]
  if (plate) cells[key({ x: 1, y: 64, z: 0 })] = () => [plate, plateProps(plate, shown.pressed)]
  const writes = []
  const looks = []
  const nudges = []
  let looking = null
  const bot = {
    entity: { position: new Vec3(1.5, 64, 0.5) },
    blockAt (p) {
      const c = new Vec3(p.x, p.y, p.z).floored()
      const [name, props] = cells[key(c)]?.() || [c.y <= 63 ? 'stone' : 'air', {}]
      const b = Block.fromProperties(name, props, 0)
      b.position = c
      return b
    },
    findBlocks: () => [new Vec3(2, 64, 0), new Vec3(2, 65, 0)],
    async lookAt (point) {
      if (String(point) === looking) return
      looking = String(point)
      looks.push(ticks)
      onLook?.(ticks, at)
      for (let i = 0; i < turnTicks; i++) tick()
    },
    async activateBlock (b) {
      await bot.lookAt(b.position.offset(0.5, 0.5, 0.5))
      writes.push(server.open)
      server.open = !server.open
      shown.open = server.open
    },
    async waitForTicks (n) { for (let i = 0; i < n; i++) tick() },
    pathfinder: { goal: null }
  }
  const env = {
    bot,
    shared: { mcData: { blocksByName: { oak_door: { id: 1, name: 'oak_door' } } } },
    cellKnown: () => true,
    seenNow: () => true,
    routeEnd: () => null,
    walkOnce: async () => 'done',
    nudgeInto: async (cell) => { nudges.push([String(cell), ticks]); return true },
    stopPath () {},
    goals,
    isDoor,
    panelAcross,
    doorCrossing,
    PLATE_WAIT_TICKS,
    console: { log () {} }
  }
  const { doorwayCommit } = loadBotFunctions(['doorwayCommit'], env)
  return { run: () => doorwayCommit({}), writes, looks, nudges, serverOpen: () => server.open, open: (value) => { server.open = value; shown.open = value } }
}

const THROUGH = { door: { name: 'oak_door', x: 2, y: 64, z: 0 }, through: true }

test('the doorway drill leaves open a door a plate opens while the body turns to it, and walks through', async () => {
  for (let turnTicks = 1; turnTicks <= 4; turnTicks++) {
    for (let after = 0; after < turnTicks; after++) {
      const at = `a ${turnTicks}-tick look, the plate after ${after} ticks`
      const d = drill({ turnTicks, onLook: (start, schedule) => schedule(start + after + 1, () => d.open(true)) })
      assert.deepStrictEqual(JSON.parse(JSON.stringify(await d.run())), THROUGH, at)
      assert.deepStrictEqual(d.writes, [], `${at}: no click`)
      assert.strictEqual(d.serverOpen(), true, `${at}: the door ends open`)
    }
  }
})

test('the doorway drill does not click shut a door the plate under the body opens while the plate update is late', async () => {
  for (const plate of ['oak_pressure_plate', 'light_weighted_pressure_plate']) {
    for (let lag = 2; lag <= 6; lag++) {
      const at = `${plate}, the update after ${lag} ticks`
      const d = drill({ plate, lag })
      assert.deepStrictEqual(JSON.parse(JSON.stringify(await d.run())), THROUGH, at)
      assert.deepStrictEqual(d.writes, [], `${at}: no click`)
      assert.strictEqual(d.serverOpen(), true, `${at}: the door ends open`)
      assert.deepStrictEqual(d.nudges[0], ['(2, 64, 0)', lag], `${at}: the body walks in once the plate reads pressed`)
    }
  }
})

test('the doorway drill clicks a closed door once and walks through', async () => {
  const d = drill({ turnTicks: 4 })
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await d.run())), THROUGH)
  assert.deepStrictEqual(d.writes, [false])
  assert.strictEqual(d.serverOpen(), true)
})

test('a plate that never reads pressed holds the doorway drill for a bounded wait, then the closed door gets one click', async () => {
  const d = drill({ plate: 'oak_pressure_plate' })
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await d.run())), THROUGH)
  assert.deepStrictEqual(d.looks, [PLATE_WAIT_TICKS])
  assert.deepStrictEqual(d.writes, [false])
  assert.strictEqual(d.serverOpen(), true)
})

// The unstuck ladder with the body at 0.5,64,0.5 walking east to 6,64,0 through a door or gate at 1,64,0 in a stone wall at x 1.
// The walk moves 0.2 a tick and stalls against a collision box. With openOnLook, the first look at the door opens it, as a plate would.
// A click reaches the server and comes back at once.
function ladder ({ name = 'oak_door', facing = 'east', hinge = 'left', open = false, openOnLook = false } = {}) {
  const Block = require('prismarine-block')(require('prismarine-registry')('1.21.11'))
  const DOOR = new Vec3(1, 64, 0)
  const state = { open, openOnLook }
  const cells = {}
  for (const z of [-2, -1, 1, 2]) for (const y of [64, 65]) cells[key({ x: 1, y, z })] = () => ['stone', {}]
  if (name.endsWith('_fence_gate')) cells[key(DOOR)] = () => [name, { facing, in_wall: 'false', open: String(state.open), powered: 'false' }]
  else for (const [y, half] of [[64, 'lower'], [65, 'upper']]) cells[key({ x: 1, y, z: 0 })] = () => [name, { facing, half, hinge, open: String(state.open), powered: 'false' }]
  const blockAt = (p) => {
    const c = new Vec3(p.x, p.y, p.z).floored()
    const [n, props] = cells[key(c)]?.() || [c.y <= 63 ? 'stone' : 'air', {}]
    const b = Block.fromProperties(n, props, 0)
    b.position = c
    return b
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
  bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: 0, width: 0.6, height: 1.8 }
  bot.blockAt = blockAt
  const face = (t) => {
    const p = bot.entity.position
    bot.entity.yaw = Math.atan2(-(t.x - p.x), -(t.z - p.z))
  }
  bot.lookAt = async (t) => {
    face(t)
    if (state.openOnLook && new Vec3(t.x, t.y, t.z).floored().equals(DOOR)) {
      state.openOnLook = false
      state.open = true
    }
  }
  const controls = {}
  bot.setControlState = (c, v) => { controls[c] = v }
  bot.clearControlStates = () => { for (const c of Object.keys(controls)) controls[c] = false }
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
    face({ x: target.x + 0.5, z: target.z + 0.5 })
    move(0.2)
  }
  bot.waitForTicks = async (n) => { for (let i = 0; i < n; i++) tick() }
  const writes = []
  bot.activateBlock = async (b) => {
    await bot.lookAt(b.position.offset(0.5, 0.5, 0.5))
    writes.push(state.open)
    state.open = !state.open
  }
  bot.dig = async () => { throw new Error('dig') }
  bot.inventory = { items: () => [] }

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
    CONTAINERS: botConstant('CONTAINERS'),
    doorCrossing,
    panelAcross
  }
  const reflex = reflexIn('unstuck', env)
  const run = async () => {
    bot.pathfinder.setGoal(new goals.GoalNear(6, 64, 0, 1))
    await reflex.act(bot)
  }
  return { bot, run, writes, events, open: () => state.open }
}

test('unstuck leaves open a door that opens while the body turns to it, and walks through', async () => {
  const w = ladder({ openOnLook: true })
  await w.run()
  assert.deepStrictEqual(w.writes, [], 'no click')
  assert.deepStrictEqual(w.events, ['unstuck: found the oak_door at 1,64,0 already open'])
  assert.ok(w.bot.entity.position.x > 2, `the walk went through, at x ${w.bot.entity.position.x}`)
})

test('unstuck walks through a closed door set sideways into the wall without a click and clicks it shut once when open', async () => {
  // Hinge right puts the open panel on the body's side of the door cell.
  const closed = ladder({ facing: 'south', hinge: 'right' })
  await closed.run()
  assert.deepStrictEqual(closed.writes, [], 'closed')
  assert.ok(closed.bot.entity.position.x > 2, `closed: the walk went through, at x ${closed.bot.entity.position.x}`)

  const open = ladder({ facing: 'south', hinge: 'right', open: true })
  await open.run()
  assert.deepStrictEqual(open.writes, [true], 'open')
  assert.strictEqual(open.open(), false, 'open')
  assert.ok(open.bot.entity.position.x > 2, `open: the walk went through, at x ${open.bot.entity.position.x}`)
})

test('unstuck clicks a closed fence gate in front once and an open one not at all', async () => {
  const closed = ladder({ name: 'oak_fence_gate' })
  await closed.run()
  assert.deepStrictEqual(closed.writes, [false], 'closed')
  assert.deepStrictEqual(closed.events, ['unstuck: opened the oak_fence_gate at 1,64,0'], 'closed')
  assert.ok(closed.bot.entity.position.x > 2, `closed: the walk went through, at x ${closed.bot.entity.position.x}`)

  const open = ladder({ name: 'oak_fence_gate', open: true })
  await open.run()
  assert.deepStrictEqual(open.writes, [], 'open')
  assert.ok(open.bot.entity.position.x > 2, `open: the walk went through, at x ${open.bot.entity.position.x}`)
})