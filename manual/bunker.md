# Bunker

The bunker is the last resort. The bunker reflex (on by default) builds the same shelter as `bunker(mode: "auto")` on its own, and the `bunker` description covers the tool.

## When the reflex fires

Health below 8 and a hit in the last 15 s that the bot attributes to a mob, a provoked neutral's included. On 1.7.10 a hit carries no attacker, see `manual(topic: "legacy-1710")`. It can fire again once health is back to 12, never while the body stands in its bunker. `reflexes(name: "bunker", on: "0")` switches it off.

## What gets built

Blocks come from your pockets: dirt first, then cobblestone and other stone-like blocks, then planks.

- Dug in, when the block under the feet and every block seen below it down to 3 deep is natural ground (dirt, grass, stone, sand, gravel, netherrack and the like) that takes at most 1.5 s to dig (stone needs a pick), no water or lava stands beside the body or in the ground seen beside the shaft, and that ground shows no opening below the shaft's top cell. The body digs up to 3 deep and stops at an opening, liquid, other block or slow dig under its feet, or at water or lava beside it, which it plugs. At 2 or 3 deep, it fills open sides at feet and head height and caps the shaft over its head. Shallower, the build fails.
- Pillared up 3 blocks, or higher to stand 2 above the highest ground seen within 3 blocks of the pillar, when it has that many blocks, clear headroom and no block beside the pillar a mob could stand on, from its foot up to the head of the body on top. Then a shell on top: a ledge ring under the body, walls on four sides at feet and head height, and a roof. That takes up to 14 more blocks. Out of blocks, the shell keeps its gaps. A pillar over 6 is refused, and against zombies the body flees instead.

Pillaring up holds against zombies, husks and zombie villagers, digging in against spiders. Digging in also holds against skeletons, strays and bogged. With feet or head in water or lava, any other mob near, both kinds near, or a mob too close for the build to finish first, the body flees instead, and the `bunker` tool refuses.

A mob's hit before the body is out of reach stops the build. After that hit, or a build that fails, the body flees if the reflex started the build. The `bunker` tool answers with the reason instead. An arrow does not stop a dig-in. While it builds, no tool walks or digs (the refusal names the bunker), and `stop` ends the build.

## Inside and out

The bunker event says where the body sits, whether the shelter is sealed, and which cells to dig to leave. Inside, the combat reflex holds the body still: fleeing, taking cover and chasing wait until it leaves the cell, and it still swings at whatever comes within reach. You decide when to come out.

- Dug in: `digat` the cap, then `pillar` climbs out, fills the shaft from the same blocks the bunker uses and rises exactly the height you ask for.
- Shell: on a pillar of 2, `digat` the two wall blocks the event names, then `goto` the ground below with its y (without y it stops on the ledge). `goto` drops at most 2, so on a taller pillar `digat` the block under the feet, one at a time, down to the ground. A drop of more than 3 hurts.
