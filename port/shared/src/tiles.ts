// Tile collision/physics constants ported from agolf/game/Tile.java.
//
// In the Java code the per-pixel collision map is a byte[][] of values 0..47-ish.
// Tile.calculateFriction(value, speed) and Tile.getFriction(value) define how
// each collision-byte interacts with the ball. We port those verbatim.

import { TILE_WIDTH, TILE_HEIGHT } from "./rle.ts";

export const PIXEL_PER_TILE = 15;
export const MAP_PIXEL_WIDTH = TILE_WIDTH * PIXEL_PER_TILE; // 735
export const MAP_PIXEL_HEIGHT = TILE_HEIGHT * PIXEL_PER_TILE; // 375

/**
 * Named collision values (a subset — the rest are referenced numerically below).
 * Comments come from Map.collisionMap() and Tile.getYPixelsFromSpecialId.
 */
export const TILE = Object.freeze({
    EMPTY: 0,
    WALL_NORMAL: 1,
    WALL_BOUNCY: 2,
    WALL_STICKY: 3,
    // 4..11 — slope tiles (8 directions; "fast" surfaces, friction 0.9935)
    WATER: 12,
    ACID: 13,
    WATER_SWAMP: 14,
    ACID_SWAMP: 15,
    // 16..23 — wall variants (19 = illusion); 20..23 = one-way walls
    ILLUSION_WALL: 19,
    START_COMMON: 24,
    HOLE: 25,
    FAKE_HOLE: 26,
    MOVABLE_BLOCK: 27,
    MINE_SMALL: 28,
    MINE_SMALL_SPENT: 29,
    MINE_BIG: 30,
    MINE_BIG_SPENT: 31,
    TELEPORT_BLUE_START: 32,
    TELEPORT_BLUE_EXIT: 33,
    TELEPORT_RED_START: 34,
    TELEPORT_RED_EXIT: 35,
    TELEPORT_YELLOW_START: 36,
    TELEPORT_YELLOW_EXIT: 37,
    TELEPORT_GREEN_START: 38,
    TELEPORT_GREEN_EXIT: 39,
    BRICK_FULL: 40,
    BRICK_3Q: 41,
    BRICK_HALF: 42,
    BRICK_QUARTER: 43,
    MAGNET_ATTRACT: 44,
    MAGNET_REPEL: 45,
    SUNKABLE_BLOCK: 46,
    SUNKEN_BLOCK: 47,
    START_BLUE: 48,
    START_RED: 49,
    START_YELLOW: 50,
    START_GREEN: 51,
});

/**
 * Friction lookup. Direct port of Tile.getFriction(int) — preserves the original
 * nested-ternary decision tree exactly.
 *
 *   default                                     -> 0.9935
 *   v == 0 (empty / hole 47 also returns 0.9935 by the outer condition) — see code below
 *   v == 1 (normal wall)                        -> 0.92
 *   v == 2 (bouncy wall)                        -> 0.8
 *   v == 3 / 32 / 34 / 36 / 38 (sticky / tele)  -> 0.9975
 *   v == 12 / 13 (water / acid)                 -> 0.0
 *   v == 14 / 15 (water_swamp / acid_swamp)     -> 0.95
 *   v in 20..23 (illusion non-shadow)           -> 0.995
 *   v == 25 (hole)                              -> 0.96
 *   v == 28 / 30 (mine_small / mine_big)        -> 1.0
 *   v == 29 / 31 (mine spent)                   -> 0.9
 *   v == 44 (magnet_attract)                    -> 0.9
 *   v == 19 / 47 / 4..11                        -> 0.9935 (the "fast surface" outer branch)
 */
export function getFriction(value: number): number {
    const v = value | 0;
    // Outer: matches `v == 0 || (v >= 4 && v <= 11) || v == 19 || v == 47` -> 0.9935
    if (v === 0 || (v >= 4 && v <= 11) || v === 19 || v === 47) {
        return 0.9935;
    }
    if (v === 1) return 0.92;
    if (v === 2) return 0.8;
    if (v === 3 || v === 32 || v === 34 || v === 36 || v === 38) return 0.9975;
    if (v === 12 || v === 13) return 0.0;
    if (v === 14 || v === 15) return 0.95;
    if (v >= 20 && v <= 23) return 0.995;
    if (v === 25) return 0.96;
    if (v === 28 || v === 30) return 1.0;
    if (v === 29 || v === 31) return 0.9;
    if (v === 44) return 0.9;
    return 1.0;
}

/**
 * Speed-modulated friction, port of Tile.calculateFriction(int, double).
 *   double friction = getFriction(value);
 *   double speedModifier = 0.75 * speed / 6.5;
 *   double frictionModifier = 1.0 - friction;
 *   return friction + frictionModifier * speedModifier;
 */
export function calculateFriction(value: number, speed: number): number {
    const friction = getFriction(value);
    const speedModifier = (0.75 * speed) / 6.5;
    const frictionModifier = 1.0 - friction;
    return friction + frictionModifier * speedModifier;
}

/**
 * Y-pixel constants returned for special tile shapes — port of Tile.getYPixelsFromSpecialId().
 * (Note: the Java method name is misleading; the values are ARGB-ish ints used as a sentinel.)
 */
export function getYPixelsFromSpecialId(shape: number): number {
    switch (shape) {
        case 24:
            return 16777215; // Starting point common
        case 48:
            return 11579647; // Start blue
        case 49:
            return 16752800; // Start red
        case 50:
            return 16777088; // Start yellow
        case 51:
            return 9502608; // Start green
        default:
            return -1;
    }
}
