// Lobby — port of org.moparforia.server.game.Lobby.
import { tabularize } from "@minigolf/shared";
import type { Player } from "./player.ts";
import type { Game } from "./game.ts";

export const LobbyType = Object.freeze({
    SINGLE: "1",
    DUAL: "2",
    MULTI: "x",
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
        // lobby\tusers[\t<userN>...] — include "lobby\tusers" with no extra tab when empty.
        if (others.length > 0) {
            player.connection.sendDataRaw(tabularize("lobby", "users", ...others));
        } else {
            player.connection.sendDataRaw(tabularize("lobby", "users"));
        }

        // Self ownjoin
        player.connection.sendData("lobby", "ownjoin", player.toString());

        if (this.players.indexOf(player) < 0) {
            this.players.push(player);
        }
        player.lobby = this;

        // Multi-player lobby: send the public game list to the newcomer.
        if (this.type === LobbyType.MULTI) {
            this.sendGameList(player);
        }
        // Send tag-count metadata to populate the lobby form's track-type
        // dropdown labels. Wire form: lobby tagcounts <all> <c1>..<c6>
        // (port extension — Java didn't have this).
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

    /** Send the current public-game list to one player. Mirrors Java Lobby.sendGameList. */
    sendGameList(player: Player): void {
        const fields: (string | number)[] = ["lobby", "gamelist", "full"];
        let count = 0;
        const flat: string[] = [];
        for (const g of this.games.values()) {
            if (g.isPublic) {
                // Each game contributes its 15 game-string fields, then a trailing tab
                // (the Java code appends gameString + "\t" then runs that whole buffer
                // through tabularize as a single arg, which preserves the embedded tabs).
                flat.push(g.getGameString());
            } else {
                continue;
            }
            count++;
        }
        fields.push(count);
        if (flat.length > 0) {
            // Java emits the games concatenated with trailing "\t" — duplicate that exactly.
            fields.push(flat.join("\t") + "\t");
        }
        player.connection.sendDataRaw(tabularize(...fields));
    }

    removePlayer(player: Player, partReason: number, gameName?: string): boolean {
        const idx = this.players.indexOf(player);
        if (idx < 0) return false;
        this.players.splice(idx, 1);

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
}
