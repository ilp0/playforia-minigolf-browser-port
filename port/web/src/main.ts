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

async function boot(): Promise<void> {
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
