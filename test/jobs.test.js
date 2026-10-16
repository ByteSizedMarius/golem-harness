'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createJobs } = require('../lib/jobs')
const { deathLedger } = require('../lib/deaths')
const { waitFor, loadBotFunctions } = require('./helpers')

function registry () {
  const emitted = []
  let stops = 0
  const deaths = deathLedger()
  const jobs = createJobs({ stop: () => { stops++ }, emit: (name, msg) => emitted.push(`${name}: ${msg}`), deaths })
  return { jobs, emitted, deaths, stops: () => stops }
}

// A job that runs until it sees its cancel flag.
const untilCancelled = async (job) => {
  while (!job.cancelled) await new Promise((resolve) => setTimeout(resolve, 2))
  return { stopped: 'cancelled' }
}

test('a job ended for a reflex says which reflex took the legs', async () => {
  const { jobs, emitted } = registry()
  const { id } = jobs.start('dig_stair up n x24', untilCancelled)
  assert.strictEqual(jobs.running(), true, 'control: the job runs')
  assert.strictEqual(jobs.yieldTo({ reflex: 'combat', why: 'fight in melee range' }), true)
  assert.ok(await waitFor(() => jobs.get(id).status !== 'running', 2000), 'the job kept running')
  assert.strictEqual(jobs.get(id).status, 'cancelled')
  assert.deepStrictEqual(emitted, ['dig_stair up n x24: cancelled, the combat reflex took the legs to fight in melee range'])
  assert.strictEqual(jobs.list()[0].takenBy, 'the combat reflex took the legs to fight in melee range')
  assert.strictEqual(jobs.running(), false)
})

test('a job stopped by the pilot or preempted names no reflex', async () => {
  const { jobs, emitted } = registry()
  const first = jobs.start('gather oak_log x16', untilCancelled).id
  const second = jobs.start('dig_tunnel e x12', untilCancelled).id
  assert.ok(await waitFor(() => jobs.get(first).status === 'cancelled', 2000), 'control: the preempted job ended')
  assert.strictEqual(jobs.stop(second), true)
  assert.ok(await waitFor(() => jobs.get(second).status === 'cancelled', 2000))
  assert.deepStrictEqual(emitted, ['gather oak_log x16: cancelled', 'dig_tunnel e x12: cancelled'])
  assert.ok(jobs.list().every((j) => j.takenBy === undefined))
})

test('a job cancelled for a reflex stops counting as running before it winds down', async () => {
  const { jobs, emitted } = registry()
  let windDown
  const { id } = jobs.start('dig_tunnel e x12', async (job) => {
    while (!job.cancelled) await new Promise((resolve) => setTimeout(resolve, 2))
    await new Promise((resolve) => { windDown = resolve })
  })
  assert.strictEqual(jobs.running(), true, 'control: the job runs')
  assert.strictEqual(jobs.yieldTo({ reflex: 'combat', why: 'fight in melee range' }), true)
  assert.ok(await waitFor(() => windDown, 2000), 'the job saw its cancel flag')
  assert.deepStrictEqual([jobs.get(id).status, jobs.running()], ['running', false], 'winding down, no longer running')
  assert.strictEqual(jobs.yieldTo({ reflex: 'lava_watch', why: 'back away from lava' }), false, 'a second reflex finds no job to end')
  windDown()
  assert.ok(await waitFor(() => emitted.length === 1, 2000))
  assert.deepStrictEqual(emitted, ['dig_tunnel e x12: cancelled, the combat reflex took the legs to fight in melee range'])
})

test('yieldJob stops the cancelled job\'s walk once, and touches no walk when no job ran', () => {
  const { jobs } = registry()
  let stops = 0
  const env = { jobs, bot: { stopDigging () {} }, stopPath: () => { stops++ } }
  const { yieldJob } = loadBotFunctions(['yieldJob'], env)
  yieldJob('combat', 'fight in melee range')
  assert.strictEqual(stops, 0, 'no job, the reflex keeps its goal')
  jobs.start('gather oak_log x16', untilCancelled)
  yieldJob('combat', 'fight in melee range')
  yieldJob('combat', 'fight in melee range')
  assert.strictEqual(stops, 1)
})

test('yieldTo with no job running cancels nothing', () => {
  const { jobs, stops } = registry()
  assert.strictEqual(jobs.yieldTo({ reflex: 'combat', why: 'flee' }), false)
  assert.strictEqual(stops(), 0, 'the reflex keeps the goal it set')
})

test('an erroring job reports its error, and one done reports done', async () => {
  const { jobs, emitted } = registry()
  const bad = jobs.start('build cabin', async () => { throw new Error('out of planks') }).id
  assert.ok(await waitFor(() => jobs.get(bad).status !== 'running', 2000))
  const good = jobs.start('fish', async () => ({ caught: 1 })).id
  assert.ok(await waitFor(() => jobs.get(good).status !== 'running', 2000))
  assert.deepStrictEqual(emitted, ['build cabin: error out of planks', 'fish: done'])
  assert.deepStrictEqual(jobs.get(good).result, { caught: 1 })
})

test('a job the body died during ends with the death message, the next job without it', async () => {
  const { jobs, emitted, deaths } = registry()
  const fatal = jobs.start('dig_tunnel e x12', async () => { deaths.died('DIED near (1,60,4)') }).id
  assert.ok(await waitFor(() => jobs.get(fatal).status !== 'running', 2000))
  const next = jobs.start('fish', async () => ({ caught: 1 })).id
  assert.ok(await waitFor(() => jobs.get(next).status !== 'running', 2000))
  assert.deepStrictEqual(emitted, ['dig_tunnel e x12: done, died: DIED near (1,60,4)', 'fish: done'])
  assert.deepStrictEqual([jobs.get(fatal).died, jobs.get(next).died], ['DIED near (1,60,4)', null])
})
