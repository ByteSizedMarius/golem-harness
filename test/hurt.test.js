'use strict'
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const { botSource, balanced, botConstant } = require('./helpers')

// The bot.js health listener on a full-health body whose every hit is an environmental fall.
function hurtRig () {
  const events = []
  const env = {
    bot: { health: 20, food: 20 },
    lastHp: 20,
    lastHurtEmit: 0,
    fight: { lastHit: null, lastAttrib: null, swingWait: null },
    lowFoodWarned: false,
    bunker: { building: false },
    BIG_HIT: botConstant('BIG_HIT'),
    waterState: () => null,
    emitEvent: (kind, msg) => { if (kind === 'hurt') events.push(msg) }
  }
  const src = botSource()
  const at = src.indexOf("bot.on('health', async () =>")
  const body = at < 0 ? '' : balanced(src, src.indexOf('=>', at))
  assert.ok(body, 'the hurt listener not found in bot.js')
  const listener = vm.runInContext(`(async () => ${body})`, vm.createContext(env))
  async function hit (dmg) {
    env.bot.health -= dmg
    env.fight.lastAttrib = { t: Date.now(), desc: 'fall', entity: null, ranged: false, env: true }
    await listener()
  }
  return { events, hit }
}

test('a hit of 4 or more damage emits a hurt event inside the throttle window, two smaller hits emit once', async () => {
  const { events, hit } = hurtRig()
  await hit(1)
  await hit(1)
  await hit(5)
  assert.deepStrictEqual(events.map((m) => m.match(/^took (\S+) /)[1]), ['1', '5'])
})
