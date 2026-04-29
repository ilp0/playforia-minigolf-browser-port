import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    MAP_PIXEL_HEIGHT,
    MAP_PIXEL_WIDTH,
    PIXEL_PER_TILE,
    TILE,
    calculateFriction,
    getFriction,
    getYPixelsFromSpecialId,
} from "./tiles.ts";

describe("tiles - dimensions", () => {
    it("matches the 49x25 grid at 15px tiles", () => {
        assert.equal(PIXEL_PER_TILE, 15);
        assert.equal(MAP_PIXEL_WIDTH, 735);
        assert.equal(MAP_PIXEL_HEIGHT, 375);
    });
});

describe("tiles - getFriction", () => {
    // Hand-checked against Tile.java's nested ternary.
    it("returns 0.9935 for the 'fast surface' band (0, 4..11, 19, 47)", () => {
        for (const v of [0, 4, 5, 6, 7, 8, 9, 10, 11, 19, 47]) {
            assert.equal(getFriction(v), 0.9935, `v=${v}`);
        }
    });

    it("normal wall (1) is 0.92 and bouncy wall (2) is 0.8", () => {
        assert.equal(getFriction(1), 0.92);
        assert.equal(getFriction(2), 0.8);
    });

    it("sticky / teleport-starts return 0.9975", () => {
        for (const v of [3, 32, 34, 36, 38]) {
            assert.equal(getFriction(v), 0.9975, `v=${v}`);
        }
    });

    it("water/acid returns 0.0 and swamp variants return 0.95", () => {
        assert.equal(getFriction(12), 0.0);
        assert.equal(getFriction(13), 0.0);
        assert.equal(getFriction(14), 0.95);
        assert.equal(getFriction(15), 0.95);
    });

    it("one-way walls 20..23 return 0.995", () => {
        for (const v of [20, 21, 22, 23]) {
            assert.equal(getFriction(v), 0.995);
        }
    });

    it("hole (25) returns 0.96 and magnet_attract (44) returns 0.9", () => {
        assert.equal(getFriction(25), 0.96);
        assert.equal(getFriction(44), 0.9);
    });

    it("28/30 -> 1.0 ; 29/31 -> 0.9", () => {
        assert.equal(getFriction(28), 1.0);
        assert.equal(getFriction(30), 1.0);
        assert.equal(getFriction(29), 0.9);
        assert.equal(getFriction(31), 0.9);
    });

    it("falls through to 1.0 for unknown values", () => {
        assert.equal(getFriction(100), 1.0);
    });
});

describe("tiles - calculateFriction", () => {
    it("matches Tile.calculateFriction formula", () => {
        // calculateFriction(12, 6.5) = 0 + (1 - 0) * (0.75 * 6.5 / 6.5) = 0.75
        assert.equal(calculateFriction(12, 6.5), 0.75);
        // calculateFriction(0, 0) = 0.9935 + (1 - 0.9935) * 0 = 0.9935
        assert.equal(calculateFriction(0, 0), 0.9935);
    });
});

describe("tiles - getYPixelsFromSpecialId", () => {
    it("matches the Java switch table", () => {
        assert.equal(getYPixelsFromSpecialId(24), 16777215);
        assert.equal(getYPixelsFromSpecialId(48), 11579647);
        assert.equal(getYPixelsFromSpecialId(49), 16752800);
        assert.equal(getYPixelsFromSpecialId(50), 16777088);
        assert.equal(getYPixelsFromSpecialId(51), 9502608);
        assert.equal(getYPixelsFromSpecialId(0), -1);
    });
});

describe("tiles - TILE name table", () => {
    it("has stable named ids matching Java tile semantics", () => {
        assert.equal(TILE.EMPTY, 0);
        assert.equal(TILE.WALL_NORMAL, 1);
        assert.equal(TILE.WATER, 12);
        assert.equal(TILE.ACID, 13);
        assert.equal(TILE.WATER_SWAMP, 14);
        assert.equal(TILE.ACID_SWAMP, 15);
        assert.equal(TILE.HOLE, 25);
        assert.equal(TILE.MAGNET_ATTRACT, 44);
        assert.equal(TILE.MAGNET_REPEL, 45);
        assert.equal(TILE.SUNKABLE_BLOCK, 46);
        assert.equal(TILE.SUNKEN_BLOCK, 47);
    });
});
