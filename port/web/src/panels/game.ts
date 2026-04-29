import { PacketType, Seed, parseSettingsFlags, type Packet } from "@minigolf/shared";
import type { App } from "../app.ts";
import type { Panel } from "../panel.ts";
import { loadAtlases, type Atlases } from "../game/sprites.ts";
import { buildMap, type ParsedMap } from "../game/map.ts";
import { TrackRenderer, slotNickColor, type AimLine, type BallSprite, type PeerAim } from "../game/render.ts";
import {
  applyStrokeImpulse,
  newBall,
  PHYSICS_STEP_MS,
  step,
  type BallState,
  type PhysicsContext,
} from "../game/physics.ts";
import {
  copyToClipboard,
  dailyScore,
  replayLink,
  saveDailyResult,
  shareText,
  shortReplayLink,
  todayKey,
  type DailyReplay,
  type DailyResult,
} from "../daily.ts";
import { t } from "../i18n.ts";
import { audio } from "../audio.ts";

const DEV = Boolean(import.meta.env?.DEV);

/** Max chat lines retained in the DOM. Older lines are dropped on append. */
const CHAT_LOG_MAX_LINES = 500;

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

/**
 * Wire convention: server sends `"-"` to mean "no clan" (Player.clan defaults
 * to "-" on the Java side). Java's GamePanel.java:187,194 maps that sentinel
 * to null before storing it; we collapse it to the empty string so the
 * existing `clan && clan.length > 0` checks across render and scoreboard skip
 * the `[clan]` row instead of rendering a literal `[-]`.
 */
function normalizeClan(raw: string | undefined): string {
  if (!raw || raw === "-") return "";
  return raw;
}

/**
 * Per-user game-panel preferences, persisted across sessions in localStorage.
 * Exposed through the in-game "Valikko" button so the player can toggle
 * cosmetic + bandwidth knobs without leaving the match. Volume lives on the
 * audio singleton (which has its own persistence key); the rest live here.
 */
/**
 * Where the magnifier loupe floats while the player drags. The default
 * `above` puts it directly over the finger; the corner placements pin it to
 * one side so it never moves with the finger (useful for left-handed users
 * or anyone whose thumb covers the loupe at the natural offset).
 */
type LoupePlacement = "above" | "below" | "top-left" | "top-right";

interface GameSettings {
  /** Render in-game name labels above other players' balls. */
  showNames: boolean;
  /** Broadcast my cursor at ~15 Hz so peers see my live aim line. */
  sendCursor: boolean;
  /** Render peers' aim lines from their broadcast cursor positions. */
  showPeerCursors: boolean;
  /** Mobile-only: where the magnifier loupe is placed during a drag. */
  loupePlacement: LoupePlacement;
  /** Mobile-only: magnifier zoom factor. 1.5 / 2 / 3 cover the useful range. */
  loupeZoom: number;
}

const SETTINGS_KEY = "minigolf.game.settings";
const LOUPE_PLACEMENTS: readonly LoupePlacement[] = ["above", "below", "top-left", "top-right"] as const;
const DEFAULT_SETTINGS: GameSettings = {
  showNames: true,
  sendCursor: true,
  showPeerCursors: true,
  loupePlacement: "above",
  loupeZoom: 2,
};

function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const place: LoupePlacement = LOUPE_PLACEMENTS.includes(parsed.loupePlacement)
      ? parsed.loupePlacement
      : DEFAULT_SETTINGS.loupePlacement;
    // Clamp the zoom even if a hand-edited localStorage carries a junk value.
    const zoomRaw = typeof parsed.loupeZoom === "number" ? parsed.loupeZoom : DEFAULT_SETTINGS.loupeZoom;
    const zoom = Math.max(1.2, Math.min(4, zoomRaw));
    return {
      showNames: typeof parsed.showNames === "boolean" ? parsed.showNames : DEFAULT_SETTINGS.showNames,
      sendCursor: typeof parsed.sendCursor === "boolean" ? parsed.sendCursor : DEFAULT_SETTINGS.sendCursor,
      showPeerCursors:
        typeof parsed.showPeerCursors === "boolean" ? parsed.showPeerCursors : DEFAULT_SETTINGS.showPeerCursors,
      loupePlacement: place,
      loupeZoom: zoom,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // localStorage unavailable (private mode, quota) - accept the loss.
  }
}

interface TrackInfoLine {
  plays: number;
  totalStrokes: number;
  bestPar: number;
  numBestPar: number;
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
  ball: BallState;
  /** Per-stroke physics context - replaced on each `beginstroke` broadcast. */
  ctx: PhysicsContext | null;
  /** True until this player holes-in for the current track. */
  active: boolean;
  /** True while their ball is in motion. */
  simulating: boolean;
  /** This player has holed-in on the current track. */
  holedThisTrack: boolean;
  /** This player gave up on the current track. */
  forfeitedThisTrack: boolean;
  /**
   * Java `playerVotedToSkip[player]`. Set when we receive `game voteskip <id>`
   * from the server (or locally when *we* press skip - the server doesn't
   * echo back the sender). Cleared on every `resetvoteskip` and on starttrack.
   * Drives the "(Vote: skip track)" badge in the scoreboard row.
   */
  votedToSkip: boolean;
  /**
   * Java `playerReadyForNewGame[player]`. Set when we receive `game rfng <id>`
   * (or locally when *we* press the play-again button - server doesn't echo).
   * Drives the "(Wants a new game!)" badge after the game ends.
   */
  wantsNewGame: boolean;
  /**
   * Java `playerLeaveReasons[player]`. 0 = present, otherwise the part-reason
   * byte from `game part <id> <reason>`:
   *   4 = USERLEFT (voluntary back)
   *   5 = CONN_PROBLEM (network blip / closed tab)
   *   6 = SWITCHEDLOBBY (silent - name nulled, no badge)
   * Drives the trailing badge in the scoreboard row for parted players.
   */
  partReason: number;
  /**
   * Spawn for this player on the current track. On multi-spawn tracks each
   * colour-keyed reset marker (shapes 48..51) yields a per-player spawn; the
   * common shape-24 marker is the fallback. Used when constructing the per-
   * stroke physics context so water/acid resets land at this player's start.
   */
  startX: number;
  startY: number;
  /**
   * Final stroke counts per finished hole, indexed by hole-1. Filled in on
   * every `endstroke` broadcast for the current hole - the last write before
   * the track advances becomes the recorded final.
   */
  holeScores: number[];
  /**
   * Last cursor position for this peer (from `game cursor` broadcasts), or
   * null if we haven't received one yet (or it was cleared on track change).
   * Drives the live aim-preview render for non-self players.
   */
  cursorX: number | null;
  cursorY: number | null;
  /**
   * Right-click shooting mode this peer is currently in (0..3). Driven by the
   * 4th field of the `game cursor` broadcast - peers send the mode alongside
   * the cursor position so the watcher's aim preview matches what the peer
   * actually sees on their own screen.
   */
  cursorMode: number;
}

/**
 * Multi-player game panel - async play with **server-assigned per-stroke seeds**.
 *
 * Determinism contract:
 *   1. Server picks a unique 32-bit seed for each beginstroke and broadcasts it
 *      to ALL clients (including the shooter).
 *   2. The shooter does NOT apply the impulse on click. They wait for the
 *      server's broadcast and apply it then - so the shooter and every watcher
 *      run identical physics from identical initial conditions with the same
 *      Seed instance.
 *   3. Each ball gets its own Seed instance (per stroke); parallel strokes from
 *      different players never share random state.
 *   4. Server is the single source of truth for stroke counts and hole-ins -
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
  private trackAuthorEl: HTMLElement | null = null;
  private trackProgressEl: HTMLElement | null = null;
  private bestParEl: HTMLElement | null = null;
  private avgParEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private strokeCountEl: HTMLElement | null = null;
  private chatLogEl: HTMLElement | null = null;
  private chatInputEl: HTMLInputElement | null = null;
  private chatStripEl: HTMLElement | null = null;
  /** The `.panel-game` wrap. Used to toggle the `.is-multi` layout class. */
  private panelEl: HTMLElement | null = null;

  private parsedMap: ParsedMap | null = null;
  private renderer: TrackRenderer | null = null;
  private startX = 367.5;
  private startY = 187.5;
  private players: PlayerSlot[] = [];
  /**
   * Per-frame scratch buffers for `draw()`. Reused via `length = 0` so the
   * RAF hot path doesn't allocate two new arrays every frame.
   */
  private drawSprites: BallSprite[] = [];
  private drawPeerAims: PeerAim[] = [];
  /**
   * Coalesces scoreboard rebuilds: callers set this flag instead of doing a
   * synchronous DOM wipe-and-rebuild, and `draw()` does a single rebuild per
   * frame. A burst of endstroke/finishtrack packets used to tear down and
   * rebuild every row repeatedly.
   */
  private scoreboardDirty = true;
  /** beginstroke packets that arrived before atlases or track were ready. */
  private pendingBeginStrokes: string[][] = [];
  private pendingStartTrack: string[] | null = null;
  /**
   * Per-track score multipliers from the `scoringmulti` packet (Java
   * `playerInfoPanel.trackScoresMultipliers`). The server doesn't currently
   * emit `scoringmulti`, so this stays empty and every track is treated as 1×.
   * When populated, `handleStartTrack` posts a chat notice on a new track
   * whose multiplier is > 1, mirroring Java's `GameChat_ScoreMultiNotify`.
   */
  private trackScoresMultipliers: number[] = [];
  /**
   * In-game skip / new-game buttons. Recreated on each `setState`-equivalent
   * transition (track change, end-of-game) so visibility tracks the Java
   * GameControlPanel's add/remove dance. The `skipButton` is detached from
   * the DOM after the local player votes (and re-attached on `resetvoteskip`)
   * so the user can't spam-vote.
   */
  private skipButton: HTMLButtonElement | null = null;
  private skipButtonHost: HTMLElement | null = null;
  private playAgainButton: HTMLButtonElement | null = null;
  /**
   * Practice-mode button - shown only while a multiplayer room is still
   * waiting for fillers. Click sends `game practice`; the server answers
   * with the usual start/starttrack/practicemode trio. Mutually exclusive
   * with `skipButton` (you only see one or the other depending on whether
   * a track is currently in play).
   */
  private practiceButton: HTMLButtonElement | null = null;
  /**
   * True once the server has broadcast `game start` for this room (either
   * the real game starting because the room filled, or practice mode
   * starting). Drives the "waiting in lobby" predicate that decides whether
   * the Practice button is even relevant.
   */
  private gameStartedReceived = false;
  /**
   * True between `game practicemode t` and the next `game start` (which
   * either flips this off explicitly or, more commonly, is followed by the
   * real-game starttrack with no `practicemode t` packet). Suppresses
   * per-hole columns and shows "Practice" instead of "Track N/M" in the HUD.
   */
  private practiceMode = false;

  private mouseX = 0;
  private mouseY = 0;
  /**
   * Right-click shooting mode (0..3). Mirrors original GameCanvas.shootingMode.
   * 0 = normal, 1 = reverse, 2 = 90° clockwise, 3 = 90° counter-clockwise.
   * Right-click cycles through them so the player can hit hard along an axis
   * even when the canvas edge would clip a normal aim line. Reset to 0 at the
   * start of each track and after our own beginstroke is processed.
   */
  private shootingMode = 0;
  private rafHandle = 0;
  private gameId: string = "0";
  private numPlayers = 1;
  /**
   * Configured room capacity from `gameinfo` - does NOT shrink when a
   * starttrack arrives with a shorter `playStatus` (which can happen during
   * practice in a partially-filled room: 1/4 players makes playStatus = "f",
   * length 1, but the room is still a 4-player room). Drives the
   * "is this a multiplayer room?" predicate for skip / practice button
   * visibility, where transient under-population shouldn't flip us into
   * single-player UI.
   */
  private roomCapacity = 1;
  private numTracks = 1;
  private currentTrackIdx = 0;
  private myPlayerId = 0;
  private waterEvent = 0;
  private myNick = "You";

  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  private mouseMoveHandler: ((ev: MouseEvent) => void) | null = null;
  private clickHandler: ((ev: MouseEvent) => void) | null = null;
  private contextMenuHandler: ((ev: MouseEvent) => void) | null = null;
  /** Touch-input handlers for mobile drag-to-shoot. Stored so unmount can
   *  detach them, and grouped with the magnifier-loupe element they update. */
  private touchStartHandler: ((ev: TouchEvent) => void) | null = null;
  private touchMoveHandler: ((ev: TouchEvent) => void) | null = null;
  private touchEndHandler: ((ev: TouchEvent) => void) | null = null;
  private touchCancelHandler: ((ev: TouchEvent) => void) | null = null;
  /**
   * Active touch-aim state. `activeTouchId` is the identifier of the touch we
   * are tracking (so a second finger doesn't hijack the aim); `null` when no
   * touch is in progress. `aimingByTouch` gates the aim-line render and the
   * loupe so we don't draw a stale aim from the last finger position after
   * release.
   */
  private activeTouchId: number | null = null;
  private aimingByTouch = false;
  /** Magnifier loupe - circular canvas floating above the finger during a
   *  drag-to-shoot. Painted from the main canvas inside `draw()` so the
   *  zoomed-in view always reflects the current aim line. */
  private loupeEl: HTMLCanvasElement | null = null;
  /** Mobile-only shoot-mode cycle button. Floats over the canvas (visible
   *  only on touch-primary devices), shows the current `shootingMode` glyph,
   *  and cycles 0..3 on tap - replacing the desktop right-click that's
   *  unavailable on mobile. Created in `mount`, re-synced on every cycle. */
  private shootModeBtnEl: HTMLButtonElement | null = null;
  /** Last touch position in viewport coords - used to position the loupe. */
  private touchClientX = 0;
  private touchClientY = 0;
  /**
   * Cached "is this a phone/tablet" check. Reads the `is-touch-mode` body
   * class set by `setupTouchMode()` in main.ts, so the in-game flag uses
   * the same verdict as the CSS gates - single source of truth for both
   * the touch-only menu rows + shoot-mode button and the aim/cursor
   * suppression while no finger is down. On `true`, the aim line and
   * cursor broadcasts are gated on an active touch - otherwise mouseX/Y
   * starts at (0,0) and the aim line would point to the top-left corner
   * before the user has even tapped.
   */
  private isTouchPrimary =
    typeof document !== "undefined" &&
    document.body?.classList?.contains("is-touch-mode") === true;
  /** Toggleable user prefs (names, cursor send/recv) - persisted via localStorage. */
  private settings: GameSettings = loadSettings();
  private settingsMenuEl: HTMLElement | null = null;
  private menuButtonEl: HTMLButtonElement | null = null;
  private menuOutsideClickHandler: ((ev: MouseEvent) => void) | null = null;

  /**
   * Daily-mode state. Set when the server sends `game dailymode <dateKey>`.
   * Drives ghost rendering for non-self balls and swaps the end overlay
   * for a copy-to-clipboard share dialog.
   */
  private dailyMode = false;
  private dailyDateKey: string | null = null;
  /** Track average from the latest starttrack - used in the share text. */
  private trackAverage = 0;
  /** Track display name from the latest starttrack - used in the share text. */
  private trackName = "";
  /** Set once we have shown the daily share screen, to avoid double-saving. */
  private dailyResultRecorded = false;
  /**
   * Per-stroke recording of the local player's daily run. Captured from the
   * server's `beginstroke` broadcasts (which carry the deterministic inputs)
   * so the run can be replayed bit-exactly without server cooperation.
   */
  private dailyReplayStrokes: Array<[string, string, number]> = [];
  /** Raw `T <map>` line from the most recent starttrack - embedded in replay links. */
  private dailyTLine: string | null = null;
  /** Track author from starttrack - surfaced in playback HUD. */
  private trackAuthor = "";

  constructor(app: App) {
    this.app = app;
  }

  // ----- mount ----------------------------------------------------------

  mount(root: HTMLElement): void {
    this.root = root;
    const wrap = document.createElement("div");
    wrap.className = "panel-game";
    this.panelEl = wrap;

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

    // Mobile-only shoot-mode cycle button. Lives inside `.canvas-frame` so it
    // scales with the canvas under the landscape `transform: scale()`. CSS
    // hides it outside touch-primary devices, so it's invisible on desktop
    // while still being instantiated unconditionally (keeps the lifecycle
    // simple and avoids feature-detect branching on mount).
    const shootModeBtn = document.createElement("button");
    shootModeBtn.type = "button";
    shootModeBtn.className = "shoot-mode-btn";
    shootModeBtn.setAttribute("aria-label", "Shooting mode");
    shootModeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.cycleShootingMode();
    });
    frame.appendChild(shootModeBtn);
    this.shootModeBtnEl = shootModeBtn;
    this.refreshShootModeBtn();

    wrap.appendChild(frame);

    const bottomBand = document.createElement("div");
    bottomBand.className = "bottom-band";

    const trackinfo = document.createElement("div");
    trackinfo.className = "trackinfo";
    trackinfo.style.padding = "0";

    const left = document.createElement("div");
    left.className = "left";
    const trackProgress = document.createElement("div");
    const trackTitle = document.createElement("div");
    trackTitle.style.fontWeight = "bold";
    const trackAuthor = document.createElement("div");
    left.appendChild(trackProgress);
    left.appendChild(trackTitle);
    left.appendChild(trackAuthor);

    // `.center` holds the single-player HUD: stroke counter, status hint, and
    // the forfeit button. Hidden via CSS in multiplayer mode (see `.is-multi`),
    // where the original Playforia layout had no such hint and the scoreboard
    // already shows the current-track stroke count per row.
    const center = document.createElement("div");
    center.className = "center";
    const statusEl = document.createElement("div");
    statusEl.className = "hud-status";
    statusEl.textContent = t("Port_Game_LoadingSprites", "Loading sprites…");
    const strokeCountEl = document.createElement("div");
    strokeCountEl.className = "stroke-count";
    strokeCountEl.style.fontSize = "13px";
    strokeCountEl.style.fontWeight = "bold";
    strokeCountEl.textContent = t("Port_Game_StrokeFmt", "Stroke %1", 0);
    center.appendChild(strokeCountEl);
    center.appendChild(statusEl);

    const buttonRow = document.createElement("div");
    buttonRow.className = "button-row";

    const forfeit = document.createElement("button");
    forfeit.type = "button";
    forfeit.className = "btn-yellow forfeit-btn";
    forfeit.textContent = t("Port_Game_ForfeitHole", "Forfeit hole");
    forfeit.style.padding = "1px 10px";
    forfeit.style.minHeight = "auto";
    forfeit.style.fontSize = "11px";
    forfeit.addEventListener("click", () => this.forfeitHole());
    buttonRow.appendChild(forfeit);

    center.appendChild(buttonRow);

    // Right-side container holds two stacked blocks: stats (avg + best) and
    // actions (skip + menu). In single-player they stack vertically; in
    // multiplayer the `.right` container becomes a horizontal row so the
    // bottom band mirrors the original Playforia layout.
    const right = document.createElement("div");
    right.className = "right";

    const stats = document.createElement("div");
    stats.className = "stats";
    const avgPar = document.createElement("div");
    const bestPar = document.createElement("div");
    stats.appendChild(avgPar);
    stats.appendChild(bestPar);
    right.appendChild(stats);

    const actions = document.createElement("div");
    actions.className = "actions";

    // Skip-track - Java GameControlPanel `buttonSkip`. Lives in `.actions`
    // so in multiplayer it sits next to the Menu button on the far right
    // (matching the original "Radan väliinjättö" position). Hidden by
    // `updateSkipButtonVisibility` in 1-player and daily rooms.
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "btn-blue skip-btn";
    skip.textContent = t("GameControl_Skip", "Skip track");
    skip.style.padding = "1px 10px";
    skip.style.minHeight = "auto";
    skip.style.fontSize = "11px";
    skip.style.display = "none";
    skip.addEventListener("click", () => this.voteSkip());
    actions.appendChild(skip);
    this.skipButton = skip;
    this.skipButtonHost = actions;

    // Practice - port-original "Harjoittele" button. Occupies the same slot
    // as the skip button while the multiplayer room is still filling up;
    // `updateSkipButtonVisibility` keeps the two mutually exclusive (Skip
    // is meaningless before a track has started; Practice is meaningless
    // after one has). Larger padding/font give it the "big button" feel
    // the design calls for.
    const practice = document.createElement("button");
    practice.type = "button";
    practice.className = "btn-green practice-btn";
    practice.textContent = t("Port_Game_Practice", "Practice");
    practice.style.padding = "6px 22px";
    practice.style.minHeight = "auto";
    practice.style.fontSize = "14px";
    practice.style.fontWeight = "bold";
    practice.style.display = "none";
    practice.title = t(
      "Port_Game_PracticeHint",
      "Play random maps while waiting - multiplayer enabled",
    );
    practice.addEventListener("click", () => this.startPractice());
    actions.appendChild(practice);
    this.practiceButton = practice;

    // "Valikko" - opens the ESC popover (settings + quit). Replaces the
    // original "<- Valikkoon" button position.
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "btn-yellow menu-btn";
    menuBtn.textContent = t("Port_Game_Menu", "Menu");
    menuBtn.style.padding = "1px 12px";
    menuBtn.style.minHeight = "auto";
    menuBtn.style.fontSize = "11px";
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.setAttribute("aria-pressed", "false");
    menuBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.toggleSettingsMenu();
    });
    actions.appendChild(menuBtn);
    this.menuButtonEl = menuBtn;

    right.appendChild(actions);

    trackinfo.appendChild(left);
    trackinfo.appendChild(center);
    trackinfo.appendChild(right);

    // Chat first in DOM order - single-player CSS hides it, multi-player CSS
    // gives it `flex: 1` so it takes the left half of the bottom band.
    const chatStrip = this.makeChatStrip();
    bottomBand.appendChild(chatStrip);
    this.chatStripEl = chatStrip;
    bottomBand.appendChild(trackinfo);

    wrap.appendChild(bottomBand);
    root.appendChild(wrap);

    this.canvas = canvas;
    this.trackProgressEl = trackProgress;
    this.trackTitleEl = trackTitle;
    this.trackAuthorEl = trackAuthor;
    this.statusEl = statusEl;
    this.strokeCountEl = strokeCountEl;
    this.avgParEl = avgPar;
    this.bestParEl = bestPar;
    this.scoreboardDirty = true;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#99ff99";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const keyHandler = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        // Avoid swallowing ESC while a chat input/textarea has focus - the
        // user is probably trying to clear a draft, not pop the menu.
        const focused = ev.target as HTMLElement | null;
        if (focused && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")) return;
        ev.preventDefault();
        this.toggleSettingsMenu();
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
      // Java parity: BUTTON1 = shoot; any other button cycles shootingMode
      // through 0..3 (normal → reverse → 90° CW → 90° CCW → …). The cycle
      // is gated on the same "ball at rest" condition as a shot.
      if (ev.button !== 0) {
        ev.preventDefault();
        this.cycleShootingMode();
        return;
      }
      const [mx, my] = localCoords(ev);
      const dx = me.ball.x - mx;
      const dy = me.ball.y - my;
      if (Math.sqrt(dx * dx + dy * dy) < 6.5) return;
      // Don't apply impulse here - wait for server broadcast (which includes
      // the seed) so we run identical physics with everyone else.
      const ix = (me.ball.x | 0);
      const iy = (me.ball.y | 0);
      this.app.connection.sendData(
        "game",
        "beginstroke",
        encodeCoords(ix, iy, 0) + "\t" + encodeCoords((mx | 0), (my | 0), this.shootingMode),
      );
    };
    canvas.addEventListener("mousedown", clickHandler);
    this.clickHandler = clickHandler;

    // Suppress the browser's right-click context menu on the canvas - the
    // right button is reserved for cycling shootingMode (Java parity).
    const contextMenuHandler = (ev: MouseEvent) => {
      ev.preventDefault();
    };
    canvas.addEventListener("contextmenu", contextMenuHandler);
    this.contextMenuHandler = contextMenuHandler;

    // ----- touch input (drag-to-shoot, mobile) ---------------------------
    // Mirrors the mouse pipeline: touchstart/move set mouseX/Y so the existing
    // aim-line render and cursor broadcast already work; touchend triggers the
    // same beginstroke send as a click. preventDefault on touchstart suppresses
    // iOS's synthesized 300 ms-later mousedown/click that would otherwise fire
    // a *second* shot.
    const localCoordsTouch = (t: Touch): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / Math.max(rect.width, 1);
      const sy = canvas.height / Math.max(rect.height, 1);
      return [(t.clientX - rect.left) * sx, (t.clientY - rect.top) * sy];
    };

    // Larger no-shot deadzone for touch than for the 6.5 px mouse threshold:
    // touch precision is ~10-30 screen px which lands as ~14-42 canvas px
    // after the landscape-fit downscale. Anything below this counts as a
    // tap-on-ball cancel rather than a tiny accidental nudge.
    const TOUCH_SHOT_DEADZONE = 14;

    const touchStartHandler = (ev: TouchEvent) => {
      // Only track if there is no active touch - multi-finger doesn't aim.
      if (this.activeTouchId !== null) return;
      if (ev.changedTouches.length === 0) return;
      ev.preventDefault();
      const t = ev.changedTouches[0];
      this.activeTouchId = t.identifier;
      const [mx, my] = localCoordsTouch(t);
      this.mouseX = mx;
      this.mouseY = my;
      this.touchClientX = t.clientX;
      this.touchClientY = t.clientY;
      this.aimingByTouch = true;
      this.showLoupe();
    };
    canvas.addEventListener("touchstart", touchStartHandler, { passive: false });
    this.touchStartHandler = touchStartHandler;

    const findActiveTouch = (list: TouchList): Touch | null => {
      if (this.activeTouchId === null) return null;
      for (let i = 0; i < list.length; i++) {
        if (list[i].identifier === this.activeTouchId) return list[i];
      }
      return null;
    };

    const touchMoveHandler = (ev: TouchEvent) => {
      const t = findActiveTouch(ev.changedTouches);
      if (!t) return;
      ev.preventDefault();
      const [mx, my] = localCoordsTouch(t);
      this.mouseX = mx;
      this.mouseY = my;
      this.touchClientX = t.clientX;
      this.touchClientY = t.clientY;
    };
    canvas.addEventListener("touchmove", touchMoveHandler, { passive: false });
    this.touchMoveHandler = touchMoveHandler;

    const touchEndHandler = (ev: TouchEvent) => {
      const t = findActiveTouch(ev.changedTouches);
      if (!t) return;
      ev.preventDefault();
      const [mx, my] = localCoordsTouch(t);
      this.activeTouchId = null;
      this.aimingByTouch = false;
      this.hideLoupe();
      // Mirror the mousedown shoot path. Same gating: ball must be at rest.
      const me = this.players[this.myPlayerId];
      if (!me || me.ball.inHole || me.simulating) return;
      const dx = me.ball.x - mx;
      const dy = me.ball.y - my;
      if (Math.sqrt(dx * dx + dy * dy) < TOUCH_SHOT_DEADZONE) return;
      const ix = (me.ball.x | 0);
      const iy = (me.ball.y | 0);
      this.app.connection.sendData(
        "game",
        "beginstroke",
        encodeCoords(ix, iy, 0) + "\t" + encodeCoords((mx | 0), (my | 0), this.shootingMode),
      );
    };
    canvas.addEventListener("touchend", touchEndHandler, { passive: false });
    this.touchEndHandler = touchEndHandler;

    const touchCancelHandler = (ev: TouchEvent) => {
      // OS interruption (notification, system gesture) - abort the aim.
      const t = findActiveTouch(ev.changedTouches);
      if (!t) return;
      this.activeTouchId = null;
      this.aimingByTouch = false;
      this.hideLoupe();
    };
    canvas.addEventListener("touchcancel", touchCancelHandler);
    this.touchCancelHandler = touchCancelHandler;

    void loadAtlases().then((atl) => {
      this.atlases = atl;
      this.setStatus(t("Port_Game_WaitingForTrack", "Waiting for track…"));
      if (this.pendingStartTrack) {
        const f = this.pendingStartTrack;
        this.pendingStartTrack = null;
        this.handleStartTrack(f);
      }
    }).catch((err) => {
      if (DEV) console.warn("[game] atlases failed", err);
      this.setStatus(t("Port_Game_SpriteLoadFailed", "Sprite load failed: %1", String(err)));
    });

    this.startLoop();
  }

  unmount(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.closeSettingsMenu();
    this.menuButtonEl = null;
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler);
    if (this.canvas) {
      if (this.mouseMoveHandler) this.canvas.removeEventListener("mousemove", this.mouseMoveHandler);
      if (this.clickHandler) this.canvas.removeEventListener("mousedown", this.clickHandler);
      if (this.contextMenuHandler) this.canvas.removeEventListener("contextmenu", this.contextMenuHandler);
      if (this.touchStartHandler) this.canvas.removeEventListener("touchstart", this.touchStartHandler);
      if (this.touchMoveHandler) this.canvas.removeEventListener("touchmove", this.touchMoveHandler);
      if (this.touchEndHandler) this.canvas.removeEventListener("touchend", this.touchEndHandler);
      if (this.touchCancelHandler) this.canvas.removeEventListener("touchcancel", this.touchCancelHandler);
    }
    this.keyHandler = null;
    this.mouseMoveHandler = null;
    this.clickHandler = null;
    this.contextMenuHandler = null;
    this.touchStartHandler = null;
    this.touchMoveHandler = null;
    this.touchEndHandler = null;
    this.touchCancelHandler = null;
    this.activeTouchId = null;
    this.aimingByTouch = false;
    if (this.loupeEl && this.loupeEl.parentNode) {
      this.loupeEl.parentNode.removeChild(this.loupeEl);
    }
    this.loupeEl = null;
    this.shootModeBtnEl = null;
    this.canvas = null;
    this.scoreboardEl = null;
    this.statusEl = null;
    this.strokeCountEl = null;
    this.trackProgressEl = null;
    this.trackTitleEl = null;
    this.trackAuthorEl = null;
    this.avgParEl = null;
    this.bestParEl = null;
    this.chatLogEl = null;
    this.chatInputEl = null;
    this.chatStripEl = null;
    this.skipButton = null;
    this.skipButtonHost = null;
    this.playAgainButton = null;
    this.practiceButton = null;
    this.gameStartedReceived = false;
    this.practiceMode = false;
    this.roomCapacity = 1;
    this.overlay = null;
    this.panelEl = null;
    this.root = null;
    this.players = [];
    this.pendingBeginStrokes = [];
    this.trackScoresMultipliers = [];
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
        // Capture the configured room cap before starttrack can shrink
        // `numPlayers` in a partially-filled room (see `roomCapacity`
        // declaration).
        this.roomCapacity = this.numPlayers;
        this.numTracks = parseInt(f[6] ?? "1", 10) || 1;
        this.waterEvent = parseInt(f[10] ?? "0", 10) || 0;
        // Fresh gameinfo arrives on every join - reset the "started" gate so
        // the Practice button reappears for any new room (including a
        // re-join). The trailing `f` flag in the packet always says
        // "isStarted=false" today; we don't trust it and just track via the
        // `start` broadcast.
        this.gameStartedReceived = false;
        this.practiceMode = false;
        this.ensurePlayerSlots(this.numPlayers);
        this.scoreboardDirty = true;
        this.applyChatVisibility();
        this.updateSkipButtonVisibility();
        break;
      case "owninfo":
        this.myPlayerId = parseInt(f[2] ?? "0", 10) || 0;
        this.myNick = f[3] ?? "You";
        this.ensurePlayerSlots(this.myPlayerId + 1);
        this.players[this.myPlayerId].nick = this.myNick;
        this.players[this.myPlayerId].clan = normalizeClan(f[4]);
        this.scoreboardDirty = true;
        break;
      case "players":
        for (let i = 2; i + 2 < f.length; i += 3) {
          const id = parseInt(f[i] ?? "0", 10);
          this.ensurePlayerSlots(id + 1);
          this.players[id].nick = f[i + 1] ?? "";
          this.players[id].clan = normalizeClan(f[i + 2]);
        }
        this.scoreboardDirty = true;
        break;
      case "join":
        {
          const id = (parseInt(f[2] ?? "1", 10) || 1) - 1;
          this.ensurePlayerSlots(id + 1);
          // Slot may have been left inactive by an earlier `part`. Reset
          // every per-player field a previous occupant could have dirtied
          // before populating the new identity - otherwise the joiner
          // inherits stale `active=false`, prior strokes, holed/forfeit
          // flags, ball position, hole-score history, etc. The spawn falls
          // back to `slot.startX/Y` which is the panel default for fresh
          // slots; this is correct because today MultiGame join is gated
          // pre-start (game.ts:887-889 removes started games from the
          // lobby gamelist), so `slot.startX/Y` hasn't been re-pointed at a
          // previous occupant's per-track spawn yet.
          const slot = this.players[id];
          slot.nick = f[3] ?? "";
          slot.clan = normalizeClan(f[4]);
          slot.active = true;
          slot.simulating = false;
          slot.holedThisTrack = false;
          slot.forfeitedThisTrack = false;
          slot.strokesThisTrack = 0;
          slot.holeScores = [];
          slot.ball = newBall(slot.startX, slot.startY);
          slot.ctx = null;
          slot.cursorX = null;
          slot.cursorY = null;
          slot.cursorMode = 0;
          this.appendChat("* " + t("Chat_Game_PlayerJoined", "%1 joined the game", slot.nick), "system");
          this.scoreboardDirty = true;
        }
        break;
      case "part":
        {
          // Java GamePanel.handlePacket "part" reads args[3] as the reason byte
          // and routes to PlayerInfoPanel.setPlayerPartStatus, which:
          //   reason 6 → silent name-null (no chat line)
          //   reason 4 → "Left the game" badge
          //   reason 5 → "Connection problem" badge
          // We mirror those branches here.
          const id = parseInt(f[2] ?? "0", 10) || 0;
          const reason = parseInt(f[3] ?? "4", 10) || 4;
          const slot = this.players[id];
          if (slot) {
            if (reason === 6) {
              // SWITCHEDLOBBY - silent removal, just clear the slot's name
              // so the scoreboard row no longer references them.
              slot.nick = "";
              slot.active = false;
              slot.partReason = 0;
            } else {
              slot.active = false;
              slot.partReason = reason;
              const nick = slot.nick || t("Port_Game_PlayerFmt", "Player %1", id + 1);
              if (reason === 5) {
                this.appendChat(
                  "* " + t("Port_Chat_PlayerConnProblem", "%1 disconnected (connection problem)", nick),
                  "system",
                );
              } else {
                this.appendChat(
                  "* " + t("Chat_Game_PlayerLeft", "Player %1 left the game", nick),
                  "system",
                );
              }
            }
          }
          this.scoreboardDirty = true;
        }
        break;
      case "voteskip":
        {
          // Server broadcasts to OTHER players only; the local clicker sets
          // the flag in `voteSkip()`. So this branch fires for peers' votes.
          const id = parseInt(f[2] ?? "0", 10) || 0;
          const slot = this.players[id];
          if (slot) {
            slot.votedToSkip = true;
            const nick = slot.nick || t("Port_Game_PlayerFmt", "Player %1", id + 1);
            this.appendChat(
              "* " + t("Port_Chat_VoteSkip", "%1 voted to skip the track", nick),
              "system",
            );
          }
          this.scoreboardDirty = true;
        }
        break;
      case "resetvoteskip":
        // Server broadcasts on every starttrack and on game start. Java's
        // `voteSkipReset()` clears all flags; we mirror that and re-show the
        // skip button so the local player can vote again on the new track.
        for (const slot of this.players) slot.votedToSkip = false;
        this.updateSkipButtonVisibility();
        this.scoreboardDirty = true;
        break;
      case "rfng":
        {
          // "Ready for new game" from a peer (server uses writeExcluding for
          // this, so the local clicker sets the flag in `requestNewGame()`).
          const id = parseInt(f[2] ?? "0", 10) || 0;
          const slot = this.players[id];
          if (slot) {
            slot.wantsNewGame = true;
            const nick = slot.nick || t("Port_Game_PlayerFmt", "Player %1", id + 1);
            this.appendChat(
              "* " + t("Port_Chat_WantsNewGame", "%1 wants a new game", nick),
              "system",
            );
          }
          this.scoreboardDirty = true;
        }
        break;
      case "scoringmulti":
        {
          // Per-track score multipliers. Stored once; each starttrack reads
          // the entry for the new track and posts a chat notice if > 1.
          const arr: number[] = [];
          for (let i = 2; i < f.length; i++) {
            arr.push(parseInt(f[i] ?? "1", 10) || 1);
          }
          this.trackScoresMultipliers = arr;
        }
        break;
      case "cr":
        // Per-track comparison results. Java feeds this into the player-info
        // panel's results-comparison view, which the port hasn't built yet
        // (issue #30). Accept and discard so the verb stops appearing in the
        // unhandled-packet log; the comparison panel is a deferred follow-up.
        break;
      case "start":
        // Server's "round begins" broadcast - fires both at first game start
        // AND on "uusi peli" (new game) restart after the end overlay. Reset
        // per-game scoreboard state so a fresh round doesn't carry forward
        // the prior game's hole scores or track index.
        for (const slot of this.players) {
          slot.votedToSkip = false;
          slot.wantsNewGame = false;
          slot.holeScores = [];
          slot.strokesThisTrack = 0;
          slot.holedThisTrack = false;
          slot.forfeitedThisTrack = false;
        }
        this.currentTrackIdx = 0;
        this.gameStartedReceived = true;
        // Default to non-practice. A subsequent `practicemode t` packet will
        // flip this back on if the start was for practice; otherwise we're
        // in a real game (full room) and per-hole columns should render.
        this.practiceMode = false;
        // Tear down any leftover end-of-game overlay before the new round
        // starts; otherwise the play-again button stays on screen even though
        // the new game has begun.
        this.removeOverlay();
        this.updateSkipButtonVisibility();
        this.scoreboardDirty = true;
        audio.playNotify();
        break;
      case "practicemode":
        // Port-original packet. Sent right after a practice `starttrack` so
        // the client knows the cycling-random-maps mode is on; absent on
        // real-game starts. The trailing field is "t"/"f" (default true).
        this.practiceMode = (f[2] ?? "t") === "t";
        this.scoreboardDirty = true;
        this.updateSkipButtonVisibility();
        this.refreshTrackProgress();
        break;
      case "starttrack":
        // A late joiner to a started game gets a personal `starttrack`
        // (no `start` precedes it on their wire), so flip the
        // game-started gate here too - otherwise the Practice button
        // would still be available to a player who's already mid-room.
        this.gameStartedReceived = true;
        this.handleStartTrack(f);
        break;
      case "gametrack":
        // Late-joiner correction: server tells us which configured track
        // index this is so the HUD reads "Track N/M" matching the room
        // rather than the default "Track 1/M" the client would compute
        // from the single starttrack it just received. No-op for normal
        // joiners - `handleStartTrack` already incremented to the right
        // value before this packet arrives, and the server simply doesn't
        // emit `gametrack` for them.
        {
          const idx = parseInt(f[2] ?? "1", 10) || 1;
          this.currentTrackIdx = idx;
          this.refreshTrackProgress();
          this.scoreboardDirty = true;
        }
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
      case "cursor":
        // Live aim preview from a peer.
        // wire: game cursor <playerId> <x> <y> [<shootingMode>]
        // The mode field is optional for back-compat with older senders;
        // missing means mode 0 (normal aim).
        {
          const id = parseInt(f[2] ?? "0", 10) || 0;
          const cx = parseInt(f[3] ?? "0", 10) || 0;
          const cy = parseInt(f[4] ?? "0", 10) || 0;
          const cm = f[5] !== undefined ? ((parseInt(f[5], 10) || 0) % 4) : 0;
          const slot = this.players[id];
          if (slot && id !== this.myPlayerId) {
            slot.cursorX = cx;
            slot.cursorY = cy;
            slot.cursorMode = cm;
          }
        }
        break;
      case "say":
        {
          const id = parseInt(f[2] ?? "0", 10) || 0;
          const nick = this.players[id]?.nick ?? "?";
          this.appendChat(t("Chat_UserSay", "<%1> %2", nick, f[3] ?? ""), "say");
        }
        break;
      case "sayp":
        this.appendChat(t("Port_Chat_WhisperFromFmt", "[whisper from %1] %2", f[2] ?? "?", f[3] ?? ""), "whisper");
        break;
      case "end":
        this.showEndOverlay(f);
        break;
      case "dailymode":
        // Server tagging this room as the daily challenge. f[2] is the UTC
        // date key the server picked the track for. The packet arrives AFTER
        // `starttrack` (server.joinDaily ordering), so refresh the skip
        // button - the prior starttrack would have shown it for a daily
        // room with two or more occupants because dailyMode was still false.
        this.dailyMode = true;
        this.dailyDateKey = f[2] ?? null;
        this.updateSkipButtonVisibility();
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
      this.setStatus(t("Port_Game_NoTLine", "Could not load track (no T-line)."));
      return;
    }
    try {
      const parsed = buildMap(tLine, this.atlases);
      this.parsedMap = parsed;
      // S line: 4 visibility/shadow flags + legacy 2-digit player range. Server
      // forwards the raw body; we decode the first four chars. Missing/short
      // S → all-false, mirroring `new boolean[4]` in Java's track parser.
      const settingsBody = extractField(f, "S ") ?? "";
      const settingsFlags = parseSettingsFlags(settingsBody);
      this.renderer = new TrackRenderer(parsed, this.atlases, settingsFlags);
      // Pick the common (shape-24) start, deterministic from gameId.
      const commonStart: [number, number] | null =
        parsed.startPositions.length > 0
          ? parsed.startPositions[
              Number(BigInt(this.gameId) % BigInt(parsed.startPositions.length))
            ] ?? null
          : null;
      // Panel-wide defaults (used by ensurePlayerSlots before we know spawns).
      const defaultStart = commonStart ?? [367.5, 187.5];
      this.startX = defaultStart[0];
      this.startY = defaultStart[1];

      // Per-player spawn - Java resetPosition() rules: per-color (48..51) wins,
      // common start is the fallback, finally the centre default.
      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i];
        const colour = i < parsed.resetPositions.length ? parsed.resetPositions[i] : null;
        const spawn = colour ?? commonStart ?? [367.5, 187.5];
        p.startX = spawn[0];
        p.startY = spawn[1];
        p.ball = newBall(spawn[0], spawn[1]);
        p.active = true;
        p.strokesThisTrack = 0;
        p.simulating = false;
        p.ctx = null;
        p.holedThisTrack = false;
        p.forfeitedThisTrack = false;
        // Drop stale aim previews - last hole's cursor would point off-map.
        p.cursorX = null;
        p.cursorY = null;
        p.cursorMode = 0;
      }
      this.currentTrackIdx++;
      this.updateStrokeCount();
      // Java parity: shootingMode resets at startTurn - for our async port
      // there's no per-turn boundary, so reset on every track change so a
      // mode picked on the previous hole doesn't leak into the new one.
      this.shootingMode = 0;
      this.refreshShootModeBtn();

      const author = extractField(f, "A ") ?? "";
      const name = extractField(f, "N ") ?? "";
      const info = parseInfoLine(extractField(f, "I "));
      const bestPlayer = (extractField(f, "B ") ?? "").split(",")[0] ?? "";
      this.setTrackMeta(author, name, info, bestPlayer);
      this.trackAuthor = author;
      // Capture the raw T-line for replay-link generation. We capture on every
      // starttrack rather than only when `this.dailyMode` is set: the server
      // sends `starttrack` BEFORE `dailymode` in the daily-join sequence
      // (server.ts joinDaily: start → resetvoteskip → starttrack → dailymode),
      // so a `dailyMode` guard here always missed the first track and left
      // `dailyTLine` null - hiding the "Copy replay link" button in the share
      // overlay. The fields are harmless to populate for non-daily rooms; the
      // button-render check requires both daily mode and recorded strokes.
      this.dailyTLine = tLine;
      this.dailyReplayStrokes = [];
      this.dailyResultRecorded = false;

      this.setStatus(t("Port_Game_ClickToShoot", "Click to shoot when you're ready."));
      this.removeOverlay();
      // Fresh track: vote-skip flags get cleared by the server's
      // `resetvoteskip` broadcast (which precedes starttrack), but mirror the
      // reset locally too in case the packets arrive out of order.
      for (const slot of this.players) slot.votedToSkip = false;
      // Java GamePanel.starttrack: after `playerInfoPanel.startNextTrack()`
      // returns the multiplier for the NEW track, post a chat notice if > 1.
      // currentTrackIdx was just incremented above so the [-1] indexes the
      // multiplier entry for the freshly-starting track.
      const trackMul = this.trackScoresMultipliers[this.currentTrackIdx - 1] ?? 1;
      if (trackMul > 1) {
        this.appendChat(
          t("GameChat_ScoreMultiNotify", "* %1x score from this track *", trackMul),
          "system",
        );
      }
      this.updateSkipButtonVisibility();
      this.scoreboardDirty = true;
      // Replay any beginstrokes that arrived too early.
      const queued = this.pendingBeginStrokes;
      this.pendingBeginStrokes = [];
      for (const q of queued) this.handleBeginStroke(q);
    } catch (err) {
      if (DEV) console.warn("[game] track build failed", err);
      this.setStatus(t("Port_Game_TrackParseError", "Track parse error: %1", String(err)));
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

    // Take the ball position the server believed at stroke begin - this keeps
    // every client's physics agreement bit-exact even if our local ball drifted.
    const ballCoords = decodeCoords(ballRaw);
    slot.ball.x = ballCoords.x;
    slot.ball.y = ballCoords.y;

    const mouse = decodeCoords(mouseRaw);
    // Snapshot all OTHER players' resting positions for the movable-block
    // obstruction check. Skip the shooter (their ball is the one moving) and
    // any peer currently mid-stroke (we'd diverge across clients otherwise -
    // local positions for in-flight balls aren't authoritative).
    const otherPlayers: Array<{ x: number; y: number } | null> = [];
    for (let pi = 0; pi < this.players.length; pi++) {
      if (pi === id) {
        otherPlayers.push(null);
        continue;
      }
      const peer = this.players[pi];
      if (peer.simulating || peer.ball.inHole) {
        otherPlayers.push(null);
        continue;
      }
      otherPlayers.push({ x: peer.ball.x, y: peer.ball.y });
    }
    const ctx: PhysicsContext = {
      map: this.parsedMap,
      seed: new Seed(BigInt(seedNum)),
      norandom: false,
      waterEvent: this.waterEvent,
      // Per-slot start so water (event 0) and acid resets land at THIS player's
      // spawn, not at player 0's. Determinism-safe: every client computes the
      // same per-slot spawn from the same map+gameId.
      startX: slot.startX,
      startY: slot.startY,
      otherPlayers,
    };
    slot.ctx = ctx;
    applyStrokeImpulse(slot.ball, ctx, mouse.x, mouse.y, mouse.mode);
    slot.simulating = true;
    // Mirror Java GamePanel.java:388 / :448 - playGameMove() on every stroke,
    // including the local player's (server echoes their own click back).
    audio.playGameMove();
    // Clear the firing peer's aim preview so we don't draw a stale line from
    // the new resting position to the old click point after their ball stops.
    // Self never has cursorX/Y populated (we only set it for peers), so this
    // is a no-op for the shooter.
    slot.cursorX = null;
    slot.cursorY = null;
    slot.cursorMode = 0;
    // Java parity: shootingMode resets after the shot is taken. The shooter's
    // server echo is the trigger here so the reset survives any local race
    // with a right-click made between sending the click and the echo.
    if (id === this.myPlayerId) {
      this.shootingMode = 0;
      this.refreshShootModeBtn();
    }
    // Record OUR strokes when in daily mode for the share-link replay. Stored
    // raw (4-char base36 coords + uint32 seed) so encoding the link is just a
    // straight JSON pack - no further processing needed.
    if (this.dailyMode && id === this.myPlayerId) {
      this.dailyReplayStrokes.push([ballRaw, mouseRaw, seedNum]);
    }
    this.scoreboardDirty = true;
  }

  /** Server's scoreboard sync after a player's stroke ended. */
  private handleEndStrokeBroadcast(f: string[]): void {
    const id = parseInt(f[2] ?? "0", 10);
    const strokes = parseInt(f[3] ?? "0", 10);
    const status = f[4] ?? "f"; // 't' = holed, 'p' = passed/forfeited, 'f' = still playing
    const slot = this.players[id];
    if (!slot) return;
    slot.strokesThisTrack = strokes;
    // Stamp the per-hole tally on every stroke; the last write before the
    // server advances to the next track becomes the recorded final score.
    if (this.currentTrackIdx > 0) {
      slot.holeScores[this.currentTrackIdx - 1] = strokes;
    }
    if (status === "t") {
      slot.ball.inHole = true;
      slot.simulating = false;
      slot.holedThisTrack = true;
    } else if (status === "p") {
      slot.simulating = false;
      slot.forfeitedThisTrack = true;
      // Hide the ball - they're done with this hole.
      slot.ball.inHole = true; // reuse the "hidden" sprite path
    }
    if (id === this.myPlayerId) this.updateStrokeCount();
    this.scoreboardDirty = true;
  }

  // ----- physics tick ---------------------------------------------------

  private physicsAccumMs = 0;
  private lastTickMs = 0;
  /** Cursor-broadcast throttle: timestamp of last `game cursor` we sent. */
  private lastCursorSentMs = 0;
  private lastCursorSentX = -9999;
  private lastCursorSentY = -9999;

  /**
   * Stream our cursor to peers at ~15 Hz so they see our aim line live.
   * Bandwidth-conscious: sends only while OUR ball is at rest, and only when
   * the cursor has moved by at least 2 px since last send. The mode (0..3)
   * is appended so peers can render the rotated aim line (right-click parity);
   * a right-click reset of `lastCursorSentX/Y` forces a send on mode-only
   * change so a stationary cursor still pushes the new orientation through.
   */
  private maybeSendCursor(nowMs: number): void {
    if (!this.app.connection.isOpen) return;
    if (!this.settings.sendCursor) return;
    const me = this.players[this.myPlayerId];
    if (!me) return;
    if (me.simulating || me.ball.inHole || me.holedThisTrack || me.forfeitedThisTrack) return;
    // Touch devices: only broadcast while actively aiming, otherwise peers
    // would see a frozen aim line at our last finger position.
    if (this.isTouchPrimary && !this.aimingByTouch) return;
    if (nowMs - this.lastCursorSentMs < 66) return; // 15 Hz cap
    const cx = this.mouseX | 0;
    const cy = this.mouseY | 0;
    if (Math.abs(cx - this.lastCursorSentX) < 2 && Math.abs(cy - this.lastCursorSentY) < 2) return;
    // Server stamps the playerId before forwarding, so we don't include it.
    this.app.connection.sendData(
      "game",
      "cursor",
      String(cx),
      String(cy),
      String(this.shootingMode),
    );
    this.lastCursorSentMs = nowMs;
    this.lastCursorSentX = cx;
    this.lastCursorSentY = cy;
  }

  private startLoop(): void {
    const tick = () => {
      this.rafHandle = requestAnimationFrame(tick);
      this.maybeSendCursor(performance.now());
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
    // Daily rooms have sparse player ids (a finisher who later leaves still
    // owns a slot in the server's playStatus, so a fresh joiner's myPlayerId
    // can exceed the broadcast playStatus length / numPlayers). Iterate up to
    // myPlayerId+1 so the produced string always includes our own char -
    // otherwise the server reads `charAt(myPlayerId) === ""`, resolves it to
    // "f", and never marks us as holed.
    const len = Math.max(this.numPlayers, this.myPlayerId + 1);
    let s = "";
    for (let i = 0; i < len; i++) {
      if (i === this.myPlayerId) {
        s += this.players[i]?.ball.inHole ? "t" : "f";
      } else {
        // Other players' status: the server overwrites it anyway, so just
        // say "still playing" - the server only trusts our own char.
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
      this.strokeCountEl.textContent = t("Port_Game_StrokeFmt", "Stroke %1", slot?.strokesThisTrack ?? 0);
    }
  }

  /** Refresh just the track-progress line. Pulled out of `setTrackMeta` so
   *  `practicemode` packets (which arrive AFTER the starttrack that wrote
   *  the "Track N/M" text) can re-render it as "Practice" without rebuilding
   *  the rest of the metadata. */
  private refreshTrackProgress(): void {
    if (!this.trackProgressEl) return;
    if (this.practiceMode) {
      this.trackProgressEl.textContent = t("Port_Game_PracticeProgress", "Practice");
    } else {
      this.trackProgressEl.textContent = t(
        "GameTrackInfo_CurrentTrack",
        "Track %1/%2",
        this.currentTrackIdx,
        this.numTracks,
      );
    }
  }

  private setTrackMeta(
    author: string,
    name: string,
    info: TrackInfoLine | null,
    bestPlayer: string,
  ): void {
    this.refreshTrackProgress();
    // Stash for the daily-share text; both fields are blank until the first
    // starttrack arrives.
    this.trackName = name;
    this.trackAverage = info && info.plays > 0 ? info.totalStrokes / info.plays : 0;
    if (this.trackTitleEl) this.trackTitleEl.textContent = name;
    if (this.trackAuthorEl) {
      this.trackAuthorEl.textContent = author ? t("Port_Game_AuthorByFmt", "by %1", author) : "";
    }
    if (this.avgParEl) {
      if (info && info.plays > 0) {
        const avg = info.totalStrokes / info.plays;
        this.avgParEl.textContent = t("GameTrackInfo_AverageResultL", "Average of all players: %1 strokes", avg.toFixed(1));
      } else {
        this.avgParEl.textContent = "";
      }
    }
    if (this.bestParEl) {
      while (this.bestParEl.firstChild) this.bestParEl.removeChild(this.bestParEl.firstChild);
      if (info && info.plays > 0 && info.bestPar > 0) {
        const pct = (info.numBestPar / info.plays) * 100;
        // Two-line layout: "Paras: %1 lyöntiä by <player>" / "(%1% pelanneista)".
        const head = t("GameTrackInfo_BestResultL", "Best: %1 strokes", info.bestPar);
        const pctSuffix = t("GameTrackInfo_BestResultPercentL", "(%1% of players)", pct.toFixed(1));
        const who = bestPlayer ? " " + t("Port_Game_BestByFmt", "by %1", bestPlayer) : "";
        const line1 = document.createElement("div");
        line1.textContent = head + who;
        const line2 = document.createElement("div");
        line2.textContent = pctSuffix;
        this.bestParEl.appendChild(line1);
        this.bestParEl.appendChild(line2);
      }
    }
  }

  private renderScoreboard(): void {
    const sb = this.scoreboardEl;
    if (!sb) return;
    while (sb.firstChild) sb.removeChild(sb.firstChild);
    // Iterate `players.length` so a high-sparse-id self-row in a daily room
    // still renders (numPlayers can be smaller than myPlayerId+1).
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p) continue;
      // Daily mode: only the local player's score is shown - other ghosts in
      // the room represent concurrent runs, not a shared scoreboard.
      if (this.dailyMode && i !== this.myPlayerId) continue;
      const row = document.createElement("div");
      row.className = "row " + (i === this.myPlayerId ? "you" : "them");
      const num = document.createElement("span");
      num.textContent = `${i + 1}.`;
      const name = document.createElement("span");
      name.textContent = p.nick || t("Port_Game_PlayerFmt", "Player %1", i + 1);
      // Match the ball+cursor palette - same `playerIdx` used by render.ts.
      // The inline style overrides `.row.you` / `.row.them` colour rules.
      name.style.color = slotNickColor(i);
      // Per-hole stroke counts. Each cell renders into its own fixed-width
      // span (`.track-cell`) so that 2-digit scores (10+) don't shift the
      // total/note columns out of alignment relative to other rows. Mirrors
      // the column-aligned scoreboard in the original Java client.
      //
      // Practice mode: tracks cycle (server picks a new random map every
      // hole-in), so per-hole columns and a running "total" don't carry
      // any meaning. Show just the live stroke counter for the current map.
      const tracksCol = document.createElement("span");
      tracksCol.className = "tracks-cells";
      let totalSoFar = 0;
      if (this.practiceMode) {
        const cell = document.createElement("span");
        cell.className = "track-cell";
        cell.textContent = String(p.strokesThisTrack);
        tracksCol.appendChild(cell);
        totalSoFar = p.strokesThisTrack;
      } else {
        for (let t = 0; t < this.numTracks; t++) {
          const cell = document.createElement("span");
          cell.className = "track-cell";
          if (t + 1 < this.currentTrackIdx) {
            // `holeScores[t]` is undefined when this player joined the
            // room AFTER track `t+1` ended (the server can't replay
            // historical per-track stroke counts - the client only
            // accumulates them from live `endstroke` broadcasts during
            // the run). Render "-" instead of "0" so a late joiner's
            // scoreboard distinguishes "didn't play" from "scored 0".
            const score = p.holeScores[t];
            if (score === undefined) {
              cell.textContent = "-";
            } else {
              cell.textContent = String(score);
              totalSoFar += score;
            }
          } else if (t + 1 === this.currentTrackIdx) {
            cell.textContent = String(p.strokesThisTrack);
            totalSoFar += p.strokesThisTrack;
          } else {
            cell.textContent = "-";
          }
          tracksCol.appendChild(cell);
        }
      }
      const total = document.createElement("span");
      // In practice mode the "= N" total would just duplicate the single
      // strokes cell - drop it for a cleaner read.
      total.textContent = this.practiceMode ? "" : "= " + totalSoFar;
      const note = document.createElement("span");
      // Mirrors Java PlayerInfoPanel's `extraMessage` priority chain:
      // part-reason badges win over voteSkip/wantsNewGame, which win over
      // the in-progress play-state notes.
      if (p.partReason === 5) {
        note.textContent = t(
          "GamePlayerInfo_Quit_ConnectionProblem",
          "(Connection problem or closed browser)",
        );
      } else if (p.partReason === 4) {
        note.textContent = t("GamePlayerInfo_Quit_Part", "(Left the game)");
      } else if (p.wantsNewGame) {
        note.textContent = t("GamePlayerInfo_ReadyForNewGame", "(Wants a new game!)");
      } else if (p.votedToSkip) {
        note.textContent = t("GamePlayerInfo_VoteSkipTrack", "(Vote: skip track)");
      } else if (p.holedThisTrack) {
        note.textContent = t("Port_Game_StatusInHole", "in hole");
      } else if (p.forfeitedThisTrack) {
        note.textContent = t("Port_Game_StatusForfeited", "forfeited");
      } else if (p.simulating) {
        note.textContent = t("Port_Game_StatusShooting", "shooting");
      }
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
    // The `.chat-strip` class is referenced by both single-player ("hide via
    // CSS") and multi-player (`.is-multi .chat-strip { flex: 1 }`) layout
    // rules in style.css.
    strip.className = "chat-strip";

    const log = document.createElement("div");
    log.style.flex = "1";
    // Without min-height: 0 the flex item refuses to shrink below its
    // intrinsic content height, defeating overflow-y:auto.
    log.style.minHeight = "0";
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

    // Operator-disabled chat: keep the log so server-driven messages still
    // surface, but drop the input row so the UI never invites typing the
    // server would discard.
    if (!this.app.chatEnabled) {
      return strip;
    }

    const form = document.createElement("form");
    form.style.display = "flex";
    form.style.gap = "3px";
    form.style.marginTop = "3px";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 200;
    input.placeholder = t("Port_Chat_GameInputHelp", "Chat (Enter to send)");
    input.style.flex = "1";
    input.style.fontSize = "11px";
    form.appendChild(input);
    this.chatInputEl = input;

    const send = document.createElement("button");
    send.type = "submit";
    send.textContent = t("Port_Chat_Send", "Send");
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
    this.appendChat(t("Chat_UserSay", "<%1> %2", this.myNick, text), "say-self");
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
    // Bound the scrollback so multi-hour sessions don't grow the DOM forever.
    while (log.childNodes.length > CHAT_LOG_MAX_LINES) {
      log.removeChild(log.firstChild!);
    }
    log.scrollTop = log.scrollHeight;
  }

  // ----- canvas rendering -----------------------------------------------

  private draw(): void {
    if (this.scoreboardDirty) {
      this.scoreboardDirty = false;
      this.renderScoreboard();
    }
    if (!this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    if (!this.renderer) {
      ctx.fillStyle = "#99ff99";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    // Drain any tile mutations (movable blocks, breakable bricks) into the
    // renderer's cached background. The shading pass (applyShading) casts
    // shadows across tile boundaries, so we rebuild the full bgCanvas rather
    // than re-blitting individual tiles - otherwise a moved block leaves a
    // phantom shadow at its old position and shows no bevel/shadow at its new
    // one. Coalesces any number of mutations into one rebuild per frame.
    if (this.parsedMap && this.parsedMap.dirtyTiles.length > 0) {
      this.parsedMap.dirtyTiles.length = 0;
      this.renderer.rebuildBackground();
    }
    let aim: AimLine | null = null;
    const me = this.players[this.myPlayerId];
    // On touch-primary devices the aim line only shows while a finger is
    // actively dragging - without this gate, mouseX/Y stays at the last
    // touch point (or the initial 0,0) and we'd render a stale/origin aim.
    const aimSuppressedByTouch = this.isTouchPrimary && !this.aimingByTouch;
    if (me && !me.ball.inHole && !me.simulating && !aimSuppressedByTouch) {
      aim = {
        fromX: me.ball.x,
        fromY: me.ball.y,
        toX: this.mouseX,
        toY: this.mouseY,
        mode: this.shootingMode,
      };
    }
    const sprites = this.drawSprites;
    const peerAims = this.drawPeerAims;
    sprites.length = 0;
    peerAims.length = 0;
    // Iterate `players.length` (not `numPlayers`): in daily rooms our own
    // myPlayerId can exceed numPlayers because of sparse server-side ids
    // accumulated from finishers who later left. ensurePlayerSlots already
    // grew the array to cover myPlayerId+1, so this loop reaches our slot.
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p) continue;
      const isMine = i === this.myPlayerId;
      // Skip empty placeholder slots from sparse-id gaps in daily rooms - a
      // joiner with a high sparse id leaves untouched lower indices that
      // never received `players` or `join`. Without this they would render
      // as ghosts at spawn labelled "Player N".
      if (this.dailyMode && !isMine && p.nick === "") continue;
      // Daily mode: render every other player as a translucent ghost with a
      // name label above. Self renders normally.
      const ghost = this.dailyMode && !isMine;
      // Multiplayer name labels - Java's `playerNamesDisplayMode` defaults
      // to `playerCount <= 2 ? 0 : 3`, so labels only appear in 3+ player
      // games. Self is intentionally suppressed: the user knows which ball
      // is theirs, and Java's white-self / black-others colour split was
      // moot in our continuous-render model anyway. The Valikko toggle
      // still lets the user hide them in larger games. Ghosts short-circuit
      // since they already render their own centered label.
      const showName =
        !ghost &&
        !isMine &&
        this.settings.showNames &&
        this.numPlayers >= 3 &&
        p.active &&
        !p.holedThisTrack &&
        !p.forfeitedThisTrack &&
        !p.ball.inHole &&
        (p.nick?.length ?? 0) > 0;
      // Sink/drown shrink animation. Java GameCanvas.drawPlayer (line 540)
      // passes the live onHoleTimer as shrinkAmount whenever the ball is on a
      // hole/water/acid/swamp tile - physics.ts mirrors this in `liquidTimer`,
      // ramping 0→2.166 over a hole sink and 0→6.0 over a liquid death.
      const isSinking = p.ball.onHole || p.ball.onLiquidOrSwamp;
      sprites.push({
        x: p.ball.x,
        y: p.ball.y,
        playerIdx: i,
        // Always idle frame - the "moving" frame in balls.gif is a different
        // colour for the next player slot, which made the ball appear to swap
        // colours mid-shot.
        moving: false,
        hidden: p.ball.inHole,
        ghost,
        label: ghost ? (p.nick || `Player ${i + 1}`) : undefined,
        nameDisplay: showName
          ? { mode: 3, name: p.nick, clan: p.clan, isSelf: isMine }
          : undefined,
        shrink: isSinking ? p.ball.liquidTimer : 0,
      });
      // Peer aim preview - only for non-self peers whose ball is at rest and
      // who have a fresh cursor sample. The cursor is cleared on track change
      // and on each beginstroke so we never show a stale aim. Suppressed in
      // daily mode: the ghost rendering treats other players as non-interactive
      // shadows of past plays; live aim lines would clash with that framing.
      if (
        this.settings.showPeerCursors &&
        !isMine &&
        !ghost &&
        !p.ball.inHole &&
        !p.simulating &&
        !p.holedThisTrack &&
        !p.forfeitedThisTrack &&
        p.cursorX !== null &&
        p.cursorY !== null
      ) {
        peerAims.push({
          fromX: p.ball.x,
          fromY: p.ball.y,
          toX: p.cursorX,
          toY: p.cursorY,
          playerIdx: i,
          mode: p.cursorMode,
        });
      }
    }
    this.renderer.drawFrame(ctx, sprites, aim, peerAims);
    // Update the magnifier loupe AFTER the renderer has painted this frame,
    // so the zoomed-in copy includes the just-drawn aim line. Sampling in a
    // touchmove callback would lag the aim line by one frame.
    if (this.aimingByTouch) this.drawLoupe();
  }

  // ----- magnifier loupe (mobile) ---------------------------------------

  /**
   * Mount the loupe canvas on first use and tag it visible. The element lives
   * directly under <body> (position: fixed) so the landscape transform on
   * #app doesn't affect its size - we want a constant 120 px circle floating
   * over the finger regardless of the global scale factor.
   */
  private showLoupe(): void {
    if (!this.loupeEl) {
      const el = document.createElement("canvas");
      el.className = "aim-loupe";
      el.width = 120;
      el.height = 120;
      document.body.appendChild(el);
      this.loupeEl = el;
    }
    this.loupeEl.classList.add("is-visible");
    // Position immediately so the loupe doesn't pop in at (0,0); content gets
    // painted on the next draw() tick.
    this.positionLoupe();
  }

  private hideLoupe(): void {
    if (this.loupeEl) this.loupeEl.classList.remove("is-visible");
  }

  /**
   * Place the loupe according to the user's `loupePlacement` setting:
   *  - `above` / `below`: track the finger with a 110 px offset; the
   *    fallback flip happens automatically when the finger is too close to
   *    the screen edge in that direction.
   *  - `top-left` / `top-right`: pin to a viewport corner so the loupe never
   *    moves with the finger (useful when the finger position is fine but
   *    the user wants the magnified view in a stable spot).
   *  All variants are clamped to stay fully on screen.
   */
  private positionLoupe(): void {
    if (!this.loupeEl) return;
    const size = 120;
    const margin = 8;
    const fingerGap = 110;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = 0;
    let top = 0;
    switch (this.settings.loupePlacement) {
      case "top-left":
        left = margin;
        top = margin;
        break;
      case "top-right":
        left = vw - margin - size;
        top = margin;
        break;
      case "below":
        left = this.touchClientX - size / 2;
        top = this.touchClientY + fingerGap;
        // Flip up if there's no room below.
        if (top + size > vh - margin) top = this.touchClientY - fingerGap - size;
        break;
      case "above":
      default:
        left = this.touchClientX - size / 2;
        top = this.touchClientY - fingerGap - size;
        // Flip down if there's no room above.
        if (top < margin) top = this.touchClientY + fingerGap;
        break;
    }
    // Viewport clamp common to all placements.
    if (left < margin) left = margin;
    if (left + size > vw - margin) left = vw - margin - size;
    if (top < margin) top = margin;
    if (top + size > vh - margin) top = vh - margin - size;
    this.loupeEl.style.left = `${left}px`;
    this.loupeEl.style.top = `${top}px`;
  }

  /** Sample around the touch point on the main canvas into the 120×120 loupe
   *  canvas at the user's chosen zoom factor, with a crosshair overlay
   *  marking the exact aim point. */
  private drawLoupe(): void {
    if (!this.loupeEl || !this.canvas) return;
    this.positionLoupe();
    const lctx = this.loupeEl.getContext("2d");
    if (!lctx) return;
    // Source region size = loupe size / zoom. Smaller source = stronger zoom.
    const zoom = this.settings.loupeZoom;
    const sampleSize = Math.round(120 / zoom);
    const sx = Math.round(this.mouseX - sampleSize / 2);
    const sy = Math.round(this.mouseY - sampleSize / 2);
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = "#99ff99";
    lctx.fillRect(0, 0, 120, 120);
    lctx.drawImage(
      this.canvas,
      sx, sy, sampleSize, sampleSize,
      0, 0, 120, 120,
    );
    // Crosshair at the loupe centre - marks the exact aim point under the
    // finger. Two short red strokes with a 6 px gap so the actual pixel of
    // interest stays visible.
    lctx.strokeStyle = "rgba(255, 30, 30, 0.95)";
    lctx.lineWidth = 2;
    lctx.beginPath();
    lctx.moveTo(60, 44); lctx.lineTo(60, 56);
    lctx.moveTo(60, 64); lctx.lineTo(60, 76);
    lctx.moveTo(44, 60); lctx.lineTo(56, 60);
    lctx.moveTo(64, 60); lctx.lineTo(76, 60);
    lctx.stroke();
  }

  // ----- shoot-mode cycle (mobile parity for desktop right-click) ------

  /**
   * Cycle shootingMode through 0..3 (normal → reverse → 90° CW → 90° CCW)
   * and force the next peer-cursor packet through the throttle so watchers
   * see the new orientation immediately even if the cursor is stationary.
   * Called from the desktop right-click path AND the mobile in-canvas
   * shoot-mode button - both go through here so the button glyph and the
   * cursor broadcast stay in lockstep.
   */
  private cycleShootingMode(): void {
    this.shootingMode = (this.shootingMode + 1) % 4;
    this.lastCursorSentX = -9999;
    this.lastCursorSentY = -9999;
    this.refreshShootModeBtn();
  }

  /** Update the mobile shoot-mode button glyph + a11y label to match the
   *  current `shootingMode`. Cheap; safe to call on every cycle/reset. */
  private refreshShootModeBtn(): void {
    if (!this.shootModeBtnEl) return;
    // Glyph picks: a clear-direction-of-aim icon for each mode. The unicode
    // arrows render reliably at small size and don't need a sprite.
    const glyphs = ["→", "←", "↻", "↺"];
    const labels = [
      "Normal aim",
      "Reverse aim",
      "Rotate 90° clockwise",
      "Rotate 90° counter-clockwise",
    ];
    const i = this.shootingMode | 0;
    this.shootModeBtnEl.textContent = glyphs[i] ?? glyphs[0];
    this.shootModeBtnEl.setAttribute("aria-label", labels[i] ?? labels[0]);
    this.shootModeBtnEl.setAttribute("data-mode", String(i));
  }

  // ----- game-end overlay -----------------------------------------------

  private showEndOverlay(f: string[]): void {
    if (!this.root) return;
    if (this.dailyMode) {
      this.showDailyShareOverlay();
      return;
    }
    this.removeOverlay();
    const ov = document.createElement("div");
    ov.className = "game-end-overlay";

    const title = document.createElement("div");
    title.textContent = t("GameFin_W_GameOver", "Game over!");
    ov.appendChild(title);

    if (f.length > 2) {
      const lines = document.createElement("div");
      lines.style.fontSize = "14px";
      lines.style.fontWeight = "normal";
      lines.style.fontFamily = '"Dialog", Verdana, sans-serif';
      lines.style.textAlign = "center";
      for (let i = 0; i < this.numPlayers; i++) {
        const result = parseInt(f[2 + i] ?? "0", 10);
        const nick = this.players[i]?.nick ?? t("Port_Game_PlayerFmt", "Player %1", i + 1);
        const word =
          result === 1 ? t("GamePlayerInfo_Winner", "Winner!").replace(/!$/, "") :
          result === 0 ? t("GamePlayerInfo_Draw", "Draw") :
          "-";
        const row = document.createElement("div");
        row.textContent = `${nick}: ${word}`;
        lines.appendChild(row);
      }
      ov.appendChild(lines);
      // Mirror Java PlayerInfoPanel.java:457-461 - pick the local player's
      // outcome and play the matching applause/loss/draw clip once.
      const myResult = parseInt(f[2 + this.myPlayerId] ?? "0", 10);
      if (myResult === 1) audio.playGameWinner();
      else if (myResult === 0) audio.playGameDraw();
      else audio.playGameLoser();
    }

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "6px";
    btnRow.style.justifyContent = "center";

    // Play-again - only meaningful in multiplayer (Java's `buttonNewGame`
    // lives in GameControlPanel and is shown for state==2 game-over). In
    // single-player there's no peer to vote with us, so the server would
    // just immediately restart on a single click - surface it the same way.
    if (this.numPlayers > 1) {
      const playAgain = document.createElement("button");
      playAgain.type = "button";
      playAgain.className = "btn-green";
      playAgain.textContent = t("GameControl_New", "New Game");
      playAgain.addEventListener("click", () => this.requestNewGame());
      btnRow.appendChild(playAgain);
      this.playAgainButton = playAgain;
    }

    const back = document.createElement("button");
    back.type = "button";
    back.className = this.numPlayers > 1 ? "btn-yellow" : "btn-green";
    back.textContent = t("GameControl_Back", "« To menu");
    back.addEventListener("click", () => {
      this.app.connection.sendData("game", "back");
    });
    btnRow.appendChild(back);
    ov.appendChild(btnRow);

    this.root.appendChild(ov);
    this.overlay = ov;
  }

  /**
   * Daily-mode end screen. The local player has just finished the daily hole
   * (holed-in or forfeited); the room continues for others. Persist the
   * result to localStorage to gate tomorrow's button, render the score
   * relative to the track average, and offer a copy-to-clipboard share.
   */
  private showDailyShareOverlay(): void {
    if (!this.root) return;
    const me = this.players[this.myPlayerId];
    const dateKey = this.dailyDateKey ?? todayKey();
    const result: DailyResult = {
      date: dateKey,
      strokes: me?.strokesThisTrack ?? 0,
      average: this.trackAverage,
      forfeited: !!me?.forfeitedThisTrack && !me?.holedThisTrack,
      trackName: this.trackName,
    };
    if (!this.dailyResultRecorded) {
      saveDailyResult(result);
      this.dailyResultRecorded = true;
      // No Java parity (daily mode is port-original) but the audio mapping
      // mirrors the regular game-over: holed = winner clip, forfeit = loser.
      if (result.forfeited) audio.playGameLoser();
      else audio.playGameWinner();
    }

    this.removeOverlay();
    const ov = document.createElement("div");
    ov.className = "game-end-overlay";

    const title = document.createElement("div");
    title.textContent = t("Port_Daily_OverlayTitle", "Daily Cup - %1", dateKey);
    ov.appendChild(title);

    const lines = document.createElement("div");
    lines.style.fontSize = "14px";
    lines.style.fontWeight = "normal";
    lines.style.fontFamily = '"Dialog", Verdana, sans-serif';
    lines.style.textAlign = "center";
    lines.style.padding = "8px 0";

    const score = dailyScore(result.strokes, result.average, result.forfeited);
    const verdict = result.forfeited
      ? t("Port_Daily_VerdictForfeited", "Forfeited")
      : result.average > 0 && result.strokes < result.average
        ? t("Port_Daily_VerdictBelow", "Below average - nice!")
        : result.average > 0 && result.strokes === Math.round(result.average)
          ? t("Port_Daily_VerdictOn", "Right on average.")
          : result.average > 0
            ? t("Port_Daily_VerdictAbove", "Above average.")
            : t("Port_Daily_VerdictFirst", "First play!");

    const row1 = document.createElement("div");
    row1.textContent = result.forfeited
      ? t("Port_Daily_RowForfeited", "You forfeited \"%1\".", result.trackName)
      : t(
          result.strokes === 1 ? "Port_Daily_RowFinished1" : "Port_Daily_RowFinishedN",
          result.strokes === 1
            ? "You finished \"%1\" in %2 stroke."
            : "You finished \"%1\" in %2 strokes.",
          result.trackName,
          result.strokes,
        );
    lines.appendChild(row1);
    if (result.average > 0) {
      const row2 = document.createElement("div");
      row2.textContent = t("Port_Daily_RowAverage", "Track average: %1 strokes", result.average.toFixed(1));
      lines.appendChild(row2);
    }
    const row3 = document.createElement("div");
    row3.style.fontWeight = "bold";
    row3.style.marginTop = "4px";
    row3.textContent = t("Port_Daily_RowScore", "Score: %1  -  %2", score, verdict);
    lines.appendChild(row3);
    ov.appendChild(lines);

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "6px";
    btnRow.style.justifyContent = "center";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn-green";
    copyBtn.textContent = t("Port_Daily_CopyShareText", "Copy share text");
    copyBtn.addEventListener("click", () => {
      const text = shareText(result);
      void copyToClipboard(text).then((ok) => {
        copyBtn.textContent = ok
          ? t("Port_Daily_Copied", "Copied!")
          : t("Port_Daily_CopyFailed", "Copy failed - select & copy manually");
        if (!ok) {
          // Fallback: drop the text into a visible textarea so the user can
          // hand-copy when the Clipboard API is gated (older browsers / iframes).
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.rows = 3;
          ta.style.width = "320px";
          ta.style.fontFamily = '"Lucida Console", monospace';
          ta.style.fontSize = "11px";
          ta.style.marginTop = "6px";
          ov.appendChild(ta);
          ta.select();
        }
        window.setTimeout(() => {
          copyBtn.textContent = t("Port_Daily_CopyShareText", "Copy share text");
        }, 2000);
      });
    });
    btnRow.appendChild(copyBtn);

    // "Copy replay link" - only present when we have both the track tile data
    // (T-line) and at least one recorded stroke. Forfeit-without-shooting runs
    // give an empty replay, which we hide rather than offering a no-op link.
    if (this.dailyTLine && this.dailyReplayStrokes.length > 0) {
      const replay: DailyReplay = {
        v: 1,
        d: dateKey,
        n: this.trackName,
        a: this.trackAuthor,
        avg: this.trackAverage > 0 ? this.trackAverage : undefined,
        t: this.dailyTLine,
        s: this.dailyReplayStrokes,
        holed: !!me?.holedThisTrack,
      };
      const linkBtn = document.createElement("button");
      linkBtn.type = "button";
      linkBtn.className = "btn-blue";
      linkBtn.disabled = true;
      linkBtn.textContent = t("Port_Daily_SavingReplay", "Saving replay…");

      // Auto-upload as soon as the overlay opens. The previous behaviour was
      // to defer the POST until the user clicked, which meant a fresh upload
      // (and possible failure) on every share. Doing it eagerly:
      //   - Makes the "Copy replay link" click instant once it lands.
      //   - Surfaces upload failures immediately so the user sees the
      //     fallback fragment-embedded link without waiting.
      // Falls back to `replayLink(replay)` (long URL with the run packed into
      // the URL fragment) on network/server failure so the user always gets
      // *something* shareable.
      let cachedUrl: string | null = null;
      void (async () => {
        let url: string;
        try {
          url = await shortReplayLink(replay);
        } catch {
          url = replayLink(replay);
        }
        cachedUrl = url;
        linkBtn.disabled = false;
        linkBtn.textContent = t("Port_Daily_CopyReplayLink", "Copy replay link");
      })();

      linkBtn.addEventListener("click", () => {
        if (!cachedUrl) return;
        const url = cachedUrl;
        void (async () => {
          const ok = await copyToClipboard(url);
          linkBtn.textContent = ok
            ? t("Port_Daily_LinkCopied", "Link copied!")
            : t("Port_Daily_CopyFailedShort", "Copy failed");
          if (!ok) {
            const ta = document.createElement("textarea");
            ta.value = url;
            ta.rows = 3;
            ta.style.width = "320px";
            ta.style.fontFamily = '"Lucida Console", monospace';
            ta.style.fontSize = "11px";
            ta.style.marginTop = "6px";
            ov.appendChild(ta);
            ta.select();
          }
          window.setTimeout(() => {
            linkBtn.textContent = t("Port_Daily_CopyReplayLink", "Copy replay link");
          }, 2000);
        })();
      });
      btnRow.appendChild(linkBtn);
    }

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "btn-blue";
    backBtn.textContent = t("GameControl_Back", "« To menu");
    backBtn.addEventListener("click", () => {
      this.app.connection.sendData("game", "back");
    });
    btnRow.appendChild(backBtn);

    ov.appendChild(btnRow);

    // Hint that other players keep playing even after you exit.
    const hint = document.createElement("div");
    hint.textContent = t("Port_Daily_HintOthersStillPlaying", "Other players are still on the same track.");
    hint.style.fontSize = "11px";
    hint.style.color = "#666";
    hint.style.marginTop = "4px";
    hint.style.fontFamily = '"Dialog", Verdana, sans-serif';
    hint.style.fontWeight = "normal";
    ov.appendChild(hint);

    this.root.appendChild(ov);
    this.overlay = ov;
  }

  private removeOverlay(): void {
    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.overlay = null;
    // The play-again button is a child of `overlay`; the GC takes it with
    // the overlay, but null the ref so a stale `disabled = true` write from
    // a late `requestNewGame` can't blow up.
    this.playAgainButton = null;
  }

  private quit(): void {
    this.app.connection.sendData("game", "back");
  }

  /** Toggle the in-game settings menu. Closes if already open. */
  private toggleSettingsMenu(): void {
    if (this.settingsMenuEl) {
      this.closeSettingsMenu();
    } else {
      this.openSettingsMenu();
    }
  }

  private closeSettingsMenu(): void {
    if (this.settingsMenuEl) {
      this.settingsMenuEl.remove();
      this.settingsMenuEl = null;
    }
    if (this.menuOutsideClickHandler) {
      document.removeEventListener("click", this.menuOutsideClickHandler, true);
      this.menuOutsideClickHandler = null;
    }
    if (this.menuButtonEl) {
      this.menuButtonEl.classList.remove("is-active");
      this.menuButtonEl.setAttribute("aria-pressed", "false");
    }
  }

  private openSettingsMenu(): void {
    const anchor = this.menuButtonEl;
    if (!anchor) return;
    const parent = anchor.parentElement;
    if (!parent) return;

    const menu = document.createElement("div");
    menu.className = "game-settings-menu";
    // Anchor above the button: parent is `position: relative`, so absolute
    // bottom positioning floats the popover up from the bottom strip.
    menu.style.position = "absolute";
    menu.style.right = "0";
    menu.style.bottom = `${anchor.offsetHeight + 4}px`;
    menu.style.minWidth = "210px";
    menu.style.padding = "6px 8px";
    menu.style.background = "#fff";
    menu.style.border = "1px solid #555";
    menu.style.borderRadius = "3px";
    menu.style.boxShadow = "0 2px 6px rgba(0,0,0,0.25)";
    menu.style.fontSize = "11px";
    menu.style.fontFamily = '"Dialog", Verdana, sans-serif';
    menu.style.color = "#000";
    menu.style.zIndex = "20";
    // Block clicks inside the menu from bubbling to the outside-click handler.
    menu.addEventListener("click", (ev) => ev.stopPropagation());

    const addCheckbox = (
      label: string,
      checked: boolean,
      onChange: (next: boolean) => void,
    ): void => {
      const row = document.createElement("label");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "6px";
      row.style.padding = "2px 0";
      row.style.cursor = "pointer";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = checked;
      cb.style.margin = "0";
      cb.addEventListener("change", () => onChange(cb.checked));
      const text = document.createElement("span");
      text.textContent = label;
      row.appendChild(cb);
      row.appendChild(text);
      menu.appendChild(row);
    };

    addCheckbox(
      t("Port_Game_Menu_ShowNames", "Show player names"),
      this.settings.showNames,
      (v) => {
        this.settings.showNames = v;
        saveSettings(this.settings);
      },
    );
    addCheckbox(
      t("Port_Game_Menu_SendCursor", "Share my aim with others"),
      this.settings.sendCursor,
      (v) => {
        this.settings.sendCursor = v;
        saveSettings(this.settings);
      },
    );
    addCheckbox(
      t("Port_Game_Menu_ShowPeerCursors", "Show others' aim lines"),
      this.settings.showPeerCursors,
      (v) => {
        this.settings.showPeerCursors = v;
        saveSettings(this.settings);
      },
    );

    // Mobile-only loupe controls. Hidden on desktop where there's no
    // magnifier in play; appended in a divider'd block so the rest of the
    // menu still reads as the existing AWT-style settings list.
    if (this.isTouchPrimary) {
      const sep = document.createElement("div");
      sep.style.borderTop = "1px solid #ddd";
      sep.style.margin = "4px 0 2px";
      menu.appendChild(sep);

      const heading = document.createElement("div");
      heading.textContent = t("Port_Game_Menu_MobileSection", "Mobile controls");
      heading.style.fontWeight = "bold";
      heading.style.padding = "2px 0";
      menu.appendChild(heading);

      // Loupe placement - radio-style segmented row. Picking a value
      // immediately persists; the next touch-drag uses the new placement.
      const placeRow = document.createElement("div");
      placeRow.style.display = "flex";
      placeRow.style.alignItems = "center";
      placeRow.style.gap = "6px";
      placeRow.style.padding = "2px 0";
      const placeLabel = document.createElement("span");
      placeLabel.textContent = t("Port_Game_Menu_LoupePlacement", "Loupe");
      placeLabel.style.minWidth = "48px";
      placeRow.appendChild(placeLabel);
      const placeSelect = document.createElement("select");
      const placeOpts: Array<[LoupePlacement, string]> = [
        ["above", t("Port_Game_Menu_LoupeAbove", "Above finger")],
        ["below", t("Port_Game_Menu_LoupeBelow", "Below finger")],
        ["top-left", t("Port_Game_Menu_LoupeTopLeft", "Top-left corner")],
        ["top-right", t("Port_Game_Menu_LoupeTopRight", "Top-right corner")],
      ];
      for (const [value, label] of placeOpts) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        if (this.settings.loupePlacement === value) opt.selected = true;
        placeSelect.appendChild(opt);
      }
      placeSelect.style.flex = "1";
      placeSelect.addEventListener("change", () => {
        const v = placeSelect.value as LoupePlacement;
        if (LOUPE_PLACEMENTS.includes(v)) {
          this.settings.loupePlacement = v;
          saveSettings(this.settings);
        }
      });
      placeRow.appendChild(placeSelect);
      menu.appendChild(placeRow);

      // Loupe zoom - range slider. Steps of 0.25 cover 1.5×-3× cleanly.
      const zoomRow = document.createElement("div");
      zoomRow.style.display = "flex";
      zoomRow.style.alignItems = "center";
      zoomRow.style.gap = "6px";
      zoomRow.style.padding = "2px 0";
      const zoomLabel = document.createElement("span");
      zoomLabel.textContent = t("Port_Game_Menu_LoupeZoom", "Zoom");
      zoomLabel.style.minWidth = "48px";
      zoomRow.appendChild(zoomLabel);
      const zoomSlider = document.createElement("input");
      zoomSlider.type = "range";
      zoomSlider.className = "win98-slider";
      zoomSlider.min = "1.2";
      zoomSlider.max = "4";
      zoomSlider.step = "0.1";
      zoomSlider.value = String(this.settings.loupeZoom);
      zoomSlider.style.flex = "1";
      const zoomValue = document.createElement("span");
      zoomValue.style.minWidth = "30px";
      zoomValue.style.textAlign = "right";
      zoomValue.textContent = `${this.settings.loupeZoom.toFixed(1)}×`;
      zoomSlider.addEventListener("input", () => {
        const v = zoomSlider.valueAsNumber;
        this.settings.loupeZoom = v;
        zoomValue.textContent = `${v.toFixed(1)}×`;
        saveSettings(this.settings);
      });
      zoomRow.appendChild(zoomSlider);
      zoomRow.appendChild(zoomValue);
      menu.appendChild(zoomRow);
    }

    // Volume slider - moved here from the bottom strip.
    const volRow = document.createElement("div");
    volRow.style.display = "flex";
    volRow.style.alignItems = "center";
    volRow.style.gap = "6px";
    volRow.style.padding = "4px 0 2px";
    volRow.style.borderTop = "1px solid #ddd";
    volRow.style.marginTop = "4px";
    const volLabel = document.createElement("span");
    volLabel.textContent = t("Port_Game_Volume", "Volume");
    const volSlider = document.createElement("input");
    volSlider.type = "range";
    volSlider.className = "win98-slider";
    volSlider.min = "0";
    volSlider.max = "100";
    volSlider.step = "1";
    volSlider.value = String(Math.round(audio.volume * 100));
    volSlider.style.flex = "1";
    volSlider.title = t("Port_Game_VolumeTitle", "Master volume");
    volSlider.addEventListener("input", () => {
      audio.setVolume(volSlider.valueAsNumber / 100);
    });
    volRow.appendChild(volLabel);
    volRow.appendChild(volSlider);
    menu.appendChild(volRow);

    // Quit button - pull-up of the bottom-strip ESC behaviour.
    const quitBtn = document.createElement("button");
    quitBtn.type = "button";
    quitBtn.className = "btn-red";
    quitBtn.textContent = t("Tournament_QuitGameButton", "Quit game");
    quitBtn.style.marginTop = "6px";
    quitBtn.style.width = "100%";
    quitBtn.style.padding = "2px 8px";
    quitBtn.style.minHeight = "auto";
    quitBtn.style.fontSize = "11px";
    quitBtn.addEventListener("click", () => {
      this.closeSettingsMenu();
      this.quit();
    });
    menu.appendChild(quitBtn);

    parent.appendChild(menu);
    this.settingsMenuEl = menu;
    anchor.classList.add("is-active");
    anchor.setAttribute("aria-pressed", "true");

    // Close on click anywhere outside the popover. Capture phase so we see
    // it before any panel handler can swallow the event.
    const onOutside = (ev: MouseEvent): void => {
      const target = ev.target as Node | null;
      if (!target) return;
      if (menu.contains(target)) return;
      if (anchor.contains(target)) return;
      this.closeSettingsMenu();
    };
    this.menuOutsideClickHandler = onOutside;
    // Defer registration so the click that opened the menu doesn't immediately
    // close it.
    setTimeout(() => {
      if (this.menuOutsideClickHandler === onOutside) {
        document.addEventListener("click", onOutside, true);
      }
    }, 0);
  }

  /** Give up on the current hole - server caps strokes & marks DNF. */
  private forfeitHole(): void {
    const me = this.players[this.myPlayerId];
    if (!me) return;
    if (me.holedThisTrack || me.forfeitedThisTrack) return;
    if (!window.confirm(t("Port_Game_ForfeitConfirm", "Forfeit this hole? You'll be capped at the stroke limit."))) return;
    this.app.connection.sendData("game", "forfeit");
  }

  /**
   * Vote-skip click. Server uses writeExcluding so the local player never
   * sees their own broadcast - we have to mark our own slot here. Hides the
   * button so the user can't double-vote; re-shown on `resetvoteskip` (fired
   * by the server on every starttrack).
   */
  private voteSkip(): void {
    const me = this.players[this.myPlayerId];
    if (!me) return;
    if (me.votedToSkip) return;
    me.votedToSkip = true;
    this.app.connection.sendData("game", "voteskip");
    this.updateSkipButtonVisibility();
    this.scoreboardDirty = true;
  }

  /**
   * Play-again click on the end overlay. Server uses writeExcluding for the
   * `rfng` broadcast; mark our own slot, disable the button so we can't
   * spam-vote, and tell peers via `game newgame`.
   */
  private requestNewGame(): void {
    const me = this.players[this.myPlayerId];
    if (!me) return;
    if (me.wantsNewGame) return;
    me.wantsNewGame = true;
    this.app.connection.sendData("game", "newgame");
    if (this.playAgainButton) {
      this.playAgainButton.disabled = true;
      this.playAgainButton.textContent = t("Port_Game_WaitingForPeers", "Waiting for others…");
    }
    this.scoreboardDirty = true;
  }

  /**
   * Show/hide the in-game skip button. Java's GameControlPanel only shows
   * the skip button in multiplayer rooms (single-player has its own lobby
   * skip flow); we extend that to also hide it in daily mode (the singleton
   * room has no concept of voting to skip a deterministic daily track).
   * Local-player vote also hides until the server's `resetvoteskip` clears.
   *
   * In multiplayer the button uses `visibility: hidden` rather than
   * `display: none` once we've voted, so the actions column doesn't collapse
   * and the Menu button doesn't jump positions. Single-player and daily mode
   * collapse the space entirely (no skip is ever shown there).
   *
   * Skip is also suppressed while the room is still waiting for fillers
   * (`!gameStartedReceived`): the Practice button takes that slot. Once
   * either practice or the real game starts, Skip takes over.
   */
  private updateSkipButtonVisibility(): void {
    const btn = this.skipButton;
    const practiceBtn = this.practiceButton;
    const me = this.players[this.myPlayerId];
    // Use `roomCapacity` (configured) rather than `numPlayers` (which a
    // practice starttrack can transiently shrink to 1 in a 1/4 room) so
    // the multiplayer-only buttons stay shown for the whole room lifetime.
    const isMulti = this.roomCapacity > 1 && !this.dailyMode;

    if (practiceBtn) {
      const showPractice = isMulti && !this.gameStartedReceived;
      practiceBtn.style.display = showPractice ? "" : "none";
    }

    if (!btn) return;
    if (!isMulti || !this.gameStartedReceived) {
      btn.style.display = "none";
      btn.style.visibility = "";
      return;
    }
    btn.style.display = "";
    btn.style.visibility = me && !me.votedToSkip ? "visible" : "hidden";
  }

  /** "Harjoittele" click - kick off (or no-op join) shared practice. The
   *  server filters out repeat presses while practice is already running
   *  and after the real game has started. */
  private startPractice(): void {
    if (this.gameStartedReceived) return;
    this.app.connection.sendData("game", "practice");
  }

  private applyChatVisibility(): void {
    // The `.is-multi` class on the panel root drives the entire bottom-band
    // layout switch (chat visible on left, stroke/status/forfeit hidden,
    // `.right` becomes a horizontal row). See style.css for the rules.
    if (this.panelEl) this.panelEl.classList.toggle("is-multi", this.numPlayers > 1);
  }

  private ensurePlayerSlots(n: number): void {
    while (this.players.length < n) {
      this.players.push({
        nick: "",
        clan: "",
        strokesThisTrack: 0,
        ball: newBall(this.startX, this.startY),
        ctx: null,
        active: true,
        simulating: false,
        holedThisTrack: false,
        forfeitedThisTrack: false,
        votedToSkip: false,
        wantsNewGame: false,
        partReason: 0,
        startX: this.startX,
        startY: this.startY,
        holeScores: [],
        cursorX: null,
        cursorY: null,
        cursorMode: 0,
      });
    }
  }
}
