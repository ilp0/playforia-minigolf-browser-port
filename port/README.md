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

## Tests

```sh
cd port
npm test                                       # shared package: Seed, RLE, codec, tools
node --experimental-strip-types --no-warnings server/src/test-handshake.ts
node --experimental-strip-types --no-warnings server/src/test-fullflow.ts  # needs a running server
```

`test-handshake.ts` boots a self-contained server on port 4243 and
walks the full guest-login → training-game flow.

`test-fullflow.ts` connects to whatever WS server is on
`ws://localhost:4242/ws` (override via `WS_URL`) and asserts the same
exchange end-to-end, including the stroke cycle.

The `Seed` PRNG test uses 100 reference values captured from the
actual Java `agolf.Seed` class running under JDK 17 — every shot's
randomness is bit-for-bit identical to the original game.

## What's implemented (MVP)

- WebSocket transport with sequence-number validation and ping/pong.
- Connect → guest login (`~anonym-NNNN`) → lobby-select → enter
  single-player lobby → start training game → receive track and stats.
- Training game lifecycle: `starttrack`, `startturn`, `beginstroke`,
  `endstroke`, `nextTrack`, `endGame` cycle.
- 49×25 RLE map decoding, byte-for-byte match with the Java
  `Map.parse()` algorithm (incl. A/B/C inline + D-I copy-references).
- 735×375 pixel collision map, built from sprite atlases the same way
  Java does it (`shapes.gif` / `special.gif` masks composited with
  `elements.gif` background/foreground indices).
- Ball physics: deterministic shot impulse with seeded random noise,
  integration with friction, wall reflection (cardinal + diagonal),
  hole pull and 7+-neighbour lock, hole-in detection.
- Mouse aim with power scaling per the Java `getStrokePower()`.
- Atlas-based ball sprite (player 0 = white).

## What's deferred

These were intentionally left out of MVP scope to keep one autonomous
implementation pass tractable:

- Dual / multi-player lobbies and lobby chat.
- Track-test mode.
- Slopes, water, sand, mines, magnets, teleports, breakable /
  movable blocks (most tracks still play; tracks that *require* these
  features to reach the hole won't be completable yet).
- One-way wall directional pass-through (treated as solid).
- Localisation routing (XML files are bundled but not consumed).
- Sprite-accurate tile rendering (uses a simple colour palette
  driven by element index).

## Architecture notes

- The shared package is the single source of truth for the wire
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
  the ball + aim line overlay.
