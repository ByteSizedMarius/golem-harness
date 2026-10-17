'use strict'

// fleeDist is the berth the combat reflex keeps from creepers and heavy mobs.
const STANCES = {
  guard:    { fleeDist: 16, bowBand: [7, 24],  chase: false, engage: 'closers',   note: 'default: hold ground, melee closers, bow standoffs, wide creeper berth' },
  skirmish: { fleeDist: 8,  bowBand: [4, 24],  chase: false, engage: 'closers',   note: 'fire support: bow-first from the perch, creepers shot from 8 out' },
  vanguard: { fleeDist: 12, bowBand: [10, 24], chase: true,  engage: 'closers',   note: 'clear the room: run melee targets down, bow only the far ones' },
  sentinel: { fleeDist: 16, bowBand: [7, 24],  chase: false, engage: 'confirmed', note: 'work detail: ignore posturing, fight only what actually hits me' }
}

module.exports = { STANCES }
