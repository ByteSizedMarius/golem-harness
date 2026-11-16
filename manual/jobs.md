# Jobs

## Key rules

- `smelt` is no job and does not wait for the burn: it loads the furnace and returns with `doneInSec`, 10 s per item the fuel covers.
- A furnace smelts only while its output is empty or holds what the input makes.
- Take the output with `furnace(take: "output")` once `doneInSec` has passed.

## Background jobs

- `gather`, `dig_stair`, `dig_tunnel`, `fish`, `sow` and `build` run as background jobs. The call returns `{job: id}` at once, and the work goes on while you stay free to react.
- Poll with `job(id: <id>)` using the id that call returned. A stale id reads a finished job and misleads you.
- A new job preempts the running one.
- A job's status is running, done, cancelled or error, and its note is the latest progress line. Progress is stored, not sent: read it with `jobs` or `job`.
- A job's end (done, error or cancelled) arrives as an event through `wait_events`, and so do gather and build milestones.
- Rhythm: start the job, glance at `jobs` once to confirm it started, do something else, and let the end event wake you.
- `sow` plants a whole bed from its corner and size and clicks each plot once. Plots in `missed` or `refused` need another `sow` or a `use`. For plots in `unreached`, walk to a path beside them at their level, then `sow` again.
- No walk comes down hard on farmland you have seen (a drop, a jump across a gap, a jump up out of water), since that tramples it. Walking across a field on its own level and stepping up onto it from dry ground are fine. A `goto` that finds only such a way answers `farmland` with the farmland block it would come down on first. Pick another point. When it is the only way off the spot you stand on, `goto` a point just past that block with `trample` and walk on from there without it, since `trample` lets the whole walk come down on farmland. Never use it to cut across a field. A flee from danger ignores the rule.
- `eat` fails while a job holds the hand. Eat between jobs.
- At food 14 or less `goto` eats on the way, but not while a job holds the hand.
- A running job keeps the legs: the combat reflex's flees, cover moves and chases wait until a mob stands in melee range. Then, or for an emergency (a creeper, critical health, lava, drowning, a bunker), the reflex takes over and the job ends as cancelled, its end event and `takenBy` naming the reflex.
- `stop` ends every job, `job_stop` one.

## Smelting

- `smelt` uses fuel already in the slot and takes the finished output of the same input into your pockets. Without `item` it refuses a slot holding another fuel. It refuses a furnace busy with another input and leaves an output of another item in place.
- If the furnace has not started cooking within 3 s with its output empty, `smelt` takes the input back, leaves the fuel in the slot and fails with `no-recipe`.
- `furnace` shows a furnace's slots, and with `take` moves one into your pockets.
