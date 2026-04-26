// Entry point for the Node WebSocket server.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, lstatSync } from "node:fs";
import * as path from "node:path";
import { WebSocketServer } from "ws";
import { GolfServer } from "./server.ts";
import { Connection } from "./connection.ts";
import { TrackManager } from "./tracks.ts";

interface CliArgs {
    host: string;
    port: number;
    tracksDir: string;
    verbose: boolean;
    /** Max simultaneous WS connections from one remote address. 0 disables the cap. Defaults to 16. */
    maxConnsPerIp?: number;
    /** When true, accept WS upgrades from any Origin (dev). Default rejects cross-origin. */
    allowAnyOrigin?: boolean;
}

const DEFAULT_MAX_CONNS_PER_IP = 16;

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        host: "0.0.0.0",
        port: 4242,
        tracksDir: defaultTracksDir(),
        verbose: false,
        maxConnsPerIp: DEFAULT_MAX_CONNS_PER_IP,
        allowAnyOrigin: false,
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
    ".svg": "image/svg+xml",
};

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
        res.writeHead(200, {
            "Content-Type": mime,
            "X-Content-Type-Options": "nosniff",
        });
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
    const golfServer = new GolfServer(trackManager);

    // Cache the per-category counts on each lobby so newcomers get the
    // numbers as soon as they enter (drives the lobby form's count chips).
    const counts = trackManager.getCategoryCounts();
    for (const lt of ["1", "2", "x"] as const) {
        try { golfServer.getLobby(lt).setTagCounts(counts); } catch { /* */ }
    }
    console.log(`[tracks] category counts: total=${counts[0]} basic=${counts[1]} traditional=${counts[2]} modern=${counts[3]} hio=${counts[4]} short=${counts[5]} long=${counts[6]}`);

    const webDist = path.resolve(args.tracksDir, "..", "..", "web", "dist");

    const http = createServer((req, res) => {
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

    return {
        close: async () => {
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
