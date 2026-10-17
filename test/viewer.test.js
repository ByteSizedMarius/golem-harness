'use strict'
const test = require('node:test')
const assert = require('node:assert')

// lib/bot/config reads the environment once, when it loads.
test('the viewer listens on CTRL_PORT + 1', () => {
  const viewerPath = require.resolve('prismarine-viewer')
  const loaded = ['../lib/bot/config', '../lib/bot/viewer'].map((id) => require.resolve(id))
  const saved = { CTRL_PORT: process.env.CTRL_PORT, VIEW_PORT: process.env.VIEW_PORT }
  const savedViewer = require.cache[viewerPath]
  const seen = []
  try {
    process.env.CTRL_PORT = '4000'
    delete process.env.VIEW_PORT
    for (const file of loaded) delete require.cache[file]
    require.cache[viewerPath] = { id: viewerPath, filename: viewerPath, loaded: true, exports: { mineflayer: (bot, opts) => { seen.push(opts.port) } } }
    const { createViewer, bindViewer } = require('../lib/bot/viewer')
    const ctx = {}
    createViewer(ctx)
    bindViewer({ bot: {} })
    ctx.startViewer()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    for (const file of loaded) delete require.cache[file]
    if (savedViewer) require.cache[viewerPath] = savedViewer
    else delete require.cache[viewerPath]
  }
  assert.deepStrictEqual(seen, [4001])
})
