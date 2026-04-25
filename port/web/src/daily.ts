/**
 * Daily Cup — client-side helpers for the once-per-day mode.
 *
 * - `todayKey()` matches the server's `todayDateKey()` (UTC YYYY-MM-DD), so a
 *   localStorage entry survives if and only if the player already finished
 *   today's run.
 * - Results are stored in localStorage to gate the "Daily Cup" button on
 *   the lobby-select panel and to render the share text.
 *
 * No backend persistence — the server doesn't know if you've played; the
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
        // storage quota / disabled — best-effort.
    }
}

/**
 * Score formula. Above 100 = beat the track average; 100 = on average; below
 * 100 = worse. Hand-tuned for "average ≈ 5 strokes" tracks: each stroke
 * relative to the average moves the score by ~10 points. Forfeits get a fixed
 * floor so the share is still postable.
 */
export function dailyScore(strokes: number, average: number, forfeited: boolean): number {
    if (forfeited) return 0;
    if (!Number.isFinite(average) || average <= 0) return 100;
    const delta = average - strokes; // positive = better than average
    return Math.max(0, Math.round(100 + delta * 10));
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

export function shareText(r: DailyResult): string {
    const score = dailyScore(r.strokes, r.average, r.forfeited);
    const avgStr = r.average > 0 ? r.average.toFixed(1) : "?";
    const lines = [
        `Playforia Minigolf — Daily Cup ${r.date}`,
        r.forfeited
            ? `Forfeited "${r.trackName}" (avg ${avgStr})`
            : `${r.strokes} stroke${r.strokes === 1 ? "" : "s"} on "${r.trackName}" (avg ${avgStr}) — score ${score}`,
    ];
    return lines.join("\n");
}
