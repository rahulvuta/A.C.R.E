import { cleanup, render, screen, within } from "@testing-library/react";
import { ScenarioResults } from "./ScenarioResults";
import { currentExample, EXAMPLE_LABEL, missingMoneyExample } from "./fixtures";
import { originSchema, scenarioSchema } from "./schema";

afterEach(cleanup);

it("renders both ten-year fan charts, actual ranges, living cover, and event sentences", () => {
  const { container } = render(<ScenarioResults scenario={currentExample} />);
  expect(screen.getByText(EXAMPLE_LABEL)).toBeVisible();
  expect(screen.getByText("$131,000")).toBeVisible();
  expect(screen.getByText("$98,000")).toBeVisible();
  expect(screen.getByText("$165,000")).toBeVisible();
  expect(screen.getByRole("img", { name: /Annual margin by year/ })).toBeVisible();
  expect(screen.getByRole("img", { name: /Rain on bare soil by year/ })).toBeVisible();
  expect(container.querySelectorAll(".sim-fan-chart .sim-fan-band")).toHaveLength(2);
  const cover = screen.getByRole("table", { name: /Annual living cover/ });
  expect(within(cover).getAllByRole("row")).toHaveLength(11);
  expect(within(cover).getByRole("rowheader", { name: "2036" })).toBeVisible();
  expect(screen.getByText(/3 or more dry springs in 10 years occurred in 34%/)).toBeVisible();
  expect(screen.getByText(/Replays real past weather in new orders; not a forecast/)).toBeVisible();
  expect(screen.getByText(/Includes your dry-spring loss estimate/)).toBeVisible();
  expect(container.textContent).not.toMatch(/\bscore\b/i);
});

it("explains missing money without inventing a margin", () => {
  const { container } = render(<ScenarioResults scenario={missingMoneyExample} />);
  expect(screen.getByText(/No local clover price or harvest cost was supplied/)).toBeVisible();
  expect(screen.getByText("Money inputs: partial.")).toBeVisible();
  expect(screen.getAllByText("Not available").length).toBeGreaterThan(2);
  expect(screen.queryByText("$0")).not.toBeInTheDocument();
  expect(container.querySelector(".sim-fan-chart")?.querySelector(".sim-median-line")).not.toBeInTheDocument();
});

it("keeps zeroes distinct from null values in summaries, charts, events, and field readings", () => {
  const scenario = scenarioSchema.parse({
    ...currentExample,
    totals: { margin_10y: { median: 0, p10: 0, p90: null, currency: "USD", origin: "grower" }, living_cover_days_per_year: { median: 0, origin: "calculation" }, rain_on_bare_soil_mm_per_year: { median: null, origin: "calculation" } },
    yearly: [{ year: 2027, money: { margin: { median: 0, p10: 0, p90: null, currency: "USD", origin: "calculation" } }, indicators: { rain_on_bare_soil_mm: null, living_cover_days: { median: 0, origin: "calculation" } } }],
    events: [{ event: "dry_springs_ge_3_in_10y", probability: 0, origin: "calculation" }],
    readings_context: [{ date: "2026-04-02", kind: "rainfall_mm", value: 0, depth_cm: null, origin: "grower", modeled_same_day: { gwettop: null, origin: "nasa_modeled" } }],
  });
  render(<ScenarioResults scenario={scenario} />);
  expect(screen.getAllByText("$0").length).toBeGreaterThan(1);
  expect(screen.getAllByText("0 days").length).toBeGreaterThan(1);
  expect(screen.getByText(/0% of historical replays included this event/)).toBeVisible();
  expect(screen.getAllByText("Not available").length).toBeGreaterThan(0);
  expect(screen.getByText("0 mm")).toBeInTheDocument();
});

it("shows farmer dots and a separate modeled line without converting or merging their units", () => {
  const { container } = render(<ScenarioResults scenario={currentExample} />);
  expect(screen.getByRole("img", { name: /Farmer soil moisture/ })).toBeVisible();
  expect(screen.getByRole("img", { name: /NASA modeled surface wetness/ })).toBeVisible();
  expect(container.querySelectorAll(".sim-grower-dot")).toHaveLength(3);
  expect(container.querySelectorAll(".sim-readings .sim-median-line")).toHaveLength(1);
  expect(screen.getByText("23.5 %")).toBeInTheDocument();
  expect(screen.getByText("0.41 wetness index")).toBeInTheDocument();
  expect(screen.queryByText("41 %")).not.toBeInTheDocument();
  expect(screen.getByText(/Readings do not change the simulation/)).toBeVisible();
});

it.each(originSchema.options)("keeps the exact %s origin label on supplied values", origin => {
  const scenario = scenarioSchema.parse({ ...currentExample, totals: { living_cover_days_per_year: { median: 123, origin } } });
  const { container } = render(<ScenarioResults scenario={scenario} />);
  const value = screen.getByText("123 days").closest("dd")!;
  expect(within(value).getByText(origin)).toHaveAttribute("data-origin", origin);
  if (origin === "ai_suggested" || origin === "source_checked") {
    expect(value.querySelector(".sim-origin-verified_source")).toBeNull();
    expect(container.textContent).not.toMatch(/AI.*verified/);
  }
});

it("shows missing provenance honestly and accepts a response with empty sections", () => {
  const scenario = scenarioSchema.parse({ scenario_id: "blank", label: "Blank plan", status: "unavailable", money_status: "unavailable", totals: { crop_families: 2 } });
  render(<ScenarioResults scenario={scenario} />);
  expect(screen.getAllByText("Origin not available").length).toBeGreaterThan(0);
  expect(screen.getByText(/No field readings were returned/)).toBeVisible();
  expect(screen.queryByText("$0")).not.toBeInTheDocument();
});

it.each(["null", "omitted"])("leaves %s years as gaps instead of connecting a median line through them", mode => {
  const yearly = mode === "omitted" ? currentExample.yearly.filter((_, index) => index !== 4) : currentExample.yearly.map((year, index) => index === 4 ? { ...year, money: null, indicators: { ...year.indicators, rain_on_bare_soil_mm: null } } : year);
  const scenario = scenarioSchema.parse({ ...currentExample, yearly });
  const { container } = render(<ScenarioResults scenario={scenario} />);
  expect(container.querySelectorAll(".sim-fan-chart .sim-median-line")).toHaveLength(4);
  expect(container.querySelectorAll(".sim-fan-chart .sim-fan-band")).toHaveLength(4);
});
