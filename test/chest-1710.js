'use strict'
const registry = require('minecraft-data')('1.21.11')

const CHEST_WINDOW = 1
const CHEST_SLOTS = 27
// Player window pocket slots, the hotbar first.
const HOTBAR_FIRST = [...Array(9).keys()].map((i) => 36 + i).concat([...Array(27).keys()].map((i) => 9 + i))

// A 1.7.10 server's chest and pockets, replaying each plain click. Stacks are [slot, name, count, tag], pockets in player window slots 9-44.
// Stacks of one name join only with an equal tag, as 1.21 items that differ only in components do on 1.7.10.
function server1710 (client, { chest, pockets }, caps = {}) {
  const chestSlots = Array(CHEST_SLOTS).fill(null)
  const inv = Array(46).fill(null)
  for (const [slot, name, count, tag] of chest) chestSlots[slot] = { name, count, tag }
  for (const [slot, name, count, tag] of pockets) inv[slot] = { name, count, tag }
  const s = { cursor: null, cursorAtClose: undefined, dropped: [], clicks: 0, onClick: () => {} }
  const cap = (name) => caps[name] ?? registry.itemsByName[name].stackSize
  const get = (slot) => (slot < CHEST_SLOTS ? chestSlots[slot] : inv[slot - CHEST_SLOTS + 9])
  const set = (slot, v) => { if (slot < CHEST_SLOTS) chestSlots[slot] = v; else inv[slot - CHEST_SLOTS + 9] = v }
  const click = (slot, button) => {
    const cur = s.cursor
    if (slot === -999) {
      if (cur) s.dropped.push(cur)
      s.cursor = null
      return
    }
    const here = get(slot)
    if (!cur) {
      if (!here) return
      const take = button === 0 ? here.count : Math.ceil(here.count / 2)
      s.cursor = { ...here, count: take }
      set(slot, here.count > take ? { ...here, count: here.count - take } : null)
    } else if (!here) {
      const put = Math.min(button === 0 ? cur.count : 1, 64)
      set(slot, { ...cur, count: put })
      s.cursor = cur.count > put ? { ...cur, count: cur.count - put } : null
    } else if (here.name === cur.name && here.tag === cur.tag) {
      const k = Math.min(button === 0 ? cur.count : 1, cap(cur.name) - here.count)
      if (k <= 0) return
      here.count += k
      s.cursor = cur.count > k ? { ...cur, count: cur.count - k } : null
    } else if (cur.count <= cap(cur.name)) {
      set(slot, cur)
      s.cursor = here
    }
  }
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
    const item = (x) => {
      if (!x) return Item.toNotch(null)
      const it = new Item(registry.itemsByName[x.name].id, x.count)
      if (x.tag) it.components = [{ type: 'custom_name', data: x.tag }]
      return Item.toNotch(it)
    }
    const slots = windowId === 0 ? inv : [...chestSlots, ...inv.slice(9, 45)]
    return { windowId, stateId: 1, items: slots.map(item), carriedItem: Item.toNotch(null) }
  }
  return s
}

module.exports = { CHEST_WINDOW, CHEST_SLOTS, server1710 }
