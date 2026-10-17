'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const { botConstant, loadBotFunctions } = require('./helpers')

const AIR = Block.fromStateId(registry.blocksByName.air.defaultState, 0)
const statesOf = (name) => {
  const b = registry.blocksByName[name]
  return Array.from({ length: b.maxStateId - b.minStateId + 1 }, (_, i) => Block.fromStateId(b.minStateId + i, 0))
}
const blockOf = (name) => Block.fromStateId(registry.blocksByName[name].defaultState, 0)

// A body standing at (0, 64, 0) with head in its head cell, feet in its feet cell, and the digs it starts.
function body (head, feet = AIR) {
  const digs = []
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    oxygenLevel: 20,
    blockAt: (p) => (p.x === 0 && p.z === 0 && p.y === 65 ? head : p.x === 0 && p.z === 0 && p.y === 64 ? feet : AIR),
    dig: async (b) => { digs.push(b.name) }
  }
  const env = { bot, OPENABLE: botConstant('OPENABLE'), equipPickFor: async () => {} }
  return {
    buried: () => loadBotFunctions(['waterState'], env).waterState().buried,
    digOutHead: () => loadBotFunctions(['digOutHead'], env).digOutHead(),
    digs
  }
}

const slab = (type) => statesOf('oak_slab').find((b) => b.getProperties().type === type && !b.getProperties().waterlogged)

test('a head in glass, a sign, a stair or a half slab is not buried', () => {
  for (const head of [blockOf('glass'), blockOf('oak_sign'), blockOf('oak_stairs'), slab('bottom')]) {
    assert.strictEqual(body(head).buried(), false, `${head.name} ${JSON.stringify(head.getProperties())}`)
  }
})

test('a head in gravel or a double slab is buried', () => {
  assert.strictEqual(body(blockOf('gravel')).buried(), true, 'gravel')
  assert.strictEqual(body(slab('double')).buried(), true, 'double oak_slab')
})

test('a body standing in a doorway is not buried and the rescue leaves the door', async () => {
  for (const open of [false, true]) {
    const doors = statesOf('oak_door').filter((b) => b.getProperties().open === open && b.getProperties().facing === 'north')
    const upper = doors.find((b) => b.getProperties().half === 'upper')
    const lower = doors.find((b) => b.getProperties().half === 'lower')
    const b = body(upper, lower)
    assert.strictEqual(b.buried(), false, `open ${open}`)
    assert.strictEqual(await b.digOutHead(), false, `open ${open}`)
    assert.deepStrictEqual(b.digs, [], `open ${open}`)
  }
})

test('the rescue digs out gravel in the head cell, never bedrock', async () => {
  const gravel = body(blockOf('gravel'))
  assert.strictEqual(await gravel.digOutHead(), true, 'gravel')
  assert.deepStrictEqual(gravel.digs, ['gravel'])
  const bedrock = body(blockOf('bedrock'))
  assert.strictEqual(await bedrock.digOutHead(), false, 'bedrock')
  assert.deepStrictEqual(bedrock.digs, [])
})
