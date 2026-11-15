import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/*
  Agent D's workspace specs (map entry, farm and field screens, provenance). They run the Vite
  dev server with VITE_API_BASE=http://api.test, and every backend call and map tile is mocked
  (map-mocks.ts), so they run offline. Port: D's 5173 is taken on this machine by another
  checkout's server, so D_PW_PORT (default 5177) is used; it never reuses C's 5174.
  Run: npx playwright test -c tests/e2e/workspace.config.ts
*/
const port = Number(process.env.D_PW_PORT ?? 5177);
// E2E_API=http://localhost:8000 runs the workflow spec against a real backend instead of mocks.
const apiBase = process.env.E2E_API ?? "http://api.test";

export default defineConfig({
  testDir: ".",
  testMatch: /(?:workspace[^/]*|guided-demo)\.spec\.ts$/,
  timeout: process.env.E2E_API ? 360_000 : 45_000,
  fullyParallel: true,
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: `VITE_API_BASE=${apiBase} npx vite --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    port,
    reuseExistingServer: false,
  },
  projects: [{ name: "laptop-1280x720", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } }],
});
