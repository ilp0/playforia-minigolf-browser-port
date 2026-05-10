// Headless atlas loader. Mirrors port/web/src/game/sprites.ts loadAtlases()
// but reads GIFs from disk via omggif instead of HTMLImageElement +
// canvas.getImageData.
//
// Why this exists: the autoresearch harness runs in Node. Node has no Image
// constructor or canvas. The atlases ship as GIF files in the web public
// dir; omggif is a pure-JS GIF decoder we use to extract raw RGBA bytes
// without pulling in a native canvas dependency.
//
// Output is shape-compatible with the browser Atlases interface for the
// fields buildMap actually reads (shapeMasks + specialMasks). The
// HTMLImageElement fields are stubbed with `null as any` because nothing
// in the headless training path touches them - rendering is browser-only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GifReader } from "omggif";
import type { Atlases } from "../../web/src/game/sprites.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, "../../web/public/picture/agolf");

const BG_MARKER = 0xccccff;

interface DecodedGif {
  width: number;
  height: number;
  /** RGBA, length = width * height * 4. */
  rgba: Uint8Array;
}

function decodeGif(filename: string): DecodedGif {
  const buf = readFileSync(resolve(PUBLIC_DIR, filename));
  const reader = new GifReader(buf);
  const rgba = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, rgba);
  return { width: reader.width, height: reader.height, rgba };
}

function extractMasks(
  img: DecodedGif,
  count: number,
  perRow: number,
  w: number,
  h: number,
): Uint8Array[] {
  const masks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const sx = col * (w + 1) + 1;
    const sy = row * (h + 1) + 1;
    const mask = new Uint8Array(w * h);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const ix = ((sy + py) * img.width + (sx + px)) * 4;
        const rgb = (img.rgba[ix] << 16) | (img.rgba[ix + 1] << 8) | img.rgba[ix + 2];
        mask[py * w + px] = rgb === BG_MARKER ? 1 : 2;
      }
    }
    masks.push(mask);
  }
  return masks;
}

function extractPixels(
  img: DecodedGif,
  count: number,
  perRow: number,
  w: number,
  h: number,
): Uint8ClampedArray[] {
  const out: Uint8ClampedArray[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const sx = col * (w + 1) + 1;
    const sy = row * (h + 1) + 1;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const src = ((sy + py) * img.width + (sx + px)) * 4;
        const dst = (py * w + px) * 4;
        data[dst] = img.rgba[src];
        data[dst + 1] = img.rgba[src + 1];
        data[dst + 2] = img.rgba[src + 2];
        data[dst + 3] = img.rgba[src + 3];
      }
    }
    out.push(data);
  }
  return out;
}

let cached: Atlases | null = null;

export function loadAtlasesHeadless(): Atlases {
  if (cached) return cached;

  const shapes = decodeGif("shapes.gif");
  const elements = decodeGif("elements.gif");
  const special = decodeGif("special.gif");

  const shapeMasks = extractMasks(shapes, 28, 4, 15, 15);
  const specialMasks = extractMasks(special, 28, 4, 15, 15);
  const elementPixels = extractPixels(elements, 24, 4, 15, 15);
  const specialPixels = extractPixels(special, 28, 4, 15, 15);

  cached = {
    shapes: null as never,
    elements: null as never,
    special: null as never,
    balls: null as never,
    shapeMasks,
    specialMasks,
    elementPixels,
    specialPixels,
  };
  return cached;
}
