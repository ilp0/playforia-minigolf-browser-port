import { App } from "./app.ts";
import { readReplayFromHash } from "./daily.ts";
import { ReplayPanel } from "./panels/replay.ts";
import { i18n, loadSavedLang } from "./i18n.ts";

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app root element");
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

  // Replay viewer is a separate boot path — fully self-contained, no server
  // connection. Triggered by `#replay=<base64url>` in the URL.
  const replay = readReplayFromHash();
  if (replay) {
    new ReplayPanel(replay).mount(root);
  } else {
    new App(root).start();
  }
}

void boot();
