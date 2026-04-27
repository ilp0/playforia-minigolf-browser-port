// Game base + GolfGame + TrainingGame. Ports Game.java / GolfGame.java / TrainingGame.java.
import { tabularize, type Track } from "@minigolf/shared";
import type { Player } from "./player.ts";
import type { Lobby } from "./lobby.ts";
import { JoinType, PartReason, LobbyType } from "./lobby.ts";
import {
    networkSerialize,
    trackCategoryByTypeId,
    type TrackCategoryId,
    type TrackManager,
    type TrackStats,
} from "./tracks.ts";
import { logEvent } from "./log.ts";

export const STROKES_UNLIMITED = 0;
export const STROKETIMEOUT_INFINITE = 0;
export const COLLISION_NO = 0;
export const COLLISION_YES = 1;
export const SCORING_STROKE = 0;
export const SCORING_TRACK = 1;
export const SCORING_WEIGHT_END_NONE = 0;

export const PERM_EVERYONE = 0;
export const PERM_REGISTERED = 1;
export const PERM_VIP = 2;

export abstract class Game {
    protected players: Player[] = [];
    public numberIndex = 0;
    public playersNumber: number[] = [];
    protected wantsGameCount = 0;
    protected confirmCount = 0;
    public isPublic = true;

    public readonly gameId: number;
    public readonly lobbyType: LobbyType;
    public readonly name: string;
    public readonly password: string | null;
    public readonly passworded: boolean;

    constructor(
        gameId: number,
        lobbyType: LobbyType,
        name: string,
        password: string | null,
        passworded: boolean,
    ) {
        this.gameId = gameId;
        this.lobbyType = lobbyType;
        this.name = name;
        this.password = password;
        this.passworded = passworded;
    }

    playerCount(): number {
        return this.players.length;
    }

    getPlayers(): readonly Player[] {
        return this.players;
    }

    isEmpty(): boolean {
        return this.players.length === 0;
    }

    getPlayerId(p: Player): number {
        return this.playersNumber[this.players.indexOf(p)];
    }

    addPlayer(player: Player): boolean {
        if (this.players.includes(player)) return false;
        if (player.lobby !== null) {
            // Single-player branch only: we always leave with STARTED_SP.
            const reason = PartReason.STARTED_SP;
            player.lobby.removePlayer(player, reason);
        }
        this.sendJoinMessages(player);
        this.players.push(player);
        this.playersNumber.push(this.numberIndex);
        this.numberIndex++;
        player.game = this;
        logEvent("game_join", {
            game_id: this.gameId,
            lobby: this.lobbyType,
            id: player.id,
            nick: player.nick,
            players: this.players.length,
        });
        return true;
    }

    /**
     * Remove a player from the game and broadcast `game part <id> <reason>` to
     * the rest. `reason` follows the Java codes consumed by GamePanel:
     *   4 = USERLEFT (voluntary back / `back` packet)
     *   5 = CONN_PROBLEM (grace expired after disconnect)
     *   6 = SWITCHEDLOBBY (silent — client just nulls the name)
     * Defaults to USERLEFT so the back-button path keeps its existing wire.
     */
    removePlayer(player: Player, reason: number = PartReason.USERLEFT): boolean {
        const idx = this.players.indexOf(player);
        if (idx < 0) return false;
        const num = this.playersNumber[idx];
        for (const p of this.players) {
            if (p !== player) p.connection.sendData("game", "part", num, reason);
        }
        this.playersNumber.splice(idx, 1);
        this.players.splice(idx, 1);
        return true;
    }

    protected sendJoinMessages(player: Player): void {
        this.sendGameInfo(player);
        this.sendPlayerNames(player);
        // Broadcast join to existing players (none for single-player on first add).
        // Wire: `game join <newPlayerOrdinal> <nick> <clan>`. The client treats
        // the ordinal as 1-based and subtracts 1 to get its slot index. The new
        // player's actual id will be `numberIndex` (assigned right after this
        // by `addPlayer`), so the correct 1-based ordinal is `numberIndex + 1`.
        // In the daily room sparse ids accumulate (a finisher who left still
        // owns a slot in playStatus), so `playerCount() + 1` would target a
        // lower index than the joiner's real id and overwrite an existing
        // player's nick on the recipients' scoreboards.
        for (const p of this.players) {
            if (p !== player) {
                p.connection.sendData("game", "join", this.numberIndex + 1, player.nick, player.clan);
            }
        }
        // Self owninfo — Java sends `numberIndex` BEFORE incrementing, so first player sees 0.
        player.connection.sendData("game", "owninfo", this.numberIndex, player.nick, player.clan);
    }

    protected sendPlayerNames(player: Player): void {
        // Java: tabularize("game","players") then for each *other* player append "\t<id>\t<nick>\t<clan>".
        const parts: (string | number)[] = ["game", "players"];
        for (const p of this.players) {
            if (p !== player) {
                parts.push(this.getPlayerId(p), p.nick, p.clan);
            }
        }
        player.connection.sendDataRaw(tabularize(...parts));
    }

    protected writeAll(body: string): void {
        for (const p of this.players) p.connection.sendDataRaw(body);
    }

    protected writeExcluding(exclude: Player, body: string): void {
        for (const p of this.players) if (p !== exclude) p.connection.sendDataRaw(body);
    }

    protected endGame(): void {
        this.writeAll(tabularize("game", "end"));
        logEvent("game_end", {
            game_id: this.gameId,
            lobby: this.lobbyType,
            players: this.players.length,
        });
    }

    abstract sendGameInfo(player: Player): void;
    abstract startGame(): void;
    abstract handlePacket(player: Player, fields: string[]): boolean;
    abstract getGameString(): string;

    /** Public access for handlers / lobby broadcasting. */
    public broadcast(body: string): void {
        this.writeAll(body);
    }
    public broadcastExcept(player: Player, body: string): void {
        this.writeExcluding(player, body);
    }
}

export class GolfGame extends Game {
    public tracks: Track[];
    protected playStatus = "";
    protected currentTrack = 0;
    protected strokeCounter = 0;
    /**
     * Server-side per-stroke seed counter. Increments on every beginstroke;
     * the value is broadcast to all clients so they can construct identical
     * Seed instances and compute identical physics.
     */
    protected strokeSeedCounter = 0;
    public playerStrokesThisTrack: number[];
    public playerStrokesTotal: number[];

    public numberOfTracks: number;
    public perms: number;
    public tracksType: number;
    public maxStrokes: number;
    public strokeTimeout: number;
    public waterEvent: number;
    public collision: number;
    public trackScoring: number;
    public trackScoringEnd: number;
    public numPlayers: number;
    protected trackManager: TrackManager;

    constructor(
        gameId: number,
        lobbyType: LobbyType,
        name: string,
        password: string | null,
        passworded: boolean,
        numberOfTracks: number,
        perms: number,
        tracksType: number,
        maxStrokes: number,
        strokeTimeout: number,
        waterEvent: number,
        collision: number,
        trackScoring: number,
        trackScoringEnd: number,
        numPlayers: number,
        trackManager: TrackManager,
    ) {
        super(gameId, lobbyType, name, password, passworded);
        this.numberOfTracks = numberOfTracks;
        this.perms = perms;
        this.tracksType = tracksType;
        this.maxStrokes = maxStrokes;
        this.strokeTimeout = strokeTimeout;
        this.waterEvent = waterEvent;
        this.collision = collision;
        this.trackScoring = trackScoring;
        this.trackScoringEnd = trackScoringEnd;
        this.numPlayers = numPlayers;
        this.trackManager = trackManager;
        this.playerStrokesThisTrack = new Array<number>(numPlayers).fill(0);
        this.playerStrokesTotal = new Array<number>(numPlayers).fill(0);
        this.tracks = this.initTracks();
    }

    protected initTracks(): Track[] {
        const cat: TrackCategoryId = trackCategoryByTypeId(this.tracksType);
        return this.trackManager.getRandomTracks(this.numberOfTracks, cat);
    }

    sendGameInfo(player: Player): void {
        player.connection.sendData("status", "game");
        player.connection.sendData(
            "game",
            "gameinfo",
            this.name,
            this.passworded, // -> "t"/"f"
            this.gameId,
            this.numPlayers,
            this.tracks.length,
            this.tracksType,
            this.maxStrokes,
            this.strokeTimeout,
            this.waterEvent,
            this.collision,
            this.trackScoring,
            this.trackScoringEnd,
            "f",
        );
    }

    startGame(): void {
        this.writeAll(tabularize("game", "start"));

        const buff = "t".repeat(this.players.length);
        this.playStatus = buff.replace(/t/g, "f");

        const stats: TrackStats = this.trackManager.getStats(this.tracks[0]);

        this.writeAll(tabularize("game", "resetvoteskip"));
        // game\tstarttrack\t<playStatus>\t<gameId>\t<networkSerialize>
        // Async play: no `startturn` follows; clients can shoot whenever their own
        // ball is at rest. The strokeSeedCounter resets per track so each new
        // track's strokes start from seed 0 (combined with gameId for entropy).
        this.strokeSeedCounter = 0;
        this.writeAll(tabularize("game", "starttrack", buff, this.gameId, networkSerialize(stats)));
    }

    handlePacket(player: Player, fields: string[]): boolean {
        // fields are tab-split. Java GameHandler regex captures (verb, optionalCoords, optionalStatus).
        // fields[0] === "game".
        if (fields.length < 2) return false;
        const verb = fields[1];

        switch (verb) {
            case "beginstroke": {
                // wire (async multi): game\tbeginstroke\t<ballCoords>\t<mouseCoords>
                const ballCoords = fields[2] ?? "";
                const mouseCoords = fields[3] ?? ballCoords;
                this.beginStroke(player, ballCoords, mouseCoords);
                return true;
            }
            case "endstroke": {
                // Wire form: game\tendstroke\t<playerId>\t<playStatus>
                const newPlayStatus = fields[3] ?? this.playStatus;
                this.endStroke(player, newPlayStatus);
                return true;
            }
            case "voteskip":
            case "voteski":
            case "skip":
            case "ski":
                this.voteSkip(player);
                return true;
            case "forfeit":
                // Async-mode "give up on this hole": cap player's strokes,
                // mark them DNF for the current track, advance if everyone done.
                this.forfeit(player);
                return true;
            case "newgame":
                this.wantsNewGame(player);
                return true;
            case "back": {
                this.removePlayer(player);
                if (this.isEmpty() && player.lobby) {
                    player.lobby.removeGame(this);
                }
                if (player.lobby) {
                    player.lobby.addPlayer(player, JoinType.FROMGAME);
                } else {
                    // Lobby was nulled when the game was created — fall back via server next turn.
                }
                player.game = null;
                return true;
            }
            default:
                return false;
        }
    }

    /**
     * Server assigns a unique seed for THIS stroke and broadcasts to all clients
     * (including the shooter). Each client constructs `Seed(seed)` and runs
     * identical physics, guaranteeing every client sees the same trajectory.
     *
     *   wire: client → server  : game beginstroke <ballCoords> <mouseCoords>
     *         server → all     : game beginstroke <playerId> <ballCoords> <mouseCoords> <seed>
     */
    protected beginStroke(p: Player, ballCoords: string, mouseCoords: string): void {
        const playerId = this.getPlayerId(p);
        // Defensive guard: ignore begin from a player whose ball is already in
        // play or already in the hole.
        if (this.playStatus.charAt(playerId) !== "f") return;
        this.strokeSeedCounter++;
        // 32-bit composite — distinct per (game, stroke) so all clients pick
        // up a fresh independent random stream.
        const seed = ((this.gameId & 0xffff) << 16) | (this.strokeSeedCounter & 0xffff);
        this.writeAll(tabularize("game", "beginstroke", playerId, ballCoords, mouseCoords, seed));
    }

    /**
     * Async endstroke: each player reports their own ball's outcome the moment
     * it stops. We update their stroke count, mark them in the playStatus, and
     * broadcast a fresh per-player update so every client's scoreboard agrees.
     * Once all live players are either holed or skipped, advance the track.
     *
     *   wire: client → server  : game endstroke <playerId> <playStatus>
     *           (we trust only their OWN char of the playStatus; shooter sees the
     *            board through their own eyes but we authoritatively own the rest)
     *         server → all     : game endstroke <playerId> <strokesThisTrack> <inHole>
     */
    protected endStroke(player: Player, newPlayStatus: string): void {
        const id = this.getPlayerId(player);
        const myStatus = newPlayStatus.charAt(id);
        // Bump stroke count for this player.
        this.playerStrokesThisTrack[id] = (this.playerStrokesThisTrack[id] ?? 0) + 1;

        // Update authoritative playStatus with this player's char (only).
        const psArr = this.playStatus.split("");
        while (psArr.length < this.players.length) psArr.push("f");

        let resolvedStatus: "t" | "p" | "f" =
            myStatus === "t" || myStatus === "p" ? myStatus : "f";

        // Enforce maxStrokes: if a player hits the cap without holing, they're
        // out for this hole (status "p" = passed/skipped, like Java's voteSkip).
        if (
            resolvedStatus === "f" &&
            this.maxStrokes > 0 &&
            this.playerStrokesThisTrack[id] >= this.maxStrokes
        ) {
            resolvedStatus = "p";
        }
        psArr[id] = resolvedStatus;
        this.playStatus = psArr.join("");

        // Broadcast scoreboard update.
        this.writeAll(
            tabularize(
                "game",
                "endstroke",
                id,
                this.playerStrokesThisTrack[id],
                resolvedStatus === "t" ? "t" : resolvedStatus === "p" ? "p" : "f",
            ),
        );

        // If this stroke just finished the player, the set of unfinished
        // players shrank — clear any pending skip votes so the survivors can
        // re-vote (or use the skip button as a solo-forfeit when only one
        // player is left mid-track). Skipped on `nextTrack` paths because that
        // already broadcasts its own `resetvoteskip`.
        if (resolvedStatus !== "f" && !this.allDoneOnCurrentTrack()) {
            this.resetSkipVotesIfAny();
        }

        if (this.allDoneOnCurrentTrack()) this.nextTrack();
    }

    /**
     * Async forfeit: a player gives up on the current hole. Their stroke count
     * is set to maxStrokes (or current+1 if no cap), they're marked status 'p'
     * (passed), and the track advances if everyone is now done.
     */
    protected forfeit(player: Player): void {
        const id = this.getPlayerId(player);
        if (!this.players[id]) return;
        // Already done — ignore.
        const cur = this.playStatus.charAt(id);
        if (cur === "t" || cur === "p") return;

        const cap = this.maxStrokes > 0 ? this.maxStrokes : this.playerStrokesThisTrack[id] + 1;
        this.playerStrokesThisTrack[id] = cap;

        const psArr = this.playStatus.split("");
        while (psArr.length < this.players.length) psArr.push("f");
        psArr[id] = "p";
        this.playStatus = psArr.join("");

        this.writeAll(tabularize("game", "endstroke", id, cap, "p"));

        if (!this.allDoneOnCurrentTrack()) this.resetSkipVotesIfAny();

        if (this.allDoneOnCurrentTrack()) this.nextTrack();
    }

    /**
     * Clear all `hasSkipped` flags and broadcast `resetvoteskip` if anyone
     * had voted. No-op if nobody had voted, so it's safe to call eagerly
     * whenever the unfinished-player set shrinks.
     */
    private resetSkipVotesIfAny(): void {
        let any = false;
        for (const p of this.players) {
            if (p.hasSkipped) {
                p.hasSkipped = false;
                any = true;
            }
        }
        if (any) this.writeAll(tabularize("game", "resetvoteskip"));
    }

    private allDoneOnCurrentTrack(): boolean {
        for (const c of this.playStatus) {
            if (c === "f") return false;
        }
        return true;
    }

    protected getNextPlayer(playStatus: string): number {
        this.strokeCounter++;
        const player = this.strokeCounter % this.players.length;
        if (playStatus.charAt(player) === "t") {
            return this.getNextPlayer(playStatus);
        }
        return this.playersNumber[this.strokeCounter % this.players.length];
    }

    protected voteSkip(p: Player): void {
        p.hasSkipped = true;
        this.writeExcluding(p, tabularize("game", "voteskip", this.getPlayerId(p)));
        for (const player of this.players) {
            if (!player.hasSkipped && this.playStatus.charAt(this.getPlayerId(player)) === "f") return;
        }
        // Vote passed — cap any player still mid-track at the stroke limit
        // (mirroring `forfeit`). Players already holed ('t') or forfeited ('p')
        // keep their actual score; only those still in 'f' get the max.
        const psArr = this.playStatus.split("");
        while (psArr.length < this.players.length) psArr.push("f");
        for (let i = 0; i < this.players.length; i++) {
            if (psArr[i] !== "f") continue;
            const cap = this.maxStrokes > 0 ? this.maxStrokes : this.playerStrokesThisTrack[i] + 1;
            this.playerStrokesThisTrack[i] = cap;
            psArr[i] = "p";
            this.writeAll(tabularize("game", "endstroke", i, cap, "p"));
        }
        this.playStatus = psArr.join("");
        this.nextTrack();
    }

    protected wantsNewGame(p: Player): void {
        this.wantsGameCount++;
        this.writeExcluding(p, tabularize("game", "rfng", this.getPlayerId(p)));
        if (this.wantsGameCount >= this.players.length) {
            this.wantsGameCount = 0;
            this.reset();
            this.startGame();
        }
    }

    protected reset(): void {
        this.currentTrack = 0;
        this.playerStrokesThisTrack = new Array<number>(this.players.length).fill(0);
        this.playerStrokesTotal = new Array<number>(this.players.length).fill(0);
        this.strokeCounter = 0;
        this.tracks = this.initTracks();
    }

    /**
     * 15-field game string used in lobby gamelist packets. Mirrors Java
     * GolfGame.getGameString.
     *
     * Field 5 (formerly the always-`-1` legacy slot) is repurposed as an
     * "in-progress" flag: `1` once the game has started (`!isPublic`),
     * `0` while it is still waiting / practicing. Old clients that ignored
     * the field keep working; new clients use it to badge running rooms.
     */
    override getGameString(): string {
        return tabularize(
            this.gameId,
            this.name,
            this.passworded,
            this.perms,
            this.numPlayers,
            this.isPublic ? 0 : 1,
            this.tracks.length,
            this.tracksType,
            this.maxStrokes,
            this.strokeTimeout,
            this.waterEvent,
            this.collision,
            this.trackScoring,
            this.trackScoringEnd,
            this.players.length,
        );
    }

    protected nextTrack(): void {
        this.strokeCounter = 0;
        this.currentTrack++;
        for (let i = 0; i < this.players.length; i++) {
            this.playerStrokesTotal[i] += this.playerStrokesThisTrack[i];
        }
        if (this.currentTrack < this.tracks.length) {
            const stats = this.trackManager.getStats(this.tracks[this.currentTrack]);
            const buff = "t".repeat(this.players.length);
            for (let i = 0; i < this.players.length; i++) {
                this.playerStrokesThisTrack[i] = 0;
                this.players[i].hasSkipped = false;
            }
            this.playStatus = buff.replace(/t/g, "f");
            this.strokeSeedCounter = 0;
            this.writeAll(tabularize("game", "resetvoteskip"));
            this.writeAll(tabularize("game", "starttrack", buff, this.gameId, networkSerialize(stats)));
        } else {
            this.endGame();
        }
    }
}

/**
 * Daily-challenge game — singleton room held by the server. Plays a single
 * deterministic track for the day; everyone in the room sees each other's
 * balls (existing async-MP broadcast already gives "ghost" semantics, since
 * other players' beginstroke packets are relayed to all and each client sims
 * each ball with its own seed).
 *
 * Differences from MultiGame:
 *   - Joining is allowed at any time, no fill-to-start.
 *   - `numTracks = 1`. After all players finish that one track, the room
 *     stays alive for late joiners.
 *   - When THIS player finishes (holes-in or forfeits), they get a personal
 *     `game end` so the share dialog can appear; the room continues for others.
 *   - On `back`, the player is sent straight to `lobbyselect` (no daily lobby
 *     panel exists on the client).
 *   - On a date roll-over, the track is swapped and per-player counters reset
 *     so today's players see today's track.
 */
/**
 * Hard cap on the daily room's sparse-id growth. `numberIndex` only resets
 * when the room fully empties; if the room never empties (one player always
 * present as new ones cycle in), `playerStrokesThisTrack` / `playerStrokesTotal`
 * grow unboundedly. Capping `numberIndex` at this value bounds those arrays
 * at ~4KB each while still permitting many hundreds of cycles per day.
 */
const DAILY_MAX_SPARSE_IDS = 256;

export class DailyGame extends GolfGame {
    public dateKey: string;
    private dailyTrackManager: TrackManager;

    constructor(gameId: number, trackManager: TrackManager, dateKey: string) {
        super(
            gameId,
            LobbyType.DAILY,
            "Daily Cup",
            null,
            false,
            1,                             // numberOfTracks
            PERM_EVERYONE,
            0,                             // tracksType (ALL — daily picks deterministically)
            0,                             // maxStrokes (unlimited; forfeit always available)
            STROKETIMEOUT_INFINITE,
            0,                             // waterEvent
            COLLISION_NO,
            SCORING_STROKE,
            SCORING_WEIGHT_END_NONE,
            100,                           // numPlayers — effectively unbounded room cap
            trackManager,
        );
        this.dateKey = dateKey;
        this.dailyTrackManager = trackManager;
        // Replace the random-pick tracks with today's deterministic one.
        this.tracks = [trackManager.getDailyTrack(dateKey)];
        // Initial playStatus for an empty room.
        this.playStatus = "";
        this.isPublic = false;
        logEvent("game_create", {
            game_id: gameId,
            kind: "daily",
            date: dateKey,
        });
    }

    /** Swap track for the new UTC day if needed; reset per-player counters. */
    rotateIfNewDay(currentDateKey: string): void {
        if (this.dateKey === currentDateKey) return;
        this.dateKey = currentDateKey;
        this.tracks = [this.dailyTrackManager.getDailyTrack(currentDateKey)];
        for (let i = 0; i < this.players.length; i++) {
            this.playerStrokesThisTrack[i] = 0;
            this.playerStrokesTotal[i] = 0;
        }
        this.strokeSeedCounter = 0;
        this.playStatus = "f".repeat(this.players.length);
        // Re-broadcast a fresh starttrack so everyone resets to spawn.
        this.broadcastStartTrack();
    }

    /** Late-join entry. Called from the daily-select handler. */
    joinDaily(player: Player): void {
        if (this.players.includes(player)) return;
        // Singleton room: previous occupants leave incremented `numberIndex`
        // and finished `playStatus` chars ('t'/'p') behind. A fresh joiner into
        // an empty room must start from id 0 with a 'f' slot, otherwise the
        // beginstroke gate (`playStatus.charAt(playerId) === 'f'`) silently
        // rejects every shot they try to take.
        if (this.players.length === 0) {
            this.numberIndex = 0;
            this.playStatus = "";
            this.strokeSeedCounter = 0;
            for (let i = 0; i < this.playerStrokesThisTrack.length; i++) {
                this.playerStrokesThisTrack[i] = 0;
                this.playerStrokesTotal[i] = 0;
            }
        } else if (this.numberIndex >= DAILY_MAX_SPARSE_IDS) {
            // Sparse-id cap reached and room still has occupants. Refusing
            // the join keeps memory bounded; the player stays in the daily
            // lobby and can retry once the room next empties.
            return;
        }
        // super.addPlayer broadcasts `game join` to existing players, sends
        // gameInfo/players/owninfo to the newcomer, and pushes the slot.
        this.addPlayer(player);
        // After addPlayer, this.numberIndex == newId + 1. Grow the per-id
        // arrays / playStatus to that length, NOT players.length: ids are
        // sparse (a finisher who later leaves still owned a slot in
        // playStatus), so padding only to players.length leaves the joiner's
        // own slot off the end and beginstroke silently rejects them.
        const idCapacity = this.numberIndex;
        while (this.playerStrokesThisTrack.length < idCapacity) {
            this.playerStrokesThisTrack.push(0);
            this.playerStrokesTotal.push(0);
        }
        if (this.playStatus.length < idCapacity) {
            this.playStatus = this.playStatus.padEnd(idCapacity, "f");
        }
        // Personal starttrack so the newcomer renders the map.
        const stats = this.dailyTrackManager.getStats(this.tracks[0]);
        const buff = "f".repeat(this.players.length);
        player.connection.sendDataRaw(tabularize("game", "start"));
        player.connection.sendDataRaw(tabularize("game", "resetvoteskip"));
        player.connection.sendDataRaw(
            tabularize("game", "starttrack", buff, this.gameId, networkSerialize(stats)),
        );
        // Tell the client to render this game in daily mode (ghosts, share
        // overlay on end, etc.). Sent after starttrack so the panel is ready.
        player.connection.sendDataRaw(tabularize("game", "dailymode", this.dateKey));
    }

    /** Re-broadcast starttrack to everyone (used after a day rotation). */
    private broadcastStartTrack(): void {
        const stats = this.dailyTrackManager.getStats(this.tracks[0]);
        const buff = "f".repeat(this.players.length);
        this.writeAll(tabularize("game", "resetvoteskip"));
        this.writeAll(
            tabularize("game", "starttrack", buff, this.gameId, networkSerialize(stats)),
        );
    }

    /** Single track only — no auto-advance. */
    protected override nextTrack(): void {
        // No-op.
    }

    /** Standard endStroke logic, then send a personal `game end` to finishers. */
    protected override endStroke(player: Player, newPlayStatus: string): void {
        const id = this.getPlayerId(player);
        const myStatus = newPlayStatus.charAt(id);
        this.playerStrokesThisTrack[id] = (this.playerStrokesThisTrack[id] ?? 0) + 1;
        const psArr = this.playStatus.split("");
        while (psArr.length < this.players.length) psArr.push("f");
        const resolvedStatus: "t" | "p" | "f" =
            myStatus === "t" || myStatus === "p" ? myStatus : "f";
        psArr[id] = resolvedStatus;
        this.playStatus = psArr.join("");
        this.writeAll(
            tabularize("game", "endstroke", id, this.playerStrokesThisTrack[id], resolvedStatus),
        );
        if (resolvedStatus === "t" || resolvedStatus === "p") {
            // Tell only this player their daily run is over (others keep playing).
            player.connection.sendData("game", "end");
            logEvent("daily_play_end", {
                date: this.dateKey,
                id: player.id,
                nick: player.nick,
                strokes: this.playerStrokesThisTrack[id],
                holed: resolvedStatus === "t",
                forfeited: resolvedStatus === "p",
            });
        }
    }

    protected override forfeit(player: Player): void {
        const id = this.getPlayerId(player);
        if (!this.players[id]) return;
        const cur = this.playStatus.charAt(id);
        if (cur === "t" || cur === "p") return;
        const cap = (this.playerStrokesThisTrack[id] ?? 0) + 1;
        this.playerStrokesThisTrack[id] = cap;
        const psArr = this.playStatus.split("");
        while (psArr.length < this.players.length) psArr.push("f");
        psArr[id] = "p";
        this.playStatus = psArr.join("");
        this.writeAll(tabularize("game", "endstroke", id, cap, "p"));
        player.connection.sendData("game", "end");
        logEvent("daily_play_end", {
            date: this.dateKey,
            id: player.id,
            nick: player.nick,
            strokes: cap,
            holed: false,
            forfeited: true,
        });
    }

    override handlePacket(player: Player, fields: string[]): boolean {
        if (fields.length >= 2 && fields[1] === "back") {
            this.removePlayer(player);
            // No daily lobby panel — bounce straight to lobbyselect.
            player.connection.sendData("status", "lobbyselect", "300");
            player.game = null;
            return true;
        }
        return super.handlePacket(player, fields);
    }

    /**
     * The configured `numPlayers` is a soft cap (100); reporting that to a
     * newcomer would make their client allocate 100 empty scoreboard rows.
     * Report `players.length + 1` instead — the realistic room size right
     * after this player joins. The subsequent `starttrack` (whose `playStatus`
     * length is authoritative) corrects this further.
     */
    override sendGameInfo(player: Player): void {
        player.connection.sendData("status", "game");
        player.connection.sendData(
            "game",
            "gameinfo",
            this.name,
            this.passworded,
            this.gameId,
            this.players.length + 1,
            this.tracks.length,
            this.tracksType,
            this.maxStrokes,
            this.strokeTimeout,
            this.waterEvent,
            this.collision,
            this.trackScoring,
            this.trackScoringEnd,
            "f",
        );
    }
}

export class TrainingGame extends GolfGame {
    constructor(
        player: Player,
        gameId: number,
        tracksType: number,
        numberOfTracks: number,
        water: number,
        trackManager: TrackManager,
    ) {
        super(
            gameId,
            LobbyType.SINGLE,
            "derp",
            null,
            false,
            numberOfTracks,
            PERM_EVERYONE,
            tracksType,
            STROKES_UNLIMITED,
            STROKETIMEOUT_INFINITE,
            water,
            COLLISION_YES,
            SCORING_STROKE,
            SCORING_WEIGHT_END_NONE,
            1,
            trackManager,
        );

        logEvent("game_create", {
            game_id: gameId,
            kind: "training",
            tracks: numberOfTracks,
            track_type: tracksType,
            water,
            creator_id: player.id,
        });

        const lob: Lobby | null = player.lobby;
        if (this.addPlayer(player)) {
            if (lob) lob.addGame(this);
            this.startGame();
        }
    }
}

/**
 * Multi-player golf — port of org.moparforia.server.game.gametypes.golf.MultiGame.
 *
 * Lifecycle:
 *   1. Constructor: creator joins; lobby broadcasts `lobby gamelist add <gameString>`.
 *   2. Each subsequent join broadcasts `lobby gamelist change <gameString>`.
 *   3. When playerCount === numPlayers, the game starts: lobby broadcasts
 *      `lobby gamelist remove <gameId>` and game broadcasts `game start`.
 *   4. Players left during play continue with each other; the game ends when
 *      all tracks are complete or all players leave.
 *
 * Browser-port extension: **practice mode**. While the room is still waiting
 * for players to fill, anyone in the room can press the Practice button to
 * start a shared run of random tracks that auto-cycle on each hole-in. Late
 * joiners drop into the current practice track. When the last player joins,
 * practice ends and the configured tracks list is played from track 1 — the
 * existing `startGame()` flow runs untouched.
 */
export class MultiGame extends GolfGame {
    /** True between `game practice` request and the real-game `startGame()`. */
    public practiceActive = false;
    /** The map currently in play during practice. Replaced on every hole-in. */
    private practiceTrack: Track | null = null;
    constructor(
        creator: Player,
        gameId: number,
        name: string,
        password: string,
        numberOfTracks: number,
        perms: number,
        tracksType: number,
        maxStrokes: number,
        strokeTimeout: number,
        waterEvent: number,
        collision: number,
        trackScoring: number,
        trackScoringEnd: number,
        numPlayers: number,
        trackManager: TrackManager,
    ) {
        const passworded = !(password === "-" || password === "");
        super(
            gameId,
            LobbyType.MULTI,
            name,
            passworded ? password : null,
            passworded,
            numberOfTracks,
            perms,
            tracksType,
            maxStrokes,
            strokeTimeout,
            waterEvent,
            collision,
            trackScoring,
            trackScoringEnd,
            numPlayers,
            trackManager,
        );

        logEvent("game_create", {
            game_id: gameId,
            kind: "multi",
            tracks: numberOfTracks,
            track_type: tracksType,
            num_players: numPlayers,
            max_strokes: maxStrokes,
            collision,
            passworded,
            creator_id: creator.id,
        });

        // Add creator first.
        const lobby = creator.lobby;
        this.addPlayerWithPassword(creator, password);
        if (lobby) {
            lobby.writeAll(tabularize("lobby", "gamelist", "add", this.getGameString()));
            lobby.addGame(this);
        }
    }

    /**
     * Public-facing add: validates password, broadcasts game-list updates, and
     * starts the game when full. Returns false if the password is wrong (in which
     * case the player is bounced back to the lobby).
     */
    addPlayerWithPassword(player: Player, password: string): boolean {
        const lobby = player.lobby;
        if (this.passworded && password !== this.password) {
            // Wrong password — back to the lobby.
            if (lobby) {
                lobby.addPlayer(player, JoinType.FROMGAME);
                player.connection.sendData("error", "wrongpassword");
            }
            return false;
        }
        if (!this.addPlayer(player)) return false;

        if (lobby && this.players.length > 1) {
            // Update game-list entry (player count changed).
            lobby.writeAll(tabularize("lobby", "gamelist", "change", this.getGameString()));
        }

        if (this.isPublic && this.players.length === this.numPlayers) {
            // Room just filled for the first time — kick the real game off.
            // `startGame()` clears any active practice state so the configured
            // track list is what plays. Re-broadcast `gamelist change` so the
            // inProgress flag flips for everyone in the lobby (the room stays
            // visible — we no longer drop it from the list on fill so vacated
            // slots can be refilled later).
            this.isPublic = false;
            if (lobby) {
                lobby.writeAll(tabularize("lobby", "gamelist", "change", this.getGameString()));
            }
            this.startGame();
        } else if (!this.isPublic) {
            // Game already running — catch the late joiner up to the current
            // track. `addPlayer` already broadcast `game join` to the rest;
            // they keep playing untouched.
            this.sendCurrentTrackTo(player);
        } else if (this.practiceActive) {
            // Late joiner during practice — drop them into the current track.
            this.sendPracticeTrackTo(player);
        }
        return true;
    }

    /**
     * Catch-up packet sequence for a player who joined a started game with a
     * free slot. Walks them through the same `start` / `resetvoteskip` /
     * `starttrack` trio existing players saw at the start of this track,
     * stamps `gametrack` so their HUD reads "Track N/M" matching the room,
     * and replays per-slot `endstroke` packets so peers who already finished
     * the current track render correctly on the joiner's scoreboard.
     *
     * Per-track stroke counts for prior tracks aren't recoverable — the
     * server doesn't keep per-track history per slot, only the rolling
     * `playerStrokesTotal`. The joiner's scoreboard renders prior columns
     * as "—" via the client's `holeScores[t] === undefined` branch.
     */
    private sendCurrentTrackTo(player: Player): void {
        const slotId = this.getPlayerId(player);

        // Pad / overwrite the joiner's slot to fresh.
        const psArr = this.playStatus.split("");
        while (psArr.length <= slotId) psArr.push("f");
        psArr[slotId] = "f";
        this.playStatus = psArr.join("");

        const track = this.tracks[this.currentTrack];
        if (!track) return;
        const stats = this.trackManager.getStats(track);
        const buff = "f".repeat(this.playStatus.length);

        player.connection.sendDataRaw(tabularize("game", "start"));
        player.connection.sendDataRaw(tabularize("game", "resetvoteskip"));
        player.connection.sendDataRaw(
            tabularize("game", "starttrack", buff, this.gameId, networkSerialize(stats)),
        );
        // Tell the joiner which configured track this is so their HUD reads
        // "Track N/M" matching the room rather than "Track 1/M".
        player.connection.sendDataRaw(
            tabularize("game", "gametrack", this.currentTrack + 1),
        );

        // Replay completion state for peers who already finished this track.
        for (let i = 0; i < this.playStatus.length; i++) {
            if (i === slotId) continue;
            const status = this.playStatus.charAt(i);
            if (status === "t" || status === "p") {
                const strokes = this.playerStrokesThisTrack[i] ?? 0;
                player.connection.sendDataRaw(
                    tabularize("game", "endstroke", i, strokes, status),
                );
            }
        }
    }

    /**
     * Begin (or ignore if already running) shared practice mode. Picks a
     * random track from the room's configured category and broadcasts a
     * `game start`/`starttrack` pair to everyone currently in the room. New
     * joiners get a personal version of the same broadcast via
     * `sendPracticeTrackTo`. The configured `this.tracks` list is left
     * untouched — `sendGameInfo`'s `numTracks` and the eventual real-game
     * track sequence both keep working.
     *
     * No-op if the real game has already started (`!this.isPublic`).
     */
    startPractice(): void {
        if (this.practiceActive) return;
        if (!this.isPublic) return;

        const cat: TrackCategoryId = trackCategoryByTypeId(this.tracksType);
        const picked = this.trackManager.getRandomTracks(1, cat);
        if (picked.length === 0) return;

        this.practiceActive = true;
        this.practiceTrack = picked[0];
        this.strokeCounter = 0;
        this.strokeSeedCounter = 0;
        for (let i = 0; i < this.playerStrokesThisTrack.length; i++) {
            this.playerStrokesThisTrack[i] = 0;
            this.playerStrokesTotal[i] = 0;
        }
        for (const p of this.players) p.hasSkipped = false;

        const buff = "f".repeat(this.players.length);
        this.playStatus = buff;
        const stats = this.trackManager.getStats(this.practiceTrack);
        this.writeAll(tabularize("game", "start"));
        this.writeAll(tabularize("game", "resetvoteskip"));
        this.writeAll(
            tabularize("game", "starttrack", buff, this.gameId, networkSerialize(stats)),
        );
        // Tell clients to render this as practice (HUD shows "Practice", no
        // per-hole columns). Sent after `starttrack` so the panel has the
        // track loaded by the time it flips into practice mode.
        this.writeAll(tabularize("game", "practicemode", "t"));
        logEvent("practice_start", {
            game_id: this.gameId,
            players: this.players.length,
            track: this.practiceTrack.name,
        });
    }

    /**
     * Drop a single player into the currently-running practice track. Pads
     * `playStatus` to cover their slot, sends them the same `start` /
     * `resetvoteskip` / `starttrack` / `practicemode` sequence existing
     * players already saw, and replays per-slot `endstroke` packets so any
     * peers who already finished the current track render correctly on the
     * joiner's scoreboard.
     */
    private sendPracticeTrackTo(player: Player): void {
        if (!this.practiceTrack) return;

        const slotId = this.getPlayerId(player);
        const psArr = this.playStatus.split("");
        while (psArr.length <= slotId) psArr.push("f");
        // Joiner is fresh on the current track regardless of what was there.
        psArr[slotId] = "f";
        this.playStatus = psArr.join("");

        const buff = "f".repeat(this.playStatus.length);
        const stats = this.trackManager.getStats(this.practiceTrack);
        player.connection.sendDataRaw(tabularize("game", "start"));
        player.connection.sendDataRaw(tabularize("game", "resetvoteskip"));
        player.connection.sendDataRaw(
            tabularize("game", "starttrack", buff, this.gameId, networkSerialize(stats)),
        );
        player.connection.sendDataRaw(tabularize("game", "practicemode", "t"));

        // Replay completion state for peers who already finished this track.
        for (let i = 0; i < this.playStatus.length; i++) {
            if (i === slotId) continue;
            const status = this.playStatus.charAt(i);
            if (status === "t" || status === "p") {
                const strokes = this.playerStrokesThisTrack[i] ?? 0;
                player.connection.sendDataRaw(
                    tabularize("game", "endstroke", i, strokes, status),
                );
            }
        }
    }

    /** During practice each hole-in / forfeit-all advances to a fresh random
     *  track instead of walking through `this.tracks`. */
    protected override nextTrack(): void {
        if (!this.practiceActive) {
            super.nextTrack();
            return;
        }
        const cat: TrackCategoryId = trackCategoryByTypeId(this.tracksType);
        const picked = this.trackManager.getRandomTracks(1, cat);
        if (picked.length === 0) return;
        this.practiceTrack = picked[0];
        this.strokeCounter = 0;
        this.strokeSeedCounter = 0;
        for (let i = 0; i < this.players.length; i++) {
            const slot = this.playersNumber[i];
            this.playerStrokesThisTrack[slot] = 0;
            this.players[i].hasSkipped = false;
        }
        const buff = "f".repeat(this.playStatus.length);
        this.playStatus = buff;
        const stats = this.trackManager.getStats(this.practiceTrack);
        this.writeAll(tabularize("game", "resetvoteskip"));
        this.writeAll(
            tabularize("game", "starttrack", buff, this.gameId, networkSerialize(stats)),
        );
    }

    /** Real-game start. Wipes any practice residue (track ref + per-player
     *  stroke counters incremented during practice) before delegating to the
     *  base `GolfGame.startGame`. The base broadcasts `game start`, which the
     *  client uses to drop back into normal-mode rendering. */
    override startGame(): void {
        if (this.practiceActive) {
            this.practiceActive = false;
            this.practiceTrack = null;
            for (let i = 0; i < this.playerStrokesThisTrack.length; i++) {
                this.playerStrokesThisTrack[i] = 0;
                this.playerStrokesTotal[i] = 0;
            }
            this.strokeCounter = 0;
        }
        super.startGame();
    }

    /** Inject the `practice` verb before falling through to the standard
     *  GolfGame handler. Practice can only start while the room is still
     *  open (`isPublic`) — the request is ignored otherwise. */
    override handlePacket(player: Player, fields: string[]): boolean {
        if (fields.length >= 2 && fields[1] === "practice") {
            this.startPractice();
            return true;
        }
        return super.handlePacket(player, fields);
    }

    /**
     * MultiGame join — reuses the lowest unoccupied slot id (0..numPlayers-1)
     * so a leaver's slot is reclaimed by the next joiner, and broadcasts
     * `game join` exactly once with that id.
     *
     * The base `Game.addPlayer` always assigns the new player `numberIndex`,
     * which only ever grows — so after any prior leave a fresh joiner takes a
     * sparse high id while the old slot stays vacant. That breaks two things
     * for MultiGame:
     *   1. The per-slot stroke arrays (`playerStrokesThisTrack/Total`) are
     *      sized to `numPlayers` in the constructor — sparse ids past that
     *      cap fall off the end.
     *   2. The base also calls `sendJoinMessages` which broadcasts `game join`
     *      with `numberIndex + 1`. When the original `MultiGame` layer ALSO
     *      broadcast a join with `playerCount() + 1`, the two ordinals diverged
     *      after a leave and existing clients ended up with the joiner appearing
     *      at TWO scoreboard rows — sometimes overwriting an unrelated active
     *      player. (See #39 root cause.)
     *
     * The override below picks a single dense id and uses it consistently for
     * the broadcast, the owninfo, and the `playersNumber` push.
     */
    override addPlayer(player: Player): boolean {
        if (this.players.includes(player)) return false;

        // Lowest free slot id within the room's hard cap.
        let slotId = 0;
        while (slotId < this.numPlayers && this.playersNumber.includes(slotId)) {
            slotId++;
        }
        if (slotId >= this.numPlayers) return false;

        // Detach from the lobby with the right MULTI-flavoured reason. The
        // base Game.addPlayer would use STARTED_SP here, which surfaces a
        // misleading "joined single-player" event in `lobby_leave` analytics.
        if (player.lobby !== null) {
            const reason = this.players.length === 0 ? PartReason.CREATED_MP : PartReason.JOINED_MP;
            player.lobby.removePlayer(player, reason, this.name);
        }

        // Send join messages BEFORE adding the player so writeAll loops below
        // don't include the joiner.
        this.sendGameInfo(player);
        this.sendPlayerNames(player);
        const joinBody = tabularize("game", "join", slotId + 1, player.nick, player.clan);
        for (const p of this.players) {
            p.connection.sendDataRaw(joinBody);
        }
        player.connection.sendData("game", "owninfo", slotId, player.nick, player.clan);

        this.players.push(player);
        this.playersNumber.push(slotId);
        if (slotId >= this.numberIndex) this.numberIndex = slotId + 1;
        player.game = this;

        logEvent("game_join", {
            game_id: this.gameId,
            lobby: this.lobbyType,
            id: player.id,
            nick: player.nick,
            players: this.players.length,
        });
        return true;
    }

    override removePlayer(player: Player, reason: number = PartReason.USERLEFT): boolean {
        if (!this.players.includes(player)) return false;
        const wasPublic = this.isPublic;
        const wasPracticing = this.practiceActive;
        const playerNum = this.getPlayerId(player);
        super.removePlayer(player, reason);

        if (this.playStatus.length > playerNum) {
            // Don't let the leaver's `'f'` slot trap survivors waiting on a
            // ball that's never going to roll. Stamp the slot 'p' (passed)
            // so `allDoneOnCurrentTrack` sees only still-present players
            // as needing to finish; advance the track if they all did.
            // Applies to both practice and real games — a vacated slot
            // should never block progression for whoever's still here.
            const cur = this.playStatus.charAt(playerNum);
            if (cur === "f") {
                const psArr = this.playStatus.split("");
                psArr[playerNum] = "p";
                this.playStatus = psArr.join("");
                if (this.players.length > 0) {
                    let allDone = true;
                    for (const c of this.playStatus) {
                        if (c === "f") { allDone = false; break; }
                    }
                    if (allDone) this.nextTrack();
                }
            }
        }

        if (wasPracticing && this.players.length === 0) {
            // Room emptied mid-practice — drop the practice ref so a future
            // re-use of this object (none today, defensive) doesn't leak.
            this.practiceActive = false;
            this.practiceTrack = null;
        }

        const lobby = player.lobby;
        if (this.players.length > 0) {
            if (!wasPublic) {
                // Game was in progress — pick the first remaining player to shoot.
                this.broadcast(tabularize("game", "startturn", this.playersNumber[0] ?? 0));
            }
            if (lobby) {
                // Always update the gamelist row so the freed slot is visible
                // to lobby-side joiners (covers both waiting and in-progress
                // games — full rooms now stay in the list and shrink back to
                // joinable when someone leaves).
                lobby.writeAll(tabularize("lobby", "gamelist", "change", this.getGameString()));
            }
        } else if (lobby) {
            lobby.writeAll(tabularize("lobby", "gamelist", "remove", String(this.gameId)));
            lobby.removeGame(this);
        }
        return true;
    }
}
