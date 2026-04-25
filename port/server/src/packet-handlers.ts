// Regex-based packet dispatch. Mirrors PacketHandlerFactory + the individual
// PacketHandler implementations from org.moparforia.server.net.packethandlers.

import { type Packet, PacketType, tabularize } from "@minigolf/shared";
import type { Connection } from "./connection.ts";
import type { GolfServer } from "./server.ts";
import { Player } from "./player.ts";
import { JoinType, LobbyType } from "./lobby.ts";
import { MultiGame, TrainingGame } from "./game.ts";

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
        // Java sends "c id <id>\n" — the trailing \n is the TCP framing terminator we don't need.
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
        if (conn.player) conn.player.language = match[1];
    },
});

register({
    type: PacketType.DATA,
    pattern: /^logintype\t(nr|reg|ttm)$/,
    handle: (_server, conn) => {
        conn.sendData("status", "login");
    },
});

register({
    type: PacketType.DATA,
    pattern: /^login$/,
    handle: (_server, conn) => {
        const player = conn.player;
        if (!player) {
            conn.close("login-without-player");
            return;
        }
        const username = `~anonym-${Math.floor(Math.random() * 10000)}`;
        player.nick = username;
        player.emailVerified = true;
        player.registered = false;
        // basicinfo\t<emailVerified>\t<accessLevel>\tt\tt
        conn.sendData("basicinfo", player.emailVerified, player.accessLevel, "t", "t");
        conn.sendData("status", "lobbyselect", "300");
    },
});

register({
    type: PacketType.DATA,
    pattern: /^lobbyselect\t(rnop|select|qmpt)(?:\t([12x])(h)?)?$/,
    handle: (server, conn, match) => {
        const sub = match[1];
        const player = conn.player;
        if (!player) return;
        if (sub === "rnop") {
            const single = server.getLobby(LobbyType.SINGLE).totalPlayerCount();
            const dual = server.getLobby(LobbyType.DUAL).totalPlayerCount();
            const multi = server.getLobby(LobbyType.MULTI).totalPlayerCount();
            conn.sendData("lobbyselect", "nop", single, dual, multi);
        } else if (sub === "select") {
            const tag = match[2];
            if (!tag) return;
            player.isChatHidden = match[3] === "h";
            const lobbyType = (Object.values(LobbyType) as string[]).includes(tag)
                ? (tag as LobbyType)
                : null;
            if (!lobbyType) return;
            server.getLobby(lobbyType).addPlayer(player, JoinType.NORMAL);
        } else if (sub === "qmpt") {
            player.isChatHidden = match[3] === "h";
            server.getLobby(LobbyType.MULTI).addPlayer(player, JoinType.NORMAL);
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
            const playerCount = parseInt(rest[2] ?? "2", 10) || 2;
            const numberOfTracks = parseInt(rest[3] ?? "9", 10) || 9;
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
    handle: (_server, conn, match) => {
        const player = conn.player;
        if (!player) return;
        const scope = match[1];
        const verb = match[2];
        const arg3 = match[3];
        const arg4 = match[4];

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
            // 'command' — admin commands; not implemented in MVP.
            console.log(`[chat] unhandled command from ${player.nick}: ${arg3} ${arg4 ?? ""}`);
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
        // STRING / HEADER / NONE — not used inbound for the MVP exchange.
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
