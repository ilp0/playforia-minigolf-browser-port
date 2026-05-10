// Brute-force hole-in-one search.
//
// Before training a network on a map, we try every shot on a coarse
// polar grid (angle × power) and check if any one of them holes the ball
// directly. If we find one, training is unnecessary - the agent gets a
// PERFECTED status and just replays the recorded action.
//
// Why polar (not Cartesian over (Δx, Δy)): equal-angle samples give
// uniform directional coverage. Cartesian would oversample low-power
// shots near (0, 0) and miss directional gaps.
//
// Defaults: 1° angle resolution × 2-pixel power resolution from 5 to 200
// pixels. That's 360 × 98 ≈ 35 000 sandbox shots per map, ~3-5 seconds
// of CPU on a typical machine. Yielded periodically via `setTimeout(0)`
// so the UI doesn't freeze.

import { Episode, type StrokeOutcome } from "./env.ts";
import type { LoadedTrack } from "./loader.ts";

export interface HioSearchOptions {
  /** Angle step in degrees. Smaller = finer angular coverage, more shots. */
  angleStep?: number;
  /** Power step in pixels. Smaller = finer power coverage, more shots. */
  powerStep?: number;
  /** Min mouse-offset magnitude (pixels). Below ~5 the impulse is too
   *  weak to move the ball usefully. */
  minPower?: number;
  /** Max mouse-offset magnitude (pixels). Physics clamps anything bigger
   *  to ~6.5 units of velocity, so going past ~200 px adds no power. */
  maxPower?: number;
  /** How many candidate shots between yields to the event loop. Lower =
   *  smoother UI during the search, slower wall-clock total. */
  yieldEveryN?: number;
  /** Optional progress callback fired every `yieldEveryN` shots. */
  onProgress?: (done: number, total: number) => void;
  /** Optional per-candidate visualisation callback. Fired immediately
   *  after each simulation completes, so the renderer can paint the
   *  shot's trajectory onto an overlay. Used to visualise the search
   *  process live - the user sees a fan of attempted shots build up
   *  while the search runs. */
  onCandidate?: (
    action: { dx: number; dy: number },
    finalX: number,
    finalY: number,
    outcome: StrokeOutcome,
  ) => void;
  /** Optional cancel signal. Polled at every yield; if it returns true,
   *  the search aborts and resolves to null. Used so map-switches don't
   *  leave a stale search running in the background. */
  isCancelled?: () => boolean;
}

export interface HioSearchResult {
  action: { dx: number; dy: number };
  /** Total candidate shots we evaluated before finding one. */
  candidatesTried: number;
}

const DEFAULTS = {
  angleStep: 1,
  powerStep: 2,
  minPower: 5,
  maxPower: 200,
  yieldEveryN: 200,
};

/**
 * Try every shot on a polar grid until we find one that holes the ball
 * in a single stroke. Returns the action on success, or null after
 * exhausting the grid.
 *
 * Each candidate runs in a fresh {@link Episode} (so they don't pollute
 * each other) with `maxStrokes: 1` and is ticked to completion.
 */
export async function searchHoleInOne(
  track: LoadedTrack,
  opts: HioSearchOptions = {},
): Promise<HioSearchResult | null> {
  const angleStep = opts.angleStep ?? DEFAULTS.angleStep;
  const powerStep = opts.powerStep ?? DEFAULTS.powerStep;
  const minPower = opts.minPower ?? DEFAULTS.minPower;
  const maxPower = opts.maxPower ?? DEFAULTS.maxPower;
  const yieldEveryN = opts.yieldEveryN ?? DEFAULTS.yieldEveryN;

  const angleCount = Math.round(360 / angleStep);
  const powerCount = Math.floor((maxPower - minPower) / powerStep) + 1;
  const total = angleCount * powerCount;
  let tried = 0;

  for (let ai = 0; ai < angleCount; ai++) {
    const a = (ai * angleStep * Math.PI) / 180;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    for (let p = minPower; p <= maxPower; p += powerStep) {
      const dx = cosA * p;
      const dy = sinA * p;

      // Fresh episode per candidate. Cheap - just allocates a ball
      // state and a context object; no rendering.
      const ep = new Episode(track, { maxStrokes: 1 });
      ep.applyShot({ dx, dy });
      // Tick to completion. The 9 000 cap matches physics' built-in
      // MAX_STROKE_ITERATIONS safety net so a stuck ball can't run
      // forever inside the search loop.
      ep.tick(9000);

      tried++;
      const finalState = ep.state();
      if (finalState.status === "holed") {
        if (opts.onCandidate) {
          opts.onCandidate({ dx, dy }, finalState.ballX, finalState.ballY, "holed");
        }
        return { action: { dx, dy }, candidatesTried: tried };
      }
      if (opts.onCandidate) {
        // ep.strokeOutcomes has one entry per finished stroke; the
        // single-stroke episode has at most one. Default to "normal" if
        // the stroke didn't actually settle (e.g. iteration cap).
        const outcome: StrokeOutcome = ep.strokeOutcomes[0] ?? "normal";
        opts.onCandidate({ dx, dy }, finalState.ballX, finalState.ballY, outcome);
      }

      if (tried % yieldEveryN === 0) {
        if (opts.onProgress) opts.onProgress(tried, total);
        if (opts.isCancelled && opts.isCancelled()) return null;
        // Yield to the event loop so the page stays responsive.
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  }
  return null;
}
