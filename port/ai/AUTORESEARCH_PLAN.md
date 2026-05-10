# Autoresearch handoff plan

A plan for applying the *principles* of Karpathy's
[autoresearch](https://github.com/karpathy/autoresearch) to this RL trainer
(`port/ai`). **This is a design doc — no code yet.** The next agent
implements it.

The previous context window built a lot of mechanism (HIO search, safety
filter, pathfinder, navigation channel, ~27 tunable knobs, etc.). What
we *don't* have is a way to know which combinations actually win, beyond
"I watched the chart for 30 seconds and it looked OK." That's exactly
the gap autoresearch closes.

---

## 1. The six principles, ported to this domain

Karpathy's autoresearch hangs on six principles. Each maps cleanly here.

| Principle | What it means here |
|---|---|
| **Fixed time budget per trial** | Each variant gets exactly **N seconds of training across a fixed map set**, not "N episodes." Wall-clock budget closes the obvious gaming vector — variants that simulate fewer ticks don't get to claim more episodes. |
| **One mutable artifact** | The agent edits exactly **one file**: `port/ai/src/research_program.ts` (or equivalent). Everything else — physics, env.ts, the eval harness, the map list — is frozen. The most dangerous failure mode is the agent "improving" the score by editing its own measuring stick; freeze the evaluator. |
| **One scalar metric** | Pick one number that's invariant to architectural changes. See §3. Don't add "tiebreakers" or composite scores during the run — that's gameable. |
| **Autonomous loop, not a grid** | No pre-defined parameter sweep. The agent reads the prior log, hypothesises one change, runs, scores, keeps-or-reverts, repeats. Each step is conditioned on what just happened. |
| **`program.md` as the steering wheel** | A plain-English file with research directions, hints, off-limits. The human edits *this*, not the code. |
| **Small enough to fit in context** | The mutable surface should be ~200 lines max. The agent can re-read everything every iteration without paging out. |

---

## 2. What's mutable vs frozen

### Frozen (the evaluator can't touch these)

- `port/web/src/game/physics.ts` — physics simulation. Source of truth.
- `port/ai/src/env.ts` — `Episode`, `simulateShot`, reward bookkeeping.
  The reward *formula* and the per-stroke outcome classification are
  load-bearing for fairness.
- `port/ai/src/path.ts` — pathfinder. Auxiliary fact about the world.
- The map list used for evaluation (see §4).
- The eval harness itself (the script that runs N seconds × N maps and
  emits one number).
- **`BOUNDS` (the per-knob clamp ranges in `config.ts`).** This is
  load-bearing for closing gaming vectors *structurally*, not just by
  prose hints in `program.md`. Specifically: cap `safetyRetries` at
  ~12 (it's a brute-force success multiplier — at 200 the policy isn't
  learning, the rejection-sample loop is just trying harder per shot),
  cap `numParallel` at 8 (per program.md), and bound `searchHIOFirst`
  / HIO candidate count from any future expansion. The agent setting
  a knob outside its bound is rejected by clampConfig before training
  starts; that's a hard wall instead of a soft suggestion.

### Mutable (where the agent gets to be creative)

The agent edits a single file `research_program.ts` that exports:

```ts
export const TRAINING_CONFIG: TrainingConfig = { /* all 27 knobs */ };
```

**Stance: config-only first, deliberately.** Karpathy's original is
config + architecture + optimizer in one file because nanochat had
been hand-tuned only at the architecture level — the knob space was
small. We have the opposite situation: 27 knobs, hand-tuned over many
sessions, with a defensible baseline. The first round of autoresearch
has plenty to chew on inside the config space alone, and giving the
agent the network code on day one would let it overshoot into
architecture redesigns before we know whether the knobs are even
load-bearing.

Expand the mutable surface only after **the loop's keep-rate drops
below ~10%** in the config-only space — that's the signal that
gradient-style local search has exhausted what the knobs can do.

**Knobs available now (from `port/ai/src/config.ts`):**
- Architecture: `gridSize`, `raySamples`, `radialRays`, `radialSamplesPerRay`,
  `useNavigation`, `hiddenSize`
- Optimizer: `lr`, `gamma`, `batchSize`, `valueCoef`, `gradClip`
- Action distribution: `meanScale`, `initLogStd`, `logStdMin`, `logStdMax`
- Reward: `strokePenalty`, `holeBonus`, `waterPenalty`, `acidPenalty`,
  `progressBonus`, `explorationBonus`
- Episode/runtime: `maxStrokes`, `numParallel`
- Safety/HIO: `safetyRetries`, `learnFromRejectedShots`, `searchHIOFirst`

That's 27 knobs — much bigger search space than autoresearch's nanochat.
The agent will need the `program.md` priors (§5) to navigate sensibly.

---

## 3. The one scalar metric — design decision

This is the biggest open question. Karpathy used `val_bpb` because it's
*"vocab-size-independent so architectural changes are fairly compared."*
We need a number with the same "fair across structural changes"
property.

**Candidates:**

1. **Mean R averaged across the eval map set, after fixed wall-clock training.**
   Pro: Already what we're optimising. Con: Reward magnitudes are
   *tunable* — the agent could "win" by inflating `holeBonus`, even
   though that doesn't represent better play.

2. **Mean strokes-to-hole on holed episodes, averaged across maps.**
   Pro: Reward-tuning-invariant; lower is better; corresponds directly
   to "play well." Con: Maps where the agent never holes contribute
   nothing — the agent could hyperfocus on one easy map.

3. **Success rate (% of episodes that holed), averaged across maps,
   after fixed training time.** Pro: Reward-invariant, clearly
   interpretable, robust across structural changes. Con: Saturates at
   100% on easy maps; loses signal once everything's solved.

4. **Composite: success rate × (par / mean-strokes-on-holed).** Pro:
   Captures both "did it solve it" AND "did it solve it well." Con:
   Composites are gameable — and if any map has `par=0` you've got a
   division-by-zero.

**Recommended starting point:** option 3, with a curated map set chosen
so ~half the maps are below the success-saturation point at the chosen
training budget. **Switch to option 4 only if the agent saturates
option 3 within the first few iterations.**

The metric must be reward-formula-invariant. Currently `progressBonus`
and `explorationBonus` shift the absolute R scale; success rate doesn't
care. Stick with binary "did it hole."

---

## 4. The eval harness (frozen)

A new script — call it `port/ai/research_eval.ts` — that:

1. Loads a fixed set of N maps. **Recommended: 12–20 maps** spanning
   easy, hazard-heavy, teleport-required, and known-hard. Hard-code the
   list; don't let the program touch it.
2. For each map:
   - Reads the current `research_program.ts` config.
   - Trains a fresh agent for `T` seconds (no carry-over).
   - Runs `K` eval episodes in `evalMode` (deterministic policy mean).
   - Records: success rate, mean strokes on holed, total wall-clock
     used.
3. Averages success rate across maps. **Emits ONE number.**
4. Appends a row to `research_log.jsonl`: `{timestamp, score, hash, …}`.

`T` should be small enough that one trial fits in a few minutes (so
~100 trials/night becomes feasible) but big enough that variants
actually have time to differentiate. **Start at T=60s per map ×
16 maps = ~16 minutes per trial.** Tune from there.

The harness MUST run **headless** — no canvas, no rAF, no DOM. That's
a meaningful chunk of work because the existing loop is browser-native.
The env.ts physics is already pure JS so it'll port; the renderer and
HIO overlay obviously don't.

**Held-out validation set.** With 16 fixed eval maps and 100+ trials,
overfitting to *those exact 16 maps* is essentially guaranteed. Pick
an additional **40 maps** the loop never sees during normal scoring
("validation maps"), and every 20 trials run the current best config
on them as a sanity check. If validation score keeps tracking eval
score: the loop is genuinely finding better configs. If validation
score plateaus or regresses while eval score climbs: the agent is
overfitting to the eval set and you should either rotate the eval set
or stop the loop. The validation maps are also frozen — never let
the agent see their identities.

**Storage isolation.** The existing trainer persists policies to
`localStorage` under `minigolf-ai:policy:v3:<map>` (and configs under
`minigolf-ai:config:v1:<map>`). The autoresearch loop trains from
scratch every trial (§6), so it must NOT write into those keys —
otherwise a bad mid-trial state leaks into the user-facing trainer
the next time they open the UI. Either give the harness its own
namespace (`minigolf-ai:autoresearch:<run-id>:…`) or run it with no
persistence at all. Same applies to any future cache (pathfinder
results, HIO results) — keep the autoresearch sandbox sealed off.

---

## 5. The `program.md` — the steering wheel

A plain-English file the *human* edits, the *agent* reads. Describes
research priors. Sketch:

```
Goal: improve mean success rate across the 16-map eval set.

Allowed: any change to research_program.ts. Architecture, hyper-
parameters, reward shaping coefficients are all fair game.

Off-limits:
- Don't disable safetyRetries or HIO search and call it "improvement."
  Those help the score in a way that doesn't generalise; if you remove
  them and score goes up, that's gaming, not progress.
- Don't increase numParallel past 8 — slow and not load-bearing.

Priors worth trying:
- progressBonus has been useful but is sensitive to magnitude (0.001 -
  0.005 range; bigger swamps the stroke penalty).
- gridSize and useNavigation interact: navigation channel pulls more
  weight when grid is small. Search them jointly.
- Reward shaping is more brittle than architectural changes. If you
  blow up the score with reward tweaks, revert eagerly.
- Initial logStd matters more on hazard-heavy maps. Worth varying.

Boring: don't tune log-std clamps unless something else is stuck.
Don't tune gradClip - it's been at 100 forever and that's fine.
```

**The agent reads program.md every iteration.** When the human notices
it's getting stuck or going off-track, they edit program.md. Not the
code.

---

## 6. The loop (per iteration)

```
1. Read research_log.jsonl (last 30 entries).
2. Read program.md.
3. Hypothesise ONE change to research_program.ts.
4. Apply the change.
5. Invoke research_eval.ts. Wait for the wall-clock budget.
6. Read the emitted score.
7. Compare against the prior best. Keep iff strictly better; revert
   otherwise. Append a row to research_log.jsonl with:
     { timestamp, score, prev_best, change_summary, kept: bool }
8. Loop.
```

Keep step 7 **binary**. No "this is within noise, count it as a tie" —
that's the path to the agent slowly drifting on noise. Strict-better-or-revert.

**Noise floor:** the score has variance because of stochastic policy
sampling and stochastic init. Run each variant **3 times** with
different seeds and take the **median**. That's the cost of fairness.
At T=60s × 16 maps × 3 seeds = 48 minutes per trial. ~30 trials/day on
one machine.

**These numbers are starting estimates, not gospel.** T=60s, 16 maps,
3 seeds — pick something, but the harness's first job (before any
autonomous loop) is **calibration**: run the same config 5–10 times,
measure inter-run variance, and check that *between-variant*
differences are bigger than *within-variant* noise. If they aren't:
either bump T (more training time per trial → less noise per trial)
or bump seed count (more trials averaged → tighter median). If
between-variant differences swamp the noise immediately, you can
shrink the budget to get more trials per day. The autoresearch loop
is only worth running once this signal-to-noise check passes.

---

## 7. Implementation tasks (handoff to next agent)

In rough dependency order:

0. **Node sanity-check (do this first, before estimating anything
   else).** Write a 30-line Node script that imports `env.ts`,
   `agent.ts`, `path.ts`, `hio.ts` and runs one `Episode` +
   `simulateShot` + a single training step. If it works: the harness
   is mostly glue (~200-300 lines per item 1). If it fails because
   anything reaches for `requestAnimationFrame`, `performance.now`,
   `localStorage`, browser `fetch`, or DOM types — the harness item
   becomes "refactor those modules to be runtime-agnostic *plus*
   write the harness," which is a multi-day refactor instead of a
   one-day glue job. The next agent needs to know which they're
   inheriting before they commit a deadline.
1. **Headless harness.** Strip the canvas/DOM dependency from a fork of
   the env+agent loop. Pure Node, no browser. Verify it produces
   identical results to the in-browser trainer for a fixed seed.
   *Rough size: 200-300 lines if step 0 passed cleanly; 1-2k lines
   plus refactor work if it didn't.*
2. **Eval map set.** Pick 16 maps. Document why each was chosen
   (easy/hazard/teleport/hard). Hard-code in the harness.
3. **`research_program.ts`.** Initial version exports the current
   defaults. Build one place the agent edits.
4. **`research_eval.ts`.** Glue: load program → train → eval → emit
   score. JSONL log. Median-of-3-seeds.
5. **`program.md`.** Initial steering wheel — copy §5 above as a
   starting draft. Refine after the first few iterations expose what
   the agent's tempted to try.
6. **The autonomous-loop runner — Claude Code in a while-loop reading
   `research_log.jsonl`.** This is the form closest to Karpathy's
   original (an LLM agent reads the log, hypothesises one change,
   edits the mutable file, invokes the eval, reads the score, decides
   keep/revert). Concretely: a small wrapper script that, in a loop,
   asks Claude Code to "read the log and program.md, propose one
   change to research_program.ts, write the change, run
   research_eval.ts, append the result." The harness emits JSON for
   the agent to parse. Manual runs of `research_eval.ts` should still
   produce the same artifact for human-driven debugging.
7. **Analysis notebook.** A small `analysis.ipynb` (or a `.ts` script
   if you'd rather avoid Python) that plots score over iterations and
   surfaces the keep-rate. Look at this before declaring "the loop is
   working."

---

## 8. Things to NOT do (failure modes I'd bet on)

- **Letting the agent edit env.ts or the eval harness.** It will
  accidentally make tiny changes that look harmless and turn out to be
  scoring-system tweaks. Hard wall on this; ideally the harness loads
  research_program.ts via dynamic import and nothing else.
- **Multiple metrics.** "Improve success AND speed AND best-strokes" is
  a way to argue any direction is good. One number.
- **Variable training budget per variant.** "Hard maps need more time"
  → suddenly the agent finds it can win by saying every map is hard.
  Fixed wall-clock per trial.
- **Carrying weights across trials.** Each trial trains *from scratch*.
  Otherwise an early lucky run becomes a permanent boost the
  successor variants didn't earn.
- **Trusting a single-seed result.** RL variance is huge. Median of 3.
  If 3 isn't enough variance, scale up; don't reduce.
- **Letting the loop run without periodic human review.** Skim the log
  daily. The agent will find ways to "win" that you didn't anticipate;
  the program.md is your only knob to redirect it.

---

## 9. What this gets us

If this works, you stop tuning 27 knobs by hand for 2,000 maps and
start writing research-direction notes. The agent's mechanical
iteration finds combinations and reveals which knobs are even
load-bearing. The lesson from autoresearch on nanochat was that the
loop **finds bugs and dead-weight features humans overlooked because
they're boring** — exactly what we have here (the rejected-sample
training that destabilised, the radial rays that may or may not
matter, etc.).

If it doesn't work, the failure is informative: it means the
hyperparameter space is well-tuned already, and further gains require
changing the *model class* (the encoder, the value head, the
gradient algorithm) — work no autoresearch loop can do without a
broader mutable surface.

---

## 10. One concrete first iteration

To prove the harness works before building the loop:

1. Build the harness.
2. Hand-run two variants: `gridSize=5` vs `gridSize=11`. Default
   everything else.
3. Verify the harness produces a score (one number) for each.
4. Confirm the one with bigger `gridSize` wins on hazard maps and
   roughly ties on no-hazard maps — sanity check that the score
   reflects what we already empirically know.

If that passes, the harness is trustworthy enough to drive an
autonomous loop. If it doesn't, the harness is the bug, not the agent.

---

## 11. Stop conditions

The loop should not run forever. Two stop conditions, evaluated after
each trial:

1. **Keep-rate floor.** Compute the rolling keep-rate over the last 30
   trials (`kept_count / 30`). If it drops below **~10%**, you've hit
   the local optimum the current mutable surface allows. Stop, hand
   the log back to the human, and decide whether to (a) widen the
   mutable surface (let the agent edit the agent code, the encoder, or
   the optimizer), (b) revise `program.md` with new priors, or (c)
   declare "tuning is done, the gains are now in the model class."
2. **Score plateau.** If the best score hasn't improved in 50
   consecutive trials, stop for the same reasons. This is a slower
   tripwire than keep-rate but catches the case where the agent keeps
   finding small wins that round to zero in absolute terms.

Don't lower these thresholds when the loop "feels close" to a
breakthrough. The thresholds exist precisely because human pattern-
matching on a noisy chart is unreliable; trust the rule.

The loop *can* be restarted after the human edits `program.md` or
expands the mutable surface — the rolling keep-rate window resets at
that point because the search space changed.
