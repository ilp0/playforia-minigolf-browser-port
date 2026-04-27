// Track renderer. Builds a 735*375 background image once from the parsed track,
// then per-frame draws the ball and (optionally) an aim line on top.
//
// Background compositing follows SpriteManager.combineElementAndElement and
// combineElementAndSpecial: for each tile pixel we pick either the element-bg
// pixel or the element-fg / special pixel based on the shape mask. This
// faithfully reproduces the original visuals (slope arrows on hills, mine
// markings, magnet patterns, hole shading, etc.).

import {
  TILE_WIDTH,
  TILE_HEIGHT,
  PIXEL_PER_TILE,
  MAP_PIXEL_WIDTH,
  MAP_PIXEL_HEIGHT,
  NO_SETTINGS_FLAGS,
  applySettingsToTileCode,
  type SettingsFlags,
  unpackTile,
} from "@minigolf/shared";
import type { ParsedMap } from "./map.ts";
import { type Atlases, spriteSrc13 } from "./sprites.ts";

export interface AimLine {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /**
   * Right-click shooting mode (0..3). Mirrors original GameCanvas.shootingMode:
   *   0 = normal — render solid line ball→cursor as before.
   *   1 = reverse, 2 = 90° clockwise, 3 = 90° counter-clockwise.
   * For 1..3 we render a Java-faithful preview: a dashed line in the cursor
   * direction and a solid line in the rotated trajectory direction, both
   * scaled to the same `power*200/6.5` length the original used.
   */
  mode?: number;
}

/**
 * Peer's live aim preview. Drawn thinner and tinted by ball colour so the
 * local aim line stays the most prominent visual element. Sent via the
 * `game cursor` packet at ~15 Hz while the peer's ball is at rest.
 */
export interface PeerAim {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Player index 0..3 — used to pick a ball-colour-matched stroke. */
  playerIdx: number;
  /** Same right-click shooting mode as the peer is in (see AimLine.mode). */
  mode?: number;
}

/** Ball-colour-matched stroke style for peer aim previews. Indexed by playerIdx. */
const PEER_AIM_COLOURS = [
  "rgba(255, 255, 255, 0.7)", // 0 — white ball
  "rgba(220, 80, 80, 0.7)",   // 1 — red ball
  "rgba(80, 130, 255, 0.7)",  // 2 — blue ball
  "rgba(240, 210, 80, 0.8)",  // 3 — yellow ball
];

/**
 * Solid hex colour matched to the ball palette, used by the scoreboard nick
 * span so each player's name visibly matches their ball+cursor on the canvas.
 * Slot 0's "white" maps to a mid grey for readability against the panel
 * background — pure white text would be invisible. Indexed by `playerIdx % 4`.
 */
const SLOT_NICK_COLOURS = [
  "#5a5a5a", // 0 — neutral grey (white ball reads as a colourless circle)
  "#b32020", // 1 — red
  "#2050cc", // 2 — blue
  "#a07000", // 3 — gold (yellow tones don't read well on the off-white scoreboard)
];

/** Public lookup for the scoreboard / chat / overlays. Cycles past slot 3 like
 *  the ball atlas does, so daily-room high sparse ids still resolve. */
export function slotNickColor(playerIdx: number): string {
  const i = ((playerIdx % SLOT_NICK_COLOURS.length) + SLOT_NICK_COLOURS.length) % SLOT_NICK_COLOURS.length;
  return SLOT_NICK_COLOURS[i];
}

/**
 * Power-scaled delta from ball to a point at length `power*200/6.5`. Mirrors
 * Java GameCanvas.update():
 *   x2 = ball + power[0] * 200 / 6.5
 * where power = (mouse-ball) * (mag/dist), mag = clamp((dist-5)/30, 0.075, 6.5).
 * Returns null when the cursor is on top of the ball (no direction).
 */
function scaledPowerDelta(
  ballX: number,
  ballY: number,
  mouseX: number,
  mouseY: number,
): { dx: number; dy: number } | null {
  const dx = ballX - mouseX;
  const dy = ballY - mouseY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-9) return null;
  let mag = (dist - 5) / 30;
  if (mag < 0.075) mag = 0.075;
  if (mag > 6.5) mag = 6.5;
  const k = (mag / dist) * (200 / 6.5);
  return { dx: (mouseX - ballX) * k, dy: (mouseY - ballY) * k };
}

/** Rotate (dx,dy) for the right-click shooting mode. Matches Java GameCanvas
 *  branch in update() (and in doStroke()): mode 1 negates, 2 = (dy,-dx),
 *  3 = (-dy,dx). */
function rotateForMode(dx: number, dy: number, mode: number): { dx: number; dy: number } {
  if (mode === 1) return { dx: -dx, dy: -dy };
  if (mode === 2) return { dx: dy, dy: -dx };
  if (mode === 3) return { dx: -dy, dy: dx };
  return { dx, dy };
}

export interface BallSprite {
  x: number;
  y: number;
  /** Player index 0..3 → ball colour (white / red / blue / yellow). */
  playerIdx: number;
  /** True if the ball is currently moving (used to pick the second sprite). */
  moving: boolean;
  /** Hide the ball entirely (e.g. holed-in). */
  hidden: boolean;
  /**
   * Daily-mode "ghost" — render the ball at half opacity with a name label
   * floating above. Used to distinguish other players' concurrent balls from
   * the local player's own ball in the daily room.
   */
  ghost?: boolean;
  /** Optional label drawn above the ball (only shown when `ghost`). */
  label?: string;
  /**
   * Multiplayer name display for non-ghost balls. Mode mirrors Java
   * GameCanvas.playerNamesDisplayMode (drawPlayer at 1737 on the Java side):
   *   1 = single-letter initial centered above the ball, no outline
   *   2 = full name beside the ball, outlined, edge-aware horizontal alignment
   *   3 = name + "[clan]" stacked beside the ball; falls back to mode-2 layout
   *       when clan is empty
   * Java draws self in white and others in black, both with a green
   * (rgb(19,167,19) — the panel background) 1px orthogonal outline; the port
   * matches that exactly so labels look identical to the original.
   */
  nameDisplay?: {
    mode: 1 | 2 | 3;
    name: string;
    clan?: string;
    /** True if this is the local player's ball — flips the fill colour from
     *  black (other players, Java GameCanvas:116) to white (self, GameCanvas:125). */
    isSelf: boolean;
  };
  /**
   * Death/sink animation. Mirrors Java GameCanvas.drawPlayer's `shrinkAmount`
   * (the live `onHoleTimer` while ball is on hole/water/acid/swamp). Position
   * shifts by `shrink` and the rendered size reduces by `shrink * 2`. 0 means
   * draw at full size. Reaches ~6.0 just before water/acid respawn and
   * ~2.166 just before a hole-sink completes.
   */
  shrink?: number;
}

export class TrackRenderer {
  private bgCanvas: HTMLCanvasElement;
  private parsedMap: ParsedMap;
  private atlases: Atlases;
  /**
   * Track 'S'-line flags (see `parseSettingsFlags` in @minigolf/shared).
   *   [0] mines visible / hidden as plain bg
   *   [1] magnets visible / hidden as plain bg
   *   [2] teleports coloured / reduced to colourless blue start+exit
   *   [3] illusion-wall (collision id 19) casts shadow / not
   * Java applies these only at draw time (via `Tile.getSpecialsettingCode` and
   * `Map.castShadow`); collision/physics keeps the original tile semantics so
   * "hidden" mines/magnets/teleports still trigger normally — that's the whole
   * point of the flags as a puzzle-design knob.
   */
  private settingsFlags: SettingsFlags;
  constructor(parsedMap: ParsedMap, atlases: Atlases, settingsFlags: SettingsFlags = NO_SETTINGS_FLAGS) {
    this.parsedMap = parsedMap;
    this.atlases = atlases;
    this.settingsFlags = settingsFlags;
    this.bgCanvas = document.createElement("canvas");
    this.bgCanvas.width = MAP_PIXEL_WIDTH;
    this.bgCanvas.height = MAP_PIXEL_HEIGHT;
    this.buildBackground();
  }

  /**
   * Replace the active settings flags and rebuild the cached background. Used
   * if the S line ever arrives after `TrackRenderer` was constructed (the
   * panel currently passes flags up-front, but this keeps the door open).
   */
  setSettingsFlags(flags: SettingsFlags): void {
    this.settingsFlags = flags;
    this.buildBackground();
  }

  /**
   * For one tile pixel: pick the source sprite's RGB based on the shape mask.
   *   special=1, mask=1 → elements[bgIdx]
   *   special=1, mask=2 → elements[fgIdx]
   *   special=2, mask=1 → elements[bgIdx]
   *   special=2, mask=2 → specials[shape]
   * Where bgIdx = unpackTile.fore (Java's `background` field) and
   *       fgIdx = unpackTile.back (Java's `foreground` field).
   */
  private writeTile(
    img: ImageData,
    tx: number,
    ty: number,
    code: number,
  ): void {
    // Visibility / colour-key remap per the track's S-line flags. Done here
    // (visual layer) only — collision/physics keeps the unmodified code so
    // hidden mines still detonate, hidden magnets still pull, etc.
    code = applySettingsToTileCode(code, this.settingsFlags);
    const u = unpackTile(code);
    const special = u.isNoSpecial;
    if (special === 0) {
      // Empty tile — fill with white-ish per Java default 0xFFFFFF.
      const x0 = tx * PIXEL_PER_TILE;
      const y0 = ty * PIXEL_PER_TILE;
      for (let py = 0; py < PIXEL_PER_TILE; py++) {
        for (let px = 0; px < PIXEL_PER_TILE; px++) {
          const o = ((y0 + py) * MAP_PIXEL_WIDTH + (x0 + px)) * 4;
          img.data[o] = 255;
          img.data[o + 1] = 255;
          img.data[o + 2] = 255;
          img.data[o + 3] = 255;
        }
      }
      return;
    }
    const shape = u.shape;
    const bgIdx = u.fore; // Java's `background` element index
    const fgIdx = u.back; // Java's `foreground` element index
    const mask =
      special === 1 ? this.atlases.shapeMasks[shape] : this.atlases.specialMasks[shape];
    if (!mask) return;

    const bgPixels = this.atlases.elementPixels[bgIdx];
    const fgPixels =
      special === 1
        ? this.atlases.elementPixels[fgIdx]
        : this.atlases.specialPixels[shape];
    if (!bgPixels || !fgPixels) return;

    const x0 = tx * PIXEL_PER_TILE;
    const y0 = ty * PIXEL_PER_TILE;
    for (let py = 0; py < PIXEL_PER_TILE; py++) {
      for (let px = 0; px < PIXEL_PER_TILE; px++) {
        const m = mask[py * PIXEL_PER_TILE + px];
        const src = m === 1 ? bgPixels : fgPixels;
        const si = (py * PIXEL_PER_TILE + px) * 4;
        const oi = ((y0 + py) * MAP_PIXEL_WIDTH + (x0 + px)) * 4;
        img.data[oi] = src[si];
        img.data[oi + 1] = src[si + 1];
        img.data[oi + 2] = src[si + 2];
        img.data[oi + 3] = 255;
      }
    }
  }

  /**
   * Rebuild the cached background canvas from the current `parsedMap.tiles[][]`
   * and `parsedMap.collision`. Call after one or more `mutateTile` invocations
   * (movable blocks, breakable bricks) — the shading pass casts shadows across
   * tile boundaries, so per-tile reblits aren't enough; we need to re-run
   * `applyShading` against the full collision state. Drained from
   * `parsedMap.dirtyTiles` once per frame in the panel tick.
   */
  rebuildBackground(): void {
    this.buildBackground();
  }

  private buildBackground(): void {
    const ctx = this.bgCanvas.getContext("2d");
    if (!ctx) return;
    // Default fill — outside the playable area gets a dark border colour.
    const img = ctx.createImageData(MAP_PIXEL_WIDTH, MAP_PIXEL_HEIGHT);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 30;
      data[i + 1] = 50;
      data[i + 2] = 30;
      data[i + 3] = 255;
    }
    for (let ty = 0; ty < TILE_HEIGHT; ty++) {
      for (let tx = 0; tx < TILE_WIDTH; tx++) {
        const code = this.parsedMap.tiles[tx][ty];
        this.writeTile(img, tx, ty, code);
      }
    }
    this.applyShading(img);
    ctx.putImageData(img, 0, 0);
  }

  /**
   * Per-pixel edge-lighting + drop-shadow + grain pass, ported from Java
   * GameBackgroundCanvas.drawMap (graphicsQualityIndex >= 2 branch).
   *
   * Light source is the top-left of the playfield. For each "solid" pixel
   * (collision 16..23, illusion-wall id 19 excluded by default) we look at the
   * up-left and down-right neighbours:
   *   - inner-corner solid (only down-right neighbour is solid): big +128 boost
   *     on top of the corner pixel — that's what gives walls the chiselled bevel.
   *   - top/left edge: +24 (bright)
   *   - bottom/right edge: −24 (dark)
   * Then for each solid pixel we cast a 7-pixel down-right drop shadow (−8 per
   * pixel) onto the non-solid neighbours, faked ambient occlusion.
   * Teleport-start markers (col 32/34/36/38) get the same brightness pass at a
   * lighter weight (±16 instead of ±24/±128).
   * Finally, a ±5 random grain across every pixel for the painterly texture.
   */
  private applyShading(img: ImageData): void {
    const W = MAP_PIXEL_WIDTH;
    const H = MAP_PIXEL_HEIGHT;
    const data = img.data;
    const collision = this.parsedMap.collision;

    // Java `Map.castShadow`: solid pixels are collision id 16..23, with id 19
    // (illusion wall) gated by `specialSettings[3]` — when the flag is on,
    // illusion walls cast shadows like normal walls; when off, they don't.
    const illusionShadow = this.settingsFlags[3];
    const isSolid = (x: number, y: number): boolean => {
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      const c = collision[y * W + x];
      if (c < 16 || c > 23) return false;
      return c !== 19 || illusionShadow;
    };
    const isTeleStart = (x: number, y: number): boolean => {
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      const c = collision[y * W + x];
      return c === 32 || c === 34 || c === 36 || c === 38;
    };
    const shift = (x: number, y: number, off: number): void => {
      const o = (y * W + x) * 4;
      const r = data[o] + off;
      const g = data[o + 1] + off;
      const b = data[o + 2] + off;
      data[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      data[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    };

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isSolid(x, y)) {
          const ul = isSolid(x - 1, y - 1);
          const dr = isSolid(x + 1, y + 1);
          if (!ul && dr && !isSolid(x, y - 1) && !isSolid(x - 1, y)) {
            // Inner corner: this pixel is the top-left tip of a solid block.
            shift(x, y, 128);
          } else {
            if (!ul && dr) shift(x, y, 24);
            if (!dr && ul) shift(x, y, -24);
          }
          // Drop-shadow trail (quality≥2 in Java). Up to 7 px down-right onto
          // non-solid neighbours.
          for (let i = 1; i <= 7 && x + i < W && y + i < H; i++) {
            if (!isSolid(x + i, y + i)) shift(x + i, y + i, -8);
          }
        }
        if (isTeleStart(x, y)) {
          const ul = isTeleStart(x - 1, y - 1);
          const dr = isTeleStart(x + 1, y + 1);
          if (!ul && dr && !isTeleStart(x, y - 1) && !isTeleStart(x - 1, y)) {
            shift(x, y, 16);
          } else {
            if (!ul && dr) shift(x, y, 16);
            if (!dr && ul) shift(x, y, -16);
          }
        }
        // Grain — Math.floor(Math.random()*11) − 5 ∈ [-5, 5].
        shift(x, y, ((Math.random() * 11) | 0) - 5);
      }
    }
  }

  /**
   * Per-frame draw. Note: `balls` is sorted in-place to avoid a spread/sort
   * allocation every frame; callers reuse a scratch array (see GamePanel.draw)
   * and don't depend on insertion order being preserved.
   */
  drawFrame(
    ctx: CanvasRenderingContext2D,
    balls: BallSprite[],
    aim: AimLine | null,
    peerAims: PeerAim[] = [],
  ): void {
    ctx.drawImage(this.bgCanvas, 0, 0);

    // Peer aims first so the local aim renders on top of any overlap.
    for (const pa of peerAims) {
      const colour = PEER_AIM_COLOURS[pa.playerIdx % PEER_AIM_COLOURS.length];
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      const mode = pa.mode ?? 0;
      if (mode === 0) {
        // Cursor stream coords aren't power-scaled — peer sees a dashed line
        // straight to the cursor (matches mode-0 self preview which goes
        // ball→cursor without scaling either).
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(pa.fromX, pa.fromY);
        ctx.lineTo(pa.toX, pa.toY);
        ctx.stroke();
      } else {
        // Java preview for modes 1..3: dashed cursor-direction line +
        // solid rotated-trajectory line, both at power-scaled length.
        const dEl = scaledPowerDelta(pa.fromX, pa.fromY, pa.toX, pa.toY);
        if (dEl) {
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(pa.fromX, pa.fromY);
          ctx.lineTo(pa.fromX + dEl.dx, pa.fromY + dEl.dy);
          ctx.stroke();
          const r = rotateForMode(dEl.dx, dEl.dy, mode);
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(pa.fromX, pa.fromY);
          ctx.lineTo(pa.fromX + r.dx, pa.fromY + r.dy);
          ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);

    if (aim) {
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.lineWidth = 1;
      const mode = aim.mode ?? 0;
      if (mode === 0) {
        ctx.beginPath();
        ctx.moveTo(aim.fromX, aim.fromY);
        ctx.lineTo(aim.toX, aim.toY);
        ctx.stroke();
      } else {
        // Mode 1..3: dashed line in cursor direction + solid in rotated
        // trajectory direction, both scaled to Java's power*200/6.5 length.
        const dEl = scaledPowerDelta(aim.fromX, aim.fromY, aim.toX, aim.toY);
        if (dEl) {
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(aim.fromX, aim.fromY);
          ctx.lineTo(aim.fromX + dEl.dx, aim.fromY + dEl.dy);
          ctx.stroke();
          const r = rotateForMode(dEl.dx, dEl.dy, mode);
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(aim.fromX, aim.fromY);
          ctx.lineTo(aim.fromX + r.dx, aim.fromY + r.dy);
          ctx.stroke();
        }
      }
    }
    ctx.setLineDash([]);

    // Sort: ghosts first (drawn beneath), self last so it's always visible.
    balls.sort((a, b) => {
      const ga = a.ghost ? 0 : 1;
      const gb = b.ghost ? 0 : 1;
      if (ga !== gb) return ga - gb;
      return Number(a.moving) - Number(b.moving);
    });
    for (const b of balls) {
      if (b.hidden) continue;
      // balls.gif layout (matches Java's `ballSprites[playerid + offset]` at
      // GameCanvas.java:1753 / 1789):
      //   row 0 (idx 0..3): players 0..3 frame A (idle)
      //   row 1 (idx 4..7): players 0..3 frame B (Java's dithered alternate
      //                      driven by `(x/5 + y/5) % 2 * 4`)
      // The previous `colour * 2 + moving` formula assumed each player's two
      // frames were horizontally adjacent (cols 2k, 2k+1) — they aren't, which
      // made slot 1 render as P2's sprite, slot 2 as P0 frame B, and slot 3 as
      // P2 frame B. End result: only two distinct ball colours visible across
      // four players. Daily rooms can hold 100 players (vs Java's 4-cap), so
      // cycle colours past index 3 to stay in-atlas.
      const colour = ((b.playerIdx % 4) + 4) % 4;
      const idx = (b.moving ? 4 : 0) + colour;
      const { sx, sy } = spriteSrc13(idx, 4);
      const baseDx = Math.round(b.x - 6.5);
      const baseDy = Math.round(b.y - 6.5);
      const shrink = b.shrink && b.shrink > 0 ? b.shrink : 0;
      const dx = shrink > 0 ? Math.floor(baseDx + shrink) : baseDx;
      const dy = shrink > 0 ? Math.floor(baseDy + shrink) : baseDy;
      const size = shrink > 0 ? Math.max(0, Math.floor(13 - shrink * 2)) : 13;
      if (size <= 0) continue;
      if (b.ghost) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.drawImage(this.atlases.balls, sx, sy, 13, 13, dx, dy, size, size);
        if (b.label) {
          // Small white-with-shadow label above the ghost ball.
          ctx.globalAlpha = 0.85;
          ctx.font = "10px Verdana, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "alphabetic";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.strokeText(b.label, b.x, baseDy - 2);
          ctx.fillStyle = "#fff";
          ctx.fillText(b.label, b.x, baseDy - 2);
        }
        ctx.restore();
      } else {
        ctx.drawImage(this.atlases.balls, sx, sy, 13, 13, dx, dy, size, size);
        const nd = b.nameDisplay;
        if (nd) {
          // Java GameCanvas.drawPlayer:1754. Outline = panel background green
          // rgb(19,167,19) (Java's `backgroundColour`); fill = white for self,
          // black for others (set in GameCanvas:116/125 before drawPlayer is
          // called, then preserved by StringDraw.drawOutlinedString).
          ctx.save();
          ctx.font = '10px "Dialog", Verdana, sans-serif';
          ctx.textBaseline = "alphabetic";
          const fillColour = nd.isSelf ? "#fff" : "#000";
          if (nd.mode === 1) {
            // Initial: centered above ball, NO outline (Java calls plain
            // drawString here, not drawOutlinedString).
            const initial = nd.name.charAt(0);
            ctx.textAlign = "center";
            ctx.fillStyle = fillColour;
            ctx.fillText(initial, baseDx + 6, baseDy + 13 - 3);
          } else {
            // Java draws the outline by 4 offset fillText copies of the same
            // string (StringDraw.drawOutlinedString:53-63). Replicating that
            // pixel-for-pixel in canvas leaves a green halo that's washed out
            // against the canvas's anti-aliased glyph edges — so use canvas
            // strokeText instead, which produces a single solid 1.5px outline
            // that reads clearly while still using Java's exact colour choices
            // (green outline, white-self / black-others fill).
            ctx.lineWidth = 1.5;
            ctx.lineJoin = "round";
            ctx.miterLimit = 2;
            ctx.strokeStyle = "rgb(19,167,19)";
            ctx.fillStyle = fillColour;
            const drawOutlined = (text: string, tx: number, ty: number): void => {
              ctx.strokeText(text, tx, ty);
              ctx.fillText(text, tx, ty);
            };
            const clan =
              nd.mode === 3 && nd.clan && nd.clan.length > 0
                ? `[${nd.clan}]`
                : null;
            const nameWidth = ctx.measureText(nd.name).width;
            const clanWidth = clan ? ctx.measureText(clan).width : 0;
            // Java edge-clip threshold (canvas width 735, Java compares >= 733).
            const overflow =
              baseDx + 13 + 2 + Math.max(nameWidth, clanWidth) >= 733;
            if (clan) {
              // Mode 3: name above ball-vertical-center, clan below bottom.
              const yName = baseDy + 13 - 3 - 6;
              const yClan = baseDy + 13 - 3 + 7;
              if (overflow) {
                // Java: alignment flips to RIGHT, textX = x - 2 (text ends at x-2).
                ctx.textAlign = "right";
                const tx = baseDx - 2;
                drawOutlined(nd.name, tx, yName);
                drawOutlined(clan, tx, yClan);
              } else {
                ctx.textAlign = "left";
                const tx = baseDx + 13 + 2;
                drawOutlined(nd.name, tx, yName);
                drawOutlined(clan, tx, yClan);
              }
            } else {
              // Mode 2 (or mode 3 with no clan): single name line beside ball.
              const yLine = baseDy + 13 - 3;
              ctx.textAlign = "left";
              // Java keeps LEFT alignment on overflow but shifts X to
              // (x - 2 - nameWidth) so the text ends at x-2.
              const tx = overflow
                ? baseDx - 2 - nameWidth
                : baseDx + 13 + 2;
              drawOutlined(nd.name, tx, yLine);
            }
          }
          ctx.restore();
        }
      }
    }
  }
}
