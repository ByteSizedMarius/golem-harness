'use strict'
// The cells the bot has seen are remembered per server address, dimension and world seed.
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const { botConstant, wiredSource, functionSource, loadBotFunctions } = require('./helpers')

const ck = (x, y, z) => x + ',' + y + ',' + z
const CELL = { x: 1, y: 64, z: 0 }

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
  const handlers = [...wiredSource().matchAll(/^bot\.on\('game', ([A-Za-z_$][\w$]*)\)$/gm)].filter((m) => /\bSEEN\b/.test(functionSource(m[1])))
  assert.ok(handlers.length, 'no game handler of bot.js touches SEEN')
  const ctx = loadBotFunctions(['loadSeen', 'seenJson', 'cellKnown', ...handlers.map((m) => m[1])], env)
  const loaded = saved === undefined ? null : ctx.loadSeen(saved)
  vm.runInContext(handlers.map((m) => m[0]).join('\n'), ctx)
  bot.emit('game')
  return {
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

test('a seen.json saved before per-world memory is dropped', () => {
  for (const saved of [JSON.stringify({ version: 2, cells: [ck(CELL.x, CELL.y, CELL.z)] }), JSON.stringify([ck(CELL.x, CELL.y, CELL.z)])]) {
    const s = session({ saved })
    assert.strictEqual(s.loaded, false, saved)
    assert.strictEqual(s.known(), false, saved)
  }
})
