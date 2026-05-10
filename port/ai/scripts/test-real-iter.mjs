// End-to-end test of one real autoresearch iteration.
//
// Uses --eval-mode smoke so the eval is fast (5s training on 1 map),
// but the agent call is REAL: claude --print sees the actual prompt
// and proposes a real edit.
//
// Backs up research_program.ts before, restores after - leaves the
// repo state unchanged regardless of outcome.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const aiRoot = resolve(here, "..");

const programPath = resolve(aiRoot, "research_program.ts");
const backupPath = resolve(aiRoot, ".test-real-iter.backup");
const logPath = resolve(aiRoot, "research_log.jsonl");

console.error("[test-real-iter] backing up research_program.ts and research_log.jsonl");
copyFileSync(programPath, backupPath);
const logBackup = resolve(aiRoot, ".test-real-iter.log.backup");
const hadLog = existsSync(logPath);
if (hadLog) copyFileSync(logPath, logBackup);

// Save log size so we can show only NEW rows.
const logSizeBefore = hadLog ? readFileSync(logPath, "utf8").length : 0;

console.error("[test-real-iter] running 1 real iteration with claude --print + smoke eval ...");
const t0 = Date.now();
const res = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    resolve(aiRoot, "research_loop.ts"),
    "--max-iterations", "1",
    "--eval-mode", "smoke",
    "--agent-cmd", "claude --print",
  ],
  { stdio: "inherit", cwd: aiRoot },
);
const dt = (Date.now() - t0) / 1000;
console.error(`[test-real-iter] elapsed: ${dt.toFixed(1)}s status=${res.status}`);

console.error("\n[test-real-iter] new log row:");
if (existsSync(logPath)) {
  const after = readFileSync(logPath, "utf8");
  const newPart = after.slice(logSizeBefore).trim();
  if (newPart) {
    try {
      const row = JSON.parse(newPart.split("\n").pop());
      console.error(JSON.stringify({
        score: row.score,
        prev_best: row.prev_best,
        kept: row.kept,
        config_hash: row.config_hash,
        wall_secs: row.wall_secs,
      }, null, 2));
    } catch {
      console.error(newPart.slice(0, 500));
    }
  } else {
    console.error("  (no new rows - eval likely failed)");
  }
}

console.error("\n[test-real-iter] restoring research_program.ts and research_log.jsonl");
copyFileSync(backupPath, programPath);
unlinkSync(backupPath);
if (hadLog) {
  copyFileSync(logBackup, logPath);
  unlinkSync(logBackup);
} else if (existsSync(logPath)) {
  unlinkSync(logPath);
}
console.error("[test-real-iter] done.");
process.exit(res.status ?? 0);
