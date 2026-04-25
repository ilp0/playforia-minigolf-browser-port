// Quick sanity check: pick tracks by each tracksType and confirm the result
// pool is actually filtered correctly. Run with:
//   node --experimental-strip-types --no-warnings src/test-filter.ts
import * as path from "node:path";
import { TrackManager, trackCategoryByTypeId } from "./tracks.ts";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
const tm = new TrackManager();
await tm.load(path.resolve(here, "..", "tracks"));

const names = ["MIXED", "BASIC", "TRADITIONAL", "MODERN", "HIO", "SHORT", "LONG"];
for (let i = 0; i <= 6; i++) {
    const cat = trackCategoryByTypeId(i);
    const sample = tm.getRandomTracks(5, cat);
    const total = i === 0
        ? tm.tracks.length
        : tm.tracks.filter((t) => t.categories.includes(i)).length;
    console.log(
        `tracksType=${i} (${names[i]}): total=${total}, sample tags: ` +
            sample.map((t) => `[${t.categories.join(",")}]`).join(" "),
    );
}
process.exit(0);
