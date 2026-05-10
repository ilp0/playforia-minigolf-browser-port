// Frozen bounds for the autoresearch loop. Tighter than the user-facing
// BOUNDS in config.ts.
//
// These bounds exist (per AUTORESEARCH_PLAN.md §2 "frozen") to close
// gaming vectors structurally rather than via prose hints in program.md.
// Concretely:
//
//   - safetyRetries up to ~12 (the user-facing slider goes to 50). At 50
//     the policy doesn't really learn - the rejection-sample loop just
//     tries 50 times per stroke. That inflates success rate without the
//     policy improving. Cap forces the loop to make the policy do the work.
//
//   - numParallel up to 8 (slider goes to 16). program.md flags this as
//     "slow and not load-bearing"; we enforce it here.
//
//   - searchHIOFirst is locked at 0. The HIO brute-force pre-search
//     solves nearly every curated eval map in <3 seconds. With HIO=1
//     enabled, score saturates at 1.0 immediately and the loop's
//     strict-better-or-revert rule freezes there forever - the policy
//     never gets to matter. Calibration confirmed this empirically.
//     The user-facing BOUNDS in src/config.ts still allow 0/1 for
//     the browser trainer; only autoresearch is locked.
//
// The eval harness applies these bounds via `clampToAutoresearchBounds`
// before training. If the program's exported config sets a knob outside
// the bound, it gets silently clamped - we deliberately don't error
// because the loop should be able to "try" any config and have the
// system reject it gracefully.
//
// This file is part of the FROZEN surface. The autoresearch loop must
// NEVER edit it. Doing so would re-open the gaming vectors.

import { type TrainingConfig } from "../src/config.ts";

export interface Bound {
  min: number;
  max: number;
}

export const AUTORESEARCH_BOUNDS: Record<keyof TrainingConfig, Bound> = {
  // Architecture - allow the full UI range. The autoresearch goal includes
  // "find the right network shape," so these are unrestricted.
  gridSize: { min: 3, max: 49 },
  raySamples: { min: 0, max: 64 },
  radialRays: { min: 0, max: 16 },
  radialSamplesPerRay: { min: 1, max: 16 },
  radialRayMaxDist: { min: 30, max: 800 },
  useNavigation: { min: 0, max: 1 },
  hiddenSize: { min: 8, max: 128 },

  // Optimizer - full range. The Karpathy-style loop is supposed to find
  // good values here.
  lr: { min: 1e-6, max: 1e-2 },
  gamma: { min: 0.5, max: 1.0 },
  batchSize: { min: 1, max: 32 },
  valueCoef: { min: 0, max: 5 },
  gradClip: { min: 1, max: 10000 },

  // Action distribution - full range.
  meanScale: { min: 5, max: 300 },
  initLogStd: { min: 0, max: 6 },
  logStdMin: { min: 0, max: 6 },
  logStdMax: { min: 0, max: 6 },

  // Reward - full range. The metric (success rate) is reward-invariant
  // by design, so the loop can't game *the metric* via reward tweaks.
  // It can still find magnitudes that train better/worse.
  strokePenalty: { min: -20, max: 0 },
  holeBonus: { min: 0, max: 200 },
  waterPenalty: { min: -50, max: 0 },
  acidPenalty: { min: -50, max: 0 },
  progressBonus: { min: 0, max: 0.05 },
  explorationBonus: { min: 0, max: 0.05 },

  // Episode / runtime
  // maxStrokes: don't let the loop arbitrarily inflate this - 200 is
  // the UI max, but at 200 a "successful" episode could waste tons of
  // wall-clock time per eval round, distorting the trial budget across
  // configs. Cap at 60.
  maxStrokes: { min: 1, max: 60 },
  // numParallel: cap per program.md guidance.
  numParallel: { min: 1, max: 8 },

  // Safety / search - the cheap-success knobs.
  // safetyRetries: capped per advisor §1. At 12 the loop has expressive
  // room (off, low, mid) without being able to convert the metric into
  // a "how many retries can I afford" exercise.
  safetyRetries: { min: 0, max: 12 },
  // learnFromRejectedShots: 0/1. Was OFF by default after empirical
  // destabilisation; the loop CAN turn it on but only as one knob
  // among many.
  learnFromRejectedShots: { min: 0, max: 1 },
  // searchHIOFirst: locked at 0 for autoresearch.
  // The HIO brute-force pre-search solves nearly every curated eval
  // map in <3 seconds. With HIO=1, score saturates at 1.0 and the
  // loop's strict-better-or-revert rule means whichever variant got
  // there first becomes the eternal best - the policy never gets to
  // matter. Lock structurally rather than rely on program.md prose.
  // The user-facing BOUNDS in src/config.ts still allow 0/1 - only
  // autoresearch is locked.
  searchHIOFirst: { min: 0, max: 0 },
};

/** Return a copy of `cfg` with every knob clamped into the autoresearch
 *  bound. Boolean knobs are rounded to {0,1}; other integer knobs are
 *  rounded but not snapped (let the user-facing config layer do that). */
export function clampToAutoresearchBounds(cfg: TrainingConfig): TrainingConfig {
  const out = { ...cfg };
  for (const k of Object.keys(AUTORESEARCH_BOUNDS) as Array<keyof TrainingConfig>) {
    const { min, max } = AUTORESEARCH_BOUNDS[k];
    let v = out[k];
    if (!Number.isFinite(v)) v = min;
    if (v < min) v = min;
    if (v > max) v = max;
    out[k] = v;
  }
  return out;
}

/** Return the list of knobs the autoresearch loop is allowed to write.
 *  Currently identical to the BOUNDS keys; held as a separate export so
 *  the loop runner can sanity-check the diff between iterations
 *  ("did the agent edit anything outside the allowed surface?"). */
export const ALLOWED_KEYS: ReadonlyArray<keyof TrainingConfig> = Object.keys(
  AUTORESEARCH_BOUNDS,
) as Array<keyof TrainingConfig>;
