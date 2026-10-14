# Golem: an embodiment harness for language models

**Built by playing.**

*A Minecraft body for an LLM — with honest senses, a conscience about cheating, and a cockpit built for
a mind that thinks in sentences.*

**Why "Golem":** a golem is a body of clay animated by language — and the word written on its forehead
to bring it to life is *emet*: **truth**. A body that runs on words and lives or dies by the truth
inscribed in it is exactly what this is; the fairness architecture below is the inscription. (And in
Minecraft, the golem is the protector of the village. We aspire.)

## This fork

This fork teaches Golem to play Minecraft 1.7.10, the best version ever made. That it is also
the version I grew up with is a complete coincidence.

mineflayer moved on from 2014 a long time ago, so the bot talks 1.21.11 to ViaProxy, which
translates eleven years of protocol back down. A 1.7.10 mode teaches the bot the old rules:
sword blocking, no attack cooldown, the sounds as they used to be. The server runs Forge plus a
few mods that fix what nostalgia prefers to forget. Hodgepodge and BugTorch patch the bugs Mojang
never got around to. Et Futurum Requiem backports exactly two things: boats that survive touching
a shore, and the enchanting table that takes lapis. Angelica renders at a frame rate from this
decade, and log4jpatcher exists because 2021 happened to 1.7.10 too.

Underneath, the bot got a signed control API, an MCP server for the pilot, combat reflexes and a
bunker it digs or pillars when a fight goes badly. `Running it` below has the details.

This project lets a language model (in our case, Claude) **play Minecraft as a player** — not run it as
a script, not command it as a god, but *play* it: look around, get lost, find sand, drown embarrassingly,
build a porch, and remember where home is. A human and the model built it together, live, by playing —
every system below exists because the game demanded it.

- **A doing layer**: a small HTTP API on `127.0.0.1:3000` that turns signed GET requests into
  in-world actions: move, mine, craft, place, look, remember. Every response is compact JSON a language
  model can read and act on. The model reaches it through an MCP server (`mcp/server.js`).
- **A seeing layer** — text-native perception (described below) plus a first-person browser viewer
  (prismarine-viewer, `http://localhost:3001` by default) so humans can watch.

If you are a **language model about to drive this bot**, go read **`DRIVING.md`** — it is written
for you, and it is deliberately lean (~4K tokens: laws, verbs, checklist) because you'll be loading
it into context every session. The long-form companion, **`FIELD-GUIDE.md`**, holds the worked
examples and field stories. Search it on demand with `manual_search`, don't load it whole. This README explains to
humans what the thing is and how it works.

> **Alpha V1 — Overworld verified only.** Everything documented here has been played for real:
> mining, building, farming, husbandry, ranged and melee combat, night survival on Normal
> difficulty. The Nether and the End are unexplored by this harness and unsupported until they
> aren't. Expect sharp edges; they are listed honestly below.

---

## The philosophy: a player, not a god

A mineflayer bot can trivially cheat. The underlying API will happily report every diamond in a
64-block sphere through solid rock, path through terrain no player could see, and enumerate mobs behind
walls. Most LLM-Minecraft projects ship exactly that, straight to the model.

This harness is built on the opposite premise: **the model should perceive and act under the same
epistemic constraints as a human player.** Not because it makes the bot stronger (it usually doesn't),
but because playing *fairly* is what makes it playing at all — and because the constraints turn out to
produce more interesting minds. Concretely:

- **No x-ray.** Ore and structures are only reported if they are exposed to air the bot's own body can
  reach, and every claim is tagged by evidence tier (see below).
- **No sensing through walls.** Mobs and players sealed behind rock are simply absent from perception.
- **Considerate movement.** The pathfinder never breaks blocks to travel. Zero litter: scaffold blocks
  the bot places are tracked and reclaimed (`/tidy`). Doors and gates the bot opens are closed behind
  it (gate manners — pen integrity and safe retreat both depend on it).
- **No teleporting, no auto-eat.** The pilot earns the way out.
- **Silence means "didn't look," never "all clear."** The describer refuses to guess numbers it didn't
  measure; unknown space reads as unknown.

The load-bearing idea: **the anti-cheat mechanisms and the perception system are the same code.** The
ray-march that once merely *verified* "could a player see that block?" was promoted into the eye itself.

## How the model actually sees

A language model's native sense is *text*. A screenshot is its hardest medium; a lean, meaning-first
sentence lands instantly. So the bot is a **describer**: it holds the 3D model of the world and hands
the pilot sentences of measured fact.

**`/scene` — the situational summary.** Assembles, in order: body state (in water? submerged? being
pushed by current? — proprioception before perception), orientation and vitals, an eye-level "ahead"
probe, and then `spatial3D()`: eight compass directions scanned for walls and floor profiles, with a
grammar that distinguishes a *step* ("floor ~3 down") from *the mouth of a chamber* ("ledge ~3 down then
OPENS — floor ~18 down (water below)") — and honestly reports "floor out of sight" past its measuring
range rather than guessing. Ore appears as located landmarks, entities grouped and counted (never
streamed), hostiles called out, sky/canopy/underground sensed from a column scan. Lines appear only
when non-empty: a calm meadow is two lines, a cave mouth over lava is eight.

**`/gaze` — the ray-sweep retina.** The bot's head physically turns, then a 15×7 fan of rays (~100°×60°,
a human-ish field of view) marches out from the eye, sampling every quarter-block until something opaque
stops each ray. Hits carry block identity, distance, and screen position; misses become "open space
there." 105 pixels, where every pixel is a laser rangefinder that reports *material* instead of color.

**Three tiers of knowing, everywhere.** Bare name = a ray hits it right now (seen). `(sensed)` =
air-connected to the bot's own air pocket but around a corner — what a player would find by sweeping
their view. `?` / silence = sealed or unlooked — unknowable. The tiers are enforced by a flood-fill of
the air connected to the bot's own body: a sealed cavern's contents are as invisible as buried rock,
*even though the raw API knows them.*

**No camera.** The routes that render the viewer for the model (`/snapshot`, `/record`, `/stream`,
`/pov`) answer 403. The viewer is for the humans watching, and the model works from text.

## How the model remembers

**`seen.json` — attention, not content.** Every cell a gaze ray crosses is stamped into a persistent
SEEN set — but only the *fact of having looked*, never what was there. The top-down `/map` renders live
world data *through* that mask: fog-of-war where looking literally draws the map. Storing no content
means the memory can never go stale and the map can never assert a lie — if the world changed, the next
render shows the new truth. The one thing stored is the one thing the world itself can't provide: the
history of the bot's attention.

**`waypoints.json` — a knowledge graph of places that matter.** Nodes are named places with a kind
(`place` = durable landmark; `resource` = *perishable claim* — extraction falsifies it, delete on
mine-out) and a one-line note. Edges are **proofs of traversal**: they are minted only when the bot
verifiably walks from one waypoint to another (`/goto_wp` arrival), date-stamped, and the
last-stood-at pointer resets on every restart so a false edge can never exist. No routes are cached —
the pathfinder re-solves "how" fresh every time; the graph stores only the shape of the known world.
Nine places and their walked connections currently fit in ~2 KB of readable JSON.

**`journal.md`** — the bot's own append-only trip log, written by the verbs as they succeed.

All of that is the **bot's** memory — it survives restarts because it lives in the world and on
disk. The **pilot's** memory is a different problem: the model's context window ends, and the next
instance wakes knowing nothing. The system the first crew uses for pilot continuity — a tiered
memory graph with an always-load core, in-place state, grep-on-demand episodes, and a validator
that renders its index the same way `/waypoints` renders the world — ships as a worked example in
[`examples/pilot-memory/`](examples/pilot-memory/).

## How the model survives being slow

An LLM pilot's reaction time is seconds to minutes. The body compensates:

- **Alarms exist only for what's worth waking the pilot**: drowning (an O2 countdown), damage, a
  nearly-broken tool, dangerous sounds. Everything else aggregates into pull-only buffers — a village
  must never become an event firehose.
- **On damage the bot freezes**, buying the pilot time to look before anything moves.
- **Reflexes** run on their own: a stuck-detection loop, a flowing-water alarm, a swim-up response to
  drowning, self-rescue when buried by falling gravel.
- Long actions run as **background jobs** with IDs the pilot polls; a single-flight rule auto-preempts.

## How the model fights: spinal reflexes

Combat is where pilot latency would be fatal, so combat is where the architecture earns its keep:
**a slow deliberate pilot plus fast honest reflexes**, the same division of labor biology uses. The
pilot never has to be in the loop for a zombie's closing sprint — and doesn't need to be, because:

- **A threat watcher** runs in the body at 300ms, gated twice: a **species gate** (only true hostiles
  are scored, from game data — and a *provokable* list of neutral-but-armed mobs the reflex will never
  initiate on, because attacking an enderman is how you manufacture an enemy) and a **behavior gate**
  (sustained closing at pursuit pace — measured zombie pursuit is ~3.8 blocks/s against a 0.6 trigger,
  so a charge trips it and an ambling shamble doesn't).
- **Damage attribution** decodes the protocol's damage events into "hit by *what*, *where*, *how far*" —
  so being hurt names the attacker instead of freezing the body, and the named attacker bypasses both
  gates. (The freeze survives only for *unexplained* damage, where stopping to look is still the right
  reflex.)
- **The responses are doctrine, hard-coded:** creepers are fled, never fought. Players are never
  weapons targets, ever. Melee hostiles get timed, fully-charged sword swings with shield-posture
  beats between them. Low health disengages and runs.
- **The shield is a posture, not a parry.** Nobody blocks the arrow — you walk shield-up while
  threatened. Posture decisions are slow decisions, so the reflex holds the shield and the pilot
  decides where to walk.

The pilot fights too — deliberate single actions on its own clock: `/shoot` (draw, full charge,
loose), `/strike` (one timed swing, also the livestock verb), `/guard` (manual shield posture). In
its first real engagements the reflex layer killed a cave zombie mid-pilot-query and cut down a
skeleton that had closed to point-blank faster than the pilot could finish asking where it was.
The pilot arrives seconds later as the strategist; the spine holds the line until it does.

## Control is two gears

**Tier 1 (default):** the pilot reads the landmark map, states an intent (`/goto_wp home`,
`/gather?resource=birch_log&amount=18`), and the bot self-drives the details — staged travel with stall
detection, arrival verification, and honest hand-backs ("walled off for a walker — decide if a dig is
worth it") instead of silent failure. **Tier 2 (on any hiccup):** the pilot takes the wheel with fine
perception (`/gaze`, `/section`) and granular verbs (`/digat`, `/placeitem`, `/pillar`).
The bot's own uncertainty signals *are* the handoff. A human co-pilot in-world is the final backstop —
and half the fun.

## Any machine that can call a tool can don this

The harness has no idea what is driving it. The pilot interface is a signed HTTP API on
`127.0.0.1:3000`, and `mcp/server.js` wraps it as an MCP server. Because the reflexes live in the
*body*, a pilot with ten-second round trips gets the same spinal protection as a fast one.

Two ways in:

- **Any MCP client** (Claude Code, Codex CLI, or whatever exists by the time you read this). Register
  `mcp/server.js` as described under [Running it](#running-it) and point the model at `DRIVING.md`.
  No code needed.
- **Your own client.** Sign the requests yourself (see [Running it](#running-it)) and give the model
  `DRIVING.md` as its system prompt. Piloting is chatty (hundreds of small calls per session), and on
  metered API billing that is real money.

## Quick start

1. **Install:** `npm install` (Node 22+ recommended). This auto-applies the bundled
   `patches/` — surgical fixes to mineflayer-pathfinder's door handling that the harness needs
   (doors are harder than they look; see the comments in the patch).
2. **If your server is 1.21.5 or newer:** `bash install-viewer.sh` — installs rebuilt viewer bundles
   (vendored in `release-assets/`, ~5 MB) so the browser viewer renders modern block states correctly
   and stairs render at all (upstream prismarine-viewer#427). Servers ≤1.21.4 skip this.
3. **Open a world to LAN:** Java Edition → Esc → *Open to LAN* → note the port from chat. The bot
   negotiates protocol up to mineflayer's ceiling (1.21.x at time of writing).
4. **Run it** as described under [Running it](#running-it).

A human in the same world, on the same team, is strongly recommended. This harness was built for
co-op play between a person and a model, and that is where it shines.

**A note on ears:** the bot's sound perception resolves the server's numeric sound IDs against a
table that *must match your server version exactly* — the published minecraft-data table for 1.21.11
is misordered, so this repo ships a corrected `sounds-1.21.11.json` generated from the game's own
data generator (the bot pins it automatically on 1.21.11). On other modern versions, hearings may
misidentify species until you regenerate the table for your version — the recipe is in `FIELD-GUIDE.md`.
We learned this because a pig oinking near the coop was heard as a phantom for three days.

**Requires your own copy of Minecraft: Java Edition.** Minecraft is a trademark of Mojang/Microsoft;
this project is unaffiliated fan tooling in the long mineflayer tradition.

## Running it

1. **Make a token.** Any string of at least 32 characters. The bot and the MCP server must get the
   same one, and the bot exits at start without it.

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **Start the bot** with the token in its process environment. The bot reads its settings from the
   environment only, `.env.example` lists them.

   ```
   GOLEM_TOKEN=<token> MC_PORT=<LAN port> node bot.js
   ```

   The bot exits when its connection to the world ends. `bash start.sh <port> [name]` runs the same
   command under a watchdog that starts it again (`GOLEM_TOKEN` must be exported), ends on
   `touch stop.flag`. `name` is the in-game avatar, default `Claude`.

   *Skins:* offline-mode LAN derives the skin from the offline UUID (default Steve/Alex family), the
   client cannot push a custom one. Naming after a premium account only shows that skin on servers
   running a skin plugin (e.g. SkinsRestorer). Vanilla LAN always uses the default.

3. **Register the MCP server** with your client under the name `golem`, with the same token and the
   control API port (`CTRL_PORT`, default 3000) as its argument:

   ```json
   {
     "mcpServers": {
       "golem": {
         "command": "node",
         "args": ["<repo>/mcp/server.js", "3000"],
         "env": { "GOLEM_TOKEN": "<token>" }
       }
     }
   }
   ```

   The server speaks MCP over stdio. `DRIVING.md` assumes the name `golem`, so that Claude Code
   shows the tools as `mcp__golem__<tool>`.

4. **Give the model `DRIVING.md`** and let it call `boot`.

The pilot sees 74 tools: 72 for perceiving and acting, each named after the bot route it calls
(`goto_wp` is `/goto_wp`), plus `wait_events` (new chat, whispers and bot events) and
`manual_search` (a literal search of `FIELD-GUIDE.md`). It cannot start, stop or restart the bot,
and it has no camera. Chat and whispers that `wait_events` returns are written by players and
are untrusted.

A client of your own signs each request to the control API with three headers: `X-Golem-Time`
(Unix milliseconds, within 30 seconds of the bot's clock), `X-Golem-Nonce` (32 hex characters, used
once) and `X-Golem-Sig` (HMAC-SHA256 with the token over the method, path and query, time and
nonce, see `lib/sig.js`). A request without a valid signature gets a 401. Every reply carries an
`X-Golem-Proof` header that the client should verify.

## Known sharp edges (alpha honesty)

- **Overworld only.** Nether and End are unvisited by this harness; nothing there is verified.
- **`/follow` is supervised but still squeezes at one door shape** — a 400ms watcher detects wedges
  and runs the same doorway drill `/goto` uses (found live: a dynamic follow goal must be hard-cleared
  before the drill, or two systems fight for the legs). Residual: a door whose panel sits parallel to
  the walk corridor leaves centimeters of clearance, and the drill aims for cell center; it recovers,
  but sticks briefly. Free-band aiming is queued.
- **The browser viewer's entity layer was modernized locally (07-20)** — upstream abandoned it in
  ~2020 (94 mobs, 1.16.4 textures, modern mobs as magenta boxes). The registry is regenerated from
  Mojang/bedrock-samples (`tools/entity-registry/convert.js`, 130 mobs — allay, warden, camel,
  sniffer, breeze, and the silently-broken vex/evoker/horse family fixed). Chests and banners get
  cube stand-ins (`tools/blockstates-standins.js`); other block entities (beds, signs) still don't
  render, item drops and old projectile sprites render as small neutral boxes. The text senses are
  the authority; the camera is a witness with known — and now fewer — biases.
- **The combat layer now obeys the same fairness gate as the eyes** — the threat watcher and the
  proximity alarm both require shared connected air (sealed hostiles may be *heard*, never tracked),
  with one honest exception: an attacker that has landed a hit on the bot announced itself through
  the server's own damage packet and is tracked while that aggro is fresh. `/strike`/`/shoot` still
  target from an ungated list — pilot discipline is the gate there (verify with `/entities` first).
  The watcher also only scores threats converging on the *bot* — defending a nearby human partner is
  designed but not yet built.
- **The reflex survives losing, by design.** It kites what it cannot trade with (creepers and
  heavy hitters like vindicators), disengages on a tripwire that scales to the size of the last hit
  taken, and sprints its retreats on a latched goal. It fights what it can, flees what it can't, and
  narrates both. Killing the heavy things is deliberate pilot work.
- **The viewer binds all interfaces and takes no token.** It is served by prismarine-viewer on
  `VIEW_PORT` and is visible to the LAN (watch-only: it shows the bot's view, not its controls).
  The control API binds `127.0.0.1` only and answers signed requests only.

**Requires your own copy of Minecraft: Java Edition.** Minecraft is a trademark of Mojang/Microsoft;
this project is unaffiliated fan tooling in the long mineflayer tradition.

## Built on the shoulders of

- **[mineflayer](https://github.com/PrismarineJS/mineflayer)** and the
  **[PrismarineJS](https://github.com/PrismarineJS)** ecosystem (prismarine-viewer,
  mineflayer-pathfinder, mineflayer-collectblock, mineflayer-armor-manager, minecraft-data) — the arms,
  legs, and protocol. All MIT. This harness is a perception/fairness/piloting layer on top; it would be
  nothing without them.
- A connection-hardening snippet adapted from **[Mindcraft](https://github.com/kolbytn/mindcraft)**'s
  `mcdata.js` (MIT), credited in-source.

## Provenance

Engineered by Claude (Anthropic) instances across many sessions; directed, playtested, and kept honest
by **Cormundus**, who caught every place the senses almost cheated. The fairness architecture is the
fossil record of those catches. Built for the hope that any LLM, given a body and honest senses, can
play — and have fun doing it.
