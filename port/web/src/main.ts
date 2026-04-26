import { App } from "./app.ts";
import { readReplayFromHash } from "./daily.ts";
import { ReplayPanel } from "./panels/replay.ts";

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app root element");
}

// Replay viewer is a separate boot path — fully self-contained, no server
// connection. Triggered by `#replay=<base64url>` in the URL.
const replay = readReplayFromHash();
if (replay) {
  new ReplayPanel(replay).mount(root);
} else {
  new App(root).start();
}
