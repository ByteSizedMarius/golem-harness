# Memory

The world persists, your context does not. Waypoints and their notes are the memory you write, so a later session inherits your map. The bot writes the journal.

- Read `waypoints` at session start. It prints the world graph in about a dozen lines: every named place, its kind, a one-line note, and the `<->` edges recorded from walks you made. It replaces prose route descriptions.
- Never cache routes. The pathfinder solves each trip fresh, so nothing goes stale.
- The moment you find something worth returning to (your base, a village, an exposed vein, a chest), `waypoint` it. Coordinates are cheap to lose and expensive to find again.
- A home waypoint names a cell inside, not the door.
- `goto(waypoint: "home")` records the walked edge from your previous waypoint on arrival. The graph learns by travel.
- Resource waypoints are perishable. `kind: "resource"` marks a claim about the world (a vein, a loot site), and mining it out falsifies it. Then `rm: true`, or re-note it as a place if the location still matters. A stale resource waypoint costs a later session a wasted trip. Doubt any `[RESOURCE]` tag you did not verify this session.
- `journal(n: 30)` reads the log the bot appends: waypoint changes and `goto` arrivals at a waypoint. It is the archive, the graph is the living map.
- A death stamps a waypoint named `lastdeath`.
