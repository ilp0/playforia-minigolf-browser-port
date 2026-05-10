# Autoresearch — quick reference

Focused user manual for the autoresearch loop. For the full system
overview (browser dashboards, HIO scanner, training, etc.) see
[`HOW_IT_WORKS.md`](./HOW_IT_WORKS.md).

## What it does

Drives an LLM (Claude Code by default) to search the 27-knob
`TrainingConfig` space autonomously. Each iteration: read the log,
hypothesise one knob change, train + eval a fresh agent, keep if the
score improved or revert otherwise. Logs everything to JSONL so you
can see what was tried and why.

## Quick start

From `port/ai/`:

```bash
# Verify Node can import the RL modules (one-time)
npm run ai:sanity

# Smoke-test the eval harness (~10s)
npm run ai:eval:smoke

# Run the full eval at default budget (~16 maps × 3 seeds × 60s ≈ 48 min)
npm run ai:eval

# Print ASCII plots of the log
npm run ai:analyze

# Start the autonomous loop (CLI)
npm run ai:loop -- --max-iterations 30 --agent-cmd 'claude --print'

# Or drive it from the browser:
#   http://localhost:5180/autoresearch.html — loop control + live status
#   http://localhost:5180/autoresearch-report.html — post-run analysis
```

Single-map experiment (own log, won't pollute the main one):

```bash
node --experimental-strip-types research_loop.ts \
  --max-iterations 5 \
  --maps Watertankrun.track \
  --log-path research_log_watertankrun.jsonl \
  --train-secs 300 \
  --agent-cmd 'claude --print'
```

## CLI flags

`research_loop.ts` and `research_eval.ts` share these flags:

| Flag | Default | What it does |
|---|---|---|
| `--max-iterations N` | 30 (loop) | Stop after N iterations even if no stop condition trips |
| `--budget short\|default\|long` | default | Preset for trainSecs/evalEps/seeds (15/60/120s × 3 seeds) |
| `--train-secs N` | from budget | Override training seconds per (map, seed) |
| `--eval-eps N` | from budget | Override eval episodes per (map, seed) |
| `--seeds 42,123,7` | 3 seeds | Override seed list |
| `--maps F,G.track` | EVAL_MAPS | Run on a custom subset instead of headless/maps.ts |
| `--log-path X.jsonl` | research_log.jsonl | Per-experiment log file |
| `--agent-cmd 'CMD'` | claude --print | The LLM CLI to drive iterations |
| `--keep-rate-floor 0.1` | 0.1 | Stop when keep-rate over last 30 iters < this |
| `--plateau-window 50` | 50 | Stop when no new best in this many iters |
| `--validate-every 20` | 20 | Run a validation-set pass every N kept iters |
| `--dry-run` | off | Skip the LLM, run eval against current research_program.ts |

## What edits what

| File | Who edits | When |
|---|---|---|
| `program.md` | **You** | When the loop is going off track and you want to redirect it. The loop re-reads it every iteration. |
| `research_program.ts` | **The loop** | Every iteration. Don't edit manually — the loop will overwrite. |
| `headless/autoresearch-bounds.ts` | Frozen | Caps "cheap-success" knobs (safetyRetries, numParallel) to close gaming vectors |
| `headless/maps.ts` | Frozen | The 16 eval maps + 40 validation maps |
| Everything else under `headless/` and `src/` | Frozen | The evaluator. Editing it would let the loop "improve" by changing the measuring stick. |

## How a single iteration runs

1. Read `research_log.jsonl` (last 30 entries) and `program.md`.
2. Backup `research_program.ts` to `.research_program.ts.backup`.
3. Send program.md + log + current research_program.ts to `claude --print`.
4. Validate the response: must export `TRAINING_CONFIG` with all 27 fields.
   Anything outside `autoresearch-bounds.ts` is silently clamped.
5. Write the new research_program.ts.
6. Spawn `research_eval.ts` — it loads the new program, trains a
   fresh agent, evaluates, emits one number on stdout.
7. Compare to prior best (from the log). Strictly better → KEEP.
   Else → restore from backup.
8. Append a row to `research_log.jsonl`.
9. If `iteration % validateEvery == 0` and KEPT → run a validation
   pass on the held-out 40 maps.

The loop also writes per-iteration events to
`research_loop_events.jsonl` for the dashboard's live event feed.

## Stop conditions

- **Manual** — Ctrl-C (CLI) or click ■ Stop in the dashboard. The
  Vite plugin runs `taskkill /T /F` (Windows) / `kill -TERM -<pgid>`
  (POSIX) so the loop process tree dies cleanly (loop + claude
  --print + research_eval).
- **Keep-rate floor** — fewer than 10% of last 30 iters were kept.
- **Score plateau** — no new best in 50 iterations.

## How to extend the mutable surface

This is a deliberate human decision, not the loop's choice. Wait until
the keep-rate drops below ~10% on the 27-knob space, then:

1. Decide what to expose: encoder shape, optimizer choice, etc.
2. Add the field to `TrainingConfig` in `src/config.ts`.
3. Add to `AUTORESEARCH_BOUNDS` in `headless/autoresearch-bounds.ts`
   with sensible bounds that close the new gaming vector.
4. Add to `research_program.ts` with a starting value.
5. Update `program.md` with priors for the new knob.
6. Optional: reset `research_log.jsonl` for a clean restart, or keep
   for comparison.

## Calibration findings

- **HIO locked off** in autoresearch (`searchHIOFirst: {min:0,max:0}`).
  The brute-force pre-search solves nearly every curated eval map in
  <3s. With it on, score saturates at 1.0 and the RL policy becomes
  invisible to the metric.
- **Single-map default-budget runs scored 0.0** on Watertankrun
  across 5 iterations (progressBonus + initLogStd variants). The map
  is too hard at 60s × 3 seeds for the metric to discriminate. Bigger
  budget (`--train-secs 300`) or easier map are the next moves.
- **Loop machinery verified**: one full `claude --print` iteration
  takes ~30s in smoke mode. KEEP/REVERT logic, JSONL logging, ASCII
  plots all working.
