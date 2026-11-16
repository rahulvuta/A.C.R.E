/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the same build works on GitHub Pages, Vercel, or opened locally
// from `vite preview` on the demo laptop with the network off.
export default defineConfig({
  base: "./",
  plugins: [react()],
  // The list of built files, read by the service worker so the whole app is kept for use offline (card 20).
  build: { manifest: "asset-manifest.json" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
