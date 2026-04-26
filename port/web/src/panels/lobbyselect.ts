import { PacketType, type Packet } from "@minigolf/shared";
import type { App } from "../app.ts";
import type { Panel } from "../panel.ts";
import { todayKey, getDailyResult } from "../daily.ts";
import { t } from "../i18n.ts";
import { audio } from "../audio.ts";

/**
 * Lobby-select panel — visual port of agolf.LobbySelectPanel, repurposed:
 * the original "Dual player" column has been replaced by "Daily Cup"
 * (since DUAL was never implemented in the port and the daily room is the
 * port's headline new feature).
 *
 * Layout overlays the bg-lobbyselect.gif background:
 *   - 3 serif titles ("Single player", "Daily Cup", "Multiplayer") at the
 *     1/6, 3/6, 5/6 horizontal positions.
 *   - "(N players)" line below each title (refreshed via lobbyselect/rnop).
 *     Daily count comes from the new 5th field in the rnop reply.
 *   - 3 columns of buttons. The daily column has one button — disabled (with
 *     a "done today" label) once the local player has finished today's run.
 *   - Footer row: graphics-quality dropdown, audio dropdown, quit button.
 */
export class LobbySelectPanel implements Panel {
  private app: App;
  private wrap: HTMLElement | null = null;
  private listeners: Array<() => void> = [];
  private singleCount: HTMLElement | null = null;
  private dailyCount: HTMLElement | null = null;
  private multiCount: HTMLElement | null = null;
  private rnopTimer: number | null = null;

  constructor(app: App) {
    this.app = app;
  }

  mount(root: HTMLElement): void {
    const wrap = document.createElement("div");
    wrap.className = "panel-lobbyselect";

    // Titles overlay
    const titles = document.createElement("div");
    titles.className = "lobby-titles";

    // Title positions in pixels, matching the bg image's 735px-wide column
    // thirds (centres at 122.5 / 367.5 / 612.5). Percent positions would
    // resolve against #app's 733px content area (1px border eats 2px) and
    // slip a pixel left of the image's divider lines.
    const positions: Array<["1" | "2" | "3", string, string]> = [
      ["1", t("LobbySelect_SinglePlayer", "Single player"), "122.5px"],
      // "Daily Cup" is port-specific (replaces the original DUAL column).
      ["2", t("Port_LobbySelect_DailyCup", "Daily Cup"), "367.5px"],
      ["3", t("LobbySelect_MultiPlayer", "Multiplayer"), "612.5px"],
    ];
    const counts: Record<"1" | "2" | "3", HTMLElement> = {
      1: this.makeCount(),
      2: this.makeCount(),
      3: this.makeCount(),
    };
    for (const [k, label, x] of positions) {
      const t = document.createElement("div");
      t.className = "lobby-title";
      t.textContent = label;
      t.style.left = x;
      titles.appendChild(t);

      const c = counts[k];
      c.style.left = x;
      titles.appendChild(c);
    }
    this.singleCount = counts[1];
    this.dailyCount = counts[2];
    this.multiCount = counts[3];
    wrap.appendChild(titles);

    // Three button columns: Single / Daily / Multi.
    wrap.appendChild(this.makeColumn(
      1,
      t("LobbySelect_SinglePlayer", "Single player"),
      t("LobbySelect_QuickStart", "Quick start"),
      () => this.selectSingle(),
      () => this.quickSingle(),
    ));
    wrap.appendChild(this.makeDailyColumn());
    wrap.appendChild(this.makeColumn(
      3,
      t("LobbySelect_MultiPlayer", "Multiplayer"),
      t("LobbySelect_QuickStart", "Quick start"),
      () => this.selectMulti(),
      () => this.quickMulti(),
    ));

    // Footer: graphics / audio / quit
    const footer = document.createElement("div");
    footer.className = "footer";

    const gfxPrefix = t("LobbySelect_Gfx", "Graphics:");
    const gfxLabels = [
      t("LobbySelect_Gfx0", "Plain (minimum)"),
      t("LobbySelect_Gfx1", "Some details (fast)"),
      t("LobbySelect_Gfx2", "Full details (slower)"),
      t("LobbySelect_Gfx3", "Full + animations"),
    ];
    const gfx = document.createElement("select");
    for (const label of gfxLabels) {
      const opt = document.createElement("option");
      opt.textContent = `${gfxPrefix} ${label}`;
      gfx.appendChild(opt);
    }
    gfx.selectedIndex = 2;

    // Reflects the persisted SoundManager preference and toggles the global
    // audio singleton on change. Mirrors Java LobbySelectPanel.java:259-266.
    const audioSel = document.createElement("select");
    for (const label of [
      t("Port_LobbySelect_AudioOn", "Audio: On"),
      t("Port_LobbySelect_AudioOff", "Audio: Off"),
    ]) {
      const opt = document.createElement("option");
      opt.textContent = label;
      audioSel.appendChild(opt);
    }
    audioSel.selectedIndex = audio.enabled ? 0 : 1;
    const audioChange = (): void => {
      audio.setEnabled(audioSel.selectedIndex === 0);
    };
    audioSel.addEventListener("change", audioChange);
    this.listeners.push(() => audioSel.removeEventListener("change", audioChange));

    const quit = document.createElement("button");
    quit.type = "button";
    quit.className = "btn-red";
    quit.textContent = t("LobbySelect_Quit", "Quit");
    const quitHandler = (): void => {
      // Best we can do in a browser tab.
      try { window.close(); } catch { /* noop */ }
    };
    quit.addEventListener("click", quitHandler);
    this.listeners.push(() => quit.removeEventListener("click", quitHandler));

    footer.appendChild(gfx);
    footer.appendChild(audioSel);
    footer.appendChild(quit);
    wrap.appendChild(footer);

    root.appendChild(wrap);
    this.wrap = wrap;

    // Kick off a player-count poll. The original repeats every few seconds.
    this.requestCounts();
    this.rnopTimer = window.setInterval(() => this.requestCounts(), 5000);
  }

  unmount(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    if (this.rnopTimer !== null) {
      window.clearInterval(this.rnopTimer);
      this.rnopTimer = null;
    }
    this.wrap = null;
    this.singleCount = null;
    this.dailyCount = null;
    this.multiCount = null;
  }

  onPacket(pkt: Packet): void {
    if (pkt.type !== PacketType.DATA) return;
    const f = pkt.fields;
    if (f[0] === "lobbyselect" && f[1] === "nop") {
      // d N lobbyselect nop <single> <dual> <multi> [<daily>]
      // We show the daily count in the middle column (where DUAL used to live);
      // ignore the dual count since DUAL isn't surfaced any more.
      this.setCount(this.singleCount, parseInt(f[2] ?? "-1", 10));
      this.setCount(this.multiCount, parseInt(f[4] ?? "-1", 10));
      this.setCount(this.dailyCount, parseInt(f[5] ?? "-1", 10));
      return;
    }
    if (f[0] === "status" && f[1] === "lobby") {
      // f[2] is the lobby tag: "1", "1h", "x", "xh", "d" (daily — no panel).
      const tag = (f[2] ?? "1").charAt(0);
      if (tag === "d") {
        // Daily lobby is invisible; the server follows up with `status game`
        // immediately. Ignore and stay on lobbyselect until that arrives.
        return;
      }
      if (tag === "x") {
        this.app.setPanel("lobby-multi");
      } else {
        this.app.setPanel("lobby");
      }
    }
    if (f[0] === "status" && f[1] === "game") {
      // Daily mode: server sent `status lobby d` (ignored above) then
      // `status game` to drop us straight into the daily room.
      this.app.setPanel("game");
    }
  }

  // ---------- helpers ----------

  private makeCount(): HTMLElement {
    const el = document.createElement("div");
    el.className = "lobby-count";
    el.textContent = t("LobbySelect_Players0", "(No players)");
    return el;
  }

  private setCount(el: HTMLElement | null, n: number): void {
    if (!el) return;
    if (!Number.isFinite(n) || n < 0) return;
    if (n === 0) el.textContent = t("LobbySelect_Players0", "(No players)");
    else if (n === 1) el.textContent = t("LobbySelect_Players1", "(1 player)");
    else el.textContent = t("LobbySelect_PlayersX", "(%1 players)", n);
  }

  private makeColumn(
    idx: 1 | 2 | 3,
    primaryText: string,
    quickText: string | null,
    onPrimary: (() => void) | null,
    onQuick: (() => void) | null,
  ): HTMLElement {
    const col = document.createElement("div");
    col.className = `col col-${idx}`;

    const primary = document.createElement("button");
    primary.type = "button";
    primary.textContent = primaryText;
    if (onPrimary) {
      primary.addEventListener("click", onPrimary);
      this.listeners.push(() => primary.removeEventListener("click", onPrimary));
    } else {
      primary.disabled = true;
    }
    col.appendChild(primary);

    if (quickText) {
      const quick = document.createElement("button");
      quick.type = "button";
      quick.className = "btn-blue btn-quick";
      quick.textContent = quickText;
      if (onQuick) {
        quick.addEventListener("click", onQuick);
        this.listeners.push(() => quick.removeEventListener("click", onQuick));
      } else {
        quick.disabled = true;
      }
      col.appendChild(quick);
    }
    return col;
  }

  /**
   * Daily-Challenge column. One button — disabled if today's run is already
   * recorded in localStorage. Tooltip surfaces the previous result so the
   * "you already played" message has substance.
   */
  private makeDailyColumn(): HTMLElement {
    const col = document.createElement("div");
    col.className = "col col-2";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-yellow";
    const existing = getDailyResult();
    if (existing) {
      btn.disabled = true;
      btn.textContent = t("Port_Daily_AlreadyPlayed", "Already played today");
      const verdict = existing.forfeited
        ? t("Port_Daily_Forfeited", "forfeited")
        : t("Port_Daily_Strokes", "%1 strokes", existing.strokes);
      btn.title = t(
        "Port_Daily_ButtonTitleDone",
        "%1: %2 (avg %3). Come back tomorrow.",
        todayKey(),
        verdict,
        existing.average.toFixed(1),
      );
    } else {
      btn.textContent = t("Port_LobbySelect_DailyCup", "Daily Cup");
      btn.title = t(
        "Port_Daily_ButtonTitle",
        "%1 — same track for everyone today.",
        todayKey(),
      );
      const handler = (): void => this.selectDaily();
      btn.addEventListener("click", handler);
      this.listeners.push(() => btn.removeEventListener("click", handler));
    }
    col.appendChild(btn);
    return col;
  }

  private requestCounts(): void {
    if (!this.app.connection.isOpen) return;
    this.app.connection.sendData("lobbyselect", "rnop");
  }

  private selectSingle(): void {
    this.app.connection.sendData("lobbyselect", "select", 1);
  }

  private selectMulti(): void {
    this.app.connection.sendData("lobbyselect", "select", "x");
  }

  private selectDaily(): void {
    if (!this.app.connection.isOpen) return;
    this.app.connection.sendData("lobbyselect", "select", "d");
  }

  private quickSingle(): void {
    // Original sends `cspt 10 1 0` (10 tracks, traditional, water-on).
    this.app.connection.sendData("lobbyselect", "cspt", 10, 1, 0);
  }

  private quickMulti(): void {
    this.app.connection.sendData("lobbyselect", "qmpt");
  }
}
