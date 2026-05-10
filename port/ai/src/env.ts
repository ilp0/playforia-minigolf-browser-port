// The "environment" in RL terms: a stateful wrapper around one episode of play.
//
// One episode = one round on a fixed map, from start until the ball is in the
// hole or we hit the stroke budget. Phase 1 just exposes the rollout machinery;
// the network plugs in by replacing `pickAction` (currently a random agent).
//
// Why stateful and not a tight loop: we want the simulation to be drivable by
// a requestAnimationFrame loop so users can watch each stroke play out. The
// `tick(steps)` method advances physics by N substeps per browser frame -
// passing a large N renders the whole episode "instantly" for fast training,
// while N=3 (~166Hz / 60Hz) plays back at original game speed.

import { Seed, PIXEL_PER_TILE, TILE_WIDTH, TILE_HEIGHT } from "@minigolf/shared";
import {
  newBall,
  applyStrokeImpulse,
  step,
  type BallState,
  type PhysicsContext,
} from "../../web/src/game/physics.ts";
import { colAt, type ParsedMap } from "../../web/src/game/map.ts";
import type { LoadedTrack } from "./loader.ts";
import { UNREACHABLE_DIST } from "./path.ts";

/**
 * Deep-clone the mutable parts of a ParsedMap so a copy can be mutated
 * by physics without affecting the original.
 *
 * Why this matters: physics calls `mutateTile` when the ball hits a
 * brick (40..43, decays through shapes), pushes a movable block (27),
 * triggers a mine (28/30 → 29/31), or sinks a sunkable block (46 → 47).
 * Those mutations write to `map.collision`, `map.tiles`, and
 * `map.dirtyTiles`. If multiple Episodes share a single ParsedMap
 * reference, mutations from one run leak into the next - the second
 * episode starts with bricks already broken, mines already detonated,
 * etc. Cloning per Episode and per simulateShot fixes that.
 *
 * The shareable fields (`atlases`, `magnetMap`, `startPositions`,
 * `resetPositions`, `teleportStarts`, `teleportExits`) are read-only
 * during physics, so we keep them as references and don't pay to clone
 * them. Cost is dominated by the 275 KB Uint8Array for `collision`,
 * which `new Uint8Array(src)` does in roughly 100 µs.
 */
export function cloneMap(map: ParsedMap): ParsedMap {
  return {
    ...map,
    tiles: map.tiles.map((col) => col.slice()),
    collision: new Uint8Array(map.collision),
    dirtyTiles: [],
  };
}

export type EpisodeStatus =
  | "awaiting_shot"
  | "in_motion"
  | "holed"
  | "out_of_strokes";

/**
 * Per-stroke outcome label - drives reward shaping. The agent learns
 * "this kind of stroke is bad" instead of just "this episode used too
 * many strokes".
 *
 *   normal  - ball came to rest on safe ground (or out_of_strokes timeout)
 *   water   - ball sat on water (12 or 14) long enough to be teleported
 *             back to the stroke start (waterEvent=0). Functionally a
 *             wasted stroke - the agent's input post-stroke is identical
 *             to its input pre-stroke, so without explicit shaping the
 *             policy has no gradient pulling it off "full speed into water".
 *   acid    - ball sat on acid (13 or 15) and got reset to the track
 *             start. Strictly worse than water because it can undo prior
 *             progress, so we penalise it more heavily.
 *   holed   - the holing stroke. The episode terminator.
 */
export type StrokeOutcome = "normal" | "water" | "acid" | "holed";

export interface Action {
  /** Mouse offset from ball: physics computes velocity from (mouseX, mouseY)
   *  where mouse = ball + (dx, dy). Magnitude controls power, direction
   *  controls aim. Magnitudes between ~5 and ~200 pixels map to the full
   *  power range; outside that range physics clamps. */
  dx: number;
  dy: number;
}

export interface EpisodeState {
  ballX: number;
  ballY: number;
  holeX: number;
  holeY: number;
  /** Strokes used so far in this episode. */
  strokesUsed: number;
  status: EpisodeStatus;
}

/**
 * Reward magnitudes for one stroke. Configurable per-map via the training
 * config UI - these defaults are pedagogical starting points.
 *
 *   strokePenalty: per-stroke baseline. -1 drives the agent toward fewer
 *                  strokes regardless of outcome.
 *   holeBonus    : added on the holing stroke.
 *   waterPenalty : added when the stroke ended in water (12/14). Without
 *                  this, water-shots and grass-shots produce identical
 *                  (state, next_state, reward) tuples and the policy has
 *                  no gradient pulling it off "full speed at water".
 *   acidPenalty  : added when the stroke ended in acid (13/15). Strictly
 *                  worse than water - acid resets to the track start.
 *
 * With defaults: hole-in-1 = -1 + 20 = 19; 5-stroke clean hole = 15;
 * 30-stroke timeout with no hazards = -30; 30-stroke timeout with 10
 * water shots = -30 - 30 = -60.
 */
export interface RewardMagnitudes {
  strokePenalty: number;
  holeBonus: number;
  waterPenalty: number;
  acidPenalty: number;
  /** Coefficient on the per-stroke "got closer to the hole" bonus. The
   *  Episode records the raw delta-distance (`strokeShapingDeltas`); the
   *  reward function multiplies that by this coefficient. 0 disables
   *  shaping (the original behaviour). */
  progressBonus: number;
  /** Coefficient on the per-stroke "got further from the start" bonus.
   *  Multiplied by `strokeExplorationDeltas`. 0 disables. */
  explorationBonus: number;
}

export const DEFAULT_REWARDS: RewardMagnitudes = {
  strokePenalty: -1,
  holeBonus: 20,
  waterPenalty: -3,
  acidPenalty: -6,
  progressBonus: 0,
  explorationBonus: 0,
};

/** Per-stroke reward without discounting - the building block both
 *  `episodeReturn` and `discountedPerStepReturns` use.
 *
 *  - `progDelta`: pixels closer to the hole this stroke (path-distance
 *    when available, straight-line otherwise). Multiplied by progressBonus.
 *  - `expDelta`: pixels further from the track start this stroke.
 *    Multiplied by explorationBonus. */
function strokeReward(
  outcome: StrokeOutcome,
  progDelta: number,
  expDelta: number,
  r: RewardMagnitudes,
): number {
  const shaping = r.progressBonus * progDelta + r.explorationBonus * expDelta;
  switch (outcome) {
    case "holed":
      return r.strokePenalty + r.holeBonus + shaping;
    case "water":
      return r.strokePenalty + r.waterPenalty + shaping;
    case "acid":
      return r.strokePenalty + r.acidPenalty + shaping;
    case "normal":
      return r.strokePenalty + shaping;
  }
}

/** Pad strokeOutcomes to length `n` with "normal" so reward calculations
 *  are well-defined even when the user resets mid-stroke (the trace already
 *  contains the in-flight step's PolicyStep but the Episode hasn't seen
 *  the stroke settle yet). Treating truncated strokes as "normal" matches
 *  the old single-scalar behaviour for resets. */
function paddedOutcomes(episode: Episode, n: number): StrokeOutcome[] {
  const out = episode.strokeOutcomes.slice();
  while (out.length < n) out.push("normal");
  return out;
}

/** Pad a delta array to length `n` with 0 (no progress recorded for an
 *  unfinished/truncated stroke). */
function paddedDeltas(arr: readonly number[], n: number): number[] {
  const out = arr.slice();
  while (out.length < n) out.push(0);
  return out;
}

/**
 * Total undiscounted episode reward (the scalar shown in the chart and
 * "mean R(50)" readout). With no hazards this is identical to the old
 * formula; with hazards it deducts the per-stroke water/acid penalties.
 */
export function episodeReturn(
  episode: Episode,
  rewards: RewardMagnitudes = DEFAULT_REWARDS,
): number {
  const n = episode.strokes;
  const outcomes = paddedOutcomes(episode, n);
  const progDeltas = paddedDeltas(episode.strokeShapingDeltas, n);
  const expDeltas = paddedDeltas(episode.strokeExplorationDeltas, n);
  let r = 0;
  for (let i = 0; i < n; i++) {
    r += strokeReward(outcomes[i], progDeltas[i], expDeltas[i], rewards);
  }
  return r;
}

/**
 * Per-step discounted returns (the "G_t" in classical RL notation).
 *
 *   r_t  = strokeReward(outcomes[t])
 *   G_t  = r_t + γ·r_{t+1} + γ²·r_{t+2} + ...
 *
 * Each stroke gets credited with its FUTURE return, not the whole-episode
 * sum. So a holing-shot at step N gets the full +19 (or hazard penalty
 * if missed), while step 1's contribution to that hole is dampened by
 * γ^(N-1).
 *
 * Why this matters vs the single-scalar version: when an episode ends with
 * a holed shot at step 8 of 30, with the scalar version every one of those
 * 8 strokes (including unhelpful ones) gets the same credit. With per-step
 * returns, the early strokes receive less credit (γ-attenuated) and the
 * late strokes more - better credit assignment, lower variance.
 *
 * γ = 1 reduces this to "future cumulative reward" with no time-decay.
 * γ = 0.99 over 30 steps leaves the earliest stroke at 74% strength -
 * mild but meaningful weighting toward later actions.
 */
export function discountedPerStepReturns(
  episode: Episode,
  gamma: number,
  rewards: RewardMagnitudes = DEFAULT_REWARDS,
): number[] {
  const n = episode.strokes;
  if (n === 0) return [];
  const outcomes = paddedOutcomes(episode, n);
  const progDeltas = paddedDeltas(episode.strokeShapingDeltas, n);
  const expDeltas = paddedDeltas(episode.strokeExplorationDeltas, n);
  const stepRewards = outcomes.map((o, i) =>
    strokeReward(o, progDeltas[i], expDeltas[i], rewards),
  );
  const returns = new Array<number>(n);
  let g = 0;
  for (let t = n - 1; t >= 0; t--) {
    g = stepRewards[t] + gamma * g;
    returns[t] = g;
  }
  return returns;
}

/**
 * Convergence test, shared by the single-map view and the grid view.
 *
 * The previous rule was just "success >= 90% over the last 50 episodes",
 * which fired prematurely on maps where the policy had settled in a
 * mediocre but reliable local minimum - e.g. always holes in 3 strokes
 * on a map where 1 or 2 is provably possible. The agent looked done,
 * training auto-paused, but the policy wasn't actually near optimal.
 *
 * When the track metadata carries `par` (the best human score on record),
 * we use it as an objective optimum: the agent must have found at least
 * one trajectory matching the human record before we call it converged.
 * Stochastic noise reliably finds the optimum once the policy mean is in
 * the right neighbourhood, so requiring `bestStrokes <= par` protects
 * against the "stuck at 3 strokes" pattern without being unreasonable.
 *
 * When `par` is unavailable (some legacy tracks have `bestPar === 0`),
 * we fall back to the success-rate-only rule.
 */
export interface ConvergenceInputs {
  /** Recent rolling-window success rate, in [0, 1]. */
  success: number;
  /** Total episodes finished on this map (any result). */
  lifetimeReturnsCount: number;
  /** Number of recent episodes contributing to the rolling window. */
  recentSuccessCount: number;
  /** Best stroke count achieved so far on this map. `Infinity` if no
   *  successful run yet. */
  bestStrokes: number;
  /** Human record from the original Playforia database, in strokes.
   *  `0` means "no record on file"; anything > 0 is treated as the
   *  optimum the agent should match before we declare it converged. */
  par: number;
}

export function isConverged(c: ConvergenceInputs): boolean {
  if (c.lifetimeReturnsCount < 30) return false;
  if (c.recentSuccessCount < 50) return false;
  if (c.success < 0.9) return false;
  if (c.par > 0 && c.bestStrokes > c.par) return false;
  return true;
}

export class Episode {
  readonly track: LoadedTrack;
  readonly maxStrokes: number;
  private readonly ball: BallState;
  private readonly ctx: PhysicsContext;
  strokes = 0;
  status: EpisodeStatus = "awaiting_shot";
  /** Sampled positions the ball has visited this episode - used for the trail. */
  readonly trail: Array<{ x: number; y: number; stroke: number }> = [];
  /** Each stroke's start point and applied (dx, dy) for visualization. */
  readonly shots: Array<{
    fromX: number;
    fromY: number;
    dx: number;
    dy: number;
  }> = [];
  /** One entry per finished stroke. Set when the stroke comes to rest;
   *  consumed by reward shaping. Length always equals `this.strokes` once
   *  the in-flight stroke has settled. */
  readonly strokeOutcomes: StrokeOutcome[] = [];
  /** Raw "got closer to the hole" amount in pixels for each finished
   *  stroke: `distToHole_at_stroke_start − distToHole_at_stroke_end`.
   *  When the track has a pathfinder distance map, this uses the
   *  pathfinder distance (in pixels of tile-step) instead of crow-flies,
   *  so detours around water count correctly as forward progress.
   *  Positive = ball got closer; negative = drifted away. The reward
   *  function multiplies by `progressBonus`. */
  readonly strokeShapingDeltas: number[] = [];
  /** Raw "got further from the track start" amount in pixels for each
   *  finished stroke. The reward function multiplies by
   *  `explorationBonus`. Useful when the policy collapses to "do
   *  nothing" - any direction of movement away from start nets a
   *  positive shaping signal, breaking the local minimum. */
  readonly strokeExplorationDeltas: number[] = [];
  /** Ball position at the moment `applyShot` was called for this stroke
   *  (BEFORE applyStrokeImpulse - the impulse can theoretically nudge x/y,
   *  so we capture the pristine pre-impulse position for shaping math). */
  private strokeStartX = 0;
  private strokeStartY = 0;
  /** Per-stroke flags accumulated during physics ticks. Reset on each new
   *  applyShot. They become the StrokeOutcome when the ball stops. */
  private touchedWater = false;
  private touchedAcid = false;

  constructor(track: LoadedTrack, opts: { maxStrokes?: number; seed?: number } = {}) {
    this.track = track;
    this.maxStrokes = opts.maxStrokes ?? 30;
    this.ball = newBall(track.startX, track.startY);
    this.ctx = {
      // Each episode owns its own map so brick/movable/mine/sunkable
      // mutations don't leak into the next episode (or into other parallel
      // rollouts in multi-env training). The track keeps the canonical
      // never-mutated original.
      map: cloneMap(track.map),
      seed: new Seed(opts.seed ?? 1),
      // For the AI loop we want shots to be deterministic given an action -
      // the random "dispersion" in applyStrokeImpulse would otherwise be
      // an extra noise source on top of the policy's own sampling.
      norandom: true,
      waterEvent: 0,
      startX: track.startX,
      startY: track.startY,
      otherPlayers: [],
      collisionMode: 0,
      peers: [],
      myIdx: 0,
    };
    this.trail.push({ x: this.ball.x, y: this.ball.y, stroke: 0 });
  }

  /** Distance (in pixels) from a point to the hole. Uses the track's
   *  pathfinder distance map when present, scaled from tile-steps to
   *  pixels so it's comparable to straight-line. Out-of-map / unreachable
   *  positions fall back to straight-line distance, which is a graceful
   *  degradation (caller still gets a useful number). */
  private distToHole(x: number, y: number): number {
    const distMap = this.track.pathDistMap?.dist;
    if (distMap) {
      const tx = Math.floor(x / PIXEL_PER_TILE);
      const ty = Math.floor(y / PIXEL_PER_TILE);
      if (tx >= 0 && tx < TILE_WIDTH && ty >= 0 && ty < TILE_HEIGHT) {
        const d = distMap[ty * TILE_WIDTH + tx];
        if (d < UNREACHABLE_DIST) return d * PIXEL_PER_TILE;
      }
    }
    const dx = x - this.track.holeX;
    const dy = y - this.track.holeY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  state(): EpisodeState {
    return {
      ballX: this.ball.x,
      ballY: this.ball.y,
      holeX: this.track.holeX,
      holeY: this.track.holeY,
      strokesUsed: this.strokes,
      status: this.status,
    };
  }

  /** Apply an action. Only valid in `awaiting_shot`. */
  applyShot(action: Action): void {
    if (this.status !== "awaiting_shot") return;
    // Capture the pre-impulse position for reward shaping. Doing this
    // BEFORE applyStrokeImpulse keeps the shaping math correct even if
    // the impulse function mutates ball.x/y internally.
    this.strokeStartX = this.ball.x;
    this.strokeStartY = this.ball.y;
    const mouseX = this.ball.x + action.dx;
    const mouseY = this.ball.y + action.dy;
    applyStrokeImpulse(this.ball, this.ctx, mouseX, mouseY);
    this.shots.push({
      fromX: this.ball.x,
      fromY: this.ball.y,
      dx: action.dx,
      dy: action.dy,
    });
    this.strokes++;
    this.touchedWater = false;
    this.touchedAcid = false;
    this.status = "in_motion";
  }

  /**
   * Run a hypothetical shot in a sandbox copy of the ball + physics
   * context, return the StrokeOutcome it WOULD produce, and discard the
   * sandbox. Used by the safety filter to reject actions that would
   * end with the ball drowning in water/acid before we commit them.
   *
   * Crossing water mid-roll is fine and reported as "normal" - we only
   * call it "water"/"acid" if the ball came to rest in liquid (the same
   * condition real `tick()` uses to bump `strokeOutcomes`).
   *
   * Cost: one full stroke of physics. With `norandom: true` the result
   * is deterministic given (ballState, action), so the filter never
   * disagrees with what the real shot will do.
   */
  simulateShot(action: Action): StrokeOutcome {
    if (this.status !== "awaiting_shot") return "normal";
    const sim: BallState = { ...this.ball };
    // Sandbox the simulation in its own clone of the map and physics
    // context. Otherwise, a sandbox shot that breaks a brick / detonates
    // a mine / pushes a movable block would mutate the real episode's
    // map - and consecutive simulateShot calls (the safety filter
    // sample-and-retry loop) would each see prior sandbox mutations,
    // making each candidate evaluate against a different world.
    const simMap = cloneMap(this.ctx.map);
    const simCtx: PhysicsContext = { ...this.ctx, map: simMap };
    applyStrokeImpulse(sim, simCtx, sim.x + action.dx, sim.y + action.dy);
    let touchedWater = false;
    let touchedAcid = false;
    // Cap mirrors physics' MAX_STROKE_ITERATIONS so we don't run forever
    // on a stuck shot. 9000 ≈ ~1 minute of game time at 166Hz, which
    // matches the safety net inside `step()`.
    for (let i = 0; i < 9000; i++) {
      const r = step(sim, simCtx);
      if (sim.onLiquidOrSwamp) {
        const cv = colAt(simMap, sim.x | 0, sim.y | 0);
        if (cv === 12 || cv === 14) touchedWater = true;
        else if (cv === 13 || cv === 15) touchedAcid = true;
      }
      if (r.stopped) {
        if (r.inHole) return "holed";
        if (touchedAcid) return "acid";
        if (touchedWater) return "water";
        return "normal";
      }
    }
    return "normal";
  }

  /** Advance physics by `steps` iterations (each = one 166Hz tick = 10 substeps). */
  tick(steps: number): void {
    if (this.status !== "in_motion") return;
    for (let i = 0; i < steps; i++) {
      const r = step(this.ball, this.ctx);
      // Sample trail every few iterations to keep memory bounded.
      if ((this.ball.iterationsThisStroke & 3) === 0) {
        this.trail.push({ x: this.ball.x, y: this.ball.y, stroke: this.strokes });
      }
      // Hazard tracking. `onLiquidOrSwamp` is set inside physics ONLY when
      // the ball comes to rest on water/acid (it's the precondition for the
      // 6s timeout that teleports the ball back). So if it was ever true
      // during this stroke, the stroke is going to end as a hazard reset.
      // Read the tile id at that moment so we can distinguish water (12/14)
      // from acid (13/15).
      if (this.ball.onLiquidOrSwamp) {
        const cv = colAt(this.ctx.map, this.ball.x | 0, this.ball.y | 0);
        if (cv === 12 || cv === 14) this.touchedWater = true;
        else if (cv === 13 || cv === 15) this.touchedAcid = true;
      }
      if (r.stopped) {
        // Always log the resting point so the visual trail ends where the
        // next shot will start from.
        this.trail.push({ x: this.ball.x, y: this.ball.y, stroke: this.strokes });
        // Classify the stroke outcome BEFORE flipping status, so reward
        // shaping has the full label set per stroke.
        let outcome: StrokeOutcome;
        if (r.inHole) outcome = "holed";
        else if (this.touchedAcid) outcome = "acid";
        else if (this.touchedWater) outcome = "water";
        else outcome = "normal";
        this.strokeOutcomes.push(outcome);
        // Per-stroke shaping deltas.
        //
        // Progress delta = distToHole_before − distToHole_after, where
        // "distToHole" is the PATHFINDER distance (in pixels) when the
        // track has a path map, falling back to straight-line if not.
        // Pathfinder distance correctly credits detours around water
        // as "still progress along the only safe route"; straight-line
        // would mis-credit them as backwards.
        //
        // Exploration delta = distFromStart_after − distFromStart_before
        // (always straight-line, since "distance from start" is what
        // the user asked for - rewards moving the ball anywhere).
        //
        // Water shots end at strokeStartX/Y (event=0 teleport) so both
        // deltas are ≈ 0 - automatic "no shaping for drowning".
        const distBeforeHole = this.distToHole(this.strokeStartX, this.strokeStartY);
        const distAfterHole = this.distToHole(this.ball.x, this.ball.y);
        this.strokeShapingDeltas.push(distBeforeHole - distAfterHole);
        const dxStartBefore = this.strokeStartX - this.track.startX;
        const dyStartBefore = this.strokeStartY - this.track.startY;
        const dxStartAfter = this.ball.x - this.track.startX;
        const dyStartAfter = this.ball.y - this.track.startY;
        const distBeforeStart = Math.sqrt(dxStartBefore * dxStartBefore + dyStartBefore * dyStartBefore);
        const distAfterStart = Math.sqrt(dxStartAfter * dxStartAfter + dyStartAfter * dyStartAfter);
        this.strokeExplorationDeltas.push(distAfterStart - distBeforeStart);
        if (r.inHole) {
          this.status = "holed";
        } else if (this.strokes >= this.maxStrokes) {
          this.status = "out_of_strokes";
        } else {
          this.status = "awaiting_shot";
        }
        return;
      }
    }
  }
}
