# Playforia Minigolf — Browser/Node Port

A TypeScript port of the Java Playforia Minigolf client and server.
The original Java sources live in `../client`, `../server`, `../shared`, and `../editor`.

> **Looking for the deep dive?** See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
> for the technical overview, [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the
> wire format, and [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) for the
> active bug list and roadmap.

This port replaces:

- The Java applet client → a browser app (HTML / Canvas).
- The Netty TCP server → a Node.js + WebSocket server.

The wire protocol (line-delimited text, `c/d/s/h` prefixes, tab-separated fields, per-direction sequence numbers) is identical to the Java protocol — the only change is that one packet now equals one WebSocket text frame instead of one `\n`-terminated TCP line.

## Layout

```
port/
  shared/    Shared TypeScript: Seed PRNG, packet codec,
             RLE map decoder, track parser, tile constants
  server/    Node.js + ws server (port 4242 by default)
  web/       Vite + TypeScript browser client
  scripts/   Asset preparation (.au → .wav, copy images, copy tracks)
```

## Prerequisites

- Node.js 22+ (this port was developed against Node 25; uses
  `--experimental-strip-types` to run TS sources directly).
- `npm` 10+.

## First-time setup

From the worktree root (one level above this `port/` directory):

```sh
cd port
npm install
npm run assets        # transcodes .au sounds, copies images, l10n, tracks
npm run build         # builds shared + web (server runs from source)
```

`npm run assets` is idempotent — it deletes and recreates each
destination subtree. It must be run at least once before starting the
client because Vite serves images and sounds from `web/public/`.

## Running

In two separate shells:

```sh
# shell 1 — backend
cd port
npm run dev:server

# shell 2 — frontend
cd port
npm run dev:web
```

Open <http://localhost:5173>. The Vite dev server proxies `/ws` to
`ws://localhost:4242/ws`, so both panels of the app — login and game —
connect through the same origin.

### Production (single-process)

```sh
cd port
npm run build
npm run dev:server   # serves the built web bundle on http://localhost:4242
```

### Operator knobs

Set on the command line or via env vars when launching the server:

| Env var         | CLI flag           | Effect                                                         |
| --------------- | ------------------ | -------------------------------------------------------------- |
| `CHAT_ENABLED`  | `--chat-disabled`  | Set `CHAT_ENABLED=0` (or pass `--chat-disabled`) to drop all lobby/game chat server-side. The sender is told once via a system whisper; gameplay traffic is unaffected. Useful for hosting without taking on chat-moderation duty. |

## Tests

```sh
cd port
npm test                                                                    # shared (Seed, RLE, codec, tools, tiles, tracks)
node --experimental-strip-types --no-warnings server/src/test-handshake.ts  # connect + login handshake
node --experimental-strip-types --no-warnings server/src/test-fullflow.ts   # single-player end-to-end
node --experimental-strip-types --no-warnings server/src/test-multi.ts      # 2-client async-MP determinism + cursor relay
node --experimental-strip-types --no-warnings server/src/test-forfeit.ts    # async forfeit + maxStrokes auto-cap
node --experimental-strip-types --no-warnings server/src/test-filter.ts     # track-category filtering
node --experimental-strip-types --no-warnings server/src/test-daily.ts      # daily-challenge room flow + re-entry
```

Each smoke test boots its own self-contained server on a private port
and tears it down at the end, so they can run in any order or in
parallel.

The `Seed` PRNG test uses 100 reference values captured from the
actual Java `agolf.Seed` class running under JDK 17 — every shot's
randomness is bit-for-bit identical to the original game.

`test-multi.ts` is the load-bearing one for the **determinism
contract**: it asserts that both clients receive identical per-stroke
seeds for the same stroke, that two strokes get different seeds, and
that the live cursor relay is wired through the right handler order.

## What's implemented

**Multiplayer & lobbies**
- Single-player training games (track-type filter, 1/3/5/9/18 tracks,
  water-event mode, max-strokes cap).
- Multi-player lobby with game list, password-protected games, in-lobby
  chat with `/msg <nick>` whispers, create-game form.
- Login form lets the user pick their own nickname; the chosen name
  flows through to scoreboards and daily-mode ghost labels (server
  sanitises and falls back to a `~anonym-` placeholder if absent).
- **Async multi-player**: every player can shoot whenever their own
  ball is at rest — no turn arbiter. Server picks a unique 32-bit seed
  per stroke and broadcasts it to all clients (incl. shooter) so every
  client computes byte-identical trajectories.
- **Daily challenge room**: singleton `DailyGame` with a deterministic
  per-day track. Other players in the room render as translucent
  ghosts with name labels. Daily result is saved to localStorage; the
  end overlay offers a copy-to-clipboard share text and a shareable
  replay link (the run is reconstructed from the recorded
  `(ballCoords, mouseCoords, seed)` tuples — no server lookup needed).
  The room resets cleanly when it empties, so re-entrants and
  late joiners aren't rejected at the `beginstroke` gate.

**Physics** (faithful port of `GameCanvas.run`'s 166 Hz inner loop)
- Velocity integration (10 substeps × 0.1).
- Friction per surface, wall reflection (cardinal + diagonal),
  inside-corner suppression, restitution table.
- One-way walls (20–23) with directional pass-through.
- Slopes (4–11) with 8-direction acceleration.
- Water (12, 14) with both `waterEvent` modes (back to last hit /
  back to shore).
- Acid (13, 15) — always reset to track start.
- Hole pull (25) + 7+-neighbour lock.
- Teleports (32–38 / 33–39) with random exit selection.
- Mines (28, 30) ejecting at random velocity.
- Magnets (44 attract, 45 repel) with pre-computed 147×75 force field.
- Super-bouncy block (18) with the dynamic
  `bounciness * 6.5 / speed` restitution, decaying per hit.
- Movable & sunkable blocks (27, 46) — block slides along the impact
  axis when the ball hits a free face and sinks into adjacent water/
  acid. Fully client-deterministic via the shared per-stroke seed; an
  `otherPlayers` snapshot taken at `beginstroke` keeps the obstruction
  check in agreement across clients during async play.
- Per-player spawn resolution matching Java `resetPosition()` —
  per-color reset markers (48..51) win, common shape-24 start is the
  fallback, centre is the last resort.

**UX**
- Live peer aim preview — cursor stream at 15 Hz lets every player see
  every other player's aim line as they line up.
- Per-hole final scores in the scoreboard, with the running total
  derived from the same array.
- Anti-repeat ringbuffer in `TrackManager` (last 50 served names) so
  the same maps don't recur within a few games.

**Rendering**
- 49×25 RLE map decoding, byte-for-byte match with Java `Map.parse()`
  (A/B/C inline + D-I copy-references).
- Sprite-accurate tile compositing from `shapes.gif` / `elements.gif`
  / `special.gif` masks — slope arrows, mine markings, magnet field
  patterns, hole shading, etc.
- Original `GameBackgroundCanvas` edge-light pass: corner highlight,
  bevel edges, 7-px drop shadow on solids, ±16 on teleport markers,
  ±5 grain. Composited once at track build, plus on-the-fly tile
  mutation (movable blocks) rebuilds only the affected region.
- Atlas-based ball sprites with per-player colour.

## What's deferred

See `docs/KNOWN_ISSUES.md` "Gaps from a faithful 1:1 port" for the
running list. Highlights:

- Player-player ball collision (gated on `collision: 1`; not ported).
- Breakable-block (40–43) visual decay (bounce works; the wall doesn't
  visually crack — the mutate-tile plumbing added for movable blocks
  is reusable here).
- Sound playback (.wav files bundled in `web/public/sound/shared/`
  but not yet hooked up to Web Audio).
- Localisation routing (XML files bundled, not consumed).
- Track-test mode (`logintype ttm`).
- DUAL lobby (UI button disabled).
- Aim modes (right-click rotation between solid + 3 dashed lines).
- Reconnect after network blip.
- Track ratings UI / persistence.

## Architecture notes

- The **shared** package is the single source of truth for the wire
  protocol and map format. Both server and client import from it via
  TypeScript path mapping (`@minigolf/shared`).
- The server is single-threaded and event-driven — every Netty event
  in the Java source maps to an `await` or a callback here.
- The browser client follows the Java applet's panel-stack pattern:
  one `Panel` interface, an `App` that swaps panels on the same
  `#app` root, and a `Connection` singleton that pipes parsed
  `Packet` objects to the active panel.
- Game rendering uses an offscreen canvas for the static background
  (drawn once when the track loads) and `requestAnimationFrame` for
  the ball, aim line, and peer aim previews on top.
- Server state is **all in-memory** — track ringbuffer, lobbies,
  games, daily-room state. A restart wipes everything; only the
  daily result history survives because it's stored client-side in
  the user's browser localStorage.
- Long-session memory is bounded explicitly: chat log capped at
  500 lines, scoreboard rebuilds coalesced via a dirty flag, draw-
  call arrays reused across frames, daily-room sparse-id growth
  capped at 256 slots, inbound WS frame size capped at 16 KiB with
  ≤32 frames per message.
