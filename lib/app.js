'use strict'

const express = require('express')
const { installSecurity } = require('./install')
const { countVerbs } = require('./verbs')

function createApp ({ token, port, chat, onRequest }) {
  const app = express()
  installSecurity(app, { token, port, chat })
  // installSecurity's guards and its /chat route are not counted.
  const verbs = countVerbs(app, onRequest)
  return { app, verbs }
}

module.exports = { createApp }
