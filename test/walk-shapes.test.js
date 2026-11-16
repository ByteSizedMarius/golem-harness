'use strict'
require('./full-farmland')
const { farmlandStandCases } = require('./farmland-stand-cases')

// Full-cube farmland at y 63 puts the feet at 64.
farmlandStandCases({ feet: 64 })
