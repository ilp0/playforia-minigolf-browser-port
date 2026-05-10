// Per-map training configuration.
//
// Every knob the trainer exposes lives here, with a single typed default.
// Each map gets its own copy in localStorage so users can tune e.g. the
// water penalty up on hazard-heavy maps without affecting hole-in-1 grass
// maps. The single-map UI edits the current map's config; the grid view
// reads the per-map configs and spawns each cell with its own.
//
// Two flavours of knob:
//   - **architectural** (gridSize, hiddenSize, raySamples) - changing these
//     re-shapes the network and invalidates any saved policy weights for
//     this map. The UI rebuilds the agent when one changes.
//   - **live** (everything else) - safe to mutate on a running agent
//     mid-batch; the next backward pass picks up the new value.

import { TILE_WIDTH } from "@minigolf/shared";

export interface TrainingConfig {
  // --- Architecture (changing requires agent rebuild) ---
  /** Side length of the ball-centred fine tile grid. Odd values only.
   *  At max (49) and ball-at-centre, covers the whole 49×25 map. From
   *  edge positions the grid extends off-map; off-map cells encode as
   *  walls, which is informative ("you can't go that way"). */
  gridSize: number;
  /** Number of evenly-spaced sample points along the ball→hole line.
   *  0 disables the ray. Each sample reports (is_wall, is_hazard). */
  raySamples: number;
  /** Number of radial rays from the ball, evenly spaced at fixed
   *  compass angles (0°, 45°, 90°, ...). 0 disables. Lets the policy
   *  see "NW is clear, E is water" instead of only knowing what's on
   *  the straight line to the hole. */
  radialRays: number;
  /** Sample points per radial ray. Each sample reports (is_wall,
   *  is_hazard) at a position along the ray. Higher = finer-grained
   *  view of how each direction degrades with distance. */
  radialSamplesPerRay: number;
  /** Maximum reach of a radial ray, in pixels. Samples are spaced
   *  evenly from the ball out to this distance. */
  radialRayMaxDist: number;
  /** Boolean-as-number (1 = on, 0 = off). When on, the ball-centred grid
   *  gains a fourth channel: per-tile pathfinder distance to the hole,
   *  normalised to [0, 1]. Walls, water, acid and mines block the BFS,
   *  so the channel directly encodes "this tile is N steps along a
   *  navigable route to the hole". The policy can use it as a
   *  topographical hint OR ignore it (e.g. when a slope-bounce off-path
   *  is faster). Architectural - changing it rebuilds the network. */
  useNavigation: number;
  /** Hidden-layer width. Bigger = more capacity, slower to train. */
  hiddenSize: number;

  // --- Optimizer ---
  lr: number;
  /** Discount factor in [0, 1]. 1 → all strokes share the episode return;
   *  <1 → near-future strokes get higher per-step credit. */
  gamma: number;
  /** Episodes whose gradients we accumulate before stepping the weights.
   *  With multi-env=N parallel rollouts, batchSize=N is "synchronous A2C". */
  batchSize: number;
  /** Coefficient on the value loss in the combined gradient. <1 keeps the
   *  value head from dominating the shared trunk's update. */
  valueCoef: number;
  /** Per-element gradient clip - stops single huge updates after a lucky
   *  hole-in-1 from overwriting a useful policy. */
  gradClip: number;

  // --- Action distribution ---
  /** Mouse offset is policy_mean × meanScale. Bigger = more power per
   *  unit policy output, but the network can saturate sooner. */
  meanScale: number;
  /** Initial log-σ on both action axes - controls exploration at the very
   *  start. exp(3.55) ≈ 35 px standard deviation. */
  initLogStd: number;
  /** Lower clamp on log-σ. Prevents the policy from collapsing to
   *  near-deterministic before it's actually solved the map. */
  logStdMin: number;
  /** Upper clamp on log-σ. Prevents runaway exploration on hard maps. */
  logStdMax: number;

  // --- Reward ---
  /** Per-stroke baseline. -1 drives the agent toward fewer strokes. */
  strokePenalty: number;
  /** Added on the holing stroke. */
  holeBonus: number;
  /** Extra penalty when a stroke ends in water (12/14). Without this,
   *  water-shots and grass-shots produce identical (state,reward) tuples
   *  and the policy has no gradient pulling it off "full speed at water". */
  waterPenalty: number;
  /** Extra penalty when a stroke ends in acid (13/15). Strictly worse
   *  than water - acid resets to the track start, undoing prior progress. */
  acidPenalty: number;
  /** Per-stroke "got closer to the hole" bonus, scaled by pixels of
   *  progress. Reward per stroke gains `progressBonus * (distBefore -
   *  distAfter)`. 0 disables (default). Provably policy-invariant under
   *  γ-discounting (Ng et al. 1999) so it doesn't bias the optimum -
   *  it just gives the agent dense gradient signal early in training,
   *  before the holed-bonus is reachable. Keep it small (~0.003) so a
   *  long-distance stroke still nets negative reward when there's no
   *  hole nearby - otherwise the policy stops caring about stroke count.
   *
   *  Distance is the PATHFINDER distance when `useNavigation` is on,
   *  falling back to crow-flies when navigation is off. Path distance
   *  correctly says "you went 50 px further from the hole going around
   *  this water blob, but that's actually progress along the only safe
   *  route" - the straight-line version would mis-credit the detour. */
  progressBonus: number;
  /** Per-stroke "got further from the start" bonus, scaled by pixel
   *  distance from the track start position. Reward per stroke gains
   *  `explorationBonus * (distFromStart_after - distFromStart_before)`.
   *  0 disables (default). Useful on maps where the policy collapses
   *  to "do nothing" and never moves the ball - this gives positive
   *  reward for ANY direction of movement away from start, breaking
   *  the local minimum. Keep small (~0.003) for the same reason as
   *  progressBonus: don't let it drown out the stroke penalty. */
  explorationBonus: number;

  // --- Episode / runtime ---
  /** Stroke budget per episode. Episodes that don't hole within this
   *  many strokes are counted as failures. */
  maxStrokes: number;
  /** Number of parallel rollouts sharing the network. Higher = lower
   *  gradient variance per update, more memory. */
  numParallel: number;

  // --- Safety filter ---
  /** When >0, sample the agent's action up to N times: simulate each in
   *  a sandbox copy of the physics, and only accept actions that DON'T
   *  end with the ball drowning in water/acid. Crossing water mid-roll
   *  is fine - some maps require it. The filter only rejects landings,
   *  not transits. 0 disables. */
  safetyRetries: number;
  /** Boolean-as-number (1 = on, 0 = off). When on, every action the
   *  safety filter REJECTS is fed back into the policy as a single-
   *  sample gradient with the corresponding water/acid penalty as the
   *  synthetic reward. The policy actually learns "don't sample
   *  there" instead of relying on the filter to hide bad samples
   *  forever. Off ⇒ filter is purely a censor; the policy never sees
   *  the rejected gradient. */
  learnFromRejectedShots: number;

  // --- HIO brute-force pre-search ---
  /** Boolean-as-number (1 = on, 0 = off). When on, the trainer brute-
   *  forces every shot on a coarse polar grid (1° × 2-px) before kicking
   *  off RL. If a hole-in-one exists, it's saved as the PERFECTED route
   *  and training never starts. Faster than RL on HIO-possible maps;
   *  on maps where no HIO exists, falls through to RL after a few
   *  seconds of search. Live-updatable (only consulted on map load). */
  searchHIOFirst: number;
}

export const DEFAULTS: TrainingConfig = {
  // Architecture - 9×9 grid covers a 135×135-pixel patch (~18% of map),
  // enough for the policy to see local detours around hazards. The 5×5
  // default was too small for any non-trivial map.
  gridSize: 9,
  raySamples: 16,
  // 8 cardinal+diagonal rays × 4 samples each adds 64 features but lets
  // the network see "this direction is blocked, that one is clear",
  // which the ball→hole ray alone can't.
  radialRays: 8,
  radialSamplesPerRay: 4,
  radialRayMaxDist: 200,
  // Navigation channel on by default - the cost is +gridSize² features
  // (81 at default 9×9) and a one-time BFS at map load. The benefit is
  // a strong "where to aim" prior across all maps without per-map tuning.
  useNavigation: 1,
  hiddenSize: 32,
  // Optimizer
  lr: 1e-4,
  gamma: 0.99,
  batchSize: 4,
  valueCoef: 0.5,
  gradClip: 100,
  // Action distribution
  meanScale: 80,
  initLogStd: 3.55,
  logStdMin: 1.6,
  logStdMax: 4.4,
  // Reward
  strokePenalty: -1,
  holeBonus: 20,
  waterPenalty: -3,
  acidPenalty: -6,
  progressBonus: 0,
  explorationBonus: 0,
  // Episode / runtime
  maxStrokes: 30,
  numParallel: 4,
  // Safety filter on by default - cheap insurance against the "just
  // hits full power into water" pathology. 10 retries × ~1 stroke of
  // sim cost = at most ~10× per-stroke cost in the worst case (when
  // every sample lands in water); typically <2× because most
  // samples are fine.
  safetyRetries: 10,
  // Learning from rejected shots is OFF by default. In principle the
  // filter would otherwise hide useful gradient signal forever; in
  // practice the synthetic-reward scale is hard to balance against the
  // accepted-episode signal, and on heavy-water maps the rejection
  // gradient flood currently destabilises training. Treat as
  // experimental until the magnitude is worked out.
  learnFromRejectedShots: 0,
  // HIO pre-search on by default. Costs a few seconds of CPU when a
  // map first loads, eliminates RL training entirely on HIO-possible
  // maps. Disable per-map if it's eating too much wall-clock time.
  searchHIOFirst: 1,
};

/** UI sanity bounds for each knob. Slider/input min, max, step. The
 *  upper grid-size bound (49) is chosen so that, with the ball roughly
 *  at the map centre, the entire 49×25 map fits inside the ball-centred
 *  view; from the corners only half the map is visible (the other half
 *  reads as wall padding, which is benign). */
export const BOUNDS: Record<keyof TrainingConfig, { min: number; max: number; step: number }> = {
  gridSize: { min: 3, max: 49, step: 2 },
  raySamples: { min: 0, max: 64, step: 1 },
  radialRays: { min: 0, max: 16, step: 1 },
  radialSamplesPerRay: { min: 1, max: 16, step: 1 },
  radialRayMaxDist: { min: 30, max: 800, step: 10 },
  // Boolean knob. The UI renders it as 0/1 (number input with step 1).
  useNavigation: { min: 0, max: 1, step: 1 },
  hiddenSize: { min: 8, max: 256, step: 8 },
  lr: { min: 1e-6, max: 1e-2, step: 1e-6 },
  gamma: { min: 0.5, max: 1.0, step: 0.001 },
  batchSize: { min: 1, max: 32, step: 1 },
  valueCoef: { min: 0, max: 5, step: 0.05 },
  gradClip: { min: 1, max: 10000, step: 1 },
  meanScale: { min: 5, max: 300, step: 1 },
  initLogStd: { min: 0, max: 6, step: 0.05 },
  logStdMin: { min: 0, max: 6, step: 0.05 },
  logStdMax: { min: 0, max: 6, step: 0.05 },
  strokePenalty: { min: -20, max: 0, step: 0.5 },
  holeBonus: { min: 0, max: 200, step: 1 },
  waterPenalty: { min: -50, max: 0, step: 0.5 },
  acidPenalty: { min: -50, max: 0, step: 0.5 },
  progressBonus: { min: 0, max: 0.05, step: 0.001 },
  explorationBonus: { min: 0, max: 0.05, step: 0.001 },
  maxStrokes: { min: 1, max: 200, step: 1 },
  numParallel: { min: 1, max: 16, step: 1 },
  safetyRetries: { min: 0, max: 50, step: 1 },
  learnFromRejectedShots: { min: 0, max: 1, step: 1 },
  searchHIOFirst: { min: 0, max: 1, step: 1 },
};

/** Knobs that change the network's input or weight shape. Mutating these
 *  on a running agent would crash on the next forward pass, so the UI
 *  layer must rebuild the agent when one of these changes. */
export const ARCHITECTURE_KEYS: ReadonlyArray<keyof TrainingConfig> = [
  "gridSize",
  "raySamples",
  "radialRays",
  "radialSamplesPerRay",
  "useNavigation",
  "hiddenSize",
];

const PREFIX = "minigolf-ai:config:v1:";

/** Load the training config for one map, falling back to DEFAULTS if no
 *  saved config exists or if the saved blob is missing keys (forward-
 *  compatible: a new knob added in the future will pick up its default).
 *
 *  `autoOverrides` slot in BETWEEN the static DEFAULTS and the user's
 *  saved values, so:
 *    - If the user manually saved a value, it wins.
 *    - Otherwise, the auto override (e.g. "max strokes = 3 × map
 *      avg-strokes") wins over the static default (30).
 *    - Otherwise, the static default applies.
 *  The caller (main.ts/grid.ts) computes per-map auto values from
 *  track metadata after loading the track. */
export function loadConfig(
  filename: string,
  autoOverrides: Partial<TrainingConfig> = {},
): TrainingConfig {
  try {
    const raw = localStorage.getItem(PREFIX + filename);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TrainingConfig>;
      return clampConfig({ ...DEFAULTS, ...autoOverrides, ...parsed });
    }
  } catch {
    // Storage disabled or JSON corrupt - use defaults.
  }
  return clampConfig({ ...DEFAULTS, ...autoOverrides });
}

export function saveConfig(filename: string, cfg: TrainingConfig): void {
  try {
    localStorage.setItem(PREFIX + filename, JSON.stringify(cfg));
  } catch (e) {
    console.warn("Failed to save training config:", e);
  }
}

export function deleteConfig(filename: string): void {
  localStorage.removeItem(PREFIX + filename);
}

/** Clamp every numeric value into the UI's bounds and snap grid size to
 *  the nearest odd integer. Defensive: a hand-edited localStorage entry
 *  shouldn't be able to crash the trainer with absurd values. */
export function clampConfig(cfg: TrainingConfig): TrainingConfig {
  const out = { ...cfg };
  for (const k of Object.keys(BOUNDS) as Array<keyof TrainingConfig>) {
    const { min, max } = BOUNDS[k];
    let v = out[k];
    if (!Number.isFinite(v)) v = DEFAULTS[k];
    if (v < min) v = min;
    if (v > max) v = max;
    out[k] = v;
  }
  // Grid size must be odd so the ball sits at the geometric centre.
  if (out.gridSize % 2 === 0) out.gridSize = Math.max(3, out.gridSize - 1);
  // Don't let the grid extend further than the map itself can - going
  // wider than the worst-case map dimension just wastes parameters on
  // tiles that always read as wall padding.
  const maxUseful = TILE_WIDTH * 2 - 1; // 97 - covers worst-case ball-in-corner
  if (out.gridSize > maxUseful) out.gridSize = maxUseful;
  // Integer knobs.
  out.raySamples = Math.round(out.raySamples);
  out.radialRays = Math.round(out.radialRays);
  out.radialSamplesPerRay = Math.round(out.radialSamplesPerRay);
  out.radialRayMaxDist = Math.round(out.radialRayMaxDist);
  out.hiddenSize = Math.round(out.hiddenSize);
  out.batchSize = Math.round(out.batchSize);
  out.gradClip = Math.round(out.gradClip);
  out.meanScale = Math.round(out.meanScale);
  out.maxStrokes = Math.round(out.maxStrokes);
  out.numParallel = Math.round(out.numParallel);
  out.safetyRetries = Math.round(out.safetyRetries);
  // useNavigation / searchHIOFirst / learnFromRejectedShots are 0/1.
  out.useNavigation = out.useNavigation >= 0.5 ? 1 : 0;
  out.searchHIOFirst = out.searchHIOFirst >= 0.5 ? 1 : 0;
  out.learnFromRejectedShots = out.learnFromRejectedShots >= 0.5 ? 1 : 0;
  // progressBonus / explorationBonus are fine-grained floats; don't round.
  return out;
}
