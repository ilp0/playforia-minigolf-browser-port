// Lobby - port of org.moparforia.server.game.Lobby.
import { tabularize } from "@minigolf/shared";
import type { Player } from "./player.ts";
import type { Game } from "./game.ts";
import { logEvent } from "./log.ts";

export const LobbyType = Object.freeze({
    SINGLE: "1",
    DUAL: "2",
    MULTI: "x",
    DAILY: "d",
} as const);

export type LobbyType = (typeof LobbyType)[keyof typeof LobbyType];

export const PartReason = Object.freeze({
    STARTED_SP: 1,
    CREATED_MP: 2,
    JOINED_MP: 3,
    USERLEFT: 4,
    CONN_PROBLEM: 5,
    SWITCHEDLOBBY: 6,
} as const);

/** Human-readable names for `PartReason` codes - used by the analytics
 *  `lobby_leave` event so consumers don't have to remember the numbers. */
const PART_REASON_NAME: Record<number, string> = {
    1: "started_sp",
    2: "created_mp",
    3: "joined_mp",
    4: "userleft",
    5: "conn_problem",
    6: "switchedlobby",
};

export const JoinType = Object.freeze({
    NORMAL: 0,
    FROMGAME: 1,
} as const);

export class Lobby {
    private players: Player[] = [];
    private games: Map<number, Game> = new Map();

    public readonly type: LobbyType;

    constructor(type: LobbyType) {
        this.type = type;
    }

    playerCount(): number {
        return this.players.length;
    }

    getPlayers(): readonly Player[] {
        return this.players;
    }

    /** Players in the lobby plus all players in games created from this lobby. */
    totalPlayerCount(): number {
        let inGames = 0;
        for (const g of this.games.values()) {
            inGames += g.playerCount();
        }
        return this.players.length + inGames;
    }

    addPlayer(player: Player, joinType: number = JoinType.NORMAL): boolean {
        if (player.lobby !== null) {
            player.lobby.removePlayer(player, PartReason.USERLEFT);
        }

        // status\tlobby\t<typeChar>[h]
        const lobbyTag = this.type + (player.isChatHidden ? "h" : "");
        player.connection.sendData("status", "lobby", lobbyTag);

        // For each existing player, broadcast join to them and accumulate user list for newcomer.
        const verb = joinType === JoinType.NORMAL ? "join" : "joinfromgame";
        const others: string[] = [];
        for (const p of this.players) {
            p.connection.sendData("lobby", verb, player.toString());
            others.push(p.toString());
        }
        // lobby\tusers[\t<userN>...] - include "lobby\tusers" with no extra tab when empty.
        if (others.length > 0) {
            player.connection.sendDataRaw(tabularize("lobby", "users", ...others));
        } else {
            player.connection.sendDataRaw(tabularize("lobby", "users"));
        }

        // Self ownjoin
        player.connection.sendData("lobby", "ownjoin", player.toString());

        const wasPresent = this.players.indexOf(player) >= 0;
        if (!wasPresent) {
            this.players.push(player);
        }
        player.lobby = this;
        if (!wasPresent) {
            logEvent("lobby_join", {
                id: player.id,
                nick: player.nick,
                lobby: this.type,
                from_game: joinType !== JoinType.NORMAL,
            });
        }

        // Multi-player lobby: send the public game list to the newcomer.
        if (this.type === LobbyType.MULTI) {
            this.sendGameList(player);
        }
        // Send tag-count metadata to populate the lobby form's track-type
        // dropdown labels. Wire form: lobby tagcounts <all> <c1>..<c6>
        // (port extension - Java didn't have this).
        if (this.tagCountsBody !== null) {
            player.connection.sendDataRaw(this.tagCountsBody);
        }
        return true;
    }

    /**
     * Cache the "lobby tagcounts ..." body so we can blast it cheaply on every
     * join. Set once at server boot when the TrackManager has finished loading.
     */
    private tagCountsBody: string | null = null;
    setTagCounts(counts: readonly number[]): void {
        this.tagCountsBody = tabularize("lobby", "tagcounts", ...counts);
    }

    /** Broadcast a raw "data" body (already tabularized) to every player in the lobby. */
    writeAll(body: string): void {
        for (const p of this.players) p.connection.sendDataRaw(body);
    }

    /**
     * Send the multiplayer game list to one player. Mirrors Java
     * Lobby.sendGameList. Today this is only called for `LobbyType.MULTI`,
     * which contains exclusively MultiGame rooms - full and ongoing rooms
     * are included so the player can see what's happening across the lobby
     * (and join any room with a free slot, including ones that filled
     * earlier and have since freed a seat).
     */
    sendGameList(player: Player): void {
        const fields: (string | number)[] = ["lobby", "gamelist", "full"];
        let count = 0;
        const flat: string[] = [];
        for (const g of this.games.values()) {
            // Each game contributes its 15 game-string fields. The
            // `inProgress` flag in field 5 lets the client decide whether
            // to render a "(In progress)" badge / disable Join.
            flat.push(g.getGameString());
            count++;
        }
        fields.push(count);
        if (flat.length > 0) {
            // Java emits the games concatenated with trailing "\t" - duplicate that exactly.
            fields.push(flat.join("\t") + "\t");
        }
        player.connection.sendDataRaw(tabularize(...fields));
    }

    removePlayer(player: Player, partReason: number, gameName?: string): boolean {
        const idx = this.players.indexOf(player);
        if (idx < 0) return false;
        this.players.splice(idx, 1);
        logEvent("lobby_leave", {
            id: player.id,
            nick: player.nick,
            lobby: this.type,
            reason: PART_REASON_NAME[partReason] ?? String(partReason),
        });

        // Broadcast lobby\tpart\t<nick>\t<reason>[\t<gameName>] to remaining players.
        const parts: (string | number)[] = ["lobby", "part", player.nick, partReason];
        if (partReason === PartReason.JOINED_MP && gameName) {
            parts.push(gameName);
        }
        const body = tabularize(...parts);
        for (const p of this.players) p.connection.sendDataRaw(body);

        if (partReason === PartReason.USERLEFT) {
            player.connection.sendData("status", "lobbyselect", "300");
        }
        // NB: do NOT null `player.lobby` here. The Java original keeps the
        // back-reference sticky so that `Game.handlePacket("back")` can return
        // the player to their lobby via `player.lobby.addPlayer(player, FROMGAME)`.
        // The `lobby.players` list itself is the source of truth for "who is here".
        return true;
    }

    addGame(g: Game): boolean {
        if (this.games.has(g.gameId)) return false;
        this.games.set(g.gameId, g);
        return true;
    }

    removeGame(g: Game): boolean {
        return this.games.delete(g.gameId);
    }

    hasGame(id: number): boolean {
        return this.games.has(id);
    }

    getGame(id: number): Game | undefined {
        return this.games.get(id);
    }

    /** Live count of games hosted by this lobby. Used by the periodic
     *  analytics snapshot in main.ts. */
    gameCount(): number {
        return this.games.size;
    }

    /** Total players across the games hosted by this lobby (excludes players
     *  still sitting in the lobby itself). Used by the snapshot. */
    inGamePlayerCount(): number {
        let n = 0;
        for (const g of this.games.values()) n += g.playerCount();
        return n;
    }
}
