'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { mcpServer, call, textOf, tickReply } = require('./helpers')
const { mcData, Block, STEP, received, scene, twice, BESIDE, unseenBeside, around, hearing, asReceived, pool } = require('./point-scene')

const LOG = 'Steve at 10 64 0 points E, level, at oak_log 20 65 0'
const NEAR_LOG = 'Steve at 10 64 0 points E, level, near oak_log 20 65 0'
const cow = (x = 13.3) => ({ id: 9, type: 'animal', name: 'cow', position: new Vec3(x, 64, 0.4), width: 0.9, height: 1.4 })
const mob = (name, at) => ({ id: 11, type: 'hostile', name, position: at, width: 0.6, height: 1.95 })
const zombie7 = () => mob('zombie', new Vec3(10.3, 64, 7.4))
const villager = (z) => ({ id: 9, type: 'passive', name: 'villager', position: new Vec3(15.3, 64, z), width: 0.6, height: 1.95 })
// Sets Steve's received head angles to due east, tilted up by the given number of bytes.
const east = (s, up) => {
  s.steve.headYaw = -64 * STEP
  s.steve.yaw = s.steve.headYaw + 1
  s.steve.pitch = up * STEP
}
// Cell 13 65 0, three blocks out on Steve's look at the log.
const notCell13 = (p) => !(p.x === 13 && p.y === 65 && p.z === 0)
// The knockback carries the cow dx further out before the decision, moving its position in place as mineflayer does.
const punch = (dx) => (s) => {
  const target = s.bot.entities[9]
  s.look(target.position.offset(0, 1, 0))
  s.swing()
  s.bot.emit('entityHurt', target)
  target.position.translate(dx, 0.4, 0)
}

// Runs each case's act in a fresh scene and checks the points it gave.
function outcomes (t, table) {
  const got = {}
  const want = {}
  for (const [name, { opts, act, want: points = [] }] of Object.entries(table)) {
    const s = scene(t, opts)
    act(s)
    s.settle()
    got[name] = s.points()
    want[name] = points
  }
  assert.deepStrictEqual(got, want)
}

// Runs each case's act, by default one punch, then punches again 300 ms later, and checks the points it gave.
function cases (t, table) {
  outcomes(t, Object.fromEntries(Object.entries(table).map(([name, { act = (s) => s.swing(), ...rest }]) =>
    [name, { ...rest, act: (s) => { act(s); s.wait(300); s.swing() } }])))
}

// A punch, then a head turn of up angle bytes up and left bytes left and a second punch ms later.
const again = (ms, up, left = 0) => (s) => {
  s.swing()
  s.wait(ms)
  s.steve.pitch += up * STEP
  s.steve.headYaw += left * STEP
  s.bot.emit('entityMoved', s.steve)
  s.swing()
}

test('a still player punching twice toward a far block the bot sees points at it, and wait_events names the player, bearing, block and cell', async (t) => {
  const s = scene(t)
  twice(s)
  s.settle()
  const events = s.events()
  assert.deepStrictEqual(events.map((e) => e.msg), [LOG])
  t.mock.timers.reset()
  const { srv } = mcpServer({ reply: tickReply([], events) })
  const { items } = JSON.parse(textOf(await call(srv, 'wait_events', { timeout: 1 })))
  assert.deepStrictEqual(items, [{ type: 'event', kind: 'point', msg: LOG }])
})

test('a punch at the sky or at a block the bot cannot see gives the bearing and tilt without a cell, and a steep one no bearing', (t) => {
  const sky = scene(t)
  sky.look(new Vec3(10.3, 75.62, -9.6))
  twice(sky)
  sky.settle()
  assert.deepStrictEqual(sky.points(), ['Steve at 10 64 0 points N, up'])

  const hidden = scene(t, { sees: () => false })
  twice(hidden)
  hidden.settle()
  assert.deepStrictEqual(hidden.points(), ['Steve at 10 64 0 points E, level'])

  const steep = scene(t)
  steep.look(new Vec3(10.3, 75.62, -0.6))
  twice(steep)
  steep.settle()
  assert.deepStrictEqual(steep.points(), ['Steve at 10 64 0 points up'])
})

test('a crouching player points from the crouched eye, which sits higher on 1.7.10', (t) => {
  cases(t, {
    'a log the crouched eye looks at': {
      opts: { crouching: true },
      act: (s) => { s.look(new Vec3(20.5, 64.7, 0.4)); s.swing() },
      want: ['Steve at 10 64 0 points E, level, at oak_log 20 64 0']
    },
    'a log cell the 1.7.10 crouched eye looks at, one above the cell the same look from the lower eye hits': {
      opts: { crouching: true, legacy: true },
      act: (s) => { s.look(new Vec3(20, 65.26, 0.4)); s.swing() },
      want: ['Steve at 10 64 0 points E, level, near oak_log 20 65 0']
    }
  })
})

test('a cell 17 blocks out on a wall facing the look is named at', (t) => {
  const wall = {}
  for (let y = 64; y <= 67; y++) for (let z = 3; z <= 7; z++) wall[`27,${y},${z}`] = 'white_wool'
  const s = scene(t, { cells: wall })
  s.look(new Vec3(27, 65.5, 5.5))
  twice(s)
  s.settle()
  assert.deepStrictEqual(s.points(), ['Steve at 10 64 0 points E, level, at white_wool 27 65 5'])
})

test('a shallow look at ground 25 blocks out names a ground cell as near', (t) => {
  const s = scene(t)
  s.look(new Vec3(35.5, 64, -3.5))
  twice(s)
  s.settle()
  assert.deepStrictEqual(s.points(), ['Steve at 10 64 0 points E, level, near stone 31 63 -3'])
})

test('a cell reads at only when every look the server could have sent as this head angle hits it', (t) => {
  const pillar = { '10,64,0': 'cobblestone', '10,65,0': 'cobblestone', '10,66,0': 'cobblestone', '10,67,0': 'cobblestone', '13,64,0': 'oak_log' }
  const overhang = { '13,69,-2': 'stone' }
  for (let y = 68; y <= 72; y++) for (let z = -6; z <= -2; z++) overhang[`16,${y},${z}`] = 'white_wool'
  const wall = {}
  for (let y = 64; y <= 67; y++) for (let z = 3; z <= 7; z++) wall[`27,${y},${z}`] = 'white_wool'
  cases(t, {
    'the log 10 blocks out on 1.7.10, where a turn of 3 angle steps can stay unsent': {
      opts: { legacy: true },
      want: ['Steve at 10 64 0 points E, level, near oak_log 20 65 0']
    },
    'a log at the foot of the pillar the player stands on, just past reach on the received look, on 1.7.10': {
      opts: { legacy: true, at: new Vec3(10.3, 68, 0.4), cells: pillar },
      act: (s) => { s.look(new Vec3(13.3, 65, 0.5)); s.swing() },
      want: ['Steve at 10 68 0 points E, down, at oak_log 13 64 0']
    },
    'a wall cell whose look one step higher, a look the server never sends as this angle, clips an overhang': {
      opts: { cells: overhang },
      act: (s) => { s.look(new Vec3(16, 70.61, -3.26)); s.swing() },
      want: ['Steve at 10 64 0 points NE, up, at white_wool 16 70 -4']
    },
    'a cell overhead whose look half a step lower and left clips the corner of a block below it': {
      opts: { cells: { '19,73,-9': 'white_wool', '18,71,-8': 'stone' } },
      act: (s) => { s.look(new Vec3(19.35, 73.59, -8.52)); s.swing() },
      want: ['Steve at 10 64 0 points NE, up, near white_wool 19 73 -9']
    },
    'a cell overhead 5.6 out on the received look, on 1.7.10': {
      opts: { legacy: true, cells: { '11,71,1': 'white_wool' } },
      act: (s) => { s.look(new Vec3(11.49, 71.4, 1.5)); s.swing() },
      want: ['Steve at 10 64 0 points up, at white_wool 11 71 1']
    },
    'a wall cell whose received look crosses just into the row above, where the middle of the possible looks hits the row below': {
      opts: { cells: wall },
      act: (s) => { s.look(new Vec3(27, 66.1, 5.5)); s.swing() },
      want: ['Steve at 10 64 0 points E, level, near white_wool 27 65 5']
    }
  })
})

test('digging, breaking grass, using a chest, hitting near a mob or player, a fight, a hostile near, a cast, a drop, a ride or a walk gives no point', (t) => {
  const bobber = { id: 12, type: 'projectile', name: 'fishing_bobber', width: 0.25, height: 0.25 }
  const item = { id: 13, type: 'other', name: 'item', width: 0.25, height: 0.25 }
  cases(t, {
    'a dig in reach of a block the bot cannot see': {
      opts: { cells: { '13,65,0': 'stone' }, sees: notCell13 },
      act: (s) => { s.bot.emit('blockBreakProgressObserved', s.bot.blockAt(new Vec3(13, 65, 0)), 3, s.steve); s.swing() }
    },
    'grass broken where the player looks': {
      opts: { cells: { '13,64,0': 'dirt' } },
      act: (s) => { s.swing(); s.change(13, 65, 0, 'short_grass') }
    },
    'a block broken on the look just before the swing': { act: (s) => { s.change(13, 65, 0); s.wait(200); s.swing() } },
    'a chest opened in reach': { opts: { cells: { '13,65,0': 'chest' } } },
    'a chest opened 5.2 out on the look, near the edge of reach': {
      opts: { cells: { '15,65,2': 'chest' } },
      act: (s) => { s.look(new Vec3(15.5, 65.5, 2.9)); s.swing() }
    },
    'a cow missed just above its back': { opts: { entities: [cow()] } },
    'a cow killed by the punch': {
      opts: { entities: [cow()] },
      act: (s) => {
        const target = s.bot.entities[9]
        s.swing()
        s.bot.emit('entityHurt', target)
        delete s.bot.entities[9]
      }
    },
    'a cow 5.5 away knocked past reach by the punch': { opts: { entities: [cow(15.8)] }, act: punch(1.5) },
    'a cow hit 5.84 away and knocked 1.9 further': { opts: { entities: [cow(16.14)] }, act: punch(1.9) },
    'a cow 5.5 away hurt and knocked past reach just before the swing arrives': {
      opts: { entities: [cow(15.8)] },
      act: (s) => {
        const target = s.bot.entities[9]
        s.look(target.position.offset(0, 1, 0))
        s.bot.emit('entityHurt', target)
        target.position.translate(1.5, 0.4, 0)
        s.wait(100)
        s.swing()
      }
    },
    'a cow hurt 5.5 away that leaves the bot\'s entities before the decision': {
      opts: { entities: [cow(15.8)] },
      act: (s) => { punch(0)(s); delete s.bot.entities[9] }
    },
    'the bot in reach on the look': { act: (s) => { s.bot.entity.position = new Vec3(13.3, 64, 0.4); s.swing() } },
    'another player in reach on the look': {
      opts: { entities: [{ id: 15, type: 'player', username: 'Alex', name: 'player', position: new Vec3(13.3, 64, 0.4), width: 0.6, height: 1.8 }] }
    },
    'a fight': { opts: { busy: true } },
    'a zombie near the player': { opts: { entities: [mob('zombie', new Vec3(14, 64, 6))] } },
    'a creeper near the player': { opts: { entities: [mob('creeper', new Vec3(14, 64, 6))] } },
    'a ravager near the player': { opts: { entities: [mob('ravager', new Vec3(14, 64, 6))] } },
    'a fishing line cast out 6 blocks by the decision': {
      opts: { entities: [bobber] },
      act: (s) => { s.swing(); s.spawn(bobber, new Vec3(10.3, 65.62, 0.4)); bobber.position = new Vec3(16.3, 64.1, 0.4) }
    },
    'an item dropped by the player': {
      opts: { entities: [item] },
      act: (s) => { s.swing(); s.spawn(item, new Vec3(10.3, 65.32, 0.4)); item.position = new Vec3(14.3, 64, 0.4) }
    },
    'a player riding': { act: (s) => { s.steve.vehicle = { id: 14, type: 'animal', name: 'horse' }; s.swing() } },
    'a player who just stepped': {
      act: (s) => {
        s.bot.emit('entityMoved', s.steve)
        s.steve.position = new Vec3(11.3, 64, 0.4)
        s.bot.emit('entityMoved', s.steve)
        s.look(new Vec3(20.5, 65.5, 0.4))
        s.swing()
      }
    }
  })
})

test('a mob or the bot on the look past reach, a block change beside the look, the door the player stands in or an old drop leaves the point', (t) => {
  cases(t, {
    'a cow 6.5 away': { opts: { entities: [cow(16.8)] }, want: [LOG] },
    'the bot 6.5 away': { act: (s) => { s.bot.entity.position = new Vec3(16.8, 64, 0.4); s.swing() }, want: [LOG] },
    'a furnace lit beside the look': {
      opts: { cells: { '11,64,2': 'furnace' } },
      act: (s) => { s.swing(); s.bot.emit('blockUpdate', { name: 'furnace', stateId: 3, position: new Vec3(11, 64, 2) }, { name: 'furnace', stateId: 4, position: new Vec3(11, 64, 2) }) },
      want: [LOG]
    },
    'a door at the eye': { opts: { cells: { '10,64,0': 'oak_door', '10,65,0': 'oak_door' } }, want: [LOG] },
    'an item lying at the feet': {
      opts: { entities: [{ id: 13, type: 'other', name: 'item', position: new Vec3(11.3, 64, 0.4), width: 0.25, height: 0.25 }] },
      want: [LOG]
    }
  })
})

test('a mob, block, block change or drop hidden from the bot and the player leaves the point, and one either sees stops it', (t) => {
  cases(t, {
    'a zombie 7 away behind a wall': { opts: { cells: { '10,64,3': 'stone', '10,65,3': 'stone' }, entities: [zombie7()], hidden: [11] }, want: [LOG] },
    'a zombie 7 away the bot sees': { opts: { entities: [zombie7()] }, want: [] },
    'a zombie 7 away only the player sees': { opts: { entities: [zombie7()], hidden: [11], clear: () => true }, want: [] },
    'a cow on the look in reach': { opts: { entities: [cow()], hidden: [9] }, want: [LOG] },
    'a cow killed by the punch': {
      opts: { entities: [cow()], hidden: [9] },
      act: (s) => {
        const target = s.bot.entities[9]
        s.swing()
        s.bot.emit('entityHurt', target)
        delete s.bot.entities[9]
      },
      want: [LOG]
    },
    'a block in reach on the look': { opts: { cells: { '13,65,0': 'stone' }, sees: notCell13 }, want: ['Steve at 10 64 0 points E, level'] },
    'a block broken on the look': { opts: { sees: notCell13 }, act: (s) => { s.swing(); s.change(13, 65, 0) }, want: [LOG] },
    'an item spawning behind a wall 2 from the eye': {
      opts: { entities: [{ id: 13, type: 'other', name: 'item', width: 0.25, height: 0.25 }], hidden: [13] },
      act: (s) => { s.swing(); s.spawn(s.bot.entities[13], new Vec3(10.3, 65, 2.4)) },
      want: [LOG]
    }
  })
})

const unseenBesideLegacy = { ...unseenBeside, legacy: true }
const happening = (id, cell = BESIDE.floored(), late = false) => around((s) => s.levelEvent(id, cell), late)

test('a block placed or used within reach of the player, which the bot hears but cannot see, during either punch gives no point', (t) => {
  const row = (name, p) => ({ opts: unseenBeside, act: hearing(name, p) })
  outcomes(t, {
    'a block placed on 1.7.10, whose place sound arrives as the material\'s break sound': row('block.stone.break'),
    'a block placed': row('minecraft:block.wood.place'),
    'a chest opened': row('block.chest.open'),
    'a chest closed': row('block.chest.close'),
    'a lever or button on 1.7.10, whose click arrives as the dispenser sound': row('block.dispenser.dispense'),
    'a lever': row('block.lever.click'),
    'a button': row('block.stone_button.click_on'),
    'a door': row('block.wooden_door.open'),
    'a fence gate': row('block.fence_gate.close'),
    'a barrel opened': row('block.barrel.open'),
    'a weathered copper chest opened': row('block.copper_chest_weathered.open'),
    'a bell rung': row('block.bell.use'),
    'seeds planted': row('item.crop.plant'),
    'a chest whose near face lies within reach though its centre does not': row('block.chest.open', new Vec3(10.5, 65.5, 6.5)),
    'a chest opened during the second punch': { opts: unseenBeside, act: hearing('block.chest.open', BESIDE, true) }
  })
})

test('on 1.7.10 a door, trapdoor or fence gate used within reach of the player, which arrives as a level event, during either punch gives no point', (t) => {
  outcomes(t, {
    'one used during the first punch, arriving as event 1005': { opts: unseenBesideLegacy, act: happening(1005) },
    'one used during the second punch, arriving as event 1011': { opts: unseenBesideLegacy, act: happening(1011, BESIDE.floored(), true) }
  })
})

test('a block broken within reach of the player, which arrives as level event 2001, during either punch gives no point', (t) => {
  outcomes(t, {
    'a block broken during the second punch': { opts: unseenBeside, act: happening(2001, BESIDE.floored(), true) },
    'a block broken during the first punch on 1.7.10': { opts: unseenBesideLegacy, act: happening(2001) }
  })
})

// A fill sound plays at the filler's feet, rounded to an eighth of a block.
const FEET = new Vec3(10.25, 64, 0.375)

test('a bucket or bottle filled during either punch, which the bot hears, gives no point', (t) => {
  outcomes(t, {
    'a glass bottle filled during the first punch': { opts: { held: 'iron_sword' }, act: hearing('item.bottle.fill', FEET) },
    'a bucket filled during the second punch': { opts: { held: 'iron_sword' }, act: hearing('item.bucket.fill', FEET, true) }
  })
})

// Two punches 650 ms apart, with cue halfway, after the first punch's decision and before the second's look-back.
const midway = (cue) => (s) => {
  s.swing()
  s.wait(325)
  cue(s)
  s.wait(325)
  s.swing()
}
// Where a trapdoor overhead plays, in reach of the standing eye and 6.1 from the crouched one.
const OVERHEAD = new Vec3(10.5, 71.5, 3.5)
// Where a chest below and ahead plays, in reach of the crouched eye and 6.15 from the standing one.
const BELOW = new Vec3(12.5, 59.5, -2.5)
// A crouched punch, then a standing one at the same block 950 ms later, with cue 290 ms before the first.
const standingUp = (cue) => (s) => {
  cue(s)
  s.wait(290)
  s.swing()
  s.wait(950)
  s.steve.crouching = false
  s.look(new Vec3(20.5, 65.5, 0.4))
  s.swing()
}

test('a block used in reach between the two punches, after the first punch\'s decision, gives no point', (t) => {
  outcomes(t, {
    'a chest opened halfway': { opts: unseenBeside, act: midway((s) => s.hear('block.chest.open', BESIDE)) },
    'a door used halfway on 1.7.10, arriving as a level event': { opts: unseenBesideLegacy, act: midway((s) => s.levelEvent(1011, BESIDE.floored())) },
    'control: nothing heard between punches 650 ms apart': { opts: unseenBeside, act: midway(() => {}), want: [LOG] },
    'control: nothing heard between punches 650 ms apart on 1.7.10': { opts: unseenBesideLegacy, act: midway(() => {}), want: [NEAR_LOG] },
    'a trapdoor used just before a crouched first punch, in reach of the eye once the player stands for the second': {
      opts: { crouching: true },
      act: standingUp((s) => s.hear('block.oak_trapdoor.open', OVERHEAD))
    },
    'a chest opened just before a crouched first punch, in reach of the crouched eye but not of the standing one for the second': {
      opts: { crouching: true },
      act: standingUp((s) => s.hear('block.chest.open', BELOW))
    },
    'control: the crouched punch and the standing one with nothing heard': { opts: { crouching: true }, act: standingUp(() => {}), want: [LOG] }
  })
})

test('after a use heard between two punches, a third punch points with the second unless the use fell in the second punch\'s look-back', (t) => {
  const got = {}
  const want = {}
  for (const [name, heard, third] of [
    ['the chest opened halfway, before the second punch\'s look-back', 325, [LOG]],
    ['the chest opened 100 ms before the second punch', 550, []]
  ]) {
    const s = scene(t, unseenBeside)
    s.swing()
    s.wait(heard)
    s.hear('block.chest.open', BESIDE)
    s.wait(650 - heard)
    s.swing()
    s.wait(400)
    const second = s.points()
    s.swing()
    s.settle()
    got[name] = { second, third: s.points() }
    want[name] = { second: [], third }
  }
  assert.deepStrictEqual(got, want)
})

test('a block sound beyond reach, outside both punches, unrelated to a use or at a cell the bot just edited leaves the point', (t) => {
  outcomes(t, {
    'a chest opened 7.5 from the eye': { opts: unseenBeside, act: hearing('block.chest.open', new Vec3(10.5, 64.5, 8.5)), want: [LOG] },
    'a chest opened 500 ms before the first punch': {
      opts: unseenBeside,
      act: (s) => { s.hear('block.chest.open', BESIDE); s.wait(500); twice(s) },
      want: [LOG]
    },
    'a chest opened after the decision on the second punch': {
      opts: unseenBeside,
      act: (s) => { twice(s); s.wait(260); s.hear('block.chest.open', BESIDE) },
      want: [LOG]
    },
    'a footstep': { opts: unseenBeside, act: hearing('block.stone.step'), want: [LOG] },
    'a block the bot just placed': {
      opts: unseenBeside,
      act: (s) => { s.ownEdit(10, 64, 3); hearing('block.stone.break')(s) },
      want: [LOG]
    },
    'a door used 7.5 from the eye on 1.7.10': { opts: unseenBesideLegacy, act: happening(1011, new Vec3(10, 64, 8)), want: [NEAR_LOG] },
    'a door used 500 ms before the first punch on 1.7.10': {
      opts: unseenBesideLegacy,
      act: (s) => { s.levelEvent(1011, BESIDE.floored()); s.wait(500); twice(s) },
      want: [NEAR_LOG]
    },
    'a block broken 7.5 from the eye': { opts: unseenBeside, act: happening(2001, new Vec3(10, 64, 8)), want: [LOG] },
    'a block broken at a cell the bot just edited': {
      opts: unseenBeside,
      act: (s) => { s.ownEdit(10, 64, 3); happening(2001)(s) },
      want: [LOG]
    },
    'a spawner spawning a mob on 1.7.10, which arrives as level event 2004': { opts: unseenBesideLegacy, act: happening(2004), want: [NEAR_LOG] },
    'a door event at a cell the bot just edited on 1.7.10': {
      opts: unseenBesideLegacy,
      act: (s) => { s.ownEdit(10, 64, 3); happening(1011)(s) },
      want: [NEAR_LOG]
    },
    'a jukebox song stopping, whose level event id a 1.7.10 door also arrives as': { opts: unseenBeside, act: happening(1011), want: [LOG] },
    'level event 1005, the other id a 1.7.10 door arrives as': { opts: unseenBeside, act: happening(1005), want: [LOG] }
  })
})

test('on 1.7.10 a still player whose last sent head angle passes beside a chest in reach, while the look it stands for opens it, gives no point, heard or not', (t) => {
  // The head turned three bytes since the server last sent its angle, which leaves the line passing north of the
  // chest's edge.
  const stale = (s) => {
    s.look(new Vec3(13.5, 65.5, 1.1))
    s.steve.headYaw = received(s.steve.headYaw, 3)
    s.steve.pitch = received(s.steve.pitch)
    s.swing()
  }
  const at = (name) => ({ legacy: true, cells: { '13,64,1': 'stone', '13,65,1': name } })
  cases(t, {
    'the chest heard opening': { opts: at('chest'), act: (s) => { stale(s); s.hear('block.chest.open', new Vec3(13.5, 65.5, 1.5)) } },
    'the chest unheard': { opts: at('chest'), act: stale },
    'control: a stone block in its place, judged by the last sent head angle': { opts: at('stone'), act: stale, want: ['Steve at 10 64 0 points E, level'] }
  })
})

test('on 1.7.10 a block past reach on the received look takes the point, though other looks the server could have sent as that angle reach the ground', (t) => {
  cases(t, {
    'the foot of a chest on the ground 7 blocks out': {
      opts: { legacy: true, cells: { '17,64,0': 'chest' } },
      act: (s) => { s.look(new Vec3(17.5, 64, 0.5)); s.swing() },
      want: ['Steve at 10 64 0 points E, level, near chest 17 64 0']
    },
    'the ground 5 blocks out, where the received look lands 0.3 past reach': {
      opts: { legacy: true },
      act: (s) => { s.look(new Vec3(15.9, 64, 0.5)); s.swing() },
      want: ['Steve at 10 64 0 points E, level, near stone 15 63 0']
    }
  })
})

// On 1.7.10, two uses 600 ms apart with the look at target, sent while the head sits three bytes below the pitch the
// server last sent, so the received line runs 4.2 to 5.6 degrees above the look.
const lagging = (target) => (s) => {
  s.look(target)
  s.steve.headYaw = received(s.steve.headYaw)
  s.steve.pitch = received(s.steve.pitch, 3)
  twice(s, 600)
}
// A block on the ground x blocks out, the look at its top face and the received line passing over it.
const onGround = (name, x) => ({ opts: { legacy: true, cells: { [`${x},64,0`]: name } }, act: lagging(new Vec3(x + 0.5, 64.8, 0.5)) })

test('on 1.7.10 two uses of a block that acts on use, which a look the head angle stands for reaches, give no point though the received line passes over it', (t) => {
  outcomes(t, {
    'a crafting table 4 out': onGround('crafting_table', 14),
    'a furnace 5 out': onGround('furnace', 15),
    'a lever 4 out': onGround('lever', 14),
    'a fence 4 out': onGround('oak_fence', 14)
  })
})

test('on 1.7.10 the same two punches over a plain block, over redstone dust or a daylight detector, which do nothing on use there, or over a block that acts on use just past reach on every possible look, leave the point', (t) => {
  outcomes(t, {
    'planks 4 out': { ...onGround('oak_planks', 14), want: ['Steve at 10 64 0 points E, level, near oak_log 20 64 0'] },
    'redstone dust 4 out': { ...onGround('redstone_wire', 14), want: ['Steve at 10 64 0 points E, level, near oak_log 20 64 0'] },
    'a daylight detector 4 out': { ...onGround('daylight_detector', 14), want: ['Steve at 10 64 0 points E, level, near oak_log 20 64 0'] },
    'a crafting table 5.7 out': { ...onGround('crafting_table', 16), want: ['Steve at 10 64 0 points E, level, near oak_log 20 65 0'] }
  })
})

const usingOn = (item, name, x, { unseen = false, legacy = true } = {}) => ({
  opts: { legacy, held: item, cells: { [`${x},64,0`]: name }, ...(unseen && { sees: (p) => !(p.x === x && p.y === 64 && p.z === 0) }) },
  act: (legacy ? lagging : asReceived)(new Vec3(x + 0.5, 64.8, 0.5))
})
// The row with the bot standing west of the player, its feet dist from his eye.
const away = (dist, row) => ({ ...row, act: (s) => { s.bot.entity.position = new Vec3(10.3 - Math.sqrt(dist ** 2 - 1.62 ** 2), 64, 0.4); row.act(s) } })
// A block 4 out the bot cannot see, the look at the far edge of its top face.
const overTop = (name) => ({ ...usingOn(null, name, 14, { unseen: true, legacy: false }), act: asReceived(new Vec3(15, 65, 0.5)) })

test('two uses of an item that acts on blocks, with a block in reach on a look the head angle stands for, give no point, seen or not', (t) => {
  outcomes(t, {
    'bone meal on a sapling 4 out on 1.7.10': usingOn('bone_meal', 'oak_sapling', 14),
    'bone meal on a sapling 4 out the bot cannot see on 1.7.10': usingOn('bone_meal', 'oak_sapling', 14, { unseen: true }),
    'flint and steel on stone 4 out on 1.7.10': usingOn('flint_and_steel', 'stone', 14),
    'a hoe on grass 4 out on 1.7.10': usingOn('iron_hoe', 'grass_block', 14),
    'wheat seeds on farmland 4 out the bot cannot see, 6 blocks from the bot, on 1.7.10': away(6, usingOn('wheat_seeds', 'farmland', 14, { unseen: true })),
    'bone meal on a sapling 4 out the bot cannot see': usingOn('bone_meal', 'oak_sapling', 14, { unseen: true, legacy: false })
  })
})

test('the same uses with a plain item or an empty hand, with an item that does nothing silent there, or with no block in reach on any possible look leave the point', (t) => {
  const NEAR_FOOT = 'Steve at 10 64 0 points E, level, near oak_log 20 64 0'
  outcomes(t, {
    'a sword over a sapling 4 out on 1.7.10': { ...usingOn('iron_sword', 'oak_sapling', 14), want: [NEAR_FOOT] },
    'an empty hand over a sapling 4 out on 1.7.10': { ...onGround('oak_sapling', 14), want: [NEAR_FOOT] },
    'an axe over a log 4 out on 1.7.10, where it strips nothing': { ...usingOn('iron_axe', 'oak_log', 14), want: [NEAR_FOOT] },
    'wheat seeds over farmland 4 out the bot cannot see, 6 blocks from the bot': {
      ...away(6, usingOn('wheat_seeds', 'farmland', 14, { unseen: true, legacy: false })),
      want: ['Steve at 10 64 0 points E, level']
    },
    'bone meal at the sky on 1.7.10': {
      opts: { legacy: true, held: 'bone_meal' },
      act: (s) => { s.look(new Vec3(10.3, 75.62, -9.6)); twice(s, 600) },
      want: ['Steve at 10 64 0 points N, up']
    },
    'bone meal over a sapling 5.7 out on 1.7.10': { ...usingOn('bone_meal', 'oak_sapling', 16), want: ['Steve at 10 64 0 points E, level, near oak_log 20 65 0'] }
  })
})

test('two uses of a block or an item that places one, far enough from the bot that a block placed in reach could play its place sound out of earshot, with a block in reach on a possible look, give no point', (t) => {
  outcomes(t, {
    'stone 20 blocks from the bot over stone 4 out the bot cannot see': away(20, usingOn('stone', 'stone', 14, { unseen: true, legacy: false })),
    'stone 20 blocks from the bot over stone 4 out the bot cannot see on 1.7.10': away(20, usingOn('stone', 'stone', 14, { unseen: true })),
    'stone 7.5 blocks from the bot over stone 4 out the bot cannot see on 1.7.10': away(7.5, usingOn('stone', 'stone', 14, { unseen: true })),
    'wheat seeds 20 blocks from the bot over farmland 4 out the bot cannot see': away(20, usingOn('wheat_seeds', 'farmland', 14, { unseen: true, legacy: false })),
    'stone 12 blocks from the bot, within hearing of the player but not of every cell in his reach': away(12, usingOn('stone', 'stone', 14, { unseen: true, legacy: false }))
  })
})

test('the same uses closer to the bot, with a sword, at the sky or with no block in reach on any possible look leave the point', (t) => {
  const NO_CELL = 'Steve at 10 64 0 points E, level'
  outcomes(t, {
    'stone 7.9 blocks from the bot': { ...away(7.9, usingOn('stone', 'stone', 14, { unseen: true, legacy: false })), want: [NO_CELL] },
    'stone 6.9 blocks from the bot on 1.7.10': { ...away(6.9, usingOn('stone', 'stone', 14, { unseen: true })), want: ['Steve at 10 64 0 points E, level, near oak_log 20 64 0'] },
    'glass 5 blocks from the bot': { ...away(5, usingOn('glass', 'stone', 14, { unseen: true, legacy: false })), want: [NO_CELL] },
    'a sword 20 blocks from the bot': { ...away(20, usingOn('iron_sword', 'stone', 14, { unseen: true, legacy: false })), want: [NO_CELL] },
    'stone 20 blocks from the bot at the sky': {
      ...away(20, { opts: { held: 'stone' }, act: (s) => { s.look(new Vec3(10.3, 75.62, -9.6)); twice(s, 600) } }),
      want: ['Steve at 10 64 0 points N, up']
    },
    'stone 20 blocks from the bot over stone 5.7 out': { ...away(20, usingOn('stone', 'stone', 16, { legacy: false })), want: ['Steve at 10 64 0 points E, level, at stone 16 64 0'] }
  })
})

test('on 1.7.10 two uses of glass, ice or an anvil, whose place sound arrives as a footstep or an anvil landing, close to the bot with a block in reach on a possible look give no point', (t) => {
  outcomes(t, {
    'glass 5 blocks from the bot over stone 4 out the bot cannot see': away(5, usingOn('glass', 'stone', 14, { unseen: true })),
    'ice 5 blocks from the bot over stone 4 out the bot cannot see': away(5, usingOn('ice', 'stone', 14, { unseen: true })),
    'an anvil 5 blocks from the bot over stone 4 out the bot cannot see': away(5, usingOn('anvil', 'stone', 14, { unseen: true }))
  })
})

// Two uses at the surface 2 out with held in hand.
const overPool = (held, liquid = 'water') => ({ opts: { held, cells: pool(liquid) }, act: asReceived(new Vec3(12.4, 64, 0.75)) })
const FLOOR = 'Steve at 10 64 0 points E, down, at stone 17 59 1'

test('two uses of an empty bucket or a glass bottle at water, a bubble column or lava whose floor lies past reach give no point', (t) => {
  outcomes(t, {
    'a glass bottle at water': overPool('glass_bottle'),
    'a glass bottle at a bubble column': overPool('glass_bottle', 'bubble_column'),
    'a bucket at water': overPool('bucket'),
    'a bucket at lava': overPool('bucket', 'lava')
  })
})

test('the same uses at deep water with a sword, or with a water bucket, which fills nothing, leave the point', (t) => {
  outcomes(t, {
    'a sword': { ...overPool('iron_sword'), want: [FLOOR] },
    'a water bucket': { ...overPool('water_bucket'), want: [FLOOR] }
  })
})

test('two uses of a lily pad or frogspawn, which a look places on the water it meets, far enough from the bot that the place sound could fall out of earshot, at water or a bubble column whose floor lies past reach give no point', (t) => {
  outcomes(t, {
    'a lily pad 20 blocks from the bot': away(20, overPool('lily_pad')),
    'frogspawn 20 blocks from the bot': away(20, overPool('frogspawn')),
    'a lily pad 20 blocks from the bot at a bubble column': away(20, overPool('lily_pad', 'bubble_column'))
  })
})

test('the same uses of a lily pad close to the bot, or at lava, where it places nothing, leave the point', (t) => {
  outcomes(t, {
    'a lily pad 5 blocks from the bot': { ...away(5, overPool('lily_pad')), want: [FLOOR] },
    'a lily pad 20 blocks from the bot at lava': { ...away(20, overPool('lily_pad', 'lava')), want: [FLOOR] }
  })
})

// Two uses steeply up at the open sky, standing in water depth cells deep with held in hand.
const inWater = (held, depth) => away(20, {
  opts: { held, cells: Object.fromEntries(Array.from({ length: depth }, (_, i) => [`10,${64 + i},0`, 'water'])) },
  act: asReceived(new Vec3(11.1, 75.62, -4.6))
})

test('two uses of a glass bottle or a lily pad with the eye inside water, which the item takes or floats on, give no point', (t) => {
  outcomes(t, {
    'a glass bottle': inWater('glass_bottle', 2),
    'a lily pad': inWater('lily_pad', 2)
  })
})

test('the same uses with a sword, or with a glass bottle and the eye above the water, leave the point', (t) => {
  const SKY = 'Steve at 10 64 0 points N, up'
  outcomes(t, {
    'a sword with the eye inside water': { ...inWater('iron_sword', 2), want: [SKY] },
    'a glass bottle with the eye above water 1 deep': { ...inWater('glass_bottle', 1), want: [SKY] }
  })
})

test('on 1.7.10, where a bucket acts on no block, two uses with one held through water at an unseen block that acts on use give no point, as with an empty hand', (t) => {
  // A chest under two cells of water 2 out, which the look meets 4.1 from the eye.
  const sunk = (held) => ({
    opts: { legacy: true, held, cells: { ...pool('water'), '12,61,0': 'chest' }, sees: (p) => !(p.x === 12 && p.y === 61 && p.z === 0) },
    act: asReceived(new Vec3(12.5, 61.5, 0.5))
  })
  outcomes(t, {
    'a bucket': sunk('bucket'),
    'an empty hand': sunk(null)
  })
})

test('two uses of a block that acts on use, which the bot cannot see, on a look the head angle stands for give no point', (t) => {
  outcomes(t, {
    'a barrel 4 out': usingOn(null, 'barrel', 14, { unseen: true, legacy: false }),
    'a lectern 4 out': usingOn(null, 'lectern', 14, { unseen: true, legacy: false }),
    'a composter 4 out': usingOn(null, 'composter', 14, { unseen: true, legacy: false }),
    'a bell 4 out': usingOn(null, 'bell', 14, { unseen: true, legacy: false }),
    'a weathered copper chest 4 out': usingOn(null, 'weathered_copper_chest', 14, { unseen: true, legacy: false }),
    'redstone dust 4 out': usingOn(null, 'redstone_wire', 14, { unseen: true, legacy: false }),
    'a barrel 4 out that the received look passes over and a look a step lower reaches': overTop('barrel'),
    'control: planks in its place': { ...overTop('oak_planks'), want: ['Steve at 10 64 0 points E, level'] }
  })
})

test('a block that acts on use, which every possible look meets only behind a nearer plain block, leaves the point', (t) => {
  const shadowed = (legacy, cells = { '12,65,0': 'stone', '13,65,0': 'crafting_table' }) => ({
    opts: { legacy, cells, sees: (p) => !(p.y === 65 && p.z === 0 && (p.x === 12 || p.x === 13)) },
    act: asReceived(new Vec3(13.5, 65.5, 0.5))
  })
  const NO_CELL = 'Steve at 10 64 0 points E, level'
  outcomes(t, {
    'a crafting table behind a stone': { ...shadowed(false), want: [NO_CELL] },
    'a crafting table behind a stone on 1.7.10': { ...shadowed(true), want: [NO_CELL] },
    'a crafting table behind glass': { ...shadowed(false, { '12,65,0': 'glass', '13,65,0': 'crafting_table' }), want: [NO_CELL] },
    'control: the crafting table without the stone': shadowed(false, { '13,65,0': 'crafting_table' })
  })
})

test('a block that acts on use 3 out, which every possible look meets behind a nearer block short of a full cube, gives no point, and planks in its place leave the point', (t) => {
  // The 1.7.10 look aims lower because its possible looks reach up to 7 angle steps above it.
  const ahead = (legacy, near, far) => ({
    opts: { legacy, cells: { ...near, '13,64,0': far }, sees: (p) => !(p.y === 64 && p.z === 0 && p.x >= 11 && p.x <= 13) },
    act: legacy ? lagging(new Vec3(13.5, 64.1, 0.5)) : asReceived(new Vec3(13.5, 64.6, 0.5))
  })
  const DUST = { '11,64,0': 'redstone_wire', '12,64,0': 'redstone_wire' }
  const CARPET = { '12,64,0': 'white_carpet' }
  const SLAB = { '12,64,0': 'stone_slab' }
  const TORCH = { '12,64,0': 'torch' }
  const NO_CELL = 'Steve at 10 64 0 points E, level'
  outcomes(t, {
    'a repeater behind 2 cells of redstone dust on 1.7.10': ahead(true, DUST, 'repeater'),
    'a chest behind a carpet': ahead(false, CARPET, 'chest'),
    'a crafting table behind a bottom slab': ahead(false, SLAB, 'crafting_table'),
    'a lever behind a torch': ahead(false, TORCH, 'lever'),
    'control: planks behind the dust on 1.7.10': { ...ahead(true, DUST, 'oak_planks'), want: ['Steve at 10 64 0 points E, down'] },
    'control: planks behind the carpet': { ...ahead(false, CARPET, 'oak_planks'), want: [NO_CELL] },
    'control: planks behind the slab': { ...ahead(false, SLAB, 'oak_planks'), want: [NO_CELL] },
    'control: planks behind the torch': { ...ahead(false, TORCH, 'oak_planks'), want: [NO_CELL] }
  })
})

// Oak blocks: an open door or trapdoor along the south edge of its cell, a fence gate's panel across the look east.
const door = (open) => Block.fromProperties('oak_door', { facing: 'east', hinge: 'right', open: String(open), half: 'lower', powered: 'false' }, 0)
const trapdoor = Block.fromProperties('oak_trapdoor', { facing: 'north', open: 'true', half: 'top', powered: 'false', waterlogged: 'false' }, 0)
const fenceGate = (open, inWall = false, facing = 'east') => Block.fromProperties('oak_fence_gate', { facing, open: String(open), in_wall: String(inWall), powered: 'false' }, 0)
const gate = fenceGate(true)
// A door 2 out.
const doorway = (b) => ({ '12,64,0': b, '12,65,0': b })
// A log pillar 8 out.
const PILLAR = { '18,64,0': 'oak_log', '18,65,0': 'oak_log', '18,66,0': 'oak_log' }
// Two uses at target with cells in the way.
const past = (cells, target, legacy = false) => ({ opts: { legacy, cells: { ...PILLAR, ...cells } }, act: (legacy ? lagging : asReceived)(target) })
const LOG8 = new Vec3(18.5, 65.5, 0.5)
const AT_LOG8 = 'Steve at 10 64 0 points E, level, at oak_log 18 65 0'
const NEAR_LOG8 = 'Steve at 10 64 0 points E, level, near oak_log 18 66 0'
// A fence gate on a block 2 out.
const gateway = { '12,64,0': 'stone', '12,65,0': gate }
// A trapdoor overhead and a log pillar beyond it.
const HATCH = { '11,67,0': trapdoor, '14,71,0': 'oak_log', '14,72,0': 'oak_log', '14,73,0': 'oak_log' }
const HATCH_LOG = new Vec3(14.5, 72.5, 0.65)
// The leaf of the open door.
const LEAF = new Vec3(12.5, 65.5, 0.9)

test('a look through the gap of an open door or trapdoor points at the block behind it', (t) => {
  outcomes(t, {
    'a log past an open door': { ...past(doorway(door(true)), LOG8), want: [AT_LOG8] },
    'a log past an open door on 1.7.10': { ...past(doorway(door(true)), LOG8, true), want: [NEAR_LOG8] },
    'a log past an open trapdoor overhead': { ...past(HATCH, HATCH_LOG), want: ['Steve at 10 64 0 points E, up, at oak_log 14 71 0'] },
    'a log past an open trapdoor overhead on 1.7.10': { ...past(HATCH, HATCH_LOG, true), want: ['Steve at 10 64 0 points E, up, near oak_log 14 72 0'] }
  })
})

test('a look over a fence gate, open or closed, above its outline points at the block behind it, which sits lower in a wall on 1.21.11', (t) => {
  // The look clears the gate's 1-high outline but crosses its 1.5-high collision box and dips into its cell.
  const low = (b, legacy) => past({ '12,64,0': b, '16,64,0': 'oak_log' }, new Vec3(16.5, 64.15, 0.5), legacy)
  outcomes(t, {
    'a log past a closed fence gate': { ...low(fenceGate(false)), want: ['Steve at 10 64 0 points E, level, at oak_log 16 64 0'] },
    'a log past a closed fence gate on 1.7.10': { ...low(fenceGate(false), true), want: ['Steve at 10 64 0 points E, level, near oak_log 16 64 0'] },
    'control: a log past an open fence gate': { ...low(fenceGate(true)), want: ['Steve at 10 64 0 points E, level, at oak_log 16 64 0'] },
    'a log past a closed fence gate in a wall on a block 2 out, the look crossing below the top of a free one': {
      ...past({ '12,64,0': 'stone', '12,65,0': fenceGate(false, true) }, new Vec3(18.5, 66.7, 0.5)),
      want: ['Steve at 10 64 0 points E, level, at oak_log 18 66 0']
    }
  })
})

test('a closed door, an open door the look meets, a fence gate the look meets open or not, or a slab the look passes over stops the point', (t) => {
  const slab = Block.fromProperties('stone_slab', { type: 'bottom', waterlogged: 'false' }, 0)
  const post = past(gateway, new Vec3(18.5, 65.5, 0.2))
  outcomes(t, {
    'the door closed': past(doorway(door(false)), LOG8),
    'the door closed on 1.7.10': past(doorway(door(false)), LOG8, true),
    'the open door\'s leaf': past(doorway(door(true)), LEAF),
    'the open door\'s leaf on 1.7.10': past(doorway(door(true)), LEAF, true),
    'an open fence gate the look crosses below its top': past(gateway, LOG8),
    'an open fence gate the look crosses below its top on 1.7.10': past(gateway, LOG8, true),
    'an open fence gate the look crosses near its post': { ...post, opts: { ...post.opts, at: new Vec3(10.3, 64, 0.15) } },
    'an open fence gate facing north, which the look north crosses near its post': {
      opts: { cells: { '10,64,-2': 'stone', '10,65,-2': fenceGate(true, false, 'north'), '10,64,-8': 'oak_log', '10,65,-8': 'oak_log', '10,66,-8': 'oak_log' } },
      act: asReceived(new Vec3(10.2, 65.5, -7.5))
    },
    'a bottom slab on a block 2 out, the look crossing above the slab in its cell': past({ '12,64,0': 'stone', '12,65,0': slab }, new Vec3(18.5, 65.8, 0.5))
  })
})

// A scene whose block reads and sight checks count into reads.
function counted (t, opts, reads) {
  const s = scene(t, { ...opts, sees: (p) => { reads.push(p.toString()); return (opts.sees || (() => true))(p) } })
  const blockAt = s.bot.blockAt
  s.bot.blockAt = (p) => { reads.push('block'); return blockAt(p) }
  return s
}

test('a dig, a fight or a hostile near ends the decision before any block on the look is read or checked for sight', (t) => {
  const got = {}
  const want = {}
  for (const [name, opts, prep = () => {}] of [
    ['a dig', {}, (s) => s.bot.emit('blockBreakProgressObserved', { name: 'oak_log', position: new Vec3(20, 65, 0) }, 3, s.steve)],
    ['a fight', { busy: true }],
    ['a zombie near the player', { entities: [mob('zombie', new Vec3(14, 64, 6))] }]
  ]) {
    const reads = []
    const s = counted(t, opts, reads)
    prep(s)
    twice(s)
    // Both decisions fall within a second of the dig.
    s.wait(300)
    got[name] = { points: s.points(), reads: reads.length }
    want[name] = { points: [], reads: 0 }
  }
  assert.deepStrictEqual(got, want)
})

test('a cell asked about twice in one decision is checked for sight once', (t) => {
  const reads = []
  const s = counted(t, { cells: { '13,65,0': 'stone' }, sees: notCell13 }, reads)
  s.swing()
  s.wait(300)
  const first = reads.filter((r) => r !== 'block')
  s.swing()
  s.settle()
  assert.deepStrictEqual({ first, points: s.points() }, { first: ['(13, 65, 0)'], points: ['Steve at 10 64 0 points E, level'] })
})

test('on 1.7.10 a player who punches, then hits a cow 2.5 away on the same look and turns 90 degrees before the decision, gives no point', (t) => {
  const s = scene(t, { legacy: true })
  s.swing()
  s.wait(300)
  const target = cow(12.8)
  s.bot.entities[target.id] = target
  s.swing()
  s.bot.emit('entityHurt', target)
  target.position.translate(0.5, 0.4, 0)
  s.wait(150)
  // North and level, a look that hits nothing in reach.
  s.steve.headYaw += Math.PI / 2
  s.steve.pitch = 0
  s.bot.emit('entityMoved', s.steve)
  s.settle()
  assert.deepStrictEqual(s.points(), [])
})

test('a swing is judged by the look in the first angle update that closely follows it', (t) => {
  const s = scene(t)
  for (let i = 0; i < 2; i++) {
    // The head angle last received points north and up when the swing arrives.
    s.look(new Vec3(10.3, 75.62, -9.6))
    s.swing()
    s.wait(70)
    s.look(new Vec3(20.5, 65.5, 0.4))
    s.bot.emit('entityMoved', s.steve)
    s.wait(230)
  }
  s.settle()
  assert.deepStrictEqual(s.points(), [LOG])
})

test('a head twitch of up to 4 angle steps after the second swing leaves the point on the swing\'s look, and a wider turn drops it', (t) => {
  const turn = (up, left = 0) => (s) => {
    twice(s)
    s.wait(180)
    s.steve.pitch += up * STEP
    s.steve.headYaw += left * STEP
    s.bot.emit('entityMoved', s.steve)
  }
  outcomes(t, {
    'two steps up': { act: turn(2), want: [LOG] },
    'four steps up': { act: turn(4), want: [LOG] },
    'five steps up': { act: turn(5) },
    'four steps left': { act: turn(0, 4), want: [LOG] },
    'five steps left': { act: turn(0, 5) },
    'four steps up on 1.7.10': { opts: { legacy: true }, act: turn(4), want: [NEAR_LOG] },
    'five steps up on 1.7.10': { opts: { legacy: true }, act: turn(5) }
  })
})

test('a turn after the second swing whose entity look arrives before the decision and head angle after it drops the point', (t) => {
  // Entity look and head yaw arrive in separate packets, here 202 and 304 ms after the swing.
  const split = (left) => (s) => {
    twice(s)
    s.wait(202)
    s.steve.yaw += left * STEP
    s.bot.emit('entityMoved', s.steve)
    s.wait(102)
    s.steve.headYaw += left * STEP
    s.bot.emit('entityMoved', s.steve)
  }
  outcomes(t, {
    'five steps left': { act: split(5) },
    'four steps left': { act: split(4), want: [LOG] }
  })
})

// Aims Steve at the log between angle bytes, his entity yaw lag bytes off the head yaw, and returns the true yaw.
const offBoundary = (s, lag = 0) => {
  s.look(new Vec3(20.5, 65.5, 0.6))
  const yaw = s.steve.headYaw
  s.steve.headYaw = received(yaw)
  s.steve.yaw = received(yaw, lag)
  s.steve.pitch = received(s.steve.pitch)
  return yaw
}
const OFF_LOG = 'Steve at 10 64 0 points E, level, at oak_log 20 65 0'
const OFF_NEAR_LOG = 'Steve at 10 64 0 points E, level, near oak_log 20 65 0'
// Two punches at the log, then the cue 300 ms after the second, once its decision has run.
const late = (cue, after = 300) => (s) => {
  offBoundary(s)
  twice(s)
  s.run(after - (after % 10))
  if (after % 10) s.wait(after % 10)
  cue(s)
  s.run(300)
}
const turnLeft = (left, { head = true, entity = true, after } = {}) => late((s) => {
  if (head) s.steve.headYaw += left * STEP
  if (entity) s.steve.yaw += left * STEP
  s.bot.emit('entityMoved', s.steve)
}, after)

test('a turn of more than 4 angle steps arriving after the decision on the second swing drops the point, but not on 1.7.10, where the point is out by then', (t) => {
  outcomes(t, {
    'five steps left on the head angle and entity look together': { act: turnLeft(5) },
    'five steps left on the head angle alone': { act: turnLeft(5, { entity: false }) },
    'five steps left on the entity look alone': { act: turnLeft(5, { head: false }) },
    'four steps left': { act: turnLeft(4), want: [OFF_LOG] },
    'five steps left on 1.7.10': { opts: { legacy: true }, act: turnLeft(5), want: [OFF_NEAR_LOG] }
  })
})

test('on 1.21.11 a turn of more than 4 angle steps arriving 401 or 451 ms after the second swing drops the point, and the pair without it still points', (t) => {
  outcomes(t, {
    'five steps left 401 ms after the second swing': { act: turnLeft(5, { after: 401 }) },
    'five steps left 451 ms after the second swing': { act: turnLeft(5, { after: 451 }) },
    'no turn': { act: late(() => {}, 401), want: [OFF_LOG] }
  })
})

test('a player who leaves, goes stale, drops out of sight or steps after the decision on the second swing, before the point is out, gives no point', (t) => {
  outcomes(t, {
    leaves: { act: late((s) => { delete s.bot.entities[s.steve.id] }) },
    'goes stale': { act: late((s) => s.stale()) },
    'drops out of sight': { act: late((s) => s.hide()) },
    steps: {
      act: (s) => {
        s.bot.emit('entityMoved', s.steve)
        late(() => {
          s.steve.position = s.steve.position.offset(0.4, 0, 0)
          s.bot.emit('entityMoved', s.steve)
        })(s)
      }
    },
    'control: stays': { act: late(() => {}), want: [OFF_LOG] }
  })
})

test('punches that pair up again while a point waits to go out add no second point', (t) => {
  const s = scene(t)
  offBoundary(s)
  twice(s)
  s.wait(40)
  twice(s, 50)
  s.run(500)
  assert.deepStrictEqual(s.points(), [OFF_LOG])
})

test('on 1.7.10 a twitch of 2 angle steps that the entity look, its byte 3 steps behind, reads as 5 leaves the point', (t) => {
  const s = scene(t, { legacy: true })
  const yaw = offBoundary(s, -3)
  twice(s)
  s.wait(180)
  // The head angle byte stays, 2 steps short of its resend threshold.
  s.steve.yaw = received(yaw + 2 * STEP)
  s.bot.emit('entityMoved', s.steve)
  s.settle()
  assert.deepStrictEqual(s.points(), [OFF_NEAR_LOG])
})

test('the point names the cell the player stands in', (t) => {
  const s = scene(t, { at: new Vec3(10.6, 64, 0.4) })
  twice(s)
  s.settle()
  assert.deepStrictEqual(s.points(), [LOG])
})

test('a mob beside the line vetoes within the aim error the head angle bytes allow at its distance, which 1.7.10 widens', (t) => {
  // The line runs level due east from the eye at z 0.4, and the villager's box spans 0.3 either side of its z, 5 blocks out.
  const level = (s) => { east(s, 0); s.swing() }
  cases(t, {
    'a villager missed by 0.8 on 1.7.10': { opts: { legacy: true, entities: [villager(1.5)] }, act: level },
    'a villager missed by 1.2 on 1.7.10': { opts: { legacy: true, entities: [villager(1.9)] }, act: level, want: [NEAR_LOG] },
    'a villager missed by 0.6': { opts: { entities: [villager(1.3)] }, act: level },
    'a villager missed by 0.8': { opts: { entities: [villager(1.5)] }, act: level, want: [LOG] }
  })
})

test('on 1.7.10 a mob is measured by its 1.7.10 hitbox, and a hurt one by the box it had when hurt', (t) => {
  // Steve stands on two snow layers, so his eye sits 0.47 above the back of a cow behind him by its 1.21 hitbox and
  // 0.57 by its 1.7.10 one.
  const snow = { at: new Vec3(10.3, 64.25, 0.4), cells: { '10,64,0': 'snow' }, entities: [cow(9.5)] }
  const babyIdx = mcData.entitiesByName.cow.metadataKeys.indexOf('baby')
  cases(t, {
    'a cow behind the player on 1.7.10': { opts: { ...snow, legacy: true }, act: (s) => { east(s, 0); s.swing() }, want: [NEAR_LOG] },
    'a cow behind the player': { opts: snow, act: (s) => { east(s, 0); s.swing() } },
    'a baby cow hurt under the line, knocked aside and grown up by the decision': {
      opts: { legacy: true, entities: [cow()] },
      act: (s) => {
        const calf = s.bot.entities[9]
        calf.metadata = Object.assign([], { [babyIdx]: true })
        east(s, 0)
        s.swing()
        s.bot.emit('entityHurt', calf)
        calf.position.translate(0, 0.4, 1.5)
        calf.metadata[babyIdx] = false
      },
      want: [NEAR_LOG]
    }
  })
})

test('repeated punches at the same spot with small shifts of stance and look give one point', (t) => {
  const s = scene(t)
  twice(s)
  s.settle()
  for (const [dx, target] of [[0.4, new Vec3(20.5, 65.9, 0.9)], [0.2, new Vec3(20.5, 65.2, 0.1)], [-0.3, new Vec3(20.5, 66.4, 0.6)]]) {
    s.steve.position = s.steve.position.offset(dx, 0, 0)
    s.bot.emit('entityMoved', s.steve)
    s.wait(6000)
    s.look(target)
    twice(s)
    s.settle()
  }
  assert.strictEqual(s.points().length, 1)
})

test('a player who steps 2 blocks aside and punches the same spot again points again', (t) => {
  const s = scene(t)
  twice(s)
  s.settle()
  s.steve.position = new Vec3(10.3, 64, 2.4)
  s.bot.emit('entityMoved', s.steve)
  s.wait(6000)
  s.look(new Vec3(20.5, 65.5, 0.4))
  twice(s)
  s.settle()
  assert.deepStrictEqual(s.points(), [LOG, 'Steve at 10 64 2 points E, level, at oak_log 20 65 0'])
})

// The log cell above, on 1.7.10, where the second punch looks 4 angle bytes higher than the first.
const UP_LOG = 'Steve at 10 64 0 points E, level, near oak_log 20 66 0'

test('a point takes a second punch at the same spot within a second of the first, and carries the second punch\'s look', (t) => {
  outcomes(t, {
    'one punch': { opts: { legacy: true }, act: (s) => s.swing() },
    'a second punch 200 ms later, while the first awaits its decision': { opts: { legacy: true }, act: again(200, 4), want: [UP_LOG] },
    'a second punch 300 ms later': { opts: { legacy: true }, act: again(300, 4), want: [UP_LOG] },
    'a second punch 900 ms later': { opts: { legacy: true }, act: again(900, 4), want: [UP_LOG] },
    'a second punch 1100 ms later': { opts: { legacy: true }, act: again(1100, 4) },
    'three punches': {
      opts: { legacy: true },
      act: (s) => {
        again(300, 4)(s)
        s.wait(300)
        s.steve.pitch -= 2 * STEP
        s.bot.emit('entityMoved', s.steve)
        s.swing()
      },
      want: [UP_LOG]
    }
  })
})

test('two punches more than 4 angle steps apart give no point, unless both name the same cell', (t) => {
  const sky = (up) => (s) => { s.look(new Vec3(10.3, 75.62, -9.6)); again(300, up)(s) }
  outcomes(t, {
    'the sky, four angle bytes apart': { act: sky(4), want: ['Steve at 10 64 0 points N, up'] },
    'the sky, five angle bytes apart': { act: sky(5) },
    'the sky, four angle bytes apart on 1.7.10': { opts: { legacy: true }, act: sky(4), want: ['Steve at 10 64 0 points N, up'] },
    'the sky, five angle bytes apart on 1.7.10': { opts: { legacy: true }, act: sky(5) },
    'the sky, four angle bytes apart sideways': { act: (s) => { s.look(new Vec3(10.3, 75.62, -9.6)); again(300, 0, 4)(s) }, want: ['Steve at 10 64 0 points N, up'] },
    'the sky, five angle bytes apart sideways': { act: (s) => { s.look(new Vec3(10.3, 75.62, -9.6)); again(300, 0, 5)(s) } },
    'the sky on 1.7.10, a twitch of two angle steps up that arrives as five bytes, the first punch\'s byte held three behind': {
      opts: { legacy: true },
      act: (s) => {
        // A look between angle bytes on both axes.
        s.look(new Vec3(9.6, 75.3, -9.6))
        const pitch = s.steve.pitch
        s.steve.headYaw = received(s.steve.headYaw)
        s.steve.pitch = received(pitch, -3)
        s.swing()
        s.wait(300)
        s.steve.pitch = received(pitch + 2 * STEP)
        s.bot.emit('entityMoved', s.steve)
        s.swing()
      }
    },
    // mineflayer reads a head yaw in [0, 2π), so due north is where it wraps.
    'the sky, three angle bytes apart across due north': {
      act: (s) => {
        s.look(new Vec3(10.3, 75.62, -9.6))
        s.steve.headYaw = 1.5 * STEP
        s.swing()
        s.wait(300)
        s.steve.headYaw = 2 * Math.PI - 1.5 * STEP
        s.bot.emit('entityMoved', s.steve)
        s.swing()
      },
      want: ['Steve at 10 64 0 points N, up']
    },
    'a block 6 out, five angle bytes apart': {
      opts: { cells: { '16,65,0': 'white_wool' } },
      act: (s) => { s.look(new Vec3(16, 65.15, 0.5)); again(300, 5)(s) },
      want: ['Steve at 10 64 0 points E, level, at white_wool 16 65 0']
    }
  })
})

test('a first punch that hits a cow does not count toward a point', (t) => {
  outcomes(t, {
    'the cow hit and killed by the first punch': {
      opts: { entities: [cow()] },
      act: (s) => {
        const target = s.bot.entities[9]
        s.swing()
        s.bot.emit('entityHurt', target)
        delete s.bot.entities[9]
        s.wait(400)
        s.swing()
      }
    },
    'control: the cow gone before the first punch': {
      opts: { entities: [cow()] },
      act: (s) => { delete s.bot.entities[9]; twice(s, 400) },
      want: [LOG]
    }
  })
})

test('a player who steps between the two punches gives no point', (t) => {
  outcomes(t, {
    'a step of 0.4': {
      act: (s) => {
        s.bot.emit('entityMoved', s.steve)
        s.swing()
        s.wait(100)
        s.steve.position = s.steve.position.offset(0.4, 0, 0)
        s.bot.emit('entityMoved', s.steve)
        s.wait(600)
        s.swing()
      }
    },
    'control: no step': { act: (s) => twice(s, 700), want: [LOG] }
  })
})

test('a player points again at another spot only 5 s after their last point', (t) => {
  const s = scene(t)
  twice(s)
  s.settle()
  s.look(new Vec3(10.3, 75.62, -9.6))
  s.wait(2000)
  twice(s)
  s.settle()
  assert.strictEqual(s.points().length, 1, 'within 5 s')
  s.wait(1500)
  twice(s)
  s.settle()
  assert.deepStrictEqual(s.points(), [LOG, 'Steve at 10 64 0 points N, up'])
})

test('a player who punches the same spot after 20 s without a punch points again', (t) => {
  const s = scene(t)
  twice(s)
  s.settle()
  s.wait(21000)
  twice(s)
  s.settle()
  assert.deepStrictEqual(s.points(), [LOG, LOG])
})

test('a player the bot cannot perceive, or one past 32 blocks, gives no point', (t) => {
  cases(t, {
    hidden: { opts: { seen: false } },
    far: { opts: { at: new Vec3(40.3, 64, 0.4) } }
  })
})
