'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Chunk = require('prismarine-chunk')(registry)
const World = require('prismarine-world')(registry)
const injectBlocks = require('mineflayer/lib/plugins/blocks')

const ID = (name) => registry.blocksByName[name].id

// A bot standing at body in a world holding only the blocks build sets.
function realBot (body, build) {
  const bot = Object.assign(new EventEmitter(), {
    registry,
    _client: new EventEmitter(),
    supportFeature: registry.supportFeature,
    game: { minY: -64, height: 384, dimension: 'overworld' },
    entity: { position: body }
  })
  injectBlocks(bot, { version: '1.21.11' })
  bot.world = new World(null).sync
  const columns = new Map()
  const placed = {}
  build((x, y, z, name) => {
    const k = (x >> 4) + ',' + (z >> 4)
    if (!columns.has(k)) columns.set(k, new Chunk({ minY: -64, worldHeight: 384 }))
    columns.get(k).setBlockStateId({ x: x & 15, y, z: z & 15 }, registry.blocksByName[name].defaultState)
    ;(placed[name] ??= []).push(new Vec3(x, y, z))
  })
  for (const [k, c] of columns) bot.world.setColumn(...k.split(',').map(Number), c)
  return { bot, placed }
}

const cells = (list) => list.map((p) => [p.x, p.y, p.z])

test('findBlocks finds a block within the radius in a section diagonal to the body\'s', () => {
  const ore = realBot(new Vec3(15.5, 79, 15.5), (set) => set(32, 80, 16, 'diamond_ore')).bot
  assert.deepStrictEqual(cells(ore.findBlocks({ matching: [ID('diamond_ore')], maxDistance: 25, count: 512 })), [[32, 80, 16]])

  const door = realBot(new Vec3(15.5, 64, 15.5), (set) => { set(16, 64, 16, 'oak_door'); set(16, 65, 16, 'oak_door') }).bot
  assert.deepStrictEqual(cells(door.findBlocks({ matching: [ID('oak_door')], maxDistance: 4, count: 8 })), [[16, 64, 16], [16, 65, 16]])

  const table = realBot(new Vec3(15.5, 79, 15.5), (set) => set(16, 80, 16, 'crafting_table')).bot
  for (const maxDistance of [4, 8, 16]) {
    assert.deepStrictEqual(cells(table.findBlocks({ matching: [ID('crafting_table')], maxDistance, count: 256 })), [[16, 80, 16]], `radius ${maxDistance}`)
  }
})

test('findBlocks returns the count nearest matches when the body\'s own section holds more', () => {
  // 512 coal_ore inside a stone cube in the body's section, one more 1.4 away in the next section east.
  const body = new Vec3(15.5, 72, 15.5)
  const { bot, placed } = realBot(body, (set) => {
    for (let x = 0; x <= 9; x++) {
      for (let y = 68; y <= 77; y++) {
        for (let z = 0; z <= 9; z++) set(x, y, z, x % 9 && y > 68 && y < 77 && z % 9 ? 'coal_ore' : 'stone')
      }
    }
    set(16, 72, 14, 'coal_ore')
  })
  const point = body.floored()
  const found = bot.findBlocks({ matching: [ID('coal_ore')], maxDistance: 40, count: 40 })
  assert.deepStrictEqual(cells(found.slice(0, 1)), [[16, 72, 14]])
  const nearest = placed.coal_ore.map((p) => p.distanceTo(point)).sort((a, b) => a - b).slice(0, 40)
  assert.deepStrictEqual(found.map((p) => p.distanceTo(point)), nearest)
})

test('findBlocks leaves out matches beyond the radius', () => {
  // Tables 5 away in the body's section, 6 away in it and 5.7 away in the diagonal section.
  const { bot } = realBot(new Vec3(15.5, 64, 15.5), (set) => {
    set(15, 64, 10, 'crafting_table')
    set(15, 64, 9, 'crafting_table')
    set(19, 64, 19, 'crafting_table')
  })
  assert.deepStrictEqual(cells(bot.findBlocks({ matching: [ID('crafting_table')], maxDistance: 5, count: 8 })), [[15, 64, 10]])
})
