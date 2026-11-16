import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Dist, ScenarioResult } from "../../api/simModel";
import { PlainAnswer } from "./PlainAnswer";

const dist = (median: number | null, p10: number | null = median, p90: number | null = median, extra: Partial<Dist> = {}): Dist => ({ median, p10, p90, unit: null, currency: null, origin: "calculation", includesAssumption: null, ...extra });
const scenario = (totals: ScenarioResult["totals"], moneyGaps: string[] = []): ScenarioResult => ({
  scenarioId: "now", label: "What I do now", status: "complete", reasonText: null, timeline: [],
  yearly: Array.from({ length: 10 }, (_, i) => ({ year: 2027 + i, indicators: {}, money: null })),
  totals, events: [], moneyStatus: moneyGaps.length ? "partial" : "complete", moneyGaps, readingsContext: [],
});

describe("the result in three plain sentences", () => {
  it("restates the service's own figures and nothing else, in the grower's currency", () => {
    render(<PlainAnswer winter={false} s={scenario({ dry_springs: dist(2, 0, 4), rain_on_bare_soil_mm_per_year: dist(409), heavy_rain_days_on_bare_soil_per_year: dist(1), margin_10y: dist(4837336, 4778065, 4837336, { currency: "INR", origin: "assumed", includesAssumption: "dry_spring_pct" }) })} />);
    const text = screen.getByRole("region", { name: "In short" }).textContent!;
    expect(text).toContain("the weeks before planting were too dry in 2 of the 10 years");
    expect(text).not.toContain("spring"); // no winter here, so no spring
    expect(text).toContain("between 0 and 4");
    expect(text).toContain("About 409 mm of rain a year falls while the ground is bare");
    expect(text).toContain("on about 1 day a year");
    expect(text).toContain("₹483,734 a year");
    expect(text).toContain("₹4,837,336 over 10 years");
    expect(text).toContain("from ₹4,778,065 to ₹4,837,336");
    expect(screen.getByText("Uses your loss estimate")).toBeInTheDocument();
  });

  it("says spring where there is a winter, and that weather does not move a flat money figure", () => {
    render(<PlainAnswer winter s={scenario({ dry_springs: dist(0), margin_10y: dist(38264, 38264, 38264, { currency: "USD" }) })} />);
    const text = screen.getByRole("region", { name: "In short" }).textContent!;
    expect(text).toContain("the weeks before planting were not too dry in any of the 10 years");
    // Planting is not always in spring, so the season is not named.
    expect(text).not.toContain("in spring");
    expect(text).toContain("$3,826 a year");
    expect(text).toContain("Weather does not move this figure");
  });

  it("gives the service's reason when there is no money result, and a way back to prices", () => {
    const onPrices = vi.fn();
    render(<PlainAnswer winter={false} onPrices={onPrices} s={scenario({ dry_springs: dist(1) }, ["No costs for maize_second yet. Add your own to get a money result."])} />);
    expect(screen.getByRole("region", { name: "In short" }).textContent).toContain("No costs for maize, second season yet.");
    screen.getByRole("button", { name: "Add prices and costs" }).click();
    expect(onPrices).toHaveBeenCalled();
    expect(screen.queryByText(/a year for the whole field/)).toBeNull(); // no invented money figure
  });
});
