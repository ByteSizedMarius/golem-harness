# Golem: an embodiment harness for language models

**Built by playing.**

*A Minecraft body for an LLM, with honest senses, a conscience about cheating, and a cockpit built
for a mind that thinks in sentences.*

A golem is a body of clay animated by language, and the word written on its forehead to bring it
to life is *emet*: truth. Golem is a body that runs on words, and its fairness rules are the
inscription. (In Minecraft the golem also protects the village. We aspire.)

Golem lets a language model (in our case, Claude) play Minecraft as a player: look around, get
lost, find sand, drown embarrassingly, build a porch and remember where home is. It is a
[mineflayer](https://github.com/PrismarineJS/mineflayer) bot with two layers on top:

- A control API on `127.0.0.1:3000` that turns signed GET requests into in-world actions (move,
  mine, craft, place, look, remember) and answers in compact JSON.
- An MCP server, `mcp/server.js`, that hands those actions to the model as tools.

The model learns to drive from `DRIVING.md`, which sits in its context every session, and from the
topics under `manual/` (water, combat, building and more), which it fetches with the `manual` tool.
This README is for the person running the bot.

> **Alpha.** Only the Overworld has been played. The Nether and the End are untested.

## This fork

This is a fork of [cormundus/golem-harness](https://github.com/cormundus/golem-harness). It teaches
Golem to play Minecraft 1.7.10, the best version ever made. That it is also the version I grew up
with is a complete coincidence.

It adds over upstream:

- 1.7.10 support through ViaProxy, with a mode that gives the body the old combat and senses.
- Request signing on the control API, which upstream served unauthenticated.
- The MCP server.
- Stricter fairness rules: sight needs light, a block's current state shows only while it is in
  sight, and walks plan only through cells the bot knows.
- A bunker the body digs or pillars when a fight goes badly.

## A player, not a god

A mineflayer bot can trivially cheat. The API will report every diamond in a 64-block sphere
through solid rock, path through terrain no player could see, and list mobs behind walls. Golem
holds the model to what a human player could perceive and do. That rarely makes the bot stronger,
but playing fairly is what makes it playing at all.

- No x-ray. A block shows only in line of sight from the bot's eyes, within the range its light
  allows.
- No sensing through walls. A mob, player or drop counts only when it is lit enough to see from
  where the bot stands, and either sits on a clear line of sight or, within about 20 blocks, is
  joined to the bot by air the bot has seen or by open surface (a drop needs the line of sight).
  Sealed behind rock, it is absent from every reply, and `strike`, `shoot` and `useon` pick their
  targets the same way.
- Only what a player could know. Every reply, event, error and tool description passes the same
  test. A block's current state shows only while it is in sight or touched by the body, otherwise a
  reply gives what the bot last saw there, or nothing. Chests, furnaces, crafting tables, anvils
  and enchanting tables are used only where the bot saw one.
- Considerate movement. The walker never breaks blocks to travel, except leaves and logs while
  `gather` collects wood. Scaffold blocks it places are tracked and mined back with `tidy`. Doors
  and gates it opens are closed behind it. A `goto` plans before it walks and refuses a plan that
  ends more than 2 off the asked height or drops more than 3, unless told `accept=1`. `preview=1`
  returns the plan without taking a step.
- No teleporting. The body eats on its own only right after a fight, at food 14 or lower, and wears
  the best armor it carries.
- Silence means "didn't look", never "all clear". Unknown space reads as unknown.

The anti-cheat checks and the perception system are the same code. The ray-march that once only
verified "could a player see that block?" became the eye itself.

## Supported servers

| Server | Settings |
|---|---|
| Minecraft 1.21.11 | none, the bot speaks 1.21.11 by default |
| Minecraft 1.7.10 (Forge) behind ViaProxy | `GOLEM_MC_1710=1` and `MC_VERSION=1.21.11` |

The bot logs in as an offline-mode player, so a dedicated server needs `online-mode=false`.

### 1.21.11

Hearing resolves the server's numeric sound IDs against `sounds-1.21.11.json`, which is exact only
for 1.21.11. Other versions mineflayer supports connect with `MC_VERSION=auto` or an explicit
version, and there the bot may misname what it hears. A world newer than mineflayer supports fails
at login whatever `MC_VERSION` says.

### 1.7.10 behind ViaProxy

The bot still speaks 1.21.11, to the proxy, and ViaProxy translates down to the server.
`GOLEM_MC_1710=1` switches the body to 1.7.10 rules: no attack cooldown, a sword block instead of a
shield, no off-hand, and the old hitboxes, sounds and underwater light. Every 1.7.10 value lives in
`lib/bot/legacy-1710.js`.

- Set `MC_VERSION=1.21.11` explicitly. `auto` would take the version the proxy reports.
  `start.sh` falls back to `auto`, so put the line in `.env`.
- Run ViaProxy 3.4.12 with `--compression-threshold -1`. With compression on, about one login in 50
  stalls until the server's 30 s timeout.
- A Forge server also needs its FML handshake answered. That takes a ViaProxy plugin that is not
  part of this repo.
- `GOLEM_SERVER_OVERRIDES` names a JSON file of recipe overrides and block renames, for a server
  whose recipes or blocks differ from what the bot knows. A block renamed to `gravestone` turns on
  the `grave` tool. `.env.example` shows the format.
- `GOLEM_CHAT_MAX` (100 to 256) sets the longest chat line the bot sends, by default 100 here and
  256 on 1.21.11. Raising it only helps when the proxy lets longer lines through.

## Install

Node 22 or newer.

```
npm install
```

The install applies `patches/` with patch-package: fixes to mineflayer-pathfinder's door, wall and
farmland handling, to how mineflayer and minecraft-protocol decode velocity from 1.21.9 on, and to
how prismarine-chunk reads and writes chunk light.

## Running it

### Token

Any string of at least 32 characters. The bot and the MCP server need the same one, and both refuse
to start without it.

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Start the bot

`bot.js` reads its settings from its process environment only.

```
GOLEM_TOKEN=<token> MC_HOST=<host> MC_PORT=<port> node bot.js
```

`npm start` runs `node bot.js`.

| Variable | Default | |
|---|---|---|
| `GOLEM_TOKEN` | none | required, the signing key |
| `MC_HOST` | `localhost` | |
| `MC_PORT` | `25565` | a world opened to LAN prints its port in chat |
| `MC_VERSION` | `1.21.11` | `auto` takes the server's version |
| `MC_USER` | `Claude` | the bot's in-game name |
| `CTRL_PORT` | `3000` | control API port, always on 127.0.0.1 |
| `GOLEM_MC_1710` | off | `1` for 1.7.10 behind ViaProxy |

`.env.example` describes the rest: `MC_OWNER` (the default player for `where`),
`GOLEM_SERVER_OVERRIDES`, `GOLEM_CHAT_MAX`, and the MCP server's `GOLEM_PAPERCUTS`,
`GOLEM_LESSONS`, `GOLEM_MEMORY`, `GOLEM_TODO` and `GOLEM_TOPICS` (the gated manual topics to
serve).

The control API is the only port the bot opens. The bot exits when its connection to the server
ends.

`bash start.sh <port> [name]` runs the bot under a watchdog that starts it again 3 s after it
exits. It reads `.env` from the repo root (copy `.env.example`), takes the server port as its first
argument and the in-game name as its second, and writes `bot.log`, cleared at the first launch.
Unlike `node bot.js`, it falls back to `MC_VERSION=auto`. `touch stop.flag` in the repo root ends
the watchdog the next time the bot exits.

The bot keeps its memory in its working directory: `seen.json`, `waypoints.json` and `journal.md`.
`seen.json` holds one map per world. The waypoints and the journal carry over to every world the bot
joins from the same directory.

### Connect a pilot

Register the MCP server with your client under the name `golem`, with the token in its environment
and the bot's `CTRL_PORT` as its argument:

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

The server speaks MCP over stdio and takes a port from 1024 to 65535. `DRIVING.md` assumes the name
`golem`, under which Claude Code shows the tools as `mcp__golem__<tool>`. Give the model
`DRIVING.md` and let it call `boot`.

An optional second argument names a wake log. The server appends a line for every `wait_events`
call, delivery and tool call, and after a restart it resumes chat and events where the log left
off.

The pilot sees 76 tools: 72 that each call one bot route (`goto` calls `/goto`), plus

- `wait_events`: new chat, whispers and bot events.
- `note`: a note of kind `memory`, `lesson` or `papercut`. Memory notes, at most 20, are kept in
  the JSON file `GOLEM_MEMORY` names and shown at `boot`. Lessons (what a future player should
  know) and papercuts (what made playing harder) are for the owner, appended to the files
  `GOLEM_LESSONS` and `GOLEM_PAPERCUTS` name.
- `todo`: the pilot's open requests and promises, each at priority high, normal or low, kept in
  the JSON file `GOLEM_TODO` names and shown at `boot`.
- `manual`: one topic of `manual/`, whole. A gated topic only while `GOLEM_TOPICS` names it.

Each of the four files must be an absolute path. Without one, its tool or note kind answers that it
is off.

The pilot cannot start, kill or restart the bot process, and it has no camera. Chat and whispers that
`wait_events` returns are written by players and are untrusted, and so is the text of its `server`
events.

Any MCP client works (Claude Code, Codex CLI). Piloting is chatty, hundreds of small calls per
session, and on metered API billing that is real money.

### Your own client

A client of your own signs each request with three headers:

- `X-Golem-Time`: Unix milliseconds, within 30 seconds of the bot's clock and not earlier than the
  bot's start.
- `X-Golem-Nonce`: 32 lowercase hex characters, used once.
- `X-Golem-Sig`: HMAC-SHA256 in hex, keyed with the token, over the method, the path with its
  query, the time and the nonce, joined by newlines.

The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. A request that fails any check
gets a 401. Every reply carries an `X-Golem-Proof` header, an HMAC over the nonce and the SHA-256 of
the body, which the client should verify. `lib/sig.js` has both computations.

## How the model sees

A language model's native sense is text, so the bot is a describer: it holds the 3D world and
hands the pilot sentences of measured fact.

`scene` is the situational summary. Body state comes first (in water, submerged, pushed by a
current), then facing and vitals, what is ahead, and eight compass directions scanned for walls
and floor profiles. Its grammar tells a step ("floor ~3 down") from the mouth of a chamber ("ledge
~3 down then OPENS"), and past its measuring range it says "floor out of sight" rather than guess.
Ore in sight, entities grouped and counted, threats, sky or underground, and doors and gates
follow, each line only when it has content. Beside the summary, `steps` is a 5x5 north-up grid of
the step from the feet to each neighbouring cell (`+1`, `-2`, `#` wall, `v` drop, `~` liquid, `?`
unseen).

`gaze` is the retina. The bot's head turns, then a 15x7 fan of rays (about 100 by 60 degrees)
marches out from the eye until something opaque stops each ray. Hits carry block identity,
distance and screen position, and misses become open space.

`section` cuts a vertical profile through a cave, and `map` draws the top-down view.

Everywhere, a bare name means seen: in lit sight now or when the bot looked earlier. `?` or silence
means unseen. A dark cave around the corner stays unknown even though the raw API knows it. Full
light (level 7 and up) lets sight reach as far as the line of sight does. In the dark it shrinks
from 24 blocks at level 6 to 2 at level 0. A player's nametag shows through walls within 64 blocks
unless they sneak or are invisible, as in the game.

There is no camera. The model works from text.

## How the model remembers

`seen.json` records what the bot looked at: every lit cell a gaze ray crosses or the walk passes,
plus the top block it last saw in each column. `map` draws a column live while its top is in sight
or under open sky, otherwise as last seen. A change out of sight stays off the map until the bot
looks again.

`waypoints.json` is a graph of named places. Each has a kind, `place` for a lasting landmark or
`resource` for a claim that mining it out falsifies, and a one-line note. Edges record walks: a
`goto` arrival at a waypoint links it to the waypoint the bot last stood at, and that pointer resets
on every restart. The pilot can assert an edge it walked with `linkto`. No routes are stored, and
the pathfinder solves each walk fresh.

`journal.md` is the bot's append-only trip log: arrivals at waypoints, and waypoints set, removed
or linked.

That is the bot's memory. The pilot's is a separate problem, since the next model instance wakes
knowing nothing.

## How the model survives being slow

A pilot's reaction time is seconds to minutes, and the body covers the gap. The reflexes live in
the body, so a pilot with ten-second round trips gets the same protection as a fast one.

- Events wake the pilot from `wait_events` for what matters: drowning with an oxygen count, damage,
  a tool below 12% durability, dangerous sounds, low food. Watched threats and ambient world changes
  wake nothing and wait for the next call.
- Damage from an unknown source freezes the body, so the pilot can look before anything moves. A
  buried body steps aside or digs out, and a submerged one swims up.
- Reflexes run every 300 ms: lava watch, bunker, combat, unstuck, current watch, narrator, trek and
  flee to player. `reflexes` lists them and switches each on or off.
- Long actions run as background jobs the pilot polls. One runs at a time, and a new job stops the
  running one.

## How the model fights

Combat is where pilot latency would be fatal, so the body fights on its own and the pilot steers.

- A threat watcher scores only hostiles. Neutral mobs that turn hostile when provoked (endermen,
  piglins, wolves, bees and others) are never attacked first. A hostile counts as a threat once it
  keeps closing faster than 0.6 blocks a second (a chasing zombie closes at about 2.3). Unproven
  mobs count within 24 blocks and only while perceived.
- Damage attribution names the attacker of a hit from the server's damage events. An attacker
  that hit the body stays a threat for 45 s, out to 48 blocks, seen or not.
- Players are never weapons targets. Creepers and heavy hitters (vindicator, ravager, piglin brute,
  wither skeleton) are never met in melee. The reflex shoots them from the stance's bow range or
  runs.
- Low health disengages, at 8 HP (5 HP against a hostile in the vanguard stance) or at 2.5
  times the last fresh hit. Three or more hostiles within
  16 blocks start a fighting withdrawal, unless a partner stands within 10 and the bot has 12 HP or
  more.
- Below 8 HP within 15 s of a mob's hit, the body builds a bunker, dug down or pillared up,
  whichever holds against the mobs near. When none holds, it flees.

The swing itself depends on the server:

| | 1.21.11 | 1.7.10 (`GOLEM_MC_1710=1`) |
|---|---|---|
| Melee | fully charged sword swings | no cooldown, a hit at most every 550 ms and timed to the mob's hurt window, a sprint hit to open |
| Guard between swings | shield in the off-hand | sword block |
| Off-hand | yes | none |

On both, the guard rises only while the body stands still, and a walk or a swing lowers it.

The pilot picks a stance (`guard`, the default, `skirmish`, `vanguard` or `sentinel`) and fights on
its own clock with `shoot`, `strike` (also the livestock verb), `guard`, `hold` (a doorway or perch)
and `brace` (legs held against reflexes for a few seconds).

## Control is two gears

In the first gear the pilot states an intent (`goto` a waypoint, `gather` 18 birch logs) and the
bot drives the details: staged travel with stall detection, arrival checks, and a reason when it
gives up (`walled` means reachable only by digging). In the second, after any hiccup, the pilot
takes over with fine perception (`gaze`, `section`) and single actions (`digat`, `placeitem`,
`pillar`). A human co-pilot in the world is the final backstop, and half the fun.

## Tests

```
npm test
```

runs the tests in `test/` with Node's test runner. It needs Node 22 and `npm install`, and no
Minecraft server.

## Skin

The bot's skin and cape are in `skin/`, 64x32 in the 1.7.10 layout. The bot cannot push a skin to
an offline-mode server. Players see them through the client-side mod CustomSkinLoader, which loads
`LocalSkin/skins/<player name>.png` and `LocalSkin/capes/<player name>.png` from the client's
CustomSkinLoader folder. `skin/make_skin.py` and `skin/make_cape.py` rebuild them (Python with
Pillow).

## Known sharp edges

- Only the Overworld has been played.
- The threat watcher scores threats to the bot only. It does not defend a nearby partner.
- A mob a floor above or below, with no eye-line, is narrated as watched and never fought.
- The reflex kites what it cannot trade with. Killing a heavy hitter is the pilot's work.
- The waypoints and the journal do not switch with the world. Run each world from its own
  directory or clear them.

**Requires your own copy of Minecraft: Java Edition.** Minecraft is a trademark of Mojang/Microsoft;
this project is unaffiliated fan tooling in the long mineflayer tradition.

## Built on the shoulders of

- **[mineflayer](https://github.com/PrismarineJS/mineflayer)** and the
  **[PrismarineJS](https://github.com/PrismarineJS)** ecosystem (mineflayer-pathfinder,
  mineflayer-collectblock, mineflayer-armor-manager, minecraft-data): the arms, legs, and protocol.
  All MIT. This harness is a perception/fairness/piloting layer on top; it would be
  nothing without them.
- A connection-hardening snippet adapted from **[Mindcraft](https://github.com/kolbytn/mindcraft)**'s
  `mcdata.js` (MIT), credited in-source.

## Provenance

Engineered by Claude (Anthropic) instances across many sessions; directed, playtested, and kept honest
by **Cormundus**, who caught every place the senses almost cheated. The fairness architecture is the
fossil record of those catches. Built for the hope that any LLM, given a body and honest senses, can
play — and have fun doing it.
