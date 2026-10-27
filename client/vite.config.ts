import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Inside Docker, localhost is the client container itself, so compose sets
// API_PROXY_TARGET=http://server:3001. Run locally, the default applies.
const target = process.env.API_PROXY_TARGET ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/api": target,
      "/ws": {
        target: target.replace(/^http/, "ws"),
        ws: true,
      },
    },
  },
});
