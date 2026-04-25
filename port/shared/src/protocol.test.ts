import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    PacketType,
    bool,
    parseBool,
    buildCommand,
    buildData,
    decode,
    encode,
} from "./protocol.ts";

describe("protocol — bool helpers", () => {
    it("encodes boolean values as t/f", () => {
        assert.equal(bool(true), "t");
        assert.equal(bool(false), "f");
    });

    it("parses only 't' as true", () => {
        assert.equal(parseBool("t"), true);
        assert.equal(parseBool("f"), false);
        assert.equal(parseBool(""), false);
        assert.equal(parseBool("true"), false);
    });
});

describe("protocol — buildCommand", () => {
    it("joins verb and args with single spaces", () => {
        assert.equal(buildCommand("ping"), "c ping");
        assert.equal(buildCommand("id", "42"), "c id 42");
        assert.equal(buildCommand("old", "12345"), "c old 12345");
    });
});

describe("protocol — buildData", () => {
    it("encodes mixed types and tab-joins fields", () => {
        assert.equal(
            buildData(5, "logintype", "nr", true, 42),
            "d 5 logintype\tnr\tt\t42",
        );
    });

    it("encodes a lone integer body", () => {
        assert.equal(buildData(0, "version", 35), "d 0 version\t35");
    });
});

describe("protocol — encode/decode roundtrip", () => {
    it("COMMAND with multiple args", () => {
        const wire = "c id 42";
        const p = decode(wire);
        assert.equal(p.type, PacketType.COMMAND);
        assert.deepEqual(p.fields, ["id", "42"]);
        assert.equal(p.raw, "id 42");
        assert.equal(encode(p), wire);
    });

    it("COMMAND with single verb", () => {
        const wire = "c ping";
        const p = decode(wire);
        assert.equal(p.type, PacketType.COMMAND);
        assert.deepEqual(p.fields, ["ping"]);
        assert.equal(encode(p), wire);
    });

    it("DATA splits seq and tab-fields", () => {
        const wire = "d 5 logintype\tnr\tt\t42";
        const p = decode(wire);
        assert.equal(p.type, PacketType.DATA);
        assert.equal(p.seq, 5);
        assert.deepEqual(p.fields, ["logintype", "nr", "t", "42"]);
        assert.equal(encode(p), wire);
    });

    it("STRING preserves raw body", () => {
        const wire = "s tlog\t1\thi";
        const p = decode(wire);
        assert.equal(p.type, PacketType.STRING);
        assert.equal(p.raw, "tlog\t1\thi");
        assert.equal(encode(p), wire);
    });

    it("HEADER decodes 'h 1'", () => {
        const p = decode("h 1");
        assert.equal(p.type, PacketType.HEADER);
        assert.equal(p.raw, "1");
        assert.equal(encode(p), "h 1");
    });

    it("NONE for unprefixed/raw line", () => {
        const p = decode("hello");
        assert.equal(p.type, PacketType.NONE);
        assert.equal(p.raw, "hello");
        assert.equal(encode(p), "hello");
    });
});

describe("protocol — decode error cases", () => {
    it("throws on empty input", () => {
        assert.throws(() => decode(""));
    });

    it("throws on DATA missing seq", () => {
        assert.throws(() => decode("d malformed"));
    });

    it("throws on DATA with non-numeric seq", () => {
        assert.throws(() => decode("d abc msg"));
    });
});
