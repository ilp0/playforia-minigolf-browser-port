// In-memory track and trackset registry. Mirrors FileSystemTrackManager.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseTrack, parseTrackset, tabularize, commaize, type Track, type TrackSet } from "@minigolf/shared";

export const TrackCategory = Object.freeze({
    UNKNOWN: -1,
    ALL: 0,
    BASIC: 1,
    TRADITIONAL: 2,
    MODERN: 3,
    HIO: 4,
    SHORT: 5,
    LONG: 6,
} as const);

export type TrackCategoryId = (typeof TrackCategory)[keyof typeof TrackCategory];

export function trackCategoryByTypeId(id: number): TrackCategoryId {
    switch (id) {
        case 0:
            return TrackCategory.ALL;
        case 1:
            return TrackCategory.BASIC;
        case 2:
            return TrackCategory.TRADITIONAL;
        case 3:
            return TrackCategory.MODERN;
        case 4:
            return TrackCategory.HIO;
        case 5:
            return TrackCategory.SHORT;
        case 6:
            return TrackCategory.LONG;
        default:
            return TrackCategory.UNKNOWN;
    }
}

/**
 * The Java FileSystemTrackStats holds bundled "stats" alongside the track. In our MVP
 * the stats live inside the Track itself (parsed from the I/R/B lines), so we expose a
 * thin record that lets `networkSerialize()` find what it needs.
 */
export interface TrackStats {
    track: Track;
    numCompletions: number;
    totalStrokes: number;
    bestPar: number;
    numberOfBestPar: number;
    bestPlayer: string | null;
    /** epoch milliseconds */
    bestParEpoch: number | null;
    /** Fixed-length 11 entries (ratings buckets). Missing buckets default to 0. */
    ratings: number[];
}

const RATINGS_LENGTH = 11;

function makeStats(track: Track): TrackStats {
    const ratings = new Array<number>(RATINGS_LENGTH).fill(0);
    for (let i = 0; i < Math.min(track.ratings.length, RATINGS_LENGTH); i++) {
        ratings[i] = track.ratings[i];
    }
    return {
        track,
        numCompletions: track.plays,
        totalStrokes: track.strokes,
        bestPar: track.bestPar,
        numberOfBestPar: track.numBestPar,
        bestPlayer: track.bestPlayer ?? null,
        bestParEpoch: track.bestParEpoch ?? null,
        ratings,
    };
}

function ratingsToString(ratings: number[]): string {
    return ratings.join(",");
}

/**
 * Java FileSystemTrackStats.networkSerialize. Branches on bestPar (>=0 vs <0).
 * Outer separator is `\t`; inner I/R/B rows are comma-joined.
 */
export function networkSerialize(stats: TrackStats): string {
    const t = stats.track;
    const iLine = "I " + commaize(stats.numCompletions, stats.totalStrokes, stats.bestPar, stats.numberOfBestPar);
    const rLine = "R " + ratingsToString(stats.ratings);
    // Tag/category line — clients render these as chips next to the track name.
    // Java's networkSerialize doesn't include this; we add it as a port extension
    // because the client UI surfaces tags now.
    const cLine = "C " + (t.categories.length > 0 ? t.categories.join(",") : "");

    if (stats.bestPar < 0) {
        return tabularize("V 1", "A " + t.author, "N " + t.name, "T " + t.map, cLine, iLine, rLine);
    }

    const bestPlayer = stats.bestPlayer ?? "";
    const bestEpoch = stats.bestParEpoch ?? 0;
    const bLine = "B " + commaize(bestPlayer, bestEpoch);
    return tabularize("V 1", "A " + t.author, "N " + t.name, "T " + t.map, cLine, iLine, bLine, rLine);
}

export class TrackManager {
    tracks: Track[] = [];
    trackSets: TrackSet[] = [];
    private byName = new Map<string, Track>();
    private byCategory = new Map<TrackCategoryId, Track[]>();
    private loaded = false;

    async load(tracksDir: string): Promise<void> {
        const tracksPath = path.join(tracksDir, "tracks");
        const setsPath = path.join(tracksDir, "sets");

        const tracksDirEntries = await safeReaddir(tracksPath);
        for (const entry of tracksDirEntries) {
            if (!entry.endsWith(".track")) continue;
            const full = path.join(tracksPath, entry);
            try {
                const text = await fs.readFile(full, "utf-8");
                const track = parseTrack(text);
                this.tracks.push(track);
                this.byName.set(track.name, track);
                for (const cat of track.categories) {
                    const list = this.byCategory.get(cat as TrackCategoryId) ?? [];
                    list.push(track);
                    this.byCategory.set(cat as TrackCategoryId, list);
                }
            } catch (err) {
                console.warn(`[tracks] failed to parse ${entry}: ${err instanceof Error ? err.message : err}`);
            }
        }

        const setEntries = await safeReaddir(setsPath);
        setEntries.sort();
        for (const entry of setEntries) {
            if (!entry.endsWith(".trackset")) continue;
            try {
                const text = await fs.readFile(path.join(setsPath, entry), "utf-8");
                this.trackSets.push(parseTrackset(text));
            } catch (err) {
                console.warn(`[tracks] failed to parse trackset ${entry}: ${err instanceof Error ? err.message : err}`);
            }
        }

        this.loaded = true;
        console.log(`[tracks] loaded ${this.tracks.length} tracks, ${this.trackSets.length} tracksets`);
    }

    isLoaded(): boolean {
        return this.loaded;
    }

    /** Return up to `limit` random tracks, optionally filtered by category. Mirrors Java. */
    getRandomTracks(limit: number, category: TrackCategoryId): Track[] {
        if (limit < 1) {
            throw new Error("Number of tracks must be at least 1");
        }
        const pool =
            category === TrackCategory.ALL
                ? this.tracks
                : this.tracks.filter((t) => t.categories.includes(category as number));
        if (pool.length === 0) {
            // Empty category — fall back to ALL so a player isn't stranded.
            return this.shuffled(this.tracks).slice(0, limit);
        }
        return this.shuffled(pool).slice(0, limit);
    }

    findByName(name: string): Track | undefined {
        return this.byName.get(name);
    }

    /**
     * Per-category track counts. Index 0 = ALL (total), 1..6 = individual
     * categories. Used by the client to show "Modern (1288 tracks)" etc.
     */
    getCategoryCounts(): number[] {
        const counts = new Array<number>(7).fill(0);
        counts[0] = this.tracks.length;
        for (let i = 1; i <= 6; i++) {
            counts[i] = (this.byCategory.get(i as TrackCategoryId) ?? []).length;
        }
        return counts;
    }

    getStats(track: Track): TrackStats {
        return makeStats(track);
    }

    private shuffled<T>(arr: T[]): T[] {
        const copy = arr.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = copy[i];
            copy[i] = copy[j];
            copy[j] = tmp;
        }
        return copy;
    }
}

async function safeReaddir(p: string): Promise<string[]> {
    try {
        return await fs.readdir(p);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            console.warn(`[tracks] directory not found: ${p}`);
            return [];
        }
        throw err;
    }
}
