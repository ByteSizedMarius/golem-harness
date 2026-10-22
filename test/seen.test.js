'use strict'
// The cells the bot has seen are remembered per server address, dimension and world seed.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const { botConstant, wiredSource, functionSource, loadBotFunctions, wireListeners } = require('./helpers')

const ck = (x, y, z) => x + ',' + y + ',' + z
const CELL = { x: 1, y: 64, z: 0 }

function seenGameHandlers () {
  const handlers = [...wiredSource().matchAll(/^bot\.on\('game', ([A-Za-z_$][\w$]*)\)$/gm)].filter((m) => /\bSEEN\b/.test(functionSource(m[1])))
  assert.ok(handlers.length, 'no game handler of bot.js touches SEEN')
  return handlers
}

// A bot wired to the game handlers of bot.js that touch SEEN, with the seen.json text saved loaded
// as at startup, then logged in at host:port in dimension. Nothing is in lit sight.
function session ({ host = 'example.net', port = 25565, dimension = 'overworld', saved } = {}) {
  const bot = Object.assign(new EventEmitter(), { game: { dimension } })
  const env = {
    bot,
    HOST: host,
    PORT: port,
    memory: { worldSeed: '0' },
    SEEN: new Set(),
    SEEN_CAP: 10,
    SEEN_VERSION: botConstant('SEEN_VERSION'),
    SEEN_WORLDS: {},
    SURFACE: new Map(),
    SURFACE_CAP: 10,
    SURFACE_WORLDS: {},
    STATIONS: new Map(),
    STATION_CAP: 10,
    STATION_WORLDS: {},
    seenKey: null,
    seenDirty: 0,
    ck,
    seesLit: () => false,
    SIGHT_MEMO: { t: 0, cells: new Map() },
    SIGHT_MS: botConstant('SIGHT_MS'),
    console: { log () {} }
  }
  const handlers = seenGameHandlers()
  const ctx = loadBotFunctions(['loadSeen', 'seenJson', 'cellKnown', ...handlers.map((m) => m[1])], env)
  const loaded = saved === undefined ? null : ctx.loadSeen(saved)
  vm.runInContext(handlers.map((m) => m[0]).join('\n'), ctx)
  bot.emit('game')
  return {
    env,
    loaded,
    known: () => ctx.cellKnown(CELL),
    see: () => env.SEEN.add(ck(CELL.x, CELL.y, CELL.z)),
    // The top block remembered in CELL's column, as [block id, y].
    top: () => { const t = env.SURFACE.get(CELL.x + ',' + CELL.z); return t && [...t] },
    seeTop: () => env.SURFACE.set(CELL.x + ',' + CELL.z, [1, CELL.y]),
    save: () => ctx.seenJson(),
    respawn (into) {
      bot.game.dimension = into
      bot.emit('game')
    },
    // mineflayer sets spawnPoint from the spawn_position packet and emits game.
    spawnAt (x, y, z) {
      bot.spawnPoint = { x, y, z }
      bot.emit('game')
    }
  }
}

test('a cell seen in the overworld is unknown in the nether and known again back in the overworld', () => {
  const s = session()
  s.see()
  assert.strictEqual(s.known(), true, 'control: seen')
  s.respawn('overworld')
  assert.strictEqual(s.known(), true, 'a death respawn in the same dimension')
  s.respawn('the_nether')
  assert.strictEqual(s.known(), false)
  s.respawn('overworld')
  assert.strictEqual(s.known(), true)
})

test('a seen.json saved on another server address loads nothing for this one', () => {
  const first = session({ port: 25565 })
  first.see()
  const saved = first.save()
  assert.strictEqual(session({ port: 25565, saved }).known(), true, 'control: the same address')
  assert.strictEqual(session({ port: 25566, saved }).known(), false)
  assert.strictEqual(session({ host: 'other.example.net', port: 25565, saved }).known(), false)
})

test('worlds behind one address and seed share SEEN only with the same spawn point', () => {
  const first = session()
  first.spawnAt(0, 64, 0)
  first.see()
  const saved = first.save()
  const same = session({ saved })
  same.spawnAt(0, 64, 0)
  assert.strictEqual(same.known(), true, 'control: the same spawn point')
  const rebuilt = session({ saved })
  rebuilt.spawnAt(100, 70, -40)
  assert.strictEqual(rebuilt.known(), false)
})

test('the top block seen in a column comes back from seen.json in the same world only', () => {
  const first = session()
  first.seeTop()
  const saved = first.save()
  assert.deepStrictEqual(session({ saved }).top(), [1, CELL.y])
  assert.strictEqual(session({ port: 25566, saved }).top(), undefined)
  const s = session({ saved })
  s.respawn('the_nether')
  assert.strictEqual(s.top(), undefined)
  s.respawn('overworld')
  assert.deepStrictEqual(s.top(), [1, CELL.y])
})

// The keys of SEEN, SURFACE and STATIONS in recording order.
const stored = (env) => ({ seen: [...env.SEEN], surface: [...env.SURFACE.keys()], stations: [...env.STATIONS.keys()] })

test('a full memory drops the least recently seen cell, column top and station for a new one', () => {
  const env = {
    bot: { entity: { position: { y: 64 } } },
    ck,
    SEEN: new Set(),
    SEEN_CAP: 3,
    seenEdits: 0,
    OLDEST: new WeakMap(),
    SURFACE: new Map(),
    SURFACE_CAP: 3,
    surfaceEdits: 0,
    STATIONS: new Map(),
    STATION_CAP: 3,
    STATION_RE: botConstant('STATION_RE'),
    stationEdits: 0
  }
  const { markSeen } = loadBotFunctions(['markSeen'], env)
  const chest = { name: 'chest', type: 6, boundingBox: 'block' }
  for (const x of [0, 1, 2, 0, 3]) markSeen(x, 64, 0, chest)
  assert.deepStrictEqual(stored(env), {
    seen: ['2,64,0', '0,64,0', '3,64,0'],
    surface: ['2,0', '0,0', '3,0'],
    stations: ['2,64,0', '0,64,0', '3,64,0']
  })
})

test('a seen.json holding more than the caps loads the most recently seen entries', () => {
  const first = session()
  for (let x = 0; x < 12; x++) {
    first.env.SEEN.add(ck(x, 64, 0))
    first.env.SURFACE.set(x + ',0', [1, 64])
    first.env.STATIONS.set(ck(x, 64, 0), 6)
  }
  const newest = Array.from({ length: 10 }, (_, i) => i + 2)
  assert.deepStrictEqual(stored(session({ saved: first.save() }).env), {
    seen: newest.map((x) => ck(x, 64, 0)),
    surface: newest.map((x) => x + ',0'),
    stations: newest.map((x) => ck(x, 64, 0))
  })
})

// A bot over stone up to y 63, with cells mapping 'x,y,z' to a name or [name, properties].
function walker ({ cells = {}, unloaded = new Set() } = {}) {
  const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 0, 0), onGround: true }, game: { dimension: 'overworld' } })
  let reads = 0
  bot.blockAt = (p) => {
    reads++
    const k = ck(p.x, p.y, p.z)
    if (unloaded.has(k)) return null
    const [name, props] = [].concat(cells[k] || (p.y <= 63 ? 'stone' : 'air'))
    return props ? Block.fromProperties(name, props, 0) : Block.fromStateId(registry.blocksByName[name].defaultState, 0)
  }
  const env = {
    bot,
    Vec3,
    ck,
    HOST: 'example.net',
    PORT: 25565,
    memory: { worldSeed: '0' },
    SEEN: new Set(),
    SEEN_CAP: 100,
    seenEdits: 0,
    SEEN_WORLDS: {},
    OLDEST: new WeakMap(),
    SURFACE: new Map(),
    SURFACE_CAP: 100,
    surfaceEdits: 0,
    SURFACE_WORLDS: {},
    STATIONS: new Map(),
    STATION_CAP: 100,
    STATION_RE: botConstant('STATION_RE'),
    stationEdits: 0,
    STATION_WORLDS: {},
    seenKey: null,
    seenDirty: 0,
    bodyMarkedAt: null,
    console: { log () {} }
  }
  wireListeners(env, 'move')
  const handlers = seenGameHandlers()
  vm.runInContext(handlers.map((m) => m[0]).join('\n'), loadBotFunctions(handlers.map((m) => m[1]), env))
  bot.emit('game')
  return {
    bot,
    unloaded,
    reads: () => reads,
    respawn (into) {
      bot.game.dimension = into
      bot.emit('game')
    },
    move (x, y, z, onGround = true) {
      bot.entity.position = new Vec3(x, y, z)
      bot.entity.onGround = onGround
      bot.emit('move')
      return [...env.SEEN].sort()
    }
  }
}

const box = (x0, y0, z0, x1, y1, z1) => {
  const out = []
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push(ck(x, y, z))
  return out.sort()
}

test('a standing body marks the cells its hitbox overlaps and the block under it, nothing beside or above', () => {
  assert.deepStrictEqual(walker().move(0.5, 64, 0.5), box(0, 63, 0, 0, 65, 0))
  assert.deepStrictEqual(walker().move(0.7, 64, 0.5), box(0, 63, 0, 0, 65, 0), 'pressed against the face of x 1')
  assert.deepStrictEqual(walker().move(0.9, 64, 0.5), box(0, 63, 0, 1, 65, 0), 'straddling x 1')
  assert.deepStrictEqual(walker().move(0.9, 64, 0.9), box(0, 63, 0, 1, 65, 1), 'straddling a corner')
})

test('a body at a ledge edge marks the block it stands on and not the air beside it under the overhang', () => {
  const w = walker({ cells: { '1,63,0': 'air', '1,62,0': 'air' } })
  assert.deepStrictEqual(w.move(0.9, 64, 0.5), [...box(0, 64, 0, 1, 65, 0), ck(0, 63, 0)].sort())
})

test('a body beside a chest marks the block it stands on and not the chest top below its feet', () => {
  const w = walker({ cells: { '1,63,0': 'chest' } })
  assert.deepStrictEqual(w.move(0.9, 64, 0.5), [...box(0, 64, 0, 1, 65, 0), ck(0, 63, 0)].sort())
})

test('a body on a slab marks the slab and not the block under it', () => {
  const w = walker({ cells: { '0,64,0': 'stone_slab' } })
  assert.deepStrictEqual(w.move(0.5, 64.5, 0.5), box(0, 64, 0, 0, 66, 0))
})

test('a body on farmland marks the farmland and not the chest top below its feet beside it', () => {
  const w = walker({ cells: { '0,63,0': 'farmland', '1,63,0': 'chest' } })
  assert.deepStrictEqual(w.move(0.9, 63.9375, 0.5), [...box(0, 64, 0, 1, 65, 0), ck(0, 63, 0)].sort())
})

test('a body on soul sand marks the soul sand and not the bed top below its feet beside it', () => {
  const w = walker({ cells: { '0,63,0': 'soul_sand', '1,63,0': 'red_bed' } })
  assert.deepStrictEqual(w.move(0.9, 63.875, 0.5), [...box(0, 64, 0, 1, 65, 0), ck(0, 63, 0)].sort())
})

test('a body on a fence post marks the fence', () => {
  const w = walker({ cells: { '0,64,0': 'oak_fence' } })
  assert.deepStrictEqual(w.move(0.5, 65.5, 0.5), [ck(0, 64, 0), ...box(0, 65, 0, 0, 67, 0)].sort())
})

test('a body grazing the cell of a ladder on its far side does not mark the ladder', () => {
  const w = walker({ cells: { '1,64,0': ['ladder', { facing: 'west', waterlogged: false }] } })
  assert.deepStrictEqual(w.move(0.9, 64, 0.5), box(0, 63, 0, 1, 65, 0).filter((k) => k !== ck(1, 64, 0)))
})

test('a body climbing a ladder marks the ladder cells its hitbox misses the thin shape of', () => {
  const ladder = ['ladder', { facing: 'east', waterlogged: false }]
  const w = walker({ cells: { '0,64,0': ladder, '0,65,0': ladder, '0,66,0': ladder } })
  assert.deepStrictEqual(w.move(0.4875, 64, 0.5), box(0, 63, 0, 0, 65, 0), 'at the foot of the shaft')
  assert.deepStrictEqual(w.move(0.4875, 64.6, 0.5, false), box(0, 63, 0, 0, 66, 0))
  assert.deepStrictEqual(w.move(0.4875, 65.4, 0.5, false), box(0, 63, 0, 0, 67, 0))
})

test('a body walking through an open door marks both door cells', () => {
  const door = (half) => ['oak_door', { facing: 'east', half, hinge: 'left', open: true, powered: false }]
  const w = walker({ cells: { '0,64,0': door('lower'), '0,65,0': door('upper') } })
  assert.deepStrictEqual(w.move(-0.5, 64, 0.5), box(-1, 63, 0, -1, 65, 0), 'control: before the door')
  assert.deepStrictEqual(w.move(0.5, 64, 0.5), [...box(-1, 63, 0, -1, 65, 0), ...box(0, 63, 0, 0, 65, 0)].sort())
})

test('a head touching a ceiling at a whole block marks the ceiling and not the air there', () => {
  assert.strictEqual(64.2 + 1.8, 66, 'control: the head lands on the block face')
  assert.deepStrictEqual(walker({ cells: { '0,66,0': 'stone' } }).move(0.5, 64.2, 0.5, false), box(0, 64, 0, 0, 66, 0))
  assert.deepStrictEqual(walker().move(0.5, 64.2, 0.5, false), box(0, 64, 0, 0, 65, 0))
})

test('a body moving within the same cells marks a stair step once its footprint reaches the step', () => {
  const w = walker({ cells: { '1,63,0': ['oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false }] } })
  assert.ok(!w.move(0.9, 64, 0.5).includes(ck(1, 63, 0)), 'control: the footprint ends short of the step')
  assert.ok(w.move(1.25, 64, 0.5).includes(ck(1, 63, 0)))
})

test('a body in the air marks no floor', () => {
  assert.deepStrictEqual(walker().move(0.5, 65.2, 0.5, false), box(0, 65, 0, 0, 66, 0))
})

test('a riding body marks nothing', () => {
  const w = walker()
  w.bot.vehicle = { id: 3 }
  assert.deepStrictEqual(w.move(0.5, 64, 0.5), [])
  w.bot.vehicle = null
  assert.deepStrictEqual(w.move(0.5, 64, 0.5), box(0, 63, 0, 0, 65, 0), 'control: off the mount')
})

test('a body with a cell in an unloaded chunk marks nothing until a move after the chunk loads', () => {
  const w = walker({ unloaded: new Set(['0,63,0']) })
  assert.deepStrictEqual(w.move(0.5, 64, 0.5), [])
  w.unloaded.clear()
  assert.deepStrictEqual(w.move(0.5, 64, 0.5), box(0, 63, 0, 0, 65, 0))
})

test('a move event that leaves the body in place reads no block', () => {
  const w = walker()
  w.move(0.5, 64, 0.5)
  const after = w.reads()
  assert.ok(after > 0, 'control: the first move reads its cells')
  w.bot.emit('move')
  w.move(0.5, 64, 0.5)
  assert.strictEqual(w.reads(), after)
  w.move(0.55, 64, 0.45)
  assert.ok(w.reads() > after, 'control: a step inside the same cells reads again')
})

test('a body in the same cells after a world change marks them into the new world', () => {
  const w = walker()
  assert.deepStrictEqual(w.move(0.5, 64, 0.5), box(0, 63, 0, 0, 65, 0), 'control: the overworld')
  w.respawn('the_nether')
  assert.deepStrictEqual(w.move(0.5, 64, 0.5), box(0, 63, 0, 0, 65, 0))
})

test('a seen.json saved before per-world memory is dropped', () => {
  for (const saved of [JSON.stringify({ version: 2, cells: [ck(CELL.x, CELL.y, CELL.z)] }), JSON.stringify([ck(CELL.x, CELL.y, CELL.z)])]) {
    const s = session({ saved })
    assert.strictEqual(s.loaded, false, saved)
    assert.strictEqual(s.known(), false, saved)
  }
})
