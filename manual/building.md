# Building

- Calibrate off a landmark block. `find` one existing block of the target pattern, take its exact coordinates and anchor every row off it. Survey with `gaze`, target with `find`: gaze angle estimates miss.
- Stand clear of your own build cells. Your body blocks a placement, and the error is an unhelpful timeout. Step off, then place.
- Roof spans and eaves have nothing below, so they grow outward from existing blocks. Build toward a refused cell from a neighbour first.
- Skip fixture columns: a door pops off when you break its floor, a torch pops with its wall.
- Place, `blockat`, correct. `then: "blockat"` on `placeitem` and `digat` puts the check in the reply, also when the call reports a false failure because the block update arrived late.
- Stairs: place one with `face`, `blockat` it to check the facing, then place the rest.
- `craft` in small explicit batches and check `inventory` between each, or let a teammate craft at a real table while you lay blocks.
- `build` lays a whole cabin as a job. `outline`, `walls` and `roof` run at once and suit smaller, precise work.
- A gap crossing: `bridging(on: "1")`, cross, `bridging(on: "0")`, then `tidy` to take the scaffold back. The pathfinder places nothing on its own.
- Stock up before you build or travel: check `inventory` and carry a stack of cobblestone or dirt.
