'use strict'

const { apiGuard } = require('./guard')
const { ROUTE_BOUNDS, ROUTE_COORDS, boundsGuard, coordGuard, requireCoords } = require('./bounds')
const { BadParam, checkName, checkText } = require('./validate')
const { planChat, createChatQueue, QueueFull } = require('./chat-out')
const { targetKind } = require('./walk')
const { STANCES } = require('./bot/stances')
const { GAZE_DIRS } = require('./gaze-dirs')
const { TOOLS } = require('../mcp/tools')

const DISABLED_ROUTES = ['/snapshot', '/record', '/stream', '/pov']
const GOTO_TARGET = ['x', 'y', 'z', 'waypoint', 'player', 'block']
const lower = (v) => v.toLowerCase()
const upper = (v) => v.toUpperCase()
// The case fold each handler applies to an enum param before comparing it.
const ENUM_FOLDS = {
  '/gaze': { dir: lower },
  '/section': { dir: lower },
  '/dig_tunnel': { dir: lower },
  '/dig_stair': { dir: lower },
  '/gesture': { name: lower },
  '/placeitem': { face: upper },
  '/sign': { face: upper }
}
const XYZ_OR_NONE = ['/waypoint', '/fish', '/chest', '/withdraw', '/deposit']
const CHAT_DEFAULTS = { maxLen: 100, gapMs: 2500, maxDepth: 20, allow: ['me', 'tell', 'msg', 'w'] }
// mineflayer's chat limit past which it splits a message, on either server.
const CHAT_MAX_LEN = 256
const MSG_MAX = 400
const LINES_MAX = 5
const SIGN_TEXT_MAX = 90
const ITEM_NAME_MAX = 35

const refuse = (res, status, error) => res.status(status).json({ ok: false, error })

// Answers 400 for the first query param whose check throws BadParam.
function queryGuard (checks) {
  return (req, res, next) => {
    for (const [param, check] of checks) {
      const v = req.query[param]
      if (v === undefined) continue
      try {
        check(v)
      } catch (e) {
        if (!(e instanceof BadParam)) throw e
        return refuse(res, 400, `${param}: ${e.message}`)
      }
    }
    next()
  }
}

const waypointGuard = queryGuard([['name', checkName], ['linkto', checkName], ['note', (v) => checkText(v, { max: 200 })]])
const gotoNames = queryGuard([['waypoint', checkName], ['player', checkName], ['block', checkName]])

function gotoTarget (req, res, next) {
  const q = Object.fromEntries(GOTO_TARGET.filter((k) => req.query[k] !== undefined).map((k) => [k, req.query[k]]))
  const kind = targetKind(q)
  if (!kind) return refuse(res, 400, 'give exactly one target: x and z with an optional y, waypoint, player or block')
  if (kind === 'block' && req.query.range !== undefined) return refuse(res, 400, 'range: a block target stops adjacent and takes no range')
  next()
}

// A boolean query param, as the MCP server sends it.
function flag (v) {
  if (v !== '1' && v !== '0') throw new BadParam('must be 1 or 0')
}

// A str param: one value of 1 to max characters, as checkArgs counts them.
function schemaText (max, allowControl) {
  return (v) => {
    checkText(v, { max, allowControl })
    if (v === '') throw new BadParam('must not be empty')
  }
}

function oneOf (values, fold = (v) => v) {
  return (v) => {
    if (typeof v !== 'string' || !values.includes(fold(v))) throw new BadParam(`must be one of ${values.join(', ')}`)
  }
}

function keyOf (table, fold = (v) => v) {
  return (v) => {
    if (typeof v !== 'string' || !Object.hasOwn(table, fold(v))) throw new BadParam(`must be one of ${Object.keys(table).join(', ')}`)
  }
}

const requireXYZ = requireCoords(['x', 'y', 'z'])

function xyzOrNone (req, res, next) {
  if (['x', 'y', 'z'].some((n) => req.query[n] !== undefined)) return requireXYZ(req, res, next)
  next()
}

function schemaGuards ({ name, route, params }) {
  const guards = []
  const required = Object.keys(params).filter((p) => params[p].type === 'num' && params[p].required)
  if (required.length) guards.push(requireCoords(required))
  if (XYZ_OR_NONE.includes(route)) guards.push(xyzOrNone)
  if (Object.hasOwn(ROUTE_COORDS, route)) guards.push(coordGuard)
  const folds = ENUM_FOLDS[route] || {}
  const checks = []
  for (const [p, spec] of Object.entries(params)) {
    if (spec.type === 'enum') checks.push([p, oneOf(spec.values, folds[p])])
    if (spec.type === 'bool') checks.push([p, flag])
    if (spec.type === 'str') {
      if (!Number.isInteger(spec.maxLen) || spec.maxLen < 1) throw new TypeError(`${name}.${p}: a str param needs an integer maxLen of 1 or more`)
      // planChat strips control characters from chat text.
      checks.push([p, schemaText(spec.maxLen, route === '/chat')])
    }
  }
  if (checks.length) guards.push(queryGuard(checks))
  return guards
}

// The character rules of chat for sign text and item names, refused rather than stripped.
function gameText (max) {
  return (v) => {
    checkText(v, { max })
    if (v.includes('§')) throw new BadParam('§ is not allowed')
  }
}

// The texts of one /chat request: msg is one message, lines is up to five messages split at '|'.
function chatTexts (query) {
  const { msg, lines } = query
  if ((msg === undefined) === (lines === undefined)) throw new BadParam('give exactly one of msg or lines')
  if (msg !== undefined) return [checkText(msg, { max: MSG_MAX, allowControl: true })]
  checkText(lines, { max: LINES_MAX * (MSG_MAX + 1), allowControl: true })
  const parts = lines.split('|')
  for (const part of parts) if (part.length > MSG_MAX) throw new BadParam(`a line is longer than ${MSG_MAX} characters`)
  const texts = parts.map((s) => s.trim()).filter(Boolean)
  if (texts.length === 0 || texts.length > LINES_MAX) throw new BadParam(`lines takes 1 to ${LINES_MAX} lines`)
  return texts
}

function chatRoute (chat) {
  const queue = createChatQueue(chat)
  // Throws here, at startup, on a bad maxLen or allow list.
  planChat('', chat)
  return (req, res) => {
    let texts
    try {
      texts = chatTexts(req.query)
    } catch (e) {
      if (!(e instanceof BadParam)) throw e
      return refuse(res, 400, e.message)
    }
    const chunks = []
    for (const text of texts) {
      const plan = planChat(text, chat)
      if (plan.error !== undefined) return refuse(res, plan.status, plan.error)
      chunks.push(...plan.lines)
    }
    let queued
    try {
      queued = queue.enqueue(chunks)
    } catch (e) {
      if (!(e instanceof QueueFull)) throw e
      return refuse(res, 429, 'chat queue is full, try again later')
    }
    res.json({ ok: true, queued })
  }
}

// The chat line length from GOLEM_CHAT_MAX, CHAT_DEFAULTS.maxLen when unset or empty.
function chatMaxLen (value) {
  if (value === undefined || value === '') return CHAT_DEFAULTS.maxLen
  const n = /^[0-9]{3}$/.test(value) ? Number(value) : NaN
  if (!(n >= CHAT_DEFAULTS.maxLen && n <= CHAT_MAX_LEN)) {
    throw new TypeError(`GOLEM_CHAT_MAX must be an integer ${CHAT_DEFAULTS.maxLen}-${CHAT_MAX_LEN}`)
  }
  return n
}

function installSecurity (app, { token, port, nonceMax, bootMs = Date.now(), chat }) {
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('token must be a string of at least 32 characters')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be an integer 1-65535')
  if (!Number.isFinite(bootMs)) throw new TypeError('bootMs must be a finite number')
  const chatOpts = { ...CHAT_DEFAULTS, ...chat }
  app.use(apiGuard(port, token, { nonceMax, bootMs }))
  for (const route of DISABLED_ROUTES) app.all(route, (req, res) => refuse(res, 403, 'this route is disabled'))
  for (const route of Object.keys(ROUTE_BOUNDS)) app.get(route, boundsGuard)
  for (const tool of TOOLS) {
    const guards = schemaGuards(tool)
    if (guards.length) app.get(tool.route, ...guards)
  }
  app.get('/stance', queryGuard([['set', keyOf(STANCES)]]))
  app.get('/gaze', queryGuard([['dir', keyOf(GAZE_DIRS, lower)]]))
  app.get('/waypoint', waypointGuard)
  app.get('/goto', gotoNames, gotoTarget)
  app.get('/sign', queryGuard([['text', gameText(SIGN_TEXT_MAX)]]))
  app.get('/rename', queryGuard([['name', gameText(ITEM_NAME_MAX)]]))
  app.get('/chat', chatRoute(chatOpts))
}

module.exports = { installSecurity, chatMaxLen }
