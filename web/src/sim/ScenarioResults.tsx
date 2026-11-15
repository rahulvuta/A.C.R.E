import type { Scenario } from "./schema";
import { FanChart, ReadingsContext, chartMoneyUnit } from "./charts";
import { EventOdds, HISTORY_NOTE, MarginSummary, MoneyContext, SummaryMetric, Value, readable } from "./shared";
import "./sim.css";

export interface ScenarioResultsProps { scenario: Scenario }
export function ScenarioResults({ scenario }: ScenarioResultsProps) {
  const marginRows = scenario.yearly.map(year => ({ year: year.year, distribution: year.money?.margin }));
  return <section className="sim sim-results" aria-label={`Simulation results for ${scenario.label}`}>
    <header className="sim-section-heading"><div><h2>{scenario.label}</h2><p className="sim-muted">Historical simulation · {readable(scenario.status)}</p></div>{scenario.example_label && <p className="sim-example">{scenario.example_label}</p>}</header>
    <p className="sim-honesty">{HISTORY_NOTE}</p>{scenario.reason_text && <p>{scenario.reason_text}</p>}
    <div className="sim-results-summary"><section className="sim-card"><MarginSummary margin={scenario.totals?.margin_10y} /><MoneyContext scenario={scenario} /></section><section className="sim-card"><h3>Soil cover and water exposure</h3><dl className="sim-metrics"><SummaryMetric label="Living cover per year" value={scenario.totals?.living_cover_days_per_year} unit="days" caption="Typical days each year with a living crop on the field." /><SummaryMetric label="Rain on bare soil per year" value={scenario.totals?.rain_on_bare_soil_mm_per_year} unit="mm" caption="Typical yearly rain falling while the plan has no living cover; this is not measured runoff." /></dl></section></div>
    <div className="sim-chart-grid"><FanChart title="Annual margin by year" caption="Each year shows money left after the costs included in the plan; these are annual values, not running totals." rows={marginRows} unit={chartMoneyUnit(marginRows)} money /><FanChart title="Rain on bare soil by year" caption="Each year shows rain falling while the plan has no living cover, in millimetres." rows={scenario.yearly.map(year => ({ year: year.year, distribution: year.indicators.rain_on_bare_soil_mm }))} unit="mm" /></div>
    <div className="sim-chart-grid"><section className="sim-card"><h3>Living cover by year</h3><p>These are the median days with a living crop in each simulated year.</p><div className="sim-table-scroll"><table><caption>Annual living cover returned by the simulation service</caption><thead><tr><th scope="col">Year</th><th scope="col">Living cover</th></tr></thead><tbody>{scenario.yearly.map(year => <tr key={year.year}><th scope="row">{year.year}</th><td><Value value={year.indicators.living_cover_days?.median} unit={year.indicators.living_cover_days?.unit ?? "days"} origin={year.indicators.living_cover_days?.origin} /></td></tr>)}</tbody></table></div>{!scenario.yearly.length && <p>Not available. No yearly cover values were returned.</p>}</section><section className="sim-card"><h3>How often stress events appeared</h3><p>Odds count historical replays containing each event; they do not predict the next season.</p><EventOdds events={scenario.events} /></section></div>
    <ReadingsContext readings={scenario.readings_context} />
  </section>;
}
