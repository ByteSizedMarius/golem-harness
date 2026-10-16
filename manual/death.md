# Death

## Key rules

- After a death, `goto(waypoint: "lastdeath")`, then `grave(take: "all")` empties the nearest gravestone in sight into your pockets.
- Only you can take all the items from your gravestone. Anyone else takes one item.
- A gravestone holding items cannot be broken.

A death fires a `death` event and stamps the waypoint `lastdeath` where you died.

On a server with graves, the death event says your items wait in a gravestone where you died.
