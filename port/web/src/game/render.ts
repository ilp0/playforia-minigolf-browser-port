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
  unpackTile,
} from "@minigolf/shared";
import type { ParsedMap } from "./map.ts";
import { type Atlases, spriteSrc13 } from "./sprites.ts";

export interface AimLine {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
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
}

/** Ball-colour-matched stroke style for peer aim previews. Indexed by playerIdx. */
const PEER_AIM_COLOURS = [
  "rgba(255, 255, 255, 0.7)", // 0 — white ball
  "rgba(220, 80, 80, 0.7)",   // 1 — red ball
  "rgba(80, 130, 255, 0.7)",  // 2 — blue ball
  "rgba(240, 210, 80, 0.8)",  // 3 — yellow ball
];

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
}

export class TrackRenderer {
  private bgCanvas: HTMLCanvasElement;
  private parsedMap: ParsedMap;
  private atlases: Atlases;

  constructor(parsedMap: ParsedMap, atlases: Atlases) {
    this.parsedMap = parsedMap;
    this.atlases = atlases;
    this.bgCanvas = document.createElement("canvas");
    this.bgCanvas.width = MAP_PIXEL_WIDTH;
    this.bgCanvas.height = MAP_PIXEL_HEIGHT;
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
   * Re-blit a single tile into the cached background canvas. Called after
   * physics mutates the map (movable blocks, breakable bricks) — keeps the
   * background image in sync with `parsedMap.tiles[][]` without rebuilding
   * the entire 735×375 bitmap.
   *
   * Drained from `parsedMap.dirtyTiles` once per frame in the panel tick.
   */
  invalidateTile(tx: number, ty: number): void {
    const ctx = this.bgCanvas.getContext("2d");
    if (!ctx) return;
    const code = this.parsedMap.tiles[tx][ty];
    const img = ctx.createImageData(PIXEL_PER_TILE, PIXEL_PER_TILE);
    // Default fill so empty / non-mask pixels start as the playable-area bg
    // (white per Java default 0xFFFFFF) — matches buildBackground's empty
    // fall-through.
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
    // writeTile expects an ImageData sized to MAP_PIXEL_WIDTH * MAP_PIXEL_HEIGHT
    // and writes at absolute coords. Build a tiny tile-only ImageData here
    // and copy via a temp full-size one to reuse writeTile? Simpler: do the
    // raster inline.
    this.writeTileToImage(img, tx, ty, code);
    ctx.putImageData(img, tx * PIXEL_PER_TILE, ty * PIXEL_PER_TILE);
  }

  /**
   * Tile-local rasterizer mirroring `writeTile` but writing into a 15×15
   * ImageData instead of an MAP_PIXEL_WIDTH × MAP_PIXEL_HEIGHT one. Kept
   * in this class so any future changes to writeTile's substitution rules
   * stay locally co-located.
   */
  private writeTileToImage(img: ImageData, _tx: number, _ty: number, code: number): void {
    const u = unpackTile(code);
    const special = u.isNoSpecial;
    if (special === 0) return; // already filled white above
    const shape = u.shape;
    const bgIdx = u.fore;
    const fgIdx = u.back;
    const mask =
      special === 1 ? this.atlases.shapeMasks[shape] : this.atlases.specialMasks[shape];
    if (!mask) return;
    const bgPixels = this.atlases.elementPixels[bgIdx];
    const fgPixels =
      special === 1
        ? this.atlases.elementPixels[fgIdx]
        : this.atlases.specialPixels[shape];
    if (!bgPixels || !fgPixels) return;
    for (let py = 0; py < PIXEL_PER_TILE; py++) {
      for (let px = 0; px < PIXEL_PER_TILE; px++) {
        const m = mask[py * PIXEL_PER_TILE + px];
        const src = m === 1 ? bgPixels : fgPixels;
        const si = (py * PIXEL_PER_TILE + px) * 4;
        const oi = (py * PIXEL_PER_TILE + px) * 4;
        img.data[oi] = src[si];
        img.data[oi + 1] = src[si + 1];
        img.data[oi + 2] = src[si + 2];
        img.data[oi + 3] = 255;
      }
    }
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

    const isSolid = (x: number, y: number): boolean => {
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      const c = collision[y * W + x];
      // Java: c >= 16 && c <= 23 && c != 19  (specialSettings[3]==false; the
      // illusion-wall block doesn't cast shadows in the default ruleset).
      return c >= 16 && c <= 23 && c !== 19;
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

  drawFrame(
    ctx: CanvasRenderingContext2D,
    balls: BallSprite[],
    aim: AimLine | null,
    peerAims: PeerAim[] = [],
  ): void {
    ctx.drawImage(this.bgCanvas, 0, 0);

    // Peer aims first so the local aim renders on top of any overlap.
    for (const pa of peerAims) {
      ctx.strokeStyle = PEER_AIM_COLOURS[pa.playerIdx % PEER_AIM_COLOURS.length];
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pa.fromX, pa.fromY);
      ctx.lineTo(pa.toX, pa.toY);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (aim) {
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(aim.fromX, aim.fromY);
      ctx.lineTo(aim.toX, aim.toY);
      ctx.stroke();
    }

    // Sort: ghosts first (drawn beneath), self last so it's always visible.
    const sorted = [...balls].sort((a, b) => {
      const ga = a.ghost ? 0 : 1;
      const gb = b.ghost ? 0 : 1;
      if (ga !== gb) return ga - gb;
      return Number(a.moving) - Number(b.moving);
    });
    for (const b of sorted) {
      if (b.hidden) continue;
      // balls.gif: 8 sprites total, 4 per row → playerIdx*2 + (moving?1:0).
      const idx = b.playerIdx * 2 + (b.moving ? 1 : 0);
      const { sx, sy } = spriteSrc13(idx, 4);
      const dx = Math.round(b.x - 6.5);
      const dy = Math.round(b.y - 6.5);
      if (b.ghost) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.drawImage(this.atlases.balls, sx, sy, 13, 13, dx, dy, 13, 13);
        if (b.label) {
          // Small white-with-shadow label above the ghost ball.
          ctx.globalAlpha = 0.85;
          ctx.font = "10px Verdana, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "alphabetic";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.strokeText(b.label, b.x, dy - 2);
          ctx.fillStyle = "#fff";
          ctx.fillText(b.label, b.x, dy - 2);
        }
        ctx.restore();
      } else {
        ctx.drawImage(this.atlases.balls, sx, sy, 13, 13, dx, dy, 13, 13);
      }
    }
  }
}
