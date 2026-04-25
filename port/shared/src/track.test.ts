import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { parseTrack, parseTrackset } from "./track.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const trackPath = (rel: string) =>
    path.resolve(
        __dirname,
        "../../../server/src/main/resources/tracks",
        rel,
    );

describe("parseTrack — 100degrees.track", () => {
    it("extracts author / name / categories / plays from a real V2 file", () => {
        const text = fs.readFileSync(trackPath("tracks/100degrees.track"), "utf8");
        const track = parseTrack(text);

        assert.equal(track.version, 2);
        assert.equal(track.author, "Scope");
        assert.equal(track.name, "-100 degrees");
        assert.deepEqual(track.categories, [3]);
        assert.equal(track.plays, 8888);
        assert.equal(track.strokes, 139778);
        assert.equal(track.bestPar, 3);
        assert.equal(track.numBestPar, 150);
        assert.deepEqual(track.ratings, [99, 12, 21, 26, 35, 101, 89, 97, 57, 51, 303]);
        assert.equal(track.bestPlayer, "advanced");
        assert.equal(track.bestParEpoch, 1145570400000);
        assert.ok(track.map.startsWith("BAQQ"), "map must start with BAQQ");
        // Map line keeps the trailing ",Ads:..." intact; rle.decodeMap strips it.
        assert.ok(track.map.includes(",Ads:"));
    });
});

describe("parseTrack — defaults for missing optional lines", () => {
    it("returns defaults when only required lines are present", () => {
        const text = ["V 2", "A x", "N y", "T BAQQ"].join("\n");
        const track = parseTrack(text);
        assert.equal(track.settings, "ffff");
        assert.equal(track.plays, 0);
        assert.equal(track.bestPar, -1);
        assert.deepEqual(track.categories, []);
        assert.deepEqual(track.ratings, []);
        assert.equal(track.bestPlayer, undefined);
    });
});

describe("parseTrackset — birchwood.trackset", () => {
    it("parses name, difficulty and 9 track names", () => {
        const text = fs.readFileSync(trackPath("sets/birchwood.trackset"), "utf8");
        const set = parseTrackset(text);
        assert.equal(set.name, "Birchwood");
        assert.equal(set.difficulty, "EASY");
        assert.equal(set.trackNames.length, 9);
        assert.equal(set.trackNames[0], "Leobas 1");
        assert.equal(set.trackNames[8], "Virtuoso Bridges");
    });
});
