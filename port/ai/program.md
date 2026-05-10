# program.md — autoresearch steering wheel

The human edits **this file**. The autoresearch agent reads it every
iteration, then edits **only `research_program.ts`**. That's the
contract. Don't edit anything else.

## Goal

Improve the **mean success rate** across the 16-map eval set defined in
`headless/maps.ts`, after a fixed wall-clock training budget per map.
Score is reward-formula-invariant by design (per
`AUTORESEARCH_PLAN.md` §3 option 3): you can change the reward
magnitudes without changing what success means.

## What you're allowed to edit

Exactly one file: **`research_program.ts`**. Inside it, the `TRAINING_CONFIG`
object's 27 fields, plus the `NOTES` string. Do not add new fields.
Do not delete fields. Do not edit anything outside `research_program.ts`.

The harness will silently clamp values outside
`headless/autoresearch-bounds.ts`. You can't break that wall — but you
also won't be told if you tried; the JSONL row's `config_was_clamped`
flag will be set.

## Strict procedure (do this every iteration)

1. **Read** `research_log.jsonl` (the last 30 entries). Note: prior best,
   recent change history, what kept and what didn't.
2. **Read** `research_program.ts` `NOTES` for the rationale of the
   most-recent edit.
3. **Hypothesise ONE change**. Bigger surface area = higher chance of
   gaming the metric or getting confused about which knob mattered.
   Change one thing.
4. **Edit** `research_program.ts`. Update `NOTES` to record what you
   changed and why.
5. **Run** the eval (the loop runner does this for you).
6. **Read the score off stdout's last line** (one float).
7. **Compare against prior best**. Strict-better-or-revert. No
   "within noise."
8. **If reverted**, edit `research_program.ts` back to its prior
   state (the loop runner saves a copy before each iteration).
9. **Stop conditions** — don't override these:
   - keep-rate over last 30 trials < 10% → stop, hand back to human.
   - best score hasn't improved in 50 trials → stop, hand back to human.
   - no improvement on the validation set in last 5 validation runs → stop.

## Priors (read before forming a hypothesis)

The 27 knobs split into rough categories. Some are well-tuned; some
have been hand-tweaked but never systematically searched.

### Worth trying first
- **`gridSize` × `useNavigation`**: these interact. The navigation
  channel pulls more weight when the grid is small. Try a small grid
  with navigation on, vs a big grid with navigation off — there's a
  single knob's worth of feature redundancy here.
- **`radialRays` × `radialRayMaxDist`**: 8 rays at 200px is the current
  default. Hazard-heavy maps might want more rays at shorter distance
  ("tell me about the immediate vicinity, not 200 px out").
- **`progressBonus` magnitude**: useful range is 0.001-0.005. Bigger
  swamps the stroke penalty. 0 by default; turning it on is one of
  the highest-EV knobs to try first.
- **`initLogStd`**: matters more on hazard-heavy maps. Higher = more
  exploration up front; lower = faster convergence to a local optimum.
  Worth varying.

### Brittle - revert eagerly if you change these
- **Reward magnitudes** (`strokePenalty`, `holeBonus`, `waterPenalty`,
  `acidPenalty`): the metric is invariant to reward scaling, so don't
  expect score to move much from these. If it DOES move dramatically,
  that's a sign you broke training (made one term dominate).
- **`progressBonus`, `explorationBonus`**: same — small magnitudes only.

### Boring - leave alone unless something else is stuck
- **`gradClip`** has been at 100 for the entire history of this trainer.
  No reason to suspect it's load-bearing.
- **`logStdMin`, `logStdMax`** clamps — they exist as safety, not as
  load-bearing values.
- **`gamma`** — 0.99 is a safe default. Going to 1.0 (no discount)
  has worked in early experiments; below 0.95 underweights the
  holing reward.

### Off-limits (don't game the metric)
- **`safetyRetries`**: the obvious gaming vector. Brute-forcing 50
  retries per stroke inflates success rate without the policy learning
  anything. The harness clamps it at 12 — but please don't
  set it ABOVE the current `10` unless you have a specific hypothesis.
- **`numParallel`**: clamped at 8. It's slow and not load-bearing.
  Lower can be useful (lower batchSize for noisier updates); higher
  is just slower wall-clock.
- **`searchHIOFirst`**: starts at 0 in the baseline. Calibration showed
  that with HIO=1, the brute-force pre-search solves nearly every
  curated eval map in <3 seconds — score saturates at 1.0 and the
  metric stops differentiating RL variants. Turning HIO on inflates
  scores without the policy learning anything. You CAN turn it on as
  one of the 27 knobs (the bounds allow it) but the resulting score
  won't reflect policy quality. Strongly suggest leaving at 0 unless
  you have a specific reason.

## When you're stuck

If 5 iterations in a row revert: re-read the last successful change,
think about why it worked, look for adjacent ideas. The loop's job is
local search around the current best — when local search exhausts,
the answer is "this is the best the search space allows," not "try
harder."

If you think you need to change the network architecture beyond what
the 27 knobs allow: stop. Tell the human. Per the plan, expanding the
mutable surface is a deliberate human decision, not an autonomous one.

## What the human sees

The human checks `research_log.jsonl`, the validation log, and
occasionally `research_program.ts`. They edit THIS file (`program.md`)
when they want to redirect you. They don't edit `research_program.ts`
unless something has gone seriously off the rails.
