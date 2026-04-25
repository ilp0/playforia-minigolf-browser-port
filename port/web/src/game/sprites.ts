// Sprite-atlas loader. Atlases are GIF sheets with a 1-pixel border between
// each sprite (the Java SpriteManager.parseSpriteSheet layout):
//   sheetX = column * (spriteW + 1) + 1
//   sheetY = row    * (spriteH + 1) + 1
//
// Each pixel in the resulting masks is 1 (background marker, RGB 0xCCCCFF) or
// 2 (foreground), matching SpriteManager.createShapeMask.

import { loadImage } from "../sprites.ts";

export interface Atlases {
  shapes: HTMLImageElement;
  elements: HTMLImageElement;
  special: HTMLImageElement;
  balls: HTMLImageElement;
  /** 28 entries; each is a 15*15 Uint8Array indexed [py*15 + px], values 1 or 2. */
  shapeMasks: Uint8Array[];
  /** 28 entries; each is a 15*15 Uint8Array indexed [py*15 + px], values 1 or 2. */
  specialMasks: Uint8Array[];
  /** 24 entries; each is a 15*15 RGBA Uint8ClampedArray of element pixel data. */
  elementPixels: Uint8ClampedArray[];
  /** 28 entries; same shape, special sprite pixel data. */
  specialPixels: Uint8ClampedArray[];
}

const BG_MARKER = 0xccccff;

function extractMasks(
  img: HTMLImageElement,
  count: number,
  perRow: number,
  w: number,
  h: number,
): Uint8Array[] {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(img, 0, 0);
  const masks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const sx = col * (w + 1) + 1;
    const sy = row * (h + 1) + 1;
    const data = ctx.getImageData(sx, sy, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const o = (py * w + px) * 4;
        const rgb = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
        mask[py * w + px] = rgb === BG_MARKER ? 1 : 2;
      }
    }
    masks.push(mask);
  }
  return masks;
}

/** Extract raw 15*15 RGBA pixel data for each sprite in an atlas. */
function extractPixels(
  img: HTMLImageElement,
  count: number,
  perRow: number,
  w: number,
  h: number,
): Uint8ClampedArray[] {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(img, 0, 0);
  const out: Uint8ClampedArray[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const sx = col * (w + 1) + 1;
    const sy = row * (h + 1) + 1;
    const data = ctx.getImageData(sx, sy, w, h).data;
    out.push(new Uint8ClampedArray(data));
  }
  return out;
}

export async function loadAtlases(): Promise<Atlases> {
  const [shapes, elements, special, balls] = await Promise.all([
    loadImage("/picture/agolf/shapes.gif"),
    loadImage("/picture/agolf/elements.gif"),
    loadImage("/picture/agolf/special.gif"),
    loadImage("/picture/agolf/balls.gif"),
  ]);
  const shapeMasks = extractMasks(shapes, 28, 4, 15, 15);
  const specialMasks = extractMasks(special, 28, 4, 15, 15);
  const elementPixels = extractPixels(elements, 24, 4, 15, 15);
  const specialPixels = extractPixels(special, 28, 4, 15, 15);
  return {
    shapes,
    elements,
    special,
    balls,
    shapeMasks,
    specialMasks,
    elementPixels,
    specialPixels,
  };
}

/** Read sprite (sx,sy) for a 15x15 atlas (column, row form), returning canvas-source coords. */
export function spriteSrc15(index: number, perRow: number): { sx: number; sy: number } {
  const row = Math.floor(index / perRow);
  const col = index % perRow;
  return { sx: col * 16 + 1, sy: row * 16 + 1 };
}

export function spriteSrc13(index: number, perRow: number): { sx: number; sy: number } {
  const row = Math.floor(index / perRow);
  const col = index % perRow;
  return { sx: col * 14 + 1, sy: row * 14 + 1 };
}
