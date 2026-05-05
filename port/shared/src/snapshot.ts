// Wire codecs for the desync-recovery protocol (port extension).
//
// A "snapshot" is the authoritative ball state used to snap a diverged client
// back into agreement with peers. Each ball entry serializes the minimum set
// of fields whose divergence would produce visibly different cascade outcomes
// after the snap. Stuck counters and bounciness are included because they
// gate per-iteration safety thresholds; ignoring them would let a corrected
// ball re-diverge on the next stroke timeout.
//
// Format (per ball, semicolon-separated entries):
//   <slot>:<x>,<y>,<vx>,<vy>,<bounciness>,<magnetMul>,<flags>,<liquidTimer>,
//          <iters>,<downhillStuck>,<magnetStuck>,<spinningStuck>,
//          <strokeStartX>,<strokeStartY>,<shoreX>,<shoreY>,<seedHex>
//
// Numbers are encoded with up to 6 decimal places (more than the cascade
// noise needs, and enough that float-bit jitter rounds away in comparison).
// Slot empty / vacant balls are omitted from the wire payload.

export interface BallSnapshotEntry {
    slot: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    bounciness: number;
    magnetMul: number;
    /** Bit-packed booleans: bit 0 stopped, 1 inHole, 2 onHole, 3 onLiquidOrSwamp,
     *  4 teleported, 5 causedByShot. */
    flags: number;
    liquidTimer: number;
    iterationsThisStroke: number;
    downhillStuckCounter: number;
    magnetStuckCounter: number;
    spinningStuckCounter: number;
    strokeStartX: number;
    strokeStartY: number;
    shoreX: number;
    shoreY: number;
    /** Lowercase hex of `Seed.getState()` (a 48-bit unsigned bigint). */
    seedHex: string;
}

export const SNAP_FLAG_STOPPED = 1 << 0;
export const SNAP_FLAG_IN_HOLE = 1 << 1;
export const SNAP_FLAG_ON_HOLE = 1 << 2;
export const SNAP_FLAG_ON_LIQUID = 1 << 3;
export const SNAP_FLAG_TELEPORTED = 1 << 4;
export const SNAP_FLAG_CAUSED_BY_SHOT = 1 << 5;

function num(n: number): string {
    if (!Number.isFinite(n)) return "0";
    // Trim trailing zeros so equal-on-the-wire snapshots compare as equal strings.
    return Number(n.toFixed(6)).toString();
}

export function encodeBallSnapshot(entries: BallSnapshotEntry[]): string {
    return entries
        .map((e) =>
            [
                e.slot,
                num(e.x),
                num(e.y),
                num(e.vx),
                num(e.vy),
                num(e.bounciness),
                num(e.magnetMul),
                e.flags,
                e.liquidTimer,
                e.iterationsThisStroke,
                e.downhillStuckCounter,
                e.magnetStuckCounter,
                e.spinningStuckCounter,
                num(e.strokeStartX),
                num(e.strokeStartY),
                num(e.shoreX),
                num(e.shoreY),
                e.seedHex || "0",
            ].join(","),
        )
        .join(";");
}

export function decodeBallSnapshot(blob: string): BallSnapshotEntry[] {
    if (!blob) return [];
    const out: BallSnapshotEntry[] = [];
    for (const part of blob.split(";")) {
        if (!part) continue;
        const f = part.split(",");
        if (f.length < 17) continue;
        const slot = parseInt(f[0]!, 10);
        if (!Number.isFinite(slot) || slot < 0) continue;
        out.push({
            slot,
            x: parseFloat(f[1]!) || 0,
            y: parseFloat(f[2]!) || 0,
            vx: parseFloat(f[3]!) || 0,
            vy: parseFloat(f[4]!) || 0,
            bounciness: parseFloat(f[5]!) || 0,
            magnetMul: parseFloat(f[6]!) || 0,
            flags: parseInt(f[7]!, 10) || 0,
            liquidTimer: parseInt(f[8]!, 10) || 0,
            iterationsThisStroke: parseInt(f[9]!, 10) || 0,
            downhillStuckCounter: parseInt(f[10]!, 10) || 0,
            magnetStuckCounter: parseInt(f[11]!, 10) || 0,
            spinningStuckCounter: parseInt(f[12]!, 10) || 0,
            strokeStartX: parseFloat(f[13]!) || 0,
            strokeStartY: parseFloat(f[14]!) || 0,
            shoreX: parseFloat(f[15]!) || 0,
            shoreY: parseFloat(f[16]!) || 0,
            seedHex: f[17] ?? "0",
        });
    }
    return out;
}

/** Position-distance-squared between two ball entries for the same slot.
 *  Used by the divergence detector to decide if two reports are far enough
 *  apart to warrant snapshot recovery. */
export function ballPosDistSq(a: BallSnapshotEntry, b: BallSnapshotEntry): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

/** Tolerance (in pixels) for "these two clients agree on this ball's
 *  resting position." Floats can drift sub-pixel even on a perfect
 *  simulation; anything larger is real desync, not float noise. */
export const SNAPSHOT_AGREEMENT_EPSILON_PX = 0.5;
