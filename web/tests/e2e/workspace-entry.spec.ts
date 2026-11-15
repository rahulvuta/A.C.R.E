import { expect, test } from "@playwright/test";
import { geoHandlers, mockApi, mockTiles } from "./map-mocks";

// Card D1: the map is the way in, the Union County demo sits next to it.

test("?view=app opens the map with the demo next to it", async ({ page }) => {
  await mockTiles(page);
  await mockApi(page, geoHandlers);
  await page.goto("/?view=fields");
  await expect(page.getByRole("heading", { name: "Find your farm", level: 1 })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("link", { name: "Open the Union County demo" })).toHaveAttribute("href", "?view=demo");
});

test("a picked point shows the capabilities from the fixtures", async ({ page }) => {
  await mockTiles(page);
  const calls = await mockApi(page, geoHandlers);
  await page.goto("/?view=fields");
  await page.getByPlaceholder("Town, address or coordinates").fill("Pergamino");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Pergamino, Buenos Aires, Argentina", exact: true }).click();
  const caps = page.getByRole("list", { name: "Capabilities" });
  await expect(caps).toBeVisible();
  await expect(caps.locator('[data-capability="catalog"]')).toHaveAttribute("data-status", "partial");
  await expect(caps.locator('[data-capability="drought"]')).toHaveAttribute("data-status", "unavailable");
  await expect(page.getByText("No drought monitor is connected for this country.")).toBeVisible();
  expect(calls.some((c) => c.startsWith("GET /v1/locations/capabilities"))).toBe(true);
});

test("the demo still opens offline from the saved record", async ({ page }) => {
  // No backend at all: every API call fails.
  await page.route("http://api.test/**", (r) => r.abort());
  await page.goto("/?view=demo");
  await expect(page.getByRole("heading", { name: "Winter plans" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Union County/ }).first()).toBeVisible();
});
