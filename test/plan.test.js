'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { summarizePlan, planRisk, END_SLACK, DROP_MAX } = require('../lib/plan')
const { loadBotFunctions } = require('./helpers')

// A pathfinder node: feet at y, x and z at the cell centre.
const node = (x, y, z) => new Vec3(x + 0.5, y, z + 0.5)
const START = new Vec3(0.5, 64, 0.5)
// East along z 0: one step, a step up, a 3-block drop, a 4-block drop into water, then flat.
const PATH = [node(1, 64, 0), node(2, 65, 0), node(3, 62, 0), node(4, 58, 0), node(5, 58, 0)]
const all = () => true

test('a plan through known cells gives its length, net height change, biggest drop and end cell', () => {
  assert.deepStrictEqual(summarizePlan(START, { status: 'success', path: PATH }, all),
    { reaches: true, length: 5, rise: -6, drop: 4, end: { x: 5, y: 58, z: 0 }, unseen: false })
})

test('a failed search leaves reaches null even when the path it returned crosses only known cells', () => {
  // The search itself may have run through cells the bot never saw.
  for (const status of ['noPath', 'timeout', 'partial']) {
    assert.strictEqual(summarizePlan(START, { status, path: PATH }, all).reaches, null, status)
  }
})

test('a plan into unseen terrain stops its numbers where the cells the bot knows end', () => {
  // The drop at x 3 and everything after it lie in cells the bot never saw.
  const seen = (c) => c.x < 3
  const plan = summarizePlan(START, { status: 'success', path: PATH }, seen)
  assert.deepStrictEqual(plan, { reaches: null, length: 2, rise: 1, drop: 0, end: { x: 2, y: 65, z: 0 }, unseen: true })
  assert.strictEqual(summarizePlan(START, { status: 'noPath', path: PATH }, seen).reaches, null, 'whether it reaches stays hidden either way')
  assert.strictEqual(planRisk(plan, 58), null, 'the hidden end and the hidden drop raise no refusal')
  const floorHidden = (c) => !(c.x === 2 && c.y === 64)
  assert.deepStrictEqual(summarizePlan(START, { status: 'success', path: PATH }, floorHidden).end, { x: 1, y: 64, z: 0 }, 'an unseen floor cuts too')
})

test(`a plan is risky when it ends more than ${END_SLACK} off the y asked or drops more than ${DROP_MAX} at once`, () => {
  const plan = (endY, drop, over = {}) => ({ reaches: true, length: 10, rise: 0, drop, end: { x: 9, y: endY, z: 0 }, unseen: false, ...over })
  assert.strictEqual(planRisk(plan(66, 3), 64), null, 'control: 2 above, a 3-block drop')
  assert.strictEqual(planRisk(plan(67, 0), 64), 'it ends 3 above the y asked')
  assert.strictEqual(planRisk(plan(58, 0), 64.9), 'it ends 6 below the y asked')
  assert.strictEqual(planRisk(plan(58, 0), 64, 6), null, 'a range of 6 allows 6')
  assert.strictEqual(planRisk(plan(70, 0), undefined), null, 'no y asked')
  assert.strictEqual(planRisk(plan(58, 0, { reaches: null }), 64), null, 'the end of a plan not known to reach is not judged')
  assert.strictEqual(planRisk(plan(64, 4), 64), 'it drops 4 blocks at once')
  assert.strictEqual(planRisk(plan(60, 5), 64), 'it ends 4 below the y asked and it drops 5 blocks at once')
})

// planPath of bot.js over a search that answers partial before its last result, ending the route after endAfter ticks.
async function planWith (results, endAfter = Infinity) {
  let ticks = 0
  let goalSet = false
  const bot = {
    entity: { position: START },
    pathfinder: {
      movements: {},
      setGoal () { goalSet = true },
      * getPathFromTo () { for (const result of results) yield { result } }
    },
    waitForTicks: async () => { ticks++ }
  }
  const { planPath } = loadBotFunctions(['planPath'], { bot, routeEnd: () => (ticks >= endAfter ? 'stopped' : null) })
  return { result: await planPath({}, {}), ticks, goalSet }
}

test('planPath works the search out a tick per slice without setting a goal, and gives up when the route ends', async () => {
  const done = { status: 'success', path: PATH }
  const partial = { status: 'partial', path: [] }
  assert.deepStrictEqual(await planWith([partial, partial, done]), { result: done, ticks: 2, goalSet: false })
  assert.deepStrictEqual(await planWith([partial, partial, done], 1), { result: null, ticks: 1, goalSet: false })
})
