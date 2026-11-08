'use strict'
const { EventEmitter, once } = require('node:events')
const registry = require('minecraft-data')('1.21.11')

const CHEST_WINDOW = 1
const CHEST_SLOTS = 27
// Player window pocket slots, the hotbar first.
const HOTBAR_FIRST = [...Array(9).keys()].map((i) => 36 + i).concat([...Array(27).keys()].map((i) => 9 + i))
// What each armour slot takes on 1.7.10, by 1.21 item name.
const ARMOUR_1710 = { 5: /(?:_helmet|^carved_pumpkin|_skull|_head)$/, 6: /_chestplate$/, 7: /_leggings$/, 8: /_boots$/ }

// A tag is a custom name, or { enchantment: level } for an enchanted item.
const sameTag = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function clicker (s, get, set, cap, limit = () => 64, fits = () => true) {
  return (slot, button) => {
    const cur = s.cursor
    if (slot === -999) {
      if (cur) s.dropped.push(cur)
      s.cursor = null
      return
    }
    const here = get(slot)
    const most = (name) => Math.min(cap(name), limit(slot))
    if (!cur) {
      if (!here) return
      const take = button === 0 ? here.count : Math.ceil(here.count / 2)
      s.cursor = { ...here, count: take }
      set(slot, here.count > take ? { ...here, count: here.count - take } : null)
    } else if (!fits(slot, cur)) {
      return
    } else if (!here) {
      const put = Math.min(button === 0 ? cur.count : 1, limit(slot))
      set(slot, { ...cur, count: put })
      s.cursor = cur.count > put ? { ...cur, count: cur.count - put } : null
    } else if (here.name === cur.name && sameTag(here.tag, cur.tag)) {
      const k = Math.min(button === 0 ? cur.count : 1, most(cur.name) - here.count)
      if (k <= 0) return
      here.count += k
      s.cursor = cur.count > k ? { ...cur, count: cur.count - k } : null
    } else if (cur.count <= most(cur.name)) {
      set(slot, cur)
      s.cursor = here
    }
  }
}

function notchOf (Item, x) {
  if (!x) return Item.toNotch(null)
  const it = new Item(registry.itemsByName[x.name].id, x.count)
  if (typeof x.tag === 'string') it.components = [{ type: 'custom_name', data: x.tag }]
  else if (x.tag) it.components = [{ type: 'enchantments', data: { enchantments: Object.entries(x.tag).map(([e, level]) => ({ id: registry.enchantmentsByName[e].id, level })) } }]
  return Item.toNotch(it)
}

// The tag of a client item, the inverse of notchOf.
function tagOf (item) {
  const c = item.components[0]
  if (c?.type !== 'enchantments') return c?.data
  return Object.fromEntries(c.data.enchantments.map((e) => [registry.enchantments[e.id].name, e.level]))
}

// A client window's stacks in the [slot, name, count, tag] form of the servers below.
const stacksOf = (window) => window.slots.flatMap((x, slot) => (x ? [[slot, x.name, x.count, tagOf(x)]] : []))

// A 1.7.10 server's chest and pockets, replaying each plain click. Stacks are [slot, name, count, tag], pockets in player window slots 9-44.
function server1710 (client, { chest, pockets }, caps = {}) {
  const chestSlots = Array(CHEST_SLOTS).fill(null)
  const inv = Array(46).fill(null)
  for (const [slot, name, count, tag] of chest) chestSlots[slot] = { name, count, tag }
  for (const [slot, name, count, tag] of pockets) inv[slot] = { name, count, tag }
  const s = { cursor: null, cursorAtClose: undefined, dropped: [], clicks: 0, onClick: () => {} }
  const cap = (name) => caps[name] ?? registry.itemsByName[name].stackSize
  const get = (slot) => (slot < CHEST_SLOTS ? chestSlots[slot] : inv[slot - CHEST_SLOTS + 9])
  const set = (slot, v) => { if (slot < CHEST_SLOTS) chestSlots[slot] = v; else inv[slot - CHEST_SLOTS + 9] = v }
  const click = clicker(s, get, set, cap)
  client.write = (name, data) => {
    if (name === 'window_click' && data.windowId === CHEST_WINDOW && data.mode === 0) {
      s.clicks++
      click(data.slot, data.mouseButton)
      s.onClick(data.slot)
    }
    if (name === 'close_window') {
      s.cursorAtClose = s.cursor
      if (s.cursor) {
        const free = HOTBAR_FIRST.find((i) => !inv[i])
        if (free === undefined) s.dropped.push(s.cursor)
        else inv[free] = s.cursor
        s.cursor = null
      }
    }
  }
  const sum = (slots, name) => slots.filter((x) => x && x.name === name).reduce((n, x) => n + x.count, 0)
  s.inChest = (name) => sum(chestSlots, name)
  s.inPockets = (name) => sum(inv.slice(9, 45), name)
  s.place = (slot, name, count) => set(slot, { name, count })
  s.chestStacks = () => chestSlots.flatMap((x, slot) => (x ? [[slot, x.name, x.count, x.tag]] : []))
  s.notch = (Item, windowId) => {
    const slots = windowId === 0 ? inv : [...chestSlots, ...inv.slice(9, 45)]
    return { windowId, stateId: 1, items: slots.map((x) => notchOf(Item, x)), carriedItem: Item.toNotch(null) }
  }
  return s
}

// A 1.7.10 server's player window, replaying each plain click. Stacks are [slot, name, count, tag] in window slots 5-44.
function player1710 (client, stacks) {
  const inv = Array(46).fill(null)
  for (const [slot, name, count, tag] of stacks) inv[slot] = { name, count, tag }
  const s = { cursor: null, dropped: [], held: 0 }
  const click = clicker(s, (slot) => inv[slot], (slot, v) => { inv[slot] = v }, (name) => registry.itemsByName[name].stackSize,
    (slot) => (ARMOUR_1710[slot] ? 1 : 64), (slot, x) => !ARMOUR_1710[slot] || ARMOUR_1710[slot].test(x.name))
  client.write = (name, data) => {
    if (name === 'window_click' && data.windowId === 0 && data.mode === 0) click(data.slot, data.mouseButton)
    if (name === 'held_item_slot') s.held = data.slotId
  }
  s.stacks = () => inv.flatMap((x, slot) => (x ? [[slot, x.name, x.count, x.tag]] : []))
  s.heldItem = () => inv[36 + s.held]
  s.notch = (Item) => ({ windowId: 0, stateId: 1, items: inv.map((x) => notchOf(Item, x)), carriedItem: Item.toNotch(null) })
  return s
}

async function playerBody (stacks) {
  const mineflayer = require('mineflayer')
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.end = () => {}
  const server = player1710(client, stacks)
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  await once(bot, 'inject_allowed')
  bot.loadPlugin(require('mineflayer/lib/plugins/inventory'))
  bot.loadPlugin(require('mineflayer/lib/plugins/simple_inventory'))
  client.emit('window_items', server.notch(require('prismarine-item')(bot.registry)))
  client.emit('held_item_slot', { slot: 0 })
  return { bot, server }
}

module.exports = { CHEST_WINDOW, CHEST_SLOTS, server1710, player1710, playerBody, stacksOf }
