// Verify the forfeit + maxStrokes behaviour for the async multiplayer game.
//
// Scenario:
//   - Two-player 2-track game, maxStrokes=3.
//   - Player A holes-in immediately on hole 1.
//   - Player B forfeits hole 1 (caps strokes at 3).
//   - Track must advance because both are "done" (one t, one p).
//   - On hole 2, A takes 3 strokes without holing - server must auto-cap them
//     at maxStrokes (the third endstroke flips status to "p").
//
// Usage: node --experimental-strip-types --no-warnings src/test-forfeit.ts
import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4245;
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
    sendData(...fields: (string | number)[]): void {
        this.ws.send(`d ${this.outSeq++} ${fields.join("\t")}`);
    }
    sendCommand(verb: string, ...args: string[]): void {
        this.ws.send(`c ${[verb, ...args].join(" ")}`);
    }
    async waitFor(predicate: (s: string) => boolean, label: string, timeoutMs = 4000): Promise<string> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                console.log(`[${this.name}] timed out: ${label}; queue:`, this.received);
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

async function enterMulti(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "x");
    await c.waitFor((s) => /^d \d+ lobby\tgamelist\tfull/.test(s), "gamelist full");
}

const ENC = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
const MOUSE = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });

        const a = new Client("A"), b = new Client("B");
        await Promise.all([a.open(), b.open()]);
        await login(a); await login(b);
        await enterMulti(a); await enterMulti(b);

        // 2-player, 2 tracks, maxStrokes=3, basic.
        a.sendData("lobby", "cmpt", "Forfeit", "-", 0, 2, 2, 1, 3, 60, 0, 1, 0, 0);
        const addLine = await b.waitFor((s) => /^d \d+ lobby\tgamelist\tadd/.test(s), "B gamelist add");
        const gameId = parseInt(addLine.split("\t")[3] ?? "0", 10);
        b.sendData("lobby", "jmpt", String(gameId));
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
        await b.waitFor((s) => /^d \d+ game\tstart$/.test(s), "B game start");
        const t1 = await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack 1");
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack 1");
        console.log("[OK] game started, on track 1");

        // Hole 1: A scores immediately (1 stroke), B forfeits.
        a.sendData("game", "beginstroke", ENC, MOUSE);
        await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "A sees A's stroke");
        await b.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "B sees A's stroke");
        a.sendData("game", "endstroke", 0, "tf");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "A's hole-in broadcast");
        await b.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tt$/.test(s), "B sees A's hole-in");
        console.log("[OK] A holed in 1 stroke");

        // B forfeits.
        b.sendData("game", "forfeit");
        // Server caps B at maxStrokes=3 and marks 'p'.
        await b.waitFor((s) => /^d \d+ game\tendstroke\t1\t3\tp$/.test(s), "B forfeit broadcast");
        await a.waitFor((s) => /^d \d+ game\tendstroke\t1\t3\tp$/.test(s), "A sees B forfeit");
        // Both done → server must advance to track 2.
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s) && s !== t1, "A starttrack 2", 5000);
        await b.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "B starttrack 2");
        console.log("[OK] track advanced after forfeit (one in hole + one DNF)");

        // Hole 2: A takes 3 strokes without holing - server must auto-cap.
        for (let stroke = 1; stroke <= 3; stroke++) {
            a.sendData("game", "beginstroke", ENC, MOUSE);
            await a.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), `A stroke ${stroke}`);
            await b.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), `B sees A's stroke ${stroke}`);
            const status = stroke === 3 ? "p" : "f"; // 3rd stroke at maxStrokes=3 → cap
            // Client always claims "f" (still playing); server flips to "p" on cap.
            a.sendData("game", "endstroke", 0, "ff");
            await a.waitFor(
                (s) => new RegExp(`^d \\d+ game\\tendstroke\\t0\\t${stroke}\\t${status}$`).test(s),
                `A endstroke #${stroke} status=${status}`,
            );
        }
        console.log("[OK] maxStrokes auto-cap kicked in on stroke 3 (status flipped to 'p')");

        // B also forfeits to end the game.
        b.sendData("game", "forfeit");
        await b.waitFor((s) => /^d \d+ game\tendstroke\t1\t3\tp$/.test(s), "B's 2nd forfeit");
        await a.waitFor((s) => /^d \d+ game\tend/.test(s), "A game end");
        await b.waitFor((s) => /^d \d+ game\tend/.test(s), "B game end");
        console.log("[OK] game ended after both done on track 2");

        a.close(); b.close();
        console.log("\nALL FORFEIT/MAXSTROKES PHASES PASSED");
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
