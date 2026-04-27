import { App } from "./app.ts";
import { fetchReplayById, readReplayFromHash, readReplayIdFromQuery, type DailyReplay } from "./daily.ts";
import { ReplayPanel } from "./panels/replay.ts";
import { i18n, loadSavedLang } from "./i18n.ts";

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app root element");
}

/**
 * Boot routing:
 *   ?r=<id>             — short link backed by server-side storage. Async fetch.
 *   #replay=<base64url> — legacy/fallback self-contained link.
 *   (neither)           — normal app boot.
 *
 * The replay viewer is fully self-contained — no WebSocket, no App
 * scaffolding — so we mount it directly into root.
 */
function showLoadingShim(message: string): void {
  if (!root) return;
  root.innerHTML = "";
  const div = document.createElement("div");
  div.className = "panel-loading";
  const h = document.createElement("h1");
  h.textContent = message;
  div.appendChild(h);
  root.appendChild(div);
}

function showError(message: string): void {
  if (!root) return;
  root.innerHTML = "";
  const div = document.createElement("div");
  div.className = "panel-loading";
  const h = document.createElement("h1");
  h.textContent = message;
  div.appendChild(h);
  root.appendChild(div);
}

function mountReplay(replay: DailyReplay): void {
  if (!root) return;
  // Drop the loading shim before mounting — its `.panel-loading` div is
  // 100% width/height with a green background, so without this the replay
  // canvas is rendered underneath an opaque "Loading replay…" cover and
  // the user sees the loading message forever.
  root.innerHTML = "";
  new ReplayPanel(replay).mount(root);
}

/**
 * Update the `--mobile-scale` CSS variable so the landscape-touch media query
 * can apply `transform: scale(var(--mobile-scale))` to #app. CSS `scale()`
 * requires a unitless number; `min(100vw/735, 100vh/525)` resolves to a
 * length and silently fails to parse, so the scale factor has to be computed
 * in JS. Idempotent and cheap; safe to run on resize/orientation change.
 *
 * Uses `visualViewport.height` when available so the scale tracks the
 * shrinking viewport when iOS Safari's address bar is shown — otherwise the
 * game would be sized for the full viewport and the bottom UI would sit
 * underneath the bar.
 */
function setupMobileScale(): void {
  const APP_W = 735;
  const APP_H = 525;
  const update = () => {
    const w = window.visualViewport?.width ?? window.innerWidth;
    const h = window.visualViewport?.height ?? window.innerHeight;
    const scale = Math.min(w / APP_W, h / APP_H);
    document.documentElement.style.setProperty("--mobile-scale", String(scale));
  };
  update();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  // visualViewport fires on bar show/hide and on virtual-keyboard open
  // events — without this, scale stays sized for the *initial* viewport.
  window.visualViewport?.addEventListener("resize", update);
}

/**
 * Wire the touch-only fullscreen gate. The HTML markup carries a
 * `#fullscreen-prompt` overlay that CSS reveals on touch-primary landscape
 * unless `body.is-fullscreen` is set. Tapping the button calls
 * `requestFullscreen()` inside the user-gesture window, and the body class
 * is toggled from a `fullscreenchange` listener so the gate auto-reappears
 * when the user exits (Esc, system gesture). Browsers without the API
 * (older iOS Safari) just dismiss the gate on tap so the user isn't locked
 * out — the game still plays, with the address bar covering the bottom.
 */
function setupFullscreenGate(): void {
  const button = document.getElementById("fullscreen-prompt__button");
  if (!button) return;

  const supportsFullscreen =
    typeof document.documentElement.requestFullscreen === "function" ||
    // Safari prefix — kept for compatibility with iOS < 16.4 where the
    // standard API was missing entirely. Nothing else uses this name.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (document.documentElement as any).webkitRequestFullscreen === "function";

  const sync = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el: Element | null = document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;
    document.body.classList.toggle("is-fullscreen", el !== null);
  };
  sync();

  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync);

  button.addEventListener("click", async () => {
    if (!supportsFullscreen) {
      // Graceful degradation — flag the body so the gate hides for the rest
      // of the session. Address-bar handling falls back to dvh-driven
      // resizing, which is good enough on devices without the API.
      document.body.classList.add("is-fullscreen");
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = document.documentElement as any;
      const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
      await req.call(el);
    } catch (err) {
      console.warn("[fullscreen] requestFullscreen failed:", err);
      // Still hide the gate so the user isn't stuck — they can play, just
      // not in true fullscreen.
      document.body.classList.add("is-fullscreen");
    }
  });
}

async function boot(): Promise<void> {
  setupMobileScale();
  setupFullscreenGate();
  // Load EN first so every panel that mounts can already resolve
  // `t("Key", "default")`. If EN fails to load (e.g. assets weren't prepared),
  // panels still fall back to the inline English defaults — they just don't
  // get the prettier wording from the XML.
  try {
    await i18n.init();
  } catch (err) {
    console.warn("[i18n] init failed; using inline defaults", err);
  }

  // Apply the saved-language preference up front so a returning visitor sees
  // their previous locale immediately on the login screen.
  const saved = loadSavedLang();
  if (saved !== "en") {
    try {
      await i18n.setLanguage(saved);
    } catch (err) {
      console.warn("[i18n] saved language failed to load", err);
    }
  }

  const id = readReplayIdFromQuery();
  if (id) {
    showLoadingShim("Loading replay…");
    void fetchReplayById(id)
      .then((r) => {
        if (r) mountReplay(r);
        else showError("Replay expired or not found.");
      })
      .catch(() => showError("Replay failed to load."));
  } else {
    const embedded = readReplayFromHash();
    if (embedded) {
      mountReplay(embedded);
    } else {
      new App(root).start();
    }
  }
}

void boot();
