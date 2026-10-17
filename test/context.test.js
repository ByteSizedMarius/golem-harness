'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createContext } = require('../lib/context')

test('reading an unset key throws an error naming the key', () => {
  const ctx = createContext()
  assert.throws(() => ctx.walkGoal, /walkGoal/)
})

test('then reads undefined, so awaiting the context resolves to it', async () => {
  const ctx = createContext()
  assert.strictEqual(ctx.then, undefined)
  assert.strictEqual(await ctx, ctx)
})

test('a symbol key reads through without throwing', () => {
  const ctx = createContext()
  assert.strictEqual(ctx[Symbol.iterator], undefined)
})

test('assigning undefined throws an error naming the key', () => {
  const ctx = createContext()
  assert.throws(() => { ctx.walkGoal = undefined }, /walkGoal/)
})

test('a stored value reads back, null and false included', () => {
  const ctx = createContext()
  const goal = { x: 1 }
  ctx.walkGoal = goal
  ctx.target = null
  ctx.busy = false
  assert.strictEqual(ctx.walkGoal, goal)
  assert.strictEqual(ctx.target, null)
  assert.strictEqual(ctx.busy, false)
})
