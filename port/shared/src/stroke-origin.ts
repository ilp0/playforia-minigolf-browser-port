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
