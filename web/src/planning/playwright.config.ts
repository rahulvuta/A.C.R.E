import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "../../tests/e2e",
  testMatch: /planning.*\.spec\.ts$/,
  outputDir: "/tmp/acre-planning-playwright",
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5175"
  },
  webServer: {
    command: "npm run dev -- --port 5175 --strictPort",
    port: 5175,
    reuseExistingServer: true
  },
  projects: [{
    name: "planning-desktop",
    use: {
      ...devices["Desktop Chrome"],
      channel: "chrome",
      viewport: {
        width: 1280,
        height: 720
      }
    }
  }]
});
