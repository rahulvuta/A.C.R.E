import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "harness.spec.ts", fullyParallel: false, workers: 1,
  outputDir: "/tmp/acre-u3-playwright", reporter: "list",
  use: { baseURL: "http://127.0.0.1:5183", viewport: { width: 1280, height: 900 }, browserName: "chromium" },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 5183", url: "http://127.0.0.1:5183/src/inputs/harness.html", reuseExistingServer: true },
});
