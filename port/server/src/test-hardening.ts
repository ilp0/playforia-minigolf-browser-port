// Abuse-resistance regression test.
//
// Verifies that a second `c new` closes the connection, that `endstroke`
// needs a preceding `beginstroke` (so Daily Cup results cannot be posted
// without a stroke), that malformed stroke coordinates are not relayed,
// that a frame flood closes the socket and that the replay store is bounded
// by total size.
//
// Usage: node --experimental-strip-types --no-warnings src/test-hardening.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";
import { _clearReplayStore, getReplay, saveReplay } from "./replay-store.ts";

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
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false });

        const dup = new Client("dup");
        await dup.open();
        await login(dup);
        dup.sendCommand("new");
        if (!(await closed(dup))) throw new Error("second c new did not close the connection");
        console.log("[OK] duplicate c new closes the connection");

        const a = new Client("A");
        await a.open();
        await login(a);
        await enterDaily(a);
        a.sendData("game", "endstroke", 0, "t", "s");
        if (!(await a.expectAbsent((s) => /\tendstroke\t/.test(s), "endstroke without a stroke"))) {
            throw new Error("endstroke without beginstroke was accepted");
        }
        a.sendData("game", "endstroke", 0, "t", "k");
        if (!(await a.expectAbsent((s) => /\tendstroke\t/.test(s), "krokkaus without collisions"))) {
            throw new Error("krokkaus endstroke was accepted in a room without collisions");
        }
        console.log("[OK] endstroke without a begun stroke is ignored");

        a.sendData("game", "beginstroke", "x".repeat(200), "0000");
        if (!(await a.expectAbsent((s) => /\tbeginstroke\t/.test(s), "malformed coords relay"))) {
            throw new Error("malformed beginstroke coordinates were relayed");
        }
        const ball = (200 * 1500 + 200 * 4).toString(36).padStart(4, "0");
        a.sendData("game", "beginstroke", ball, ball);
        await a.waitFor((s) => /\tbeginstroke\t/.test(s), "beginstroke relay");
        a.sendData("game", "beginstroke", ball, ball);
        if (!(await a.expectAbsent((s) => /\tbeginstroke\t/.test(s), "second beginstroke in flight"))) {
            throw new Error("a second beginstroke was relayed while one was in flight");
        }
        a.sendData("game", "endstroke", 0, "t", "s");
        await a.waitFor((s) => /\tendstroke\t0\t1\tt$/.test(s), "holed endstroke");
        a.sendData("game", "endstroke", 0, "t", "s");
        if (!(await a.expectAbsent((s) => /\tendstroke\t/.test(s), "repeated finish"))) {
            throw new Error("a finished player's endstroke was accepted again");
        }
        console.log("[OK] one stroke ends once and malformed coordinates are dropped");
        a.close();

        const flood = new Client("flood");
        await flood.open();
        await login(flood);
        for (let i = 0; i < 100; i++) flood.send(Array(32).fill("c pong").join("\n"));
        if (!(await closed(flood))) throw new Error("frame flood did not close the connection");
        console.log("[OK] inbound frame flood closes the connection");

        _clearReplayStore();
        const first = saveReplay("a".repeat(64 * 1024));
        for (let i = 0; i < 300; i++) saveReplay("b".repeat(64 * 1024));
        if (getReplay(first) !== null) throw new Error("replay store kept more than its size budget");
        console.log("[OK] replay store evicts by total size");

        console.log("ALL HARDENING PHASES PASSED");
    } catch (err) {
        console.error("FAIL:", err);
        process.exitCode = 1;
    } finally {
        if (server) await server.close();
        setTimeout(() => process.exit(process.exitCode ?? 0), 100);
    }
}

void main();
