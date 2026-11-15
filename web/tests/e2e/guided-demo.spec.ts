import { expect, test, type Page, type Response } from "@playwright/test";
import { mockTiles } from "./map-mocks";

const LIVE = Boolean(process.env.E2E_API);
const simulation = (response: Response, count: number) => response.url().endsWith("/v1/scenarios/simulate") && response.request().method() === "POST" && response.request().postDataJSON()?.scenarios?.length === count;
const next = (page: Page, step: string) => page.getByRole("button", { name: `Next: ${step}`, exact: true }).click();
async function expectOk(response: Response) {
  const text = await response.text();
  expect(response.status(), `${response.request().method()} ${new URL(response.url()).pathname}: ${text}`).toBe(200);
  return JSON.parse(text);
}

test.describe("guided live demo farms", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!LIVE, "Set E2E_API to the live backend; this spec does not mock API responses.");
  for (const demo of [
    { id: "union", name: /Union County, North Carolina/ },
    { id: "pergamino", name: /Pergamino, Buenos Aires/ },
  ]) {
    test(`${demo.id}: six steps, suggestion, custom plan, comparison and timeline`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await mockTiles(page);
      await page.goto("/?view=app");
      const steps = page.getByRole("navigation", { name: "Steps" });
      await expect(page.getByRole("heading", { name: "Your farm", exact: true, level: 1 })).toBeVisible();
      await expect(steps.getByRole("button", { name: /What you do now/ })).toBeDisabled();

      const loaded = page.waitForResponse(response => response.url().includes(`/v1/demo/farm?scenario=${demo.id}`));
      await page.getByRole("button", { name: demo.name }).click();
      await expectOk(await loaded);
      await expect(page.getByRole("heading", { name: "What do you grow on this field now?" })).toBeVisible();
      await expect(page.getByText("Demo farm (example values)", { exact: true })).toBeVisible();
      await expect(page.getByText("Ready to simulate", { exact: true })).toBeVisible();
      expect(await page.getByLabel("Selected field").locator("option").count()).toBeGreaterThanOrEqual(2);

      await steps.getByRole("button", { name: /^Your farm/ }).click();
      await expect(page.getByText("Farm total", { exact: true })).toBeVisible();
      await expect(page.getByRole("list", { name: "Fields", exact: true }).locator("li").first()).toContainText(/ac/);
      await next(page, "What you do now");
      await expect(page.getByText("Part 1 of 5", { exact: true })).toBeVisible();
      await next(page, "Dates");
      const dates = page.waitForResponse(response => response.url().endsWith("/v1/plans/autofill"));
      await page.getByRole("button", { name: "Refill blank dates with typical ones", exact: true }).first().click();
      await expectOk(await dates);
      await expect(page.getByRole("button", { name: "Refill blank dates with typical ones", exact: true }).first()).toBeEnabled();
      await next(page, "Equipment");
      await expect(page.getByRole("region", { name: "Equipment", exact: true })).toBeVisible();
      await next(page, "Prices and costs");
      await expect(page.getByRole("region", { name: "Prices, yields and costs", exact: true })).toBeVisible();
      await next(page, "Weather losses");

      const readingTools = page.locator("details.gf-reading-tools");
      await readingTools.getByText("Log a field reading", { exact: true }).click();
      await expect(readingTools.getByRole("region", { name: "Field readings", exact: true })).toBeVisible();
      await readingTools.getByText("Log a field reading", { exact: true }).click();

      const baseline = page.waitForResponse(response => simulation(response, 1));
      await next(page, "Simulate current plan");
      const baselineResponse = await baseline;
      const baselineBody = await expectOk(baselineResponse);
      expect(baselineBody.method.note).toMatch(/evidence-based outlook/i);
      expect(baselineBody.scenarios[0].timeline).toHaveLength(10);
      await expect(page.getByRole("region", { name: "10-year result", exact: true })).toBeVisible();

      await next(page, "Try other plans");
      const priorities = page.getByRole("region", { name: "Your priorities", exact: true });
      const resilience = priorities.getByRole("combobox", { name: /weather/i });
      if (await resilience.inputValue() !== "0") await resilience.selectOption("0");
      const add = page.getByRole("button", { name: "Add to compare", exact: true }).first();
      await expect(add).toBeEnabled({ timeout: 120_000 });
      await add.click();
      await page.getByRole("button", { name: "Build your own", exact: true }).click();
      await expect(page.getByText(/2 of 5/)).toBeVisible();
      await page.getByRole("textbox", { name: "Plan name", exact: true }).fill("My demo alternative");
      await page.getByRole("button", { name: "Done editing", exact: true }).click();

      const comparison = page.waitForResponse(response => simulation(response, 3));
      await next(page, "Compare");
      const comparisonResponse = await comparison;
      const compared = await expectOk(comparisonResponse);
      expect(compared.scenarios).toHaveLength(3);
      expect(compared.comparison.caveat).toMatch(/scenarios you compared/i);
      await expect(page.getByRole("region", { name: "Compare scenario plans", exact: true })).toBeVisible();
      await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `/private/tmp/acre-demo-${demo.id}-comparison.png` });
      await page.getByText("Compare crop calendars", { exact: true }).click();
      const calendars = page.getByRole("region", { name: "Plans compared over 10 years", exact: true });
      await expect(calendars).toBeVisible();
      await expect(calendars.locator("[data-scenario]")).toHaveCount(3);
      const choices = page.getByRole("button", { name: /Choose this plan/ });
      await expect(choices).toHaveCount(3);
      await choices.last().click();
      await expect(page.getByRole("heading", { name: "What does your chosen plan look like, year by year?" })).toBeVisible();
      const timeline = page.getByRole("region", { name: "10-year plan: My demo alternative", exact: true });
      await expect(timeline).toBeVisible();
      await expect(timeline.locator(".tl-rows > li")).toHaveCount(10);
      await expect(timeline.getByText(/cannot say what any single year will bring/i)).toBeVisible();
      await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `/private/tmp/acre-demo-${demo.id}-timeline.png` });

      const readings = page.getByRole("region", { name: "Field readings", exact: true });
      await readings.getByLabel("Date", { exact: true }).fill("2026-04-02");
      await readings.getByLabel("Reading type", { exact: true }).selectOption("soil_moisture_vwc");
      await readings.getByRole("spinbutton", { name: "Volumetric soil moisture (m³/m³)", exact: true }).fill("0");
      await readings.getByLabel("Depth (cm, optional)", { exact: true }).fill("10");
      const replayWithReading = page.waitForResponse(response => simulation(response, 3) && response.request().postDataJSON().field.readings.some((reading: { kind: string; value: number; depth_cm?: number }) => reading.kind === "soil_moisture_vwc" && reading.value === 0 && reading.depth_cm === 10));
      await readings.getByRole("button", { name: "Add reading", exact: true }).click();
      await expect(readings.getByRole("list", { name: "Recorded readings", exact: true }).getByText("Volumetric soil moisture: 0 m³/m³", { exact: true })).toBeVisible();
      await expect(readings.getByRole("list", { name: "Recorded readings", exact: true }).locator("li").filter({ hasText: "Volumetric soil moisture: 0 m³/m³" }).getByText("Depth: 10 cm", { exact: true })).toBeVisible();
      await steps.getByRole("button", { name: /^Compare/ }).click();
      const updated = await replayWithReading;
      await expectOk(updated);
      const sentReading = updated.request().postDataJSON().field.readings.find((reading: { kind: string }) => reading.kind === "soil_moisture_vwc");
      expect(sentReading).toMatchObject({ value: 0, depth_cm: 10 });
      expect(sentReading).not.toHaveProperty("origin");

      await steps.getByRole("button", { name: /^Your 10-year plan/ }).click();
      await page.reload();
      await expect(page.getByRole("region", { name: "10-year plan: My demo alternative", exact: true })).toBeVisible({ timeout: 120_000 });
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      expect((await download).suggestedFilename()).toMatch(/10-year-plan\.json$/);
    });
  }
});
