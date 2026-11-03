# Combat

## Key rules

- A creeper flee in `takenBy` or a combat event says where it stood. Walk around it, not back.
- A creeper swells within 3, explodes 1.5 s later, and its blast reaches 6. `shoot` it from beyond your flee distance.
- Craft a bow, carry arrows from the early game on, and enchant it with power and unbreaking once you can.

You are the strategist, the combat reflex is the trigger finger. It runs every 300 ms, so a fight is often over before you read its event. Read the narration, then retreat (`goto`, `pillar`) or press (`shoot`, `strike`). A fight refuses digging, placing and crafting outside a bunker.

## How the reflex decides

- Species gate: it scores hostiles only and never starts a fight with a neutral (endermen, zombie pigmen, wolves). Attacking one makes an enemy.
- Behaviour gate: sustained closing at pursuit pace. A zombie charges at about 2.3 blocks/s, and the trigger is 0.6.
- Attribution: a perceived attacker is named ("hit by zombie SW ~2"), any other reads as "something", and both are engaged past both gates. An arrow names the nearest skeleton you see within 15 that faces you, else "hit by an arrow", with a bearing only if seen.
- It kites what it cannot afford to trade with (creepers always, and wither skeletons) and disengages on a tripwire scaled to the last hit taken.
- Damage with no attribution at all freezes all action. A fall, lava, or a sourceless hit with no hostile within 4 only raises a hurt event.
- Perception may flow through the floor, urgency must flow through the path. Enemies a storey away without eye line are `watched:`, narrated, never driving the legs or pack count.
- The legs have one owner. Your movement tools hold a soft lane reflex moves defer to. `brace` holds a hard one that only a creeper, low health, lava, drowning, an unexplained hit or the bunker overrides. `follow` yields to combat mid-fight.
- `stance` sets the reflex's posture. It flees a creeper within 16 (12 vanguard, 8 skirmish), beyond that shoots it given a bow and a clear line, else flees.
- A `goto`, `collect` or job that a reflex stopped names it in `takenBy`, plus what the reflex did and where a perceived threat stands.

## Doctrine

- Bow beyond about 6 blocks (`shoot`), sword to finish (`strike`).
- A creeper 8 or more off with no walk to you within your flee distance is `watched:`. `goto` walks around a watched creeper or answers `creeper` with its cell.
- Break a skeleton's line of sight. Spiders climb walls. At night, get inside early and stay in. Before `strike`, check the hostile is on your side of the wall: `strike` and the reflex treat unseen walls and doors as open.
- Mob senses, paths and attacks: `manual(topic: "mobs")`.
- Night is survivable by civics, not swordplay. `activate` a bed by day to set spawn, at night to sleep (no monsters within 8), until day if another player is up. Body calls wake you.
- The bunker is the last resort: `manual(topic: "bunker")`.

## Beside a teammate

- Agree fire lanes before the cave. The default split: they melee, you hold ranged beyond an agreed line.
- Never loose through their lane. Before a creeper you both run.

## Fleeing

A flee ends on a seen cell: solid floor, no drop over 3 beside or on the way to it, no lava or fire within 2 of either. It lies 8 to 16 blocks from you, away from the threat and other hostiles you perceive within 16, and farther from the nearest than you are now. With none, the body stands still, guard raised. Each creeper flee or stand raises a combat event, at most one per 8 s.

flee_to_player is on by default. When the combat reflex flees, it runs to a player you see within 24 blocks, farther from the threat than you, if reachable, and a `flee_to_player` event arrives through `wait_events`. `reflexes(name: "flee_to_player", on: "0")` switches it off.

On a `pillar` top the body stays put unless a melee mob in reach has your health under the disengage tripwire. A held-back flee raises a combat event.
