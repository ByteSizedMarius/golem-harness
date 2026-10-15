'use strict'

// The unit {x, z} heading away from threat and the other mobs, each pushing harder the nearer it
// stands. Straight away from threat when the pushes cancel out.
function fleeHeading (here, threat, mobs) {
  let x = 0
  let z = 0
  for (const m of [threat, ...mobs]) {
    const dx = here.x - m.x
    const dz = here.z - m.z
    const d2 = dx * dx + dz * dz
    if (d2 < 1e-6) continue
    x += dx / d2
    z += dz / d2
  }
  const len = Math.hypot(x, z)
  if (len > 1e-6) return { x: x / len, z: z / len }
  const ax = here.x - threat.x
  const az = here.z - threat.z
  const alen = Math.hypot(ax, az)
  return alen > 1e-6 ? { x: ax / alen, z: az / alen } : { x: 1, z: 0 }
}

module.exports = { fleeHeading }
