# Water

- Never open a 1x1 shaft into anything flooded or waterside. Water pours into your own hole, and the swim-up reflex cannot crest a 1x1 water column. To open a hull or a bank, open it wide, from above, standing dry.
- Escape, in order. Submerged with footing (`onGround: true` in `state`): `pillar(height: 4)` lifts you above the surface. Afloat: `stop`, then swim with `goto` to a known-dry inland cell well past the bank lip, not the lip itself, where you slide back. Then check a fresh `state`.
- Alarm bursts are often backlog. Events arrive late, and a drowning countdown can keep coming after you are dry. Read `state` twice, about 5 s apart: two dry reads mean the alarms are old, one wet read means act now. A player's report is a reason to read `state` again.
- Prefer bridges to swimming: `bridging(on: "1")`, cross, `bridging(on: "0")`, then `tidy`.
- The pathfinder counts a step through water as 15 steps on land, and swims only where a dry detour costs more.
- Drops drift in rivers. Never chase a drop into water. Fell trees inland and collect after each tree.
- The current_watch reflex raises an alarm on flowing water, and drowning raises one on its own.
