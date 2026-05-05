// Snapshot resolver for the desync-recovery protocol.
// Lives in shared so its tests run with `npm -w shared test`; the server
// is the only consumer today, but the logic is pure data-processing and
// has no Node-specific dependencies.
//
// Inputs: per-observer ball snapshots collected after a divergence event
// (typically triggered by mismatched `ballend` observations at endstroke).
// Output: a single "winning" snapshot to broadcast back to every client.
//
// Resolution strategy, in priority order:
//   1. Drop the self-reported late-applier (if the protocol identified one).
//      That client is the loser by definition; their state shouldn't get a
//      vote.
//   2. Cluster remaining reports per-slot by position (within
//      SNAPSHOT_AGREEMENT_EPSILON_PX). Pick the largest cluster's centroid.
//   3. On a true tie (two equal-sized clusters in N≥3, or any disagreement
//      in N=2), defer to the physics tiebreaker (server-side simulation).
//      Until that's wired, fall back to the lowest observerId as a stable
//      arbitrary choice — predictable across runs, no ping bias.
//
// Per-ball seedHex is voted independently (the seed is only meaningful for
// the slot whose stroke is in flight; for other slots' resting balls the
// stored seed is incidental and trivially identical across reports anyway).

import {
    SNAPSHOT_AGREEMENT_EPSILON_PX,
    type BallSnapshotEntry,
} from "./snapshot.ts";

const EPS_SQ = SNAPSHOT_AGREEMENT_EPSILON_PX * SNAPSHOT_AGREEMENT_EPSILON_PX;

export interface SnapshotReport {
    observerId: number;
    /** True if this observer self-reported as a late-applier (impulse landed
     *  after their worldTick had already passed apply_tick). Excluded from
     *  voting. */
    isLateApplier: boolean;
    entries: BallSnapshotEntry[];
}

export interface ResolutionResult {
    winning: BallSnapshotEntry[];
    /** Per-slot diagnostic — how many reports backed the chosen entry vs.
     *  total reports considered. Useful for logging and for the test suite. */
    perSlotAgreement: Map<number, { agreed: number; total: number }>;
    /** Slots where no clear majority emerged and the tiebreaker had to fire. */
    tiedSlots: number[];
}

/** Optional hook for an authoritative server-side simulation. When present,
 *  invoked for slots that hit a tie in majority voting. The function should
 *  return the canonical entry for that slot, or null if it can't decide. */
export type PhysicsTiebreaker = (slot: number, candidates: BallSnapshotEntry[]) => BallSnapshotEntry | null;

export function resolveSnapshots(
    reports: SnapshotReport[],
    tiebreaker: PhysicsTiebreaker | null = null,
): ResolutionResult {
    const eligible = reports.filter((r) => !r.isLateApplier);
    const pool = eligible.length > 0 ? eligible : reports; // fall back if everyone's a late-applier

    // Collect entries per slot.
    const perSlot = new Map<number, BallSnapshotEntry[]>();
    for (const r of pool) {
        for (const e of r.entries) {
            const arr = perSlot.get(e.slot) ?? [];
            arr.push(e);
            perSlot.set(e.slot, arr);
        }
    }

    const winning: BallSnapshotEntry[] = [];
    const perSlotAgreement = new Map<number, { agreed: number; total: number }>();
    const tiedSlots: number[] = [];

    for (const [slot, candidates] of perSlot) {
        const { winner, agreed, tied } = pickClusterWinner(candidates);
        perSlotAgreement.set(slot, { agreed, total: candidates.length });

        if (tied) {
            // Diagnostic: the slot needed external arbitration regardless of
            // whether the tiebreaker hook returned a value. Operators care
            // about the "is this room desyncing in nasty ways" signal.
            tiedSlots.push(slot);
            const tb = tiebreaker ? tiebreaker(slot, candidates) : null;
            if (tb) {
                winning.push(tb);
            } else {
                // Stable fallback: pick the candidate from the lowest
                // observerId among the pool — deterministic, ping-blind.
                const sorted = [...pool].sort((a, b) => a.observerId - b.observerId);
                let pick: BallSnapshotEntry | null = null;
                for (const r of sorted) {
                    const e = r.entries.find((x) => x.slot === slot);
                    if (e) {
                        pick = e;
                        break;
                    }
                }
                if (pick) winning.push(pick);
            }
        } else {
            winning.push(winner);
        }
    }

    winning.sort((a, b) => a.slot - b.slot);
    return { winning, perSlotAgreement, tiedSlots };
}

/** Cluster candidates by position (within epsilon) and return the centroid
 *  of the largest cluster. `tied` is true when two clusters have equal max
 *  size. Position is the only clustering key — non-position fields ride
 *  along on whichever cluster member happened to come first. */
function pickClusterWinner(candidates: BallSnapshotEntry[]): {
    winner: BallSnapshotEntry;
    agreed: number;
    tied: boolean;
} {
    type Cluster = { members: BallSnapshotEntry[]; cx: number; cy: number };
    const clusters: Cluster[] = [];
    for (const c of candidates) {
        let placed = false;
        for (const cl of clusters) {
            const dx = c.x - cl.cx;
            const dy = c.y - cl.cy;
            if (dx * dx + dy * dy <= EPS_SQ) {
                cl.members.push(c);
                cl.cx = (cl.cx * (cl.members.length - 1) + c.x) / cl.members.length;
                cl.cy = (cl.cy * (cl.members.length - 1) + c.y) / cl.members.length;
                placed = true;
                break;
            }
        }
        if (!placed) {
            clusters.push({ members: [c], cx: c.x, cy: c.y });
        }
    }

    let bestSize = 0;
    let secondSize = 0;
    let best: Cluster | null = null;
    for (const cl of clusters) {
        if (cl.members.length > bestSize) {
            secondSize = bestSize;
            bestSize = cl.members.length;
            best = cl;
        } else if (cl.members.length > secondSize) {
            secondSize = cl.members.length;
        }
    }
    if (!best) {
        // Empty input — shouldn't happen because callers gate on non-empty,
        // but fail safely with a zeroed entry.
        return {
            winner: candidates[0]!,
            agreed: 0,
            tied: false,
        };
    }
    const tied = bestSize === secondSize && clusters.length > 1;
    return {
        winner: { ...best.members[0]!, x: best.cx, y: best.cy },
        agreed: bestSize,
        tied,
    };
}
