// Regression test for multi-game leave-and-rejoin.
//
// Boots a fresh GolfServer on port 4249 and walks through the broken-before
// scenario: A creates a 4-player game, B joins, then B leaves. The MultiGame
// scoreboard must reuse B's slot id when a fresh joiner D arrives — previously
// the server emitted two divergent `game join` ordinals (one at
// `playerCount()+1`, one at `numberIndex+1` from the base `sendJoinMessages`),
// which made existing clients render the joiner at TWO scoreboard rows and
// kept growing the visible player count beyond `numPlayers` over each rejoin.
//
// Asserts:
//   - Each `game join` broadcast carries exactly one ordinal (no doubles).
//   - A new joiner reclaims the lowest free slot id, not a fresh sparse index.
//   - The same slot can be filled by a different player without breaking the
//     id space.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-multi-rejoin.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4249;
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
    /** Return all currently buffered frames matching predicate without blocking. */
    drain(predicate: (s: string) => boolean): string[] {
        const out: string[] = [];
        const keep: string[] = [];
        for (const s of this.received) {
            if (predicate(s)) out.push(s);
            else keep.push(s);
        }
        this.received = keep;
        return out;
    }
    async settle(ms = 80): Promise<void> {
        await new Promise<void>((r) => setTimeout(r, ms));
    }
    close(): void {
        try { this.ws.close(); } catch { /* */ }
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

/** Parse the player-id (1-based ordinal in the wire packet → 0-based slot). */
function ownInfoSlot(line: string): number {
    // d <seq> game\towninfo\t<id>\t<nick>\t<clan>
    const m = line.match(/game\towninfo\t(-?\d+)/);
    if (!m) throw new Error(`not an owninfo: ${line}`);
    return parseInt(m[1], 10);
}

function joinSlot(line: string): number {
    // d <seq> game\tjoin\t<ordinal>\t<nick>\t<clan>  (1-based; subtract 1 for slot)
    const m = line.match(/game\tjoin\t(-?\d+)/);
    if (!m) throw new Error(`not a join: ${line}`);
    return parseInt(m[1], 10) - 1;
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
        console.log("[OK] A and B in multi lobby");

        // A creates a 4-player game (room for B + two more).
        a.sendData("lobby", "cmpt", "RejoinTest", "-", 0, 4, 1, 0, 10, 60, 0, 1, 0, 0);
        const addLine = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees gamelist add",
        );
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        await a.waitFor((s) => /^d \d+ status\tgame/.test(s), "A status game");
        const aOwn = await a.waitFor((s) => /game\towninfo/.test(s), "A owninfo");
        if (ownInfoSlot(aOwn) !== 0) {
            throw new Error(`A's slot id should be 0, got ${ownInfoSlot(aOwn)}`);
        }
        console.log("[OK] A created game id", gameId, "and got slot 0");

        // B joins → A receives ONE join broadcast for B at slot 1, B receives owninfo 1.
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        const bOwn = await b.waitFor((s) => /game\towninfo/.test(s), "B owninfo");
        if (ownInfoSlot(bOwn) !== 1) {
            throw new Error(`B's slot id should be 1, got ${ownInfoSlot(bOwn)}`);
        }
        await b.settle();
        const aJoinB = a.drain((s) => /game\tjoin\t/.test(s));
        if (aJoinB.length !== 1) {
            throw new Error(`A should see exactly 1 join broadcast for B, got ${aJoinB.length}: ${JSON.stringify(aJoinB)}`);
        }
        if (joinSlot(aJoinB[0]) !== 1) {
            throw new Error(`A's join broadcast for B should target slot 1, got ${joinSlot(aJoinB[0])}`);
        }
        console.log("[OK] B joined at slot 1 with a single broadcast");

        // B leaves the game (back to multi lobby). A must see `game part 1 4`.
        b.sendData("game", "back");
        await a.waitFor((s) => /game\tpart\t1\t4/.test(s), "A sees B part");
        await b.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "B back in lobby");
        console.log("[OK] B left, A saw part for slot 1");

        // C joins (a fresh client) and MUST take slot 1 (B's old slot) — not 2.
        const c = new Client("C");
        await c.open();
        await login(c);
        await enterMultiLobby(c);
        c.sendData("lobby", "jmpt", String(gameId));
        await c.waitFor((s) => /^d \d+ status\tgame/.test(s), "C status game");
        const cOwn = await c.waitFor((s) => /game\towninfo/.test(s), "C owninfo");
        if (ownInfoSlot(cOwn) !== 1) {
            throw new Error(`C should reuse B's freed slot 1, got ${ownInfoSlot(cOwn)} — sparse-id regression`);
        }
        await c.settle();
        const aJoinC = a.drain((s) => /game\tjoin\t/.test(s));
        if (aJoinC.length !== 1) {
            throw new Error(`A should see exactly 1 join broadcast for C, got ${aJoinC.length}: ${JSON.stringify(aJoinC)}`);
        }
        if (joinSlot(aJoinC[0]) !== 1) {
            throw new Error(`A's join broadcast for C should target slot 1, got ${joinSlot(aJoinC[0])}`);
        }
        console.log("[OK] C reclaimed slot 1 with a single broadcast (no scoreboard bloat)");

        // B rejoins — they should be assigned slot 2 (next free), again single broadcast.
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game (rejoin)");
        const bRejoinOwn = await b.waitFor((s) => /game\towninfo/.test(s), "B owninfo (rejoin)");
        if (ownInfoSlot(bRejoinOwn) !== 2) {
            throw new Error(`B's rejoin slot should be 2, got ${ownInfoSlot(bRejoinOwn)}`);
        }
        await c.settle();
        const cJoinB = c.drain((s) => /game\tjoin\t/.test(s));
        if (cJoinB.length !== 1) {
            throw new Error(`C should see exactly 1 join broadcast for B's rejoin, got ${cJoinB.length}: ${JSON.stringify(cJoinB)}`);
        }
        if (joinSlot(cJoinB[0]) !== 2) {
            throw new Error(`C's join broadcast for B should target slot 2, got ${joinSlot(cJoinB[0])}`);
        }
        console.log("[OK] B rejoined at slot 2 with a single broadcast");

        a.close();
        b.close();
        c.close();
        console.log("\nALL MULTI-REJOIN PHASES PASSED");
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
