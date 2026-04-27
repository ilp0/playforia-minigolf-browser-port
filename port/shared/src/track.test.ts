import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { applySettingsToTileCode, parseSettingsFlags, parseTrack, parseTrackset } from "./track.ts";

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

describe("parseSettingsFlags", () => {
    it("decodes the four-char form ('t'==true, anything else==false)", () => {
        assert.deepEqual(parseSettingsFlags("ttff"), [true, true, false, false]);
        assert.deepEqual(parseSettingsFlags("tttt"), [true, true, true, true]);
        assert.deepEqual(parseSettingsFlags("ffff"), [false, false, false, false]);
        assert.deepEqual(parseSettingsFlags("ftft"), [false, true, false, true]);
    });

    it("ignores the trailing 2-digit min/max-player suffix on real S lines", () => {
        // VersionedTrackFileParser has a `length() != 6` typo that drops these
        // entirely; we deliberately diverge — the first four chars are the
        // flag bits regardless of how many trailing chars follow.
        assert.deepEqual(parseSettingsFlags("tttt14"), [true, true, true, true]);
        assert.deepEqual(parseSettingsFlags("ftft14"), [false, true, false, true]);
        assert.deepEqual(parseSettingsFlags("ffff14"), [false, false, false, false]);
    });

    it("returns all-false for empty / null / undefined / too-short input", () => {
        assert.deepEqual(parseSettingsFlags(""), [false, false, false, false]);
        assert.deepEqual(parseSettingsFlags(null), [false, false, false, false]);
        assert.deepEqual(parseSettingsFlags(undefined), [false, false, false, false]);
        assert.deepEqual(parseSettingsFlags("tt"), [true, true, false, false]);
    });
});

describe("applySettingsToTileCode", () => {
    // Helper to build a 32-bit tile code: special<<24 | shape<<16 | bg<<8 | fg.
    const tile = (special: number, shape: number, bg: number, fg = 0) =>
        (special << 24) | (shape << 16) | (bg << 8) | fg;
    const allOn: ReturnType<typeof parseSettingsFlags> = [true, true, true, true];
    const allOff: ReturnType<typeof parseSettingsFlags> = [false, false, false, false];

    it("returns the input unchanged for non-special tiles (special != 2)", () => {
        const elemTile = tile(1, 0, 5, 7);
        assert.equal(applySettingsToTileCode(elemTile, allOff), elemTile);
        assert.equal(applySettingsToTileCode(elemTile, allOn), elemTile);
        const empty = 0;
        assert.equal(applySettingsToTileCode(empty, allOff), empty);
    });

    it("returns the input unchanged when all flags are on", () => {
        // Mine, magnet, every teleport variant — flags=tttt means "show all".
        for (const shape of [4, 6, 20, 21, 10, 11, 12, 13, 14, 15]) {
            const code = tile(2, shape, 1, 0);
            assert.equal(applySettingsToTileCode(code, allOn), code, `shape=${shape}`);
        }
    });

    it("hides mines when flag[0]=false (shape 28/30 in Java, raw 4/6)", () => {
        // Mine on dirt (bg=1). Substitute = 0x01000000 + 1*256 = 16777472.
        const mine = tile(2, 4, 1, 0);
        const bigmine = tile(2, 6, 1, 0);
        const want = 16777216 + 1 * 256;
        assert.equal(applySettingsToTileCode(mine, allOff), want);
        assert.equal(applySettingsToTileCode(bigmine, allOff), want);
        // ...but only when flag[0] is off.
        assert.equal(applySettingsToTileCode(mine, [true, false, false, false]), mine);
    });

    it("hides magnets when flag[1]=false (raw 20/21)", () => {
        const attract = tile(2, 20, 2, 0);
        const repel = tile(2, 21, 2, 0);
        const want = 16777216 + 2 * 256;
        assert.equal(applySettingsToTileCode(attract, allOff), want);
        assert.equal(applySettingsToTileCode(repel, allOff), want);
        assert.equal(applySettingsToTileCode(attract, [false, true, false, false]), attract);
    });

    it("strips teleport colour when flag[2]=false (raw 10/12/14 → blue start, 11/13/15 → blue exit)", () => {
        const bg = 0;
        // Sources collapse to blue start (34078720 = 0x02080000).
        for (const raw of [10, 12, 14]) {
            assert.equal(applySettingsToTileCode(tile(2, raw, bg, 0), allOff), 34078720 + bg * 256);
        }
        // Exits collapse to blue exit (34144256 = 0x02090000).
        for (const raw of [11, 13, 15]) {
            assert.equal(applySettingsToTileCode(tile(2, raw, bg, 0), allOff), 34144256 + bg * 256);
        }
        // Blue itself (raw 8 source, raw 9 exit) is already generic — no change.
        const blueStart = tile(2, 8, bg, 0);
        const blueExit = tile(2, 9, bg, 0);
        assert.equal(applySettingsToTileCode(blueStart, allOff), blueStart);
        assert.equal(applySettingsToTileCode(blueExit, allOff), blueExit);
    });

    it("doesn't react to flag[3] (illusion shadows are gated in the shadow pass, not the tile pass)", () => {
        const wallishCode = tile(2, 19 - 24 + 24, 0, 0); // any non-mine/magnet/tele special
        assert.equal(applySettingsToTileCode(wallishCode, [true, true, true, false]), wallishCode);
        assert.equal(applySettingsToTileCode(wallishCode, [true, true, true, true]), wallishCode);
    });

    it("preserves the under-tile bg in the substitute (mine-on-dirt becomes plain dirt)", () => {
        // bg=2 (mud); substitute should be 16777216 + 2*256 = 16777728.
        const mineOnMud = tile(2, 4, 2, 0);
        assert.equal(applySettingsToTileCode(mineOnMud, allOff), 16777216 + 2 * 256);
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
