'use strict'

const AIR = new Set(['air', 'cave_air', 'void_air'])
// Blocks that come and go by themselves: snow layers, grass and ferns, and leaves.
const AMBIENT = /^(snow|short_grass|grass|tall_grass|fern|large_fern|[a-z_]+_leaves)$/
// Ore blocks of one name this many blocks apart or closer belong to one vein.
const VEIN_GAP = 2

const loose = (name) => AIR.has(name) || AMBIENT.test(name)

// True for a block change the world makes by itself: grass spreading or dying, snow falling or melting,
// grass growing or broken, leaves decaying.
function ambientChange (from, to) {
  if ((from === 'dirt' && to === 'grass_block') || (from === 'grass_block' && to === 'dirt')) return true
  return from !== to && loose(from) && loose(to) && !(AIR.has(from) && AIR.has(to))
}

// True when an announced ore block of the same name lies within VEIN_GAP of pos.
// announced maps "x,y,z" to { name }.
function sameVein (announced, name, pos) {
  for (const [key, ore] of announced) {
    if (ore.name !== name) continue
    const [x, y, z] = key.split(',').map(Number)
    if (Math.max(Math.abs(x - pos.x), Math.abs(y - pos.y), Math.abs(z - pos.z)) <= VEIN_GAP) return true
  }
  return false
}

module.exports = { ambientChange, sameVein }
