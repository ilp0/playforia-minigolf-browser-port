import { App } from "./app.ts";
import { fetchReplayById, readReplayFromHash, readReplayIdFromQuery, type DailyReplay } from "./daily.ts";
import { ReplayPanel } from "./panels/replay.ts";

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
  new ReplayPanel(replay).mount(root);
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
