// Optional Aapeli portal integration. The server advertises it through
// `GET /api/portal-config`; standalone servers answer 404 and the client
// keeps its guest-nickname login.

export interface PortalProfile {
  nickname: string;
  username: string | null;
}

export class PortalClient {
  readonly api: string;
  readonly game: string;
  profile: PortalProfile | null = null;
  private csrfToken = "";
  private readonly sessionId = newSessionId();

  constructor(api: string, game: string) {
    this.api = api;
    this.game = game;
  }

  get registered(): boolean {
    return this.profile?.username != null;
  }

  async refreshSession(): Promise<PortalProfile> {
    const res = await fetch(`${this.api}/session`, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`portal session ${res.status}`);
    const body = (await res.json()) as { profile: PortalProfile; csrfToken: string };
    this.profile = { nickname: body.profile.nickname, username: body.profile.username ?? null };
    this.csrfToken = body.csrfToken;
    return this.profile;
  }

  /** Signed identity ticket for one WebSocket connection (valid 15 min). */
  async ticket(): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.csrfToken || attempt > 0) await this.refreshSession();
      const res = await fetch(`${this.api}/game-ticket`, {
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
    await this.refreshSession();
    return `${base}?ticket=${encodeURIComponent(await this.ticket())}`;
  }
}

export async function loadPortal(): Promise<PortalClient | null> {
  let config: { api?: unknown; game?: unknown };
  try {
    const res = await fetch("/api/portal-config", { cache: "no-store" });
    if (!res.ok) return null;
    config = await res.json();
  } catch {
    return null;
  }
  if (typeof config.api !== "string" || typeof config.game !== "string") return null;
  const portal = new PortalClient(config.api, config.game);
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
