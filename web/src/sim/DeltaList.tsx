import type { DeltaChange, ScenarioDelta } from "./schema";
import { formatMoney, formatNumber, OriginLabel, readable } from "./shared";
import "./sim.css";

export interface DeltaListProps {
  deltas: ScenarioDelta[];
  scenarioId: string;
  baselineId: string;
  baselineLabel?: string;
}
function deltaText(change: DeltaChange) {
  if (change.text) return change.text;
  if (change.median_delta == null) return `${readable(change.indicator)}: Not available`;
  const sign = change.median_delta > 0 ? "+" : "";
  if (change.indicator === "margin_10y") return `${sign}${formatMoney(change.median_delta, change.currency)} over 10 years (median)`;
  return `${readable(change.indicator)}: ${sign}${formatNumber(change.median_delta)}${change.unit ? ` ${change.unit}` : ""} compared with the current plan`;
}
export function DeltaList({ deltas, scenarioId, baselineId, baselineLabel = "current plan" }: DeltaListProps) {
  const changes = deltas.filter(delta => delta.scenario_id === scenarioId && delta.versus === baselineId).flatMap(delta => delta.changes);
  return <div className="sim sim-deltas"><h4>Compared with {baselineLabel}</h4>{scenarioId === baselineId ? <p>This is the current plan used for comparison.</p> : changes.length ? <ul>{changes.map((change, index) => <li key={`${change.indicator}-${index}`}>{deltaText(change)}<OriginLabel origin={change.origin} /></li>)}</ul> : <p className="sim-muted">Not available. No differences were returned for this current plan.</p>}</div>;
}
