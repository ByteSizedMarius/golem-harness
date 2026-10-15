'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { HUNG, mcpServer, call, textOf, errorText, isToolError, waitFor, delay, timed, toolNamed } = require('./helpers')

const DIG = { x: 1, y: 64, z: 1 }
const TORCH = { x: 2, y: 64, z: 2, name: 'torch' }
const ANSWER_AT_ONCE = new Set(['/scene', '/stop', '/job_stop'])

// A bot that holds every route outside ANSWER_AT_ONCE until the test releases it.
function heldBot () {
  const log = []
  const gates = []
  async function reply (url) {
    const route = url.pathname
    log.push(`start ${route}`)
    if (!ANSWER_AT_ONCE.has(route)) await new Promise((resolve) => gates.push({ route, resolve }))
    log.push(`end ${route}`)
    return { ok: true, route }
  }
  async function release (route) {
    const held = () => gates.findIndex((g) => g.route === route)
    assert.ok(await waitFor(() => held() >= 0, 2000), `${route} never reached the bot`)
    gates.splice(held(), 1)[0].resolve()
  }
  return { log, reply, release }
}

const textsOf = (r) => r.result.content.map((c) => c.text)
const waitedOf = (r) => textsOf(r).filter((t) => t.startsWith('Waited '))

test('two body calls sent together reach the bot one after the other, in the order sent', async () => {
  const bot = heldBot()
  const { srv } = mcpServer({ reply: bot.reply })
  const dig = call(srv, 'digat', DIG)
  const place = call(srv, 'placeitem', TORCH)
  await waitFor(() => bot.log.length > 0, 2000)
  await delay(100)
  assert.deepStrictEqual(bot.log, ['start /digat'])
  await bot.release('/digat')
  textOf(await dig)
  await bot.release('/placeitem')
  textOf(await place)
  assert.deepStrictEqual(bot.log, ['start /digat', 'end /digat', 'start /placeitem', 'end /placeitem'])
})

test('a perception call answers while one body call runs and another waits', async () => {
  const bot = heldBot()
  const { srv } = mcpServer({ reply: bot.reply })
  const dig = call(srv, 'digat', DIG)
  const place = call(srv, 'placeitem', TORCH)
  const { out } = await timed(call(srv, 'scene', {}), 2000)
  assert.notStrictEqual(out, HUNG, 'scene waited behind the body calls')
  assert.match(textOf(out), /"route":"\/scene"/)
  assert.ok(!bot.log.includes('start /placeitem'), 'placeitem ran beside digat')
  await bot.release('/digat')
  await bot.release('/placeitem')
  await Promise.all([dig, place])
})

test('a body call that waited says how long and behind which calls, one that did not says nothing', async () => {
  const bot = heldBot()
  const { srv } = mcpServer({ reply: bot.reply })
  const first = call(srv, 'digat', DIG)
  const second = call(srv, 'digat', DIG)
  const third = call(srv, 'placeitem', TORCH)
  await delay(300)
  await bot.release('/digat')
  assert.deepStrictEqual(waitedOf(await first), [])
  await bot.release('/digat')
  const [waited] = waitedOf(await second)
  assert.match(waited, /^Waited \d+(\.\d)? s behind digat\.$/)
  assert.ok(Number(waited.split(' ')[1]) >= 0.2, waited)
  await bot.release('/placeitem')
  assert.match(waitedOf(await third)[0], /^Waited \d+(\.\d)? s behind digat x2\.$/)
})

test('stop answers at once and cancels the waiting body calls, which never reach the bot', async () => {
  for (const stopper of ['stop', 'job_stop']) {
    const bot = heldBot()
    const { srv } = mcpServer({ reply: bot.reply })
    const dig = call(srv, 'digat', DIG)
    const queued = [call(srv, 'placeitem', TORCH), call(srv, 'goto', { x: 9, z: 9 })]
    await waitFor(() => bot.log.length > 0, 2000)
    const stopped = await timed(call(srv, stopper, stopper === 'job_stop' ? { id: 1 } : {}), 2000)
    assert.notStrictEqual(stopped.out, HUNG, `${stopper} waited behind the body calls`)
    textOf(stopped.out)
    for (const q of queued) {
      const { out } = await timed(q, 2000)
      assert.notStrictEqual(out, HUNG, `a waiting call outlived ${stopper}`)
      assert.ok(isToolError(out))
      assert.strictEqual(errorText(out), `cancelled by ${stopper} before it ran`)
    }
    await bot.release('/digat')
    textOf(await dig)
    const after = call(srv, 'placeitem', TORCH)
    await bot.release('/placeitem')
    assert.deepStrictEqual(waitedOf(await after), [], `the queue stayed blocked after ${stopper}`)
    assert.ok(!bot.log.includes('start /goto'))
    assert.strictEqual(bot.log.filter((l) => l === 'start /placeitem').length, 1)
  }
})

test('a body call still waiting at the end of its time budget answers an error and never runs', { timeout: 10000 }, async () => {
  const BUDGET = 200
  assert.strictEqual(toolNamed('lookat').timeoutMs, undefined, 'lookat runs on the request timeout')
  const bot = heldBot()
  const { srv } = mcpServer({ reply: bot.reply, requestTimeoutMs: BUDGET })
  const walk = call(srv, 'goto', { x: 9, z: 9 })
  const { out, ms } = await timed(call(srv, 'lookat', DIG), 3000)
  assert.notStrictEqual(out, HUNG, 'lookat waited past its budget')
  assert.ok(ms >= BUDGET - 20 && ms < BUDGET + 1000, `answered after ${ms} ms`)
  assert.ok(isToolError(out))
  assert.match(errorText(out), /^not run: it waited 0\.2 s behind goto, its whole time budget, and did nothing$/)
  await bot.release('/goto')
  textOf(await walk)
  assert.ok(!bot.log.includes('start /lookat'))
})
