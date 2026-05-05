import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSnapshots, type SnapshotReport } from "./snap-resolver.ts";
import {
    SNAP_FLAG_STOPPED,
    SNAPSHOT_AGREEMENT_EPSILON_PX,
    type BallSnapshotEntry,
} from "./index.ts";

function ball(slot: number, x: number, y: number, extra: Partial<BallSnapshotEntry> = {}): BallSnapshotEntry {
    return {
        slot,
        x,
        y,
        vx: 0,
        vy: 0,
        bounciness: 1,
        magnetMul: 1,
        flags: SNAP_FLAG_STOPPED,
        liquidTimer: 0,
        iterationsThisStroke: 100,
        downhillStuckCounter: 0,
        magnetStuckCounter: 0,
        spinningStuckCounter: 0,
        strokeStartX: 0,
        strokeStartY: 0,
        shoreX: x,
        shoreY: y,
        seedHex: "0",
        ...extra,
    };
}

function report(observerId: number, entries: BallSnapshotEntry[], isLateApplier = false): SnapshotReport {
    return { observerId, isLateApplier, entries };
}

test("majority wins on a 2-vs-1 disagreement", () => {
    const result = resolveSnapshots([
        report(0, [ball(0, 100, 100)]),
        report(1, [ball(0, 100, 100)]),
        report(2, [ball(0, 150, 200)]),
    ]);
    assert.equal(result.winning.length, 1);
    const w = result.winning[0]!;
    assert.equal(w.slot, 0);
    assert.ok(Math.abs(w.x - 100) < 1e-6);
    assert.ok(Math.abs(w.y - 100) < 1e-6);
    assert.deepEqual(result.tiedSlots, []);
    assert.equal(result.perSlotAgreement.get(0)!.agreed, 2);
    assert.equal(result.perSlotAgreement.get(0)!.total, 3);
});

test("self-reported late-applier is excluded from voting", () => {
    // The late client lies and says (200, 200); the two on-time clients
    // agree on (100, 100). Without the late-applier filter, this is a
    // 1-1-1 tie. With it, the on-time pair wins cleanly.
    const result = resolveSnapshots([
        report(0, [ball(0, 100, 100)]),
        report(1, [ball(0, 100, 100)]),
        report(2, [ball(0, 200, 200)], /* late */ true),
    ]);
    assert.equal(result.winning.length, 1);
    assert.ok(Math.abs(result.winning[0]!.x - 100) < 1e-6);
    assert.equal(result.perSlotAgreement.get(0)!.agreed, 2);
    assert.equal(result.perSlotAgreement.get(0)!.total, 2);
});

test("epsilon clusters near-identical floats together", () => {
    const eps = SNAPSHOT_AGREEMENT_EPSILON_PX * 0.4;
    // Two reports differ by less than epsilon in last-bit float noise.
    // They should cluster as one, not split the vote.
    const result = resolveSnapshots([
        report(0, [ball(0, 100, 100)]),
        report(1, [ball(0, 100 + eps, 100 + eps)]),
        report(2, [ball(0, 9999, 9999)]),
    ]);
    assert.equal(result.tiedSlots.length, 0);
    assert.equal(result.perSlotAgreement.get(0)!.agreed, 2);
});

test("tie falls back to lowest observerId pick", () => {
    // 1-1-1 tie with no late-applier flag, no tiebreaker hook → stable pick.
    const result = resolveSnapshots([
        report(7, [ball(0, 300, 300)]),
        report(2, [ball(0, 100, 100)]),
        report(5, [ball(0, 200, 200)]),
    ]);
    assert.deepEqual(result.tiedSlots, [0]);
    // Lowest observerId is 2, so its (100,100) value is picked.
    assert.ok(Math.abs(result.winning[0]!.x - 100) < 1e-6);
});

test("physics tiebreaker hook wins over the fallback", () => {
    const result = resolveSnapshots(
        [
            report(7, [ball(0, 300, 300)]),
            report(2, [ball(0, 100, 100)]),
            report(5, [ball(0, 200, 200)]),
        ],
        () => ball(0, 999, 999),
    );
    assert.deepEqual(result.tiedSlots, [0]);
    assert.ok(Math.abs(result.winning[0]!.x - 999) < 1e-6);
});

test("all reports late: still resolves rather than stalling", () => {
    const result = resolveSnapshots([
        report(0, [ball(0, 100, 100)], true),
        report(1, [ball(0, 100, 100)], true),
    ]);
    assert.equal(result.winning.length, 1);
    assert.ok(Math.abs(result.winning[0]!.x - 100) < 1e-6);
});
