import { defineConfig } from "vite";
import path from "node:path";

// Per-worktree devctl.mjs sets WS_PORT/WEB_PORT so each worktree gets its
// own port pair. Defaults match the historical hardcoded pair so master
// and ad-hoc `npm run dev` keep working unchanged.
const WS_PORT = Number.parseInt(process.env.WS_PORT ?? "", 10) || 4242;
const WEB_PORT = Number.parseInt(process.env.WEB_PORT ?? "", 10) || 5173;

export default defineConfig({
  root: ".",
  publicDir: "public",
  resolve: {
    alias: {
      "@minigolf/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: WEB_PORT,
    // Accept tunnel hostnames (TryCloudflare, ngrok, etc.) in addition to
    // localhost. Vite 5 rejects unknown Host headers by default.
    allowedHosts: true,
    proxy: {
      "/ws": {
        target: process.env.WS_PROXY_TARGET ?? `ws://127.0.0.1:${WS_PORT}`,
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
      // Server-side replay store lives next to the WebSocket — proxy so dev
      // mode reaches the same endpoints in-process.
      "/api": {
        target: `http://127.0.0.1:${WS_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
