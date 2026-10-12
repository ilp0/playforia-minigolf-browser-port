// In-memory store for shared daily replays.
//
// We don't persist to disk: replays are ephemeral by nature (a daily run
// linked to a particular date is mostly shared the same day), and an in-
// memory ring buffer keeps the implementation tiny and abuse-bounded. If a
// shared link outlives the buffer's reach (or the server restarts), the
// fetch falls through to a 404 and the client surfaces "replay expired".
//
// Capacity is a hard upper bound: oldest entries are evicted as new ones
// arrive. Sized for "lots of daily players sharing freely" without letting
// the server's heap balloon - 10k replays at ~2 KB each ≈ 20 MB. Bodies may be
// up to 64 KB, so total stored characters are capped too.

import { randomBytes } from "node:crypto";

const MAX_REPLAYS = 10_000;
const MAX_STORED_CHARS = 16 * 1024 * 1024;
let storedChars = 0;

/**
 * Stored replays as a Map (insertion-ordered) so eviction picks the oldest.
 * Re-inserting on read would make this an LRU; the current FIFO behaviour is
 * fine because we just want bounded memory, not access-pattern caching.
 */
const store = new Map<string, string>();

/** 8-char base36 id - 36^8 ≈ 2.8e12, collision-free at our scale. */
function generateId(): string {
    const bytes = randomBytes(8);
    let id = "";
    for (const byte of bytes) id += (byte % 36).toString(36);
    return id;
}

export function saveReplay(payload: string): string {
    let id = generateId();
    // Vanishingly rare, but handle it.
    while (store.has(id)) id = generateId();
    store.set(id, payload);
    storedChars += payload.length;
    while (store.size > MAX_REPLAYS || storedChars > MAX_STORED_CHARS) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        storedChars -= store.get(oldestKey)?.length ?? 0;
        store.delete(oldestKey);
    }
    return id;
}

export function getReplay(id: string): string | null {
    return store.get(id) ?? null;
}

/** Test hook - wipes the store. */
export function _clearReplayStore(): void {
    store.clear();
    storedChars = 0;
}
