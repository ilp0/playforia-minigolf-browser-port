// Two-client async-multiplayer smoke test.
//
// Boots a fresh GolfServer on port 4244, opens two ws clients, walks them
// through guest-login → multi lobby → create+join 2-player game → both
// players shoot in parallel → confirms the server broadcasts identical
// per-stroke seeds to both clients (the determinism contract).
//
// Usage: node --experimental-strip-types --no-warnings src/test-multi.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4244;
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
        await Promise.all([a.open(), b.open()]);

        await login(a);
        await login(b);
        console.log("[OK] both logged in");

        await enterMultiLobby(a);
        await enterMultiLobby(b);
        console.log("[OK] both in multi lobby");

        // A creates a 2-player game.
        a.sendData("lobby", "cmpt", "TestGame", "-", 0, 2, 1, 0, 10, 60, 0, 1, 0, 0);
        const addLine = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees gamelist add",
        );
        await a.waitFor((s) => /^d \d+ status\tgame/.test(s), "A status game");
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        console.log("[OK] game created with id", gameId);

        // B joins.
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
        await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B game start");
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack");
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack");
        console.log("[OK] both joined and started");

        // Async play: A and B both shoot RIGHT AWAY (no turns).
        // wire: game beginstroke <ballCoords> <mouseCoords>
        const ball = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
        const mouseA = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");
        const mouseB = (100 * 1500 + 150 * 4 + 0).toString(36).padStart(4, "0");
        a.sendData("game", "beginstroke", ball, mouseA);
        b.sendData("game", "beginstroke", ball, mouseB);

        // Both clients should receive BOTH beginstroke broadcasts (one for A, one for B).
        // Each broadcast carries the per-stroke seed; A and B must see identical seed
        // values for the SAME stroke (that's the whole determinism contract).
        const aGotA = await a.waitFor(
            (s) => /^d \d+ game\tbeginstroke\t0\t/.test(s),
            "A sees A's stroke broadcast",
        );
        const bGotA = await b.waitFor(
            (s) => /^d \d+ game\tbeginstroke\t0\t/.test(s),
            "B sees A's stroke broadcast",
        );
        const aGotB = await a.waitFor(
            (s) => /^d \d+ game\tbeginstroke\t1\t/.test(s),
            "A sees B's stroke broadcast",
        );
        const bGotB = await b.waitFor(
            (s) => /^d \d+ game\tbeginstroke\t1\t/.test(s),
            "B sees B's stroke broadcast",
        );

        const seedAonA = aGotA.split("\t").pop();
        const seedAonB = bGotA.split("\t").pop();
        const seedBonA = aGotB.split("\t").pop();
        const seedBonB = bGotB.split("\t").pop();
        if (seedAonA !== seedAonB) throw new Error(`A's stroke seed differs across clients: ${seedAonA} vs ${seedAonB}`);
        if (seedBonA !== seedBonB) throw new Error(`B's stroke seed differs across clients: ${seedBonA} vs ${seedBonB}`);
        if (seedAonA === seedBonA) throw new Error(`A's stroke seed matches B's — should be unique per stroke`);
        console.log(`[OK] determinism: both clients agree A.seed=${seedAonA}, B.seed=${seedBonA}, and they differ`);

        // Each player reports their own ball stopped (not in hole).
        a.sendData("game", "endstroke", 0, "ff");
        b.sendData("game", "endstroke", 1, "ff");
        // Server should broadcast endstroke updates to both.
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tf$/.test(s), "A sees own endstroke");
        await b.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tf$/.test(s), "B sees A's endstroke");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t1\t1\tf$/.test(s), "A sees B's endstroke");
        await b.waitFor((s) => /^d \d+ game\tendstroke\t1\t1\tf$/.test(s), "B sees own endstroke");
        console.log("[OK] async endstrokes processed and broadcast");

        // Cursor relay: A sends a cursor sample, B must receive it stamped with
        // A's playerId (0). Guards the "cursor handler must come before generic
        // game handler" ordering invariant in packet-handlers.ts. Self-echo is
        // intentionally suppressed by the server.
        a.sendData("game", "cursor", 123, 456);
        const bGotCursor = await b.waitFor(
            (s) => /^d \d+ game\tcursor\t0\t123\t456$/.test(s),
            "B sees A's cursor",
        );
        if (!bGotCursor) throw new Error("cursor relay missing");
        console.log("[OK] cursor relayed to peer with stamped playerId");

        // Both holes-in to end the track.
        a.sendData("game", "beginstroke", ball, mouseA);
        b.sendData("game", "beginstroke", ball, mouseB);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A sees A's 2nd");
        await b.waitFor((s) => /^d \d+ game\tbeginstroke\t1\t/.test(s), "B sees B's 2nd");
        a.sendData("game", "endstroke", 0, "tf");
        b.sendData("game", "endstroke", 1, "ft");
        // Track has 1 hole → game ends after both finish.
        await a.waitFor((s) => /^d \d+ game\tend/.test(s), "A game end");
        await b.waitFor((s) => /^d \d+ game\tend/.test(s), "B game end");
        console.log("[OK] game ended after both holed (no turn-arbiter required)");

        // Chat (lobby — return first).
        a.sendData("game", "back");
        b.sendData("game", "back");
        await a.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "A back to lobby");
        await b.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "B back to lobby");
        a.sendData("lobby", "say", "hi from A");
        await b.waitFor((s) => /lobby\tsay\thi from A/.test(s), "B sees A's chat");
        console.log("[OK] lobby chat works");

        // Lobby `back` button — `lobbyselect leave` must remove from current
        // lobby and bounce back to lobbyselect. The historical bug was that
        // the single-player Back sent `lobbyselect select 1` which re-entered
        // the same lobby, so the panel snapped right back. We send `leave`
        // and assert the server replies with `status lobbyselect`.
        a.sendData("lobbyselect", "leave");
        await a.waitFor((s) => /^d \d+ status\tlobbyselect\t/.test(s), "A leaves lobby");
        console.log("[OK] lobbyselect leave routes back to main menu");

        a.close();
        b.close();
        console.log("\nALL ASYNC-MULTIPLAYER PHASES PASSED");
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
