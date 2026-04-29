// Practice-mode smoke test.
//
// Boots a fresh server, has two clients enter the multi lobby and create a
// 4-player room (so the room never auto-fills during the test). Then:
//   1. A presses Practice → both A and B receive game start + starttrack +
//      practicemode t.
//   2. A holes in 1 stroke → server picks a fresh random track and rebroadcasts
//      starttrack with a clean playStatus.
//   3. C joins → C sees a personal start/starttrack/practicemode t.
//   4. The 4th player D joins → the room fills and the configured tracks
//      (numTracks=3) start playing. No `practicemode` packet on this start.
//
// Usage: node --experimental-strip-types --no-warnings src/test-practice.ts

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
    send(line: string): void { this.ws.send(line); }
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
    /** Confirm a packet matching `predicate` does NOT arrive within `timeoutMs`. */
    async assertNotReceived(predicate: (s: string) => boolean, label: string, timeoutMs = 200): Promise<void> {
        await new Promise((r) => setTimeout(r, timeoutMs));
        const hit = this.received.find(predicate);
        if (hit) throw new Error(`[${this.name}] unexpected packet (${label}): ${hit}`);
    }
    drain(): void {
        this.received.length = 0;
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

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });
        console.log("[server] up");

        const a = new Client("A");
        const b = new Client("B");
        const c = new Client("C");
        const d = new Client("D");
        await Promise.all([a.open(), b.open(), c.open(), d.open()]);
        for (const x of [a, b, c, d]) await login(x);
        for (const x of [a, b, c, d]) await enterMultiLobby(x);
        console.log("[OK] all four logged in and in multi lobby");

        // A creates a 4-player game with 3 configured tracks. No password.
        a.sendData("lobby", "cmpt", "PracticeRoom", "-", 0, 4, 3, 0, 10, 60, 0, 1, 0, 0);
        const addLine = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees gamelist add",
        );
        await a.waitFor((s) => /^d \d+ status\tgame/.test(s), "A status game");
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        console.log("[OK] game created with id", gameId, "(4 players, 3 tracks)");

        // B joins (now 2/4). No `game start` should fire - room not full.
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        await a.waitFor((s) => /^d \d+ game\tjoin\t2\t/.test(s), "A sees B join");
        await a.assertNotReceived((s) => /^d \d+ game\tstart$/.test(s), "no start before practice");
        console.log("[OK] B joined; room is 2/4, no auto-start");

        // A presses Practice. Server should broadcast start + resetvoteskip +
        // starttrack + practicemode t to BOTH players.
        a.drain(); b.drain();
        a.sendData("game", "practice");

        for (const cli of [a, b]) {
            await cli.waitFor((s) => /^d \d+ game\tstart$/.test(s), `${cli.name} game start (practice)`);
            await cli.waitFor((s) => /^d \d+ game\tresetvoteskip$/.test(s), `${cli.name} resetvoteskip`);
            await cli.waitFor((s) => /^d \d+ game\tstarttrack\tff\t/.test(s), `${cli.name} starttrack`);
            await cli.waitFor((s) => /^d \d+ game\tpracticemode\tt$/.test(s), `${cli.name} practicemode t`);
        }
        console.log("[OK] practice started for A & B with random track + practicemode flag");

        // Repeat-press is a no-op on the server.
        a.drain(); b.drain();
        a.sendData("game", "practice");
        await a.assertNotReceived((s) => /^d \d+ game\tstart$/.test(s), "no second start", 200);
        console.log("[OK] repeat practice press ignored while practice is running");

        // A holes-in (status 't') → server's nextTrack swaps in another random
        // track and rebroadcasts starttrack with a clean buff.
        a.drain(); b.drain();
        const ball = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
        const mouseA = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");
        a.sendData("game", "beginstroke", ball, mouseA);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A own beginstroke");
        a.sendData("game", "endstroke", 0, "tf");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "A endstroke t");
        // B is still 'f', so allDone is false → no advance yet.
        await a.assertNotReceived((s) => /game\tstarttrack/.test(s), "no advance with B still 'f'", 200);

        b.sendData("game", "beginstroke", ball, mouseA);
        await b.waitFor((s) => /^d \d+ game\tbeginstroke\t1\t/.test(s), "B own beginstroke");
        b.sendData("game", "endstroke", 1, "ft");
        // Now both are 't' → nextTrack picks a fresh random track.
        await a.waitFor((s) => /^d \d+ game\tstarttrack\tff\t/.test(s), "A practice next track");
        await b.waitFor((s) => /^d \d+ game\tstarttrack\tff\t/.test(s), "B practice next track");
        // No `game start` between practice tracks - only on the very first start.
        // (Existing handler only sends `start` from `startGame`/`startPractice`.)
        console.log("[OK] practice cycles: both holed → fresh random track");

        // C joins mid-practice - gets a personal start/starttrack/practicemode t.
        a.drain(); b.drain();
        c.sendData("lobby", "jmpt", String(gameId));
        await c.waitFor((s) => /^d \d+ status\tgame/.test(s), "C status game");
        await c.waitFor((s) => /^d \d+ game\tstart$/.test(s), "C personal start");
        await c.waitFor((s) => /^d \d+ game\tstarttrack\t/.test(s), "C personal starttrack");
        await c.waitFor((s) => /^d \d+ game\tpracticemode\tt$/.test(s), "C practicemode t");
        // A & B don't get a start broadcast (only the join announcement).
        await a.waitFor((s) => /^d \d+ game\tjoin\t3\t/.test(s), "A sees C join");
        await a.assertNotReceived((s) => /^d \d+ game\tstart$/.test(s), "no spurious start for A on C-join", 200);
        console.log("[OK] late joiner C dropped into running practice without disturbing A/B");

        // D joins → room fills (4/4) → real game starts. Practice flag is dropped.
        a.drain(); b.drain(); c.drain(); d.drain();
        d.sendData("lobby", "jmpt", String(gameId));
        await d.waitFor((s) => /^d \d+ status\tgame/.test(s), "D status game");
        for (const cli of [a, b, c, d]) {
            await cli.waitFor((s) => /^d \d+ game\tstart$/.test(s), `${cli.name} real game start`);
            await cli.waitFor((s) => /^d \d+ game\tstarttrack\t/.test(s), `${cli.name} real starttrack`);
            // No practicemode t on the real-game start.
            await cli.assertNotReceived((s) => /^d \d+ game\tpracticemode\tt$/.test(s), `${cli.name} no practicemode on real start`, 150);
        }
        console.log("[OK] room filled → practice ended, real game started for all four");

        a.close(); b.close(); c.close(); d.close();
        console.log("\nALL PRACTICE-MODE PHASES PASSED");
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
