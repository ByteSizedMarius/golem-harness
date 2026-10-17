'use strict'

const path = require('path')
const { GRAVESTONE, readServerOverrides } = require('../server-overrides')

// The fork root.
const ROOT = path.join(__dirname, '..', '..')

const HOST = process.env.MC_HOST || 'localhost'
const PORT = parseInt(process.env.MC_PORT || '25565')
const VERSION = process.env.MC_VERSION || '1.21.8'
const USERNAME = process.env.MC_USER || 'Claude'
const CTRL_PORT = parseInt(process.env.CTRL_PORT || '3000')
const VIEW_PORT = parseInt(process.env.VIEW_PORT || String(CTRL_PORT + 1))
// Set for a Forge 1.7.10 server behind ViaProxy: no attack charge, a sword block instead of a shield, no off-hand.
const LEGACY_1710 = process.env.GOLEM_MC_1710 === '1'
// On 1.7.10 a full hit lands every 10 ticks at most, and the bot attacks 11 ticks apart.
const LEGACY_HIT_MS = 550
const SERVER_OVERRIDES = readServerOverrides(process.env.GOLEM_SERVER_OVERRIDES)
const SERVER_RECIPES = SERVER_OVERRIDES && SERVER_OVERRIDES.recipes
// The server keeps a dead player's items in a gravestone.
const GRAVES = !!SERVER_OVERRIDES && [...SERVER_OVERRIDES.blocks.values()].includes(GRAVESTONE)

module.exports = { HOST, PORT, VERSION, USERNAME, CTRL_PORT, VIEW_PORT, LEGACY_1710, LEGACY_HIT_MS, SERVER_OVERRIDES, SERVER_RECIPES, GRAVES, ROOT }
