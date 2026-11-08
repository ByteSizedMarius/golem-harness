'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const mineflayer = require('mineflayer')

const VERSION = '1.21.11'
const registry = require('minecraft-data')(VERSION)
const ANVIL_WINDOW = 2
const ANVIL_TYPE = 8

// An open anvil holding a diamond sword, whose server answers the take with an experience update only when grants is true.
async function openAnvil (t, grants, gameMode = 'survival') {
  const client = new EventEmitter()
  client.version = VERSION
  client.end = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  await once(bot, 'inject_allowed')
  bot.loadPlugin(require('mineflayer/lib/plugins/inventory'))
  bot.loadPlugin(require('mineflayer/lib/plugins/experience'))
  bot.loadPlugin(require('mineflayer/lib/plugins/anvil'))
  bot.game = { gameMode }
  bot.activateBlock = async () => {}
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const Item = require('prismarine-item')(bot.registry)
  const sword = () => new Item(registry.itemsByName.diamond_sword.id, 1)
  client.emit('experience', { experienceBar: 0, level: 30, totalExperience: 1395 })
  client.write = (name, data) => {
    if (name === 'name_item' && data.name === 'Ax') {
      const named = Object.assign(sword(), { components: [{ type: 'custom_name', data: 'Ax' }] })
      client.emit('set_slot', { windowId: ANVIL_WINDOW, stateId: 1, slot: 2, item: Item.toNotch(named) })
    }
    if (name === 'window_click' && data.slot === 2 && grants) client.emit('experience', { experienceBar: 0, level: 29, totalExperience: 1332 })
  }
  const opening = bot.openAnvil({})
  client.emit('open_window', { windowId: ANVIL_WINDOW, inventoryType: ANVIL_TYPE, windowTitle: 'Repair' })
  const items = Array(39).fill(Item.toNotch(null))
  items[3] = Item.toNotch(sword())
  client.emit('window_items', { windowId: ANVIL_WINDOW, stateId: 1, items, carriedItem: Item.toNotch(null) })
  return opening
}

async function settle (t, promise, ms) {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  for (let i = 0; i < ms / 10 && !settled; i++) {
    await new Promise(setImmediate)
    t.mock.timers.tick(10)
  }
  assert.ok(settled, `still pending after ${ms} ms`)
}

test('a rename the server takes without an experience update rejects as refused', async (t) => {
  const anvil = await openAnvil(t, false)
  const renamed = anvil.rename(anvil.slots[3], 'Ax')
  await settle(t, renamed, 25000)
  await assert.rejects(renamed, { message: 'the anvil refused the rename' })
})

test('a rename the server answers with an experience update resolves', async (t) => {
  const anvil = await openAnvil(t, true)
  const renamed = anvil.rename(anvil.slots[3], 'Ax')
  await settle(t, renamed, 25000)
  await renamed
})

test('a rename in creative mode resolves without an experience update', async (t) => {
  const anvil = await openAnvil(t, false, 'creative')
  const renamed = anvil.rename(anvil.slots[3], 'Ax')
  await settle(t, renamed, 25000)
  await renamed
})
