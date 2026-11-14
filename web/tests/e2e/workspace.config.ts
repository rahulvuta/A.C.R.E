import { defineConfig, devices } from "@playwright/test";

/*
  Agent D's workspace specs (map entry, farm and field screens, provenance). They run the Vite
  dev server with VITE_API_BASE=http://api.test, and every backend call and map tile is mocked
  (map-mocks.ts), so they run offline. Port: D's 5173 is taken on this machine by another
  checkout's server, so D_PW_PORT (default 5177) is used; it never reuses C's 5174.
  Run: npx playwright test -c tests/e2e/workspace.config.ts
*/
const port = Number(process.env.D_PW_PORT ?? 5177);

export default defineConfig({
  testDir: ".",
  testMatch: /workspace[^/]*\.spec\.ts$/,
  timeout: 45_000,
  fullyParallel: true,
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: `VITE_API_BASE=http://api.test npx vite --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
  },
  projects: [{ name: "laptop-1280x720", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } }],
});
