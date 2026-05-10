// Headless track loader. Mirrors port/ai/src/loader.ts but reads .track
// files from the local filesystem instead of through Vite's import.meta.glob,
// and uses the headless atlas loader.
//
// The output (LoadedTrack) is intentionally shape-compatible with the
// browser version so the same Episode + agent code can consume it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseTrack,
  parseSettingsFlags,
  ALL_VISIBLE_FLAGS,
  TILE,
  MAP_PIXEL_WIDTH,
  MAP_PIXEL_HEIGHT,
} from "@minigolf/shared";
import { buildMap } from "../../web/src/game/map.ts";
import { buildDistanceMap } from "../src/path.ts";
import type { LoadedTrack } from "../src/loader.ts";
import { loadAtlasesHeadless } from "./atlases.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(here, "../../server/tracks/tracks");

export function loadTrackHeadless(filename: string): LoadedTrack {
  const trackText = readFileSync(resolve(TRACKS_DIR, filename), "utf8");
  const atlases = loadAtlasesHeadless();
  const track = parseTrack(trackText);

  const settingsFlags = track.settings
    ? parseSettingsFlags(track.settings)
    : ALL_VISIBLE_FLAGS;

  const map = buildMap(track.map, atlases);

  let startX = 0;
  let startY = 0;
  if (map.startPositions.length > 0) {
    [startX, startY] = map.startPositions[0];
  }

  let hx = 0;
  let hy = 0;
  let count = 0;
  for (let y = 0; y < MAP_PIXEL_HEIGHT; y++) {
    for (let x = 0; x < MAP_PIXEL_WIDTH; x++) {
      if (map.collision[y * MAP_PIXEL_WIDTH + x] === TILE.HOLE) {
        hx += x;
        hy += y;
        count++;
      }
    }
  }
  if (count > 0) {
    hx /= count;
    hy /= count;
  }

  const pathDistMap = buildDistanceMap(map, hx, hy);

  return {
    name: track.name,
    map,
    atlases,
    settingsFlags,
    meta: track,
    startX,
    startY,
    holeX: hx,
    holeY: hy,
    pathDistMap,
  };
}
