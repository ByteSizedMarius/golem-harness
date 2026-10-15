# Jobs

## Key rules

- `smelt` is no job and does not wait for the burn: it loads the furnace and returns with `doneInSec`, 10 s per item.
- A furnace smelts only while its output is empty or holds what the input makes.
- Take the output with `furnace(take: "output")` once `doneInSec` has passed.

## Background jobs

- `gather`, `dig_stair`, `dig_tunnel`, `fish` and `build` run as background jobs. The call returns `{job: id}` at once, and the work goes on while you stay free to react.
- Poll with `job(id: <id>)` using the id that call returned. A stale id reads a finished job and misleads you.
- A new job preempts the running one.
- A job's status is running, done, cancelled or error, and its note is the latest progress line. Progress is stored, not sent: read it with `jobs` or `job`.
- A job's end (done, error or cancelled) arrives as an event through `wait_events`, and so do gather and build milestones.
- Rhythm: start the job, glance at `jobs` once to confirm it started, do something else, and let the end event wake you.
- `eat` fails while a job holds the hand. Eat between jobs.
- A running job keeps the legs: the combat reflex's flees, cover moves and chases wait until a mob stands in melee range. Then, or for an emergency (a creeper, critical health, lava, drowning, a bunker), the reflex takes over and the job ends as cancelled, its end event and `takenBy` naming the reflex.
- `stop` ends every job, `job_stop` one.

## Smelting

- `smelt` uses fuel already in the slot and takes the finished output of the same input into your pockets. It refuses a furnace busy with another input and leaves an output of another item in place.
- `furnace` shows a furnace's slots, and with `take` moves one into your pockets.
