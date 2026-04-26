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
// the server's heap balloon — 10k replays at ~2 KB each ≈ 20 MB.

const MAX_REPLAYS = 10_000;

/**
 * Stored replays as a Map (insertion-ordered) so eviction picks the oldest.
 * Re-inserting on read would make this an LRU; the current FIFO behaviour is
 * fine because we just want bounded memory, not access-pattern caching.
 */
const store = new Map<string, string>();

/** 8-char base36 id — 36^8 ≈ 2.8e12, collision-free at our scale. */
function generateId(): string {
    // Two 32-bit chunks ensure ≥ 4 bytes of entropy each.
    const a = Math.floor(Math.random() * 0xffffffff).toString(36);
    const b = Math.floor(Math.random() * 0xffffffff).toString(36);
    return (a + b).padEnd(8, "0").slice(0, 8);
}

export function saveReplay(payload: string): string {
    let id = generateId();
    // Vanishingly rare, but handle it.
    while (store.has(id)) id = generateId();
    store.set(id, payload);
    while (store.size > MAX_REPLAYS) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        store.delete(oldestKey);
    }
    return id;
}

export function getReplay(id: string): string | null {
    return store.get(id) ?? null;
}

/** Test hook — wipes the store. */
export function _clearReplayStore(): void {
    store.clear();
}
