# Changelog

Changes to the harness, newest first. Most entries exist because something went wrong in play,
and each says what happened and what the harness does now. A heading's date is the play session,
or the day of a release or removal, and the commit messages carry the detail.


After a restart the pilot followed an old, generic todo item instead of the task it was finishing,
since nothing marked that task. The `todo` tool now takes the action `current`, which marks one open
item as the task in progress. The list and the boot reply show it first, with the time since it was
marked, until it is done or dropped.

## 2026-10-30: hurt events name starvation by the 1.7.10 rule

A hurt event called any small hit at food 0 starvation, so on a 1.7.10 server a hit the bot could
not name read as hunger even at a health or a damage the server never starves at. It now names
starvation only for a hit of 1 at a health the server starves on its difficulty, the rule the bot's
other hit naming already used. The 1.7.10 manual now says how the bot names drowning, cactus,
starvation and knockback hits.

## 2026-10-30: the buried rescue keeps its hand

While the buried self-rescue dug the bot out, pilot routes, the combat reflex and `stop` could swap
the tool in its hand or end its hold on the hand, and two failed digs left the bot held stuck in the
block. While the rescue or a bunker build runs, routes that use the hand now refuse with `busy` and
name what they skipped: before they walk or act, between their equip and their click, and when the
rescue stops their walk. A transfer or a meal already under way stops before its next step and says
what it got done. The combat reflex neither swaps the hand nor moves the body during a rescue, `stop`
leaves the rescue's hold alone, and `equip` still puts on armor.

## 2026-10-30: the buried rescue follows 1.7.10 suffocation

The buried self-rescue judged a head by the 1.21 full-cube rule, so on a 1.7.10 server it dug out of
redstone blocks, TNT, glowstone and retracted pistons, which do not suffocate there, and stayed put
in soul sand and spawners, which do. It now follows the 1.7.10 rule. A head block that takes longer
to dig than a rescue may run, obsidian by hand for one, gives up at once and holds until the block
or the body changes, where the rescue used to restart the dig after every 30 s timeout. Once the
head is clear, a feet block too slow for the time left ends the rescue instead of holding the legs.

## 2026-10-30: replies name only the blocks in sight

Replies and decisions that named a block (lava, water, doors, floors, canopy, plan risk) went by
the cell as the bot remembered it, so a block changed out of sight was named as it was. They now go
by what the bot sees right now, while remembered geometry still plans walks, pillars and dig-ins.
Bunker pillars keep remembered ceilings and walls. A swim that starts afloat stays afloat over
water out of sight. `/map` answers `underground: null` when no cover is in sight. Doors, gates and
trapdoors out of sight no longer reveal whether they are open: hearing and flee checks treat them as
unknown, and `/passages` walks only wooden doors and gates, which open either way.

## 2026-10-30: digs stop only for gravel, sand, lava and water in sight

`digat`, `dig_tunnel` and `dig_stair` refused or stopped for gravel, sand, lava or water the bot
remembered but could not see at that moment, which a player at the keyboard cannot know. They now
decide on what is in sight. `anyway` lets `digat` dig under gravel or sand in sight, and lets
`dig_tunnel` and `dig_stair` dig through it and dig out what falls into their way, up to 8 times a
step. A `mine` refusal under such a column names the `digat` call that takes the fall. Before each
step both jobs wait up to 2 s for falling blocks to land and stop when one is still falling.

## 2026-10-25: line of sight follows block shapes

A drop on a slab floor read as out of sight to the bot standing on the same floor, since every block
with a collision box blocked the bot's line of sight. The line now passes beside and over partial
blocks such as slabs, carpets, stairs, fence posts, open doors and chests, and is blocked only where
it meets a block's shape. Soul sand, mud, honey blocks and powder snow look like full cubes and
block it across the whole cell. Snow blocks it up to the top of its layers, and fences, walls and
fence gates block it only up to 1 block high, though they stop a body at 1.5.

## 2026-10-25: item frames hang on the wall the pilot names

A frame placed in front of a chest went onto the floor's top face, which a 1.7.10 server refuses, or
onto a block across the cell, and calls reported a failure for frames that had hung. `placeitem` now
takes `face` as the wall a frame hangs on, a chest included, never clicks the block below a frame on
a 1.7.10 server, and counts a frame as placed once the server spawns it in the cell, naming the wall
and facing the server set. It refuses a face that already holds a frame in sight, and without `face`
on a 1.7.10 server it picks a wall that holds none. `strike` and `useon` take `at` to pick a frame
by its cell, and `entities` names what each frame holds. Before acting on a frame, `strike` and
`useon` walk to a spot where its face is in swing reach. They say so when no spot in walking reach
puts it there, and say the walk ran out of time when their time, or the path search's think time,
ran out before the body stood in reach. A `strike` that empties a frame waits for the drop to come
to rest, walks onto it, and says it picked the drop up only once the drop has left the floor and the
inventory gained it. Otherwise its reply says what became of the drop, for example that it merged
into another item, was still moving when time ran out, or lay out of walking reach.

## 2026-10-25: the bot knows its own chat by its current name

The chat log dropped the bot's own lines by the name it logged in with. On a server that shows the
bot under another name, its own lines would come back as another player's. The log now compares each
line's sender with the name the server gave the bot when the line arrives, and the spawn log line
names it too.

## 2026-10-25: branch mining in the mining manual

The mining manual gains key rules and a section on branch mining: one level with the feet at y 11 or
12, a main tunnel from a hub with a branch every 3rd block on both sides, and a branch that ends
where it opens into a cave, lava or water. `dig_tunnel` and `dig_stair` replies carry those key
rules, and the floor-digging line follows how `digat` and `mine` step off a block or dig it in
place.

## 2026-10-25: the perception manual reads dark caves by shape

The perception manual said a dark cave shows only the 2 blocks around the bot. It now says that
`section` and `passages` read a dark cave's shape, and no longer lists them among the tools that
need a lit block.

## 2026-10-25: positions name the cell

Chat lines gave the bot's and the speaker's positions rounded, so a body at the centre of its cell
read as the cell to the east or south, and gotos to those coordinates ran into the wall. Chat `me`,
`where` positions, last-seen crumbs and the pulse's position now name the cell the body stands in,
as the F3 block coordinates do.

A goto to a stone cell beside a tunnel was refused as an unseen way, with the target itself as the
edge, and the pilot lit torches and pillared to reach a cell it could already see. A goto whose
asked cell is known and solid, with no stand cell near it, now answers `solid` with the block's
name, so the pilot picks the open cell beside it.

## 2026-10-25: dark caves show their shape

In a dark cave `passages` and `section` called openings sealed, because unlit cells counted as
unseen. Unlit cells in line of sight now give shape only: `section` draws them as dark open or dark
solid and reads floors and walls from them, and `passages` counts them as exits or walls. Block
names, ore, water, slopes and walk-to cells stay lit-only, and a closed door in the dark reads as a
wall whatever it is made of.

A player walked the bot past ore in plain view without a callout, since the passive ore sweep ran
every 4 seconds. The sweep now runs each second while the body moves underground, and every 4
seconds otherwise.

## 2026-10-25: mining jobs keep the drop and use the best pick

A tunnel and a stair dug with a stone pick broke gold and redstone ore without a drop and counted
them as mined, and wore a stone pick down while an iron pick sat in the inventory. The harness now
holds the best pick up to iron that harvests the block, and a diamond pick only where nothing lower
harvests. A job leaves wall ore its held pick cannot harvest in place and lists it under `skipped`.
It stops at such a block in its path with a reason naming the block and the pick tier it needs, and
counts only ore it dug with a pick that harvests it.

## 2026-10-24: floor ore gets dug from beside it

Mining ore in the floor, the bot dug the block it stood on and dropped into the hole, with `digat`
and with `mine`. `digat`, `mine` and `gather` now walk to a cell beside such a block that has a
solid floor, centre the body there and dig from it, and their walks no longer end on top of the
block. If the body stands on the block and no cell beside it holds the body, such as on a pillar top
or in a shaft, `digat` and `mine` dig it in place and the body drops. `gather` skips that block.

## 2026-10-24: sprint jumps under low ceilings

The walk never sprint-jumped under a ceiling two blocks above the floor, though jumps that bump the
head there cover more ground than a sprint walk. It now sprint-jumps under a full-block ceiling, and
keeps the body on its feet on a run from under open sky into such a ceiling, where a hop would hit
the ceiling's side and stop the body.

## 2026-10-24: drop the sprint when the body stops moving

The bot kept sprinting while it pressed into a block or stood on a flee with no path, so players on
a 1.7.10 server saw sprint particles under a bot that wasn't moving. A sprint now ends after 4 ticks
that each move the body less than 0.1 blocks, and the walk, the flee and the sprint opener start
another only once the body has moved a block from there.

## 2026-10-24: one note tool with a memory for each server

The pilot had free text only in one-line waypoint notes, and wrote lessons and papercuts through two
separate tools. A single `note` tool now takes the kinds `memory`, `lesson` and `papercut`. Lessons
and papercuts go to the same files as before. Memory notes, at most 20 of 200 characters each, are
kept in the file `GOLEM_MEMORY` names, listed and dropped by id, and shown at `boot` under a label
that marks them as data. A file over the caps reads as unreadable instead of reaching the pilot.

## 2026-10-24: signs hang on the wall the pilot names

A sign placed in front of a chest hung on the block across the cell, and reading it back showed
every line as "[object Object]". `sign` now takes `wall` (N, S, E or W) to hang the sign on that
wall of the cell, even over a floor, and its reply names the wall and the facing the server set. It
holds the hand against the guard reflex as `placeitem` does, and `blockat` shows each sign line as
plain text.

## 2026-10-24: manual topics follow the server's mods

The MCP server withholds the manual topics that apply only on some servers unless `GOLEM_TOPICS`
names them, so the pilot reads only the topics for the server it plays on. The gravestone rules
moved from `death` into the gated topic `graves`, and the `grave` tool's key rules come from there.
`death` keeps what holds on every server. The topics are picked from the server's mod list by the
launcher (outside this repo).

## 2026-10-24: equip puts armor in its slot

Putting on a helmet took `equip(name: "iron_helmet", dest: "head")`, while a shift-click needs no
slot. `equip` without `dest` now puts a helmet, chestplate, leggings or boots in its armor slot, an
elytra on the back, and anything else in the hand, and the reply names the slot. Like a shift-click,
it refuses when that slot already holds a piece and names the worn one. An explicit `dest` swaps the
worn piece as before.

## 2026-10-24: /chat can wait for its queue

`/chat` takes `wait=1`, which answers only once every queued chat line has been sent. A client that
is about to stop the bot can wait for its last message to go out instead of guessing how long the
queue needs.

## 2026-10-23: chat lines carry where the speaker is

The pilot answered the owner's chat with a place far away while the owner stood right in front of
the bot. Chat and whisper lines now carry where their speaker is, as far as the bot can tell (an
exact position, distance and bearing in sight, a rough distance and bearing by nametag, the last
place it saw them, or `unseen`), and where the bot stood when the line arrived. Every read of the
chat log, in `/tick`, `/chatlog` and `wait_events`, gives each line its age in seconds, so a
replayed line no longer reads as current. `/boot` names the players on the tab list (at most 20,
plus a count of the rest) and gives the dimension and, while the sky shows, the time of day, the
same way `/state` does.

## 2026-10-23: one withdraw call takes several stacks

Sorting chests took one withdraw call per stack, and the pilot repeated an item name inside one call
to take more. The withdraw text now says that count may span stacks. A withdraw without count takes
one stack of the item (16 ender pearls, a single sword) instead of 64 items, and the deposit text
says that no count puts everything in. Both wait up to the longest route timeout, since one call can
move many stacks.

## 2026-10-23: goto refuses long swims, and pillar keeps the legs under water

Three drownings followed long gotos that hopped toward a far waypoint or into a lake without
checking the swim, and a pillar under water was cut off by the drown reflex. A goto, and each hop of
a far one, now refuses a plan that swims more than 3 blocks of deep water unless accept is given,
and a goto that starts in water swims out to dry ground unrefused. The step into deep water costs as
much as a step through it for goto and collect, so a bridge or walkway beside a lake wins over a
swim, and a shallow ford keeps its cost. While a pillar gains a level every 3 s the drown reflex
only raises its alarm, and it takes the legs again on the first reading after the pillar stalls or
oxygen falls to 3.

## 2026-10-23: dig jobs survive a broken pick and falling gravel

The held stone pick broke mid `dig_tunnel`, and the job ended "cannot advance: nudge stalled" with
spare picks in the pockets, never naming the broken one. On 1.7.10, `dig_tunnel` and `dig_stair` now
wait for the server's answer to each dig. A block the server sends back is dug once more after a
fresh equip, and a block sent back twice stops the job, naming the block and the held item. A swap
to a spare pick raises a `mine` event naming the broken pick and the spare.

After `dig_stair` stopped on falling gravel, a `dig_tunnel` toward the same spot let the gravel bury
the bot's head. `dig_tunnel` now stops on gravel or sand that a face dig lays bare over its passage,
and short of such gravel it already knows of. `dig_stair` going up also checks the cell above the
one it digs over its head. After a gravel stop, either job steps one cell back when the body can
stand there.

The suffocation rescue dug the head block in place, so each dug gravel block let the next one fall
in, and the bot lost 15 HP before it walked out. A body whose head is buried now steps to a known
open cell beside its feet whose floor is a full block, the cell it came from first. It digs the head
block only when no such cell exists or the step fails.

## 2026-10-23: the sample pilot memory system is removed

The sample pilot memory system in `examples/`, a tiered markdown graph with a validator, is gone,
and the README no longer links it.

## 2026-10-22: chest moves at a player's pace

The owner watched the bot empty a chest and called it inhuman: every stack moved in the same tick as
the one before.

`withdraw`, `deposit` and `grave` move one stack per mineflayer call and wait 300 to 450 ms between
calls, never inside one, where a combat equip could swap the item on the cursor. A container that
closes during a pause, or a fight that starts, stops the move, and the reply names what it took. The
three routes refuse during a fight. A `withdraw` count reaches past the first matching stack.

## 2026-10-22: follow wakes on a stop

The pilot answered "lead the way" with `follow` and slept in `wait_events`. Nothing fired on
arrival, and the bot trailed the player for 47 s until the player's chat woke the pilot.

A follow sends one `follow` event once the player in sight has stood within 1.5 blocks of one spot
for 5 s, counted only while the bot is near them, and keeps following. It fires again only after
the player moves more than 1.5 blocks from that spot. A stop seen only by the nametag never counts,
and a fight or a lost sight restarts the 5 s.

## 2026-10-21: combat stays inside the walls

Indoors at night, a skeleton outside the wall of a closed room counted as a close threat, and
`strike` walked the bot out the door after it. Flees and cover moves then kept it outside.

Combat weighs a hostile by whether it can walk to the bot past the walls and closed doors the bot
has seen. `strike` and the vanguard chase go only for a hostile the bot can walk to, never through a
closed door or down a drop it can't climb back, and `strike` names the wall when it refuses. Drops
after a kill are picked up only where a short walk reaches them. A walled-off mob is watched until
it hits, except a ranged mob in sight within its range, and stays out of the pack count. Cover stays
on the bot's side of the wall. Water, carpet and an unseen field don't read as walls, and walls the
bot never saw count as open. Livestock is still struck over a fence.

## 2026-10-21: doors and beds on a 1.7.10 server

`activate` on a door's upper half answered `open:false` while the door had opened, because the reply
read the server's echo of the clicked half. Door and gate clicks wait up to half a second for the
toggle. A `goto` through a closed door clicked it twice in one tick, shut it again and stalled. It
sends one click per toggle, walks through and closes the door behind it.

`craft bed` answered unknown item, and `craft white_bed` reported nothing made while a red bed
landed in the inventory. That server has one bed, every 1.21 bed name crafts it, and the reply names
the bed it got.

## 2026-10-21: building tools name their cells and blocks

- `place` of a crafting table answered `on:` with the cell under the table, and the pilot hunted for
  the table with `blockat`. The reply adds the placed cell as `at:`.
- `roof` failed every cell with "no block in pockets" while the bot carried 129 cobblestone, since
  the default roof block is oak planks. A failed cell names the missing blocks, such as `no
  oak_planks in pockets`.
- The pilot passed `roof name:"house_floor"` as a label. The block parameters of `build`, `outline`,
  `walls` and `roof` describe themselves as a block and name their default.

## 2026-10-21: seeing in the dark

Underground beside fresh torches, `scene` read "Dim (light 0)", `blockat` could not see the middle
rungs of a ladder shaft from either end, and `goto` found no way back up a dark stair the bot had
just walked down. `scene` reads the feet by the same light estimate as `blockat` and `find`.
Ladders, scaffolding and vines count as open for sight, so a rung shows from inside its shaft while
a ladder buried in rock stays hidden. Every cell the body passes and every block it stands on is
remembered as seen, so a walked stair stays walkable in the dark.

## 2026-10-21: time underground

Underground the pilot guessed midnight at midday, because `scene` and `state` told the time only
with the sky in sight. Both say when the bot last saw the sky and the phase then ("last saw sky ~10
min ago, day then"). A clock in hand tells the time anywhere in the overworld and nothing in the
Nether or the End.

## 2026-10-21: dig jobs stop when the last pick breaks

`dig_tunnel` went on after its pick broke and mined stone by hand until a nudge stalled. Both dig
jobs end with "no pickaxe left (tool broke)", and a pick too weak for a block still digs on. The
jobs also broke into caves and farms without a word. A seen opening beside the corridor raises a
`mine` event "breached open air at x,y,z", and the job carries on.

## 2026-10-21: event line and combat gate

The pilot chained 64 placements in one turn and learned of nightfall, two hostiles and a whole guard
fight only afterwards. Every bot reply but a `tick` ends with a line naming the event kinds no
`wait_events` or `tick` has shown yet, counted and in arrival order.

A batch of 9 placements ran while the guard reflex fought a zombie. The reflex put the sword back in
hand every 250 ms, the placements swung at the floor, and 6 timed out. World work (every body tool
but the fight, escape, eat and equip tools) is refused while the combat reflex fights, flees, takes
cover or scores a threat, unless the body sits in its own bunker, and while a fight event under
60 s old is unread. A placement, a dig or a meal holds the hand until it ends, and the sword waits.

## 2026-10-21: calm head while walking

Players saw the bot's head twitch on every path, since the pathfinder turns it to each next block: a
zig-zag diagonal turned it 456° in 60 ticks. Other players see an eased gaze 4 blocks ahead along
the path, with a 12° deadband and at most 45° off the walking direction, and the same walk turns it
45°. A forced look, a dig, an item in use or a bite of food shows the real look.

## 2026-10-21: todo priorities

The owner's urgent requests sat under older small ones in a long todo list. An item carries a
priority (high, normal or low), set at `add` or later with `priority`, and the list shows high
first, oldest first within a level.

## 2026-10-19: version split and live-play fixes

The bot speaks 1.21.11 by default, and `GOLEM_MC_1710=1` switches it to 1.7.10 rules for a Forge
server behind ViaProxy, with every 1.7.10 value in `lib/bot/legacy-1710.js`. Rules applied on both
versions follow the server: the hoe on leaves and hay, the sneak and creeper eye heights, lightning
explosions, and chat at 256 characters on 1.21.11 and 100 on 1.7.10.

- The prismarine-viewer fed raw chunks and every entity position to anyone on any interface, with no
  token. Nothing used it, and it is gone, together with its tools
  (`tools/entity-registry/convert.js`, `tools/blockstates-standins.js`, `tools/viewer-qa/`) and the
  upstream leftovers (`BLUEPRINT.md`, `MINDCRAFT-SALVAGE.md`, `backup.sh`, the vault tool). `/pov`,
  `/record` and `/stream` answer that the route is disabled, and `/batch` is gone. The README is
  rewritten for a newcomer.
- `dig_stair` stalled while the combat reflex stayed on a spider 27 blocks off across a ravine,
  still "CONFIRMED (it hit me)" long after. A mob that hit the body stays confirmed 20 s after its
  last hit, longer only while it is in sight within melee reach.
- A creeper by the base dragged the bot back three times: each `goto home` planned past it, and the
  flee pulled the bot 15 to 25 blocks onto ravine edges. A goto plans around a watched creeper,
  outside the stance's flee distance plus 3. When the only way runs past it, the reason is `creeper`
  with its cell, and `accept` walks it anyway.
- On 1.7.10 ladders dug with an axe never dropped, and a later placement found the cell "occupied by
  ladder" while `blockat` said air. mineflayer finished the dig in about 100 ms where the server
  needs about 575 ms with any tool. A ladder digs at hand speed there, and `digat` answers once the
  server's block update arrives, `unconfirmed` after 1.5 s without one and `toolBroke` when the last
  use empties the slot. Durability counts the uses left, the breaking one included.
- On 1.7.10 the server hung a ladder on whatever wall it picked first, so a shaft left its wall at
  the first rung. A ladder goes against the wall `face` names, else the wall of the ladder below,
  else the first solid wall, and a cell without that wall is refused. `sign` refuses a walk over 16
  blocks or a drop over 3, as `placeitem` does.
- `useon` on an item frame answered "used wheat" while the pilot believed the frame held its sword,
  and bone meal on the farmland under a crop said ok and grew nothing. `useon` replies with what the
  server shows in the frame, `strike` knocks the item out and walks to the drop, and bone meal aimed
  at the soil clicks the plant above it and replies its stage.
- On 1.7.10 `craft(ladder, 3)` answered made 3 while the sticks still showed, and birch planks
  turned into an oak button the reply never named. A table craft waits up to 500 ms for the server's
  inventory update and counts after it. A 1.21 wood name the server knows as one item crafts that
  item and says so, and every `<wood>_fence` maps to `oak_fence`. A 2x2 recipe whose table is out of
  reach crafts in the inventory grid.
- `gaze` called a torch-lit stair too dark to see. prismarine-chunk 1.40.0 read light arrays as
  big-endian longs, so each cell of a 16-block row took the light of another, and a sealed stair
  read daylight. `patches/prismarine-chunk+1.40.0.patch` reads them as nibble bytes, and the bot's
  light matches the server's. A 1.7.10 server sends no light after a block change, so there the bot
  relights for itself.

## 2026-10-18: no-path replies name what blocks the way

- The chest opened and sounded once per item kind the pilot moved. `withdraw` and `deposit` take up
  to 8 names separated by `|` in one open and name the ones that matched nothing.
- The pilot heard "LAVA W ~6" with only a zombie around and reported lava. On 1.7.10 the only lava
  sound is the fizz of lava meeting water, which a burning mob going out also makes, so there it
  reads `lava or fizz`. The perception manual gives the hearing ranges (about 16 blocks for most
  sounds, 64 for explosions) and says a sound never tells who caused it.
- Depositing "wheat" put the wheat seeds away, and the pilot dug one half of a double chest the list
  showed as one cell. `deposit` moves the exact name when it is carried, and chest lists name both
  cells of a double chest. `dig_stair` takes `steps`, since stopping the job by hand overshot.
- `goto` answered no-path at an open door, on a lit stair and at a ladder shaft, and the pilot found
  each fix by trial. A no-path reply names what blocks the way: an open door with unseen cells
  behind it, a ladder for a goal above, or the last cell before sight goes dark. `state` names a
  block the body is stuck in, `passages` marks sloped exits, and a `placeitem` that would walk over
  16 blocks or drop more than 3 refuses.

## 2026-10-15: sight follows the light, and one body call runs at a time

The pilot loop:

- Claude Code sends batched tool calls in parallel, and the bot ran them at once: two torch
  placements fought over the path and ended in a ravine, and 8 `deposit` calls sat 5 minutes in
  `[path] reset stuck`. The MCP server runs one body call at a time and refuses a second with `busy:
  goto has run 14 s`. Perception, memory and chat tools run beside it, and `stop` stops the running
  one.
- `wait_events` hands over the oldest items first, and a backlog over 50 comes on the next call
  instead of being dropped. `GET /cursors` and the wake log show a supervising process whether
  anything waits.
- A player asked "what are u working on?" while the pilot ran some 30 calls and never looked at
  chat. Every reply ends with `Unread chat: 2 lines from <name>` while chat waits unread.
- Every chat line no player wrote reaches `wait_events` as a `server` event. Deaths, joins, leaves
  and achievements wake it, at most 6 a minute, the rest arrive quietly, and repeats merge. A server
  line's text stays untrusted.
- 1.7.10 achievements arrive as achievement lines instead of an unfilled template.
- 22 of 121 wakes in one session were noise. Grass, snow and leaves changing by themselves,
  `watched:` threats and ore already called out no longer wake `wait_events`.
- The owner made about 15 requests in one session, and bread, seeds, wood and 64 ore left in a
  furnace were promised or noticed and then forgotten. The `todo` tool keeps at most 30 open items
  in the file `GOLEM_TODO` names and appends them to `boot`. An add with a `who` reminds the pilot
  to say it is queued.
- What the pilot learned in play died with the session. The `lesson` tool appends one paragraph,
  with an optional manual topic or tool it belongs to, to the file `GOLEM_LESSONS` names.
- The pilot never opened the manual in three sessions and walled a hut with chests while
  `manual/building.md` held the chest rules. `DRIVING.md` names the topic for each situation, and a
  topic's `## Key rules` (at most 3 lines) ride along on the first reply of a tool mapped to it. The
  building manual says a chest needs a free block above it and storage goes against the inside of a
  wall, where skeletons had shot through the gaps beside the chests.
- On 1.7.10 every chat line over 100 characters was cut to 100 by ViaVersion's 1.11 to 1.10 step,
  while a player's own client sends 256. A ViaProxy plugin outside this repo raises the cut, and
  `GOLEM_CHAT_MAX` sets the bot's length.
- The prompt and tool list passed their size cap, and the tool descriptions dropped what the replies
  or the manual already say.

Senses:

- `find` with `sense` gave the exact cell of iron 19 blocks behind rock, since the sensed tier
  counted any block facing air connected to the bot's pocket. The tier is gone. A block reaches the
  pilot only in lit line of sight or from the seen set, in every sense and reply.
- Sight knew only lit and dark, so a block lit at level 1 showed at any distance while one at level
  0 stayed hidden at arm's length. Sight distance follows the light at the target: 2 blocks at
  light 0, then 4, 6, 8, 12, 16 and 24, and any distance from light 7 up. Sky light follows the time
  of day, so open ground at midnight shows about 12 blocks out. A nametag still shows through walls.
- `lava_watch` backed away from lava sealed behind rock, `scene` named the surface height through
  solid cover, and the walked trail marked cells seen through walls. `lava_watch` and the trail take
  only cells the body touches or sees lit, and `scene` names the top of the cover only once the sky
  shows. `gaze` rays striking in total darkness read `too dark to see`.
- One dig in a pitch-black cave on 1.7.10 made ore show within about 25 blocks, because unknown
  light around a changed block counted as lit. Only a placed light source marks its reach unknown,
  and a dug cell takes its brightest neighbour's light minus one. Lava blocks sight, and water does
  after 3 blocks. `seen.json` carries a version, and older files are dropped.
- `use` named the block at any loaded cell, rock interiors included, and `passages` flooded through
  unseen cells to reveal a dark tunnel. Both answer only from cells the bot knows, and `activate`
  needs lit sight.
- `/section` summarised "floor: down 13-16" where the real ground lay 61 blocks down. A column
  without a seen floor reads `floor unknown at dN`.
- The body hears through shared air within 20 blocks, down from about 34.
- A chat line with "here" or "this" from a player the bot sees carries the block the player looked
  at, when the bot sees it too.

Players:

- Through the proxy `bot.players` held no entity for players the server tracked, so `where`,
  `follow` and `goto` never found the owner. Lookups find the entity by username, `entities` and
  `scene` name players, and a player named like a mob is never a threat. `where` and `follow` pass
  the same gate as `goto`: exact in sight, a bearing and a rough distance by the nametag, else the
  last sighting.
- A `player` event says when someone comes into view or leaves it, at most once per player per 30 s,
  for information only.
- After a dimension change, entities the server has not updated are left out of every scan, so a new
  mob with an old id is not taken for the one that hit.
- `follow` stays on until `unfollow` or `stop`, as the owner asked, and waits while a fight, a
  bunker or a job holds the legs. A `goto` toward a nametag walks in hops re-aimed at each one.

Walking:

- `goto` plans before it walks and refuses a plan that ends more than 2 blocks off the asked y or
  drops more than 3 at once. `accept` walks it anyway, and `preview` answers the plan without a
  step. The plan's numbers stop at unseen terrain.
- `walls`, `deposit` and other verbs sat for minutes in `[path] reset stuck`. Every walk and collect
  runs under a stall watch, 4.5 s without a block of progress or 60 s in all, and a stall replies
  `stalled at x,y,z` with the block the body presses against. The unstuck reflex acts on a stuck
  loop after about 10 s instead of 30.
- `mine iron_ore count 2` never returned while the bot stood still. `mine` and `tidy` end on
  `stalled` or `budget`, and `mine` counts a block once it is gone from the world.
- The bot wedged at the farm's oak door again and again, since the doorway drill took its axis from
  where the bot stood. The drill reads the axis from the door's state, opens a panel across the way,
  retries once and ends with reason `door`.
- The bot never walked into the owner's hut, and `walls` looped `[path] reset stuck` for 3 minutes.
  mineflayer-pathfinder aimed a door node at the cell corner behind the jamb and planned from inside
  the wall the body stood flush against. `patches/mineflayer-pathfinder+2.4.5.patch` aims a door
  node at its cell centre and starts from the free cell the body is in.
- The unstuck reflex logged "broke a pathing wedge" while the bot stayed wedged. It tries a ladder
  of moves once each: replan from the server's position, step back, open a door or jump a step,
  break the block pressed against and put it back, then stop with an event naming what it tried. It
  breaks nothing it can't put back.
- A sprint crossed the reach band between two door checks and left doors open. Door manners check
  every physics tick, iron doors stay walls, and `scene` lists the doors in sight and a 5×5 grid of
  step heights around the feet.
- Drops wedged where no body fits read `enclosed` with a hint to dig to them, instead of a plain
  miss.
- Reflexes took the legs in silence. A running job keeps its legs until a mob stands in melee range,
  and a reflex that takes them ends the job and is named in `takenBy`.

Pace:

- The owner saw the bot build very fast with its head jumping around. A forced look sweeps at 300°
  per second, 900° in a fight, instead of snapping, and placements go at least 200 ms plus up to 80
  ms apart (`lib/pace.js`). The combat stare waits until the legs are idle.
- On a straight, flat stretch the body sprint jumps and lets go before a turn, a step or a drop
  (`lib/sprint.js`).
- The owner watched the bot sprint jump across the fields and trample them. No hop starts over
  farmland or crops.
- Eating, drinking and drawing a bow stop the legs and drop attacks until the use ends, and a walk,
  sprint or attack lowers a raised guard first.

Combat:

- In one session the reflex fled a creeper about 19 of 21 times while only one blew, and flees ran a
  straight 20 blocks onto lava edges, pinnacles and ravine lips, once off the bot's own pillar at 3
  HP. A creeper 8 or more blocks off counts only when it can walk to the bot. A flee walks only seen
  cells, no step down over 3 and nothing near lava, to the safest cell 8 to 16 blocks away, and
  without one the bot stays put and guards.
- The flee ran straight away from one mob, sometimes into the next, and runs from every hostile
  within 16. The bunker digs in against skeletons, and an arrow no longer stops it.
- A zombie hit never moved the bot. Since 1.21.9 entity velocity is an `lpVec3`, which
  minecraft-protocol 1.66.2 read little-endian and mineflayer 4.37.1 divided by 8000.
  `patches/minecraft-protocol+1.66.2.patch` and `patches/mineflayer+4.37.1.patch` decode and apply
  it, and a zombie hit pushes the bot 1 to 2 blocks.

Items and building:

- A load of 69 iron ore made a 14-minute `smelt` call that ended "nothing yet" with 64 ore inside,
  and it pulled the owner's queued ore out. `smelt` loads the furnace and returns at once with
  `doneInSec`, a furnace busy with another input is refused, and `furnace` shows and takes a
  furnace's slots.
- `/craft` placed a crafting table from the pockets and picked it back up. It uses a table within 16
  blocks or the 2x2 grid. `/place` never picks a cell the body overlaps, the dig jobs take any
  filler block, and `/digat` puts a harvesting tool in hand or refuses.
- On 1.7.10 every crafted fence vanished, since the bot crafted by the 1.21 recipe and the server
  refused the result. `GOLEM_SERVER_OVERRIDES` names a file of the server's recipes, block names and
  item names.
- On 1.7.10 a death puts the items into a modded gravestone, which the proxy showed as a cobblestone
  wall. The proxy (a ViaProxy plugin outside this repo) shows it as an end rod named `gravestone`,
  the `grave` tool takes its items, and the `death` manual topic gives the rules.
- A bucket aimed at grass or a torch poured nothing, and a held bucket always takes the item use.
- The skin and cape live in `skin/`. On an offline-mode server players see them through the client
  mod CustomSkinLoader.

## 2026-10-15: one goto, and arrival means standing there

A scenario test walking onto exact cells could not pass: `range=0` at a drop's y answered "No path
to the goal!", range 1 stopped a cell short of pickup reach, a closed fence gate hung `/goto` 19
times of 19, and "arrived" allowed range plus 1.5 blocks.

- `/goto` takes one target: `x`,`z` with an optional `y`, a `waypoint`, a `player` or a `block`.
  `range` 0, the default, stands on the cell. `/come` and `/goto_wp` are gone.
- Arrival is the pathfinder's own test after the walk, and a failure names one reason, such as
  `no-path`, `walled`, `stalled` or `unseen`.
- A walk ends after 4.5 s without a block of progress, whatever `isMoving()` says, and one 280 s
  deadline covers every attempt and retry.
- Terrain the bot has not seen is walked and reported, never answered up front.
- A player is walked to where the bot sees them, else toward the nametag, else to where they were
  last seen.
- `/collect` walks onto each perceived drop and reports what it could not reach.
- An entity under open sky is perceptible only with a clear eye ray, and an error in the check now
  hides the entity.

## 2026-07-25: the walls verb forgets to eat

No code changed. Open then:

- `walls` burned food from 20 to 0 over its 20-minute loop, and starvation took the bot to 14 HP.
  Long loop verbs need a food floor. The hurt line blamed the combat reflex for the starvation
  damage.
- A `withdraw` count drained one stack (139 asked, 11 moved), and `smelt` collected before the
  furnace finished (27 asked, 11 collected).
- `gather` and `mine` wedged on trees: on the trunk top they wanted, at leaf-shrouded trunks, and in
  a 10-minute spin beside a stale target.
- Two doors left open on a gather trek let the livestock out, and the pilot let the manners events
  scroll past.

## 2026-07-24: the bot takes cover from arrows

The death in the deep cave had three causes: the attacker was dropped, the event misreported it,
and a kept attacker had no answer.

- The distance gate ran before the confirmed-attacker check, so a skeleton at about 33 blocks was
  confirmed and dropped fourteen times. Confirmed attackers stay scored out to 48 blocks.
- A hit whose cause id differs from its direct id is a projectile, whatever the server names as the
  shooter, and attribution lines say "(projectile)".
- A new reflex move, `takeCover`, walks to a cell within 3 that the attacker can't see, else sprints
  out of the sightline. It replaces the shield stare against an archer the bow can't answer, which
  held the body in the line of fire.
- Hurt events say what the body is doing, not that the reflex "has it".

Open then: placements died as empty API replies while the arrows fell.

## 2026-07-23: a death in the deep cave

A run into a deep cave ended in a death. No code changed. Open then:

- A hostile shot up the stair shaft 14 times while the body never moved and every hurt event said
  "combat reflex has it".
- `dig_stair` quit at cavities with "nothing to place" while the pockets held 72 placeable blocks.
- A gravel column suffocated the bot for 5.5 hearts, and the wound did not heal, since the damage
  drained hunger below the regeneration threshold. From then on the pilot dug falling blocks from
  the side.
- A stair walked down was one-way for the pathfinder, since the ledges it dropped off read as walls
  on the way back.
- All three chat kicks followed paced sends of 3 lines, so the pilot kept each send to two lines.

## 2026-07-22: the door deadlock

Doors were a deadlock of three actors. The walk stalled at doorways, the unstuck reflex toggled
doors blind (shutting open ones) and then stopped the pilot's verb, and the 10 s stall check took
path computation for a wedge, so 400-block treks died at second eleven.

- Unstuck checks `open` before it toggles a door, and the path goes on after a door it opened.
- The stall check waits 30 s instead of 10 s while `path_update` events show planning.
- `/safe_goto` retries once on "Path was stopped", which means a reflex intervened.

Open then:

- A short curl timeout hung up mid-walk and read as an empty reply.
- `/toss` couldn't throw past the bot's own pickup range, and its `count` drained one stack.
- `/journal` was read-only to the pilot, and a wandering trader was a dead end with no `/trade`
  verb.
- A movement verb that dragged the body away from a blocking `/smelt` left the output in the
  furnace.
- Eye rays can't confirm air, and the block underfoot is invisible to every sense, so terraforming
  means walking transects and reading the bot's own y.

## 2026-07-21: named blades, and an ally hold that yields

- `/rename?item=&name=` names an item at the nearest anvil.
- The ally hold for packs of 3 or more pinned the body in a pack of six at 9 hearts, twice. Below
  12 HP the hold yields.
- `/eat` failed silently while combat held the hand, so food ran down across fights. The reflex eats
  the best food in the pockets when a fight ends.
- A launch backgrounded in a shell that exits killed the watchdog while node survived. Since then
  the pilot launches with `nohup` and reads "watchdog ended" in `start-nohup.log`, not `bot.log`.

## 2026-07-21: fewer round trips, decisions stay with the pilot

Repeated mechanical steps run in one call, and every decision stays with the pilot.

- `max=N` on `/shoot` (up to 8) and `/strike` (up to 5) runs a bounded volley in one call. `/shoot`
  stops after two arrows at unchanged range, where the pilot had spent about 8 arrows on a wall.
- `/chat?lines=a|b|c` sends up to 5 lines 2.5 s apart, so the pilot no longer waits out the
  anti-kick pacing between lines.
- `/stream` is an SSE feed of every chat line and event, with position, HP and food in each frame,
  and replaces tailing `bot.log`.
- `/batch?do=step|step` chains at most 5 verbs, since an unbounded batch scripts a player.
- `/tick?delta=1` reports only what changed since the last tick.

## 2026-07-21: one owner for the legs

In one fight the legs fled creepers pacing the dark rooms overhead, which the pack counter saw
correctly but which had no path to the bot.

- A mob behind a floor is `watched:` and left out of threat scoring and the pack count. Anything
  that hits is engageable. Perception may pass through a floor, urgency only through a path.
- A running movement verb holds the legs in a soft lane: the reflex's optional moves (a withdrawal,
  kiting to stance range, a chase) wait, and emergencies such as a creeper fuse still pass. In that
  fight ten verbs had failed with "goal was changed".
- `/brace?sec=N`, at most 30, holds the legs against every reflex move but a survival one.
- Follow pauses while the combat reflex is engaged, after its wedge drill froze the legs on a live
  creeper fuse.

## 2026-07-21: three latency cuts from an outside pilot

A pilot outside the project suggested three latency cuts, all landed the same day. One look around
had cost 3 to 4 calls.

- `/tick?chat=&ev=` is one call with the body's essentials, new chat and events, visible hostiles
  and running jobs.
- `?then=blockat` on `/placeitem` and `/digat` returns the acted-on cell in the same reply.
- `?brief=1` strips null fields. Empty arrays stay, since `[]` means the bot looked and found none.
- The hostile list existed twice and disagreed, and there is one now.

## 2026-07-21: the reflex commits to a fight

Three deaths in tight rooms had one cause: the reflex switched between fight and flight and
finished neither.

- A flee runs to an ally within 24 that is not closer to the threat, after blind away-runs led into
  corners and fresh packs.
- In the vanguard stance, which clears a room by running melee targets down, a pack of light mobs
  is fought, not fled, after four zombies wore the bot down from 20 to 0 inside a ring. A heavy mob
  or a creeper in the pack still counts.
- Against light mobs the vanguard stance disengages at 5 HP instead of 8.

Open then:

- The pack counter saw through floors.
- `/eat?name=golden_apple` reported "ate" at 1 HP while the apple stayed in the pocket.
- `/useon` and `/toss` take the first slot matching a name, so a written and a blank name tag look
  the same.
- A step back after a toss that paths over the drop picks it up again.

## 2026-07-20: the viewer learns modern mobs

prismarine-viewer's entity layer was abandoned around 2020 with textures pinned to 1.16.4, so a
caged allay would have filmed as a magenta box.

- `tools/entity-registry/convert.js` regenerates the registry from Mojang's bedrock-samples, 130
  mobs with 36 new.
- `tools/blockstates-standins.js` writes stand-ins for chests and banners, block entities with no
  model.
- `tools/viewer-qa/` screenshots a synthetic world headlessly, so a change is checked without a
  server.
- Vex, evoker and the horse family crashed the renderer on bone names that differed in case, and
  cube rotations turned about the wrong point. The converter fixes both.
- Moved texture paths were found by basename or filled from older dumps, and an unknown entity draws
  as a small brown box.

## 2026-07-20: a film rig

- `/pov` shows the first-person viewer with a HUD and captions of narrator events and chat.
- `/record?on=1&label=…` films `/pov` through headless Chrome into `recordings/`, with ffmpeg in the
  gitignored `tools/ffmpeg/`.

## 2026-07-20: another pilot's field report

Another pilot on another model reported five gaps from one session.

- bot.js never loaded `.env`, although the README said to copy it. bot.js and `start.sh` read it,
  and a `start.sh` argument beats the env, which beats `.env`.
- The pilot could speak and found no way to read chat. `/chat` without `msg` returns the last 20
  lines and the cursor.
- `/place`'s "no valid adjacent ground spot" says what it wanted and points at `/placeitem`.
- `start.sh` hardcoded `MC_USER=Claude` over whatever was set. `bash start.sh <port> [name]` sets
  the name. On an offline-mode server the skin follows the offline UUID.
- Thin snow and short grass read as occupied to every placement check, so builds on a snowy plain
  failed. Soft cover gets broken before a placement, and ground finding scans through it.

## 2026-07-20: enchanting

- `/enchant` without `slot` reads the three offers, and with `slot=0|1|2` it commits. Slot ids remap
  when a window opens, and mineflayer's `ready` event never fires on 1.21, so the route finds items
  in the open window and polls the offers itself.
- `/state` and `/boot` carry `xpLevel`.
- A pack of 3 or more is fled only when no ally stands within 10 blocks.
- `/smelt` failed on a furnace that still held fuel or output. It drains old output, reuses the fuel
  and counts fuel by burn time.
- Holes kept appearing in the house. The collect plugin put its own digging `Movements` into the
  shared pathfinder and never restored the bot's, so every walk after `/mine` could dig through
  builds. `collectSafely` restores them.

Open then: ore callouts like "coal x3 S ~6" were useless two steps later without
coordinates, and `/shoot` spent three arrows on a creeper behind cover at unchanged range.

## 2026-07-19: pilot memory and reading the manual

- A sample pilot memory system shipped: a tiered markdown graph with a validator, since nothing kept
  the pilot across context windows.
- A pilot booted from the memory summary without reading `DRIVING.md`, guessed at verbs all session
  and drowned. The sample's boot drill leads with reading it in full.

Open then:

- The pilot's `/goto` and the drown reflex replaced each other's goals until the air ran out.
- `/bridging` left on after a river crossing let the pathfinder break a house wall 140 blocks later.
- `/tidy` listed a new bridge's deck blocks as litter.
- `/blockat` missed partial-height blocks at point-blank range while `/gaze` saw them.
- A botched restart left two watchdogs writing `bot.log` at once.

## 2026-07-17: survival day

- An ore callout names air-exposed ore within 12 as an event. Its first callout was a diamond the
  pilot had walked past.
- `/inventory` shows durability, worn armour and the offhand, and `/blockat` reads sign text.
- `/chest`, `/withdraw` and `/deposit` take `x,y,z`, since with four chests in one attic the nearest
  was the wrong one.
- A death came from dueling one skeleton while a creeper and two more mobs closed in. With 3 or more
  hostiles within 16 the combat reflex withdraws.
- The drown alarm fired eleven times while a dig held the bot under water down to 2 HP. At oxygen 8
  or less the drown reflex aborts the dig and swims.
- A lost equip race with the combat reflex dug a diamond with the bow. `digat` refuses ore unless a
  sufficient pick is in hand.
- `/craft`'s `count` means items: "craft 12 planks" had eaten 12 logs for 48.
- Obsidian has a pick tier, where an iron pick had broken it without a drop.
- `/eat` takes `name=`, which it had ignored for the best food.
- Golden apples at full hunger fall back to a held right-click, since mineflayer's `consume()`
  refused an emergency heal before a death.
- `lava_watch` beside static lava cancelled the pilot's goal every 4 s and warns once per cell.

Open then:

- A boxed-in body can't place its way out, since placement goes through the pathfinder.
- `/strike` walks to its target, off a ledge into a creeper pit included.
- Solo exploration works with a leash to an anchor, lit ground only and a hard HP retreat line. The
  first test without them died in minutes.

## 2026-07-16: v0.1.0-alpha

First public release: the verb set, the reflex spine, the fairness rule (the bot may use nothing a
player at the keyboard could not perceive) and the journal discipline.

## 2026-07-15: spine and stances

- Combat stances and a ranged reflex, with the bow loosed only along a clear eye ray.
- `lava_watch` vetoes walks at body level, after flowing lava entered a path that was air at plan
  time.
- A flee latch, after twelve "disengaging" events with no escape because each re-entry reset the
  flee goal.
- The disengage tripwire scales with the last hit, after a vindicator hit for 8.6 through iron.
- The manual split into a lean `DRIVING.md` for the pilot and a `FIELD-GUIDE.md` for stories,
  written for any tool-calling model.

## 2026-07-13: field lessons

Rules from four drownings, three chat kicks and a shipwreck went into the manual.

- With a full inventory, gathers reported success while the pockets stayed empty.
- A gaze estimate of "center, ~2 out" meant open water: survey with `gaze`, target with `find`.
- The body blocked its own placements three times on one porch.
- `/craft` turned 25 birch logs into 20 stairs and 3 planks, with about 64 planks unaccounted.
- `placeitem` with `face` waits two ticks for the aim packet before it clicks, which fixed stair
  orientation.
