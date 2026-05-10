// research_eval.ts - the eval entry point.
//
// Per AUTORESEARCH_PLAN.md §4:
//   "A new script - call it research_eval.ts - that:
//     1. Loads a fixed set of N maps.
//     2. For each map: train fresh, eval, record success rate.
//     3. Average success rate across maps. EMITS ONE NUMBER.
//     4. Appends a row to research_log.jsonl."
//
// Per §6 we run **3 seeds and take the median** for noise control.
// The harness reports per-seed scores; this file does the median.
//
// Usage:
//   node --experimental-strip-types port/ai/research_eval.ts [--mode eval|validate|smoke] [--budget short|default|long]
//
//   - eval:     16-map eval set, 60s × 16 × 3 seeds = ~48 min wall.
//   - validate: 40-map held-out set, same budget structure → ~2 hours.
//   - smoke:    1 map, 1 seed, 5s budget. For "is the harness wired up at all".
//
// Output:
//   - stdout: ONE NUMBER (the score). Other diagnostics go to stderr.
//   - research_log.jsonl: one JSON line appended per invocation.
//
// The "one number to stdout" pattern is so the autoresearch loop runner
// can `cat $(node ... | tail -1)` and parse the score without bespoke
// machinery. Anything more interesting goes through the JSONL.

import {
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { TRAINING_CONFIG, NOTES } from "./research_program.ts";
import { runHarness, type HarnessResult } from "./headless/harness.ts";
import { EVAL_MAPS, VALIDATION_MAPS } from "./headless/maps.ts";
import {
  clampToAutoresearchBounds,
  AUTORESEARCH_BOUNDS,
} from "./headless/autoresearch-bounds.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(here, "../server/tracks/tracks");

/**
 * Verify every map file referenced by EVAL_MAPS + VALIDATION_MAPS
 * exists on disk. Cheap one-time check at startup so we fail fast
 * instead of after 12+ minutes of eval when a typo'd validation map
 * eventually gets loaded.
 */
function preflightMaps(): void {
  const all = [...EVAL_MAPS, ...VALIDATION_MAPS];
  const missing: string[] = [];
  for (const m of all) {
    const path = resolve(TRACKS_DIR, m.file);
    try {
      statSync(path);
    } catch {
      missing.push(m.file);
    }
  }
  if (missing.length > 0) {
    process.stderr.write(
      `[research_eval] PREFLIGHT FAILED: ${missing.length} map files missing:\n` +
        missing.map((f) => `  - ${f}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }
}

const LOG_PATH = resolve(here, "research_log.jsonl");
const VALIDATION_LOG_PATH = resolve(here, "research_validation_log.jsonl");

interface CliArgs {
  mode: "eval" | "validate" | "smoke";
  budget: "short" | "default" | "long";
  /** Optional: tag to attach to this row. Useful for experiment tracking
   *  ("baseline", "smoke", "manual-test", etc). */
  tag: string | null;
  /** CSV override for the map list. When set, the eval runs on these
   *  filenames instead of EVAL_MAPS / VALIDATION_MAPS. Lets the user
   *  drive the loop on a single map (or any custom subset) without
   *  editing maps.ts. */
  mapsOverride: string[] | null;
  /** Override the JSONL log path. Useful when running per-map loops
   *  side-by-side - each one gets its own log so the loop runner's
   *  prior_best computation isn't confused by other runs' scores. */
  logPath: string | null;
  /** Override training seconds per (map, seed) trial. When null, the
   *  budget preset (short/default/long) determines this. */
  trainSecs: number | null;
  /** Override number of eval episodes per (map, seed) trial. */
  evalEps: number | null;
  /** Override seeds. Default is 3 seeds for noise control. */
  seedsOverride: number[] | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: "eval",
    budget: "default",
    tag: null,
    mapsOverride: null,
    logPath: null,
    trainSecs: null,
    evalEps: null,
    seedsOverride: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i] as CliArgs["mode"];
    else if (a === "--budget") args.budget = argv[++i] as CliArgs["budget"];
    else if (a === "--tag") args.tag = argv[++i];
    else if (a === "--maps")
      args.mapsOverride = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--log-path") args.logPath = argv[++i];
    else if (a === "--train-secs") args.trainSecs = Number(argv[++i]);
    else if (a === "--eval-eps") args.evalEps = Number(argv[++i]);
    else if (a === "--seeds")
      args.seedsOverride = argv[++i].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  }
  return args;
}

function budgetFor(mode: CliArgs["mode"], budget: CliArgs["budget"]) {
  // Smoke: short and self-evidently correct - 1 map, 1 seed, 5s.
  if (mode === "smoke") {
    return { trainSecsPerMap: 5, evalEpisodesPerMap: 8, seeds: [42] };
  }
  // Eval / validate. Three pre-set budgets so the loop can request
  // "short" (early calibration) without re-thinking the formula.
  switch (budget) {
    case "short":
      return { trainSecsPerMap: 15, evalEpisodesPerMap: 16, seeds: [42, 123, 7] };
    case "long":
      return { trainSecsPerMap: 120, evalEpisodesPerMap: 32, seeds: [42, 123, 7] };
    case "default":
    default:
      return { trainSecsPerMap: 60, evalEpisodesPerMap: 24, seeds: [42, 123, 7] };
  }
}

/** Hash the config so the JSONL log can dedup identical re-runs. */
function configHash(cfg: typeof TRAINING_CONFIG): string {
  const ordered = Object.keys(cfg)
    .sort()
    .map((k) => `${k}=${(cfg as any)[k]}`)
    .join("|");
  return createHash("sha256").update(ordered).digest("hex").slice(0, 12);
}

/** Group a HarnessResult's per-map data by seed, then return the
 *  median-by-seed score. The harness's own `score` field is a flat mean
 *  - useful for diagnostics, but the loop wants the median across seeds
 *  to be robust to one bad seed. */
function medianBySeed(result: HarnessResult): number {
  const bySeed = new Map<number, number[]>();
  for (const m of result.perMap) {
    const ratio = m.holedCount / m.evalEpisodes;
    if (!bySeed.has(m.seed)) bySeed.set(m.seed, []);
    bySeed.get(m.seed)!.push(ratio);
  }
  const seedScores = [...bySeed.values()].map(
    (rs) => rs.reduce((a, b) => a + b, 0) / rs.length,
  );
  seedScores.sort((a, b) => a - b);
  const mid = Math.floor(seedScores.length / 2);
  return seedScores.length % 2 === 0
    ? (seedScores[mid - 1] + seedScores[mid]) / 2
    : seedScores[mid];
}

/** Read the JSONL log, return prior best score (or -Infinity if none). */
function priorBest(logPath: string): number {
  if (!existsSync(logPath)) return -Infinity;
  const lines = readFileSync(logPath, "utf8").trim().split(/\r?\n/);
  let best = -Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.score === "number" && r.score > best) best = r.score;
    } catch {
      // ignore
    }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mapsOverride) preflightMaps();
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();

  // Apply the autoresearch bounds. If the program tried to set
  // something outside the allowed range, we record both the requested
  // and the clamped value so the human can see the difference.
  const requestedCfg = { ...TRAINING_CONFIG };
  const clampedCfg = clampToAutoresearchBounds(requestedCfg);
  const wasClamped = JSON.stringify(requestedCfg) !== JSON.stringify(clampedCfg);

  const mapList = args.mode === "validate" ? VALIDATION_MAPS : EVAL_MAPS;
  const maps = args.mapsOverride
    ? args.mapsOverride
    : args.mode === "smoke" ? ["CurveI.track"] : mapList.map((m) => m.file);

  const presetBudget = budgetFor(args.mode, args.budget);
  const budget = {
    trainSecsPerMap: args.trainSecs ?? presetBudget.trainSecsPerMap,
    evalEpisodesPerMap: args.evalEps ?? presetBudget.evalEpisodesPerMap,
    seeds: args.seedsOverride ?? presetBudget.seeds,
  };

  process.stderr.write(
    `[research_eval] mode=${args.mode} budget=${args.budget} ` +
      `maps=${maps.length} trainSecs=${budget.trainSecsPerMap} ` +
      `evalEps=${budget.evalEpisodesPerMap} seeds=${budget.seeds.join(",")}\n`,
  );
  if (wasClamped) {
    process.stderr.write(`[research_eval] WARNING: config was clamped to bounds\n`);
  }

  // Live status file the dashboard polls. Throttle writes so we don't
  // hammer disk on every progress callback.
  const STATUS_PATH = resolve(here, ".eval_status.json");
  const writeStatus = (extra: Record<string, unknown>) => {
    try {
      writeFileSync(
        STATUS_PATH,
        JSON.stringify({
          running: true,
          mode: args.mode,
          budget: args.budget,
          maps: maps.length,
          seeds: budget.seeds,
          tag: args.tag,
          started_at: startedAt,
          ...extra,
        }),
      );
    } catch {
      // best effort
    }
  };
  writeStatus({ phase: "starting" });
  let lastStatusWrite = 0;

  const result = await runHarness({
    cfg: clampedCfg,
    maps,
    trainSecsPerMap: budget.trainSecsPerMap,
    evalEpisodesPerMap: budget.evalEpisodesPerMap,
    seeds: budget.seeds,
    onProgress: ({ map, seed, phase, pct }) => {
      // One stderr line per map/seed/phase transition (don't spam).
      if (pct === 1.0 || (phase === "train" && pct >= 0.5 && pct < 0.55)) {
        process.stderr.write(
          `  ${map} seed=${seed} ${phase} ${(pct * 100).toFixed(0)}%\n`,
        );
      }
      // Status file: throttle to every ~500 ms.
      const now = Date.now();
      if (now - lastStatusWrite > 500) {
        writeStatus({ phase, current_map: map, current_seed: seed, pct });
        lastStatusWrite = now;
      }
    },
  });
  writeStatus({ phase: "wrapping_up" });

  const score = medianBySeed(result);
  const meanScore = result.score;
  const logPathToUse = args.logPath
    ? resolve(args.logPath)
    : args.mode === "validate" ? VALIDATION_LOG_PATH : LOG_PATH;
  const prior = priorBest(logPathToUse);

  // Per-map summary for the JSONL. Aggregate across seeds.
  const perMapSummary = new Map<
    string,
    { holed: number; total: number; meanStrokesOnHoled: number; hioWonAny: boolean }
  >();
  for (const m of result.perMap) {
    const cur = perMapSummary.get(m.map) ?? {
      holed: 0,
      total: 0,
      meanStrokesOnHoled: 0,
      hioWonAny: false,
    };
    cur.holed += m.holedCount;
    cur.total += m.evalEpisodes;
    if (Number.isFinite(m.meanStrokesOnHoled)) {
      cur.meanStrokesOnHoled =
        (cur.meanStrokesOnHoled * (cur.total - m.evalEpisodes) +
          m.meanStrokesOnHoled * m.holedCount) /
        Math.max(1, cur.total);
    }
    if (m.hioWon) cur.hioWonAny = true;
    perMapSummary.set(m.map, cur);
  }

  const row = {
    timestamp: startedAt,
    mode: args.mode,
    budget: args.budget,
    tag: args.tag,
    score, // PRIMARY: median-by-seed mean-across-maps success rate
    score_mean: meanScore, // backup: flat mean across all (map, seed) trials
    prev_best: prior,
    kept: score > prior, // strict-better-or-revert per §6
    wall_secs: (Date.now() - wallStart) / 1000,
    map_count: maps.length,
    train_secs_per_map: budget.trainSecsPerMap,
    eval_episodes_per_map: budget.evalEpisodesPerMap,
    seeds: budget.seeds,
    config_hash: configHash(clampedCfg),
    config: clampedCfg,
    config_was_clamped: wasClamped,
    requested_config: wasClamped ? requestedCfg : null,
    notes: NOTES.replace(/\s+/g, " ").trim().slice(0, 500),
    per_map: Object.fromEntries(
      [...perMapSummary.entries()].map(([k, v]) => [
        k,
        {
          success_rate: v.holed / v.total,
          mean_strokes_on_holed: Number.isFinite(v.meanStrokesOnHoled)
            ? Number(v.meanStrokesOnHoled.toFixed(2))
            : null,
          hio_won_any_seed: v.hioWonAny,
        },
      ]),
    ),
  };

  appendFileSync(logPathToUse, JSON.stringify(row) + "\n");
  writeStatus({ phase: "done", final_score: score });

  process.stderr.write(
    `[research_eval] done: score=${score.toFixed(4)} ` +
      `(prev best=${prior === -Infinity ? "none" : prior.toFixed(4)}, ` +
      `kept=${row.kept}, wall=${row.wall_secs.toFixed(1)}s)\n`,
  );

  // PRIMARY OUTPUT - last line on stdout is the score, parsable by the loop.
  process.stdout.write(score.toFixed(6) + "\n");
}

main().catch((e) => {
  process.stderr.write(`[research_eval] FATAL: ${e?.stack ?? e}\n`);
  process.exit(1);
});
