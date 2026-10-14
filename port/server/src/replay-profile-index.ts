/** Persistent, retryable portal indexing. Ownership comes only from verified WS identities. */
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import type { PortalConfig } from './portal.ts';
import { atomicWrite } from './replay-fs.ts';
import * as path from 'node:path';

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

let config: PortalConfig | null = null;
let directory = '';
let running = false, rerun = false, failures = 0, retryAt = 0;
let timer: NodeJS.Timeout | null = null;
/** Bodies of still-playing entries the portal already accepted; unchanged ones are not re-sent. */
const accepted = new Map<string, string>();

/**
 * Point the outbox at `root` and start publishing when a portal is configured.
 * Entries still marked playing were left by an earlier process, so they become
 * interrupted; `isLive` protects recordings this process is still writing.
 */
export function configureReplayIndex(cfg: PortalConfig | null, root: string, isLive: (id: string) => boolean = () => false): void {
    config = cfg;
    directory = path.join(root, 'profile-outbox');
    void (async () => {
        try {
            for (const name of await listOutbox()) {
                if (isLive(name.slice(0, -'.json'.length))) continue;
                const file = path.join(directory, name);
                try {
                    const meta = JSON.parse(await readFile(file, 'utf8'));
                    if (meta.state === 'playing') await atomicWrite(file, JSON.stringify({ ...meta, state: 'interrupted', ended: Date.now() }));
                } catch { /* Unreadable entries are retried or dropped by publish(). */ }
            }
        } catch (e) { console.error('Replay index outbox:', e); }
        if (config) void publish();
    })();
}

/** Durably queue the profile index entry for `meta`. Resolves once the outbox file is written. */
export async function queueReplayIndex(meta: Record<string, any>): Promise<void> {
    if (!directory || !meta.owners || !Object.keys(meta.owners).length) return;
    const body = JSON.stringify({
        id: meta.id, game: meta.game, mode: meta.settings?.mode, started: meta.started, ended: meta.ended ?? null, state: meta.state,
        owners: Object.entries(meta.owners).map(([profileId, view]) => ({ profileId, score: meta.scores?.[String(view)] || {} })),
    });
    await mkdir(directory, { recursive: true });
    await atomicWrite(path.join(directory, meta.id + '.json'), body);
    if (Date.now() >= retryAt) void publish();
}

async function listOutbox(): Promise<string[]> {
    try { return (await readdir(directory)).filter(n => n.endsWith('.json')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}

function schedule(delay: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void publish(), delay);
    timer.unref();
}

async function dropIfUnchanged(file: string, body: string): Promise<void> {
    if ((await readFile(file, 'utf8').catch(() => null)) === body) await unlink(file).catch(() => {});
}

/** One outbox pass. Never rejects: every failure is caught and turns into a backoff. */
async function publish(): Promise<void> {
    if (!config) return;
    if (running) { rerun = true; return; }
    running = true;
    let healthy = true;
    try {
        for (const name of await listOutbox()) {
            const cfg = config;
            if (!cfg) break;
            const file = path.join(directory, name);
            let body: string;
            try { body = await readFile(file, 'utf8'); } catch { continue; }
            if (accepted.get(name) === body) continue;
            let status: number;
            try {
                const response = await fetch(cfg.internalUrl + '/internal/replay', {
                    method: 'POST', headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
                    body, signal: AbortSignal.timeout(5000), redirect: 'error',
                });
                status = response.status;
                await response.body?.cancel().catch(() => {});
            } catch { healthy = false; break; }
            if (status >= 200 && status < 300) {
                let playing = false;
                try { playing = JSON.parse(body).state === 'playing'; } catch { /* malformed: dropped below */ }
                if (playing) { accepted.set(name, body); continue; }
                accepted.delete(name);
                await dropIfUnchanged(file, body);
            } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
                // Permanent rejection: retrying the same body can never succeed.
                console.warn(`Replay index: portal rejected ${name} (${status}); dropping it`);
                accepted.delete(name);
                await dropIfUnchanged(file, body);
            } else { healthy = false; break; }
        }
    } catch (e) {
        healthy = false;
        console.error('Replay index:', e);
    } finally {
        running = false;
    }
    failures = healthy ? 0 : failures + 1;
    const delay = healthy ? BASE_DELAY_MS : Math.min(BASE_DELAY_MS * 2 ** failures, MAX_DELAY_MS);
    retryAt = healthy ? 0 : Date.now() + delay;
    const again = healthy && rerun;
    rerun = false;
    if (again) void publish();
    else schedule(delay);
}
