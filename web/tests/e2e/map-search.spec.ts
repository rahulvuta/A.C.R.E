import { expect, test } from "@playwright/test";
import { fixture, geoHandlers, mapCenter, mockApi, openMap } from "./map-mocks";

// Card C1: map, search and picking a point (all routes mocked).

test.skip(({ baseURL }) => !baseURL?.includes(":5174"), "runs with -c tests/e2e/map.config.ts");

test.beforeEach(async ({ page }) => {
  await mockApi(page, geoHandlers);
  await openMap(page);
});

test("search Pergamino shows the result and flies there", async ({ page }) => {
  await page.getByLabel("Find your farm").fill("Pergamino");
  await page.getByRole("button", { name: "Search" }).click();
  const result = page.getByRole("list", { name: "Search results" }).getByRole("button", { name: "Pergamino, Buenos Aires, Argentina", exact: true });
  await expect(result).toBeVisible();
  await result.click();
  await expect
    .poll(async () => {
      const [lat, lon] = await mapCenter(page);
      return Math.abs(lat - -33.89) < 0.1 && Math.abs(lon - -60.575) < 0.1;
    }, { timeout: 8000 })
    .toBe(true);
  await expect(page.getByRole("region", { name: "Picked place" }).getByRole("heading", { name: "Pergamino, Buenos Aires, Argentina" })).toBeVisible();
});

test("typing coordinates drops the pin", async ({ page }) => {
  await page.getByLabel("Find your farm").fill("35.1, -80.5");
  await page.getByLabel("Find your farm").press("Enter");
  await expect(page.getByRole("img", { name: "Picked point" })).toBeVisible();
  // A typed point is not a list of choices.
  await expect(page.getByRole("list", { name: "Search results" })).toHaveCount(0);
  await expect.poll(async () => (await mapCenter(page))[0], { timeout: 8000 }).toBeCloseTo(35.1, 1);
  await expect(page.getByRole("region", { name: "Picked place" })).toContainText("Union County");
});

test("the card shows the capability statuses from the fixture", async ({ page }) => {
  await page.getByLabel("Find your farm").fill("Pergamino");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Pergamino, Buenos Aires, Argentina", exact: true }).click();
  const caps = page.getByRole("list", { name: "Capabilities" });
  await expect(caps.locator("[data-capability='weather']")).toHaveAttribute("data-status", "complete");
  await expect(caps.locator("[data-capability='catalog']")).toContainText("Partly available");
  await expect(caps.locator("[data-capability='catalog']")).toContainText("AI-found suggestions, not verified");
  await expect(caps.locator("[data-capability='soil']")).toContainText("SoilGrids model");
  await expect(caps.locator("[data-capability='drought']")).toContainText("Not available");
  await expect(caps.locator("[data-capability='drought']")).toContainText("No drought monitor is connected");
  const card = page.getByRole("region", { name: "Picked place" });
  await expect(card).toContainText("Cfa · Humid subtropical");
  await expect(card).toContainText("lat-34.00_lon-60.625");
});

test("clicking the map drops a pin and asks about that point", async ({ page }) => {
  const reverse = page.waitForRequest((r) => r.url().includes("/v1/geo/reverse"));
  await page.locator(".mp-map canvas").click({ position: { x: 300, y: 300 } });
  const req = await reverse;
  // The point is rounded before it leaves the browser.
  const lat = new URL(req.url()).searchParams.get("lat")!;
  expect(lat.split(".")[1]?.length ?? 0).toBeLessThanOrEqual(5);
  await expect(page.getByRole("img", { name: "Picked point" })).toBeVisible();
});

test("attribution stays visible, on both basemaps", async ({ page }) => {
  const attrib = page.locator(".maplibregl-ctrl-attrib");
  await expect(attrib).toContainText("Esri");
  await expect(attrib).toBeInViewport();
  await page.getByRole("radio", { name: "Streets" }).click();
  await expect(page.locator(".mp-map")).toHaveAttribute("data-basemap", "streets");
  await expect(attrib).toContainText("OpenStreetMap");
  await expect(attrib).toBeInViewport();
  // The expanded attribution has no collapse button.
  await expect(page.locator(".maplibregl-compact")).toHaveCount(0);
});

test("a failed search says so", async ({ page }) => {
  await page.unroute("http://api.test/**");
  await page.route("http://api.test/**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}", headers: { "access-control-allow-origin": "*" } }));
  await page.getByLabel("Find your farm").fill("Pergamino");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 500");
});

test("a map click wins over a slower search still in flight", async ({ page }) => {
  // Registered after the default mocks from beforeEach: the newest route answers first, so
  // this is the one the search request reaches, and it holds the answer until released.
  let release!: () => void;
  let held = 0;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("http://api.test/v1/geo/search**", async (route) => {
    held++;
    await gate;
    // By now the page has dropped the request, so there may be nothing left to answer.
    await route
      .fulfill({ contentType: "application/json", body: JSON.stringify(fixture("geo-search-coordinates")), headers: { "access-control-allow-origin": "*" } })
      .catch(() => undefined);
  });
  const asked = page.waitForRequest((r) => r.url().includes("/v1/geo/search"));
  const dropped = page.waitForEvent("requestfailed", (r) => r.url().includes("/v1/geo/search"));

  await page.getByLabel("Find your farm").fill("35.1, -80.5");
  await page.getByLabel("Find your farm").press("Enter");
  await asked; // the search has left the browser and is being held
  expect(held).toBe(1);

  await page.locator(".mp-map canvas").click({ position: { x: 300, y: 300 } });
  await expect(page.getByRole("img", { name: "Picked point" })).toBeVisible();
  const clicked = await page.locator(".mp-pin").boundingBox();
  const centre = await mapCenter(page);
  await dropped; // the click cancelled the search that was still out

  release();
  await page.waitForTimeout(800);
  // The late coordinate answer did not move the pin, the map or the list.
  expect(await page.locator(".mp-pin").boundingBox()).toEqual(clicked);
  expect(await mapCenter(page)).toEqual(centre);
  await expect(page.getByRole("list", { name: "Search results" })).toHaveCount(0);
});

test("a click on a repeated copy of the world asks about a real longitude", async ({ page }) => {
  // Zoomed out near the date line, the map draws the world more than once.
  await page.evaluate(() => (window as unknown as { __map: { jumpTo: (o: object) => void } }).__map.jumpTo({ center: [179, 0], zoom: 1 }));
  await expect.poll(async () => (await mapCenter(page))[1]).toBeCloseTo(179, 0);
  const box = (await page.locator(".mp-map canvas").boundingBox())!;
  const reverse = page.waitForRequest((r) => r.url().includes("/v1/geo/reverse"));
  // At zoom 1 the world is 1024 px wide, so 300 px right of centre is about 105 degrees further
  // east: 284 degrees on the copy, which is 76 degrees west on the real one.
  await page.locator(".mp-map canvas").click({ position: { x: box.width / 2 + 300, y: box.height / 2 } });
  const lon = Number(new URL((await reverse).url()).searchParams.get("lon"));
  expect(lon).toBeGreaterThanOrEqual(-180);
  expect(lon).toBeLessThanOrEqual(180);
  expect(lon).toBeLessThan(-60);
  expect(lon).toBeGreaterThan(-90);
  await expect(page.getByRole("img", { name: "Picked point" })).toBeVisible();
});
