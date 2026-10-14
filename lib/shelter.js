'use strict'

// Speeds are blocks per second. SAFE_HEIGHT and SAFE_DEPTH are the blocks up or down that put the body out of reach.
const SHELTER = { REACT_S: 0.5, REACH: 2, SPEED: { zombie: 2.3, babyZombie: 5.2, spider: 4.7 }, PILLAR_BLOCK_MS: 650, SAFE_HEIGHT: 2, SAFE_DEPTH: 2, DROP_MS: 400, FIRST_CELL_MS: 540, HORIZON: 32 }

const MODES = ['auto', 'up', 'down']
const FAMILIES = new Map([
  ...['zombie', 'husk', 'zombie_villager'].map((n) => [n, 'zombie']),
  ['spider', 'spider'],
  ...['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'drowned'].map((n) => [n, 'ranged']),
  ['creeper', 'creeper']
])
// The one mode that holds against each family. A family missing here has none.
const HOLDS = new Map([['zombie', 'up'], ['spider', 'down']])

function mobFamily (name) {
  return FAMILIES.get(name) || 'other'
}

// A family with no measured speed needs an infinite lead. Anything but baby false counts as a baby.
function requiredLead ({ family, baby, buildMs }) {
  const speed = family === 'zombie' ? (baby === false ? SHELTER.SPEED.zombie : SHELTER.SPEED.babyZombie)
    : family === 'spider' ? SHELTER.SPEED.spider : Infinity
  return Math.ceil(speed * (buildMs / 1000 + SHELTER.REACT_S) + SHELTER.REACH)
}

function refusal (text) {
  return { refuse: String(text).replace(/\s+/g, ' ').trim(), then: 'flee' }
}

// A distance short of its lead never rounds up to it.
const blocks = (d) => Math.floor(d * 10) / 10

// threats: [{ name, baby, dist }]. problems: { down, up }, null where that mode can be built.
// buildMs: { down, up }, how long each mode takes to put the body out of reach.
function chooseShelter ({ requested, threats, problems, buildMs }) {
  if (!MODES.includes(requested)) return refusal(`no bunker mode ${requested}`)
  const against = new Map()
  for (const t of threats) {
    const mode = HOLDS.get(mobFamily(t.name))
    if (!mode) return refusal(`no bunker holds against ${t.name}`)
    if (!(typeof t.dist === 'number' && t.dist >= 0)) return refusal(`${t.name} at an unknown distance`)
    if (!against.has(mode)) against.set(mode, t)
  }
  if (against.size > 1) return refusal(`${against.get('up').name} and ${against.get('down').name} together, no bunker holds against both`)
  const needed = [...against.keys()][0]
  if (requested !== 'auto' && needed && needed !== requested) return refusal(`${requested} does not hold against ${against.get(needed).name}`)
  const mode = requested !== 'auto' ? requested : needed || ['down', 'up'].find((m) => problems[m] === null)
  if (!mode) return refusal(`down: ${problems.down}, up: ${problems.up}`)
  if (problems[mode] !== null) return refusal(`${mode}: ${problems[mode]}`)
  let lead = 0
  for (const t of threats) {
    const need = requiredLead({ family: mobFamily(t.name), baby: t.baby, buildMs: buildMs[mode] })
    if (!(t.dist >= need)) return refusal(`${t.name} ${blocks(t.dist)} blocks away, ${mode} needs a lead of ${need}`)
    lead = Math.max(lead, need)
  }
  return { mode, lead }
}

// A box that only touches a face of the cell is outside it.
function entityInCell (cell, entities) {
  return entities.some(({ position: p, width, height }) =>
    p.x - width / 2 < cell.x + 1 && p.x + width / 2 > cell.x &&
    p.z - width / 2 < cell.z + 1 && p.z + width / 2 > cell.z &&
    p.y < cell.y + 1 && p.y + height > cell.y)
}

// An entity type without a baby key counts as a baby. A missing value is the protocol default, an adult.
function babyFlag (metadata, metadataKeys) {
  const i = Array.isArray(metadataKeys) ? metadataKeys.findIndex((k) => k === 'baby' || k === 'is_baby') : -1
  if (i < 0) return true
  const value = metadata == null ? undefined : metadata[i]
  return value === undefined ? false : !!value
}

function upBuildMs () {
  return SHELTER.PILLAR_BLOCK_MS * SHELTER.SAFE_HEIGHT
}

// cellDigMs: the dig times of the top SAFE_DEPTH cells of the shaft.
function downBuildMs (cellDigMs) {
  return cellDigMs.reduce((sum, ms) => sum + ms + SHELTER.DROP_MS, SHELTER.FIRST_CELL_MS)
}

function expireConfirmed (map, now, maxAgeMs) {
  for (const [id, hit] of map) if (now - hit.t > maxAgeMs) map.delete(id)
}

const cell = (c) => `(${c.x},${c.y},${c.z})`

// One line on a buildBunker result.
function bunkerSummary (r) {
  if (r.error) return r.error
  if (!r.at) {
    if (!r.reached) return `no bunker built, ${r.stopped}`
    return `${r.mode === 'up' ? `pillared ${r.reached} of ${r.height} blocks` : `dug ${r.reached} of 3 cells`}, ${r.stopped}`
  }
  // An up build's placed counts its shell blocks too.
  const where = r.mode === 'up' ? `${r.stopped ? `pillared ${Math.min(r.placed, r.height)} of ${r.height} blocks` : 'on a pillar'} at ${cell(r.at)}`
    : `${r.dug === 3 ? 'dug in 3 below ground' : `dug ${r.dug} of 3 cells`} at ${cell(r.at)}`
  if (r.stopped) return `${where}, ${r.stopped}`
  const state = r.sealed ? 'sealed' : `${r.gaps.length} ${r.gaps.length === 1 ? 'gap' : 'gaps'} in the shell`
  const dig = r.exit.length ? `dig ${r.exit.map(cell).join(' and ')}, then ` : ''
  return `${where}, ${state}. To leave, ${dig}${r.mode === 'down' ? 'pillar up 3' : 'step out and drop to the ground'}.`
}

module.exports = { SHELTER, mobFamily, requiredLead, chooseShelter, entityInCell, babyFlag, upBuildMs, downBuildMs, expireConfirmed, bunkerSummary }
