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
}
