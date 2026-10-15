# Changelog

This harness is **built by playing**: nearly every entry below exists because something
bit us in the world first. Each fix records the wound that taught it — the reasoning is
the point, not just the diff. Dates are play-sessions, not releases. Full commit messages
carry more detail (`git log`). The pilot's text (`DRIVING.md`, `manual/`) states the rules
and leaves the stories here.

## 2026-10-15: live-play fixes

Chat length. On the 1.7.10 testbed every line over 100 characters arrived cut to 100, while
the owner's own client sends up to 256 there. The cut is ViaVersion's 1.11 to 1.10 step,
and a ViaProxy plugin raises it to 256 for a 1.7.10 server. The chat line length is
`GOLEM_CHAT_MAX` (100 to 256, 100 when unset), and the `chat` description names both
lengths. The MCP wake log now names the params each tool call passed, never their values,
so unused tools and params can be counted and trimmed later.

The head jittered on every walk past a mob: the combat reflex's standoff stare forced a look at it
every 250 ms while the pathfinder turned the head toward its next node every tick, and the yaw is
also the walking direction. The stare now waits until the legs are idle (`lib/head.js`). Melee and
bow aims are unchanged.

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

Reflexes took the legs in silence: a job carried on fighting a flee, and a walk answered a bare
`stopped`. Now a running job keeps the legs from flees, cover moves and chases until a mob stands
in melee range. A reflex that does take them (melee, an emergency flee, lava, drowning, the
unexplained-hit freeze, the bunker) ends the job and stops the job's walk with it, and its end
event, `/job`, `/jobs` and a stopped `/goto` or `/collect` name the reflex in `takenBy`. A job
cancelled this way stops counting as running at once, while it still winds down.

These landed side by side, and three of them reached for the legs at once. The walk routes counted
stops in one place and the jobs named reflexes in another, so a route could end unnamed or a name
could point at a reflex that never stopped it. Now one ledger does both: every reflex that takes the
legs (the hurt freeze, drowning, lava, a flee, a cover move, a chase, the vanguard's release in melee
range, unstuck and the bunker) records itself there, and that record is what ends a walk route begun
before it. `/stop` takes the legs for nobody and clears the lane. A melee fight ends a running job but
leaves a pilot's walk its legs, as the lane says. `follow` also waits while a job runs, since it would
otherwise re-arm between the job's own paths and drag the body off. `/scene` names players by username
like `/entities`, and a player named like a mob is never a threat there. A player under an invisibility
potion counts as unseen, as the nametag rule already had it.

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

`gaze` named surfaces its rays struck in total darkness. Those rays now read `too dark to see`, and
the trek scan skips them too. A walk toward a player known only by the nametag aimed at their exact
position. `goto` now heads for the centre of their 5-block cube with a reach that covers all of it,
and `follow` arms the entity goal only while it sees the player, else aims at the cube centre and
re-aims when the cube changes.

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
