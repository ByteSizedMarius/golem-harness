'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Item = require('prismarine-item')(registry)
const { routeHandler, fakeClock, botConstant } = require('./helpers')

const AT = new Vec3(5, 64, 0)
const READ_MS = botConstant('LEGACY_CLOSE_READ_MS')

const stack = (name, count = 1, components = []) => Item.fromNotch({ itemId: registry.itemsByName[name].id, itemCount: count, components, removeComponents: [] })
const named = (it, name) => stack(it.name, it.count, [...it.components, { type: 'custom_name', data: { type: 'string', value: name } }])

// A fake clock that moves in 10 ms steps, one per event loop turn, while a timer waits.
function autoClock () {
  const clock = fakeClock()
  let moving = false
  const step = () => {
    clock.advance(10)
    if (clock.pending()) setImmediate(step)
    else moving = false
  }
  return {
    now: clock.now,
    clearTimeout: clock.clearTimeout,
    setTimeout (fn, ms) {
      const id = clock.setTimeout(fn, ms)
      if (!moving) {
        moving = true
        setImmediate(step)
      }
      return id
    }
  }
}

// A 1.7.10 server answers the close with a window 0 set_slot per changed pocket slot, or a window_items when it kept an item in the anvil.
async function renameRun (pocket, { legacy = true, level = 50, mode = 'survival', spend = 7, takes = true, refuses = false, answers = true, late = false, elsewhere = false, name = 'Occam', keeps = name, breaks = false } = {}) {
  const walks = []
  const opened = []
  const packets = []
  const clock = autoClock()
  const client = new EventEmitter()
  const inventory = { inventoryStart: 9, inventoryEnd: 45, slots: Array(46).fill(null), items: () => inventory.slots.slice(9, 45).filter(Boolean) }
  inventory.slots[9] = stack('stick', 2)
  inventory.slots[10] = pocket
  const send = (packet, fields) => {
    packets.push([packet, fields.slot])
    client.emit(packet, { windowId: 0, ...fields })
  }
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    findBlocks: ({ matching }) => (matching.includes(145) ? [AT] : []),
    blockAt: (p) => ({ name: p.equals(AT) ? 'anvil' : 'stone', position: p }),
    pathfinder: { goto: async (g) => { walks.push([g.x, g.y, g.z]) } },
    inventory,
    experience: { level },
    game: { gameMode: mode },
    _client: client,
    waitForTicks: async () => {},
    openAnvil: async () => {
      const slots = Array(39).fill(null)
      for (let i = 9; i < 45; i++) slots[i - 6] = inventory.slots[i]
      const server = [...slots]
      const atOpen = [...slots]
      const anvil = {
        slots,
        inventoryStart: 3,
        inventoryEnd: 39,
        closed: 0,
        broken: false,
        renamed: [],
        async rename (it, to) {
          anvil.renamed.push([it, to])
          const from = slots.indexOf(it)
          slots[from] = named(it, to)
          if (takes && !refuses) {
            const done = keeps === to ? slots[from] : named(it, keeps)
            server[from] = done
            if (elsewhere) {
              server[slots.indexOf(null, 3)] = done
              server[from] = null
            }
            bot.experience.level -= spend
            if (breaks) {
              // mineflayer leaves bot.inventory as it is at a server's close.
              anvil.broken = true
              bot.emit('windowClose', anvil)
              for (let i = 3; i < 39; i++) {
                if (server[i] === atOpen[i]) continue
                inventory.slots[i + 6] = server[i]
                send('set_slot', { slot: i + 6 })
              }
            }
          } else {
            server[0] = it
            server[from] = null
          }
          if (refuses) throw new Error('the anvil refused the rename')
        },
        close () {
          anvil.closed++
          // mineflayer copies the window's pockets into bot.inventory at the close.
          for (let i = 3; i < 39; i++) inventory.slots[i + 6] = slots[i]
          bot.emit('windowClose', anvil)
          // A server that closed the anvil already answers a second close with nothing.
          if (!legacy || !answers || anvil.broken) return
          const kept = server[0]
          if (kept) {
            server[atOpen.indexOf(kept)] = kept
            server[0] = null
          }
          clock.setTimeout(() => {
            if (kept) {
              for (let i = 3; i < 39; i++) inventory.slots[i + 6] = server[i]
              return send('window_items', {})
            }
            for (let i = 3; i < 39; i++) {
              if (server[i] === atOpen[i]) continue
              const answer = () => {
                inventory.slots[i + 6] = server[i]
                send('set_slot', { slot: i + 6 })
              }
              if (slots[i] === atOpen[i]) clock.setTimeout(answer, 5)
              else answer()
            }
          }, (kept ? 40 : 100) + (late ? READ_MS : 0))
        }
      }
      opened.push(anvil)
      return anvil
    }
  })
  const env = {
    shared: { ready: true },
    bot,
    cellKnown: () => true,
    seenNow: () => true,
    STATIONS: new Map(),
    resolveBlockIds: (n) => ({ anvil: [145], chipped_anvil: [146], damaged_anvil: [147] })[n] || [],
    goals,
    LEGACY_1710: legacy,
    LEGACY_CLOSE_READ_MS: READ_MS,
    POCKET_SETTLE_MS: botConstant('POCKET_SETTLE_MS'),
    emitEvent () {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  }
  const { handle, res } = routeHandler('/rename', env)
  await handle({ query: { item: pocket.name, name } }, res)
  return { reply: res.body && JSON.parse(JSON.stringify(res.body)), error: res.error && res.error.message, walks, opened, inventory, packets, repliedAt: clock.now() }
}

const sword = () => stack('diamond_sword')
const UNCONFIRMED = `the rename of diamond_sword is unconfirmed: the server did not confirm my diamond_sword pocket slots within ${READ_MS} ms of closing the anvil`

test('rename on 1.7.10 refuses before walking when the rename costs more levels than the bot has', async () => {
  for (const [pocket, level, cost] of [
    [sword(), 6, 7],
    [stack('stone', 3), 14, 15],
    [stack('stone', 64), 38, 39],
    [stack('diamond_sword', 1, [{ type: 'repair_cost', data: 45 }]), 38, 39],
    [stack('diamond_sword', 1, [{ type: 'damage', data: 500 }, { type: 'repair_cost', data: 2 }]), 8, 9]
  ]) {
    const { error, walks, opened } = await renameRun(pocket, { level })
    assert.strictEqual(error, `refused: renaming ${pocket.name} costs ${cost} levels on this server and I am level ${level}, nothing done`, `${pocket.name} x${pocket.count}`)
    assert.deepStrictEqual([walks, opened], [[], []])
  }
})

test('rename on 1.7.10 goes ahead at exactly the cost, in creative mode, and on the baseline at any level', async () => {
  for (const [pocket, opts, spent] of [
    [sword(), { level: 7 }, 7],
    [stack('diamond_sword', 1, [{ type: 'repair_cost', data: 45 }]), { level: 39, spend: 39 }, 39],
    [sword(), { level: 0, mode: 'creative', spend: 0 }, 0],
    [sword(), { level: 3, legacy: false, spend: 1 }, 1]
  ]) {
    const { reply, error, opened } = await renameRun(pocket, opts)
    assert.strictEqual(error, undefined, JSON.stringify(opts))
    assert.deepStrictEqual(reply, { renamed: 'diamond_sword', name: 'Occam', levelsSpent: spent, myLevelNow: opts.level - spent }, JSON.stringify(opts))
    assert.strictEqual(opened[0].closed, 1)
  }
})

test('rename on 1.7.10 replies renamed once the server\'s set_slot for the changed pocket slot shows the new name, before the deadline', async () => {
  const { reply, opened, inventory, packets, repliedAt } = await renameRun(sword(), { level: 20 })
  assert.deepStrictEqual(reply, { renamed: 'diamond_sword', name: 'Occam', levelsSpent: 7, myLevelNow: 13 })
  assert.deepStrictEqual([opened[0].closed, inventory.slots[10].customName], [1, { type: 'string', value: 'Occam' }])
  assert.deepStrictEqual(packets, [['set_slot', 10]])
  assert.ok(repliedAt < READ_MS, `replied at ${repliedAt} ms`)
})

test('rename on 1.7.10 reads a set_slot for an unpredicted pocket slot that follows the predicted one in the same burst', async () => {
  const { reply, error, inventory, packets } = await renameRun(sword(), { level: 20, elsewhere: true })
  assert.strictEqual(error, undefined)
  assert.deepStrictEqual(reply, { renamed: 'diamond_sword', name: 'Occam', levelsSpent: 7, myLevelNow: 13 })
  assert.deepStrictEqual([inventory.slots[10], inventory.slots[11].customName], [null, { type: 'string', value: 'Occam' }])
  assert.deepStrictEqual(packets, [['set_slot', 10], ['set_slot', 11]])
})

test('rename reports a rename the server undid, from the window_items that hands the item back at the close', async () => {
  const { reply, error, opened, packets } = await renameRun(sword(), { takes: false })
  assert.strictEqual(reply, undefined)
  assert.strictEqual(error, 'the rename did not take: the diamond_sword is in my pockets, unrenamed')
  assert.deepStrictEqual([opened[0].closed, packets], [1, [['window_items', undefined]]])
})

test('rename passes on the anvil\'s refusal after closing the anvil and reading the pockets', async () => {
  const { reply, error, opened } = await renameRun(sword(), { refuses: true })
  assert.strictEqual(reply, undefined)
  assert.strictEqual(error, 'the rename did not take (the anvil refused the rename): the diamond_sword is in my pockets, unrenamed')
  assert.strictEqual(opened[0].closed, 1)
})

test('rename on 1.7.10 calls a predicted rename unconfirmed, never undone, when the server answers nothing', async () => {
  const { reply, error, repliedAt } = await renameRun(sword(), { answers: false })
  assert.strictEqual(reply, undefined)
  assert.strictEqual(error, UNCONFIRMED)
  assert.strictEqual(repliedAt, READ_MS)
})

test('rename on 1.7.10 calls the rename unconfirmed when the server\'s set_slot comes after the deadline', async () => {
  const { reply, error } = await renameRun(sword(), { late: true })
  assert.strictEqual(reply, undefined)
  assert.strictEqual(error, UNCONFIRMED)
})

test('rename on 1.7.10 refuses a name over 30 characters before walking, and takes 30 there and 35 on the baseline', async () => {
  const long = 'A'.repeat(31)
  const { error, walks, opened } = await renameRun(sword(), { name: long })
  assert.strictEqual(error, `refused: a name on this server holds at most 30 characters and "${long}" has 31, nothing done`)
  assert.deepStrictEqual([walks, opened], [[], []])
  for (const [opts, length] of [[{}, 30], [{ legacy: false, spend: 1 }, 35]]) {
    const name = 'A'.repeat(length)
    const { reply, error } = await renameRun(sword(), { level: 20, name, ...opts })
    assert.strictEqual(error, undefined, JSON.stringify(opts))
    assert.strictEqual(reply.name, name)
  }
})

test('rename names the name the item carries after a rename that did not take, never calling a named item unrenamed', async () => {
  const kept = await renameRun(sword(), { level: 20, keeps: 'Occa' })
  assert.strictEqual(kept.error, 'the rename did not take: the diamond_sword is in my pockets named "Occa"')
  const refused = await renameRun(named(sword(), 'Ockham'), { refuses: true })
  assert.strictEqual(refused.error, 'the rename did not take (the anvil refused the rename): the diamond_sword is in my pockets named "Ockham"')
})

test('rename on 1.7.10 reads the set_slots of a server that closed the anvil before the route closes it, and sends no second close', async () => {
  const { reply, error, opened, packets } = await renameRun(sword(), { level: 20, breaks: true })
  assert.strictEqual(error, undefined)
  assert.deepStrictEqual(reply, { renamed: 'diamond_sword', name: 'Occam', levelsSpent: 7, myLevelNow: 13 })
  assert.deepStrictEqual([opened[0].closed, packets], [0, [['set_slot', 10]]])
})

test('rename on 1.7.10 reads the cost of an enchanted or named item as a lower bound', async () => {
  const sharp = registry.enchantmentsByName.sharpness.id
  for (const pocket of [
    stack('diamond_sword', 1, [{ type: 'enchantments', data: { enchantments: [{ id: sharp, level: 2 }] } }]),
    named(sword(), 'Ockham')
  ]) {
    const refused = await renameRun(pocket, { level: 6 })
    assert.strictEqual(refused.error, 'refused: renaming diamond_sword costs at least 7 levels on this server and I am level 6, nothing done', JSON.stringify(pocket.components))
    assert.deepStrictEqual([refused.walks, refused.opened], [[], []])
    const { error, opened } = await renameRun(pocket, { level: 7 })
    assert.strictEqual(error, undefined, JSON.stringify(pocket.components))
    assert.strictEqual(opened.length, 1)
  }
})

test('rename on 1.7.10 prices an unbreakable item per item, as a lower bound', async () => {
  const pocket = stack('diamond_sword', 1, [{ type: 'unbreakable' }])
  const { reply, error } = await renameRun(pocket, { level: 6, spend: 5 })
  assert.strictEqual(error, undefined)
  assert.deepStrictEqual(reply, { renamed: 'diamond_sword', name: 'Occam', levelsSpent: 5, myLevelNow: 1 })
  const refused = await renameRun(pocket, { level: 4 })
  assert.strictEqual(refused.error, 'refused: renaming diamond_sword costs at least 5 levels on this server and I am level 4, nothing done')
  assert.deepStrictEqual([refused.walks, refused.opened], [[], []])
})
