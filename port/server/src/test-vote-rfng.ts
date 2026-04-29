// Smoke test for issue #30 - confirms the server's wire output for voteskip,
// rfng, scoringmulti (placeholder), and the part-reason byte on disconnect.
//
// Boots a fresh GolfServer on port 4246, drives two clients through a 2-player
// game, and asserts:
//   - voteskip from A reaches B as `game voteskip <playerId>` and is NOT echoed
//     back to A (server uses writeExcluding).
//   - On the next track the server broadcasts `game resetvoteskip` (so the
//     client can clear its per-player skip flags).
//   - newgame from A after game-over reaches B as `game rfng <playerId>` (also
//     writeExcluding - A doesn't see its own).
//   - When A's WebSocket drops mid-game, B receives `game part 0 5` (the
//     CONN_PROBLEM reason). Pre-fix this was always 4 regardless of cause.
//
// Usage: node --experimental-strip-types --no-warnings src/test-vote-rfng.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4246;
const HOST = "127.0.0.1";

function tracksDir(): string {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

class Client {
    name: string;
    ws: WebSocket;
    outSeq = 0;
    received: string[] = [];

    constructor(name: string) {
        this.name = name;
        this.ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
        this.ws.on("message", (m) => this.received.push(m.toString()));
    }
    async open(): Promise<void> {
        await new Promise<void>((r) => this.ws.once("open", () => r()));
    }
    send(line: string): void {
        this.ws.send(line);
    }
    sendData(...fields: (string | number)[]): void {
        this.send(`d ${this.outSeq++} ${fields.join("\t")}`);
    }
    sendCommand(verb: string, ...args: string[]): void {
        this.send(`c ${[verb, ...args].join(" ")}`);
    }
    async waitFor(predicate: (s: string) => boolean, label: string, timeoutMs = 4000): Promise<string> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                console.log(`[${this.name}] timed out waiting for ${label}; queue:`, this.received);
                reject(new Error(`[${this.name}] timeout: ${label}`));
            }, timeoutMs);
            const tick = (): void => {
                const idx = this.received.findIndex(predicate);
                if (idx >= 0) {
                    clearTimeout(t);
                    const [s] = this.received.splice(idx, 1);
                    resolve(s);
                    return;
                }
                setTimeout(tick, 20);
            };
            tick();
        });
    }
    /** Asserts a packet matching `predicate` does NOT arrive within `windowMs`. */
    async assertNotReceived(predicate: (s: string) => boolean, label: string, windowMs = 250): Promise<void> {
        await new Promise((r) => setTimeout(r, windowMs));
        const found = this.received.find(predicate);
        if (found) {
            throw new Error(`[${this.name}] unexpected packet for ${label}: ${found}`);
        }
    }
    close(): void {
        try { this.ws.close(); } catch { /* */ }
    }
    /** Hard-disconnect (no graceful close frame). Forces server to detect EOF. */
    terminate(): void {
        try { this.ws.terminate(); } catch { /* */ }
    }
}

async function login(c: Client): Promise<void> {
    await c.waitFor((s) => s === "h 1", "h 1");
    await c.waitFor((s) => s.startsWith("c crt"), "c crt");
    await c.waitFor((s) => s === "c ctr", "c ctr");
    c.sendCommand("new");
    await c.waitFor((s) => s.startsWith("c id "), "c id");
    c.sendData("version", 35);
    await c.waitFor((s) => /^d \d+ status\tlogin$/.test(s), "status login (v)");
    c.sendData("language", "en");
    c.sendData("logintype", "nr");
    await c.waitFor((s) => /^d \d+ status\tlogin$/.test(s), "status login (lt)");
    c.sendData("login");
    await c.waitFor((s) => /^d \d+ basicinfo\t/.test(s), "basicinfo");
    await c.waitFor((s) => /^d \d+ status\tlobbyselect/.test(s), "status lobbyselect");
}

async function enterMultiLobby(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "x");
    await c.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "status lobby x");
    await c.waitFor((s) => /^d \d+ lobby\tusers/.test(s), "lobby users");
    await c.waitFor((s) => /^d \d+ lobby\townjoin/.test(s), "lobby ownjoin");
    await c.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "gamelist full");
}

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });
        console.log("[server] up");

        const a = new Client("A");
        const b = new Client("B");
        await Promise.all([a.open(), b.open()]);
        await login(a);
        await login(b);
        await enterMultiLobby(a);
        await enterMultiLobby(b);
        // 2 tracks so we can confirm resetvoteskip fires between holes.
        a.sendData("lobby", "cmpt", "TestGame", "-", 0, 2, 2, 0, 10, 60, 0, 1, 0, 0);
        const addLine = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees gamelist add",
        );
        await a.waitFor((s) => /^d \d+ status\tgame/.test(s), "A status game");
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
        await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B game start");
        await a.waitFor((s) => /^d \d+ game\tresetvoteskip/.test(s), "A initial resetvoteskip");
        await b.waitFor((s) => /^d \d+ game\tresetvoteskip/.test(s), "B initial resetvoteskip");
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack #1");
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack #1");
        console.log("[OK] both joined, game started");

        // ── voteskip ──────────────────────────────────────────────────────
        // A votes; server should send `game voteskip 0` to B (only). A must
        // NOT see an echo (Java compensates by setting the flag locally on
        // the click handler).
        a.sendData("game", "voteskip");
        const bGotVote = await b.waitFor(
            (s) => /^d \d+ game\tvoteskip\t0$/.test(s),
            "B sees A's voteskip",
        );
        console.log("[OK] B received:", bGotVote.split(" ").slice(2).join(" "));
        await a.assertNotReceived(
            (s) => /game\tvoteskip/.test(s),
            "A should not see own voteskip echo",
        );
        console.log("[OK] no self-echo for voteskip");

        // B also votes → both have voted → server advances to next track.
        b.sendData("game", "voteskip");
        await a.waitFor(
            (s) => /^d \d+ game\tvoteskip\t1$/.test(s),
            "A sees B's voteskip",
        );
        // Track advance: server broadcasts resetvoteskip + starttrack.
        await a.waitFor((s) => /^d \d+ game\tresetvoteskip/.test(s), "A resetvoteskip after both voted");
        await b.waitFor((s) => /^d \d+ game\tresetvoteskip/.test(s), "B resetvoteskip after both voted");
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack #2");
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack #2");
        console.log("[OK] both votes accepted, track advanced with resetvoteskip");

        // ── play through the second track and end the game ────────────────
        // Quickest path to game end: both forfeit the second hole.
        a.sendData("game", "forfeit");
        b.sendData("game", "forfeit");
        await a.waitFor((s) => /^d \d+ game\tend/.test(s), "A game end");
        await b.waitFor((s) => /^d \d+ game\tend/.test(s), "B game end");
        console.log("[OK] game ended after both forfeited last track");

        // ── rfng (newgame) ────────────────────────────────────────────────
        // A clicks play-again; server should send `game rfng 0` to B only.
        a.sendData("game", "newgame");
        const bGotRfng = await b.waitFor(
            (s) => /^d \d+ game\trfng\t0$/.test(s),
            "B sees A's rfng",
        );
        console.log("[OK] B received:", bGotRfng.split(" ").slice(2).join(" "));
        await a.assertNotReceived(
            (s) => /game\trfng/.test(s),
            "A should not see own rfng echo",
        );
        console.log("[OK] no self-echo for rfng");

        // ── part-reason on hard disconnect ────────────────────────────────
        // Drain B's queue first so we're sure the next game-related packet
        // is the part broadcast (rather than leftover starttrack/etc.).
        b.received.length = 0;
        a.terminate();
        const bGotPart = await b.waitFor(
            (s) => /^d \d+ game\tpart\t/.test(s),
            "B sees A's part",
            6000,
        );
        // Format: `d <seq> game\tpart\t<id>\t<reason>` - split on tabs, take
        // the last field. The reason MUST be "5" (CONN_PROBLEM) post-fix; the
        // pre-fix server hardcoded "4" for every disconnect path.
        const parts = bGotPart.split("\t");
        const reason = parts[parts.length - 1];
        if (reason !== "5") {
            throw new Error(`expected part reason "5" (CONN_PROBLEM) on hard disconnect, got "${reason}" (full line: ${bGotPart})`);
        }
        console.log("[OK] hard disconnect produced part reason 5 (CONN_PROBLEM)");

        b.close();
        console.log("\nALL VOTESKIP / RFNG / PART-REASON CHECKS PASSED");
        process.exit(0);
    } catch (err) {
        console.error("FAIL:", err);
        process.exit(1);
    } finally {
        if (server) {
            try { await server.close(); } catch { /* */ }
        }
    }
}

main();
