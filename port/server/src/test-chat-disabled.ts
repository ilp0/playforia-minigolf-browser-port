// Chat-disabled smoke test.
//
// Boots a fresh GolfServer with chatEnabled=false, walks two clients into the
// multi lobby, and asserts:
//   - Each client received `srvinfo chat 0` so the UI can hide its input.
//   - Sender of a `lobby say` gets a `lobby sayp server <text>` system whisper.
//   - The other client never receives A's chat (server drops it).
//
// Usage: node --experimental-strip-types --no-warnings src/test-chat-disabled.ts

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
    /** Asserts no message matching `predicate` arrives within `windowMs`. */
    async expectSilence(predicate: (s: string) => boolean, label: string, windowMs = 600): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < windowMs) {
            if (this.received.some(predicate)) {
                throw new Error(`[${this.name}] expected silence for ${label}, but got a match`);
            }
            await new Promise((r) => setTimeout(r, 30));
        }
    }
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
    await c.waitFor((s) => /^d \d+ srvinfo\tchat\t0$/.test(s), "srvinfo chat 0");
    await c.waitFor((s) => /^d \d+ basicinfo\t/.test(s), "basicinfo");
    await c.waitFor((s) => /^d \d+ status\tlobbyselect/.test(s), "status lobbyselect");
}

async function enterMultiLobby(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "x");
    await c.waitFor((s) => /^d \d+ status\tlobby\tx/.test(s), "status lobby x");
    await c.waitFor((s) => /^d \d+ lobby\townjoin/.test(s), "lobby ownjoin");
}

async function main(): Promise<void> {
    let server: RunningServer | null = null;
    try {
        server = await startServer({
            host: HOST,
            port: PORT,
            tracksDir: tracksDir(),
            verbose: false,
            chatEnabled: false,
        });
        console.log("[server] up (chat disabled)");

        const a = new Client("A");
        const b = new Client("B");
        await Promise.all([a.open(), b.open()]);

        await login(a);
        await login(b);
        console.log("[OK] both logged in, both received srvinfo chat 0");

        await enterMultiLobby(a);
        await enterMultiLobby(b);
        console.log("[OK] both in multi lobby");

        // A sends a chat. Server should bounce a system whisper to A and drop
        // it for B.
        a.sendData("lobby", "say", "hi from A");
        await a.waitFor(
            (s) => /^d \d+ lobby\tsayp\tserver\tChat is disabled on this server\.$/.test(s),
            "A receives server-disabled whisper",
        );
        await b.expectSilence((s) => /lobby\tsay\thi from A/.test(s), "B never sees A's chat");
        console.log("[OK] lobby say is dropped, sender gets system whisper, peer gets nothing");

        // Whisper is also gated.
        a.sendData("lobby", "sayp", "B", "secret");
        await a.waitFor(
            (s) => /^d \d+ lobby\tsayp\tserver\tChat is disabled on this server\.$/.test(s),
            "A receives server-disabled whisper for sayp",
        );
        await b.expectSilence((s) => /sayp\t.*secret/.test(s), "B never sees A's whisper");
        console.log("[OK] lobby sayp is dropped too");

        a.close();
        b.close();
        console.log("\nALL CHAT-DISABLED CHECKS PASSED");
    } finally {
        if (server) await server.close();
    }
}

main().catch((err) => {
    console.error("[test-chat-disabled] FAILED:", err);
    process.exit(1);
});
