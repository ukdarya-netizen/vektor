import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Replit sets PORT and BASE_PATH; locally the defaults below are used.
const port = Number(process.env.PORT ?? 5173);
const base = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  root: path.resolve(import.meta.dirname),
  build: { outDir: path.resolve(import.meta.dirname, "dist/public"), emptyOutDir: true },
  server: {
    port, strictPort: true, host: "0.0.0.0", allowedHosts: true,
    // Locally the API runs separately; on Replit /api is routed to the API artifact.
    proxy: process.env.REPL_ID ? undefined : { "/api": "http://localhost:8080" },
  },
  preview: { port, host: "0.0.0.0", allowedHosts: true },
});
