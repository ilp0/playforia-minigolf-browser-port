// GolfServer — singleton container for state. Mirrors org.moparforia.server.Server.
import { type Packet, PacketType } from "@minigolf/shared";
import type { Connection } from "./connection.ts";
import { Player } from "./player.ts";
import { Lobby, LobbyType } from "./lobby.ts";
import type { TrackManager } from "./tracks.ts";
import { dispatchPacket } from "./packet-handlers.ts";

export class GolfServer {
    private players: Map<number, Player> = new Map();
    private lobbies: Map<LobbyType, Lobby> = new Map();
    private nextPlayerIdCounter = 1;
    private nextGameIdCounter = 1;

    public readonly trackManager: TrackManager;

    constructor(trackManager: TrackManager) {
        this.trackManager = trackManager;
        this.lobbies.set(LobbyType.SINGLE, new Lobby(LobbyType.SINGLE));
        this.lobbies.set(LobbyType.DUAL, new Lobby(LobbyType.DUAL));
        this.lobbies.set(LobbyType.MULTI, new Lobby(LobbyType.MULTI));
    }

    getNextPlayerId(): number {
        return this.nextPlayerIdCounter++;
    }

    getNextGameId(): number {
        return this.nextGameIdCounter++;
    }

    addPlayer(p: Player): void {
        this.players.set(p.id, p);
    }

    removePlayer(id: number): void {
        this.players.delete(id);
    }

    getPlayer(id: number): Player | undefined {
        return this.players.get(id);
    }

    getLobby(type: LobbyType): Lobby {
        const l = this.lobbies.get(type);
        if (!l) throw new Error(`unknown lobby type: ${type}`);
        return l;
    }

    /** Called from Connection on each parsed packet. Routes via the regex registry. */
    dispatch(conn: Connection, packet: Packet): void {
        try {
            dispatchPacket(this, conn, packet);
        } catch (err) {
            console.error("[server] dispatch error:", err);
            conn.close("dispatch-error");
        }
    }

    handleDisconnect(conn: Connection): void {
        const player = conn.player;
        if (!player) return;
        if (player.game) {
            // For MVP just remove the game when its sole player disconnects.
            const lob = player.lobby;
            try {
                player.game.removePlayer(player);
            } catch {
                // ignore
            }
            if (player.game.isEmpty() && lob) {
                lob.removeGame(player.game);
            }
        }
        if (player.lobby) {
            try {
                player.lobby.removePlayer(player, /*PartReason.CONN_PROBLEM*/ 5);
            } catch {
                // ignore
            }
        }
        this.removePlayer(player.id);
    }

    // re-export for convenience in connection
    static isData(p: Packet): boolean {
        return p.type === PacketType.DATA;
    }
}
