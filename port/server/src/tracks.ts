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
    // Special-settings flags (mines/magnets/teleports visibility + illusion-wall
    // shadow). Java's networkSerialize omits this — combined with the buggy
    // `length() != 6` skip in VersionedTrackFileParser the original client
    // never honored S at all. The port forwards the raw S body so the renderer
    // can apply it. Empty string when the track file has no S line; the client
    // treats that as all-false (Java parser default).
    const sLine = "S " + (t.settings ?? "");

    if (stats.bestPar < 0) {
        return tabularize("V 1", "A " + t.author, "N " + t.name, "T " + t.map, cLine, sLine, iLine, rLine);
    }

    const bestPlayer = stats.bestPlayer ?? "";
    const bestEpoch = stats.bestParEpoch ?? 0;
    const bLine = "B " + commaize(bestPlayer, bestEpoch);
    return tabularize("V 1", "A " + t.author, "N " + t.name, "T " + t.map, cLine, sLine, iLine, bLine, rLine);
}

/**
 * Anti-repeat memory: how many recently-served tracks to remember per server.
 * When picking random tracks we prefer ones NOT in this ring. Sized roughly
 * for "a few games' worth so we don't repeat a track from your last session
 * unless the filtered pool is small enough to force it."
 */
const RECENT_RING_SIZE = 50;

export class TrackManager {
    tracks: Track[] = [];
    trackSets: TrackSet[] = [];
    private byName = new Map<string, Track>();
    private byCategory = new Map<TrackCategoryId, Track[]>();
    private loaded = false;
    /** Names of recently-served tracks (oldest first). Used by getRandomTracks. */
    private recentTrackNames: string[] = [];
    private recentTrackSet = new Set<string>();

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
        const filtered =
            category === TrackCategory.ALL
                ? this.tracks
                : this.tracks.filter((t) => t.categories.includes(category as number));
        // Empty category — fall back to ALL so a player isn't stranded.
        const pool = filtered.length === 0 ? this.tracks : filtered;
        const picked = this.pickAvoidingRecent(pool, limit);
        for (const t of picked) this.markRecent(t.name);
        return picked;
    }

    /**
     * Pick `limit` tracks from `pool`, preferring ones not in the recent ring.
     * If too few non-recent are available we fill the remainder from the recent
     * pool so the caller always gets `min(limit, pool.length)` tracks.
     */
    private pickAvoidingRecent(pool: Track[], limit: number): Track[] {
        const fresh: Track[] = [];
        const stale: Track[] = [];
        for (const t of pool) {
            if (this.recentTrackSet.has(t.name)) stale.push(t);
            else fresh.push(t);
        }
        const out = this.shuffled(fresh).slice(0, limit);
        if (out.length < limit) {
            for (const t of this.shuffled(stale)) {
                if (out.length >= limit) break;
                out.push(t);
            }
        }
        return out;
    }

    private markRecent(name: string): void {
        if (this.recentTrackSet.has(name)) {
            // Move to most-recent position by removing then re-pushing.
            const idx = this.recentTrackNames.indexOf(name);
            if (idx !== -1) this.recentTrackNames.splice(idx, 1);
        } else {
            this.recentTrackSet.add(name);
        }
        this.recentTrackNames.push(name);
        while (this.recentTrackNames.length > RECENT_RING_SIZE) {
            const evicted = this.recentTrackNames.shift();
            if (evicted !== undefined) this.recentTrackSet.delete(evicted);
        }
    }

    findByName(name: string): Track | undefined {
        return this.byName.get(name);
    }

    /**
     * Deterministic per-day track pick. Same `dateKey` (UTC YYYY-MM-DD) → same
     * track. Uses a small string hash so the choice isn't trivially predictable
     * from the date alone. Falls back to the first track if the pool is empty.
     */
    getDailyTrack(dateKey: string): Track {
        if (this.tracks.length === 0) throw new Error("no tracks loaded");
        let h = 0x811c9dc5 >>> 0;
        for (let i = 0; i < dateKey.length; i++) {
            h ^= dateKey.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return this.tracks[h % this.tracks.length];
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
