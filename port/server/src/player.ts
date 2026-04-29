// Player record. Mirrors Java org.moparforia.server.game.Player.
import { triangelize } from "@minigolf/shared";
import type { Connection } from "./connection.ts";
import type { Lobby } from "./lobby.ts";
import type { Game } from "./game.ts";

export const ACCESSLEVEL_NORMAL = 0;
export const ACCESSLEVEL_SHERIFF = 1;
export const ACCESSLEVEL_ADMIN = 2;

export type GameType = "GOLF" | null;

export class Player {
    nick = "-";
    language: string | null = null;
    profileUrl = "-";
    avatarUrl = "-";
    /**
     * Java initializes clan to "-" in resetVals, but ChatHandler.tableizes the empty string by default for
     * lobby presentation; toString below handles null-safe rendering.
     */
    clan = "-";
    accessLevel = ACCESSLEVEL_NORMAL;
    ranking = 0;
    emailVerified = false;
    registered = false;
    vip = false;
    sheriff = false;
    notAcceptingChallenges = false;
    isChatHidden = false;
    hasSkipped = false;

    lobby: Lobby | null = null;
    game: Game | null = null;
    gameType: GameType = null;

    /** Mutable so `GolfServer.handleReconnect` can swap in the post-reconnect
     *  WebSocket without disturbing peer-broadcast paths (everywhere else in
     *  the codebase reaches sends via `player.connection.send*`). */
    public connection: Connection;
    public readonly id: number;

    /** When non-null, the player's WS is currently disconnected and a
     *  grace-window timer is running; a `c old <id>` from a fresh socket
     *  within the window will adopt this player. Cleared on reconnect.
     *  Owned by `GolfServer.handleDisconnect` / `handleReconnect`. */
    disconnectedAt: number | null = null;

    constructor(connection: Connection, id: number) {
        this.connection = connection;
        this.id = id;
    }

    /** Faithful port of Player.toString from Java - caret-joined with the "3:" nick prefix. */
    toString(): string {
        let tmp = "";
        if (this.registered) tmp += "r";
        if (this.vip) tmp += "v";
        if (this.sheriff) tmp += "s";
        if (this.notAcceptingChallenges) tmp += "n";
        const lang = this.language !== null ? this.language : "-";
        return triangelize(
            "3:" + (this.nick !== null ? this.nick : ""),
            tmp === "" ? "w" : tmp,
            this.ranking,
            lang,
            this.profileUrl !== null ? this.profileUrl : "",
            this.avatarUrl !== null ? this.avatarUrl : "",
        );
    }
}
