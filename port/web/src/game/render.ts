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
    ctx.putImageData(img, 0, 0);
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
