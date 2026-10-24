# Death

## Key rules

- A death fires a `death` event and stamps the waypoint `lastdeath` where you died.
- `goto(waypoint: "lastdeath")` walks back there.
