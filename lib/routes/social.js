'use strict'

const { Vec3 } = require('vec3')

let bot, ok, err

function installSocialRoutes (app) {
  // GET /gesture?name=nod|shake|wave|point[&at=x,y,z] — nonverbal presence for co-op play: the body
  // can say yes, no, hello, and LOOK THERE without chat.
  app.get('/gesture', async (req, res) => {
    try {
      const name = String(req.query.name || '').toLowerCase()
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const yaw0 = bot.entity.yaw, pitch0 = bot.entity.pitch
      if (name === 'nod') {
        for (let i = 0; i < 2; i++) { await bot.look(yaw0, -0.55, true); await sleep(180); await bot.look(yaw0, 0.35, true); await sleep(180) }
        await bot.look(yaw0, pitch0, true)
      } else if (name === 'shake') {
        for (let i = 0; i < 2; i++) { await bot.look(yaw0 - 0.6, pitch0, true); await sleep(180); await bot.look(yaw0 + 0.6, pitch0, true); await sleep(180) }
        await bot.look(yaw0, pitch0, true)
      } else if (name === 'wave') {
        for (let i = 0; i < 3; i++) { bot.swingArm('right'); await sleep(250) }
      } else if (name === 'point') {
        const [x, y, z] = String(req.query.at || '').split(',').map(Number)
        if (![x, y, z].every(Number.isFinite)) return err(res, new Error('point needs at=x,y,z'))
        await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5), true)
        for (let i = 0; i < 2; i++) { bot.swingArm('right'); await sleep(300) }
      } else return err(res, new Error('name must be nod|shake|wave|point'))
      ok(res, { gestured: name })
    } catch (e) { err(res, e) }
  })
}

function createSocialRoutes (ctx) {
  Object.assign(ctx, { installSocialRoutes })
}

function bindSocialRoutes (ctx) {
  ({ bot, ok, err } = ctx)
}

module.exports = { createSocialRoutes, bindSocialRoutes }
