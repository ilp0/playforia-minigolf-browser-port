// Loads atlases (the same GIF sheets the web client uses) and parses a
// .track string into a ParsedMap that physics can step. Also extracts the
// hole position by scanning the collision grid for TILE.HOLE pixels.
//
// We surface the original SettingsFlags too so the production TrackRenderer
// gets the same per-track visibility tweaks (hidden mines/magnets/teleports)
// the real game would apply.

import {
  parseTrack,
  parseSettingsFlags,
  ALL_VISIBLE_FLAGS,
  TILE,
  MAP_PIXEL_WIDTH,
  MAP_PIXEL_HEIGHT,
  type SettingsFlags,
  type Track,
} from "@minigolf/shared";
import { buildMap, type ParsedMap } from "../../web/src/game/map.ts";
import { loadAtlases, type Atlases } from "../../web/src/game/sprites.ts";
import { buildDistanceMap, type DistanceResult } from "./path.ts";

let cachedAtlases: Atlases | null = null;

export async function getAtlases(): Promise<Atlases> {
  if (cachedAtlases) return cachedAtlases;
  cachedAtlases = await loadAtlases();
  return cachedAtlases;
}

export interface LoadedTrack {
  name: string;
  map: ParsedMap;
  atlases: Atlases;
  settingsFlags: SettingsFlags;
  /** Original parsed Track record - exposes author, plays, strokes,
   *  bestPar, bestPlayer, ratings, etc. to the UI. We surface this so
   *  the metadata panel can show "the OG database stats" alongside the
   *  agent's own training metrics. */
  meta: Track;
  /** Pixel-center start position the agent's ball will spawn at. */
  startX: number;
  startY: number;
  /** Pixel-center hole position (centroid of all hole-collision pixels). */
  holeX: number;
  holeY: number;
  /** Tile-step distances from each tile to the hole + parent pointers
   *  for route reconstruction, computed once at load time. Walls / water
   *  / acid / mines block the BFS; teleporters create same-distance
   *  edges between START and EXIT tiles. The agent's encoder reads
   *  `dist` for the "navigation" channel; the reward shaping uses
   *  `dist` for the "got closer" delta; the route renderer walks
   *  `parent` to reconstruct the polyline. */
  pathDistMap: DistanceResult;
}

export async function loadTrack(trackText: string): Promise<LoadedTrack> {
  const atlases = await getAtlases();
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

  // Hole: scan collision[] for TILE.HOLE pixels and take the centroid.
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

  // Pre-compute the tile-step distance map (and parent pointers, for
  // route reconstruction) for navigation features and reward shaping.
  // <1ms; cached on the track so we don't redo it on every encode.
  const pathDistMap: DistanceResult = buildDistanceMap(map, hx, hy);

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
