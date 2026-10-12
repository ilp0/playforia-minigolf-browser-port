import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeWireOrigin, encodeExactOrigin, parseExactOrigin, resolveStrokeOrigin } from "./stroke-origin.ts";

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

test("exact origins round-trip bit for bit", () => {
    for (const [x, y] of [[367.5, 187.5], [565.8081537221, 79.84400012], [0.1 + 0.2, 1e-7], [734.9999999999999, 374]]) {
        const parsed = parseExactOrigin(encodeExactOrigin(x, y), Math.trunc(x), Math.trunc(y));
        assert.deepEqual(parsed, { x, y });
    }
});

test("rejects exact origins that are malformed or leave the wire pixel", () => {
    assert.equal(parseExactOrigin(undefined, 1, 1), null);
    assert.equal(parseExactOrigin("", 0, 0), null);
    assert.equal(parseExactOrigin("1.5,2.5", 2, 2), null);
    assert.equal(parseExactOrigin("NaN,1", 0, 1), null);
    assert.equal(parseExactOrigin("Infinity,1", 0, 1), null);
    assert.equal(parseExactOrigin("0x1f,1", 31, 1), null);
    assert.equal(parseExactOrigin(" 1,1", 1, 1), null);
    assert.equal(parseExactOrigin("-0.5,1", 0, 1), null);
    assert.equal(parseExactOrigin("1,1,1", 1, 1), null);
    assert.equal(parseExactOrigin("1." + "1".repeat(70) + ",1", 1, 1), null);
});

test("decodes the whole-pixel wire origin", () => {
    const v = (565 * 1500 + 79 * 4 + 2).toString(36);
    assert.deepEqual(decodeWireOrigin(v), { x: 565, y: 79 });
});
