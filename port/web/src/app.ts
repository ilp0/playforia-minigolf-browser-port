import type { Packet } from "@minigolf/shared";
import { Connection } from "./connection.ts";
import type { Panel } from "./panel.ts";
import { LoadingPanel } from "./panels/loading.ts";
import { LoginPanel } from "./panels/login.ts";
import { LobbySelectPanel } from "./panels/lobbyselect.ts";
import { LobbyPanel } from "./panels/lobby.ts";
import { LobbyMultiPanel } from "./panels/lobby-multi.ts";
import { GamePanel } from "./panels/game.ts";

const DEV = Boolean(import.meta.env?.DEV);

export type PanelName =
  | "loading"
  | "login"
  | "lobbyselect"
  | "lobby"
  | "lobby-multi"
  | "game";

/**
 * Top-level application. Owns the WebSocket connection and the active panel.
 *
 * Panels are mounted into the supplied `#app` root and receive packets via
 * their `onPacket` hook. State transitions happen via `setPanel(name)`.
 */
export class App {
  readonly root: HTMLElement;
  readonly connection: Connection;
  private currentPanel: Panel | null = null;
  private currentName: PanelName | null = null;

  /** Flags from initial handshake — read by login panel before submit. */
  serverHandshakeOk = false;
  serverId: string | null = null;

  /** Whether the operator has chat enabled on this server. Default true; the
   *  server pushes a `srvinfo chat 0|1` data packet right after login so this
   *  is set before any chat-bearing panel mounts. Lobby/game panels read this
   *  to decide whether to render the chat input row. */
  chatEnabled = true;

  constructor(root: HTMLElement) {
    this.root = root;
    const url = this.resolveWsUrl();
    this.connection = new Connection(url);

    this.connection.addEventListener("packet", (ev) => {
      const pkt = ev.detail;
      this.onPacket(pkt);
    });

    this.connection.addEventListener("error", (ev) => {
      console.warn("[app] connection error:", ev.detail.message);
      this.showError(ev.detail.message);
    });

    this.connection.addEventListener("close", () => {
      this.showError("Connection closed");
    });

    // Reconnect lifecycle. The Connection itself drives the `c old <id>`
    // handshake — App's job is just to surface that something's happening
    // (so the user doesn't think the UI froze) and clear it on success.
    this.connection.addEventListener("reconnecting", (ev) => {
      const { attempt, maxAttempts } = ev.detail;
      this.showReconnect(`Reconnecting… (${attempt}/${maxAttempts})`);
    });
    this.connection.addEventListener("reconnected", () => {
      this.clearReconnect();
    });
    this.connection.addEventListener("reconnect-failed", (ev) => {
      this.clearReconnect();
      const msg = ev.detail.reason === "rcf"
        ? "Reconnect refused — please refresh."
        : "Reconnect failed — please refresh.";
      this.showError(msg);
    });
  }

  private resolveWsUrl(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  start(): void {
    this.setPanel("loading");
  }

  setPanel(name: PanelName): void {
    if (DEV) console.debug("[app] setPanel:", name);
    if (this.currentPanel) {
      try {
        this.currentPanel.unmount();
      } catch (err) {
        console.warn("[app] panel unmount threw:", err);
      }
    }
    // Clear DOM.
    while (this.root.firstChild) {
      this.root.removeChild(this.root.firstChild);
    }

    const panel = this.createPanel(name);
    this.currentPanel = panel;
    this.currentName = name;
    panel.mount(this.root);
  }

  private createPanel(name: PanelName): Panel {
    switch (name) {
      case "loading":
        return new LoadingPanel(this);
      case "login":
        return new LoginPanel(this);
      case "lobbyselect":
        return new LobbySelectPanel(this);
      case "lobby":
        return new LobbyPanel(this);
      case "lobby-multi":
        return new LobbyMultiPanel(this);
      case "game":
        return new GamePanel(this);
    }
  }

  private onPacket(pkt: Packet): void {
    // Server-level config push. Intercept before forwarding so panels see a
    // consistent `app.chatEnabled` regardless of which one's mounted.
    if (pkt.fields[0] === "srvinfo" && pkt.fields[1] === "chat") {
      this.chatEnabled = pkt.fields[2] !== "0";
    }
    if (this.currentPanel) {
      try {
        this.currentPanel.onPacket(pkt);
      } catch (err) {
        console.warn("[app] panel onPacket threw:", err);
      }
    }
  }

  get currentPanelName(): PanelName | null {
    return this.currentName;
  }

  private showError(message: string): void {
    // Avoid stacking duplicate banners.
    const existing = this.root.querySelector(".error-banner");
    if (existing) existing.remove();
    const banner = document.createElement("div");
    banner.className = "error-banner";
    banner.textContent = message;
    this.root.appendChild(banner);
  }

  /** Render a non-fatal "reconnecting" indicator. Distinct class from the
   *  error banner so it can be styled differently and removed independently
   *  on `reconnected`. */
  private showReconnect(message: string): void {
    let banner = this.root.querySelector(".reconnect-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "reconnect-banner";
      this.root.appendChild(banner);
    }
    banner.textContent = message;
  }

  private clearReconnect(): void {
    const banner = this.root.querySelector(".reconnect-banner");
    if (banner) banner.remove();
  }
}
