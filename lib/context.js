'use strict'

// Shared state that throws when a key is read unset or set to undefined.
function createContext () {
  return new Proxy({}, {
    get (target, key, receiver) {
      if (typeof key === 'symbol' || key in target) return Reflect.get(target, key, receiver)
      // Lets await and Promise.resolve probe for then without throwing.
      if (key === 'then') return undefined
      throw new Error(`ctx.${key} is not set`)
    },
    set (target, key, value, receiver) {
      if (value === undefined) throw new Error(`ctx.${String(key)} set to undefined`)
      return Reflect.set(target, key, value, receiver)
    }
  })
}

module.exports = { createContext }
