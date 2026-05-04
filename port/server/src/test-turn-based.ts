// Turn-based multiplayer smoke test.
//
// Boots a fresh GolfServer on port 4253, opens three ws clients, walks them
// through guest-login → multi lobby → create+join 3-player turn-based game,
// then exercises the contract:
//
//   1. Server announces `gameinfo` with the trailing `t` flag.
//   2. After fill, `startturn 0` is broadcast to all.
//   3. A non-current-turn shooter is silently rejected.
//   4. The current-turn shooter's beginstroke is accepted.
//   5. After endstroke, `startturn` advances to the next slot.
//   6. When the current-turn player parts mid-track, the turn advances.
//
// Usage: node --experimental-strip-types --no-warnings src/test-turn-based.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4253;
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
    async assertNotReceived(predicate: (s: string) => boolean, label: string, windowMs: number): Promise<void> {
        await new Promise<void>((r) => setTimeout(r, windowMs));
        const idx = this.received.findIndex(predicate);
        if (idx >= 0) {
            throw new Error(`[${this.name}] received unexpected (${label}): ${this.received[idx]}`);
        }
    }
    drain(): void {
        this.received = [];
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
        await Promise.all([a.open(), b.open(), c.open()]);

        await login(a);
        await login(b);
        await login(c);
        await enterMultiLobby(a);
        await enterMultiLobby(b);
        await enterMultiLobby(c);
        console.log("[OK] three players in multi lobby");

        // A creates a 3-player TURN-BASED game.
        // Wire: cmpt <name> <pwd> <perms> <numPlayers> <numTracks> <trackType>
        //       <maxStrokes> <strokeTimeout> <water> <collision> <scoring>
        //       <weightEnd> <turnBased>
        a.sendData("lobby", "cmpt", "TurnRoom", "-", 0, 3, 1, 0, 10, 60, 0, 1, 0, 0, 1);
        const addLine = await b.waitFor(
            (s) => /^d \d+ lobby\tgamelist\tadd/.test(s),
            "B sees gamelist add",
        );
        // 16-field gameString: last field should be '1' (turnBased).
        const fields = addLine.split("\t");
        const turnBasedField = fields[fields.length - 1];
        if (turnBasedField !== "1") {
            throw new Error(`expected trailing turnBased=1 in gamelist add: ${addLine}`);
        }
        console.log("[OK] gamelist row carries turnBased=1");
        await a.waitFor((s) => /^d \d+ status\tgame/.test(s), "A status game");
        const gameId = parseInt(fields[3] ?? "0", 10);

        // Local A also gets gameinfo; check the trailing turn-based flag (last field is `t`).
        const gi = await a.waitFor((s) => /^d \d+ game\tgameinfo\t/.test(s), "A gameinfo");
        const giParts = gi.split("\t");
        if (giParts[giParts.length - 1] !== "t") {
            throw new Error(`expected gameinfo trailing turnBased="t": ${gi}`);
        }
        console.log("[OK] gameinfo carries turnBased=t");

        // B and C join → room fills → startGame → startturn 0.
        b.sendData("lobby", "jmpt", String(gameId));
        await b.waitFor((s) => /^d \d+ status\tgame/.test(s), "B status game");
        c.sendData("lobby", "jmpt", String(gameId));
        await c.waitFor((s) => /^d \d+ status\tgame/.test(s), "C status game");

        // Wait for startGame → first startturn 0.
        await a.waitFor((s) => /^d \d+ game\tstart$/.test(s), "A game start");
        await a.waitFor((s) => /^d \d+ game\tstarttrack/.test(s), "A starttrack");
        const aTurn0 = await a.waitFor((s) => /^d \d+ game\tstartturn\t0$/.test(s), "A startturn 0");
        await b.waitFor((s) => /^d \d+ game\tstartturn\t0$/.test(s), "B startturn 0");
        await c.waitFor((s) => /^d \d+ game\tstartturn\t0$/.test(s), "C startturn 0");
        if (!aTurn0) throw new Error("expected startturn 0");
        console.log("[OK] all three saw startturn 0 after fill");

        // B (slot 1) tries to shoot out of turn → should be silently dropped.
        // Server gates on `playerId === currentTurn`; no beginstroke broadcast back.
        const ball = (200 * 1500 + 200 * 4 + 0).toString(36).padStart(4, "0");
        const mouseB = (100 * 1500 + 150 * 4 + 0).toString(36).padStart(4, "0");
        a.drain();
        b.sendData("game", "beginstroke", ball, mouseB);
        await a.assertNotReceived(
            (s) => /^d \d+ game\tbeginstroke\t1\t/.test(s),
            "no broadcast for B's out-of-turn stroke",
            300,
        );
        console.log("[OK] B's out-of-turn beginstroke was rejected");

        // A (current turn) shoots → broadcast to all. Then A's endstroke
        // advances the turn to slot 1.
        const mouseA = (300 * 1500 + 250 * 4 + 0).toString(36).padStart(4, "0");
        a.sendData("game", "beginstroke", ball, mouseA);
        await b.waitFor((s) => /^d \d+ game\tbeginstroke\t0\t/.test(s), "B sees A's stroke");
        a.sendData("game", "endstroke", 0, "fff");
        await b.waitFor((s) => /^d \d+ game\tendstroke\t0\t1\tf$/.test(s), "B sees endstroke 0");
        await a.waitFor((s) => /^d \d+ game\tstartturn\t1$/.test(s), "A startturn 1");
        await b.waitFor((s) => /^d \d+ game\tstartturn\t1$/.test(s), "B startturn 1");
        await c.waitFor((s) => /^d \d+ game\tstartturn\t1$/.test(s), "C startturn 1");
        console.log("[OK] turn advanced to slot 1 after A's endstroke");

        // A (no longer current turn) tries to shoot again → rejected.
        a.drain();
        a.sendData("game", "beginstroke", ball, mouseA);
        await a.assertNotReceived(
            (s) => /^d \d+ game\tbeginstroke\t0\t/.test(s),
            "no broadcast for A's now-out-of-turn stroke",
            300,
        );
        console.log("[OK] A's stroke rejected once it was no longer their turn");

        // B (current turn) parts the game mid-track. Server should:
        //  - mark slot 1 'p',
        //  - advance the turn to slot 2 (C),
        //  - keep the game running (A and C still present).
        b.sendData("game", "back");
        await a.waitFor((s) => /^d \d+ game\tpart\t1\t4$/.test(s), "A sees B part");
        await c.waitFor((s) => /^d \d+ game\tpart\t1\t4$/.test(s), "C sees B part");
        await a.waitFor((s) => /^d \d+ game\tstartturn\t2$/.test(s), "A startturn 2");
        await c.waitFor((s) => /^d \d+ game\tstartturn\t2$/.test(s), "C startturn 2");
        console.log("[OK] turn jumped past the leaver to slot 2");

        // C (current turn) can shoot.
        const mouseC = (250 * 1500 + 100 * 4 + 0).toString(36).padStart(4, "0");
        c.sendData("game", "beginstroke", ball, mouseC);
        await c.waitFor((s) => /^d \d+ game\tbeginstroke\t2\t/.test(s), "C sees own stroke");
        console.log("[OK] new current-turn player's stroke accepted");

        a.close();
        b.close();
        c.close();
        console.log("\nALL TURN-BASED PHASES PASSED");
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
