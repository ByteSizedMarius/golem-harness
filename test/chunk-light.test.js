'use strict'
// Light arrays off the wire are plain nibble bytes, not big-endian longs.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const Chunk = require('prismarine-chunk')('1.21.11')

// World y 0 sits in light section 5, since light keeps one extra section below minY -64.
const SECTION_BIT = 5
const MASK = [[0, 1 << SECTION_BIT]]
const NO_MASK = [[0, 0]]

// Each cell along a row gets a different value.
function lightBytes (cx, cz, cy, base) {
  const bytes = Buffer.alloc(2048)
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = (y << 8) | (z << 4) | x
        const v = (cx * x + cz * z + cy * y + base) & 15
        bytes[i >> 1] |= v << ((i & 1) * 4)
      }
    }
  }
  return bytes
}

const blockBytes = lightBytes(1, 3, 5, 0)
const skyBytes = lightBytes(1, 7, 3, 8)
const expected = (cx, cz, cy, base, x, y, z) => (cx * x + cz * z + cy * y + base) & 15

function loaded (block, sky) {
  const column = new Chunk({ minY: -64, worldHeight: 384 })
  column.loadParsedLight([sky], [block], MASK, MASK, NO_MASK, NO_MASK)
  return column
}

function assertCells (column, cells) {
  for (const [x, y, z] of cells) {
    const pos = new Vec3(x, y, z)
    assert.strictEqual(column.getBlockLight(pos), expected(1, 3, 5, 0, x, y, z), `block light at ${x},${y},${z}`)
    assert.strictEqual(column.getSkyLight(pos), expected(1, 7, 3, 8, x, y, z), `sky light at ${x},${y},${z}`)
  }
}

const fullRow = (y, z) => Array.from({ length: 16 }, (_, x) => [x, y, z])

test('a light array from the server reads each cell\'s own nibble', () => {
  assertCells(loaded(blockBytes, skyBytes), fullRow(2, 3))
})

test('a light array reads the right nibble along z and y', () => {
  const cells = [[0, 0, 0], [15, 0, 0], [0, 0, 15], [9, 0, 15], [4, 7, 8], [15, 15, 15], [6, 15, 0], [1, 9, 12]]
  assertCells(loaded(blockBytes, skyBytes), cells)
})

test('a light array at an unaligned byte offset reads the same', () => {
  const shifted = (bytes) => {
    const backing = Buffer.alloc(bytes.length + 3)
    bytes.copy(backing, 3)
    return backing.subarray(3)
  }
  assertCells(loaded(shifted(blockBytes), shifted(skyBytes)), fullRow(11, 5))
})

test('dumpLight returns the bytes the server sent', () => {
  const dump = loaded(blockBytes, skyBytes).dumpLight()
  assert.deepStrictEqual(dump.blockLight.map(b => Buffer.from(b)), [blockBytes])
  assert.deepStrictEqual(dump.skyLight.map(b => Buffer.from(b)), [skyBytes])
})
