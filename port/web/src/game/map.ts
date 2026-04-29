// Build the 735*375 collision map from a parsed track, mirroring Map.collisionMap()
// in the Java client. Also extracts start positions, teleport portals, magnet
// field, and tracks any "live" mines so physics can detonate them.
//
// Important naming note: shared/rle.ts unpackTile() returns `fore` and `back`
// where `fore` is what Java calls `background` and `back` is `foreground`.
// We rebind locally to bg/fg to keep the code readable.

import {
  decodeMap,
  unpackTile,
  TILE_WIDTH,
  TILE_HEIGHT,
  PIXEL_PER_TILE,
  MAP_PIXEL_WIDTH,
  MAP_PIXEL_HEIGHT,
} from "@minigolf/shared";
import type { Atlases } from "./sprites.ts";

/** Width / height of the magnet-force grid (5x5 pixels per cell). */
export const MAGNET_W = 147;
export const MAGNET_H = 75;

export interface ParsedMap {
  /** [x][y] grid of raw 32-bit tile codes (49 * 25). */
  tiles: number[][];
  /** Length 735*375, indexed [y*735 + x]; values 0..47ish per Map.java. */
  collision: Uint8Array;
  /** Pixel-center positions of common-start tiles (special shape 24). */
  startPositions: Array<[number, number]>;
  /** Per-color reset positions for shape 48..51, or null if absent. */
  resetPositions: Array<[number, number] | null>;
  /** Teleport-start positions, indexed by colour 0..3 (blue/red/yellow/green). */
  teleportStarts: Array<Array<[number, number]>>;
  /** Teleport-exit positions, indexed by colour 0..3. */
  teleportExits: Array<Array<[number, number]>>;
  /**
   * Magnet field: 147 x 75 cells, each holding [forceX, forceY] in the same
   * units as Java state.magnetMap (clamped to ±2047). null if no magnets.
   */
  magnetMap: Int16Array | null;
  /**
   * Tile coords [tx, ty] that have been mutated since the last drain. Movable
   * and breakable blocks push entries here when they change; the renderer
   * drains the queue once per frame and re-blits the affected tiles into
   * its cached background canvas.
   */
  dirtyTiles: Array<[number, number]>;
  /** Atlases the map was built against - held for in-place re-rasterization. */
  atlases: Atlases;
}

/**
 * Rasterize one tile's 15×15 pixels into the collision map. Shared by
 * `buildMap` (whole-map build) and `mutateTile` (in-place updates) so the
 * substitution rules - shape 24/26/33/35/37/39 fall through to background,
 * bricks 40-43 keep their shape ID, magnets 44/45 have water-aware fallback -
 * can never drift between build and mutate paths.
 */
function rasterizeCollisionTile(
  collision: Uint8Array,
  tx: number,
  ty: number,
  code: number,
  atlases: Atlases,
): void {
  const u = unpackTile(code);
  const special = u.isNoSpecial;
  const shape = u.shape;
  const bg = u.fore;
  const fg = u.back;

  // Empty tile (special === 0): clear pixels to 0 so isWall/colAt don't see
  // stale wall data from a previous mutation.
  if (special === 0) {
    for (let py = 0; py < PIXEL_PER_TILE; py++) {
      for (let px = 0; px < PIXEL_PER_TILE; px++) {
        const cx = tx * PIXEL_PER_TILE + px;
        const cy = ty * PIXEL_PER_TILE + py;
        collision[cy * MAP_PIXEL_WIDTH + cx] = 0;
      }
    }
    return;
  }

  const mask =
    special === 1 ? atlases.shapeMasks[shape] : atlases.specialMasks[shape];
  if (!mask) return;

  for (let py = 0; py < PIXEL_PER_TILE; py++) {
    for (let px = 0; px < PIXEL_PER_TILE; px++) {
      const m = mask[py * PIXEL_PER_TILE + px];
      let pixel: number;
      if (special === 1) {
        pixel = m === 1 ? bg : fg;
      } else {
        const s = shape + 24;
        pixel = m === 1 ? bg : s;
        if (s === 24) pixel = bg;
        else if (s === 26) pixel = bg;
        else if (s === 33 || s === 35 || s === 37 || s === 39) pixel = bg;
        else if (s >= 40 && s <= 43) pixel = s;
        else if (s === 44) {
          pixel =
            bg !== 12 && bg !== 13 && bg !== 14 && bg !== 15 ? s : bg;
        } else if (s === 45) pixel = bg;
      }
      const cx = tx * PIXEL_PER_TILE + px;
      const cy = ty * PIXEL_PER_TILE + py;
      collision[cy * MAP_PIXEL_WIDTH + cx] = pixel & 0xff;
    }
  }
}

/**
 * In-place tile update used by movable/breakable blocks during physics.
 * Mutates `tiles[tx][ty]`, re-rasterizes the 15×15 collision pixels, and
 * appends the tile to `dirtyTiles` so the renderer can refresh its cached
 * background. Safe to call multiple times per frame for the same tile -
 * the renderer dedupes naturally because the final state is what gets blitted.
 */
export function mutateTile(map: ParsedMap, tx: number, ty: number, code: number): void {
  if (tx < 0 || tx >= TILE_WIDTH || ty < 0 || ty >= TILE_HEIGHT) return;
  map.tiles[tx][ty] = code;
  rasterizeCollisionTile(map.collision, tx, ty, code, map.atlases);
  map.dirtyTiles.push([tx, ty]);
}

export function buildMap(rawTLine: string, atlases: Atlases): ParsedMap {
  const tiles = decodeMap(rawTLine);
  const collision = new Uint8Array(MAP_PIXEL_WIDTH * MAP_PIXEL_HEIGHT);
  const startPositions: Array<[number, number]> = [];
  const resetPositions: Array<[number, number] | null> = [null, null, null, null];
  const teleportStarts: Array<Array<[number, number]>> = [[], [], [], []];
  const teleportExits: Array<Array<[number, number]>> = [[], [], [], []];
  // [x, y, shape] tuples for magnet-force calculation.
  const magnets: Array<[number, number, number]> = [];

  for (let ty = 0; ty < TILE_HEIGHT; ty++) {
    for (let tx = 0; tx < TILE_WIDTH; tx++) {
      const code = tiles[tx][ty];
      const u = unpackTile(code);
      const special = u.isNoSpecial; // 0=empty, 1=elem+elem, 2=elem+special
      const shape = u.shape; // raw byte 2 (the "shapeReduced" value)

      if (special === 0) continue;

      // Track start markers, teleport portals, and magnets (uses the +24 form per Java).
      if (special === 2) {
        const s = shape + 24;
        const cx = tx * PIXEL_PER_TILE + 7.5;
        const cy = ty * PIXEL_PER_TILE + 7.5;
        if (s === 24) {
          startPositions.push([cx, cy]);
        } else if (s >= 48 && s <= 51) {
          resetPositions[s - 48] = [cx, cy];
        } else if (s === 32 || s === 34 || s === 36 || s === 38) {
          // Teleport start: blue=32, red=34, yellow=36, green=38.
          teleportStarts[(s - 32) / 2].push([cx, cy]);
        } else if (s === 33 || s === 35 || s === 37 || s === 39) {
          teleportExits[(s - 33) / 2].push([cx, cy]);
        } else if (s === 44 || s === 45) {
          magnets.push([Math.round(cx), Math.round(cy), s]);
        }
      }

      rasterizeCollisionTile(collision, tx, ty, code, atlases);
    }
  }

  // Build the magnet force field if we found any magnets, mirroring the
  // GameCanvas init at line 800. The field is 5x5 pixels per cell.
  let magnetMap: Int16Array | null = null;
  if (magnets.length > 0) {
    magnetMap = new Int16Array(MAGNET_W * MAGNET_H * 2);
    for (let my = 2; my < MAP_PIXEL_HEIGHT; my += 5) {
      for (let mx = 2; mx < MAP_PIXEL_WIDTH; mx += 5) {
        let fx = 0;
        let fy = 0;
        for (const [magX, magY, shape] of magnets) {
          let dx = magX - mx;
          let dy = magY - my;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= 127) {
            const m = Math.abs(dx) / (dist || 1);
            const force = 127 - dist;
            dx = (dx < 0 ? -1 : 1) * force * m;
            dy = (dy < 0 ? -1 : 1) * force * (1 - m);
            if (shape === 45) {
              dx = -dx;
              dy = -dy;
            }
            fx += dx;
            fy += dy;
          }
        }
        const ix = Math.floor(mx / 5);
        const iy = Math.floor(my / 5);
        const o = (iy * MAGNET_W + ix) * 2;
        magnetMap[o] = clampInt16(fx);
        magnetMap[o + 1] = clampInt16(fy);
      }
    }
  }

  return {
    tiles,
    collision,
    startPositions,
    resetPositions,
    teleportStarts,
    teleportExits,
    magnetMap,
    dirtyTiles: [],
    atlases,
  };
}

function clampInt16(v: number): number {
  const i = v | 0;
  if (i < -0x7ff) return -0x7ff;
  if (i > 0x7ff) return 0x7ff;
  return i;
}

/** Read collision-map at integer pixel (x,y); off-map returns 0 (empty). */
export function colAt(map: ParsedMap, x: number, y: number): number {
  if (x < 0 || x >= MAP_PIXEL_WIDTH || y < 0 || y >= MAP_PIXEL_HEIGHT) return 0;
  return map.collision[y * MAP_PIXEL_WIDTH + x];
}
