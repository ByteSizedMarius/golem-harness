'use strict'
// bot.js runs as a child process against loopback stand-ins for the Minecraft server and the control port.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { HUNG, ROOT, baseEnv, timed, waitFor } = require('./helpers')

const DEADLINE_MS = 8000

// A loopback TCP server that accepts and never answers.
async function silentServer (t) {
  const sockets = []
  const server = net.createServer((s) => {
    // A killed bot resets its connection.
    s.on('error', () => {})
    sockets.push(s)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    for (const s of sockets) s.destroy()
    server.close(resolve)
  }))
  return { port: server.address().port, sockets }
}

async function freePort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

function runBot (t, env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-bot-'))
  const child = spawn(process.execPath, [path.join(ROOT, 'bot.js')], { cwd, env: { ...baseEnv(), MC_HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await exited
    fs.rmSync(cwd, { recursive: true, force: true })
  })
  const out = { stdout: '', stderr: '' }
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8')
    child[stream].on('data', (d) => { out[stream] += d })
  }
  return { child, exited, out }
}

async function assertExits (run, label) {
  const { out: code } = await timed(run.exited, DEADLINE_MS)
  assert.notStrictEqual(code, HUNG, `${label}: kept running`)
  assert.ok(typeof code === 'number' && code !== 0, `${label}: exited with ${code}`)
}

test('bot.js exits non-zero without connecting to the server when GOLEM_TOKEN is under 32 characters', async (t) => {
  const mc = await silentServer(t)
  const env = { MC_PORT: String(mc.port), CTRL_PORT: String(await freePort()) }
  const control = runBot(t, { ...env, GOLEM_TOKEN: 'k'.repeat(32) })
  assert.ok(await waitFor(() => mc.sockets.length === 1, DEADLINE_MS), 'control: a 32-character token connects')
  control.child.kill()
  await control.exited
  const short = runBot(t, { ...env, GOLEM_TOKEN: 'k'.repeat(31) })
  await assertExits(short, '31 characters')
  assert.match(short.out.stderr, /GOLEM_TOKEN is missing or shorter than 32 characters, refusing to start/)
  assert.strictEqual(mc.sockets.length, 1, '31 characters: connected to the server')
})

test('bot.js exits non-zero when the control port is taken', async (t) => {
  const token = 'k'.repeat(64)
  const mc = await silentServer(t)
  const ctrlFree = await freePort()
  const control = runBot(t, { GOLEM_TOKEN: token, MC_PORT: String(mc.port), CTRL_PORT: String(ctrlFree) })
  const listening = `control API on http://127.0.0.1:${ctrlFree}`
  assert.ok(await waitFor(() => control.out.stdout.includes(listening), DEADLINE_MS), 'control: a free port listens')
  control.child.kill()
  await control.exited
  const taken = await silentServer(t)
  const run = runBot(t, { GOLEM_TOKEN: token, MC_PORT: String(mc.port), CTRL_PORT: String(taken.port) })
  await assertExits(run, 'taken port')
  assert.match(run.out.stderr, new RegExp(`control API cannot listen on 127\\.0\\.0\\.1:${taken.port}`))
})
