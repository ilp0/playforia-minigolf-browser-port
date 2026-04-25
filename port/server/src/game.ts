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
        return true;
    }

    removePlayer(player: Player): boolean {
        const idx = this.players.indexOf(player);
        if (idx < 0) return false;
        // game\tpart\t<numberIndex>\t<reason=4>
        const num = this.playersNumber[idx];
        for (const p of this.players) {
            if (p !== player) p.connection.sendData("game", "part", num, 4);
        }
        this.playersNumber.splice(idx, 1);
        this.players.splice(idx, 1);
        return true;
    }

    protected sendJoinMessages(player: Player): void {
        this.sendGameInfo(player);
        this.sendPlayerNames(player);
        // Broadcast join to existing players (none for single-player on first add).
        for (const p of this.players) {
            if (p !== player) {
                p.connection.sendData("game", "join", this.playerCount(), player.nick, player.clan);
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

        if (this.allDoneOnCurrentTrack()) this.nextTrack();
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

    /** 15-field game string used in lobby gamelist packets. Mirrors Java GolfGame.getGameString. */
    override getGameString(): string {
        return tabularize(
            this.gameId,
            this.name,
            this.passworded,
            this.perms,
            this.numPlayers,
            -1,
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
 */
export class MultiGame extends GolfGame {
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
        // Broadcast `game join` to existing players BEFORE adding the new one.
        this.broadcast(tabularize("game", "join", this.playerCount(), player.nick, player.clan));
        this.addPlayer(player);

        if (lobby && this.players.length > 1) {
            // Update game-list entry (player count changed).
            lobby.writeAll(tabularize("lobby", "gamelist", "change", this.getGameString()));
        }
        if (this.players.length === this.numPlayers) {
            // Game just filled — kick it off.
            this.isPublic = false;
            if (lobby) {
                lobby.writeAll(tabularize("lobby", "gamelist", "remove", String(this.gameId)));
            }
            this.startGame();
        }
        return true;
    }

    override removePlayer(player: Player): boolean {
        if (!this.players.includes(player)) return false;
        const wasPublic = this.isPublic;
        const playerNum = this.getPlayerId(player);
        super.removePlayer(player);

        const lobby = player.lobby;
        if (this.players.length > 0) {
            if (!wasPublic) {
                // Game was in progress — pick the first remaining player to shoot.
                this.broadcast(tabularize("game", "startturn", this.playersNumber[0] ?? 0));
            } else if (lobby) {
                // Still in the lobby phase — update the visible player count.
                lobby.writeAll(tabularize("lobby", "gamelist", "change", this.getGameString()));
            }
        } else if (lobby) {
            lobby.writeAll(tabularize("lobby", "gamelist", "remove", String(this.gameId)));
            lobby.removeGame(this);
        }
        // Touch playerNum so TS doesn't whine.
        void playerNum;
        return true;
    }
}
