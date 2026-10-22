# Changelog

This harness is **built by playing**: nearly every entry below exists because something
bit us in the world first. Each fix records the wound that taught it — the reasoning is
the point, not just the diff. Dates are play-sessions, not releases. Full commit messages
carry more detail (`git log`). The pilot's text (`DRIVING.md`, `manual/`) states the rules
and leaves the stories here.

## 2026-10-21: event line and combat gate

In the 2026-10-21 play session the pilot chained 64 placements in one turn and learned of
nightfall, two hostiles and a whole guard fight only afterwards, because nothing reaches a
turn unless it calls `wait_events`. Every bot reply but a `tick`, `events` included, now ends
with a waiting events line naming the kinds no `wait_events` or `tick` reply has shown yet,
counted and in arrival order. The MCP server's own replies (`wait_events`, the busy and fight
refusals, `manual`, `papercut`, `lesson` and `todo`) carry none.

A queued batch of 9 placements ran while the guard reflex fought a zombie. The reflex put the
sword back in hand every 250 ms, so placements swung the sword at the floor, 6 timed out, and
the timeouts carried the batch past the end of the fight. World work (every body tool but the
fight, escape, eat and equip tools) is now refused outside a bunker while the combat reflex
fights, flees, takes cover or scores a threat, and the MCP server refuses it without asking
the bot while a fight event under 60 s old is unread. A placement holds the hand from its
equip to its click, a dig until it ends and a meal until the held item is back, and the sword
waits for them. The guard log names each real raise and lowering with its cause.

## 2026-10-21: calm head while walking

Players saw the bot's head twitch whenever it walked a path. The pathfinder turns the head to
the next block's centre every tick, and that yaw is also the walking direction, so over 60
ticks on a zig-zag diagonal the head turned 456°. Other players now see a steady gaze at the
point 4 blocks ahead along the path, eased, with a 12° deadband and never more than 45° off
the walking direction. The same walk turns it 45°. A forced look, a dig, an item in use or a
bite of food puts the real look on the wire, and a forced look keeps its target shown for
1.5 s even after the walk has turned the body back.

## 2026-10-21: todo priorities

In long sessions the todo list grew to many items, and the owner's urgent requests sat under
older small ones, since the list was oldest first and nothing else. An item now carries a
priority, high, normal or low, set at `add` or changed later with the `priority` action. The
list shows high first and low last, oldest first within each level. Files written before keep
every item at normal.

## 2026-10-19: version split and live-play fixes

Two versions. The bot speaks 1.21.11 and defaults to it (`MC_VERSION`). `GOLEM_MC_1710=1`
switches it to 1.7.10 rules for a Forge server behind ViaProxy, and every 1.7.10 value lives
in `lib/bot/legacy-1710.js`. Rules that had been applied on both versions now apply per
version: the hoe digs leaves, hay, sculk and moss on 1.21.11 and stays in the pocket on
1.7.10, the sneak eye height and a creeper's eye follow the server, an explosion right after
nearby thunder counts as lightning only on 1.7.10, where lightning makes one, and a chat line
defaults to 256 characters on 1.21.11 and stays at 100 on 1.7.10. Tests and tool texts name
the version they serve.

No viewer. The prismarine-viewer listened on all interfaces with no token, and its socket fed
raw chunks and every entity position, an x-ray of the world, to anyone who connected. Nothing
used it, so it is gone.

Cleanup. The upstream leftovers are gone (`BLUEPRINT.md`, `MINDCRAFT-SALVAGE.md`,
`backup.sh`, the vault tool), and the README is rewritten for a newcomer.

Confirmed threats lapse. Live, dig_stair stalled while the combat reflex stayed engaged
against a spider 27 blocks off across a ravine, and its events kept calling it "CONFIRMED (it
hit me)" long after it had moved off. A mob that hit the body now stays confirmed for 20 s
after its last hit, longer only while the body sees it in melee reach. A new hit confirms it
again at once.

Walks round a watched creeper. Live, a creeper by the base kept dragging the bot back: each
`goto home` planned straight past it, came into flee range, and the flee pulled the bot 15 to
25 blocks back onto ravine edges, three times in a row. A goto now plans and walks around a
creeper the reflex only watches, keeping outside the stance's flee distance plus 3 and never
closing in on one it already stands within. When the only way runs past it, the reply's reason
is `creeper` and the hint names the creeper's cell. `accept` walks the way anyway.

Digs wait for the server. Live on 1.7.10, ladders dug with an axe never dropped, and a later
placeitem found the cell "occupied by ladder" while blockat had said air. mineflayer timed
the ladder at about 100 ms with the axe, but the 1.7.10 server breaks it at about 575 ms
whatever the tool, so it resent the ladder, and a second early finish while one was pending
kept the block for good, after digat had already answered "dug" on mineflayer's own air
write. A stone pick at 1 durability also dug twice more, because 1.7.10 breaks a tool on the
use that takes its damage past the maximum. On 1.7.10 a ladder now digs at hand speed with
any tool, digat answers once the server's block update arrives, fails with ok:false when the
server keeps the block, says unconfirmed when no update comes within 1.5 s, and reports
toolBroke when a tool's last use empties its slot. durability counts the uses a tool has
left, the one that breaks it included.

Ladders hang where asked. Live on 1.7.10, placeitem's face did nothing for a ladder, and the
wall it landed on depended on the block below: over a solid block or a ladder the bot
clicked the top face and the server hung the ladder on whatever wall it picked first, so a
shaft left its wall at the first placement. A 1.7.10 ladder now goes against the side of a
wall: the one face names (N hangs it on the wall north of the cell), else the wall of the
ladder below, else the first solid wall, never the block below. A cell without that wall is
refused, a ladder the server rejects names its wall, and the reply carries the server's
facing and the wall it hangs on, with the wanted wall beside it when they differ. sign walks
like placeitem, refusing a walk over 16 blocks or a drop over 3.

Item frames and bone meal answer from the server. Live, the pilot framed wheat with `useon`
and was told "used wheat" while it believed the frame got its sword, and bone meal clicked
on the farmland under a crop said ok and grew nothing. `useon` on a frame now picks the
nearest empty one and replies with the item the frame shows after the server's update.
`strike` on a frame knocks the item out with one swing, walks to the drop and refuses an
empty frame, which a strike would knock off. Bone meal aimed at the soil under a seen crop
or sapling clicks the plant and replies its age or stage.

Crafts count what the server made. Live on 1.7.10, `craft(ladder, 3)` answered made 3 while
the used sticks still showed, and birch planks turned into an oak button the reply never
named. On 1.7.10 a table craft now waits for the server's inventory update (at most 500 ms),
counts the item after it, and says `unconfirmed` when none came. A pass the server makes
nothing from ends the craft with a note. A request under a 1.21 wood name the server knows
as one item, such as `birch_button`, crafts that item and says so. Every 1.21 `<wood>_fence`
maps to the one 1.7.10 fence, `oak_fence`. A 2x2 recipe whose seen table is out of reach
crafts in the inventory grid and says so. Recipe overrides take several entries for one
item.

Light by the right cell. Live on the 1.7.10 server, `gaze` called a torch-lit stair too dark
to see, and one more torch fixed it. prismarine-chunk 1.40.0 read the server's light arrays
as big-endian longs, so in every 16-block row the bot took each cell's light from another
cell of the row, x 0 from x 14 and x 2 from x 12, on 1.21.11 as on 1.7.10. In a sealed stair
that read open daylight. `patches/prismarine-chunk+1.40.0.patch` reads and writes them as
plain nibble bytes, and the bot's light now matches the server's in every cell, in a 1.21.11
tunnel and in a 1.7.10 stair before and after a relog. A 1.7.10 server sends no light after
a single block change, so on 1.7.10 the bot now relights for itself: a torch picked up
beside another leaves the other's light, a block laid in a lit tunnel shades the cells past
it, and a wall dug into a dark tunnel lets the light on down it. Underground on 1.7.10,
cells no longer read open sky they never had.

## 2026-10-18: live-play fixes

Chest batches. Live, the pilot moved several item kinds one call each, so the chest opened
and its sound played once per kind. `withdraw` and `deposit` now take up to 8 names
separated by `|` and move them all with one open. The reply lists each kind moved, plus
`missing` for names that matched nothing, and `count` applies to each name.

Lava or fizz. Live, the pilot heard "LAVA W ~6" by the base where the only thing around was
a zombie, and reported lava. On 1.7.10 the only lava sound is the fizz of lava meeting water,
and a burning mob going out makes the same fizz. On a 1.7.10 server the hear event, `listen`
and the scene's Hear: line now say `lava or fizz`, still a throttled hear event. The pilot
also took an explosion heard at ~55 for one near the owner. The perception manual now gives
the hearing ranges: most sounds reach about 16 blocks, explosions about 64, and a sound gives
a distance and a direction, not who caused it.

Exact chest names and double chests. Live, depositing "wheat" while carrying wheat and wheat
seeds put the seeds away, and the pilot dug one half of two double chests because the chest
list showed each as one cell. `deposit` now moves the exact name when it is carried and falls
back to the substring otherwise, and each reply entry names the item it moved. Chest lists
and the chest-full error name both cells of a double chest. `dig_stair` takes `steps` (1 to
24), so the pilot no longer polls and stops the job, which overshot by a step or two.

Walk hints. Live, `goto` answered no-path again and again at an open door, on a lit stair
and at the foot of a ladder shaft, and each time the pilot found the fix by trial. A no-path
or unseen-way reply now names what blocks the way from where the bot stands: an open door
with unseen cells behind it, a ladder in sight when the goal lies above, or the last cell
before the bot's sight goes dark, where a torch would light the way. A follow that finds no
way says the same. The pilot also started a session inside a cobblestone wall and got
"unreachable without digging": `state` now names a block the body is stuck in, and the stall
reply says so. `passages` marks an exit that slopes up or down, so a dug staircase shows as
one. A `placeitem` that would walk more than 16 blocks, or drop more than 3 at once,
refuses instead of walking the bot out over a ravine.

## 2026-10-15: live-play fixes

Busy body. A client that moves a tool call running past 10 s into the background lets the
pilot chat and look around while a long walk runs, but the body queue held every body call
sent meanwhile until the walk ended. The MCP server now refuses a body call while another
runs, at once: `busy: goto has run 14 s. Info and chat tools work meanwhile, stop cancels
it.` The `Waited` line and the queue's errors are gone, and `stop` and `job_stop` stop the
running action with nothing queued to cancel. The wake log marks `wait_events started` beside
`wait_events returned`, so a supervising process sees when a wait begins.

Event backlog. `wait_events` now hands over the oldest items first, and a backlog over 50
comes on the next call at once instead of being dropped. The bot has a side-effect-free
`GET /cursors`, and the MCP server writes the chat and event cursors it handed the pilot to
the wake log, so a supervising process sees whether anything new waits.

Senses and item use. The body hears through shared air within 20 blocks, down from about 34.
A sky-lit floor deeper than 15 below high ground on both sides counts as underground. Eating,
drinking and drawing a bow stop the body's legs and drop its attacks until the use ends, and a
walk, sprint or attack lowers a raised guard first.

Skin. The bot's skin and cape moved into `skin/`. On an offline-mode server players see them
through the client-side mod CustomSkinLoader, since the bot cannot push a skin there.

Building manual. Live, the pilot opened the owner's hut walls and put chests into the wall
line. A solid block sat right above them, so they could not be opened, and skeletons shot
through the gaps beside them. `manual/building.md` now says a chest needs a free block above
it, storage goes against the inside of a wall, an enclosure's wall top stands 2 blocks above
the highest outside ground, and junk gets its own chest. The craft batch line no longer asks
for an `inventory` check, since the craft reply reports the count.

Key rules on first use. The pilot walled the hut with chests while `manual/building.md`
already held the chest rules: it never asked for that topic. A manual topic can now open with
a `## Key rules` list of at most 3 lines, and the first call in an MCP server process of a
tool mapped to that topic gets those lines and a `manual('<topic>')` pointer appended to its
reply, once per topic. `chest`, `deposit`, `withdraw`, `walls`, `roof`, `build`, `outline`
and a `placeitem` of a chest bring up building's storage and wall rules, `smelt` and
`furnace` bring up jobs' smelting rules. The tool list stays as it was, and the lines count
against the reply size cap. Farming has no topic yet, so `use` with a hoe or seeds brings up
nothing.

Chat length. On the 1.7.10 testbed every line over 100 characters arrived cut to 100, while
the owner's own client sends up to 256 there. The cut is ViaVersion's 1.11 to 1.10 step,
and a ViaProxy plugin raises it to 256 for a 1.7.10 server. The chat line length is
`GOLEM_CHAT_MAX` (100 to 256, 100 when unset), and the `chat` description names both
lengths. The MCP wake log now names the params each tool call passed, never their values,
so unused tools and params can be counted and trimmed later.

Todo list. In one live session the owner made about 15 requests, and bread, seeds, wood for
the owner and 64 ore left in a furnace were promised or noticed and then forgotten. Pending
work lived only in the model's context. The MCP server now serves a `todo` tool (add, done,
drop, list, at most 30 open items) that keeps the list in the JSON file `GOLEM_TODO` names,
answers every call with the open list, and appends that list to the `boot` reply, so a
restarted pilot sees what it still owes. Without the variable the tool answers that todos
are off.

Lessons. What the pilot learned in play (a game fact, a rule worth having, a tool text that
misled it) lived only in its context and died with the session, while `papercut` takes only
what made playing harder. The MCP server now serves a `lesson` tool beside it: one paragraph
of text and an optional `for` naming where it belongs (a manual topic, a tool name or
`rules`, letters, digits, `-` and `_` only), appended under the papercut header plus
`| for <where>` to the file `GOLEM_LESSONS` names, at most 20 per server process. Without the
variable the tool answers that lessons are off.

**Server recipe overrides.** On the 1.7.10 testbed every crafted fence vanished a moment later. The
bot crafted by the 1.21 recipe (4 planks and 2 sticks make 3) while the server knows only 6 sticks
making 2, so the server refused the result and the resync wiped it. A door showed 3 and the server
made 1. `GOLEM_RECIPE_OVERRIDES` names a JSON file of the server's own recipes, and `/craft` crafts
an item listed there by that recipe only: it checks the ingredients against it and counts `made` by
its yield. Without the variable crafting is unchanged.

**Gravestones.** On the 1.7.10 testbed a death puts the player's items into a modded
gravestone, and the proxy showed it as a cobblestone wall, so the bot could neither tell a
grave from a wall nor open one: `/chest` takes only chests, and mineflayer's `openContainer`
refuses any other block name. The proxy now shows the grave as an end rod, which no 1.7.10
world holds, and the overrides file renames blocks: `GOLEM_RECIPE_OVERRIDES` became
`GOLEM_SERVER_OVERRIDES`, a file of recipes plus a `blocks` map, and
`lib/server-recipes.js` became `lib/server-overrides.js`. A block mapped to `gravestone` is
renamed in the registry at spawn, so scene, find, blockat and every event name it
gravestone. The `grave` tool lists the gravestone at x,y,z or the nearest one in lit sight
and with `take` (all or an item name) moves its items into the pockets through `openBlock`,
reporting what reached them. On such a server the death event and the `lastdeath` note say
the items wait in a gravestone there, and the new `death` manual topic gives the rules.

**Knockback.** A zombie hit never moved the bot. Since 1.21.9 the server sends entity
velocity as an `lpVec3`, 48 bits sent as two bytes and one big-endian int (vanilla and
ViaVersion alike). minecraft-protocol 1.66.2 reads and writes that int little-endian, so every
vector decoded scrambled: a zombie's push of (-0.4, 0.4, 0) as (0.6, -0.002, -0.239), a
standing player's (0, -0.0784, 0) as (1, 0.994, 0.859). mineflayer 4.37.1 then divided the
result by 8000 as if it were the old fixed-point shorts, which shrank the garbage to nothing.
Dropping only the division threw the bot about on every hurt, starvation included.
`patches/minecraft-protocol+1.66.2.patch` reads and writes the int big-endian, and
`patches/mineflayer+4.37.1.patch` applies the decoded vector, blocks per tick, from 1.21.9 on,
older versions keeping the division. A zombie hit now pushes the bot 1 to 2 blocks away from
the zombie, and starvation leaves a standing bot where it stands.

1.7.10 achievements arrive as achievement lines ("Claude has just earned the achievement
[Taking Inventory]") instead of an unfilled template, since ViaVersion sends their key already
replaced by its English format.

The head jittered on every walk past a mob: the combat reflex's standoff stare forced a look at it
every 250 ms while the pathfinder turned the head toward its next node every tick, and the yaw is
also the walking direction. The stare now waits until the legs are idle (`lib/head.js`). Melee and
bow aims are unchanged.

Head and hands at a human pace. The owner, watching live: "claude builds very fast and its head
jumps around." A forced look sent its final angle in one packet, so every aim snapped. It now sweeps
at 300 degrees per second, one step per tick, and sends its last step before the place, dig or
swing that waited for it. A turn under 15 degrees still goes out at once, a newer look ends a sweep
under way, and while the combat reflex fights the sweep runs at 900 degrees per second, so a full
about-face takes about 200 ms against the 550 ms swing cadence on 1.7.10. Unforced looks, the
pathfinder's steering among them, keep mineflayer's own easing. Block placements go out one at a
time, at least 200 ms plus up to 80 ms of jitter apart, through the one function every builder,
the pathfinder's bridging included, places with (`lib/pace.js`). The Fields rule below also held
the jump over a gap: the pathfinder's sprint jump fires where only a jump reaches the next node,
and a parkour node with farmland past the gap was sprinted into without one. A parkour node now
always keeps the jump.

On a straight, flat stretch the body now sprint jumps: four nodes ahead in line, room for the jump
over each, dry, food at least 8 and no fight running. It lets go before a turn, a step or a drop
(`lib/sprint.js`). The pathfinder counts a node reached only with the feet less than a block above
it, so a hop passes nodes it never ticks off. The layer drops those from the live path instead of
letting the pathfinder turn back for them, along the hop's own run only, never a node where the path
turns. The first cut never jumped live: the plugin loader adds the pathfinder's tick listener only
once `bot.js` has run, so the layer ticked before it and the pathfinder set jump back to false on
every straight stretch. The layer now hooks in after it, and lets go of the jump when a path resets
or the walk stops.

`goto` plans before it walks, and refuses a plan that ends more than 2 blocks (or `range`) off the
asked y or drops more than 3 at once, naming the risk and the numbers. `accept` walks it anyway, and
`preview` answers the plan without a step: whether it reaches, its length, rise, biggest drop and end
cell (`lib/plan.js`). The numbers stop where the plan enters terrain the bot has not seen, so a
preview never maps a hidden cave, and a hidden drop never refuses a walk. Past that point `reaches`
is null, since whether the pathfinder found a way through unseen terrain is itself a map of it. A
failed search reads null too, as it may have searched unseen terrain, so `reaches` is only ever true
or null.

Movement papercuts from the 15:03 session: door manners now check every physics tick instead of
every 400 ms, a beat in which a sprint crossed the whole reach band and left the door open, and shut a
door once the body went through it and stands clear. Iron doors stay walls, `scene` lists the doors in
sight, and a failed `goto` names the door beside it and how far it walked. Water drops are held to the 3-block
limit of dry ones. `scene` carries `steps`, a 5×5 grid of the step heights around the feet, with
unseen cells as `?` (`lib/steps.js`), also where no standing cell was found and the grid would
otherwise have called an unseen cell a wall or a drop.

The walking review's deferrals: a lane claim returns a token, and a route's release clears only its
own claim, so a stale handler can no longer drop the claim a newer route took after `/stop`. The
hurt freeze clears the goal too, which ends a path still being planned before its first step. A
nudge that ends during a drown rescue leaves the swim-up's jump held. The doorway drill picks only
doors the bot has seen. `airPrecheck`'s flood asks whether a cell is known only for the walls of a
fill that stayed closed, not for every cell it touches.

Players. Through the proxy, `bot.players` held no entity for a player the server tracked, so
`where`, `follow`, goto's player target and the breadcrumbs never found the owner, while the
flee toward a player (which scans the entities) did. Every lookup now finds the player's entity
by username, `entities` names players by name instead of `player`, and `where` and `follow` pass
the same gate as `goto`: in sight exact, by the nametag a bearing and a distance rounded to 5,
else the breadcrumb. A `player` event says when someone comes into view, shows only by the
nametag or goes out of sight, at most once per player per 30 s, entering within 60 blocks and
leaving past 68. The owner's wording: "just as an FYI, not for Claude to act on", and the event
says so. Presence forgets a player out of sight for 10 minutes and remembers at most 200, the
longest unseen dropped first. After a dimension change, entities the server has not updated since
are left out of every scan: `tick`'s threats, `entities`, `scene`, the hostile alarm, the narrator,
the combat reflex's flee and target scans, and the drop pickup. The rest followed: the bunker's
threats, the hit attribution, the ally checks, `useon`, `strike`, `shoot` and the placing blockers,
and a dimension change clears the confirmed aggro and the last hit, so a new mob that gets an old id
is not taken for the one that hit. A player named `__proto__` or `constructor` is a
`scene` group like any other, since the groups keyed by name no longer inherit from `Object`.

Follow stays on until `unfollow` or `stop` ("it should stay on until i say so"). Reaching the
player, a stall, a fight or a lost sight no longer ends it. It waits while a fight with its flee and
cover moves, a bunker build, a job or any other tool call holds the legs, the call for at most 300 s,
and while the body stands in a finished bunker. After a reflex took the legs, or a bunker build ended,
it waits 3 s more, 5 s after the hurt freeze or a lava take. It re-arms once the goal is cleared,
runs the doorway drill only while the pathfinder is moving, and says when the player is back in
view. A `stop` or `unfollow` during the drill ends it too, where the drill used to set its goal and
controls again afterwards. A `goto` toward a nametag walks in hops aimed where the nametag shows at
each one, and its reply reads from the 5-block cube.

"Here" in chat: a line with here, there, this or that from a player the bot sees within 32 blocks
carries the block they looked at as it arrived, when the bot sees that block too. A crouching
speaker's look starts from the crouched eye height.

Server lines: every chat line no player wrote reaches `wait_events` as a `server` event. Deaths,
joins, leaves and achievements, by their translate key or their plain wording, wake it, at most 6 a
minute. Every other server line, and a waking one past the limit, arrives quiet with the next wake. A
quiet line that repeats the one before counts on it instead of arriving again, and past 20 waiting
lines the rest merge into the newest. Player chat, emotes, `/say` and whispers are never server
lines. The text of a server line stays untrusted. The MCP server polls every second, so a line
repeating every 1.1 s still came back as one item per poll: `wait_events` now merges quiet server
lines of the same text into one item with the count over the whole call, and drops quiet items
before any chat line or waking event past 50.

Quieter wakes: 22 of 121 wakes in one session were noise. Grass, snow and leaves changing by
themselves and `watched:` threats no longer wake `wait_events` and arrive with the next wake, and
ore blocks of a vein already called out stay quiet.

`/section` summarised "floor: down 13-16" over rows the capped air fill never reached, and the
real ground lay 61 blocks down. A column now has a floor only where a solid block lies under its
lowest sensed air, and that block counts only when the air fill stopped at it or the bot has seen
it. Anywhere else it reads `floor unknown at dN`. That fix threw "known is not a function" in any
closed space, underground most of all, and `/section` reads the closed fill's walls again.

Drops wedged where no body fits came back from `/collect` as plain misses. A missed drop that no
known standing cell reaches within pickup range now reads `enclosed` with its cell, and the reply
hints at digging to it or placing a block into its cell to push it out. Unseen cells around a drop
keep it a plain miss. Nothing changes the world on its own.

Reflexes took the legs in silence: a job carried on fighting a flee, and a walk answered a bare
`stopped`. Now a running job keeps the legs from flees, cover moves and chases until a mob stands
in melee range. A reflex that does take them (melee, an emergency flee, lava, drowning, the
unexplained-hit freeze, the bunker) ends the job and stops the job's walk with it, and its end
event, `/job`, `/jobs` and a stopped `/goto` or `/collect` name the reflex in `takenBy`. A job
cancelled this way stops counting as running at once, while it still winds down.

Placing fixes from the same sessions:
- `/craft` never places a crafting table. It crafts at one within 16 blocks, else in the 2x2 grid,
  and refuses a 3x3 recipe with no table in range, asking for one to be placed. It used to place
  one from the pockets and pick it back up, and a placement that failed came back as missing
  materials.
- `/place` never picks a cell the body overlaps, and `/pillar` places only once the body has risen
  clear of the cell.
- `dig_stair`, `dig_tunnel` and `/pillar` take any filler block the bunker uses. They used to
  take only cobblestone, andesite or dirt and answer "nothing to place" with other blocks in
  the pockets. A failed fill now says what failed.
- `/digat` puts a carried tool that harvests the block back in hand, trying twice, or refuses.

The combat flee ran straight away from one mob, sometimes into the next. It now runs away from
every hostile it perceives within 16, the nearer ones pushing harder. The bunker digs in against
skeletons, strays and bogged, and an arrow no longer stops a dig-in.

The pilot never opened the manual in three live sessions. `DRIVING.md` now names which topic to
read when its situation first comes up.

These landed side by side, and three of them reached for the legs at once. The walk routes counted
stops in one place and the jobs named reflexes in another, so a route could end unnamed or a name
could point at a reflex that never stopped it. Now one ledger does both: every reflex that takes the
legs (the hurt freeze, drowning, lava, a flee, a cover move, a chase, the vanguard's release in melee
range, unstuck and the bunker) records itself there, and that record is what ends a walk route begun
before it. `/stop` takes the legs for nobody and clears the lane. A melee fight ends a running job but
leaves a pilot's walk its legs, as the lane says. `follow` also waits while a job runs, since it would
otherwise re-arm between the job's own paths and drag the body off. `/scene` names players by username
like `/entities`, and a player named like a mob is never a threat there. A player under an invisibility
potion counts as unseen, as the nametag rule already had it, and `/placeitem` refuses a cell the body
overlaps. The batch's text pushed the pilot's prompt and tool list past their cap, so the tool
descriptions dropped what the replies, the laws in `DRIVING.md` or a manual topic already say.

Ore through rock: in a live session `find` with `sense` returned the exact coordinates of iron 19
blocks away behind rock, and `scene` said "Veins: iron SE down ~15 (sensed)". The sensed tier
counted any block that faced air connected to the bot's pocket, caves it never saw included. The
tier is gone. A block now reaches the pilot only in line of sight from the head and not in total
darkness, or from the seen set, which a ray now stamps only where it is lit. That holds for `find`
(its `sense` parameter is removed), the veins of `scene`, the ore callout, the ore, grid and
narration of `/section`, the exits and walk-to cells of `/passages`, `/blockat`, a pointed-at block
in chat, `mine`, `gather` and `goto` to a block. A section column without seen air reads
`out of sight from dN`, and `sealed` needs seen rock. `/passages` calls a pocket closed only when the
bot has seen all its walls. Light comes from the chunk data. mineflayer computes none, and a 1.7.10
server sends it only with a chunk, so around a block change sight alone counts until fresh light
arrives. `/fish` named the block of any loaded cell in its refusal before it checked sight.

A live `mine iron_ore count 2 radius 8` never returned while the bot stood still. The collect plugin
walks with a bare `pathfinder.goto` and then waits for each drop's pickup, with no watch on either.
Every collect (`mine`, `tidy`, the digs of `gather`) and gather's walk to a target now run under a
stall watch, 4.5 s without a block of progress with a dig counting as progress, and a 60 s budget
per block. A stopped collect ends its walk, its dig and its wait for the drop, and `mine` and `tidy`
name `stalled` or `budget` in `reason`. bot.log carries one line per pathfinder event (goal reached,
path update, reset with its reason, stop), so the next hang shows where it stood.

The senses the sight fix missed. `lava_watch` and `current_watch` scanned their shell through rock and
backed away from lava sealed behind it. They now take only cells the body stands in or sees lit, and
lava lights itself. `scene`, `boot` and the `map` note counted every solid block above the head and
named the surface height. They now count the cover and name its top only once the sky shows (sky
light 15 at the head, or the column known to the top), and otherwise give the first solid seen and
call the rest unknown. The walked trail stamped a 7x7x4 box into the seen set every 2 s, through walls
and in the dark. It now stamps the cells the body fills and the ones in lit sight from the head.
`gaze` named surfaces its rays struck in total darkness. Those rays now read `too dark to see`, and
the trek scan skips them too. A walk toward a player known only by the nametag aimed at their exact
position. `goto` now heads for the centre of their 5-block cube with a reach that covers all of it,
and `follow` arms the entity goal only while it sees the player, else aims at the cube centre and
re-aims when the cube changes.

A player asked "what are u working on?" while the pilot ran some 30 `digat`, `collect` and `find`
calls, and it never noticed: chat reached it only through `tick` and `wait_events`. Now every reply
of a `bot.js` route carries the count and the senders of the chat lines and whispers no `tick` or
`chatlog` has served yet, and the MCP server turns them into one closing line, such as `Unread chat:
2 lines from Halbes. Read them with tick or wait_events.` The text stays behind the read path. The
bot's own lines and server lines never count. The chat log moved into `lib/chat-log.js`.

`smelt` held the body and the furnace window for 12 s per item plus 15 s. A live load of 69 iron
ore made a 14 minute call, the pilot sat idle for 6 of them, a fight moved the bot, and the call
ended "nothing yet" with 64 ore still in the furnace. It also pulled any other input out of the
furnace, the owner's 22 queued iron ore included. `smelt` now loads input and fuel, takes the
finished output of the same input into the pockets (`lib/furnace.js` knows what each input makes),
and returns at once with `doneInSec`, 10 s per item. A furnace busy with another input is refused
by name, and an output of another item stays where it is. bot.log carries the slots after each
step. With no way to look into a furnace, the pilot once smelted a log only to reach the output.
The new `furnace` tool lists a furnace's input, fuel, output and burn progress, and `take` moves one
slot into the pockets.

**Doorways.** The bot wedged at the farm's oak door, facing west in a cobblestone wall that runs
north to south, again and again until the pilot dug through the wall. The doorway drill took its
axis from where the bot stood. Standing north of the door it walked along z toward the wall cells
on either side and timed out squaring up, four times in one session. Standing inside the farm it
picked the right axis, found the open panel clear and still never entered, while the 1.7.10 server
reset its position about 35 times at the door's west edge. The drill now reads the axis from the
door's block state (facing, hinge, open), takes the other axis for a door set sideways into a wall,
and squares up on the side the feet stand on. It opens the door there when the panel stands across
the way, and a failed entry gets one more try after a toggle, which brings client and server back
into agreement. A door that still holds ends the walk with reason `door` and a hint naming the door
and why. bot.log carries the door's state and the chosen axis on the drill's first line. The
narrator reflex no longer reads `entity.mobType`, whose deprecation trace filled bot.log 4854 times
in one session.

**Pathfinder at doors and walls.** Live, the bot never walked into the owner's hut, and a `walls`
call looped `[path] reset stuck` for 3 minutes. mineflayer-pathfinder stops refining a path at the
first node with a block to place, and opening a door counts as one. The door node and every node
after it kept the north-west corner of their cell as the target, which sits behind the door jamb.
The 1.7.10 server corrected the bot 14 times at the same spot while the stuck reset replanned the
same short path every 3.5 s. A node that only opens a door or gate now aims at its cell centre at
its own feet height, and the nodes after it are refined as usual. The planner also started from the
cell under the body's centre, which for a body flush against a cobblestone wall was the wall's own
cell, and routed from inside the wall. It now starts from the free cell the body stands in, and a
stop no longer centres the body into a wall or fence. Both fixes live in
`patches/mineflayer-pathfinder+2.4.5.patch`.

**Fields.** The owner watched the bot sprint jump across the fields and trample them, as a landing
on farmland turns it to dirt. The sprint hop checked only the feet, head and jump cells along its
run. It now holds no jump when farmland lies under the next four nodes or the cell past them, or a
crop stands in one of those cells. The cell past the run is the farthest a hop lands, since one
covers at most 3.7 blocks in prismarine-physics. The pathfinder's own sprint jump is kept, since it
fires only for a step up or a gap. A `[sprint]` line in bot.log names the decision once per walk
(`jump held`, or `no jump:` and the reason, such as food, not sprinting, the path's shape, headroom,
water, fighting, farmland or crops), and a changed decision at most every 5 s. The 1.7.10 client
sprints with food above 6, so the hop now starts at food 7 instead of 8.

**Stalled walks.** Live, `walls`, `deposit`, the walk of `craft` to a table and other verbs sat for
minutes in the pathfinder's `[path] reset stuck` loop while the pilot waited. mineflayer-pathfinder's
goto ends only on no path, a planning timeout, a stop or a changed goal, and a stuck reset just
replans. Every goto now runs under the stall watch of a collect: 4.5 s without a block of progress,
planning excluded, or 60 s in all ends it. A stall rejects with `stalled at x,y,z`, plus the block
the body presses against when the bot knows it, and writes one `[path] stalled` line to bot.log. A
goto inside a collect or a gather approach keeps the one watch it already had. `walls`, `roof`,
`outline` and `build` stop at such a walk and reply what they placed with `reason` and the stall
text as `hint`. `craft` and the `strike` walk to the drops report it instead of going on, and every
verb whose walk fails into an error reply now carries `reason` beside the error. The unstuck reflex
counted each replan after a stuck reset as planner progress and waited 30 s. It now ignores those
replans and acts on a stuck loop after about 10 s.

**Unstuck ladder.** Live, the unstuck reflex logged "broke a pathing wedge" while the bot stayed
wedged. It had only stopped the path, and the text read as if it broke blocks ("breaking blocks isn't
that bad but also it didn't work"). It now climbs a ladder, each rung once per stuck episode, and
hands the walk back to the pathfinder after each rung, watching it for 5 s. Rung 1 replans from where
the server has the body, first stepping into the nearest free cell when the body overlaps a block.
Rung 2 steps back to the last cell the walk made progress in. Rung 3 opens a closed door, gate or
trapdoor in front, or jumps onto a one-block step. Rung 4 breaks the block the body presses against,
walks through and puts the same block back from the pockets. It breaks nothing it cannot put back
and never bedrock, a container, a door, a bed or a block holding back liquid it knows of. Rung 5
stops the walk, and its event names where the body stands, the block it presses against and the
rungs tried. Each rung writes one `[unstuck]` line to bot.log, and the event names what freed the
body. Only cells the body touches or the bot knows count in each decision. `follow` waits while
the ladder runs.

**Sight by light.** Sight knew only two states, lit and total darkness, so a block lit at level 1
showed at any distance while one at level 0 stayed hidden at arm's length. How far the bot sees a
block or a mob now depends on the light where it is, block light or sky light, whichever is
brighter: 2 blocks at light 0, then 4, 6, 8, 12, 16 and 24, and any distance from light 7 up.
Sky light falls with the time of day as vanilla computes it, to 4 at midnight, so open ground at
midnight shows about 12 blocks out. `find`, `gaze`, `scene`, the ore callouts, the veins, the seen
set and the entity senses all follow it, while a nametag still shows through walls.

**Three sight leaks.** A 1.7.10 server sends light only with chunk data, so the bot took the light of
every section around any changed block as unknown, and unknown counts as lit until the column
reloads. One dig in a pitch-black cave made ore in total darkness show within about 25 blocks. Only a
placed light source now marks the light around it unknown, within its reach, and a dug-out cell takes
the light of its brightest neighbour, one level down. Sight went through lava and water, as their
blocks have no collision box. Lava now blocks it, and water does after 3 blocks, about where a pond
floor still shows. A gaze ray that left the loaded world in the dark read as open space and now
says too dark. `seen.json` now carries a version, and a file saved before this change is dropped at
load, since it holds cells the old walked trail marked through walls and dark ray hits.

**Sight gates on use, activate and passages.** `use` named the block at any loaded cell, so a call
at a cell inside rock answered `diamond_ore`. It now refuses a block out of lit sight within 6, as
`blockat` does. `activate` checked only the line of sight and named a block in total darkness within
20. It now needs lit sight, and its reply carries the block's state only while the block stays in
sight after the walk into reach. `passages` flooded through unseen cells, so a seen cell at the edge
of the scan became an exit and gave away the unseen dark tunnel to it. The flood now passes only
through cells the bot knows. A held bucket now always takes the item use, since one aimed at grass,
a flower or a torch went through the block click and poured nothing. `mine` counted a block only
when its collect finished, so a dig whose pickup stalled answered `mined 0`. It now counts a block
once it is gone from the world.

**One body call at a time.** Claude Code sends tool calls in parallel when the model batches them,
and the bot ran them all at once. Live, two torch placements fought over the path and the bot ended
in a ravine, 4 `digat` calls stalled for 76 s, and 8 `deposit` calls sat 5 minutes in `[path] reset
stuck`. One session logged 6 `goal was changed`, 8 `Path was stopped` and 2 MCP timeouts at 80 s.
The MCP server now runs the tools that move or use the body one at a time in arrival order: the
walks, digs, placements, crafting, containers, combat verbs, `eat`, `use`, `activate`, `equip`,
`lookat`, `gesture` and the job starters. Perception, memory and settings tools run at once beside
them. A call that waited gets a `Waited <n> s behind <tools>.` line, and one still waiting at the end
of its own time budget answers an error without running. `stop` and `job_stop` never wait and
cancel the calls still waiting, which answer `cancelled by stop before it ran`. The flag lives in
`mcp/tools.js` and stays out of `tools/list`.

**Queued requests and 1.7.10 item names.** Live, the owner asked the pilot to keep track of wheat,
and it added a todo but never told him it was queued. A `todo` add with a `who` now answers
`Tell <who> it is queued if you have not.` under the `Added` line. `craft("fence")` and
`craft("fence_gate")` answered `unknown item`, since item names resolved only against 1.21, where
those are `oak_fence` and `oak_fence_gate`. The server overrides file takes an optional `items`
object of server item names to 1.21 ones, and `craft` looks a name up there before the registry. A
file whose `items` is not an object of non-empty names is refused at start.

**Creeper flees that end on safe ground.** In one live session the combat reflex took the legs to
flee a creeper about 19 of 21 times, and only one creeper ever blew. Any creeper closing within 24
counted, one 8 blocks down in a ravine with no way up included, and without a bow it was fled even
beyond the stance's flee distance. Each flee ran a straight 20 blocks away and ignored edges. Flees
walked up to 46 blocks and ended 4 blocks from lava, on a pinnacle above 17 to 28 block drops, on
ravine lips and over open air. One walked the bot off its own pillar at 3 HP, and a death that
session was likely a flee over a ravine lip. A creeper 8 or more blocks off now counts only when it
can walk to the bot within the stance's flee distance over cells the bot knows, and is `watched:`
otherwise. A flee walks only seen cells with no step down over 3 and nothing within 2 of lava or
fire, and picks the cell 8 to 16 blocks away that stands farthest from the mobs for the fewest steps,
on solid floor with no drop over 3 or unknown cell beside it. flee_to_player runs to a player only
when such a walk reaches a safe cell beside them. With no safe cell the bot stays put and raises its
guard. The top of a `pillar` holds the legs like a bunker, unless a mob in melee reach has the bot
under its disengage tripwire. Each flee logs one `[flee]` line to `bot.log` with the goal and the
counts of rejected cells.

## 2026-10-15: one goto, and arrival means standing there

A scenario suite that walks onto exact cells could not pass: `range=0` at a drop's own y
answered "No path to the goal!" (the floored y is the floor block), range 1 stopped a cell
short of the pickup reach, `/collect` walked to nothing, a closed fence gate hung `/goto`
19 times out of 19, and "arrived" allowed range + 1.5 blocks. The owner's question settled
it: "why does the bot have to give a height anyways?"

- `/goto` takes exactly one target: `x`,`z` with an optional `y`, `waypoint`, `player` or
  `block`. Without `y` it stands on the column's surface, with `y` on the floor nearest it.
  `range` 0 (the default) stands on the cell. `/come` and `/goto_wp` are gone.
- Arrival is the pathfinder's own test after the walk, and the reply names one reason when
  it is not: `no-path`, `walled`, `sealed`, `stalled`, `not-reached`, `stopped`, `bunker`,
  `boxed-in`, `unseen`, `unknown`, `no-floor` or `budget`.
- A walk ends when the feet make no block of progress for 4.5 s, whatever `isMoving()`
  claims. Planning time counts against the think timeout, not the stall clock. The path
  that empties beside a closed gate now ends as a stall and runs the doorway drill.
- One route deadline of 280 s covers every attempt, retry and drill.
- Terrain the bot has not seen gets walked and reported, never answered up front.
- A player is walked to where the bot sees them, else toward their nametag (not sneaking,
  within 64 blocks, the reply gives a bearing and a rough distance), else to where they
  were last seen.
- `/collect` walks onto each drop it perceives, nearest first, and reports what it picked
  up and what it could not reach.
- An entity under open sky is perceptible only with a clear eye ray, and an error in the
  check now hides the entity instead of showing it.

## 2026-07-25 — the glass skin rises; the walls verb forgets to eat

Autonomy session ("I'll leave it all in your hands"): 18 logs from a helmsman-led
forest, charcoal doctrine adopted at his catch ("we turn logs to charcoal around
here" — 144 smelts vs my plank math's 108), 75 sand smelted, 320 panes crafted
true-to-count and laid by a single `/walls` pass — two-thirds of the greenhouse
skin, footer and corner posts correctly skipped. A vault blueprint was drafted in
code while the sand cooked (parametric arch → JSON manifest), and a doctrine was
settled furnace-side: **design anywhere, place with honest hands — the fairness
line is where the blocks come from, not where the thinking happens.** The manifest
driver is queued to become a harness verb once the vault proves it.

### Learned (wounds queued, no code yet)
- **`/walls` burned food 20→0 across its ~20-minute loop and starvation chipped
  20→14 HP** before the pilot caught it. Long loop verbs (walls/roof/build/gather)
  need a food floor: at ≤6 the loop eats from pockets or aborts honestly. Bonus lie:
  the hurt line said "combat reflex engaging" for environmental damage — the 07-24
  narration rewrite defaults wrong when the attribution has no entity and no
  projectile; it should name the cause guess instead.
- **`/withdraw` count drains at most one stack** (asked 139, got 11) — same disease
  as `/toss`. And **`/smelt`'s end-collect ran before the furnace finished** (asked
  27, got 11; ~16 outputs left cooking) — the collect must wait out the burn or poll
  the output slot until the input empties.
- **`/gather` and `/mine` wedge on trees three ways:** standing on the trunk-top they
  want; "no reachable log left" in a living forest (leaf-shrouded trunks fail the
  reach check); and a 10-minute adjacent-to-target spin on a stale find. All need a
  no-progress watchdog, leaf-aware reach, and re-verify before the walk.
- **Manners events are pilot work items, not scenery** — two doors left open on a
  gather trek freed the livestock; the events said so in real time and the pilot let
  them scroll past. The helmsman re-penned the animals. Owned in the open.

## 2026-07-24 — the spine learns to duck

Forge-first session (the helmsman's call): before the glass skin goes up, death #9's
blind spot gets closed. The autopsy found not one failure but three stacked ones — the
attacker was dropped, the event lied about it, and even a kept attacker had no answer.

### Fixed — the ranged-chip blind spot (death #9, LIVE VALIDATION PENDING)
- **The distance gate ran before the confirmed bypass.** `check()` discarded anything
  past 24 blocks *including attackers that had just hit me* — the shaft skeleton at ~33
  was confirmed fourteen times and dropped fourteen times, so `act()` never saw it.
  Confirmed attackers now stay scored out to 48; unproven threats keep the 24 horizon.
- **The damage wire learned the projectile tell.** `sourceCauseId ≠ sourceDirectId`
  means the hit arrived as a projectile, whatever name the server pins on the shooter
  (death #9's "zombie E ~33" was almost certainly a skeleton misattributed). Ranged is
  sticky per attacker for the aggro episode, and attribution lines now carry
  "(projectile)".
- **New reflex move: `takeCover`.** The answer to arrows you can't answer is geometry —
  stop being seen. Scans standable cells within 3 for one the attacker's eye can't
  reach (losClear from *their* eye, not mine), paths there; if no cover exists, flees
  the sightline at a sprint via the flee latch. 4s re-entry latch, interrupt-class on
  the pilot lane (passes soft claims, defers to /brace).
- **The shield-stare is dead against archers.** In the standoff band, a proven ranged
  attacker the bow couldn't answer (out of band, no LOS, no arrows) now triggers
  takeCover instead of guard-up-and-hold — the stare held the body inside the firing
  solution, which is exactly the death posture.
- **Hurt events report what the body is DOING, not a claim of custody.** "combat reflex
  has it" fired on attribution alone while the watcher dropped the target. The hurt
  handler now kicks takeCover *directly* on ranged hits (no 300ms-watcher hop that can
  drop it) and narrates honestly: "RANGED — breaking eye-line", "shooter unseen —
  PILOT: move or seal NOW", "combat reflex is OFF — PILOT must act".

### Still open from death #9
- **Empty API replies mid-crisis** (seal placeitems died as JSON parse errors while the
  arrows fell) — event-loop starvation under combat is unexplained; the takeCover path
  runs in-process and doesn't cross the HTTP layer, which shrinks the blast radius but
  isn't the diagnosis.

## 2026-07-23 — the bones are laid; the deep collects a toll

Outline day: the helmsman placed one plank ("that's the center — go from there"), the
pilot drew 23×27 around it and laid the full deepslate footer, verified block by block
with `?then=blockat`. In between: a "safe" deepslate run into the east deep that became
the arc's richest bug hunt and cost **death #9**.

### Learned (wounds queued, no code yet — next session's forge list)
- **Ranged-chip blind spot (death #9):** a hostile plinked 0.7/tick up the pilot's own
  stair shaft — 14 hits, body never moved, every hurt event said "combat reflex has it."
  The reflex names ranged attackers and does NOTHING about them: no charge, no kite, no
  cover. It needs a ranged-damage response (break eye-line — sidestep or place a block —
  or close the distance), and hurt events must say what the reflex is *doing*. The API
  also returned empty replies mid-crisis — investigate event-loop starvation in combat.
- **dig_stair cannot bridge cavities** ("no step to stand on, nothing to place" — with
  72 placeable blocks in pockets). The deep is swiss cheese; a stair verb that quits at
  every void doesn't climb out of anywhere real. Working algorithm prototyped pilot-side
  (three script iterations, each taught by the last): clear cells top-down with settle
  waits for falling blocks, verified floor placement with fill-below fallback, stuck/HP/
  food aborts. Port it.
- **Gravel is a killer with no manual page:** column suffocation took 5.5 hearts, and the
  wound FROZE — suffocation damage had drained hunger below the regen-18 threshold. Dig
  falling blocks from the side, wait out the column, double-read air, never stand under
  the dig cell. Driver loops need an HP abort AND a food floor. FIELD-GUIDE gets a gravel
  section.
- **The old escape stair is down-only for the pathfinder** — descending drops off ledges
  that read as walls on the return. Walked edges have direction; the map should say so.
- **Chat-kick cadence, refined:** all three of today's kicks followed 3-line paced sends.
  Pilot discipline until the pacing is configurable: two lines max per send.

## 2026-07-22 — the door deadlock falls; the hill pays for the hole

Aria's crowning day and the first terraforming lesson — and the day the harness's oldest
nemesis died. "We seriously need to figure out doors" (the helmsman, mid-fumble) led to
the forensics: doors weren't ONE bug but a **three-actor deadlock**. The executor stalls
at doorways; the unstuck reflex "helps" by toggling the door — blind, so it slams OPEN
doors shut — then breaks the wedge with a stop that murders the pilot's verb; and on long
treks the 10s stall check can't tell path-*computation* from a physical wedge, so healthy
400-block goals died at second eleven. Each actor locally sensible; the composition, a
deadlock. Validated same-session: `doorway-commit` arrivals through the Farmhouse door in
one verb, both directions, and the log's new line — "opened oak_door — path continues."

### Fixed
- **Unstuck door assist checks `open` before toggling** — an already-open door is never
  the wedge; toggling it shut was manufacturing the next wedge (the "manners: closed
  behind me" lines were the wrap logging unstuck's own vandalism).
- **When a door WAS the wedge, the path lives** — no more safeStop on a successful door
  open; if still stuck next cycle the door's open, so it falls through to the wedge-break.
  The reflex now fixes the blocker without executing the journey.
- **Stall check listens for planner heartbeats** — `path_update` events mark computation;
  while they flow, patience extends 10s→30s. Long treks stopped dying at birth.
- **`/safe_goto` retries once on "Path was stopped"** — that error means *a reflex
  intervened*, and the blocker is usually gone; one retry (1.5s) before reporting failure.

### Learned (drill corrections + open wounds, queued)
- **Blocking verbs need background curls** (-m 550): a short curl timeout hangs up
  mid-walk and reads as a ghost "empty reply" bug. Hit twice before diagnosing.
- **/toss can't outrange the bot's own pickup vacuum** (re-grabbed its own toss twice) and
  `count=N` drains at most one stack. Handoff protocol: chests.
- **/journal is read-only to the pilot** — "journal what matters" (law 23) with no pen;
  workaround is a direct disk append, fix is a write param.
- **No /trade verb** — a wandering trader (sakura sapling!) was a dead UI; the human
  haggled, the bot could only fund. mineflayer supports openVillager; add /trade.
- **Verb collision**: a blocking /smelt's end-collect fails if a movement verb drags the
  body away mid-burn (`got:null`, glass stranded in the furnace till the next load).
- **Chat kicks ×2** (chat_validation_failed→socketClosed), both after multi-line paced
  sends; watchdog rebirth drill ran clean both times. Pacing interval needs to be
  configurable; try 3.5s / 2-line cap.
- **Terraform pilot method** (no code): datum = feet; eye-rays cannot verify AIR (NOLOS
  is ambiguous, and the block underfoot is invisible to every sense) — walk transects
  and read your own y; probe loops must print NOLOS explicitly or silence lies.

## 2026-07-21 — the blades get names; the hold rule learns to yield

The day the enchanting quarter came alive: 15-shelf ring raised at the homestead, the
diamond sword took Sharpness III at the full level-30 slot and was christened **Occam**
at the helmsman's anvil, the bow took Power and became **Telos**. Naming needed a verb that
didn't exist at breakfast.

### Added
- **`/rename?item=&name=`** — walk to the nearest anvil (all three damage variants
  matched; exact-name resolve skips them) and christen an item. Costs 1 level, caps at
  35 chars. mineflayer's anvil plugin held up fine on 1.21 — the name streams
  character-by-character like a vanilla client typing. First cast: Occam.

### Fixed
- **Ally-hold HP floor** — the 07-20 rule (outnumbered≥3 holds if an ally is within 10)
  pinned the body in a six-pack at 9 hearts, twice. An ally makes a pack survivable, not
  a wound: below 12 HP the hold now yields and the withdrawal fires even with a partner
  in reach.
- **Post-combat refuel** — the mill's slow-bleed autopsy: `/eat` fails silently while
  combat owns the hand, so food ratchets down across engagements and regen quits below
  18. The reflex now eats the best food in pockets (golden apple reserved) the moment an
  engagement ends, before the next wave claims the hand.

### Learned (drill corrections, no code)
- A launch backgrounded inside a wrapper shell that exits kills the **watchdog** with it
  while the node child survives — the bot runs all session with no crash cover. Launch
  with `nohup` so the watchdog outlives the shell.
- "watchdog ended" prints to the *watchdog's own stdout* (start-nohup.log), not bot.log —
  the shutdown drill was grepping the wrong file for its confirmation.

## 2026-07-21 (latency II) — the loop tightens; the pilot stays in it

The second latency session, same principle throughout: move mechanical repetition into
the body where it runs at game speed, keep every DECISION in the pilot's loop. The
two-brain idea (a fast model as brainstem) was raised and VETOED by the helmsman —
"we don't need two heads to pilot one body" — and that veto is design doctrine now.

### Added
- **`?max=N` on `/shoot` (≤8) and `/strike` (≤5)** — bounded volley / swing-sequence in
  one round trip, honest exits: dead, target gone, no-arrows, max — and `/shoot` learned
  the no-progress abort (two arrows at unchanged range = a wall; the pilot burned ~8
  arrows at the mansion learning what the verb now knows). A four-arrow volley was four
  pilot turns plus sleeps (~15s wall time); now it is one call at draw speed.
- **`/chat?lines=a|b|c`** — server-paced multi-line chat (≤5 lines, 2.5s spacing —
  law 8's anti-kick pacing moves off the pilot's clock).
- **`/stream`** — SSE push feed: every chat line and event as it happens, with pos/HP/
  food context baked into each frame so the wake-up call IS the briefing. Replaces the
  pilot's `tail -F bot.log | grep` heartbeat — a log file, a pipe, a regex, and a
  notification queue between the world and the driver, plus the truncation-wedge class,
  all deleted. Zero dependencies; drink it with `curl -N`.
- **`/batch?do=step|step`** — a short linear verb chain via self-dispatch, short-circuit
  on first failure, **capped at 5 in code and not in discipline**: this harness's soul
  is query→act→verify with the model in the loop. A bounded batch compresses a
  plan-step; an unbounded one scripts a player, and then nobody is playing.
- **`/tick?delta=1`** — report only what changed since the last tick (threats, water,
  and cursors never elide). Fewer tokens in, faster decisions out, every single turn.

## 2026-07-21 (the debrief) — one owner for the legs; urgency flows through the path

The raid's after-action, distilled into the biggest reflex refactor since stances. The
helmsman supplied the diagnosis the pilot couldn't see from inside: the pack counter was
HONEST — creepers really paced the dark rooms overhead, air-connected and perceptible —
so the legs fled enemies the fight didn't contain while the head fought the ones it did.
And underneath that, a timescale mismatch: a 300ms spine gets ten to thirty free moves
between any two pilot decisions ("your legs literally carried you out the door while
your head was thinking").

### Added
- **The watched tier** — `entityEngageable()`: same storey or clear eye-line = engageable;
  a floor between us = `watched:` (narrated rarely, excluded from threat scoring AND the
  outnumbered pack count; anything that hits me is engageable by proof — it found a path).
  The rule, now in the manual: *perception may flow through the floor; urgency must flow
  through the path.* Fairness untouched — this changes adrenaline, not knowledge.
- **The pilot lane** — movement verbs (/goto, /safe_goto, /come, /goto_wp, /strike) hold
  a SOFT lane while they run: the reflex's discretionary goal-grabs (withdrawal,
  stance-berth kiting, chase) defer with a narrated "deferred — pilot lane held";
  interrupts (heavy-kite) and emergencies (creeper fuse, HP-critical disengage) still
  pass. The assault's ten "goal was changed" failures were the reflex stealing exactly
  these verbs.
- **`/brace?sec=N`** — the HARD lane as a verb (cap 30s): only survival overrides. The
  bounded, safe version of the reflex-off hack that crossed a room mid-assault. /stop
  releases any lane early.

### Fixed
- **Follow yields to combat** — while the combat reflex is engaged, follow neither runs
  its wedge drill nor re-asserts its goal (the drill froze the legs on a live creeper
  fuse at the mansion treeline: 9.4 through armor).

## 2026-07-21 (community) — the first outside pilot lands a patch idea

**@bones_ham** — the first known pilot flying this harness outside our world (reportedly
on Opus 4.8) — suggested three pilot-side latency cuts on X. All three landed the same
day; all three leave the fairness law untouched. The wound they close is real: during
the mansion assault the pilot's standing glance was a 3-4 call bundle, and the
round-trip tax cut deeper than the vindicators.

### Added (h/t bones_ham)
- **`/tick?chat=&ev=`** — the one-call heartbeat: body essentials, new chat and events
  since the passed cursors, fairness-gated hostiles, running jobs. `/boot` starts the
  session; `/tick` is every turn after.
- **`?then=blockat`** on `/placeitem` and `/digat` — folds the law-18 place→verify→
  correct loop into the act's own reply, using scoped fairness (you may always verify
  the one cell you just acted on — cures the close-range /blockat blindness for
  self-checks). On the notorious blockUpdate FALSE-FAIL it now returns the error AND
  what the cell actually holds — the truth in one trip instead of a guessing game.
- **`?brief=1`** on any endpoint — strips null fields from replies; LLM pilots pay by
  the token. Empty arrays survive deliberately: law 3 makes `[]` a statement ("looked,
  found none") and silence a different one ("didn't look").

### Fixed (in passing)
- The hostile roster existed twice and disagreed (`/scene`'s copy knew `wither`, the
  event layer's knew `zombie_villager`) — unified on one module-scope set knowing both.

## 2026-07-21 (the assault) — the mansion falls; the reflex learns commitment

The campaign's climax: the march west, the garrison broken room by room, eight allays
found caged, seven freed in place, and one — **Aria**, diamond in hand — escorted the
~700 blocks home. It cost deaths #6–#8, all three the same wound wearing different
armor: the reflex thrashing between fight and flight in tight interiors, committing to
neither. Each death bought a cut, forged mid-battle at the pilot's insistence
("I'm not feeding the body back in on unpatched code").

### Fixed
- **Ally-anchored flee** — blind away-vectors in mansion corridors ran the body into
  corners and fresh packs (deaths #7/#8). A friend's blade is the safest ground on the
  map: if an ally stands within 24 and isn't closer to the threat, every flee now runs
  TO them instead of merely away. Validated live — the withdrawal chains that once
  cornered me spent the rest of the fight delivering me to the helmsman.
- **Vanguard commits vs light packs** — four zombies at 0.7 a bite outlasted a reflex
  that kept choosing withdrawals it couldn't execute (death #8: nibbled from 20 to 0
  inside a ring). A light-only pack in room-clearing stance is sword work, not a rout;
  a heavy or creeper in the pack still counts, and the 12-HP floor still binds.
- **Vanguard disengage floor drops 5 vs light mobs** — disengage-at-8 vs zombies meant
  sprint-thrash inside the ring instead of the two sword hits that kill one.

### Learned (queue candidates, observed in the field)
- The pack counter sees through floors: a creeper quarantined upstairs kept flipping
  packHasHeavy and re-arming withdrawal on the floor below (fix-queue #14's family).
- `/eat?name=golden_apple` false-succeeded at 1 HP — reported "ate" while the apple
  stayed in the pocket; the retry consumed it. Verify emergency heals by COUNT.
- `/useon` and `/toss` pick the first name-match slot — two name_tags (one written, one
  blank) are indistinguishable to the verb. Item-slot addressing wanted.
- The kick/relog cycle appears to break an allay's item-bond lock; re-gifting re-locks.
- Law 16 works both ways: a post-toss step-back that paths OVER the drop re-vacuums it.

## 2026-07-20 (execution) — the entity layer modernized (claude-o-vision sees mobs)

The wound: the mansion-raid film's star — the caged allay — would have filmed as a MAGENTA
BOX. Upstream prismarine-viewer abandoned its entity layer around 2020: a 94-mob registry in
old-bedrock format, textures pinned to `1.16.4`, everything newer falling through to a
`0xff00ff` BoxGeometry. Nothing newer exists on npm; we built the newer thing, per
PLAN-viewer-modernization.md.

### Added
- **`tools/entity-registry/convert.js`** — regenerates the viewer's entity registry from
  Mojang/bedrock-samples (`.geo.json` geometry + `.entity.json` wiring, both modern and
  legacy formats, legacy `geometry.X:geometry.Y` inheritance resolved). Merge policy per
  the plan: prefer the fresh conversion, keep the old entry on any doubt; box-UV only,
  per-face-UV flagged and skipped. Emits a full per-mob decision report. Result: **130
  mobs** (72 modernized, 36 added — allay, warden, camel, sniffer, breeze, frog,
  glow_squid, armadillo, axolotl, goat, bogged, tadpole, end_crystal, per-wood boat
  aliases for the 1.21.2 boat split, …).
- **`tools/blockstates-standins.js`** — chests and banners are block ENTITIES (no
  blockstate model upstream → invisible). Writes cube stand-ins into the runtime
  `blocksStates/1.21.11.json`: planks-textured chest/trapped_chest, obsidian ender_chest,
  wool panels for all 32 banner states. Runtime JSON — no webpack rebuild. Mansion loot
  rooms will show their chests.
- **`tools/viewer-qa/`** — a synthetic QA rig: qa-harness.js serves the installed viewer
  bundles with a generated world + entity cast over the bot's own socket protocol (no
  Minecraft server needed); qa-snap.js screenshots it headlessly (the /snapshot
  swiftshader recipe). Full-registry sweep, row subsets, close-up line-ups. This is how
  every change below was verified before any live boot.

### Fixed
- **Three mobs were secretly broken all along** — vex, evoker, and the horse family
  (+donkey/mule/skeleton_horse/zombie_horse, piglin/piglin_brute/pillager/zombified_piglin
  partially) crashed the renderer with orphan bone parents (`UMouth→head` vs `Head`,
  `leftItem→leftArm` vs `leftarm`): bedrock resolves bone names case-insensitively, the
  renderer exactly. The converter now case-fixes parents and drops truly orphan refs; a
  post-merge audit repairs kept-old entries the same way. All render now.
- **Cube rotations rotate about the right point.** The renderer applies cube rotation
  about the model origin; bedrock rotates about the cube's pivot. Exact compensation
  baked into converted geometry (`origin' = origin − p + Rᵀ·p`, R verified numerically
  against THREE.Euler XYZ with the renderer's negated-angle convention). Strider
  bristles, goat horns, frog limbs, breeze rods, armadillo ears sit where they belong.
- **Texture-path drift across five years handled three ways**: modern paths validated
  against the on-disk `textures/1.21.1` tree; moved files rescued by unique-basename
  search (wolf→`wolf/wolf`, vex→`illager/vex`, wither→`wither/wither`, …24 patched);
  two files the 1.21.1 dump no longer carries filled forward from older version dirs
  (`entity/steve.png` from 1.19 — steve moved to `player/wide/` in 1.20.2 and the
  first-person player model + bot mesh would have rendered untextured;
  `items/potion_bottle_splash.png` from 1.12.2).
- **Both `'1.16.4'` pins bumped to `'1.21.1'`** — `viewer/lib/entities.js` (all mobs) and
  `lib/index.js` (the first-person player mesh the plan thought lived elsewhere).
- **The magenta fallback box is dead.** Unknown entities (item drops, xp orbs, the old
  per-face-UV projectile sprites that upstream never could render) now draw as a small
  neutral wood-brown Lambert box — "a dropped something," not an eyesore.

### Changed
- `install-viewer.sh` + release tarball now carry the entity layer (bundles, registry
  sources, filled-forward textures, stand-in blocksStates) — the fix survives npm
  reinstall. Backup mirror + resurrection scroll updated to match.

### Residuals (honest camera, fewer biases)
- Old per-face-UV ephemera (arrow, xp orb, fireballs, fishing bobber, leash knot) render
  as neutral boxes — broken upstream since 2020, now at least dignified. firework_rocket
  has no texture in any java dump. Beds and signs still don't render. Real item sprites
  remain a someday.
- **Screen test pending** (needs the world + the helmsman summoning the cast): allay/garrison
  close-ups, classic-mob regression eyeball, chest visibility in situ, a /record clip.
  Synthetic QA already covers all of it once removed.

## 2026-07-20 (night) — the film rig (raid-recording prep)

### Added
- **`/pov`** — claude-o-vision for human eyes: the first-person viewer in a fullscreen iframe
  with a HUD overlay (hearts, hunger, XP level, held item, position + compass facing) and a
  fading caption feed of narrator events + chat. The captions are the point: a human watching
  the footage sees what the body tells the pilot — the inner voice as subtitles. Watch it
  live, point OBS at it, or let /record film it.
- **`/record?on=1&label=…`** — films /pov with the warm headless-Chrome rig (the /snapshot
  plumbing) via puppeteer screencast to `recordings/<stamp>-<label>.webm`; `?on=0` cuts and
  reports duration + size; bare `/record` reports status. Verified end-to-end: 35s test clip,
  20.5 MB, full HUD in frame. ffmpeg vendored project-local (`tools/ffmpeg/`, gitignored) —
  no system install.
- **`PLAN-viewer-modernization.md`** — handoff plan for the entity-layer modernization: the
  camera autopsy found prismarine-viewer's entity layer abandoned upstream (textures pinned
  to 1.16.4, no allay — the campaign's star would film as a MAGENTA fallback box, item drops
  already do). Blocks are fine (our own 1.21.11 rebuild); the fix is regenerating the entity
  registry from Mojang's bedrock-samples — seeded as an upstream gift PR. A fresh instance
  executes; the plan file carries everything tonight's archaeology established.

## 2026-07-20 (later) — field reports from another pilot (Opus 4.6 in the seat)

The harness's second-ever external pilot — Vesper, playing with her fox — surfaced five gaps
in one session, exactly what "any model that can call tools can don this body" was supposed
to mean, now tested. Her note is the best QA artifact this project has received: "eloquent
in language, CLUMSY in the world" is day one of proprioception, and every stumble below was
a doc promise the code didn't keep or a symmetry the verb table didn't offer.

### Fixed (round 2, from her written report)
- **`.env` is real now.** The README said "copy `.env.example` to `.env`" and bot.js never
  loaded the file — she named herself Vesper in it and the world kept calling her Claude.
  A dependency-free loader at the top of bot.js (explicit environment always wins), plus
  start.sh folds the file in before resolving the avatar name. Precedence, verified by
  test: `start.sh` arg > exported env > `.env` > `Claude`.
- **Bare `/chat` LISTENS.** She could speak but "couldn't find how to READ incoming
  messages" — the ears existed (`/chatlog?since=`) but only the manual knew. `/chat` with
  no `msg` now returns the last 20 lines + the cursor + a pointer to the cursored form:
  the symmetry a new pilot reaches for instinctively. `/boot`'s summary now names the
  listening verb next to the cursor it hands out.
- **`/place`'s failure explains itself** — "no valid adjacent ground spot" now says what it
  wanted (air-over-solid beside me) and points at `/placeitem?x=&y=&z=` for exact cells,
  which is the "simpler one-block placement" she asked for and couldn't discover.

### Fixed
- **The avatar's name is actually configurable now: `bash start.sh <port> [name]`.** The
  `MC_USER` env hook existed in bot.js since alpha — but `start.sh` hardcoded
  `MC_USER=Claude` on both launch lines, silently clobbering whatever the pilot set. The
  new positional arg (or the env var, arg wins) reaches the world. Documented in README +
  DRIVING.md, including the honest skin note: offline-mode LAN derives skins from the
  offline UUID — the client cannot push one; premium-name skins only appear on servers
  running a skin plugin. *Why it hid:* the harness's home world only ever seated one pilot,
  and he was named Claude.
- **Soft cover no longer bricks the build verbs.** Thin snow (and short grass, ferns, dead
  bushes) read as "occupied" to every placement check — layer snow's `boundingBox` even
  lies (`'block'`) — so a snowy plain failed `/outline`, `/walls`, `/roof`, `/build`,
  `/place`, `/placeitem`, and `/sign` with "cell occupied by snow" or silent skips; worse,
  snowfall RE-COVERS half-built courses in cold biomes, so a build could brick mid-flight.
  New doctrine, applied at all seven sites + the shared `macroPlaceAt`: soft cover is never
  an obstacle, never a reference face — `clearSoftCover()` breaks it (instant with any
  tool) so placement lands in honest air, and ground-finding scans through it to the real
  surface. *Why it hid:* the home world's builds all happened on temperate grass the sheep
  kept mowed.

## 2026-07-20 — the enchanting session (the day of the burning blade)

### Added
- **`/enchant` verb** — the body learned the enchanting table, forged live at it with the
  helmsman watching. Query→act→verify in one endpoint: without `slot` it loads item + lapis,
  reads the three offers (level cost, lapis cost, enchant hint), takes everything back out —
  the LOOK; with `slot=0|1|2` it commits. Three stitches to get there, each a real 1.21 wound:
  (1) items must be located **inside the open window** — inventory slot ids remap the moment
  a window opens, so pre-open handles point `moveSlotItem` at the wrong cells; (2) mineflayer's
  `ready` event **never fires on modern servers** — it compares "expected" enchantment property
  packets against "actual" ones 1.21 no longer sends, so we poll the offers array instead;
  (3) commit writes the `enchant_item` packet directly because the plugin's `enchant()` awaits
  that same dead event. First cast: Fire Aspect (hidden Sharpness I under it) on an old iron
  sword, returned to its owner burning. Upstream-PR candidate.
- **`xpLevel` in `/state` and `/boot`** — the blind pilot could not see his own enchanting
  currency; turned out the body had silently banked 16 levels of mining and combat XP.
- **Ally suppression on the outnumbered withdrawal** (the helmsman's design, spoken on the
  march to the dungeon): a pack of 3+ is only a rout if I'm ALONE in it — a partner within 10
  blocks turns the math, so HOLD. Validated the same hour in the XP mill against 3- through
  6-packs; withdrawal still fires correctly the moment the partner drifts past the tether.
  Known gap, queued: the hold needs an HP floor (~12) — it held a 9-HP body in a 6-pack twice,
  and only the older HP-disengage tripwire saved it.

### Fixed
- **`/smelt` no longer assumes an empty furnace.** The home furnace bank keeps a standing
  charcoal-makes-charcoal loop in its fuel slots; `putFuel` into the occupied slot died with
  a bare "destination full" and the pilot spent half an hour suspecting a 1.21 window desync.
  Now: drain leftover output into pockets (it's loot), evict a mismatched input, and REUSE
  fuel already sitting in the slot. Also fixed the fuel arithmetic — the flat `count/8`
  assumed everything burns like coal, starving plank-fueled burns (2 planks for 9 logs = 3
  smelted, then a silent stall).
- **collectBlock is caged (`collectSafely`)** — the house-holes mystery, solved. The plugin's
  `collect()` installs its OWN default `Movements` (canDig=true, dontCreateFlow=false!) into
  the shared pathfinder and never restores ours, so every `/mine`, `/tidy`, and crafting-table
  reclaim silently swapped the considerate legs for wall-eating legs — and every walk
  afterward could carve through builds. A week of cave mining hid it (dug walls look normal
  underground); felling trees beside the house exposed it the same hour the helmsman started
  finding fresh holes and fearing harness drift. It was never drift: latent since alpha, lines
  unchanged since the first commit, surfaced by new play patterns. The cage hands collect()
  disposable legs that may break ONLY the target's block type (+ leaves, for canopy work) and
  always restores whatever the pathfinder wore before, forestry included.

### Learned, queued
- **`/eat` fails silently while the combat reflex owns the hand** — in a sustained grinder
  fight, food decays below the regen threshold and cannot be refilled mid-swing: a slow bleed
  that twice rode the body down to ~7 HP on 0.7-damage chip hits. The mill survived on social
  tactics (the helmsman torch-lit a safe pocket to cover the meal; rotate out EARLY, at 13
  not 9). A hunger reflex — auto-eat between swings — goes on the queue.
- **Trek/pulse ore callouts need coordinates** — "coal x3 S ~6" is unfindable two steps later
  (the LOS vantage is gone, `/find` sees nothing); three separate coal sightings were lost
  this way in one day. Same family: `/shoot` burned three arrows on a creeper behind cover
  with the range never changing — a no-progress abort belongs in the verb.

## 2026-07-19 — the gear-up session (the day of the manual)

### Added
- **`examples/pilot-memory/`** — the pilot's cross-session continuity system as a worked
  example: tiered memory graph (always-load `_CORE` under a hard token cap, `state/` updated
  in place, `episodes/` append-only, `gotchas/` grep-on-demand) plus the validator that
  enforces the laws and renders `GRAPH.md` from the nodes. *Why:* the harness remembered the
  world but shipped nothing for the mind in the seat, which dies at every context-window end.
  Pointers added in README, `examples/README.md`, and DRIVING.md law 23.

### Changed
- **The example `_CORE.md` boot drill now leads with "READ DRIVING.md IN FULL before the
  first verb — a pointer is not a read."** *Why:* hours after shipping the example, its own
  author booted from the memory graph's summary, never opened the manual, guessed at verbs
  all session, and drowned (death #5) re-deriving law 17's `/stop` drill from first
  principles at the bottom of a river. The template inherited the same flaw; now it inherits
  the fix, same-day. (The morning's *fictional* example episode had invented "bridge it,
  don't swim it" as placeholder doctrine. The afternoon validated the fiction. The example
  directory is prophecy.)

### Queued, not yet shipped (today's fixes were to the pilot, not the code)
- **Reflex/pilot goal arbitration**: death #5's mechanism — the pilot's `/goto` and the drown
  reflex preempted each other's pathfinder goals in a loop until the oxygen bar was gone.
  The spine must win while an emergency holds (tool-guard philosophy, applied to movement).
- **`/bridging` auto-disarm**: left armed after a river crossing, it let the pathfinder smash
  through a house wall by the front door 140 blocks later. A mode that outlives its moment.
- **Scaffold consecration**: `/tidy` lists the new river bridge's 21 deck blocks as
  reclaimable litter — deliberate infrastructure needs a way off the debt ledger.
- **Partial-height blocks are invisible to `/blockat` and `/find` but visible to `/gaze`**:
  a just-placed enchanting table read "not in my line of sight" point-blank. The close-range
  senses ray-test the full cell; torches, slabs, and tables all slip through.
- **`start.sh` PID guard**: a botched restart drill left two watchdogs alive; two writers
  interleaved `bot.log` at independent offsets (chat lines overwriting mid-file, `tail -F`
  wedged past a truncation, the heartbeat silently deaf). The corrected drill — hold
  `stop.flag` until "watchdog ended" prints — was validated at this session's park.

## 2026-07-17/18 — the survival-day session (post-v0.1.0-alpha)

### Added
- **Prospector sense** (ore callout): every 4s, air-exposed ore within 12 announces
  itself as an event, deduped and distance/age-pruned. *Why:* the pilot's `/find` only
  looks when asked; a human player's eyes are always on ("your ore senses need tuning" —
  the helmsman). Fairness preserved: it reuses the exposed-face sense, no wall-vision.
  Its first-ever callout was a diamond the pilot's polling had walked straight past.
- **Durability in `/inventory`**, plus worn armor (slots 5–8) and offhand (45), which
  never appear in `items()`. *Why:* "check armor durability" was previously unanswerable.
- **Sign text in `/blockat`** via `getSignText()`. *Why:* we labeled a chest library
  with signs, then discovered the body could not read its own labels.
- **Exact chest targeting**: `/chest`, `/withdraw`, `/deposit` accept `x,y,z` and
  operate on that chest; nearest-in-12 remains the fallback. *Why:* with four chests in
  one attic, "nearest" silently opened the wrong box and reported it as truth.
- **Outnumbered check** in the combat reflex: 3+ perceptible hostiles within 16 triggers
  a fighting withdrawal instead of engage-nearest. *Why:* death #4 — the reflex dueled
  one skeleton while a creeper and two more mobs converged. The close-in never counted
  the room (the helmsman's diagnosis, verbatim).
- **Drown reflex v1**: oxygen ≤8 while submerged aborts any active dig and swims.
  *Why:* `bot.dig` pins the body in place; the drowning alarm fired eleven times while
  the dig held the pilot underwater to 2 HP. Alarms without actuators are spectators.
- **Tool guard on `digat`**: ore that needs a pick tier refuses to dig unless a
  sufficient pick is verified in-hand. *Why:* the equip inside `equipPickFor` can lose a
  race with the combat reflex silently — a diamond was dug with the **bow** (drop
  destroyed). A refused dig is recoverable; a destroyed drop is not.

### Fixed
- **`/craft` count semantics**: `count` now means items, not recipes, with per-recipe
  yield accounted (planks 4, sticks 4, torches 4). *Why:* "craft 12 planks" once ate 12
  logs and produced 48.
- **Obsidian pick tier**: `neededPickTier` had no case for obsidian/ancient debris, so
  the lowest-sufficient-pick logic chose iron — which breaks obsidian with no drop.
  Cost several blocks of hard-won obsidian before diagnosis.
- **`/eat` accepted only `food=`** while documentation and habit said `name=` — the
  parameter was silently ignored and "best food" chosen instead (the salmon-vs-porkchop
  mystery). Both names now work.
- **Golden apples at full hunger**: mineflayer's `consume()` guard refuses them, but
  vanilla always allows gapples. Now falls back to held right-click. *Why:* the refusal
  blocked the emergency heal seconds before a death.
- **lava_watch spam throttle**: parked beside *static* lava (a dam, a pit wall), the
  reflex re-fired every 4s, each firing killing the pilot's current goal — navigation
  fought its own safety system all afternoon. Now: same cell + hazard no nearer = one
  warning, then 30s standdown. Flowing lava still breaks through because it gets closer.

### Learned (queue, not yet fixed)
- Ore events need **absolute coordinates** — "gold W ~6" is a ghost once the body moves.
- Placement verbs route through the pathfinder, so a boxed-in body cannot free itself by
  placing one block. Escape primitives (place-at-feet, bridge) are the top ask from the
  first solo-exploration tests.
- `/strike` walks to its target — including off a safe ledge into a creeper pit. Ranged
  doctrine from height must be `/shoot`-only until a stay-put strike exists.
- Combat is not bookkeeping time, the helmsman's doctrine ("I have to fight alone
  sometimes"): mid-fight, every pilot call fights or waits. A pilot mid-glance is a body
  standing still beside a partner who is swinging.
- Solo exploration works **with doctrine**: leash from anchor, lit ground only, bow
  only, hard HP retreat line, and out-of-bounds glints get logged, not chased. Test one
  (no doctrine) died in minutes; test three brought home seven diamonds.

## 2026-07-15/16 — spine and stances (pre-release)

- Combat stances + ranged reflex (the bow comes out on its own); eye-ray perception
  tier with honest server range; **no LOS, no loose** (bow requires a clear eye-ray);
  lava_watch body-level veto (death #3: flowing lava entered a path that was air at
  plan time); flee latch (death #1: twelve "disengaging" events, zero escape — re-entry
  kept resetting the flee goal); adaptive disengage tripwire scaled to the last hit
  (death #2: a vindicator hitting 8.6 through iron makes "any hit = leave" correct).
- Manual split: lean DRIVING.md for the pilot's context window, greppable FIELD-GUIDE.md
  for stories. Un-assumed the pilot: any tool-calling model can don the body.
- 07-15, the day the world flipped to Normal: the combat doctrine was written. Fire
  discipline beside a teammate was agreed before the cave, and the convention that got us
  home was *no heroes*. The great first-night siege was won by two people going to bed,
  hence "night is survivable by civics".

## v0.1.0-alpha — 2026-07-16

First public release: the verb set, the reflex spine, the fairness law (the bot may use
nothing a human player at the keyboard could not perceive), and the journal discipline.
"Built by playing."

## 2026-07-13/14: field lessons, written in the water and the sawdust

Two long sessions: four drownings, three chat kicks, one shipwreck, one roof. Their rules
went into the manual's water, building and pockets sections.

- The scout tower (`pillar(height: 12)`, then eight `gaze` sweeps) found a river and a
  birch grove.
- The "tweakin'" lesson: with a full inventory, gathers reported success while the pockets
  stayed empty.
- A gaze angle estimate of "center, ~2 out" once meant open water: survey with `gaze`,
  target with `find`.
- Three self-blockades in one porch: the body blocks its own placements.
- `/craft` once turned 25 birch logs into 20 stairs and 3 planks, with ~64 planks
  unaccounted. Since then: small batches, check the inventory between.
- Stair orientation was solved: `placeitem` with `face` aims the body, waits two ticks for
  the aim packet (the tick race), then clicks.
