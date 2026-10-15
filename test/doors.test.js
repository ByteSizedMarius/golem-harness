'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { isDoor, doorStep, panelAcross, doorCrossing } = require('../lib/doors')
const { loadBotFunctions } = require('./helpers')

const AIR = { name: 'air', boundingBox: 'empty', shapes: [], light: 15, skyLight: 15 }
const STONE = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
const ck = (x, y, z) => x + ',' + y + ',' + z

const door = (name, half, open = false) => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 0.1875]], getProperties: () => ({ half, open }) })

// Flat stone up to y 63, plus the blocks in extra ('x,y,z' -> block), each with its position.
function world (extra = {}) {
  return (p) => ({ ...(extra[ck(p.x, p.y, p.z)] || (p.y <= 63 ? STONE : AIR)), position: new Vec3(p.x, p.y, p.z) })
}

test('a door the body opened closes once it went through and stands clear, never while it walks back, and is far out of reach', () => {
  const now = 10000
  const opened = (over) => ({ pos: new Vec3(2, 64, 0), t: now, ...over })
  const step = (door, x, t = now) => doorStep(door, new Vec3(x, 64, 0.5), t)
  const walked = opened()
  assert.deepStrictEqual([step(walked, 2.5), walked.through], ['wait', true], 'in the door cell')
  assert.strictEqual(step(walked, 3.9), 'wait', '1.4 past it')
  assert.strictEqual(step(walked, 4.2), 'close')
  assert.strictEqual(step(walked, 3.8), 'wait', 'walking back toward it')
  assert.strictEqual(step(opened(), 0.5, now + 1000), 'wait', 'opened from 1.5 off, not yet through')
  assert.strictEqual(step(opened(), 0.5, now + 4000), 'close', 'never used')
  assert.strictEqual(step(opened({ through: true }), 7), 'far')
})

// closeDoorsBehind of bot.js over an open oak door at 2,64,0 the body opened.
function mannersBot () {
  const activated = []
  const events = []
  const env = {
    bot: {
      entity: { position: new Vec3(1.5, 64, 0.5) },
      blockAt: world({ '2,64,0': door('oak_door', 'lower', true) }),
      activateBlock: async (b) => { activated.push(b.position) }
    },
    PENDING_DOORS: [{ key: '(2, 64, 0)', pos: new Vec3(2, 64, 0), t: Date.now(), warned: false }],
    isManneredDoor: (b) => b && /(_door|_fence_gate)$/.test(b.name) && b.name !== 'iron_door',
    emitEvent: (kind, msg) => events.push(kind),
    doorStep
  }
  return { env, activated, events, ...loadBotFunctions(['closeDoorsBehind'], env) }
}

test('a walk closes the door behind it once through, even at a sprint, and once per second at most', () => {
  const { env, activated, closeDoorsBehind } = mannersBot()
  // One physics tick apart at a sprint jump's 0.35 blocks per tick.
  for (let x = 1.5; x < 6; x += 0.35) {
    env.bot.entity.position = new Vec3(x, 64, 0.5)
    closeDoorsBehind()
  }
  assert.deepStrictEqual(activated.map((p) => [p.x, p.y, p.z]), [[2, 64, 0]])
})

test('a door left out of reach is reported once', () => {
  const { env, activated, events, closeDoorsBehind } = mannersBot()
  env.PENDING_DOORS[0].through = true
  env.bot.entity.position = new Vec3(9.5, 64, 0.5)
  closeDoorsBehind()
  closeDoorsBehind()
  assert.deepStrictEqual([activated.length, events], [0, ['manners']])
})

// A body at 0,64,0 with a door in sight 3 east and one 6 south behind a stone wall at z 3.
function doorScene (wall = true) {
  const extra = {
    '3,64,0': door('oak_door', 'lower'),
    '3,65,0': door('oak_door', 'upper'),
    '0,64,6': door('spruce_door', 'lower', true),
    '0,65,6': door('spruce_door', 'upper', true)
  }
  if (wall) for (let x = -6; x <= 6; x++) for (let y = 64; y <= 72; y++) extra[ck(x, y, 3)] = STONE
  const blockAt = world(extra)
  return {
    bot: {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      blockAt,
      findBlocks: () => ['3,64,0', '3,65,0', '0,64,6', '0,65,6'].map((k) => new Vec3(...k.split(',').map(Number))),
      time: { timeOfDay: 6000 }
    },
    mcData: { blocksByName: { oak_door: { id: 1, name: 'oak_door' }, spruce_door: { id: 2, name: 'spruce_door' }, stone: { id: 3, name: 'stone' } } },
    isDoor,
    ck,
    Vec3,
    STALE_LIGHT: new Set(),
    OPENED_LIGHT: new Map()
  }
}

test('scene lists each door in sight once, and none behind a wall', () => {
  const listed = (wall) => JSON.parse(JSON.stringify(loadBotFunctions(['doorsInSight'], doorScene(wall)).doorsInSight()))
  assert.deepStrictEqual(listed(false).map((d) => d.name), ['oak_door', 'spruce_door'], 'control: no wall')
  assert.deepStrictEqual(listed(true), [{ name: 'oak_door', dir: 'E', dist: 3, open: false }])
})

test('a failed walk names the door beside it by its lower half, never one the bot does not know', () => {
  const env = doorScene()
  env.bot.blockAt = world({ '2,65,0': door('oak_door', 'upper'), '2,64,0': door('oak_door', 'lower'), '-1,64,1': door('iron_door', 'lower') })
  env.cellKnown = (p) => !(p.x === -1 && p.z === 1)
  const { doorBeside } = loadBotFunctions(['doorBeside'], env)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(doorBeside())), { name: 'oak_door', x: 2, y: 64, z: 0, open: false })
  env.cellKnown = () => true
  assert.deepStrictEqual(JSON.parse(JSON.stringify(doorBeside())), { name: 'iron_door', x: -1, y: 64, z: 1, open: false }, 'control: the nearer iron door once known')
})

test('the doorway drill picks no door the bot cannot see', async () => {
  for (const seen of [true, false]) {
    const env = doorScene()
    env.bot.entity.position = new Vec3(0.5, 64, 6.5)
    env.bot.findBlocks = () => [new Vec3(2, 64, 6)]
    env.bot.blockAt = world({ '2,64,6': door('oak_door', 'lower'), '2,65,6': door('oak_door', 'upper') })
    let walks = 0
    Object.assign(env, {
      cellKnown: () => seen,
      routeEnd: () => null,
      walkOnce: async () => { walks++; return 'changed' },
      goals: require('mineflayer-pathfinder').goals,
      panelAcross,
      doorCrossing,
      console: { log () {} }
    })
    const { doorwayCommit } = loadBotFunctions(['doorwayCommit'], env)
    assert.strictEqual(await doorwayCommit({}), null)
    assert.strictEqual(walks, seen ? 1 : 0, seen ? 'control: a door in sight' : 'a hidden door')
  }
})

const FACINGS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

test('a door in a wall passes along its facing axis whatever its hinge and open state, entered from the side the feet stand on', () => {
  for (const [facing, [fx, fz]] of Object.entries(FACINGS)) {
    const axis = fx ? 'x' : 'z'
    // The wall runs across the facing axis.
    const walkable = (dx, dz) => (fx ? dz === 0 : dx === 0)
    for (const hinge of ['left', 'right']) {
      for (const open of [false, true]) {
        const props = { facing, half: 'lower', hinge, open }
        const at = `${facing} ${hinge} ${open ? 'open' : 'closed'}`
        for (const s of [1, -1]) {
          const feet = { x: 10.5 + s * Math.abs(fx) * 1.4, z: 20.5 + s * Math.abs(fz) * 1.4 }
          assert.deepStrictEqual(doorCrossing(props, { x: 10, z: 20 }, feet, walkable), { axis, side: fx ? [s, 0] : [0, s] }, `${at}, feet on the ${s} side`)
        }
        assert.strictEqual(panelAcross('oak_door', props, axis), !open, at)
      }
    }
  }
})

test('a door set sideways into a wall passes across its facing, walkable closed and a wall open', () => {
  // A door facing south in a wall running north to south.
  const walkable = (dx, dz) => dz === 0
  const feet = { x: 9.2, z: 20.9 }
  for (const hinge of ['left', 'right']) {
    const props = { facing: 'south', half: 'lower', hinge, open: false }
    assert.deepStrictEqual(doorCrossing(props, { x: 10, z: 20 }, feet, walkable), { axis: 'x', side: [-1, 0] })
    assert.strictEqual(panelAcross('oak_door', props, 'x'), false, `${hinge} closed`)
    assert.strictEqual(panelAcross('oak_door', { ...props, open: true }, 'x'), true, `${hinge} open`)
  }
})

test('a gate stands across the way only while closed', () => {
  for (const axis of ['x', 'z']) {
    assert.strictEqual(panelAcross('oak_fence_gate', { facing: 'north', open: false }, axis), true)
    assert.strictEqual(panelAcross('oak_fence_gate', { facing: 'north', open: true }, axis), false)
  }
})

const COBBLE = { name: 'cobblestone_wall', boundingBox: 'block', shapes: [[0.25, 0, 0.25, 0.75, 1.5, 0.75]] }

// The farm door at -308,63,81 on the live server, set into a cobblestone wall running north to south.
function farmDoor (feet, state = { facing: 'west', hinge: 'left', open: true }) {
  const lower = { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ ...state, half: 'lower' }) }
  const upper = { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ ...state, half: 'upper' }) }
  const extra = { '-308,63,81': lower, '-308,64,81': upper }
  for (const z of [78, 79, 80, 82, 83, 84]) for (const y of [63, 64]) extra[ck(-308, y, z)] = COBBLE
  const lines = []
  const walks = []
  const nudges = []
  const activated = []
  const bot = {
    entity: { position: feet },
    blockAt: (p) => ({ ...(extra[ck(p.x, p.y, p.z)] || (p.y <= 62 ? STONE : AIR)), position: new Vec3(p.x, p.y, p.z) }),
    findBlocks: () => [new Vec3(-308, 63, 81), new Vec3(-308, 64, 81)],
    activateBlock: async (b) => { activated.push(b.position.toString()); state.open = !state.open },
    waitForTicks: async () => {},
    pathfinder: { goal: null }
  }
  const env = {
    bot,
    mcData: { blocksByName: { oak_door: { id: 1, name: 'oak_door' } } },
    cellKnown: () => true,
    routeEnd: () => null,
    walkOnce: async (g) => { walks.push([g.x, g.y, g.z]); bot.entity.position = new Vec3(g.x + 0.5, g.y, g.z + 0.5); return 'done' },
    nudgeInto: async (cell) => { nudges.push([cell.x, cell.y, cell.z]); return false },
    stopPath () {},
    goals: require('mineflayer-pathfinder').goals,
    isDoor,
    panelAcross,
    doorCrossing,
    console: { log: (line) => lines.push(line) }
  }
  return { env, lines, walks, nudges, activated, ...loadBotFunctions(['doorwayCommit'], env) }
}

test('the drill crosses the live farm door along x from the side the bot stands on, never into the wall', async () => {
  for (const [feet, near, far] of [
    [new Vec3(-307.5, 63, 79.5), [-309, 63, 81], '(-307, 63, 81)'],
    [new Vec3(-305.5, 63, 79.5), [-307, 63, 81], '(-309, 63, 81)']
  ]) {
    const { lines, walks, doorwayCommit } = farmDoor(feet)
    await doorwayCommit({})
    assert.deepStrictEqual(walks[0], near, `feet at ${feet}`)
    assert.ok(lines[0].includes(`facing=west half=lower hinge=left open=true axis=x near=(${near.join(', ')}) far=${far}`), lines[0])
  }
})

test('a door that will not let the body through ends the drill after two tries, toggled on the retry, with why', async () => {
  const { nudges, activated, doorwayCommit } = farmDoor(new Vec3(-308.5, 63, 81.5))
  const out = JSON.parse(JSON.stringify(await doorwayCommit({})))
  assert.deepStrictEqual(out, { door: { name: 'oak_door', x: -308, y: 63, z: 81 }, through: false, why: 'did not let me through from the west after 2 tries' })
  assert.deepStrictEqual(nudges, [[-308, 63, 81], [-308, 63, 81]])
  // The retry closes the open door, finds the panel across and opens it again.
  assert.deepStrictEqual(activated, ['(-308, 63, 81)', '(-308, 63, 81)'])
})

test('a closed door is opened from the near side before the body walks in', async () => {
  const { env, nudges, activated, doorwayCommit } = farmDoor(new Vec3(-306.5, 63, 81.5), { facing: 'west', hinge: 'left', open: false })
  env.nudgeInto = async (cell) => { nudges.push([cell.x, activated.length]); return true }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await doorwayCommit({}))), { door: { name: 'oak_door', x: -308, y: 63, z: 81 }, through: true })
  assert.deepStrictEqual(nudges, [[-308, 1], [-309, 1]])
})
