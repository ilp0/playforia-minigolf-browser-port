# How `port/ai` works — the complete guide

A plain-English tour of everything in `port/ai/`. Read top to bottom
to understand the whole system; jump to a section if you know what
you're after.

> This file is the canonical reference. The other docs in `port/ai/`
> ([`AUTORESEARCH.md`](./AUTORESEARCH.md), [`AUTORESEARCH_PLAN.md`](./AUTORESEARCH_PLAN.md),
> [`program.md`](./program.md)) are deliberately narrower — they cover
> one topic each. When something contradicts, this file wins.

---

## Contents

1. [What is this?](#1-what-is-this)
2. [Quick start](#2-quick-start)
3. [The five entry points](#3-the-five-entry-points)
4. [The agent](#4-the-agent)
5. [What the agent sees and does](#5-what-the-agent-sees-and-does)
6. [The training loop](#6-the-training-loop)
7. [Reward shaping](#7-reward-shaping)
8. [Helper systems](#8-helper-systems)
9. [Persistence](#9-persistence)
10. [The autoresearch loop](#10-the-autoresearch-loop)
11. [Browser dashboards](#11-browser-dashboards)
12. [The HIO scanner](#12-the-hio-scanner)
13. [Physics quirks the port carries](#13-physics-quirks-the-port-carries)
14. [Files](#14-files)
15. [Common workflows](#15-common-workflows)
16. [Glossary](#16-glossary)
17. [Things that can go wrong](#17-things-that-can-go-wrong)

---

## 1. What is this?

A small browser app + Node CLI that **teaches a tiny neural network to
play Aapeli minigolf**. You watch a ball get whacked across a course
thousands of times — bad shots at first, gradually better — until the
network has figured out a reliable way to sink the ball.

Everything runs locally:

- The browser side runs the trainer and dashboards (no network calls).
- The Node side runs the autoresearch loop and the hole-in-one scanner
  using the *exact same physics* the browser uses (imported directly
  from `port/web/src/game/`).

Nothing is sent to a server. Trained policies and scan results live in
your browser's localStorage and as JSON files in this directory.

---

## 2. Quick start

From `port/ai/`:

```bash
# Install (first time only) and start the dev server
npm install                  # also installs omggif (Node-side GIF decoder)
npm run dev                  # serves http://localhost:5180

# Verify the Node side can import the RL modules
npm run ai:sanity            # ~2s — pure import check

# Smoke-test the eval harness
npm run ai:eval:smoke        # ~10s — 1 map, 5s of training

# Open the browser dashboards
#   http://localhost:5180/                         single-map trainer
#   http://localhost:5180/grid.html                grid trainer (N maps in parallel)
#   http://localhost:5180/autoresearch.html        live autoresearch dashboard
#   http://localhost:5180/autoresearch-report.html post-run autoresearch report
#   http://localhost:5180/hio.html                 hole-in-one tracks list
```

To start an autoresearch loop from the browser, open
`/autoresearch.html`, fill in the loop-control panel, and click **Start**.
To run the HIO scan over every track:

```bash
node --experimental-strip-types scripts/scan-hio.mjs --workers 8
```

Expect ~2-3 hours for the full 2062-track scan. Partial results show
up live in `/hio.html` as it runs.

---

## 3. The five entry points

| Page / CLI | What it does | When to use |
|---|---|---|
| **`/index.html`** (single-map view) | Watch four agents train one map in parallel. Live charts, stats, controls. | "Teach me one map fast" / debugging features. |
| **`/grid.html`** (grid view) | Train any number of maps side by side, one cell per map. | "Solve the catalogue overnight." |
| **`/autoresearch.html`** (live dashboard) | Drives the autoresearch loop from the browser. Start/Stop button, live event feed, score chart. | Watch the loop search the 27-knob hyperparameter space in real time. |
| **`/autoresearch-report.html`** (post-run report) | Static analysis of a completed loop run: verdict, score chart, per-knob trajectories, per-iteration cards with Claude's reasoning, baseline-vs-best diff. | "Did the last loop run actually improve anything? What changed?" |
| **`/hio.html`** (HIO tracks list) | Lists every track that's hole-in-one-able. Filter by name, sort by candidates-tried. Each row deep-links to the single-track viewer. | Find which tracks have a 1-stroke solution; spot maps where humans missed the optimal route. |

`/index.html?map=Foo.track` deep-links to a specific map. The other
pages keep their state in URL params too, so you can bookmark a
specific report or HIO experiment.

---

## 4. The agent

A small **multi-layer perceptron** (MLP) with two output heads (an
"actor-critic" architecture). The whole network is ~3.7 KB of
floating-point weights and fits in localStorage easily.

```
state (~424 numbers)
    │
    ▼
[ Linear ]  ← inputSize × hiddenSize  (default: 424×32)
    │
    ▼
[ tanh ]    ← keeps outputs in [-1, 1]
    │
    ├──► Actor head  (hiddenSize × 4)  ← μₓ, μᵧ, log σₓ, log σᵧ
    │                                    "where to aim and how confidently"
    │
    └──► Critic head (hiddenSize × 1)  ← V(s)
                                         "expected return from this state"
```

- **Actor** outputs four numbers: the mean of a 2D Gaussian (where to
  aim) and its log-standard-deviations (how spread out random samples
  should be). Each shot is a sample from this Gaussian.
- **Critic** predicts the expected episode return from the current
  state. The actor uses the critic's prediction as a baseline for its
  policy gradient (see §6).

The architecture is hand-coded in `src/nn.ts` and trained via
hand-coded backprop in `src/agent.ts` — no autograd library, no GPU.
Every gradient is visible in source.

---

## 5. What the agent sees and does

### State features (~424 numbers at default config)

| Feature | Default size | Toggleable | What it tells the agent |
|---|---|---|---|
| Ball + hole positions | 4 | always on | "where am I, where do I want to go" — normalised pixel coords |
| Ball-centred grid | 9×9 × (3 + 1) = 324 | size adjustable; nav-channel toggleable | A patch of tiles around the ball with 3 boolean channels (wall / hole / hazard) plus an optional 4th channel (pathfinder distance). The 4th channel turns the grid into a *topographic map* the agent can use to navigate around water without ever touching it. |
| Ball→hole ray | 16 × 2 = 32 | sample count adjustable | 16 evenly-spaced sample points along the straight line ball→hole. 2 channels (wall / hazard). Answers "is there water in my path if I aim at the hole?" |
| Radial rays | 8 × 4 × 2 = 64 | count and sample count adjustable | 8 rays at fixed compass angles, each with 4 sample points. 2 channels per sample. Answers "which directions are clear?" |

**Total at defaults: 424 features.** The state encoder is in
`src/agent.ts:encodeState`.

The grid covers a ~135×135-pixel patch (the map is 735×375). The grid
size, ray counts, and navigation channel are all knobs (see §10) — the
autoresearch loop has tuned these in the past.

### Action

Two numbers: a mouse-cursor offset from the ball. Distance = power,
direction = aim. This matches how the original Aapeli minigolf game
worked — click the mouse near the ball, the ball flies.

The actor's four outputs are interpreted as `(μₓ, μᵧ, log σₓ, log σᵧ)`.
The actual shot is sampled: `(action.dx, action.dy) = (μₓ + ε·σₓ, μᵧ +
ε·σᵧ)` with ε ∼ N(0, 1). σ shrinks as the agent gets confident.

In **eval mode** the σ is ignored — the agent just plays the mean.
This is how saved policies replay deterministically.

---

## 6. The training loop

### Single episode

```
1. Spawn ball at the map's start tile.
2. Encode state → 424 numbers
3. Forward pass: state → actor + critic outputs
4. Pre-roll the action through the safety filter (§8): up to
   `safetyRetries` times, simulate the shot in a sandbox; if it
   would land in water/acid, draw a fresh sample.
5. Apply the chosen shot.
6. Tick the physics until the ball stops or holes.
7. If holed → episode done. Else go back to step 2 (or stop at
   `maxStrokes`, default 30).
8. Compute discounted per-stroke returns G_t.
9. For each step in the trace, accumulate the policy + value
   gradients. After `batchSize` accumulated episodes, apply.
10. Save trace, repeat.
```

### Multi-environment rollouts

The single-map view runs **4 episodes in parallel** by default, all
sharing the same network. Their gradients are averaged before the
weights actually change. This is "synchronous A2C" — lower variance per
update for the same wall-clock time. The four white/red/blue/yellow
balls on the canvas are the four parallel agents.

### Discounted per-step returns

A holing stroke at step N gets the full +20 reward; the strokes
leading up to it get γⁿ⁻ᵗ × that reward, where γ = 0.99 by default.
This is "credit assignment" — the actor learns that the last *few*
shots contributed to the win, weighted by how recent they were. With
γ = 1, every step in a winning episode gets equal credit.

### Actor-critic update rule

```
advantage_t = G_t - V(s_t)              # how much better than predicted
policy_loss = -log π(a_t | s_t) * advantage_t
value_loss  = (V(s_t) - G_t)²
total_loss  = policy_loss + valueCoef * value_loss
```

Standard REINFORCE-with-baseline. The advantage drives the policy
gradient; the squared error pulls V toward the actual returns.

---

## 7. Reward shaping

Per-stroke recipe:

| Term | Default | Fires when |
|---|---|---|
| `strokePenalty` | −1 | every stroke (encourages fewer strokes) |
| `holeBonus` | +20 | the holing stroke |
| `waterPenalty` | −3 | stroke ended in water (ball was teleported back to shot start) |
| `acidPenalty` | −6 | stroke ended in acid (ball was reset to track start) |
| `progressBonus` × Δ | 0 | scaled by `pathfinder distance before − after` |
| `explorationBonus` × Δ | 0 | scaled by `distance from start after − before` |

`progressBonus` and `explorationBonus` are **optional** dense-shaping
terms. They're off by default because they're brittle (too high
swamps the stroke penalty and the policy learns to loiter near the
hole). When on, `progressBonus` uses the *pathfinder distance* (see
§8) so detours around water count as progress.

Mines are not penalised — they bump the ball randomly but don't kill
it.

Examples (with all shaping at zero):

| Outcome | Reward |
|---|---|
| Holed in 1 | −1 + 20 = **+19** |
| Holed in 5, no hazards | −5 + 20 = **+15** |
| Holed in 5, one water bath | −5 + 20 − 3 = **+12** |
| Failed at 30, four water baths | −30 − 12 = **−42** |

---

## 8. Helper systems

Three pieces of non-RL machinery sit between the network and the
physics. All three are **off** by configuration alone — flipping their
knobs lets you compare RL-only against RL-plus-helpers.

### Pathfinder (`src/path.ts`)

A BFS from every hole-tile across the map's collision grid, with:

- **Ball-radius erosion**: a tile is "passable" only if a 7-pixel
  circle around its centre is wall-free. Without this, the BFS finds
  one-pixel-wide gaps the actual ball can't fit through.
- **Teleporter shortcuts**: teleport-start and teleport-exit pairs
  share the same BFS distance. The pathfinder's parent pointers
  correctly walk through teleporters when reconstructing routes.
- **Multi-hole seeding**: maps with multiple holes seed the BFS from
  every hole tile, so distance reflects "shortest path to *any* hole."

Result: a `dist` Int16Array (49×25 tile-step distances, normalised) +
a `parent` array for route reconstruction. Used by:

- The agent's **navigation channel** (4th channel of the ball-centred
  grid), which tells the policy "which direction is closer to the
  hole" without it having to figure out walls from scratch.
- The reward shaping (`progressBonus`).
- The single-track view's optional **route overlay** (toggle with
  `#show-route`).

### Safety filter (`src/agent.ts:pickSafeAction`)

The actor samples N candidate actions (`safetyRetries`, default 10).
For each candidate, the env runs a sandbox simulation in a *cloned*
map. If the candidate would land the ball in water or acid, it's
rejected and a fresh one is drawn. After N rejections the filter gives
up and uses the last sample (so the gradient still gets *some*
signal).

A second, experimental knob (`learnFromRejectedShots`, default OFF)
feeds the rejected samples back into the policy as single-sample
gradient updates with the synthetic water/acid penalty as the reward.
Was empirically destabilising on heavy-water maps; left as a knob.

### HIO brute-force pre-search (`src/hio.ts`)

For each map, before any training, sweep a polar grid of candidate
shots (default 1° angle × 2-px power, ~35 000 candidates) and check if
*any* of them holes. If so, save that exact shot as the PERFECTED
route — no training needed.

`searchHIOFirst` is the toggle (default ON in the browser trainer,
LOCKED OFF for autoresearch — see §10). Live visualisation of the
search overlay paints each candidate's trajectory onto the canvas as
the search runs.

This is also the engine behind the standalone HIO scanner (§12).

---

## 9. Persistence

Trained networks save themselves to your browser's **localStorage**.
One key per map, like `minigolf-ai:policy:v3:CurveI.track`. Each save
is ~100 KB and contains:

- All network weights + value-head weights
- Current best-strokes record
- Recorded best-ever action sequence (replayed in "best" mode)
- Status (TRAINING / CONVERGING / CONVERGED / PERFECTED / LOADED)
- Lifetime episode count + recent rolling stats

Saves happen automatically when:

- A new best-strokes record is hit
- Status crosses into CONVERGED or PERFECTED
- Every 50 episodes (so live counters survive reload)

Per-map training **configs** save separately under
`minigolf-ai:config:v1:<map>`. Storing config per map lets you tune
high-water maps without affecting easy ones.

The Node-side autoresearch harness **never touches localStorage** —
it trains from scratch every iteration and writes JSONL files instead
(see §10).

---

## 10. The autoresearch loop

The 27 knobs across `src/config.ts` are too many to tune by hand
across 2000+ maps. The autoresearch loop replaces the human tuner
with an LLM driving local search through hyperparameter space.

The full design rationale is in
[`AUTORESEARCH_PLAN.md`](./AUTORESEARCH_PLAN.md). What's below is
how the *as-built* system runs.

### The shape

```
                  one iteration
   ┌──────────────────────────────────────────────────┐
   │                                                  │
   │  1. Loop runner reads research_log.jsonl + program.md
   │  2. Loop runner asks Claude Code:                │
   │     "given these last 30 iterations,             │
   │      change ONE knob in research_program.ts"     │
   │  3. Claude returns a new research_program.ts     │
   │  4. Runner validates: must export TRAINING_CONFIG│
   │     with all 27 fields; out-of-bounds get clamped│
   │  5. Runner spawns research_eval.ts:              │
   │     - load research_program.ts                   │
   │     - train fresh agent, N seconds × M maps × K seeds
   │     - eval (deterministic policy mean), record holed-rate
   │     - emit one number on stdout (median across seeds)
   │  6. Runner compares to prior best:               │
   │     - strictly better → KEEP                     │
   │     - else            → revert from backup       │
   │  7. Runner appends a row to research_log.jsonl   │
   │                                                  │
   └──────────────────────────────────────────────────┘
              ↓
        loop again until stop condition
```

### What's frozen vs mutable

The loop edits exactly one file. Everything else is the evaluator and
must not move during a run.

**Mutable** (the loop edits between iterations):
- `research_program.ts` — exports `TRAINING_CONFIG` (the 27 knobs) and
  `NOTES` (a freeform paragraph the loop maintains across iterations
  to remember its own reasoning).

**Human-edited** (you, when redirecting the loop):
- `program.md` — priors, off-limits, what to try next. The loop
  re-reads it every iteration. If the loop's going off track, edit
  this file and it'll see the change immediately.

**Frozen** (the loop must not edit these):
- `port/web/src/game/physics.ts` — the simulator
- `src/env.ts` — Episode, simulateShot, reward formula
- `src/agent.ts`, `src/nn.ts` — the network
- `src/path.ts`, `src/hio.ts` — pathfinder + HIO search
- `src/config.ts` — `TrainingConfig` type, `DEFAULTS`
- Everything under `headless/` — the eval harness, atlas loader,
  track loader, eval/validation map sets, autoresearch bounds
- `research_eval.ts`, `research_loop.ts`, `research_analyze.ts` — the
  loop itself

### The 27 knobs

Defined in `src/config.ts` (`TrainingConfig`). Categories:

| Category | Knobs |
|---|---|
| Architecture | `gridSize`, `raySamples`, `radialRays`, `radialSamplesPerRay`, `radialRayMaxDist`, `useNavigation`, `hiddenSize` |
| Optimizer | `lr`, `gamma`, `batchSize`, `valueCoef`, `gradClip` |
| Action distribution | `meanScale`, `initLogStd`, `logStdMin`, `logStdMax` |
| Reward | `strokePenalty`, `holeBonus`, `waterPenalty`, `acidPenalty`, `progressBonus`, `explorationBonus` |
| Episode/runtime | `maxStrokes`, `numParallel` |
| Safety/search | `safetyRetries`, `learnFromRejectedShots`, `searchHIOFirst` |

`headless/autoresearch-bounds.ts` defines tighter bounds than the
user-facing `BOUNDS` in `config.ts`. Specifically, **`searchHIOFirst`
is locked at `0/0`** for autoresearch — with HIO on, the brute-force
pre-search solves nearly every curated eval map in <3s and the score
saturates at 1.0, hiding the RL policy from the metric. Same applies
to other "cheap-success" knobs like `safetyRetries` (capped at 12) and
`numParallel` (capped at 8).

### The metric

One scalar: **mean success rate across the eval map set, median by
seed**. `headless/maps.ts` defines:

- **EVAL_MAPS** (16 maps) — the loop scores against these.
- **VALIDATION_MAPS** (40 maps) — held-out, checked every 20 iterations
  to catch overfitting to the eval 16.

Each variant trains for `trainSecsPerMap` seconds × `seeds.length`
seeds × `EVAL_MAPS.length` maps. Per-seed scores are averaged across
maps; the median across seeds is the iteration's score.

The metric is **reward-formula-invariant** by design: changing reward
magnitudes doesn't directly move the score (only via second-order
effects on training dynamics). Stops the loop "winning" by inflating
`holeBonus`.

### How to drive it

Three ways:

1. **Browser** (easiest). Open `/autoresearch.html`, fill in the
   loop-control panel (training secs/seed, maps CSV, log path, max
   iterations), click **▶ Start**. Watch live. Click **■ Stop** when
   you want to. Stop kills the loop process tree (`taskkill /T /F` on
   Windows, `kill -TERM -<pgid>` on POSIX) so the loop AND its
   `claude --print` child AND any running eval all die together.

2. **`npm run ai:loop`** (CLI):
   ```bash
   npm run ai:loop -- --max-iterations 30 --agent-cmd 'claude --print'

   # single-map experiment with own log:
   node --experimental-strip-types research_loop.ts \
     --max-iterations 5 \
     --maps Watertankrun.track \
     --log-path research_log_watertankrun.jsonl \
     --agent-cmd 'claude --print'
   ```

3. **Manual eval** (no LLM): `npm run ai:eval` runs `research_eval.ts`
   with the current `research_program.ts`. Useful for "what does
   this hand-tuned config score?"

CLI flags worth knowing:

- `--train-secs N` — override training seconds per (map, seed).
  Lets you run "5 minutes per training" without editing budget presets.
- `--eval-eps N` — override eval episodes per (map, seed).
- `--seeds 42,7,123` — override seed list.
- `--maps CurveI.track,Watertankrun.track` — restrict to a subset.
- `--log-path X.jsonl` — write to a custom log so per-experiment runs
  don't pollute the main `research_log.jsonl`.

### Stop conditions

The loop runner stops on its own when:

- **Keep-rate floor** — fewer than 10% of the last 30 iterations were
  kept (the search has exhausted the local optimum at this resolution).
- **Score plateau** — no new best in 50 iterations.

Or, of course, when you click Stop / Ctrl-C / the user signals SIGINT.

### Live status files

The loop and eval write three small JSON files the dashboards poll:

- `.loop_pid.json` — pid + start time. Vite plugin uses this for the
  Stop button.
- `.loop_status.json` — current iteration, max, phase
  (`calling_agent` / `running_eval` / `finished`).
- `.eval_status.json` — eval-level: current map, seed, training pct.

Plus a JSONL event feed at `research_loop_events.jsonl` (one line per
key transition: `iteration_start`, `agent_call_start`,
`agent_call_done`, `eval_start`, `iteration_done`,
`shutdown_signal`, `loop_finished`, `stopped_by_user`). The live
dashboard tails this for the "what's happening right now" pane.

All of these are in `.gitignore` — they're regenerated every run.

---

## 11. Browser dashboards

The Vite dev server runs at **http://localhost:5180** and serves five
pages. Production builds (`npm run build`) bundle them all.

### `/index.html` — single-map trainer

The original. Pick a map from the dropdown, watch four agents train,
see live charts and stats. Every knob in `TrainingConfig` has a UI
input on the right-hand panel.

URL param: `?map=Foo.track` deep-links to a specific map. Selecting a
new map updates the URL so a refresh / shared link round-trips.

Mode dropdown:

- **training** — random shots from the policy distribution, weights
  update.
- **eval** — deterministic mean shot, weights frozen.
- **best** — replay the best-ever recorded action sequence (auto-loops).

When the agent reaches PERFECTED (hole-in-1 in eval mode), it
auto-switches to "best" mode.

Status badge:

| Badge | When you see it |
|---|---|
| **TRAINING** (gray) | Recent success rate < 50%. |
| **CONVERGING** (amber) | Recent success rate ≥ 50%. |
| **CONVERGED** (green) | Success ≥ 90% over last 50 episodes, 30+ lifetime, AND best ≤ human par when known. |
| **PERFECTED** (bright green) | Hole-in-one achieved in eval mode. Training auto-stops. |
| **LOADED** (blue) | Restored a CONVERGED save without enough fresh runs to confirm. |

### `/grid.html` — grid trainer

N maps training side-by-side, one cell per map. Add maps from the
dropdown; each cell is independent (own network, own config). Solved
cells stop training and replay their best route on a loop.

Persistence: the cell list is in localStorage so your custom set
survives refresh. ~10 MB per cell — don't add 200 unless you have RAM.

### `/autoresearch.html` — live dashboard

Read-while-running view of the autoresearch loop. Polls every 2 s.
Shows:

- **Loop control panel** — Start/Stop buttons, configuration inputs
  (training secs, maps CSV, log path, max iterations). Talks to the
  Vite plugin's `/api/loop/{start,stop,status,events}` endpoints.
- **Score chart** — best-so-far line + per-iteration dots
  (filled-green = kept, hollow-red = reverted), iteration numbers
  labelled.
- **Summary stats** — iterations, best score, total wall, knobs
  explored, maps tested.
- **Events feed** — color-coded scrolling log of every key transition
  (`iteration_start`, `agent_call_start/done`, `eval_start`,
  `iteration_done` KEPT/REVERTED, `stopped_by_user`).
- **Live status** — current map / seed / phase / pct progress bar
  while training/evaluating.
- **Per-map breakdown** — success rate per map for the latest iteration.
- **Iteration list** — newest-first, with the config diff vs the prior
  kept iteration plus the agent's NOTES.

Log dropdown switches between the main eval log, validation log, and
any per-experiment `research_log_*.jsonl` (auto-discovered).

### `/autoresearch-report.html` — post-run report

Static analysis of a completed loop run. Different from the live
dashboard: no polling, no live status, just one thorough render of the
JSONL log. Use after a run to answer "what did this loop actually
accomplish?"

Sections, top to bottom:

- **Verdict pill** — green ✓ / amber ~ / red ✕ keyed off best vs baseline.
- **Stat cards** — iterations, best score, wall time, knobs explored, maps.
- **Score evolution chart** — same as live, larger.
- **Per-knob trajectories** — only knobs that actually varied get a
  mini-chart with their distinct values listed. Lets you see "the
  loop only really tried these two knobs."
- **Iteration cards** — one per iteration with config diff, an
  extracted "Hypothesis" line, and the full reasoning blockquote
  from Claude's NOTES.
- **Configuration: baseline vs best** — side-by-side table of all 27
  knobs; differing values highlighted.
- **Recommendations** — when no improvement, lists knobs not yet
  tried in this run with one-line explanations of why each might help,
  plus copy-pasteable bash commands.

URL param: `?log=research_log_NAME.jsonl` selects the experiment.

### `/hio.html` — hole-in-one tracks list

Lists every track in `port/server/tracks/tracks/` with its scan
status. Filter by name substring; toggle view (HIO-able only / HIO-able
but humans never got 1 / wall-clip / all / no HIO / errors); sort by
candidates-tried, scan time, name, file.

Stat cards show:

- Total tracks scanned
- HIO-able (real, no wall-clips)
- **Unknown HIO** — HIO-able by physics AND human bestPar > 1. This
  is the candidate list of "humans missed this 1-stroke route." The
  amber-highlighted column shows the bestPar with the player name.
- Wall-clip — scan found a "HIO" but the trajectory phased through
  walls due to the physics quirk in §13. Hidden from the default list.
- Grid exhausted, timed out, errors, scan wall.

Each row's `open →` link goes to `/index.html?map=Foo.track`. The
single-track viewer's URL-param support lets you browse the list and
jump directly into any map.

The page auto-refreshes every 5 s while a scan is in progress, so the
list builds live without manual reloads.

---

## 12. The HIO scanner

`scripts/scan-hio.mjs` runs the brute-force HIO search on every track
and writes the results to `hio-scan.json`. The browser HIO list reads
from there.

Architecture:

- **8 worker threads** (configurable with `--workers`). Each worker
  handles one track at a time and posts the result back to the parent.
- **Per-map time budget** (configurable with `--budget-secs`,
  default 0 = unbounded). HIO-able maps usually find their answer in
  <1s; non-HIO-able maps exhaust the full ~35 000-shot grid (~5-15 min
  CPU each). The budget caps the worst case.
- **Checkpoints every 10 maps** to `hio-scan.json` so the page can
  render partial results.

Each scan record includes the track's `bestPar` and `bestPlayer` from
the .track I-line, so the dashboard can flag "physics says HIO-able
but no human ever logged 1" — the candidate list of unknown shortcuts.

### Wall-clip detection

The HIO scan ran into a physics quirk: some "HIO" results had the ball
travelling in a straight line *through walls* (see §13 for the
explanation). The scanner now **replays each HIO candidate** after the
search finds it and counts how many wall pixels the trajectory passed
through. If it's more than 5, the result is tagged `wall_clip: true`
and excluded from the default HIO list. One-way walls (values 20-23)
and illusion walls (19) are excluded from the wall-pixel count because
those are intentionally passable in the right direction.

Real HIOs clip 0 pixels of solid walls. Bogus ones clip 30+ (whole
wall thicknesses).

### CLI

```bash
# Full scan, default settings (8 workers, no time budget).
node --experimental-strip-types scripts/scan-hio.mjs

# Faster but less thorough (2-second budget per map).
node --experimental-strip-types scripts/scan-hio.mjs --budget-secs 2

# Different parallelism / resolution.
node --experimental-strip-types scripts/scan-hio.mjs \
  --workers 4 --angle-step 2 --power-step 5
```

`hio-scan.json` is gitignored — regenerable any time, takes 2-3 hours
unbudgeted.

---

## 13. Physics quirks the port carries

The physics engine in `port/web/src/game/physics.ts` is a faithful
port of the original Aapeli minigolf Java client. Two quirks worth
documenting:

### Inside-corner suppression (FIXED post-port)

The original `handleWallCollision` had an "inside-corner suppression"
rule: if `top + tl + left` were all walls (an L-shape), clear `top`
and `left` to false. The intent was "ball wedged in a corner shouldn't
double-bounce off both walls in one frame."

In practice, the rule fired purely on geometry — even when the ball
was just *approaching* the wall from below at vx=0, vy<0. The rule
cleared `top`, the subsequent reflection was skipped, and the ball
phased straight through the wall. The HIO scanner found dozens of
these "HIOs" — straight-line shots that ran through 4+ walls in
sequence. AdventureIV's `(0, 33)` was the canonical example.

The fix in `port/web/src/game/physics.ts:519-547` adds a velocity
check: each suppression now requires the ball's velocity to actually
point *into* the corner. The TL-corner suppression fires only when
`vx<0 AND vy<0`, etc. Genuine wedge cases (diagonal motion into a
concave corner) still suppress and the diagonal-reflection block
handles them. Glancing approaches now reflect normally off the single
wall they hit.

This intentionally diverges from the Java original. Three-pointer's
legitimate one-way-wall HIO still works; AdventureIV's bogus straight-
through-walls "HIO" no longer holes.

### One-way walls vs the wall-clip detector

Tile values 20-23 are "one-way walls" — passable in their nominal
direction. The wall-clip detector originally treated them as walls and
flagged shots that *legitimately* passed through them as bogus. Fixed
by narrowing the detector's wall-set to genuinely-solid values
(16-18, 27, 40-43, 46).

---

## 14. Files

```
port/ai/
├── HOW_IT_WORKS.md            # this file (canonical reference)
├── AUTORESEARCH.md            # quick reference for the autoresearch loop
├── AUTORESEARCH_PLAN.md       # original design doc (status: implemented)
├── program.md                 # ⚙ HUMAN edits this. Loop steering wheel.
│
├── index.html                 # single-map view
├── grid.html                  # grid view
├── autoresearch.html          # live autoresearch dashboard
├── autoresearch-report.html   # post-run autoresearch report
├── hio.html                   # HIO tracks list
│
├── research_program.ts        # ⚙ AGENT edits this. The 27-knob config.
├── research_eval.ts           # entry: load program → train → eval → emit one number
├── research_loop.ts           # autonomous-loop driver
├── research_analyze.ts        # log → ASCII plots
│
├── vite-plugin-autoresearch.ts # /api/loop/{start,stop,status,events}
├── vite.config.ts             # 5 entry points + plugin
├── package.json               # npm scripts: dev, ai:sanity, ai:eval, ai:loop, ai:analyze, ai:calibrate
│
├── headless/                  # FROZEN evaluator components
│   ├── atlases.ts             #   omggif-based GIF decoder for collision masks
│   ├── track-loader.ts        #   fs-based track loader (Node, mirrors src/loader.ts)
│   ├── harness.ts             #   train+eval one config on N maps → one number
│   ├── maps.ts                #   16 eval maps + 40 validation maps
│   └── autoresearch-bounds.ts #   tighter bounds that close gaming vectors
│
├── scripts/
│   ├── sanity-check.mjs       # one-time "do imports work in Node?" check
│   ├── calibration-smoke.mjs  # gridSize=5 vs gridSize=11 sanity check
│   ├── test-harness.mjs       # smoke: harness on CurveI
│   ├── test-headless-load.mjs # smoke: load + 1 episode in Node
│   ├── test-prompt.mjs        # smoke: claude --print prompt format
│   ├── test-real-iter.mjs     # smoke: one full claude --print iteration
│   ├── classify-tracks.mjs    # categorise all 2062 tracks by features (used to curate maps)
│   ├── curate-mapsets.mjs     # buckets classified tracks into eval/validation sets
│   ├── scan-hio.mjs           # full HIO scan (parallel, with wall-clip detection)
│   ├── scan-hio-worker.mjs    #   worker thread for the scan
│   └── summary.mjs            # text alternative to the autoresearch dashboard
│
├── src/
│   ├── main.ts                # entry for /index.html
│   ├── grid.ts                # entry for /grid.html
│   ├── autoresearch-dashboard.ts # entry for /autoresearch.html
│   ├── autoresearch-report.ts # entry for /autoresearch-report.html
│   ├── hio-page.ts            # entry for /hio.html
│   ├── nn.ts                  # tiny MLP (forward pass + Xavier init)
│   ├── agent.ts               # MLPAgent (actor-critic, REINFORCE backprop, state encoder)
│   ├── env.ts                 # Episode (wraps physics into a rollout, reward formulas)
│   ├── path.ts                # BFS pathfinder (multi-hole, ball-radius erosion, teleporters)
│   ├── hio.ts                 # brute-force hole-in-one search
│   ├── config.ts              # TrainingConfig type, DEFAULTS, BOUNDS, clampConfig, loadConfig/saveConfig
│   ├── render.ts              # canvas drawing (uses production TrackRenderer)
│   ├── chart.ts               # reward sparkline
│   ├── loader.ts              # browser-side track loader (Vite glob)
│   ├── tracks.ts              # enumerates all .track files via Vite glob
│   ├── storage.ts             # localStorage helpers (save/load policies)
│   └── track-data.ts          # (legacy, unused)
```

The agent imports physics directly from the main web client at
`../web/src/game/physics.ts` and `../web/src/game/map.ts`. Same
simulator the live game uses, so anything the agent learns to do, a
real player could in principle do too.

---

## 15. Common workflows

### Train one map fast

```
1. Open http://localhost:5180/
2. Pick a map from the dropdown
3. Slide speed up to ~500
4. Wait a few minutes for the badge to turn green
```

### Solve every curated map overnight

```
1. Open /grid.html
2. Add maps via the dropdown (or use the curated set)
3. Slide speed up to 1000+
4. Walk away
5. Come back, look at the solved/total counter
```

### Run autoresearch on a specific map

```
1. Open /autoresearch.html
2. Loop control: set
   - train secs/seed: 300  (5 minutes per training run)
   - maps:           Watertankrun.track
   - log file:       research_log_watertankrun.jsonl
   - max iterations: 1000
3. Click ▶ Start
4. Watch the events feed and chart fill in
5. Click ■ Stop when you've seen enough
```

### Find tracks where humans missed a 1-stroke solution

```
1. Run the HIO scan: node --experimental-strip-types scripts/scan-hio.mjs
2. Open /hio.html
3. Set "show" dropdown to "HIO-able but humans never got 1 (bestPar > 1)"
4. Click any row's "open →" to inspect the map in the single-track viewer
```

### Reset everything

- Browser: "delete saved policies" in the grid view's header wipes
  all localStorage entries.
- Autoresearch: `rm research_log*.jsonl` clears the loop history.
- HIO scan: `rm hio-scan.json` and re-run.

---

## 16. Glossary

- **Agent** — the thing playing the game. Here, a small MLP.
- **Episode** — one full attempt: from start to either holing or
  running out of strokes (`maxStrokes`, default 30).
- **Policy** — the agent's strategy. Maps state → action distribution.
- **Reward** — the scalar signal the agent uses to learn.
- **Rollout** — running the policy through one or more episodes to
  collect training data.
- **Trace** — recorded (state, action, value) per step, used by the
  learning pass.
- **Backprop** — the math that computes per-weight gradients.
- **Xavier init** — initial random weights that keep activations
  unit-scale through layers at init (avoids vanishing/exploding
  gradients).
- **σ (sigma)** — standard deviation of the action distribution.
- **γ (gamma)** — discount factor. 0.99 means the agent slightly
  prefers near-future rewards.
- **REINFORCE** — the classic policy-gradient algorithm; the
  grandparent of PPO and A2C.
- **HIO** — hole-in-one (1-stroke completion).
- **Wall-clip HIO** — a "HIO" trajectory that phased through walls
  because of the inside-corner-suppression quirk in physics. Fixed.
- **Autoresearch** — Karpathy-style autonomous local search through
  hyperparameter space, driven by an LLM.
- **PERFECTED** — status badge meaning the agent has found a
  hole-in-one in eval mode and training is auto-stopped.

---

## 17. Things that can go wrong

### "It's stuck at TRAINING forever"

Map is too hard for the current feature set / training budget. Try:

- A different map.
- Higher speed slider for more training episodes.
- Turn on `progressBonus` (small, e.g. 0.002) for dense gradient
  signal.
- Run `/autoresearch.html` on that single map and let the loop search
  the knob space.

### "Browser feels sluggish"

You're at slider 5000+ which pegs one CPU core. JavaScript is
single-threaded so there's no way to use more without Web Workers
(not implemented). Drop the slider or close the tab.

### "PERFECTED but success shows 0%"

Old save format from before perfection criteria were tightened. Click
"delete saved policies" in the grid header and let it retrain.

### "Autoresearch loop never makes progress"

If 5+ iterations all score 0, the metric isn't sensitive enough at
this budget to differentiate variants. Either:

- Increase `--train-secs` (default 60s preset, try 300s).
- Switch to a less hard map for calibration (harder maps need more
  training to surface signal).
- Add knobs that aren't in the current `TRAINING_CONFIG` — see "How
  to extend the mutable surface" in [`AUTORESEARCH.md`](./AUTORESEARCH.md).

### "HIO scanner takes forever"

A non-HIO-able map exhausts the full 35 000-shot grid (~5-15 min CPU).
Use `--budget-secs 2` for a fast first-pass scan, then re-run
unbudgeted on just the maps that interesting.

### "Loop dashboard says 'running' but nothing changes"

Iteration is in the `calling_agent` phase — Claude Code is generating
the next proposal (~25-30s per call). The eval phase is when you'll
see live progress on the chart.

### Stop button doesn't kill claude --print

It should. The Vite plugin's stop endpoint writes a `.loop_stop` flag
*and* runs `taskkill /T /F` (Windows) or `kill -TERM -<pgid>` (POSIX).
That tears down the loop, the running `claude --print`, and any
in-flight `research_eval.ts`. If a stale process survives, find it
with `tasklist | findstr node` (Windows) or `ps -ef | grep node`
(POSIX) and kill it manually.

---

That's the whole system. The codebase is around 4 000 lines of
TypeScript + 600 lines of HTML and CSS. Read `src/agent.ts` if you
want to see the actual learning math — every gradient is visible, no
deep-learning library used.
