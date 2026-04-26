import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: ".",
  publicDir: "public",
  resolve: {
    alias: {
      "@minigolf/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    // Accept tunnel hostnames (TryCloudflare, ngrok, etc.) in addition to
    // localhost. Vite 5 rejects unknown Host headers by default.
    allowedHosts: true,
    proxy: {
      "/ws": {
        target: "ws://localhost:4244",
        ws: true,
        rewriteWsOrigin: true,
      },
      // Server-side replay store lives next to the WebSocket — proxy so dev
      // mode (vite on 5173/5175) reaches the same endpoints in-process.
      "/api": {
        target: "http://localhost:4244",
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
