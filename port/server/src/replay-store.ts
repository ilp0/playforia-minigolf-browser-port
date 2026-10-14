/**
 * Daily Cup share payloads, persisted on disk. Existing IDs and URLs remain
 * compatible. POST /api/replay is unauthenticated, so the store is bounded by
 * entry count and total bytes (AAPELI_REPLAY_SHARE_MAX_ENTRIES, default 5000;
 * AAPELI_REPLAY_SHARE_MAX_BYTES, default 64 MiB); the oldest shares are
 * evicted first.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, openSync, closeSync, fsyncSync, readdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { envLimit } from './replay-fs.ts';

const MAX_PAYLOAD_BYTES = 64 * 1024;
let root = path.join(process.env.AAPELI_NATIVE_REPLAY_DIR || fileURLToPath(new URL('../../../../replays/private/native/', import.meta.url)), 'daily-shares');
let overrides: { maxEntries?: number; maxBytes?: number } = {};
/** id -> stored size, oldest first. Loaded lazily from disk on first use. */
let index: Map<string, number> | null = null;
let totalBytes = 0;
const testRoots: string[] = [];

function limits(): { maxEntries: number; maxBytes: number } {
    return {
        maxEntries: Math.max(1, overrides.maxEntries ?? envLimit('AAPELI_REPLAY_SHARE_MAX_ENTRIES', 5000)),
        maxBytes: Math.max(MAX_PAYLOAD_BYTES, overrides.maxBytes ?? envLimit('AAPELI_REPLAY_SHARE_MAX_BYTES', 64 * 1024 * 1024)),
    };
}

function load(): Map<string, number> {
    if (index) return index;
    mkdirSync(root, { recursive: true });
    const entries: { id: string; size: number; mtime: number }[] = [];
    for (const name of readdirSync(root)) {
        if (!name.endsWith('.json')) continue;
        try { const st = statSync(path.join(root, name)); entries.push({ id: name.slice(0, -5), size: st.size, mtime: st.mtimeMs }); } catch { /* raced away */ }
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    index = new Map(entries.map(e => [e.id, e.size]));
    totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    return index;
}

function evict(map: Map<string, number>): void {
    const { maxEntries, maxBytes } = limits();
    while (map.size > 1 && (map.size > maxEntries || totalBytes > maxBytes)) {
        const [oldest, size] = map.entries().next().value as [string, number];
        try { unlinkSync(path.join(root, oldest + '.json')); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        map.delete(oldest);
        totalBytes -= size;
    }
}

export function saveReplay(payload: string): string {
    const size = Buffer.byteLength(payload);
    if (size > MAX_PAYLOAD_BYTES) throw new Error('Replay payload too large');
    const map = load();
    let id: string;
    do { id = randomUUID(); } while (map.has(id));
    const fd = openSync(path.join(root, id + '.json'), 'wx');
    try { writeFileSync(fd, payload); fsyncSync(fd); } finally { closeSync(fd); }
    map.set(id, size);
    totalBytes += size;
    evict(map);
    return id;
}

export function getReplay(id: string): string | null {
    if (!/^(?:[a-z0-9]{8}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(id)) return null;
    try { return readFileSync(path.join(root, id + '.json'), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

/** Tests switch to an empty temporary namespace, preserving real archives. */
export function _clearReplayStore(limitOverrides: { maxEntries?: number; maxBytes?: number } = {}): string {
    root = mkdtempSync(path.join(tmpdir(), 'golf-replay-test-'));
    testRoots.push(root);
    overrides = limitOverrides;
    index = null;
    totalBytes = 0;
    return root;
}

/** Remove every temporary namespace created by {@link _clearReplayStore}. */
export function _disposeReplayStores(): void {
    for (const dir of testRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
    index = null;
    totalBytes = 0;
}
