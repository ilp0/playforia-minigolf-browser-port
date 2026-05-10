// Use the cached classification to pick eval (16) and validation (40) sets.
// Goals (per AUTORESEARCH_PLAN.md §4 + user spec):
//   easy:     bestPar 1-2, no hazards, no teleports, simple geometry,
//             plays >= 50000 (well-tested popular maps).
//   hazard:   hazards > 0, plays >= 30000, no teleports (don't muddle with
//             other categories).
//   teleport: teleStarts >= 1 AND teleExits >= 1.
//   hard:     bestPar >= 4 OR avgStrokes high; popular but takes patience.
//
// Eval = 16 maps (4/4/4/4). Validation = 40 maps (10/10/10/10), disjoint.
// Both sets include the curated maps already used in the UI as a sanity
// check baseline (CurveI, OvalI etc are eval).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(here, "../headless/track-classification.json");
const data = JSON.parse(readFileSync(CACHE, "utf8"));

const entries = Object.entries(data).map(([file, r]) => ({ file, ...r }));

// Filter pools.
const easy = entries.filter(
  (r) =>
    r.bestPar >= 1 &&
    r.bestPar <= 2 &&
    r.hazards === 0 &&
    r.teleStarts === 0 &&
    r.teleExits === 0 &&
    r.mines === 0 &&
    r.magnets === 0 &&
    r.movable === 0 &&
    r.plays >= 50000,
);
easy.sort((a, b) => b.plays - a.plays);

const hazard = entries.filter(
  (r) =>
    r.hazards >= 30 && // meaningful amount of hazard, not just a sliver
    r.teleStarts === 0 &&
    r.teleExits === 0 &&
    r.bestPar >= 1 &&
    r.bestPar <= 4 &&
    r.plays >= 30000,
);
hazard.sort((a, b) => b.hazards * (b.plays / 100000) - a.hazards * (a.plays / 100000));

const teleport = entries.filter(
  (r) =>
    r.teleStarts >= 1 &&
    r.teleExits >= 1 &&
    r.plays >= 20000 &&
    r.bestPar >= 1 &&
    r.bestPar <= 4,
);
teleport.sort((a, b) => b.plays - a.plays);

const hard = entries.filter(
  (r) =>
    r.bestPar >= 4 &&
    r.plays >= 30000 &&
    // skip teleport-required hard maps (they go in teleport)
    r.teleStarts === 0 &&
    r.teleExits === 0,
);
hard.sort((a, b) => b.bestPar * 100000 + b.plays - (a.bestPar * 100000 + a.plays));

console.log(`Pools: easy=${easy.length}, hazard=${hazard.length}, tele=${teleport.length}, hard=${hard.length}`);
console.log("\nTop 20 easy:");
for (const r of easy.slice(0, 20))
  console.log(`  ${r.file.padEnd(34)} par=${r.bestPar} plays=${r.plays} avg=${r.avgStrokes.toFixed(2)}`);
console.log("\nTop 20 hazard:");
for (const r of hazard.slice(0, 20))
  console.log(`  ${r.file.padEnd(34)} par=${r.bestPar} plays=${r.plays} hz=${r.hazards}`);
console.log("\nTop 20 teleport:");
for (const r of teleport.slice(0, 20))
  console.log(
    `  ${r.file.padEnd(34)} par=${r.bestPar} plays=${r.plays} ts=${r.teleStarts} te=${r.teleExits}`,
  );
console.log("\nTop 20 hard:");
for (const r of hard.slice(0, 20))
  console.log(
    `  ${r.file.padEnd(34)} par=${r.bestPar} plays=${r.plays} avg=${r.avgStrokes.toFixed(2)}`,
  );

// Manual curation: pick eval (4 each) + validation (10 each), disjoint.
// Anchor eval set on the maps the UI already shows so we have parity with
// what the human eyeballs day-to-day.
const ANCHOR = ["CurveI.track", "OvalI.track", "CurveII.track", "OvalIII.track", "BarbII.track", "100degrees.track"];

function take(pool, n, exclude) {
  const out = [];
  for (const r of pool) {
    if (exclude.has(r.file)) continue;
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

const used = new Set();

// EVAL easy: anchor with CurveI / OvalI (both par 1-2 simple ovals).
// Then 2 more from the popular easy pool.
const evalEasy = [];
for (const f of ["CurveI.track", "OvalI.track"]) {
  const r = entries.find((e) => e.file === f);
  if (r && !used.has(f)) {
    evalEasy.push(r);
    used.add(f);
  }
}
for (const r of take(easy, 2, used)) {
  evalEasy.push(r);
  used.add(r.file);
}

// EVAL hazard: BarbII anchor + 3 more.
const evalHazard = [];
for (const f of ["BarbII.track"]) {
  const r = entries.find((e) => e.file === f);
  if (r && r.hazards > 0 && !used.has(f)) {
    evalHazard.push(r);
    used.add(f);
  }
}
for (const r of take(hazard, 4 - evalHazard.length, used)) {
  evalHazard.push(r);
  used.add(r.file);
}

// EVAL teleport: top 4 by popularity, prefer balanced start/exit counts.
const evalTele = take(teleport, 4, used);
for (const r of evalTele) used.add(r.file);

// EVAL hard: include 100degrees if it qualifies as hard, else top 4.
const evalHard = [];
const hundred = entries.find((e) => e.file === "100degrees.track");
if (hundred && hundred.bestPar >= 4 && !used.has("100degrees.track")) {
  evalHard.push(hundred);
  used.add("100degrees.track");
}
for (const r of take(hard, 4 - evalHard.length, used)) {
  evalHard.push(r);
  used.add(r.file);
}

// VALIDATION sets: 10 each, disjoint from eval.
const valEasy = take(easy, 10, used);
for (const r of valEasy) used.add(r.file);

const valHazard = take(hazard, 10, used);
for (const r of valHazard) used.add(r.file);

const valTele = take(teleport, 10, used);
for (const r of valTele) used.add(r.file);

const valHard = take(hard, 10, used);
for (const r of valHard) used.add(r.file);

const result = {
  eval: { easy: evalEasy, hazard: evalHazard, teleport: evalTele, hard: evalHard },
  val: { easy: valEasy, hazard: valHazard, teleport: valTele, hard: valHard },
};

console.log("\n=== EVAL (16) ===");
for (const cat of ["easy", "hazard", "teleport", "hard"]) {
  console.log(`-- ${cat} (${result.eval[cat].length}) --`);
  for (const r of result.eval[cat]) {
    console.log(
      `  ${r.file.padEnd(34)} par=${r.bestPar} plays=${r.plays} hz=${r.hazards} ts=${r.teleStarts} te=${r.teleExits} avg=${r.avgStrokes.toFixed(2)}`,
    );
  }
}
console.log("\n=== VALIDATION (40) ===");
for (const cat of ["easy", "hazard", "teleport", "hard"]) {
  console.log(`-- ${cat} (${result.val[cat].length}) --`);
  for (const r of result.val[cat]) {
    console.log(
      `  ${r.file.padEnd(34)} par=${r.bestPar} plays=${r.plays} hz=${r.hazards} ts=${r.teleStarts} te=${r.teleExits} avg=${r.avgStrokes.toFixed(2)}`,
    );
  }
}

// Also report sanity sums.
const evalAll = [...evalEasy, ...evalHazard, ...evalTele, ...evalHard];
const valAll = [...valEasy, ...valHazard, ...valTele, ...valHard];
console.log(`\nTotals: eval=${evalAll.length}, val=${valAll.length}, overlap=${evalAll.filter((e) => valAll.some((v) => v.file === e.file)).length}`);

// Save for the writer.
writeFileSync(resolve(here, "../headless/curated-mapsets.json"), JSON.stringify(result, null, 2));
console.log(`\nSaved to: ${resolve(here, "../headless/curated-mapsets.json")}`);
