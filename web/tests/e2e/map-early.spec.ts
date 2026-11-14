import { expect, test } from "@playwright/test";
import { API, geoHandlers, holdTiles, mapCenter, mockApi } from "./map-mocks";

// Card C1: picking a place while the map is still loading (all routes mocked, tiles held).

test.skip(({ baseURL }) => !baseURL?.includes(":5174"), "runs with -c tests/e2e/map.config.ts");

test("a place picked before the map has loaded gets its pin and its view once it does", async ({ page }) => {
  await mockApi(page, geoHandlers);
  const release = await holdTiles(page);
  await page.goto(`/src/map/harness.html?api=${encodeURIComponent(API)}`);
  const map = page.locator(".mp-map");
  await expect(map).not.toHaveAttribute("data-ready", "true");

  await page.getByLabel("Find your farm").fill("Pergamino");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Pergamino, Buenos Aires, Argentina", exact: true }).click();
  // The place is picked and described while the map is still loading.
  await expect(page.getByRole("region", { name: "Picked place" }).getByRole("heading", { name: "Pergamino, Buenos Aires, Argentina" })).toBeVisible();
  await expect(map).not.toHaveAttribute("data-ready", "true");

  release();
  await page.locator(".mp-map[data-ready='true']").waitFor();
  await expect(page.getByRole("img", { name: "Picked point" })).toBeVisible();
  await expect
    .poll(async () => {
      const [lat, lon] = await mapCenter(page);
      return Math.abs(lat - -33.89) < 0.1 && Math.abs(lon - -60.575) < 0.1;
    }, { timeout: 8000 })
    .toBe(true);
});

test("typed coordinates before the map has loaded are not lost", async ({ page }) => {
  await mockApi(page, geoHandlers);
  const release = await holdTiles(page);
  await page.goto(`/src/map/harness.html?api=${encodeURIComponent(API)}`);
  await expect(page.locator(".mp-map")).not.toHaveAttribute("data-ready", "true");

  await page.getByLabel("Find your farm").fill("35.1, -80.5");
  await page.getByLabel("Find your farm").press("Enter");
  await expect(page.getByRole("region", { name: "Picked place" })).toContainText("Union County");

  release();
  await page.locator(".mp-map[data-ready='true']").waitFor();
  await expect(page.getByRole("img", { name: "Picked point" })).toBeVisible();
  await expect.poll(async () => (await mapCenter(page))[0], { timeout: 8000 }).toBeCloseTo(35.1, 1);
});
