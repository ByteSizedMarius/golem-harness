'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { mcpServer, manualFixture, call } = require('./helpers')

const MANUAL = path.join(__dirname, '..', 'manual')
const POINTER = /\nMore: manual\('([a-z0-9-]+)'\)$/

const okBot = () => mcpServer({ reply: () => ({ ok: true }) }).srv

function primerOf (r) {
  assert.ok(r && r.result && Array.isArray(r.result.content), JSON.stringify(r).slice(0, 300))
  const primers = r.result.content.map((c) => c.text).filter((t) => POINTER.test(t))
  assert.ok(primers.length <= 1, `${primers.length} primers`)
  return primers[0] ?? null
}

function keyRulesBlock (topic) {
  const m = /^# .*\n\n## Key rules\n\n((?:- .*\n)+)/.exec(fs.readFileSync(path.join(MANUAL, `${topic}.md`), 'utf8').replace(/\r\n/g, '\n'))
  assert.ok(m, `manual/${topic}.md has no key rules below its title`)
  return m[1].trimEnd()
}

test('the first chest call carries the building key rules, and later calls of the topic do not', async () => {
  const srv = okBot()
  assert.match(primerOf(await call(srv, 'chest', {})), /More: manual\('building'\)$/)
  assert.strictEqual(primerOf(await call(srv, 'chest', {})), null, 'second chest call')
  assert.strictEqual(primerOf(await call(srv, 'walls', { x: 0, z: 0 })), null, 'another tool of the same topic')
})

test('the first reply whose takenBy names a creeper carries the combat key rules, and a later one does not', async () => {
  const combat = `${keyRulesBlock('combat')}\nMore: manual('combat')`
  const unseen = { arrived: false, reason: 'stopped', takenBy: 'the combat reflex took the legs to flee' }
  const creeper = { ...unseen, takenBy: 'the combat reflex took the legs to flee: creeper E ~6, 2 above' }
  const replies = [unseen, creeper, creeper]
  const { srv } = mcpServer({ reply: () => replies.shift() })
  assert.strictEqual(primerOf(await call(srv, 'goto', { x: 1, z: 1 })), null, 'a flee that names no mob')
  assert.strictEqual(primerOf(await call(srv, 'goto', { x: 1, z: 1 })), combat)
  assert.strictEqual(primerOf(await call(srv, 'goto', { x: 1, z: 1 })), null, 'the second creeper take')
  const jobs = mcpServer({ reply: () => ({ ok: true, jobs: [{ id: 1, status: 'cancelled', takenBy: creeper.takenBy }] }) }).srv
  assert.strictEqual(primerOf(await call(jobs, 'jobs', {})), combat, 'a job the creeper flee ended')
})

test('a fresh server brings up the key rules again', async () => {
  for (const run of [1, 2]) {
    assert.match(primerOf(await call(okBot(), 'deposit', { name: 'cobblestone' })) ?? '', /manual\('building'\)$/, `server ${run}`)
  }
})

test('placeitem brings up the building key rules only for a chest', async () => {
  const srv = okBot()
  assert.strictEqual(primerOf(await call(srv, 'placeitem', { x: 1, y: 64, z: 1, name: 'oak_planks' })), null)
  assert.match(primerOf(await call(srv, 'placeitem', { x: 1, y: 64, z: 2, name: 'trapped_chest' })) ?? '', /manual\('building'\)$/)
})

test('an unmapped tool brings up no key rules and leaves them for the first mapped call', async () => {
  const srv = okBot()
  assert.strictEqual(primerOf(await call(srv, 'digat', { x: 1, y: 64, z: 1 })), null)
  assert.strictEqual(primerOf(await call(srv, 'state', {})), null)
  assert.ok(primerOf(await call(srv, 'roof', { x: 0, y: 70, z: 0 })), 'control: the first building call')
})

test('the key rules a reply carries are the topic file\'s key rules block and a pointer to the topic', async () => {
  for (const [tool, args, topic, topics] of [['outline', { x: 0, z: 0 }, 'building'], ['smelt', { item: 'raw_iron' }, 'jobs'], ['grave', { take: 'all' }, 'graves', ['graves']], ['dig_tunnel', { dir: 'n', length: 16 }, 'mining'], ['dig_stair', { dir: 'n', up: '-1' }, 'mining']]) {
    const block = keyRulesBlock(topic)
    assert.ok(block.split('\n').length <= 3, `${topic} key rules`)
    const srv = mcpServer({ reply: () => ({ ok: true }), topics }).srv
    assert.strictEqual(primerOf(await call(srv, tool, args)), `${block}\nMore: manual('${topic}')`, tool)
  }
})

test('createServer refuses a mapped topic without key rules below its title or with more than 3', (t) => {
  const rules = (n) => Array.from({ length: n }, (_, i) => `- Rule ${i + 1}.`).join('\n')
  assert.doesNotThrow(() => mcpServer({ manualDir: manualFixture(t, { 'building.md': `# Building\n\n## Key rules\n\n${rules(3)}\n\n## More\n\n- More.\n` }) }), 'control')
  for (const body of [`# Building\n\n${rules(2)}\n`, `# Building\n\n## Key rules\n\n${rules(4)}\n`]) {
    assert.throws(() => mcpServer({ manualDir: manualFixture(t, { 'building.md': body }) }), { name: 'TypeError', message: /\bbuilding\b/ })
  }
})
