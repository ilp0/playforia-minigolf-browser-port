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

import { Seed } from "@minigolf/shared";
import {
  newBall,
  applyStrokeImpulse,
  step,
  type BallState,
  type PhysicsContext,
} from "../../web/src/game/physics.ts";
import type { LoadedTrack } from "./loader.ts";

export type EpisodeStatus =
  | "awaiting_shot"
  | "in_motion"
  | "holed"
  | "out_of_strokes";

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
 * Reward shaping for an episode. Tunable; this default is a good
 * pedagogical starting point.
 *
 *   per-stroke penalty: -1   (drives the policy toward FEWER strokes)
 *   terminal bonus    : +20 if holed, 0 if out of strokes
 *
 * So a lucky 1-stroke hole-in returns +19, a typical 5-stroke hole returns
 * +15, a 30-stroke failure returns -30.
 */
export function episodeReturn(episode: Episode): number {
  const STROKE_PENALTY = -1;
  const HOLE_BONUS = 20;
  const state = episode.state();
  const holeBonus = state.status === "holed" ? HOLE_BONUS : 0;
  return STROKE_PENALTY * episode.strokes + holeBonus;
}

/**
 * Per-step discounted returns (the "G_t" in classical RL notation).
 *
 *   r_t  = -1 for every stroke, plus +20 on the FINAL stroke if holed
 *   G_t  = r_t + γ·r_{t+1} + γ²·r_{t+2} + ...
 *
 * Each stroke gets credited with its FUTURE return, not the whole-episode
 * sum. So a holing-shot at step N gets the full +19 (or -1 if missed),
 * while step 1's contribution to that hole is dampened by γ^(N-1).
 *
 * Why this matters vs the single-scalar version: when an episode ends with
 * a holed shot at step 8 of 30, with the scalar version every one of those
 * 8 strokes (including unhelpful ones) gets the same +12 credit. With
 * per-step returns, the early strokes receive less credit (γ-attenuated)
 * and the late strokes more - better credit assignment, lower variance.
 *
 * γ = 1 reduces this to "future cumulative reward" with no time-decay.
 * γ = 0.99 over 30 steps leaves the earliest stroke at 74% strength -
 * mild but meaningful weighting toward later actions.
 */
export function discountedPerStepReturns(
  episode: Episode,
  gamma: number,
): number[] {
  const n = episode.strokes;
  if (n === 0) return [];
  const STROKE_PENALTY = -1;
  const HOLE_BONUS = 20;
  const rewards = new Array<number>(n).fill(STROKE_PENALTY);
  if (episode.state().status === "holed") {
    rewards[n - 1] += HOLE_BONUS;
  }
  const returns = new Array<number>(n);
  let g = 0;
  for (let t = n - 1; t >= 0; t--) {
    g = rewards[t] + gamma * g;
    returns[t] = g;
  }
  return returns;
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

  constructor(track: LoadedTrack, opts: { maxStrokes?: number; seed?: number } = {}) {
    this.track = track;
    this.maxStrokes = opts.maxStrokes ?? 30;
    this.ball = newBall(track.startX, track.startY);
    this.ctx = {
      map: track.map,
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
    this.status = "in_motion";
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
      if (r.stopped) {
        // Always log the resting point so the visual trail ends where the
        // next shot will start from.
        this.trail.push({ x: this.ball.x, y: this.ball.y, stroke: this.strokes });
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
