/**
 * Browser-side analog of Java `com.aapeli.client.TextManager`. Loads
 * `/l10n/<lang>/AGolf.xml` (copied into `web/public/l10n/` by
 * `scripts/prepare-assets.mjs`), parses it once, and resolves keys via
 * `t(key, defaultEn, ...args)` with `%1`/`%2` substitution.
 *
 * Differences from Java:
 *  - Active locale falls back through EN before reaching `defaultEn`, so a
 *    half-translated locale still surfaces English instead of `{key}` when
 *    a key only lives in `en/AGolf.xml`. The Java client just returns
 *    `{key}` because it never overlays a fallback locale.
 *  - We treat keys as lowercase (matching Java's `.toLowerCase()` lookup).
 *  - The `reverse="yes"` attribute on BadNicks/BadWords is ignored - the
 *    port has no client-side moderation that consumes those lists.
 */
export type Lang = "en" | "fi" | "sv";

const STORAGE_KEY = "pmg.lang";
/** Site default. Finnish - the original Playforia game was a Finnish product
 *  and the user base of this port leans that way. EN remains the fallback
 *  overlay for any keys missing in the active locale. */
const DEFAULT_LANG: Lang = "fi";

function isLang(s: string | null): s is Lang {
  return s === "en" || s === "fi" || s === "sv";
}

/** Read the saved choice, or `en` if no saved choice / invalid value. */
export function loadSavedLang(): Lang {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (isLang(v)) return v;
  } catch {
    // localStorage may throw in private mode / sandboxed iframes - fall through.
  }
  return DEFAULT_LANG;
}

export function saveLang(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // noop
  }
}

class TextManager {
  /** Active-locale key→translation map. Always lowercase keys. */
  private active: Map<string, string> = new Map();
  /** EN overlay used as a fallback for missing keys in non-EN locales. */
  private fallback: Map<string, string> = new Map();
  private currentLang: Lang = DEFAULT_LANG;
  /** Cache parsed locales so a switch-back is instant. */
  private cache: Map<Lang, Map<string, string>> = new Map();
  /** In-flight fetches so concurrent `setLanguage` calls share a load. */
  private inflight: Map<Lang, Promise<Map<string, string>>> = new Map();

  /** Load EN as both active and fallback. Call once at app boot. */
  async init(): Promise<void> {
    const en = await this.loadLocale("en");
    this.fallback = en;
    this.active = en;
    this.currentLang = "en";
  }

  get language(): Lang {
    return this.currentLang;
  }

  /**
   * Switch the active locale. EN remains the fallback overlay. Safe to call
   * with `en` - it's a no-op since the active map is already EN.
   */
  async setLanguage(lang: Lang): Promise<void> {
    if (lang === this.currentLang) return;
    const map = await this.loadLocale(lang);
    this.active = map;
    this.currentLang = lang;
  }

  /**
   * Resolve a localised string.
   *   t("LobbyReal_Start", "Start training")
   *   t("LobbyChat_Join", "%1 joined the game", nick)
   *
   * Lookup order: active locale → EN fallback → `defaultEn` → `{key}`.
   * Substitutes `%1`, `%2`, … with the supplied positional args (only the
   * first occurrence is replaced per arg, matching Java `replaceFirst`).
   */
  t(key: string, defaultEn: string, ...args: Array<string | number>): string {
    const lower = key.toLowerCase();
    let template = this.active.get(lower);
    if (template === undefined) template = this.fallback.get(lower);
    if (template === undefined) template = defaultEn;
    if (template === undefined) template = `{${key}}`;
    if (args.length === 0) return template;
    let out = template;
    for (let i = 0; i < args.length; i++) {
      // String#replace with a string pattern only replaces the first match,
      // matching Java's replaceFirst - `%1` with "$2" must NOT eat the literal
      // "$2" the way `replace` with a string treats `$&` etc. when the
      // replacement is computed lazily, so we use a function to disable
      // pattern interpretation.
      const needle = "%" + (i + 1);
      const value = String(args[i]);
      out = out.replace(needle, () => value);
    }
    return out;
  }

  // ---- internals -------------------------------------------------------

  private loadLocale(lang: Lang): Promise<Map<string, string>> {
    const cached = this.cache.get(lang);
    if (cached) return Promise.resolve(cached);
    const inflight = this.inflight.get(lang);
    if (inflight) return inflight;
    const promise = this.fetchAndParse(lang).then((map) => {
      this.cache.set(lang, map);
      this.inflight.delete(lang);
      return map;
    }).catch((err) => {
      this.inflight.delete(lang);
      throw err;
    });
    this.inflight.set(lang, promise);
    return promise;
  }

  private async fetchAndParse(lang: Lang): Promise<Map<string, string>> {
    const url = `/l10n/${lang}/AGolf.xml`;
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) {
      throw new Error(`l10n fetch failed: ${url} (${res.status})`);
    }
    const text = await res.text();
    return parseAGolfXml(text);
  }
}

/**
 * Parse an `AGolf.xml` body into a key→string map. Keys are lowercased.
 * `<parsererror>` (the DOMParser failure marker) is treated as a hard error
 * - DOMParser doesn't throw on malformed XML, so we have to spot it ourselves.
 */
export function parseAGolfXml(text: string): Map<string, string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) {
    throw new Error(`l10n XML parse error: ${err.textContent ?? "?"}`);
  }
  const out = new Map<string, string>();
  const nodes = doc.getElementsByTagName("str");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i);
    if (!node) continue;
    const key = node.getAttribute("key");
    if (!key) continue;
    // Trim whitespace contributed by XML pretty-printing around the CDATA
    // section (`\n\t  CDATA\n\t`). Java DOM behaves the same here; their
    // strings only look right because the source XML happens to have the
    // CDATA flush against the tag in some entries - relying on that is
    // brittle, so we trim universally.
    const text = (node.textContent ?? "").trim();
    out.set(key.toLowerCase(), text);
  }
  return out;
}

/**
 * Singleton - created at module load so panels can import `t` directly
 * without threading the manager through every constructor. Boot order:
 *   1. main.ts calls `i18n.init()` (awaits) → EN loaded as active+fallback.
 *   2. Login panel kicks `i18n.setLanguage(<picked>)` on dropdown change.
 */
export const i18n = new TextManager();

/** Convenience proxy so call sites read `t("Key", "default")` directly. */
export function t(key: string, defaultEn: string, ...args: Array<string | number>): string {
  return i18n.t(key, defaultEn, ...args);
}
