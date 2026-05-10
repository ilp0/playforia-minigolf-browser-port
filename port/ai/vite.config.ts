import { defineConfig } from "vite";
import path from "node:path";
import { autoresearchPlugin } from "./vite-plugin-autoresearch.ts";

// Reuse the web client's already-prepared atlas/sprite assets so we don't
// double-store them. Run `npm run assets` from port/ once; both apps then
// see the same /picture/agolf/*.gif paths.
const PUBLIC_DIR = path.resolve(__dirname, "../web/public");

export default defineConfig({
  root: ".",
  publicDir: PUBLIC_DIR,
  plugins: [autoresearchPlugin()],
  resolve: {
    alias: {
      "@minigolf/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5180,
    allowedHosts: true,
    fs: {
      // Allow Vite to serve files from the entire worktree (port/ai imports
      // physics from port/web/, shared from port/shared/, and tracks from
      // server/src/main/resources/ via ?raw).
      allow: [path.resolve(__dirname, "../..")],
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      input: {
        // Five entry HTML files share the same module graph: single-map
        // training, multi-map grid trainer, the live autoresearch
        // dashboard, the post-run report, and the HIO-tracks list.
        // The loop and the HIO scan run as Node CLIs separately.
        main: path.resolve(__dirname, "index.html"),
        grid: path.resolve(__dirname, "grid.html"),
        autoresearch: path.resolve(__dirname, "autoresearch.html"),
        autoresearchReport: path.resolve(__dirname, "autoresearch-report.html"),
        hio: path.resolve(__dirname, "hio.html"),
      },
    },
  },
});
