// research_loop.ts - the autonomous-loop driver.
//
// Per AUTORESEARCH_PLAN.md §6:
//   1. Read research_log.jsonl (last 30 entries).
//   2. Read program.md.
//   3. Hypothesise ONE change to research_program.ts.
//   4. Apply the change.
//   5. Invoke research_eval.ts. Wait for the wall-clock budget.
//   6. Read the emitted score.
//   7. Compare against prior best. Keep-or-revert. Append a row.
//   8. Loop.
//
// This file is the runner. Steps 2-3 are LLM-shaped (Claude Code reading
// program.md and emitting an edit), so the runner shells out to a CLI.
// The default CLI is `claude` (Claude Code). If you want to drive the
// loop with a different agent (gpt, manual, etc), set --agent-cmd to
// the binary that takes the prompt on stdin and writes the new
// research_program.ts contents on stdout.
//
// Hard rules the runner enforces:
//   - Saves a copy of research_program.ts before every iteration. If
//     the score is worse, restores from the copy. The agent can't
//     accidentally drift the codebase.
//   - Validates the agent's output IS valid TypeScript that exports
//     TRAINING_CONFIG (typescript-import sanity check).
//   - Stops on the keep-rate / score-plateau triggers in §11.
//
// Usage:
//   node --experimental-strip-types port/ai/research_loop.ts \
//     --max-iterations 30 \
//     --budget short \
//     --agent-cmd 'claude --print --no-input'
//
// The loop is designed to be stoppable: SIGINT (Ctrl+C) finishes the
// current iteration cleanly, then exits. No state is lost.

import { spawnSync, execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  appendFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const PROGRAM_PATH = resolve(here, "research_program.ts");
const PROGRAM_BACKUP_PATH = resolve(here, ".research_program.ts.backup");
const LOG_PATH = resolve(here, "research_log.jsonl");
const PROGRAM_MD_PATH = resolve(here, "program.md");
const RUNNER_LOG_PATH = resolve(here, "research_runner_log.jsonl");
const LOOP_STATUS_PATH = resolve(here, ".loop_status.json");
const PID_PATH = resolve(here, ".loop_pid.json");
const EVENTS_PATH = resolve(here, "research_loop_events.jsonl");
const STOP_FLAG_PATH = resolve(here, ".loop_stop");

function writeLoopStatus(extra: Record<string, unknown>): void {
  try {
    writeFileSync(
      LOOP_STATUS_PATH,
      JSON.stringify({ updated_at: new Date().toISOString(), ...extra }),
    );
  } catch {
    // best effort
  }
}

function writePid(): void {
  try {
    writeFileSync(
      PID_PATH,
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
    );
  } catch {
    // best effort
  }
}

function clearPid(): void {
  try {
    if (existsSync(PID_PATH)) {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.unlinkSync(PID_PATH);
    }
  } catch {
    // best effort
  }
}

/** Append a single event line to research_loop_events.jsonl. The dashboard
 *  tails this for the "what is happening right now" narrative. */
function logEvent(event: string, extra: Record<string, unknown> = {}): void {
  try {
    appendFileSync(
      EVENTS_PATH,
      JSON.stringify({ ts: new Date().toISOString(), event, ...extra }) + "\n",
    );
  } catch {
    // best effort
  }
}

interface CliArgs {
  maxIterations: number;
  budget: "short" | "default" | "long";
  /** What --mode to pass to research_eval.ts. Set to "smoke" when
   *  testing the runner machinery (fast 1-map check) and "eval" for
   *  real loop iterations. */
  evalMode: "eval" | "smoke";
  agentCmd: string;
  /** Stop if last N kept-rate < this fraction. */
  keepRateFloor: number;
  keepRateWindow: number;
  /** Stop if no new best in this many iterations. */
  plateauWindow: number;
  /** Run a validation pass every N iterations. */
  validateEvery: number;
  /** If true, run one iteration WITHOUT calling an LLM - useful for
   *  testing the runner machinery against a fixed config. */
  dryRun: boolean;
  /** Optional: comma-separated map filenames. Pass-through to
   *  research_eval.ts so the loop can target a single map or any
   *  custom subset. */
  mapsCsv: string | null;
  /** Optional: alternate JSONL log path. Lets us run a side experiment
   *  (e.g., per-map loop on Watertankrun) without polluting the main
   *  research_log.jsonl. */
  logPath: string | null;
  /** Optional: override training seconds per (map, seed). */
  trainSecs: number | null;
  /** Optional: override eval episodes per (map, seed). */
  evalEps: number | null;
  /** Optional: comma-separated seeds list. */
  seedsCsv: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    maxIterations: 30,
    budget: "default",
    evalMode: "eval",
    agentCmd: "claude --print",
    keepRateFloor: 0.1,
    keepRateWindow: 30,
    plateauWindow: 50,
    validateEvery: 20,
    dryRun: false,
    mapsCsv: null,
    logPath: null,
    trainSecs: null,
    evalEps: null,
    seedsCsv: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-iterations") out.maxIterations = Number(argv[++i]);
    else if (a === "--budget") out.budget = argv[++i] as CliArgs["budget"];
    else if (a === "--eval-mode") out.evalMode = argv[++i] as CliArgs["evalMode"];
    else if (a === "--agent-cmd") out.agentCmd = argv[++i];
    else if (a === "--keep-rate-floor") out.keepRateFloor = Number(argv[++i]);
    else if (a === "--keep-rate-window") out.keepRateWindow = Number(argv[++i]);
    else if (a === "--plateau-window") out.plateauWindow = Number(argv[++i]);
    else if (a === "--validate-every") out.validateEvery = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--maps") out.mapsCsv = argv[++i];
    else if (a === "--log-path") out.logPath = argv[++i];
    else if (a === "--train-secs") out.trainSecs = Number(argv[++i]);
    else if (a === "--eval-eps") out.evalEps = Number(argv[++i]);
    else if (a === "--seeds") out.seedsCsv = argv[++i];
  }
  return out;
}

interface LogRow {
  timestamp: string;
  score: number;
  prev_best: number | null;
  kept: boolean;
  config_hash: string;
  notes?: string;
}

function readLog(logPath: string = LOG_PATH): LogRow[] {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, "utf8").trim().split(/\r?\n/);
  const rows: LogRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore corrupt lines
    }
  }
  return rows;
}

function priorBestScore(rows: LogRow[]): number {
  let best = -Infinity;
  for (const r of rows) if (r.score > best) best = r.score;
  return best;
}

/** Build the prompt for the agent. Per the plan, this is just:
 *    program.md + log tail + current research_program.ts.
 *  No prescribed step-by-step. The agent's job is to look at all three
 *  and emit a NEW research_program.ts. */
function buildAgentPrompt(rows: LogRow[], args: CliArgs): string {
  const programMd = readFileSync(PROGRAM_MD_PATH, "utf8");
  const currentProgram = readFileSync(PROGRAM_PATH, "utf8");
  const lastN = rows.slice(-30);
  const logExcerpt = lastN
    .map((r) =>
      JSON.stringify({
        timestamp: r.timestamp,
        score: r.score,
        prev_best: r.prev_best,
        kept: r.kept,
        config_hash: r.config_hash,
        notes: r.notes,
      }),
    )
    .join("\n");

  // Tell the agent what the eval is actually scoring against. Without
  // this, single-map runs see "score = 0.0" and reason about the
  // multi-map 16-map baseline (since program.md is written for that),
  // which produces correct intuition but mis-calibrated targets.
  const scopeNote = args.mapsCsv
    ? `**Scope:** this loop is running on the custom map subset \`${args.mapsCsv}\`.\n` +
      `Score is success-rate averaged across these maps × 3 seeds. The 16-map\n` +
      `baseline of 0.125 in program.md does not apply to this run; use the\n` +
      `JSONL log's prior iterations on the same scope as your reference.`
    : `**Scope:** this loop is running on the full 16-map eval set defined in\n` +
      `headless/maps.ts, score = mean success-rate × 3 seeds.`;

  return [
    "# autoresearch loop iteration",
    "",
    scopeNote,
    "",
    "## program.md (the steering wheel)",
    programMd,
    "",
    "## research_log.jsonl (last 30 entries; oldest first)",
    "```jsonl",
    logExcerpt || "(no prior iterations)",
    "```",
    "",
    "## current research_program.ts",
    "```typescript",
    currentProgram,
    "```",
    "",
    "## task",
    "Hypothesise ONE change to TRAINING_CONFIG. Edit research_program.ts ",
    "(only that file, only TRAINING_CONFIG and NOTES inside it). Update ",
    "NOTES to record what you changed and why. ",
    "",
    "Output: write the COMPLETE new contents of research_program.ts to ",
    "stdout, surrounded by a single ``` typescript code fence. Output ",
    "nothing else.",
  ].join("\n");
}

/** Strip the markdown code fence around the agent's output, leaving just
 *  the TypeScript. Tolerant of common fence variations. */
function stripCodeFence(s: string): string {
  // Find the first ``` and the last ```. Take what's between.
  const m = s.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)\n```/);
  if (m) return m[1].trim() + "\n";
  // Fallback: if there's no fence, assume the whole thing is the file.
  return s.trim() + "\n";
}

/** Run the LLM agent to produce a new research_program.ts. */
function callAgent(prompt: string, agentCmd: string): string {
  const parts = agentCmd.split(/\s+/);
  const result = spawnSync(parts[0], parts.slice(1), {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `agent command failed: status=${result.status}, stderr=${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Validate the proposed file at least imports as TypeScript and exports
 *  TRAINING_CONFIG. Imperfect (we'd need a type-checker for real) but
 *  catches "agent forgot the export keyword" and "agent dropped a knob". */
async function validateProgram(programSrc: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Light static check: must export TRAINING_CONFIG.
  if (!/export\s+const\s+TRAINING_CONFIG/.test(programSrc)) {
    return { ok: false, reason: "missing export const TRAINING_CONFIG" };
  }
  // Must mention every required field. We pull the field list off the
  // current TrainingConfig.
  const required = [
    "gridSize", "raySamples", "radialRays", "radialSamplesPerRay",
    "radialRayMaxDist", "useNavigation", "hiddenSize", "lr", "gamma",
    "batchSize", "valueCoef", "gradClip", "meanScale", "initLogStd",
    "logStdMin", "logStdMax", "strokePenalty", "holeBonus", "waterPenalty",
    "acidPenalty", "progressBonus", "explorationBonus", "maxStrokes",
    "numParallel", "safetyRetries", "learnFromRejectedShots",
    "searchHIOFirst",
  ];
  for (const k of required) {
    if (!programSrc.includes(k)) {
      return { ok: false, reason: `missing field: ${k}` };
    }
  }
  return { ok: true };
}

/** Run research_eval.ts. Returns the score (parsed from the last stdout
 *  line) and a flag for whether it crashed. */
function runEval(
  budget: CliArgs["budget"],
  mode: "eval" | "validate" | "smoke" = "eval",
  mapsCsv: string | null = null,
  logPath: string | null = null,
  trainSecs: number | null = null,
  evalEps: number | null = null,
  seedsCsv: string | null = null,
): { score: number; ok: boolean; stderr: string } {
  const evalArgs = [
    "--experimental-strip-types",
    resolve(here, "research_eval.ts"),
    "--mode",
    mode,
    "--budget",
    budget,
  ];
  if (mapsCsv) evalArgs.push("--maps", mapsCsv);
  if (logPath) evalArgs.push("--log-path", logPath);
  if (trainSecs != null) evalArgs.push("--train-secs", String(trainSecs));
  if (evalEps != null) evalArgs.push("--eval-eps", String(evalEps));
  if (seedsCsv) evalArgs.push("--seeds", seedsCsv);
  const result = spawnSync(process.execPath, evalArgs, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return { score: -Infinity, ok: false, stderr: result.stderr };
  }
  const lastLine = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  const score = Number(lastLine);
  return {
    score: Number.isFinite(score) ? score : -Infinity,
    ok: Number.isFinite(score),
    stderr: result.stderr,
  };
}

function shouldStop(rows: LogRow[], args: CliArgs): { stop: boolean; reason?: string } {
  // Keep-rate floor.
  if (rows.length >= args.keepRateWindow) {
    const window = rows.slice(-args.keepRateWindow);
    const kept = window.filter((r) => r.kept).length;
    const rate = kept / window.length;
    if (rate < args.keepRateFloor) {
      return {
        stop: true,
        reason: `keep-rate ${(rate * 100).toFixed(1)}% < floor ${(args.keepRateFloor * 100).toFixed(1)}% over last ${args.keepRateWindow} trials`,
      };
    }
  }
  // Score plateau.
  if (rows.length >= args.plateauWindow) {
    const recent = rows.slice(-args.plateauWindow);
    const olderBest = priorBestScore(rows.slice(0, -args.plateauWindow));
    const recentBest = priorBestScore(recent);
    if (recentBest <= olderBest) {
      return {
        stop: true,
        reason: `no improvement in ${args.plateauWindow} trials (recent best ${recentBest.toFixed(4)} <= older best ${olderBest.toFixed(4)})`,
      };
    }
  }
  return { stop: false };
}

function logRunner(event: object): void {
  appendFileSync(
    RUNNER_LOG_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
  );
}

let interrupted = false;
function onShutdownSignal(sig: string) {
  process.stderr.write(`\n[loop] ${sig} received - finishing current iteration\n`);
  interrupted = true;
  logEvent("shutdown_signal", { signal: sig });
}
process.on("SIGINT", () => onShutdownSignal("SIGINT"));
process.on("SIGTERM", () => onShutdownSignal("SIGTERM"));
process.on("exit", () => {
  clearPid();
});

/** Cross-platform graceful stop. Windows ignores SIGINT (Node's
 *  process.kill on win32 actually calls TerminateProcess), so we also
 *  poll a stop-flag file the Vite plugin can create. The flag is
 *  removed on loop start. */
function checkStopFlag(): boolean {
  if (existsSync(STOP_FLAG_PATH)) {
    interrupted = true;
    logEvent("stop_flag_seen");
    return true;
  }
  return false;
}

function clearStopFlag(): void {
  try {
    if (existsSync(STOP_FLAG_PATH)) {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.unlinkSync(STOP_FLAG_PATH);
    }
  } catch {
    // ignore
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  clearStopFlag(); // Drop any stale stop flag from a prior run.
  writePid();
  logEvent("loop_start", {
    max_iterations: args.maxIterations,
    budget: args.budget,
    train_secs: args.trainSecs,
    eval_eps: args.evalEps,
    maps: args.mapsCsv,
    log_path: args.logPath,
    dry_run: args.dryRun,
  });
  process.stderr.write(
    `[loop] starting: max=${args.maxIterations} budget=${args.budget} dry-run=${args.dryRun}\n`,
  );

  const effectiveLogPath = args.logPath ?? LOG_PATH;
  for (let iter = 1; iter <= args.maxIterations; iter++) {
    if (checkStopFlag() || interrupted) break;

    const rows = readLog(effectiveLogPath);
    const stop = shouldStop(rows, args);
    if (stop.stop) {
      process.stderr.write(`[loop] STOP: ${stop.reason}\n`);
      logRunner({ iteration: iter, event: "stop", reason: stop.reason });
      break;
    }

    process.stderr.write(`\n[loop] === iteration ${iter}/${args.maxIterations} ===\n`);

    // 1. Backup the current program.
    copyFileSync(PROGRAM_PATH, PROGRAM_BACKUP_PATH);
    const priorBest = priorBestScore(rows);
    process.stderr.write(`[loop] prior best score: ${priorBest === -Infinity ? "none" : priorBest.toFixed(4)}\n`);
    writeLoopStatus({
      running: true,
      iteration: iter,
      max_iterations: args.maxIterations,
      prior_best: priorBest === -Infinity ? null : priorBest,
      phase: args.dryRun ? "dry_run" : "calling_agent",
      log_path: args.logPath ?? null,
    });
    logEvent("iteration_start", {
      iteration: iter,
      max_iterations: args.maxIterations,
      prior_best: priorBest === -Infinity ? null : priorBest,
    });

    // 2-4. Get a new program (unless dry-run).
    if (!args.dryRun) {
      const prompt = buildAgentPrompt(rows, args);
      let proposed: string;
      logEvent("agent_call_start", { iteration: iter, prompt_chars: prompt.length });
      const agentStart = Date.now();
      try {
        const raw = callAgent(prompt, args.agentCmd);
        proposed = stripCodeFence(raw);
      } catch (e: any) {
        process.stderr.write(`[loop] agent call failed: ${e?.message}\n`);
        logRunner({ iteration: iter, event: "agent_error", error: String(e) });
        logEvent("agent_call_failed", { iteration: iter, error: String(e) });
        break;
      }
      const validation = await validateProgram(proposed);
      if (!validation.ok) {
        process.stderr.write(`[loop] proposed program invalid: ${validation.reason}\n`);
        logRunner({ iteration: iter, event: "invalid_proposal", reason: validation.reason });
        logEvent("invalid_proposal", { iteration: iter, reason: validation.reason });
        // Restore backup, skip this iteration.
        copyFileSync(PROGRAM_BACKUP_PATH, PROGRAM_PATH);
        continue;
      }
      writeFileSync(PROGRAM_PATH, proposed);
      process.stderr.write(`[loop] proposal applied (${proposed.length} chars)\n`);
      logEvent("agent_call_done", {
        iteration: iter,
        proposed_chars: proposed.length,
        secs: (Date.now() - agentStart) / 1000,
      });
    } else {
      process.stderr.write(`[loop] dry-run: skipping agent, using current program\n`);
    }

    // 5-6. Run eval, get score.
    writeLoopStatus({
      running: true,
      iteration: iter,
      max_iterations: args.maxIterations,
      prior_best: priorBest === -Infinity ? null : priorBest,
      phase: "running_eval",
      log_path: args.logPath ?? null,
    });
    logEvent("eval_start", { iteration: iter });
    const evalStart = Date.now();
    const { score, ok, stderr } = runEval(
      args.budget,
      args.evalMode,
      args.mapsCsv,
      args.logPath,
      args.trainSecs,
      args.evalEps,
      args.seedsCsv,
    );
    const evalSecs = (Date.now() - evalStart) / 1000;

    if (!ok) {
      process.stderr.write(`[loop] eval crashed:\n${stderr}\n`);
      logRunner({ iteration: iter, event: "eval_error", stderr: stderr.slice(0, 1000) });
      logEvent("eval_error", { iteration: iter, stderr: stderr.slice(0, 500) });
      copyFileSync(PROGRAM_BACKUP_PATH, PROGRAM_PATH);
      continue;
    }

    process.stderr.write(`[loop] score=${score.toFixed(4)} (was ${priorBest === -Infinity ? "none" : priorBest.toFixed(4)}, eval=${evalSecs.toFixed(1)}s)\n`);

    // 7. Keep or revert.
    const kept = score > priorBest;
    if (!kept) {
      process.stderr.write(`[loop] REVERT (score did not improve)\n`);
      copyFileSync(PROGRAM_BACKUP_PATH, PROGRAM_PATH);
    } else {
      process.stderr.write(`[loop] KEEP (new best)\n`);
    }
    logRunner({
      iteration: iter,
      event: "iteration_done",
      score,
      prior_best: priorBest === -Infinity ? null : priorBest,
      kept,
      eval_secs: evalSecs,
    });
    logEvent("iteration_done", {
      iteration: iter,
      score,
      prior_best: priorBest === -Infinity ? null : priorBest,
      kept,
      eval_secs: evalSecs,
    });

    // 8. Validation pass every N iterations (if score improved).
    // Skip validation when running on a custom map subset - the
    // validation maps are decoupled from any single-map experiment.
    if (kept && iter % args.validateEvery === 0 && !args.mapsCsv) {
      process.stderr.write(`[loop] running validation pass ...\n`);
      const valStart = Date.now();
      const valResult = runEval(args.budget, "validate");
      const valSecs = (Date.now() - valStart) / 1000;
      process.stderr.write(`[loop] validation score=${valResult.score.toFixed(4)} (${valSecs.toFixed(1)}s)\n`);
      logRunner({
        iteration: iter,
        event: "validation",
        score: valResult.score,
        eval_score_at_iteration: score,
        secs: valSecs,
      });
    }
  }

  writeLoopStatus({ running: false, phase: "finished", log_path: args.logPath ?? null });
  logEvent("loop_finished", { interrupted });
  clearPid();
  process.stderr.write(`\n[loop] finished\n`);
}

main().catch((e) => {
  process.stderr.write(`[loop] FATAL: ${e?.stack ?? e}\n`);
  process.exit(1);
});
