# Mining and pockets

## Key rules

- Diamond and redstone lie below y 16, and caves at y 10 and below fill with lava. Branch-mine on one level, with your feet at y 11 or 12.
- Branch mining: one main tunnel in one compass direction from a hub, a branch off it every 3rd block on both sides, every branch the same length. The way home is the main tunnel.
- A branch that opens into a cave, ravine, lava or water ends there. Save the spot as a waypoint and take the next branch.

## Branch mining

- Go down with `dig_stair` and save a waypoint at its foot. That cell is the hub.
- Dig each branch 16 to 24 long with `dig_tunnel`, then walk back to the main tunnel. Every 3rd block leaves 2 blocks of rock between branches.
- Stay within a set range of the hub.
- Leave `dig_tunnel`'s `torch` on. Ore in a tunnel wall shows only in light.

## Digging

- `find` before `mine`. With nothing in range, `mine` returns `mined: 0` and you learn nothing. `find` shows whether and where it is.
- An empty ore result usually means buried or unlit, not absent. Expose it by digging toward it: open a cave, follow a wall of exposed stone. Light a dark cave before you look.
- `digat` and `mine` step off a block you stand on and dig it from beside. With no cell beside it to stand on (a pillar top, a shaft), they dig it in place and you drop into whatever is below: a cave, lava, a long fall. `gather` refuses targets more than about 2 below your feet.
- `mine` gives up on a block it makes no progress toward for about 5 s, or after a minute, and its `reason` says `stalled` or `budget`. `tidy` stops the same way and keeps the rest queued.
- `dig_tunnel` and `dig_stair` stop at lava or water in sight and at gravel or sand in sight over their way (`dig_stair` also in it). They plug a hole onto lava with filler, step back from falling gravel and stop at gravel that fell in. With `anyway` they dig through it and dig out what falls in. Before a step they wait up to 2 s for falls to land, else stop `still falling`. A `falling from` stop without `stepped back` means walk out at once.
- `digat` needs `anyway` to dig where gravel or sand in sight would fall on you.
- A walk wedged for about 10 s gets the unstuck reflex: it replans, steps back, opens a door or jumps a step, and breaks the block in the way only when you carry one to put back. Failing that, it stops the walk and its event names where you are stuck, against what, and what it tried. Dig out from there.
- When something else holds the hand, `digat` puts a carried tool that harvests the block back in it, or refuses the dig.
- Digs use a fortune pick on ore it multiplies, else a plain one. `silk` is for glass, ice, bookshelves and ore saved for a fortune pick.
- `digat` answers once the server broke the block. A tool's `durability` counts the digs it has left. A nearly broken tool raises a wear event.
- A block of `dig_tunnel` length is two digs: an iron pick lasts about 125 blocks, a stone one 65. Take spares for a long tunnel or a room. A job swaps to one when its pick breaks.

## Pockets

- A full inventory makes pickups fail silently: a gather reports success and your pockets stay empty. Check `emptySlots` in `inventory` before a collection run. An alarm warns at 4 free slots or fewer.
- Overloaded: stop, read the whole inventory once, then act once. Wear armor instead of carrying it: one `equip(name: "iron_helmet")` per piece. Toss true junk, then walk away at once.
- Drops despawn after about 5 minutes. When a drop that matters lies there and your pack is full, free one slot the fastest way, such as a `toss` of junk to a teammate. A tidy trip to the chest costs more than it saves.
- A drop that `collect` reports enclosed lies where no body fits within pickup reach, such as a one-high gap. Dig to it, or `placeitem` a block into its cell, which pushes the drop into an open neighbouring cell.
- Workstations belong at bases. Do not scatter crafting tables, furnaces and chests. Toss junk or carry it home.
