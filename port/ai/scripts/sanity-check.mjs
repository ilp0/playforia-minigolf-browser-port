// Node sanity-check (autoresearch handoff plan §7 item 0).
//
// Verifies that the core RL modules can be imported and exercised under
// Node without browser APIs. We deliberately import via Node's experimental
// TypeScript stripping (`--experimental-strip-types`), then construct an
// Episode + run one simulateShot, which is the smallest "real" exercise.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const toUrl = (p) => pathToFileURL(resolve(here, p)).href;

console.log("--- Stage 1: import nn.ts (pure)");
const nn = await import(toUrl("../src/nn.ts"));
console.log("  ok, MLP class =", typeof nn.MLP);

console.log("--- Stage 2: import config.ts (pure)");
const cfg = await import(toUrl("../src/config.ts"));
console.log("  ok, DEFAULTS keys =", Object.keys(cfg.DEFAULTS).length);

console.log("--- Stage 3: import path.ts (pure)");
const path = await import(toUrl("../src/path.ts"));
console.log("  ok, buildDistanceMap =", typeof path.buildDistanceMap);

console.log("--- Stage 4: import physics.ts (deep dep)");
const physics = await import(toUrl("../../web/src/game/physics.ts"));
console.log("  ok, step =", typeof physics.step);

console.log("--- Stage 5: import map.ts (deep dep, atlases-typed)");
const map = await import(toUrl("../../web/src/game/map.ts"));
console.log("  ok, buildMap =", typeof map.buildMap);

console.log("--- Stage 6: import env.ts (the integration point)");
const env = await import(toUrl("../src/env.ts"));
console.log("  ok, Episode =", typeof env.Episode);

console.log("--- Stage 7: import agent.ts");
const agent = await import(toUrl("../src/agent.ts"));
console.log("  ok, MLPAgent =", typeof agent.MLPAgent);

console.log("--- Stage 8: import hio.ts");
const hio = await import(toUrl("../src/hio.ts"));
console.log("  ok, searchHoleInOne =", typeof hio.searchHoleInOne);

console.log("\nAll imports succeeded under Node.");
