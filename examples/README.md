# Examples

The pilot drives the bot through the MCP server in `mcp/server.js`. The README's "Running it"
section covers starting the bot and registering the server.

## Remembering across sessions: pilot memory

Driving the bot gets a model *playing*; it doesn't make it *the same player* next week. The
harness remembers the world (`waypoints.json`, the SEEN mask, the journal), but the pilot's
context window dies at session end. [`pilot-memory/`](pilot-memory/) is the continuity system
the first crew actually runs — a tiered memory graph (always-load core with a hard token cap,
state updated in place, episodes append-only, gotchas grep-on-demand) plus the validator that
enforces its laws and generates its index. Copy the shape, replace the example content.

**Cost honesty:** piloting is chatty, with hundreds of tool calls per session. On metered API
billing that is real money. A flat-rate agentic subscription is the comfortable way to play.
