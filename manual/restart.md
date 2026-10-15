# Restart

- The bot exits on a disconnect or kick, and whatever started you starts it again. You never start or restart anything.
- `wait_events` keeps its own cursors and notes a restart in its reply. Chat and events from before the restart are gone.
- After a restart: `boot`, then `equip` your tool again, because a restart resets the held item.
- A job that was running ended with the bot. Keep the goal and start the job again.
- Read `chatlog`, `events` and `pulse` from `since: 0` again, and pass `tick` the chat cursor from the new `boot`.
- Chat said while the bot was offline never reached you. After a disconnect, a request may be hanging.
- Waypoints, their notes and the journal survive a restart.
