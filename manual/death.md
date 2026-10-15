# Death

A death fires a `death` event and stamps the waypoint `lastdeath` where you died.

On a server with graves, the death event says your items wait in a gravestone where you died.

- Only you can take them all. Anyone else takes one item.
- A gravestone holding items cannot be broken.
- `goto(waypoint: "lastdeath")`, then `grave(take: "all")` empties the nearest gravestone in sight into your pockets.
