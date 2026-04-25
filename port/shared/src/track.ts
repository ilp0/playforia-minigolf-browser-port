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
 * Parse a versioned (.track) file. Tolerates missing optional lines.
 *
 * Format (per VersionedTrackFileParser javadoc):
 *   V <version>            — only V >= 2 is supported
 *   A <author>
 *   N <name>
 *   T <encoded_map>        — raw, undecoded
 *   C <category_csv>       — comma-separated ints
 *   S <settings>           — "ttff" etc
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
        // GenericTrackParser uses line.substring(2) — i.e. expects "<tag> <body>".
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
