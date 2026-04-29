/**
 * Daily replay viewer. Self-contained playback of a recorded daily run from
 * a `#replay=<base64url>` URL fragment.
 *
 * Determinism: the recording stores each stroke as `(ballCoords, mouseCoords,
 * seed)`. The 32-bit seed already embeds the original gameId - feeding it to
 * `new Seed(BigInt(seed))` and replaying via the same physics path the live
 * game uses for peers reproduces the trajectory bit-exactly. We don't need a
 * server connection, the original gameId, or seat assignment; we just drop
 * the ball at each stroke's start and watch.
 *
 * Pacing: strokes fire one at a time. The next stroke arms only after the
 * current ball comes to rest, mirroring the way GamePanel sequences peers.
 */

import { PacketType, Seed, type Packet } from "@minigolf/shared";
import { loadAtlases, type Atlases } from "../game/sprites.ts";
import { buildMap, type ParsedMap } from "../game/map.ts";
import { TrackRenderer } from "../game/render.ts";
import {
  applyStrokeImpulse,
  newBall,
  PHYSICS_STEP_MS,
  step,
  type BallState,
  type PhysicsContext,
} from "../game/physics.ts";
import type { DailyReplay } from "../daily.ts";
import type { Panel } from "../panel.ts";
import { t } from "../i18n.ts";

const DEV = Boolean(import.meta.env?.DEV);

function decodeCoords(s: string): { x: number; y: number; mode: number } {
  const v = parseInt(s, 36);
  return { x: Math.floor(v / 1500), y: Math.floor((v % 1500) / 4), mode: v % 4 };
}

export class ReplayPanel implements Panel {
  private replay: DailyReplay;
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private statusEl: HTMLElement | null = null;
  private strokeEl: HTMLElement | null = null;
  private playBtn: HTMLButtonElement | null = null;

  private atlases: Atlases | null = null;
  private parsedMap: ParsedMap | null = null;
  private renderer: TrackRenderer | null = null;
  private ball: BallState;
  private ctx: PhysicsContext | null = null;

  private strokeIdx = 0;
  private simulating = false;
  private paused = true;
  private finished = false;

  private rafHandle = 0;
  private physicsAccumMs = 0;
  private lastTickMs = 0;

  constructor(replay: DailyReplay) {
    this.replay = replay;
    // Initial ball position is taken from the first stroke's ballCoords once
    // the map is built; this default just gives us a non-null ball before then.
    this.ball = newBall(367.5, 187.5);
  }

  mount(root: HTMLElement): void {
    this.root = root;
    root.classList.add("replay-root");

    const wrap = document.createElement("div");
    wrap.className = "replay-wrap";
    root.appendChild(wrap);

    const header = document.createElement("div");
    header.className = "replay-header";
    const title = document.createElement("div");
    title.className = "replay-title";
    title.textContent = t("Port_Replay_Title", "Daily Cup Replay - %1", this.replay.d);
    const meta = document.createElement("div");
    meta.className = "replay-meta";
    const tn = this.replay.n || t("Port_Replay_UnknownTrack", "(unknown track)");
    const ta = this.replay.a ? " " + t("Port_Game_AuthorByFmt", "by %1", this.replay.a) : "";
    meta.textContent = `${tn}${ta}`;
    header.appendChild(title);
    header.appendChild(meta);
    wrap.appendChild(header);

    const canvas = document.createElement("canvas");
    canvas.width = 735;
    canvas.height = 375;
    canvas.className = "replay-canvas";
    wrap.appendChild(canvas);
    this.canvas = canvas;

    const controls = document.createElement("div");
    controls.className = "replay-controls";

    this.playBtn = document.createElement("button");
    this.playBtn.type = "button";
    this.playBtn.className = "btn-green";
    this.playBtn.textContent = t("Port_Replay_Play", "Play");
    this.playBtn.addEventListener("click", () => this.togglePlay());
    controls.appendChild(this.playBtn);

    const restartBtn = document.createElement("button");
    restartBtn.type = "button";
    restartBtn.className = "btn-blue";
    restartBtn.textContent = t("Port_Replay_Restart", "Restart");
    restartBtn.addEventListener("click", () => this.restart());
    controls.appendChild(restartBtn);

    const exitBtn = document.createElement("button");
    exitBtn.type = "button";
    exitBtn.className = "btn-blue";
    exitBtn.textContent = t("Port_Replay_Exit", "Exit replay");
    exitBtn.addEventListener("click", () => {
      // Clearing the hash & reloading drops us back into the regular app boot.
      window.location.hash = "";
      window.location.reload();
    });
    controls.appendChild(exitBtn);

    this.strokeEl = document.createElement("span");
    this.strokeEl.className = "replay-stroke";
    controls.appendChild(this.strokeEl);

    wrap.appendChild(controls);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "replay-status";
    this.statusEl.textContent = t("Port_Game_LoadingSprites", "Loading sprites…");
    wrap.appendChild(this.statusEl);

    this.boot();
  }

  unmount(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    if (this.root) this.root.classList.remove("replay-root");
    this.root = null;
  }

  // ReplayPanel never receives network packets, but the Panel interface needs
  // this method. Stub: no-op.
  onPacket(_p: Packet): void {
    void _p;
    void PacketType;
  }

  // ----- boot -----------------------------------------------------------

  private async boot(): Promise<void> {
    try {
      this.atlases = await loadAtlases();
      this.parsedMap = buildMap(this.replay.t, this.atlases);
      // DailyReplay doesn't carry the track's S-line body (yet) so the
      // renderer defaults to all-false flags - mines/magnets/teleports hide,
      // illusion walls don't cast shadows. Matches Java's "no S" default and
      // is acceptable since replay physics doesn't depend on visibility.
      this.renderer = new TrackRenderer(this.parsedMap, this.atlases);
      this.placeAtFirstStrokeOrigin();
      this.updateStrokeLabel();
      this.setStatus(this.replay.s.length > 0
        ? t(
            this.replay.s.length === 1 ? "Port_Replay_PressPlay1" : "Port_Replay_PressPlayN",
            this.replay.s.length === 1
              ? "Press Play to watch %1 stroke."
              : "Press Play to watch %1 strokes.",
            this.replay.s.length,
          )
        : t("Port_Replay_NoStrokes", "No strokes recorded - this run was forfeited before shooting."));
      this.draw();
      this.startLoop();
    } catch (err) {
      if (DEV) console.warn("[replay] boot failed", err);
      this.setStatus(t("Port_Replay_LoadFailed", "Replay failed to load: %1", String(err)));
    }
  }

  private placeAtFirstStrokeOrigin(): void {
    if (this.replay.s.length > 0) {
      const c = decodeCoords(this.replay.s[0][0]);
      this.ball = newBall(c.x, c.y);
    } else {
      // Empty recording - drop the ball roughly centre-ish so the canvas
      // isn't blank. The user only sees this when the run was forfeited
      // without a single shot.
      this.ball = newBall(367.5, 187.5);
    }
  }

  // ----- controls -------------------------------------------------------

  private togglePlay(): void {
    if (this.finished) {
      this.restart();
      return;
    }
    this.paused = !this.paused;
    if (this.playBtn) {
      this.playBtn.textContent = this.paused
        ? t("Port_Replay_Play", "Play")
        : t("Port_Replay_Pause", "Pause");
    }
    if (!this.paused && !this.simulating) {
      this.armNextStroke();
    }
  }

  private restart(): void {
    this.strokeIdx = 0;
    this.simulating = false;
    this.finished = false;
    this.paused = true;
    if (this.playBtn) this.playBtn.textContent = t("Port_Replay_Play", "Play");
    this.placeAtFirstStrokeOrigin();
    this.updateStrokeLabel();
    this.setStatus(this.replay.s.length > 0
      ? t(
          this.replay.s.length === 1 ? "Port_Replay_PressPlay1" : "Port_Replay_PressPlayN",
          this.replay.s.length === 1
            ? "Press Play to watch %1 stroke."
            : "Press Play to watch %1 strokes.",
          this.replay.s.length,
        )
      : t("Port_Replay_NoStrokesShort", "No strokes recorded."));
    this.draw();
  }

  private armNextStroke(): void {
    if (!this.parsedMap) return;
    if (this.strokeIdx >= this.replay.s.length) {
      this.finishPlayback();
      return;
    }
    const [ballRaw, mouseRaw, seedNum] = this.replay.s[this.strokeIdx];
    const b = decodeCoords(ballRaw);
    const m = decodeCoords(mouseRaw);

    // Snap the ball to the recorded start-of-stroke position. Even if our
    // local sim drifted by a sub-pixel from the original (it shouldn't, but
    // defence-in-depth), this keeps each subsequent stroke faithful.
    this.ball.x = b.x;
    this.ball.y = b.y;

    this.ctx = {
      map: this.parsedMap,
      seed: new Seed(BigInt(seedNum >>> 0)),
      norandom: false,
      // Replay is single-ball with no live water-event metadata. 0 = "respawn
      // at stroke start", which is the most common server setting and the
      // safest default - a rare edge case where a daily track sends the ball
      // into water on shore-respawn would visually diverge, but the recorded
      // ballCoords for the next stroke would re-snap it before then.
      waterEvent: 0,
      startX: this.ball.x,
      startY: this.ball.y,
      // Single-ball replay - no peers to obstruct movable blocks. Pad to
      // length 1 since the obstruction loop is keyed by index.
      otherPlayers: [null],
    };
    applyStrokeImpulse(this.ball, this.ctx, m.x, m.y, m.mode);
    this.simulating = true;
    this.strokeIdx++;
    this.updateStrokeLabel();
  }

  private finishPlayback(): void {
    this.finished = true;
    this.paused = true;
    this.simulating = false;
    if (this.playBtn) this.playBtn.textContent = t("Port_Replay_Restart", "Restart");
    const n = this.replay.s.length;
    const key = this.replay.holed
      ? (n === 1 ? "Port_Replay_HoledIn1" : "Port_Replay_HoledInN")
      : (n === 1 ? "Port_Replay_Forfeited1" : "Port_Replay_ForfeitedN");
    const fallback = this.replay.holed
      ? (n === 1 ? "Holed in %1 stroke." : "Holed in %1 strokes.")
      : (n === 1 ? "Forfeited at %1 stroke." : "Forfeited at %1 strokes.");
    this.setStatus(t(key, fallback, n));
  }

  // ----- physics tick ---------------------------------------------------

  private startLoop(): void {
    const tick = () => {
      this.rafHandle = requestAnimationFrame(tick);
      this.draw();
      if (this.paused || !this.simulating || !this.ctx) {
        this.lastTickMs = 0;
        this.physicsAccumMs = 0;
        return;
      }
      const now = performance.now();
      if (this.lastTickMs === 0) this.lastTickMs = now;
      const elapsed = now - this.lastTickMs;
      this.lastTickMs = now;
      this.physicsAccumMs += Math.min(elapsed, 100);
      let safety = 200;
      while (this.physicsAccumMs >= PHYSICS_STEP_MS && safety-- > 0 && this.simulating) {
        this.physicsAccumMs -= PHYSICS_STEP_MS;
        const r = step(this.ball, this.ctx);
        if (r.stopped) {
          this.simulating = false;
          if (this.strokeIdx >= this.replay.s.length) {
            this.finishPlayback();
          } else {
            // Brief pause between strokes so the viewer can register the stop.
            window.setTimeout(() => {
              if (!this.paused) this.armNextStroke();
            }, 350);
          }
        }
      }
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  // ----- render ---------------------------------------------------------

  private draw(): void {
    if (!this.canvas || !this.renderer) return;
    const c = this.canvas.getContext("2d");
    if (!c) return;
    this.renderer.drawFrame(
      c,
      [{
        x: this.ball.x,
        y: this.ball.y,
        playerIdx: 0,
        moving: false,
        hidden: this.ball.inHole,
      }],
      null,
    );
  }

  private setStatus(s: string): void {
    if (this.statusEl) this.statusEl.textContent = s;
  }

  private updateStrokeLabel(): void {
    if (!this.strokeEl) return;
    const total = this.replay.s.length;
    // strokeIdx is incremented when a stroke is armed, so it doubles as the
    // 1-based count of strokes already started.
    const cur = Math.min(this.strokeIdx, total);
    this.strokeEl.textContent = total > 0 ? t("Port_Replay_StrokeNOfM", "Stroke %1 / %2", cur, total) : "";
  }
}
