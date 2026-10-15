'use strict'

// One tool per bot.js route the pilot may call. Each param is that route's query parameter of the same name.
// structural names the top-level reply fields bot.js generates that keep up to 4000 characters.
// timeoutMs is how long a route that answers once its action ended may take: its walks and mineflayer
// waits added up, at most LONGEST.

const required = (spec) => ({ ...spec, required: true })

// One walk to a nearby target, about 250 blocks at walking speed.
const WALK = 60000
// mineflayer's default wait for a window or slot event.
const EVENT = 20000
// mineflayer's wait for the block update after a placement.
const PLACE = 5000
// mineflayer's wait for a food item to be eaten.
const CONSUME = 2500
// Routes whose walks have no bound in bot.js, or that walk once per item or per cell.
const LONGEST = 600000

const X = { type: 'num', min: -30000000, max: 30000000 }
const Y = { type: 'num', min: -2048, max: 2048 }
const XYZ = { x: required(X), y: required(Y), z: required(X) }
const AT = { x: X, y: Y, z: X }
const NAME = { type: 'str', maxLen: 64 }
const PLAYER = { type: 'str', maxLen: 32 }
const WAYPOINT = { type: 'str', maxLen: 64 }
const POINT = { type: 'str', maxLen: 64, desc: 'x,y,z' }
const COUNT = { type: 'int', min: 1, max: 576 }
const SIZE = { type: 'int', min: 1, max: 64 }
const RADIUS = { type: 'int', min: 1, max: 64 }
const RANGE = { type: 'int', min: 1, max: 32 }
const CURSOR = { type: 'int', min: 0, max: 1000000000 }
const JOB_ID = { type: 'int', min: 1, max: 1000000000 }
const FLAG = { type: 'bool' }
const ON = { type: 'enum', values: ['1', '0'] }
const FACE = { type: 'enum', values: ['N', 'S', 'E', 'W'] }
const THEN = { type: 'enum', values: ['blockat'] }
const TUNNEL_DIR = { type: 'enum', values: ['n', 's', 'e', 'w', 'north', 'south', 'east', 'west'] }
// The reflexes bot.js runs, in the order it checks them.
const REFLEXES = ['lava_watch', 'bunker', 'combat', 'unstuck', 'current_watch', 'narrator', 'trek', 'flee_to_player']

const TOOLS = [
  // Seeing
  { name: 'boot', route: '/boot', description: 'Call first every session: body, armor, held tool and durability, sky, jobs, waypoints, chat cursor.', params: {} },
  { name: 'tick', route: '/tick', description: 'Heartbeat: body essentials, hostiles, jobs, and chat and events after the cursors chat and ev (from the last tick, or boot\'s chat cursor at first). Without them it repeats the newest 50 of each. delta: true drops values unchanged since the last tick, wait_events ticks included.', params: { chat: CURSOR, ev: CURSOR, delta: FLAG }, lists: ['chat.messages', 'events.list', 'jobs'] },
  { name: 'state', route: '/state', description: 'Position, facing, health, food, oxygen, water and buried state, held item, looked-at block.', params: {} },
  { name: 'inventory', route: '/inventory', description: 'Items with counts and slots, worn armor, empty slots. With no empty slot, pickups fail silently.', params: {} },
  { name: 'scene', route: '/scene', description: 'The default glance: facing, time, health and food, what is ahead, sky or underground, the lay of the land, ore in sight, entities and threats, sounds, nearby resources, doors. steps: step heights around you, north up (+1, -2, # wall, v drop over 3, ~ liquid, ? unseen). verbose adds entity groups, the block ahead and the resource list.', params: { verbose: FLAG }, structural: ['summary'] },
  { name: 'gaze', route: '/gaze', description: 'The deliberate look at at=x,y,z or dir: a fan of eye rays narrates what it hits, each with screen region and distance. dist reaches 256, and past 64 names collapse to terrain classes. What it sees draws map.', params: { at: POINT, dir: { type: 'enum', values: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'up', 'down'] }, dist: { type: 'int', min: 4, max: 256 } } },
  { name: 'section', route: '/section', description: 'The cave tool: a vertical cross-section in one direction with narration, showing floor and ceiling profile, water, ore, and whether the passage seals or continues. Only lit cells in sight show, ? is unseen.', params: { dir: { type: 'enum', values: ['n', 's', 'e', 'w'] }, len: { type: 'int', min: 4, max: 32 }, up: { type: 'int', min: 2, max: 16 }, down: { type: 'int', min: 2, max: 24 } }, structural: ['grid'] },
  { name: 'passages', route: '/passages', description: 'Exits from the current air pocket by direction, each with a walk-to sample cell, or a closed pocket. Only lit cells in sight count.', params: { radius: { type: 'int', min: 8, max: 32 } } },
  { name: 'map', route: '/map', description: 'Top-down minimap with fog of war: only terrain you have seen or walked renders, and · is unexplored. Row 0 is north.', params: { radius: { type: 'int', min: 1, max: 256 }, scale: { type: 'int', min: 1, max: 64 }, verbose: FLAG }, structural: ['grid'] },
  { name: 'find', route: '/find', description: 'Nearest blocks matching a fuzzy name, in sight and not in total darkness.', params: { name: required(NAME), count: { type: 'int', min: 1, max: 50 }, radius: RADIUS } },
  { name: 'entities', route: '/entities', description: 'Perceptible entities nearby: shared air within about 34, open sky, or a clear eye ray. Nothing sealed behind rock.', params: { radius: { type: 'int', min: 1, max: 128 } } },
  { name: 'listen', route: '/listen', description: 'Sounds heard recently, through walls, aggregated by category and species. The danger tier announces itself.', params: { window: { type: 'int', min: 5, max: 300 }, verbose: FLAG } },
  { name: 'blockat', route: '/blockat', description: 'Name, full state and sign text of one block in sight: the check after you place or dig.', params: XYZ },
  { name: 'where', route: '/where', description: 'A player in sight: position, distance and bearing. By the nametag only (not sneaking, within 64): bearing and distance rounded to 5. Else the last-seen breadcrumb.', params: { name: required(PLAYER) } },
  { name: 'pulse', route: '/pulse', description: 'Change-gated narrator lines since a cursor.', params: { since: CURSOR }, lists: ['pulses'] },
  { name: 'chatlog', route: '/chatlog', description: 'Chat lines since a cursor, and the next cursor. A stale high cursor silently skips lines.', params: { since: CURSOR }, lists: ['messages'] },
  { name: 'events', route: '/events', description: 'Interrupt events since a cursor: hurt, health_critical, low_food, death, hostile (a mob within 16), nightfall, combat, bunker, job ends, gather and build milestones, player and server.', params: { since: CURSOR }, lists: ['events'] },

  // Moving
  { name: 'goto', route: '/goto', description: 'Walk to x,z (y optional: without it the surface, with it the floor nearest y), a waypoint, a player you can see or last saw, or the nearest block type in sight (stops adjacent). range N stops within N, 0 on the cell. It drops at most 3 and shuts doors it opened. It says why it gave up. A plan ending over 2 (or range) off your y or dropping over 3 needs accept. preview only plans.', params: { ...AT, waypoint: WAYPOINT, player: PLAYER, block: NAME, range: { type: 'int', min: 0, max: 32 }, preview: FLAG, accept: FLAG }, timeoutMs: LONGEST },
  { name: 'follow', route: '/follow', description: 'Keep following a player you see or whose nametag shows, repathing as they move, until unfollow or stop. It waits out fights, jobs, your other calls, reflex moves and lost sight, stays put in a bunker, and runs the doorway drill when wedged.', params: { name: required(PLAYER), range: RANGE } },
  { name: 'unfollow', route: '/unfollow', description: 'Stop following.', params: {} },
  { name: 'stop', route: '/stop', description: 'Cancel the path, clear movement, stop all jobs, end a bunker build.', params: {} },
  { name: 'lookat', route: '/lookat', description: 'Aim the head at a point. Turns instantly.', params: XYZ },
  // A 3 s step into the ladder column, the 15 s climb loop and the step-off.
  { name: 'climb', route: '/climb', description: 'Climb an adjacent ladder to its top.', params: {}, timeoutMs: 20000 },
  // 16 levels, 3 jumps each of 580 ms plus the placement wait.
  { name: 'pillar', route: '/pillar', description: 'Jump-and-place a pillar under yourself, up only. Descend with dig_stair and up -1.', params: { height: { type: 'int', min: 1, max: 16 } }, timeoutMs: 16 * 3 * (580 + PLACE) },
  { name: 'bridging', route: '/bridging', description: 'Arm (1) or disarm (0) scaffold placement for gap crossings, no value reports it. tidy takes the scaffold back.', params: { on: ON } },
  { name: 'tidy', route: '/tidy', description: 'Mine back every scaffold block that pathfinding and bridging placed; dry only counts them.', params: { dry: FLAG }, timeoutMs: LONGEST },

  // Working
  { name: 'mine', route: '/mine', description: 'Find, break and collect the nearest visible matching blocks. Names match partially: log matches oak_log and spruce_log.', params: { name: required(NAME), count: COUNT, radius: RADIUS }, timeoutMs: LONGEST },
  { name: 'collect', route: '/collect', description: 'Walk onto each drop you perceive within radius, nearest first, to pick it up.', params: { radius: RADIUS }, timeoutMs: LONGEST },
  { name: 'gather', route: '/gather', description: 'Job: mine the nearest matching block until the amount is collected. Skips targets more than about 2 below your feet and ones the pathfinder cannot reach, and stops when none is left.', params: { resource: required(NAME), amount: COUNT, radius: RADIUS } },
  { name: 'dig_tunnel', route: '/dig_tunnel', description: 'Job: carve a 1x2 corridor through rock; torch is the torch spacing, 0 for none. It skips air ahead, fills floor gaps from your filler blocks, and stops at lava, water, bedrock or a gap it cannot fill.', params: { dir: TUNNEL_DIR, length: { type: 'int', min: 1, max: 64 }, torch: { type: 'int', min: 0, max: 64 } } },
  { name: 'dig_stair', route: '/dig_stair', description: 'Job: carve 24 steps through rock, up 1 ascends (default), 0 or -1 descends; torch is the spacing in steps, default 4, 0 for none. It fills a missing step from your filler blocks.', params: { dir: TUNNEL_DIR, up: { type: 'enum', values: ['1', '0', '-1'] }, torch: { type: 'int', min: 0, max: 96 } } },
  { name: 'digat', route: '/digat', description: 'Dig one block, a no-op on air. It upgrades the pick tier so drops survive, and grabs a pickaxe for planks and sand too. then=blockat reports the cell afterwards.', params: { ...XYZ, then: THEN }, timeoutMs: LONGEST },
  { name: 'craft', route: '/craft', description: 'Craft at a crafting table within 16, else in the 2x2 grid. It never places one: a 3x3 recipe with no table within 16 is refused. Counts are unreliable for some recipes: craft small batches and check inventory between them.', params: { item: required(NAME), count: COUNT }, timeoutMs: LONGEST },
  // The window opens, then the output, input and fuel moves wait for their slot updates.
  { name: 'smelt', route: '/smelt', description: 'Load input and fuel from your pockets into the nearest furnace and return at once.', params: { item: required(NAME), fuel: NAME, count: COUNT }, timeoutMs: WALK + 4 * EVENT },
  // The window opens, and the take waits for its slot updates.
  { name: 'furnace', route: '/furnace', description: 'The slots of the furnace at x,y,z or the nearest. take moves one into your pockets.', params: { at: POINT, take: { type: 'enum', values: ['output', 'input', 'fuel'] }, count: COUNT }, timeoutMs: WALK + 2 * EVENT },
  // The table window opens, the offers get 6 s and a commit 1 s, and the lapis goes back.
  { name: 'enchant', route: '/enchant', description: 'At the nearest enchanting table: without slot, list the 3 offers (levels, lapis, enchantment); slot 0-2 commits one, paying lapis from your pockets and your levels (xpLevel in state).', params: { item: required(NAME), slot: { type: 'int', min: 0, max: 2 } }, timeoutMs: WALK + EVENT + 7000 + EVENT },
  // The anvil window opens, and the rename waits for the experience update.
  { name: 'rename', route: '/rename', description: 'Rename an item at the nearest anvil.', params: { item: required(NAME), name: required({ type: 'str', maxLen: 35 }) }, timeoutMs: WALK + 2 * EVENT },
  { name: 'place', route: '/place', description: 'Place a block on an open spot beside you.', params: { name: required(NAME) }, timeoutMs: EVENT + PLACE },
  { name: 'placeitem', route: '/placeitem', description: 'Place a block at a coordinate, onto the block below or else against a solid neighbour beside it; a cell with neither is refused. face sets a stair ascend direction. then=blockat reports the cell afterwards.', params: { ...XYZ, name: required(NAME), face: FACE, then: THEN }, timeoutMs: WALK + PLACE },
  { name: 'sign', route: '/sign', description: 'Place a sign and write it, the one moment its text can be set. Up to 4 lines of about 15 characters, split by |. face aims a standing sign, and a cell with only a sideways neighbour gets a wall sign.', params: { ...XYZ, text: { type: 'str', maxLen: 90 }, face: FACE, item: NAME }, timeoutMs: WALK + PLACE },
  { name: 'equip', route: '/equip', description: 'Equip an item to the hand or an armor slot (head, torso, legs, feet).', params: { name: required(NAME), dest: { type: 'enum', values: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] } }, timeoutMs: EVENT },
  // The equips before and after eating, and the 2.1 s hold of a golden apple at full food.
  { name: 'eat', route: '/eat', description: 'Eat the named food, or the most filling one. Fails while a job holds the hand.', params: { food: NAME }, timeoutMs: 2 * EVENT + CONSUME + 2100 },
  { name: 'activate', route: '/activate', description: 'Right-click a block in sight (bed, lever, button, door, gate), walking into reach. Aims at the block centre: name the upper half of a door to aim level, the fence gate block itself to aim down.', params: XYZ, timeoutMs: LONGEST },
  { name: 'use', route: '/use', description: 'Right-click a block with an optional item: till, sow, fill or pour a bucket.', params: { ...XYZ, item: NAME }, timeoutMs: LONGEST },
  { name: 'useon', route: '/useon', description: 'Use an item on a nearby creature: shears on a sheep, a bucket on a cow.', params: { name: required(NAME), item: required(NAME) }, timeoutMs: LONGEST },
  { name: 'toss', route: '/toss', description: 'Drop items, or throw them toward a player with to. Walk away afterwards or you pick them up again.', params: { name: required(NAME), count: COUNT, to: PLAYER }, timeoutMs: EVENT },
  { name: 'fish', route: '/fish', description: 'Job: cast the fishing rod count times, at seen water (x,y,z) or ahead. Each catch arrives as an event.', params: { count: { type: 'int', min: 1, max: 32 }, ...AT } },
  { name: 'chest', route: '/chest', description: 'List the chest at x,y,z or the nearest one within 12.', params: AT, timeoutMs: WALK + EVENT },
  { name: 'withdraw', route: '/withdraw', description: 'Take items from the chest at x,y,z or the nearest one. name matches as a substring.', params: { name: required(NAME), count: COUNT, ...AT }, timeoutMs: WALK + EVENT },
  { name: 'deposit', route: '/deposit', description: 'Put items into the chest at x,y,z or the nearest one. name matches as a substring, so mind what else it matches.', params: { name: required(NAME), count: COUNT, ...AT }, timeoutMs: WALK + EVENT },
  // The walk, the window and one withdraw per item kind.
  { name: 'grave', route: '/grave', description: 'List the gravestone at x,y,z or the nearest in sight. take: all or an item name.', params: { at: POINT, take: NAME }, timeoutMs: LONGEST },

  // Building
  { name: 'build', route: '/build', description: 'Job: a cabin with a cobblestone foundation, oak plank walls to height h, a 2-high doorway centred in the west wall and a roof laid outer ring first. Skips solid cells. Stock enough cobblestone and oak planks first, or cells fail.', params: { template: { type: 'enum', values: ['cabin'] }, x: required(X), z: required(X), w: SIZE, d: SIZE, h: SIZE, base: Y, name: NAME, base_name: NAME } },
  { name: 'outline', route: '/outline', description: 'Lay a rectangular foundation outline. Runs at once.', params: { x: required(X), z: required(X), w: SIZE, d: SIZE, name: NAME, y: Y }, timeoutMs: LONGEST },
  { name: 'walls', route: '/walls', description: 'Raise perimeter walls with a doorway. Runs at once.', params: { x: required(X), z: required(X), w: SIZE, d: SIZE, h: SIZE, base: Y, name: NAME, base_name: NAME, door: { type: 'enum', values: ['west', 'east', 'north', 'south'] } }, timeoutMs: LONGEST },
  { name: 'roof', route: '/roof', description: 'Fill a solid slab at height y, outer ring first. Runs at once.', params: { x: required(X), y: required(Y), z: required(X), w: SIZE, d: SIZE, name: NAME }, timeoutMs: LONGEST },

  // Fighting
  // Five swings of about 2.3 s each, with room for short approaches.
  { name: 'strike', route: '/strike', description: 'Up to max melee swings at a creature, approaching it, with item (iron_sword by default). Refused when that item is not in your pockets: name the weapon you carry.', params: { name: required(NAME), item: NAME, max: { type: 'int', min: 1, max: 5 } }, timeoutMs: 20000 },
  // 8 shots, each a 1.55 s draw and a 2 s watch for the kill, and the bow's equip.
  { name: 'shoot', route: '/shoot', description: 'Up to max full-charge bow shots at a creature in line of sight within 25, without approaching. Ends on a kill, the target gone, no arrows, or two arrows at unchanged range (a wall).', params: { name: required(NAME), max: { type: 'int', min: 1, max: 8 } }, timeoutMs: 8 * (1550 + 2000) + EVENT },
  { name: 'guard', route: '/guard', description: 'Raise (1) or lower (0) the off-hand shield, or on 1.7.10 a block with the sword in hand (raising needs a sword). The guard stays up across fights until on is 0.', params: { on: ON } },
  { name: 'brace', route: '/brace', description: 'Hold the legs against reflexes for sec seconds. Only survival overrides it: creeper fuse, critical health, drowning. stop releases it early.', params: { sec: { type: 'int', min: 1, max: 30 } } },
  { name: 'stance', route: '/stance', description: 'Get or set the combat posture: guard (default, melee closers, bow standoffs), skirmish (bow first, flee only the blast radius), vanguard (chase and melee, room clearing), sentinel (fight only what hits you).', params: { set: { type: 'enum', values: ['guard', 'skirmish', 'vanguard', 'sentinel'] } } },
  { name: 'reflexes', route: '/reflexes', description: 'List the reflexes, or switch the named one on (1) or off (0).', params: { name: { type: 'enum', values: REFLEXES }, on: ON } },
  // The 3 s combat wait, two centrings of 1.6 s, 3 digs of 1.5 s with a 1 s drop each, 6 pillar levels of
  // 3 jump-and-place tries, 16 placements, and an equip before each dig, level and placement.
  { name: 'bunker', route: '/bunker', description: 'Last-resort shelter from pocket blocks, dirt and cobblestone first. down digs 3 into natural ground and caps the shaft over your head. up pillars height blocks (default 3) and builds a shell on top. auto (the default) picks the one that holds against the mobs near, down when none is near. Refused where it would not hold or finish in time, naming why. No tool walks or digs while it builds. It answers once the shelter stands, and the reply names the gaps and the cells to dig to leave.', params: { mode: { type: 'enum', values: ['auto', 'up', 'down'] }, height: { type: 'int', min: 2, max: 6 } }, timeoutMs: Math.min(LONGEST, 3000 + 2 * 1600 + 3 * (1500 + 1000) + 6 * 3 * (580 + PLACE) + 16 * PLACE + (3 + 6 + 16) * EVENT) },

  // Social
  { name: 'chat', route: '/chat', description: 'Say one message of up to 400 characters. A chat line holds 100 characters, 256 on a 1.7.10 server. A longer message splits at spaces into lines, one every 2.5 s. Commands: only /me, /tell, /msg, /w. The command and target repeat on each line and count against its length. The queue holds 20 lines and refuses a message that does not fit, whole. Control characters and the section sign are stripped.', params: { msg: required({ type: 'str', maxLen: 400 }) } },
  { name: 'chat_lines', route: '/chat', description: 'Say up to 5 messages separated by |, each split and paced like chat. The whole call is refused when its lines do not fit the 20-line queue.', params: { lines: required({ type: 'str', maxLen: 2004 }) } },
  { name: 'gesture', route: '/gesture', description: 'Nod, shake, wave, or point at=x,y,z: presence without words.', params: { name: required({ type: 'enum', values: ['nod', 'shake', 'wave', 'point'] }), at: POINT } },

  // Memory and jobs
  { name: 'waypoint', route: '/waypoint', description: 'Store x,y,z under a name, or without coordinates stamp where you stand, linked to the waypoint you last stood at. note is one line of up to 200 characters, kind is place or resource, linkto asserts an edge you truly walked, rm deletes.', params: { name: required(WAYPOINT), ...AT, note: { type: 'str', maxLen: 200 }, kind: { type: 'enum', values: ['place', 'resource'] }, linkto: WAYPOINT, rm: FLAG } },
  { name: 'waypoints', route: '/waypoints', description: 'Your map: every named place with its kind and note, and the edges you walked.', params: { verbose: FLAG }, structural: ['graph'] },
  { name: 'journal', route: '/journal', description: 'The last n lines of the journal the bot writes: waypoint changes and goto arrivals at a waypoint.', params: { n: { type: 'int', min: 1, max: 50 } } },
  { name: 'jobs', route: '/jobs', description: 'List jobs with id, name, status (running, done, cancelled, error) and the latest progress note.', params: {}, lists: ['jobs'] },
  { name: 'job', route: '/job', description: 'Status and result of one job. Use the id its call returned: a stale id reads a finished job.', params: { id: required(JOB_ID), verbose: FLAG } },
  { name: 'job_stop', route: '/job_stop', description: 'Cancel one job.', params: { id: required(JOB_ID) } }
]

module.exports = { TOOLS }
