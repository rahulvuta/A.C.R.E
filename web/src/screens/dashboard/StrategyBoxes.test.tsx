import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptSimulation, BackendSimulation } from "../../api/adapt";
import type { Option } from "../../api/model";
import type { Scenario } from "../../api/simModel";
import type { FieldPlan } from "../../farm/types";
import { badgeLabels } from "../../sim/BadgeRow";
import { BADGE_LABEL } from "../guided/format";
import { buildBoxes, decisionSummary, monthlyOf, pickSuggestions, StrategyBox, VerdictRow } from "./StrategyBoxes";

// SYNTHETIC FIXTURE: invented numbers in the backend's response shape, used only to test rendering.
const dist = (p10: number, median: number, p90: number) => ({ p10, median, p90, currency: "USD", origin: "calculation" });
const year = (y: number) => ({ year: y, indicators: {}, money: { revenue: dist(500, 1000, 1500), costs: dist(300, 400, 500), margin: dist(0, 600, 1200) } });
const months = [
  { month: "2027-05", costs: dist(300, 400, 500), revenue: dist(0, 0, 0), net: dist(-500, -400, -300), cumulative_net: dist(-500, -400, -300), operations: [{ kind: "plant", crop_id: "soybean" }], risks: [{ kind: "dry_pre_plant", probability: 0.2, text: "Dry 30 days before planting in 20% of replays" }] },
  { month: "2027-06", costs: dist(0, 0, 0), revenue: dist(0, 0, 0), net: dist(0, 0, 0), cumulative_net: dist(-500, -400, -300), operations: [], risks: [] },
  { month: "2027-10", costs: dist(0, 0, 0), revenue: dist(500, 1000, 1500), net: dist(500, 1000, 1500), cumulative_net: dist(0, 600, 1200), operations: [{ kind: "harvest", crop_id: "soybean" }], risks: [] },
];
const scenario = (id: string, label: string, complete: boolean) => ({
  scenario_id: id, label, status: "complete", timeline: [], yearly: [2027, 2028, 2029, 2030, 2031].map(year),
  totals: { margin_10y: dist(1000, 3000, 5000), costs_total: dist(2000, 2000, 2000), revenue_total: dist(4000, 5000, 6000), margin_per_area_per_year: { p10: 100, median: 240, p90: 380, currency: "USD", area_unit: "acre", origin: "calculation" } }, events: [], money_status: complete ? "complete" : "partial",
  money_gaps: complete ? [] : [{ text: "No price for soybean yet." }], readings_context: [],
  monthly: complete ? { currency: "USD", origin: "calculation", timing_origin: "assumed", timing_text: "Costs are counted in the planting month.", includes_assumption: "dry_spring_pct", funding_gap: { p10: 200, median: 400, p90: 500, currency: "USD", origin: "calculation", deepest_month: "2027-05", text: "Out of pocket most in May 2027." }, break_even_month: "2027-10", months } : null,
});
const raw = {
  status: "complete", method: { weather: "historical_resampling", runs: 200, seed: 7, source_years: "1981–2025", note: "An evidence-based outlook: this field's real past seasons (1981-2025) replayed in new orders over the next 10 seasons. Rain is adjusted for the trend observed in this record. It shows what to plan for under conditions seen here; it cannot say what any single year will bring." },
  scenarios: [scenario("current", "What I do now", true), scenario("alt1", "Soy first", false)],
  crop_money: { soybean: { crop_id: "soybean", status: "complete", currency: "USD", price: { low: 9, typical: 11, high: 13, origin: "grower" }, yield_per_area: { value: 50, area_unit: "acre", origin: "grower" }, costs_per_area: { value: 420, area_unit: "acre", origin: "verified_source" } }, corn: { crop_id: "corn", status: "partial", currency: "USD", price: null, yield_per_area: null, costs_per_area: { value: null, area_unit: "acre", origin: null } } },
  comparison: { baseline: "current", badges: [{ badge: "best_profit", scenario_id: "current", why: "Most money in a typical run" }], deltas: [{ scenario_id: "alt1", versus: "current", changes: [{ indicator: "margin_10y", median_delta: 4200, currency: "USD", text: "More crop margin." }] }], trade_offs: [{ scenario_id: "alt1", text: "Holds up best in dry springs" }], not_decided: [], caveat: "The stronger of the plans you compared, given these numbers and the conditions seen at this field. An evidence-based outlook, not a guarantee." },
};
const data = adaptSimulation(BackendSimulation.parse(raw));
const mk = (id: string, label: string, isBaseline = false): Scenario => ({ scenarioId: id, label, isBaseline, rotation: [], from: isBaseline ? "current" : "suggested" });
const boxes = buildBoxes(mk("current", "What I do now", true), [mk("alt1", "Soy first")], data);
const withRotation = (sc: Scenario): Scenario => ({ ...sc, rotation: [{ plan_id: "p1", previous_crop_id: "corn", next_crop_id: "soybean", prev_harvest: "09-20", next_plant: "05-01", winter: { kind: "cover", crop_id: "rye", seed: "10-01", terminate: "04-15" } }] });
const boxFor = (d: typeof data, id: string, isBaseline: boolean) => buildBoxes(withRotation(mk("current", "What I do now", true)), [withRotation(mk(id, "Soy first"))], d)[isBaseline ? 0 : 1]!;
const complete = (id: string, over: Record<string, unknown> = {}, monthlyOver: Record<string, unknown> = {}) => { const sc = scenario(id, "Soy first", true); return { ...sc, ...over, totals: { ...sc.totals, ...((over.totals as object) ?? {}) }, monthly: { ...sc.monthly!, ...monthlyOver } }; };
const adapt = (scenarios: unknown[], extra: Record<string, unknown> = {}) => adaptSimulation(BackendSimulation.parse({ ...raw, ...extra, scenarios }));
const renderBox = (b: ReturnType<typeof boxFor>) => render(<StrategyBox box={b} badges={[]} highlight={false} waiting={false} onTab={() => {}} />);

afterEach(cleanup);

const plan = (id: string, crop: string): FieldPlan => ({ plan_id: id, previous_crop_id: "corn", next_crop_id: crop, prev_harvest: "09-20", next_plant: "05-01", winter: { kind: "none" } });
const option = (id: string, label: string, crop: string) => ({ candidateId: id, label, origin: "calculation", plans: [{ plan_id: `${id}_1`, previous_crop_id: "corn", next_crop_id: crop, prev_harvest: "09-20", next_plant: "05-01", winter: { kind: "none" } }] }) as unknown as Option;

describe("strategy boxes", () => {
  it("reads the month block from the raw response and leaves a missing one null", () => {
    expect(monthlyOf(data.raw, "current")?.months).toHaveLength(3);
    expect(monthlyOf(data.raw, "alt1")).toBeNull();
  });

  it("shows the crop margin, the bad-to-good range, and spent and sold over 10 years with their origin", () => {
    render(<StrategyBox box={boxes[0]!} badges={[]} highlight={false} waiting={false} onTab={() => {}} />);
    const money = screen.getByRole("group", { name: "Money over 10 years" });
    expect(money.textContent).toContain("Spent $2,000 · Sold $5,000 over 10 years"); // backend costs_total and revenue_total medians
    expect(within(money).getByText("Expected crop margin over 10 years").nextSibling?.textContent).toBe("$3,000");
    expect(money.textContent).toContain("Bad years $1,000");
    expect(money.textContent).toContain("good years $5,000");
    expect(money.textContent).toContain("assumed");
    expect(within(money).getAllByText("calculation").length).toBeGreaterThan(0);
  });

  it("charts the months with a risk list, operations in text and the timing note tagged assumed", () => {
    render(<StrategyBox box={boxes[0]!} badges={[]} highlight={false} waiting={false} onTab={() => {}} />);
    expect(screen.getByRole("img", { name: /Costs are drawn below the zero line/ })).toBeInTheDocument();
    const risks = screen.getByRole("list", { name: "Months with weather risk" });
    expect(risks.textContent).toContain("Dry 30 days before planting in 20% of replays");
    expect(screen.getAllByText(/Costs are counted in the planting month/).length).toBeGreaterThan(0);
    fireEvent.focus(screen.getByLabelText(/May 2027: Dry 30 days/));
    expect(document.querySelector(".sb-detail")?.textContent).toMatch(/May 2027.*Plant soybean/);
  });

  it("an empty box prompts for a suggested plan and opens Recommendations", () => {
    const onTab = vi.fn();
    render(<StrategyBox box={boxes[2]!} badges={[]} highlight={false} waiting={false} onTab={onTab} />);
    expect(screen.getByText("Pick a suggested plan to compare.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Recommendations" }));
    expect(onTab).toHaveBeenCalledWith("recommendations");
  });

  it("shows the gap text and a Financial Analysis button, no numbers, when money is not complete", () => {
    const onTab = vi.fn();
    render(<StrategyBox box={boxes[1]!} badges={[]} highlight={false} waiting={false} onTab={onTab} />);
    expect(screen.getByText("No price for soybean yet.")).toBeInTheDocument();
    expect(screen.queryByText("Spent")).toBeNull();
    expect(screen.queryByText(/\$0\b/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Financial Analysis" }));
    expect(onTab).toHaveBeenCalledWith("financial");
  });

  it("the verdict row prints only the backend's badge and trade-off sentences", () => {
    render(<VerdictRow boxes={boxes} data={data} />);
    expect(screen.getByText("Most money in a typical run")).toBeInTheDocument();
    expect(screen.getByText("Holds up best in dry springs")).toBeInTheDocument();
  });

  it("suggestions skip a plan equal to the current one, keep the backend order and are labelled", () => {
    const current = [plan("c1", "soybean")];
    const picks = pickSuggestions([option("a", "Same as now", "soybean"), option("b", "Corn after corn", "corn"), option("c", "Corn again", "corn"), option("d", "Wheat", "wheat")], current, [], 2);
    expect(picks.map((p) => p.scenario.label)).toEqual(["Corn after corn", "Wheat"]);
    expect(picks[0]!.scenario.from).toBe("suggested");
  });

  it("a suggested box says so, offers Add to my plans, and a flat range asks for a loss estimate", () => {
    const onAdd = vi.fn();
    const onTab = vi.fn();
    const flat = adaptSimulation(BackendSimulation.parse({ ...raw, scenarios: [{ ...scenario("current", "What I do now", true), totals: { margin_10y: dist(3000, 3000, 3000), costs_total: dist(2000, 2000, 2000), revenue_total: dist(5000, 5000, 5000) } }, scenario("sug_x", "Soy first", true)] }));
    const bs = buildBoxes(mk("current", "What I do now", true), [mk("sug_x", "Soy first")], flat, { sug_x: "calculation" });
    render(<StrategyBox box={bs[1]!} badges={[]} highlight={false} waiting={false} onTab={onTab} onAdd={onAdd} />);
    expect(screen.getByRole("heading", { name: "Suggested: Soy first" })).toBeInTheDocument();
    expect(screen.getByText(/Suggested by the plan finder for this location and your priorities\. It was not chosen for margin; the margin comparison is below\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to my plans" }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ scenarioId: "sug_x" }));
    cleanup();
    render(<StrategyBox box={bs[0]!} badges={[]} highlight={false} waiting={false} onTab={onTab} />);
    expect(screen.getByText(/Same in every simulated year/)).toBeInTheDocument();
    expect(screen.queryByText(/Bad years/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a loss estimate" }));
    expect(onTab).toHaveBeenCalledWith("financial");
  });

  it("the decision summary is the backend's badge sentence with the plan's name", () => {
    expect(decisionSummary(boxes, data)).toEqual(["What I do now: Most money in a typical run"]);
  });

  it("shades only months whose top risk is at least 10%, but lists every risk", () => {
    const low = { ...scenario("current", "What I do now", true), monthly: { ...scenario("current", "x", true).monthly!, months: [{ ...months[0]!, risks: [{ kind: "heavy_rain_on_bare_soil", probability: 0.05, text: "Heavy rain on bare soil in 5% of replays" }] }, months[1]!] } };
    const d = adaptSimulation(BackendSimulation.parse({ ...raw, scenarios: [low] }));
    const b = buildBoxes(mk("current", "What I do now", true), [], d);
    const { container } = render(<StrategyBox box={b[0]!} badges={[]} highlight={false} waiting={false} onTab={() => {}} />);
    expect(container.querySelectorAll(".sb-risk")).toHaveLength(0);
    expect(screen.getByRole("list", { name: "Months with weather risk" }).textContent).toContain("5% of replays");
  });

  it("leads with the margin per acre per year, the funding gap with its month, the break-even month and the signed difference versus the current plan", () => {
    const d = adapt([complete("current"), complete("alt1")]);
    renderBox(boxFor(d, "alt1", false));
    const money = screen.getByRole("group", { name: "Money over 10 years" });
    expect(within(money).getByText("Expected crop margin per acre per year").nextSibling?.textContent).toBe("$240");
    expect(within(money).getByText("Compared with what I do now").nextSibling?.textContent).toBe("+$4,200");
    expect(money.textContent).toContain("more crop margin over 10 years");
    expect(within(money).getByText("Largest funding gap").nextSibling?.textContent).toBe("$400");
    expect(money.textContent).toContain("in May 2027");
    expect(within(money).getByText("Back above zero from").nextSibling?.textContent).toBe("Oct 2027");
    cleanup();
    renderBox(boxFor(d, "alt1", true));
    expect(screen.getByText("This is your current plan")).toBeInTheDocument();
  });

  it("shows a negative difference with a minus sign and the word less", () => {
    const d = adapt([complete("current"), complete("alt1")], { comparison: { ...raw.comparison, deltas: [{ scenario_id: "alt1", versus: "current", changes: [{ indicator: "margin_10y", median_delta: -1300, currency: "USD", text: "" }] }] } });
    renderBox(boxFor(d, "alt1", false));
    const money = screen.getByRole("group", { name: "Money over 10 years" });
    expect(within(money).getByText("Compared with what I do now").nextSibling?.textContent).toBe("\u2212$1,300");
    expect(money.textContent).toContain("less crop margin");
  });

  it("an older response without the new fields omits those tiles, says Not available for the difference, and does not throw", () => {
    const { margin_per_area_per_year: _a, ...totals } = complete("alt1").totals; // eslint-disable-line @typescript-eslint/no-unused-vars
    const { funding_gap: _b, break_even_month: _c, ...monthly } = complete("alt1").monthly; // eslint-disable-line @typescript-eslint/no-unused-vars
    const { crop_money: _d, ...older } = raw; // eslint-disable-line @typescript-eslint/no-unused-vars
    const d = adaptSimulation(BackendSimulation.parse({ ...older, comparison: { ...raw.comparison, deltas: [] }, scenarios: [complete("current"), { ...complete("alt1"), totals, monthly }] }));
    renderBox(boxFor(d, "alt1", false));
    const money = screen.getByRole("group", { name: "Money over 10 years" });
    expect(within(money).queryByText(/Crop margin per/)).toBeNull();
    expect(within(money).queryByText("Largest funding gap")).toBeNull();
    expect(within(money).queryByText("Back above zero from")).toBeNull();
    expect(within(money).getByText("Compared with what I do now").nextSibling?.textContent).toBe("Not available");
    expect(within(money).getByText("Expected crop margin over 10 years")).toBeInTheDocument();
    expect(screen.queryByText("Costs counted per crop")).toBeNull();
  });

  it("a funding gap of 0 says none, and a null break-even month says not within these 10 years", () => {
    const d = adapt([complete("current"), complete("alt1", {}, { funding_gap: { median: 0, p10: 0, p90: 0, currency: "USD", origin: "calculation", deepest_month: null, text: "" }, break_even_month: null })]);
    renderBox(boxFor(d, "alt1", false));
    expect(screen.getByText("None: the running total never goes below zero")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Money over 10 years" })).getByText("Back above zero from").nextSibling?.textContent).toBe("Not within these 10 years");
  });

  it("marks the month of the largest funding gap on the chart and in its hover text", () => {
    const d = adapt([complete("current"), complete("alt1")]);
    const { container } = renderBox(boxFor(d, "alt1", false));
    expect(container.querySelectorAll(".sb-gap-dot")).toHaveLength(1);
    expect(screen.getByRole("img", { name: /May 2027, is marked/ })).toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText(/May 2027: .*Largest funding gap/));
    expect(document.querySelector(".sb-detail")?.textContent).toMatch(/running total.*Largest funding gap/);
    expect(container.textContent).not.toMatch(/running net/i);
  });

  it("never says profit in a strategy box except in 'not whole-farm profit'", () => {
    const d = adapt([complete("current"), complete("alt1")]);
    const { container } = renderBox(boxFor(d, "alt1", false));
    expect((container.textContent ?? "").replace(/not whole-farm profit/gi, "")).not.toMatch(/profit/i);
  });

  it("defines the terms and lists the costs counted for each crop in the rotation with their origin", () => {
    const d = adapt([complete("current"), complete("alt1")]);
    renderBox(boxFor(d, "alt1", false));
    const details = screen.getByText("What these numbers mean").closest("details")!;
    expect(details.textContent).toContain("It is not whole-farm profit");
    expect(within(details).getByText("Running total")).toBeInTheDocument();
    const table = within(details).getByRole("table", { name: "Costs counted per crop" });
    const row = (crop: string) => within(table).getByRole("rowheader", { name: crop }).closest("tr")!;
    expect(row("Soybean").textContent).toContain("$420 per acre");
    expect(row("Soybean").querySelector("[data-origin]")?.getAttribute("data-origin")).toBe("verified_source");
    expect(row("Corn").textContent).toContain("Not available");
    expect(row("Rye").textContent).toContain("Not available"); // a crop the backend sent nothing for
    expect(within(details).getByText(/total listed cost per acre/)).toBeInTheDocument();
  });

  it("the best-margin badge says it is the highest estimate of these plans, not the best plan", () => {
    expect(badgeLabels.best_profit).toBe("Highest estimated margin of these plans");
    expect(BADGE_LABEL.best_profit).toBe("Highest estimated margin of these plans");
  });
});
