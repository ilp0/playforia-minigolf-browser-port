import {
  buildCommand,
  buildData,
  decode,
  encode,
  type Packet,
  PacketType,
} from "@minigolf/shared";

const DEV = Boolean(import.meta.env?.DEV);

export type ConnectionEventMap = {
  open: Event;
  close: CloseEvent;
  packet: CustomEvent<Packet>;
  error: CustomEvent<{ message: string; cause?: unknown }>;
};

/**
 * WebSocket wrapper that mirrors the Java client's line-protocol semantics.
 *
 * Each text frame contains exactly one packet (no trailing newline).
 * Both directions maintain a sequence counter for `d` (data) packets.
 */
export class Connection extends EventTarget {
  readonly url: string;
  private ws: WebSocket | null = null;
  private outSeq = 0;
  private inSeq = 0;
  private closed = false;
  /** Proactive keepalive timer — sends `c ping` to the server on a fixed
   *  interval so background-tab throttling can't hit the server's 60s idle cap. */
  private keepaliveTimer: number | null = null;

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
      this.dispatchEvent(new Event("open"));
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
      void ev;
    });

    ws.addEventListener("close", (ev) => {
      this.closed = true;
      if (this.keepaliveTimer !== null) {
        window.clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }
      if (DEV) console.debug("[conn] close", ev.code, ev.reason);
      this.dispatchEvent(
        new CloseEvent("close", {
          code: ev.code,
          reason: ev.reason,
          wasClean: ev.wasClean,
        }),
      );
    });

    ws.addEventListener("error", () => {
      if (DEV) console.debug("[conn] socket error");
      this.emitError("websocket error");
    });

    ws.addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? ev.data : "";
      if (!data) return;
      this.handleLine(data);
    });
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

    this.dispatchEvent(
      new CustomEvent<Packet>("packet", { detail: pkt }),
    );
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
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
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
