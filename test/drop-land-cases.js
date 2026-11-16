'use strict'
// These walks run the pathfinder's real executor on prismarine-physics.
const test = require('node:test')
const assert = require('node:assert')
const { createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { Physics, PlayerState } = require('prismarine-physics')
const { walkingBody, farmlandTop } = require('./helpers')

const STONE = ['stone', {}]
const AIR = ['air', {}]
const FARM = ['farmland', { moisture: 7 }]
const WATER = ['water', { level: 0 }]

// Stone tops out at y 65 up to z 2, the path sits at y 64 on z 3 and the farmland bed starts at z 4.
function terrace (bed = FARM, corridor = false, half = 12) {
  const cells = {}
  for (let x = -half; x <= half; x++) {
    for (let z = -12; z <= 2; z++) cells[`${x},64,${z}`] = STONE
    for (let z = 4; z <= 9; z++) cells[`${x},63,${z}`] = bed
  }
  if (!corridor) return cells
  for (const y of [65, 66]) {
    for (let z = -3; z <= 2; z++) cells[`-1,${y},${z}`] = cells[`1,${y},${z}`] = STONE
    cells[`0,${y},-4`] = STONE
  }
  return cells
}

function turn (a) {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

// The 1.7.10 server reads a fall on the block 0.2 below the feet.
async function walk (t, start, goal, cells, { sprint = true, moves = (m) => m, settle = false, trample = false } = {}) {
  const { bot, trampleGoal } = await walkingBody(t, start, cells)
  const world = { getBlock: (p) => bot.blockAt(p) }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  // The yaw the server was sent.
  let sent = null
  const look = async (yaw, pitch) => {
    sent ??= yaw
    Object.assign(bot.entity, { yaw, pitch })
  }
  Object.assign(bot.entity, { yaw: 0, pitch: 0, effects: {}, attributes: {}, isCollidedHorizontally: false, isInWater: false })
  Object.assign(bot, {
    physics: Physics(bot.registry, world),
    jumpTicks: 0,
    jumpQueued: false,
    food: 20,
    controlState: controls,
    setControlState (k, v) { controls[k] = v },
    getControlState: (k) => controls[k],
    sprintFacing: () => Math.abs(turn(sent - bot.entity.yaw)) <= Math.PI / 4 + 1e-3,
    clearControlStates () { for (const k in controls) controls[k] = false },
    look,
    lookAt: () => look(0, 0),
    inventory: { items: () => [], slots: [] }
  })
  const TURN = bot.physics.yawSpeed * 0.05
  moves(bot.pathfinder.movements)
  bot.pathfinder.movements.allowSprinting = sprint
  bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
  let plan = null
  let done = false
  // The executor shifts this array as it takes nodes.
  let path = []
  bot.on('path_update', (r) => {
    path = r.path
    plan ??= r.path.map((n) => [n.x, n.y, n.z])
  })
  bot.on('goal_reached', () => { done = true })
  bot.pathfinder.setGoal(trample ? trampleGoal(goal) : goal)
  const trace = []
  const touchdowns = []
  // Each node the executor took, with where the body stood on that tick.
  const taken = []
  let peak = start.y
  let wasGround = true
  let ticks = 0
  let wet = 0
  // Ticks the body sat in the next node's arrival box and the executor kept the node.
  let held = 0
  const sprints = []
  for (; ticks < 400 && (!done || (settle && !bot.entity.onGround)); ticks++) {
    // mineflayer eases the sent yaw toward the body's at yawSpeed.
    if (sent !== null) sent += Math.max(-TURN, Math.min(TURN, turn(bot.entity.yaw - sent)))
    const sprinting = controls.sprint && controls.forward && bot.sprintFacing()
    bot.physics.simulatePlayer(new PlayerState(bot, { ...controls, sprint: sprinting }), world).apply(bot)
    const e = bot.entity
    const p = e.position
    sprints.push({ sprinting, ground: e.onGround, at: [p.x, p.y, p.z] })
    if (e.isInWater) wet++
    if (!e.onGround) peak = Math.max(peak, p.y)
    if (e.onGround && !wasGround) touchdowns.push({ tick: ticks, on: bot.blockAt(p.offset(0, -0.2, 0)).name, fall: peak - p.y, at: [p.x, p.y, p.z] })
    if (e.onGround) peak = p.y
    wasGround = e.onGround
    trace.push([p.x, p.y, p.z, e.onGround, e.yaw, Object.keys(controls).filter((k) => controls[k]).join('+')].join(' '))
    const [next] = path
    const before = path
    const inBox = next && Math.abs(next.x - p.x) <= 0.35 && Math.abs(next.z - p.z) <= 0.35 && Math.abs(next.y - p.y) < 1
    bot.emit('physicsTick')
    if (inBox && path === before && path[0] === next) held++
    if (next && path === before && path[0] !== next) taken.push({ node: [next.x, next.y, next.z], at: [p.x, p.y, p.z], ground: e.onGround })
  }
  bot.pathfinder.stop()
  bot.removeAllListeners()
  const farmFall = Math.max(0, ...touchdowns.filter((d) => d.on === 'farmland').map((d) => d.fall))
  const hash = createHash('sha256').update(trace.join('\n')).digest('hex').slice(0, 16)
  const end = bot.entity.position
  const downs = touchdowns.map((d) => `${d.on} ${d.at.map((v) => v.toFixed(3)).join(' ')}`).join(', ')
  t.diagnostic(`ticks ${ticks}, farmland fall ${farmFall.toFixed(4)}, end ${end.x.toFixed(3)} ${end.y.toFixed(4)} ${end.z.toFixed(3)}, touchdowns ${downs}, held ${held}, trace ${hash}`)
  return { done, plan, touchdowns, farmFall, wet, sprints, held, taken, hash }
}

function at3 (touchdown) {
  return touchdown.at.map((v) => Math.round(v * 1000) / 1000)
}

function consecutive (plan, a, b, c) {
  const at = plan.findIndex((n) => n[0] === b[0] && n[1] === b[1] && n[2] === b[2])
  const say = JSON.stringify(plan)
  assert.ok(at > 0, `${JSON.stringify(b)} not in ${say}`)
  assert.deepStrictEqual([plan[at - 1], plan[at + 1]], [a, c], say)
}

function channel () {
  const cells = {}
  for (let x = -12; x <= 12; x++) {
    for (let z = -12; z <= 2; z++) cells[`${x},64,${z}`] = STONE
    cells[`${x},63,3`] = WATER
    for (let z = 4; z <= 9; z++) {
      cells[`${x},63,${z}`] = AIR
      cells[`${x},62,${z}`] = FARM
    }
  }
  return cells
}

function unseen (m) {
  const getBlock = m.getBlock.bind(m)
  m.getBlock = (pos, dx, dy, dz) => {
    const b = getBlock(pos, dx, dy, dz)
    return b.name === 'farmland' ? { ...b, type: null, name: 'solid' } : b
  }
}

function sprintsOffEdge (r, top) {
  return r.sprints.find((s) => s.at[1] < top).sprinting
}

// The terrace with a drop of 2 onto the path.
function high () {
  const cells = terrace()
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 2; z++) cells[`${x},65,${z}`] = STONE
  return cells
}

// The terrace with a stone ledge at height y running out to z = last, one for each [y, last].
function ledges (bed, ...levels) {
  const cells = terrace(bed)
  for (const [y, last] of levels) for (let x = -12; x <= 12; x++) for (let z = -12; z <= last; z++) cells[`${x},${y},${z}`] = STONE
  return cells
}

// The field's terraces: farmland beds two rows wide between 1-wide paths, each level one lower, walled on both sides.
function field () {
  const cells = {}
  const ends = [5, 4, 6]
  const paths = [['cobblestone', {}], ['stone_bricks', {}], ['oak_planks', {}]]
  for (let x = -2; x <= 8; x++) {
    for (let z = -1; z <= 10; z++) {
      const level = Math.floor(z / 3)
      let floor = null
      if (x > -2 && z > -1 && z < 9 && x <= ends[level]) floor = [64 - level, z % 3 === 0 ? paths[level] : FARM]
      if (x > -2 && z === 9 && x <= ends[2]) floor = [61, STONE]
      for (let y = 55; y <= 67; y++) cells[`${x},${y},${z}`] = !floor || y < floor[0] ? STONE : y === floor[0] ? floor[1] : AIR
    }
  }
  return cells
}

function bedAbove (upper = FARM, bed = FARM) {
  const cells = terrace(bed)
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 2; z++) cells[`${x},64,${z}`] = upper
  return cells
}

// The path at feet 64 on z 3 between the bed and a floor one lower, dry or under water.
function below (fill) {
  const cells = {}
  for (let x = -12; x <= 12; x++) {
    for (let z = -12; z <= 2; z++) cells[`${x},63,${z}`] = fill
    for (let z = 4; z <= 9; z++) cells[`${x},63,${z}`] = FARM
  }
  return cells
}

// differ holds the expectations that change with farmland's collision height.
function dropLandCases (differ = {}) {
  const top = farmlandTop()
  const bed = (y) => y + top
  // airSprintPast: the z past which the field descent may sprint in the air.
  const expect = { straight: [0.5, 63.938, 4.374], airSprintPast: Infinity, ...differ }

  test('a walking drop onto the path touches down on the path before it steps onto the bed', async (t) => {
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 64, 5), terrace(), { sprint: false })
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64, 3.5], [0.5, bed(63), 4.5])
    assert.ok(r.done)
    assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
  })

  for (let run = 1; run <= 8; run++) {
    test(`a sprinting drop after a run of ${run} touches down on the path before it steps onto the bed`, async (t) => {
      const r = await walk(t, new Vec3(0.5, 65, 2.5 - run), new goals.GoalBlock(0, 64, 5), terrace())
      consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64, 3.5], [0.5, bed(63), 4.5])
      assert.ok(r.done)
      assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
    })
  }

  test('a diagonal drop onto the path touches down on the path before it steps on diagonally onto the bed', async (t) => {
    const r = await walk(t, new Vec3(-2.5, 65, -0.5), new goals.GoalBlock(3, 64, 6), terrace())
    consecutive(r.plan, [-0.5, 65, 2.5], [0.5, 64, 3.5], [1.5, bed(63), 4.5])
    assert.ok(r.done)
    assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
  })

  test('a straight drop onto the path touches down on the path before it steps on diagonally onto the bed', async (t) => {
    // A pillar on the path east of the drop leaves no diagonal drop.
    const cells = terrace(FARM, true)
    for (const y of [64, 65]) cells[`1,${y},3`] = STONE
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(2, 64, 5), cells)
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64, 3.5], [1.5, bed(63), 4.5])
    assert.ok(r.done)
    assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
  })

  test('a drop with stone beyond the path walks on', async (t) => {
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 64, 5), terrace(STONE))
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64, 3.5], [0.5, 64, 4.5])
    assert.ok(r.done)
    assert.deepStrictEqual(r.touchdowns.map((d) => d.on), ['stone', 'stone'])
  })

  test('a sprinting drop with stone beyond the path keeps its sprint', async (t) => {
    const r = await walk(t, new Vec3(0.5, 65, 1.5), new goals.GoalBlock(0, 64, 5), terrace(STONE))
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64, 3.5], [0.5, 64, 4.5])
    assert.ok(r.done)
    assert.ok(r.sprints.find((s) => s.at[1] < 65).sprinting)
  })

  test('a descent of three drops with no farmland walks on', async (t) => {
    const cells = {}
    for (let x = -12; x <= 12; x++) {
      for (let z = -12; z <= 2; z++) for (const y of [64, 65, 66]) cells[`${x},${y},${z}`] = STONE
      for (const y of [64, 65]) cells[`${x},${y},3`] = STONE
      cells[`${x},64,4`] = STONE
    }
    const r = await walk(t, new Vec3(0.5, 67, 0.5), new goals.GoalBlock(0, 64, 8), cells)
    consecutive(r.plan, [0.5, 67, 2.5], [0.5, 66, 3.5], [0.5, 65, 4.5])
    consecutive(r.plan, [0.5, 66, 3.5], [0.5, 65, 4.5], [0.5, 64, 5.5])
    assert.ok(r.done)
    assert.ok(r.touchdowns.length >= 3, JSON.stringify(r.touchdowns))
  })

  test('a drop onto the path with the bed one lower beyond steps on in the air', async (t) => {
    const cells = {}
    for (let x = -12; x <= 12; x++) {
      for (let z = -12; z <= 2; z++) cells[`${x},64,${z}`] = STONE
      for (let z = 4; z <= 9; z++) {
        cells[`${x},63,${z}`] = AIR
        cells[`${x},62,${z}`] = FARM
      }
    }
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 63, 6), cells, { trample: true })
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64, 3.5], [0.5, bed(62), 4.5])
    assert.ok(r.done)
    const onPath = r.touchdowns.find((d) => d.at[1] === 64)
    assert.ok(onPath.at[2] > 4, `touchdown at ${onPath.at}`)
  })

  test('a drop into water beside the bed swims on', async (t) => {
    // A jump across the pool or a walk round a narrower bed costs less than the swim out onto farmland.
    const cells = terrace(FARM, false, 40)
    for (let x = -40; x <= 40; x++) for (const z of [3, 4]) cells[`${x},63,${z}`] = WATER
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 64, 6), cells, { trample: true, moves: (m) => { m.allowParkour = false } })
    assert.ok(r.plan.some((n) => n[2] === 3.5 && n[1] < 64), `no water node in ${JSON.stringify(r.plan)}`)
    assert.ok(r.done)
    assert.ok(r.wet > 0)
  })

  test('a swim through water one above the bed climbs straight out onto it', async (t) => {
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 63, 6), channel())
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 63, 3.5], [0.5, bed(62), 4.5])
    assert.ok(r.done)
    assert.ok(r.wet > 0)
    assert.deepStrictEqual(at3(r.touchdowns.find((d) => d.on === 'farmland')), [0.5, 63, 4.41])
  })

  test('a sprinting drop into water with the bed beyond keeps its sprint', async (t) => {
    const r = await walk(t, new Vec3(0.5, 65, 1.5), new goals.GoalBlock(0, 63, 6), channel())
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 63, 3.5], [0.5, bed(62), 4.5])
    assert.ok(r.done)
    assert.ok(r.sprints.find((s) => s.at[1] < 65).sprinting)
  })

  test('a sprint jump down across a gap lands on the path before the bed', async (t) => {
    const cells = terrace()
    for (let x = -12; x <= 12; x++) {
      for (let z = 3; z <= 5; z++) for (let y = 58; y <= 63; y++) cells[`${x},${y},${z}`] = AIR
      cells[`${x},63,6`] = STONE
    }
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 64, 8), cells)
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64, 6.5], [0.5, bed(63), 7.5])
    assert.ok(r.done)
    assert.deepStrictEqual(r.touchdowns.slice(1, 2).map((d) => [d.on, d.at[1], Math.floor(d.at[2])]), [['stone', 64, 6]])
  })

  test('a sprint along level ground onto the bed keeps its sprint', async (t) => {
    const cells = {}
    for (let x = -12; x <= 12; x++) for (let z = 4; z <= 9; z++) cells[`${x},63,${z}`] = FARM
    const r = await walk(t, new Vec3(0.5, 64, -2.5), new goals.GoalBlock(0, 64, 7), cells)
    consecutive(r.plan, [0.5, 64, 2.5], [0.5, 64, 3.5], [0.5, bed(63), 4.5])
    assert.ok(r.done)
    const from = r.sprints.findIndex((s) => s.sprinting)
    const onBed = r.sprints.findIndex((s) => s.at[2] >= 4)
    assert.ok(from >= 0 && r.sprints.slice(from, onBed + 1).every((s) => s.sprinting))
  })

  test('a drop straight onto the bed steps on in the air', async (t) => {
    const cells = terrace(FARM, true)
    for (let x = -12; x <= 12; x++) cells[`${x},63,3`] = FARM
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 64, 6), cells, { trample: true })
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, bed(63), 3.5], [0.5, bed(63), 4.5])
    assert.ok(r.done)
    assert.strictEqual(r.held, 0)
    assert.deepStrictEqual(at3(r.touchdowns.find((d) => d.on === 'farmland')), expect.straight)
  })

  test('a sprinting drop whose bed beyond the path the bot has not seen keeps its sprint', async (t) => {
    const r = await walk(t, new Vec3(-2.5, 65, -0.5), new goals.GoalBlock(3, 64, 6), terrace(), { moves: unseen })
    consecutive(r.plan, [-0.5, 65, 2.5], [0.5, 64, 3.5], [1.5, bed(63), 4.5])
    assert.ok(r.done)
    assert.ok(sprintsOffEdge(r, 65))
  })

  const turns = [
    ['to a goal on it', new Vec3(0.5, 65, 2), new goals.GoalBlock(4, 64, 3), [[1.5, 64, 3.5], [2.5, 64, 3.5]]],
    ['to the bed further along', new Vec3(-2.5, 65, 2), new goals.GoalBlock(3, 64, 6), [[-1.5, 64, 3.5], [-0.5, 64, 3.5]]]
  ]
  for (const [where, start, goal, first] of turns) {
    test(`a sprinting drop whose plan turns along the path ${where} touches down on the path`, async (t) => {
      const r = await walk(t, start, goal, terrace())
      assert.deepStrictEqual(r.plan.slice(0, 2), first)
      assert.ok(r.done)
      assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
      assert.ok(r.sprints.every((s) => !s.sprinting || s.at[1] <= 64))
    })
  }

  test('a sprinting drop past the corner of a bed touches down on the path', async (t) => {
    const cells = terrace()
    for (let x = -12; x <= 1; x++) for (let z = 4; z <= 9; z++) cells[`${x},63,${z}`] = STONE
    const r = await walk(t, new Vec3(0.5, 65, 2), new goals.GoalBlock(4, 64, 3), cells)
    assert.deepStrictEqual(r.plan.slice(0, 2), [[1.5, 64, 3.5], [2.5, 64, 3.5]])
    assert.ok(r.done)
    assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
  })

  test('a sprinting drop of 2 whose plan turns along the path touches down on the path', async (t) => {
    const r = await walk(t, new Vec3(-2.5, 66, 2.25), new goals.GoalBlock(4, 64, 3), high())
    assert.deepStrictEqual(r.plan.slice(0, 2), [[-2.5, 64, 3.5], [-1.5, 64, 3.5]])
    assert.ok(r.done)
    assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
  })

  test('a sprinting drop of 2 onto a goal on the path touches down on the path', async (t) => {
    const r = await walk(t, new Vec3(0.5, 66, 1.5), new goals.GoalBlock(0, 64, 3), high(), { settle: true })
    assert.deepStrictEqual(r.plan, [[0.5, 66, 2.5], [0.5, 64, 3.5]])
    assert.ok(r.done)
    assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
  })

  for (const run of [1, 3]) {
    test(`a sprinting drop of 2 after a run of ${run} touches down on the path before it steps onto the bed`, async (t) => {
      const r = await walk(t, new Vec3(0.5, 66, 2.5 - run), new goals.GoalBlock(0, 64, 5), high())
      consecutive(r.plan, [0.5, 66, 2.5], [0.5, 64, 3.5], [0.5, bed(63), 4.5])
      assert.ok(r.done)
      assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
    })
  }

  test('a sprinting drop with farmland beside the landing and stone ahead keeps its sprint', async (t) => {
    const cells = terrace(STONE)
    for (const x of [-1, 1]) for (let z = 3; z <= 9; z++) cells[`${x},63,${z}`] = FARM
    const r = await walk(t, new Vec3(0.5, 65, 1.5), new goals.GoalBlock(0, 64, 6), cells)
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64, 3.5], [0.5, 64, 4.5])
    assert.ok(r.done)
    assert.ok(sprintsOffEdge(r, 65))
  })

  test('a sprinting drop onto a path 2 wide keeps its sprint', async (t) => {
    const cells = terrace()
    for (let x = -12; x <= 12; x++) cells[`${x},63,4`] = STONE
    const r = await walk(t, new Vec3(0.5, 65, 1.5), new goals.GoalBlock(0, 64, 6), cells)
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64, 3.5], [0.5, 64, 4.5])
    assert.ok(r.done)
    assert.ok(sprintsOffEdge(r, 65))
  })

  test('a sprinting drop whose plan turns along the path with a bed ahead the bot has not seen keeps its sprint', async (t) => {
    const r = await walk(t, new Vec3(0.5, 65, 2), new goals.GoalBlock(4, 64, 3), terrace(), { moves: unseen })
    assert.deepStrictEqual(r.plan.slice(0, 2), [[1.5, 64, 3.5], [2.5, 64, 3.5]])
    assert.ok(r.done)
    assert.ok(sprintsOffEdge(r, 65))
  })

  for (const sprint of [false, true]) {
    test(`a ${sprint ? 'sprinting' : 'walking'} descent of the field's terraces touches down on each path before it steps onto the bed`, async (t) => {
      const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(5, 62, 9), field(), { sprint })
      consecutive(r.plan, [0.5, bed(64), 2.5], [1.5, 64, 3.5], [1.5, bed(63), 4.5])
      consecutive(r.plan, [1.5, bed(63), 5.5], [2.5, 63, 6.5], [3.5, bed(62), 7.5])
      assert.ok(r.done)
      assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
      assert.ok(r.sprints.every((s) => !s.sprinting || s.ground || s.at[2] > expect.airSprintPast))
    })
  }

  for (const sprint of [false, true]) {
    test(`a ${sprint ? 'sprinting' : 'walking'} drop from a bed onto the path touches down on the path before it steps onto the bed`, async (t) => {
      const r = await walk(t, new Vec3(0.5, bed(64), 0.5), new goals.GoalBlock(0, 64, 5), bedAbove(), { sprint })
      consecutive(r.plan, [0.5, bed(64), 2.5], [0.5, 64, 3.5], [0.5, bed(63), 4.5])
      assert.ok(r.done)
      assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
      assert.ok(r.sprints.every((s) => !s.sprinting || s.ground))
    })
  }

  test('a walking drop from a dirt path onto the path touches down on the path before it steps onto the bed', async (t) => {
    const r = await walk(t, new Vec3(0.5, 64.9375, 0.5), new goals.GoalBlock(0, 64, 5), bedAbove(['dirt_path', {}]), { sprint: false })
    consecutive(r.plan, [0.5, 64.9375, 2.5], [0.5, 64, 3.5], [0.5, bed(63), 4.5])
    assert.ok(r.done)
    assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
  })

  test('a sprinting drop from soul sand onto the path touches down on the path before it steps onto the bed', async (t) => {
    const r = await walk(t, new Vec3(0.5, 64.875, 0.5), new goals.GoalBlock(0, 64, 5), bedAbove(['soul_sand', {}]))
    consecutive(r.plan, [0.5, 64.875, 2.5], [0.5, 64, 3.5], [0.5, bed(63), 4.5])
    assert.ok(r.done)
    assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
  })

  test('a drop from a bed with stone beyond the path holds no node', async (t) => {
    const r = await walk(t, new Vec3(0.5, bed(64), 0.5), new goals.GoalBlock(0, 64, 5), bedAbove(FARM, STONE))
    consecutive(r.plan, [0.5, bed(64), 2.5], [0.5, 64, 3.5], [0.5, 64, 4.5])
    assert.ok(r.done)
    assert.strictEqual(r.held, 0)
  })

  test('a walking drop from a bed onto a path 2 wide touches down on the path', async (t) => {
    const cells = bedAbove()
    for (let x = -12; x <= 12; x++) cells[`${x},63,4`] = STONE
    const r = await walk(t, new Vec3(0.5, bed(64), 0.5), new goals.GoalBlock(0, 64, 6), cells, { sprint: false })
    consecutive(r.plan, [0.5, bed(64), 2.5], [0.5, 64, 3.5], [0.5, 64, 4.5])
    assert.ok(r.done)
    assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
  })

  test('a step down from stone onto a dirt path with the bed beyond holds no node', async (t) => {
    const cells = terrace(STONE)
    for (let x = -12; x <= 12; x++) {
      cells[`${x},64,3`] = ['dirt_path', {}]
      for (let z = 4; z <= 9; z++) cells[`${x},64,${z}`] = FARM
    }
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 65, 6), cells)
    consecutive(r.plan, [0.5, 65, 2.5], [0.5, 64.9375, 3.5], [0.5, bed(64), 4.5])
    assert.ok(r.done)
    assert.strictEqual(r.held, 0)
  })

  test('a walk down a staircase of bottom slabs to the path with the bed beyond holds no node', async (t) => {
    const slab = ['stone_slab', { type: 'bottom', waterlogged: false }]
    const cells = {}
    for (let x = -12; x <= 12; x++) {
      for (let z = -12; z <= 2; z++) cells[`${x},64,${z}`] = STONE
      for (let z = -12; z <= 0; z++) cells[`${x},65,${z}`] = STONE
      cells[`${x},65,1`] = slab
      cells[`${x},64,3`] = slab
      for (let z = 5; z <= 9; z++) cells[`${x},63,${z}`] = FARM
    }
    const r = await walk(t, new Vec3(0.5, 66, -1.5), new goals.GoalBlock(0, 64, 7), cells, { sprint: false })
    consecutive(r.plan, [0.5, 65.5, 1.5], [0.5, 65, 2.5], [0.5, 64.5, 3.5])
    consecutive(r.plan, [0.5, 64.5, 3.5], [0.5, 64, 4.5], [0.5, bed(63), 5.5])
    assert.ok(r.done)
    assert.strictEqual(r.held, 0)
  })

  for (const [from, fill] of [['the floor', AIR], ['water', WATER]]) {
    test(`a jump up from ${from} onto the path with the bed beyond touches down on the path`, async (t) => {
      const r = await walk(t, new Vec3(0.5, 63, 0.5), new goals.GoalBlock(0, 64, 6), below(fill))
      consecutive(r.plan, [0.5, 63, 2.5], [0.5, 64, 3.5], [0.5, bed(63), 4.5])
      assert.ok(r.done)
      const up = r.touchdowns.find((d) => d.at[1] === 64)
      assert.deepStrictEqual([up.on, Math.floor(up.at[2])], ['stone', 3])
    })
  }

  const inAir = (e) => !e.onGround && e.position.z > 3.2 && e.position.y > 64.05
  const onEdge = (e) => e.onGround && e.position.z > 3 && e.position.y > 64.5
  const replans = [
    ['for a moved goal in the air over the path', inAir, {}],
    ['for a moved goal on the bed\'s edge over the path', onEdge, {}],
    ['for a block update in the air over the path', inAir, { by: 'block' }],
    ['in the air over the path that ends a tick later', inAir, { partial: true }],
    ['for a moved goal in the air over the path to the bed\'s first row', inAir, { row: 4 }]
  ]
  for (const [when, at, how] of replans) {
    for (const sprint of [false, true]) {
      test(`a ${sprint ? 'sprinting' : 'walking'} drop from a bed replanned ${when} touches down on the path`, async (t) => {
        const goal = new goals.GoalBlock(0, 64, how.row ?? 5)
        const cells = bedAbove()
        const replan = replanOnce(goal, cells, at, how)
        const r = await walk(t, new Vec3(0.5, bed(64), 0.5), goal, cells, { sprint, moves: replan.moves })
        assert.ok(replan.seen.fired)
        assert.strictEqual(replan.seen.partial, how.partial ? 1 : 0)
        assert.ok(r.done)
        assert.strictEqual(r.farmFall, 0)
        assert.deepStrictEqual(r.touchdowns.filter((d) => d.fall > 0).map((d) => [d.on, d.at[1], Math.floor(d.at[2])]), [['stone', 64, 3]])
      })
    }
  }

  test('a drop from a bed with stone beyond the path replanned in the air holds no node', async (t) => {
    const goal = new goals.GoalBlock(0, 64, 5)
    const cells = bedAbove(FARM, STONE)
    const replan = replanOnce(goal, cells, inAir)
    const r = await walk(t, new Vec3(0.5, bed(64), 0.5), goal, cells, { moves: replan.moves })
    assert.ok(replan.seen.fired)
    assert.ok(r.done)
    assert.strictEqual(r.held, 0)
    const plain = await walk(t, new Vec3(0.5, bed(64), 0.5), new goals.GoalBlock(0, 64, 5), bedAbove(FARM, STONE))
    assert.strictEqual(r.hash, plain.hash)
  })

  test('a drop from a bed whose bed beyond the path the bot has not seen replanned in the air holds no node', async (t) => {
    const goal = new goals.GoalBlock(0, 64, 5)
    const cells = bedAbove()
    const replan = replanOnce(goal, cells, inAir)
    const moves = (m) => { unseen(m); replan.moves(m) }
    const r = await walk(t, new Vec3(0.5, bed(64), 0.5), goal, cells, { moves })
    assert.ok(replan.seen.fired)
    assert.ok(r.done)
    assert.strictEqual(r.held, 0)
    // A full-cube bed carries the body as stone does.
    const plain = await walk(t, new Vec3(0.5, bed(64), 0.5), new goals.GoalBlock(0, 64, 5), top === 1 ? bedAbove(FARM, STONE) : bedAbove(), { moves: unseen })
    assert.strictEqual(r.hash, plain.hash)
  })

  // On farmland 0.9375 high, the sprint's partial plan steps diagonally onto the bed at a tick budget of 0.0055 to 0.007.
  const partials = [[false, 0, [0, 64, 6], 0.0045], [true, -0.5, [0, 64, 7], top < 1 ? 0.0065 : 0.0045]]
  for (const [sprint, z, goal, tickTimeout] of partials) {
    test(`a ${sprint ? 'sprinting' : 'walking'} drop from a bed whose plan stays partial in the air touches down on the path`, async (t) => {
      const slow = slowPlan(t, tickTimeout)
      const r = await walk(t, new Vec3(0.5, bed(64), z), new goals.GoalBlock(...goal), bedAbove(), { sprint, moves: slow.moves })
      assert.ok(slow.seen.overDrop >= 2, `${slow.seen.overDrop} partial plans over the drop`)
      assert.strictEqual(slow.seen.turned, top < 1)
      assert.ok(r.done)
      assert.strictEqual(r.farmFall, 0)
      assert.deepStrictEqual(r.touchdowns.filter((d) => d.fall > 0).map((d) => [d.on, d.at[1], Math.floor(d.at[2])]), [['stone', 64, 3]])
    })
  }

  test('a walking drop from a bed to the bed\'s first row whose plan stays partial in the air touches down on the path', async (t) => {
    const slow = slowPlan(t, 0.0045)
    const r = await walk(t, new Vec3(0.5, bed(64), 0), new goals.GoalBlock(0, 64, 4), bedAbove(), { sprint: false, moves: slow.moves })
    assert.ok(slow.seen.overDrop >= 2, `${slow.seen.overDrop} partial plans over the drop`)
    assert.ok(r.done)
    assert.strictEqual(r.farmFall, 0)
    assert.deepStrictEqual(r.touchdowns.filter((d) => d.fall > 0).map((d) => [d.on, d.at[1], Math.floor(d.at[2])]), [['stone', 64, 3]])
  })

  test('a drop from a bed with stone beyond the path whose plan stays partial in the air holds no node', async (t) => {
    const slow = slowPlan(t, 0.0045)
    const r = await walk(t, new Vec3(0.5, bed(64), 0), new goals.GoalBlock(0, 64, 6), bedAbove(FARM, STONE), { sprint: false, moves: slow.moves })
    assert.ok(slow.seen.overDrop >= 2, `${slow.seen.overDrop} partial plans over the drop`)
    assert.ok(r.done)
    assert.strictEqual(r.held, 0)
  })

  // On a full-cube bed no partial plan of these walks moves to the next column.
  const switches = [[0.5, 8, 0.0025], [0.4, 9, 0.0018]]
  for (const [x, row, tickTimeout] of switches) {
    test(`a walking drop from a bed at x ${x} whose partial plan moves to the path's next column over the drop touches down on the drop cell`, async (t) => {
      const slow = slowPlan(t, tickTimeout)
      const r = await walk(t, new Vec3(x, bed(64), 0.5), new goals.GoalBlock(0, 64, row), bedAbove(), { sprint: false, moves: slow.moves })
      assert.strictEqual(slow.seen.switched > 0, top < 1, `${slow.seen.switched} plans in the next column`)
      assert.ok(r.done)
      assert.strictEqual(r.farmFall, 0)
      assert.deepStrictEqual(r.touchdowns.filter((d) => d.fall > 0).map((d) => [d.on, d.at[1], Math.floor(d.at[0]), Math.floor(d.at[2])]), [['stone', 64, 0, 3]])
    })
  }

  test('a drop whose landing cell fills with stone under the body on the edge walks on after one stuck reset', async (t) => {
    let clock = 0
    t.mock.method(performance, 'now', () => clock)
    const cells = terrace()
    const resets = []
    let over = 0
    const moves = (m) => {
      const bot = m.bot
      bot.prependListener('physicsTick', () => {
        clock += 50
        const p = bot.entity.position
        if (over > 1 || !bot.entity.onGround || Math.floor(p.z) !== 3) return
        // The second tick on the edge over the drop cell.
        if (++over < 2) return
        const at = new Vec3(0, 64, 3)
        const old = bot.blockAt(at)
        cells['0,64,3'] = STONE
        bot.emit('blockUpdate', old, bot.blockAt(at))
      })
      bot.on('path_reset', (reason) => resets.push(reason))
    }
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 64, 5), cells, { sprint: false, moves })
    assert.strictEqual(over, 2)
    assert.deepStrictEqual(resets, ['block_updated', 'stuck'])
    assert.ok(r.done)
  })

  for (const sprint of [false, true]) {
    test(`a ${sprint ? 'sprinting' : 'walking'} drop whose landing cell fills with a carpet under the body on the edge touches down on no farmland with a fall over 0.5`, async (t) => {
      let clock = 0
      t.mock.method(performance, 'now', () => clock)
      const cells = terrace()
      let over = 0
      const moves = (m) => {
        const bot = m.bot
        bot.prependListener('physicsTick', () => {
          clock += 50
          const p = bot.entity.position
          if (over > 1 || !bot.entity.onGround || Math.floor(p.z) !== 3) return
          // The second tick on the edge over the drop cell.
          if (++over < 2) return
          const at = new Vec3(0, 64, 3)
          const old = bot.blockAt(at)
          cells['0,64,3'] = ['white_carpet', {}]
          bot.emit('blockUpdate', old, bot.blockAt(at))
        })
      }
      const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 64, 5), cells, { sprint, moves })
      assert.strictEqual(over, 2)
      assert.ok(r.done)
      assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
    })
  }

  test('a drop from a bed whose plan in the air comes back empty gets the drop node into the array path_update handed out', async (t) => {
    const goal = new goals.GoalBlock(0, 64, 5)
    const cells = bedAbove()
    const replan = replanOnce(goal, cells, inAir, { partial: true })
    let empty = null
    let kept = null
    const moves = (m) => {
      replan.moves(m)
      m.bot.on('path_update', (r) => { if (r.path.length === 0) empty = r.path })
      m.bot.on('physicsTick', () => { if (empty && !kept) kept = empty.map((n) => [n.x, n.y, n.z]) })
    }
    const r = await walk(t, new Vec3(0.5, bed(64), 0.5), goal, cells, { sprint: false, moves })
    assert.strictEqual(replan.seen.partial, 1)
    assert.deepStrictEqual(kept, [[0.5, 64, 3.5]])
    assert.ok(r.done)
  })

  test('a diagonal walk off the edge whose partial plan ends at the drop node keeps a node off the bed first in the air', async (t) => {
    const slow = slowPlan(t, 0.0015)
    let front = []
    let oneNode = 0
    let onBed = 0
    const moves = (m) => {
      slow.moves(m)
      const bot = m.bot
      bot.on('path_update', (r) => {
        front = r.path
        if (r.status === 'partial' && r.path.length === 1 && Math.floor(r.path[0].z) === 3) oneNode++
        // Continuations expand no node while the body is above y 64.6.
        r.context.tickTimeout = bot.entity.position.y > 64.6 ? 0.0005 : 0.0015
      })
      bot.on('physicsTick', () => {
        const e = bot.entity
        const n = front[0]
        if (e.onGround || e.position.y <= 64 || !n) return
        if (bot.blockAt(new Vec3(Math.floor(n.x), Math.ceil(n.y) - 1, Math.floor(n.z))).name === 'farmland') onBed++
      })
    }
    const r = await walk(t, new Vec3(0.5, 65, 2), new goals.GoalBlock(1, 64, 9), terrace(), { sprint: false, moves })
    assert.ok(oneNode > 0)
    assert.strictEqual(onBed, 0, `${onBed} ticks in the air with a node on the bed first`)
    assert.ok(r.done)
  })

  test('a drop whose goal moves back up the terrace while the body stands on the edge over the drop cell stays up', async (t) => {
    let sent = false
    const moves = (m) => {
      const bot = m.bot
      bot.on('physicsTick', () => {
        const e = bot.entity
        if (sent || !e.onGround || Math.floor(e.position.z) !== 3 || e.position.y <= 64.5) return
        sent = true
        bot.pathfinder.setGoal(new goals.GoalBlock(0, 65, -2))
      })
    }
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 64, 5), terrace(), { sprint: false, moves })
    assert.ok(sent)
    assert.ok(r.done)
    assert.ok(r.sprints.every((s) => s.at[1] > 64.5), 'the body stepped down')
  })

  test('a sprinting drop latched on the edge whose goal moves along the path while the body still drifts back does not sprint before it touches down', async (t) => {
    const goal = new goals.GoalBlock(0, 64, 8)
    let calls = 0
    goal.hasChanged = () => {
      if (++calls !== 2) return false
      goal.x = 1
      return true
    }
    let moved = null
    const moves = (m) => {
      // The body starts drifting back from the drop.
      m.bot.entity.velocity.z = -0.12
      m.bot.on('path_update', (r) => { if (calls >= 2 && !moved) moved = r.path.slice(0, 2).map((n) => [Math.floor(n.x), n.y, Math.floor(n.z)]) })
    }
    const r = await walk(t, new Vec3(0.5, 65, 3.25), goal, terrace(), { moves })
    assert.deepStrictEqual(moved, [[0, 64, 3], [1, 64, 3]])
    assert.ok(r.done)
    const down = r.touchdowns.find((d) => d.fall > 0)
    assert.deepStrictEqual([down.on, down.at[1], Math.floor(down.at[0]), Math.floor(down.at[2])], ['stone', 64, 0, 3])
    assert.ok(r.sprints.slice(0, down.tick).every((s) => !s.sprinting), 'a sprint tick before the touchdown')
  })

  test('a drop from a bed whose goal moves on the second tick on the bed\'s edge over the path keeps one node per cell', async (t) => {
    const goal = new goals.GoalBlock(0, 64, 5)
    const cells = bedAbove()
    let edge = 0
    const replan = replanOnce(goal, cells, (e) => onEdge(e) && ++edge === 2)
    const cell = (n) => [Math.floor(n.x), Math.ceil(n.y), Math.floor(n.z)].join()
    let front = []
    let twice = null
    const moves = (m) => {
      replan.moves(m)
      m.bot.on('path_update', (r) => { front = r.path })
      m.bot.on('physicsTick', () => {
        const i = front.findIndex((n, k) => k > 0 && cell(n) === cell(front[k - 1]))
        if (i > 0 && !twice) twice = front.map(cell)
      })
    }
    const r = await walk(t, new Vec3(0.5, bed(64), 0.5), goal, cells, { sprint: false, moves })
    assert.ok(replan.seen.fired)
    assert.strictEqual(twice, null, `two nodes of one cell in a row: ${JSON.stringify(twice)}`)
    assert.ok(r.done)
    assert.strictEqual(r.farmFall, 0)
    assert.deepStrictEqual(r.touchdowns.filter((d) => d.fall > 0).map((d) => [d.on, d.at[1], Math.floor(d.at[2])]), [['stone', 64, 3]])
  })

  // On a full-cube bed no plan of this walk finishes.
  test('a walking drop from a bed whose plan finishes in the air over the drop cell touches down once, on the drop cell', async (t) => {
    const slow = slowPlan(t, 0.0045)
    let finished = null
    const moves = (m) => {
      slow.moves(m)
      const bot = m.bot
      bot.on('path_update', (r) => {
        const p = bot.entity.position
        if (r.status === 'success' && !finished) finished = [bot.entity.onGround, Math.floor(p.z), p.y > 64.5]
      })
    }
    const r = await walk(t, new Vec3(0.5, bed(64), 1.5), new goals.GoalBlock(0, 64, 9), bedAbove(), { sprint: false, moves })
    assert.deepStrictEqual(finished, top < 1 ? [false, 3, true] : null)
    assert.ok(r.done)
    assert.strictEqual(r.farmFall, 0)
    assert.deepStrictEqual(r.touchdowns.filter((d) => d.fall > 0).map((d) => [d.on, d.at[1], Math.floor(d.at[0]), Math.floor(d.at[2])]), [['stone', 64, 0, 3]])
  })

  const entering = (e) => e.onGround && Math.floor(e.position.z) === 3 && e.position.y > 64.5
  for (const by of ['goal', 'block']) {
    test(`a walking drop replanned for a ${by === 'goal' ? 'moved goal' : 'block update'} as the body's centre crosses over the drop cell touches down on the drop cell`, async (t) => {
      const goal = new goals.GoalBlock(1, 64, 8)
      const cells = terrace()
      const replan = replanOnce(goal, cells, entering, { by })
      let sideways = null
      const moves = (m) => {
        replan.moves(m)
        m.bot.on('path_update', (r) => { if (replan.seen.fired && !sideways) sideways = r.path.find((n) => Math.floor(n.x) !== 0) })
      }
      const r = await walk(t, new Vec3(0.5, 65, 0.5), goal, cells, { sprint: false, moves })
      assert.ok(replan.seen.fired)
      assert.deepStrictEqual([Math.floor(sideways.x), sideways.y, Math.floor(sideways.z)], [1, 64, 3])
      assert.ok(r.done)
      assert.strictEqual(r.farmFall, 0)
      assert.deepStrictEqual(r.touchdowns.filter((d) => d.fall > 0).map((d) => [d.on, d.at[1], Math.floor(d.at[0]), Math.floor(d.at[2])]), [['stone', 64, 0, 3]])
    })
  }

  test('a drop replanned for a block update as the body\'s centre crosses over the drop cell whose goal then moves back up the terrace stays up', async (t) => {
    const cells = terrace()
    let sent = false
    const resets = []
    const moves = (m) => {
      const bot = m.bot
      bot.on('path_reset', (reason) => resets.push(reason))
      bot.prependListener('physicsTick', () => {
        if (sent || !entering(bot.entity)) return
        sent = true
        const at = new Vec3(1, 64, 3)
        const old = bot.blockAt(at)
        cells['1,64,3'] = ['torch', {}]
        bot.emit('blockUpdate', old, bot.blockAt(at))
        bot.pathfinder.setGoal(new goals.GoalBlock(0, 65, -2))
      })
    }
    const r = await walk(t, new Vec3(0.5, 65, 0.5), new goals.GoalBlock(0, 64, 5), cells, { sprint: false, moves })
    assert.ok(sent)
    assert.strictEqual(resets[0], 'block_updated')
    assert.ok(r.done)
    assert.ok(r.sprints.every((s) => s.at[1] > 64.5), 'the body stepped down')
  })

  for (const sprint of [false, true]) {
    test(`a ${sprint ? 'sprinting' : 'walking'} drop from a bed block onto the path touches down on the path before it steps onto the bed`, async (t) => {
      const r = await walk(t, new Vec3(0.5, 64.5625, 1.5), new goals.GoalBlock(0, 64, 5), bedAbove(BED_BLOCK), { sprint })
      consecutive(r.plan, [0.5, 64.5625, 2.275], [0.5, 64, 3.5], [0.5, bed(63), 4.5])
      assert.ok(r.done)
      assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
    })
  }

  const nodeCell = (n) => [Math.floor(n.x), n.y, Math.floor(n.z)]

  for (const [where, to] of [['back up the terrace', [0, 65, -2]], ['along the path', [4, 64, 3]]]) {
    test(`a walking drop whose goal moves ${where} while the body is in the air over the drop cell touches down on the drop cell`, async (t) => {
      let front = []
      let sent = null
      let kept = null
      const moves = (m) => {
        const bot = m.bot
        bot.on('path_update', (r) => { front = r.path })
        bot.on('physicsTick', () => {
          const e = bot.entity
          if (sent && !kept) kept = nodeCell(front[0])
          if (sent || e.onGround || Math.floor(e.position.z) !== 3 || e.position.y <= 64) return
          sent = front.slice(0, 2).map(nodeCell)
          bot.pathfinder.setGoal(new goals.GoalBlock(...to))
        })
      }
      const r = await walk(t, new Vec3(0.8, 65, 0.5), new goals.GoalBlock(0, 64, 5), terrace(), { sprint: false, moves })
      assert.deepStrictEqual(sent, [[0, 64, 3], [0, bed(63), 4]])
      assert.ok(r.done)
      assert.strictEqual(r.farmFall, 0)
      const down = r.touchdowns.find((d) => d.fall > 0)
      assert.deepStrictEqual([down.on, down.at[1], Math.floor(down.at[0]), Math.floor(down.at[2])], ['stone', 64, 0, 3])
      assert.deepStrictEqual(kept, [0, 64, 3])
    })
  }

  test('a walking drop past a ledge one deep whose path resets as the body first comes over the drop cell in the air, and whose goal then moves along the path, touches down on the drop cell', async (t) => {
    const cells = terrace()
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 1; z++) cells[`${x},65,${z}`] = STONE
    const resets = []
    let front = []
    let from = null
    let sent = null
    const moves = (m) => {
      const bot = m.bot
      bot.on('path_update', (r) => { front = r.path })
      bot.on('path_reset', (reason) => resets.push(reason))
      bot.prependListener('physicsTick', () => {
        const e = bot.entity
        const p = e.position
        if (sent || e.onGround || Math.floor(p.z) !== 3 || p.y <= 64.5 || !front[0] || Math.floor(front[0].z) !== 3) {
          if (!sent) from = Math.floor(p.z)
          return
        }
        sent = [from, front.slice(0, 2).map(nodeCell)]
        const at = new Vec3(1, 64, 3)
        const old = bot.blockAt(at)
        cells['1,64,3'] = ['torch', {}]
        bot.emit('blockUpdate', old, bot.blockAt(at))
        bot.pathfinder.setGoal(new goals.GoalBlock(4, 64, 3))
      })
    }
    const r = await walk(t, new Vec3(0.5, 66, -1.5), new goals.GoalBlock(0, 64, 5), cells, { sprint: false, moves })
    assert.deepStrictEqual(sent, [2, [[0, 64, 3], [0, bed(63), 4]]])
    assert.strictEqual(resets[0], 'block_updated')
    assert.ok(r.done)
    assert.strictEqual(r.farmFall, 0)
    const down = r.touchdowns.find((d) => d.at[1] === 64)
    assert.deepStrictEqual([down.on, Math.floor(down.at[0]), Math.floor(down.at[2])], ['stone', 0, 3])
  })

  test('a walking drop latched on the edge whose body a position correction puts on the upper level one column over walks on by its own plan', async (t) => {
    const goal = new goals.GoalBlock(1, 64, 8)
    let front = []
    let latched = null
    let replan = 0
    let own = null
    let next = null
    const changed = goal.hasChanged.bind(goal)
    goal.hasChanged = () => {
      if (replan !== 1) return changed()
      replan = 2
      return true
    }
    const moves = (m) => {
      const bot = m.bot
      bot.on('path_update', (r) => {
        front = r.path
        if (replan === 2 && !own) own = r.path.slice(0, 3).map(nodeCell)
      })
      bot.on('physicsTick', () => {
        const e = bot.entity
        const p = e.position
        if (own && !next) next = front.slice(0, 3).map(nodeCell)
        if (latched && replan === 0 && e.onGround) replan = 1
        if (latched || !e.onGround || Math.floor(p.z) !== 3 || p.y <= 64.5) return
        latched = front.slice(0, 2).map(nodeCell)
        // As mineflayer applies a server position: velocity 0 and onGround false.
        p.set(1.5, 65, 2.5)
        e.velocity.set(0, 0, 0)
        e.onGround = false
        bot.emit('forcedMove')
      })
    }
    const r = await walk(t, new Vec3(0.5, 65, 0.5), goal, terrace(), { sprint: false, moves })
    assert.deepStrictEqual(latched, [[0, 64, 3], [0, bed(63), 4]])
    assert.deepStrictEqual(own.slice(0, 2), [[1, 64, 3], [1, bed(63), 4]])
    assert.deepStrictEqual(next, own, 'the latched node in front of the plan made after the correction')
    assert.ok(r.done)
    assert.strictEqual(r.farmFall, 0)
    const down = r.touchdowns.find((d) => d.at[1] === 64)
    assert.deepStrictEqual([down.on, Math.floor(down.at[0]), Math.floor(down.at[2])], ['stone', 1, 3])
  })

  // On a full-cube bed this walk's plans put the bed after the drop node before the body reaches the edge.
  test('a sprinting drop from a bed whose continuation on the edge turns from along the path onto the bed touches down on the drop cell', async (t) => {
    const slow = slowPlan(t, 0.0015)
    let updates = 0
    const edge = []
    const moves = (m) => {
      slow.moves(m)
      const bot = m.bot
      bot.on('path_update', (r) => {
        // Every continuation expands one node, the ninth two.
        r.context.tickTimeout = ++updates === 9 ? 0.0035 : 0.0015
        const e = bot.entity
        const p = e.position
        if (e.onGround && p.y > 64.5 && Math.abs(p.x + 0.5) <= 0.35 && Math.abs(p.z - 3.5) <= 0.35) edge.push(r.path.slice(0, 2).map(nodeCell))
      })
    }
    const r = await walk(t, new Vec3(-1.5, bed(64), 0.5), new goals.GoalBlock(2, 64, 7), bedAbove(), { moves })
    assert.ok(r.done)
    assert.strictEqual(r.farmFall, 0)
    const down = r.touchdowns.find((d) => d.fall > 0)
    assert.deepStrictEqual([down.on, down.at[1], Math.floor(down.at[0]), Math.floor(down.at[2])], ['stone', 64, -1, 3])
    assert.deepStrictEqual(edge[0], [[-1, 64, 3], top < 1 ? [-1, bed(63), 4] : [0, 64, 4]])
  })

  const oneDeep = [
    ['past a ledge one deep', 66, -1.5, [[65, 1]]],
    ['past a ledge one deep', 66, 0.5, [[65, 1]]],
    ['down three steps one deep', 67, 0.5, [[65, 1], [66, 0]]]
  ]
  for (const [what, y, z, levels] of oneDeep) {
    test(`a sprinting descent ${what} from z ${z} touches down on the path before it steps onto the bed`, async (t) => {
      const r = await walk(t, new Vec3(0.5, y, z), new goals.GoalBlock(0, 64, 5), ledges(FARM, ...levels))
      assert.ok(r.done)
      assert.strictEqual(r.farmFall, 0)
      const down = r.touchdowns.find((d) => d.at[1] < 64.5)
      assert.deepStrictEqual([down.on, down.at[1], Math.floor(down.at[0]), Math.floor(down.at[2])], ['stone', 64, 0, 3])
    })
  }

  test('walking descents past a ledge and down three steps one deep keep their traces', async (t) => {
    const hashes = []
    for (const [, y, z, levels] of oneDeep) hashes.push((await walk(t, new Vec3(0.5, y, z), new goals.GoalBlock(0, 64, 5), ledges(FARM, ...levels), { sprint: false })).hash)
    assert.deepStrictEqual(hashes, top < 1
      ? ['abdb6f4b5f6562d6', 'd729c5bc0e1cd0d2', '81b847afb3a5083f']
      : ['f95541b831f51977', '9546a24fbeea861c', '9bfd375d70d8035a'])
  })

  test('a sprinting descent past a ledge two deep still sprints off the top level\'s edge', async (t) => {
    const r = await walk(t, new Vec3(0.5, 66, -1.5), new goals.GoalBlock(0, 64, 5), ledges(FARM, [65, 0]))
    assert.ok(r.done)
    assert.ok(sprintsOffEdge(r, 66))
  })

  test('a sprinting descent down three steps one deep with stone in place of the bed still sprints off the top level\'s edge', async (t) => {
    const r = await walk(t, new Vec3(0.5, 67, 0.5), new goals.GoalBlock(0, 64, 5), ledges(STONE, [65, 1], [66, 0]))
    assert.ok(r.done)
    assert.ok(sprintsOffEdge(r, 67))
  })

  for (const [drop, cellsOf, sprint] of [[1, terrace, false], [2, high, false], [1, terrace, true]]) {
    test(`a ${sprint ? 'sprinting' : 'walking'} drop of ${drop} following a player who walks back up the terrace while the body stands on the edge over the drop cell stays up`, async (t) => {
      const upper = 64 + drop
      const player = { position: new Vec3(0.5, 64, 5.5) }
      let moved = false
      const moves = (m) => {
        const bot = m.bot
        bot.prependListener('physicsTick', () => {
          const e = bot.entity
          if (moved || !e.onGround || Math.floor(e.position.z) !== 3 || e.position.y < upper - 0.5) return
          moved = true
          player.position = new Vec3(0.5, upper, -1.5)
        })
      }
      const r = await walk(t, new Vec3(0.5, upper, 0.5), new goals.GoalFollow(player, 1), cellsOf(), { sprint, moves })
      assert.ok(moved)
      assert.ok(r.sprints.every((s) => s.at[1] > upper - 0.5), 'the body stepped down')
      assert.ok(r.done)
    })
  }

  test('a drop whose goal moves to the side on the upper level while the body stands on the edge over the drop cell stays up', async (t) => {
    const goal = new goals.GoalBlock(0, 64, 5)
    let bot = null
    let moved = false
    const changed = goal.hasChanged.bind(goal)
    goal.hasChanged = () => {
      const e = bot.entity
      if (moved || !e.onGround || Math.floor(e.position.z) !== 3 || e.position.y <= 64.5) return changed()
      moved = true
      Object.assign(goal, { x: -3, y: 65, z: 1 })
      return true
    }
    const r = await walk(t, new Vec3(0.5, 65, 0.5), goal, terrace(), { sprint: false, moves: (m) => { bot = m.bot } })
    assert.ok(moved)
    assert.ok(r.sprints.every((s) => s.at[1] > 64.5), 'the body stepped down')
    assert.ok(r.done)
  })

  for (const [drop, cellsOf, sprint, partial] of [[1, terrace, false, false], [1, terrace, true, false], [2, high, false, false], [2, high, true, true]]) {
    test(`a ${sprint ? 'sprinting' : 'walking'} drop of ${drop} whose plan comes back empty ${partial ? 'and partial' : 'for a goal out of reach'} while the body stands on the edge over the drop cell touches down on the drop cell`, async (t) => {
      const upper = 64 + drop
      const goal = new goals.GoalBlock(0, 64, 5)
      let bot = null
      let fired = false
      let empty = 0
      const changed = goal.hasChanged.bind(goal)
      goal.hasChanged = () => {
        const e = bot.entity
        if (fired || !e.onGround || Math.floor(e.position.z) !== 3 || e.position.y <= upper - 0.5) return changed()
        fired = true
        if (partial) {
          bot.pathfinder.tickTimeout = -1
        } else {
          Object.assign(goal, { y: upper + 20, z: 3 })
          bot.pathfinder.thinkTimeout = -1
        }
        return true
      }
      const moves = (m) => {
        bot = m.bot
        bot.on('path_update', (r) => {
          if (!fired || r.path.length > 0) return
          if (++empty === 8 && partial) r.context.tickTimeout = bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
        })
      }
      const r = await walk(t, new Vec3(0.5, upper, 0.5), goal, cellsOf(), { sprint, moves })
      assert.ok(empty >= (partial ? 8 : 1), `${empty} empty plans`)
      assert.ok(r.farmFall <= 0.5, `fall ${r.farmFall} onto farmland`)
      const down = r.touchdowns.find((d) => d.fall > 0)
      assert.deepStrictEqual([down.on, down.at[1], Math.floor(down.at[0]), Math.floor(down.at[2])], ['stone', 64, 0, 3])
    })
  }
}

const BED_BLOCK = ['red_bed', { facing: 'south', part: 'foot', occupied: false }]

// partial: the replan's first compute ends partial with an empty path.
function replanOnce (goal, cells, when, { by = 'goal', partial = false } = {}) {
  const seen = { fired: false, partial: 0 }
  let bot = null
  const fire = () => {
    if (seen.fired || !bot || !when(bot.entity)) return false
    seen.fired = true
    if (partial) bot.pathfinder.tickTimeout = -1
    return true
  }
  if (by === 'goal') {
    const changed = goal.hasChanged.bind(goal)
    goal.hasChanged = () => fire() || changed()
  }
  const moves = (m) => {
    bot = m.bot
    if (by === 'block') {
      bot.prependListener('physicsTick', () => {
        if (!fire()) return
        const at = new Vec3(1, 64, 3)
        const old = bot.blockAt(at)
        cells['1,64,3'] = ['torch', {}]
        bot.emit('blockUpdate', old, bot.blockAt(at))
      })
    }
    bot.on('path_update', (r) => {
      if (r.status !== 'partial') return
      seen.partial++
      r.context.tickTimeout = bot.pathfinder.tickTimeout = bot.pathfinder.thinkTimeout
    })
  }
  return { moves, seen }
}

// tickTimeout is measured on the mock clock below, 0.001 ms per read.
function slowPlan (t, tickTimeout) {
  let clock = 0
  t.mock.method(performance, 'now', () => (clock += 0.001))
  // overDrop: partial plans made while the body is in the air over the drop cell. turned: one of those plans steps diagonally onto the bed.
  // switched: plans made there whose first node is in the drop row but another column.
  const seen = { overDrop: 0, turned: false, switched: 0 }
  const moves = (m) => {
    const bot = m.bot
    bot.prependOnceListener('physicsTick', () => { bot.pathfinder.tickTimeout = tickTimeout })
    bot.on('path_update', (r) => {
      const p = bot.entity.position
      if (bot.entity.onGround || Math.floor(p.z) !== 3 || p.y <= 64) return
      if (r.path.length && Math.floor(r.path[0].z) === 3 && Math.floor(r.path[0].x) !== Math.floor(p.x)) seen.switched++
      if (r.status !== 'partial') return
      seen.overDrop++
      if (r.path.slice(0, 2).some((n) => Math.floor(n.z) === 4 && Math.floor(n.x) !== Math.floor(p.x))) seen.turned = true
    })
  }
  return { moves, seen }
}

module.exports = { dropLandCases, walk, field, bedAbove, terrace, STONE, FARM }
