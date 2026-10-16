# Combat

You are the strategist, the combat reflex is the trigger finger. It runs in the body every 300 ms, and by the time you read an event the fight is often over. Read the narration, decide to retreat, press or reposition, and override with `stop`, `shoot` or `strike`.

## How the reflex decides

- Species gate: it scores true hostiles only and never starts a fight with a neutral (endermen, zombie pigmen, wolves). Attacking one manufactures an enemy.
- Behaviour gate: sustained closing at pursuit pace. A zombie charges at about 3.8 blocks/s, and the trigger is 0.6.
- Attribution: whatever damages you is named ("hit by zombie SW ~2") and engaged past both gates.
- It kites what it cannot afford to trade with (creepers always, and wither skeletons) and disengages on a tripwire scaled to the last hit taken.
- Damage with no attribution at all freezes all action. A fall, lava, fire, or a sourceless hit with no hostile within 4 blocks only raises a hurt event.
- Perception may flow through the floor, urgency must flow through the path. Enemies a storey away with no eye line are `watched:`: narrated, never driving the legs or the pack count.
- The legs have one owner. Your movement tools hold a soft lane that the reflex's own moves defer to, and `brace` holds a hard one that only survival overrides. Mid-fight, `follow` yields to combat entirely.
- `stance` sets the posture the reflex fights by.
- A `goto` or `collect` that a reflex stopped names the reflex in `takenBy`.

## Doctrine

- Bow beyond about 6 blocks (`shoot`), sword to finish (`strike`).
- Creepers: the reflex flees them for you, and your bow may take them from range. A creeper 8 or more blocks off counts only when it can walk to you within your stance's flee distance. One below a cliff with no way up is `watched:`.
- Break a skeleton's line of sight. Spiders climb walls. At night, retreat early.
- How each mob notices you, paths and attacks: `manual(topic: "mobs")`.
- Night is survivable by civics, not swordplay. Claim a bed spawn by day (`activate` the bed), and at night sleep (`activate` it again, with no monsters within about 8).
- The bunker is the last resort: `manual(topic: "bunker")`.

## Beside a teammate

- Agree fire lanes before the cave. The default split: they melee, you hold ranged beyond an agreed line, unless you agree another.
- Never loose through their lane. Before a creeper you both run.

## Fleeing

A flee ends on a cell you have seen: solid floor, no drop over 3 beside it or on the way there, no lava or fire within 2 of it or of the way. It lies 8 to 16 blocks away from the threat and the other hostiles you perceive within 16. With no such cell the body stands still and raises its guard.

flee_to_player is on by default. When the combat reflex flees, it runs to a player within 24 blocks who stands farther from the threat than you, if such a way leads there, and a `flee_to_player` event arrives through `wait_events`. `reflexes(name: "flee_to_player", on: "0")` switches it off.

On top of a `pillar` the body stays put. It leaves only when a mob in melee reach has your health under the disengage tripwire.
