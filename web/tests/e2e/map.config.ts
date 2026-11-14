import { defineConfig, devices } from "@playwright/test";

/*
  Agent C's map and farm specs. They run the Vite dev server on port 5174 (D uses 5173) and
  open the dev-only harness pages under src/map/. Every backend call and every map tile is
  mocked (see map-mocks.ts), so the specs run offline.
  Run: npx playwright test -c tests/e2e/map.config.ts
*/
export default defineConfig({
  testDir: ".",
  testMatch: /(map|farm)[^/]*\.spec\.ts$/,
  timeout: 45_000,
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:5174",
    // MapLibre needs WebGL; headless Chromium provides it through SwiftShader.
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: "npx vite --port 5174 --strictPort",
    port: 5174,
    reuseExistingServer: true,
  },
  // The installed Google Chrome: Playwright 1.49's own browser download is no longer served.
  projects: [{ name: "laptop-1280x720", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1280, height: 720 } } }],
});
