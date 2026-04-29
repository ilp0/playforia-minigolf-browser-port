# Known Issues & Roadmap

A running list of bugs and gaps. Notes from playtest sessions go here so a
future maintainer (or fresh-context Claude) can pick up where we left off.

## Bugs (reported by user during playtest)

### 2. User disconnects unexpectedly

**Symptom:** A player's tab gets disconnected mid-game with no obvious cause.

**What we already did:**
- Bumped server idle window: `PING_AFTER_MS=15s`, `CLOSE_AFTER_MS=60s` (was
  5s/20s) to tolerate background-tab throttling.
- Added proactive client-side `c ping` every 15s so even a heavily throttled
  background tab keeps the connection warm.
- Added always-on logging of close reasons in `Connection.close` with the
  player nick - every disconnect now prints `[connection] closing
  {id}/{nick}: {reason}` to the server stdout.

**Next time it happens:** Look at the server log for the close reason.
Likely candidates:
- `idle-timeout` → keepalive timer didn't fire (browser tab was REALLY
  throttled, or the connection was stuck somehow). Consider lowering the
  client keepalive interval to 5s.
- `seq-mismatch` → client sent packets out of order. Should be impossible
  via the normal code path; investigate the sequence of events.
- `decode-failure` → client sent a malformed packet. Look at the surrounding
  log lines for what was sent.
- `ws error` / no reason → underlying TCP/WS error (network blip, NAT
  rebinding, tunnel reset).

**Files:** `port/server/src/connection.ts` (idle constants),
`port/web/src/connection.ts` (keepalive interval).

## Gaps from a faithful 1:1 port

Things we deferred for MVP that the original Java game has:

- **Player-player ball collision.** Java has it gated on `collision: 1`; we
  ignore the flag. Adding it has determinism implications - any per-iteration
  call ordering must match between clients. The collision math is in
  `GameCanvas.handlePlayerCollisions`.
- **Sound playback.** All 8 .wav files are bundled in
  `port/web/public/sound/shared/` but the client never plays them. Need
  Web Audio integration: `gamemove` on stroke, `winner`/`loser` on game end,
  `notify` on chat, etc.
- **Localisation extension.** Core wiring exists (`web/src/i18n.ts` -
  Java `TextManager` analog) and en/fi/sv `AGolf.xml` are loaded via
  `fetch` from `/l10n/<lang>/AGolf.xml`. Visible strings in the login,
  lobby-select, single/multi lobby, in-game and replay panels resolve
  through `t(key, defaultEn, ...args)`. New port-specific strings live
  under the `Port_*` namespace (not present in the original Java XMLs);
  add them to `client/src/main/resources/l10n/<lang>/AGolf.xml` if you
  want them translated, then re-run `npm run assets`. Falls through
  active-locale → EN → inline `defaultEn` so missing keys still render.
- **Track-test mode (`logintype ttm`).** Not implemented.
- **DUAL lobby.** UI button is disabled; the protocol/server handlers
  technically support `select 2` but no `LobbyDualplayerHandler` is wired.
- **Dynamic ball-frame sprite.** The "moving" sprite frame in `balls.gif` is
  intentionally NOT used (it's a different colour to the idle frame, which
  visually swapped the ball colour mid-shot). If the original intent was a
  rotating animation, we'd need a different sprite layout.
- **Aim modes (right-click rotation).** The original lets right-click cycle
  through 4 aim modes (solid + 3 dashed-line rotations). We only have mode 0.
- **Rating tracks.** Server stub exists (`game rate <track> <rating>`) but
  no UI; ratings aren't persisted (FileSystemStatsManager is read-only).
- **Mid-game reconnect.** Lobby/lobbyselect reconnect-after-blip is now
  implemented (see PROTOCOL.md "Reconnect after network blip"), but a
  mid-game disconnect still falls through to immediate cleanup. Honoring
  grace mid-stroke is non-trivial: peers are waiting on this player's
  `endstroke` to advance the game, so the grace window has to either
  auto-forfeit the in-flight stroke or model "disconnected but
  reserved" with a separate stroke-timeout. Files: `port/server/src/
  server.ts` (`handleDisconnect` early-returns to `fullyRemovePlayer`
  when `player.game !== null`).
- **Daily mode: resting-ghost sync for late joiners.** When a player joins the
  daily room mid-play, they see existing players' balls at the spawn position
  rather than wherever those balls have actually come to rest. The next stroke
  by an existing player corrects this (the server's `beginstroke` broadcast
  carries the authoritative ball coords). To fix: have the server track each
  player's last-stop position (e.g. by recording `ballCoords` from each
  `beginstroke`) and send a snapshot to newcomers via a new `game ghoststate`
  packet inside `DailyGame.joinDaily`. Files: `port/server/src/game.ts`
  (`DailyGame`), `port/web/src/panels/game.ts` (handler).

## Architecture notes for future-Claude

A few non-obvious pitfalls when modifying things:

- **`player.lobby` is sticky.** `Lobby.removePlayer` does NOT null
  `player.lobby` - needed so `Game.handlePacket("back")` can route the
  player back to the lobby they came from. If you re-introduce the null,
  `back` from a multi-game silently drops to nothing.
- **Order of registered handlers matters.** The chat handler must come
  before the generic `^game\t.+$` handler in `packet-handlers.ts`. Both
  match `game say`; the first hit wins.
- **`GolfServer.getNextGameId` starts at 1.** Old smoke tests assumed 0 -
  watch out.
- **`networkSerialize` has a port-specific addition.** It now includes a
  `C <categories>` line that Java's `FileSystemTrackStats.networkSerialize`
  doesn't emit, plus an `S <settings>` line that the Java server also
  omitted (the Java client never honored these flags because of a parser
  typo on the receiving side - see `parseSettingsFlags` in
  `shared/src/track.ts`). Clients use C for the in-game tag chips and S
  for tile-visibility / illusion-shadow rendering. If you ever cross-test
  against a real Java client, expect it to ignore both lines (it scans
  for known prefixes only).
- **The shooter waits for the server broadcast.** Don't optimize the
  click→impulse path by applying locally - it would desync everyone.
- **HMR delivers physics changes instantly.** The Vite dev server hot-reloads
  edits to anything in `web/src/`. Server changes need a restart of `npm run
  dev:server`.

## Caveats from the recent movable-blocks port

- **Movable-block (27/46) sync in async play.** The implementation is fully
  client-deterministic: each client mutates `parsedMap.tiles[][]` from the
  same shared seed, so block positions converge without any new packet. The
  `canMovableBlockMove` obstruction check uses an `otherPlayers` snapshot
  taken at beginstroke (in `panels/game.ts`) and skips any peer who is
  currently mid-stroke - that keeps the check deterministic across clients
  even when multiple balls are in flight.
- **Late joiners see the original block layout, not the current one.** Same
  class as the daily-mode resting-ghost issue: a player who joins a multi
  game after blocks have already been pushed around won't see the current
  positions until the next `starttrack` resets the map. To fix properly
  we'd need a `game blockstate` snapshot in the join sequence; deferred.
- **A player whose stroke crashes/exits mid-motion can leave the block state
  diverged on their machine.** Recovery is implicit: on the next
  `starttrack` (next hole) the map rebuilds from the original `T` line.

## Resolved (kept for posterity)

- **`test-fullflow.ts` and `test-handshake.ts` were stale (predated `lobby
  tagcounts`).** Both now drain frames via predicate matchers
  (`awaitMatch` / `waitFor`-style) instead of strict-positional assertions,
  so the port-extension `lobby tagcounts` packet between `lobby ownjoin`
  and `status game` no longer trips them. The stale `startturn` assertion
  was also dropped (server is async-mode now). Files:
  `port/server/src/test-fullflow.ts`, `port/server/src/test-handshake.ts`.
- **3D shading on tile rendering.** The original `GameBackgroundCanvas`
  edge-light pass - corner highlight, bevel edges, 7-px drop shadow on
  solids, ±16 on teleport markers, ±5 grain - is now applied once at track
  build in `TrackRenderer`, with a partial rebuild on movable-block tile
  mutations.
- **Movable / sunkable blocks (27, 46) sliding behaviour.** Block now
  slides on impact and sinks into adjacent water/acid; see the caveats
  section above for the determinism shape.
- **Same maps appeared too often.** Added a 50-entry recently-served ringbuffer
  to `TrackManager` - `getRandomTracks` now prefers tracks not in the ring and
  only falls through to recents when the filtered pool is too small.
- **Inconsistent chat formatting between lobby and game.** Lobby chat used
  `<you>` for self while game used `<{nick}>`. Lobby-multi now captures the
  assigned nick from `lobby ownjoin` and renders local-echo as `<{myNick}>`
  to match peers and the in-game format.
- **Wrong spawn point on multi-spawn-marker tracks.** `handleStartTrack` now
  resolves each player's spawn the way Java `resetPosition()` does:
  `resetPositions[playerId]` (shapes 48..51) wins, common shape-24 start is the
  fallback, centre is the last resort. Each `PlayerSlot` carries its own
  `startX/startY` so water/acid resets in `handleBeginStroke` use the right
  per-player spawn.
- **Scoreboard didn't show finished hole scores.** Added `holeScores: number[]`
  to `PlayerSlot`, populated on every `endstroke` broadcast (last write before
  track advance becomes the recorded final). `renderScoreboard` now shows the
  per-hole tally for past holes and derives the running total from the same
  array. The `strokesTotal` field was removed (was double-counting risk).
- Track-type form values were 0-5 instead of 1-6 (sent ALL when "Basic" was
  picked). Fixed in `lobby.ts` / `lobby-multi.ts`.
- Bouncy blocks (18) returned a flat 0.84; now use the dynamic
  `bounciness * 6.5 / speed` formula matching Java.
- Ball "color change" mid-shot was the moving sprite from `balls.gif`. Fixed
  by always rendering the idle frame.
- `endstroke` handler used `fields[2]` (player id) as the playStatus instead
  of `fields[3]`. Fixed.
- Initial server idle window of 20s was too tight for background tabs.
  Bumped to 60s plus client keepalive at 15s.
- `lobby cspt` (single-player) was being sent as `lobbyselect cspt` from the
  in-lobby panel, causing the server to bounce the player back to lobbyselect.
  Fixed by switching the in-lobby form to `lobby cspt`.
- Vite was rejecting tunnel hostnames. Added `allowedHosts: true` to
  `vite.config.ts`.
