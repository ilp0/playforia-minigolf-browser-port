import { PacketType, Seed, type Packet } from "@minigolf/shared";
import type { App } from "../app.ts";
import type { Panel } from "../panel.ts";
import { loadAtlases, type Atlases } from "../game/sprites.ts";
import { buildMap, type ParsedMap } from "../game/map.ts";
import { TrackRenderer, type AimLine, type BallSprite } from "../game/render.ts";
import {
  applyStrokeImpulse,
  newBall,
  PHYSICS_STEP_MS,
  step,
  type BallState,
  type PhysicsContext,
} from "../game/physics.ts";

const DEV = Boolean(import.meta.env?.DEV);

function encodeCoords(x: number, y: number, mode: number): string {
  const v = (x | 0) * 1500 + (y | 0) * 4 + mode;
  return v.toString(36).padStart(4, "0");
}

function decodeCoords(s: string): { x: number; y: number; mode: number } {
  const v = parseInt(s, 36);
  return {
    x: Math.floor(v / 1500),
    y: Math.floor((v % 1500) / 4),
    mode: v % 4,
  };
}

function extractField(fields: string[], prefix: string): string | null {
  for (let i = 4; i < fields.length; i++) {
    const f = fields[i];
    if (f.startsWith(prefix)) return f.substring(prefix.length);
  }
  return null;
}

interface TrackInfoLine {
  plays: number;
  totalStrokes: number;
  bestPar: number;
  numBestPar: number;
}

const CATEGORY_NAMES: Record<number, string> = {
  1: "Basic",
  2: "Traditional",
  3: "Modern",
  4: "HIO",
  5: "Short",
  6: "Long",
};

/** Parse a "C <csv>" line value into category IDs. */
function parseCategories(s: string | null): number[] {
  if (!s) return [];
  return s
    .split(",")
    .map((p) => parseInt(p.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseInfoLine(s: string | null): TrackInfoLine | null {
  if (!s) return null;
  const parts = s.split(",");
  if (parts.length < 4) return null;
  return {
    plays: parseInt(parts[0], 10) || 0,
    totalStrokes: parseInt(parts[1], 10) || 0,
    bestPar: parseInt(parts[2], 10) || 0,
    numBestPar: parseInt(parts[3], 10) || 0,
  };
}

/**
 * Per-player state. Each ball is fully independent: its own physics ctx (with
 * its own Seed), its own state machine, its own stroke counter. This lets
 * multiple balls move simultaneously without sharing the random stream.
 */
interface PlayerSlot {
  nick: string;
  clan: string;
  strokesThisTrack: number;
  strokesTotal: number;
  ball: BallState;
  /** Per-stroke physics context — replaced on each `beginstroke` broadcast. */
  ctx: PhysicsContext | null;
  /** True until this player holes-in for the current track. */
  active: boolean;
  /** True while their ball is in motion. */
  simulating: boolean;
  /** This player has holed-in on the current track. */
  holedThisTrack: boolean;
  /** This player gave up on the current track. */
  forfeitedThisTrack: boolean;
}

/**
 * Multi-player game panel — async play with **server-assigned per-stroke seeds**.
 *
 * Determinism contract:
 *   1. Server picks a unique 32-bit seed for each beginstroke and broadcasts it
 *      to ALL clients (including the shooter).
 *   2. The shooter does NOT apply the impulse on click. They wait for the
 *      server's broadcast and apply it then — so the shooter and every watcher
 *      run identical physics from identical initial conditions with the same
 *      Seed instance.
 *   3. Each ball gets its own Seed instance (per stroke); parallel strokes from
 *      different players never share random state.
 *   4. Server is the single source of truth for stroke counts and hole-ins —
 *      its `endstroke` broadcasts overwrite the local scoreboard.
 */
export class GamePanel implements Panel {
  private app: App;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private overlay: HTMLElement | null = null;
  private atlases: Atlases | null = null;
  private scoreboardEl: HTMLElement | null = null;
  private trackTitleEl: HTMLElement | null = null;
  private trackTagsEl: HTMLElement | null = null;
  private trackAuthorEl: HTMLElement | null = null;
  private trackProgressEl: HTMLElement | null = null;
  private bestParEl: HTMLElement | null = null;
  private avgParEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private strokeCountEl: HTMLElement | null = null;
  private chatLogEl: HTMLElement | null = null;
  private chatInputEl: HTMLInputElement | null = null;
  private chatStripEl: HTMLElement | null = null;

  private parsedMap: ParsedMap | null = null;
  private renderer: TrackRenderer | null = null;
  private startX = 367.5;
  private startY = 187.5;
  private players: PlayerSlot[] = [];
  /** beginstroke packets that arrived before atlases or track were ready. */
  private pendingBeginStrokes: string[][] = [];
  private pendingStartTrack: string[] | null = null;

  private mouseX = 0;
  private mouseY = 0;
  private rafHandle = 0;
  private gameId: string = "0";
  private numPlayers = 1;
  private numTracks = 1;
  private currentTrackIdx = 0;
  private myPlayerId = 0;
  private waterEvent = 0;
  private myNick = "You";

  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  private mouseMoveHandler: ((ev: MouseEvent) => void) | null = null;
  private clickHandler: ((ev: MouseEvent) => void) | null = null;

  constructor(app: App) {
    this.app = app;
  }

  // ----- mount ----------------------------------------------------------

  mount(root: HTMLElement): void {
    this.root = root;
    const wrap = document.createElement("div");
    wrap.className = "panel-game";

    const scoreboard = document.createElement("div");
    scoreboard.className = "scoreboard";
    wrap.appendChild(scoreboard);
    this.scoreboardEl = scoreboard;

    const frame = document.createElement("div");
    frame.className = "canvas-frame";
    const canvas = document.createElement("canvas");
    canvas.width = 735;
    canvas.height = 375;
    frame.appendChild(canvas);
    wrap.appendChild(frame);

    const bottomBand = document.createElement("div");
    bottomBand.style.display = "grid";
    bottomBand.style.gridTemplateColumns = "1fr 280px";
    bottomBand.style.gap = "8px";
    bottomBand.style.padding = "4px 8px";
    bottomBand.style.flex = "1";
    bottomBand.style.minHeight = "0";

    const trackinfo = document.createElement("div");
    trackinfo.className = "trackinfo";
    trackinfo.style.padding = "0";

    const left = document.createElement("div");
    left.className = "left";
    const trackProgress = document.createElement("div");
    const trackTitle = document.createElement("div");
    trackTitle.style.fontWeight = "bold";
    const trackTags = document.createElement("div");
    trackTags.style.display = "flex";
    trackTags.style.gap = "3px";
    trackTags.style.flexWrap = "wrap";
    trackTags.style.marginTop = "1px";
    const trackAuthor = document.createElement("div");
    left.appendChild(trackProgress);
    left.appendChild(trackTitle);
    left.appendChild(trackTags);
    left.appendChild(trackAuthor);

    const center = document.createElement("div");
    center.className = "center";
    const statusEl = document.createElement("div");
    statusEl.className = "hud-status";
    statusEl.textContent = "Loading sprites…";
    const strokeCountEl = document.createElement("div");
    strokeCountEl.style.fontSize = "13px";
    strokeCountEl.style.fontWeight = "bold";
    strokeCountEl.textContent = "Stroke 0";
    center.appendChild(strokeCountEl);
    center.appendChild(statusEl);

    const forfeit = document.createElement("button");
    forfeit.type = "button";
    forfeit.className = "btn-yellow";
    forfeit.textContent = "Forfeit hole";
    forfeit.style.marginTop = "4px";
    forfeit.style.padding = "1px 10px";
    forfeit.style.minHeight = "auto";
    forfeit.style.fontSize = "11px";
    forfeit.addEventListener("click", () => this.forfeitHole());
    center.appendChild(forfeit);

    const right = document.createElement("div");
    right.className = "right";
    const avgPar = document.createElement("div");
    const bestPar = document.createElement("div");
    right.appendChild(avgPar);
    right.appendChild(bestPar);

    trackinfo.appendChild(left);
    trackinfo.appendChild(center);
    trackinfo.appendChild(right);
    bottomBand.appendChild(trackinfo);

    const chatStrip = this.makeChatStrip();
    bottomBand.appendChild(chatStrip);
    this.chatStripEl = chatStrip;

    wrap.appendChild(bottomBand);
    root.appendChild(wrap);

    this.canvas = canvas;
    this.trackProgressEl = trackProgress;
    this.trackTitleEl = trackTitle;
    this.trackTagsEl = trackTags;
    this.trackAuthorEl = trackAuthor;
    this.statusEl = statusEl;
    this.strokeCountEl = strokeCountEl;
    this.avgParEl = avgPar;
    this.bestParEl = bestPar;
    this.renderScoreboard();

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#99ff99";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const keyHandler = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.quit();
      }
    };
    window.addEventListener("keydown", keyHandler);
    this.keyHandler = keyHandler;

    const localCoords = (ev: MouseEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / Math.max(rect.width, 1);
      const sy = canvas.height / Math.max(rect.height, 1);
      return [(ev.clientX - rect.left) * sx, (ev.clientY - rect.top) * sy];
    };
    const mouseMoveHandler = (ev: MouseEvent) => {
      const [mx, my] = localCoords(ev);
      this.mouseX = mx;
      this.mouseY = my;
    };
    canvas.addEventListener("mousemove", mouseMoveHandler);
    this.mouseMoveHandler = mouseMoveHandler;

    const clickHandler = (ev: MouseEvent) => {
      // Async play: anyone can click their OWN ball whenever it's at rest.
      const me = this.players[this.myPlayerId];
      if (!me || me.ball.inHole || me.simulating) return;
      const [mx, my] = localCoords(ev);
      const dx = me.ball.x - mx;
      const dy = me.ball.y - my;
      if (Math.sqrt(dx * dx + dy * dy) < 6.5) return;
      // Don't apply impulse here — wait for server broadcast (which includes
      // the seed) so we run identical physics with everyone else.
      const ix = (me.ball.x | 0);
      const iy = (me.ball.y | 0);
      this.app.connection.sendData(
        "game",
        "beginstroke",
        encodeCoords(ix, iy, 0) + "\t" + encodeCoords((mx | 0), (my | 0), 0),
      );
    };
    canvas.addEventListener("mousedown", clickHandler);
    this.clickHandler = clickHandler;

    void loadAtlases().then((atl) => {
      this.atlases = atl;
      this.setStatus("Waiting for track…");
      if (this.pendingStartTrack) {
        const f = this.pendingStartTrack;
        this.pendingStartTrack = null;
        this.handleStartTrack(f);
      }
    }).catch((err) => {
      if (DEV) console.warn("[game] atlases failed", err);
      this.setStatus("Sprite load failed: " + String(err));
    });

    this.startLoop();
  }

  unmount(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler);
    if (this.canvas) {
      if (this.mouseMoveHandler) this.canvas.removeEventListener("mousemove", this.mouseMoveHandler);
      if (this.clickHandler) this.canvas.removeEventListener("mousedown", this.clickHandler);
    }
    this.keyHandler = null;
    this.mouseMoveHandler = null;
    this.clickHandler = null;
    this.canvas = null;
    this.scoreboardEl = null;
    this.statusEl = null;
    this.strokeCountEl = null;
    this.trackProgressEl = null;
    this.trackTitleEl = null;
    this.trackTagsEl = null;
    this.trackAuthorEl = null;
    this.avgParEl = null;
    this.bestParEl = null;
    this.chatLogEl = null;
    this.chatInputEl = null;
    this.chatStripEl = null;
    this.overlay = null;
    this.root = null;
    this.players = [];
    this.pendingBeginStrokes = [];
  }

  // ----- packet routing -------------------------------------------------

  onPacket(pkt: Packet): void {
    if (pkt.type !== PacketType.DATA) return;
    const f = pkt.fields;

    if (f[0] === "status") {
      if (f[1] === "lobby") {
        const tag = (f[2] ?? "1").charAt(0);
        this.app.setPanel(tag === "x" ? "lobby-multi" : "lobby");
        return;
      }
      if (f[1] === "lobbyselect") {
        this.app.setPanel("lobbyselect");
        return;
      }
    }
    if (f[0] !== "game") return;
    const verb = f[1];
    if (DEV) console.debug("[game] verb=", verb, "fields=", f);

    switch (verb) {
      case "gameinfo":
        this.numPlayers = parseInt(f[5] ?? "1", 10) || 1;
        this.numTracks = parseInt(f[6] ?? "1", 10) || 1;
        this.waterEvent = parseInt(f[10] ?? "0", 10) || 0;
        this.ensurePlayerSlots(this.numPlayers);
        this.renderScoreboard();
        this.applyChatVisibility();
        break;
      case "owninfo":
        this.myPlayerId = parseInt(f[2] ?? "0", 10) || 0;
        this.myNick = f[3] ?? "You";
        this.ensurePlayerSlots(this.myPlayerId + 1);
        this.players[this.myPlayerId].nick = this.myNick;
        this.players[this.myPlayerId].clan = f[4] ?? "";
        this.renderScoreboard();
        break;
      case "players":
        for (let i = 2; i + 2 < f.length; i += 3) {
          const id = parseInt(f[i] ?? "0", 10);
          this.ensurePlayerSlots(id + 1);
          this.players[id].nick = f[i + 1] ?? "";
          this.players[id].clan = f[i + 2] ?? "";
        }
        this.renderScoreboard();
        break;
      case "join":
        {
          const id = (parseInt(f[2] ?? "1", 10) || 1) - 1;
          this.ensurePlayerSlots(id + 1);
          this.players[id].nick = f[3] ?? "";
          this.players[id].clan = f[4] ?? "";
          this.appendChat(`* ${this.players[id].nick} joined the game`, "system");
          this.renderScoreboard();
        }
        break;
      case "part":
        {
          const id = parseInt(f[2] ?? "0", 10) || 0;
          if (this.players[id]) {
            this.appendChat(`* ${this.players[id].nick} left`, "system");
            this.players[id].active = false;
          }
          this.renderScoreboard();
        }
        break;
      case "starttrack":
        this.handleStartTrack(f);
        break;
      case "beginstroke":
        // Server broadcasts to ALL (including the shooter) so everyone runs
        // identical physics from the same seed.
        // wire: game beginstroke <playerId> <ballCoords> <mouseCoords> <seed>
        this.handleBeginStroke(f);
        break;
      case "endstroke":
        // Server scoreboard sync.
        // wire: game endstroke <playerId> <strokesThisTrack> <inHole(t/f)>
        this.handleEndStrokeBroadcast(f);
        break;
      case "say":
        {
          const id = parseInt(f[2] ?? "0", 10) || 0;
          const nick = this.players[id]?.nick ?? "?";
          this.appendChat(`<${nick}> ${f[3] ?? ""}`, "say");
        }
        break;
      case "sayp":
        this.appendChat(`[whisper from ${f[2] ?? "?"}] ${f[3] ?? ""}`, "whisper");
        break;
      case "end":
        this.showEndOverlay(f);
        break;
      default:
        break;
    }
  }

  // ----- track-start / stroke -------------------------------------------

  private handleStartTrack(f: string[]): void {
    if (!this.atlases) {
      this.pendingStartTrack = f;
      return;
    }
    const playStatus = f[2] ?? "";
    if (playStatus.length > 0) {
      this.numPlayers = playStatus.length;
      this.ensurePlayerSlots(this.numPlayers);
    }
    this.gameId = f[3] ?? "0";
    const tLine = extractField(f, "T ");
    if (!tLine) {
      this.setStatus("Could not load track (no T-line).");
      return;
    }
    try {
      const parsed = buildMap(tLine, this.atlases);
      this.parsedMap = parsed;
      this.renderer = new TrackRenderer(parsed, this.atlases);
      const startIdx = parsed.startPositions.length > 0
        ? Number(BigInt(this.gameId) % BigInt(parsed.startPositions.length))
        : 0;
      const start = parsed.startPositions[startIdx] ?? [367.5, 187.5];
      this.startX = start[0];
      this.startY = start[1];

      // Move all per-track totals to running totals BEFORE resetting.
      for (const p of this.players) {
        p.strokesTotal += p.strokesThisTrack;
      }
      // Reset every player to start.
      for (const p of this.players) {
        p.ball = newBall(start[0], start[1]);
        p.active = true;
        p.strokesThisTrack = 0;
        p.simulating = false;
        p.ctx = null;
        p.holedThisTrack = false;
        p.forfeitedThisTrack = false;
      }
      this.currentTrackIdx++;
      this.updateStrokeCount();

      const author = extractField(f, "A ") ?? "";
      const name = extractField(f, "N ") ?? "";
      const info = parseInfoLine(extractField(f, "I "));
      const bestPlayer = (extractField(f, "B ") ?? "").split(",")[0] ?? "";
      const tags = parseCategories(extractField(f, "C "));
      this.setTrackMeta(author, name, info, bestPlayer, tags);

      this.setStatus("Click to shoot when you're ready.");
      this.removeOverlay();
      this.renderScoreboard();
      // Replay any beginstrokes that arrived too early.
      const queued = this.pendingBeginStrokes;
      this.pendingBeginStrokes = [];
      for (const q of queued) this.handleBeginStroke(q);
    } catch (err) {
      if (DEV) console.warn("[game] track build failed", err);
      this.setStatus("Track parse error: " + String(err));
    }
  }

  /**
   * Server-relayed beginstroke. Format:
   *   game beginstroke <playerId> <ballCoords> <mouseCoords> <seed>
   * EVERY client (including the shooter) gets this and applies the impulse here.
   */
  private handleBeginStroke(f: string[]): void {
    if (!this.parsedMap) {
      this.pendingBeginStrokes.push(f);
      return;
    }
    const id = parseInt(f[2] ?? "0", 10);
    const ballRaw = f[3] ?? "0000";
    const mouseRaw = f[4] ?? "0000";
    const seedNum = parseInt(f[5] ?? "0", 10) >>> 0;
    const slot = this.players[id];
    if (!slot) return;

    // Take the ball position the server believed at stroke begin — this keeps
    // every client's physics agreement bit-exact even if our local ball drifted.
    const ballCoords = decodeCoords(ballRaw);
    slot.ball.x = ballCoords.x;
    slot.ball.y = ballCoords.y;

    const mouse = decodeCoords(mouseRaw);
    const ctx: PhysicsContext = {
      map: this.parsedMap,
      seed: new Seed(BigInt(seedNum)),
      norandom: false,
      waterEvent: this.waterEvent,
      startX: this.startX,
      startY: this.startY,
    };
    slot.ctx = ctx;
    applyStrokeImpulse(slot.ball, ctx, mouse.x, mouse.y);
    slot.simulating = true;
    this.renderScoreboard();
  }

  /** Server's scoreboard sync after a player's stroke ended. */
  private handleEndStrokeBroadcast(f: string[]): void {
    const id = parseInt(f[2] ?? "0", 10);
    const strokes = parseInt(f[3] ?? "0", 10);
    const status = f[4] ?? "f"; // 't' = holed, 'p' = passed/forfeited, 'f' = still playing
    const slot = this.players[id];
    if (!slot) return;
    slot.strokesThisTrack = strokes;
    if (status === "t") {
      slot.ball.inHole = true;
      slot.simulating = false;
      slot.holedThisTrack = true;
    } else if (status === "p") {
      slot.simulating = false;
      slot.forfeitedThisTrack = true;
      // Hide the ball — they're done with this hole.
      slot.ball.inHole = true; // reuse the "hidden" sprite path
    }
    if (id === this.myPlayerId) this.updateStrokeCount();
    this.renderScoreboard();
  }

  // ----- physics tick ---------------------------------------------------

  private physicsAccumMs = 0;
  private lastTickMs = 0;

  private startLoop(): void {
    const tick = () => {
      this.rafHandle = requestAnimationFrame(tick);
      this.draw();

      // Step every ball that's currently moving. Each ball has its OWN
      // PhysicsContext (with its OWN Seed), so concurrent strokes can't
      // interfere with one another's randomness.
      const anySimulating = this.players.some((p) => p.simulating);
      if (anySimulating) {
        const now = performance.now();
        if (this.lastTickMs === 0) this.lastTickMs = now;
        const elapsed = now - this.lastTickMs;
        this.lastTickMs = now;
        this.physicsAccumMs += Math.min(elapsed, 100);
        let safety = 200;
        while (this.physicsAccumMs >= PHYSICS_STEP_MS && safety-- > 0) {
          this.physicsAccumMs -= PHYSICS_STEP_MS;
          for (let i = 0; i < this.players.length; i++) {
            const slot = this.players[i];
            if (!slot.simulating || !slot.ctx) continue;
            const r = step(slot.ball, slot.ctx);
            if (r.stopped) {
              slot.simulating = false;
              if (i === this.myPlayerId) {
                // Tell the server our ball stopped (and whether we're in hole).
                this.app.connection.sendData(
                  "game",
                  "endstroke",
                  String(i),
                  this.myPlayStatus(),
                );
              }
            }
          }
        }
      } else {
        this.lastTickMs = 0;
        this.physicsAccumMs = 0;
      }
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  /** Build a status string for OUR ball (we're authoritative for ourselves). */
  private myPlayStatus(): string {
    let s = "";
    for (let i = 0; i < this.numPlayers; i++) {
      if (i === this.myPlayerId) {
        s += this.players[i]?.ball.inHole ? "t" : "f";
      } else {
        // Other players' status: the server overwrites it anyway, so just
        // say "still playing" — the server only trusts our own char.
        s += this.players[i]?.ball.inHole ? "t" : "f";
      }
    }
    return s;
  }

  // ----- HUD updaters ---------------------------------------------------

  private setStatus(s: string): void {
    if (this.statusEl) this.statusEl.textContent = s;
  }

  private updateStrokeCount(): void {
    const slot = this.players[this.myPlayerId];
    if (this.strokeCountEl) {
      this.strokeCountEl.textContent = `Stroke ${slot?.strokesThisTrack ?? 0}`;
    }
  }

  private setTrackMeta(
    author: string,
    name: string,
    info: TrackInfoLine | null,
    bestPlayer: string,
    tags: number[] = [],
  ): void {
    if (this.trackProgressEl) {
      this.trackProgressEl.textContent = `Track ${this.currentTrackIdx}/${this.numTracks}`;
    }
    if (this.trackTitleEl) this.trackTitleEl.textContent = name;
    if (this.trackTagsEl) {
      while (this.trackTagsEl.firstChild) {
        this.trackTagsEl.removeChild(this.trackTagsEl.firstChild);
      }
      for (const tagId of tags) {
        const name = CATEGORY_NAMES[tagId];
        if (!name) continue;
        const chip = document.createElement("span");
        chip.textContent = name;
        chip.style.fontSize = "10px";
        chip.style.padding = "0 4px";
        chip.style.background = "#406040";
        chip.style.color = "#fff";
        chip.style.borderRadius = "2px";
        this.trackTagsEl.appendChild(chip);
      }
    }
    if (this.trackAuthorEl) {
      this.trackAuthorEl.textContent = author ? `by ${author}` : "";
    }
    if (this.avgParEl) {
      if (info && info.plays > 0) {
        const avg = info.totalStrokes / info.plays;
        this.avgParEl.textContent = `Average: ${avg.toFixed(1)} strokes`;
      } else {
        this.avgParEl.textContent = "";
      }
    }
    if (this.bestParEl) {
      if (info && info.plays > 0 && info.bestPar > 0) {
        const pct = (info.numBestPar / info.plays) * 100;
        const who = bestPlayer ? ` by ${bestPlayer}` : "";
        this.bestParEl.textContent =
          `Best: ${info.bestPar} stroke${info.bestPar === 1 ? "" : "s"} (${pct.toFixed(1)}%)${who}`;
      } else {
        this.bestParEl.textContent = "";
      }
    }
  }

  private renderScoreboard(): void {
    const sb = this.scoreboardEl;
    if (!sb) return;
    while (sb.firstChild) sb.removeChild(sb.firstChild);
    for (let i = 0; i < this.numPlayers; i++) {
      const p = this.players[i];
      if (!p) continue;
      const row = document.createElement("div");
      row.className = "row " + (i === this.myPlayerId ? "you" : "them");
      const num = document.createElement("span");
      num.textContent = `${i + 1}.`;
      const name = document.createElement("span");
      name.textContent = p.nick || `Player ${i + 1}`;
      const tracksCol = document.createElement("span");
      const cells: string[] = [];
      for (let t = 0; t < this.numTracks; t++) {
        if (t + 1 < this.currentTrackIdx) cells.push("·");
        else if (t + 1 === this.currentTrackIdx) cells.push(String(p.strokesThisTrack));
        else cells.push("—");
      }
      tracksCol.textContent = cells.join("  ");
      const total = document.createElement("span");
      total.textContent = "= " + (p.strokesTotal + p.strokesThisTrack);
      const note = document.createElement("span");
      if (p.holedThisTrack) note.textContent = "in hole";
      else if (p.forfeitedThisTrack) note.textContent = "forfeited";
      else if (p.simulating) note.textContent = "shooting";
      row.appendChild(num);
      row.appendChild(name);
      row.appendChild(tracksCol);
      row.appendChild(total);
      row.appendChild(note);
      sb.appendChild(row);
    }
  }

  // ----- chat -----------------------------------------------------------

  private makeChatStrip(): HTMLElement {
    const strip = document.createElement("div");
    strip.style.display = "flex";
    strip.style.flexDirection = "column";
    strip.style.background = "rgba(255,255,255,0.85)";
    strip.style.border = "1px solid #000";
    strip.style.padding = "3px";
    strip.style.minHeight = "0";

    const log = document.createElement("div");
    log.style.flex = "1";
    log.style.overflowY = "auto";
    log.style.fontFamily = '"Lucida Console", monospace';
    log.style.fontSize = "11px";
    log.style.background = "#fff";
    log.style.border = "1px solid #999";
    log.style.padding = "1px 3px";
    log.style.whiteSpace = "pre-wrap";
    log.style.wordBreak = "break-word";
    strip.appendChild(log);
    this.chatLogEl = log;

    const form = document.createElement("form");
    form.style.display = "flex";
    form.style.gap = "3px";
    form.style.marginTop = "3px";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 200;
    input.placeholder = "Chat (Enter to send)";
    input.style.flex = "1";
    input.style.fontSize = "11px";
    form.appendChild(input);
    this.chatInputEl = input;

    const send = document.createElement("button");
    send.type = "submit";
    send.textContent = "Send";
    send.style.padding = "1px 8px";
    send.style.minHeight = "auto";
    send.style.fontSize = "11px";
    form.appendChild(send);

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.sendChat();
    });

    strip.appendChild(form);
    return strip;
  }

  private sendChat(): void {
    const input = this.chatInputEl;
    if (!input) return;
    // Strip newlines and tabs (they'd break the line-delimited / tab-separated wire framing).
    const text = input.value.replace(/[\r\n\t]+/g, " ").trim();
    if (!text) return;
    input.value = "";
    this.app.connection.sendData("game", "say", text);
    this.appendChat(`<${this.myNick}> ${text}`, "say-self");
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

  // ----- canvas rendering -----------------------------------------------

  private draw(): void {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    if (!this.renderer) {
      ctx.fillStyle = "#99ff99";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    let aim: AimLine | null = null;
    const me = this.players[this.myPlayerId];
    if (me && !me.ball.inHole && !me.simulating) {
      aim = { fromX: me.ball.x, fromY: me.ball.y, toX: this.mouseX, toY: this.mouseY };
    }
    const sprites: BallSprite[] = [];
    for (let i = 0; i < this.numPlayers; i++) {
      const p = this.players[i];
      if (!p) continue;
      sprites.push({
        x: p.ball.x,
        y: p.ball.y,
        playerIdx: i,
        // Always idle frame — the "moving" frame in balls.gif is a different
        // colour for the next player slot, which made the ball appear to swap
        // colours mid-shot.
        moving: false,
        hidden: p.ball.inHole,
      });
    }
    this.renderer.drawFrame(ctx, sprites, aim);
  }

  // ----- game-end overlay -----------------------------------------------

  private showEndOverlay(f: string[]): void {
    if (!this.root) return;
    this.removeOverlay();
    const ov = document.createElement("div");
    ov.className = "game-end-overlay";

    const title = document.createElement("div");
    title.textContent = "Game over";
    ov.appendChild(title);

    if (f.length > 2) {
      const lines = document.createElement("div");
      lines.style.fontSize = "14px";
      lines.style.fontWeight = "normal";
      lines.style.fontFamily = '"Dialog", Verdana, sans-serif';
      lines.style.textAlign = "center";
      for (let i = 0; i < this.numPlayers; i++) {
        const result = parseInt(f[2 + i] ?? "0", 10);
        const nick = this.players[i]?.nick ?? `Player ${i + 1}`;
        const word = result === 1 ? "Winner" : result === 0 ? "Draw" : "—";
        const row = document.createElement("div");
        row.textContent = `${nick}: ${word}`;
        lines.appendChild(row);
      }
      ov.appendChild(lines);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-green";
    btn.textContent = "Back to lobby";
    btn.addEventListener("click", () => {
      this.app.connection.sendData("game", "back");
    });
    ov.appendChild(btn);

    this.root.appendChild(ov);
    this.overlay = ov;
  }

  private removeOverlay(): void {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.overlay = null;
  }

  private quit(): void {
    this.app.connection.sendData("game", "back");
  }

  /** Give up on the current hole — server caps strokes & marks DNF. */
  private forfeitHole(): void {
    const me = this.players[this.myPlayerId];
    if (!me) return;
    if (me.holedThisTrack || me.forfeitedThisTrack) return;
    if (!window.confirm("Forfeit this hole? You'll be capped at the stroke limit.")) return;
    this.app.connection.sendData("game", "forfeit");
  }

  private applyChatVisibility(): void {
    const strip = this.chatStripEl;
    if (!strip) return;
    const showChat = this.numPlayers > 1;
    strip.style.display = showChat ? "" : "none";
    const parent = strip.parentElement as HTMLElement | null;
    if (parent) {
      parent.style.gridTemplateColumns = showChat ? "1fr 280px" : "1fr";
    }
  }

  private ensurePlayerSlots(n: number): void {
    while (this.players.length < n) {
      this.players.push({
        nick: "",
        clan: "",
        strokesThisTrack: 0,
        strokesTotal: 0,
        ball: newBall(this.startX, this.startY),
        ctx: null,
        active: true,
        simulating: false,
        holedThisTrack: false,
        forfeitedThisTrack: false,
      });
    }
  }
}
