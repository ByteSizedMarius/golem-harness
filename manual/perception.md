# Perception

You perceive the world only through what the tools say. The usual failure is acting blind: `mine(name: "stone")` with no stone nearby, or `goto` to a coordinate you made up. Look first, then move. A `goto` toward ground you have not seen walks there first and reports what it found.

## No x-ray

A block shows only when a player standing where you stand could see it: exposed to air on at least one face, on an unobstructed ray from your eyes and within the reach of its light. `find`, `goto` to a block, `mine`, `gather`, `section`, `passages`, the ore callouts and the resource hints of `scene` all follow this. Ore buried in solid stone returns nothing until you expose it by mining toward it. Ore in a cave wall, a vein a cliff has sheared open, trees and surface blocks all show. Nothing shows through lava, or through more than 3 blocks of water.

## Light

How far you see a block or a mob depends on the light where it is, block light or sky light, whichever is brighter:

| Light | You see it up to |
|---|---|
| 0 | 2 blocks |
| 1 | 4 |
| 2 | 6 |
| 3 | 8 |
| 4 | 12 |
| 5 | 16 |
| 6 | 24 |
| 7 and up | any distance |

Sky light falls with the time of day, to 4 at midnight, so open ground at midnight shows about 12 blocks out. A dark cave shows the 2 blocks around you until you light it. A torch you place shows its surroundings at once.

## Two tiers of knowing

- Bare name: seen, a real eye ray hit it.
- `?`: unseen. Nothing sees through solid rock or past the reach of the light.

Speak the tiers back. Navigate by structure and mine what is seen.

## Which sense

- `scene` is the default glance. Call it constantly. Its `steps` grid shows how far each cell around you lies up or down, the check before a jump or a climb. Overhead it counts the cover and names its top only when the sky shows. Under rock it gives the first solid you see and leaves the rest unknown.
- `gaze` is the deliberate look, where a person would turn their head. It feeds the seen set and draws `map`. Past the reach of the light it says too dark instead of naming what is there. When a far reading surprises you, check it with `find` before building a theory on it.
- `section` is the cave tool. It shows the vertical structure `map` cannot.
- `passages` answers which ways this space goes.
- `map`: a small radius (8 to 12) for a quick local read, larger to survey. `@` is you, `T` tree, log or leaves, `#` stone, `~` water or lava, `.` ground, `=` built blocks (planks, bricks, glass, furnace, chest), a space air or open, `·` unexplored. It scans the highest surface in each column, so it is a top-down heightmap, not a slice at your feet. Row 0 is north, left is west. Underground, it says so.
- `listen` hears through walls. Danger sounds (lava, fuse, explosion) also arrive as hear events, throttled so a noisy area cannot flood you.
- `entities(radius: 128)` is real sight across caverns and terrain. The server stops tracking mobs past about 128.
- Players: in sight you know where they are, but an invisible player stays unseen. A player who neither sneaks nor is invisible shows a nametag through walls within 64 blocks, which gives a bearing and a distance rounded to 5. `where`, `goto(player: ...)` and `follow` use the same tiers, and a `player` event tells when someone comes into view or goes out of sight. Toward a nametag alone, `goto` and `follow` head for the centre of its 5-block cube until the player comes into sight.

## Scout tower

Blind past the grass: `pillar(height: 12)`, then eight `gaze` sweeps from the top. Gaze rays reach 256 blocks (`gaze(dir: "n", dist: 256)`), and beyond about 64 names collapse to terrain classes, with no ore or chest names at range.
