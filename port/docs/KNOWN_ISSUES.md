# Known Issues & Roadmap

A running list of bugs and gaps. Notes from playtest sessions go here so a
future maintainer (or fresh-context Claude) can pick up where we left off.

## Bugs (reported by user during playtest)

### 1. Same maps appear more often than chance suggests

**Symptom:** Across multiple games with the same track-type filter, the same
tracks recur faster than `1/poolSize` would predict.

**Hypothesis:** `TrackManager.getRandomTracks` does a Fisher–Yates shuffle of
the filtered pool and slices the first N. There's no memory of recently-served
tracks, so the same tracks can hit several games in a row. Math.random()'s
distribution is fine — the issue is "no anti-repeat memory."

**Suggested fix:**
- Maintain a per-server (or per-lobby) `recentTrackIds: ringbuffer` of the last
  ~50 tracks served. In `getRandomTracks`, prefer tracks NOT in the ring; only
  fall through to "any" when the filtered pool is exhausted.
- Or: weight the random pick so a track served recently has a temporarily
  reduced probability.

**Files:** `port/server/src/tracks.ts` — `getRandomTracks`.

### 2. User disconnects unexpectedly

**Symptom:** A player's tab gets disconnected mid-game with no obvious cause.

**What we already did:**
- Bumped server idle window: `PING_AFTER_MS=15s`, `CLOSE_AFTER_MS=60s` (was
  5s/20s) to tolerate background-tab throttling.
- Added proactive client-side `c ping` every 15s so even a heavily throttled
  background tab keeps the connection warm.
- Added always-on logging of close reasons in `Connection.close` with the
  player nick — every disconnect now prints `[connection] closing
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

### 3. Chat formatting is inconsistent

**Symptom:** The way usernames render in chat differs between lobby chat,
in-game chat, and the local-echo of one's own messages.

**Locations:**
- `port/web/src/panels/lobby-multi.ts` — `appendChat`. Local echo writes
  `<you> {text}` for own messages, `<{senderNick}> {text}` for others.
- `port/web/src/panels/game.ts` — `appendChat`. Local echo writes
  `<{myNick}> {text}` (the actual nick, not literal "you").

**Fix:** pick one convention and apply everywhere. Suggested: always use
`<{nick}> {text}` and have `myNick` filled in for the local user. Whisper
prefix `[whisper from {nick}]` is consistent already.

### 4. Ball spawn point sometimes wrong (centre instead of marker)

**Symptom:** On certain tracks the ball spawns at the centre of the playfield
(367.5, 187.5) instead of the marked start position. Suspected to be tracks
that have multiple coloured spawn points.

**Hypothesis:** `port/web/src/game/map.ts:buildMap` only collects start
positions from special shape `24` (common start). It does collect colour
starts (shapes 48–51) into `resetPositions`, but those are NEVER used by the
client to initial-position a ball — they're used for water-shore reset for
that colour player.

In the original game, multi-player tracks have one common start (shape 24)
that all players spawn at. Tracks with ONLY coloured spawns (no shape 24)
fall through to the centre default in our code.

**Suggested fix in `game/map.ts`:**
```ts
// If no common starts, fall back to coloured starts for the spawn pool.
if (startPositions.length === 0) {
  for (const p of resetPositions) if (p) startPositions.push(p);
}
```

Then on the client (`game.ts:handleStartTrack`), instead of always picking by
`gameId % startPositions.length`, give each player a consistent start:
```ts
const start = parsed.startPositions[i % parsed.startPositions.length] ?? [...];
```
where `i` is `myPlayerId` for the local ball. Other players' balls get their
own `start[playerN % len]`. (This means each player can have a different start
position on multi-spawn tracks.)

**Files:** `port/web/src/game/map.ts`, `port/web/src/panels/game.ts`
(handleStartTrack).

### 5. Scoreboard doesn't show finished hole scores

**Symptom:** After a hole completes, the previous holes show `·` instead of
the player's final stroke count.

**What it shows now:** Current hole strokes, dot for past holes, dash for
future holes, total in the rightmost column.

**What it should show:** Current hole strokes for the active hole, the FINAL
stroke count for each finished hole, dash for future, total at the end.
Matches the original Java scoreboard which kept per-hole tallies.

**Suggested fix:** Add `holeScores: number[]` to `PlayerSlot` (length =
numTracks; index = track index 0..N-1). On every `endstroke` broadcast for the
current hole, write the latest stroke count into `holeScores[currentTrackIdx-1]`
for that player. When `starttrack` arrives for the next track, the per-track
stroke counter resets but the historical entry stays.

In `renderScoreboard`:
```ts
for (let t = 0; t < this.numTracks; t++) {
  if (t + 1 < this.currentTrackIdx) cells.push(String(p.holeScores[t]));
  else if (t + 1 === this.currentTrackIdx) cells.push(String(p.strokesThisTrack));
  else cells.push("—");
}
```

**Files:** `port/web/src/panels/game.ts` — `PlayerSlot`,
`handleEndStrokeBroadcast`, `renderScoreboard`.

## Gaps from a faithful 1:1 port

Things we deferred for MVP that the original Java game has:

- **Player-player ball collision.** Java has it gated on `collision: 1`; we
  ignore the flag. Adding it has determinism implications — any per-iteration
  call ordering must match between clients. The collision math is in
  `GameCanvas.handlePlayerCollisions`.
- **Movable / sunkable blocks (27, 46) sliding behaviour.** Walls work; but
  the block doesn't actually slide when hit.
- **Breakable blocks (40–43) visual updates.** Bounce works; the wall
  doesn't visually crack/decay.
- **3D shading on tile rendering.** The original adds light/shadow at higher
  graphics-quality settings via `GameBackgroundCanvas.drawMap`.
- **Sound playback.** All 8 .wav files are bundled in
  `port/web/public/sound/shared/` but the client never plays them. Need
  Web Audio integration: `gamemove` on stroke, `winner`/`loser` on game end,
  `notify` on chat, etc.
- **Localisation.** `AGolf.xml` for en/fi/sv is bundled but the client uses
  hard-coded English strings. Wire up a `TextManager` analog if needed.
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
- **Reconnect after network blip.** `c crt 250` advertises a 250-second
  reconnect window but we don't implement reconnect flow.

## Architecture notes for future-Claude

A few non-obvious pitfalls when modifying things:

- **`player.lobby` is sticky.** `Lobby.removePlayer` does NOT null
  `player.lobby` — needed so `Game.handlePacket("back")` can route the
  player back to the lobby they came from. If you re-introduce the null,
  `back` from a multi-game silently drops to nothing.
- **Order of registered handlers matters.** The chat handler must come
  before the generic `^game\t.+$` handler in `packet-handlers.ts`. Both
  match `game say`; the first hit wins.
- **`GolfServer.getNextGameId` starts at 1.** Old smoke tests assumed 0 —
  watch out.
- **`networkSerialize` has a port-specific addition.** It now includes a
  `C <categories>` line that Java's `FileSystemTrackStats.networkSerialize`
  doesn't emit. Clients use it for the in-game tag chips. If you ever
  cross-test against a real Java client, expect the Java client to ignore
  this line (it scans for known prefixes only).
- **The shooter waits for the server broadcast.** Don't optimize the
  click→impulse path by applying locally — it would desync everyone.
- **HMR delivers physics changes instantly.** The Vite dev server hot-reloads
  edits to anything in `web/src/`. Server changes need a restart of `npm run
  dev:server`.

## Resolved (kept for posterity)

- Track-type form values were 0–5 instead of 1–6 (sent ALL when "Basic" was
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
