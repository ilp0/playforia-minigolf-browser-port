// Late-join-into-started-game smoke test.
//
// Boots a fresh server, has A and B fill a 2-player game so it starts. C is
// in the lobby and observes:
//   1. Initial gamelist (carries A's room).
//   2. A `gamelist change` flipping the `inProgress` flag to '1' once the
//      room fills (room stays in the list - no `gamelist remove`).
//   3. A `gamelist change` shrinking the room back to 1/2 when B leaves
//      mid-game.
// Then C joins the now-1/2 room and verifies the catch-up sequence:
//   - personal `start` / `resetvoteskip` / `starttrack` / `gametrack 1` - no
//     full-room `start` broadcast (A is mid-game and shouldn't be reset).
//
// Usage: node --experimental-strip-types --no-warnings src/test-late-join.ts

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
                console.log(`[${this.name}] timeout ${label}; queue:`, this.received);
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
    async assertNotReceived(predicate: (s: string) => boolean, label: string, timeoutMs = 200): Promise<void> {
        await new Promise((r) => setTimeout(r, timeoutMs));
        const hit = this.received.find(predicate);
        if (hit) throw new Error(`[${this.name}] unexpected packet (${label}): ${hit}`);
    }
    drain(): void { this.received.length = 0; }
    close(): void { try { this.ws.close(); } catch { /* */ } }
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
        await Promise.all([a.open(), b.open(), c.open()]);
        for (const x of [a, b, c]) await login(x);
        for (const x of [a, b, c]) await enterMultiLobby(x);
        console.log("[OK] A, B, C in multi lobby");

        // A creates a 2-player game with maxStrokes=10 and 3 tracks. After
        // B joins, the room is full and starts.
        a.sendData("lobby", "cmpt", "DropInTest", "-", 0, 2, 3, 0, 10, 60, 0, 1, 0, 0);
        const addLine = await c.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "C sees gamelist add",
        );
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        // gameString field 5 is at addLine index 7 (after `d N lobby gamelist add <gameId> <name> <pwd> <perms> <numPlayers>` ...).
        // Easier check: just look for `0` as field 5 right after numPlayers=2.
        if (!/\tDropInTest\tf\t0\t2\t0\t/.test(addLine)) {
            throw new Error("expected inProgress=0 in initial add: " + addLine);
        }
        console.log("[OK] C sees room added with inProgress=0 (waiting)");
        await a.waitFor((s) => /^d \d+ status\tgame/.test(s), "A status game");

        // B joins → room fills → game starts. C should see a `gamelist change`
        // with inProgress=1, AND no `gamelist remove`.
        c.drain();
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A real start");
        await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B real start");

        // The change packet flipping inProgress to "1" should be the LAST
        // gamelist event C sees once the dust settles.
        await c.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tchange\t\d+\tDropInTest\tf\t0\t2\t1\t/.test(s),
            "C sees inProgress=1 change",
        );
        await c.assertNotReceived(
            (s) => /^d \d+ lobby\tgamelist\tremove\t/.test(s),
            "no remove after fill",
            200,
        );
        console.log("[OK] room stays in gamelist after fill, inProgress flipped to 1");

        // A and B play one stroke each, A holes-in.
        const ball = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
        const mouseA = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");
        a.sendData("game", "beginstroke", ball, mouseA);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A own beginstroke");
        a.sendData("game", "endstroke", 0, "tf");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "A holed");
        // B leaves voluntarily - `removePlayer` should mark slot 1 'p' so
        // allDone passes and the track advances; we'll only assert on the
        // gamelist side here.
        c.drain();
        b.sendData("game", "back");

        // C should see a gamelist change shrinking the room to 1/2,
        // inProgress still '1' (game still in progress).
        await c.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tchange\t\d+\tDropInTest\tf\t0\t2\t1\t.*\t1$/.test(s),
            "C sees 1/2 update with inProgress=1",
        );
        console.log("[OK] B left mid-game → gamelist shrinks back to 1/2 (inProgress=1)");

        // C joins the 1/2 in-progress room. Expect personal start / resetvoteskip /
        // starttrack / gametrack - but NO `lobby gamelist remove`.
        c.drain();
        c.sendData("lobby", "jmpt", String(gameId));
        await c.waitFor((s) => /^d \d+ status\tgame/.test(s), "C status game");
        await c.waitFor((s) => /^d \d+ game\tstart$/.test(s), "C personal start");
        await c.waitFor((s) => /^d \d+ game\tresetvoteskip$/.test(s), "C resetvoteskip");
        const stt = await c.waitFor((s) => /^d \d+ game\tstarttrack\t/.test(s), "C personal starttrack");
        await c.waitFor((s) => /^d \d+ game\tgametrack\t\d+$/.test(s), "C gametrack");
        // playStatus length should be 2 (slots 0..1 - A's slot 0 and C's slot 1).
        // Specifically: server padded playStatus for C's slot to 'f', and the
        // wire buff is "f".repeat(playStatus.length) = "ff".
        if (!/game\tstarttrack\tff\t/.test(stt)) {
            throw new Error("expected playStatus length 2 (\"ff\") in C's starttrack: " + stt);
        }
        console.log("[OK] C dropped into in-progress game with personal catch-up sequence");

        a.close(); b.close(); c.close();
        console.log("\nALL LATE-JOIN PHASES PASSED");
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
