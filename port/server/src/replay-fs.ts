/** Small async filesystem helpers shared by the replay archive modules. */
import { open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/** Write `body` to `file` atomically: temp file, fsync, rename. Never blocks the event loop. */
export async function atomicWrite(file: string, body: string | Buffer): Promise<void> {
    const tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    const handle = await open(tmp, 'wx');
    try {
        await handle.writeFile(body);
        await handle.sync();
    } catch (e) {
        await handle.close().catch(() => {});
        await unlink(tmp).catch(() => {});
        throw e;
    }
    await handle.close();
    try { await rename(tmp, file); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}

/** Read an integer limit from the environment, falling back to `fallback` when unset or invalid. */
export function envLimit(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
