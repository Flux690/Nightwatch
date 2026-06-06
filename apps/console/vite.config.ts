import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API routes are unprefixed (e.g. /incidents/pending); the console calls them
// under /api and the proxy strips the prefix, so the browser stays same-origin
// and no CORS handling is needed on the API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
