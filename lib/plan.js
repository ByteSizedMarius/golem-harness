'use strict'
const { Vec3 } = require('vec3')

// How far a planned walk may end from the y asked for before a goto refuses it.
const END_SLACK = 2
// The deepest single drop a goto walks without accept.
const DROP_MAX = 3

const cellOf = (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
const round1 = (n) => Math.round(n * 10) / 10

// The numbers of a pathfinder result planned from start, up to the first node whose feet or floor
// cell known() rejects (unseen marks the cut). reaches is true for a search that succeeded through known
// cells, else null, since unseen cells may still hold a way.
function summarizePlan (start, result, known) {
  let prev = cellOf(start)
  let at = { x: start.x, z: start.z }
  let length = 0
  let drop = 0
  let unseen = false
  for (const node of result.path) {
    const cell = cellOf(node)
    if (!known(cell) || !known(cell.offset(0, -1, 0))) {
      unseen = true
      break
    }
    length += Math.hypot(node.x - at.x, node.z - at.z)
    drop = Math.max(drop, prev.y - cell.y)
    prev = cell
    at = node
  }
  const startY = Math.floor(start.y)
  return {
    reaches: !unseen && result.status === 'success' ? true : null,
    length: round1(length),
    rise: prev.y - startY,
    drop,
    end: { x: prev.x, y: prev.y, z: prev.z },
    unseen
  }
}

// Why a goto refuses the plan, or null. The end is judged only on a plan that reaches its goal
// through known cells, against the y asked for and the range allowed.
function planRisk (plan, askedY, range = 0) {
  const risks = []
  if (askedY != null && plan.reaches && !plan.unseen) {
    const off = plan.end.y - Math.floor(askedY)
    if (Math.abs(off) > Math.max(END_SLACK, range)) risks.push(`it ends ${Math.abs(off)} ${off > 0 ? 'above' : 'below'} the y asked`)
  }
  if (plan.drop > DROP_MAX) risks.push(`it drops ${plan.drop} blocks at once`)
  return risks.length ? risks.join(' and ') : null
}

module.exports = { END_SLACK, DROP_MAX, summarizePlan, planRisk }
