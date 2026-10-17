'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { deathLedger } = require('../lib/deaths')
const { hookedRoute } = require('./helpers')

function gotoEnv (walk) {
  return {
    bot: { entity: { position: new Vec3(3.5, 64, 2.5) } },
    shared: { ready: true },
    bunker: { building: false },
    claimLane: () => ({}),
    releaseLane () {},
    walkRoute: () => ({ end () {}, walked: () => 2.5, mark: 0 }),
    stagedGoto: async () => { walk(); return { arrived: false, reason: 'stalled' } },
    doorBeside: () => null
  }
}

test('a goto during which the body dies replies with the death message, the next goto without it', async () => {
  const deaths = deathLedger()
  const fatal = await hookedRoute('/goto', { x: '9', z: '9' }, gotoEnv(() => {
    deaths.heard('Claude fell from a high place')
    deaths.died('DIED near (3,64,2)')
  }), deaths)
  assert.deepStrictEqual(fatal, {
    died: 'Claude fell from a high place', ok: true, arrived: false, reason: 'stalled', walked: 2.5, cell: { x: 3, y: 64, z: 2 }
  })
  const next = await hookedRoute('/goto', { x: '9', z: '9' }, gotoEnv(() => {}), deaths)
  assert.strictEqual(next.died, undefined)
})
