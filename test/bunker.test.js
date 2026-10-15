'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const shelter = require('../lib/shelter')
const { QUIET_MS } = require('../lib/legs')
const {
  botConstant, loadBotFunctions, HERE, shelterInputsAmong, pillarProblemWith, column,
  BUILD_HIT, threat, buildHarness, halt, HALT_REASONS, digHarness, pillarHarness, bunkerDecider, actAfter, stoppedBuild
} = require('./helpers')

const mobClass = (e) => e.cls
const zombie = (dist) => threat('zombie', dist)
const spider = (dist) => threat('spider', dist)

// ---- buildBunker ----

test('a down build re-checks threats after centring and falls back to up or refuses, an up build does not centre', async () => {
  const up = buildHarness({ scenes: [{ threats: [zombie(30)] }] })
  let r = await up.ctx.buildBunker('auto', 3)
  assert.strictEqual(r.mode, 'up', `control: a zombie at 30 builds up, got ${JSON.stringify(r)}`)
  assert.deepStrictEqual(up.log, ['shelterInputs', 'chooseShelter up', 'pillarShell'], 'auto, zombie at 30')

  let h = buildHarness()
  r = await h.ctx.buildBunker('auto', 3)
  assert.strictEqual(r.mode, 'down', `control: no threats builds down, got ${JSON.stringify(r)}`)
  assert.deepStrictEqual(h.log, ['shelterInputs', 'chooseShelter down', 'centerOnCell', 'shelterInputs', 'chooseShelter down', 'digIn'], 'no threats, centred')

  h = buildHarness({ centred: false })
  r = await h.ctx.buildBunker('auto', 3)
  assert.strictEqual(r.mode, 'up', `auto, centring failed: the second pick falls back to up, got ${JSON.stringify(r)}`)
  assert.deepStrictEqual(h.log, ['shelterInputs', 'chooseShelter down', 'centerOnCell', 'shelterInputs', 'chooseShelter up', 'pillarShell'], 'auto, centring failed')

  h = buildHarness({ centred: false })
  r = await h.ctx.buildBunker('down', 3)
  assert.match(String(r.error), /cannot stand in the middle of the cell/, `down, centring failed, got ${JSON.stringify(r)}`)
  assert.deepStrictEqual(h.log, ['shelterInputs', 'chooseShelter down', 'centerOnCell', 'shelterInputs', 'chooseShelter refuse'], 'down, centring failed')

  h = buildHarness({ scenes: [{ threats: [spider(30)] }, { threats: [spider(5)] }] })
  r = await h.ctx.buildBunker('auto', 3)
  assert.match(String(r.error), /spider 5 blocks away/, `a spider closed in during the centring, got ${JSON.stringify(r)}`)
  assert.ok(!h.log.includes('digIn') && !h.log.includes('pillarShell'), `built after the second pick refused: ${h.log}`)
})

test('a finished or failed build starts the quiet that follow waits out', async () => {
  for (const fail of [false, true]) {
    const h = buildHarness()
    if (fail) h.env.centerOnCell = async () => { throw new Error('centring broke') }
    assert.strictEqual(h.env.legs.quietUntil(), 0, 'control: nothing took the legs')
    const before = Date.now()
    const r = await h.ctx.buildBunker('auto', 3)
    assert.strictEqual(fail ? /centring broke/.test(r.error) : r.mode === 'down', true, `control: ${JSON.stringify(r)}`)
    assert.ok(h.env.legs.quietUntil() >= before + QUIET_MS, `failed ${fail}: quiet until ${h.env.legs.quietUntil()}`)
  }
})

test('a refused or failed build keeps the bunker the body stands in, a cell the build set still goes', async () => {
  // The body stands in the cell on top of a finished pillar, under its roof.
  const earlier = new Vec3(5, 67, 5)
  const inside = (h) => {
    h.env.bot.entity = { position: new Vec3(5.5, 67, 5.5) }
    h.bunker.cell = earlier
    assert.ok(h.ctx.bunkerHolds(), 'control: the finished bunker holds')
  }
  let h = buildHarness({ scenes: [{ problems: { up: 'no headroom 2 above the feet' } }] })
  inside(h)
  let r = await h.ctx.buildBunker('up', 3)
  assert.match(String(r.error), /no headroom/, `control: refused under the roof, got ${JSON.stringify(r)}`)
  assert.ok(h.ctx.bunkerHolds(), 'the bunker stopped holding after a refused build')

  h = buildHarness()
  inside(h)
  h.env.centerOnCell = async () => { throw new Error('centring broke') }
  r = await h.ctx.buildBunker('auto', 3)
  assert.match(String(r.error), /centring broke/, `control: the centring threw, got ${JSON.stringify(r)}`)
  assert.ok(h.ctx.bunkerHolds(), 'the bunker stopped holding after a throw before the build')

  h = buildHarness({ scenes: [{ threats: [zombie(30)] }] })
  inside(h)
  h.env.pillarShell = async () => { h.bunker.cell = new Vec3(5, 70, 5); return { at: h.bunker.cell, placed: 3, stopped: 'the body left the pillar top' } }
  r = await h.ctx.buildBunker('auto', 3)
  assert.strictEqual(r.stopped, 'the body left the pillar top', 'control: the build stopped')
  assert.strictEqual(h.bunker.cell, null, 'a stopped build kept the cell it set')

  h = buildHarness()
  h.env.digIn = async () => { h.bunker.cell = new Vec3(0, 66, 0); throw new Error('digIn broke') }
  r = await h.ctx.buildBunker('auto', 3)
  assert.match(String(r.error), /digIn broke/, `control: digIn threw, got ${JSON.stringify(r)}`)
  assert.strictEqual(h.bunker.cell, null, 'a throw in digIn after it set the cell keeps the cell')

  h = buildHarness()
  const running = new Vec3(0, 67, 0)
  h.bunker.building = true
  h.bunker.cell = running
  r = await h.ctx.buildBunker('auto', 3)
  assert.match(String(r.error), /already being built/, 'control: a second build while one runs')
  assert.strictEqual(h.bunker.cell, running, "a second build cleared the running build's cell")
})

test('stop or death ends a bunker build as stopped and the body does not flee', async () => {
  let h = buildHarness()
  h.env.digIn = async () => { throw new Error('Digging aborted') }
  let r = await h.ctx.buildBunker('auto', 3)
  assert.match(String(r.error), /Digging aborted/, `control: a throw with no stop is an error, got ${JSON.stringify(r)}`)
  assert.strictEqual((await actAfter(r)).length, 1, 'control: the reflex flees on the error')

  for (const why of HALT_REASONS) {
    h = buildHarness()
    h.env.digIn = async () => { halt[why](h); throw new Error('Digging aborted') }
    r = await h.ctx.buildBunker('auto', 3)
    assert.strictEqual(r.stopped, why, `${why} in digIn, got ${JSON.stringify(r)}`)
    assert.strictEqual(r.error, undefined, `${why} in digIn`)
    assert.strictEqual(r.mode, 'down', `${why} in digIn: the mode it was building`)
    assert.ok(h.ctx.bunkerSummary(r).includes(why), `the reply does not carry ${why}: ${h.ctx.bunkerSummary(r)}`)
    assert.strictEqual((await actAfter(r)).length, 0, `the reflex fled after ${why} in digIn`)
  }

  // A zombie 2 blocks away makes the pick refuse after the combat wait.
  const waiting = () => {
    const w = buildHarness({ scenes: [{ threats: [zombie(2)] }] })
    w.combat.active = true
    return w
  }
  h = waiting()
  h.env.bot.waitForTicks = async () => { h.combat.active = false }
  r = await h.ctx.buildBunker('auto', 3)
  assert.match(String(r.error), /zombie 2 blocks away/, `control: with no stop the pick refuses, got ${JSON.stringify(r)}`)
  for (const why of HALT_REASONS) {
    h = waiting()
    h.env.bot.waitForTicks = async () => { h.combat.active = false; halt[why](h) }
    r = await h.ctx.buildBunker('auto', 3)
    assert.strictEqual(r.stopped, why, `${why} in the combat wait, got ${JSON.stringify(r)}`)
    assert.deepStrictEqual(h.log, [], `${why} in the combat wait: picked or built after it`)
    assert.strictEqual((await actAfter(r)).length, 0, `the reflex fled after ${why} in the combat wait`)

    h = buildHarness()
    h.env.centerOnCell = async () => { h.log.push('centerOnCell'); halt[why](h); return true }
    r = await h.ctx.buildBunker('auto', 3)
    assert.strictEqual(r.stopped, why, `${why} in the centring, got ${JSON.stringify(r)}`)
    assert.deepStrictEqual(h.log, ['shelterInputs', 'chooseShelter down', 'centerOnCell'], `${why} in the centring: picked or built after it`)
    assert.ok(h.ctx.bunkerSummary(r).includes(why), `the reply does not carry ${why}: ${h.ctx.bunkerSummary(r)}`)
    assert.strictEqual((await actAfter(r)).length, 0, `the reflex fled after ${why} in the centring`)
  }
})

test('a stop or death after the build began reports how far it got', async () => {
  for (const why of HALT_REASONS) {
    const reach = (h) => { h.bunker.reached = 2; halt[why](h); throw new Error('Digging aborted') }
    let h = buildHarness()
    h.env.centerOnCell = async () => { halt[why](h); return true }
    let summary = shelter.bunkerSummary(await h.ctx.buildBunker('auto', 3))
    assert.match(summary, /^no bunker built\b/, `control: ${why} before the build, got ${summary}`)

    h = buildHarness()
    h.env.digIn = async () => reach(h)
    summary = shelter.bunkerSummary(await h.ctx.buildBunker('auto', 3))
    assert.match(summary, /\b2 of 3\b/, `${why} after 2 cells dug, got ${summary}`)
    assert.ok(summary.includes(why), `${why} after 2 cells dug, got ${summary}`)

    h = buildHarness({ scenes: [{ threats: [zombie(30)] }] })
    h.env.pillarShell = async () => reach(h)
    summary = shelter.bunkerSummary(await h.ctx.buildBunker('auto', 4))
    assert.match(summary, /\b2 of 4\b/, `${why} after 2 of 4 pillar blocks, got ${summary}`)
    assert.ok(summary.includes(why), `${why} after 2 of 4 pillar blocks, got ${summary}`)
  }
})

test('a stop or death that makes a build step fail ends the build as stopped and the body does not flee', async () => {
  const steps = [
    { name: 'pillarShell', harness: pillarHarness, scenes: [{ threats: [zombie(30)] }], progress: /\b1 of 3\b/ },
    { name: 'digIn', harness: digHarness, scenes: [{}], progress: /\b2 of 3\b/ }
  ]
  for (const { name, harness, scenes, progress } of steps) {
    let h = buildHarness({ scenes })
    h.env[name] = harness({ 1: () => false }, h.bunker).ctx[name]
    let r = await h.ctx.buildBunker('auto', 3)
    assert.ok(r.stopped && !HALT_REASONS.includes(r.stopped), `control: ${name} failed with no stop, got ${JSON.stringify(r)}`)
    assert.strictEqual((await actAfter(r)).length, 1, `control: the reflex flees after ${name} failed`)
    for (const why of HALT_REASONS) {
      h = buildHarness({ scenes })
      h.env[name] = harness({ 1: () => { halt[why](h); return false } }, h.bunker).ctx[name]
      r = await h.ctx.buildBunker('auto', 3)
      assert.strictEqual(r.stopped, why, `${why} failed ${name}, got ${JSON.stringify(r)}`)
      assert.match(shelter.bunkerSummary(r), progress, `${why} failed ${name}: how far it got`)
      assert.strictEqual((await actAfter(r)).length, 0, `the reflex fled after ${why} failed ${name}`)
    }
  }
})

test('a stop or death during the last, successful placing leaves a finished build and keeps its cell', async () => {
  for (const why of HALT_REASONS) {
    const h = buildHarness()
    const dig = digHarness({}, h.bunker)
    dig.ctx.placeFiller = async () => { halt[why](h); return 'placed' }
    h.env.digIn = dig.ctx.digIn
    const r = await h.ctx.buildBunker('auto', 3)
    assert.strictEqual(r.stopped, undefined, `${why} after digIn finished, got ${JSON.stringify(r)}`)
    assert.strictEqual(r.sealed, true, `${why} after digIn finished: sealed`)
    assert.ok(h.bunker.cell, `${why} after digIn finished: the cell was cleared`)
  }
})

test('a hit before the shelter is picked does not stop the build', async () => {
  const bunker = { building: true, stop: null, cell: null, mode: 'up', reached: 0 }
  const ctx = loadBotFunctions(['onBuildHit'], { bunker, SHELTER: shelter.SHELTER, mobClass })
  ctx.onBuildHit(BUILD_HIT)
  assert.strictEqual(bunker.stop, 'hit while building', 'control: a hit after the up pick at the foot of the pillar')
  bunker.stop = null
  bunker.mode = null
  ctx.onBuildHit(BUILD_HIT)
  assert.strictEqual(bunker.stop, null, 'a hit before the pick set the stop')

  const h = buildHarness()
  h.combat.active = true
  h.env.bot.waitForTicks = async () => { h.combat.active = false; h.ctx.onBuildHit(BUILD_HIT) }
  h.env.centerOnCell = async () => { h.log.push('centerOnCell'); h.ctx.onBuildHit(BUILD_HIT); return true }
  const r = await h.ctx.buildBunker('auto', 3)
  assert.strictEqual(r.mode, 'down', `control: the build picked down, got ${JSON.stringify(r)}`)
  assert.ok(h.log.includes('centerOnCell'), 'control: the body was centred')
  assert.strictEqual(r.stopped, undefined, 'a hit in the combat wait or the centring stopped the build')
})

test('an arrow does not stop a dig-in, and still stops a pillar', () => {
  const arrow = { ...BUILD_HIT, entity: { id: 4, name: 'skeleton', cls: 'hostile' }, ranged: true }
  for (const [mode, stop] of [['up', 'hit while building'], ['down', null]]) {
    const bunker = { building: true, stop: null, cell: null, mode, reached: 0 }
    const ctx = loadBotFunctions(['onBuildHit'], { bunker, SHELTER: shelter.SHELTER, mobClass })
    ctx.onBuildHit(BUILD_HIT)
    assert.strictEqual(bunker.stop, 'hit while building', `control: a zombie's hit stops ${mode}`)
    bunker.stop = null
    ctx.onBuildHit(arrow)
    assert.strictEqual(bunker.stop, stop, `an arrow during ${mode}`)
  }
})

// ---- digIn and pillarShell ----

const hit = (c) => c.onBuildHit(BUILD_HIT)
const SAFE_DEPTH = shelter.SHELTER.SAFE_DEPTH
const SAFE_HEIGHT = shelter.SHELTER.SAFE_HEIGHT
const PILOT_STOP = 'stopped by the pilot'

test('a hit once the shaft reaches safe depth does not stop the dig, a stop still does', async () => {
  let h = digHarness({ 0: hit })
  let r = await h.ctx.digIn()
  assert.strictEqual(r.stopped, 'hit while building', `control: a hit in the first cell stops the dig, got ${JSON.stringify(r)}`)
  assert.strictEqual(r.dug, 1, 'control: dug')

  h = digHarness({ [SAFE_DEPTH - 1]: hit })
  r = await h.ctx.digIn()
  assert.strictEqual(h.bunker.stop, 'hit while building', 'control: the hit set the stop before the safe depth')
  assert.strictEqual(r.stopped, undefined, `the body left a ${SAFE_DEPTH}-deep shaft on the hit, got ${JSON.stringify(r)}`)
  assert.strictEqual(r.dug, 3)
  assert.ok(h.bunker.cell, 'the finished shaft set no cell')

  r = await digHarness({ [SAFE_DEPTH]: (c) => { c.bunker.stop = PILOT_STOP } }).ctx.digIn()
  assert.strictEqual(r.stopped, PILOT_STOP, 'a stop in the last cell')
})

test('a hit once the pillar reaches safe height does not stop the shell, a stop still does', async () => {
  let h = pillarHarness({ 0: hit })
  let r = await h.ctx.pillarShell(3)
  assert.strictEqual(r.stopped, 'hit while building', `control: a hit on the first block stops the pillar, got ${JSON.stringify(r)}`)
  assert.strictEqual(r.placed, 1, 'control: placed')

  h = pillarHarness({ [SAFE_HEIGHT - 1]: hit })
  r = await h.ctx.pillarShell(3)
  assert.strictEqual(h.bunker.stop, 'hit while building', 'control: the hit set the stop before the safe height')
  assert.strictEqual(r.stopped, undefined, `the body left a ${SAFE_HEIGHT}-high pillar on the hit, got ${JSON.stringify(r)}`)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.at)), { x: 0, y: 67, z: 0 }, 'the pillar top')
  assert.ok(r.placed > 3, `the shell was not built, placed ${r.placed}`)

  r = await pillarHarness({ [SAFE_HEIGHT]: (c) => { c.bunker.stop = PILOT_STOP } }).ctx.pillarShell(SAFE_HEIGHT + 2)
  assert.strictEqual(r.stopped, PILOT_STOP, 'a stop past the safe height')
  assert.strictEqual(r.placed, SAFE_HEIGHT + 1, 'placed')
})

// ---- shelterInputs ----

test('a mob out of sight counts as a bunker threat only after it hit the body', () => {
  const entities = {
    1: { id: 1, name: 'zombie', cls: 'hostile', position: HERE.offset(30, 0, 0), seen: true },
    2: { id: 2, name: 'skeleton', cls: 'hostile', position: HERE.offset(-6, 0, 0), seen: false },
    3: { id: 3, name: 'husk', cls: 'hostile', position: HERE.offset(0, 0, 20), seen: false },
    4: { id: 4, name: 'creeper', cls: 'creeper', position: HERE.offset(0, -8, 4), seen: true }
  }
  const { input, names, fills } = shelterInputsAmong(entities, [3])
  assert.ok(names.includes('zombie') && !names.includes('creeper'), `control: the seen zombie counts, the creeper a floor below does not, got ${names}`)
  assert.ok(names.includes('husk'), `the unseen husk that hit the body is missing, got ${names}`)
  assert.ok(!names.includes('skeleton'), `the skeleton sealed from view counts, got ${names}`)
  assert.deepStrictEqual(names, ['husk', 'zombie'])
  assert.ok(fills > 0, 'fairFill was never asked')
  const pick = shelter.chooseShelter(input)
  assert.strictEqual(pick.mode, 'up', `the pick refused: ${pick.refuse}`)
})

test('a mob that hit the body counts as a bunker threat out to a farther horizon than one that did not', () => {
  const near = shelter.SHELTER.HORIZON
  const far = botConstant('CONFIRMED_HORIZON')
  assert.ok(far > near + 4, `control: the confirmed horizon ${far} lies past the horizon ${near}`)
  const at = (id, name, dx) => ({ id, name, cls: 'hostile', position: HERE.offset(dx, 0, 0), seen: true })
  const entities = { 1: at(1, 'zombie', near - 2), 2: at(2, 'husk', near + 2), 3: at(3, 'zombie_villager', -(far - 2)), 4: at(4, 'drowned', -(far + 2)) }
  const { names } = shelterInputsAmong(entities, [3, 4])
  assert.ok(names.includes('zombie'), `control: a mob inside the horizon counts, got ${names}`)
  assert.ok(names.includes('zombie_villager'), `a mob that hit the body, past the horizon, does not count, got ${names}`)
  assert.ok(!names.includes('husk'), `a mob that did not hit the body counts past the horizon, got ${names}`)
  assert.ok(!names.includes('drowned'), `a mob that hit the body counts past the confirmed horizon, got ${names}`)
})

test('a hit counts toward the bunker only while the aggro is fresh', () => {
  const confirmedMs = botConstant('CONFIRMED_MS')
  const at = (id, name, cls, dx, dy, dz, seen = true) => ({ id, name, cls, position: HERE.offset(dx, dy, dz), seen })
  const entities = {
    1: at(1, 'enderman', 'provokable', 6, 0, 0),
    2: at(2, 'zombified_piglin', 'provokable', -6, 0, 0),
    3: at(3, 'husk', 'hostile', 40, 0, 0),
    4: at(4, 'zombie', 'hostile', -40, 0, 0),
    5: at(5, 'skeleton', 'hostile', 0, 0, 6, false),
    6: at(6, 'stray', 'hostile', 0, 0, -6, false),
    7: at(7, 'spider', 'hostile', 4, -8, 0),
    8: at(8, 'cave_spider', 'hostile', -4, -8, 0)
  }
  const fresh = confirmedMs - 1000
  const stale = confirmedMs + 1000
  const old = 10 * 60 * 1000
  const { names } = shelterInputsAmong(entities, [1, 2, 3, 4, 5, 6, 7, 8], { 1: fresh, 2: stale, 3: fresh, 4: old, 5: fresh, 6: old, 7: fresh, 8: old })
  for (const name of ['enderman', 'husk', 'skeleton', 'spider']) assert.ok(names.includes(name), `control: ${name} with a fresh hit is missing, got ${names}`)
  assert.ok(!names.includes('zombified_piglin'), `a provokable counts on a stale hit, got ${names}`)
  assert.ok(!names.includes('zombie'), `a mob past the horizon counts on a 10-minute-old hit, got ${names}`)
  assert.ok(!names.includes('stray'), `a mob sealed from view counts on a 10-minute-old hit, got ${names}`)
  assert.ok(!names.includes('cave_spider'), `a mob a floor below out of sight counts on a 10-minute-old hit, got ${names}`)
})

test('an expired hit is forgotten even when its mob is no longer loaded', () => {
  const confirmedMs = botConstant('CONFIRMED_MS')
  const { confirmed } = shelterInputsAmong({}, [1, 2], { 1: confirmedMs - 1000, 2: confirmedMs + 1000 })
  assert.ok(confirmed.has(1), 'control: a fresh hit by a mob no longer loaded is kept')
  assert.ok(!confirmed.has(2), 'a stale hit by a mob no longer loaded is kept')
})

// ---- bunkerReflexDecide ----

test('the bunker reflex waits 15 s after fleeing a player', () => {
  assert.strictEqual(bunkerDecider('hostile', 1000), 'build', 'control: a flee from a mob 1 s ago')
  assert.strictEqual(bunkerDecider('player', 14000), null, 'a flee from a player 14 s ago')
  assert.strictEqual(bunkerDecider('player', 16000), 'build', 'a flee from a player 16 s ago')
})

// ---- pillarProblem ----

// On a 3-block pillar from y 64 the body's feet are at 67 and its head at 68.
test('a pillar is refused beside a ledge from which a mob reaches the body on top', () => {
  assert.strictEqual(pillarProblemWith(column(1, 1, 64, 69)), null, 'control: a wall a mob stands on two blocks over the head')
  assert.strictEqual(pillarProblemWith(column(2, 0, 64, 65)), null, 'control: a ledge two columns away')
  assert.strictEqual(pillarProblemWith(column(1, 0, 64, 65)), 'a step beside the pillar', 'a 2-high ledge beside the pillar')
  assert.strictEqual(pillarProblemWith(column(0, -1, 64, 68)), 'a step beside the pillar', 'a mob one block over the head of the body on a 3-block pillar')
})

test('the bunker reflex flees after a failed build, naming what ended it, but not after a finished one', async () => {
  const flees = await actAfter(stoppedBuild('hit while building'))
  assert.strictEqual(flees.length, 1, 'no flee after a hit stopped the build')
  assert.ok(flees[0].why.includes('hit while building'), `the flee after a hit does not name it: ${flees[0].why}`)
  assert.doesNotMatch(flees[0].why, /^no bunker\b/, 'the flee after a hit says no bunker')
  const error = 'no bunker possible here (zombie 2 blocks away, up needs a lead of 7)'
  const onError = await actAfter({ error })
  assert.strictEqual(onError.length, 1, 'no flee after an error')
  assert.ok(onError[0].why.includes(error), `the flee after an error does not name it: ${JSON.stringify(onError[0])}`)
  const done = { mode: 'up', at: { x: 0, y: 67, z: 0 }, sealed: true, dug: 0, placed: 16, gaps: [], exit: [] }
  assert.strictEqual((await actAfter(done)).length, 0, 'a flee after a finished bunker')
})
