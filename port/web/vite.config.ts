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
        target: "ws://localhost:4242",
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
