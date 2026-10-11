// Aapeli portal integration smoke test.
//
// Boots the server with `portal` enabled against a fake portal and checks:
// ticket-less and forged upgrades are refused, the ticket nickname overrides
// the client `nick`, finished daily runs of registered players are posted to
// `/internal/daily-result` and acknowledged with `game dailyrecord`, guests
// are not posted, and `c old` cannot adopt another profile's seat.
//
// Usage: node --experimental-strip-types --no-warnings src/test-portal.ts

import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "./main.ts";
import { loadPortalConfig, verifyTicket } from "./portal.ts";

const PORT = 4251;
const PORTAL_PORT = 4252;
const HOST = "127.0.0.1";
const KEY = "k".repeat(40);
const GAME = "minigolf-native";

function tracksDir(): string {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

interface TicketClaims {
    registered: boolean;
    nickname: string;
    profileId?: string;
    exp?: number;
    game?: string;
}

function ticket(claims: TicketClaims, key = KEY): string {
    const profileId = claims.profileId ?? randomUUID();
    const payload = {
        v: 2,
        purpose: "game-identity",
        registered: claims.registered,
        accountId: claims.registered ? randomUUID() : null,
        username: claims.registered ? claims.nickname.replace(/\W/g, "_") : null,
        profileId,
        sessionId: randomUUID(),
        game: claims.game ?? GAME,
        nickname: claims.nickname,
        clientIp: "127.0.0.1",
        exp: claims.exp ?? Math.floor(Date.now() / 1000) + 900,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
}

class Client {
    name: string;
    ws: WebSocket;
    outSeq = 0;
    received: string[] = [];

    constructor(name: string, query: string) {
        this.name = name;
        this.ws = new WebSocket(`ws://${HOST}:${PORT}/ws${query}`);
        this.ws.on("message", (m) => this.received.push(m.toString()));
    }
    async open(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.ws.once("open", () => resolve());
            this.ws.once("error", reject);
        });
    }
    sendData(...fields: (string | number)[]): void {
        this.ws.send(`d ${this.outSeq++} ${fields.join("\t")}`);
    }
    sendCommand(verb: string, ...args: string[]): void {
        this.ws.send(`c ${[verb, ...args].join(" ")}`);
    }
    async waitFor(predicate: (s: string) => boolean, label: string, timeoutMs = 4000): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                console.log(`[${this.name}] timed out waiting for ${label}; queue:`, this.received);
                reject(new Error(`[${this.name}] timeout: ${label}`));
            }, timeoutMs);
            const tick = (): void => {
                const idx = this.received.findIndex(predicate);
                if (idx >= 0) {
                    clearTimeout(timer);
                    resolve(this.received.splice(idx, 1)[0]);
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

async function expectRefused(query: string, label: string): Promise<void> {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws${query}`);
    const status = await new Promise<number | string>((resolve) => {
        ws.once("open", () => resolve("open"));
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("error", () => resolve("error"));
    });
    ws.terminate();
    if (status === "open") throw new Error(`${label}: upgrade was accepted`);
    console.log(`[OK] ${label} refused (${status})`);
}

async function login(c: Client, nick: string): Promise<number> {
    await c.waitFor((s) => s === "c ctr", "c ctr");
    c.sendCommand("new");
    const id = parseInt((await c.waitFor((s) => s.startsWith("c id "), "c id")).slice(5), 10);
    c.sendData("version", 35);
    c.sendData("language", "en");
    c.sendData("logintype", "nr");
    c.sendData("nick", nick);
    c.sendData("login");
    await c.waitFor((s) => /^d \d+ status\tlobbyselect/.test(s), "status lobbyselect");
    return id;
}

async function enterDaily(c: Client): Promise<void> {
    c.sendData("lobbyselect", "select", "d");
    await c.waitFor((s) => /^d \d+ game\tdailymode\t/.test(s), "dailymode");
}

function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
    const posts: { auth: string | undefined; body: Record<string, unknown> }[] = [];
    const portalHttp = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = JSON.parse(raw);
            posts.push({ auth: req.headers.authorization, body });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ saved: posts.length === 1 }));
        });
    });
    await new Promise<void>((r) => portalHttp.listen(PORTAL_PORT, HOST, r));

    const keyFile = path.join(mkdtempSync(path.join(tmpdir(), "portal-test-")), "key");
    writeFileSync(keyFile, KEY + "\n");
    const portal = loadPortalConfig({
        keyFile,
        internalUrl: `http://${HOST}:${PORTAL_PORT}`,
        publicApi: "https://aapeli.example/api",
        game: GAME,
        shareUrl: "https://aapeli.example/games/minigolf-native/",
    });

    assert(verifyTicket(portal, ticket({ registered: true, nickname: "Ok" })), "valid ticket rejected");
    assert(!verifyTicket(portal, ticket({ registered: true, nickname: "Ok", game: "pool" })), "other game accepted");
    assert(!verifyTicket(portal, ticket({ registered: true, nickname: "Ok", exp: 1 })), "expired accepted");
    assert(!verifyTicket(portal, ticket({ registered: true, nickname: "Ok" }, "x".repeat(40))), "wrong key accepted");
    assert(verifyTicket(portal, ticket({ registered: false, nickname: "a:b^c" }))?.nickname === "a b c", "nick not sanitised");
    console.log("[OK] ticket verification");

    let server: RunningServer | null = null;
    try {
        server = await startServer({ host: HOST, port: PORT, tracksDir: tracksDir(), verbose: false, portal });

        const config = (await (await fetch(`http://${HOST}:${PORT}/api/portal-config`)).json()) as { api?: string; game?: string; shareUrl?: string };
        assert(config.api === "https://aapeli.example/api" && config.game === GAME, "portal-config mismatch");
        assert(config.shareUrl === "https://aapeli.example/games/minigolf-native/", "portal-config shareUrl mismatch");
        console.log("[OK] /api/portal-config");

        await expectRefused("", "upgrade without ticket");
        await expectRefused(`?ticket=${ticket({ registered: true, nickname: "X" }, "y".repeat(40))}`, "forged ticket");

        const profileId = randomUUID();
        const member = new Client("member", `?ticket=${ticket({ registered: true, nickname: "Kalle", profileId })}`);
        await member.open();
        const memberId = await login(member, "Impostor");
        const player = server.golfServer.getPlayer(memberId);
        assert(player?.nick === "Kalle" && player.registered, `nick=${player?.nick} registered=${player?.registered}`);
        console.log("[OK] ticket nickname overrides client nick");

        await enterDaily(member);
        member.sendData("game", "forfeit");
        await member.waitFor((s) => /^d \d+ game\tend$/.test(s), "member end");
        await member.waitFor((s) => /^d \d+ game\tdailyrecord\tsaved$/.test(s), "dailyrecord saved");
        assert(posts.length === 1, `expected 1 portal post, got ${posts.length}`);
        const post = posts[0];
        assert(post.auth === `Bearer ${KEY}`, "missing bearer key");
        assert(post.body.game === GAME && post.body.profileId === profileId, "wrong identity posted");
        assert(post.body.holed === false && post.body.strokes === 1, `wrong result ${JSON.stringify(post.body)}`);
        assert(post.body.date === new Date().toISOString().slice(0, 10), "wrong date");
        console.log("[OK] registered daily result posted and acknowledged");

        const guest = new Client("guest", `?ticket=${ticket({ registered: false, nickname: "Vieras" })}`);
        await guest.open();
        await login(guest, "Ignored");
        await enterDaily(guest);
        guest.sendData("game", "forfeit");
        await guest.waitFor((s) => /^d \d+ game\tdailyrecord\tguest$/.test(s), "dailyrecord guest");
        assert(posts.length === 1, "guest result was posted");
        console.log("[OK] guest result not posted");

        // Seat takeover: drop the member abnormally, then try `c old` with
        // another profile's ticket.
        member.ws.terminate();
        await new Promise((r) => setTimeout(r, 200));
        const intruder = new Client("intruder", `?ticket=${ticket({ registered: true, nickname: "Mallory" })}`);
        await intruder.open();
        await intruder.waitFor((s) => s === "c ctr", "c ctr");
        intruder.sendCommand("old", String(memberId));
        await intruder.waitFor((s) => s === "c rcf", "rcf for foreign profile");
        const owner = new Client("owner", `?ticket=${ticket({ registered: true, nickname: "Kalle", profileId })}`);
        await owner.open();
        await owner.waitFor((s) => s === "c ctr", "c ctr");
        owner.sendCommand("old", String(memberId));
        await owner.waitFor((s) => s === "c rcok", "rcok for same profile");
        console.log("[OK] reconnect bound to portal profile");

        for (const c of [guest, intruder, owner]) c.close();
        console.log("\nALL PORTAL CHECKS PASSED");
    } finally {
        await server?.close();
        portalHttp.close();
    }
}

main().then(
    () => process.exit(0),
    (err) => {
        console.error(err);
        process.exit(1);
    },
);
