import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BadgeRow } from "./BadgeRow";
import { DeltaList } from "./DeltaList";
import { ScenarioCompare } from "./ScenarioCompare";
import { currentExample, partialSimulationExample, simulationExample } from "./fixtures";
import { simulationResultSchema } from "./schema";
import { COMPARISON_CAVEAT } from "./shared";

afterEach(cleanup);

it("renders returned badges, why, indicators, deltas, trade-offs, and choice callbacks", () => {
  const onChoose = vi.fn();
  const { container } = render(<ScenarioCompare result={simulationExample} baselineId="current" onChoose={onChoose} />);
  for (const badge of ["Highest estimated margin of these plans", "Most sustainable", "Lowest weather risk", "Best for your priorities"]) expect(screen.getByRole("heading", { name: badge })).toBeVisible();
  expect(screen.getByText(/Highest median 10-year margin/)).toBeVisible();
  const rye = screen.getByRole("article", { name: "Add cereal rye" });
  expect(within(rye).getByText("$142,000")).toBeVisible();
  expect(within(rye).getByText("242 days")).toBeVisible();
  expect(within(rye).getByText("163 mm")).toBeVisible();
  expect(within(rye).getByText("+$11,000 over 10 years (median)")).toBeVisible();
  expect(within(rye).getByText(/one extra field operation each year/)).toBeVisible();
  fireEvent.click(within(rye).getByRole("button", { name: /Choose this plan/ }));
  expect(onChoose).toHaveBeenCalledTimes(1);
  expect(onChoose).toHaveBeenCalledWith("rye");
  expect(screen.getByText(COMPARISON_CAVEAT)).toBeVisible();
  expect(container.textContent).not.toMatch(/\bscore\b/i);
});

it("displays not_decided reasons and never invents omitted badges for partial money", () => {
  render(<ScenarioCompare result={partialSimulationExample} baselineId="current" onChoose={vi.fn()} />);
  expect(screen.queryByRole("heading", { name: "Highest estimated margin of these plans" })).not.toBeInTheDocument();
  expect(screen.getByText(/Clover price and harvest cost are missing/)).toBeVisible();
  const diverse = screen.getByRole("article", { name: "Add wheat and clover" });
  expect(within(diverse).queryByText("$0")).not.toBeInTheDocument();
  expect(within(diverse).getAllByText("Not available")).toHaveLength(3);
});

it("renders six scenarios without turning a server score into a displayed metric", () => {
  const result = simulationResultSchema.parse({ ...simulationExample, scenarios: Array.from({ length: 6 }, (_, index) => ({ ...currentExample, scenario_id: `s${index}`, label: `Plan ${index}`, score: 987654321 })), comparison: null });
  const { container } = render(<ScenarioCompare result={result} baselineId="s0" onChoose={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: /Choose this plan/ })).toHaveLength(6);
  expect(container.textContent).not.toMatch(/score|987654321/i);
});

it("keeps the caveat visible even with an unavailable or empty comparison", () => {
  const result = simulationResultSchema.parse({ status: "unavailable", scenarios: [], comparison: { caveat: " " } });
  render(<ScenarioCompare result={result} baselineId="current" onChoose={vi.fn()} />);
  expect(screen.getByText(COMPARISON_CAVEAT)).toBeVisible();
  expect(screen.getByText(/No scenarios were returned/)).toBeVisible();
});

it("uses only deltas for the requested baseline without calculating replacements", () => {
  render(<DeltaList deltas={simulationExample.comparison!.deltas} scenarioId="rye" baselineId="another" />);
  expect(screen.queryByText(/\+\$11,000/)).not.toBeInTheDocument();
  expect(screen.getByText(/No differences were returned/)).toBeVisible();
});

it("formats supplied zero and null deltas without treating a blank as zero", () => {
  render(<DeltaList scenarioId="s2" baselineId="current" deltas={[{ scenario_id: "s2", versus: "current", changes: [{ indicator: "margin_10y", median_delta: 0, currency: "USD", origin: "calculation" }, { indicator: "living_cover_days", median_delta: null, origin: "calculation" }] }]} />);
  expect(screen.getByText("$0 over 10 years (median)")).toBeVisible();
  expect(screen.getByText("living cover days: Not available")).toBeVisible();
});

it("can render standalone per-plan badges and keeps AI suggestions separate from verified sources", () => {
  const { container } = render(<BadgeRow scenarioId="rye" badges={[{ badge: "best_for_priorities", scenario_id: "rye", why: "Example AI reasoning", origin: "ai_suggested" }, { badge: "most_sustainable", scenario_id: "other", why: "Other plan", origin: "verified_source" }]} />);
  expect(screen.getByText("Example AI reasoning")).toBeVisible();
  expect(screen.getByText("AI suggestion, not verified")).toHaveClass("sim-origin-ai_suggested");
  expect(container.querySelector(".sim-origin-verified_source")).not.toBeInTheDocument();
  expect(screen.queryByText("Other plan")).not.toBeInTheDocument();
});
