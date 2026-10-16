'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { HUNG, mcpServer, call, textOf, errorText, isToolError, waitFor, timed } = require('./helpers')

const DIG = { x: 1, y: 64, z: 1 }
const TORCH = { x: 2, y: 64, z: 2, name: 'torch' }
const ANSWER_AT_ONCE = new Set(['/scene', '/chat', '/stop', '/job_stop'])

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

test('a body call while another runs is refused at once naming the running tool, and never reaches the bot', async () => {
  const bot = heldBot()
  const { srv } = mcpServer({ reply: bot.reply })
  const dig = call(srv, 'digat', DIG)
  await waitFor(() => bot.log.length > 0, 2000)
  const { out } = await timed(call(srv, 'placeitem', TORCH), 500)
  assert.notStrictEqual(out, HUNG, 'placeitem waited for digat')
  assert.ok(isToolError(out))
  assert.match(errorText(out), /^busy: digat\b/)
  await bot.release('/digat')
  textOf(await dig)
  assert.deepStrictEqual(bot.log, ['start /digat', 'end /digat'])
})

test('info, chat, stop and job_stop calls run while a body call runs', async () => {
  const bot = heldBot()
  const { srv } = mcpServer({ reply: bot.reply })
  const dig = call(srv, 'digat', DIG)
  await waitFor(() => bot.log.length > 0, 2000)
  for (const [name, args] of [['scene', {}], ['chat', { msg: 'hi' }], ['job_stop', { id: 1 }], ['stop', {}]]) {
    const { out } = await timed(call(srv, name, args), 2000)
    assert.notStrictEqual(out, HUNG, `${name} waited for digat`)
    assert.match(textOf(out), new RegExp(`"route":"/${name}"`))
  }
  await bot.release('/digat')
  textOf(await dig)
})

test('a body call after the running one ended reaches the bot', async () => {
  const bot = heldBot()
  const { srv } = mcpServer({ reply: bot.reply })
  const dig = call(srv, 'digat', DIG)
  await bot.release('/digat')
  textOf(await dig)
  const place = call(srv, 'placeitem', TORCH)
  await bot.release('/placeitem')
  assert.match(textOf(await place), /"route":"\/placeitem"/)
  assert.deepStrictEqual(bot.log, ['start /digat', 'end /digat', 'start /placeitem', 'end /placeitem'])
})
