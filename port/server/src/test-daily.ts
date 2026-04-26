// Daily-challenge smoke test.
//
// Verifies the server-side daily room: two clients select daily, both end up
// in the same singleton DailyGame, both see each other's stroke broadcasts,
// and finishing (hole-in / forfeit) sends a personal `game end` to the
// finisher only — the room stays alive for the other player.
//
// Usage: node --experimental-strip-types --no-warnings src/test-daily.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4248;
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
    /** Like waitFor but resolves false (no error) if the timeout elapses. */
    async expectAbsent(predicate: (s: string) => boolean, label: string, windowMs = 400): Promise<boolean> {
        await new Promise((r) => setTimeout(r, windowMs));
        const found = this.received.findIndex(predicate);
        if (found >= 0) {
            console.log(`[${this.name}] unexpectedly found "${label}":`, this.received[found]);
            return false;
        }
        return true;
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

async function enterDaily(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "d");
    await c.waitFor((s) => /^d \d+ status\tlobby\td/.test(s), "status lobby d");
    await c.waitFor((s) => /^d \d+ status\tgame$/.test(s), "status game");
    await c.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "gameinfo");
    await c.waitFor((s) => /^d \d+ game\tstart$/.test(s), "game start");
    await c.waitFor((s) => /^d \d+ game\tstarttrack\t/.test(s), "starttrack");
    await c.waitFor((s) => /^d \d+ game\tdailymode\t/.test(s), "dailymode");
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
        console.log("[OK] both logged in");

        await enterDaily(a);
        console.log("[OK] A in daily room");
        await enterDaily(b);
        console.log("[OK] B in daily room");

        // A should see B's `game join` broadcast (B was added after A) AND
        // it must carry the new player's 1-based ordinal (=2 for B). The
        // client treats this as 1-based and subtracts 1 to get the slot
        // index — sending 1 here would make A's client overwrite slot 0
        // (its own row) with B's nick.
        const joinPkt = await a.waitFor((s) => /^d \d+ game\tjoin\t/.test(s), "A sees B join");
        const joinFields = joinPkt.split("\t");
        const ordinal = parseInt(joinFields[2] ?? "0", 10);
        if (ordinal !== 2) {
            throw new Error(`A saw join with ordinal=${ordinal}; want 2 (B's 1-based slot)`);
        }
        console.log(`[OK] join broadcast carries correct 1-based ordinal=${ordinal}`);

        // Both shoot — same async semantics as MultiGame. The strokes happen
        // in the singleton daily game; both players see each other's strokes.
        const ball = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
        const mouseA = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");
        const mouseB = (100 * 1500 + 150 * 4 + 0).toString(36).padStart(4, "0");
        a.sendData("game", "beginstroke", ball, mouseA);
        b.sendData("game", "beginstroke", ball, mouseB);

        const aGotA = await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A sees own stroke");
        const bGotA = await b.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "B sees A's stroke");
        const seedAonA = aGotA.split("\t").pop();
        const seedAonB = bGotA.split("\t").pop();
        if (seedAonA !== seedAonB) throw new Error(`stroke seed differs across clients: ${seedAonA} vs ${seedAonB}`);
        console.log(`[OK] both clients see identical seed=${seedAonA} for A's stroke`);

        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t1\t/.test(s), "A sees B's stroke");
        await b.waitFor((s) => /^d \d+ game\tbeginstroke\t1\t/.test(s), "B sees own stroke");

        // A holes in. Server should broadcast the endstroke to both AND send
        // A a personal `game end` (room continues for B).
        a.sendData("game", "endstroke", 0, "tf");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "A sees own holed");
        await b.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "B sees A holed");
        await a.waitFor((s) => /^d \d+ game\tend$/.test(s), "A gets personal end");

        // Crucially, B must NOT receive a `game end` — they're still playing.
        const bNoEnd = await b.expectAbsent((s) => /^d \d+ game\tend$/.test(s), "B's spurious end", 300);
        if (!bNoEnd) throw new Error("B got `game end` despite still playing");
        console.log("[OK] only the finisher gets `game end`; room continues for others");

        // B forfeits — also gets a personal `game end`.
        b.sendData("game", "forfeit");
        await b.waitFor((s) => /^d \d+ game\tendstroke\t1\t/.test(s), "B sees forfeit endstroke");
        await b.waitFor((s) => /^d \d+ game\tend$/.test(s), "B gets personal end after forfeit");
        console.log("[OK] forfeit yields personal end too");

        // A goes back to lobbyselect (not into a daily lobby panel).
        a.sendData("game", "back");
        await a.waitFor((s) => /^d \d+ status\tlobbyselect\t/.test(s), "A back to lobbyselect");
        console.log("[OK] back from daily routes straight to lobbyselect");

        // Regression: B also leaves, then a fresh client C re-enters the
        // (now-empty) singleton daily room and must be able to shoot. Pre-fix,
        // C would inherit the stale `numberIndex` (=2 after A and B) and the
        // stale `playStatus` ("tp" from A's hole-in + B's forfeit), so its
        // beginstroke would be silently rejected by the playStatus gate.
        b.sendData("game", "back");
        await b.waitFor((s) => /^d \d+ status\tlobbyselect\t/.test(s), "B back to lobbyselect");

        const c = new Client("C");
        await c.open();
        await login(c);
        await enterDaily(c);
        // Owninfo must show id=0 — the room reset on empty-join, otherwise C's
        // numberIndex would still be 2 here and the next assert (charAt 0) is
        // the wrong slot.
        const owninfo = await c.waitFor((s) => /^d \d+ game\towninfo\t/.test(s), "C owninfo");
        const cid = parseInt(owninfo.split("\t")[2] ?? "-1", 10);
        if (cid !== 0) throw new Error(`C re-entered daily with id=${cid}; want 0 (numberIndex was not reset)`);
        c.sendData("game", "beginstroke", ball, mouseA);
        await c.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "C sees own stroke after re-entry");
        console.log("[OK] daily re-entry into empty room: C can shoot with id=0");
        c.close();

        a.close();
        b.close();
        console.log("\nALL DAILY-CHALLENGE PHASES PASSED");
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
