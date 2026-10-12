// `beginstroke` carries the ball position truncated to whole pixels, while
// every client simulates exact doubles (tees sit at tile centres, x*15+7.5).
// Snapping to the truncated value moved the shooter half a pixel off the tee,
// next to an opponent still on it, so the first stroke "collided" with them.
// Keep the exact local position whenever it truncates to the wire value and
// snap only a client that has really drifted.

export function resolveStrokeOrigin(
    wireX: number,
    wireY: number,
    localX: number,
    localY: number,
): { x: number; y: number } {
    if (Math.trunc(localX) === wireX && Math.trunc(localY) === wireY) return { x: localX, y: localY };
    return { x: wireX, y: wireY };
}

// Port extension: the shooter appends its exact origin to `beginstroke` and
// the server relays it, so every client - including late joiners that only
// ever learned whole-pixel positions - starts the stroke from the same doubles.
// String(n) is the shortest form that parses back to the identical double.

const EXACT_NUMBER = String.raw`\d{1,4}(?:\.\d{1,20})?(?:e-\d{1,3})?`;
const EXACT_ORIGIN_RE = new RegExp(`^(${EXACT_NUMBER}),(${EXACT_NUMBER})$`);

export function encodeExactOrigin(x: number, y: number): string {
    return `${String(x)},${String(y)}`;
}

/** The exact origin, or null unless it is well formed and truncates to the wire value. */
export function parseExactOrigin(
    raw: string | undefined,
    wireX: number,
    wireY: number,
): { x: number; y: number } | null {
    if (!raw || raw.length > 64) return null;
    const m = EXACT_ORIGIN_RE.exec(raw);
    if (!m) return null;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (Math.trunc(x) !== wireX || Math.trunc(y) !== wireY) return null;
    return { x, y };
}

/** Whole-pixel ball position carried by the base36 `beginstroke` coordinate field. */
export function decodeWireOrigin(coords: string): { x: number; y: number } {
    const v = parseInt(coords, 36);
    return { x: Math.floor(v / 1500), y: Math.floor((v % 1500) / 4) };
}
