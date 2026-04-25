import { PacketType, type Packet } from "@minigolf/shared";
import type { App } from "../app.ts";
import type { Panel } from "../panel.ts";

/** A row from the lobby's game list. Mirrors the 15-field gameString. */
interface GameInfo {
  id: number;
  name: string;
  passworded: boolean;
  perms: number;
  numPlayers: number;
  numTracks: number;
  trackType: number;
  maxStrokes: number;
  strokeTimeout: number;
  water: number;
  collision: number;
  scoring: number;
  scoringEnd: number;
  currentPlayers: number;
}

interface PlayerInfo {
  nick: string;
  flags: string;
  ranking: number;
  language: string;
}

/** Index in this list = the trackType integer the server understands (1..6).
 *  The server treats trackType=0 as ALL (random across every category), so the
 *  form's "Basic" must be 1, not 0. */
const TRACK_TYPES = ["Basic", "Traditional", "Modern", "Hole-in-one", "Short", "Long"];
/** Convert form-array index (0-based) to server trackType id (1-based). */
function trackTypeToServerId(formIdx: number): number {
  return formIdx + 1;
}
/** Convert server trackType id to form-array index. */
function serverIdToTrackType(serverId: number): number {
  return Math.max(0, serverId - 1);
}

/** Parse "3:Nick^flags^ranking^lang^profile^avatar" into a PlayerInfo. */
function parsePlayerString(s: string): PlayerInfo {
  const parts = s.split("^");
  let nick = parts[0] ?? "";
  if (nick.startsWith("3:")) nick = nick.substring(2);
  return {
    nick,
    flags: parts[1] ?? "w",
    ranking: parseInt(parts[2] ?? "0", 10) || 0,
    language: parts[3] ?? "-",
  };
}

/** Build a GameInfo from 15 consecutive fields. */
function parseGameFields(fields: string[], offset: number): GameInfo {
  const f = (i: number): string => fields[offset + i] ?? "";
  return {
    id: parseInt(f(0), 10) || 0,
    name: f(1),
    passworded: f(2) === "t",
    perms: parseInt(f(3), 10) || 0,
    numPlayers: parseInt(f(4), 10) || 0,
    // f(5) is the always-`-1` slot
    numTracks: parseInt(f(6), 10) || 0,
    trackType: parseInt(f(7), 10) || 0,
    maxStrokes: parseInt(f(8), 10) || 0,
    strokeTimeout: parseInt(f(9), 10) || 0,
    water: parseInt(f(10), 10) || 0,
    collision: parseInt(f(11), 10) || 0,
    scoring: parseInt(f(12), 10) || 0,
    scoringEnd: parseInt(f(13), 10) || 0,
    currentPlayers: parseInt(f(14), 10) || 0,
  };
}

/**
 * Multiplayer lobby — visual & functional port of agolf.lobby.LobbyMultiPlayerPanel.
 * Lays out a game list (left), a player list + create-game form (right) and a
 * chat band along the bottom. Backed by the bg-lobby-multi.gif background.
 */
export class LobbyMultiPanel implements Panel {
  private app: App;
  private wrap: HTMLElement | null = null;
  private gameListEl: HTMLElement | null = null;
  private playerListEl: HTMLElement | null = null;
  private chatLogEl: HTMLElement | null = null;
  private chatInputEl: HTMLInputElement | null = null;

  private games = new Map<number, GameInfo>();
  private players = new Map<string, PlayerInfo>();
  private listeners: Array<() => void> = [];
  private tagCounts: number[] | null = null;
  private trackTypeSel: HTMLSelectElement | null = null;
  /** Captured from `lobby ownjoin` so local-echo chat shows our nick consistently with peers. */
  private myNick = "";

  constructor(app: App) {
    this.app = app;
  }

  mount(root: HTMLElement): void {
    const wrap = document.createElement("div");
    wrap.className = "panel-lobby panel-lobby-multi";
    wrap.style.background =
      "#99ff99 url('/picture/agolf/bg-lobby-multi.gif') no-repeat top left";

    // Top bar: title + back
    const topBar = document.createElement("div");
    topBar.style.position = "absolute";
    topBar.style.top = "8px";
    topBar.style.left = "0";
    topBar.style.right = "0";
    topBar.style.display = "flex";
    topBar.style.alignItems = "center";
    topBar.style.justifyContent = "space-between";
    topBar.style.padding = "0 12px";

    const title = document.createElement("div");
    title.textContent = "Multiplayer";
    title.style.fontFamily = '"Times New Roman", serif';
    title.style.fontSize = "20px";
    title.style.fontWeight = "bold";
    topBar.appendChild(title);

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "btn-red";
    backBtn.textContent = "Back";
    this.bind(backBtn, "click", () => this.goBack());
    topBar.appendChild(backBtn);

    wrap.appendChild(topBar);

    // Main area: 2 columns (left = game list, right = players + create form)
    const main = document.createElement("div");
    main.style.position = "absolute";
    main.style.top = "44px";
    main.style.left = "8px";
    main.style.right = "8px";
    main.style.bottom = "150px";
    main.style.display = "grid";
    main.style.gridTemplateColumns = "1fr 280px";
    main.style.gap = "8px";

    // Game list
    const gamesBox = this.makeBox("Games");
    const gamesScroll = document.createElement("div");
    gamesScroll.style.overflowY = "auto";
    gamesScroll.style.flex = "1";
    gamesScroll.style.background = "rgba(255,255,255,0.85)";
    gamesScroll.style.border = "1px solid #000";
    gamesScroll.style.fontSize = "12px";
    gamesBox.appendChild(gamesScroll);
    main.appendChild(gamesBox);
    this.gameListEl = gamesScroll;

    // Right column: players + create form (stacked)
    const rightCol = document.createElement("div");
    rightCol.style.display = "grid";
    rightCol.style.gridTemplateRows = "1fr auto";
    rightCol.style.gap = "8px";

    const playersBox = this.makeBox("Players");
    const playersScroll = document.createElement("div");
    playersScroll.style.overflowY = "auto";
    playersScroll.style.flex = "1";
    playersScroll.style.background = "rgba(255,255,255,0.85)";
    playersScroll.style.border = "1px solid #000";
    playersScroll.style.fontSize = "12px";
    playersScroll.style.padding = "2px 4px";
    playersBox.appendChild(playersScroll);
    rightCol.appendChild(playersBox);
    this.playerListEl = playersScroll;

    rightCol.appendChild(this.makeCreateForm());
    main.appendChild(rightCol);

    wrap.appendChild(main);

    // Chat strip at the bottom
    wrap.appendChild(this.makeChatStrip());

    root.appendChild(wrap);
    this.wrap = wrap;
    this.refreshGames();
    this.refreshPlayers();
  }

  unmount(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    this.wrap = null;
    this.gameListEl = null;
    this.playerListEl = null;
    this.chatLogEl = null;
    this.chatInputEl = null;
    this.games.clear();
    this.players.clear();
  }

  onPacket(pkt: Packet): void {
    if (pkt.type !== PacketType.DATA) return;
    const f = pkt.fields;
    const head = f[0];

    if (head === "lobby") {
      const verb = f[1];
      switch (verb) {
        case "users":
          this.players.clear();
          for (let i = 2; i < f.length; i++) {
            const p = parsePlayerString(f[i]);
            this.players.set(p.nick, p);
          }
          this.refreshPlayers();
          break;
        case "join":
        case "joinfromgame": {
          const p = parsePlayerString(f[2] ?? "");
          this.players.set(p.nick, p);
          this.refreshPlayers();
          if (verb === "join") this.appendChat(`* ${p.nick} joined the lobby`, "system");
          break;
        }
        case "ownjoin": {
          const p = parsePlayerString(f[2] ?? "");
          this.players.set(p.nick, p);
          this.myNick = p.nick;
          this.refreshPlayers();
          break;
        }
        case "part": {
          const nick = f[2] ?? "";
          this.players.delete(nick);
          this.refreshPlayers();
          this.appendChat(`* ${nick} left the lobby`, "system");
          break;
        }
        case "gamelist":
          this.handleGameList(f);
          break;
        case "tagcounts":
          // lobby tagcounts <all> <c1> <c2> <c3> <c4> <c5> <c6>
          this.tagCounts = [];
          for (let i = 2; i <= 8 && i < f.length; i++) {
            this.tagCounts.push(parseInt(f[i] ?? "0", 10) || 0);
          }
          this.populateTrackTypeOptions();
          break;
        case "say": {
          // lobby say <text> <senderNick> <senderClan>
          const text = f[2] ?? "";
          const sender = f[3] ?? "?";
          this.appendChat(`<${sender}> ${text}`, "say");
          break;
        }
        case "sayp": {
          // lobby sayp <senderNick> <text>
          const sender = f[2] ?? "?";
          const text = f[3] ?? "";
          this.appendChat(`[whisper from ${sender}] ${text}`, "whisper");
          break;
        }
        default:
          break;
      }
      return;
    }

    if (head === "status" && f[1] === "game") {
      this.app.setPanel("game");
      return;
    }
    if (head === "status" && f[1] === "lobbyselect") {
      this.app.setPanel("lobbyselect");
      return;
    }
    if (head === "error" && f[1] === "wrongpassword") {
      this.appendChat("* Wrong password.", "system");
      return;
    }
  }

  // ---------- packet helpers ----------

  private handleGameList(f: string[]): void {
    const op = f[2];
    if (op === "full") {
      // lobby gamelist full <count> <g0_f0> ... <gN_f14>
      const count = parseInt(f[3] ?? "0", 10) || 0;
      this.games.clear();
      for (let i = 0; i < count; i++) {
        const offset = 4 + i * 15;
        if (offset + 14 >= f.length) break;
        const g = parseGameFields(f, offset);
        this.games.set(g.id, g);
      }
      this.refreshGames();
    } else if (op === "add" || op === "change") {
      // lobby gamelist <op> <g_f0> ... <g_f14>
      const g = parseGameFields(f, 3);
      this.games.set(g.id, g);
      this.refreshGames();
    } else if (op === "remove") {
      const id = parseInt(f[3] ?? "-1", 10);
      this.games.delete(id);
      this.refreshGames();
    }
  }

  // ---------- UI builders ----------

  private makeBox(label: string): HTMLElement {
    const box = document.createElement("div");
    box.style.display = "flex";
    box.style.flexDirection = "column";
    box.style.minHeight = "0";
    const head = document.createElement("div");
    head.textContent = label;
    head.style.fontWeight = "bold";
    head.style.fontSize = "12px";
    head.style.padding = "1px 4px 2px";
    box.appendChild(head);
    return box;
  }

  private makeCreateForm(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.background = "rgba(255,255,255,0.85)";
    wrap.style.border = "1px solid #000";
    wrap.style.padding = "6px";
    wrap.style.fontSize = "12px";

    const head = document.createElement("div");
    head.textContent = "Create game";
    head.style.fontWeight = "bold";
    head.style.marginBottom = "4px";
    wrap.appendChild(head);

    const grid = document.createElement("div");
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "auto 1fr";
    grid.style.rowGap = "3px";
    grid.style.columnGap = "6px";
    grid.style.alignItems = "center";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = "My Game";
    nameInput.maxLength = 24;
    grid.appendChild(this.label("Name:"));
    grid.appendChild(nameInput);

    const passwordInput = document.createElement("input");
    passwordInput.type = "text";
    passwordInput.placeholder = "(blank = open)";
    passwordInput.maxLength = 24;
    grid.appendChild(this.label("Password:"));
    grid.appendChild(passwordInput);

    const numPlayersSel = this.numericSelect([2, 3, 4], "2");
    grid.appendChild(this.label("Players:"));
    grid.appendChild(numPlayersSel);

    const trackTypeSel = document.createElement("select");
    this.trackTypeSel = trackTypeSel;
    this.populateTrackTypeOptions();
    grid.appendChild(this.label("Track type:"));
    grid.appendChild(trackTypeSel);

    const numTracksSel = this.numericSelect([1, 3, 5, 9, 18], "9");
    grid.appendChild(this.label("Tracks:"));
    grid.appendChild(numTracksSel);

    const maxStrokesSel = this.numericSelect([5, 10, 15, 20, 25, 30], "10");
    grid.appendChild(this.label("Max strokes:"));
    grid.appendChild(maxStrokesSel);

    const collisionSel = document.createElement("select");
    for (const [v, label] of [
      ["1", "Players collide"],
      ["0", "No collision"],
    ] as const) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      collisionSel.appendChild(o);
    }
    grid.appendChild(this.label("Collision:"));
    grid.appendChild(collisionSel);

    const waterSel = document.createElement("select");
    for (const [v, label] of [
      ["0", "Back to last hit"],
      ["1", "Back to shore"],
    ] as const) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      waterSel.appendChild(o);
    }
    grid.appendChild(this.label("Water:"));
    grid.appendChild(waterSel);

    wrap.appendChild(grid);

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "btn-green";
    createBtn.textContent = "Create";
    createBtn.style.marginTop = "6px";
    this.bind(createBtn, "click", () => {
      const name = (nameInput.value || "Game").trim();
      const password = passwordInput.value.trim() || "-";
      const numPlayers = parseInt(numPlayersSel.value, 10);
      const trackType = parseInt(trackTypeSel.value, 10);
      const numTracks = parseInt(numTracksSel.value, 10);
      const maxStrokes = parseInt(maxStrokesSel.value, 10);
      const collision = parseInt(collisionSel.value, 10);
      const water = parseInt(waterSel.value, 10);
      // lobby cmpt <name> <password> <perms=0> <numPlayers> <numTracks>
      // <trackType> <maxStrokes> <strokeTimeout> <water> <collision> <scoring> <scoringEnd>
      this.app.connection.sendData(
        "lobby",
        "cmpt",
        name,
        password,
        0,
        numPlayers,
        numTracks,
        trackType,
        maxStrokes,
        60,
        water,
        collision,
        0,
        0,
      );
    });
    wrap.appendChild(createBtn);

    return wrap;
  }

  private makeChatStrip(): HTMLElement {
    const strip = document.createElement("div");
    strip.style.position = "absolute";
    strip.style.left = "8px";
    strip.style.right = "8px";
    strip.style.bottom = "8px";
    strip.style.height = "134px";
    strip.style.display = "flex";
    strip.style.flexDirection = "column";
    strip.style.background = "rgba(255,255,255,0.85)";
    strip.style.border = "1px solid #000";
    strip.style.padding = "4px";

    const log = document.createElement("div");
    log.style.flex = "1";
    log.style.overflowY = "auto";
    log.style.fontFamily = '"Lucida Console", monospace';
    log.style.fontSize = "12px";
    log.style.background = "#fff";
    log.style.border = "1px solid #999";
    log.style.padding = "2px 4px";
    log.style.whiteSpace = "pre-wrap";
    log.style.wordBreak = "break-word";
    strip.appendChild(log);
    this.chatLogEl = log;

    const inputRow = document.createElement("form");
    inputRow.style.display = "flex";
    inputRow.style.gap = "4px";
    inputRow.style.marginTop = "4px";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 200;
    input.placeholder = "Press enter to chat (start with /msg <nick> for a whisper)";
    input.style.flex = "1";
    inputRow.appendChild(input);
    this.chatInputEl = input;

    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.textContent = "Send";
    inputRow.appendChild(sendBtn);

    this.bind(inputRow, "submit", (ev: Event) => {
      ev.preventDefault();
      this.sendChat();
    });

    strip.appendChild(inputRow);
    return strip;
  }

  /** Build/refresh the track-type dropdown with track counts (if known). */
  private populateTrackTypeOptions(): void {
    const sel = this.trackTypeSel;
    if (!sel) return;
    const prev = sel.value || String(trackTypeToServerId(1));
    while (sel.firstChild) sel.removeChild(sel.firstChild);

    const counts = this.tagCounts;
    const labelFor = (serverId: number, name: string): string => {
      if (!counts) return name;
      const n = counts[serverId] ?? 0;
      return `${name} (${n})`;
    };

    const mixed = document.createElement("option");
    mixed.value = "0";
    mixed.textContent = labelFor(0, "Mixed");
    sel.appendChild(mixed);
    for (let i = 0; i < TRACK_TYPES.length; i++) {
      const id = trackTypeToServerId(i);
      const o = document.createElement("option");
      o.value = String(id);
      o.textContent = labelFor(id, TRACK_TYPES[i]);
      sel.appendChild(o);
    }
    sel.value = prev;
  }

  private label(text: string): HTMLElement {
    const lab = document.createElement("label");
    lab.textContent = text;
    lab.style.textAlign = "right";
    lab.style.whiteSpace = "nowrap";
    return lab;
  }

  private numericSelect(values: number[], def: string): HTMLSelectElement {
    const sel = document.createElement("select");
    for (const v of values) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = String(v);
      sel.appendChild(o);
    }
    sel.value = def;
    return sel;
  }

  // ---------- list refreshers ----------

  private refreshPlayers(): void {
    const el = this.playerListEl;
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    const sorted = [...this.players.values()].sort((a, b) =>
      a.nick.localeCompare(b.nick),
    );
    for (const p of sorted) {
      const row = document.createElement("div");
      row.textContent = p.nick;
      el.appendChild(row);
    }
  }

  private refreshGames(): void {
    const el = this.gameListEl;
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    const sorted = [...this.games.values()].sort((a, b) => a.id - b.id);
    if (sorted.length === 0) {
      const empty = document.createElement("div");
      empty.style.padding = "8px";
      empty.style.color = "#666";
      empty.style.fontStyle = "italic";
      empty.textContent = "(No games yet — create one to get started)";
      el.appendChild(empty);
      return;
    }
    for (const g of sorted) {
      el.appendChild(this.makeGameRow(g));
    }
  }

  private makeGameRow(g: GameInfo): HTMLElement {
    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "16px 1fr auto auto auto";
    row.style.gap = "6px";
    row.style.alignItems = "center";
    row.style.padding = "3px 4px";
    row.style.borderBottom = "1px solid #ccc";

    const lock = document.createElement("span");
    lock.textContent = g.passworded ? "🔒" : "";
    lock.style.fontSize = "11px";
    row.appendChild(lock);

    const name = document.createElement("span");
    name.textContent = g.name;
    name.style.fontWeight = "bold";
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    row.appendChild(name);

    const meta = document.createElement("span");
    const ttype = g.trackType === 0 ? "Mixed" : (TRACK_TYPES[serverIdToTrackType(g.trackType)] ?? "?");
    meta.textContent = `${ttype} · ${g.numTracks}t`;
    meta.style.fontSize = "11px";
    meta.style.color = "#406040";
    row.appendChild(meta);

    const slots = document.createElement("span");
    slots.textContent = `${g.currentPlayers}/${g.numPlayers}`;
    slots.style.fontSize = "11px";
    row.appendChild(slots);

    const join = document.createElement("button");
    join.type = "button";
    join.className = "btn-blue";
    join.textContent = "Join";
    join.style.padding = "1px 8px";
    join.style.minHeight = "auto";
    if (g.currentPlayers >= g.numPlayers) {
      join.disabled = true;
      join.textContent = "Full";
    } else {
      this.bind(join, "click", () => this.joinGame(g));
    }
    row.appendChild(join);

    return row;
  }

  // ---------- actions ----------

  private joinGame(g: GameInfo): void {
    let password = "-";
    if (g.passworded) {
      const entered = window.prompt(`Password for "${g.name}":`);
      if (entered === null) return;
      password = entered.trim() || "-";
    }
    if (g.passworded) {
      this.app.connection.sendData("lobby", "jmpt", String(g.id), password);
    } else {
      this.app.connection.sendData("lobby", "jmpt", String(g.id));
    }
  }

  private sendChat(): void {
    const input = this.chatInputEl;
    if (!input) return;
    const text = input.value.replace(/[\r\n\t]+/g, " ").trim();
    if (!text) return;
    input.value = "";

    if (text.startsWith("/msg ")) {
      // /msg <nick> <text>
      const rest = text.substring(5).trim();
      const space = rest.indexOf(" ");
      if (space > 0) {
        const target = rest.substring(0, space);
        const body = rest.substring(space + 1);
        this.app.connection.sendData("lobby", "sayp", target, body);
        this.appendChat(`[whisper to ${target}] ${body}`, "whisper");
      }
      return;
    }

    // Echo locally — server only forwards to *others*. Use our captured nick
    // so the format matches incoming `<{sender}> ...` lines from peers.
    this.app.connection.sendData("lobby", "say", text);
    this.appendChat(`<${this.myNick || "you"}> ${text}`, "say-self");
  }

  private appendChat(line: string, kind: "say" | "say-self" | "whisper" | "system"): void {
    const log = this.chatLogEl;
    if (!log) return;
    const div = document.createElement("div");
    div.textContent = line;
    if (kind === "system") div.style.color = "#666";
    if (kind === "whisper") div.style.color = "#800080";
    if (kind === "say-self") div.style.color = "#000080";
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  private goBack(): void {
    // Server doesn't have an explicit "leave lobby" — closing the panel and
    // re-entering lobbyselect via a fresh `lobbyselect rnop` is fine, but for
    // a clean semantic we just switch panels; the disconnect on game start
    // will remove us from lobby anyway.
    this.app.setPanel("lobbyselect");
  }

  private bind<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void {
    el.addEventListener(type, handler as EventListener);
    this.listeners.push(() =>
      el.removeEventListener(type, handler as EventListener),
    );
  }
}
