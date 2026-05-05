import { test } from "node:test";
import assert from "node:assert/strict";
import {
    encodeBallSnapshot,
    decodeBallSnapshot,
    ballPosDistSq,
    SNAPSHOT_AGREEMENT_EPSILON_PX,
    SNAP_FLAG_STOPPED,
    SNAP_FLAG_IN_HOLE,
    type BallSnapshotEntry,
} from "./snapshot.ts";

const sample: BallSnapshotEntry[] = [
    {
        slot: 0,
        x: 124.5,
        y: 200.123456,
        vx: -1.5,
        vy: 2.0,
        bounciness: 0.84,
        magnetMul: 1.0,
        flags: SNAP_FLAG_STOPPED,
        liquidTimer: 0,
        iterationsThisStroke: 230,
        downhillStuckCounter: 0,
        magnetStuckCounter: 0,
        spinningStuckCounter: 0,
        strokeStartX: 100,
        strokeStartY: 100,
        shoreX: 124,
        shoreY: 200,
        seedHex: "deadbeefcafe",
    },
    {
        slot: 2,
        x: 50,
        y: 60,
        vx: 0,
        vy: 0,
        bounciness: 1.0,
        magnetMul: 1.0,
        flags: SNAP_FLAG_STOPPED | SNAP_FLAG_IN_HOLE,
        liquidTimer: 5,
        iterationsThisStroke: 410,
        downhillStuckCounter: 1,
        magnetStuckCounter: 2,
        spinningStuckCounter: 3,
        strokeStartX: 25,
        strokeStartY: 30,
        shoreX: 50,
        shoreY: 60,
        seedHex: "0",
    },
];

test("ball-snapshot encode/decode round-trip", () => {
    const wire = encodeBallSnapshot(sample);
    const decoded = decodeBallSnapshot(wire);
    assert.equal(decoded.length, sample.length);
    for (let i = 0; i < sample.length; i++) {
        const a = sample[i]!;
        const b = decoded[i]!;
        assert.equal(b.slot, a.slot);
        assert.ok(Math.abs(b.x - a.x) < 1e-6);
        assert.ok(Math.abs(b.y - a.y) < 1e-6);
        assert.equal(b.flags, a.flags);
        assert.equal(b.iterationsThisStroke, a.iterationsThisStroke);
        assert.equal(b.seedHex, a.seedHex);
    }
});

test("decode tolerates empty / malformed input", () => {
    assert.deepEqual(decodeBallSnapshot(""), []);
    assert.deepEqual(decodeBallSnapshot(";"), []);
    assert.deepEqual(decodeBallSnapshot("not,enough,fields"), []);
});

test("ballPosDistSq + agreement epsilon", () => {
    const a = sample[0]!;
    const b = { ...a, x: a.x + 0.4, y: a.y + 0.2 };
    assert.ok(Math.sqrt(ballPosDistSq(a, b)) < SNAPSHOT_AGREEMENT_EPSILON_PX);
    const c = { ...a, x: a.x + 5, y: a.y };
    assert.ok(Math.sqrt(ballPosDistSq(a, c)) > SNAPSHOT_AGREEMENT_EPSILON_PX);
});
