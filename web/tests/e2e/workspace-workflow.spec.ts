import { expect, test, type Page } from "@playwright/test";
import { API, fixture, geoHandlers, mockTiles } from "./map-mocks";

/*
  Card D4: the full workflow, every backend call mocked from the contract fixtures.
  Search → draw 2 fields → give each a plan (switching keeps drafts) → analyse → field results
  differ → overview totals area only → export GeoJSON → reload keeps everything.
*/

type Fld = { field_id: string; name: string };
async function mockBackend(page: Page) {
  const calls: string[] = [];
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(`${req.method()} ${url.pathname}`);
    const send = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
    for (const h of geoHandlers) {
      const r = h(url);
      if (r) return send(r.body, r.status ?? 200);
    }
    if (url.pathname === "/v1/regions/AR-B/profile") return send(fixture("profile-ar-b"));
    if (url.pathname.startsWith("/v1/regions/")) return send({ detail: "none" }, 404);
    if (url.pathname === "/v1/farms/analyze") {
      // The two-field fixture, renamed to the request's own fields (field i gets result i).
      const asked = (JSON.parse(req.postData() ?? "{}").farm?.fields ?? []) as Fld[];
      const base = fixture("farm-two-fields-one-cell") as { fields: Fld[]; weather_cells: Array<{ field_ids: string[] }> };
      const fields = asked.map((f, i) => ({ ...base.fields[i % base.fields.length], field_id: f.field_id, name: f.name }));
      const weather_cells = base.weather_cells.map((c) => ({ ...c, field_ids: asked.map((f) => f.field_id) }));
      return send({ ...base, fields, weather_cells });
    }
    return send({ issues: [{ message: "not mocked" }] }, 404);
  });
  return calls;
}

async function drawRing(page: Page, pts: [number, number][]) {
  const b = (await page.locator(".mp-map canvas").boundingBox())!;
  const xy = pts.map(([fx, fy]) => [b.x + b.width * fx, b.y + b.height * fy] as const);
  for (const [x, y] of [...xy, xy[0]!]) {
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(300);
}

const LIVE = Boolean(process.env.E2E_API);
// Live: Union County (NC profile crops); mocked: Pergamino (AR-B fixture profile).
const PLACE = LIVE
  ? { query: "34.97, -80.55", hit: /34\.97/, center: [-80.555, 34.965], prev: "field_corn", crops: ["soybean", "soybean"], dates: { harvest: "09-20", seed: "10-01", terminate: "04-20", plants: ["05-12", "05-25"] } }
  : { query: "Pergamino", hit: "Pergamino, Buenos Aires, Argentina", center: [-60.575, -33.885], prev: "maize", crops: ["soybean", "wheat"], dates: { harvest: "04-20", seed: "05-01", terminate: "10-20", plants: ["11-15", "06-01"] } };

async function fillPlan(page: Page, id: string, next: { crop: string; plant: string }) {
  await page.locator(`#pe-prev-${id}`).selectOption(PLACE.prev);
  await page.locator(`#pe-harv-${id}`).fill(PLACE.dates.harvest);
  await page.locator(`#pe-wk-${id}`).selectOption("cover");
  await page.locator(`#pe-cov-${id}`).selectOption("cereal_rye");
  await page.locator(`#pe-seed-${id}`).fill(PLACE.dates.seed);
  await page.locator(`#pe-term-${id}`).fill(PLACE.dates.terminate);
  await page.locator(`#pe-next-${id}`).selectOption(next.crop);
  await page.locator(`#pe-plant-${id}`).fill(next.plant);
}

test("search, draw two fields, plan each, analyse, overview, export, reload", async ({ page }) => {
  await mockTiles(page);
  const calls = LIVE ? [] : await mockBackend(page);
  await page.goto("/?view=app");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator(".mp-map[data-ready='true']").waitFor();

  // Search and start a farm there.
  await page.getByPlaceholder("Town, address or coordinates").fill(PLACE.query);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: PLACE.hit, exact: typeof PLACE.hit === "string" }).first().click();
  await page.evaluate((c) => (window as unknown as { __map: { jumpTo(o: unknown): void } }).__map.jumpTo({ center: c, zoom: 15 }), PLACE.center);
  await page.waitForTimeout(300);

  await page.getByRole("button", { name: "Start a farm here" }).click();
  // Draw two fields.
  const list = page.getByRole("list", { name: "Fields" }).locator("li");
  await page.getByRole("button", { name: "Draw a field" }).click();
  await drawRing(page, [[0.2, 0.2], [0.45, 0.2], [0.45, 0.5], [0.2, 0.5]]);
  await page.getByRole("button", { name: "Draw a field" }).click();
  await drawRing(page, [[0.55, 0.2], [0.8, 0.2], [0.8, 0.5], [0.55, 0.5]]);
  await expect(list).toHaveCount(2);

  // Plan field 1, then switch to field 2 and back: the draft stays.
  const store = () => page.evaluate(() => JSON.parse(localStorage.getItem("acre.farms.v1")!));
  const ids: string[] = (await store()).farms[0].fields.map((f: { field_id: string }) => f.field_id);
  const switcher = page.getByLabel("Selected field");
  await switcher.selectOption(ids[0]!);
  await page.getByRole("button", { name: "Field plan" }).click();
  await fillPlan(page, ids[0]!, { crop: PLACE.crops[0]!, plant: PLACE.dates.plants[0]! });
  await switcher.selectOption(ids[1]!);
  await switcher.selectOption(ids[0]!);
  await expect(page.locator(`#pe-plant-${ids[0]}`)).toHaveValue(PLACE.dates.plants[0]!);
  await expect(page.locator(`#pe-harv-${ids[0]}`)).toHaveValue(PLACE.dates.harvest);
  await page.getByRole("button", { name: "Save plan" }).click();
  await switcher.selectOption(ids[1]!);
  await fillPlan(page, ids[1]!, { crop: PLACE.crops[1]!, plant: PLACE.dates.plants[1]! });
  await page.getByRole("button", { name: "Save plan" }).click();
  expect((await store()).farms[0].fields.every((f: { plan: unknown }) => f.plan)).toBe(true);

  // Analyse; the two fields show their own results.
  await page.getByRole("button", { name: "Analyse farm" }).click();
  const results = page.getByRole("region", { name: "Results for this field" });
  await expect(results.locator(".fr-num").first()).toBeVisible({ timeout: LIVE ? 120_000 : 5_000 });
  const second = await results.locator(".fr-num").allTextContents();
  await switcher.selectOption(ids[0]!);
  await expect(results.locator(".fr-num").first()).toBeVisible();
  const first = await results.locator(".fr-num").allTextContents();
  expect(first).not.toEqual(second);
  await expect(results.getByText(/share one NASA weather series/)).toBeVisible();
  await expect(results.locator(".ob").first()).toBeVisible();
  if (!LIVE) expect(calls).toContain("POST /v1/farms/analyze");

  // Overview: area is the only total.
  await page.getByRole("button", { name: "Farm overview" }).click();
  const foot = page.getByRole("row", { name: /Total area/ });
  await expect(foot).toContainText("ha");
  await expect(foot).not.toContainText("mm");

  // Export GeoJSON from the map.
  await page.getByRole("button", { name: "Farm map" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GeoJSON" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.geojson$/);

  // Reload: farm, fields and plans persist.
  await page.reload();
  await page.locator(".mp-map[data-ready='true']").waitFor();
  await expect(list).toHaveCount(2);
  const saved = await store();
  expect(saved.farms[0].fields[0].plan.next_plant).toBe(PLACE.dates.plants[0]);
});
