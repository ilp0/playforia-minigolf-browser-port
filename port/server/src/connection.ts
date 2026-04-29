// Per-WebSocket connection wrapper. Mirrors Java's Channel + ClientState + IdleStateHandler.
//
// Wire framing: one packet per WebSocket text frame. No trailing "\n" - the WS frame
// boundary already delimits packets. We track per-direction sequence numbers (Java's
// SocketConnection does the same for DATA packets, COMMAND/HEADER/STRING packets are
// sequence-less).

import type { WebSocket } from "ws";
import { decode, type Packet, PacketType, buildCommand, buildData } from "@minigolf/shared";
import type { Player } from "./player.ts";
import type { GolfServer } from "./server.ts";
import { logEvent } from "./log.ts";

// Browsers throttle JS in background tabs (Chrome down to ~1Hz, sometimes
// even less). The original Java applet didn't have that problem, but our
// WebSocket connection does - be generous with the idle window so a quick
// alt-tab doesn't disconnect anyone mid-game.
const PING_AFTER_MS = 15_000;
const CLOSE_AFTER_MS = 60_000;
/**
 * Defensive cap on the number of newline-separated frames a single WS message
 * may produce. Belt-and-suspenders alongside the WebSocketServer's maxPayload:
 * a maxPayload-sized frame full of `\n` could still split into thousands of
 * tiny entries. Legit traffic is one packet per WS message.
 */
const MAX_FRAMES_PER_MESSAGE = 32;

export class Connection {
    /** Outbound DATA sequence number (server -> client). Increments per server-sent DATA packet. */
    public outSeq = 0;
    /** Expected next inbound DATA sequence number (client -> server). */
    public inSeq = 0;

    public player: Player | null = null;
    public lastActivity: number = Date.now();
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private closed = false;

    public readonly ws: WebSocket;
    public readonly server: GolfServer;
    public readonly verbose: boolean;
    /** Short random per-connection id (e.g. `c-x3k9q1mt`). Stamped on every
     *  analytics event involving this socket so a downstream consumer can
     *  group `client_connect` / `player_login` / `player_disconnect` lines
     *  for the same WS, even if the player record is reused via reconnect. */
    public readonly connId: string;
    /** Remote address from the HTTP upgrade socket. May be IPv4-mapped IPv6
     *  (`::ffff:1.2.3.4`) - left as-is so it round-trips back to the same
     *  bucket that `main.ts` uses for per-IP rate limiting. */
    public readonly remoteAddress: string;
    /** User-Agent header from the WS upgrade. Non-browser clients (smoke
     *  tests, server-to-server tooling) typically send `undefined` - we
     *  store the empty string so the field is always present in logs. */
    public readonly userAgent: string;
    /** Persistent browser-side UUID (from `localStorage["mg.clientId"]`) sent
     *  by the web client during the login handshake via the `cid` packet.
     *  Survives page refresh; lets analytics distinguish "same browser
     *  reloading" from "two unrelated guests". Null until the packet lands
     *  (or for non-browser clients that don't send one). Lives on Connection
     *  rather than Player so the `client_connect`/`client_disconnect` events
     *  - which fire pre-login and post-player-removal respectively - can
     *  still surface it. */
    public clientId: string | null = null;

    constructor(
        ws: WebSocket,
        server: GolfServer,
        verbose: boolean,
        remoteAddress: string,
        userAgent: string,
    ) {
        this.ws = ws;
        this.server = server;
        this.verbose = verbose;
        this.remoteAddress = remoteAddress;
        this.userAgent = userAgent;
        this.connId = "c-" + Math.random().toString(36).slice(2, 10);
        ws.on("message", (data) => {
            const text = typeof data === "string" ? data : data.toString("utf-8");
            this.lastActivity = Date.now();
            this.handleRawMessage(text);
        });
        ws.on("close", () => this.handleClose());
        ws.on("error", (err) => {
            if (this.verbose) console.error("[ws error]", err);
            this.handleClose();
        });

        this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), 1_000);

        // Connection-level analytics ping. Fires for every WS upgrade, even
        // ones that abort before login - so we see "browser opened a socket"
        // separately from "player completed handshake". `conn` ties it to
        // the eventual `player_login`/`player_disconnect` lines.
        logEvent("client_connect", {
            conn: this.connId,
            ip: this.remoteAddress,
            ua: this.userAgent,
        });

        // Send the initial handshake - this is what Java sends in ClientConnectedEvent.
        this.sendRaw("h 1");
        this.sendRaw("c crt 250");
        this.sendRaw("c ctr");
    }

    private handleRawMessage(text: string): void {
        // The browser/test client may glue multiple frames together via "\n" in some setups.
        // Split defensively - this also matches Java's line-delimited TCP framing.
        const frames = text.split(/\r?\n/).filter((f) => f.length > 0);
        // Defensive cap: even within the WS-level maxPayload, a frame full of
        // "\n" bytes would still produce thousands of 1-byte entries. Drop the
        // connection rather than dispatch each one.
        if (frames.length > MAX_FRAMES_PER_MESSAGE) {
            console.error(
                `[connection] frame-burst from ${this.playerLabel()}: ${frames.length} frames in one message`,
            );
            this.close("frame-burst");
            return;
        }
        for (const frame of frames) {
            let packet: Packet;
            try {
                packet = decode(frame);
            } catch (err) {
                console.error(
                    `[connection] decode failure (player=${this.playerLabel()}): ${err instanceof Error ? err.message : err}`,
                );
                this.close("decode-failure");
                return;
            }

            if (this.verbose) console.log(`<<< [${this.playerLabel()}] ${frame}`);

            if (packet.type === PacketType.DATA) {
                if (packet.seq === undefined) {
                    console.error(`[connection] DATA packet without seq from ${this.playerLabel()}: ${frame}`);
                    this.close("missing-seq");
                    return;
                }
                if (packet.seq !== this.inSeq) {
                    console.error(
                        `[connection] seq mismatch from ${this.playerLabel()}: expected ${this.inSeq} got ${packet.seq}; frame=${frame}`,
                    );
                    this.close("seq-mismatch");
                    return;
                }
                this.inSeq++;
            }

            this.server.dispatch(this, packet);
        }
    }

    private playerLabel(): string {
        return this.player ? `${this.player.id}/${this.player.nick}` : "anon";
    }

    private checkHeartbeat(): void {
        if (this.closed) return;
        const elapsed = Date.now() - this.lastActivity;
        if (elapsed > CLOSE_AFTER_MS) {
            this.close("idle-timeout");
        } else if (elapsed > PING_AFTER_MS) {
            this.sendRaw("c ping");
        }
    }

    private handleClose(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        // Connection-level disconnect - pairs with `client_connect`. The
        // higher-level `player_disconnect` (emitted from server.ts) fires
        // only when the socket carried a logged-in player; this one fires
        // even for sockets that never got past the handshake. `cid` is
        // included if the client got far enough to send it.
        logEvent("client_disconnect", {
            conn: this.connId,
            cid: this.clientId,
        });
        this.server.handleDisconnect(this);
    }

    /** Raw frame send. Used for h/c packets that have no per-direction sequence number. */
    sendRaw(line: string): void {
        if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
        if (this.verbose) console.log(`>>> ${line}`);
        this.ws.send(line);
    }

    sendCommand(verb: string, ...args: string[]): void {
        this.sendRaw(buildCommand(verb, ...args));
    }

    sendData(...fields: (string | number | boolean)[]): void {
        const seq = this.outSeq++;
        this.sendRaw(buildData(seq, ...fields));
    }

    /** Send an already-built tab-joined data body (no double-tabbing). */
    sendDataRaw(body: string): void {
        const seq = this.outSeq++;
        this.sendRaw(`d ${seq} ${body}`);
    }

    close(reason: string): void {
        if (this.closed) return;
        // Always log close reasons so disconnects are diagnosable.
        console.log(`[connection] closing ${this.playerLabel()}: ${reason}`);
        try {
            this.ws.close(1000, reason);
        } catch {
            // ignore
        }
        this.handleClose();
    }
}
