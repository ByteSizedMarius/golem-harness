'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { farmlandTop } = require('./helpers')
const { dropLandCases } = require('./drop-land-cases')

test('farmland is the version data\'s 0.9375 high in this file, no shapes override applied', () => {
  assert.strictEqual(farmlandTop(), 0.9375)
})

dropLandCases()
