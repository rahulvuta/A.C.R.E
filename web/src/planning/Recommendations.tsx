import { useState } from "react";
import { recommendPlans, type PlanningField, type Goals, type PlanningLocation, type RecommendRequest, type RecommendationCandidate, type ReplayRequest } from "./api";
import { IndicatorValue, OriginBadge, readable, RequestError, SourceLink, usePlanningRequest, Vulnerabilities } from "./shared";
import "./planning.css";
export interface RecommendationsProps {
  location: PlanningLocation;
  field?: PlanningField;
  goals?: Goals;
  candidates?: RecommendRequest["candidates"];
  onEditPlan: (candidate: RecommendationCandidate) => void;
  onUsePlan: (candidate: RecommendationCandidate) => void;
  onPlanManually?: () => void;
  onReplay?: (request: ReplayRequest) => void;
}
export function Recommendations({
  location,
  field,
  goals,
  candidates,
  onEditPlan,
  onUsePlan,
  onPlanManually,
  onReplay
}: RecommendationsProps) {
  const request = {
    location,
    field,
    goals,
    candidates
  };
  const {
    data,
    error,
    loading,
    retry
  } = usePlanningRequest(JSON.stringify(request), signal => recommendPlans(request, signal));
  const [manual, setManual] = useState(false);
  if (loading) return <div className="pl pl-card" role="status">Comparing plans against this location’s recorded weather…</div>;
  if (error) return <div className="pl"><RequestError message={error} onRetry={retry} /></div>;
  if (!data) return null;
  const insufficient = data.status === "insufficient_data";
  const used = data.method?.indicators_used ?? [];
  const labelOf = (id: string) => [...data.shortlist, ...data.dominated, ...data.not_comparable].find(c => c.candidate_id === id)?.label || id;
  return <div className="pl pl-recommendations">
    <header className="pl-section-heading"><div><h2>{insufficient ? "More evidence is needed" : "Plans to consider"}</h2><p className="pl-muted">{data.method?.note ?? "Indicators from historical weather and regional guidance."}</p></div><span className="pl-status">{readable(data.status)}</span></header>
    {(data.gaps.length > 0 || data.reason_text) && <section className="pl-card" aria-label="Evidence gaps"><h3>Evidence gaps</h3>{data.reason_text && <p>{data.reason_text}</p>}<ul>{data.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul></section>}
    {(insufficient || data.status === "unsupported" || data.status === "unavailable" || data.shortlist.length === 0) && <section className="pl-card"><p>{insufficient ? "There is not enough comparable evidence to recommend a plan for these goals." : "No shortlist is available for this request."}</p><button className="pl-button pl-primary" onClick={() => onPlanManually ? onPlanManually() : setManual(true)}>Plan manually</button>{manual && <p role="status">Enter a grower plan in your field editor, with your local adviser’s guidance. No dates have been filled in automatically.</p>}</section>}
    {data.shortlist.length > 0 && <>
      <div className="pl-shortlist">{data.shortlist.map((candidate, i) => <article className="pl-card pl-plan-card" key={candidate.candidate_id} aria-labelledby={`pl-candidate-${candidate.candidate_id}`}>
        <div className="pl-card-top"><span className="pl-muted">Option {i + 1}</span><OriginBadge origin={candidate.origin} /></div>
        <h3 id={`pl-candidate-${candidate.candidate_id}`}>{candidate.label || candidate.candidate_id}</h3>
        <ol className="pl-rotation" aria-label="Crop sequence">{candidate.plans.map((p, index) => <li key={`${p.plan_id}-${index}`}><span>Season {index + 1}</span><strong>{readable(p.previous_crop_id)} → {p.winter.kind === "none" ? "no winter crop" : readable(p.winter.crop_id ?? "unknown")} → {readable(p.next_crop_id)}</strong></li>)}</ol>
        <h4>Why consider it</h4>{candidate.why.length ? <ul className="pl-evidence-list">{candidate.why.map((why, index) => <li key={index}>{why.text}<SourceLink source={why.source} /></li>)}</ul> : <p className="pl-muted">No explanation returned.</p>}
        <details><summary>Trade-offs ({candidate.trade_offs.length})</summary>{candidate.trade_offs.map((trade, index) => <p key={index}>{trade.text}</p>)}{candidate.trade_offs.length === 0 && <p>No trade-offs returned.</p>}</details>
        <details><summary>Uncertainties ({candidate.uncertainties.length})</summary>{candidate.uncertainties.map((item, index) => <div className="pl-evidence" key={index}><p>{item.text}</p><OriginBadge origin={item.origin} /><SourceLink source={item.source} /></div>)}{candidate.uncertainties.length === 0 && <p>No uncertainty details returned.</p>}</details>
        <details><summary>Historical vulnerabilities ({candidate.historical_vulnerabilities.length})</summary><Vulnerabilities items={candidate.historical_vulnerabilities} onReplay={onReplay} /></details>
        <div className="pl-actions"><button className="pl-button" onClick={() => onEditPlan(candidate)}>Edit this plan</button><button className="pl-button pl-primary" onClick={() => onUsePlan(candidate)}>Use this plan</button></div>
      </article>)}</div>
      <section className="pl-card"><h3>Compare the indicators used</h3><p className="pl-muted">Highlight = first rank for that indicator in this shortlist, including ties. Open a cell to see its season values.</p><div className="pl-table-scroll"><table className="pl-tradeoff"><caption>Historical and planning indicators</caption><thead><tr><th scope="col">Indicator</th>{data.shortlist.map(c => <th scope="col" key={c.candidate_id}>{c.label || c.candidate_id}</th>)}</tr></thead><tbody>{used.map(name => <tr key={name}><th scope="row">{readable(name)}<small>{data.shortlist.find(c => c.indicators[name])?.indicators[name]?.direction === "higher_better" ? "Higher preferred" : "Lower preferred"}</small><details><summary>Definition and source</summary><p>{data.shortlist.find(c => c.indicators[name])?.indicators[name]?.definition ?? "No definition returned."}</p><SourceLink source={data.shortlist.find(c => c.indicators[name])?.indicators[name]?.source} /></details></th>{data.shortlist.map(c => {
                  const indicator = c.indicators[name];
                  const best = indicator?.status === "complete" && indicator.value !== null && c.rank_positions[name] === 1;
                  return <td key={c.candidate_id} data-best={best || undefined} className={best ? "pl-best" : undefined}><IndicatorValue indicator={indicator} />{best && <span className="pl-best-label">First rank</span>}<OriginBadge origin={indicator?.origin} /><details><summary>Season values</summary>{indicator?.per_leg?.length ? <ol>{indicator.per_leg.map((leg, i) => <li key={i}>Season {i + 1}: {typeof leg === "object" && leg !== null ? `${leg.value ?? "Not available"} (${leg.dry_seasons ?? "unknown"} dry / ${leg.eligible_seasons ?? "unknown"} eligible)` : leg ?? "Not available"}</li>)}</ol> : <p>Not available</p>}</details></td>;
                })}</tr>)}</tbody></table></div></section>
    </>}
    <details className="pl-card"><summary>Dominated plans ({data.dominated.length})</summary><p className="pl-muted">Another comparable plan performs at least as well on every used indicator, and better on at least one.</p>{data.dominated.map(c => <div className="pl-folded-plan" key={c.candidate_id}><strong>{c.label || c.candidate_id}</strong><OriginBadge origin={c.origin} /><p>Dominated by: {c.dominated_by.map(labelOf).join("; ") || "Not available"}</p><button className="pl-text-button" onClick={() => onEditPlan(c)}>Edit this plan</button></div>)}</details>
    <details className="pl-card"><summary>Not comparable ({data.not_comparable.length})</summary>{data.not_comparable.map(c => <div className="pl-folded-plan" key={c.candidate_id}><strong>{c.label || c.candidate_id}</strong><OriginBadge origin={c.origin} /><p>Missing indicators: {c.missing.map(readable).join(", ") || "Not available"}</p><button className="pl-text-button" onClick={() => onEditPlan(c)}>Edit this plan</button></div>)}</details>
    {data.generation_log.length > 0 && <details className="pl-card"><summary>Generation decisions ({data.generation_log.length})</summary><ul>{data.generation_log.map((entry, i) => <li key={i}>{entry.reason_text || entry.constraint || entry.rule || entry.kind || "No explanation returned"}</li>)}</ul></details>}
  </div>;
}
