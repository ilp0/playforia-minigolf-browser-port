import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const toUrl = (p) => pathToFileURL(resolve(here, p)).href;

const { runHarness } = await import(toUrl("../headless/harness.ts"));
const { DEFAULTS } = await import(toUrl("../src/config.ts"));

console.log("Running 5s training + 8 eval episodes on CurveI ...");
const result = await runHarness({
  cfg: { ...DEFAULTS, searchHIOFirst: false },
  maps: ["CurveI.track"],
  trainSecsPerMap: 5,
  evalEpisodesPerMap: 8,
  seeds: [42],
});

console.log(`\nscore (mean holed/eval) = ${result.score.toFixed(4)}`);
console.log(`total wall time = ${result.totalWallSecs.toFixed(2)}s`);
for (const m of result.perMap) {
  console.log(`  ${m.map} seed=${m.seed}: trainEps=${m.trainEpisodes} (${m.trainSecs.toFixed(1)}s), holed=${m.holedCount}/${m.evalEpisodes} (mean strokes on holed = ${m.meanStrokesOnHoled.toFixed(2)})`);
}
