/**
 * Durable, observation-based match replays, compatible with games/replays/archive.py.
 *
 * Write model: every recorded perspective ("view") gets its own write capability,
 * a random 256-bit token handed only to the connection that owns that view. meta.json
 * stores only sha256 hashes per view (`writeHashes`, as in archive.py); a chunk PUT is accepted only when its token
 * matches the hash of the view encoded in the chunk name (`{view}-{seq}`).
 *
 * Disk limits (all overridable through the environment):
 *   AAPELI_REPLAY_END_GRACE_MS      120000      late uploads accepted after a match ends (else 409)
 *   AAPELI_REPLAY_MAX_AGE_MS        21600000    uploads rejected once a recording is 6 h old (409)
 *   AAPELI_REPLAY_MAX_VIEW_BYTES    48 MiB      compressed chunk + new asset bytes per view (413)
 *   AAPELI_REPLAY_MAX_CHUNKS        20000       chunks per recording (413)
 *   AAPELI_REPLAY_MAX_EVENT_BYTES   4 MiB       events.jsonl per recording (later events dropped)
 *   AAPELI_REPLAY_MAX_ASSET_BYTES   1 MiB       per PNG asset (413)
 *   AAPELI_REPLAY_MIN_FREE_BYTES    2 GiB       free-space floor on the archive filesystem (507)
 *   AAPELI_REPLAY_MAX_BYTES         10 GiB      total archive size (507)
 */
import { configureReplayIndex, queueReplayIndex } from './replay-profile-index.ts';
import type { PortalConfig } from './portal.ts';
import { atomicWrite, envLimit } from './replay-fs.ts';
import { access, appendFile, cp, link, lstat, mkdir, open, readdir, readFile, rename, statfs, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip, gunzip, crc32 } from 'node:zlib';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const root = process.env.AAPELI_NATIVE_REPLAY_DIR || fileURLToPath(new URL('../../../../replays/private/native/', import.meta.url));
const assets = fileURLToPath(new URL('../../../../replays/', import.meta.url));
const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const idRE = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/, chunkRE = /^([0-9]{1,5})-([0-9]{1,8})$/;
const MAX_VIEW = 99999;
const MAX_PUT_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const gzipAsync = promisify(gzip), gunzipAsync = promisify(gunzip);

export function replayLimits() {
    return {
        endGraceMs: envLimit('AAPELI_REPLAY_END_GRACE_MS', 120_000),
        maxAgeMs: envLimit('AAPELI_REPLAY_MAX_AGE_MS', 6 * 3600_000),
        maxViewBytes: envLimit('AAPELI_REPLAY_MAX_VIEW_BYTES', 48 * 1024 * 1024),
        maxChunks: envLimit('AAPELI_REPLAY_MAX_CHUNKS', 20_000),
        maxEventBytes: envLimit('AAPELI_REPLAY_MAX_EVENT_BYTES', 4 * 1024 * 1024),
        maxAssetBytes: envLimit('AAPELI_REPLAY_MAX_ASSET_BYTES', 1024 * 1024),
        minFreeBytes: envLimit('AAPELI_REPLAY_MIN_FREE_BYTES', 2 * 1024 * 1024 * 1024),
        maxTotalBytes: envLimit('AAPELI_REPLAY_MAX_BYTES', 10 * 1024 * 1024 * 1024),
    };
}

class HttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}

const simulationCommands = new Set('practiceballs toplist gameinfo player players owninfo join part start starttrack turn startturn beginstroke setwhiteball setpainted specball specdata specscore end changescore resetvoteskip voteskip readyfornewgame rfng timeout concede practicemode dailymode snapapply endstroke'.split(' '));
function validCommand(c: any): boolean {
    if (!c || !Number.isFinite(c.t) || c.t < 0 || c.t > 86400000 || typeof c.local !== 'boolean' || typeof c.packet !== 'string' || Buffer.byteLength(c.packet) > 32768 || /[\r\n\0]/.test(c.packet)) return false;
    const f = c.packet.split('\t');
    return f.length >= 2 && (f[0] === 'game' && simulationCommands.has(f[1]) || !c.local && (['basicinfo', 'coininfo'].includes(f[0]) || f[0] === 'status' && f[1] === 'game'));
}

/** Snapshot the built client once per process so old replays keep the engine that recorded them. */
let clientBuild: Promise<{ kind: string; build: string }> | null = null;
function snapshotClient(): Promise<{ kind: string; build: string }> {
    clientBuild ||= (async () => {
        const hash = createHash('sha256');
        const walk = async (folder: string): Promise<void> => {
            for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
                const file = path.join(folder, entry.name);
                if (entry.isDirectory()) await walk(file);
                else { hash.update(path.relative(dist, file)); hash.update(await readFile(file)); }
            }
        };
        await walk(dist);
        const build = hash.digest('hex');
        const target = path.join(root, 'clients', 'minigolf-native', build);
        if (!(await exists(target))) {
            await mkdir(path.dirname(target), { recursive: true });
            const tmp = target + '.' + randomBytes(8).toString('hex') + '.tmp';
            await cp(dist, tmp, { recursive: true });
            await rename(tmp, target);
        }
        return { kind: 'minigolf-native', build };
    })();
    clientBuild.catch(() => { clientBuild = null; });
    return clientBuild;
}

async function exists(file: string): Promise<boolean> {
    try { await access(file); return true; } catch { return false; }
}

// ---- Archive-wide capacity -------------------------------------------------

let archiveBytes: number | null = null, scanning = false, unscannedBytes = 0;
let freeCache: { at: number; free: number } | null = null;

function addArchiveBytes(n: number): void {
    if (archiveBytes === null) unscannedBytes += n; else archiveBytes += n;
}
/** Measure the archive once, in the background; later writes are tracked incrementally. */
function scanArchive(): void {
    if (scanning || archiveBytes !== null) return;
    scanning = true;
    void (async () => {
        let sum = 0;
        const walk = async (folder: string): Promise<void> => {
            let entries;
            try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const file = path.join(folder, entry.name);
                if (entry.isDirectory()) await walk(file);
                else if (entry.isFile()) { try { sum += (await lstat(file)).size; } catch { /* raced away */ } }
            }
        };
        await walk(root);
        // Writes during the scan may be counted twice; erring high is the safe side.
        archiveBytes = sum + unscannedBytes;
        unscannedBytes = 0;
    })().catch(e => console.error('Replay archive scan:', e)).finally(() => { scanning = false; });
}
async function freeBytes(): Promise<number> {
    if (freeCache && Date.now() - freeCache.at < 5000) return freeCache.free;
    const stats = await statfs(root);
    freeCache = { at: Date.now(), free: Number(stats.bavail) * Number(stats.bsize) };
    return freeCache.free;
}
async function reserveCapacity(bytes: number): Promise<void> {
    const limits = replayLimits();
    scanArchive();
    const known = archiveBytes ?? unscannedBytes;
    if (known + bytes > limits.maxTotalBytes) throw new HttpError(507, 'Replay storage unavailable');
    if ((await freeBytes()) - bytes < limits.minFreeBytes) throw new HttpError(507, 'Replay storage unavailable');
    if (freeCache) freeCache.free -= bytes;
}

// ---- Live recordings -------------------------------------------------------

/** The write capability for one view of one recording, held by the connection that owns the view. */
export interface MatchRecording { id: string; token: string; view: number; started: number; }

interface Live {
    id: string;
    started: number;
    ended: number | null;
    meta: Record<string, any>;
    /** Serialized disk work (meta, events, index) so writes land in order. */
    io: Promise<void>;
    /** Resolves once the recording directory and first meta.json exist. */
    ready: Promise<void>;
    /** Serializes chunk stores so accounting and conflict checks are exact. */
    puts: Promise<void>;
    failed: boolean;
    writers: Map<number, Buffer>;
    chunks: Set<string>;
    viewBytes: Map<number, number>;
    assets: Set<string>;
    eventBuffer: string[];
    eventBytes: number;
    eventFlushQueued: boolean;
    onError?: () => void;
}

const live = new Map<string, Live>();
/** Asset hashes known to exist on disk (assets are shared and content-addressed). */
const storedAssets = new Set<string>();
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const dirOf = (id: string) => path.join(root, id);

function enqueue(rec: Live, task: () => Promise<void>): Promise<void> {
    rec.io = rec.io.then(task).catch(e => {
        console.error('Replay storage:', e);
        if (!rec.failed) { rec.failed = true; rec.onError?.(); }
    });
    return rec.io;
}
function writeMeta(rec: Live): void {
    enqueue(rec, async () => {
        const body = JSON.stringify(rec.meta);
        await atomicWrite(path.join(dirOf(rec.id), 'meta.json'), body);
        addArchiveBytes(body.length);
    });
}
function indexMeta(rec: Live): void {
    const snapshot = structuredClone(rec.meta);
    // Index failures are logged but never stop the recording itself.
    enqueue(rec, () => queueReplayIndex(snapshot).catch(e => console.error('Replay index queue:', e)));
}

export function configureMatchReplayPortal(config: PortalConfig | null): void {
    configureReplayIndex(config, root, id => live.has(id));
}

/**
 * Start a recording for one connection. `view` is the server-known slot of the
 * recording player; only that view receives a write capability.
 */
export function createMatchRecording(players: string[], settings: Record<string, unknown>, owner?: string, view = 0, onError?: () => void): MatchRecording {
    if (!Number.isInteger(view) || view < 0 || view > MAX_VIEW) view = 0;
    const id = randomUUID(), started = Date.now();
    const meta = { v: 1, id, game: 'minigolf-native', players, settings, started, state: 'playing', writeHashes: {} as Record<string, string>, owners: owner ? { [owner]: view } : {} };
    const rec: Live = {
        id, started, ended: null, meta, io: Promise.resolve(), ready: Promise.resolve(), puts: Promise.resolve(), failed: false,
        writers: new Map(), chunks: new Set(), viewBytes: new Map(), assets: new Set(),
        eventBuffer: [], eventBytes: 0, eventFlushQueued: false, onError,
    };
    live.set(id, rec);
    enqueue(rec, async () => {
        await mkdir(dirOf(id), { recursive: true });
        await appendFile(path.join(dirOf(id), 'assets.list'), '');
    });
    const token = grantReplayView(id, view);
    rec.ready = rec.io;
    indexMeta(rec);
    const record = { id, token, view, started };
    // A recording nobody finishes (lost connection without a part) still closes at the age limit.
    setTimeout(() => finishMatchRecording(record, 'interrupted'), replayLimits().maxAgeMs).unref();
    return record;
}

/**
 * Issue a fresh write capability for `view`. Granting a view again replaces its
 * hash, revoking the previous token for that view.
 */
export function grantReplayView(id: string, view: number): string {
    const rec = live.get(id);
    if (!rec || rec.ended !== null) throw new Error('Recording is not active');
    if (!Number.isInteger(view) || view < 0 || view > MAX_VIEW) throw new Error('Invalid replay view');
    const token = randomBytes(32).toString('hex');
    const hash = digest(token);
    rec.writers.set(view, Buffer.from(hash, 'hex'));
    rec.meta.writeHashes[String(view)] = hash;
    writeMeta(rec);
    return token;
}

/** End a recording. Idempotent: only the first call changes state. */
export function finishMatchRecording(record: MatchRecording, state = 'completed', score?: Record<string, unknown>): void {
    const rec = live.get(record.id);
    if (!rec || rec.ended !== null) return;
    rec.ended = Date.now();
    flushEvents(rec);
    rec.meta = { ...rec.meta, state, ended: rec.ended, scores: score ? { [String(record.view)]: score } : rec.meta.scores };
    writeMeta(rec);
    indexMeta(rec);
    // Keep accepting late uploads for the grace period, then forget the recording.
    setTimeout(() => { if (live.get(rec.id) === rec) live.delete(rec.id); }, replayLimits().endGraceMs + 1000).unref();
}

const recorded = new Set(['start', 'starttrack', 'beginstroke', 'endstroke', 'end', 'startturn', 'turn', 'players', 'owninfo', 'join', 'part', 'snapapply', 'practicemode', 'dailymode']);
export function matchEvent(record: MatchRecording, body: string): void {
    const rec = live.get(record.id);
    if (!rec || rec.ended !== null) return;
    const fields = body.split('\t').slice(1);
    if (!recorded.has(fields[0])) return;
    const line = JSON.stringify({ t: Date.now(), fields }) + '\n';
    const size = Buffer.byteLength(line);
    if (rec.eventBytes + size > replayLimits().maxEventBytes) {
        if (!rec.meta.eventsTruncated) { rec.meta.eventsTruncated = true; writeMeta(rec); }
        return;
    }
    rec.eventBytes += size;
    rec.eventBuffer.push(line);
    if (!rec.eventFlushQueued) { rec.eventFlushQueued = true; setImmediate(() => flushEvents(rec)); }
}
function flushEvents(rec: Live): void {
    rec.eventFlushQueued = false;
    if (!rec.eventBuffer.length) return;
    const text = rec.eventBuffer.join('');
    rec.eventBuffer = [];
    enqueue(rec, async () => {
        await appendFile(path.join(dirOf(rec.id), 'events.jsonl'), text);
        addArchiveBytes(Buffer.byteLength(text));
    });
}

/** Resolve once all queued disk work has landed. Used by tests and graceful shutdown. */
export async function flushMatchReplays(): Promise<void> {
    for (const rec of live.values()) flushEvents(rec);
    await Promise.all([...live.values()].map(rec => Promise.all([rec.io, rec.puts])));
}

// ---- Chunk uploads ---------------------------------------------------------

/** Validate the full PNG chunk structure (lengths, CRC32, IHDR first, IDAT, IEND last). */
function parsePng(data: Buffer, sprite: boolean): void {
    if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new HttpError(400, 'invalid PNG');
    let offset = 8, index = 0, sawData = false, sawEnd = false;
    while (offset < data.length) {
        if (sawEnd || offset + 12 > data.length) throw new HttpError(400, 'invalid PNG');
        const length = data.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (length > 0x7fffffff || end > data.length) throw new HttpError(400, 'invalid PNG');
        const type = data.toString('latin1', offset + 4, offset + 8);
        if (!/^[A-Za-z]{4}$/.test(type)) throw new HttpError(400, 'invalid PNG');
        if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) throw new HttpError(400, 'invalid PNG CRC');
        if (index === 0) {
            if (type !== 'IHDR' || length !== 13) throw new HttpError(400, 'invalid PNG');
            const width = data.readUInt32BE(offset + 8), height = data.readUInt32BE(offset + 12);
            if (width < 1 || width > (sprite ? 64 : 1000) || height < 1 || height > (sprite ? 64 : 700)) throw new HttpError(400, 'invalid PNG dimensions');
        } else if (type === 'IHDR') throw new HttpError(400, 'invalid PNG');
        if (type === 'IDAT') sawData = true;
        if (type === 'IEND') { if (length !== 0) throw new HttpError(400, 'invalid PNG'); sawEnd = true; }
        offset = end;
        index++;
    }
    if (!sawEnd || !sawData) throw new HttpError(400, 'invalid PNG');
}
function decodeAsset(source: unknown, sprite: boolean): { hash: string; data: Buffer } {
    if (typeof source !== 'string' || !source.startsWith('data:image/png;base64,')) throw new HttpError(400, 'invalid asset');
    const encoded = source.slice('data:image/png;base64,'.length);
    if (encoded.length > Math.ceil(replayLimits().maxAssetBytes / 3) * 4 + 4) throw new HttpError(413, 'Replay size limit reached');
    const data = Buffer.from(encoded, 'base64');
    if (data.length > replayLimits().maxAssetBytes) throw new HttpError(413, 'Replay size limit reached');
    parsePng(data, sprite);
    return { hash: createHash('sha256').update(data).digest('hex'), data };
}

async function readChunk(id: string, name: string): Promise<Buffer> {
    const data = await readFile(path.join(dirOf(id), name + '.json'));
    return data[0] === 31 && data[1] === 139 ? await gunzipAsync(data) : data;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const buffers: Buffer[] = [];
        let total = 0;
        req.setTimeout(15000, () => { reject(new HttpError(408, 'timeout')); req.destroy(); });
        req.on('data', (b: Buffer) => {
            total += b.length;
            if (total > MAX_PUT_BYTES) { reject(new HttpError(413, 'Replay size limit reached')); req.pause(); }
            else buffers.push(b);
        });
        req.on('end', () => resolve(Buffer.concat(buffers)));
        req.on('error', reject);
        req.on('close', () => reject(new HttpError(400, 'aborted')));
    });
}

async function storeChunk(req: IncomingMessage, id: string, name: string, view: number): Promise<void> {
    const rec = live.get(id);
    if (!rec) {
        if (await exists(path.join(dirOf(id), 'meta.json'))) throw new HttpError(409, 'Recording closed');
        throw new HttpError(404, 'Replay not found');
    }
    const limits = replayLimits(), now = Date.now();
    if (rec.ended !== null && now - rec.ended > limits.endGraceMs) throw new HttpError(409, 'Recording closed');
    if (now - rec.started > limits.maxAgeMs) throw new HttpError(409, 'Recording closed');
    const expected = rec.writers.get(view);
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!expected || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(digest(token), 'hex'), expected)) throw new HttpError(403, 'Forbidden');
    if (rec.failed) throw new HttpError(507, 'Replay storage unavailable');
    const raw = await readBody(req);
    await rec.ready;
    if (rec.failed) throw new HttpError(507, 'Replay storage unavailable');
    // One store at a time per recording keeps counters and conflict checks exact.
    const run = rec.puts.then(() => storeValidated(rec, name, view, raw));
    rec.puts = run.catch(() => {});
    await run;
}

async function storeValidated(rec: Live, name: string, view: number, raw: Buffer): Promise<void> {
    const limits = replayLimits();
    let chunk: any;
    try { chunk = JSON.parse(raw.toString()); } catch { throw new HttpError(400, 'invalid JSON'); }
    if (!chunk || typeof chunk !== 'object') throw new HttpError(400, 'invalid');
    const commands = chunk.commands || [];
    if (!Array.isArray(commands) || commands.length > 1000 || commands.some((c: unknown) => !validCommand(c))) throw new HttpError(400, 'invalid commands');
    if (!Array.isArray(chunk.frames) || (!chunk.frames.length && !commands.length) || chunk.frames.length > 1000) throw new HttpError(400, 'invalid');
    for (const f of chunk.frames) {
        if (!f || !Number.isFinite(f.t) || f.t < 0 || f.t > 86400000 || !Array.isArray(f.balls) || f.balls.length > 256) throw new HttpError(400, 'invalid');
        if (f.sprites !== undefined && (!Array.isArray(f.sprites) || f.sprites.length > 64)) throw new HttpError(400, 'invalid');
    }
    if (chunk.engine) {
        const engine = chunk.engine;
        if (engine.kind !== 'minigolf-native' || typeof engine.build !== 'string' || !/^[a-f0-9]{64}$/.test(engine.build)
            || (rec.meta.engine && JSON.stringify(rec.meta.engine) !== JSON.stringify({ kind: engine.kind, build: engine.build }))
            || !(await exists(path.join(root, 'clients', 'minigolf-native', engine.build)))) throw new HttpError(400, 'invalid client');
        chunk.engine = { kind: engine.kind, build: engine.build };
    }
    // Decode and validate every image before anything touches the disk.
    const pending = new Map<string, Buffer>();
    const store = (source: unknown, sprite: boolean): string => {
        const { hash, data } = decodeAsset(source, sprite);
        pending.set(hash, data);
        return `/api/replays/${rec.id}/assets/${hash}`;
    };
    for (const f of chunk.frames) {
        if (f.background) f.background = store(f.background, false);
        if (f.sprites) f.sprites = f.sprites.map((s: unknown) => store(s, true));
    }
    const body = Buffer.from(JSON.stringify(chunk));
    if (rec.chunks.has(name)) {
        // Retried upload: identical content is fine, anything else is a conflict.
        if (!(await readChunk(rec.id, name)).equals(body)) throw new HttpError(400, 'chunk conflict');
        return;
    }
    if (rec.chunks.size >= limits.maxChunks) throw new HttpError(413, 'Replay size limit reached');
    const packed = await gzipAsync(body);
    const fresh: [string, Buffer][] = [];
    for (const [hash, data] of pending) {
        if (storedAssets.has(hash)) continue;
        if (await exists(path.join(root, 'assets', hash + '.png'))) { storedAssets.add(hash); continue; }
        fresh.push([hash, data]);
    }
    const needed = packed.length + fresh.reduce((sum, [, data]) => sum + data.length, 0);
    if ((rec.viewBytes.get(view) ?? 0) + needed > limits.maxViewBytes) throw new HttpError(413, 'Replay size limit reached');
    await reserveCapacity(needed);
    if (fresh.length) await mkdir(path.join(root, 'assets'), { recursive: true });
    for (const [hash, data] of fresh) {
        await atomicWrite(path.join(root, 'assets', hash + '.png'), data);
        storedAssets.add(hash);
    }
    const newAssets = [...pending.keys()].filter(hash => !rec.assets.has(hash));
    if (newAssets.length) {
        await appendFile(path.join(dirOf(rec.id), 'assets.list'), newAssets.map(h => h + '\n').join(''));
        for (const hash of newAssets) rec.assets.add(hash);
    }
    const file = path.join(dirOf(rec.id), name + '.json');
    const tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    const handle = await open(tmp, 'wx');
    try { await handle.writeFile(packed); await handle.sync(); } finally { await handle.close(); }
    try { await link(tmp, file); } finally { await unlink(tmp).catch(() => {}); }
    rec.chunks.add(name);
    rec.viewBytes.set(view, (rec.viewBytes.get(view) ?? 0) + needed);
    addArchiveBytes(needed);
    if (chunk.engine && !rec.meta.engine) { rec.meta.engine = chunk.engine; writeMeta(rec); await rec.io; }
}

// ---- Reads -----------------------------------------------------------------

async function metadata(id: string): Promise<Record<string, any>> {
    if (!idRE.test(id)) throw new HttpError(404, 'not-found');
    const rec = live.get(id);
    if (rec) return structuredClone(rec.meta);
    return JSON.parse(await readFile(path.join(dirOf(id), 'meta.json'), 'utf8'));
}

async function streamTimeline(id: string, view: string, res: ServerResponse, head: boolean): Promise<void> {
    const names = (await readdir(dirOf(id))).filter(x => chunkRE.test(x.replace(/\.json$/, '')) && x.endsWith('.json') && x.startsWith(view + '-'))
        .sort((a, b) => Number(a.split('-')[1].split('.')[0]) - Number(b.split('-')[1].split('.')[0]));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (!head) for (const name of names) {
        if (res.destroyed) break;
        const packed = await readFile(path.join(dirOf(id), name));
        const data = packed[0] === 31 && packed[1] === 139 ? await gunzipAsync(packed) : packed;
        if (!res.write(Buffer.concat([data, Buffer.from('\n')]))) {
            await new Promise<void>(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); });
        }
    }
    res.end();
}

/** Assets are content-addressed and shared; a recording may only serve the ones it stored. */
async function recordingHasAsset(id: string, hash: string): Promise<boolean> {
    const rec = live.get(id);
    if (rec) return rec.assets.has(hash);
    let list: string;
    try { list = await readFile(path.join(dirOf(id), 'assets.list'), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; } // recorded before scoping existed
    return list.split('\n').includes(hash);
}

const viewerFiles = ['/replays', '/replays/', '/replays/embed', '/replay-recorder.js', '/replay-viewer.js', '/replay-language.js', '/client-replay.js', '/replay-client.json', '/replays.css'];
const clientMime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.xml': 'application/xml', '.json': 'application/json' };

export function handleMatchReplayApi(req: IncomingMessage, res: ServerResponse): boolean {
    const p = new URL(req.url || '/', 'http://localhost').pathname;
    if (!p.startsWith('/api/replays/') && !viewerFiles.includes(p)) return false;
    const respond = (code: number, body: string | Buffer, mime = 'application/json') => {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(code, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : body);
    };
    routeReplayRequest(req, res, p, respond).catch(e => {
        const status = e instanceof HttpError ? e.status : (e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : (e as NodeJS.ErrnoException).code === 'ENOSPC' ? 507 : 500;
        if (!(e instanceof HttpError) && status === 500) console.error('Replay request:', e);
        const message = e instanceof HttpError ? e.message : status === 507 ? 'Replay storage unavailable' : req.method === 'PUT' ? 'Replay write failed' : 'Replay unavailable';
        respond(status, JSON.stringify({ error: message }));
        if (req.method === 'PUT' && !req.complete) req.resume();
    });
    return true;
}

async function routeReplayRequest(req: IncomingMessage, res: ServerResponse, p: string, respond: (code: number, body: string | Buffer, mime?: string) => void): Promise<void> {
    const readOnly = ['GET', 'HEAD'].includes(req.method || '');
    if (p === '/replay-client.json' && readOnly) { respond(200, JSON.stringify(await snapshotClient())); return; }
    if (!p.startsWith('/api/replays/')) {
        if (!readOnly) { respond(404, '{}'); return; }
        const name = p === '/replays/embed' ? 'embed.html' : ['/replays', '/replays/'].includes(p) ? 'viewer.html' : p.slice(1);
        const file = p === '/replays.css' ? path.resolve(assets, '../../web/replays.css') : path.join(assets, name);
        respond(200, await readFile(file), name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        return;
    }
    const [id, name, ...rest] = p.slice('/api/replays/'.length).split('/');
    if (!idRE.test(id)) { respond(404, '{}'); return; }
    if (name === 'client' && rest.length && rest.every(x => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(x)) && readOnly) {
        const engine = (await metadata(id)).engine as { kind: string; build: string } | undefined;
        if (!engine || !/^[a-z-]+$/.test(engine.kind) || !/^[a-f0-9]{64}$/.test(engine.build)) { respond(404, '{}'); return; }
        const file = path.join(root, 'clients', engine.kind, engine.build, ...rest);
        const ext = path.extname(file), mime = clientMime[ext];
        if (!mime) { respond(404, '{}'); return; }
        let body = await readFile(file);
        const prefix = '/api/replays/' + id + '/client';
        if (ext === '.html') body = Buffer.from(body.toString().replace(/(src|href)="\/(?!replay-language|replay-recorder|client-replay)/g, '$1="' + prefix + '/'));
        if (ext === '.css') body = Buffer.from(body.toString().replace(/([("'])\/picture\//g, '$1' + prefix + '/picture/'));
        respond(200, body, mime);
        return;
    }
    if (name === 'timeline' && rest.length === 1 && /^[0-9]{1,5}$/.test(rest[0]) && readOnly) {
        await metadata(id);
        await streamTimeline(id, rest[0], res, req.method === 'HEAD').catch(() => res.destroy());
        return;
    }
    if (name === 'assets' && rest.length === 1 && /^[a-f0-9]{64}$/.test(rest[0]) && readOnly) {
        await metadata(id);
        if (!(await recordingHasAsset(id, rest[0]))) { respond(404, '{}'); return; }
        respond(200, await readFile(path.join(root, 'assets', rest[0] + '.png')), 'image/png');
        return;
    }
    const match = name ? chunkRE.exec(name) : null;
    if (rest.length || (name && !match)) { respond(404, '{}'); return; }
    if (req.method === 'PUT' && match) {
        await storeChunk(req, id, name, Number(match[1]));
        respond(200, '{"saved":true}');
        return;
    }
    if (!readOnly) { respond(404, '{}'); return; }
    if (name) { respond(200, await readChunk(id, name)); return; }
    const meta = await metadata(id);
    delete meta.writeHashes; delete meta.writeHash; delete meta.owners;
    const rec = live.get(id);
    if (meta.state === 'playing' && !rec) meta.state = 'interrupted';
    meta.chunks = rec ? [...rec.chunks].sort() : (await readdir(dirOf(id))).filter(x => x.endsWith('.json') && chunkRE.test(x.slice(0, -5))).map(x => x.slice(0, -5)).sort();
    respond(200, JSON.stringify(meta));
}
