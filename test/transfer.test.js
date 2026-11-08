'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const mineflayer = require('mineflayer')
const inventoryPlugin = require('mineflayer/lib/plugins/inventory')
const { CHEST_WINDOW, CHEST_SLOTS, server1710 } = require('./chest-1710')

const VERSION = '1.21.11'
const registry = require('minecraft-data')(VERSION)
const id = (name) => registry.itemsByName[name].id

// Full stacks of dirt in all but the last n pocket slots.
const dirtBut = (n) => Array.from({ length: 36 - n }, (_, i) => [9 + i, 'dirt', 64])
// The chest window slot of player window slot i.
const inWindow = (i) => i - 9 + CHEST_SLOTS
// The client's view of the chest in server1710's chestStacks form.
const view = (window) => window.containerItems().map((i) => [i.slot, i.name, i.count, i.components[0]?.data])

async function openChest (contents) {
  const client = new EventEmitter()
  client.version = VERSION
  client.end = () => {}
  const server = server1710(client, contents)
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  await once(bot, 'inject_allowed')
  bot.loadPlugin(inventoryPlugin)
  const Item = require('prismarine-item')(bot.registry)
  client.emit('window_items', server.notch(Item, 0))
  const opened = once(bot, 'windowOpen')
  client.emit('open_window', { windowId: CHEST_WINDOW, inventoryType: 2, windowTitle: 'Chest' })
  client.emit('window_items', server.notch(Item, CHEST_WINDOW))
  return { bot, server, window: (await opened)[0] }
}

test('a withdrawal that runs out of pocket room puts the stack it picked up back into the chest', async () => {
  const chest = [[0, 'cobblestone', 64], [1, 'cobblestone', 64], [2, 'cobblestone', 64]]
  const { server, window } = await openChest({ chest, pockets: dirtBut(2) })
  await assert.rejects(window.withdraw(id('cobblestone'), null, 192), { message: 'destination full' })
  assert.deepStrictEqual([server.inChest('cobblestone'), server.inPockets('cobblestone'), server.cursor, window.selectedItem], [64, 128, null, null])
  window.close()
  assert.deepStrictEqual(server.dropped, [])
})

test('a deposit whose last join fills the chest puts the rest it holds back into the pockets', async () => {
  const chest = [...Array.from({ length: CHEST_SLOTS - 1 }, (_, i) => [i, 'stone', 64]), [CHEST_SLOTS - 1, 'cobblestone', 60]]
  const { server, window } = await openChest({ chest, pockets: [[36, 'cobblestone', 64]] })
  await assert.rejects(window.deposit(id('cobblestone'), null, 64), { message: 'destination full' })
  assert.deepStrictEqual([server.inChest('cobblestone'), server.inPockets('cobblestone'), server.cursor, window.selectedItem], [64, 60, null, null])
  assert.deepStrictEqual(view(window), server.chestStacks())
})

test('a held stack the full destination and source range cannot take is tossed and the error names it', async () => {
  const chest = Array.from({ length: CHEST_SLOTS }, (_, i) => [i, 'stone', 64])
  const { bot, server, window } = await openChest({ chest, pockets: [[36, 'cobblestone', 10], [37, 'cobblestone', 64]] })
  await bot.clickWindow(inWindow(36), 0, 0)
  const source = inWindow(37)
  await assert.rejects(bot.transfer({ window, itemType: id('cobblestone'), metadata: null, count: 10, sourceStart: source, sourceEnd: source + 1, destStart: 0, destEnd: CHEST_SLOTS }),
    { message: 'destination full, tossed 10 cobblestone the source had no room for' })
  assert.deepStrictEqual([server.dropped, server.inPockets('cobblestone'), server.cursor, window.selectedItem], [[{ name: 'cobblestone', count: 10, tag: undefined }], 64, null, null])
})

// Another player fills chest slot 0 once the bot picked up its stack.
function refillSlot0 (bot, server) {
  const Item = require('prismarine-item')(bot.registry)
  server.onClick = (slot) => {
    if (slot !== 0 || server.inChest('dirt')) return
    server.place(0, 'dirt', 64)
    bot._client.emit('set_slot', { windowId: CHEST_WINDOW, stateId: 1, slot: 0, item: Item.toNotch(new Item(id('dirt'), 64)) })
  }
}

test('a partial withdrawal with no source slot taking the rest tosses what the pockets have no room for, names it, and leaves the other item in place', async () => {
  const chest = [[0, 'cobblestone', 64], ...Array.from({ length: CHEST_SLOTS - 1 }, (_, i) => [i + 1, 'stone', 64])]
  const { bot, server, window } = await openChest({ chest, pockets: [...dirtBut(1), [44, 'cobblestone', 63]] })
  refillSlot0(bot, server)
  await assert.rejects(window.withdraw(id('cobblestone'), null, 1), { message: 'moved 1, tossed 63 cobblestone the source had no room for' })
  assert.deepStrictEqual([server.dropped, server.inPockets('cobblestone'), server.chestStacks()[0], server.cursor], [[{ name: 'cobblestone', count: 63, tag: undefined }], 64, [0, 'dirt', 64, undefined], null])
})

test('a partial withdrawal with no source slot taking the rest puts it into the pockets when they have room', async () => {
  const chest = [[0, 'cobblestone', 64], ...Array.from({ length: CHEST_SLOTS - 1 }, (_, i) => [i + 1, 'stone', 64])]
  const { bot, server, window } = await openChest({ chest, pockets: dirtBut(2) })
  refillSlot0(bot, server)
  await window.withdraw(id('cobblestone'), null, 1)
  assert.deepStrictEqual([server.dropped, server.inPockets('cobblestone'), server.chestStacks()[0], server.cursor, window.selectedItem], [[], 64, [0, 'dirt', 64, undefined], null, null])
})

test('a partial take from a furnace output puts the rest into the pockets, since the output takes nothing back, and never clicks it again', async () => {
  const { bot, server, window } = await openChest({ chest: [[2, 'iron_ingot', 60]], pockets: dirtBut(1) })
  const Item = require('prismarine-item')(bot.registry)
  // Slot 2 stands in for the furnace output.
  window.craftingResultSlot = 2
  const outputClicks = []
  server.onClick = (slot) => {
    if (slot === 2) outputClicks.push(slot)
    if (slot === 2 && !server.inChest('iron_ingot')) {
      server.place(2, 'iron_ingot', 10)
      bot._client.emit('set_slot', { windowId: CHEST_WINDOW, stateId: 1, slot: 2, item: Item.toNotch(new Item(id('iron_ingot'), 10)) })
    }
    // A looping put-back never lets a test timeout fire.
    if (server.clicks > 50) throw new Error('the put-back loops on the output slot')
  }
  await bot.transfer({ window, itemType: id('iron_ingot'), metadata: null, count: 3, sourceStart: 2, sourceEnd: 3, destStart: window.inventoryStart, destEnd: window.inventoryEnd })
  assert.deepStrictEqual([server.inPockets('iron_ingot'), server.chestStacks(), server.cursor, server.dropped, outputClicks], [60, [[2, 'iron_ingot', 10, undefined]], null, [], [2]])
  assert.deepStrictEqual(view(window), server.chestStacks())
})

test('a deposit skips a chest stack of the same item with other components and lands in an empty slot', async () => {
  const { server, window } = await openChest({ chest: [[0, 'filled_map', 1, 'map 1']], pockets: [[36, 'filled_map', 1, 'map 0']] })
  await window.deposit(id('filled_map'), null, 1)
  assert.deepStrictEqual(server.chestStacks(), [[0, 'filled_map', 1, 'map 1'], [1, 'filled_map', 1, 'map 0']])
  assert.deepStrictEqual(view(window), server.chestStacks())
  assert.deepStrictEqual([server.inPockets('filled_map'), server.cursor], [0, null])
})

test('a put-back skips a source stack of the same item with other components', async () => {
  const chest = [[0, 'stone', 64], [1, 'stone', 64], [2, 'stone', 1, 'Marker']]
  const { server, window } = await openChest({ chest, pockets: dirtBut(1) })
  await assert.rejects(window.withdraw(id('stone'), null, 128), { message: 'destination full' })
  assert.deepStrictEqual(server.chestStacks(), [[0, 'stone', 64, undefined], [2, 'stone', 1, 'Marker']])
  assert.deepStrictEqual(view(window), server.chestStacks())
  assert.strictEqual(server.cursor, null)
})

test('a one-at-a-time withdrawal into an empty slot joins the later items onto the first', async () => {
  const { server, window } = await openChest({ chest: [[0, 'written_book', 5, 'Signed']], pockets: dirtBut(1) })
  await window.withdraw(id('written_book'), null, 2)
  assert.deepStrictEqual([server.inChest('written_book'), server.inPockets('written_book'), server.cursor, window.selectedItem], [3, 2, null, null])
  const placed = window.slots[inWindow(44)]
  assert.deepStrictEqual([placed.name, placed.count, placed.components[0]?.data], ['written_book', 2, 'Signed'])
  assert.deepStrictEqual(view(window), server.chestStacks())
})

test('a deposit skips a chest stack an earlier one-at-a-time deposit left with other components', async () => {
  const { server, window } = await openChest({ chest: [], pockets: [[36, 'stone', 10, 'Named'], [37, 'stone', 64]] })
  await window.deposit(id('stone'), null, 1)
  await window.deposit(id('stone'), null, 64)
  assert.deepStrictEqual(server.chestStacks(), [[0, 'stone', 10, 'Named'], [1, 'stone', 55, undefined]])
  assert.deepStrictEqual(view(window), server.chestStacks())
  assert.deepStrictEqual([server.inPockets('stone'), server.cursor, window.selectedItem], [9, null, null])
})

test('half a stack picked up with a right click keeps its components', async () => {
  const { bot, server, window } = await openChest({ chest: [[0, 'stone', 1]], pockets: [[36, 'stone', 10, 'Named']] })
  await bot.clickWindow(inWindow(36), 1, 0)
  const source = inWindow(36)
  await bot.transfer({ window, itemType: id('stone'), metadata: null, count: 5, sourceStart: source, sourceEnd: source + 1, destStart: 0, destEnd: CHEST_SLOTS })
  assert.deepStrictEqual(server.chestStacks(), [[0, 'stone', 1, undefined], [1, 'stone', 5, 'Named']])
  assert.deepStrictEqual(view(window), server.chestStacks())
  assert.deepStrictEqual([server.cursor, window.selectedItem], [null, null])
})

test('withdraw refuses before any click when the open window shows full pockets and the bot inventory does not', async () => {
  const chest = [[0, 'cobblestone', 64], [1, 'cobblestone', 64]]
  const { bot, server, window } = await openChest({ chest, pockets: dirtBut(1) })
  await window.withdraw(id('cobblestone'), null, 64)
  assert.strictEqual(bot.inventory.emptySlotCount(), 1, 'the bot inventory still shows the slot the withdrawal filled')
  const clicks = server.clicks
  await assert.rejects(window.withdraw(id('cobblestone'), null, 64), { message: 'Unable to withdraw, Bot inventory is full.' })
  assert.strictEqual(server.clicks, clicks)
})

test('withdraw fills a part-full pocket stack when no pocket slot is empty and leaves the rest in the chest', async () => {
  const chest = [[0, 'cobblestone', 40], [1, 'cobblestone', 40], [2, 'cobblestone', 48]]
  const { server, window } = await openChest({ chest, pockets: dirtBut(1) })
  // A route withdrawing 128 makes one call per source stack.
  await window.withdraw(id('cobblestone'), null, 40)
  await assert.rejects(window.withdraw(id('cobblestone'), null, 40), { message: 'destination full' })
  assert.deepStrictEqual([server.inPockets('cobblestone'), server.chestStacks(), server.cursor, window.selectedItem, server.dropped], [64, [[2, 'cobblestone', 64, undefined]], null, null, []])
  assert.deepStrictEqual(view(window), server.chestStacks())
})

test('withdraw refuses before any click when the only pocket room is a stack of the item with other components', async () => {
  const { server, window } = await openChest({ chest: [[0, 'stone', 64]], pockets: [...dirtBut(1), [44, 'stone', 10, 'Named']] })
  await assert.rejects(window.withdraw(id('stone'), null, 64), { message: 'Unable to withdraw, Bot inventory is full.' })
  assert.strictEqual(server.clicks, 0)
})
