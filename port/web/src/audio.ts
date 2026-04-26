/**
 * Sound effects manager — port of `com.aapeli.client.SoundManager`.
 *
 * The original Java client ships eight `.au` clips under
 * `client/src/main/resources/sound/shared/`. `port/scripts/prepare-assets.mjs`
 * transcodes them to WAV (browsers don't decode Sun .au natively) and writes
 * the result to `port/web/public/sound/shared/`.
 *
 * Triggers (mirrors original):
 *   - playNotify    : game session begins (on `gameinfo`)
 *   - playGameMove  : every stroke (on `beginstroke` broadcast — local & remote)
 *   - playGameWinner/Loser/Draw : end-of-game outcome for the local player
 *
 * The On/Off preference is wired to the existing "Audio: On/Off" dropdown on
 * the lobby-select panel and persisted to localStorage so it survives reloads.
 *
 * Implementation: WebAudio with a single AudioContext + decoded AudioBuffers.
 * Each play creates a fresh BufferSource, so overlapping shots layer correctly
 * (HTMLAudio can't replay while already playing). Lazy decode on first play —
 * we don't pay the network/decode cost until something actually fires, and we
 * never trigger the autoplay-policy gate before a user gesture (the very first
 * sound is a click-driven shot).
 */
export type SoundKey =
  | "challenge"
  | "gamemove"
  | "notify"
  | "illegal"
  | "timelow"
  | "game-winner"
  | "game-loser"
  | "game-draw";

const FILES: Record<SoundKey, string> = {
  "challenge": "/sound/shared/challenge.wav",
  "gamemove": "/sound/shared/gamemove.wav",
  "notify": "/sound/shared/notify.wav",
  "illegal": "/sound/shared/illegal.wav",
  "timelow": "/sound/shared/timelow.wav",
  "game-winner": "/sound/shared/game-winner.wav",
  "game-loser": "/sound/shared/game-loser.wav",
  "game-draw": "/sound/shared/game-draw.wav",
};

const STORAGE_KEY = "minigolf.audio.enabled";

class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<SoundKey, AudioBuffer>();
  private loading = new Map<SoundKey, Promise<AudioBuffer | null>>();
  private _enabled: boolean;

  constructor() {
    let saved: string | null = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
    this._enabled = saved !== "0";
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(v: boolean): void {
    this._enabled = v;
    try { localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); } catch { /* private mode */ }
  }

  // --- public play methods (names mirror SoundManager.java) -----------------
  playChallenge(): void { this.play("challenge"); }
  playGameMove(): void { this.play("gamemove"); }
  playNotify(): void { this.play("notify"); }
  playIllegal(): void { this.play("illegal"); }
  playTimeLow(): void { this.play("timelow"); }
  playGameWinner(): void { this.play("game-winner"); }
  playGameLoser(): void { this.play("game-loser"); }
  playGameDraw(): void { this.play("game-draw"); }

  // --- internals -----------------------------------------------------------

  private play(key: SoundKey): void {
    if (!this._enabled) return;
    const ctx = this.getContext();
    if (!ctx) return;
    const cached = this.buffers.get(key);
    if (cached) {
      this.fire(ctx, cached);
      return;
    }
    void this.ensureBuffer(key, ctx).then((buf) => {
      // Re-check enabled — the user may have toggled off during the fetch.
      if (!buf || !this._enabled) return;
      this.fire(ctx, buf);
    });
  }

  private fire(ctx: AudioContext, buf: AudioBuffer): void {
    if (ctx.state === "suspended") {
      // Autoplay-policy guard. resume() returns a promise — fire-and-forget;
      // the very first user click on canvas (which triggers the first shot
      // sound) is itself the gesture that authorises this resume.
      void ctx.resume();
    }
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    } catch {
      // BufferSource.start() throws if the context is closed. Nothing to do.
    }
  }

  private getContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    // Safari historically only exposed `webkitAudioContext`; modern Safari has
    // the standard `AudioContext` so this fallback is defensive but cheap.
    const Ctor: typeof AudioContext | undefined =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    return this.ctx;
  }

  private ensureBuffer(key: SoundKey, ctx: AudioContext): Promise<AudioBuffer | null> {
    const inflight = this.loading.get(key);
    if (inflight) return inflight;
    const url = FILES[key];
    const p = (async (): Promise<AudioBuffer | null> => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const bytes = await r.arrayBuffer();
        // Some browsers (Safari) only support callback-style decodeAudioData,
        // but the promise overload is widely available now and is the spec.
        const buf = await ctx.decodeAudioData(bytes);
        this.buffers.set(key, buf);
        return buf;
      } catch {
        return null;
      } finally {
        this.loading.delete(key);
      }
    })();
    this.loading.set(key, p);
    return p;
  }
}

/** Process-wide singleton. Panels import and call directly. */
export const audio = new AudioManager();
