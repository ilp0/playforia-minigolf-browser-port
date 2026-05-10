// Scan every track in port/server/tracks/tracks/ for a hole-in-one
// solution. Saves results to port/ai/hio-scan.json so /hio.html can
// render the list without re-scanning.
//
// HIO is brute-force: each map runs ~35,000 candidate shots through a
// fresh physics simulation and stops on the first one that holes. On a
// non-HIO-able map the search exhausts the full grid (~minutes of CPU).
// Two strategies for keeping total wall-time bounded:
//
//   1. Parallel workers (--workers, default 8). Node worker_threads
//      run independent searches across CPU cores. With N cores typical
//      machines have 8+, we can keep many maps in flight at once.
//   2. Per-map time budget (--budget-secs, default 0 = unbounded).
//      For "scan every map every pixel, just once" use 0; for a quick
//      first-pass use 30-60s.
//
// Each scan record carries the .track file's `bestPar` (the best human
// stroke count from the I-line in the .track metadata), so the
// dashboard can flag "HIO-able BUT no human ever holed in 1" - a
// candidate list of unknown HIO routes.
//
// Usage:
//   node --experimental-strip-types scripts/scan-hio.mjs \
//     [--workers 8] [--budget-secs 0] [--angle-step 1] [--power-step 2]

import { Worker } from "node:worker_threads";
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const aiRoot = resolve(here, "..");
const tracksDir = resolve(aiRoot, "../server/tracks/tracks");
const outPath = resolve(aiRoot, "hio-scan.json");
const workerScript = resolve(here, "scan-hio-worker.mjs");

const argv = process.argv.slice(2);
let budgetSecs = 0; // 0 = unbounded; default to "scan every pixel"
let numWorkers = Math.max(1, Math.min(os.cpus().length - 1, 8));
let angleStep = 1;
let powerStep = 2;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--budget-secs") budgetSecs = Number(argv[++i]);
  else if (argv[i] === "--workers") numWorkers = Number(argv[++i]);
  else if (argv[i] === "--angle-step") angleStep = Number(argv[++i]);
  else if (argv[i] === "--power-step") powerStep = Number(argv[++i]);
}
console.error(
  `[scan-hio] workers=${numWorkers} budget=${budgetSecs === 0 ? "unbounded" : budgetSecs + "s"} ` +
    `angleStep=${angleStep}° powerStep=${powerStep}px`,
);

const files = readdirSync(tracksDir)
  .filter((f) => f.endsWith(".track"))
  .sort();

console.error(`[scan-hio] scanning ${files.length} tracks ...`);
const t0 = Date.now();

const queue = files.slice();
const results = [];
let hioCount = 0;
let timeoutCount = 0;
let errCount = 0;
let completed = 0;

function saveCheckpoint() {
  const elapsed = (Date.now() - t0) / 1000;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        scanned_at: new Date().toISOString(),
        total: files.length,
        completed,
        hio_count: hioCount,
        err_count: errCount,
        timeout_count: timeoutCount,
        budget_secs: budgetSecs,
        workers: numWorkers,
        angle_step: angleStep,
        power_step: powerStep,
        elapsed_secs: elapsed,
        tracks: results,
      },
      null,
      2,
    ),
  );
}

function logProgress() {
  const elapsed = (Date.now() - t0) / 1000;
  const eta = (elapsed / Math.max(1, completed)) * (files.length - completed);
  process.stderr.write(
    `  ${completed}/${files.length}  hio=${hioCount}  timeout=${timeoutCount}  err=${errCount}  ` +
      `elapsed=${elapsed.toFixed(0)}s  eta=${eta.toFixed(0)}s\n`,
  );
}

await new Promise((done) => {
  let activeWorkers = 0;

  const dispatchNext = (worker) => {
    if (queue.length === 0) {
      worker.postMessage("exit");
      activeWorkers--;
      if (activeWorkers === 0) {
        // Final checkpoint on shutdown.
        logProgress();
        saveCheckpoint();
        done();
      }
      return;
    }
    const file = queue.shift();
    worker.postMessage({ file, budgetSecs, angleStep, powerStep });
  };

  for (let w = 0; w < numWorkers; w++) {
    const worker = new Worker(workerScript, {
      execArgv: ["--experimental-strip-types"],
    });
    activeWorkers++;
    worker.on("message", (result) => {
      results.push(result);
      completed++;
      if (result.hio) hioCount++;
      else if (result.timed_out) timeoutCount++;
      if (result.error) errCount++;
      // Checkpoint every 10 maps so partial progress is browseable.
      if (completed % 10 === 0 || completed === files.length) {
        logProgress();
        saveCheckpoint();
      }
      dispatchNext(worker);
    });
    worker.on("error", (e) => {
      process.stderr.write(`[scan-hio] worker error: ${e.message}\n`);
      activeWorkers--;
      if (activeWorkers === 0) done();
    });
    // Initial dispatch.
    dispatchNext(worker);
  }
});

const elapsed = (Date.now() - t0) / 1000;
console.error(
  `[scan-hio] done: ${hioCount}/${files.length} HIO, ${timeoutCount} timed out, ${errCount} errors, ${elapsed.toFixed(0)}s wall (${numWorkers} workers)`,
);
console.error(`[scan-hio] wrote ${outPath}`);
