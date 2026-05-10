// Calibration smoke test (AUTORESEARCH_PLAN.md §10).
//
//   1. Build the harness. ✓
//   2. Hand-run two variants: gridSize=5 vs gridSize=11. Default everything else.
//   3. Verify the harness produces a score (one number) for each.
//   4. Confirm the one with bigger gridSize wins on hazard maps and roughly
//      ties on no-hazard maps - sanity check that the score reflects what we
//      already empirically know.
//
// To keep this fast (~2 min total), we use a 4-map subset (one per category)
// with a single seed. The standard research_eval is unchanged.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const toUrl = (p) => pathToFileURL(resolve(here, p)).href;

const { runHarness } = await import(toUrl("../headless/harness.ts"));
const { DEFAULTS } = await import(toUrl("../src/config.ts"));

// 4 maps, one per category - enough to check the cross-category claim
// (bigger grid wins on hazard, ties on easy) without burning 16 maps.
const SMOKE_MAPS = [
  "CurveI.track",       // easy (HIO-doable)
  "BarbII.track",       // hazard
  "Miniaturica.track",  // teleport
  "Threehills.track",   // hard
];

const SEEDS = [42];
const TRAIN_SECS = 15;
const EVAL_EPISODES = 12;

async function runVariant(label, overrides) {
  const cfg = { ...DEFAULTS, ...overrides, searchHIOFirst: 0 };
  process.stderr.write(`\n=== ${label}  cfg=${JSON.stringify(overrides)} ===\n`);
  const result = await runHarness({
    cfg,
    maps: SMOKE_MAPS,
    trainSecsPerMap: TRAIN_SECS,
    evalEpisodesPerMap: EVAL_EPISODES,
    seeds: SEEDS,
    onProgress: () => {},
  });
  for (const m of result.perMap) {
    process.stderr.write(
      `  ${m.map.padEnd(24)} holed=${m.holedCount}/${m.evalEpisodes}` +
        ` (${(m.holedCount / m.evalEpisodes).toFixed(2)})` +
        ` strokes=${Number.isFinite(m.meanStrokesOnHoled) ? m.meanStrokesOnHoled.toFixed(1) : "—"}\n`,
    );
  }
  process.stderr.write(`  >>> overall score=${result.score.toFixed(4)} wall=${result.totalWallSecs.toFixed(1)}s\n`);
  return result;
}

const small = await runVariant("variant A: gridSize=5", { gridSize: 5 });
const large = await runVariant("variant B: gridSize=11", { gridSize: 11 });

process.stderr.write("\n=== summary ===\n");
process.stderr.write(`gridSize=5  score = ${small.score.toFixed(4)}\n`);
process.stderr.write(`gridSize=11 score = ${large.score.toFixed(4)}\n`);
process.stderr.write(`delta = ${(large.score - small.score).toFixed(4)}  (+ favours larger grid)\n`);
process.stderr.write("\n=== per-map delta (gridSize=11 minus gridSize=5) ===\n");
for (let i = 0; i < small.perMap.length; i++) {
  const a = small.perMap[i].holedCount / small.perMap[i].evalEpisodes;
  const b = large.perMap[i].holedCount / large.perMap[i].evalEpisodes;
  process.stderr.write(`  ${small.perMap[i].map.padEnd(24)} ${(b - a).toFixed(2)}\n`);
}
process.stderr.write(
  "\nExpectation: larger grid should help on hazard map (BarbII), should tie or " +
    "modestly help on easy/teleport, may help on hard. If results are noisy " +
    "(small wins/losses), bump TRAIN_SECS or EVAL_EPISODES.\n",
);
