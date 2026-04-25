import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import {
    TILE_HEIGHT,
    TILE_WIDTH,
    decodeMap,
    expandRle,
    unpackTile,
} from "./rle.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

describe("rle — expandRle", () => {
    it("treats a bare letter as count=1", () => {
        assert.equal(expandRle("ABC"), "ABC");
    });

    it("expands prefixed digit-runs and chains them", () => {
        // "5A" -> "AAAAA"; "11A" -> 11x "A"; "2B" -> "BB"
        assert.equal(expandRle("5A11A2B"), "A".repeat(5) + "A".repeat(11) + "BB");
    });

    it("handles a count of zero (no copies)", () => {
        // Java's expandMap: count=0 gives no repetition, then advances past the letter.
        assert.equal(expandRle("0AB"), "B");
    });

    it("supports multi-digit (>=10, >=100) counts", () => {
        assert.equal(expandRle("100X"), "X".repeat(100));
    });
});

describe("rle — decodeMap on a real track", () => {
    it("decodes 100degrees.track to a 49x25 grid and unpacks tiles sanely", () => {
        const trackPath = path.resolve(
            __dirname,
            "../../../server/src/main/resources/tracks/tracks/100degrees.track",
        );
        const text = fs.readFileSync(trackPath, "utf8");
        const tLine = text
            .split(/\r?\n/)
            .find((l) => l.startsWith("T "));
        assert.ok(tLine, "T line missing");
        const tBody = tLine.substring(2);

        const grid = decodeMap(tBody);
        assert.equal(grid.length, TILE_WIDTH);
        assert.equal(grid[0].length, TILE_HEIGHT);

        // Every cell should be a 32-bit non-negative integer.
        for (let x = 0; x < TILE_WIDTH; x++) {
            for (let y = 0; y < TILE_HEIGHT; y++) {
                const c = grid[x][y];
                assert.ok(
                    Number.isInteger(c) && c >= 0 && c <= 0xffffffff,
                    `tile (${x},${y}) out of range: ${c}`,
                );
            }
        }

        // Spot-check unpackTile on (0,0). The track's first encoded tile is "BAQQ" =>
        //   idx(B)=1, idx(A)=0, idx(Q)=16, idx(Q)=16  -> code = 1*2^24 + 0*2^16 + 16*256 + 16
        const expected = 1 * 0x1000000 + 0 * 0x10000 + 16 * 0x100 + 16;
        assert.equal(grid[0][0], expected);
        const unpacked = unpackTile(grid[0][0]);
        assert.deepEqual(unpacked, {
            isNoSpecial: 1,
            shape: 0,
            fore: 16,
            back: 16,
        });
    });
});

describe("rle — unpackTile", () => {
    it("decomposes a 32-bit packed code", () => {
        const code = (2 << 24) | (3 << 16) | (4 << 8) | 5;
        assert.deepEqual(unpackTile(code >>> 0), {
            isNoSpecial: 2,
            shape: 3,
            fore: 4,
            back: 5,
        });
    });

    it("handles all-zero code", () => {
        assert.deepEqual(unpackTile(0), {
            isNoSpecial: 0,
            shape: 0,
            fore: 0,
            back: 0,
        });
    });
});
