# Perception

You perceive the world only through what the tools say. The usual failure is acting blind: `mine(name: "stone")` with no stone nearby, or `goto` to a coordinate you made up. Look first, then move.

## No x-ray

A block shows only when a player standing where you stand could see it: exposed to air on at least one face and on an unobstructed ray from your eyes. `find`, `come`, `mine`, `gather` and the resource hints of `scene` all follow this. Ore buried in solid stone returns nothing until you expose it by mining toward it. Ore in a cave wall, a vein a cliff has sheared open, trees and surface blocks all show.

## Three tiers of knowing

- Bare name: seen, a real eye ray hit it.
- `(sensed)`: exposed to air connected to your air pocket, but with no clear ray right now (around a corner, down a passage). The open space `section` and `passages` report is always this tier.
- `?`: sealed beyond your connected air. Nothing sees through solid rock.

Speak the tiers back. Navigate by structure and mine what is seen: a sensed hint is not a target.

## Which sense

- `scene` is the default glance. Call it constantly.
- `gaze` is the deliberate look, where a person would turn their head. It feeds the seen set and draws `map`. When a far reading surprises you, check it with `find` before building a theory on it.
- `section` is the cave tool. It shows the vertical structure `map` cannot.
- `passages` answers which ways this space goes.
- `map`: a small radius (8 to 12) for a quick local read, larger to survey. `@` is you, `T` tree, log or leaves, `#` stone, `~` water or lava, `.` ground, `=` built blocks (planks, bricks, glass, furnace, chest), a space air or open, `·` unexplored. It scans the highest surface in each column, so it is a top-down heightmap, not a slice at your feet. Row 0 is north, left is west. Underground, it says so.
- `listen` hears through walls. Danger sounds (lava, fuse, explosion) also arrive as hear events, throttled so a noisy area cannot flood you.
- `entities(radius: 128)` is real sight across caverns and terrain. The server stops tracking mobs past about 128.

## Scout tower

Blind past the grass: `pillar(height: 12)`, then eight `gaze` sweeps from the top. Gaze rays reach 256 blocks (`gaze(dir: "n", dist: 256)`), and beyond about 64 names collapse to terrain classes, with no ore or chest names at range.
