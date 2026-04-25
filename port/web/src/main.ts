import { App } from "./app.ts";

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app root element");
}
new App(root).start();
