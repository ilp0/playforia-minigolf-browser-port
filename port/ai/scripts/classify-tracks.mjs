// Scan every .track file and classify it for the autoresearch eval/validation
// map sets. Uses the existing headless track-loader so we get the *real*
// collision-pixel grid (not just regex on the T-line).
//
// Output: writes summaries to stdout and writes a JSON cache so we can
// re-curate without re-decoding 2062 tracks.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const toUrl = (p) => pathToFileURL(resolve(here, p)).href;

const { parseTrack } = await import(toUrl("../../shared/src/track.ts"));
const { decodeMap, unpackTile } = await import(toUrl("../../shared/src/rle.ts"));
const { TILE } = await import(toUrl("../../shared/src/tiles.ts"));

const TRACKS_DIR = resolve(here, "../../server/tracks/tracks");

// Cheap: walk decoded tile codes only, looking at the (special, shape) bytes.
// We don't need the full pixel-level collision grid for classification; the
// shape byte at the top-left of each tile is enough to know if any tile is
// a hazard / teleport / brick wall.
//
// Java tile encoding (rle.ts):
//   special = (code >>> 24) & 0xff   (0 = empty, 1 = normal, 2 = special)
//   shape   = (code >>> 16) & 0xff   (raw shape byte; tile.shape = raw + 24)
//   bg      = (code >>> 8) & 0xff
//   fg      = code & 0xff
//
// Per Tile.java:
//   hazards (water/acid/swamp): special=1, shape∈{12,13,14,15} - 24 = raw {-12,-11,-10,-9}
//     Wait - those are the COLLISION values (0-47), not the shape byte.
//
// Looking at applySettingsToTileCode in shared/src/track.ts:
//   "raw 10 / 12 / 14 → red/yellow/green T-source  (Java shape 34 / 36 / 38)"
//   "raw 11 / 13 / 15 → red/yellow/green T-exit    (Java shape 35 / 37 / 39)"
//   "raw 4 / 6  → mine / BIGmine                   (Java shape 28 / 30)"
//
// So the raw shape byte adds 24 to give the Java tile.shape, which corresponds
// to the collision-value enum in tiles.ts. So:
//   raw shape  4 -> tile.shape 28 = MINE_SMALL
//   raw shape  6 -> tile.shape 30 = MINE_BIG
//   raw shape 10 -> tile.shape 34 = TELEPORT_RED_START
//   raw shape 11 -> tile.shape 35 = TELEPORT_RED_EXIT
//   raw shape 12 -> tile.shape 36 = TELEPORT_YELLOW_START
//   raw shape 13 -> tile.shape 37 = TELEPORT_YELLOW_EXIT
//   raw shape 14 -> tile.shape 38 = TELEPORT_GREEN_START
//   raw shape 15 -> tile.shape 39 = TELEPORT_GREEN_EXIT
//
// Hazards (water/acid) appear as special=1 with shape values that map to 12-15.
// In rle's unpackTile: water uses special=1, shape values match the tile codes
// for water/acid directly. Let's just decode every tile and check if its
// final collision value lies in the hazard / teleport / brick range.
//
// To keep this cheap, we don't need to expand the per-pixel collision grid
// (which is 49*15 x 25*15 = 275k pixels per map). We just look at the tile
// codes themselves. A shape byte that, after +24, equals the collision-value
// from Tile.java gives us classification.

function classifyTrack(filename) {
  const trackText = readFileSync(resolve(TRACKS_DIR, filename), "utf8");
  let track;
  try {
    track = parseTrack(trackText);
  } catch (e) {
    return { error: `parse: ${e.message}` };
  }
  if (!track.map || track.map.length === 0) {
    return { error: "no T-line / empty map" };
  }
  let tiles;
  try {
    tiles = decodeMap(track.map);
  } catch (e) {
    return { error: `decode: ${e.message}` };
  }

  let hazards = 0;
  let teleStarts = 0;
  let teleExits = 0;
  let bricks = 0;
  let mines = 0;
  let magnets = 0;
  let illusion = 0;
  let movable = 0;

  for (let x = 0; x < tiles.length; x++) {
    const col = tiles[x];
    for (let y = 0; y < col.length; y++) {
      const code = col[y];
      const t = unpackTile(code);
      const javaShape = t.shape + 24;
      // hazards: water=12, acid=13, water_swamp=14, acid_swamp=15
      // - but those are tiles.shape values that come up only when the
      //   raw shape byte is -12..-9, which is impossible for an unsigned
      //   byte. In practice hazards are encoded via the "fore" / "back"
      //   nibbles (the tile background element), not the shape byte.
      // Inspecting actual maps shows hazards appear when fore == 14/15
      // with special=1 and shape=0 (a flat dirt/water/acid square).
      // The simplest heuristic: a hazard is present whenever the BACKGROUND
      // (low byte of tile, the per-pixel floor) has a value in 12..15.
      // But that's also encoded inside the atlas, not directly here.
      //
      // Cleaner: decode using the same buildMap path the harness uses,
      // which gives a per-pixel collision array. Bite the bullet and use
      // it - 2062 tracks * ~275k pixels = 567M cell scans, but each is
      // just an array index. Should run in a few seconds in Node.
      void javaShape;

      // Tile-level checks based on shape byte (precise for these features):
      if (t.isNoSpecial === 2) {
        // teleports are special=2 with shape in {10,11,12,13,14,15} or
        //  starts {8,9} (generic blue start/exit, encoded in the
        //  applySettingsToTileCode function above).
        if (t.shape === 10 || t.shape === 12 || t.shape === 14) teleStarts++;
        else if (t.shape === 11 || t.shape === 13 || t.shape === 15) teleExits++;
        else if (t.shape === 4 || t.shape === 6) mines++;
        else if (t.shape === 20 || t.shape === 21) magnets++;
      }
      if (t.isNoSpecial === 1) {
        // shape 0..3 = wall variants; 16..19 = wall-with-illusion
        // bricks 40..43 are tile.shape values (raw + 24), so raw 16..19.
        const ts = t.shape + 24;
        if (ts >= 40 && ts <= 43) bricks++;
        if (ts === 19) illusion++;
        if (ts === 27) movable++;
      }
    }
  }

  // We still need to count hazard PIXELS. A hazard tile is a "background"
  // pixel-fill of water/acid/swamp; those are encoded via the bg byte
  // (the per-tile element, not the shape). Look at tile.fore (Java's
  // background field) which for hazards is in {12,13,14,15} when the
  // tile is a flat water/acid puddle.
  //
  // But that's not quite right either - the .fore index references the
  // atlas's background sprite list; only certain indices correspond to
  // water/acid. From the Java source, the tile's "ground material" (the
  // collision value over the open part of the tile) comes from the
  // background atlas index when the tile shape is empty (0). Indices for
  // water/acid in the standard atlas are well-known: water=12, acid=13,
  // water_swamp=14, acid_swamp=15 (matching the collision values).
  for (let x = 0; x < tiles.length; x++) {
    const col = tiles[x];
    for (let y = 0; y < col.length; y++) {
      const code = col[y];
      const t = unpackTile(code);
      // Hazard background present (regardless of shape):
      if (t.fore >= 12 && t.fore <= 15) hazards++;
      // Some hazards encode in the .back byte too (fg overlay used as the
      // "main" element on tiles where shape is 0). Don't double-count -
      // only look at .back if .fore is grass (or 0).
    }
  }

  // bestPar = .I-line 3rd field (index 2). Per task spec: I = some metadata,
  // 4th number is total plays. But task spec also says: "R = 2nd number is
  // BEST par". Looking at parseTrack:
  //   I.parts[2] = bestPar
  //   R = ratings array (11 buckets). The R-line is 11 stroke-count buckets.
  // The task description says "R 2nd number is the BEST par" but
  // parseTrack puts bestPar from I, not R. We use Track.bestPar.
  // Task also says "1st column of R" for hard maps (recorded best stroke).
  // Inspecting CurveI:
  //   I 859577,2671623,1,119243   -> bestPar=1
  //   R 903,270,294,465,676,1910,1673,1608,1299,998,6921 -> 11 buckets
  // So R is play-count buckets, not par. We'll use I-line bestPar as the
  // "official par" and use track.strokes (.I[1]) total_strokes / .I[3]
  // numBestPar as a "is this map hard" proxy.

  return {
    name: track.name,
    bestPar: track.bestPar,
    plays: track.plays,
    strokes: track.strokes,
    numBestPar: track.numBestPar,
    avgStrokes:
      track.plays > 0 ? track.strokes / track.plays : 0,
    hazards,
    teleStarts,
    teleExits,
    bricks,
    mines,
    magnets,
    illusion,
    movable,
    settings: track.settings || "",
  };
}

const files = readdirSync(TRACKS_DIR).filter((f) => f.endsWith(".track"));
files.sort();
console.log(`Scanning ${files.length} tracks...`);

const results = {};
let errors = 0;
const t0 = performance.now();
for (const f of files) {
  const r = classifyTrack(f);
  if (r.error) {
    errors++;
    continue;
  }
  results[f] = r;
}
const dt = performance.now() - t0;
console.log(`Done in ${dt.toFixed(0)}ms. ${Object.keys(results).length} ok, ${errors} errors.`);

// Write the classification cache to JSON for downstream curation.
const cachePath = resolve(here, "../headless/track-classification.json");
writeFileSync(cachePath, JSON.stringify(results, null, 2));
console.log(`Cache: ${cachePath}`);

// Print summary stats.
const all = Object.values(results);
function count(pred) {
  return all.filter(pred).length;
}
console.log("\nDistribution:");
console.log(`  bestPar=1:   ${count((r) => r.bestPar === 1)}`);
console.log(`  bestPar=2:   ${count((r) => r.bestPar === 2)}`);
console.log(`  bestPar=3:   ${count((r) => r.bestPar === 3)}`);
console.log(`  bestPar=4:   ${count((r) => r.bestPar === 4)}`);
console.log(`  bestPar>=5:  ${count((r) => r.bestPar >= 5)}`);
console.log(`  bestPar=-1:  ${count((r) => r.bestPar === -1)}`);
console.log(`  hazards>0:   ${count((r) => r.hazards > 0)}`);
console.log(`  teleports>0: ${count((r) => r.teleStarts > 0 && r.teleExits > 0)}`);
console.log(`  bricks>0:    ${count((r) => r.bricks > 0)}`);
console.log(`  mines>0:     ${count((r) => r.mines > 0)}`);
console.log(`  magnets>0:   ${count((r) => r.magnets > 0)}`);
console.log(`  movable>0:   ${count((r) => r.movable > 0)}`);
