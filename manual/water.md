# Water

- Never open a 1x1 shaft into anything flooded or waterside. Water pours into your own hole, and the swim-up reflex cannot crest a 1x1 water column. To open a hull or a bank, open it wide, from above, standing dry.
- Escape, in order. Submerged with footing (`onGround: true` in `state`): `pillar(height: 4)` lifts you above the surface. Afloat: `stop`, then swim with `goto` to a known-dry inland cell well past the bank lip, not the lip itself, where you slide back. Then check a fresh `state`.
- Alarm bursts are often backlog. Events arrive late, and a drowning countdown can keep coming after you are dry. Read `state` twice, about 5 s apart: two dry reads mean the alarms are old, one wet read means act now. A player's report is a reason to read `state` again.
- Prefer bridges to swimming: `bridging(on: "1")`, cross, `bridging(on: "0")`, then `tidy`.
- `goto` and `collect` count a step that starts in water, or a step into deep water (up to the head, or over no solid floor), as 16 steps on land, and a step into a ford (feet-deep over solid floor) as one. They swim only where a dry detour costs more. A `goto` refuses a plan that swims more than 3 blocks of deep water unless `accept`, and swims out unrefused when it starts in water.
- The pathfinder drops at most 3 blocks, into water at most 4, and a drop over 3 needs `accept`. A deep pool at the foot of a cliff is no way down.
- Drops drift in rivers. Never chase a drop into water, and `collect` walks onto drops in water too. Fell trees inland and collect after each tree.
- The current_watch reflex raises an alarm on flowing water you see lit or stand in, and drowning raises one on its own.
