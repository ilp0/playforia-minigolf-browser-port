// Entry point for the Node WebSocket server.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, lstatSync } from "node:fs";
import * as path from "node:path";
import { WebSocketServer } from "ws";
import { GolfServer } from "./server.ts";
import { Connection } from "./connection.ts";
import { TrackManager } from "./tracks.ts";
import { getReplay, saveReplay } from "./replay-store.ts";
import { LobbyType } from "./lobby.ts";
import { logEvent } from "./log.ts";

/** Cadence for the analytics `snapshot` event — short enough to give a
 *  reasonable population time-series, long enough that an idle server
 *  doesn't spam the logs. */
const SNAPSHOT_INTERVAL_MS = 60_000;

interface CliArgs {
    host: string;
    port: number;
    tracksDir: string;
    verbose: boolean;
    /** Max simultaneous WS connections from one remote address. 0 disables the cap. Defaults to 16. */
    maxConnsPerIp?: number;
    /** When true, accept WS upgrades from any Origin (dev). Default rejects cross-origin. */
    allowAnyOrigin?: boolean;
    /** When false, the server drops lobby/game chat packets. Operators can flip this off
     *  via `CHAT_ENABLED=0` (or `--chat-disabled`) to host without moderating chat.
     *  Optional in CliArgs so smoke-test fixtures can omit it; main() always populates. */
    chatEnabled?: boolean;
}

const DEFAULT_MAX_CONNS_PER_IP = 16;

/** Parse a boolean env var, accepting the usual on/off spellings. Falls back to `defaultValue`
 *  on unset/unparseable input so a typo can't silently disable a feature. */
function envBool(name: string, defaultValue: boolean): boolean {
    const v = process.env[name];
    if (v === undefined) return defaultValue;
    const s = v.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    return defaultValue;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        host: "0.0.0.0",
        port: 4242,
        tracksDir: defaultTracksDir(),
        verbose: false,
        maxConnsPerIp: DEFAULT_MAX_CONNS_PER_IP,
        allowAnyOrigin: false,
        chatEnabled: envBool("CHAT_ENABLED", true),
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--port" && i + 1 < argv.length) {
            args.port = parseInt(argv[++i], 10);
        } else if (a === "--host" && i + 1 < argv.length) {
            args.host = argv[++i];
        } else if (a === "--tracks-dir" && i + 1 < argv.length) {
            args.tracksDir = argv[++i];
        } else if (a === "--verbose") {
            args.verbose = true;
        } else if (a === "--max-conns-per-ip" && i + 1 < argv.length) {
            args.maxConnsPerIp = Math.max(0, parseInt(argv[++i], 10) || 0);
        } else if (a === "--allow-any-origin") {
            args.allowAnyOrigin = true;
        } else if (a === "--chat-disabled") {
            args.chatEnabled = false;
        } else if (a === "--chat-enabled") {
            args.chatEnabled = true;
        }
    }
    return args;
}

function defaultTracksDir(): string {
    // Resolve relative to this file: <serverRoot>/tracks
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
    return path.resolve(here, "..", "tracks");
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".xml": "application/xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

// Vite-fingerprinted bundles under /assets/ are content-addressed, so we can
// pin them with a year-long immutable cache. Everything else gets a short
// cache + must-revalidate so changes don't get stuck.
function cacheControlFor(urlPath: string): string {
    if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
    if (urlPath === "/index.html" || urlPath === "/") return "no-cache";
    return "public, max-age=300, must-revalidate";
}

/**
 * `/api/replay` endpoints — POST a JSON-encoded `DailyReplay`, get back a
 * short id; GET `/api/replay/<id>` returns the stored payload. Sized for
 * casual share-link traffic, not a public service: an ID-validation regex
 * gates GETs and a 64 KB cap gates POST bodies. Replays sit in memory
 * only — see replay-store.ts for the eviction policy.
 *
 * Returns `true` if the request was an /api/replay route (handled here);
 * `false` to let the static-file path try.
 */
const REPLAY_ID_RE = /^[a-z0-9]{8}$/;
const MAX_REPLAY_BYTES = 64 * 1024;

function handleReplayApi(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? "";
    if (!url.startsWith("/api/replay")) return false;

    if (req.method === "POST" && url === "/api/replay") {
        let total = 0;
        const chunks: Buffer[] = [];
        let aborted = false;
        req.on("data", (c: Buffer) => {
            total += c.length;
            if (total > MAX_REPLAY_BYTES) {
                if (aborted) return;
                aborted = true;
                res.writeHead(413, { "Content-Type": "text/plain" });
                res.end("Payload too large");
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            if (aborted) return;
            const body = Buffer.concat(chunks).toString("utf-8");
            // Validate JSON shape minimally — we don't decode the full
            // DailyReplay schema here, just confirm it's parseable JSON
            // and isn't empty. The client-side decoder enforces the schema
            // when it fetches the replay back.
            try {
                const parsed = JSON.parse(body);
                if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
            } catch {
                res.writeHead(400, { "Content-Type": "text/plain" });
                res.end("Invalid JSON");
                return;
            }
            const id = saveReplay(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ id }));
        });
        return true;
    }

    if (req.method === "GET") {
        const m = /^\/api\/replay\/([^/?]+)/.exec(url);
        if (m && REPLAY_ID_RE.test(m[1])) {
            const payload = getReplay(m[1]);
            if (payload === null) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Replay expired or not found");
                return true;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(payload);
            return true;
        }
    }

    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
    return true;
}

function tryServeStatic(req: IncomingMessage, res: ServerResponse, webDist: string): boolean {
    if (!req.url) return false;
    if (req.url === "/ws") return false;
    let urlPath: string;
    try {
        urlPath = decodeURIComponent(req.url.split("?")[0]);
    } catch {
        return false;
    }
    if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
    // NUL byte refuses to fs.statSync but block early as defence-in-depth.
    if (urlPath.includes("\0")) return false;
    const target = path.join(webDist, urlPath);
    // The trailing path.sep is load-bearing: without it, `webDist/../dist-evil/x`
    // resolves to `…/dist-evil/x` and would pass a bare `startsWith(webDist)`
    // (since "dist-evil" shares the "dist" prefix). Allow exact equality
    // (`urlPath === ""` after normalisation) too.
    const webDistWithSep = webDist.endsWith(path.sep) ? webDist : webDist + path.sep;
    if (target !== webDist && !target.startsWith(webDistWithSep)) return false;
    try {
        // lstatSync, not statSync: refuse to follow symlinks that escape webDist.
        const st = lstatSync(target);
        if (!st.isFile()) return false;
        const mime = MIME[path.extname(target)] ?? "application/octet-stream";
        // Weak ETag from size+mtime is enough here — the assets are static
        // and only change on rebuild/restart, so collisions are not a worry.
        const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
        const lastModified = new Date(st.mtimeMs).toUTCString();
        const ifNoneMatch = req.headers["if-none-match"];
        const ifModifiedSince = req.headers["if-modified-since"];
        if (ifNoneMatch === etag ||
            (ifModifiedSince && Date.parse(ifModifiedSince) >= Math.floor(st.mtimeMs / 1000) * 1000)) {
            res.writeHead(304, {
                "ETag": etag,
                "Last-Modified": lastModified,
                "Cache-Control": cacheControlFor(urlPath),
            });
            res.end();
            return true;
        }
        res.writeHead(200, {
            "Content-Type": mime,
            "Content-Length": st.size,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": cacheControlFor(urlPath),
            "ETag": etag,
            "Last-Modified": lastModified,
        });
        if (req.method === "HEAD") {
            res.end();
            return true;
        }
        createReadStream(target).pipe(res);
        return true;
    } catch {
        return false;
    }
}

export interface RunningServer {
    close(): Promise<void>;
}

export async function startServer(args: CliArgs): Promise<RunningServer> {
    const trackManager = new TrackManager();
    await trackManager.load(args.tracksDir);
    const chatEnabled = args.chatEnabled ?? true;
    const golfServer = new GolfServer(trackManager, { chatEnabled });
    if (!chatEnabled) {
        console.log("[chat] disabled — say/sayp packets will be dropped with a notice to the sender");
    }

    // Cache the per-category counts on each lobby so newcomers get the
    // numbers as soon as they enter (drives the lobby form's count chips).
    const counts = trackManager.getCategoryCounts();
    for (const lt of ["1", "2", "x"] as const) {
        try { golfServer.getLobby(lt).setTagCounts(counts); } catch { /* */ }
    }
    console.log(`[tracks] category counts: total=${counts[0]} basic=${counts[1]} traditional=${counts[2]} modern=${counts[3]} hio=${counts[4]} short=${counts[5]} long=${counts[6]}`);

    const webDist = path.resolve(args.tracksDir, "..", "..", "web", "dist");

    const http = createServer((req, res) => {
        if (handleReplayApi(req, res)) return;
        if (tryServeStatic(req, res, webDist)) return;
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
    });

    // Cap inbound WS frame size at 16 KiB. The ws default is 100 MiB, which is
    // an unbounded-growth foothold for a misbehaving or malicious client; legit
    // packets in this protocol (chat, cursor, stroke) are well under 1 KiB.
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

    const maxConnsPerIp = args.maxConnsPerIp ?? DEFAULT_MAX_CONNS_PER_IP;
    const allowAnyOrigin = args.allowAnyOrigin ?? false;

    // Live count of WS connections per remote address. A single client opening
    // thousands of sockets is the cheapest DoS surface in the codebase, so cap.
    const ipConnCount = new Map<string, number>();

    http.on("upgrade", (req, sock, head) => {
        if (req.url !== "/ws") {
            sock.destroy();
            return;
        }

        // Same-origin guard. Without this any third-party page can drive a
        // visitor's browser into our server (chat, lurking, free compute).
        // We compare host of the Origin to the request's Host header — the
        // operator can pass --allow-any-origin for dev/cross-host tooling.
        if (!allowAnyOrigin) {
            const origin = req.headers.origin;
            const host = req.headers.host;
            if (origin) {
                let originHost: string | null = null;
                try { originHost = new URL(origin).host; } catch { /* malformed */ }
                if (originHost === null || originHost !== host) {
                    sock.destroy();
                    return;
                }
            }
            // Origin omitted is allowed — non-browser clients (test harnesses,
            // server-to-server tooling) don't send one. Browsers always do.
        }

        // Per-IP cap. `req.socket.remoteAddress` is the immediate peer; if the
        // server sits behind a reverse proxy on the same host that's a single
        // bucket, but on a public deployment without a proxy this is a real
        // limit on the easiest DoS path.
        const remote = req.socket.remoteAddress ?? "?";
        if (maxConnsPerIp > 0) {
            const cur = ipConnCount.get(remote) ?? 0;
            if (cur >= maxConnsPerIp) {
                sock.destroy();
                return;
            }
            ipConnCount.set(remote, cur + 1);
        }

        wss.handleUpgrade(req, sock, head, (ws) => {
            new Connection(ws, golfServer, args.verbose);
            ws.on("close", () => {
                if (maxConnsPerIp > 0) {
                    const cur = ipConnCount.get(remote) ?? 0;
                    if (cur <= 1) ipConnCount.delete(remote);
                    else ipConnCount.set(remote, cur - 1);
                }
            });
        });
    });

    await new Promise<void>((resolve) => http.listen(args.port, args.host, resolve));
    console.log(`[server] listening ws://${args.host}:${args.port}/ws`);

    logEvent("server_start", {
        host: args.host,
        port: args.port,
        chat: chatEnabled,
        tracks_total: counts[0],
    });

    // Periodic population snapshot — one structured line per minute summarising
    // who's connected and where. Lets offline analysis (e.g. via `kubectl logs |
    // jq 'select(.evt=="snapshot")'`) reconstruct a player-count time-series
    // even on an idle server. unref() so smoke-tests can exit cleanly without
    // waiting for the next tick.
    const snapshotTimer = setInterval(() => {
        const snap: Record<string, unknown> = {
            players: golfServer.playerCount(),
        };
        for (const [tag, name] of [
            [LobbyType.SINGLE, "single"],
            [LobbyType.DUAL, "dual"],
            [LobbyType.MULTI, "multi"],
            [LobbyType.DAILY, "daily"],
        ] as const) {
            const lob = golfServer.getLobby(tag);
            snap[name] = {
                lobby: lob.playerCount(),
                games: lob.gameCount(),
                in_game: lob.inGamePlayerCount(),
            };
        }
        logEvent("snapshot", snap);
    }, SNAPSHOT_INTERVAL_MS);
    snapshotTimer.unref();

    return {
        close: async () => {
            clearInterval(snapshotTimer);
            await new Promise<void>((resolve) => {
                wss.close(() => resolve());
            });
            await new Promise<void>((resolve) => http.close(() => resolve()));
        },
    };
}

const isMainModule = (): boolean => {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const here = new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");
    return path.resolve(argv1) === path.resolve(here);
};

if (isMainModule()) {
    const args = parseArgs(process.argv);
    startServer(args).catch((err) => {
        console.error("[server] fatal:", err);
        process.exit(1);
    });
}
