'use strict'

// U+2800 renders blank but is not whitespace.
const flatText = (s) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u{2800}]/gu, '').replace(/\s+/g, ' ').trim()

module.exports = { flatText }
