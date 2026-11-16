import { BadgeRow } from "./BadgeRow";
import { DeltaList } from "./DeltaList";
import type { SimulationResult } from "./schema";
import { COMPARISON_CAVEAT, EventOdds, OUTLOOK_NOTE, MarginSummary, MoneyContext, OriginLabel, ReasonText, SummaryMetric, readable } from "./shared";
import "./sim.css";

export interface ScenarioCompareProps {
  result: SimulationResult;
  baselineId: string;
  onChoose: (scenarioId: string) => void;
}
export function ScenarioCompare({ result, baselineId, onChoose }: ScenarioCompareProps) {
  const comparison = result.comparison;
  const labels = Object.fromEntries(result.scenarios.map(s => [s.scenario_id, s.label]));
  const baseline = result.scenarios.find(s => s.scenario_id === baselineId);
  const baselineMismatch = comparison?.baseline != null && comparison.baseline !== baselineId;
  return <section className="sim sim-compare" aria-label="Compare scenario plans">
    <header className="sim-section-heading"><div><h2>Compare your plans</h2><p className="sim-muted">10-year outlook · {readable(result.status)}</p></div>{result.example_label && <p className="sim-example">{result.example_label}</p>}</header>
    <p className="sim-honesty">{OUTLOOK_NOTE}</p>
    <div className="sim-caveat" role="note">{comparison?.caveat?.trim() || COMPARISON_CAVEAT}</div>
    {result.method && <p className="sim-method">{result.method.runs} runs use whole past seasons from {result.method.source_years}, in new orders.<OriginLabel origin={result.method.origin} /></p>}
    {result.reason_text && <p>{result.reason_text}</p>}{result.gaps.length > 0 && <ul>{result.gaps.map((gap, index) => <li key={index}><ReasonText reason={gap} /></li>)}</ul>}
    <BadgeRow badges={comparison?.badges ?? []} scenarioLabels={labels} notDecided={comparison?.not_decided ?? []} />
    {!baseline && <p className="sim-notice">The current plan is not in these results. Differences are shown only when the service supplied them for the selected current plan.</p>}
    {baselineMismatch && <p className="sim-notice">The service compared a different current plan. Request a new comparison to refresh the badges and trade-offs. Differences below use only entries matching your selected current plan.</p>}
    {!result.scenarios.length ? <p className="sim-card">Not available. No scenarios were returned.</p> : <div className="sim-compare-scroll" tabIndex={0} role="region" aria-label="Scenario columns; scroll horizontally to compare all plans"><div className="sim-compare-columns" style={{ gridTemplateColumns: `repeat(${Math.min(result.scenarios.length, 6)}, minmax(304px, 1fr))` }}>{result.scenarios.slice(0, 6).map(scenario => <article className={`sim-scenario-column ${scenario.scenario_id === baselineId ? "sim-baseline" : ""}`} key={scenario.scenario_id} aria-label={scenario.label}>
      <header><p className="sim-plan-role">{scenario.scenario_id === baselineId ? "Current plan" : "Alternative plan"}</p><h3>{scenario.label}</h3><p className="sim-muted">{readable(scenario.status)}</p>{scenario.example_label && !result.example_label && <p className="sim-example">{scenario.example_label}</p>}</header>
      <MarginSummary margin={scenario.totals?.margin_10y} />
      <MoneyContext scenario={scenario} />
      <section><h4>Soil, water, and field work</h4><dl className="sim-metrics"><SummaryMetric label="Living cover per year" value={scenario.totals?.living_cover_days_per_year} unit="days" caption="Typical days with a living crop each year." /><SummaryMetric label="Rain on bare soil per year" value={scenario.totals?.rain_on_bare_soil_mm_per_year} unit="mm" caption="Rain falling without living cover; not measured runoff." /><SummaryMetric label="Crop families" value={scenario.totals?.crop_families} origin={scenario.totals?.origins?.crop_families} caption="Plant families represented in this rotation." /><SummaryMetric label="Field operations per year" value={scenario.totals?.operations_per_year} origin={scenario.totals?.origins?.operations_per_year} caption="Average field passes each year in this plan." /></dl></section>
      <section><h4>Weather risk</h4><EventOdds events={scenario.events} /></section>
      <DeltaList deltas={comparison?.deltas ?? []} scenarioId={scenario.scenario_id} baselineId={baselineId} baselineLabel={baseline?.label ?? "current plan"} />
      <section><h4>Trade-offs to consider</h4>{comparison?.trade_offs.some(item => item.scenario_id === scenario.scenario_id) ? <ul>{comparison.trade_offs.filter(item => item.scenario_id === scenario.scenario_id).map((item, index) => <li key={index}>{item.text}<OriginLabel origin={item.origin} /></li>)}</ul> : <p className="sim-muted">Not available. No trade-offs were returned for this plan.</p>}</section>
      {scenario.reason_text && <p>{scenario.reason_text}</p>}
      <button type="button" className="sim-button" onClick={() => onChoose(scenario.scenario_id)} aria-label={`Choose this plan: ${scenario.label}`}>Choose this plan</button>
    </article>)}</div></div>}
  </section>;
}
