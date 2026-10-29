'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter, once } = require('node:events')
const mineflayer = require('mineflayer')
const { pathfinder, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { createJobs } = require('../lib/jobs')
const { createJobBoard, bindJobBoard } = require('../lib/bot/jobs')
const { deathLedger } = require('../lib/deaths')
const digging = require('mineflayer/lib/plugins/digging')
const { HUNG, botConstant, timed, waitFor, loadBotFunctions, routeHandler } = require('./helpers')

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

test('yieldJob during the buried self-rescue dig cancels the job and leaves the rescue dig running', async () => {
  const { jobs, emitted } = registry()
  const writes = []
  const bot = Object.assign(new EventEmitter(), {
    _client: { write: (name, data) => writes.push(`${name} ${data.status}`) },
    lookAt: async () => {},
    swingArm () {},
    _updateBlockState: (p) => bot.emit(`blockUpdate:${p}`, null, { type: 0 })
  })
  digging(bot)
  bot.digTime = () => 50
  const env = { jobs, bot, digLock: botConstant('digLock'), stopPath () {} }
  const { yieldJob, wireDigGuard, claimDig, soleDig } = loadBotFunctions(['yieldJob', 'wireDigGuard', 'claimDig', 'soleDig'], env)
  wireDigGuard()
  bot.emit('spawn')
  const { id } = jobs.start('dig_tunnel e x12', untilCancelled)
  const claim = claimDig('the buried self-rescue', true)
  claim.sole = true
  const gravel = { name: 'gravel', position: new Vec3(0, 65, 0) }
  const dug = soleDig(claim, gravel)
  assert.ok(await waitFor(() => bot.targetDigBlock === gravel, 1000), 'control: the rescue dig started')
  yieldJob('combat', 'fight in melee range')
  await dug
  assert.deepStrictEqual(writes, ['block_dig 0', 'block_dig 2'])
  assert.ok(await waitFor(() => jobs.get(id).status !== 'running', 2000), 'the job kept running')
  assert.deepStrictEqual(emitted, ['dig_tunnel e x12: cancelled, the combat reflex took the legs to fight in melee range'])
})

test('a dig whose look ends during the buried self-rescue dig answers busy under the real digging plugin', async () => {
  const head = { name: 'gravel', position: new Vec3(0, 65, 0) }
  const beside = { name: 'stone', position: new Vec3(1, 65, 0) }
  const writes = []
  const cleared = []
  let endLook = null
  const bot = Object.assign(new EventEmitter(), {
    _client: {
      write: (name, data) => {
        writes.push(`${name} ${data.status} ${data.location}`)
        // The outside look ends as the rescue dig starts.
        if (data.location === head.position && data.status === 0) endLook()
      }
    },
    lookAt: (p) => p.floored().equals(beside.position) ? new Promise((resolve) => { endLook = resolve }) : Promise.resolve(),
    swingArm () {},
    _updateBlockState: (p) => {
      cleared.push(`${p}`)
      bot.emit(`blockUpdate:${p}`, null, { type: 0 })
    }
  })
  digging(bot)
  bot.digTime = () => 50
  const { wireDigGuard, claimDig, soleDig } = loadBotFunctions(['wireDigGuard', 'claimDig', 'soleDig'], { bot, digLock: botConstant('digLock') })
  wireDigGuard()
  bot.emit('spawn')
  const outside = bot.dig(beside).then(() => 'dug', (e) => [e.message, e.reason])
  assert.ok(await waitFor(() => endLook, 1000), 'control: the outside dig began its look')
  const claim = claimDig('the buried self-rescue', true)
  claim.sole = true
  const dug = soleDig(claim, head)
  assert.deepStrictEqual((await timed(outside, 1000)).out, ['busy: the buried self-rescue is running, nothing dug', 'busy'])
  assert.notStrictEqual((await timed(dug, 1000)).out, HUNG, 'the rescue dig never finished')
  assert.deepStrictEqual(writes, ['block_dig 0 (0, 65, 0)', 'block_dig 2 (0, 65, 0)'])
  assert.deepStrictEqual(cleared, ['(0, 65, 0)'])
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

test('the job list keeps the running job and the 10 newest finished ones', async (t) => {
  const { jobs } = registry()
  for (let i = 1; i <= 15; i++) {
    const { id } = jobs.start(`fish ${i}`, async () => ({ caught: i }))
    assert.ok(await waitFor(() => jobs.get(id).status === 'done', 2000), `fish ${i} kept running`)
  }
  const { id: live } = jobs.start('dig_tunnel e x12', untilCancelled)
  t.after(() => jobs.stop(live))
  assert.deepStrictEqual(jobs.list().map((j) => [j.id, j.status]), [
    ...Array.from({ length: 10 }, (_, i) => [i + 6, 'done']), [live, 'running']
  ])
  const { handle, res } = routeHandler('/job', { jobs })
  handle({ query: { id: '5' } }, res)
  assert.strictEqual(res.error && res.error.message, 'no job 5', 'a pruned id reads no job')
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

test("a job started while another job walks keeps its first goal under the real pathfinder", async () => {
  const client = new EventEmitter()
  client.version = '1.21.11'
  client.write = () => {}
  client.end = () => {}
  const bot = mineflayer.createBot({ client, username: 'Claude', loadInternalPlugins: false })
  bot.loadPlugin(pathfinder)
  await once(bot, 'inject_allowed')
  Object.assign(bot, { entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0) }, clearControlStates () {}, stopDigging () {} })
  const ctx = { bot, emitEvent () {}, stopCollect () {}, ...loadBotFunctions(['safeStop', 'stopPath'], { bot }) }
  createJobBoard(ctx)
  bindJobBoard(ctx)
  ctx.jobs.start('gather oak_log x4', async () => { bot.pathfinder.setGoal(new goals.GoalNear(20, 64, 0, 1)) })
  await new Promise(setImmediate)
  assert.ok(bot.pathfinder.goal, 'control: the gather job walks')
  const build = new goals.GoalNear(5, 64, 5, 1)
  const { id } = ctx.jobs.start('build hut 5x5h3 @5,5', async () => { bot.pathfinder.setGoal(build) })
  assert.ok(await waitFor(() => ctx.jobs.get(id).status !== 'running', 2000), 'the build job ended')
  assert.strictEqual(bot.pathfinder.goal, build)
})
