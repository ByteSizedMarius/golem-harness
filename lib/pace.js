'use strict'

// 4 game ticks.
const PLACE_GAP_MS = 200
const PLACE_JITTER_MS = 80
// A player's pause between two whole stacks moved in a container window.
const STACK_GAP_MS = 300
const STACK_JITTER_MS = 150

// Meant for bot._genericPlace, which every mineflayer block and entity placement calls.
function pacePlacements (place) {
  let last = -Infinity
  let queue = Promise.resolve()
  return function (...args) {
    const turn = queue.then(async () => {
      const wait = last + PLACE_GAP_MS + Math.random() * PLACE_JITTER_MS - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      const placed = await place(...args)
      last = Date.now()
      return placed
    })
    queue = turn.catch(() => {})
    return turn
  }
}

const stackPause = () => new Promise((resolve) => setTimeout(resolve, STACK_GAP_MS + Math.random() * STACK_JITTER_MS))

module.exports = {
  pacePlacements,
  stackPause,
  PLACE_GAP_MS,
  PLACE_JITTER_MS,
  STACK_GAP_MS,
  STACK_JITTER_MS
}
