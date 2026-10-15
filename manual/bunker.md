# Bunker

The bunker is the last resort. The bunker reflex (on by default) builds the same shelter as `bunker(mode: "auto")` on its own, and the `bunker` description covers the tool.

## When the reflex fires

Health below 8 and a hit in the last 15 s that the bot attributes to a mob, a provoked neutral's included. On 1.7.10 a hit carries no attacker, see `manual(topic: "legacy-1710")`. It can fire again once health is back to 12, never while the body stands in its bunker. `reflexes(name: "bunker", on: "0")` switches it off.

## What gets built

Blocks come from your pockets: dirt first, then cobblestone and other stone-like blocks, then planks.

- Dug in, when the three cells under the feet are natural ground (dirt, grass, stone, sand, gravel, netherrack and the like), each takes at most 1.5 s to dig (stone needs a pick), their sides and the floor below are solid and no liquid touches them. The body digs them, drops 3 and caps the shaft over its head with one block.
- Pillared up 3 blocks, when it has that many, clear headroom and no block beside the pillar a mob could stand on, from its foot up to the head of the body on top. Then a shell on top: a ledge ring under the body, walls on four sides at feet and head height, and a roof. That takes up to 14 more blocks. Out of blocks, the shell keeps its gaps.

Pillaring up holds against zombies, husks and zombie villagers, digging in against spiders. With feet or head in water or lava, any other mob near, both kinds near, or a mob too close for the build to finish first, the body flees instead.

A mob's hit before the body is out of reach stops the build. After that hit, or a build that fails, the body flees. While it builds, no tool walks or digs (the refusal names the bunker), and `stop` ends the build.

## Inside and out

The bunker event says where the body sits, whether the shelter is sealed, and which cells to dig to leave. Inside, the combat reflex holds the body still: fleeing, taking cover and chasing wait until it leaves the cell, and it still swings at whatever comes within reach. You decide when to come out.

- Dug in: `digat` the cap, then `pillar(height: 3)` climbs out and fills the shaft (it takes cobblestone, andesite or dirt).
- Shell: `digat` the two wall blocks the event names, then `goto` the ground below with its y (without y it stops on the ledge). A drop of more than 3 hurts.
