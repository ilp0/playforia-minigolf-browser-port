import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commaize, izer, tabularize, triangelize } from "./tools.ts";

describe("tools - primitive joining", () => {
    it("encodes booleans as t/f and numbers via String()", () => {
        assert.equal(tabularize("logintype", "nr", true, 42), "logintype\tnr\tt\t42");
        assert.equal(commaize(1, 2, 3), "1,2,3");
        assert.equal(triangelize("a", false), "a^f");
    });

    it("flattens one level of array arguments", () => {
        assert.equal(commaize([1, 2, 3]), "1,2,3");
        assert.equal(tabularize("x", [true, false]), "x\tt\tf");
    });

    it("works with custom splitters via izer", () => {
        assert.equal(izer("|", "a", "b", true), "a|b|t");
    });
});
