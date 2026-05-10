// Smoke test: load a track headless, instantiate Episode, run one shot.
// Verifies the harness foundation works end-to-end before we build on it.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const toUrl = (p) => pathToFileURL(resolve(here, p)).href;

const { loadTrackHeadless } = await import(toUrl("../headless/track-loader.ts"));
const { Episode } = await import(toUrl("../src/env.ts"));
const { MLPAgent } = await import(toUrl("../src/agent.ts"));
const { DEFAULTS } = await import(toUrl("../src/config.ts"));

console.log("Loading CurveI.track ...");
const track = loadTrackHeadless("CurveI.track");
console.log(`  name="${track.name}", start=(${track.startX}, ${track.startY}), hole=(${track.holeX.toFixed(1)}, ${track.holeY.toFixed(1)})`);
console.log(`  map: tiles=${track.map.tiles.length}x${track.map.tiles[0].length}, collision=${track.map.collision.length}B`);
console.log(`  pathDist[start]=${track.pathDistMap.dist[Math.floor(track.startY / 15) * 49 + Math.floor(track.startX / 15)]}`);

console.log("\nInstantiating MLPAgent ...");
const agent = new MLPAgent({ ...DEFAULTS, numParallel: 1 });
console.log(`  inputSize=${agent.inputSize}, hiddenSize=${agent.cfg.hiddenSize}`);

console.log("\nRunning one episode ...");
const episode = new Episode(track, { ...DEFAULTS, numParallel: 1 });
let strokes = 0;
let totalTicks = 0;
const t0 = performance.now();
while (episode.state().status === "awaiting_shot" && strokes < 30) {
  const action = agent.act(episode.state());
  episode.applyShot(action);
  strokes++;
  let ticks = 0;
  while (episode.state().status === "in_motion" && ticks < 5000) {
    episode.tick(8);
    ticks++;
  }
  totalTicks += ticks;
  const s = episode.state().status;
  if (s === "holed" || s === "out_of_strokes") break;
}
const dt = performance.now() - t0;
console.log(`  status=${episode.state().status}, strokes=${strokes}, total ticks=${totalTicks}, wall=${dt.toFixed(0)}ms`);
console.log("\nHeadless load + episode tick: ok.");
