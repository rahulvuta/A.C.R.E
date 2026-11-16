import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Dist, ScenarioResult } from "../../api/simModel";
import { PlainAnswer } from "./PlainAnswer";

const dist = (median: number | null, p10: number | null = median, p90: number | null = median, extra: Partial<Dist> = {}): Dist => ({ median, p10, p90, unit: null, currency: null, origin: "calculation", includesAssumption: null, ...extra });
const scenario = (totals: ScenarioResult["totals"], moneyGaps: string[] = []): ScenarioResult => ({
  scenarioId: "now", label: "What I do now", status: "complete", reasonText: null, timeline: [],
  yearly: Array.from({ length: 10 }, (_, i) => ({ year: 2027 + i, indicators: {}, money: null })),
  totals, events: [], moneyStatus: moneyGaps.length ? "partial" : "complete", moneyGaps, readingsContext: [],
});

describe("the result as three figures", () => {
  it("shows the service's own figures and nothing else, in the grower's currency", () => {
    render(<PlainAnswer winter={false} s={scenario({ dry_springs: dist(2, 0, 4), rain_on_bare_soil_mm_per_year: dist(409), heavy_rain_days_on_bare_soil_per_year: dist(1), margin_10y: dist(4837336, 4778065, 4837336, { currency: "INR", origin: "assumed", includesAssumption: "dry_spring_pct" }) })} />);
    const box = screen.getByRole("region", { name: "In short" });
    const [dry, rain, money] = within(box).getAllByRole("listitem");
    // one figure, a few words, at most one small line more
    expect(dry).toHaveTextContent("2 of 10");
    expect(dry).toHaveTextContent("years too dry before planting");
    expect(dry).toHaveTextContent("0 to 4 across the runs");
    expect(dry!.querySelectorAll('.pa-dots i')).toHaveLength(10);
    expect(dry!.querySelectorAll('.pa-dots i[data-on="yes"]')).toHaveLength(2);
    expect(rain).toHaveTextContent("409 mm");
    expect(rain).toHaveTextContent("of rain a year on bare ground");
    expect(rain).toHaveTextContent("Heavy rain on about 1 day a year");
    expect(money).toHaveTextContent("₹483,734");
    expect(money).toHaveTextContent("a year left after costs");
    expect(money).toHaveTextContent("10 years: ₹4,778,065 to ₹4,837,336");
    expect(screen.getByText("Uses your loss estimate")).toBeInTheDocument();
    // the full sentence is still there for a screen reader and for the shared page
    expect(dry).toHaveAccessibleName(/the weeks before planting were too dry in 2 of the 10 years/);
    expect(box.textContent).not.toContain("spring"); // no winter here, so no spring
  });

  it("shows a flat money figure without a range, and no dry years as none filled", () => {
    render(<PlainAnswer winter s={scenario({ dry_springs: dist(0), margin_10y: dist(38264, 38264, 38264, { currency: "USD" }) })} />);
    const box = screen.getByRole("region", { name: "In short" });
    const [dry, money] = within(box).getAllByRole("listitem");
    expect(dry).toHaveTextContent("0 of 10");
    expect(dry!.querySelectorAll('.pa-dots i[data-on="yes"]')).toHaveLength(0);
    expect(money).toHaveTextContent("$3,826");
    expect(money).toHaveTextContent("10 years: $38,264");
    // why the figure does not move is in the sentence a screen reader and the shared page get
    expect(money).toHaveAccessibleName(/Weather does not move this figure/);
  });

  it("gives the service's reason when there is no money result, and a way back to prices", () => {
    const onPrices = vi.fn();
    render(<PlainAnswer winter={false} onPrices={onPrices} s={scenario({ dry_springs: dist(1) }, ["No costs for maize_second yet. Add your own to get a money result."])} />);
    expect(screen.getByRole("region", { name: "In short" }).textContent).toContain("No costs for maize, second season yet.");
    screen.getByRole("button", { name: "Add prices and costs" }).click();
    expect(onPrices).toHaveBeenCalled();
    expect(screen.queryByText(/a year left after costs/)).toBeNull(); // no invented money figure
  });

  it("writes the paragraph in words only when it is asked for", () => {
    render(<PlainAnswer winter={false} explain={{ crops: ["maize"] }} s={scenario({ dry_springs: dist(1) })} />);
    expect(screen.getByText("Say it in words")).toBeInTheDocument();
    expect(screen.queryByText(/Written by AI/)).toBeNull();
  });
});
