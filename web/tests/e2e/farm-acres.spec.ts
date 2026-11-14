import { expect, test, type Page } from "@playwright/test";
import { geoHandlers, mockApi, openMap } from "./map-mocks";

// Card U4: acres front and centre (cards, map labels, live farm total) and the demo farm.

test.skip(({ baseURL }) => !baseURL?.includes(":5174"), "runs with -c tests/e2e/map.config.ts");

type W = { __map: { jumpTo(o: unknown): void; getCenter(): { lat: number; lng: number }; getZoom(): number } };

test.beforeEach(async ({ page }) => {
  // GET /v1/demo/farm is not shipped yet: the mocked backend answers 404, so the example file is used.
  await mockApi(page, geoHandlers);
  await openMap(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator(".mp-map[data-ready='true']").waitFor();
});

async function loadDemo(page: Page) {
  await page.getByRole("button", { name: /Try a demo farm/ }).click();
  await expect(page.getByRole("list", { name: "Fields" }).locator("li")).toHaveCount(3);
}

test("the demo farm draws its fields and zooms to them", async ({ page }) => {
  await loadDemo(page);
  await expect(page.getByText(/example values, not a real farm/)).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => {
      const m = (window as unknown as W).__map;
      return [m.getCenter().lat, m.getCenter().lng, m.getZoom()];
    }), { timeout: 8000 })
    .toEqual([expect.closeTo(34.87, 1), expect.closeTo(-80.44, 1), expect.any(Number)]);
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__map.getZoom()), { timeout: 8000 }).toBeGreaterThan(13);
  // Each field labelled on the map with its acres.
  await expect(page.locator(".mp-field-label")).toHaveCount(3);
  await expect(page.locator(".mp-field-label").first()).toContainText(/ ac · .* ha/);
});

test("field cards show acres and hectares, crops, plan status and a mini timeline; the farm total adds up area", async ({ page }) => {
  await loadDemo(page);
  const first = page.getByRole("list", { name: "Fields" }).locator("li").first();
  await expect(first).toContainText(/\d+(\.\d+)? ac/);
  await expect(first).toContainText(/\d+(\.\d+)? ha/);
  await expect(first).toContainText("Corn → bare winter → soybean");
  await expect(first).toContainText("Plan set, not simulated yet");
  await expect(first.getByRole("img")).toHaveAttribute("aria-label", /Soybean planted May 12/);
  const total = page.getByTestId("farm-total");
  await expect(total).toContainText("3 fields");
  await expect(total).toContainText(/ ac/);
});

test("the acres update live while a field is drawn", async ({ page }) => {
  await loadDemo(page);
  const total = page.getByTestId("farm-total");
  const before = await total.locator(".mp-total-ac").textContent();
  await page.getByRole("button", { name: "Draw a field" }).click();
  const b = (await page.locator(".mp-map canvas").boundingBox())!;
  const pts: [number, number][] = [[0.15, 0.15], [0.3, 0.15], [0.3, 0.3]];
  for (const [fx, fy] of pts) {
    await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy);
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
  }
  await page.mouse.move(b.x + b.width * 0.15, b.y + b.height * 0.32);
  await expect(page.locator(".mp-live")).toContainText(/This shape: \d/);
  await expect(total).toContainText("4 fields");
  expect(await total.locator(".mp-total-ac").textContent()).not.toBe(before);
});
