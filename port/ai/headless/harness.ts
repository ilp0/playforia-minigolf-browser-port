// Headless training-and-eval harness. Pure Node, no DOM, no localStorage,
// no rendering.
//
// One harness invocation = one (config × map list × seed) tuple → one number.
// The autoresearch loop calls this repeatedly with different configs and
// keeps/reverts based on the returned score.
//
// Determinism: we re-seed Math.random at the top of every (map × seed)
// combo so different seeds produce different rollouts but the same seed
// reproduces the same rollout for the same config. The shared package's
// `Seed` type already wraps a deterministic PRNG that physics consumes;
// we install ours over the global Math.random so the agent's own
// sampling (which uses Math.random directly via randn / Math.random in
// nn.ts) is also seeded.

import { performance } from "node:perf_hooks";
import {
  Episode,
  episodeReturn,
  discountedPerStepReturns,
  type RewardMagnitudes,
} from "../src/env.ts";
import { MLPAgent, type PolicyStep } from "../src/agent.ts";
import { type TrainingConfig } from "../src/config.ts";
import { searchHoleInOne } from "../src/hio.ts";
import { loadTrackHeadless } from "./track-loader.ts";
import type { LoadedTrack } from "../src/loader.ts";

/** Result for one (map × seed) trial inside one harness invocation. */
export interface MapResult {
  /** Filename, e.g. "CurveI.track". */
  map: string;
  /** Seed that drove this run. */
  seed: number;
  /** Wall-clock training time used, in seconds. */
  trainSecs: number;
  /** Number of training episodes finished within the budget. */
  trainEpisodes: number;
  /** Eval episodes that ended with status="holed". */
  holedCount: number;
  /** Total eval episodes attempted. */
  evalEpisodes: number;
  /** Mean stroke count over holed eval episodes (NaN if none holed). */
  meanStrokesOnHoled: number;
  /** Whether HIO pre-search succeeded (fully overrides the policy). */
  hioWon: boolean;
}

export interface HarnessResult {
  /** PRIMARY METRIC. Mean of (holed/eval) across all maps × seeds.
   *  Per AUTORESEARCH_PLAN.md §3 option 3 - reward-formula-invariant. */
  score: number;
  perMap: MapResult[];
  totalWallSecs: number;
  /** Echo of the config that was actually run, post-clamp. */
  config: TrainingConfig;
}

export interface HarnessOptions {
  cfg: TrainingConfig;
  /** Track filenames (e.g. ["CurveI.track", ...]). */
  maps: string[];
  /** Wall-clock training budget per map per seed, in seconds. */
  trainSecsPerMap: number;
  /** Number of evaluation episodes per map (after training). */
  evalEpisodesPerMap: number;
  /** Seeds to run per map. We average across seeds for noise control;
   *  the caller decides what "average" means (research_eval takes
   *  median across seeds, mean across maps). */
  seeds: number[];
  /** Optional: progress callback for live UI feedback. */
  onProgress?: (m: { map: string; seed: number; phase: "train" | "eval"; pct: number }) => void;
}

/** Replace Math.random with a Mulberry32 PRNG seeded by `s`. Returns the
 *  ORIGINAL Math.random so the caller can restore it. Mulberry32 has good
 *  statistical properties for our use (32-bit state, period 2^32) and is
 *  bit-identical across runtimes. */
function seedRandom(s: number): () => number {
  const orig = Math.random;
  let t = (s | 0) >>> 0;
  if (t === 0) t = 0x9e3779b9;
  Math.random = function () {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  return orig;
}

/**
 * Run one full episode to completion, training the agent on its trace
 * if `train` is true. Mirrors the `pickSafeAction → tick → endAndReset`
 * pattern from main.ts but compressed into a single tight loop because
 * we don't need to render anything.
 */
function runOneEpisode(
  track: LoadedTrack,
  agent: MLPAgent,
  cfg: TrainingConfig,
  train: boolean,
): { ret: number; holed: boolean; strokes: number } {
  const ep = new Episode(track, cfg);
  const trace: PolicyStep[] = [];

  while (true) {
    const state = ep.state();
    if (state.status === "awaiting_shot") {
      const action = pickSafeAction(state, ep, agent, trace, cfg);
      ep.applyShot(action);
    } else if (state.status === "in_motion") {
      // Big tick step - we don't need to animate, just advance to rest.
      // Cap iteration count so a stuck ball can't hang the run.
      let safety = 0;
      while (ep.state().status === "in_motion" && safety++ < 5000) {
        ep.tick(8);
      }
    } else {
      break; // holed or out_of_strokes
    }
  }

  const finalState = ep.state();
  const ret = episodeReturn(ep, cfg);

  if (train && trace.length > 0) {
    const stepReturns =
      agent.gamma >= 1
        ? new Array<number>(ep.strokes).fill(ret)
        : discountedPerStepReturns(ep, agent.gamma, cfg);
    agent.train(trace, stepReturns);
  }

  return {
    ret,
    holed: finalState.status === "holed",
    strokes: ep.strokes,
  };
}

function pickSafeAction(
  state: ReturnType<Episode["state"]>,
  ep: Episode,
  agent: MLPAgent,
  trace: PolicyStep[],
  cfg: TrainingConfig,
): { dx: number; dy: number } {
  const retries = cfg.safetyRetries;
  if (retries <= 0 || agent.evalMode) {
    return agent.actAndTrace(state, trace);
  }
  const learnFromRejected = cfg.learnFromRejectedShots > 0 && !agent.evalMode;
  let last = agent.sampleAction(state);
  for (let r = 0; r < retries; r++) {
    const outcome = ep.simulateShot(last.action);
    if (outcome !== "water" && outcome !== "acid") {
      agent.commitTraceStep(trace, last.step);
      return last.action;
    }
    if (learnFromRejected) {
      const syntheticReward =
        cfg.strokePenalty + (outcome === "acid" ? cfg.acidPenalty : cfg.waterPenalty);
      const gradScale = 1.0 / Math.max(1, cfg.safetyRetries);
      agent.trainPolicyOnSample(last.step, syntheticReward, gradScale);
    }
    last = agent.sampleAction(state);
  }
  agent.commitTraceStep(trace, last.step);
  return last.action;
}

async function runMapSeed(
  mapFile: string,
  seed: number,
  opts: HarnessOptions,
): Promise<MapResult> {
  const restoreRandom = seedRandom(seed);
  try {
    const track = loadTrackHeadless(mapFile);

    let hioWon = false;
    if (opts.cfg.searchHIOFirst) {
      // HIO is a brute-force pre-search. If it succeeds, the eval would
      // trivially holed-rate=1.0, which doesn't reflect policy quality
      // - it reflects the search's success. We still run it because
      // the autoresearch loop may want to keep it on, but record the
      // hioWon flag so the human can see it in the log. The
      // success-rate metric WILL count these. The bounds in
      // research_program.ts are what restrict the loop from gaming
      // this.
      const result = searchHoleInOne(track, {
        maxCandidates: 35000,
        isCancelled: () => false,
      });
      if (result) {
        hioWon = true;
        // Convert to "all eval episodes succeed in 1 stroke" without
        // having to run the policy at all.
        opts.onProgress?.({ map: mapFile, seed, phase: "train", pct: 1.0 });
        opts.onProgress?.({ map: mapFile, seed, phase: "eval", pct: 1.0 });
        return {
          map: mapFile,
          seed,
          trainSecs: 0,
          trainEpisodes: 0,
          holedCount: opts.evalEpisodesPerMap,
          evalEpisodes: opts.evalEpisodesPerMap,
          meanStrokesOnHoled: 1,
          hioWon: true,
        };
      }
    }

    const agent = new MLPAgent(opts.cfg);
    agent.setNavMap(track.pathDistMap.dist);

    // --- Training phase: run episodes until the wall-clock budget is up.
    const trainStart = performance.now();
    let trainEpisodes = 0;
    while ((performance.now() - trainStart) / 1000 < opts.trainSecsPerMap) {
      runOneEpisode(track, agent, opts.cfg, /*train=*/ true);
      trainEpisodes++;
      if (trainEpisodes % 8 === 0) {
        const pct = Math.min(1, (performance.now() - trainStart) / 1000 / opts.trainSecsPerMap);
        opts.onProgress?.({ map: mapFile, seed, phase: "train", pct });
      }
    }
    const trainSecs = (performance.now() - trainStart) / 1000;

    // --- Eval phase: turn off exploration noise, run K episodes.
    agent.evalMode = true;
    let holed = 0;
    let strokesSum = 0;
    for (let e = 0; e < opts.evalEpisodesPerMap; e++) {
      const r = runOneEpisode(track, agent, opts.cfg, /*train=*/ false);
      if (r.holed) {
        holed++;
        strokesSum += r.strokes;
      }
      if (e % 4 === 3) {
        opts.onProgress?.({
          map: mapFile,
          seed,
          phase: "eval",
          pct: (e + 1) / opts.evalEpisodesPerMap,
        });
      }
    }

    return {
      map: mapFile,
      seed,
      trainSecs,
      trainEpisodes,
      holedCount: holed,
      evalEpisodes: opts.evalEpisodesPerMap,
      meanStrokesOnHoled: holed > 0 ? strokesSum / holed : NaN,
      hioWon,
    };
  } finally {
    Math.random = restoreRandom;
  }
}

/**
 * Run the full harness: every (map × seed) combination once, sequential.
 * Returns the scalar score plus per-map detail. The score is the mean
 * holed/eval ratio across ALL trials (not median - median across seeds
 * happens at the research_eval.ts level when it averages multiple
 * harness invocations).
 */
export async function runHarness(opts: HarnessOptions): Promise<HarnessResult> {
  const wallStart = performance.now();
  const perMap: MapResult[] = [];
  for (const mapFile of opts.maps) {
    for (const seed of opts.seeds) {
      const r = await runMapSeed(mapFile, seed, opts);
      perMap.push(r);
    }
  }
  const ratioSum = perMap.reduce((s, r) => s + r.holedCount / r.evalEpisodes, 0);
  const score = ratioSum / perMap.length;
  return {
    score,
    perMap,
    totalWallSecs: (performance.now() - wallStart) / 1000,
    config: opts.cfg,
  };
}
