import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStrokeOrigin } from "./stroke-origin.ts";

test("keeps the exact tee position when the wire value is its truncation", () => {
    assert.deepEqual(resolveStrokeOrigin(367, 187, 367.5, 187.5), { x: 367.5, y: 187.5 });
});

test("keeps exact sub-pixel resting positions", () => {
    assert.deepEqual(resolveStrokeOrigin(120, 44, 120.913, 44.002), { x: 120.913, y: 44.002 });
});

test("snaps a drifted client to the server position", () => {
    assert.deepEqual(resolveStrokeOrigin(120, 44, 121.2, 44.5), { x: 120, y: 44 });
    assert.deepEqual(resolveStrokeOrigin(120, 44, 120.5, 45.1), { x: 120, y: 44 });
});
