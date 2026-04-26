// GolfServer — singleton container for state. Mirrors org.moparforia.server.Server.
import { type Packet, PacketType } from "@minigolf/shared";
import type { Connection } from "./connection.ts";
import { Player } from "./player.ts";
import { Lobby, LobbyType, PartReason } from "./lobby.ts";
import type { TrackManager } from "./tracks.ts";
import { DailyGame } from "./game.ts";
import { dispatchPacket } from "./packet-handlers.ts";
import { logEvent } from "./log.ts";

/** Grace window during which a player can re-attach a fresh WebSocket via
 *  `c old <id>`. Mirrors the value advertised in the connect-handshake banner
 *  (`c crt 250` → 250 seconds). After this elapses we do the original
 *  full-cleanup. */
const RECONNECT_GRACE_MS = 250_000;

/** UTC YYYY-MM-DD — single source of truth for "today". */
export function todayDateKey(): string {
    return new Date().toISOString().slice(0, 10);
}

export interface GolfServerOptions {
    /** When false, lobby/game say + sayp packets are dropped server-side and
     *  the sender gets a one-shot system whisper. Defaults to true. */
    chatEnabled?: boolean;
}

export class GolfServer {
    private players: Map<number, Player> = new Map();
    private lobbies: Map<LobbyType, Lobby> = new Map();
    private nextPlayerIdCounter = 1;
    private nextGameIdCounter = 1;
    private dailyGame: DailyGame | null = null;
    /** Pending grace-window timers for disconnected players, keyed by player id.
     *  A successful `c old <id>` cancels the timer; otherwise it fires after
     *  RECONNECT_GRACE_MS and triggers full cleanup. */
    private reconnectTimers: Map<number, NodeJS.Timeout> = new Map();

    public readonly trackManager: TrackManager;
    public readonly chatEnabled: boolean;

    constructor(trackManager: TrackManager, options: GolfServerOptions = {}) {
        this.trackManager = trackManager;
        this.chatEnabled = options.chatEnabled ?? true;
        this.lobbies.set(LobbyType.SINGLE, new Lobby(LobbyType.SINGLE));
        this.lobbies.set(LobbyType.DUAL, new Lobby(LobbyType.DUAL));
        this.lobbies.set(LobbyType.MULTI, new Lobby(LobbyType.MULTI));
        this.lobbies.set(LobbyType.DAILY, new Lobby(LobbyType.DAILY));
    }

    /**
     * Singleton daily room. Lazily created on first daily-join (so server
     * boot doesn't require tracks to be loaded yet). Rotates its track when
     * the UTC date changes.
     */
    getDailyGame(): DailyGame {
        const today = todayDateKey();
        if (!this.dailyGame) {
            const id = this.getNextGameId();
            this.dailyGame = new DailyGame(id, this.trackManager, today);
            this.getLobby(LobbyType.DAILY).addGame(this.dailyGame);
        } else {
            this.dailyGame.rotateIfNewDay(today);
        }
        return this.dailyGame;
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

    /** Live count of player records held by the server. Used by the periodic
     *  analytics snapshot in main.ts. */
    playerCount(): number {
        return this.players.size;
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
        // Belt-and-suspenders: if this connection has been swapped (via
        // `handleReconnect`) it's no longer the player's live socket — the
        // close event is just the old socket's death rattle, ignore it so we
        // don't tear down the player record we just rescued.
        if (player.connection !== conn) return;

        // Mid-game disconnect: peers are waiting on this player's `endstroke`,
        // so we can't keep them logically present. Fall through to immediate
        // cleanup as before. (Reconnect mid-game is a deferred follow-up — see
        // KNOWN_ISSUES.)
        if (player.game) {
            this.fullyRemovePlayer(player, "in_game");
            return;
        }

        // Lobby/lobbyselect: defer cleanup so a brief network blip doesn't
        // cost the player their lobby slot. Cancelled by `handleReconnect`.
        const existing = this.reconnectTimers.get(player.id);
        if (existing) clearTimeout(existing);
        player.disconnectedAt = Date.now();
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(player.id);
            // Re-check: a successful reconnect would have cleared
            // `disconnectedAt` and replaced `player.connection`.
            if (this.players.get(player.id) !== player) return;
            if (player.disconnectedAt === null) return;
            console.log(`[reconnect] grace expired for ${player.id}/${player.nick}`);
            this.fullyRemovePlayer(player, "grace_expired");
        }, RECONNECT_GRACE_MS);
        // Don't keep the event loop alive solely on this timer — the smoke
        // tests close their server cleanly and rely on natural process exit;
        // a 250s pending grace would hang them.
        timer.unref();
        this.reconnectTimers.set(player.id, timer);
    }

    private fullyRemovePlayer(player: Player, reason: string): void {
        if (player.game) {
            const lob = player.lobby;
            try {
                player.game.removePlayer(player);
            } catch {
                // ignore
            }
            if (player.game?.isEmpty() && lob) {
                lob.removeGame(player.game);
            }
        }
        if (player.lobby) {
            try {
                player.lobby.removePlayer(player, PartReason.CONN_PROBLEM);
            } catch {
                // ignore
            }
        }
        this.removePlayer(player.id);
        player.disconnectedAt = null;
        logEvent("player_disconnect", { id: player.id, nick: player.nick, reason });
    }

    /**
     * Re-attach `conn` to the player record identified by `id`, if still
     * within the grace window. Returns true on success (caller should send
     * `c rcok`); false if no such player or no grace pending (caller should
     * send `c rcf`).
     *
     * Both directions of the seq counter reset to 0 on the new connection
     * (the new Connection's defaults), which the client matches on `c rcok`.
     * We don't try to replay/dedup packets sent during the gap — anything the
     * server pushed during the dead window is lost. This is the same trade
     * the original Java applet effectively made (its retain-seq protocol
     * tripped its own gap-detection on any peer broadcast during the blip).
     */
    handleReconnect(conn: Connection, id: number): boolean {
        const player = this.players.get(id);
        if (!player || player.disconnectedAt === null) return false;
        const timer = this.reconnectTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(id);
        }
        player.disconnectedAt = null;
        player.connection = conn;
        conn.player = player;
        // The new Connection's outSeq/inSeq are 0 by construction; no reset
        // needed here. Client mirrors this on receipt of `c rcok`.
        console.log(`[reconnect] reattached ${id}/${player.nick}`);
        logEvent("player_reconnect", { id, nick: player.nick });
        return true;
    }

    // re-export for convenience in connection
    static isData(p: Packet): boolean {
        return p.type === PacketType.DATA;
    }
}
