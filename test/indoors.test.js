'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { loadBotFunctions, runRoute } = require('./helpers')

const AIR = { name: 'air', boundingBox: 'empty' }
const STONE = { name: 'stone', boundingBox: 'block' }
const ck = (x, y, z) => x + ',' + y + ',' + z
const door = (open) => ({ name: 'oak_door', boundingBox: 'block', getProperties: () => ({ open }) })

// A 5x5 stone room on open ground (floor y 63, roof y 66), doorway in the east wall at z 0, the body at its centre.
function room (doorway, known = () => true) {
  const blockAt = (p) => {
    const inside = Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2
    if (p.y <= 63) return STONE
    if (!inside || p.y > 66) return AIR
    if (p.y === 66) return STONE
    if (Math.abs(p.x) < 2 && Math.abs(p.z) < 2) return AIR
    if (p.x === 2 && p.z === 0) return doorway === 'none' ? AIR : door(doorway === 'open')
    return STONE
  }
  const env = {
    bot: { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt, game: { minY: 0, height: 256 } },
    ck,
    Vec3,
    INDOORS: new Map(),
    cellKnown: known,
    knownCell: known,
    heldLight: () => ({ light: 0, skyLight: 0 })
  }
  return env
}

function coverIn (doorway, known) {
  const { coverPhrase, overheadCover } = loadBotFunctions(['coverPhrase', 'overheadCover'], room(doorway, known))
  return coverPhrase(overheadCover())
}

test('a way out to open ground ends indoors', () => {
  assert.match(coverIn('closed'), /Indoors/, 'control: a closed door')
  assert.doesNotMatch(coverIn('none'), /Indoors/, 'an empty doorway')
  assert.doesNotMatch(coverIn('open'), /Indoors/, 'an open door')
})

test('a roof not seen in full does not read indoors', () => {
  assert.doesNotMatch(coverIn('closed', (p) => p.y !== 66), /Indoors/, 'no roof cell seen')
  assert.doesNotMatch(coverIn('closed', (p) => p.y !== 66 || (p.x === 0 && p.z === 0)), /Indoors/, 'only the roof cell overhead seen')
})

test('the map in a closed room under a seen roof says nothing of underground', () => {
  const map = (doorway) => runRoute('/map', { radius: '4' }, { ...room(doorway), require, showsNow: () => true, SURFACE: new Map() })
  assert.match(map('none').note, /UNDERGROUND/, 'control: the same roof with a way out')
  const closed = map('closed')
  assert.deepStrictEqual([closed.underground, closed.note], [false, undefined])
})
