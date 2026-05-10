// Print a per-iteration text summary of any research_log*.jsonl.
//
// Useful as a CLI alternative to the dashboard, especially after a
// loop run completes - shows the diff each iteration applied vs the
// last KEPT iteration, with score, kept/reverted, and notes.
//
// Usage:
//   node --experimental-strip-types scripts/summary.mjs [path-to-jsonl]
//   defaults to research_log.jsonl in port/ai/.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const aiRoot = resolve(here, "..");
const path = process.argv[2] ?? resolve(aiRoot, "research_log.jsonl");

if (!existsSync(path)) {
  console.error(`no such log: ${path}`);
  process.exit(1);
}

const rows = readFileSync(path, "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

if (rows.length === 0) {
  console.log("(empty log)");
  process.exit(0);
}

console.log(`# autoresearch summary: ${path}`);
console.log(`iterations: ${rows.length}`);
const best = Math.max(...rows.map((r) => r.score));
const kept = rows.filter((r) => r.kept).length;
console.log(`best score: ${best.toFixed(4)}  kept: ${kept}/${rows.length}  total wall: ${(rows.reduce((s, r) => s + (r.wall_secs ?? 0), 0) / 60).toFixed(1)}m`);
console.log("");

let lastKept = null;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  console.log(`---`);
  console.log(`iter #${i + 1}  ${r.kept ? "KEPT" : "REVERTED"}  score=${r.score.toFixed(4)}  prev_best=${r.prev_best?.toFixed(4) ?? "(first)"}  hash=${r.config_hash}  wall=${r.wall_secs?.toFixed(0) ?? "?"}s`);
  if (lastKept) {
    const diffs = [];
    for (const k of Object.keys(r.config)) {
      if (lastKept.config[k] !== r.config[k]) {
        diffs.push(`  ${k}: ${lastKept.config[k]} -> ${r.config[k]}`);
      }
    }
    if (diffs.length === 0) {
      console.log(`  (no config diff vs last kept iter #${rows.indexOf(lastKept) + 1})`);
    } else {
      console.log(`  diff vs last kept iter #${rows.indexOf(lastKept) + 1}:`);
      for (const d of diffs) console.log(d);
    }
  } else {
    console.log("  (initial baseline)");
  }
  if (r.per_map) {
    const summary = Object.entries(r.per_map)
      .map(([m, v]) => `${m}=${(v.success_rate * 100).toFixed(0)}%`)
      .join("  ");
    console.log(`  per_map: ${summary}`);
  }
  if (r.notes) {
    const oneLine = r.notes.replace(/\s+/g, " ").trim();
    console.log(`  notes: ${oneLine.slice(0, 280)}${oneLine.length > 280 ? "…" : ""}`);
  }
  if (r.kept) lastKept = r;
}
