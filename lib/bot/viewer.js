'use strict'

const { VIEW_PORT } = require('./config')

let bot

function startViewer () {
  try {
    const { mineflayer: viewer } = require('prismarine-viewer')
    // 07-14: the viewer's browser bundles were REBUILT with modern minecraft-data + a synthesized
    // 1.21.11 atlas (1.21.8 models — newest published assets; every block in this world predates
    // them). The client now resolves bot.version natively — no fallback, no shifted block ids.
    // NOTE: the old `version: '1.21.4'` "pin" here was a NO-OP (mineflayer.js never read that
    // option); the client was silently falling back to the 1.21.4 atlas on its own, which is why
    // most-but-not-all blocks rendered right. install-viewer.sh installs the rebuilt bundles from
    // release-assets/viewer-1.21.11-bundles.tar.gz.
    // prismarine-viewer keeps its http server to itself and listens with no error listener.
    const http = require('http')
    const createServer = http.createServer
    const viewServers = []
    http.createServer = (...args) => { const s = createServer(...args); viewServers.push(s); return s }
    try {
      viewer(bot, { port: VIEW_PORT, firstPerson: true })
    } finally {
      http.createServer = createServer
    }
    for (const s of viewServers) s.on('error', (e) => console.log('[bot] viewer failed (non-fatal):', e.message))
    console.log(`[bot] viewer on http://localhost:${VIEW_PORT}`)
  } catch (e) { console.log('[bot] viewer failed (non-fatal):', e.message) }
}

function createViewer (ctx) {
  Object.assign(ctx, { startViewer })
}

function bindViewer (ctx) {
  ({ bot } = ctx)
}

module.exports = { createViewer, bindViewer }
