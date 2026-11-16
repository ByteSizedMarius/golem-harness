'use strict'
// Gives farmland a full-cube collision box in every 1.21.11 registry this process loads.
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-farmland-'))
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }))
process.env.GOLEM_SERVER_OVERRIDES = path.join(dir, 'overrides.json')
fs.writeFileSync(process.env.GOLEM_SERVER_OVERRIDES, JSON.stringify({ ingredients: {}, recipes: [], blocks: {}, shapes: { farmland: [[0, 0, 0, 1, 1, 1]] } }))

const { createConnection, bindConnection, wireConnectionSpawn } = require('../lib/bot/connection')
const bot = Object.assign(new EventEmitter(), { registry: require('prismarine-registry')('1.21.11') })
createConnection({ bot })
bindConnection({ bot })
wireConnectionSpawn()
bot.emit('login')
assert.strictEqual(require('./helpers').farmlandTop(), 1, 'the override was not applied')
