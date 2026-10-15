'use strict'

const fs = require('fs')

// The block name a server with graves shows its gravestones under.
const GRAVESTONE = 'gravestone'

const isNameMap = (map) => !!map && typeof map === 'object' && !Array.isArray(map) &&
  Object.values(map).every((n) => typeof n === 'string' && n !== '')

// Maps result item names to recipes, block names to shown names and the server's item names to 1.21 ones.
function readServerOverrides (file) {
  if (file === undefined || file === '') return null
  const fail = (what) => { throw new TypeError(`GOLEM_SERVER_OVERRIDES ${file}: ${what}`) }
  let spec
  try { spec = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { fail(e.message) }
  if (!spec || !spec.ingredients || typeof spec.ingredients !== 'object' || !Array.isArray(spec.recipes)) fail('needs an ingredients object and a recipes list')
  if (!isNameMap(spec.blocks)) fail('needs a blocks object of block names to shown names')
  if (spec.items !== undefined && !isNameMap(spec.items)) fail('items must map item names to 1.21 item names')
  const recipes = new Map()
  for (const r of spec.recipes) {
    if (!r || typeof r.item !== 'string' || !Number.isInteger(r.count) || r.count < 1) fail('each recipe needs an item and a count of at least 1')
    const rows = r.inShape
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 3 ||
      !rows.every((row) => Array.isArray(row) && row.length >= 1 && row.length <= 3 && row.length === rows[0].length)) {
      fail(`${r.item} needs 1 to 3 inShape rows of one width up to 3`)
    }
    const ingredients = new Map()
    for (const key of rows.flat()) {
      if (key === null) continue
      const names = Object.hasOwn(spec.ingredients, key) && spec.ingredients[key]?.items
      if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === 'string')) fail(`${r.item} names ingredient ${key} without item names`)
      ingredients.set(key, names)
    }
    recipes.set(r.item, { count: r.count, inShape: rows, ingredients })
  }
  return { recipes, blocks: new Map(Object.entries(spec.blocks)), items: new Map(Object.entries(spec.items ?? {})) }
}

// Every block the registry builds afterwards carries the shown name.
function renameBlocks (registry, blocks) {
  for (const [from, to] of blocks) {
    const block = registry.blocksByName[from]
    if (!block) throw new Error(`the server overrides rename ${from}, a block this version lacks`)
    if (registry.blocksByName[to]) throw new Error(`the server overrides rename ${from} to ${to}, a block this version has`)
    block.name = to
    delete registry.blocksByName[from]
    registry.blocksByName[to] = block
  }
}

// One recipe per combination of ingredient items.
function overrideRecipes (overrides, name, itemsByName) {
  const recipe = overrides && overrides.get(name)
  if (!recipe) return null
  const id = (n) => {
    if (!itemsByName[n]) throw new Error(`the server recipe for ${name} names ${n}, an item this version lacks`)
    return itemsByName[n].id
  }
  let choices = [new Map()]
  for (const [key, names] of recipe.ingredients) choices = choices.flatMap((c) => names.map((n) => new Map(c).set(key, id(n))))
  return choices.map((c) => shapedRecipe(recipe.inShape.map((row) => row.map((key) => (key === null ? -1 : c.get(key)))), id(name), recipe.count))
}

// A prismarine-recipe style shaped recipe of rows of item ids, -1 for an empty cell.
function shapedRecipe (rows, id, count) {
  const delta = []
  const add = (itemId, n) => {
    const d = delta.find((e) => e.id === itemId)
    if (d) d.count += n
    else delta.push({ id: itemId, metadata: null, count: n })
  }
  for (const cell of rows.flat()) if (cell !== -1) add(cell, -1)
  add(id, count)
  return {
    result: { id, metadata: null, count },
    inShape: rows.map((row) => row.map((cell) => ({ id: cell, metadata: null, count: 1 }))),
    outShape: null,
    ingredients: null,
    delta,
    requiresTable: rows.length > 2 || rows[0].length > 2
  }
}

function craftable (recipes, table, count) {
  return recipes.filter((r) => (!r.requiresTable || table) && r.delta.every((d) => count(d.id) + d.count >= 0))
}

module.exports = { GRAVESTONE, readServerOverrides, renameBlocks, overrideRecipes, craftable }
