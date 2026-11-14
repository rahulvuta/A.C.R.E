import { expect, test } from "@playwright/test";
import { futureResponse, generated, insufficient, recommendation } from "../../src/planning/test-fixtures";
test.skip(({
  baseURL
}) => !baseURL?.includes(":5175"), "Run with -c src/planning/playwright.config.ts for the dev-only harness.");
test.beforeEach(async ({
  page
}) => {
  await page.route("**/v1/plans/**", async route => {
    const request = route.request();
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS"
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers
      });
      return;
    }
    const body = request.postDataJSON();
    const url = request.url();
    await route.fulfill({
      json: url.endsWith("/recommend") ? recommendation : url.endsWith("/generate") ? generated : futureResponse(body),
      headers
    });
  });
});
test("goals to shortlist to future plan, date edit and print", async ({
  page
}) => {
  await page.goto("/src/planning/harness.html");
  await expect(page.getByRole("slider")).toHaveCount(6);
  await expect(page.getByLabel("Irrigation")).toHaveValue("unknown");
  const requestPromise = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/v1/plans/recommend"));
  await page.getByRole("button", {
    name: "Find plans for this field"
  }).click();
  const request = await requestPromise;
  expect(request.postDataJSON().goals.constraints.irrigation).toBe("unknown");
  await expect(page.getByRole("heading", {
    name: "Rye cover rotation"
  })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/score/i);
  await expect(page.locator("td[data-best=true]")).toHaveCount(2);
  await page.getByRole("button", {
    name: "Use this plan"
  }).first().click();
  await expect(page.getByRole("heading", {
    name: "2027",
    exact: true
  })).toBeVisible();
  const futurePromise = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/v1/plans/future") && request.postDataJSON().edits.length > 0);
  await page.getByLabel("Edit Terminate rye, season 1").fill("2027-04-03");
  await page.getByLabel("Edit Terminate rye, season 1").locator("xpath=ancestor::form").getByRole("button", {
    name: "Update date"
  }).click();
  expect((await futurePromise).postDataJSON().edits).toEqual([{
    field: "winter.terminate",
    season: 1,
    value: "04-03"
  }]);
  await expect(page.getByRole("region", {
    name: "Returned plan changes"
  })).toContainText("2027-04-08 → 2027-04-03");
  await expect(page.locator(".pl-window.pl-date-grower")).toHaveCount(1);
  const styles = await page.locator(".pl-origin-legend .pl-origin").evaluateAll(elements => elements.map(element => {
    const s = getComputedStyle(element);
    return `${s.backgroundColor}|${s.borderStyle}|${s.fontStyle}|${s.borderWidth}`;
  }));
  expect(new Set(styles).size).toBe(4);
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.printed = "true";
    };
  });
  await page.getByRole("button", {
    name: "Print plan"
  }).click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", "true");
  await page.emulateMedia({
    media: "print"
  });
  await expect(page.getByRole("navigation", {
    name: "Planning steps"
  })).toBeHidden();
  await expect(page.getByRole("heading", {
    name: "Future field plan"
  })).toBeVisible();
});
test("insufficient regional evidence exposes gaps and blank manual planning", async ({
  page
}) => {
  await page.route("**/v1/plans/recommend", route => route.fulfill({
    status: route.request().method() === "OPTIONS" ? 204 : 200,
    ...(route.request().method() === "OPTIONS" ? {} : { json: insufficient }),
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS"
    }
  }));
  await page.goto("/src/planning/harness.html");
  await page.getByRole("button", {
    name: "Find plans for this field"
  }).click();
  await expect(page.getByText(insufficient.gaps[0]!)).toBeVisible();
  await page.getByRole("button", {
    name: "Plan manually"
  }).click();
  await expect(page.getByRole("heading", {
    name: "Plan manually"
  })).toBeVisible();
  for (const input of await page.getByRole("textbox").all()) await expect(input).toHaveValue("");
});
