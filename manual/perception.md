# Perception

You perceive the world only through what the tools say. The usual failure is acting blind: `mine(name: "stone")` with no stone nearby, or `goto` to a coordinate you made up. Look first, then move. `goto` walks the open surface whether you have seen it or not, and below it only seen cells.

## No x-ray

A block shows only when a player standing where you stand could see it: exposed to air on at least one face, on an unobstructed ray from your eyes and within the reach of its light. `find`, `goto` to a block, `mine`, `gather`, the ore callouts and the resource hints of `scene` all follow this. `map` and the lay of the land in `scene` show the open surface with no sight line, at any hour. Ore buried in solid stone returns nothing until you expose it by mining toward it. Ore in a cave wall, a vein a cliff has sheared open, trees and surface blocks all show. Nothing shows through lava, or through more than 3 blocks of water.

## Light

How far you see a block or a mob depends on the light where it is, block or sky light, whichever is brighter. Light 0: 2 blocks, 1: 4, 2: 6, 3: 8, 4: 12, 5: 16, 6: 24, 7 and up: any distance.

Sky light falls to 4 at midnight, so blocks, ore and mobs on open ground show 12 out. A dark cave shows 2 blocks around you until lit, but `section` and `passages` read its shape. A placed torch shows its surroundings at once.

A day lasts 20 minutes, with dusk at t=12000 halfway through. Check the time before outdoor work and be inside by dusk. Without sky, `scene` and `state` estimate it: "probably <phase> now". A clock (4 gold ingots, 1 redstone) in hand shows the time in the overworld.

## Two tiers of knowing

- Bare name: seen, a real eye ray hit it.
- `?`: unseen. Nothing sees through solid rock or past the reach of the light.

Speak the tiers back. Navigate by structure and mine what is seen.

## Which sense

- `scene` is the default glance. Call it constantly. Its `steps` grid is the check before a jump or a climb. Overhead it counts the cover and names its top only when the sky shows. Under rock it gives the first solid you see and leaves the rest unknown.
- `gaze` is the deliberate look, where a person would turn their head. It feeds the seen set and draws `map`. Past the reach of the light it says too dark. When a far reading surprises you, check it with `find` before building a theory on it.
- `section` is the cave tool. It shows the vertical structure `map` cannot.
- `passages` answers which ways this space goes.
- `map`: a small radius (8 to 12) for a quick local read, larger to survey. `@` is you, `T` tree, log or leaves, `#` stone, `~` water or lava, `.` ground, `=` built blocks (planks, bricks, glass, furnace, chest), a space air or open, `·` unexplored. It shows the top block of each column from 4 above your feet to 19 below. Row 0 is north, left is west. Underground it says it is a slice.
- `listen` hears through walls. Danger sounds (lava, fuse, explosion) also arrive as hear events, throttled so a noisy area cannot flood you. Most sounds reach about 16 blocks, explosions about 64. A sound gives a distance and a direction, not who caused it.
- `entities` looks 24 out, and `radius` takes it to 128, where the server stops tracking. Within about 20 it also finds mobs and players joined to you by air you have seen or open surface.
- Players: in sight you know where they are, except an invisible one. A player who neither sneaks nor is invisible shows a nametag through walls within 64 blocks, giving a bearing and a distance rounded to 5. `where`, `goto(player: ...)` and `follow` use the same tiers, and a `player` event marks someone coming into or going out of sight. Toward a nametag alone, `goto` and `follow` head for the centre of its 5-block cube until the player is in sight.

## Scout tower

Blind past the grass: `pillar(height: 12)`, then eight `gaze` sweeps from the top at `dist: 256`, with no ore or chest names past 64 blocks.
