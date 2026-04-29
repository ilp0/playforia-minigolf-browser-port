// Regex-based packet dispatch. Mirrors PacketHandlerFactory + the individual
// PacketHandler implementations from org.moparforia.server.net.packethandlers.

import { type Packet, PacketType, tabularize } from "@minigolf/shared";
import type { Connection } from "./connection.ts";
import type { GolfServer } from "./server.ts";
import { Player } from "./player.ts";
import { JoinType, LobbyType, PartReason } from "./lobby.ts";
import { MultiGame, TrainingGame } from "./game.ts";
import { logEvent } from "./log.ts";

interface Handler {
    type: typeof PacketType.COMMAND | typeof PacketType.DATA;
    pattern: RegExp;
    handle: (server: GolfServer, conn: Connection, match: RegExpMatchArray) => void;
}

const handlers: Handler[] = [];

function register(h: Handler): void {
    handlers.push(h);
}

// COMMAND handlers ------------------------------------------------------------

register({
    type: PacketType.COMMAND,
    pattern: /^new$/,
    handle: (server, conn) => {
        const id = server.getNextPlayerId();
        const player = new Player(conn, id);
        conn.player = player;
        server.addPlayer(player);
        // Java sends "c id <id>\n" - the trailing \n is the TCP framing terminator we don't need.
        conn.sendCommand("id", String(id));
    },
});

register({
    type: PacketType.COMMAND,
    pattern: /^pong$/,
    handle: () => {
        // No-op; activity timestamp already updated by Connection.handleRawMessage.
    },
});

// Reconnect-after-network-blip: client opens a fresh WebSocket, gets the usual
// `h 1` / `c crt 250` / `c ctr` banner, then instead of `c new` sends `c old
// <savedId>`. If the server still holds the player record (within the
// RECONNECT_GRACE_MS window), it swaps the new socket onto the existing
// player and replies `c rcok`; otherwise it replies `c rcf` and the client
// falls back to fresh-login. Pre-login command - guard against double-adopt.
register({
    type: PacketType.COMMAND,
    pattern: /^old (-?\d+)$/,
    handle: (server, conn, match) => {
        if (conn.player) return;
        const id = parseInt(match[1], 10);
        if (!Number.isFinite(id) || id < 1) {
            conn.sendCommand("rcf");
            return;
        }
        if (server.handleReconnect(conn, id)) {
            conn.sendCommand("rcok");
        } else {
            conn.sendCommand("rcf");
        }
    },
});

register({
    type: PacketType.COMMAND,
    pattern: /^ping$/,
    handle: (_server, conn) => {
        // Mirror back a pong to be polite.
        conn.sendCommand("pong");
    },
});

register({
    type: PacketType.COMMAND,
    pattern: /^end$/,
    handle: (_server, conn) => {
        conn.close("client-end");
    },
});

// DATA handlers ---------------------------------------------------------------

register({
    type: PacketType.DATA,
    pattern: /^version\t(\d+)$/,
    handle: (_server, conn, match) => {
        const v = parseInt(match[1], 10);
        if (v !== 35) {
            console.warn(`[handlers] unsupported version: ${v}`);
            conn.close("unsupported-version");
            return;
        }
        const player = conn.player;
        if (player) player.gameType = "GOLF";
        conn.sendData("status", "login");
    },
});

register({
    type: PacketType.DATA,
    pattern: /^language\t(.+)$/,
    handle: (_server, conn, match) => {
        if (!conn.player) return;
        // Same strip as the nick handler: the language ends up caret-joined
        // into the player record and the whole record tab-joined into lobby
        // packets. An unsanitised `\t` would shift positional fields on every
        // peer's user list. `^`/`:` would corrupt the caret-joined record.
        conn.player.language = match[1].replace(/[\r\n\t^:]+/g, " ").slice(0, 8);
    },
});

register({
    type: PacketType.DATA,
    pattern: /^logintype\t(nr|reg|ttm)$/,
    handle: (_server, conn) => {
        conn.sendData("status", "login");
    },
});

/**
 * Browser-port extension: persistent per-browser client id. The web client
 * keeps a UUID in `localStorage["mg.clientId"]` and forwards it during the
 * login handshake. Server-side it's only used for analytics - every
 * `player_login` / `player_disconnect` / `player_reconnect` event carries
 * the cid so an offline log scan can distinguish "same browser refreshing"
 * from "two unrelated guests on shared NAT". Length-capped and
 * character-restricted because it ends up in stdout JSON.
 */
register({
    type: PacketType.DATA,
    pattern: /^cid\t(.+)$/,
    handle: (_server, conn, match) => {
        const cleaned = match[1].replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
        if (cleaned) conn.clientId = cleaned;
    },
});

/**
 * Browser-port extension: client sends `nick <name>` between `logintype` and
 * `login` so the player's chosen display name flows through to other clients
 * (scoreboards, chat, daily-mode ghost labels). Without this the server would
 * stamp every guest with a random `~anonym-NNNN` placeholder.
 *
 * Sanitisation: trim, drop framing chars, cap at 20 chars (matches the
 * client-side input maxLength). Empty is treated as "no nick sent" so the
 * `login` handler falls back to the anonym placeholder.
 */
register({
    type: PacketType.DATA,
    pattern: /^nick\t(.+)$/,
    handle: (_server, conn, match) => {
        const player = conn.player;
        if (!player) return;
        // Strip both wire-framing chars (\r\n\t) and the structured-field
        // separators (^, :) that Player.toString triangelizes - a nick with `^`
        // or `:` would corrupt the lobby/owninfo lines for everyone.
        const cleaned = match[1].replace(/[\r\n\t^:]+/g, " ").trim().slice(0, 20);
        if (cleaned) player.nick = cleaned;
    },
});

register({
    type: PacketType.DATA,
    pattern: /^login$/,
    handle: (server, conn) => {
        const player = conn.player;
        if (!player) {
            conn.close("login-without-player");
            return;
        }
        // Honour the nick the client sent during the handshake; only fall back
        // to the random placeholder if they didn't send one (or it sanitised
        // away to nothing - `nick` handler leaves `player.nick` at the "-"
        // default in that case).
        if (player.nick === "-" || player.nick === "") {
            player.nick = `~anonym-${Math.floor(Math.random() * 10000)}`;
        }
        player.emailVerified = true;
        player.registered = false;
        // Tell the client about server-level toggles before it builds any UI.
        // Today only `chat` exists; clients that don't recognise the verb just
        // ignore the packet, so we can extend `srvinfo` later without breakage.
        conn.sendData("srvinfo", "chat", server.chatEnabled ? "1" : "0");
        // basicinfo\t<emailVerified>\t<accessLevel>\tt\tt
        conn.sendData("basicinfo", player.emailVerified, player.accessLevel, "t", "t");
        conn.sendData("status", "lobbyselect", "300");
        logEvent("player_login", {
            id: player.id,
            nick: player.nick,
            language: player.language ?? "-",
            cid: conn.clientId,
            conn: conn.connId,
            ip: conn.remoteAddress,
            ua: conn.userAgent,
        });
    },
});

register({
    type: PacketType.DATA,
    pattern: /^lobbyselect\t(rnop|select|qmpt|daily|leave)(?:\t([12xd])(h)?)?$/,
    handle: (server, conn, match) => {
        const sub = match[1];
        const player = conn.player;
        if (!player) return;
        if (sub === "leave") {
            // Player asked to go back to the lobby-select screen from a lobby
            // (e.g. clicked "Back" in the single-player or multi lobby). Pull
            // them out of any current lobby with USERLEFT, which causes the
            // server to send `status lobbyselect 300` to the leaver.
            //
            // Defensive about double-leaves: if `removePlayer` returns false
            // (the player was sticky-referenced but not actually in
            // lobby.players any more, e.g. they're in a game) we still need
            // to send the status so the client UI moves.
            if (player.lobby) {
                const removed = player.lobby.removePlayer(player, PartReason.USERLEFT);
                if (!removed) {
                    conn.sendData("status", "lobbyselect", "300");
                }
            } else {
                conn.sendData("status", "lobbyselect", "300");
            }
            return;
        }
        if (sub === "rnop") {
            const single = server.getLobby(LobbyType.SINGLE).totalPlayerCount();
            const dual = server.getLobby(LobbyType.DUAL).totalPlayerCount();
            const multi = server.getLobby(LobbyType.MULTI).totalPlayerCount();
            const daily = server.getLobby(LobbyType.DAILY).totalPlayerCount();
            // Existing 4-field reply (single/dual/multi); daily appended as a
            // 5th, optional field - older clients ignore it.
            conn.sendData("lobbyselect", "nop", single, dual, multi, daily);
        } else if (sub === "select") {
            const tag = match[2];
            if (!tag) return;
            player.isChatHidden = match[3] === "h";
            const lobbyType = (Object.values(LobbyType) as string[]).includes(tag)
                ? (tag as LobbyType)
                : null;
            if (!lobbyType) return;
            if (lobbyType === LobbyType.DAILY) {
                // Sticky-ref the lobby so `back` knows where they came from,
                // then funnel them straight into the singleton daily game.
                server.getLobby(LobbyType.DAILY).addPlayer(player, JoinType.NORMAL);
                server.getDailyGame().joinDaily(player);
                return;
            }
            server.getLobby(lobbyType).addPlayer(player, JoinType.NORMAL);
        } else if (sub === "qmpt") {
            player.isChatHidden = match[3] === "h";
            server.getLobby(LobbyType.MULTI).addPlayer(player, JoinType.NORMAL);
        } else if (sub === "daily") {
            // Compatibility alias: `lobbyselect daily` does the same as `select d`.
            server.getLobby(LobbyType.DAILY).addPlayer(player, JoinType.NORMAL);
            server.getDailyGame().joinDaily(player);
        }
    },
});

register({
    type: PacketType.DATA,
    pattern: /^(lobby|lobbyselect)\tcsp(t|c)\t(\d+)(?:\t(\d+)\t(\d+))?$/,
    handle: (server, conn, match) => {
        const player = conn.player;
        if (!player) return;
        const number = parseInt(match[3], 10);
        const fromState = match[1];
        const sub = match[2];
        if (sub === "t") {
            const trackType = match[4] !== undefined ? parseInt(match[4], 10) : 0;
            const water = match[5] !== undefined ? parseInt(match[5], 10) : 0;
            if (fromState === "lobbyselect") {
                server.getLobby(LobbyType.SINGLE).addPlayer(player, JoinType.NORMAL);
            }
            new TrainingGame(player, server.getNextGameId(), trackType, number, water, server.trackManager);
        } else if (sub === "c") {
            // Championship not implemented for MVP.
            conn.sendData("status", "lobbyselect", "300");
        }
    },
});

// Multi-player lobby create/join.
//   cmpt: lobby \t cmpt \t <name> \t <password> \t <perms> \t <numPlayers> \t <numTracks>
//         \t <trackType> \t <maxStrokes> \t <strokeTimeout> \t <water> \t <collision>
//         \t <scoreSystem> \t <weightEnd>     (13 args after cmpt)
//   jmpt: lobby \t jmpt \t <gameId> [\t <password>]
register({
    type: PacketType.DATA,
    pattern: /^lobby\t(c|j)mpt\t([^\t]+)((?:\t[^\t]*)*)$/,
    handle: (server, conn, match) => {
        const player = conn.player;
        if (!player) return;
        const sub = match[1];
        const firstArg = match[2];
        const restRaw = match[3] ?? "";
        const rest = restRaw.startsWith("\t") ? restRaw.substring(1).split("\t") : [];

        if (sub === "c") {
            // Create.
            const name = firstArg;
            const password = rest[0] ?? "-";
            const perms = parseInt(rest[1] ?? "0", 10) || 0;
            // Hard cap on playerCount: the value is used as the size of the
            // server's per-player stroke arrays (`new Array(numPlayers).fill(0)`
            // in GolfGame's constructor). An unbounded value here is a
            // single-packet OOM. The lobby form only ever emits 2/3/4.
            const playerCountRaw = parseInt(rest[2] ?? "2", 10) || 2;
            const playerCount = Math.max(2, Math.min(playerCountRaw, 4));
            // numberOfTracks isn't an array size today, but the lobby form
            // only emits 1/3/5/9/18 - clamp for defence in depth.
            const numberOfTracksRaw = parseInt(rest[3] ?? "9", 10) || 9;
            const numberOfTracks = Math.max(1, Math.min(numberOfTracksRaw, 18));
            const trackType = parseInt(rest[4] ?? "1", 10) || 0;
            const maxStrokes = parseInt(rest[5] ?? "10", 10) || 10;
            const strokeTimeout = parseInt(rest[6] ?? "60", 10) || 60;
            const water = parseInt(rest[7] ?? "0", 10) || 0;
            const collision = parseInt(rest[8] ?? "1", 10) || 1;
            const scoreSystem = parseInt(rest[9] ?? "0", 10) || 0;
            const weightEnd = parseInt(rest[10] ?? "0", 10) || 0;

            console.log(
                `[lobby] cmpt by ${player.nick}: name="${name}" pwd=${password === "-" ? "no" : "yes"}` +
                    ` players=${playerCount} tracks=${numberOfTracks} trackType=${trackType}` +
                    ` maxStrokes=${maxStrokes} water=${water} collision=${collision}`,
            );
            new MultiGame(
                player,
                server.getNextGameId(),
                name,
                password,
                numberOfTracks,
                perms,
                trackType,
                maxStrokes,
                strokeTimeout,
                water,
                collision,
                scoreSystem,
                weightEnd,
                playerCount,
                server.trackManager,
            );
            return;
        }

        // Join.
        const gameId = parseInt(firstArg, 10);
        const password = rest[0] ?? "-";
        const lobby = player.lobby;
        if (!lobby) return;
        const game = lobby.getGame(gameId);
        if (!game || !(game instanceof MultiGame)) {
            conn.sendData("error", "nosuchgame");
            return;
        }
        game.addPlayerWithPassword(player, password);
    },
});

// Lobby & game chat: say (broadcast), sayp (whisper).
//   client → lobby \t say  \t <text>
//   server → lobby \t say  \t <text> \t <senderNick> \t <senderClan>
//   client → game  \t say  \t <text>
//   server → game  \t say  \t <senderPlayerId> \t <text>
//   client → lobby \t sayp \t <recipient> \t <text>     (whisper)
//   server → lobby \t sayp \t <senderNick> \t <text>     (delivered to recipient)
register({
    type: PacketType.DATA,
    pattern: /^(lobby|game)\t(say|sayp|command)\t(.+?)(?:\t(.+))?$/s,
    handle: (server, conn, match) => {
        const player = conn.player;
        if (!player) return;
        const scope = match[1];
        const verb = match[2];
        const arg3 = match[3];
        const arg4 = match[4];

        // Operator-controlled mute: drop say/sayp and tell the sender once per
        // attempt, so they don't think the connection is broken when nobody
        // sees their message. `command` is a no-op anyway, so don't bother.
        if (!server.chatEnabled && (verb === "say" || verb === "sayp")) {
            conn.sendData(scope, "sayp", "server", "Chat is disabled on this server.");
            return;
        }

        const targets: Player[] = [];
        if (scope === "game") {
            const g = player.game;
            if (!g) return;
            for (const p of g.getPlayers()) targets.push(p);
        } else {
            const lob = player.lobby;
            if (!lob) return;
            for (const p of lob.getPlayers()) targets.push(p);
        }

        if (verb === "say") {
            for (const other of targets) {
                if (other === player) continue;
                if (scope === "game" && player.game) {
                    other.connection.sendData(
                        "game",
                        "say",
                        player.game.getPlayerId(player),
                        arg3,
                    );
                } else {
                    other.connection.sendData("lobby", "say", arg3, player.nick, player.clan);
                }
            }
        } else if (verb === "sayp") {
            const recipient = targets.find((p) => p.nick === arg3);
            if (recipient) {
                recipient.connection.sendData(scope, "sayp", player.nick, arg4 ?? "");
            }
        } else {
            // 'command' - admin commands; not implemented in MVP.
            console.log(`[chat] unhandled command from ${player.nick}: ${arg3} ${arg4 ?? ""}`);
        }
    },
});

// Live aim-preview cursor stream. Pure pass-through: the client throttles to
// ~15 Hz while its ball is at rest, the server stamps the sender's playerId
// and forwards to every other player in the game. Loss-tolerant by design -
// the next tick just overwrites the previous one. Must come BEFORE the generic
// `game .+` handler so the routing isn't swallowed.
//   client → game \t cursor \t <x> \t <y> [\t <shootingMode>]
//   server → game \t cursor \t <playerId> \t <x> \t <y> [\t <shootingMode>]
//
// The shootingMode field is optional for back-compat with senders that don't
// care about the right-click 90° aim feature; relayed verbatim if present.
register({
    type: PacketType.DATA,
    pattern: /^game\tcursor\t(\d+)\t(\d+)(?:\t(\d+))?$/,
    handle: (_server, conn, match) => {
        const player = conn.player;
        if (!player || !player.game) return;
        const game = player.game;
        const playerId = game.getPlayerId(player);
        const body = match[3] !== undefined
            ? tabularize("game", "cursor", playerId, match[1], match[2], match[3])
            : tabularize("game", "cursor", playerId, match[1], match[2]);
        for (const other of game.getPlayers()) {
            if (other === player) continue;
            other.connection.sendDataRaw(body);
        }
    },
});

register({
    type: PacketType.DATA,
    pattern: /^game\t(.+)$/,
    handle: (_server, conn, match) => {
        const player = conn.player;
        if (!player || !player.game) return;
        // Re-split the entire body so the game can read its own fields.
        const fullBody = "game\t" + match[1];
        const fields = fullBody.split("\t");
        player.game.handlePacket(player, fields);
    },
});

// Dispatcher ------------------------------------------------------------------

export function dispatchPacket(server: GolfServer, conn: Connection, packet: Packet): void {
    if (packet.type !== PacketType.COMMAND && packet.type !== PacketType.DATA) {
        // STRING / HEADER / NONE - not used inbound for the MVP exchange.
        return;
    }
    for (const h of handlers) {
        if (h.type !== packet.type) continue;
        const m = h.pattern.exec(packet.raw);
        if (m) {
            h.handle(server, conn, m);
            return;
        }
    }
    console.warn(`[handlers] no match for ${packet.type === PacketType.COMMAND ? "c" : "d"} ${packet.raw}`);
    void tabularize; // mark as used (re-exported below)
}
