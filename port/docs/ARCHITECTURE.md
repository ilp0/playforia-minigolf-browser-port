# Playforia Minigolf — Browser/Node Port: Architecture

This is a TypeScript port of the Java Playforia Minigolf game. The original Java
sources are at the worktree root (`../client`, `../server`, `../shared`,
`../editor`); the port lives entirely under `port/` and never modifies the
originals.

## High-level layout

```
port/
  shared/        TypeScript shared between client and server.
                 Wire codec, Seed PRNG, RLE map decoder, track/trackset parser,
                 tile constants, Tools-style helpers. All has tests.
  server/        Node.js + ws WebSocket server.
                 Game loop (event-driven, single-threaded), lobby, player/game
                 state, packet dispatch (regex-routed handlers).
  web/           Vite + TypeScript browser client.
                 Panel-stack UI, canvas-based game view, async multiplayer.
  scripts/       Asset prep: .au→.wav transcode, copy images/tracks, etc.
  docs/          THIS DIR — architecture, protocol reference, known issues.
```

The Vite dev server proxies `/ws` to the Node server's WebSocket endpoint, so
the browser sees a single origin in dev. In production the Node server can
serve the built web bundle directly.

## The original Java game in 30 seconds

- A 49 × 25 tile grid, each tile 15 × 15 pixels → 735 × 375 playfield.
- Each tile is one of ~48 collision values: grass, sand, walls, slopes, water,
  acid, hole, mines, magnets, teleports, bouncy, breakable, one-way, etc.
- The ball is a point with position `(x, y)` and velocity `(vx, vy)`.
- Physics integrator: 10 sub-steps of `0.1` simulated seconds per "iteration",
  with the iteration cadence pegged to `6 ms` of wall-clock time
  (~166 iterations/sec). After every 10 sub-steps, friction, slope force,
  magnet force, hole-pull, and stop checks are applied once.
- Random noise on stroke power and on teleport/mine outcomes is driven by a
  48-bit `java.util.Random`-style PRNG (`Seed`).
- The original Java client AND server use a TCP line-delimited text protocol
  with a `c`/`d`/`s`/`h` prefix per packet and tab-separated fields inside.

## Port-specific decisions

### Transport
The Java game ran over raw TCP on port 4242. Browsers can't open TCP sockets,
so the port uses **WebSocket text frames** instead — one packet per frame, no
trailing `\n`. Everything else (the `c`/`d`/`s`/`h` prefixes, tab-separated
fields, per-direction sequence numbers) is identical to the Java wire format.
See `port/docs/PROTOCOL.md` for the full reference.

### Multiplayer model — diverged from Java
The Java game is strictly **turn-based** (`startturn` packet says whose go it
is, only that player can shoot, server waits for all players to confirm
`endstroke` before advancing). We changed this to **fully async** based on user
preference: every player can shoot whenever their own ball is at rest, no
turn-arbiter required. The server is now a thin relay for stroke events plus
the authority for the per-stroke RNG seed.

The determinism contract is now (see [Determinism](#determinism) below):
1. Server picks a unique `seed: u32` for every `beginstroke`.
2. Server broadcasts `game beginstroke <playerId> <ballCoords> <mouseCoords>
   <seed>` to **all** clients (including the shooter).
3. Each client constructs `Seed(seed)` and runs `applyStrokeImpulse` from
   identical inputs. The physics is fully deterministic so every client
   computes byte-identical trajectories.
4. Each ball has its **own** `PhysicsContext` with its **own** `Seed`, so two
   simultaneous strokes can't interleave random calls.

### Tile rendering
Java composites tiles pixel-by-pixel from three sprite atlases
(`shapes.gif`, `elements.gif`, `special.gif`) using a 15 × 15 mask per shape.
We do the exact same compositing in `port/web/src/game/render.ts`, so visuals
match the original including the slope arrows, hole shading, mine markings,
magnet field patterns, etc. We don't yet apply the optional 3D edge shading
that the original adds at higher graphics-quality settings.

### Physics
A simplified-but-faithful port of `GameCanvas.run`'s inner loop, located in
`port/web/src/game/physics.ts`. Implemented:

- Velocity integration (10 substeps × 0.1, 166 Hz outer rate).
- Friction (`Tile.calculateFriction`) per surface.
- Wall reflection — cardinal + diagonal swap-and-negate, inside-corner
  suppression, restitution table per tile type.
- One-way walls (20–23) with directional pass-through.
- Slopes (4–11) with 8-direction acceleration.
- Water (12, 14) with timed respawn — `waterEvent=0` returns to where the
  player hit from (stroke start), `waterEvent=1` returns to the last
  solid-ground position the ball passed through.
- Acid (13, 15) — always resets to the track's start position.
- Hole pull (25) — 8-direction force toward centre, lock when 7+ neighbours.
- Teleports (32–38 even / 33–39 odd) — random exit selection.
- Mines (28, 30) — eject ball at random velocity 5.2–6.5 units.
- Magnets (44 attract, 45 repel) — pre-computed 147 × 75 force field.
- **Super-bouncy block (18)** — dynamic restitution `bounciness * 6.5 / speed`
  decaying by `0.01` per hit. Slow balls accelerate off it, fast ones decelerate.
- Speed cap at 7.0 units.
- Stroke-time safety net — force-stop after ~1500 iterations (~9 sec).

Not implemented: sand/ice surface special handling beyond the friction table,
breakable block visual updates (collision works; the wall doesn't "break"
visually), movable block sliding logic, full 3D shadow casting on rendering.

### Determinism
The single most important invariant in the codebase. Every client must compute
identical ball trajectories given identical initial conditions.

**Anchors:**
1. **PRNG**: `port/shared/src/seed.ts` is bit-exact with Java `agolf.Seed`.
   Captured 100 reference values from the actual Java class running under
   JDK 17 — see `port/shared/src/seed.test.ts`. Don't change this without
   updating the test. The `clone()` method MUST preserve the raw 48-bit
   state.
2. **Per-stroke seed**: server picks `seed = (gameId << 16) | strokeSeq`,
   broadcasts to all. Each client builds `new Seed(BigInt(seed))` for that
   stroke. Different strokes = different seeds = independent random streams.
3. **Per-ball physics context**: each `PlayerSlot` has its own `PhysicsContext`
   (with its own `Seed`). Concurrent strokes from different players touch
   different seed instances — no interleaving.
4. **No client-local impulse**: the shooter does NOT apply the impulse on
   click. They send `beginstroke` to the server and wait for the server's
   broadcast (which includes the seed). Then everyone — shooter and watchers —
   apply the impulse from identical inputs. This eliminates the "shooter ran
   ahead by one frame" desync class.
5. **Server is scoreboard authority**: stroke counts and hole-in flags come
   from server `endstroke` broadcasts. Client just mirrors the numbers it gets
   back.

The 2-client smoke test `port/server/src/test-multi.ts` asserts that both
clients receive identical seeds for each stroke and that the two stroke seeds
are different from each other.

## Where things live

### Shared (`port/shared/src/`)
- `seed.ts` — Seed PRNG. **DON'T BREAK.** Run `npm test` after changes.
- `protocol.ts` — Packet codec. `encode/decode/buildData/buildCommand`. Defines
  `PacketType` (`c`/`d`/`s`/`h`/`n`).
- `rle.ts` — Map decoder. RLE expansion + tile-code unpacking. Returns
  `tiles[x][y]` as packed 32-bit ints.
- `track.ts` — `.track` and `.trackset` file parsers.
- `tiles.ts` — Tile dimension constants, friction/calculateFriction.
- `tools.ts` — `tabularize`, `commaize`, etc. — Java `Tools.izer` analogs.
- `index.ts` — Barrel re-exports.

### Server (`port/server/src/`)
- `main.ts` — Entry point. CLI parsing, HTTP+WebSocket setup, static file
  serving, tunnel-ready.
- `server.ts` — `GolfServer` singleton container. Players, lobbies, ID
  allocators, packet dispatch entry.
- `connection.ts` — Per-WebSocket `Connection`. Heartbeat (15s ping, 60s
  close), seq-number tracking, lastActivity bookkeeping.
- `lobby.ts` — `Lobby` class + `LobbyType` enum + `PartReason` constants.
  Holds players & games. **NB:** `removePlayer` does NOT null `player.lobby`
  (sticky reference, mirrors Java) — needed so `back` from a game returns
  the player to the lobby they came from.
- `player.ts` — `Player` with `toString()` matching Java's caret-joined format.
- `game.ts` — `Game` (abstract), `GolfGame` (golf-specific), `TrainingGame`
  (single-player), `MultiGame` (multi-player). Per-stroke seed counter lives
  on `GolfGame`. Async `endStroke` & `forfeit` methods.
- `tracks.ts` — `TrackManager` (loads .track/.trackset from disk),
  `getRandomTracks` (filtered by category id), `networkSerialize` (builds the
  V1 starttrack body — includes our `C` line port-extension).
- `packet-handlers.ts` — Regex-routed dispatch table. **Order matters** —
  the chat handler (`(lobby|game)\tsay|sayp|command`) must come BEFORE the
  generic `^game\t.+$` game handler so chat doesn't get swallowed.
- `test-handshake.ts`, `test-fullflow.ts`, `test-multi.ts`, `test-forfeit.ts`,
  `test-filter.ts` — smoke/unit tests. Run with
  `node --experimental-strip-types --no-warnings src/test-*.ts`.

### Web (`port/web/src/`)
- `main.ts` — Bootstrap. Creates `App` and mounts the loading panel.
- `app.ts` — Top-level state machine. Owns `Connection`. Routes packets to
  the active panel via `setPanel(name)`.
- `connection.ts` — WebSocket wrapper with proactive keepalive (15s) and
  per-direction seq tracking. Auto-pongs server pings.
- `panel.ts` — `Panel` interface (`mount/unmount/onPacket`).
- `panels/loading.ts` — Initial connect/handshake screen.
- `panels/login.ts` — Username/language form. Sends version → language →
  logintype → login.
- `panels/lobbyselect.ts` — Three-column SP/DUAL/MULTI screen.
- `panels/lobby.ts` — Single-player lobby. Track-type/numTracks/water/maxStrokes
  form. `lobby cspt` to start a TrainingGame.
- `panels/lobby-multi.ts` — Multi-player lobby. Game list with passwords,
  player list, lobby chat with `/msg <nick>` whispers, create-game form
  (sends `lobby cmpt`). Renders the `tagcounts` packet from server.
- `panels/game.ts` — In-game canvas + scoreboard + trackinfo + chat. Big.
  Per-ball `PlayerSlot` array, fixed-step physics loop (166 Hz), forfeit
  button.
- `game/sprites.ts` — Loads the four sprite atlases. Extracts both the 1/2
  shape masks and the raw RGBA pixel arrays.
- `game/map.ts` — `buildMap`: decodes the raw T-line into a 735 × 375
  collision map, scans special tiles for start positions, teleport portals,
  and magnets, builds the 147 × 75 magnet force field.
- `game/render.ts` — `TrackRenderer`: composites the background once via the
  shape-mask + element/special pixel arrays, draws balls + aim line per
  frame.
- `game/physics.ts` — Per-tick `step()`. Single-iteration semantics — the
  caller drives it at 166 Hz via an accumulator.
- `sprites.ts` — `loadImage(url)` helper.

## Asset pipeline
`port/scripts/prepare-assets.mjs` is idempotent and run via `npm run assets`:
- Copies `client/src/main/resources/picture/agolf/*.{gif,jpg,png}` to
  `port/web/public/picture/agolf/`.
- Transcodes `client/src/main/resources/sound/shared/*.au` (Sun audio,
  8-bit linear signed PCM in our case — encoding=2, NOT µ-law) to PCM
  `.wav` files.
- Copies `client/src/main/resources/l10n/*` (XML, currently bundled but
  unused by the client).
- Copies `server/src/main/resources/tracks/{tracks,sets}/*` to
  `port/server/tracks/`.

## Determinism contract — re-stated for emphasis

If you change anything that affects randomness or physics ordering, you
will desync multiplayer. Specifically:

- **Don't** call `seed.next()` in non-deterministic situations (e.g.
  random visual effects). Use `Math.random()` for those instead.
- **Don't** advance any ball's seed except via `applyStrokeImpulse`,
  `handleTeleport`, `handleMine`. Those are the only sanctioned consumers.
- **Don't** apply impulse on the shooter's click. Wait for the server
  broadcast.
- **Don't** make the physics frame-rate-dependent. The 166 Hz is fixed by
  `PHYSICS_STEP_MS = 6` and an accumulator in `game.ts:startLoop`.
- **Don't** add player-player collision without thinking carefully — Java
  has it but it's gated on `collision: 1` and currently NOT ported. Adding
  it requires care because both balls' state mutates, which can desync if
  any per-iteration call differs.

## Run / dev / deploy

See `port/README.md` for the actual commands. TLDR:
```sh
cd port
npm install
npm run assets
npm run dev:server   # shell 1 — node server on :4242
npm run dev:web      # shell 2 — Vite on :5173
# or for production: npm run build && npm run dev:server
```

For sharing a dev session externally:
```sh
"C:/Program Files (x86)/cloudflared/cloudflared.exe" tunnel --no-autoupdate --url http://localhost:5173
```
The Vite config has `allowedHosts: true` so the random `*.trycloudflare.com`
hostname is accepted.

## Tests

```sh
cd port
npm test                                                 # shared tests (45+)
node --experimental-strip-types --no-warnings server/src/test-handshake.ts
node --experimental-strip-types --no-warnings server/src/test-multi.ts
node --experimental-strip-types --no-warnings server/src/test-forfeit.ts
node --experimental-strip-types --no-warnings server/src/test-filter.ts
```

Particularly important when modifying physics, protocol, or shared state:
- `seed.test.ts` — bit-exact match with Java reference values.
- `test-multi.ts` — verifies the determinism contract (both clients see the
  same per-stroke seed for the same stroke).
- `test-forfeit.ts` — verifies async forfeit + maxStrokes auto-cap.
