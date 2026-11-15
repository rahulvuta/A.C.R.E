import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FieldPlan } from "../farm/types";
import request from "./fixtures/simulate-union.request.json";
import response from "./fixtures/simulate-union.json";
import { MiniTimeline, planCrops, TenYearTimeline, TimelineCompare, withRotations, type ScenarioResult } from "./index";

const scenarios = withRotations(
  response as unknown as { scenarios: ScenarioResult[] },
  request as unknown as { scenarios: Array<{ scenario_id: string; rotation: FieldPlan[]; is_baseline?: boolean }> },
);
const rowsOf = () => screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-year"));
const rowFor = (year: number) => rowsOf().find((li) => li.getAttribute("data-year") === String(year))!;

describe("TenYearTimeline (U4)", () => {
  it("one row per year with the crops and dates in words, and the 10-year margin", () => {
    render(<TenYearTimeline scenario={scenarios[1]!} />);
    expect(rowsOf()).toHaveLength(10);
    expect(rowFor(2027).getAttribute("aria-label")).toMatch(
      /^2027: Cereal rye \(cover\) ended Apr 30; Soybean planted May 12, harvested Oct 25; Crimson clover \(cover\) seeded Oct 30\./,
    );
    expect(screen.getByText("10-year margin, median")).toBeInTheDocument();
    expect(screen.getByText(/not a forecast/)).toBeInTheDocument();
  });

  it("hover or focus shows the year's margin median", () => {
    render(<TenYearTimeline scenario={scenarios[0]!} />);
    fireEvent.focus(rowFor(2028));
    const tip = screen.getByRole("tooltip");
    const y = scenarios[0]!.yearly.find((r) => r.year === 2028)!;
    expect(within(tip).getByText("Margin (median)")).toBeInTheDocument();
    expect(tip.textContent).toContain("$" + y.money!.margin!.median!.toLocaleString("en-US"));
  });

  it("a missing margin says Not available, never $0", () => {
    const s = structuredClone(scenarios[0]!);
    s.yearly[0]!.money = null;
    render(<TenYearTimeline scenario={s} />);
    fireEvent.focus(rowFor(2027));
    expect(within(screen.getByRole("tooltip")).getByText("Not available")).toBeInTheDocument();
  });

  it("risk dots appear only where the odds reach the threshold", () => {
    const { container } = render(<TenYearTimeline scenario={scenarios[0]!} riskAt={0.3} />);
    const expected = scenarios[0]!.yearly.filter(
      (y) => Math.max(y.indicators!.dry_pre_plant!.probability!, y.indicators!.heavy_rain_at_planting!.probability!) >= 0.3,
    ).length;
    expect(container.querySelectorAll(".tl-rows .tl-risk")).toHaveLength(expected);
  });
});

describe("TimelineCompare (U4)", () => {
  it("one lane per scenario on one axis, the current plan marked", () => {
    const { container } = render(<TimelineCompare scenarios={scenarios} />);
    expect(container.querySelectorAll(".tl-lane[data-scenario]")).toHaveLength(3);
    expect(screen.getByText("Your current plan").closest(".tl-lane")!.getAttribute("data-scenario")).toBe("current");
    expect(container.querySelectorAll(".tl-cell")).toHaveLength(30);
  });
});

describe("MiniTimeline", () => {
  it("names the plan's crops and draws its year", () => {
    const plan = (request.scenarios[1]!.rotation as unknown as FieldPlan[])[0]!;
    expect(planCrops(plan)).toBe("Corn → cereal rye (cover) → soybean");
    expect(planCrops(null)).toBe("No crops yet");
    render(<MiniTimeline plan={plan} year={2027} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/Soybean planted May 12/);
  });
});
