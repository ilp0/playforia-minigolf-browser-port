// Map RLE decoder ported from agolf/game/Map.java (parse + expandMap + readNumber)
// and tile-code unpacking from agolf/game/Tile.java.

export const TILE_WIDTH = 49;
export const TILE_HEIGHT = 25;

const MAP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Step 1 from the Java parser: a digit-prefixed letter expands to count copies of that letter.
 * Empty digit prefix → count = 1.
 *
 * E.g. "5A11A22" → "AAAAA" + "AAAAAAAAAAA" + "AA" -> "AAAAAAAAAAAAAAAAAAAA" (5 + 11 + 2 = 18 A's)
 *      ...wait: that's three runs, "5A" "11A" "22" then "..." — be careful with the actual rule.
 *
 * Actual Java: at each position, read a possibly-empty number, advance past digits, then read one
 * char and append it count times.
 */
export function expandRle(input: string): string {
    let out = "";
    const len = input.length;
    for (let i = 0; i < len; i++) {
        // readNumber: read digits (possibly zero) starting at i, return parsed int (default 1).
        let count = 1;
        let digits = "";
        while (i < len) {
            const ch = input.charAt(i);
            if (ch < "0" || ch > "9") break;
            digits += ch;
            i++;
        }
        if (digits.length > 0) {
            count = parseInt(digits, 10);
        }
        if (i >= len) {
            // Java would NPE here — treat as malformed.
            throw new Error("RLE input ends with digits but no character to repeat");
        }
        const c = input.charAt(i);
        if (count > 0) {
            out += c.repeat(count);
        }
    }
    return out;
}

/**
 * Decode a track T-line into a 49x25 grid of packed 32-bit tile codes.
 *
 * Layout matches the Java `Map.tiles[x][y]` array: outer = x (0..48), inner = y (0..24).
 * The decoder iterates rows (y outer, x inner) and back-references (D/E/F/G/H/I) read
 * neighbours that have already been decoded earlier in this scan order.
 *
 * Trailing ",Ads:..." metadata after the first comma is stripped (Java uses StringTokenizer).
 */
export function decodeMap(tLineRaw: string): number[][] {
    // Strip ",Ads:..." (or any other ,-suffixed metadata).
    const commaIdx = tLineRaw.indexOf(",");
    const mapPart = commaIdx >= 0 ? tLineRaw.substring(0, commaIdx) : tLineRaw;

    const expanded = expandRle(mapPart);

    // Allocate as tiles[x][y] (column-major) so neighbour lookups read just like the Java.
    const tiles: number[][] = new Array(TILE_WIDTH);
    for (let x = 0; x < TILE_WIDTH; x++) {
        tiles[x] = new Array(TILE_HEIGHT).fill(0);
    }

    let cursor = 0;
    for (let tileY = 0; tileY < TILE_HEIGHT; tileY++) {
        for (let tileX = 0; tileX < TILE_WIDTH; tileX++) {
            if (cursor >= expanded.length) {
                throw new Error(`RLE underflow at tile (${tileX},${tileY})`);
            }
            const ch = expanded.charAt(cursor);
            const idx = MAP_CHARS.indexOf(ch);
            if (idx < 0) {
                throw new Error(`bad map char '${ch}' at offset ${cursor}`);
            }

            if (idx <= 2) {
                // A, B, or C: inline tile data.
                let b1: number;
                let b2: number;
                let b3: number;
                if (idx === 1) {
                    // B: four bytes total (the letter + three following).
                    b1 = MAP_CHARS.indexOf(expanded.charAt(cursor + 1));
                    b2 = MAP_CHARS.indexOf(expanded.charAt(cursor + 2));
                    b3 = MAP_CHARS.indexOf(expanded.charAt(cursor + 3));
                    cursor += 4;
                } else {
                    // A or C: three bytes total, b3 = 0.
                    b1 = MAP_CHARS.indexOf(expanded.charAt(cursor + 1));
                    b2 = MAP_CHARS.indexOf(expanded.charAt(cursor + 2));
                    b3 = 0;
                    cursor += 3;
                }
                if (b1 < 0 || b2 < 0 || b3 < 0) {
                    throw new Error(`bad encoded tile bytes near offset ${cursor}`);
                }
                // Pack: (idx << 24) | (b1 << 16) | (b2 << 8) | b3
                // Use unsigned-style multiplication to avoid >>> 0 surprises in JS.
                const code = idx * 0x1000000 + b1 * 0x10000 + b2 * 0x100 + b3;
                tiles[tileX][tileY] = code;
            } else {
                let neighbour: number;
                switch (idx) {
                    case 3: // D — west
                        neighbour = tiles[tileX - 1][tileY];
                        break;
                    case 4: // E — north
                        neighbour = tiles[tileX][tileY - 1];
                        break;
                    case 5: // F — northwest
                        neighbour = tiles[tileX - 1][tileY - 1];
                        break;
                    case 6: // G — 2-west
                        neighbour = tiles[tileX - 2][tileY];
                        break;
                    case 7: // H — 2-north
                        neighbour = tiles[tileX][tileY - 2];
                        break;
                    case 8: // I — 2-northwest
                        neighbour = tiles[tileX - 2][tileY - 2];
                        break;
                    default:
                        throw new Error(`unhandled map char index ${idx} ('${ch}')`);
                }
                tiles[tileX][tileY] = neighbour;
                cursor += 1;
            }
        }
    }

    return tiles;
}

export interface UnpackedTile {
    /** "special" byte — top 8 bits. 0 = empty, 1 = normal, 2 = special. */
    isNoSpecial: number;
    /** "shape" byte — bits 16..23. (Java adds 24 to this for the rendered shape; we keep raw.) */
    shape: number;
    /** Background element index — bits 8..15. Confusingly named "fore" by the spec but
     *  in Tile.java this is `background = (code >> 8) % 256`. */
    fore: number;
    /** Foreground element index — bits 0..7. In Tile.java this is `foreground = code % 256`. */
    back: number;
}

/**
 * Unpack a 32-bit tile code into its (special, shape, background, foreground) bytes,
 * matching Tile.java's constructor / update():
 *   special    = code >> 24
 *   shapeRaw   = (code >> 16) & 0xff   (Java's `shape` field is shapeRaw + 24; we expose raw)
 *   background = (code >> 8) & 0xff
 *   foreground = code & 0xff
 *
 * The naming on the returned interface matches the spec the caller asked for; the per-field
 * docstrings clarify which Java field each one corresponds to.
 */
export function unpackTile(code: number): UnpackedTile {
    return {
        isNoSpecial: (code >>> 24) & 0xff,
        shape: (code >>> 16) & 0xff,
        fore: (code >>> 8) & 0xff,
        back: code & 0xff,
    };
}
