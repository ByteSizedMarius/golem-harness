'use strict'
// The point tests' scene: a fake bot in a flat world, the player Steve and a fresh pointing module wired to them.
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { createDescribe } = require('../lib/bot/describe')
const { createStreams } = require('../lib/bot/streams')
const { HITBOX_1710 } = require('../lib/bot/legacy-1710')
const { babyFlag } = require('../lib/shelter')
const { loadBotFunctions } = require('./helpers')

const mcData = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')('1.21.11')

const defaults = new Map()
const byName = (name) => {
  if (!defaults.has(name)) defaults.set(name, Block.fromStateId(mcData.blocksByName[name].defaultState, 0))
  return defaults.get(name)
}

function world (extra) {
  const cells = { '20,64,0': 'oak_log', '20,65,0': 'oak_log', '20,66,0': 'oak_log', ...extra }
  return (p) => {
    const c = p.floored()
    const v = cells[`${c.x},${c.y},${c.z}`] || (c.y <= 63 ? 'stone' : 'air')
    const b = typeof v === 'string' ? byName(v) : v
    return { name: b.name, shapes: b.shapes, getProperties: () => b.getProperties(), position: c }
  }
}

const MOBS = { zombie: 'hostile', creeper: 'creeper', ravager: 'heavy' }
// One head angle byte.
const STEP = 2 * Math.PI / 256
// The head angle mineflayer reads for a true angle, with held bytes the server has not resent yet.
const received = (angle, held = 0) => (Math.ceil(angle / STEP) + held) * STEP

function loadPointing (legacy) {
  for (const m of ['../lib/bot/pointing', '../lib/bot/config']) delete require.cache[require.resolve(m)]
  const was = process.env.GOLEM_MC_1710
  process.env.GOLEM_MC_1710 = legacy ? '1' : '0'
  try {
    return require('../lib/bot/pointing')
  } finally {
    if (was === undefined) delete process.env.GOLEM_MC_1710
    else process.env.GOLEM_MC_1710 = was
  }
}

function scene (t, { cells = {}, entities = [], seen = true, hidden = [], clear = () => false, sees = () => true, busy = false, at = new Vec3(10.3, 64, 0.4), crouching = false, legacy = false, held = null } = {}) {
  t.mock.timers.reset()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 })
  const { bindPointing, wirePointing } = loadPointing(legacy)
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    username: 'Claude',
    entity: { id: 1, type: 'player', username: 'Claude', position: new Vec3(0.3, 64, 0.4), width: 0.6, height: 1.8 },
    entities: {},
    registry: mcData,
    blockAt: world(cells)
  })
  const steve = { id: 7, type: 'player', username: 'Steve', name: 'player', position: at, width: 0.6, height: 1.8, crouching, heldItem: held && { name: held } }
  for (const e of [steve, ...entities]) bot.entities[e.id] = e
  const ctx = {
    bot,
    staleEntities: new Set(),
    liveEntities: () => Object.values(bot.entities),
    entityPerceptible: (e) => (e === steve ? seen : !hidden.includes(e.id)),
    losClear: (from, to) => clear(to),
    seesLit: (p) => sees(p),
    reflexes: [{ name: 'combat', fairFill: () => ({ cells: new Set() }), fightBusy: () => busy }],
    mobClass: (e) => (e.type === 'player' ? 'player' : MOBS[e.name] || 'passive'),
    hitbox: loadBotFunctions(['hitbox'], { shared: { mcData }, LEGACY_1710: legacy, HITBOX_1710, babyFlag }).hitbox,
    recentOwnEdits: new Map(),
    ck: (x, y, z) => x + ',' + y + ',' + z
  }
  createDescribe(ctx)
  createStreams(ctx)
  bindPointing(ctx)
  wirePointing()
  const from = ctx.streams.eventSeq
  const look = (target) => {
    const d = target.minus(steve.position.offset(0, !steve.crouching ? 1.62 : legacy ? 1.54 : 1.27, 0))
    steve.headYaw = Math.atan2(-d.x, -d.z)
    steve.yaw = steve.headYaw + 1
    steve.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  }
  look(new Vec3(20.5, 65.5, 0.4))
  return {
    bot,
    steve,
    look,
    swing: () => bot.emit('entitySwingArm', steve),
    change: (x, y, z, was = 'stone') => bot.emit('blockUpdate', { name: was, stateId: 1, position: new Vec3(x, y, z) }, { name: 'air', stateId: 0, position: new Vec3(x, y, z) }),
    spawn: (e, p) => { e.position = p; bot.emit('entitySpawn', e) },
    hear: (name, p) => bot.emit('soundEffectHeard', name, p),
    levelEvent: (effectId, { x, y, z }) => bot._client.emit('world_event', { effectId, location: { x, y, z }, data: 0, global: false }),
    ownEdit: (x, y, z) => ctx.recentOwnEdits.set(ctx.ck(x, y, z), Date.now()),
    stale: () => ctx.staleEntities.add(steve.id),
    hide: () => { seen = false },
    settle: () => t.mock.timers.tick(1000),
    wait: (ms) => t.mock.timers.tick(ms),
    // Ticks of 10 ms keep Date.now() inside each timer within 10 ms of its due time.
    run: (ms) => { for (let i = 0; i < ms; i += 10) t.mock.timers.tick(10) },
    events: () => ctx.eventLog.filter((e) => e.id > from && e.kind === 'point'),
    points: () => ctx.eventLog.filter((e) => e.id > from && e.kind === 'point').map((e) => e.msg)
  }
}

const twice = (s, ms = 300) => {
  s.swing()
  s.wait(ms)
  s.swing()
}

// The centre of cell 10 64 3, beside the player, off their look and hidden from the bot.
const BESIDE = new Vec3(10.5, 64.5, 3.5)
const unseenBeside = { sees: (p) => !(p.x === 10 && p.y === 64 && p.z === 3) }
const around = (cue, late = false) => (s) => {
  s.swing()
  if (!late) cue(s)
  s.wait(300)
  s.swing()
  if (late) cue(s)
}
const hearing = (name, p = BESIDE, late = false) => around((s) => s.hear(name, p), late)

const asReceived = (target) => (s) => {
  s.look(target)
  s.steve.headYaw = received(s.steve.headYaw)
  s.steve.pitch = received(s.steve.pitch)
  twice(s, 600)
}

// Liquid in every cell a look into it crosses within reach.
const pool = (liquid) => {
  const cells = {}
  for (let x = 11; x <= 19; x++) for (let y = 60; y <= 63; y++) for (let z = -3; z <= 4; z++) cells[`${x},${y},${z}`] = liquid
  return cells
}

module.exports = { mcData, Block, byName, world, STEP, received, scene, twice, BESIDE, unseenBeside, around, hearing, asReceived, pool }
