'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { awaitRoute, botConstant, loadBotFunctions } = require('./helpers')

const EAST = { dir: 'e', length: '2', torch: '0' }
// Going east one step from (0, 64, 0), the wall cell (1, 64, 1) borders the corridor.
const WALL = { dir: 'e', length: '1', torch: '0' }
const UP_EAST = { dir: 'e', up: '1', steps: '2', torch: '0' }
const PICK_TYPE = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }
const STONE = { name: 'stone_pickaxe' }
const IRON = { name: 'iron_pickaxe' }
const DIAMOND = { name: 'diamond_pickaxe' }

// Runs route for a body at (0, 64, 0) in stone and returns the job's report with the cells dug, each dig as 'x,y,z pick' and the mine events.
async function pickJob (route, query, { blocks = {}, picks, held = null, stuck = [], lag = 0, legacy = false } = {}) {
  const key = (p) => `${p.x},${p.y},${p.z}`
  const opened = new Set(['0,64,0', '0,65,0'])
  const isOpen = (p) => opened.has(key(p))
  const items = picks.map((p, i) => ({ uses: Infinity, slot: 36 + i, type: PICK_TYPE[p.name], ...p }))
  const dug = []
  const digs = []
  const events = []
  const state = { cancelled: false, progress () {} }
  const inventory = Object.assign(new EventEmitter(), { emptySlotCount: () => 30, items: () => items })
  Object.defineProperty(inventory, 'slots', { get: () => { const s = new Array(46).fill(null); for (const it of items) s[it.slot] = it; return s } })
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    heldItem: items.find((it) => it.name === held) || null,
    inventory,
    async equip (item) {
      if (stuck.includes(item.name)) throw new Error('equip timed out')
      bot.heldItem = item
    },
    blockAt: (p) => {
      const name = isOpen(p) ? 'air' : blocks[key(p)] || 'stone'
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], position: p, skyLight: 0 }
    },
    async dig (b) {
      const held = bot.heldItem
      dug.push(key(b.position))
      digs.push(`${key(b.position)} ${held ? held.name : null}`)
      opened.add(key(b.position))
      const refused = !(held && held.uses > 0)
      if (legacy) {
        setTimeout(() => {
          if (refused) opened.delete(key(b.position))
          bot.emit(`blockUpdate:${b.position}`, null, bot.blockAt(b.position))
        }, refused ? 30 : 2)
      }
      if (refused) return
      const broke = --held.uses === 0
      const wear = () => {
        if (broke) { items.splice(items.indexOf(held), 1); if (bot.heldItem === held) bot.heldItem = null }
        bot.inventory.emit('updateSlot', held.slot, held, broke ? null : held)
      }
      if (lag) setTimeout(wear, lag)
      else wear()
    }
  })
  const NEIGHBOURS = botConstant('NEIGHBOURS')
  let job = null
  await awaitRoute(route, query, {
    bot,
    require,
    NEIGHBOURS,
    PICK_TIER: botConstant('PICK_TIER'),
    LEGACY_1710: legacy,
    LEGACY_DIG_CONFIRM_MS: botConstant('LEGACY_DIG_CONFIRM_MS'),
    bunker: { building: false },
    jobs: { start: (n, fn) => { job = fn(state); return { id: 1 } } },
    emitEvent: (kind, text) => { if (kind === 'mine') events.push(text) },
    refuseWhileBuilding () {},
    fillFrom: async () => null,
    macroPlaceAt: async () => ({}),
    nudgeInto: async (cell) => {
      const from = bot.entity.position.floored()
      const swept = [cell, cell.offset(0, 1, 0), ...(cell.y < from.y ? [cell.offset(0, 2, 0)] : []), ...(cell.y > from.y ? [from.offset(0, 2, 0)] : [])]
      if (!swept.every(isOpen)) return false
      bot.entity.position = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5)
      return true
    },
    canStepOutTo: (c) => isOpen(c) && isOpen(c.offset(0, 1, 0)) && !isOpen(c.offset(0, -1, 0)),
    knownCell: () => false,
    skyInSight: () => false,
    lightRange: () => Infinity,
    seesLit: (p) => NEIGHBOURS.some(([dx, dy, dz]) => isOpen(p.offset(dx, dy, dz))),
    setTimeout,
    clearTimeout
  })
  // The job's report as the client receives it.
  return { ...JSON.parse(JSON.stringify(await job)), dug, digs, events }
}

test('dig_tunnel leaves wall ore its pick cannot harvest in place and reports it skipped', async () => {
  const r = await pickJob('/dig_tunnel', WALL, { picks: [STONE], blocks: { '1,64,1': 'redstone_ore' } })
  assert.strictEqual(r.stopped, 'length reached')
  assert.deepStrictEqual(r.dug, ['1,65,0', '1,64,0'], 'dug the redstone')
  assert.deepStrictEqual([r.found, r.skipped], [{}, { redstone_ore: 1 }])
  assert.match(r.events.at(-1), /, skipped=\{"redstone_ore":1\}$/)

  const iron = await pickJob('/dig_tunnel', WALL, { picks: [IRON], blocks: { '1,64,1': 'redstone_ore' } })
  assert.deepStrictEqual([iron.dug, iron.found, iron.skipped], [['1,65,0', '1,64,0', '1,64,1'], { redstone_ore: 1 }, {}], 'control: an iron pick')
})

test('dig_tunnel stops at ore in its path its pick cannot harvest, naming the ore and the tier', async () => {
  const r = await pickJob('/dig_tunnel', EAST, { picks: [STONE], blocks: { '1,64,0': 'gold_ore' } })
  assert.strictEqual(r.stopped, 'gold_ore at 1,64,0 needs pick tier 2 (iron_pickaxe or better), holding stone_pickaxe')
  assert.deepStrictEqual([r.dug, r.found], [['1,65,0'], {}])
})

test('dig_stair stops at ore in its passage its pick cannot harvest', async () => {
  const r = await pickJob('/dig_stair', UP_EAST, { picks: [STONE], blocks: { '1,66,0': 'gold_ore' } })
  assert.strictEqual(r.stopped, 'gold_ore at 1,66,0 needs pick tier 2 (iron_pickaxe or better), holding stone_pickaxe')
  assert.deepStrictEqual(r.dug, ['0,66,0', '1,67,0'])
})

test('dig_tunnel mines with the iron pick when it carries an iron and a stone one', async () => {
  const r = await pickJob('/dig_tunnel', WALL, { picks: [STONE, IRON], blocks: { '1,64,1': 'coal_ore' } })
  assert.deepStrictEqual(r.digs, ['1,65,0 iron_pickaxe', '1,64,0 iron_pickaxe', '1,64,1 iron_pickaxe'])
})

test('dig_tunnel keeps the diamond pick out of stone while it carries an iron one', async () => {
  const r = await pickJob('/dig_tunnel', WALL, { picks: [DIAMOND, IRON], blocks: { '1,64,1': 'diamond_ore' } })
  assert.deepStrictEqual(r.digs, ['1,65,0 iron_pickaxe', '1,64,0 iron_pickaxe', '1,64,1 iron_pickaxe'])

  const only = await pickJob('/dig_tunnel', WALL, { picks: [DIAMOND, STONE], blocks: { '1,64,1': 'gold_ore' } })
  assert.deepStrictEqual(only.digs, ['1,65,0 stone_pickaxe', '1,64,0 stone_pickaxe', '1,64,1 diamond_pickaxe'], 'the diamond pick, the only one that harvests gold')
})

test('a pick choice takes a diamond pick only for a block that needs diamond or when no other pick harvests', () => {
  const choose = (names, block) => {
    const items = names.map((name) => ({ name }))
    return loadBotFunctions(['pickFor'], { bot: { inventory: { items: () => items } }, PICK_TIER: botConstant('PICK_TIER') }).pickFor(block).name
  }
  assert.strictEqual(choose(['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe'], 'obsidian'), 'diamond_pickaxe')
  assert.strictEqual(choose(['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe'], 'stone'), 'iron_pickaxe')
  assert.strictEqual(choose(['diamond_pickaxe'], 'stone'), 'diamond_pickaxe')
  assert.strictEqual(choose(['iron_pickaxe', 'stone_pickaxe'], 'obsidian'), 'iron_pickaxe', 'none harvests: the best carried')
})

test('dig_tunnel counts no ore its held pick cannot harvest when the better pick never reaches the hand', async () => {
  const wall = await pickJob('/dig_tunnel', WALL, { picks: [STONE, IRON], held: 'stone_pickaxe', stuck: ['iron_pickaxe'], blocks: { '1,64,1': 'redstone_ore' } })
  assert.deepStrictEqual([wall.dug, wall.found, wall.skipped], [['1,65,0', '1,64,0'], {}, { redstone_ore: 1 }])

  const face = await pickJob('/dig_tunnel', EAST, { picks: [STONE, IRON], held: 'stone_pickaxe', stuck: ['iron_pickaxe'], blocks: { '1,64,0': 'gold_ore' } })
  assert.deepStrictEqual([face.dug, face.found], [['1,65,0'], {}])
  assert.match(face.stopped, /^gold_ore at 1,64,0 needs pick tier 2/)

  const control = await pickJob('/dig_tunnel', EAST, { picks: [STONE, IRON], blocks: { '1,64,0': 'gold_ore' } })
  assert.deepStrictEqual([control.stopped, control.found], ['length reached', { gold_ore: 1 }], 'control: the iron pick in hand')
})

test('dig_tunnel goes on with the next best pick when its iron one breaks, and stops at ore that one cannot harvest', async () => {
  const r = await pickJob('/dig_tunnel', EAST, { picks: [{ name: 'iron_pickaxe', uses: 1 }, STONE], blocks: { '2,64,0': 'gold_ore' } })
  assert.deepStrictEqual(r.digs, ['1,65,0 iron_pickaxe', '1,64,0 stone_pickaxe', '2,65,0 stone_pickaxe'])
  assert.deepStrictEqual(r.events.filter((t) => t.includes('swapped')), ['iron_pickaxe broke, swapped to stone_pickaxe'])
  assert.strictEqual(r.stopped, 'gold_ore at 2,64,0 needs pick tier 2 (iron_pickaxe or better), holding stone_pickaxe')
})

test('on 1.7.10 dig_tunnel does not dig a resent ore again with a spare pick that cannot harvest it', async () => {
  const r = await pickJob('/dig_tunnel', EAST, { legacy: true, lag: 10, picks: [{ name: 'iron_pickaxe', uses: 1 }, STONE], blocks: { '1,64,0': 'gold_ore' } })
  assert.deepStrictEqual(r.digs, ['1,65,0 iron_pickaxe', '1,64,0 iron_pickaxe'])
  assert.strictEqual(r.stopped, 'gold_ore at 1,64,0 needs pick tier 2 (iron_pickaxe or better), holding stone_pickaxe')
})
