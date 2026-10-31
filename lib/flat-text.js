'use strict'

// U+2800 renders blank but is not whitespace.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u{2800}]/gu

const flatText = (s) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()

module.exports = { INVISIBLE, flatText }
