import { expect, test, type Page } from "@playwright/test";
import { geoHandlers, mockApi, openMap } from "./map-mocks";

// Card C2: draw, rename, cut a hole, reload; export/import; bowtie rejected.

test.skip(({ baseURL }) => !baseURL?.includes(":5174"), "runs with -c tests/e2e/map.config.ts");

async function gotoFarm(page: Page) {
  // Pergamino at a field-sized zoom.
  await page.evaluate(() => (window as unknown as { __map: { jumpTo(o: unknown): void } }).__map.jumpTo({ center: [-60.575, -33.885], zoom: 15 }));
  await page.waitForTimeout(200);
}

async function canvasBox(page: Page) {
  return (await page.locator(".mp-map canvas").boundingBox())!;
}

/** Click a ring of points given as fractions of the map, then the first point again to close. */
async function drawRing(page: Page, pts: [number, number][]) {
  const b = await canvasBox(page);
  const xy = pts.map(([fx, fy]) => [b.x + b.width * fx, b.y + b.height * fy] as const);
  for (const [x, y] of xy) {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await page.waitForTimeout(120);
  }
  await page.mouse.move(xy[0]![0], xy[0]![1]);
  await page.mouse.click(xy[0]![0], xy[0]![1]);
  await page.waitForTimeout(300);
}

const fields = (page: Page) => page.getByRole("list", { name: "Fields" }).locator("li");

test.beforeEach(async ({ page }) => {
  await mockApi(page, geoHandlers);
  await openMap(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator(".mp-map[data-ready='true']").waitFor();
  await gotoFarm(page);
});

test("draw 2 fields, rename one, add a hole, reload: all three persist", async ({ page }) => {
  await page.getByRole("button", { name: "Draw a field" }).click();
  await drawRing(page, [[0.2, 0.2], [0.45, 0.2], [0.45, 0.5], [0.2, 0.5]]);
  await expect(fields(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Draw a field" }).click();
  await drawRing(page, [[0.55, 0.2], [0.8, 0.2], [0.8, 0.5], [0.55, 0.5]]);
  await expect(fields(page)).toHaveCount(2);

  // Select the first field, rename it and cut a hole in it.
  await fields(page).first().getByRole("button").first().click();
  const name = page.getByLabel("Field name");
  await name.fill("North 40");
  await name.press("Enter");
  const before = await fields(page).first().locator(".mp-field-area").textContent();
  await page.getByRole("button", { name: "Cut out an area" }).click();
  await drawRing(page, [[0.28, 0.28], [0.36, 0.28], [0.36, 0.4], [0.28, 0.4]]);
  await expect(fields(page).first().locator(".mp-field-area")).not.toHaveText(before!);

  await page.reload();
  await page.locator(".mp-map[data-ready='true']").waitFor();
  await expect(fields(page)).toHaveCount(2);
  await expect(fields(page).first()).toContainText("North 40");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("acre.farms.v1")!));
  const geo = saved.farms[0].fields.find((f: { name: string }) => f.name === "North 40").geometry;
  expect(geo.type).toBe("Polygon");
  expect(geo.coordinates).toHaveLength(2);
  // Area shows both units.
  await expect(fields(page).first()).toContainText(/ha · .* ac/);
});

test("a bowtie outline is rejected with a message", async ({ page }) => {
  await page.getByRole("button", { name: "Draw a field" }).click();
  await drawRing(page, [[0.2, 0.2], [0.5, 0.5], [0.5, 0.2], [0.2, 0.5]]);
  await expect(page.getByRole("alert")).toContainText("crosses itself");
  await expect(page.getByRole("list", { name: "Fields" })).toHaveCount(0);
});

test("export then import round-trips the geometry exactly", async ({ page }) => {
  await page.getByRole("button", { name: "Draw a field" }).click();
  await drawRing(page, [[0.2, 0.2], [0.45, 0.25], [0.4, 0.5], [0.2, 0.45]]);
  await expect(fields(page)).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GeoJSON" }).click();
  const file = await (await download).path();
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(file!, "utf8");
  await page.getByLabel("GeoJSON file to import").setInputFiles({ name: "again.geojson", mimeType: "application/geo+json", buffer: Buffer.from(text) });
  await expect(page.getByRole("status").filter({ hasText: "Imported 1 field" })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("acre.farms.v1")!));
  expect(saved.farms).toHaveLength(2);
  expect(saved.farms[1].fields[0].geometry).toEqual(saved.farms[0].fields[0].geometry);
});

test("a bad file is rejected whole", async ({ page }) => {
  await page.getByLabel("GeoJSON file to import").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{nope") });
  await expect(page.getByRole("alert")).toContainText("Nothing was imported");
});
