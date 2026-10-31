'use strict'
// The fire reflex pours a carried water bucket at the feet of a burning body and takes the water back.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { reflexIn, botConstant, fakeClock, loadBotFunctions, runRoute, routeHandler, claimRescue } = require('./helpers')
const { QUIET_MS, LONG_QUIET_MS, legLedger } = require('../lib/leg-ledger')
const { ambientChange } = require('../lib/wake')
const BIOMES = require('minecraft-data')('1.21.11').biomesByName

const AIR = { name: 'air', boundingBox: 'empty' }
const FIRE = { name: 'fire', boundingBox: 'empty' }
const WATER = { name: 'water', boundingBox: 'empty', metadata: 0 }
const FLOWING = { name: 'water', boundingBox: 'empty', metadata: 1 }
const STONE = { name: 'stone', boundingBox: 'block' }
const SLAB = { name: 'stone_slab', boundingBox: 'block' }
const FEET = new Vec3(0, 64, 0)
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => FEET.offset(x, 0, z))
const SWORD = { name: 'iron_sword', type: 1, count: 1 }
const WATER_BUCKET = { name: 'water_bucket', type: 2, count: 1 }
const BUCKET = { name: 'bucket', type: 3, count: 1 }
const DIRT = { name: 'dirt', type: 4, count: 64 }
const ck = (x, y, z) => x + ',' + y + ',' + z

// A burning body at 0,64,0 in biome standing on under, roof at y 70, its water bucket in hotbar slot 1 or with fullHotbar
// in the pockets. pour, take and outMs (null: none) time the server's answers. Poured water flows beside the feet.
// hand(clock) returns the holdHand and endHand the reflex uses instead of the recorded lease.
function fireRig ({ feet = AIR, under = STONE, roof = AIR, raining = false, biome = BIOMES.plains, dimension = 'overworld', bucket = true, fullHotbar = false, ws = {}, bed = null, building = false, pour = { turnMs: 100, blockMs: 50 }, take = { turnMs: 100, blockMs: 50 }, outMs = 60, handTaken = false, hand = null } = {}) {
  const clock = fakeClock()
  const cells = new Map([[FEET.toString(), feet], [FEET.offset(0, -1, 0).toString(), under]])
  const blockAt = (p) => ({ ...(cells.get(p.toString()) ?? (p.y < 64 ? STONE : p.y === 70 ? roof : AIR)), position: p, biome })
  const place = (p, block) => {
    const old = blockAt(p)
    cells.set(p.toString(), block)
    bot.emit('blockUpdate', old, blockAt(p))
  }
  const inventory = Object.assign(new EventEmitter(), { hotbarStart: 36, slots: [] })
  const setSlot = (slot, item) => {
    const old = inventory.slots[slot]
    inventory.slots[slot] = item && { ...item, slot }
    inventory.emit('updateSlot', slot, old, inventory.slots[slot])
  }
  setSlot(36, SWORD)
  if (fullHotbar) for (let s = 37; s < 45; s++) setSlot(s, DIRT)
  if (bucket) setSlot(fullHotbar ? 9 : 37, WATER_BUCKET)
  inventory.items = () => inventory.slots.filter(Boolean)
  const seen = { uses: [], burningAtUse: [], pitchAtUse: [], looks: [], takes: [], renews: [], ended: [], events: [] }
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, metadata: [1], yaw: 0, pitch: 0 },
    game: { dimension, minY: 0, height: 256 },
    isRaining: raining,
    inventory,
    quickBarSlot: 0,
    time: { age: 0 },
    blockAt,
    equip: async (item) => {
      let dest = item.slot
      if (dest < 36) {
        dest = 36 + bot.quickBarSlot
        for (let s = 44; s >= 36; s--) if (!inventory.slots[s]) dest = s
        const was = inventory.slots[dest]
        setSlot(dest, inventory.slots[item.slot])
        setSlot(item.slot, was)
      }
      bot.quickBarSlot = dest - 36
      bot.emit('heldItemChanged', bot.heldItem)
    },
    look: async (yaw, pitch) => {
      seen.looks.push(pitch)
      bot.entity.pitch = pitch
    },
    activateItem () {
      const slot = inventory.hotbarStart + bot.quickBarSlot
      const held = inventory.slots[slot]?.name
      seen.uses.push(held)
      seen.burningAtUse.push(bot.entity.metadata[0] === 1)
      seen.pitchAtUse.push(bot.entity.pitch)
      if (!/bucket$/.test(held)) return
      const full = held === 'water_bucket'
      const answer = full ? pour : take
      if (answer.turnMs === null) return
      clock.setTimeout(() => setSlot(slot, full ? BUCKET : WATER_BUCKET), answer.turnMs)
      clock.setTimeout(() => {
        place(FEET, full ? WATER : AIR)
        if (full && outMs !== null) clock.setTimeout(() => { bot.entity.metadata[0] = 0; bot.emit('entityUpdate', bot.entity) }, outMs)
        clock.setTimeout(() => { for (const p of SIDES) place(p, full ? FLOWING : AIR) }, full ? 100 : 300)
      }, answer.blockMs)
    },
    deactivateItem () {}
  })
  Object.defineProperty(bot, 'heldItem', { get: () => inventory.slots[inventory.hotbarStart + bot.quickBarSlot] })
  clock.setInterval(() => { bot.time.age++; bot.emit('time') }, 50)
  const legs = legLedger()
  const combat = { name: 'combat', _fleeUntil: 0, _coverUntil: 0, _holdUntil: 0 }
  const lease = { over: false, renew (ms) { seen.renews.push(ms); return !this.over && !(handTaken && seen.renews.length > 1) } }
  const recentOwnEdits = new Map()
  const real = hand && hand(clock)
  const env = {
    bot,
    Vec3,
    shared: { bed },
    bunker: { building },
    legs,
    reflexes: [combat],
    takeLegs: (reflex, why) => { seen.takes.push(reflex); legs.take(reflex, why, clock.now()) },
    stopPath () {},
    waterState: () => ({ inWater: false, inLava: false, ...ws }),
    holdHand: real ? real.holdHand : () => lease,
    endHand: real ? real.endHand : (l) => { seen.ended.push(l === lease); l.over = true },
    emitEvent: (kind, msg) => { seen.events.push(`${kind}: ${msg}`) },
    perceived: () => true,
    seenNow: () => true,
    compass: () => 'E',
    ck,
    ambientChange,
    recentOwnEdits,
    stampOwnEdit: (p) => { recentOwnEdits.set(ck(p.x, p.y, p.z), clock.now()) },
    changeBuf: [],
    lastChangeEmit: 0,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now },
    BUCKET_WAIT_MS: botConstant('BUCKET_WAIT_MS'),
    BUCKET_WAIT_CAP_MS: botConstant('BUCKET_WAIT_CAP_MS'),
    FIRE_COOL_MS: botConstant('FIRE_COOL_MS'),
    FIRE_OUT_MS: botConstant('FIRE_OUT_MS'),
    FIRE_FLOW_MS: botConstant('FIRE_FLOW_MS'),
    FIRE_FLOW_REACH: botConstant('FIRE_FLOW_REACH'),
    SNOW_TEMP: botConstant('SNOW_TEMP')
  }
  const current = reflexIn('current_watch', env)
  env.currentWatchReflex = current
  const reflex = reflexIn('fire', env)
  loadBotFunctions(['noteWorldChange', 'worldChangeEvent'], env)
  bot.on('blockUpdate', env.noteWorldChange)
  // Runs the act as the reflex loop does, with onTick after each 10 ms.
  const act = async (onTick = () => {}) => {
    let over = false
    const end = clock.now() + 30000
    reflex.active = true
    const done = reflex.act(bot).finally(() => { over = true; reflex.active = false })
    while (!over && clock.now() < end) {
      await new Promise(setImmediate)
      clock.advance(10)
      onTick()
    }
    await done
  }
  return { bot, clock, legs, combat, lease, reflex, current, env, seen, act, place, setSlot, cell: () => cells.get(FEET.toString()) }
}

const pours = (rig) => rig.seen.uses.filter((u) => u === 'water_bucket').length

test('a burning body pours its water bucket at its feet, takes the water back and holds its sword again', async () => {
  for (const late of [false, true]) {
    const answer = late ? { turnMs: 900, blockMs: 700 } : { turnMs: 100, blockMs: 50 }
    const rig = fireRig({ pour: answer, take: answer })
    assert.strictEqual(rig.reflex.check(rig.bot), true)
    await rig.act()
    assert.deepStrictEqual(rig.seen.uses, ['water_bucket', 'bucket'], `late ${late}`)
    assert.deepStrictEqual(rig.seen.burningAtUse, [true, false], 'takes the water back once the fire is out')
    assert.ok(rig.seen.looks.every((pitch) => pitch === -Math.PI / 2), 'looks straight down')
    assert.deepStrictEqual(rig.seen.events, ['fire: on fire, poured water at 0,64,0 and picked it up again'], `late ${late}`)
    assert.deepStrictEqual([rig.bot.heldItem.name, rig.bot.inventory.slots[37].name, rig.cell()], ['iron_sword', 'water_bucket', AIR])
    assert.deepStrictEqual([rig.seen.takes, rig.seen.ended], [['fire'], [true]], 'takes the legs and ends its hand lease')
  }
})

test('a head turned away during the wait looks straight down again for the take-back', async () => {
  const rig = fireRig()
  await rig.act(() => { if (rig.seen.uses.length === 1 && rig.bot.entity.pitch !== 0) rig.bot.look(1, 0) })
  assert.deepStrictEqual(rig.seen.uses, ['water_bucket', 'bucket'])
  assert.deepStrictEqual(rig.seen.pitchAtUse, [-Math.PI / 2, -Math.PI / 2])
})

test('the fire reflex pours into a fire block at the feet, under a roof in the rain, and where the rain falls as none or snow', () => {
  const rows = {
    'fire at the feet': { feet: FIRE },
    'rain on the roof': { raining: true, roof: STONE },
    'rain over a desert': { raining: true, biome: BIOMES.desert },
    'rain over snowy plains': { raining: true, biome: BIOMES.snowy_plains }
  }
  for (const [row, setup] of Object.entries(rows)) {
    const rig = fireRig(setup)
    assert.strictEqual(rig.reflex.check(rig.bot), true, row)
  }
})

test('the fire reflex stays off where water would not help or cannot be poured', () => {
  const rows = {
    'not burning': (rig) => { rig.bot.entity.metadata[0] = 0 },
    'in the nether': { dimension: 'the_nether' },
    'in lava': { ws: { inLava: true } },
    'in water': { ws: { inWater: true } },
    'in the rain under open sky': { raining: true },
    'while the bunker is built': { building: true },
    'with a slab at the feet': { feet: SLAB },
    'over a gap': { under: AIR },
    'off the ground': (rig) => { rig.bot.entity.onGround = false },
    'with no water bucket': { bucket: false },
    'in bed': { bed: { x: 0, y: 64, z: 1 } },
    'during a combat flee': (rig) => { rig.combat._fleeUntil = 1 },
    'while combat takes cover': (rig) => { rig.combat._coverUntil = 1 },
    'while combat holds the body': (rig) => { rig.combat._holdUntil = 1 }
  }
  for (const [row, setup] of Object.entries(rows)) {
    const rig = fireRig(typeof setup === 'function' ? {} : setup)
    if (typeof setup === 'function') setup(rig)
    assert.strictEqual(rig.reflex.check(rig.bot), false, row)
  }
})

test('a walk another reflex took the legs for runs out its quiet before the pour', () => {
  const rig = fireRig()
  rig.legs.take('lava_watch', 'back away from lava', rig.clock.now())
  assert.strictEqual(rig.reflex.check(rig.bot), false, 'during the lava back-off')
  rig.clock.advance(LONG_QUIET_MS)
  assert.strictEqual(rig.reflex.check(rig.bot), true, 'after its quiet')
})

test('a combat flee keeps the water in the bucket until its goal ends, past its leg quiet', () => {
  const rig = fireRig()
  rig.legs.take('combat', 'flee', rig.clock.now())
  rig.combat._fleeUntil = rig.clock.now() + 6000
  rig.clock.advance(QUIET_MS)
  assert.strictEqual(rig.reflex.check(rig.bot), false, 'after the leg quiet, mid-flee')
  rig.clock.advance(6000 - QUIET_MS)
  assert.strictEqual(rig.reflex.check(rig.bot), true, 'after the flee')
})

test('a bucket the server does not turn cools the reflex down and is named in its event', async () => {
  const rig = fireRig({ pour: { turnMs: null, blockMs: 50 } })
  await rig.act()
  rig.bot.entity.metadata[0] = 1
  assert.deepStrictEqual([rig.seen.uses, rig.seen.events], [['water_bucket'], ['fire: on fire, the water bucket did not empty at 0,64,0']])
  assert.strictEqual(rig.bot.heldItem.name, 'iron_sword', 'the sword back in hand')
  assert.strictEqual(rig.reflex.check(rig.bot), false, 'cooling down')
  rig.clock.advance(botConstant('FIRE_COOL_MS'))
  assert.strictEqual(rig.reflex.check(rig.bot), true, 'cooled down')

  const kept = fireRig({ take: { turnMs: null, blockMs: 50 } })
  await kept.act()
  assert.deepStrictEqual(kept.seen.events, ['fire: on fire, poured water at 0,64,0, the bucket did not fill again'])
})

test('a body still burning after the take-back pours at most once per cooldown', async () => {
  const loop = async (rig, ms) => {
    const end = rig.clock.now() + ms
    while (rig.clock.now() < end) {
      if (rig.reflex.check(rig.bot)) await rig.act()
      else rig.clock.advance(300)
    }
    return pours(rig)
  }
  const burning = fireRig({ outMs: null })
  assert.strictEqual(await loop(burning, botConstant('FIRE_COOL_MS')), 1)
  assert.deepStrictEqual(burning.seen.events, ['fire: on fire, poured water at 0,64,0 and picked it up again, still burning'])
})

test('a hand taken during the pour leaves the water and the hand to the taker', async () => {
  const rig = fireRig({ handTaken: true })
  await rig.act()
  assert.deepStrictEqual(rig.seen.uses, ['water_bucket'], 'no take-back')
  assert.deepStrictEqual(rig.seen.events, ['fire: on fire, poured water at 0,64,0, the hand was taken before the water came back'])
  assert.strictEqual(rig.bot.inventory.slots[37].name, 'bucket', 'the water is left')
  assert.strictEqual(rig.bot.quickBarSlot, 1, 'the sword is not put back')
})

test('a hand lease ended or a bucket gone from the hand before the pour pours nothing', async () => {
  const rows = {
    'the hand lease ends': (rig) => { rig.lease.over = true },
    'the sword goes back in hand': (rig) => { rig.bot.quickBarSlot = 0 }
  }
  for (const [row, during] of Object.entries(rows)) {
    const rig = fireRig()
    const equip = rig.bot.equip
    rig.bot.equip = async (item) => {
      await equip(item)
      during(rig)
    }
    await rig.act()
    assert.deepStrictEqual(rig.seen.uses, [], row)
    assert.deepStrictEqual(rig.seen.events, ['fire: on fire, the hand was taken before the pour at 0,64,0'], row)
    assert.strictEqual(rig.reflex.check(rig.bot), false, `${row}: cooling down`)
  }
})

test('a bucket gone from the hand before the take-back leaves the water', async () => {
  const rig = fireRig()
  await rig.act(() => { if (rig.seen.uses.length === 1 && rig.bot.heldItem.name === 'bucket') rig.bot.quickBarSlot = 0 })
  assert.deepStrictEqual(rig.seen.uses, ['water_bucket'])
  assert.deepStrictEqual(rig.seen.events, ['fire: on fire, poured water at 0,64,0, the hand was taken before the water came back'])
})

test('with a full hotbar the sword goes back in hand, and a put-back that fails still raises the fire event', async () => {
  const full = fireRig({ fullHotbar: true })
  await full.act()
  assert.deepStrictEqual(full.seen.uses, ['water_bucket', 'bucket'])
  assert.strictEqual(full.bot.heldItem.name, 'iron_sword')
  assert.strictEqual(full.bot.inventory.slots[9].name, 'water_bucket')

  const failed = fireRig()
  const equip = failed.bot.equip
  failed.bot.equip = async (item) => {
    if (item.name !== 'water_bucket') throw new Error('window click refused')
    await equip(item)
  }
  await failed.act()
  assert.deepStrictEqual(failed.seen.events, ['fire: on fire, poured water at 0,64,0 and picked it up again'])
})

test('a pour raises no world change or current event, while a change it did not make still does', async () => {
  // current_watch holds 15 s between its alarms.
  const settled = 15001
  const rig = fireRig()
  rig.clock.advance(settled)
  const currents = []
  const watch = () => { if (rig.current.check(rig.bot)) currents.push(rig.clock.now()) }
  // Another player digs a stone 3 east under the floor while the water flows.
  await rig.act(() => {
    watch()
    if (rig.seen.uses.length === 1 && rig.cell() === WATER && rig.env.changeBuf.length === 0) rig.place(new Vec3(3, 63, 0), AIR)
  })
  for (let t = 0; t < 7000; t += 300) {
    rig.clock.advance(300)
    watch()
  }
  rig.env.worldChangeEvent()
  assert.deepStrictEqual(currents, [], 'a current event')
  assert.deepStrictEqual(rig.seen.events, ['fire: on fire, poured water at 0,64,0 and picked it up again', 'world: changed near me: stone→air E ~3'])

  // The water a pour leaves keeps flowing past the window.
  const kept = fireRig({ take: { turnMs: null, blockMs: 50 } })
  kept.clock.advance(settled)
  const keptCurrents = []
  await kept.act(() => { if (kept.current.check(kept.bot)) keptCurrents.push(kept.clock.now()) })
  kept.clock.advance(botConstant('FIRE_FLOW_MS'))
  assert.deepStrictEqual([keptCurrents, kept.current.check(kept.bot)], [[], true])
})

const POURING = 'refused: pouring water on the fire, the fire reflex holds the hand. Retry in a moment.'

// fireRig on the real hand lease, with the pilot's stop and a block_place of the client.
function handRig () {
  const guardState = { hand: null }
  const digLock = botConstant('digLock')
  const client = { write () {} }
  let hand
  const rig = fireRig({
    hand: (clock) => {
      hand = loadBotFunctions(['holdHand', 'endHand', 'wireHandLease'], { bot: { _client: client }, guardState, digLock, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
      hand.wireHandLease()
      return hand
    }
  })
  const stop = () => runRoute('/stop', {}, { bot: { clearControlStates () {} }, bunker: {}, legs: { take () {} }, stopFollow () {}, stopPath () {}, clearLane () {}, jobs: { stopAll: () => 0 }, guardState })
  return { ...rig, guardState, digLock, hand, stop, click: () => client.write('block_place', {}) }
}

test('a stop or a click during the pour leaves the hand to the fire reflex, which picks the water up again', async () => {
  const rig = handRig()
  let lease = null
  await rig.act(() => {
    if (rig.seen.uses.length !== 1 || lease) return
    lease = rig.guardState.hand
    rig.stop()
    rig.click()
  })
  assert.ok(lease, 'control: the pour holds the hand')
  assert.deepStrictEqual(rig.seen.uses, ['water_bucket', 'bucket'])
  assert.deepStrictEqual(rig.seen.events, ['fire: on fire, poured water at 0,64,0 and picked it up again'])
  assert.strictEqual(rig.guardState.hand, null, 'the pour ends its lease')
})

test('a pilot action asking for the hand during the pour is refused busy, and the pour goes on', async () => {
  const rig = handRig()
  let refusal = null
  await rig.act(() => {
    if (rig.seen.uses.length !== 1 || refusal) return
    try {
      rig.hand.holdHand()
      refusal = 'none'
    } catch (e) { refusal = [e.message, e.reason] }
  })
  assert.deepStrictEqual(refusal, [POURING, 'busy'])
  assert.deepStrictEqual(rig.seen.uses, ['water_bucket', 'bucket'])
  assert.deepStrictEqual(rig.seen.events, ['fire: on fire, poured water at 0,64,0 and picked it up again'])
})

test('a sole claim takes the hand from the pour, which leaves the water to it', async () => {
  const rig = handRig()
  let held = null
  await rig.act(() => {
    if (rig.seen.uses.length !== 1 || held) return
    claimRescue(rig.digLock)
    const rescue = rig.hand.holdHand(rig.digLock.holder)
    held = rig.guardState.hand === rescue
  })
  assert.strictEqual(held, true, 'the claim holds the hand')
  assert.deepStrictEqual(rig.seen.uses, ['water_bucket'])
  assert.deepStrictEqual(rig.seen.events, ['fire: on fire, poured water at 0,64,0, the hand was taken before the water came back'])
})

test('an equip asked for during the pour is refused, and the water bucket stays in hand', async () => {
  const rig = handRig()
  let asked = null
  await rig.act(() => {
    if (rig.seen.uses.length !== 1 || asked) return
    const { handle, res } = routeHandler('/equip', { bot: rig.bot, LEGACY_1710: false, guardState: rig.guardState, digLock: rig.digLock })
    handle({ query: { name: 'iron_sword' } }, res)
    asked = [res.error?.message, rig.bot.heldItem.name]
  })
  assert.deepStrictEqual(asked, [POURING, 'water_bucket'])
  assert.deepStrictEqual(rig.seen.events, ['fire: on fire, poured water at 0,64,0 and picked it up again'])
})

test('a goto or a follow asked for during the pour is refused before it walks, and the pour picks the water up again', async () => {
  for (const [route, query] of [['/goto', { x: '9', z: '0' }], ['/follow', { name: 'Alex' }]]) {
    const rig = handRig()
    const walks = []
    const env = {
      bot: rig.bot,
      guardState: rig.guardState,
      shared: { ready: true },
      bunker: { building: false },
      gotoQuery: (q) => ({ x: Number(q.x), z: Number(q.z) }),
      claimLane: () => 'goto',
      releaseLane () {},
      memory: { lastWaypoint: null },
      walkRoute: () => ({ end: () => ({}), walked: () => 0, mark: null }),
      stagedGoto: async () => { walks.push(route); return { arrived: true } },
      namedStop: (r) => r,
      doorBeside: () => null,
      follow: {},
      stopFollow () {},
      followTarget: () => ({ id: 1 }),
      armFollow: () => { walks.push(route) },
      followTick: async () => {},
      setInterval: rig.clock.setInterval
    }
    let res = null
    await rig.act(() => {
      if (rig.seen.uses.length !== 1 || res) return
      const run = routeHandler(route, env)
      res = run.res
      run.handle({ query }, res)
    })
    assert.deepStrictEqual([res.error?.message, res.error?.reason, walks], [POURING, 'busy', []], route)
    assert.deepStrictEqual(rig.seen.events, ['fire: on fire, poured water at 0,64,0 and picked it up again'], route)
  }
})
