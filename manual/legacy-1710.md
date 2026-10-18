# Minecraft 1.7.10

On a 1.7.10 server the bot plays by the old rules.

- No shield and no off-hand. `equip` refuses `dest: "off-hand"`.
- The combat reflex holds a sword block through a melee fight. The block cuts a zombie's hit from 3 damage to 2, and the swings still land.
- No attack cooldown: a swing right after an equip lands full damage.
- A hit carries no attacker. A hit that lands as a player within 4 blocks swings once (no swing of theirs in the 0.3 s before), facing the bot, with no hostile mob nearer, counts as no mob's, and its hurt event says "no attacker named, <name> swung nearby". Any other hit counts as the nearest hostile mob's within 4 blocks. Only a mob's hit can fire the bunker reflex.
- Lava, water, doors and digging make no sound. `lava or fizz` in `listen` and in a hear event is lava meeting water, or a burning mob or item going out.
- Lightning is heard as `thunder` plus an `explosion`. An `explosion` right after `thunder` at the same spot raises no hear event.
