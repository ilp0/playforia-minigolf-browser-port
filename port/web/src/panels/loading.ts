import { PacketType, type Packet } from "@minigolf/shared";
import type { App } from "../app.ts";
import type { Panel } from "../panel.ts";
import { t } from "../i18n.ts";

/**
 * First panel shown. Waits for:
 *   - Connection 'open'
 *   - Server `h 1` handshake
 *   - Server `c id <id>` identifier
 * Then transitions to login.
 */
export class LoadingPanel implements Panel {
  private app: App;
  private bar: HTMLElement | null = null;
  private progress = 0;
  private gotOpen = false;
  private gotHello = false;
  private gotId = false;
  private openHandler: (() => void) | null = null;

  constructor(app: App) {
    this.app = app;
  }

  mount(root: HTMLElement): void {
    const wrap = document.createElement("div");
    wrap.className = "panel-loading";

    const heading = document.createElement("h1");
    heading.textContent = t("Loader_LoadingGame", "Loading game...");
    wrap.appendChild(heading);

    const progress = document.createElement("div");
    progress.className = "progress";
    const bar = document.createElement("div");
    bar.className = "progress-bar";
    progress.appendChild(bar);
    wrap.appendChild(progress);

    this.bar = bar;
    root.appendChild(wrap);

    this.updateBar();

    // Already open? mark immediately.
    if (this.app.connection.isOpen) {
      this.markOpen();
    } else {
      const handler = () => this.markOpen();
      this.openHandler = handler;
      this.app.connection.addEventListener("open", handler);
    }
  }

  unmount(): void {
    if (this.openHandler) {
      this.app.connection.removeEventListener("open", this.openHandler);
      this.openHandler = null;
    }
    this.bar = null;
  }

  onPacket(pkt: Packet): void {
    if (pkt.type === PacketType.HEADER) {
      // The Java server sends "h 1" once on connect.
      this.gotHello = true;
      this.advance();
      return;
    }
    if (pkt.type === PacketType.COMMAND) {
      const verb = pkt.fields[0];
      if (verb === "id") {
        this.app.serverId = pkt.fields[1] ?? null;
        this.gotId = true;
        this.advance();
      }
      // 'crt' and 'ctr' are observed during handshake; nothing to do.
    }
  }

  private markOpen(): void {
    if (this.gotOpen) return;
    this.gotOpen = true;
    // Kick off handshake by requesting a new session.
    this.app.connection.sendCommand("new");
    this.advance();
  }

  private advance(): void {
    let p = 0;
    if (this.gotOpen) p += 0.33;
    if (this.gotHello) p += 0.33;
    if (this.gotId) p += 0.34;
    this.progress = Math.min(1, p);
    this.updateBar();

    if (this.gotOpen && this.gotHello && this.gotId) {
      this.app.serverHandshakeOk = true;
      // Defer transition by a frame so the bar paints full first.
      requestAnimationFrame(() => this.app.setPanel("login"));
    }
  }

  private updateBar(): void {
    if (this.bar) {
      this.bar.style.width = `${Math.round(this.progress * 100)}%`;
    }
  }
}
