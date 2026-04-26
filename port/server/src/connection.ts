// Per-WebSocket connection wrapper. Mirrors Java's Channel + ClientState + IdleStateHandler.
//
// Wire framing: one packet per WebSocket text frame. No trailing "\n" — the WS frame
// boundary already delimits packets. We track per-direction sequence numbers (Java's
// SocketConnection does the same for DATA packets, COMMAND/HEADER/STRING packets are
// sequence-less).

import type { WebSocket } from "ws";
import { decode, type Packet, PacketType, buildCommand, buildData } from "@minigolf/shared";
import type { Player } from "./player.ts";
import type { GolfServer } from "./server.ts";

// Browsers throttle JS in background tabs (Chrome down to ~1Hz, sometimes
// even less). The original Java applet didn't have that problem, but our
// WebSocket connection does — be generous with the idle window so a quick
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

    constructor(ws: WebSocket, server: GolfServer, verbose: boolean) {
        this.ws = ws;
        this.server = server;
        this.verbose = verbose;
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

        // Send the initial handshake — this is what Java sends in ClientConnectedEvent.
        this.sendRaw("h 1");
        this.sendRaw("c crt 250");
        this.sendRaw("c ctr");
    }

    private handleRawMessage(text: string): void {
        // The browser/test client may glue multiple frames together via "\n" in some setups.
        // Split defensively — this also matches Java's line-delimited TCP framing.
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
