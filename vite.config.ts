import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Worker (API) runs separately under `wrangler dev` on :8787; Vite proxies /api to it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
});
