import { expect, test, type Page } from "@playwright/test";
import { geoHandlers, mockApi, openMap } from "./map-mocks";

// Card C4: field colours by analysis state, one weather cell outline, click selects a field.

test.skip(({ baseURL }) => !baseURL?.includes(":5174"), "runs with -c tests/e2e/map.config.ts");

type W = { __map: { jumpTo(o: unknown): void; project(p: [number, number]): { x: number; y: number }; getSource(id: string): { _data?: unknown } | undefined }; __setResults(r: unknown): void };

// Two synthetic fields near Pergamino, both inside cell_-34.000_-60.625 (labelled fixture, not a real farm).
const sq = (w: number, s: number, d = 0.004) => ({ type: "Polygon", coordinates: [[[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]]] });
const STORE = {
  schema: "acre.farms.v1",
  farms: [
    {
      schema: "acre.farm.v1",
      farm_id: "farm_fx",
      name: "Fixture farm",
      anchor: { latitude: -33.89, longitude: -60.58 },
      fields: [
        { field_id: "fld_a", name: "North 40", geometry: sq(-60.59, -33.892), plan: null },
        { field_id: "fld_b", name: "Creek field", geometry: sq(-60.58, -33.892), plan: null },
      ],
      created_at: "2026-11-14T00:00:00Z",
      updated_at: "2026-11-14T00:00:00Z",
    },
  ],
  selected_farm_id: "farm_fx",
  selected_field_id: null,
};
const CELL = { cellId: "cell_-34.000_-60.625", center: { latitude: -34.0, longitude: -60.625 }, sizeDeg: [0.5, 0.625], fieldIds: ["fld_a", "fld_b"], note: null };

const fieldState = (page: Page, id: string) =>
  page.evaluate((fid) => {
    const src = (window as unknown as W).__map.getSource("acre-fields") as unknown as { serialize(): { data: { features: Array<{ properties: { field_id: string; state: string } }> } } };
    return src.serialize().data.features.find((f) => f.properties.field_id === fid)?.properties.state ?? null;
  }, id);

test.beforeEach(async ({ page }) => {
  await mockApi(page, geoHandlers);
  await page.addInitScript((s) => localStorage.setItem("acre.farms.v1", s), JSON.stringify(STORE));
  await openMap(page);
  await page.evaluate(() => (window as unknown as W).__map.jumpTo({ center: [-60.584, -33.89], zoom: 14 }));
});

test("clicking a field on the map selects it for D's screens", async ({ page }) => {
  const pt = await page.evaluate(() => (window as unknown as W).__map.project([-60.578, -33.89]));
  await page.locator(".mp-map canvas").click({ position: pt });
  await expect(page.getByTestId("selected-field")).toHaveText("fld_b");
  await expect(page.getByRole("list", { name: "Fields" }).getByRole("button", { name: /Creek field/ })).toHaveAttribute("aria-pressed", "true");
  // Selecting a field does not drop a location pin.
  await expect(page.getByRole("img", { name: "Picked point" })).toHaveCount(0);
});

test("2 fields in one cell: one cell outline, the label and the shared notice", async ({ page }) => {
  await page.evaluate((cell) => (window as unknown as W).__setResults({ states: { fld_a: "ready", fld_b: "flagged" }, cells: [cell] }), CELL);
  await expect(page.locator(".mp-cell-label")).toHaveCount(1);
  await expect(page.locator(".mp-cell-label")).toHaveText("one NASA weather series");
  const cells = page.getByRole("list", { name: "Weather cells" }).locator("li");
  await expect(cells).toHaveCount(1);
  await expect(cells.first()).toContainText("North 40, Creek field");
  await expect(cells.first()).toContainText("share one NASA weather series");
  const legend = page.getByRole("list", { name: "Field colours" });
  await expect(legend).toContainText("Results ready");
  await expect(legend).toContainText("Has a check to look at");
});

test("a pending field shows pending, then updates when its job is ready", async ({ page }) => {
  await page.evaluate((cell) => (window as unknown as W).__setResults({ states: { fld_a: "pending", fld_b: "pending" }, cells: [{ ...cell }] }), CELL);
  await expect.poll(() => fieldState(page, "fld_a")).toBe("pending");
  await expect(page.getByRole("list", { name: "Field colours" })).toContainText("Weather being prepared");
  // The mocked job finishes.
  await page.evaluate((cell) => (window as unknown as W).__setResults({ states: { fld_a: "ready", fld_b: "ready" }, cells: [cell] }), CELL);
  await expect.poll(() => fieldState(page, "fld_a")).toBe("ready");
  await expect(page.getByRole("list", { name: "Field colours" })).not.toContainText("Weather being prepared");
});
