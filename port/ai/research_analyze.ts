// research_analyze.ts - read research_log.jsonl and print/plot health metrics.
//
// Per AUTORESEARCH_PLAN.md §7 item 7:
//   "A small analysis.ipynb (or .ts script if you'd rather avoid Python)
//    that plots score over iterations and surfaces the keep-rate. Look
//    at this before declaring 'the loop is working.'"
//
// Output is plain text + ASCII plots. For real plotting, pipe the
// JSON dump through any tool you like (Python's matplotlib, Excel, etc).
//
// Usage:
//   node --experimental-strip-types port/ai/research_analyze.ts [--log path]
//   node --experimental-strip-types port/ai/research_analyze.ts --json > data.json
//
// Outputs:
//   - Total iterations, kept iterations, keep-rate (lifetime + last 30)
//   - Best-score progression (the "is the loop converging" plot)
//   - Validation vs eval score (the "is it overfitting" check)
//   - Most-changed knobs (which fields varied across kept iterations)
//   - Diff from baseline (how the current best differs from iteration 1)

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

interface Row {
  timestamp: string;
  mode?: "eval" | "validate" | "smoke";
  score: number;
  prev_best: number | null;
  kept: boolean;
  config_hash: string;
  config: Record<string, number>;
  per_map?: Record<string, { success_rate: number; mean_strokes_on_holed: number | null; hio_won_any_seed: boolean }>;
}

function parseArgs(argv: string[]) {
  let logPath = resolve(here, "research_log.jsonl");
  let validationLogPath = resolve(here, "research_validation_log.jsonl");
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log") logPath = argv[++i];
    else if (a === "--validation-log") validationLogPath = argv[++i];
    else if (a === "--json") json = true;
  }
  return { logPath, validationLogPath, json };
}

function readLog(path: string): Row[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const rows: Row[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return rows;
}

/** ASCII line plot. Quick-and-dirty. Returns a multi-line string. */
function asciiPlot(values: number[], height = 10, width = 60): string {
  if (values.length === 0) return "(no data)";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const scaled = values.slice(-width).map((v) => ((v - min) / range) * (height - 1));
  const grid: string[][] = Array.from({ length: height }, () =>
    Array(scaled.length).fill(" "),
  );
  for (let x = 0; x < scaled.length; x++) {
    const y = height - 1 - Math.round(scaled[x]);
    if (y >= 0 && y < height) grid[y][x] = "#";
  }
  const lines = grid.map((row) => row.join(""));
  lines[0] = `${max.toFixed(3)} | ${lines[0]}`;
  lines[height - 1] = `${min.toFixed(3)} | ${lines[height - 1]}`;
  for (let i = 1; i < height - 1; i++) lines[i] = `        | ${lines[i]}`;
  lines.push("        +" + "-".repeat(scaled.length));
  return lines.join("\n");
}

/** Best-so-far at each row index. */
function runningBest(rows: Row[]): number[] {
  let best = -Infinity;
  return rows.map((r) => {
    if (r.score > best) best = r.score;
    return best;
  });
}

/** Rolling keep-rate over a window. */
function rollingKeepRate(rows: Row[], window: number): number[] {
  return rows.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = rows.slice(start, i + 1);
    return slice.filter((r) => r.kept).length / slice.length;
  });
}

function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—";
}

function summary(rows: Row[]): string {
  if (rows.length === 0) return "(no iterations logged)";

  const lifetimeKept = rows.filter((r) => r.kept).length;
  const lifetimeKeepRate = lifetimeKept / rows.length;
  const last30 = rows.slice(-30);
  const last30KeepRate = last30.filter((r) => r.kept).length / last30.length;
  const bestScore = Math.max(...rows.map((r) => r.score));
  const initialScore = rows[0].score;

  // Find the row with the best score (the current "best config").
  const bestRow = rows.reduce((a, b) => (a.score > b.score ? a : b));
  // Diff from iter 1's config to best config.
  const baseCfg = rows[0].config;
  const bestCfg = bestRow.config;
  const knobDiffs: Array<[string, number, number]> = [];
  for (const k of Object.keys(baseCfg)) {
    if (baseCfg[k] !== bestCfg[k]) {
      knobDiffs.push([k, baseCfg[k], bestCfg[k]]);
    }
  }

  // Knob churn: how many distinct values has each knob taken across all
  // iterations? Tells the human which knobs the loop has actually
  // searched vs which it hasn't tried.
  const churn = new Map<string, Set<number>>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.config)) {
      if (!churn.has(k)) churn.set(k, new Set());
      churn.get(k)!.add(v as number);
    }
  }
  const churnSorted = [...churn.entries()]
    .map(([k, vals]) => [k, vals.size] as [string, number])
    .sort((a, b) => b[1] - a[1]);

  const lines: string[] = [];
  lines.push("=== autoresearch summary ===");
  lines.push(`iterations: ${rows.length}`);
  lines.push(`keep-rate (lifetime): ${fmtPct(lifetimeKeepRate)} (${lifetimeKept}/${rows.length})`);
  lines.push(`keep-rate (last 30):  ${fmtPct(last30KeepRate)}`);
  lines.push(`initial score: ${initialScore.toFixed(4)}`);
  lines.push(`best score:    ${bestScore.toFixed(4)}  (delta ${(bestScore - initialScore).toFixed(4)})`);
  lines.push(`best config hash: ${bestRow.config_hash}`);
  lines.push("");
  lines.push("--- score history (running best) ---");
  lines.push(asciiPlot(runningBest(rows)));
  lines.push("");
  lines.push("--- per-iteration score ---");
  lines.push(asciiPlot(rows.map((r) => r.score)));
  lines.push("");
  lines.push("--- keep-rate (rolling 30) ---");
  lines.push(asciiPlot(rollingKeepRate(rows, 30)));
  lines.push("");
  if (knobDiffs.length > 0) {
    lines.push(`--- knobs changed from iter 1 → best (${knobDiffs.length}) ---`);
    for (const [k, a, b] of knobDiffs) {
      lines.push(`  ${k}: ${a} → ${b}`);
    }
    lines.push("");
  } else {
    lines.push("--- best config matches initial (no kept changes) ---");
    lines.push("");
  }
  lines.push("--- knob churn (distinct values tried) ---");
  for (const [k, n] of churnSorted.slice(0, 12)) {
    lines.push(`  ${k.padEnd(24)} ${n} value${n === 1 ? "" : "s"}`);
  }
  return lines.join("\n");
}

function compareWithValidation(evalRows: Row[], valRows: Row[]): string {
  if (valRows.length === 0) return "(no validation runs yet)";
  // Pair each validation row with the eval row closest in time.
  const lines: string[] = [];
  lines.push("=== validation vs eval ===");
  lines.push(`validation runs: ${valRows.length}`);
  for (const v of valRows) {
    // Find the eval row immediately before the validation row by timestamp.
    let prior: Row | null = null;
    for (const e of evalRows) {
      if (e.timestamp <= v.timestamp) prior = e;
    }
    if (prior) {
      const delta = v.score - prior.score;
      const sign = delta >= 0 ? "+" : "";
      lines.push(
        `  ${v.timestamp}  eval=${prior.score.toFixed(3)}  val=${v.score.toFixed(3)}  Δ=${sign}${delta.toFixed(3)}`,
      );
    } else {
      lines.push(`  ${v.timestamp}  val=${v.score.toFixed(3)}  (no matching eval)`);
    }
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const evalRows = readLog(args.logPath);
  const valRows = readLog(args.validationLogPath);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          eval_rows: evalRows.length,
          validation_rows: valRows.length,
          best_score: evalRows.length ? Math.max(...evalRows.map((r) => r.score)) : null,
          keep_rate_lifetime:
            evalRows.length > 0
              ? evalRows.filter((r) => r.kept).length / evalRows.length
              : null,
          running_best: runningBest(evalRows),
          per_iteration_score: evalRows.map((r) => r.score),
          rolling_keep_rate: rollingKeepRate(evalRows, 30),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(summary(evalRows));
  console.log("");
  console.log(compareWithValidation(evalRows, valRows));
}

main();
