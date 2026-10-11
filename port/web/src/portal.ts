// Optional Aapeli portal integration. The server advertises it through
// `GET /api/portal-config`; standalone servers answer 404 and the client
// keeps its guest-nickname login.

export interface PortalProfile {
  nickname: string;
  username: string | null;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
/** A fresh session is reused for the first socket instead of fetched twice. */
const SESSION_REUSE_MS = 30_000;

/** Retries rate-limited (429), unavailable (5xx) and network failures. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status !== 429 && res.status < 500) || attempt >= RETRY_DELAYS_MS.length) return res;
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}

export class PortalClient {
  readonly api: string;
  readonly game: string;
  /** Page that replay share links point to, if the host provides one. */
  readonly shareUrl: string | null;
  profile: PortalProfile | null = null;
  private csrfToken = "";
  private sessionAt = 0;
  private readonly sessionId = newSessionId();

  constructor(api: string, game: string, shareUrl: string | null = null) {
    this.api = api;
    this.game = game;
    this.shareUrl = shareUrl;
  }

  get registered(): boolean {
    return this.profile?.username != null;
  }

  async refreshSession(): Promise<PortalProfile> {
    const res = await fetchWithRetry(`${this.api}/session`, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`portal session ${res.status}`);
    const body = (await res.json()) as { profile: PortalProfile; csrfToken: string };
    this.profile = { nickname: body.profile.nickname, username: body.profile.username ?? null };
    this.csrfToken = body.csrfToken;
    this.sessionAt = Date.now();
    return this.profile;
  }

  /** Signed identity ticket for one WebSocket connection (valid 15 min). */
  async ticket(): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.csrfToken || attempt > 0) await this.refreshSession();
      const res = await fetchWithRetry(`${this.api}/game-ticket`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": this.csrfToken },
        body: JSON.stringify({ game: this.game, sessionId: this.sessionId }),
      });
      if (res.ok) return ((await res.json()) as { ticket: string }).ticket;
      if (res.status !== 403 && res.status !== 401) throw new Error(`portal ticket ${res.status}`);
    }
    throw new Error("portal ticket refused");
  }

  async socketUrl(base: string): Promise<string> {
    // Pick up nickname/login changes made on the portal since the last connect.
    if (Date.now() - this.sessionAt > SESSION_REUSE_MS) await this.refreshSession();
    return `${base}?ticket=${encodeURIComponent(await this.ticket())}`;
  }
}

export async function loadPortal(): Promise<PortalClient | null> {
  let config: { api?: unknown; game?: unknown; shareUrl?: unknown };
  try {
    const res = await fetch("/api/portal-config", { cache: "no-store" });
    if (!res.ok) return null;
    config = await res.json();
  } catch {
    return null;
  }
  if (typeof config.api !== "string" || typeof config.game !== "string") return null;
  const portal = new PortalClient(config.api, config.game, typeof config.shareUrl === "string" ? config.shareUrl : null);
  try {
    await portal.refreshSession();
  } catch (err) {
    console.warn("[portal] session unavailable", err);
  }
  return portal;
}

function newSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
