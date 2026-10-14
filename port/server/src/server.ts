import { configureMatchReplayPortal } from './match-replays.ts';
// GolfServer - singleton container for state. Mirrors org.moparforia.server.Server.
import { type Packet, PacketType } from "@minigolf/shared";
import type { Connection } from "./connection.ts";
import { Player } from "./player.ts";
import { Lobby, LobbyType, PartReason } from "./lobby.ts";
import type { TrackManager } from "./tracks.ts";
import { DailyGame } from "./game.ts";
import { dispatchPacket } from "./packet-handlers.ts";
import { logEvent } from "./log.ts";
import { type DailyRecord, type PortalConfig, recordDailyResult } from "./portal.ts";

/** Grace window during which a player can re-attach a fresh WebSocket via
 *  `c old <id>`. Mirrors the value advertised in the connect-handshake banner
 *  (`c crt 250` → 250 seconds). After this elapses we do the original
 *  full-cleanup. */
const RECONNECT_GRACE_MS = 250_000;

/** UTC YYYY-MM-DD - single source of truth for "today". */
export function todayDateKey(): string {
    return new Date().toISOString().slice(0, 10);
}

export interface GolfServerOptions {
    /** When false, lobby/game say + sayp packets are dropped server-side and
     *  the sender gets a one-shot system whisper. Defaults to true. */
    chatEnabled?: boolean;
    /** Aapeli portal integration; null/absent keeps the standalone behaviour. */
    portal?: PortalConfig | null;
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
    public readonly portal: PortalConfig | null;

    constructor(trackManager: TrackManager, options: GolfServerOptions = {}) {
        this.trackManager = trackManager;
        this.chatEnabled = options.chatEnabled ?? true;
        this.portal = options.portal ?? null;
        configureMatchReplayPortal(this.portal);
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
            if (this.portal) this.dailyGame.onFinish = (player, record) => this.reportDaily(player, record);
        } else {
            this.dailyGame.rotateIfNewDay(today);
        }
        // Re-register on every access. `fullyRemovePlayer` unregisters the game
        // when the room empties via mid-game disconnect, but the singleton
        // itself lives on; without re-adding here, `daily_lobby.gameCount()`,
        // `inGamePlayerCount()`, and `totalPlayerCount()` perpetually report 0
        // even when subsequent joiners are sitting in the daily room - breaking
        // both the analytics snapshot and the lobbyselect "Daily Cup: N players"
        // display. `addGame` is idempotent (no-op if already registered).
        this.getLobby(LobbyType.DAILY).addGame(this.dailyGame);
        return this.dailyGame;
    }

    /** Save a finished daily run to the player's portal account and tell
     *  the client the outcome (`game dailyrecord <status>`). */
    private reportDaily(player: Player, record: DailyRecord): void {
        const portal = this.portal;
        const identity = player.portalIdentity;
        if (!portal || !identity) return;
        void recordDailyResult(portal, identity, record).then((status) => {
            logEvent("daily_record", { date: record.date, id: player.id, status });
            if (player.disconnectedAt === null) player.connection.sendData("game", "dailyrecord", status);
        });
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
        // `handleReconnect`) it's no longer the player's live socket - the
        // close event is just the old socket's death rattle, ignore it so we
        // don't tear down the player record we just rescued.
        if (player.connection !== conn) return;

        // Defer cleanup for everyone (lobby, lobbyselect, mid-game) so a
        // brief network blip doesn't cost the player their seat. Mid-game
        // gets the same 250s grace window the connect-handshake banner
        // advertises; without this, peers' simulation would have to wait on
        // a player who silently dropped while their slot stays 'f' in
        // playStatus. We mark `disconnectedAt` BEFORE the per-game hook so
        // the pacing checks (`allDoneOnCurrentTrack`, `nextEligibleTurn`,
        // `assignFirstTurn`, `voteSkip`) treat this player's 'f' slot as
        // reserved-but-skippable for the rest of this hole.
        const existing = this.reconnectTimers.get(player.id);
        if (existing) clearTimeout(existing);
        player.disconnectedAt = Date.now();
        if (player.game) {
            try {
                player.game.handlePlayerDisconnect(player);
            } catch (err) {
                console.error("[disconnect] handlePlayerDisconnect failed:", err);
            }
        }
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(player.id);
            // Re-check: a successful reconnect would have cleared
            // `disconnectedAt` and replaced `player.connection`.
            if (this.players.get(player.id) !== player) return;
            if (player.disconnectedAt === null) return;
            console.log(`[reconnect] grace expired for ${player.id}/${player.nick}`);
            this.fullyRemovePlayer(player, "grace_expired");
        }, RECONNECT_GRACE_MS);
        // Don't keep the event loop alive solely on this timer - the smoke
        // tests close their server cleanly and rely on natural process exit;
        // a 250s pending grace would hang them.
        timer.unref();
        this.reconnectTimers.set(player.id, timer);
    }

    private fullyRemovePlayer(player: Player, reason: string): void {
        if (player.game) {
            const lob = player.lobby;
            // Disconnect-driven removal: peers see "Connection problem or closed
            // browser" rather than the voluntary-leave phrasing. Voluntary exits
            // travel through game.handlePacket "back", which calls
            // game.removePlayer() without an override and stays on reason 4.
            try {
                player.game.removePlayer(player, PartReason.CONN_PROBLEM);
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
        logEvent("player_disconnect", {
            id: player.id,
            nick: player.nick,
            reason,
            cid: player.connection.clientId,
            conn: player.connection.connId,
        });
    }

    /**
     * Re-attach `conn` to the player record identified by `id`, if still
     * within the grace window. Returns true on success (caller should send
     * `c rcok`); false if no such player or no grace pending (caller should
     * send `c rcf`).
     *
     * Both directions of the seq counter reset to 0 on the new connection
     * (the new Connection's defaults), which the client matches on `c rcok`.
     * We don't try to replay/dedup packets sent during the gap - anything the
     * server pushed during the dead window is lost. This is the same trade
     * the original Java applet effectively made (its retain-seq protocol
     * tripped its own gap-detection on any peer broadcast during the blip).
     */
    handleReconnect(conn: Connection, id: number): boolean {
        const player = this.players.get(id);
        if (!player || player.disconnectedAt === null) return false;
        // With the portal enabled, only the same portal profile may adopt a
        // seat; otherwise any client could guess an id and take it over.
        if (player.portalIdentity && conn.portalIdentity?.profileId !== player.portalIdentity.profileId) {
            return false;
        }
        const timer = this.reconnectTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(id);
        }
        player.disconnectedAt = null;
        // Carry the persistent client id forward onto the new socket. The
        // transparent reconnect protocol (`c old <id>`) doesn't re-send the
        // `cid` packet, so without this the post-reattach socket's
        // `clientId` would stay null and analytics on the same browser
        // would look like two distinct identities across a network blip.
        if (conn.clientId === null && player.connection.clientId !== null) {
            conn.clientId = player.connection.clientId;
        }
        // The write capability moves with the seat; the dead socket keeps none.
        conn.matchRecording = player.connection.matchRecording;
        conn.replayResuming = conn.matchRecording !== null;
        player.connection.matchRecording = null;
        player.connection = conn;
        conn.player = player;
        // The new Connection's outSeq/inSeq are 0 by construction; no reset
        // needed here. Client mirrors this on receipt of `c rcok`.
        console.log(`[reconnect] reattached ${id}/${player.nick}`);
        // The reattached socket carries its own cid (the client re-sent it on
        // the new connection's `cid` packet - or, for a same-tab transparent
        // reconnect that happens before login, the new conn has a fresh cid
        // that will be filled later). Either way, log against `conn.clientId`
        // (the new socket) and `conn.connId` (the new socket id) so the trail
        // shows the post-reattach identity.
        logEvent("player_reconnect", {
            id,
            nick: player.nick,
            cid: conn.clientId,
            conn: conn.connId,
        });
        // Per-game post-reconnect resync. Currently only GolfGame uses it
        // (tracktick → recalibrate worldTick). No-op when player is in a
        // lobby (player.game === null), which is the only path supported
        // today; the call is here so adding mid-game grace later just needs
        // the relevant subclass override - not new wiring.
        if (player.game) {
            try {
                player.game.sendReconnectResync(player);
            } catch (err) {
                console.error("[reconnect] resync failed:", err);
            }
        }
        // A later new game must start a new recording, even if resync sent no start packet.
        conn.replayResuming = false;
        return true;
    }

    // re-export for convenience in connection
    static isData(p: Packet): boolean {
        return p.type === PacketType.DATA;
    }
}
