// Track and Trackset file parsers. Ported from VersionedTrackFileParser and the various
// LineParser implementations under shared/src/main/java/org/moparforia/shared/tracks/.

export interface Track {
    version: number;
    author: string;
    name: string;
    /** Raw T-line (the encoded RLE map plus any ",Ads:..." suffix). Use rle.decodeMap() to expand. */
    map: string;
    /** Parsed from C line as integer ids (e.g. [3], [1,2]). Empty if no C line. */
    categories: number[];
    /** 4-character flag string ("ttff" etc). Default "ffff" if missing. */
    settings: string;
    plays: number;
    strokes: number;
    bestPar: number;
    numBestPar: number;
    /** 11 ratings (one per score bucket). Empty if no R line. */
    ratings: number[];
    bestPlayer?: string;
    bestParEpoch?: number;
    lastBestPlayer?: string;
    lastBestEpoch?: number;
}

export type TrackSetDifficulty = "EASY" | "MEDIUM" | "HARD";

export interface TrackSet {
    name: string;
    difficulty: TrackSetDifficulty;
    trackNames: string[];
}

const DEFAULT_SETTINGS = "ffff";

/**
 * Four boolean flags decoded from a track's `S` line. Indexes mirror Java's
 * `Track.specialSettings`:
 *   [0] mines visible       (false = mines render as plain bg / "invisible")
 *   [1] magnets visible     (false = magnets render as plain bg)
 *   [2] teleports coloured  (false = colour-keyed start/exit reduce to blue)
 *   [3] illusion shadows    (false = collision-id 19 doesn't cast a shadow)
 */
export type SettingsFlags = readonly [boolean, boolean, boolean, boolean];

export const NO_SETTINGS_FLAGS: SettingsFlags = [false, false, false, false];

/**
 * Decode the first 4 chars of an S-line body into the boolean flag array.
 * Real-world tracks store six chars - four flags plus a 2-digit min/max
 * player range - but the Java client only consults the first four. We do the
 * same and tolerate strings shorter than 4 by leaving the missing flags false
 * (matching `new boolean[4]` in `VersionedTrackFileParser.constructTrack`).
 *
 * Note: the upstream Java parser has a long-standing typo (`length() != 6`)
 * that drops the flags entirely whenever the string is exactly 6 chars long
 * - i.e. for nearly every real track. The dev-comment "should throw error"
 * in the `else` branch shows the original intent was to parse the first 4
 * chars regardless of total length, which is what we do here.
 */
export function parseSettingsFlags(settings: string | null | undefined): SettingsFlags {
    if (!settings) return NO_SETTINGS_FLAGS;
    return [
        settings.charAt(0) === "t",
        settings.charAt(1) === "t",
        settings.charAt(2) === "t",
        settings.charAt(3) === "t",
    ];
}

/**
 * Mirror of Java `Tile.getSpecialsettingCode(boolean[])`. Substitutes a raw
 * 32-bit tile code based on visibility flags so the substituted code unpacks
 * into the "hidden" / "colourless" form. Pure function - no dependencies on
 * canvas / sprites - so the renderer just calls this on each tile before
 * unpacking.
 *
 * Shape values here are the RAW byte (Java's `tile.shape` is `raw + 24`):
 *   raw 4 / 6  → mine / BIGmine                   (Java shape 28 / 30)
 *   raw 20 / 21 → magnet attract / repel           (Java shape 44 / 45)
 *   raw 10 / 12 / 14 → red/yellow/green T-source  (Java shape 34 / 36 / 38)
 *   raw 11 / 13 / 15 → red/yellow/green T-exit    (Java shape 35 / 37 / 39)
 *
 * Substitute encodings (Java verbatim, before adding `bg*256`):
 *   16777216 = 0x01000000 → special=1, shape=0   ⇒ plain bg element
 *   34078720 = 0x02080000 → special=2, shape=8   ⇒ blue T-source (generic start)
 *   34144256 = 0x02090000 → special=2, shape=9   ⇒ blue T-exit (generic exit)
 * `bg*256` restores the original under-tile element (e.g. mine on dirt becomes
 * plain dirt, not plain grass).
 *
 * IMPORTANT: only the visual layer should call this. Java `Map.collisionMap()`
 * does NOT consult specialSettings - the collision/physics layer keeps the
 * unmodified tile semantics so a hidden mine still detonates, a hidden magnet
 * still pulls, etc. That's the whole point of the flags as a puzzle knob.
 */
export function applySettingsToTileCode(code: number, flags: SettingsFlags): number {
    const special = (code >>> 24) & 0xff;
    if (special !== 2) return code;
    const shape = (code >>> 16) & 0xff;
    const bg = (code >>> 8) & 0xff;
    // [0] mines invisible - Java shape 28/30 (raw 4/6).
    if (!flags[0] && (shape === 4 || shape === 6)) return 16777216 + bg * 256;
    // [1] magnets invisible - Java shape 44/45 (raw 20/21).
    if (!flags[1] && (shape === 20 || shape === 21)) return 16777216 + bg * 256;
    // [2] teleports colourless - colour-keyed starts/exits collapse to blue.
    if (!flags[2]) {
        if (shape === 10 || shape === 12 || shape === 14) return 34078720 + bg * 256;
        if (shape === 11 || shape === 13 || shape === 15) return 34144256 + bg * 256;
    }
    return code;
}

/**
 * Parse a versioned (.track) file. Tolerates missing optional lines.
 *
 * Format (per VersionedTrackFileParser javadoc):
 *   V <version>            - only V >= 2 is supported
 *   A <author>
 *   N <name>
 *   T <encoded_map>        - raw, undecoded
 *   C <category_csv>       - comma-separated ints
 *   S <settings>           - "ttff" etc
 *   I <plays>,<strokes>,<bestPar>,<numBestPar>
 *   R <r0,r1,...,r10>
 *   B <player>,<epoch_millis>
 *   L <player>,<epoch_millis>
 */
export function parseTrack(text: string): Track {
    const t: Track = {
        version: 0,
        author: "",
        name: "",
        map: "",
        categories: [],
        settings: DEFAULT_SETTINGS,
        plays: 0,
        strokes: 0,
        bestPar: -1,
        numBestPar: 0,
        ratings: [],
    };

    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
        if (rawLine.length < 2) continue;
        const tag = rawLine.charAt(0);
        // GenericTrackParser uses line.substring(2) - i.e. expects "<tag> <body>".
        if (rawLine.charAt(1) !== " ") continue;
        const body = rawLine.substring(2);

        switch (tag) {
            case "V":
                t.version = parseInt(body, 10) || 0;
                break;
            case "A":
                t.author = body;
                break;
            case "N":
                t.name = body;
                break;
            case "T":
                t.map = body;
                break;
            case "C": {
                t.categories = body
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
                    .map((s) => parseInt(s, 10))
                    .filter((n) => Number.isFinite(n));
                break;
            }
            case "S":
                t.settings = body;
                break;
            case "I": {
                const parts = body.split(",");
                if (parts.length >= 4) {
                    t.plays = parseInt(parts[0], 10) || 0;
                    t.strokes = parseInt(parts[1], 10) || 0;
                    t.bestPar = parseInt(parts[2], 10);
                    if (!Number.isFinite(t.bestPar)) t.bestPar = -1;
                    t.numBestPar = parseInt(parts[3], 10) || 0;
                }
                break;
            }
            case "R": {
                t.ratings = body
                    .split(",")
                    .map((s) => parseInt(s.trim(), 10))
                    .filter((n) => Number.isFinite(n));
                break;
            }
            case "B": {
                const [player, epoch] = body.split(",");
                if (player !== undefined) t.bestPlayer = player;
                if (epoch !== undefined) {
                    const e = parseInt(epoch, 10);
                    if (Number.isFinite(e)) t.bestParEpoch = e;
                }
                break;
            }
            case "L": {
                const [player, epoch] = body.split(",");
                if (player !== undefined) t.lastBestPlayer = player;
                if (epoch !== undefined) {
                    const e = parseInt(epoch, 10);
                    if (Number.isFinite(e)) t.lastBestEpoch = e;
                }
                break;
            }
            default:
                // Unknown tags are ignored, matching GenericTrackParser.
                break;
        }
    }

    return t;
}

/**
 * Parse a .trackset file. Format (FileSystemTrackManager.loadTrackSets):
 *   line 1: set name
 *   line 2: difficulty enum name (EASY / MEDIUM / HARD)
 *   lines 3..: track names (blank lines skipped, names trimmed)
 */
export function parseTrackset(text: string): TrackSet {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) {
        throw new Error("trackset file too short");
    }
    const name = lines[0];
    const diffRaw = lines[1].trim();
    if (diffRaw !== "EASY" && diffRaw !== "MEDIUM" && diffRaw !== "HARD") {
        throw new Error(`unknown trackset difficulty: ${diffRaw}`);
    }
    const trackNames: string[] = [];
    for (let i = 2; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.length > 0) {
            trackNames.push(trimmed);
        }
    }
    return { name, difficulty: diffRaw, trackNames };
}
