'use strict'

let shared

// Why one pass of recipe fails in inventory's pockets, or null.
function craftBlocker (inventory, recipe, legacy) {
  const { items } = shared.mcData
  const usable = (it) => !legacy || !(it.durabilityUsed > 0)
  const pockets = inventory.slots.slice(inventory.inventoryStart, inventory.inventoryEnd)
  if (legacy) {
    for (const d of recipe.delta) {
      if (d.count >= 0 || !items[d.id].maxDurability) continue
      const undamaged = pockets.reduce((n, it) => n + (it && it.type === d.id && usable(it) ? it.count : 0), 0)
      if (undamaged < -d.count) return `every ${items[d.id].name} carried is damaged, and this server crafts ${items[recipe.result.id].name} only from an undamaged one`
    }
  }
  const slots = pockets.map((it) => it && { type: it.type, count: it.count, stackSize: it.stackSize, usable: usable(it) })
  let held = null
  // Mirrors mineflayer's putSelectedItemRange.
  const stow = () => {
    while (held) {
      const join = slots.find((it) => it && it.type === held.type && it.count < it.stackSize)
      if (join) {
        const n = Math.min(held.count, join.stackSize - join.count)
        join.count += n
        held.count -= n
        if (!held.count) held = null
      } else {
        const free = slots.indexOf(null)
        if (free < 0) return false
        slots[free] = held
        held = null
      }
    }
    return true
  }
  for (const cell of [...(recipe.inShape || []).flat(), ...(recipe.ingredients || [])]) {
    if (cell.id === -1) continue
    if (!held || held.type !== cell.id) {
      const at = slots.findIndex((it) => it && it.type === cell.id && it.usable)
      // mineflayer refuses a missing ingredient itself.
      if (at < 0) return null
      const picked = slots[at]
      slots[at] = held
      held = picked
    }
    if (--held.count === 0) held = null
  }
  const noRoom = `no free pocket slot for the ${items[recipe.result.id].name}, free one and craft again`
  if (!stow()) return noRoom
  held = { type: recipe.result.id, count: recipe.result.count }
  return stow() ? null : noRoom
}

function createCraftCheck (ctx) {
  Object.assign(ctx, { craftBlocker })
}

function bindCraftCheck (ctx) {
  ({ shared } = ctx)
}

module.exports = { craftBlocker, createCraftCheck, bindCraftCheck }
