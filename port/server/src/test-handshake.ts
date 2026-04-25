// End-to-end smoke test of the protocol handshake.
//
// Boots the GolfServer on port 4243, drives a WebSocket client through the
// connect -> guest-login -> select single-player lobby -> create training game
// flow, asserts the right packets land in the right order, and exits 0.
//
// Invoke: node --experimental-strip-types --no-warnings src/test-handshake.ts

import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";

const PORT = 4243;
const HOST = "127.0.0.1";

function tracksDir(): string {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

interface Pending {
    resolve: (s: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

class FrameQueue {
    private waiters: Pending[] = [];
    private buffer: string[] = [];
    private closed = false;

    push(frame: string): void {
        if (this.waiters.length > 0) {
            const w = this.waiters.shift()!;
            clearTimeout(w.timer);
            w.resolve(frame);
        } else {
            this.buffer.push(frame);
        }
    }

    fail(err: Error): void {
        this.closed = true;
        for (const w of this.waiters) {
            clearTimeout(w.timer);
            w.reject(err);
        }
        this.waiters = [];
    }

    next(timeoutMs = 5000): Promise<string> {
        if (this.buffer.length > 0) {
            return Promise.resolve(this.buffer.shift()!);
        }
        if (this.closed) return Promise.reject(new Error("closed"));
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.findIndex((w) => w.resolve === resolve);
                if (idx >= 0) this.waiters.splice(idx, 1);
                reject(new Error("timeout waiting for frame"));
            }, timeoutMs);
            this.waiters.push({ resolve, reject, timer });
        });
    }
}

function describe(s: string): string {
    return s.length > 200 ? s.slice(0, 200) + "..." : s;
}

function assertStartsWith(actual: string, prefix: string, label: string): void {
    if (!actual.startsWith(prefix)) {
        throw new Error(`expected ${label} to start with ${JSON.stringify(prefix)} but got ${JSON.stringify(describe(actual))}`);
    }
    console.log(`  ok: ${label}: ${describe(actual)}`);
}

async function run(): Promise<void> {
    const running: RunningServer = await startServer({
        host: HOST,
        port: PORT,
        tracksDir: tracksDir(),
        verbose: false,
    });

    let exitCode = 0;
    try {
        const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`);
        const queue = new FrameQueue();

        ws.on("message", (data) => {
            const text = typeof data === "string" ? data : data.toString("utf-8");
            for (const line of text.split(/\r?\n/)) {
                if (line.length > 0) queue.push(line);
            }
        });
        ws.on("close", () => queue.fail(new Error("ws closed")));
        ws.on("error", (err) => queue.fail(err));

        await new Promise<void>((resolve, reject) => {
            ws.once("open", () => resolve());
            ws.once("error", (err) => reject(err));
        });

        console.log("Phase 1: handshake banner");
        assertStartsWith(await queue.next(), "h 1", "header");
        assertStartsWith(await queue.next(), "c crt 250", "crt");
        assertStartsWith(await queue.next(), "c ctr", "ctr");

        console.log("Phase 2: c new -> c id");
        ws.send("c new");
        const idLine = await queue.next();
        assertStartsWith(idLine, "c id ", "c id");
        const playerId = parseInt(idLine.substring(5), 10);
        if (!Number.isFinite(playerId) || playerId < 1) {
            throw new Error(`bad player id in: ${idLine}`);
        }

        console.log("Phase 3: version handshake");
        ws.send("d 0 version\t35");
        assertStartsWith(await queue.next(), "d 0 status\tlogin", "status login (post-version)");

        console.log("Phase 4: language + logintype + login");
        ws.send("d 1 language\ten");
        ws.send("d 2 logintype\tnr");
        assertStartsWith(await queue.next(), "d 1 status\tlogin", "status login (post-logintype)");

        ws.send("d 3 login");
        assertStartsWith(await queue.next(), "d 2 basicinfo\tt\t0\tt\tt", "basicinfo");
        assertStartsWith(await queue.next(), "d 3 status\tlobbyselect\t300", "status lobbyselect");

        console.log("Phase 5: enter single-player lobby");
        ws.send("d 4 lobbyselect\tselect\t1");
        assertStartsWith(await queue.next(), "d 4 status\tlobby\t1", "status lobby 1");
        assertStartsWith(await queue.next(), "d 5 lobby\tusers", "lobby users");
        assertStartsWith(await queue.next(), "d 6 lobby\townjoin\t", "lobby ownjoin");

        console.log("Phase 6: start training game");
        // Per Java's LobbyCreateSinglePlayerHandler comment, the client sends "lobby\tcspt..."
        // when already in the lobby, "lobbyselect\tcspt..." when jumping straight from lobbyselect.
        ws.send("d 5 lobby\tcspt\t1\t0\t0");
        // Lobby part for STARTED_SP is broadcast to remaining lobby players (none here),
        // so the next frames the client sees are the game-related ones from sendJoinMessages.
        assertStartsWith(await queue.next(), "d 7 status\tgame", "status game");
        assertStartsWith(await queue.next(), "d 8 game\tgameinfo\t", "game gameinfo");
        assertStartsWith(await queue.next(), "d 9 game\tplayers", "game players");
        assertStartsWith(await queue.next(), "d 10 game\towninfo\t0\t", "game owninfo");
        assertStartsWith(await queue.next(), "d 11 game\tstart", "game start");
        assertStartsWith(await queue.next(), "d 12 game\tresetvoteskip", "game resetvoteskip");
        assertStartsWith(await queue.next(), "d 13 game\tstarttrack\t", "game starttrack");
        assertStartsWith(await queue.next(), "d 14 game\tstartturn\t0", "game startturn");

        console.log("\nALL PHASES PASSED");
        ws.close();
    } catch (err) {
        console.error("\nFAIL:", err instanceof Error ? err.message : err);
        exitCode = 1;
    } finally {
        await running.close();
    }
    process.exit(exitCode);
}

run().catch((err) => {
    console.error("fatal:", err);
    process.exit(2);
});
