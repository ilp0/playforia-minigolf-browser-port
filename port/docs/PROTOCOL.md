# Wire Protocol Reference

Transport: WebSocket text frames. One packet per frame. No trailing `\n`.

Every packet starts with a single-character type prefix and a space, then the
body. Bodies are tab-separated where they have multiple fields.

## Packet types

| Prefix | Type      | Use                                                       |
|--------|-----------|-----------------------------------------------------------|
| `c`    | COMMAND   | Control frames (ping/pong, new, id, end, etc.)            |
| `d`    | DATA      | Game logic. Carries a per-direction sequence number.       |
| `s`    | STRING    | Telemetry. Rare. Currently unused inbound.                 |
| `h`    | HEADER    | Initial handshake (`h 1`) sent by server on connect.       |

DATA packets are the only ones with sequence numbers. Both directions count
independently (server's outbound seq starts at 0, client's outbound seq starts
at 0). A seq mismatch closes the connection - see `Connection.handleRawMessage`.

## Connect handshake

On WebSocket open the server sends three frames immediately:
```
h 1
c crt 250
c ctr
```

Then the client drives login. The handshake-banner values aren't checked by
us (Java reads them) but we send them verbatim for compatibility.

## Login flow

```
client → c new
server → c id <int>            (assigned player id, monotonic)
client → d 0 version<TAB>35    (35 = GOLF gametype version)
server → d 0 status<TAB>login
client → d 1 language<TAB>en   (en|fi|sv - server records, no reply)
client → d 2 logintype<TAB>nr  (nr = guest; the only one we implement)
server → d 1 status<TAB>login  (yes, twice - Java oddity)
client → d 3 cid<TAB>{uuid}    (PORT EXTENSION - persistent browser id from
                                localStorage; analytics only, no protocol
                                use. Optional; missing = no cid logged.)
client → d 4 nick<TAB>{name}   (PORT EXTENSION - optional; if omitted or
                                rejected, server falls back to a random
                                `~anonym-` placeholder)
client → d 5 login
server → d 2 basicinfo<TAB>t<TAB>0<TAB>t<TAB>t
server → d 3 status<TAB>lobbyselect<TAB>300
```

After this the client is at the lobby-select screen.

## Lobby select

Polled every 5s by the lobbyselect panel for live counts:
```
client → d N lobbyselect<TAB>rnop
server → d K lobbyselect<TAB>nop<TAB>{single}<TAB>{dual}<TAB>{multi}
```

To enter a lobby:
```
client → d N lobbyselect<TAB>select<TAB>{1|2|x}[<TAB>h]   (h = chat-hidden)
server → d K status<TAB>lobby<TAB>{1|2|x}[h]
server → d K+1 lobby<TAB>users[<TAB>{playerString}...]    (player list)
server → d K+2 lobby<TAB>ownjoin<TAB>{playerString}        (self)
server → d K+3 lobby<TAB>tagcounts<TAB>{all}<TAB>{c1}..{c6}  (port-extension)
```

Multi lobbies additionally get the game list right after `users`:
```
server → d K lobby<TAB>gamelist<TAB>full<TAB>{count}<TAB>{game0_f0}<TAB>...<TAB>{gameN_f14}
```

## Player string

`Player.toString()` produces a caret-separated 6-tuple, prefixed with `3:`:
```
3:{nick}^{flags}^{ranking}^{lang}^{profileUrl|-}^{avatarUrl|-}
```

`flags` is one of `r`, `v`, `s`, `n` (registered/vip/sheriff/no-challenges)
or `w` if none apply.

## Game string (15 fields)

Used in `lobby gamelist add/change` and friends. Tab-separated:
```
{id}<TAB>{name}<TAB>{passworded(t/f)}<TAB>{perms}<TAB>{numPlayers}<TAB>-1
<TAB>{numTracks}<TAB>{trackType}<TAB>{maxStrokes}<TAB>{strokeTimeout}
<TAB>{waterEvent}<TAB>{collision}<TAB>{trackScoring}<TAB>{trackScoringEnd}
<TAB>{currentPlayers}
```

`-1` is a placeholder slot from the original Java. `trackType` is the
category id (0=Mixed, 1=Basic, 2=Traditional, 3=Modern, 4=HIO, 5=Short,
6=Long).

## Lobby chat

```
client → d N lobby<TAB>say<TAB>{text}
server → d K lobby<TAB>say<TAB>{text}<TAB>{senderNick}<TAB>{senderClan}
   (broadcast to OTHERS only - sender echoes locally)

client → d N lobby<TAB>sayp<TAB>{recipientNick}<TAB>{text}
server → d K lobby<TAB>sayp<TAB>{senderNick}<TAB>{text}
   (delivered to recipient only)
```

Game chat is symmetric:
```
client → d N game<TAB>say<TAB>{text}
server → d K game<TAB>say<TAB>{playerId}<TAB>{text}
```

Newlines and tabs in chat text are stripped client-side (would break framing).

## Single-player game (training)

```
client → d N {lobby|lobbyselect}<TAB>cspt<TAB>{numTracks}<TAB>{trackType}<TAB>{water}
   (lobby = use this when already in lobby; lobbyselect = creates+joins
    in one step)

server → d K status<TAB>game
server → d K+1 game<TAB>gameinfo<TAB>{15 fields, see below}
server → d K+2 game<TAB>players                   (no other players → no fields)
server → d K+3 game<TAB>owninfo<TAB>{numIdx}<TAB>{nick}<TAB>{clan}
server → d K+4 game<TAB>start
server → d K+5 game<TAB>resetvoteskip
server → d K+6 game<TAB>starttrack<TAB>{playStatus}<TAB>{gameId}<TAB>{trackData}
```

`{trackData}` is the V1 networkSerialize body. Tab-separated lines:
```
V 1<TAB>A {author}<TAB>N {name}<TAB>T {map}<TAB>C {categories}<TAB>S {settings}
<TAB>I {plays},{strokes},{bestPar},{numBestPar}<TAB>B {bestPlayer},{bestEpochMs}
<TAB>R {r0},{r1},...,{r10}<TAB>E {elapsedMs}
```
The `B` line is omitted if `bestPar < 0`. The `C`, `S` and `E` lines are OUR
port extensions - Java doesn't include them. `S` carries the four-flag
visibility string (`mines/magnets/teleports/illusion-shadows`, plus the legacy
2-digit player-range suffix); use `parseSettingsFlags` from `@minigolf/shared`
to decode the first four chars. The `S` line is only shipped when the track
file actually has one (~8% of stock tracks); when absent, the client falls
back to `ALL_VISIBLE_FLAGS` so mines and magnets render the way they look in
the editor. Use `extractField(fields, "C ")` / `extractField(fields, "S ")`
on the client and treat a `null` return from the latter as "no settings -
default visible".

The `E <elapsedMs>` field carries the server-side track elapsed time at the
moment of broadcast - 0 for fresh broadcasts, nonzero for personal sends to a
late joiner. Clients use it to set `trackStartedAtMs = performance.now() -
elapsedMs`, anchoring the shared `worldTick` clock that drives `apply_tick`
scheduling for strokes (see "World tick + apply_tick" below).

## Game info packet (15 fields)

```
game<TAB>gameinfo<TAB>{name}<TAB>{passworded(t/f)}<TAB>{gameId}<TAB>{numPlayers}
<TAB>{numTracks}<TAB>{trackType}<TAB>{maxStrokes}<TAB>{strokeTimeout}
<TAB>{waterEvent}<TAB>{collision}<TAB>{trackScoring}<TAB>{trackScoringEnd}<TAB>f
```

Field positions (0-indexed within the tab-split fields array, so `[0]=game`,
`[1]=gameinfo`):
- `[2]` name
- `[3]` passworded
- `[4]` gameId
- `[5]` numPlayers
- `[6]` numTracks
- `[7]` trackType
- `[8]` maxStrokes
- `[9]` strokeTimeout
- `[10]` waterEvent
- `[11]` collision
- `[12]` trackScoring
- `[13]` trackScoringEnd
- `[14]` "f"

## Multi-player game

Create:
```
client → d N lobby<TAB>cmpt<TAB>{name}<TAB>{password|-}<TAB>{perms=0}
        <TAB>{numPlayers}<TAB>{numTracks}<TAB>{trackType}<TAB>{maxStrokes}
        <TAB>{strokeTimeout=60}<TAB>{water}<TAB>{collision}
        <TAB>{trackScoring=0}<TAB>{trackScoringEnd=0}
```

Server processes via `LobbyMultiplayerHandler`, broadcasts
`lobby gamelist add <gameString>` to everyone in the lobby and adds the
creator to the new game.

Join:
```
client → d N lobby<TAB>jmpt<TAB>{gameId}[<TAB>{password}]
   (if password is wrong, server replies `error wrongpassword` and bumps
    the player back to the lobby)
```

When the game fills, server broadcasts `lobby gamelist remove <gameId>` and
sends `game start` + `game starttrack` to all players.

## Stroke flow (async, port-specific)

Initiating a stroke:
```
client → d N game<TAB>beginstroke<TAB>{ballCoords}<TAB>{mouseCoords}
   (client does NOT apply impulse - waits for the broadcast)
server → d K game<TAB>beginstroke<TAB>{playerId}<TAB>{ballCoords}<TAB>{mouseCoords}<TAB>{seed}<TAB>{apply_tick}
   (broadcast to ALL players including the shooter; seed is the server-assigned
    32-bit per-stroke seed; apply_tick is the world-tick number at which every
    client applies the impulse - see "World tick + apply_tick" below)
```

The `apply_tick` field is a **port extension** the original Java game lacks.
Cross-client krokkaus collision determinism depends on it: every client buffers
the impulse and applies it when its local `worldTick` reaches `apply_tick`, so
ball-vs-ball overlap evaluates against identical peer state on every machine
even when pings differ. Older clients that ignore the trailing field would
fall back to "apply on receipt" (the legacy code path).

`ballCoords` and `mouseCoords` are base-36 4-character encodings of
`x * 1500 + y * 4 + mode`. The `mode` field carries the right-click
shooting mode (0 = normal, 1 = reverse 180°, 2 = 90° clockwise,
3 = 90° counter-clockwise) on `mouseCoords`, mirroring the original
GameCanvas.shootingMode. `ballCoords` always uses mode 0.

When the ball stops (any reason - at rest, in hole, on water/acid):
```
client → d N game<TAB>endstroke<TAB>{playerId}<TAB>{playStatusString}
   (only the shooter sends this; playStatus is one char per player -
    't' = in hole, 'p' = forfeited/passed, 'f' = still playing)
server → d K game<TAB>endstroke<TAB>{playerId}<TAB>{strokesThisTrack}<TAB>{status: t|p|f}
   (broadcast to ALL - server may flip 'f' to 'p' if the player just hit the
    stroke cap; the strokes count is authoritative)
```

Forfeit:
```
client → d N game<TAB>forfeit
server → d K game<TAB>endstroke<TAB>{playerId}<TAB>{maxStrokes}<TAB>p
```

When all players are non-`f`, server advances:
```
server → d K game<TAB>resetvoteskip
server → d K+1 game<TAB>starttrack<TAB>{playStatus}<TAB>{gameId}<TAB>{trackData}
   (a new per-stroke seed counter starts here too)
```

When the last track is done:
```
server → d K game<TAB>end[<TAB>{p0Result}<TAB>{p1Result}...]
   (1 = winner, 0 = draw, -1 = loser; results omitted in single-player)
```

## World tick + apply_tick (port-specific - krokkaus determinism)

The original Java game evaluates ball-vs-ball collision (`collision: 1`)
locally on each client at packet-receipt time. That works in turn-based mode
because only one ball moves at a time. The async port lets every player shoot
whenever their ball is at rest, so two balls can be in flight simultaneously
on one client while a third stroke arrives - and the moment-of-overlap
between any two balls is sensitive to ping jitter. To keep collisions
deterministic across clients, the port adds a shared world-tick clock:

- **trackStartedAtMs** (server) is set whenever a fresh `starttrack` is
  broadcast. The `E <elapsedMs>` field on starttrack lets each client compute
  `trackStartedAtMs_local = performance.now() - elapsedMs`. Under stable
  ping, `worldTick(t) = (t - trackStartedAtMs_local) / 6 ms` evaluates to the
  same integer on every client at the same wall-clock moment (the per-client
  ping offsets cancel out in the math).

- **apply_tick** (per stroke) is `(server_elapsedMs / 6) + lookahead_ticks`
  where `lookahead_ticks` defaults to 30 (≈180 ms) for collision-on games and
  0 otherwise. Every client buffers the impulse and applies it when its
  local `worldTick` reaches `apply_tick`. The shooter and every watcher land
  on the same iteration, so peer ball positions match at the moment of
  overlap and the per-substep krokkaus check produces identical results.

- **Catchup**: clients advance `worldTick` clock-based regardless of whether
  any ball is moving (the per-ball `step()` is still gated on motion). A tab
  returning from background catches up by running the missed iterations;
  catchup is capped per RAF frame so the browser doesn't stall.

- **Late packets** (`apply_tick < worldTick` at receipt) are applied on the
  next available tick. This produces a small visible desync until the next
  `starttrack` resets the world clock; ping spikes larger than the lookahead
  (180 ms) are the primary trigger.

The single-source-of-truth for the constants is `port/server/src/game.ts`:
`PHYSICS_STEP_MS = 6`, `STROKE_LOOKAHEAD_TICKS = 30`. The web client's
`port/web/src/game/physics.ts` exports the same `PHYSICS_STEP_MS`.

## Live aim preview (cursor stream - port-specific)

Loss-tolerant 15 Hz cursor broadcast for spectator-flavoured UX: every player
sees every other player's aim line in real time while they're lining up a
shot. Not used for physics - purely cosmetic.

```
client → d N game<TAB>cursor<TAB>{x}<TAB>{y}[<TAB>{shootingMode}]
   (sent only while OUR ball is at rest, throttled to ≤15 Hz, suppressed if
    cursor moved <2 px since the last send; sent immediately on shootingMode
    change so peers see right-click rotation even if the cursor is stationary)
server → d K game<TAB>cursor<TAB>{playerId}<TAB>{x}<TAB>{y}[<TAB>{shootingMode}]
   (server stamps the sender's playerId and forwards to every OTHER player in
    the game - sender doesn't get an echo. The shootingMode field is relayed
    verbatim when present and omitted when absent - back-compat with clients
    that don't track the right-click cycle)
```

`{x}` and `{y}` are integer canvas pixel coordinates (0..735, 0..375).
`{shootingMode}` is `0`, `1`, `2`, or `3` (Java GameCanvas.shootingMode):
0 = normal, 1 = reverse 180°, 2 = 90° clockwise, 3 = 90° counter-clockwise.
Watcher renders the peer's aim line in the same rotated direction the peer
sees on their own screen. The client only renders a peer's cursor as an aim
line when the peer's ball is at rest and the peer hasn't holed-in / forfeited.
Cursor state is cleared on `starttrack` so the previous hole's last cursor
never leaks into the next.

## Heartbeat

Server side:
- If no inbound for 15s → send `c ping`.
- If no inbound for 60s → close with reason "idle-timeout".

Client side:
- Always reply pong to inbound `c ping` (auto-handled in `Connection`).
- Proactive `c ping` every 15s regardless. This is what keeps a backgrounded
  browser tab from being timed out (Chrome throttles JS in background tabs;
  the auto-pong might miss the deadline; the proactive ping has more slack).

## Reconnect after network blip

The connect-handshake `c crt 250` advertises a 250-second window during
which a disconnected player can reattach by opening a fresh WebSocket and
sending `c old <savedId>` instead of `c new`. Server-side, this is a
faithful port of Java's `ReconnectHandler`.

Sequence:
```
(network blip - client's WS dies, code 1006 / wasClean=false)

(server) handleDisconnect: defers full cleanup by 250s if player.game === null;
         player record stays in the lobby (peers' user lists unchanged).
         Mid-game disconnects bypass grace and forfeit immediately -
         peers are otherwise stuck waiting for endstroke.

(client) opens fresh WS - server sends usual banner:
         h 1
         c crt 250
         c ctr

(client) sends      c old <savedId>
(server) replies    c rcok        ← grace was active; new socket adopted
              -- or c rcf         ← unknown id, grace expired, or mid-game
```

Both directions reset their DATA seq counter to 0 on `c rcok`. The
implementation does NOT replay packets sent during the dead window -
anything the server pushed while the WS was down is simply lost (e.g.
peer chat). This matches what the original Java client effectively did
(its retain-seq protocol tripped its own gap-detection on any peer
broadcast during the gap).

Client-side retry: 10 attempts, 3-second interval (~30s total budget).
Capped well under the server's 250s window so we surface failure
quickly when the network is genuinely down rather than thrashing.
On exhaustion or `c rcf` the client emits `reconnect-failed` and shows
"Reconnect failed - please refresh." in the error banner.

The `c old`/`c rcok`/`c rcf` packets bypass DATA seq tracking (they're
COMMAND packets) and are intercepted by `Connection.handleLine` while in
reconnect mode - panels never see them. Files: `port/server/src/server.ts`
(`handleReconnect`), `port/server/src/packet-handlers.ts` (`old` handler),
`port/web/src/connection.ts` (reconnect mode + `c old <savedId>` driver),
`port/web/src/app.ts` (`reconnecting`/`reconnected`/`reconnect-failed`
banner).

## Quitting / leaving

```
client → d N game<TAB>back        (in-game: leave to lobby)
server → d K status<TAB>lobby<TAB>{type}    (re-routes via app.setPanel)
```

`back` from the LAST player in a game also triggers `lobby gamelist remove
<gameId>` for everyone in that lobby.
