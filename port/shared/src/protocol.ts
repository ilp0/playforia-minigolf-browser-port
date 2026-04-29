// Wire-protocol codec ported from the Java SocketConnection / GameQueue / GolfConnection.
//
// Wire format (line-delimited TCP in Java; one WebSocket text frame per packet here, no \n):
//   COMMAND: "c <message>"            e.g. "c new", "c id 42", "c ping", "c pong"
//   DATA:    "d <seqNum> <message>"   e.g. "d 0 logintype\tnr"   (\t = tab)
//   STRING:  "s <message>"
//   HEADER:  "h <message>"            handshake-on-connect, value is always "1"
//   NONE:    raw "<message>"          (rare; unprefixed)

// String-literal "enum" - Node's strip-only TS mode does not support `enum`.
export const PacketType = Object.freeze({
    COMMAND: "c",
    DATA: "d",
    STRING: "s",
    HEADER: "h",
    NONE: "n",
} as const);

export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export interface Packet {
    type: PacketType;
    /** DATA packets only - monotonic per-direction sequence number. */
    seq?: number;
    /** Message body after the prefix and (for DATA) sequence number. */
    raw: string;
    /** Tab-split for DATA, space-split for COMMAND, single element for STRING/HEADER/NONE. */
    fields: string[];
}

export function bool(v: boolean): "t" | "f" {
    return v ? "t" : "f";
}

export function parseBool(s: string): boolean {
    return s === "t";
}

function asField(v: string | number | boolean): string {
    if (typeof v === "boolean") return bool(v);
    if (typeof v === "number") return String(v);
    return v;
}

/**
 * Build the inner DATA-packet payload string and prepend the "d <seq> " prefix.
 * Encodes booleans as "t"/"f" (Tools.izer convention) and joins fields with tabs.
 */
export function buildData(seq: number, ...fields: (string | number | boolean)[]): string {
    const body = fields.map(asField).join("\t");
    return `d ${seq} ${body}`;
}

/** Build a "c <verb> <arg1> <arg2> ..." command packet. Args are space-joined. */
export function buildCommand(verb: string, ...args: string[]): string {
    return args.length === 0 ? `c ${verb}` : `c ${verb} ${args.join(" ")}`;
}

export function encode(p: Packet): string {
    switch (p.type) {
        case PacketType.COMMAND:
            return `c ${p.raw}`;
        case PacketType.DATA:
            if (p.seq === undefined) {
                throw new Error("DATA packet missing seq");
            }
            return `d ${p.seq} ${p.raw}`;
        case PacketType.STRING:
            return `s ${p.raw}`;
        case PacketType.HEADER:
            return `h ${p.raw}`;
        case PacketType.NONE:
            return p.raw;
    }
}

export function decode(line: string): Packet {
    if (line.length === 0) {
        throw new Error("empty packet");
    }
    const first = line.charAt(0);
    // A typed prefix always has a single-character type and a space separator.
    if (line.length >= 2 && line.charAt(1) === " ") {
        const body = line.substring(2);
        switch (first) {
            case "c": {
                return {
                    type: PacketType.COMMAND,
                    raw: body,
                    fields: body.length === 0 ? [] : body.split(" "),
                };
            }
            case "d": {
                // DATA: "<seqNum> <message...>"
                const sp = body.indexOf(" ");
                if (sp < 0) {
                    throw new Error(`malformed DATA packet: ${line}`);
                }
                const seqStr = body.substring(0, sp);
                const seq = Number(seqStr);
                if (!Number.isFinite(seq) || !Number.isInteger(seq) || seq < 0) {
                    throw new Error(`bad seq in DATA packet: ${seqStr}`);
                }
                const raw = body.substring(sp + 1);
                return {
                    type: PacketType.DATA,
                    seq,
                    raw,
                    fields: raw.length === 0 ? [] : raw.split("\t"),
                };
            }
            case "s": {
                return { type: PacketType.STRING, raw: body, fields: [body] };
            }
            case "h": {
                return { type: PacketType.HEADER, raw: body, fields: [body] };
            }
        }
    }
    // Unprefixed (rare)
    return { type: PacketType.NONE, raw: line, fields: [line] };
}
