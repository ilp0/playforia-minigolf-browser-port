// Stroke origin and unsettled-stroke regression test.
//
// Verifies that the shooter's exact origin is relayed on `beginstroke` only
// when it is well formed and lies in the whole-pixel wire position, that a
// second stroke is still refused while one is in flight, and that a stroke
// whose `endstroke` never arrives is counted and closed after 30 s instead
// of locking the player out.
//
// Usage: node --experimental-strip-types --no-warnings src/test-stroke-origin.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4251;
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

async function closed(c: Client, timeoutMs = 2000): Promise<boolean> {
    if (c.ws.readyState === c.ws.CLOSED) return true;
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        c.ws.once("close", () => {
            clearTimeout(t);
            resolve(true);
        });
    });
}

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    const realNow = Date.now;
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });
        const a = new Client("A");
        await a.open();
        await login(a);
        await enterDaily(a);
        const b = new Client("B");
        await b.open();
        await login(b);
        await enterDaily(b);

        const ball = (200 * 1500 + 200 * 4).toString(36).padStart(4, "0");
        const mouse = (300 * 1500 + 100 * 4).toString(36).padStart(4, "0");
        const begin = /^d \d+ game\tbeginstroke\t0\t/;
        const stroke = async (exact: string | null, label: string): Promise<string[]> => {
            if (exact === null) a.sendData("game", "beginstroke", ball, mouse);
            else a.sendData("game", "beginstroke", ball, mouse, exact);
            const onA = (await a.waitFor((s) => begin.test(s), `${label} on A`)).split("\t");
            const onB = (await b.waitFor((s) => begin.test(s), `${label} on B`)).split("\t");
            if (onA.slice(1).join("\t") !== onB.slice(1).join("\t")) throw new Error(`${label}: peers got different packets`);
            a.sendData("game", "endstroke", 0, "f", "s");
            await a.waitFor((s) => /\tendstroke\t0\t\d+\tf$/.test(s), `${label} endstroke`);
            await b.waitFor((s) => /\tendstroke\t0\t\d+\tf$/.test(s), `${label} endstroke on B`);
            return onA;
        };

        let f = await stroke("200.5,200.25", "exact origin");
        if (f[7] !== "200.5,200.25") throw new Error(`exact origin not relayed: ${f.join("|")}`);
        console.log("[OK] exact origin is relayed to every peer");

        for (const bad of ["201.5,200.25", "NaN,200", "200.5", "0x1f,200", "200.5,200.25,1"]) {
            f = await stroke(bad, `bad origin ${bad}`);
            if (f.length !== 7) throw new Error(`invalid origin ${bad} was relayed: ${f.join("|")}`);
        }
        f = await stroke(null, "no origin");
        if (f.length !== 7) throw new Error(`origin field invented: ${f.join("|")}`);
        console.log("[OK] malformed or out-of-pixel origins are dropped, the stroke still relays");

        a.sendData("game", "beginstroke", ball, mouse);
        await a.waitFor((s) => begin.test(s), "unsettled stroke");
        a.sendData("game", "beginstroke", ball, mouse);
        if (!(await a.expectAbsent((s) => begin.test(s), "second stroke in flight"))) {
            throw new Error("a second stroke was relayed while one was in flight");
        }
        console.log("[OK] a second stroke is refused while one is in flight");

        const strokesBefore = 7;
        Date.now = () => realNow() + 31_000;
        a.sendData("game", "beginstroke", ball, mouse);
        await a.waitFor((s) => new RegExp(`\\tendstroke\\t0\\t${strokesBefore + 1}\\tf$`).test(s), "abandoned stroke counted");
        if (!(await a.expectAbsent((s) => begin.test(s), "stroke launched by the closing packet"))) {
            throw new Error("closing an abandoned stroke also launched the new one");
        }
        // (The clock stays shifted: winding it back would starve rate limiters.)
        a.sendData("game", "beginstroke", ball, mouse);
        await a.waitFor((s) => begin.test(s), "next stroke after abandonment");
        console.log("[OK] an unsettled stroke is counted and closed after 30 s; the next click shoots");

        // Snapshot recovery must never hole, or leave rolling, a ball whose
        // owner the server still has playing with no stroke in flight: no
        // endstroke would ever settle it and a holed ball cannot shoot.
        // A's stroke is in flight here, B's is not.
        const entry = (slot: number, flags: number, vx: number): string =>
            [slot, 300.25, 150.5, vx, 0, 1, 1, flags, 0, 10, 0, 0, 0, 300, 150, 300, 150, "1"].join(",");
        const holedAtRest = 1 | 2;
        const rolling = 0;
        const blob = `${entry(0, holedAtRest, 0)};${entry(1, holedAtRest, 0)}`;
        const recover = async (subject: number, snapBlob: string): Promise<string[]> => {
            a.sendData("game", "ballend", 0, subject, "10.000", "10.000", 1);
            b.sendData("game", "ballend", 1, subject, "90.000", "90.000", 1);
            const req = await a.waitFor((s) => /\tsnapreq\t/.test(s), "snapreq on A");
            await b.waitFor((s) => /\tsnapreq\t/.test(s), "snapreq on B");
            const nonce = req.split("\t")[2];
            a.sendData("game", "snap", nonce, 0, 0, snapBlob);
            b.sendData("game", "snap", nonce, 1, 0, snapBlob);
            const apply = await a.waitFor((s) => /\tsnapapply\t/.test(s), "snapapply");
            return apply.split("\t")[3].split(";").map((e) => e.split(",")).map((e) => `${e[0]}:${e[7]}:${e[3]}`);
        };
        let applied = await recover(0, blob);
        if (applied.join(" ") !== "0:3:0 1:1:0") throw new Error(`holed resting ball not kept out: ${applied.join(" ")}`);
        a.sendData("game", "endstroke", 0, "f", "s");
        await a.waitFor((s) => /\tendstroke\t0\t\d+\tf$/.test(s), "A settles its stroke");
        applied = await recover(1, `${entry(0, rolling, 2.5)};${entry(1, 1, 0)}`);
        if (applied.join(" ") !== "0:1:0 1:1:0") throw new Error(`rolling resting ball not stopped: ${applied.join(" ")}`);
        console.log("[OK] recovery keeps balls without a stroke in flight at rest on the course");

        a.close();
        b.close();
        console.log("ALL STROKE-ORIGIN PHASES PASSED");
    } catch (err) {
        console.error("FAIL:", err);
        process.exitCode = 1;
    } finally {
        Date.now = realNow;
        if (server) await server.close();
        setTimeout(() => process.exit(process.exitCode ?? 0), 100);
    }
}

void main();
