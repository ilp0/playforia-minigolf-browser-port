// Direct port of org.moparforia.shared.Tools - string-joining helpers.
// Booleans encode as "t"/"f"; numbers via String.valueOf(); arrays are flattened one level.

export type ToolsArg = string | number | boolean | ToolsArg[];

function toString(o: string | number | boolean): string {
    if (typeof o === "boolean") return o ? "t" : "f";
    if (typeof o === "number") return String(o);
    return o;
}

/**
 * Mirrors Tools.izer(splitter, args...). Top-level array entries are flattened one level
 * (matching Java's `Object[]` branch); nested arrays are NOT recursively flattened.
 */
export function izer(splitter: string, ...args: ToolsArg[]): string {
    const parts: string[] = [];
    for (const arg of args) {
        if (Array.isArray(arg)) {
            for (const inner of arg) {
                if (Array.isArray(inner)) {
                    // Java's branch only handles a single level - coerce to its toString().
                    parts.push(String(inner));
                } else {
                    parts.push(toString(inner));
                }
            }
        } else {
            parts.push(toString(arg));
        }
    }
    return parts.join(splitter);
}

/** Tab-join, the workhorse of the wire protocol. */
export function tabularize(...args: ToolsArg[]): string {
    return izer("\t", ...args);
}

/** Caret-joined version (used by the Java client for some sub-records). */
export function triangelize(...args: ToolsArg[]): string {
    return izer("^", ...args);
}

/** Comma-join (used for category lists, score-info lines, etc). */
export function commaize(...args: ToolsArg[]): string {
    return izer(",", ...args);
}
