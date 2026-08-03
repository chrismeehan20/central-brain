import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: "src/client",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/client"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4317",
        changeOrigin: true,
      },
    },
  },
});
