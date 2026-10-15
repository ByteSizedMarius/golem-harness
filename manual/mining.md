# Mining and pockets

- `find` before `mine`. With nothing in range, `mine` returns `mined: 0` and you learn nothing. `find` shows whether the resource is there and where, then mine it or travel to it.
- An empty ore result usually means buried or unlit, not absent. Expose it by digging toward it: open a cave, follow a wall of exposed stone. Light a dark cave before you look.
- Never dig the block under your own feet. It drops you into whatever is below: a cave, lava, a long fall. Dig into a face ahead of you or above. `gather` refuses targets more than about 2 below your feet, and with `digat` the rule is yours to keep.
- A blocked route is your call: `dig_stair` or `dig_tunnel` on purpose, or another point.
- Equip the right tool right before digs you care about. Tool choice is pick-biased: `digat` grabs a pickaxe for planks and sand. When something else holds the hand, `digat` puts a carried tool that harvests the block back in it, or refuses the dig.
- A nearly broken tool raises a wear event.

## Pockets

- A full inventory makes pickups fail silently: a gather reports success and your pockets stay empty. Check `emptySlots` in `inventory` before a collection run. An alarm warns at 4 free slots or fewer.
- Overloaded: stop, read the whole inventory once, then act once. Wear armor instead of carrying it (`equip(name: "iron_helmet", dest: "head")`). Toss true junk, then walk away at once.
- Drops despawn after about 5 minutes. When something that matters lies on the ground and your pack is full, free one slot the fastest way, such as `toss` of a junk stack to a teammate. A tidy trip to the chest costs more than it saves.
- A drop that `collect` reports enclosed lies where no body fits within pickup reach, such as a one-high gap. Dig to it, or `placeitem` a block into its cell: a block placed over a drop pushes it into an open neighbouring cell.
- Workstations belong at bases. Do not scatter crafting tables, furnaces and chests across the land. Toss junk or carry it home.
