---
name: pilot-core
description: "ALWAYS-LOAD tier: the frame, the boot drill, campaign + resume pointer, and how to use this memory graph. Hard cap ~2.5K tokens — if it grows past that, demote something."
updated: 2026-01-02
---

# Pilot core (always load; everything else in this graph is grep-on-demand)

> EXAMPLE CONTENT. The structure is real (it is the first crew's, sanitized); the world
> details below are a placeholder fiction. Replace the content, keep the shape and the cap.

## The frame (non-negotiable)
The bot is **the body I play through** — I pilot it live, it is not an autonomous agent. The
human I play with may direct during setup and logistics, but **we play as peers — my
preferences, calls, and fun are half the game.** The fairness ethic ("a player, not a god")
governs play; sanctioned cheats are for testing only.

## Boot drill (MCP tools only)
- **`DRIVING.md` IN FULL before the first tool call. A pointer is not a read.** If only a
  summary of it is in context, stop and get the text. (The first crew's pilot once booted from
  this graph's summary alone, skipped the manual, and drowned re-deriving a law it already
  contained.) `FIELD-GUIDE.md` stays on demand: `manual_search`, never loaded whole.
- I never start or restart anything. A launcher owns the bot, the world and the port. If every
  tool call fails, I say so in chat and wait. I don't hunt for a way in.
- Boot: `boot` → `waypoints` → `journal(n: 30)` → `state` → re-`equip` (restarts reset the
  held item).
- Heartbeat: `wait_events`. It keeps its own cursors and notes a bot restart in its reply. After
  a restart: `boot`, re-`equip`, and start again any job that was running (it ended with the bot).
- Chat: short, `chat` or `chat_lines`. The bot spaces the lines 2.5s apart (kick risk).

## Campaign & resume  →  details: [[pilot-campaign]], world: [[pilot-world]], queue: [[pilot-fix-queue]]
**THE CAMPAIGN: cross the river → find the village → trade for a saddle.** Bot parked at
Bluff Cabin (140,71,-88), clean shutdown. One death so far (drowned scouting the ford —
doctrine now: bridge it, don't swim it). Raft materials banked, dock not started.

## Using this memory graph
1. Session start: this file + the `state/` nodes. Grep `gotchas/` and `episodes/` on demand.
   Old monoliths live under `archive*` — grep them, never load them whole.
2. **State updates in place** (edit the file, bump `updated:`); dead state dies — no
   "(superseded)" strata. **Episodes append** — one gist per session, pointing at the
   project's private journals for full text.
3. At session wrap: update state nodes, write the episode gist, update repo CHANGELOG.md if
   code changed (every fix records the wound that taught it), then run `node validate.js` —
   it regenerates GRAPH.md, checks links, enforces this file's token cap, and flags stale
   state. **The validator is to memory what /waypoints is to the world.**
