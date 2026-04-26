import {
  buildCommand,
  buildData,
  decode,
  encode,
  type Packet,
  PacketType,
} from "@minigolf/shared";

const DEV = Boolean(import.meta.env?.DEV);

/** Auto-reconnect tunables. The server's grace window (`c crt 250`) is far
 *  longer than what we attempt here — the asymmetry is intentional: we'd
 *  rather declare the session dead and surface a clear error than thrash
 *  for four minutes against a dead network. */
const RECONNECT_INTERVAL_MS = 3_000;
const RECONNECT_MAX_ATTEMPTS = 10;

export type ConnectionEventMap = {
  open: Event;
  close: CloseEvent;
  packet: CustomEvent<Packet>;
  error: CustomEvent<{ message: string; cause?: unknown }>;
  /** Emitted when the connection is dead but we're trying to recover.
   *  Detail.attempt is 1-indexed (first try is 1). */
  reconnecting: CustomEvent<{ attempt: number; maxAttempts: number }>;
  /** Emitted on successful `c rcok` — caller should hide any reconnect UI
   *  and continue. Seqs have been reset; in-flight panel state is preserved. */
  reconnected: Event;
  /** Emitted when the server replied `c rcf`, or we exhausted retries.
   *  Detail.reason is "rcf" for server-rejected, "exhausted" for retry budget. */
  "reconnect-failed": CustomEvent<{ reason: "rcf" | "exhausted" }>;
};

/**
 * WebSocket wrapper that mirrors the Java client's line-protocol semantics.
 *
 * Each text frame contains exactly one packet (no trailing newline).
 * Both directions maintain a sequence counter for `d` (data) packets.
 *
 * On abnormal close (network blip / 1006), if a server-assigned id was
 * captured during login, the wrapper transparently swaps in a fresh inner
 * WebSocket and walks the `c old <id>` reconnect handshake — see
 * `port/docs/PROTOCOL.md` "Reconnect" section.
 */
export class Connection extends EventTarget {
  readonly url: string;
  private ws: WebSocket | null = null;
  private outSeq = 0;
  private inSeq = 0;
  /** True once `close()` has been called by the user (panel teardown, full
   *  reload). Suppresses auto-reconnect even on abnormal close. */
  private userClosed = false;
  /** Proactive keepalive timer — sends `c ping` to the server on a fixed
   *  interval so background-tab throttling can't hit the server's 60s idle cap. */
  private keepaliveTimer: number | null = null;

  /** Server-assigned player id, captured from `c id <N>` during initial login.
   *  Used as the reconnect token in `c old <savedId>`. */
  private savedId: string | null = null;
  /** True between an abnormal close and either a `c rcok`/`c rcf` reply or
   *  the retry budget being exhausted. While set, packet handling intercepts
   *  the reconnect-handshake commands instead of forwarding them to panels. */
  private reconnecting = false;
  /** Number of reconnect attempts made for the current dead-connection event.
   *  Reset on `c rcok` or on the next abnormal close. */
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  /** Once we've fired a terminal `reconnect-failed`, the inevitable WS close
   *  event would also fire `close` and overwrite the App's
   *  "Reconnect refused" banner with the generic "Connection closed". This
   *  flag suppresses that redundant follow-up. */
  private finalEventEmitted = false;

  constructor(url: string) {
    super();
    this.url = url;
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", (ev) => {
      if (DEV) console.debug("[conn] open", this.url);
      // The 'open' event is suppressed during reconnect — the panel doesn't
      // need to redo handshake-bound bookkeeping (it already mounted on the
      // first open). It'll get a 'reconnected' event once `c rcok` lands.
      if (!this.reconnecting) this.dispatchEvent(new Event("open"));
      this.startKeepalive();
      void ev;
    });

    ws.addEventListener("close", (ev) => {
      if (this.keepaliveTimer !== null) {
        window.clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }
      if (DEV) console.debug("[conn] close", ev.code, ev.reason, "wasClean=" + ev.wasClean);

      // Decide between (a) trying to reconnect or (b) surfacing the close.
      // Auto-reconnect only when:
      //  - the user didn't initiate the close,
      //  - we have a savedId (i.e. login completed),
      //  - close was abnormal (browser code 1006 / wasClean=false). A clean
      //    close usually means the server intentionally closed (idle-timeout,
      //    seq-mismatch, etc.) and retrying would just re-trigger the same.
      const shouldReconnect =
        !this.userClosed &&
        this.savedId !== null &&
        !ev.wasClean &&
        this.reconnectAttempt < RECONNECT_MAX_ATTEMPTS;

      if (shouldReconnect) {
        this.scheduleReconnect();
        return;
      }

      // If we were already mid-reconnect and ran out of attempts, surface
      // the failure as a `reconnect-failed` event so App can show the right
      // UI. Otherwise dispatch the original close so existing handlers
      // (App.showError) keep working.
      if (this.reconnecting) {
        this.reconnecting = false;
        this.finalEventEmitted = true;
        this.dispatchEvent(
          new CustomEvent<{ reason: "rcf" | "exhausted" }>("reconnect-failed", {
            detail: { reason: "exhausted" },
          }),
        );
      }
      // Skip the generic close-event dispatch once a terminal
      // `reconnect-failed` has already explained the failure — otherwise the
      // App's error banner would flicker from "Reconnect refused" to
      // "Connection closed" on the trailing socket close.
      if (!this.finalEventEmitted) {
        this.dispatchEvent(
          new CloseEvent("close", {
            code: ev.code,
            reason: ev.reason,
            wasClean: ev.wasClean,
          }),
        );
      }
    });

    ws.addEventListener("error", () => {
      if (DEV) console.debug("[conn] socket error");
      // Don't surface the error during reconnect — the failed attempt is
      // about to fire its own close, which scheduleReconnect handles.
      if (!this.reconnecting) this.emitError("websocket error");
    });

    ws.addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      if (!data) return;
      this.handleLine(data);
    });
  }

  private startKeepalive(): void {
    // Start proactive keepalive — every 15s, push a `c ping` so the server
    // sees inbound activity and won't time us out (server cap is 60s).
    // setInterval still fires in background tabs, just throttled to ~1Hz
    // minimum, which is plenty for our 15s cadence.
    if (this.keepaliveTimer !== null) window.clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send("c ping"); } catch { /* ignore */ }
      }
    }, 15_000);
  }

  private scheduleReconnect(): void {
    this.reconnecting = true;
    this.reconnectAttempt++;
    if (DEV) console.debug(`[conn] reconnect attempt ${this.reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS}`);
    this.dispatchEvent(
      new CustomEvent<{ attempt: number; maxAttempts: number }>("reconnecting", {
        detail: { attempt: this.reconnectAttempt, maxAttempts: RECONNECT_MAX_ATTEMPTS },
      }),
    );
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.userClosed) return;
      this.connect();
    }, RECONNECT_INTERVAL_MS);
  }

  private handleLine(line: string): void {
    let pkt: Packet;
    try {
      pkt = decode(line);
    } catch (err) {
      this.emitError("decode failed: " + String(err), err);
      return;
    }

    if (DEV) console.debug("[conn] <-", line);

    // While in reconnect mode, intercept the handshake control packets so
    // panels don't see a second hello/ctr cycle. Seq counters on the server
    // side are also fresh on the new socket, so DATA flows between this
    // burst and `c rcok` shouldn't happen — only the four-frame banner
    // (h 1 / c crt / c ctr) and the `c rcok`/`c rcf` reply.
    if (this.reconnecting) {
      if (pkt.type === PacketType.HEADER) return;
      if (pkt.type === PacketType.COMMAND) {
        const verb = pkt.fields[0];
        if (verb === "crt") return;
        if (verb === "ctr") {
          // Drive the reconnect with the saved id. The savedId is non-null
          // here (gated by the close-handler before scheduleReconnect ran).
          this.send(buildCommand("old", this.savedId ?? ""));
          return;
        }
        if (verb === "rcok") {
          this.finishReconnect();
          return;
        }
        if (verb === "rcf") {
          this.reconnecting = false;
          this.savedId = null;
          this.finalEventEmitted = true;
          this.dispatchEvent(
            new CustomEvent<{ reason: "rcf" | "exhausted" }>("reconnect-failed", {
              detail: { reason: "rcf" },
            }),
          );
          // Tear down the WS — App will surface the error and we don't want
          // a half-alive socket lingering. The follow-up close event won't
          // re-dispatch, gated by `finalEventEmitted`.
          try { this.ws?.close(); } catch { /* */ }
          return;
        }
      }
    }

    // Validate seq on incoming data packets.
    if (pkt.type === PacketType.DATA) {
      if (pkt.seq !== this.inSeq) {
        this.emitError(
          `seq mismatch: expected ${this.inSeq}, got ${pkt.seq}`,
        );
        this.close();
        return;
      }
      this.inSeq++;
    }

    // Auto-reply pong to ping commands.
    if (pkt.type === PacketType.COMMAND && pkt.fields[0] === "ping") {
      this.send(buildCommand("pong"));
    }

    // Capture the server-assigned id once per session — used as the
    // reconnect token in `c old <id>` on subsequent abnormal closes.
    if (
      this.savedId === null &&
      pkt.type === PacketType.COMMAND &&
      pkt.fields[0] === "id" &&
      pkt.fields[1]
    ) {
      this.savedId = pkt.fields[1];
    }

    this.dispatchEvent(
      new CustomEvent<Packet>("packet", { detail: pkt }),
    );
  }

  private finishReconnect(): void {
    if (DEV) console.debug("[conn] reconnect ok — resuming");
    // Server reset its seq counters on the new socket; mirror that locally.
    // Without this, the next inbound DATA packet (seq=0) would trip the
    // mismatch check against our stale inSeq.
    this.outSeq = 0;
    this.inSeq = 0;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.dispatchEvent(new Event("reconnected"));
  }

  private emitError(message: string, cause?: unknown): void {
    this.dispatchEvent(
      new CustomEvent<{ message: string; cause?: unknown }>("error", {
        detail: { message, cause },
      }),
    );
  }

  /** Send a raw wire string (must already be a valid packet). */
  send(line: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (DEV) console.debug("[conn] drop send (not open):", line);
      return;
    }
    if (DEV) console.debug("[conn] ->", line);
    this.ws.send(line);
  }

  /** Build and send a `d <seq> ...` data packet, incrementing outSeq. */
  sendData(...fields: (string | number | boolean)[]): void {
    const line = buildData(this.outSeq, ...fields);
    this.outSeq++;
    this.send(line);
  }

  /** Build and send a `c <verb> <args>` command packet. */
  sendCommand(verb: string, ...args: string[]): void {
    this.send(buildCommand(verb, ...args));
  }

  close(): void {
    if (this.userClosed) return;
    this.userClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** True while the wrapper is actively trying to recover from a network
   *  blip (between abnormal close and `c rcok`/`c rcf`/exhausted). Panels
   *  can read this if they want to suppress noisy intermediate state. */
  get isReconnecting(): boolean {
    return this.reconnecting;
  }

  // Typed addEventListener overloads for our custom events.
  override addEventListener<K extends keyof ConnectionEventMap>(
    type: K,
    listener: (ev: ConnectionEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
  }

  override removeEventListener<K extends keyof ConnectionEventMap>(
    type: K,
    listener: (ev: ConnectionEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
  }
}

// Re-export to silence unused-import warning when encoding is needed elsewhere.
export { encode };
