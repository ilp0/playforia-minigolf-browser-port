// Worker thread for scan-hio.mjs. Receives a track filename, runs
// searchHoleInOne with the given (or no) time budget, posts the
// result back to the parent.
//
// One worker handles many tracks sequentially - the scan-hio.mjs
// parent dispatches a new file every time the worker reports done,
// keeping the worker pool busy without per-task spawn overhead.

import { parentPort } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const aiRoot = resolve(here, "..");
const toUrl = (p) => pathToFileURL(resolve(aiRoot, p)).href;

const { loadTrackHeadless } = await import(toUrl("headless/track-loader.ts"));
const { searchHoleInOne } = await import(toUrl("src/hio.ts"));
const { Episode } = await import(toUrl("src/env.ts"));

// Tile values that count as SOLID walls for the wall-clip safety check.
// This is intentionally NARROWER than physics' isWall(): we exclude
// one-way walls (20-23) because those are passable in their allowed
// direction by design, and excluding 19 (illusion wall) which physics
// also treats as passable. Bricks (40-43) and movable/sunkable blocks
// (27, 46) are solid until they break/sink, so we keep them but accept
// some false positives if a HIO breaks a brick on the way through.
function isWallVal(v) {
  // Solid wall variants: 16, 17, 18 (normal/weak/bouncy walls).
  if (v === 16 || v === 17 || v === 18) return true;
  // Bricks and movable blocks - solid initially.
  if (v === 27 || v === 46) return true;
  if (v >= 40 && v <= 43) return true;
  return false;
}

/**
 * Replay the HIO action and check if the ball's trajectory ever passes
 * through wall pixels. Returns true if a wall-clip was detected.
 *
 * We replay because searchHoleInOne doesn't keep the trail. Re-running
 * one shot is ~25ms, cheap relative to the search.
 */
function detectWallClip(track, action) {
  const ep = new Episode(track, { maxStrokes: 1 });
  ep.applyShot(action);
  const W = 735;
  let maxClip = 0;
  let i = 0;
  while (ep.state().status === "in_motion" && i < 5000) {
    ep.tick(1);
    const s = ep.state();
    const x = s.ballX | 0;
    const y = s.ballY | 0;
    if (x >= 0 && x < W && y >= 0 && y < 375) {
      const v = track.map.collision[y * W + x];
      if (isWallVal(v)) maxClip++;
    }
    i++;
  }
  // A few "clipped" pixels can occur at hole entry if the hole tile is
  // adjacent to wall pixels; require >5 consecutive wall samples to
  // call it a true clip. In practice false-HIOs clip dozens of pixels
  // (entire wall thicknesses), real HIOs clip 0.
  return maxClip > 5;
}

parentPort.on("message", async (msg) => {
  if (msg === "exit") {
    process.exit(0);
  }
  const { file, budgetSecs, angleStep, powerStep } = msg;
  const start = Date.now();
  let triedAtTimeout = 0;
  try {
    const track = loadTrackHeadless(file);
    const meta = track.meta;
    const deadline = budgetSecs > 0 ? start + budgetSecs * 1000 : Infinity;
    const hio = await searchHoleInOne(track, {
      angleStep: angleStep ?? 1,
      powerStep: powerStep ?? 2,
      yieldEveryN: 5000,
      isCancelled: () => Date.now() > deadline,
      onProgress: (done) => {
        triedAtTimeout = done;
      },
    });
    const secs = (Date.now() - start) / 1000;
    const base = {
      file,
      name: track.name,
      bestPar: meta?.bestPar ?? -1,
      bestPlayer: meta?.bestPlayer ?? null,
    };
    if (hio) {
      // Validate: did the ball actually fly through air, or did it
      // exploit the inside-corner wall-collision quirk?
      const wallClip = detectWallClip(track, hio.action);
      parentPort.postMessage({
        ...base,
        hio: true,
        wall_clip: wallClip,
        action: hio.action,
        candidatesTried: hio.candidatesTried,
        secs,
      });
    } else {
      const timedOut = budgetSecs > 0 && Date.now() >= deadline - 50;
      parentPort.postMessage({
        ...base,
        hio: false,
        timed_out: timedOut,
        candidatesTried: triedAtTimeout,
        secs,
      });
    }
  } catch (e) {
    parentPort.postMessage({
      file,
      name: file.replace(/\.track$/i, ""),
      hio: false,
      bestPar: -1,
      bestPlayer: null,
      error: e?.message ?? String(e),
      secs: (Date.now() - start) / 1000,
    });
  }
});
