import { PacketType, type Packet } from "@minigolf/shared";
import type { App } from "../app.ts";
import type { Panel } from "../panel.ts";

/**
 * Single-player lobby — visual port of agolf.lobby.LobbySinglePlayerPanel.
 * Sits on top of bg-lobby-single.gif. The original lets the player choose:
 *   - Track type (Basic / Traditional / Modern / Hole-in-one / Short / Long)
 *   - Number of tracks (1..18)
 *   - Water-event setting (start vs shore)
 * and exposes a "Start training" + "Quit" button row.
 */
export class LobbyPanel implements Panel {
  private app: App;
  private startBtn: HTMLButtonElement | null = null;
  private trackTypeSel: HTMLSelectElement | null = null;
  private numTracksSel: HTMLSelectElement | null = null;
  private waterSel: HTMLSelectElement | null = null;
  private listeners: Array<() => void> = [];
  private tagCounts: number[] | null = null;

  private static readonly TRACK_TYPE_NAMES: Array<[string, string]> = [
    ["0", "Mixed"],
    ["1", "Basic"],
    ["2", "Traditional"],
    ["3", "Modern"],
    ["4", "Hole-in-one"],
    ["5", "Short"],
    ["6", "Long"],
  ];

  constructor(app: App) {
    this.app = app;
  }

  mount(root: HTMLElement): void {
    const wrap = document.createElement("div");
    wrap.className = "panel-lobby";

    const nameplate = document.createElement("div");
    nameplate.className = "nameplate";
    nameplate.textContent = "Single player";
    wrap.appendChild(nameplate);

    const controls = document.createElement("div");
    controls.className = "controls";

    // Track type — populated lazily once `lobby tagcounts` arrives.
    const typeGroup = this.makeGroup("Track type");
    const trackType = document.createElement("select");
    typeGroup.appendChild(trackType);
    controls.appendChild(typeGroup);
    this.trackTypeSel = trackType;
    this.populateTrackTypeOptions();
    trackType.value = "2"; // Traditional default

    // Number of tracks
    const numGroup = this.makeGroup("Tracks");
    const num = document.createElement("select");
    for (const n of [1, 3, 5, 9, 18]) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = String(n);
      num.appendChild(opt);
    }
    num.value = "9";
    numGroup.appendChild(num);
    controls.appendChild(numGroup);
    this.numTracksSel = num;

    // Water-event
    const waterGroup = this.makeGroup("Water");
    const water = document.createElement("select");
    for (const [v, label] of [
      ["0", "Back to last hit"],
      ["1", "Back to shore"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = label;
      water.appendChild(opt);
    }
    water.value = "0";
    waterGroup.appendChild(water);
    controls.appendChild(waterGroup);
    this.waterSel = water;

    // Buttons
    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "btn-green";
    startBtn.textContent = "Start training";
    const startHandler = (): void => this.startTraining();
    startBtn.addEventListener("click", startHandler);
    this.listeners.push(() => startBtn.removeEventListener("click", startHandler));
    this.startBtn = startBtn;

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "btn-red";
    backBtn.textContent = "Back";
    const backHandler = (): void => {
      this.app.connection.sendData("lobbyselect", "select", 1);
      this.app.setPanel("lobbyselect");
    };
    backBtn.addEventListener("click", backHandler);
    this.listeners.push(() => backBtn.removeEventListener("click", backHandler));

    const btnGroup = this.makeGroup("");
    btnGroup.appendChild(startBtn);
    btnGroup.appendChild(backBtn);
    controls.appendChild(btnGroup);

    wrap.appendChild(controls);
    root.appendChild(wrap);
  }

  unmount(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    this.startBtn = null;
    this.trackTypeSel = null;
    this.numTracksSel = null;
    this.waterSel = null;
  }

  onPacket(pkt: Packet): void {
    if (pkt.type !== PacketType.DATA) return;
    const fields = pkt.fields;
    if (fields[0] === "status" && fields[1] === "game") {
      this.app.setPanel("game");
      return;
    }
    if (fields[0] === "lobby" && fields[1] === "tagcounts") {
      this.tagCounts = [];
      for (let i = 2; i <= 8 && i < fields.length; i++) {
        this.tagCounts.push(parseInt(fields[i] ?? "0", 10) || 0);
      }
      this.populateTrackTypeOptions();
    }
  }

  /** Build/refresh the track-type dropdown with optional track counts. */
  private populateTrackTypeOptions(): void {
    const sel = this.trackTypeSel;
    if (!sel) return;
    const prev = sel.value || "2";
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (const [id, name] of LobbyPanel.TRACK_TYPE_NAMES) {
      const opt = document.createElement("option");
      opt.value = id;
      const n = this.tagCounts ? this.tagCounts[parseInt(id, 10)] : undefined;
      opt.textContent = n !== undefined ? `${name} (${n})` : name;
      sel.appendChild(opt);
    }
    sel.value = prev;
  }

  private makeGroup(label: string): HTMLElement {
    const group = document.createElement("div");
    group.className = "control-group";
    if (label) {
      const lab = document.createElement("label");
      lab.textContent = label + ":";
      group.appendChild(lab);
    }
    return group;
  }

  private startTraining(): void {
    if (this.startBtn) this.startBtn.disabled = true;
    const trackType = parseInt(this.trackTypeSel?.value ?? "1", 10);
    const numTracks = parseInt(this.numTracksSel?.value ?? "9", 10);
    const water = parseInt(this.waterSel?.value ?? "0", 10);
    // Already inside the SINGLE lobby — verb is `lobby cspt` (sending
    // `lobbyselect cspt` here re-enters the lobby and bounces us back).
    // Regex: cspt <numTracks> <trackType> <water>
    this.app.connection.sendData("lobby", "cspt", numTracks, trackType, water);
  }
}
