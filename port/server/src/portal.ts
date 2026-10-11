// Optional Aapeli portal integration (https://aapeli.0m.fi). Disabled unless
// the operator passes `--portal-key-file`; the standalone deployment never
// enables it, so its handshake and behaviour stay unchanged.
//
// When enabled:
//   - every WebSocket upgrade must carry `?ticket=<portal game ticket>`, an
//     HMAC-signed identity the portal issues to the browser session;
//   - the ticket's nickname replaces the client-sent `nick`;
//   - finished Daily Cup runs of registered accounts are reported to the
//     portal's `/internal/daily-result` endpoint, which stores them per account.

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export interface PortalConfig {
    key: string;
    /** Portal base for backend calls, e.g. http://library-portal:8000. */
    internalUrl: string;
    /** Browser-facing portal API base, e.g. https://aapeli.0m.fi/api. */
    publicApi: string;
    /** Game name the portal knows this server as. */
    game: string;
}

export interface PortalIdentity {
    profileId: string;
    sessionId: string;
    registered: boolean;
    accountId: string | null;
    username: string | null;
    nickname: string;
}

export type DailyRecordStatus = "saved" | "duplicate" | "guest" | "error";

export interface DailyRecord {
    date: string;
    strokes: number;
    holed: boolean;
    track: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[A-Za-z0-9_]{2,24}$/;
const MAX_TICKET_LIFETIME_S = 905;
const REQUEST_TIMEOUT_MS = 5_000;

export function loadPortalConfig(opts: {
    keyFile: string;
    internalUrl: string;
    publicApi: string;
    game: string;
}): PortalConfig {
    const key = readFileSync(opts.keyFile, "ascii").trim();
    if (key.length < 16 || key.length > 256) throw new Error("portal key must be 16-256 characters");
    const internal = new URL(opts.internalUrl);
    const publicApi = new URL(opts.publicApi);
    if (!/^https?:$/.test(internal.protocol) || !/^https?:$/.test(publicApi.protocol)) {
        throw new Error("portal URLs must be http(s)");
    }
    if (!/^[a-z0-9-]{1,32}$/.test(opts.game)) throw new Error("invalid portal game name");
    return {
        key,
        internalUrl: internal.href.replace(/\/$/, ""),
        publicApi: publicApi.href.replace(/\/$/, ""),
        game: opts.game,
    };
}

function sign(key: string, encoded: string): string {
    return createHmac("sha256", key).update(encoded).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** Mirrors the portal's ticket issuance and tools/telemetry.py verify_ticket. */
export function verifyTicket(
    cfg: PortalConfig,
    token: string | null,
    nowMs: number = Date.now(),
): PortalIdentity | null {
    if (typeof token !== "string" || token.length > 2048) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encoded, mac] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !safeEqual(mac, sign(cfg.key, encoded))) return null;
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const now = nowMs / 1000;
    const exp = payload.exp;
    if (!Number.isInteger(exp) || !(now < (exp as number) && (exp as number) <= now + MAX_TICKET_LIFETIME_S)) return null;
    if (payload.v !== 2 || payload.purpose !== "game-identity" || payload.game !== cfg.game) return null;
    if (typeof payload.profileId !== "string" || !UUID_RE.test(payload.profileId)) return null;
    if (typeof payload.sessionId !== "string" || !UUID_RE.test(payload.sessionId)) return null;
    if (typeof payload.registered !== "boolean") return null;
    if (payload.registered) {
        if (typeof payload.username !== "string" || !USERNAME_RE.test(payload.username)) return null;
        if (typeof payload.accountId !== "string" || !UUID_RE.test(payload.accountId)) return null;
    } else if (payload.username != null || payload.accountId != null) {
        return null;
    }
    const nickname = sanitizeNick(payload.nickname);
    if (!nickname) return null;
    return {
        profileId: payload.profileId,
        sessionId: payload.sessionId,
        registered: payload.registered,
        accountId: payload.registered ? (payload.accountId as string) : null,
        username: payload.registered ? (payload.username as string) : null,
        nickname,
    };
}

/** Same rules as the `nick` packet handler: no framing or record separators. */
export function sanitizeNick(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/[\r\n\t^:]+/g, " ").trim().slice(0, 20);
    return cleaned || null;
}

export async function recordDailyResult(
    cfg: PortalConfig,
    identity: PortalIdentity,
    record: DailyRecord,
): Promise<DailyRecordStatus> {
    if (!identity.registered) return "guest";
    try {
        const res = await fetch(`${cfg.internalUrl}/internal/daily-result`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: { "Authorization": `Bearer ${cfg.key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                game: cfg.game,
                profileId: identity.profileId,
                date: record.date,
                strokes: record.strokes,
                holed: record.holed,
                track: record.track.slice(0, 64),
            }),
        });
        if (!res.ok) return "error";
        const body = (await res.json()) as { saved?: unknown };
        return body.saved === true ? "saved" : "duplicate";
    } catch {
        return "error";
    }
}
