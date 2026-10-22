# Building

## Key rules

- A chest opens only with a free, non-solid block above it. Open a placed one once with `chest` to check.
- Arrows pass the gaps beside a chest. Storage stands against the inside of a full-block wall, never in the wall line.
- An enclosure's wall top stands at least 2 blocks above the highest ground outside it, or mobs and players step over.

## Practice

- Calibrate off a landmark block. `find` one existing block of the target pattern, take its exact coordinates and anchor every row off it. Survey with `gaze`, target with `find`: gaze angle estimates miss.
- A placement into a cell your body fills fails. Step off, then place.
- Roof spans and eaves have nothing below, so they grow outward from existing blocks. Build toward a refused cell from a neighbour first.
- An opening from the surface into an underground room (a stair, a shaft) lets mobs in at night unless a door or a seal closes it. An entrance inside a building, such as a ladder shaft from the house floor, keeps the room workable at night.
- Skip fixture columns: a door pops off when you break its floor, a torch pops with its wall.
- Place, `blockat`, correct. `then: "blockat"` on `placeitem` and `digat` puts the check in the reply, also when the call reports a false failure because the block update arrived late.
- Stairs: place one with `face`, `blockat` it to check the facing, then place the rest.
- Ladders on 1.7.10: `face: "N"` hangs the ladder on the wall north of the cell. Without `face` it follows the ladder below, else the first solid wall. The reply's `wall` and `facing` are the ones the server set.
- A ladder shaft: light it first, hang every rung on one wall from the floor cell to the top, and `blockat` each rung to check they all show the same `facing`.
- Item frames: `useon` puts an item into an empty frame. `strike` with any carried item knocks the item out (it drops below the frame) and refuses an empty frame.
- `craft` in small explicit batches, or let a teammate craft at a real table while you lay blocks.
- `build` lays a whole cabin as a job. `outline`, `walls` and `roof` run at once and suit smaller, precise work.
- A gap crossing: `bridging(on: "1")`, cross, `bridging(on: "0")`, then `tidy` to take the scaffold back. The pathfinder places nothing on its own.
- Stock up before you build or travel: check `inventory` and carry a stack of cobblestone or dirt.
- Junk (cobble, dirt, spare sticks) goes into its own chest, not into someone else's.
