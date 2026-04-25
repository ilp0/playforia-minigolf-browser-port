// Entry point for the Node WebSocket server.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
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
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        host: "0.0.0.0",
        port: 4242,
        tracksDir: defaultTracksDir(),
        verbose: false,
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
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
    const target = path.join(webDist, urlPath);
    if (!target.startsWith(webDist)) return false;
    try {
        const st = statSync(target);
        if (!st.isFile()) return false;
        const mime = MIME[path.extname(target)] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
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

    const wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, sock, head) => {
        if (req.url !== "/ws") {
            sock.destroy();
            return;
        }
        wss.handleUpgrade(req, sock, head, (ws) => {
            new Connection(ws, golfServer, args.verbose);
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
