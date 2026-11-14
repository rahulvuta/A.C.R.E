import { expect, test } from "@playwright/test";
import { API, geoHandlers, mapCenter, mockApi } from "./map-mocks";

// Card C1 fix: a place chosen before the map has finished loading is applied once it loads.

test.skip(({ baseURL }) => !baseURL?.includes(":5174"), "runs with -c tests/e2e/map.config.ts");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("typed coordinates before the map loads: the pin and camera follow once it is ready", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tile = async (r: import("@playwright/test").Route) => {
    await gate;
    await r.fulfill({ status: 200, contentType: "image/png", body: PNG });
  };
  await page.route("https://server.arcgisonline.com/**", tile);
  await page.route("https://tile.openstreetmap.org/**", tile);
  await mockApi(page, geoHandlers);
  // MapLibre fires "load" only after the first tiles arrive, so holding the tiles holds the map.
  await page.goto(`/src/map/harness.html?api=${encodeURIComponent(API)}`);
  await page.getByLabel("Find your farm").fill("35.1, -80.5");
  await page.getByLabel("Find your farm").press("Enter");
  await expect(page.getByRole("region", { name: "Picked place" })).toContainText("Union County");
  await expect(page.locator(".mp-map[data-ready='true']")).toHaveCount(0);
  release();
  await page.locator(".mp-map[data-ready='true']").waitFor();
  await expect(page.getByRole("img", { name: "Picked point" })).toBeVisible();
  await expect.poll(async () => (await mapCenter(page))[0], { timeout: 8000 }).toBeCloseTo(35.1, 1);
});
