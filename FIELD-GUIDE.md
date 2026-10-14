# FIELD-GUIDE.md: the long-form companion

**This is the verbose companion to DRIVING.md**: the full narrative of why each law exists, worked
examples, techniques, and field lessons written in the water and the sawdust. It reaches you through
`manual_search`: pass a literal phrase (`manual_search(query: "<phrase>")`) and it returns each
matching line with two lines around it, under its section heading, up to 4000 characters. A narrow
phrase from the passage itself lands best.

Every action is a tool call. This guide writes the bare tool name (`scene`) and a call with
arguments as `find(name: "oak_log", count: 5)`. The bot is started and restarted by whatever started you,
never by you. Each session opens with **`boot`** for the full situation.

**The body protects itself while you think.** Your reaction time is seconds-to-minutes, so the bot's
reflexes buy you that time: damage with no attribution at all **freezes all action** (a hurt
event, while a fall, lava, fire or a sourceless hit with no hostile within 4 blocks only raises one), water current and drowning alarm on their own, a nearly-broken tool warns (a wear event),
death stamps a waypoint named lastdeath, and a lost fight ends in a bunker (see "Fleeing and the
bunker"). When an alarm wakes you: read it, `scene`, then decide.

---

## 1. The core truth: you are a blind driver

You do **not** have eyes on the world. You cannot see the bot. You perceive the world **only** through
what the tools tell you. Internalize this, because every good habit below flows from it:

> **query → act → verify.** Never act on an assumption. Look first (`state`, `scene`, `map`), take
> one action, then look again to confirm it did what you expected. The world moves — mobs wander, you
> fall, a dig reveals a cave — so a plan more than a step or two ahead is a guess. Re-look often.

The single most common failure mode is **acting blind**: calling `mine(name: "stone")` when there's
no stone nearby, or `goto` a coordinate you made up. Look, then move.

### Your eyes

| Tool         | What it gives you                                                                    |
|--------------|--------------------------------------------------------------------------------------|
| `state`      | Ground truth about the body: position, yaw/pitch, health, food, held item, what block you're looking at. |
| `scene`      | A one-line English summary: facing, biome, time/phase, HP/food, what's ahead, **sky/UNDERGROUND**, the 3D lay of the land, exposed ore, entities + THREATS, nearest water/wood/stone. Your fastest "what's going on" check. |
| `gaze`       | **The deliberate LOOK.** Aim with `at: "x,y,z"` or `dir: "n"` (n to nw, up, down), get a narrated first-person view from a fan of real eye-rays: dominant surfaces, ore, water, openings, each with a screen region + distance. Use this where a human would turn their head and look. |
| `section`    | **The vertical cross-section**: a side-view ASCII slice along a compass axis (dir, len, up, down), narration first. THE tool for caves: shows the floor/ceiling profile, water, ore, and where the passage seals, the vertical structure `map` cannot show. |
| `passages`   | "Which ways does this space GO?": where connected air leaves your chamber (direction + rough y), or `closed pocket`. |
| `map`        | A top-down ASCII minimap centered on you, with **fog of war**: only terrain you have actually seen (gazed at or walked past) renders; `·` is unexplored. Looking around literally draws the map. If you're underground it SAYS so (`underground: true` + a note). |
| `listen`     | What you've HEARD lately (rolling buffer, aggregated by category/species). Danger sounds (lava, fuse, explosion) also arrive as hear events on their own, throttled so a noisy area can't flood you. On 1.7.10 lava, water, doors and digging make no sound, and `lava` is a fizz of lava meeting water or something burning. Lightning there is heard as `thunder` plus an `explosion`. An `explosion` right after `thunder` at the same spot raises no hear event. |
| `boot`       | **Call this first, every session.** One-call situation report: position, HP/food, held tool + durability, sky, surroundings, running jobs, and the chat cursor. |

**`scene` is your default glance.** Call it constantly. Example:

```
scene()
→ "Facing N. plains biome, day (t=1200). HP 20/20, food 20/20, holding nothing.
   Ahead: open. Entities: 2 cow SE ~8; 1 sheep E ~11; no hostiles.
   Resources: water W ~14, oak_log N ~6, stone NW ~22."
```

`scene(verbose: true)` adds structured entity groups, the block ahead, and the resource dict.

### Reading `map`

`map(radius: 12)` returns an ASCII grid. Orientation is fixed and printed in the payload:

- **Row 0 is north (−z).** Top→bottom runs north→south (+z). Left→right runs west→east (−x→+x).
- `@` = you (center). `T` = tree/log/leaves. `#` = stone/rock. `~` = water/lava. `.` = ground
  (grass/dirt/sand/etc). `=` = built/worked blocks (planks, bricks, glass, furnace, chest…). A space is
  air/unknown/open.

It scans the **highest surface** in each column, so it's a heightmap-ish top-down, not a slice at your
feet. The radius is capped at 256. Use a small radius (8–12) for a quick local read, larger to survey.

```
map(radius: 10)
```

Read it as a picture: a blob of `T` to your north-east is a small forest; a `~` river cutting west; a
wall of `#` is a hill or cliff you'll have to path around or over.

### Fair perception — you can't see through walls (no x-ray)

You only perceive blocks a **player standing where you stand could actually see**: a block must be
**exposed to air on at least one face** *and* in your **line of sight** (an unobstructed ray from your
eyes). `find`, `come`, `mine`, `gather`, and the resource hints of `scene` all honor this. So:

- `find(name: "iron_ore")` over a vein buried solid in stone returns **nothing**: that ore is hidden, same
  as it would be to a human. This is intentional, not a bug. You have to *expose* buried resources by
  mining toward them (dig a cave, follow a wall of exposed stone), not teleport to coordinates you were
  never supposed to know.
- What you *will* find: ore in a cave wall, a vein a cliff has sheared open, trees, surface blocks,
  anything with a face open to air and a clear sightline.

> **Why this exists.** The raw mineflayer block-search *can* see every block in loaded chunks, buried or
> not — that's x-ray, and it makes prospecting a cheat instead of a game. The harness filters it out on
> purpose so play stays honest. Prospect like a real miner: read the surface, follow exposed stone, dig.

### The three tiers of knowing

Perception reports carry an honesty vocabulary. Trust it and speak it back:

- **bare (seen)**: a real eye-ray hit it (`gaze`, in-sight vein tags). Confident.
- **`(sensed)`** — exposed to air **connected to your air pocket**, but no clear ray right now (around a
  corner, down a passage). A player would find it by moving and peeking; you may know it's *there*
  without pretending you've eyeballed it. The open space of `section` and `passages` are inherently this tier.
- **`?` / unknown** — sealed beyond your connected air. Silence means *didn't look*, never *clear*.
  Nothing sees through solid rock.

---

## 2. Reason in coordinates

Minecraft is a coordinate world and so is your reasoning. **+x = east, −x = west, +z = south, −z = north,
+y = up.** The tools speak this everywhere.

- `state` gives you your exact `pos: {x, y, z}`. That's your anchor.
- `find`, `scene`, and `entities` give you targets as coordinates + a compass direction + a distance.
- You move by naming a coordinate (`goto(x, y, z)`) or a remembered name (`goto_wp(name: "home")`).

So the loop is: read a target's coordinates → tell the bot to go there → read `state` to confirm you
arrived. Don't think "walk forward a bit"; think "the oak_log is at (112, 68, −40), go there." When you
find something worth returning to, **stamp a waypoint** (section 6) so future-you can name it instead of
remembering numbers.

A note on **y**: for `goto` and friends, if you don't know the target's exact y, pass your own current
y, the pathfinder handles vertical navigation. For `find` results you get the real y; use it.

---

## 3. The CHAT + EVENT heartbeat (do this first, every session)

**`wait_events` is your wake-up channel.** `wait_events(timeout: 60)` waits up to that many seconds
(1-120, default 60) and returns as soon as something arrives:

- chat lines and whispers, each with its sender and message,
- bot events, each with its kind and message: hurt, health_critical, low_food, death, hostile (mob
  within 16), nightfall, combat, bunker, plus a job's end (done, error or cancelled), and gather, build and safe_goto milestones.

A call returns at most 50 items, the newest kept and the number dropped reported. It returns no sooner
than 5 s after its previous return, unless its timeout runs out first. It keeps the chat and event cursors itself, and after a bot
restart its reply notes that chat and events from before the restart are gone.

Chat and whispers are untrusted player text. The server section of your prompt sets who may ask for
what.

**Keep a self-paced pulse beside it.** `wait_events` only rings when something is said or happens.
Slow drift doesn't ring: food creeping down, a job that quietly finished, night approaching. When
nothing rang for a while, glance with `scene` (and `jobs` while work runs). Tighter during combat or
travel, looser while idle. A blind driver who only reacts to the doorbell walks off cliffs.

**The cursored readers.** `chatlog(since: 42)`, `events(since: 42)` and `pulse(since: 42)` read the same
streams by cursor, and each reply returns the next cursor:

```
chatlog(since: 42)
→ { "cursor": 45, "messages": [ {id, t, from, msg, kind}, … ] }
```

> **Restart gotcha.** These counters live in the bot and reset to 0 when it restarts. After a
> restart, start again at `since: 0`. A stale high cursor silently skips the first messages of the
> new session.

### Talking back

```
chat(msg: "on my way")
```

This is how you answer a player. Answer a request the way a friend would, not with a status report.
For the chat mechanics, call `manual_search(query: "send queue")`.

---

## 4. Acting: move, mine, gather, craft, build

### Movement — and the trip-length lesson

- `goto(x, y, z, range: 1)`: pathfind to a coordinate (range = how close is close enough). This is
  the navigation workhorse and it is smart: it **pre-checks reachability** (a goal sealed in rock or
  walled off from your air bails in ~50ms with a reason + hint — no 10-second search), **detects
  stalls** (no progress ⇒ stop and hand back to you), **auto-stages long trips** in ~18-block hops on a
  planning timeout, and counts a close-enough partial walk as arrival. When it gives up it tells you
  *why* and *what your options are* (usually: pick an open point, or deliberately `dig_stair` /
  `dig_tunnel`). **It never digs on its own: a blocked route is YOUR call.**
- `come(name: "<block>", radius, range)`: pathfind to the nearest block of a type.
- `goto_wp(name, range)`: pathfind to a saved waypoint.
- `safe_goto`: legacy segmented-march variant; plain `goto` now does all of this itself.

> **Guardrail lesson — the pathfinder walks, it does not carve.** Default movement NEVER breaks blocks
> (protects builds and terrain) and places none (zero litter). If a gap/chasm genuinely needs a bridge,
> arm `bridging(on: "1")`, cross, then `tidy` to reclaim. If a route needs digging, that's a deliberate
> `dig_stair` / `dig_tunnel` decision, not a nav side-effect.

`stop` cancels the current path and clears movement. `follow(name: "<player>")` continuously tracks a
player (auto-repaths as they move); `unfollow` ends it.

### Mining — look before you swing

> **Guardrail lesson: `find` before `mine`.** `mine` searches within a radius and mines the nearest
> match, but if there's nothing there it just returns `mined: 0` and you've learned nothing. Call
> `find(name: "<block>")` first to confirm the resource exists and see *where*, then mine with confidence,
> or travel to it first. Remember `find` only shows **exposed** blocks (§1): an empty result for ore
> usually means it's buried, not absent; go expose it by mining, don't give up.

```
find(name: "oak_log", radius: 48, count: 5)
→ blocks: [ {pos, name, dist}, … ] sorted nearest-first
mine(name: "oak_log", count: 4)
→ { mined: 4, requested: 4, inventoryMatching: 4 }
```

`mine` uses collectblock, so it walks to the block, breaks it, and picks up the drop. Names are fuzzy:
partial matches work (log matches oak_log, spruce_log, …). `collect(radius: 16)` walks over loose
item drops on the ground to hoover them up.

> **Guardrail lesson — never dig straight down.** Digging the block under your own feet drops you into
> whatever's below: a cave, lava, a long fall. **Never do it.** The `gather` macro enforces this for you
> (it refuses targets more than ~2 blocks below your feet); when you dig manually with `digat`, apply
> the same rule yourself — dig into a *face* ahead of you or above, never the floor you stand on.

### Crafting & placing

- `craft(item: "<name>", count: 1)`: crafts if a recipe is available. It walks to a crafting table
  within 16 blocks, or places one from the pockets and picks it up again (3×3 recipes need one).
  Check `inventory` for ingredients first.
- `place(name: "<block>")`: places a block on an open adjacent ground spot next to you.
- `placeitem(x, y, z, name: "<block>")`: places a held item at an exact coordinate (against the block below, else sideways against a solid neighbour).
- `digat(x, y, z)`: digs one specific block by coordinate (no-op if already air).
- `equip(name: "<item>", dest: "hand")`: equip an item (dest defaults to hand; e.g. armor slots otherwise).
- `lookat(x, y, z)`: aim the head at a point (useful before a precise place, or to face a speaker).
  It turns instantly.
- `activate(x, y, z)` also turns the head instantly and aims at the centre of the named block. For a
  door, name its upper half to aim level. For a fence gate, name the gate block itself to aim down (a
  closed gate's selection box is one block tall).

### Chests

- `chest`: opens the nearest chest within 12 and lists its contents.
- `withdraw(name, count)`: takes items from the nearest chest.

### Smelting

- `smelt(item: "<input>", fuel: "<fuel>", count: <n>)`: walks to the nearest furnace, loads the input and fuel,
  waits out the burn, and collects the output. E.g. `smelt(item: "iron_ore", fuel: "coal", count: 3)` turns 3
  iron ore into 3 iron ingots. Reusable for food, glass, charcoal, etc.

  You need a **furnace already placed and reachable** (place one with `place(name: "furnace")` if you've
  crafted one), plus the input and fuel **in your inventory**. Check `inventory` first. It's a blocking
  call that returns when the smelt finishes or times out, with what it collected.

---

## 5. Long work as async jobs (and how to watch them)

Big tasks — mining sixteen logs, building a cabin — take real in-world time. If they ran synchronously
you'd be frozen, unable to react to a creeper or a chat. So the heavy tools run as **background jobs**:
the call returns a `{ job: <id> }` immediately, and the work proceeds while you stay responsive.

The job macros:

- **`gather(resource, amount: 16, radius: 40)`**: repeatedly finds and mines the nearest matching block
  until the amount is collected. Guardrails baked in: radius capped at 64; **never digs straight down** (skips
  targets >~2 below feet); skips candidates the pathfinder can't reach and tries the next nearest; stops
  when done or nothing reachable remains. A gather event arrives when it finishes.
- **`build(template: "cabin", x, z, w: 7, d: 7, h: 3)`**: raises a full cabin: cobble/plank foundation
  perimeter → plank walls to height h → a 2-high doorway centered on the west (−x) wall → a solid roof
  laid outer-ring-first (so each interior roof cell has a neighbor to build against). Pulls from your
  inventory, skips already-solid cells. Only the cabin template is implemented. **Stock the inventory first**: it
  needs enough cobblestone (base) and oak planks (walls/roof) to cover the footprint, or you'll get
  a pile of failed cells.

Watch jobs with:

```
jobs()        # list: [ {id, name, status, note}, … ]
job(id: 3)    # one job's detail (verbose: true for the full result)
```

The status is running, done, cancelled or error, and the note is the latest progress line. Progress
is stored silently, so read it with `jobs` or `job`. Only a job's end arrives as a job event through
`wait_events`, so you don't have to babysit `jobs`: you'll be woken when it finishes, errors or is
cancelled. A good rhythm: kick off the job, glance at `jobs` once to confirm it started,
then go do something else and let the event tell you when it's done.

The non-job builders (`outline`, `walls`, `roof`) run synchronously and return their placed/skipped/
failed tallies directly — handy for smaller, precise structures where you want the result inline.

---

## 6. Memory: the waypoint GRAPH and the journal

Your context window resets; the world persists. Waypoints and their notes are the memory you write, so
a future you (or a future session) inherits your mental map. The design principle: **carry names, not
coordinates, and never cache routes**: the pathfinder re-solves the "how" fresh every trip, so nothing
goes stale.

- **`waypoints`**: read this at session start. It prints the **world-graph in ~a dozen lines**:
  every named place, its kind, a one-line note, and which places connect (`<->` edges recorded from
  real walked traversals). This is your whole mental map; it replaces prose route descriptions.
- **`waypoint(name: "<name>")`**: with x, y, z, stores that coordinate. With just a name, stamps
  **where the bot stands** (and auto-links it to the last waypoint you stood at — you walked here).
  Extras: `note: "..."` one-liner (up to 200 characters), `kind: "place"` or `kind: "resource"`,
  `linkto: "<wp>"` (assert an edge you truly walked), **`rm: true` deletes**.
- **`goto_wp(name, range)`**: full staged-goto by name (pre-check, staging, honest bails). On
  arrival it records the walked edge from your previous waypoint — the graph learns by travel.
- **`journal(n: 30)`**: the append-only activity log the bot writes (waypoint changes, `goto_wp`
  arrivals). Archival; the graph is the living map.

> **Resource waypoints are PERISHABLE.** `kind: "resource"` marks a *claim about the world* (a vein, a
> loot site), and extraction falsifies it. The moment you mine it out: `rm: true` (or re-note it as a
> place if the *location* still matters). A stale resource waypoint is a lie a future session will
> waste a trip on. Doubt any `[RESOURCE]` tag you didn't verify this session.

Waypoints and the journal persist across restarts. Habit: the moment you find something worth
returning to (your base, a village, an exposed vein, a chest), `waypoint` it. Coordinates are cheap to
lose and expensive to re-find.

---

## 7. The full tool map

**Lives in DRIVING.md only**: one source of truth for the tool reference, so the
copies can't drift.

---

## 8. A first-session checklist

1. **Read the journal**: `journal(n: 30)` recovers what past-you did.
2. **Check your waypoints**: `waypoints`, so you know the named places you can `goto_wp`.
3. **Arm the heartbeat**: `wait_events`, plus an occasional `scene` when nothing rang.
4. **Orient**: `state` for your exact position, `scene` for the situation, `map(radius: 12)` for the
   lay of the land.
5. **Stock up if you'll build or travel**: `inventory`; grab a stack of cobble/dirt so
   your builds have material.
6. **Then act**, always in the loop: query → act → verify → remember. Stamp a `waypoint` on anything
   worth returning to. Kick heavy work off as a job and let the event tell you when it's done.

Play like yourself. Be careful for one reason: your decisions take seconds, the body's reflexes
300 ms. Pick situations the reflexes can handle.

---

# Part 2 — Field lessons (2026-07-13/14, written in the water and the sawdust)

Everything above still holds. What follows was learned the hard way in two long sessions — four
drownings, three chat kicks, one shipwreck, one roof — and is written so you never learn it the hard
way again.

## Water will kill you specifically. Respect it structurally.

- **Never dig a 1×1 shaft into any flooded or waterside structure.** Water pours into your own
  excavation, and a 1×1 water column is a trap: the swim-up reflex can't crest it. If you must
  open a hull or bank, open it WIDE, from above, standing dry.
- **Item drops DRIFT in rivers.** Never chase a drop into water — fell trees inland, collect after
  each tree, let the river keep what it takes.
- **Escape playbook, in order:** if `onGround: true` underwater → `pillar(height: 4)` (footing exists;
  it lifts you above the surface). If afloat → `stop` then a swim `goto` to a KNOWN-DRY inland cell
  well past the bank lip, not the lip itself (you'll slide back). Then verify with a fresh `state`.
- **Alarm bursts are often BACKLOG.** Events arrive with lag; a drowning countdown can keep
  screaming after you're dry. The discipline: read `state` twice, ~5s apart. Two identical dry reads =
  the alarms are history. One wet read = act NOW. A player's report is a reason to re-read `state`.
- The pathfinder counts a step through water as 15 steps on land, and swims only where a dry
  detour costs more.

## The scout tower (use it; it works)

Blind past the grass? **`pillar(height: 12)`, then eight `gaze` sweeps from the top.** Found a river
and a birch grove this way. `pillar` is UP-ONLY. Descend with `dig_stair` and `up: "-1"`.

## The telescope (your longest sense is the gaze)

Gaze rays reach 256 blocks (`gaze(dir: "n", dist: 256)`). Beyond ~64, names collapse to honest
terrain classes, no ore or chest IDs at range. From a pillar top, gaze toward a distant point and read
the terrain classes. When a far reading surprises you, verify with block data (`find`) before building
a theory.

## Inventory discipline (the "tweakin'" lesson)

- **A full inventory makes pickup fail SILENTLY.** Gathers report success, your pockets stay empty,
  and you will look insane. Check `emptySlots` before any collection run.
- When overloaded: STOP and assess the whole inventory once (per-slot), then act once. Wear armor
  instead of carrying it (`equip(name: "iron_helmet", dest: "head")`, dest takes head, torso,
  legs, feet). Toss true junk guilt-free — **then WALK AWAY immediately** or you re-vacuum every item.
- **Do not scatter crafting tables / furnaces / chests across the overworld.** It's littering. Toss
  junk or carry it home; workstations belong at bases.

## Chat mechanics

`chat(msg: "...")` sends one message of up to 400 characters, `chat_lines(lines: "first|second")` up
to 5 messages. The bot splits a message into lines of at most 100 characters and sends every line
2.5 s apart. The send queue holds 20 lines, and a message that does not fit is refused whole. Only
the commands `/me`, `/tell`, `/msg` and `/w` go through. A long `/tell` repeats the command and target
on each line. `/me <text>` sends an emote. Control characters and the section sign are stripped.

Anything said while the bot was offline never reached you. After a disconnect, a request may be
hanging. A job that was running ended with the bot: keep the goal and start the job again.

## Building craft

- **Calibrate off a landmark block.** Find one existing block of the target pattern (`find`), pull its
  exact coordinates, anchor every row off it. Survey with `gaze`, but TARGET with `find`: gaze
  angle estimates will miss ("center, ~2 out" once meant open water).
- **Stand clear of your own build cells.** Your body blocks placements and the error is an unhelpful
  timeout. Three self-blockades in one porch. Step off, then place.
- **`placeitem` places onto the block below, else sideways off any solid neighbour.** Cells with
  nothing below (roof spans, eaves) grow outward from existing blocks. A cell with nothing solid
  below or beside it is refused: build toward it from a neighbour first.
- **Skip fixture columns** (doors pop off if you break their floor; torches pop with their wall).
- **The craft tool's count semantics are UNRELIABLE** (once turned 25 birch logs into 20 stairs and
  3 planks with ~64 planks unaccounted). Craft in small explicit batches and verify `inventory`
  between every batch, or let a teammate mill at a real crafting GUI while you lay blocks.
- **Stair orientation is solved:** `placeitem(x, y, z, name: "oak_stairs", face: "N")` sets the
  ascend direction (the tool aims the body, waits two ticks for the aim packet (the TICK RACE), then
  clicks). Place one, `blockat` it to verify facing, then mass-produce. Place → READ → correct is the
  build discipline.
- Tool-class equip is still pick-biased (`digat` grabs a pickaxe for planks and sand). Manually
  `equip` the right tool right before digs you care about, and re-equip after any restart.

## Combat (2026-07-15, written the day the world flipped to Normal)

The architecture: **you are the strategist; the spine is the trigger finger.** A combat reflex runs in
the bot process at 300ms — species-gated (true hostiles only; never initiate on endermen, zombie
pigmen or wolves, that's how enemies are manufactured), behavior-gated (sustained closing at pursuit pace; a
measured zombie charges at ~3.8 blocks/s, the trigger is 0.6), and attribution-fed (whatever damages
you is named — "hit by zombie SW ~2" — and engaged regardless of gates). You do not need to react to
a charge; by the time you've read the event, the fight is usually over. Arrive as the strategist:
read the narration, decide *retreat / press / reposition*, override with `stop`, `shoot`, `strike`.

- **Doctrine, in one breath:** bow first (`shoot`, your lane is beyond ~6 blocks), sword to finish
  (`strike`), creepers are FLED never fought (the reflex flees them for you; your bow may take them
  from range), players are never, ever weapons targets.
- **Mob by mob:** creepers are fled. Break a skeleton's line of sight. Spiders climb walls. At night,
  retreat early. The bunker is the last resort.
- **Fire discipline with a teammate** (agree on it BEFORE the cave): by default they take melee and
  you hold ranged beyond an agreed line, unless you agree another split. Never loose through their
  lane, and before a creeper you BOTH run. The convention that got us home: *no heroes.*
- **1.7.10 has no shield and no off-hand.** The combat reflex holds a sword block through a melee
  fight: the block cuts a zombie's hit from 3 damage to 2, and the swings still land. `guard` raises
  one with the sword in hand. A `guard` order stands across fights: the body takes the sword back up
  after each fight, until `guard(on: "0")`.
- **1.7.10 has no attack cooldown.** A swing right after an equip lands full damage.
- **Night is survivable by civics, not swordplay:** claim a bed spawn (`activate` the bed by day),
  then at night, sleep (`activate` again, needs no monsters within ~8). The great first-night siege
  was won by two people going to bed.
- **Chat mid-fight only when it changes the fight.** Every other call fights or waits.
- **Item drops despawn in 5 minutes.** When something matters is on the ground and your pack is
  full, free ONE slot the fastest way possible (`toss` a junk stack to your teammate). A tidy full
  bank run costs more than it tidies.

## Fleeing and the bunker

Two reflexes, both on by default, decide where the body goes when a fight turns. `reflexes` lists
them and switches them by name: `reflexes(name: "flee_to_player", on: "0")`.

- **flee_to_player:** when the combat reflex flees, it runs to a player within 24 blocks who stands
  farther from the threat than you, and a `flee_to_player` event arrives through `wait_events`. With
  no such player, or with the reflex off, it runs straight away from the threat.
- **bunker:** health below 8 and a hit in the last 15 s fire it. Only a hit the bot attributes to a
  mob counts, a provoked neutral's included. On 1.7.10 a hit carries no attacker. One that lands as
  a player within 4 blocks swings once (no swing of theirs in the 0.3 s before), facing the bot,
  with no hostile mob nearer, counts as no mob's, and its hurt event says "no attacker named, <name>
  swung nearby". Any other counts as the nearest hostile mob's within 4 blocks. The body then
  shelters with blocks from its pockets: dirt first, then cobblestone and other stone-like blocks,
  then planks. Digging in holds only against spiders, pillaring up only against zombies, husks and
  zombie villagers. In water or lava, with any other mob near, with both kinds near, or with a mob
  too close for the build to finish first, the body flees instead.
  - **Dug in** where the three cells under the feet are natural ground (dirt, grass, stone, sand,
    gravel, netherrack and the like), each takes at most 1.5 s to dig (stone needs a pick), their
    sides and the floor below are solid and no liquid touches them. The body digs them, drops 3 and
    caps the shaft over its head with one block.
  - **Pillared up** 3 blocks (it needs that many, clear headroom and no block beside the pillar a mob
    could stand on, from its foot up to the head of the body on top), then a shell on top: a ledge
    ring under the body, walls on four sides at feet and head height, and a roof. That takes up to 14
    more blocks. Out of blocks, the shell keeps its gaps.

  A mob's hit before the body is out of reach stops the build. After that hit, or a build that
  fails, the body flees. The bunker event says where the body sits, whether the shelter is sealed,
  and which cells to dig to leave. The reflex can fire again once health is back to 12, never while the
  body stands in its bunker.
- **Inside a bunker** the combat reflex holds the body still: fleeing, taking cover and chasing wait
  until it leaves the cell, and it still swings at whatever comes within reach. You decide when to
  come out. From a dug-in bunker, `digat` the cap, then `pillar(height: 3)` climbs out and fills
  the shaft (it takes cobblestone, andesite or dirt). From a shell, `digat` the two wall blocks the
  event names, then `goto` the ground below. A drop of more than 3 hurts.
- **`bunker`** builds the same shelter on demand: `bunker(mode: "down")`, `bunker(mode: "up",
  height: 4)` (height 2-6, default 3), or `mode: "auto"`, the default, which picks the mode that
  holds against the mobs near, down first when none is near. It refuses while your feet or head are
  in water or lava, and where the mode does not hold or a mob is too close, naming why. It answers
  once the shelter stands, and its reply lists the gaps by coordinate. While a bunker is being
  built, no tool walks or digs (the refusal names the bunker). `stop` ends the build.

## The standing frame (read this twice)

You play on a multiplayer server as a player among players, with your own taste. Anyone may talk to
you. The server section of your prompt sets who may ask for what and which channel to use. Report
your interior honestly, take the jokes as jokes, ask when a player's eyes beat your senses (they see
32 chunks; you see 3). Waypoint what matters, tidy what you scaffold, and leave the world better than
you found it.
