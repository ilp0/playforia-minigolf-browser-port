/**
 * Daily Cup - client-side helpers for the once-per-day mode.
 *
 * - `todayKey()` matches the server's `todayDateKey()` (UTC YYYY-MM-DD), so a
 *   localStorage entry survives if and only if the player already finished
 *   today's run.
 * - Results are stored in localStorage to gate the "Daily Cup" button on
 *   the lobby-select panel and to render the share text.
 *
 * No backend persistence - the server doesn't know if you've played; the
 * gate is purely client-side. Refreshing or clearing storage lets you replay,
 * matching the user's "we can allow that" stance.
 */

const STORAGE_PREFIX = "daily-played-";

export interface DailyResult {
    date: string;        // UTC YYYY-MM-DD
    strokes: number;     // your final stroke count for the hole
    average: number;     // server-reported track avg (totalStrokes/plays)
    forfeited: boolean;
    trackName: string;
}

export function todayKey(): string {
    return new Date().toISOString().slice(0, 10);
}

export function getDailyResult(date: string = todayKey()): DailyResult | null {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + date);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as DailyResult;
        if (parsed.date !== date) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function saveDailyResult(r: DailyResult): void {
    try {
        localStorage.setItem(STORAGE_PREFIX + r.date, JSON.stringify(r));
    } catch {
        // storage quota / disabled - best-effort.
    }
}

/**
 * Best-effort copy. Resolves to true if the modern Clipboard API succeeded.
 * Returns false if the browser refused (no permission, insecure context,
 * etc.) so the caller can show a manual-copy fallback.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to the document.execCommand path
    }
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

/** YYYY-MM-DD → DD.MM.YYYY for the human-facing share line. */
function formatShareDate(isoDate: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
    if (!m) return isoDate;
    return `${m[3]}.${m[2]}.${m[1]}`;
}

export function shareText(r: DailyResult, replayUrl?: string): string {
    const avgStr = r.average > 0 ? r.average.toFixed(1) : "?";
    const lines: string[] = [];
    if (replayUrl) lines.push(replayUrl);
    lines.push(`Daily Cup ${formatShareDate(r.date)}`);
    lines.push(
        r.forfeited
            ? `Forfeited "${r.trackName}" (avg ${avgStr})`
            : `${r.strokes} stroke${r.strokes === 1 ? "" : "s"} on "${r.trackName}" (avg ${avgStr})`,
    );
    return lines.join("\n");
}

// ----- Replay sharing -------------------------------------------------------
//
// A daily run is fully reproducible from the broadcast `beginstroke` packets:
// each carries `(ballCoords, mouseCoords, seed)` and the physics is
// deterministic. We pack the run plus the track's RLE tile data ("T <map>"
// line value) into the URL fragment, so the link is self-contained - playback
// works on any future day with no server lookup of past tracks.
//
// Lossy in two known edge cases (acceptable for v1; bounded errors because the
// next stroke's recorded ballCoords re-snaps the ball):
//
// 1. `PhysicsContext.otherPlayers` - peers' resting positions feed the
//    movable-block obstruction check. Daily-room strokes from concurrent
//    players are NOT recorded here, so movable blocks during playback move as
//    if the player were alone. If a daily track ever combines movable blocks
//    with high-traffic ghost positions, divergence is possible.
// 2. `PhysicsContext.startX/Y` - used by water-event=0 ("respawn at stroke
//    start"). Replay sets these to the recorded ball position, which is the
//    same value the live game uses, so this is only lossy if the original
//    server had `waterEvent !== 0` (unlikely; daily uses default 0).
//
// Capturing peer positions and the per-slot spawn into the tuple would close
// both gaps; defer until they're observed to matter.

export interface DailyReplay {
    /** Format version. Bump on breaking changes. */
    v: 1;
    /** UTC date key the run was played on (informational; YYYY-MM-DD). */
    d: string;
    /** Track display name and author (for the playback HUD). */
    n: string;
    a: string;
    /** Track average for the playback share-screen, if known. */
    avg?: number;
    /**
     * Raw value of the `T <map>` line from the original `starttrack` payload.
     * Fed straight into `buildMap()` during playback. The full 32-bit per-stroke
     * seed (broadcast by the server) embeds the original gameId, so playback
     * doesn't need to mirror server seat assignment - we drop the ball at each
     * stroke's recorded ballCoords and the seed alone reproduces the trajectory.
     */
    t: string;
    /** Strokes in order. Tuple = [ballCoords, mouseCoords, seed]. */
    s: Array<[string, string, number]>;
    /** True if the player holed in; false if forfeited. */
    holed: boolean;
}

function toBase64Url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
    try {
        const padded = s.replace(/-/g, "+").replace(/_/g, "/")
            + "=".repeat((4 - (s.length % 4)) % 4);
        const bin = atob(padded);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

export function encodeReplay(r: DailyReplay): string {
    const json = JSON.stringify(r);
    const bytes = new TextEncoder().encode(json);
    return toBase64Url(bytes);
}

export function decodeReplay(s: string): DailyReplay | null {
    const bytes = fromBase64Url(s);
    if (!bytes) return null;
    try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DailyReplay;
        if (parsed?.v !== 1) return null;
        if (typeof parsed.t !== "string" || !Array.isArray(parsed.s)) return null;
        return parsed;
    } catch {
        return null;
    }
}

/** Build a shareable URL with the replay payload in the fragment. */
export function replayLink(r: DailyReplay): string {
    const enc = encodeReplay(r);
    const base = window.location.origin + window.location.pathname;
    return `${base}#replay=${enc}`;
}

/**
 * POST a replay to the server's in-memory store and return the short URL.
 * The id is opaque base36; URL form is `…/?r=<id>`. Throws on network or
 * server failure so the caller can fall back to the embed-in-fragment link.
 */
export async function shortReplayLink(r: DailyReplay): Promise<string> {
    const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r),
    });
    if (!res.ok) throw new Error(`replay save failed: ${res.status}`);
    const { id } = (await res.json()) as { id?: string };
    if (typeof id !== "string" || id.length === 0) throw new Error("server returned no id");
    const base = window.location.origin + window.location.pathname;
    return `${base}?r=${id}`;
}

/** Fetch a replay by id from the server. Returns null if expired/not found. */
export async function fetchReplayById(id: string): Promise<DailyReplay | null> {
    const res = await fetch(`/api/replay/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`replay fetch failed: ${res.status}`);
    const json = (await res.json()) as DailyReplay;
    if (json?.v !== 1 || typeof json.t !== "string" || !Array.isArray(json.s)) return null;
    return json;
}

/** Pull and parse a replay from the current `window.location.hash`, if any. */
export function readReplayFromHash(): DailyReplay | null {
    const h = window.location.hash;
    if (!h.startsWith("#")) return null;
    const params = new URLSearchParams(h.slice(1));
    const raw = params.get("replay");
    if (!raw) return null;
    return decodeReplay(raw);
}

/**
 * Read a replay id from the URL query string (`?r=<id>`). Used for the
 * server-stored short links, which keep the URL compact at ~30 chars.
 */
export function readReplayIdFromQuery(): string | null {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("r");
    if (!id) return null;
    if (!/^[a-z0-9]{8}$/.test(id)) return null;
    return id;
}
