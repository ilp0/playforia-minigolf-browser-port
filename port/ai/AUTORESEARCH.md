# Autoresearch — implementation guide

The autoresearch system implements the design in
[`AUTORESEARCH_PLAN.md`](./AUTORESEARCH_PLAN.md). This file documents
the as-built code so you can run it.

The plan is the *spec*; this file is the *user manual*.

## Quick start

```bash
# from port/ai/
npm run ai:sanity       # verify Node can import the RL modules (one-time)
npm run ai:eval:smoke   # 1-map 5-second smoke test (~10s)
npm run ai:eval:short   # full 16-map eval, short budget (~10–15 min)
npm run ai:analyze      # ASCII plots + keep-rate stats
```

The autonomous loop:

```bash
npm run ai:loop:dry     # exercise the loop machinery without an LLM
npm run ai:loop -- --max-iterations 30 --agent-cmd 'claude --print'
```

Single-map experiments (own log, won't pollute the main one):

```bash
node --experimental-strip-types research_loop.ts \
  --max-iterations 5 \
  --maps Watertankrun.track \
  --log-path research_log_watertankrun.jsonl \
  --agent-cmd 'claude --print'
```

## Two browser views

| Page | When to use |
|---|---|
| [`/autoresearch.html`](http://localhost:5180/autoresearch.html) | **Live dashboard.** Polls every 2 s while a loop or eval is running. Watch the score chart fill in, see which map/seed/phase is currently running. |
| [`/autoresearch-report.html`](http://localhost:5180/autoresearch-report.html) | **Post-run report.** Static analysis of a completed loop run: verdict, score chart, per-knob trajectories, per-iteration cards with Claude's reasoning, baseline-vs-best config diff, recommendations. Pass `?log=research_log_NAME.jsonl` to view a specific experiment. |

The dashboard has a **"report →"** link in its header that forwards
the currently-selected log.

## Live dashboard

While the loop or any eval is running, the live dashboard polls every
2 s and renders:

- **Score chart**: best-so-far line (green) plus per-iteration dots
  (filled green = kept, hollow red = reverted).
- **Live status**: current map / seed / phase / pct, plus loop-level
  "iteration 3/5, calling_agent | running_eval".
- **Iteration list**: newest first, with the config diff vs the prior
  kept iteration, plus the agent's NOTES.
- **Per-map breakdown**: success rate per map for the latest
  iteration.
- **Log dropdown**: switch between the main log, validation log, and
  any per-experiment `research_log_*.jsonl` (auto-discovered).

## Files

```
port/ai/
├── AUTORESEARCH_PLAN.md      # spec (frozen design doc)
├── AUTORESEARCH.md           # this file (how to run it)
├── program.md                # ⚙ HUMAN edits this. Steering wheel.
├── research_program.ts       # ⚙ AGENT edits this. The 27-knob config.
├── research_eval.ts          # entry: load program → train → eval → emit one number
├── research_loop.ts          # autonomous-loop driver
├── research_analyze.ts       # log → ASCII plots
│
├── headless/                 # FROZEN. Do not edit during a run.
│   ├── atlases.ts            #   GIF decoder for collision masks (Node, no canvas)
│   ├── track-loader.ts       #   fs-based track loader (mirrors browser src/loader.ts)
│   ├── harness.ts            #   train+eval one config on N maps → one number
│   ├── maps.ts               #   16 eval maps + 40 validation maps
│   └── autoresearch-bounds.ts#   tightened bounds that close gaming vectors
│
├── scripts/
│   ├── sanity-check.mjs      # one-time "do imports work in Node?" check
│   ├── calibration-smoke.mjs # gridSize=5 vs gridSize=11 from AUTORESEARCH_PLAN §10
│   └── test-headless-load.mjs# end-to-end smoke test
│
└── src/                      # FROZEN browser-side trainer (unchanged by autoresearch).
```

## What's frozen vs mutable

Per `AUTORESEARCH_PLAN.md` §2:

**Frozen** (the loop must not edit these):
- `port/web/src/game/physics.ts` — physics
- `port/ai/src/env.ts` — Episode, simulateShot, reward formula
- `port/ai/src/agent.ts` — actor-critic
- `port/ai/src/path.ts` — pathfinder
- `port/ai/src/hio.ts` — HIO brute-force
- `port/ai/src/nn.ts` — MLP
- `port/ai/src/config.ts` — TrainingConfig type, DEFAULTS
- Everything under `port/ai/headless/`
- `port/ai/research_eval.ts`, `research_loop.ts`, `research_analyze.ts`
- `port/ai/headless/maps.ts` — eval and validation map sets

**Mutable** (the loop edits between iterations):
- `port/ai/research_program.ts` — `TRAINING_CONFIG` (27 fields) + `NOTES`

**Human-edited** (you, when redirecting the loop):
- `port/ai/program.md` — priors, off-limits, what to try next

## The metric

One scalar: **mean success rate (% holed) across 16 eval maps × 3 seeds,
median-by-seed across maps**. Per `AUTORESEARCH_PLAN.md` §3, this is
**reward-formula-invariant by design**: changing reward magnitudes
doesn't move the score directly, only via second-order effects on
training dynamics.

Per-iteration score lives in `research_log.jsonl` (one JSON line per
eval), with full per-map breakdown.

## Calibration findings

Two empirical observations from running the harness:

1. **HIO locked off in autoresearch.** The HIO brute-force pre-search
   (`searchHIOFirst=1`) solves nearly every map in the curated eval set
   in <3s. With HIO on, the score saturates at 1.0 and the RL policy
   becomes invisible to the metric. `headless/autoresearch-bounds.ts`
   locks `searchHIOFirst: { min: 0, max: 0 }` so the loop cannot turn
   it on. The user-facing browser trainer (`src/config.ts`) still
   allows 0/1 unchanged.

2. **Short budget gives no signal on hard maps.** The
   gridSize=5 vs gridSize=11 calibration smoke at 15s × 4 maps × 1 seed
   showed both variants holing 12/12 on CurveI (with stroke-count
   delta: 8 vs 13) but 0/12 on hazard/teleport/hard maps. The metric
   (success rate) doesn't see the stroke-count win. If the standard
   60s budget shows the same flat-zero behaviour, **switch to the
   composite metric** (option 4 in `AUTORESEARCH_PLAN.md` §3) which
   captures stroke efficiency as well as raw success.

3. **Recorded baseline (HIO off, short budget): score = 0.125.**
   Full 16-map × 3-seed eval at 15s training/map, with the
   handoff-default config (gridSize=9, useNavigation=1, all reward
   shaping at default zero). Per-map breakdown:
   - **CurveI** (100% holed, mean 7.67 strokes per hole)
   - **1stroke4bounces** (100% holed, mean 4 strokes)
   - All other 14 maps: 0% holed.

   The loop's first concrete signal will be "did this variant solve
   any of OvalI / Leobas1 / Wormhole / etc?" — those are the lowest-
   hanging fruit (trivially HIO-able with HIO=1; they fail at 15s of
   pure RL because exploration noise is too uniform to find the hole).
   Bumping to 60s (`--budget default`) is the recommended first step
   for the next operator. If 60s also leaves >12 maps at 0%, switch
   to the composite metric.

4. **Loop machinery verified.** One full `claude --print` iteration
   takes ~30 seconds (25s agent + 5s smoke eval) when --eval-mode is
   set to smoke. The runner correctly applies the LLM's proposed
   edit, validates the format, runs the eval, compares against the
   prior best, and either keeps or restores from backup. JSONL
   logging works; analyzer ASCII plots render correctly.

## How the loop runs

Every iteration the runner:

1. **Backs up** `research_program.ts` to `.research_program.ts.backup`.
2. **Calls the agent** (`claude --print` by default) with a prompt that
   includes `program.md`, the last 30 log entries, and the current
   `research_program.ts`. The agent emits a complete new
   `research_program.ts` on stdout.
3. **Validates** the proposal: must export `TRAINING_CONFIG` with all
   27 fields. Anything outside `headless/autoresearch-bounds.ts`
   gets clamped silently.
4. **Runs `research_eval.ts`**, parses the score from stdout's last
   line.
5. **Strict-better-or-revert**: if the score didn't improve, restores
   from backup.
6. **Logs**: appends to `research_log.jsonl`.
7. **Stops** when keep-rate drops below 10% or no new best in 50
   iterations.

## How to redirect the loop

Edit `program.md`. That's the only knob you should turn while the loop
is running. Don't edit `research_program.ts` directly — the loop will
overwrite it next iteration.

If something breaks: stop the loop (Ctrl+C; it finishes the current
iteration cleanly). Inspect `research_log.jsonl` and
`research_runner_log.jsonl`. Resume by running `npm run ai:loop`
again — log + program.ts state are preserved across runs.

## How to extend the mutable surface

Per `AUTORESEARCH_PLAN.md` §2, this is a **deliberate human
decision**, not the loop's choice. Wait until the loop's keep-rate
drops below ~10% on the 27-knob space, then:

1. Decide what to expose: encoder shape, optimizer choice, etc.
2. Add the field to `TrainingConfig` in `src/config.ts`.
3. Add to `AUTORESEARCH_BOUNDS` in `headless/autoresearch-bounds.ts`
   with sensible bounds that close the new gaming vector.
4. Add to `research_program.ts` with a starting value.
5. Update `program.md` with priors for the new knob.
6. Reset the loop log (or keep it for comparison; a fresh start is
   cleaner) and run again.

## Implementation notes (for the next agent)

- **Atlases**: pure-JS GIF decoding via `omggif`. Adds ~30KB to
  `node_modules` and zero native deps. The masks (12.6KB total) could
  be pre-extracted to a static binary if the GIF decode ever became
  load-bearing — currently it's <100ms at startup, cached in-process.
- **Determinism**: every `(map × seed)` trial installs a fresh
  Mulberry32 PRNG over `Math.random` and restores the original
  afterward. Same seed reproduces same rollout for same config.
- **Storage isolation**: the Node harness never touches localStorage.
  The user-facing browser trainer's saved policies (`minigolf-ai:
  policy:v3:*`) are not affected by autoresearch runs.
- **Wall-clock fairness**: training is wall-clock-budgeted. A variant
  that simulates faster gets more episodes; a variant that simulates
  slower gets fewer. This is the design choice — wall-clock is the
  scarce resource, not episodes.
