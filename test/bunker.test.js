'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const shelter = require('../lib/shelter')
const { QUIET_MS } = require('../lib/legs')
const {
  botConstant, loadBotFunctions, HERE, shelterInputsAmong, shelterEnv, pillarProblemWith, column,
  BUILD_HIT, threat, buildHarness, halt, HALT_REASONS, digHarness, pillarHarness, bunkerDecider, actAfter, stoppedBuild, digInProblemWith,
  awaitRoute, bunkerReflexIn, combatReflexIn
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

test('a bunker build is refused while the body stands in water or lava', async () => {
  const standingIn = async (feet) => {
    const h = buildHarness()
    h.env.liquidProblem = loadBotFunctions(['liquidProblem'], {
      bot: { entity: { position: HERE }, blockAt: (p) => ({ name: p.equals(HERE.floored()) ? feet : 'air', position: p }) }
    }).liquidProblem
    return { r: await h.ctx.buildBunker('auto', 3), log: h.log }
  }
  const dry = await standingIn('air')
  assert.strictEqual(dry.r.mode, 'down', `control: dry ground builds, got ${JSON.stringify(dry.r)}`)
  for (const liquid of ['water', 'lava']) {
    const { r, log } = await standingIn(liquid)
    assert.match(String(r.error), new RegExp(`^no bunker possible here \\(.*\\b${liquid}\\b`), `in ${liquid}, got ${JSON.stringify(r)}`)
    assert.ok(!log.includes('digIn') && !log.includes('pillarShell'), `built in ${liquid}: ${log}`)
  }
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

test('no walk reaches the pathfinder while a bunker builds, whoever asks for it', async () => {
  const h = buildHarness()
  const walked = []
  h.env.bot.pathfinder = { setGoal (g) { if (g) walked.push(g) }, goto: async (g) => { walked.push(g) }, setMovements () {} }
  const goal = new goals.GoalNear(5, 64, 5, 1)
  // The refusals a route or reflex meets when it asks the pathfinder for a walk.
  const walk = async () => {
    const refused = []
    try { h.env.bot.pathfinder.setGoal(goal) } catch (e) { refused.push(e.message) }
    try { await h.env.bot.pathfinder.goto(goal) } catch (e) { refused.push(e.message) }
    return refused
  }
  assert.deepStrictEqual([await walk(), walked.length], [[], 2], 'control: both walks before the build')
  walked.length = 0
  let during = null
  const digIn = h.env.digIn
  h.env.digIn = async () => { during = await walk(); return digIn() }
  const r = await h.ctx.buildBunker('auto', 3)
  assert.strictEqual(r.mode, 'down', `control: the build ran, ${JSON.stringify(r)}`)
  const refusal = botConstant('BUNKER_WALK')
  assert.deepStrictEqual(during, [refusal, refusal], 'a walk during the build was not refused')
  assert.deepStrictEqual(walked, [], 'the pathfinder took a goal during the build')
  assert.deepStrictEqual([await walk(), walked.length], [[], 2], 'walks stay refused after the build')
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

test('a dig that opens onto a cave caps the shaft from 2 deep naming only the cell under the feet, and stops shallower', async () => {
  // The body digs from y 64. The cave starts 3 below the feet, under the second dug cell.
  let h = buildHarness()
  h.env.digIn = digHarness({}, h.bunker, ['0,61,0', '0,60,0', '1,61,0', '1,60,0', '-1,61,0']).ctx.digIn
  let r = await h.ctx.buildBunker('auto', 3)
  assert.strictEqual(r.stopped, undefined, `control: the 2-deep shaft stands, got ${JSON.stringify(r)}`)
  assert.ok(h.bunker.cell, 'the 2-deep shaft set no cell')
  assert.deepStrictEqual(JSON.parse(JSON.stringify({ dug: r.dug, at: r.at, exit: r.exit, gaps: r.gaps })), { dug: 2, at: { x: 0, y: 62, z: 0 }, exit: [{ x: 0, y: 64, z: 0 }], gaps: [{ x: 0, y: 61, z: 0 }] })
  assert.strictEqual(shelter.bunkerSummary(r), 'dug in 2 below ground at (0,62,0), dig stopped (an opening under the feet), 1 gap in the shell. To leave, dig (0,64,0), then pillar up 2.')

  h = buildHarness()
  h.env.digIn = digHarness({}, h.bunker, ['0,62,0', '0,61,0']).ctx.digIn
  r = await h.ctx.buildBunker('auto', 3)
  assert.strictEqual(shelter.bunkerSummary(r), 'dug 1 of 3 cells at (0,63,0), an opening under the feet')
  assert.strictEqual(h.bunker.cell, null, 'a 1-deep stop kept its cell')
  assert.strictEqual((await actAfter(r)).length, 1, 'the body stays in a 1-deep hole')
})

// ---- shelterInputs ----

test('a mob out of sight counts as a bunker threat only after it hit the body', () => {
  const entities = {
    1: { id: 1, name: 'zombie', cls: 'hostile', position: HERE.offset(30, 0, 0), seen: true },
    2: { id: 2, name: 'skeleton', cls: 'hostile', position: HERE.offset(-6, 0, 0), seen: false },
    3: { id: 3, name: 'husk', cls: 'hostile', position: HERE.offset(0, 0, 20), seen: false, seenAt: HERE.offset(0, 0, 20) },
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

test('a mob that hit the body and went out of sight counts where the body last perceived it', () => {
  const zombie = (seen, seenAt) => ({ 1: { id: 1, name: 'zombie', cls: 'hostile', position: HERE.offset(4, 0, 0), seen, seenAt } })
  const dist = (entities) => Array.from(shelterInputsAmong(entities, [1]).input.threats, (t) => t.dist)
  assert.deepStrictEqual(dist(zombie(true, HERE.offset(12, 0, 0))), [4], 'control: in sight it counts where it stands')
  assert.deepStrictEqual(dist(zombie(false, HERE.offset(12, 0, 0))), [12], 'out of sight, the steps it took closer count')
  assert.deepStrictEqual(dist(zombie(false, undefined)), [], 'a mob never perceived counts at a distance')
  const far = botConstant('CONFIRMED_HORIZON') + 2
  assert.deepStrictEqual(dist(zombie(false, HERE.offset(far, 0, 0))), [], 'last perceived past the horizon, it counts from where it stands')
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
  const at = (id, name, cls, dx, dy, dz, seen = true) => ({ id, name, cls, position: HERE.offset(dx, dy, dz), seen, seenAt: HERE.offset(dx, dy, dz) })
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

test('the bunker reflex arms below 8 HP within 15 s of a mob hit, and after it fired only once HP is back at 12', async () => {
  const bot = { health: 20 }
  const fight = { lastHit: { dmg: 3, t: 0, cls: 'hostile' } }
  const env = {
    bot,
    fight,
    reflexes: [{ name: 'combat', _fleeCls: null, _fleeT: 0 }],
    bunkerHolds: () => false,
    BUNKER_HP: botConstant('BUNKER_HP'),
    BUNKER_REARM_HP: botConstant('BUNKER_REARM_HP'),
    BUNKER_HEIGHT: botConstant('BUNKER_HEIGHT'),
    BUNKER_HALTS: botConstant('BUNKER_HALTS'),
    shelterInputs: () => ({ requested: 'auto', threats: [{ ...zombie(30), entity: {} }], problems: { down: null, up: null }, buildMs: { down: 2930, up: 1300 } }),
    chooseShelter: shelter.chooseShelter,
    bunkerSummary: shelter.bunkerSummary,
    buildBunker: async () => ({ mode: 'up', at: { x: 0, y: 67, z: 0 }, sealed: true, dug: 0, placed: 16, gaps: [], exit: [] }),
    emitEvent () {},
    takeLegs () {}
  }
  loadBotFunctions(['bunkerReflexDecide'], env)
  const reflex = bunkerReflexIn(env)
  env.reflexes.push(reflex)
  const arms = (health, hitAgoMs = 1000) => {
    bot.health = health
    fight.lastHit.t = Date.now() - hitAgoMs
    return reflex.check(bot)
  }
  assert.strictEqual(arms(7), true, 'control: HP 7, a mob hit 1 s ago')
  assert.strictEqual(arms(8), false, 'HP 8')
  assert.strictEqual(arms(7, 16000), false, 'a mob hit 16 s ago')
  await reflex.act(bot)
  assert.strictEqual(arms(7), false, 'armed again right after it fired')
  arms(11)
  assert.strictEqual(arms(7), false, 'armed again after HP rose to 11')
  arms(12)
  assert.strictEqual(arms(7), true, 'not armed again after HP rose to 12')
})

// ---- digInProblem ----

test('a dig-in over unseen ground holds against a spider, counts the slowest dig there and names no unseen cave', () => {
  const cave = ['1,62,0', '1,61,0', '0,60,0']
  assert.match(String(digInProblemWith({ caves: cave, known: () => true })), /opening/, 'control: a cave the bot has seen')
  const unseen = digInProblemWith({ caves: cave })
  assert.strictEqual(unseen, null, `refused over unseen ground: ${unseen}`)

  // The bot knows the surface, y 63 and up. Stone digs slower than dirt.
  const downMs = (deep) => {
    const { env } = shelterEnv({}, [])
    Object.assign(env, {
      bot: { ...env.bot, blockAt: (p) => ({ name: p.y < 63 ? deep : 'dirt', position: p }) },
      knownCell: (p) => p.y >= 63,
      digMs: (b) => (b.name === 'stone' ? 1200 : 750)
    })
    return loadBotFunctions(['shelterInputs'], env).shelterInputs('auto').buildMs.down
  }
  assert.strictEqual(downMs('stone'), downMs('dirt'), 'the dig time tells unseen stone from dirt')
  const pick = shelter.chooseShelter({ requested: 'auto', threats: [spider(30)], problems: { down: unseen, up: null }, buildMs: { down: downMs('dirt'), up: 1300 } })
  assert.strictEqual(pick.mode, 'down', `no dig-in against a spider: ${JSON.stringify(pick)}`)
})

// digInProblem for a body on dirt at (0, 64, 0) with the block name at cell, which the bot knows only when known.
function digInWith (cell, name, known) {
  const key = (p) => `${p.x},${p.y},${p.z}`
  const isOpen = (p) => p.y >= 64 || (key(p) === cell && /water|lava/.test(name))
  const env = {
    bot: {
      entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
      blockAt: (p) => ({ name: key(p) === cell ? name : isOpen(p) ? 'air' : 'dirt', boundingBox: isOpen(p) ? 'empty' : 'block', position: p })
    },
    SIDES: botConstant('SIDES'),
    BUNKER_GROUND: botConstant('BUNKER_GROUND'),
    BUNKER_DIG_MS: botConstant('BUNKER_DIG_MS'),
    solidAt: (p) => !isOpen(p),
    digMs: () => 750,
    knownCell: (p) => key(p) === cell ? known : p.y >= 63,
    fillers: () => [{ name: 'dirt', count: 64 }]
  }
  return loadBotFunctions(['digInProblem'], env).digInProblem()
}

test('a dig-in refuses water or lava beside the body or in seen ground beside the shaft, never for liquid it has not seen', () => {
  assert.strictEqual(digInWith('1,64,0', 'water', false), 'water beside the body')
  assert.strictEqual(digInWith('1,65,0', 'lava', false), 'lava beside the body', 'lava beside the head')
  assert.strictEqual(digInWith('1,62,0', 'lava', true), 'lava beside the shaft')
  assert.strictEqual(digInWith('1,62,0', 'lava', false), null)
})

test('a dig-in that meets liquid beside the body mid-dig plugs it and digs no deeper', async () => {
  const dry = await digHarness().ctx.digIn()
  assert.strictEqual(dry.dug, 3, `control: dry ground digs 3 deep, got ${JSON.stringify(dry)}`)

  // Lava flows in beside the first cell while the body digs it.
  let flowing = false
  const { ctx } = digHarness({ 0: () => { flowing = true } })
  const ground = ctx.bot.blockAt
  ctx.bot.blockAt = (p) => (flowing && p.x === 1 && p.y === 63 && p.z === 0 ? { name: 'lava', position: p } : ground(p))
  const plugged = []
  ctx.placeFiller = async (cell) => { plugged.push(`${cell.x},${cell.y},${cell.z}`); return 'placed' }
  const r = await ctx.digIn()
  assert.strictEqual(r.dug, 1, `dug past the lava, got ${JSON.stringify(r)}`)
  assert.match(String(r.stopped), /^lava\b/, 'the stop does not name the lava')
  assert.deepStrictEqual(plugged, ['1,63,0'], 'the lava was not plugged')
})

test('a dig-in digs only natural ground, refusing clay and terracotta', async () => {
  assert.strictEqual(digInProblemWith(), null, 'control: seen dirt below')
  assert.strictEqual((await digHarness().ctx.digIn()).dug, 3, 'control: dirt digs 3 deep')

  assert.match(String(digInWith('0,63,0', 'clay', true)), /^clay\b/, 'seen clay below')

  // Ground the body has not seen is judged as it digs.
  assert.strictEqual(digInWith('0,62,0', 'terracotta', false), null, 'control: unseen ground passes the preflight')
  const { ctx } = digHarness()
  const ground = ctx.bot.blockAt
  ctx.bot.blockAt = (p) => (p.x === 0 && p.y === 62 && p.z === 0 ? { name: 'terracotta', position: p } : ground(p))
  const r = await ctx.digIn()
  assert.strictEqual(r.dug, 1, `dug into terracotta, got ${JSON.stringify(r)}`)
  assert.match(String(r.stopped), /^terracotta\b/, 'the stop does not name the terracotta')
})

// ---- pillarProblem ----

// On a 3-block pillar from y 64 the body's feet are at 67 and its head at 68.
test('a pillar is refused beside a ledge from which a mob reaches the body on top', () => {
  assert.strictEqual(pillarProblemWith(column(1, 1, 64, 69)), null, 'control: a wall a mob stands on two blocks over the head')
  assert.strictEqual(pillarProblemWith(column(2, 0, 64, 65)), null, 'control: a ledge two columns away')
  assert.strictEqual(pillarProblemWith(column(1, 0, 64, 65)), 'a step beside the pillar', 'a 2-high ledge beside the pillar')
  assert.strictEqual(pillarProblemWith(column(0, -1, 64, 68)), 'a step beside the pillar', 'a mob one block over the head of the body on a 3-block pillar')
})

test('a pillar is refused only for blocks the body has seen', () => {
  const ceiling = ['0,67,0']
  assert.strictEqual(pillarProblemWith(ceiling), 'no headroom 3 above the feet', 'control: a seen block over the pillar')
  assert.strictEqual(pillarProblemWith(ceiling, 3, ceiling), null, 'an unseen block over the pillar')
  const ledge = column(1, 1, 64, 65)
  assert.strictEqual(pillarProblemWith(ledge), 'a step beside the pillar', 'control: a seen ledge beside the pillar')
  assert.strictEqual(pillarProblemWith(ledge, 3, ledge), null, 'an unseen ledge beside the pillar')
})

// ---- pillar height ----

// Ground at y 63 and a hill 3 high over x 2 to 6, beside a body at (0, 64, 0).
const hill = (p) => p.y < 64 || (p.x >= 2 && p.x <= 6 && Math.abs(p.z) <= 3 && p.y < 67)
const dirtWhere = (solid) => (p) => ({ name: solid(p) ? 'dirt' : 'air', boundingBox: solid(p) ? 'block' : 'empty', position: p })

function hillBuild (blocks) {
  const { env } = shelterEnv({ 1: { id: 1, name: 'zombie', cls: 'hostile', position: HERE.offset(-30, 0, 0), seen: true } }, [])
  delete env.pillarProblem
  delete env.pillarHeight
  Object.assign(env, {
    bot: { ...env.bot, blockAt: dirtWhere(hill) },
    solidAt: hill,
    isSoftCover: () => false,
    knownCell: () => true,
    PILLAR_SCAN_UP: botConstant('PILLAR_SCAN_UP'),
    fillers: () => [{ name: 'dirt', count: blocks }]
  })
  const { shelterInputs } = loadBotFunctions(['shelterInputs'], env)
  const h = buildHarness()
  h.env.shelterInputs = (requested, height) => { h.log.push('shelterInputs'); return shelterInputs(requested, height) }
  return h
}

test('a pillar beside a hill rises at least 2 over the hilltop', async () => {
  const h = hillBuild(64)
  const r = await h.ctx.buildBunker('auto', 3)
  assert.strictEqual(r.mode, 'up', `control: the zombie makes it a pillar, got ${JSON.stringify(r)}`)
  assert.ok(64 + r.height >= 67 + 2, `the pillar top at ${64 + r.height} is in reach from the hilltop at 67`)
  assert.strictEqual(h.lines.filter((l) => /^\[bunker\] mode up, pillar height 5\b/.test(l)).length, 1, `${h.lines}`)
})

test('the pillar verb beside a hill rises at least 2 over the hilltop and says why', async () => {
  const climb = async (ground) => {
    const entity = { position: new Vec3(0.5, 64, 0.5) }
    const solid = (p) => ground(p) || (p.x === 0 && p.z === 0 && p.y < entity.position.y)
    return awaitRoute('/pillar', { height: '3' }, {
      bot: { entity, blockAt: dirtWhere(solid) },
      bunker: { building: false },
      perch: { cell: null },
      fillers: () => [{ name: 'dirt', count: 64 }],
      jumpPlace: async () => { entity.position = entity.position.offset(0, 1, 0); return true },
      solidAt: solid,
      knownCell: () => true,
      SHELTER: shelter.SHELTER,
      PILLAR_SCAN_UP: botConstant('PILLAR_SCAN_UP'),
      BUNKER_MAX_HEIGHT: botConstant('BUNKER_MAX_HEIGHT')
    })
  }
  const flat = await climb((p) => p.y < 64)
  assert.deepStrictEqual(flat, { placed: 3, rose: 3, y: 67 }, 'control: flat ground')
  const r = await climb(hill)
  assert.ok(r.y >= 67 + 2, `the pillar top at ${r.y} is in reach from the hilltop at 67`)
  assert.match(String(r.raised), /^from 3 to 5, seen ground 3 above the feet\b/)
})

test('the pillar verb at the bottom of a shaft climbs out level instead of rising over the rim', async () => {
  // Ground to y 63 with a 2-deep shaft at x 0, z 0, the body at its bottom.
  const entity = { position: new Vec3(0.5, 62, 0.5) }
  const ground = (p) => p.y < 62 || (p.y < 64 && (p.x !== 0 || p.z !== 0))
  const solid = (p) => ground(p) || (p.x === 0 && p.z === 0 && p.y < entity.position.y)
  const r = await awaitRoute('/pillar', { height: '2' }, {
    bot: { entity, blockAt: dirtWhere(solid) },
    bunker: { building: false },
    perch: { cell: null },
    fillers: () => [{ name: 'dirt', count: 64 }],
    jumpPlace: async () => { entity.position = entity.position.offset(0, 1, 0); return true },
    solidAt: solid,
    knownCell: () => true,
    SHELTER: shelter.SHELTER,
    PILLAR_SCAN_UP: botConstant('PILLAR_SCAN_UP'),
    BUNKER_MAX_HEIGHT: botConstant('BUNKER_MAX_HEIGHT')
  })
  assert.deepStrictEqual(r, { placed: 2, rose: 2, y: 64 })
})

test('with too few blocks for the height a hill needs the bunker refuses the pillar', async () => {
  const h = hillBuild(4)
  const r = await h.ctx.buildBunker('auto', 3)
  assert.match(String(r.error), /4 blocks carried, the pillar takes 5 \(seen ground 3 above/, `got ${JSON.stringify(r)}`)
  assert.ok(!h.log.includes('pillarShell'), `built a pillar: ${h.log}`)
  assert.strictEqual((await actAfter(r)).length, 1, 'the body does not flee')
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

test('the flee after a failed build runs although a flee was under way when the build began', async () => {
  const mob = { id: 9, name: 'zombie', cls: 'hostile', position: new Vec3(3.5, 64, 0.5) }
  const bot = { health: 5, entity: { position: HERE }, pathfinder: { goal: null, setGoal (g) { this.goal = g } }, setControlState () {} }
  // The combat reflex with a planner that always finds a goal, so only its flee latch can hold a flee back.
  const combat = combatReflexIn({
    bot,
    goals,
    reflexes: [],
    console: { log () {} },
    setTimeout () {},
    laneBlocks: () => false,
    airFlood: () => ({}),
    knownCell: () => true,
    entityPerceptible: () => true,
    nearHostiles: () => [],
    fleeWorld: () => ({}),
    mobClass,
    planFlee: () => ({ goal: new Vec3(-10, 64, 0) }),
    fleeLog: () => '',
    threatWhy: (what) => what,
    takeLegs () {},
    stopPath () {},
    emitEvent () {}
  })
  combat._fleeUntil = Date.now() + 6000
  combat.fleeFrom(bot, mob, 'a second flee', 'emergency')
  assert.strictEqual(bot.pathfinder.goal, null, 'control: a flee under way holds back another')

  const h = buildHarness({ scenes: [{ threats: [zombie(30)] }] })
  h.env.reflexes.splice(0, 1, combat)
  h.env.pillarShell = async () => {
    h.log.push('pillarShell')
    return { at: new Vec3(0, 65, 0), placed: 1, stopped: 'hit while building' }
  }
  const reflex = bunkerReflexIn({
    reflexes: [combat],
    emitEvent () {},
    takeLegs () {},
    buildBunker: h.ctx.buildBunker,
    bunkerSummary: shelter.bunkerSummary,
    shelterInputs: () => ({ requested: 'auto', threats: [{ ...zombie(3), entity: mob }] }),
    BUNKER_HALTS: botConstant('BUNKER_HALTS'),
    BUNKER_HEIGHT: 3,
    BUNKER_REARM_HP: 12
  })
  await reflex.act(bot)
  assert.ok(h.log.includes('pillarShell'), `control: the build began, ${h.log}`)
  assert.ok(bot.pathfinder.goal, 'the flee after the failed build did not run')
})
