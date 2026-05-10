// Actor-critic agent.
//
// The big upgrades over the previous REINFORCE-only agent:
//
//   1. Value-function head V(s).
//      In addition to the policy outputs (means + log_stds), the network
//      now produces a scalar V estimating the expected return from the
//      current state. Trained against the sampled return G_t with MSE.
//      The policy uses advantage_t = G_t - V(s_t) instead of the
//      whole-batch scalar advantage. This is per-state, so within-episode
//      advantage variance drops dramatically - which is exactly what
//      bit us when we tried per-step γ-discounted returns alone.
//
//   2. Batched gradient updates.
//      Train accumulates gradients for `batchSize` episodes before
//      applying the average to the weights. With multi-env (4 episodes
//      in parallel), this is "synchronous A2C" - lower variance per
//      weight update for ~the same wall-clock time.
//
// The trace now lives OUTSIDE the agent (one trace per Episode in the
// caller) so multiple parallel episodes can each accumulate their own
// step history without colliding.

import { TILE_WIDTH, TILE_HEIGHT, MAP_PIXEL_WIDTH, PIXEL_PER_TILE } from "@minigolf/shared";
import type { ParsedMap } from "../../web/src/game/map.ts";
import type { Action, EpisodeState } from "./env.ts";
import { MLP, randn } from "./nn.ts";
import { DEFAULTS, ARCHITECTURE_KEYS, type TrainingConfig } from "./config.ts";
import { UNREACHABLE_DIST } from "./path.ts";

/** Tile-step distance at which the navigation channel saturates to 1.0.
 *  Same constant the env-side reward shaping uses (kept here so the
 *  encoder doesn't depend on path.ts internals beyond UNREACHABLE_DIST). */
const NAV_NORMALISE_BY = 60;

export interface Agent {
  act(state: EpisodeState): Action;
}

export class RandomAgent implements Agent {
  readonly maxOffset: number;
  constructor(maxOffset = 150) {
    this.maxOffset = maxOffset;
  }
  act(_state: EpisodeState): Action {
    const angle = Math.random() * Math.PI * 2;
    const mag = 20 + Math.random() * (this.maxOffset - 20);
    return { dx: Math.cos(angle) * mag, dy: Math.sin(angle) * mag };
  }
}

// --- Network shape ----------------------------------------------------------

/** Per-tile channels: (is_wall, is_hole, is_hazard). */
const GRID_CHANNELS = 3;
/** Per-ray-sample channels: (is_wall, is_hazard). The hole channel is
 *  redundant on the ray (the hole is always at the ray endpoint) so we
 *  drop it. */
const RAY_CHANNELS = 2;
/** Policy outputs: 2 means + 2 log_stds. Value head is separate W_v / b_v. */
const POLICY_OUTPUT_SIZE = 4;

/** Compute the network's input size from the architectural knobs. Used
 *  by both the agent constructor and the persistence-version check.
 *  When `useNavigation` is on, the grid gets a 4th channel for the
 *  pathfinder distance, so per-tile feature count is GRID_CHANNELS + 1. */
export function inputSizeFor(
  cfg: Pick<TrainingConfig, "gridSize" | "raySamples" | "radialRays" | "radialSamplesPerRay" | "useNavigation">,
): number {
  const gridChans = GRID_CHANNELS + (cfg.useNavigation ? 1 : 0);
  return (
    4 +
    cfg.gridSize * cfg.gridSize * gridChans +
    cfg.raySamples * RAY_CHANNELS +
    cfg.radialRays * cfg.radialSamplesPerRay * RAY_CHANNELS
  );
}

// --- Trace data -------------------------------------------------------------

export interface PolicyStep {
  input: Float32Array;
  hidden: Float32Array;
  meanX: number;
  meanY: number;
  logStdX: number;
  logStdY: number;
  actionX: number;
  actionY: number;
  /** V(s_t) at the moment the action was sampled. Cached because we need
   *  it later as the per-state baseline AND the value-MSE target's prediction. */
  value: number;
}

// --- Tile encoding ----------------------------------------------------------

/** Classify a collision-id into the (is_wall, is_hole, is_hazard) triple
 *  used by both the fine tile grid and the ball→hole ray. Out-of-map
 *  positions count as walls (the ball can't enter them).
 *
 *  Tile id buckets (matching physics.ts):
 *    walls  : 1..3, 16..23
 *    hole   : 25
 *    water  : 12, 14
 *    acid   : 13, 15
 *    mines  : 28, 30 - flagged as hazard for the encoding (ball gets
 *             redirected unpredictably) even though the reward shaping
 *             only penalises water/acid (mines have no "death" state).
 */
function classifyCid(cid: number): [number, number, number] {
  let isWall = 0;
  let isHole = 0;
  let isHazard = 0;
  if ((cid >= 1 && cid <= 3) || (cid >= 16 && cid <= 23)) isWall = 1;
  else if (cid === 25) isHole = 1;
  else if (cid >= 12 && cid <= 15) isHazard = 1;
  else if (cid === 28 || cid === 30) isHazard = 1;
  return [isWall, isHole, isHazard];
}

function tileFeatures(map: ParsedMap, tx: number, ty: number): [number, number, number] {
  if (tx < 0 || tx >= TILE_WIDTH || ty < 0 || ty >= TILE_HEIGHT) {
    return [1, 0, 0];
  }
  const px = tx * PIXEL_PER_TILE + 7;
  const py = ty * PIXEL_PER_TILE + 7;
  return classifyCid(map.collision[py * MAP_PIXEL_WIDTH + px]);
}

/** Sample the tile under an exact pixel position. Used by ray sampling
 *  where the sample points don't fall on tile centres. */
function pixelFeatures(map: ParsedMap, x: number, y: number): [number, number, number] {
  const ix = x | 0;
  const iy = y | 0;
  const tx = (ix / PIXEL_PER_TILE) | 0;
  const ty = (iy / PIXEL_PER_TILE) | 0;
  if (tx < 0 || tx >= TILE_WIDTH || ty < 0 || ty >= TILE_HEIGHT) {
    return [1, 0, 0];
  }
  const px = tx * PIXEL_PER_TILE + 7;
  const py = ty * PIXEL_PER_TILE + 7;
  return classifyCid(map.collision[py * MAP_PIXEL_WIDTH + px]);
}

// --- Agent ------------------------------------------------------------------

export class MLPAgent implements Agent {
  /** Shared trunk: input → hidden → POLICY_OUTPUT_SIZE outputs.
   *  Layer 1 (W1, b1) is shared by both heads. Layer 2 (W2, b2) is the
   *  policy head only - the value head has its own W_v / b_v below. */
  readonly net: MLP;
  /** Value head weights: hidden → 1 scalar. */
  Wv: Float32Array;
  bv: Float32Array;

  meanScale: number;
  lr: number;
  /** Coefficient for the value loss in the combined update. Smaller = the
   *  value head learns more slowly than the policy, which empirically
   *  works better than letting V dominate the shared trunk's gradient. */
  valueCoef: number;
  baseline: number; // diagnostic only - real baseline now is V(s)
  baselineLR: number;
  gradClip: number;
  gamma: number;
  evalMode = false;

  /** Number of episodes whose gradients we wait to accumulate before
   *  stepping the weights. With multi-env=4, one batch = one step every
   *  ~4 finished episodes. Higher = lower update frequency, lower variance. */
  batchSize: number;

  // Gradient accumulators - cleared after every applyBatch().
  private gW1: Float32Array;
  private gb1: Float32Array;
  private gW2: Float32Array;
  private gb2: Float32Array;
  private gWv: Float32Array;
  private gbv: Float32Array;
  private episodesAccumulated = 0;

  private map: ParsedMap | null = null;
  /** Pre-computed tile-step distance to the hole, keyed by `ty * TILE_WIDTH
   *  + tx`. Set by {@link setNavMap} on map load. Read per-tile by
   *  encodeState's 4th-channel loop when `cfg.useNavigation` is on. */
  private navDistMap: Int16Array | null = null;

  /** The full config the agent was built from. Architectural fields
   *  (gridSize, raySamples, hiddenSize) determine the network shape and
   *  must NOT be mutated on a live agent - the caller rebuilds the agent
   *  instead. Live fields (lr, gamma, reward magnitudes etc.) are
   *  free to mutate via {@link updateLiveConfig}. */
  cfg: TrainingConfig;
  /** Cached network input length, derived from cfg.gridSize / raySamples.
   *  Exposed so the persistence layer can sanity-check loaded weights. */
  readonly inputSize: number;
  /** Half-extent of the ball-centred grid. Cached because every encode
   *  needs it. */
  readonly gridHalf: number;

  constructor(cfg: Partial<TrainingConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.inputSize = inputSizeFor(this.cfg);
    this.gridHalf = (this.cfg.gridSize - 1) >> 1;
    this.net = new MLP({
      inputSize: this.inputSize,
      hiddenSize: this.cfg.hiddenSize,
      outputSize: POLICY_OUTPUT_SIZE,
    });
    this.net.b2[2] = this.cfg.initLogStd;
    this.net.b2[3] = this.cfg.initLogStd;

    // Value head - small Xavier init to match the network's Layer 2 scale.
    const sV = Math.sqrt(2 / (this.cfg.hiddenSize + 1));
    this.Wv = new Float32Array(this.cfg.hiddenSize);
    this.bv = new Float32Array(1);
    for (let i = 0; i < this.Wv.length; i++) this.Wv[i] = randn() * sV;

    this.gW1 = new Float32Array(this.net.W1.length);
    this.gb1 = new Float32Array(this.net.b1.length);
    this.gW2 = new Float32Array(this.net.W2.length);
    this.gb2 = new Float32Array(this.net.b2.length);
    this.gWv = new Float32Array(this.Wv.length);
    this.gbv = new Float32Array(this.bv.length);

    // Mirror live-tunable fields onto the agent so backprop's hot path
    // doesn't dereference cfg every iteration.
    this.meanScale = this.cfg.meanScale;
    this.lr = this.cfg.lr;
    this.valueCoef = this.cfg.valueCoef;
    this.baselineLR = 0.05;
    this.baseline = 0;
    this.gradClip = this.cfg.gradClip;
    this.gamma = this.cfg.gamma;
    this.batchSize = this.cfg.batchSize;
  }

  /** Apply a non-architectural config change to a running agent. Returns
   *  false (and refuses to apply) if any architectural field changed -
   *  the caller must rebuild the agent in that case. */
  updateLiveConfig(next: TrainingConfig): boolean {
    for (const k of ARCHITECTURE_KEYS) {
      if (next[k] !== this.cfg[k]) return false;
    }
    this.cfg = { ...next };
    this.meanScale = next.meanScale;
    this.lr = next.lr;
    this.valueCoef = next.valueCoef;
    this.gradClip = next.gradClip;
    this.gamma = next.gamma;
    this.batchSize = next.batchSize;
    // initLogStd intentionally NOT applied retroactively - it's an
    // initial-condition for new agents, not a live policy parameter.
    // logStdMin/Max ARE live: they clamp on every forward pass.
    return true;
  }

  setMap(map: ParsedMap): void {
    this.map = map;
  }

  /** Install the pathfinder distance map. Pass `null` to clear. The
   *  encoder reads this only when `cfg.useNavigation` is on. */
  setNavMap(distMap: Int16Array | null): void {
    this.navDistMap = distMap;
  }

  encodeState(state: EpisodeState): Float32Array {
    const arr = new Float32Array(this.inputSize);
    arr[0] = state.ballX / 367.5 - 1;
    arr[1] = state.ballY / 187.5 - 1;
    arr[2] = state.holeX / 367.5 - 1;
    arr[3] = state.holeY / 187.5 - 1;
    let off = 4;
    if (this.map) {
      // Ball-centred fine tile grid (immediate surroundings). Out-of-map
      // cells encode as walls in `tileFeatures`, so any grid size from 3
      // up to 2*TILE_WIDTH-1 is safe near the edges - the padding just
      // tells the network "you can't go that way".
      const tx0 = Math.floor(state.ballX / PIXEL_PER_TILE);
      const ty0 = Math.floor(state.ballY / PIXEL_PER_TILE);
      const half = this.gridHalf;
      const navOn = this.cfg.useNavigation > 0 && this.navDistMap !== null;
      const distMap = this.navDistMap;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const f = tileFeatures(this.map, tx0 + dx, ty0 + dy);
          arr[off++] = f[0];
          arr[off++] = f[1];
          arr[off++] = f[2];
          if (navOn) {
            // 4th channel: pathfinder distance to hole, normalised.
            // Out-of-map / unreachable tiles read as 1.0 ("stay away");
            // tiles closer to the hole read as smaller numbers, so the
            // policy can follow the gradient downhill.
            const tx = tx0 + dx;
            const ty = ty0 + dy;
            let nv = 1.0;
            if (tx >= 0 && tx < TILE_WIDTH && ty >= 0 && ty < TILE_HEIGHT) {
              const d = distMap![ty * TILE_WIDTH + tx];
              if (d < UNREACHABLE_DIST) {
                nv = d >= NAV_NORMALISE_BY ? 1.0 : d / NAV_NORMALISE_BY;
              }
            }
            arr[off++] = nv;
          }
        }
      }
      // Ball→hole ray. Samples evenly between ball and hole (excluding the
      // endpoints) and reports (is_wall, is_hazard) per sample. Lets the
      // policy answer "is there water/wall in the straight-line path I'd
      // take if I aimed at the hole?" - the single most relevant question
      // for "should I aim at full power towards the hole".
      const rayCount = this.cfg.raySamples;
      if (rayCount > 0) {
        const dx = state.holeX - state.ballX;
        const dy = state.holeY - state.ballY;
        for (let s = 0; s < rayCount; s++) {
          const t = (s + 1) / (rayCount + 1);
          const f = pixelFeatures(
            this.map,
            state.ballX + dx * t,
            state.ballY + dy * t,
          );
          arr[off++] = f[0]; // is_wall
          arr[off++] = f[2]; // is_hazard
        }
      }
      // Radial rays: fixed compass directions from the ball, with N
      // samples per ray. Lets the policy see "this direction is clear,
      // that direction is water" without committing to ball→hole as the
      // only path. Crucial when water sits between the ball and the hole.
      const ringCount = this.cfg.radialRays;
      if (ringCount > 0) {
        const samplesPerRay = this.cfg.radialSamplesPerRay;
        const maxDist = this.cfg.radialRayMaxDist;
        for (let r = 0; r < ringCount; r++) {
          const angle = (r * 2 * Math.PI) / ringCount;
          const dirX = Math.cos(angle);
          const dirY = Math.sin(angle);
          for (let s = 0; s < samplesPerRay; s++) {
            const dist = ((s + 1) / samplesPerRay) * maxDist;
            const f = pixelFeatures(
              this.map,
              state.ballX + dirX * dist,
              state.ballY + dirY * dist,
            );
            arr[off++] = f[0]; // is_wall
            arr[off++] = f[2]; // is_hazard
          }
        }
      }
    } else {
      const gridChans = GRID_CHANNELS + (this.cfg.useNavigation > 0 ? 1 : 0);
      off += this.cfg.gridSize * this.cfg.gridSize * gridChans +
             this.cfg.raySamples * RAY_CHANNELS +
             this.cfg.radialRays * this.cfg.radialSamplesPerRay * RAY_CHANNELS;
    }
    return arr;
  }

  /** Forward pass through both heads. Returns hidden so the caller can
   *  cache it on the trace (needed for backprop's W2/Wv gradients). */
  private forward(input: Float32Array): {
    hidden: Float32Array;
    policy: Float32Array;
    value: number;
  } {
    const { hidden, output } = this.net.forward(input);
    let v = this.bv[0];
    for (let j = 0; j < this.cfg.hiddenSize; j++) v += hidden[j] * this.Wv[j];
    return { hidden, policy: output, value: v };
  }

  /** Plain Action sample - for eval mode and the intent arrow. Doesn't
   *  record anything; doesn't allocate trace memory. */
  act(state: EpisodeState): Action {
    const input = this.encodeState(state);
    const { policy } = this.forward(input);
    const meanX = policy[0] * this.meanScale;
    const meanY = policy[1] * this.meanScale;
    if (this.evalMode) return { dx: meanX, dy: meanY };
    const stdX = Math.exp(clamp(policy[2], this.cfg.logStdMin, this.cfg.logStdMax));
    const stdY = Math.exp(clamp(policy[3], this.cfg.logStdMin, this.cfg.logStdMax));
    return { dx: meanX + stdX * randn(), dy: meanY + stdY * randn() };
  }

  /** Sample an action and produce the trace step that WOULD be appended
   *  if this sample is accepted. Used by the safety filter to draw and
   *  sandbox-simulate multiple candidates per stroke without polluting
   *  the trace with rejected samples. The caller calls
   *  {@link commitTraceStep} once it picks one. */
  sampleAction(state: EpisodeState): { action: Action; step: PolicyStep } {
    const input = this.encodeState(state);
    const { hidden, policy, value } = this.forward(input);
    const meanX = policy[0] * this.meanScale;
    const meanY = policy[1] * this.meanScale;
    const logStdX = clamp(policy[2], this.cfg.logStdMin, this.cfg.logStdMax);
    const logStdY = clamp(policy[3], this.cfg.logStdMin, this.cfg.logStdMax);

    if (this.evalMode) {
      // Eval mode uses zero noise.
      return {
        action: { dx: meanX, dy: meanY },
        step: {
          input, hidden,
          meanX, meanY, logStdX, logStdY,
          actionX: meanX, actionY: meanY,
          value,
        },
      };
    }

    const stdX = Math.exp(logStdX);
    const stdY = Math.exp(logStdY);
    const actionX = meanX + stdX * randn();
    const actionY = meanY + stdY * randn();
    return {
      action: { dx: actionX, dy: actionY },
      step: {
        input, hidden,
        meanX, meanY, logStdX, logStdY,
        actionX, actionY,
        value,
      },
    };
  }

  /** Append a previously-sampled step to a trace buffer. */
  commitTraceStep(trace: PolicyStep[], step: PolicyStep): void {
    trace.push(step);
  }

  /**
   * Apply a single-sample policy gradient with a synthetic reward,
   * bypassing the value-head update and the batch counter. Used by the
   * safety filter to teach the policy "don't sample like that" without
   * wasting the simulated knowledge.
   *
   * The math: the action `step.actionX/Y` was actually drawn from
   * π(s; θ), so its log-prob has a real gradient ∇θ log π. We score it
   * with the *would-have-been* reward (water/acid penalty) instead of
   * the actual return. That pushes π away from sampling there in the
   * future - exactly the correction we'd get from REINFORCE if we'd
   * really taken the shot, except we don't pay for it in real episode
   * strokes.
   *
   * What we DON'T do here:
   *   - Update V(s). V tracks the expected return *under the filtered
   *     policy* (the rollouts we actually run). Synthetic samples
   *     would bias it downward toward the unfiltered estimate.
   *   - Increment `episodesAccumulated`. These are sub-episode
   *     samples; they shouldn't trigger an early batch-apply.
   *
   * The accumulated gradients ride along with the next real episode's
   * `train()` call, applied together by `applyBatch()`.
   */
  trainPolicyOnSample(
    step: PolicyStep,
    syntheticReward: number,
    gradScale: number = 1.0,
  ): void {
    const { inputSize, hiddenSize, outputSize } = this.net.spec;
    // gradScale lets the caller dilute the gradient so a stroke with
    // many rejected samples doesn't outweigh a single accepted episode
    // step. With safetyRetries=10 and gradScale=1/10, all rejections
    // for a stroke together contribute about as much as one real step.
    const advantage = (syntheticReward - step.value) * gradScale;

    const stdX = Math.exp(step.logStdX);
    const stdY = Math.exp(step.logStdY);
    const sigma2X = stdX * stdX;
    const sigma2Y = stdY * stdY;
    const dx = step.actionX - step.meanX;
    const dy = step.actionY - step.meanY;

    const dLdPolicy: [number, number, number, number] = [
      (dx * this.meanScale) / sigma2X,
      (dy * this.meanScale) / sigma2Y,
      (dx * dx) / sigma2X - 1,
      (dy * dy) / sigma2Y - 1,
    ];

    const dLdHidden = new Float32Array(hiddenSize);
    for (let k = 0; k < outputSize; k++) {
      const w = advantage * dLdPolicy[k];
      this.gb2[k] += w;
      for (let j = 0; j < hiddenSize; j++) {
        this.gW2[j * outputSize + k] += w * step.hidden[j];
        dLdHidden[j] +=
          dLdPolicy[k] * this.net.W2[j * outputSize + k] * advantage;
      }
    }
    // Through tanh.
    for (let j = 0; j < hiddenSize; j++) {
      const h = step.hidden[j];
      dLdHidden[j] *= 1 - h * h;
    }
    // Layer 1.
    for (let j = 0; j < hiddenSize; j++) {
      this.gb1[j] += dLdHidden[j];
      for (let i = 0; i < inputSize; i++) {
        this.gW1[i * hiddenSize + j] += dLdHidden[j] * step.input[i];
      }
    }
  }

  /** Same as act() but ALSO appends a PolicyStep to `trace` so the caller
   *  can train on this rollout afterwards. The agent itself holds NO
   *  trace state - the caller owns the buffer, which lets multiple
   *  parallel episodes track separate histories. */
  actAndTrace(state: EpisodeState, trace: PolicyStep[]): Action {
    const { action, step } = this.sampleAction(state);
    this.commitTraceStep(trace, step);
    return action;
  }

  mean(state: EpisodeState): { dx: number; dy: number } {
    const input = this.encodeState(state);
    const { policy } = this.forward(input);
    return {
      dx: policy[0] * this.meanScale,
      dy: policy[1] * this.meanScale,
    };
  }

  currentMeanStd(state: EpisodeState): { sx: number; sy: number } {
    const input = this.encodeState(state);
    const { policy } = this.forward(input);
    return {
      sx: Math.exp(clamp(policy[2], this.cfg.logStdMin, this.cfg.logStdMax)),
      sy: Math.exp(clamp(policy[3], this.cfg.logStdMin, this.cfg.logStdMax)),
    };
  }

  /**
   * Add this episode's gradients to the running batch accumulator. When
   * `batchSize` episodes have been accumulated, applies the averaged
   * update. Returns true if a weight update was applied this call.
   *
   * `returns[t]` = G_t (per-step future-discounted return). For γ=1 this
   * is the same scalar repeated across the episode (constant return); for
   * γ<1 it's the proper discounted future from each step. The V baseline
   * makes per-step variance OK either way - the policy gradient now uses
   * (G_t - V(s_t)) rather than (G_t - constant).
   */
  train(trace: PolicyStep[], returns: number[]): boolean {
    if (trace.length === 0 || returns.length !== trace.length) return false;

    // Update the diagnostic scalar baseline (only used for the UI readout).
    let meanRet = 0;
    for (const r of returns) meanRet += r;
    meanRet /= returns.length;
    this.baseline += this.baselineLR * (meanRet - this.baseline);

    const { inputSize, hiddenSize, outputSize } = this.net.spec;

    for (let t = 0; t < trace.length; t++) {
      const step = trace[t];
      const G = returns[t];
      // Per-state advantage. THIS is the actor-critic improvement: the
      // baseline is V(s_t), specific to this state, instead of a global
      // running mean. A bad action that landed in a bad state is
      // recognised as bad-given-the-state, not bad-in-general.
      const advantage = G - step.value;

      const stdX = Math.exp(step.logStdX);
      const stdY = Math.exp(step.logStdY);
      const sigma2X = stdX * stdX;
      const sigma2Y = stdY * stdY;
      const dx = step.actionX - step.meanX;
      const dy = step.actionY - step.meanY;

      // Policy output gradients (4 values: μ_x, μ_y, log_std_x, log_std_y).
      const dLdPolicy: [number, number, number, number] = [
        (dx * this.meanScale) / sigma2X,
        (dy * this.meanScale) / sigma2Y,
        (dx * dx) / sigma2X - 1,
        (dy * dy) / sigma2Y - 1,
      ];

      // Value head gradient direction: ascend on -(V-G)² → +(G-V) (factor
      // of 2 absorbed into valueCoef). Pushes V toward G.
      const dLdValue = G - step.value;

      // Layer 2: combined hidden gradient = policy contribution + value
      // contribution. Both heads share the trunk through `hidden`.
      const dLdHidden = new Float32Array(hiddenSize);
      for (let k = 0; k < outputSize; k++) {
        const w = advantage * dLdPolicy[k];
        this.gb2[k] += w;
        for (let j = 0; j < hiddenSize; j++) {
          this.gW2[j * outputSize + k] += w * step.hidden[j];
          dLdHidden[j] += dLdPolicy[k] * this.net.W2[j * outputSize + k] * advantage;
        }
      }
      // Value head:
      const wv = this.valueCoef * dLdValue;
      this.gbv[0] += wv;
      for (let j = 0; j < hiddenSize; j++) {
        this.gWv[j] += wv * step.hidden[j];
        dLdHidden[j] += this.valueCoef * dLdValue * this.Wv[j];
      }

      // Through tanh.
      for (let j = 0; j < hiddenSize; j++) {
        const h = step.hidden[j];
        dLdHidden[j] *= 1 - h * h;
      }

      // Layer 1.
      for (let j = 0; j < hiddenSize; j++) {
        this.gb1[j] += dLdHidden[j];
        for (let i = 0; i < inputSize; i++) {
          this.gW1[i * hiddenSize + j] += dLdHidden[j] * step.input[i];
        }
      }
    }

    this.episodesAccumulated++;
    if (this.episodesAccumulated >= this.batchSize) {
      this.applyBatch();
      return true;
    }
    return false;
  }

  /** Apply averaged accumulated gradients and clear the buffers. */
  private applyBatch(): void {
    const inv = 1 / this.episodesAccumulated;
    const c = this.gradClip;
    scaleAndClip(this.gW1, inv, c);
    scaleAndClip(this.gb1, inv, c);
    scaleAndClip(this.gW2, inv, c);
    scaleAndClip(this.gb2, inv, c);
    scaleAndClip(this.gWv, inv, c);
    scaleAndClip(this.gbv, inv, c);

    for (let i = 0; i < this.net.W1.length; i++) this.net.W1[i] += this.lr * this.gW1[i];
    for (let i = 0; i < this.net.b1.length; i++) this.net.b1[i] += this.lr * this.gb1[i];
    for (let i = 0; i < this.net.W2.length; i++) this.net.W2[i] += this.lr * this.gW2[i];
    for (let i = 0; i < this.net.b2.length; i++) this.net.b2[i] += this.lr * this.gb2[i];
    for (let i = 0; i < this.Wv.length; i++) this.Wv[i] += this.lr * this.gWv[i];
    for (let i = 0; i < this.bv.length; i++) this.bv[i] += this.lr * this.gbv[i];

    this.gW1.fill(0);
    this.gb1.fill(0);
    this.gW2.fill(0);
    this.gb2.fill(0);
    this.gWv.fill(0);
    this.gbv.fill(0);
    this.episodesAccumulated = 0;
  }

  /** Diagnostic - how many episodes are sitting in the batch buffer. */
  get pendingBatchSize(): number {
    return this.episodesAccumulated;
  }

  /** Snapshot the network's parameters into JSON-friendly arrays. Used by
   *  the persistence layer to save trained policies to localStorage. */
  toSerialized(): {
    W1: number[]; b1: number[];
    W2: number[]; b2: number[];
    Wv: number[]; bv: number[];
    inputSize: number; hiddenSize: number; outputSize: number;
  } {
    return {
      W1: Array.from(this.net.W1),
      b1: Array.from(this.net.b1),
      W2: Array.from(this.net.W2),
      b2: Array.from(this.net.b2),
      Wv: Array.from(this.Wv),
      bv: Array.from(this.bv),
      inputSize: this.net.spec.inputSize,
      hiddenSize: this.net.spec.hiddenSize,
      outputSize: this.net.spec.outputSize,
    };
  }

  /** Replace the agent's parameters with a previously-saved snapshot.
   *  Returns false if dimensions don't match (architecture changed since
   *  the save was created). On success, also clears any in-flight batch
   *  gradients so the loaded weights aren't immediately overwritten. */
  loadSerialized(s: {
    W1: number[]; b1: number[];
    W2: number[]; b2: number[];
    Wv: number[]; bv: number[];
    inputSize: number; hiddenSize: number; outputSize: number;
  }): boolean {
    if (s.inputSize !== this.net.spec.inputSize) return false;
    if (s.hiddenSize !== this.net.spec.hiddenSize) return false;
    if (s.outputSize !== this.net.spec.outputSize) return false;
    if (s.W1.length !== this.net.W1.length) return false;
    if (s.b1.length !== this.net.b1.length) return false;
    if (s.W2.length !== this.net.W2.length) return false;
    if (s.b2.length !== this.net.b2.length) return false;
    if (s.Wv.length !== this.Wv.length) return false;
    if (s.bv.length !== this.bv.length) return false;
    this.net.W1.set(s.W1);
    this.net.b1.set(s.b1);
    this.net.W2.set(s.W2);
    this.net.b2.set(s.b2);
    this.Wv.set(s.Wv);
    this.bv.set(s.bv);
    // Drop any partial batch - it was computed against the old (random) weights.
    this.gW1.fill(0);
    this.gb1.fill(0);
    this.gW2.fill(0);
    this.gb2.fill(0);
    this.gWv.fill(0);
    this.gbv.fill(0);
    this.episodesAccumulated = 0;
    return true;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function scaleAndClip(arr: Float32Array, scale: number, c: number): void {
  for (let i = 0; i < arr.length; i++) {
    let v = arr[i] * scale;
    if (v > c) v = c;
    else if (v < -c) v = -c;
    arr[i] = v;
  }
}
