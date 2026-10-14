'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { mobFamily, requiredLead, chooseShelter, entityInCell, babyFlag, expireConfirmed, bunkerSummary } = require('../lib/shelter')

// up: two pillar blocks of 650 ms.
const BUILD = { up: 1300, down: 2930 }
const NO_PROBLEMS = { down: null, up: null }
const LEAD = {
  zombie: requiredLead({ family: 'zombie', baby: false, buildMs: BUILD.up }),
  babyZombie: requiredLead({ family: 'zombie', baby: true, buildMs: BUILD.up }),
  spider: requiredLead({ family: 'spider', baby: false, buildMs: BUILD.down })
}

const zombie = (dist, baby = false) => ({ name: 'zombie', baby, dist })
const spider = (dist) => ({ name: 'spider', baby: false, dist })

function choose (requested, threats, problems = NO_PROBLEMS, buildMs = BUILD) {
  return chooseShelter({ requested, threats, problems, buildMs })
}

function assertRefusal (r, label = '') {
  assert.ok(r && typeof r === 'object', `${label}: result is an object`)
  assert.deepStrictEqual(Object.keys(r).sort(), ['refuse', 'then'], `${label}: refusal keys, got ${JSON.stringify(r)}`)
  assert.strictEqual(r.then, 'flee', label)
  assert.strictEqual(typeof r.refuse, 'string', label)
  assert.ok(r.refuse.trim().length > 0, `${label}: refuse is empty`)
  assert.ok(!/[\r\n]/.test(r.refuse), `${label}: refuse is one line, got ${JSON.stringify(r.refuse)}`)
  return r.refuse
}

function assertMode (r, mode, label = '') {
  assert.ok(r && typeof r === 'object', `${label}: result is an object`)
  assert.deepStrictEqual(Object.keys(r).sort(), ['lead', 'mode'], `${label}: success keys, got ${JSON.stringify(r)}`)
  assert.strictEqual(r.mode, mode, `${label}: got ${JSON.stringify(r)}`)
}

// True when text holds the number n on its own, 5 or 5.0 but not 15 or 5.5.
function mentions (text, n) {
  return new RegExp(`(?<![\\d.])${n}(?:\\.0+)?(?![\\d.]*\\d)`).test(text)
}

test('mobFamily files a named mob under its family and everything else under other', () => {
  assert.strictEqual(mobFamily('zombie'), 'zombie', 'control')
  assert.strictEqual(mobFamily('husk'), 'zombie')
  assert.strictEqual(mobFamily('cave_spider'), 'other')
})

test('mobFamily gives other for prototype keys and non-strings, without throwing', () => {
  assert.strictEqual(mobFamily('spider'), 'spider', 'control')
  for (const name of ['constructor', null, ['zombie']]) {
    let r
    assert.doesNotThrow(() => { r = mobFamily(name) }, String(name))
    assert.strictEqual(r, 'other', String(name))
  }
})

test('auto picks up against zombie and husk at 30, down against a spider at 30', () => {
  assertMode(choose('auto', [zombie(30)]), 'up', 'control: zombie')
  assertMode(choose('auto', [{ name: 'husk', baby: false, dist: 30 }]), 'up', 'husk')
  assertMode(choose('auto', [spider(30)]), 'down', 'spider')
})

test('a ranged mob or a zombie together with a spider refuses, naming the mob', () => {
  assertMode(choose('auto', [zombie(30)]), 'up', 'control')
  const why = assertRefusal(choose('auto', [{ name: 'skeleton', baby: false, dist: 30 }]), 'skeleton')
  assert.ok(why.includes('skeleton'), `the refusal names the mob, got ${JSON.stringify(why)}`)
  assertRefusal(choose('auto', [zombie(30), spider(30)]), 'zombie plus spider')
})

test('a zombie at 2 refuses, naming the zombie, its distance and the lead it needs', () => {
  assertMode(choose('auto', [zombie(30)]), 'up', 'control')
  const why = assertRefusal(choose('auto', [zombie(2)]), 'zombie at 2')
  assert.ok(why.includes('zombie'), `names the zombie: ${why}`)
  assert.ok(mentions(why, 2), `names the distance 2: ${why}`)
  assert.ok(mentions(why, LEAD.zombie), `names the lead ${LEAD.zombie}: ${why}`)
})

test('each family exactly at its lead passes with that lead, under it refuses naming its own lead', () => {
  assert.ok(LEAD.babyZombie > LEAD.zombie, `control: a baby zombie needs a longer lead than an adult, ${LEAD.babyZombie} vs ${LEAD.zombie}`)
  const cases = [
    ['zombie', (d) => zombie(d), 'up', LEAD.zombie],
    ['baby zombie', (d) => zombie(d, true), 'up', LEAD.babyZombie],
    ['spider', (d) => spider(d), 'down', LEAD.spider]
  ]
  for (const [label, make, mode, lead] of cases) {
    const r = choose('auto', [make(lead)])
    assertMode(r, mode, `${label} at ${lead}`)
    assert.strictEqual(r.lead, lead, `${label}: lead`)
    const why = assertRefusal(choose('auto', [make(lead - 0.01)]), `${label} at ${lead - 0.01}`)
    assert.ok(mentions(why, lead), `${label}: names the lead ${lead}: ${why}`)
  }
})

test('the lead comes from the buildMs passed in, and every threat must clear it', () => {
  assertMode(choose('auto', [zombie(LEAD.zombie)]), 'up', 'control')
  const slow = { up: 4000, down: 2930 }
  const slowLead = requiredLead({ family: 'zombie', baby: false, buildMs: slow.up })
  assert.ok(slowLead > LEAD.zombie, `control: a 4000 ms pillar needs a longer lead than ${LEAD.zombie}, got ${slowLead}`)
  assertRefusal(choose('auto', [zombie(slowLead - 1)], NO_PROBLEMS, slow), `zombie at ${slowLead - 1} with a 4000 ms pillar`)
  const r = choose('auto', [zombie(slowLead)], NO_PROBLEMS, slow)
  assertMode(r, 'up', `zombie at ${slowLead} with a 4000 ms pillar`)
  assert.strictEqual(r.lead, slowLead)
  const why = assertRefusal(choose('auto', [zombie(30), zombie(3), zombie(25)]), 'one of three zombies too close')
  assert.ok(mentions(why, 3), `names the close zombie's distance 3: ${why}`)
  assertRefusal(choose('auto', [zombie(30), zombie(LEAD.zombie, true)]), 'a baby among adults at the adult lead')
})

test('a distance that is NaN, missing or negative refuses', () => {
  assertMode(choose('auto', [zombie(30)]), 'up', 'control')
  for (const dist of [NaN, undefined, -1]) assertRefusal(choose('auto', [zombie(dist)]), `zombie at ${dist}`)
})

test('a requested mode is returned or refused, never swapped', () => {
  assertMode(choose('down', [spider(30)]), 'down', 'control')
  assertRefusal(choose('down', [zombie(30)]), 'requested down, zombie at 30')
  const why = assertRefusal(choose('up', [], { down: null, up: 'no headroom 3 above the feet' }), 'requested up, up problem')
  assert.ok(why.includes('no headroom 3 above the feet'), why)
  assertMode(choose('up', []), 'up', 'requested up, no threats, no problems')
  assertMode(choose('up', [zombie(30)], { down: 'no solid floor 4 below', up: null }), 'up', 'a down problem does not stop up')
})

test('auto with a zombie at 30 and an up problem refuses, naming the problem', () => {
  assertMode(choose('auto', [zombie(30)], { down: null, up: null }), 'up', 'control')
  const why = assertRefusal(choose('auto', [zombie(30)], { down: null, up: 'no headroom 3 above the feet' }), 'zombie, up problem')
  assert.ok(why.includes('no headroom 3 above the feet'), why)
})

test('with no threats auto takes down, then up, and refuses when both have a problem', () => {
  assertMode(choose('auto', []), 'down', 'control: no problems')
  assertMode(choose('auto', [], { down: 'no solid floor 4 below', up: null }), 'up', 'down has a problem')
  const why = assertRefusal(choose('auto', [], { down: 'no solid floor 4 below', up: 'no solid footing' }), 'both have one')
  assert.ok(why.includes('no solid floor 4 below'), `names the down problem: ${why}`)
  assert.ok(why.includes('no solid footing'), `names the up problem: ${why}`)
})

test('entityInCell overlaps the unit cube strictly, touching a face is no overlap', () => {
  const cell = { x: 0, y: 64, z: 0 }
  const box = (x, y, z, width = 0.6, height = 1.8) => ({ position: { x, y, z }, width, height })
  assert.strictEqual(entityInCell(cell, [box(0.5, 64, 0.5)]), true, 'control: centred in the cell')
  assert.strictEqual(entityInCell(cell, [box(-0.25, 64, 0.5, 0.5)]), false, 'touching the -x face only')
  assert.strictEqual(entityInCell(cell, [box(0.5, 65, 0.5)]), false, 'standing on top of the cell')
  assert.strictEqual(entityInCell({ x: -3, y: -10, z: -7 }, [box(-1.75, -10, -6.5, 0.5)]), false, 'negative coordinates, touching the +x face')
})

test('babyFlag is true with no key, false with a key and no value, else the value', () => {
  const keys = ['shared_flags', 'air_supply', 'custom_name', 'is_baby']
  const at = (i, v) => { const m = []; m[i] = v; return m }
  assert.strictEqual(babyFlag([], ['shared_flags', 'air_supply']), true, 'control: no baby key')
  assert.strictEqual(babyFlag(undefined, undefined), true, 'no metadataKeys at all')
  assert.strictEqual(babyFlag([], keys), false, 'is_baby key, no value')
  assert.strictEqual(babyFlag(undefined, keys), false, 'is_baby key, no metadata')
  assert.strictEqual(babyFlag(at(3, true), keys), true, 'is_baby true')
  assert.strictEqual(babyFlag(at(3, false), keys), false, 'is_baby false')
  assert.strictEqual(babyFlag(at(3, 1), keys), true, 'is_baby 1')
  assert.strictEqual(babyFlag(at(3, 0), keys), false, 'is_baby 0')
  assert.strictEqual(babyFlag(at(2, true), keys), false, 'a value at another index')
  assert.strictEqual(babyFlag(at(2, true), ['a', 'b', 'baby']), true, 'baby true')
})

test('expireConfirmed drops every hit older than the max age and keeps one exactly that old', () => {
  const now = 100000
  const hits = new Map([[1, { t: now - 1001 }], [2, { t: now - 1000 }], [3, { t: now - 5000 }], [4, { t: now - 60000 }], [5, { t: now }]])
  expireConfirmed(hits, now, 1000)
  assert.deepStrictEqual([...hits.keys()], [2, 5])
})

test('a stopped up build says how many of its pillar blocks it placed', () => {
  const stopped = { mode: 'up', at: { x: 0, y: 65, z: 0 }, sealed: false, dug: 0, placed: 1, height: 3, gaps: [], exit: [], stopped: 'stopped by the pilot' }
  assert.match(bunkerSummary(stopped), /\b1 of 3\b/, 'stopped after 1 pillar block')
  assert.match(bunkerSummary({ ...stopped, at: { x: 0, y: 67, z: 0 }, placed: 9 }), /\b3 of 3\b/, 'stopped while the shell was built')
})
