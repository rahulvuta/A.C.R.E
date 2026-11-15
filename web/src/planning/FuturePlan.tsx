import { useEffect, useId, useRef, useState } from "react";
import { dateFields, fetchFuturePlan, type FutureEdit, type FutureRequest, type FutureResponse, type FutureSeason, type GeneratedCandidate, type Goals, type Plan, type ReplayRequest } from "./api";
import { formatValue, IndicatorValue, OriginBadge, readable, RequestError, SourceLink, usePlanningRequest, Vulnerabilities } from "./shared";
import "./planning.css";
type Point = {
  latitude: number;
  longitude: number;
};
export interface FuturePlanProps {
  location: Point;
  candidate?: GeneratedCandidate;
  plan?: Plan;
  plans?: Plan[];
  startSeason?: string;
  seasons?: number;
  priorities?: Goals["priorities"];
  onChange?: (result: FutureResponse) => void;
  onReplay?: (request: ReplayRequest) => void;
}
export function FuturePlan({
  location,
  candidate,
  plan,
  plans,
  startSeason = String(new Date().getFullYear() + 1),
  seasons = candidate?.seasons.length ?? plans?.length ?? 1,
  priorities,
  onChange,
  onReplay
}: FuturePlanProps) {
  const request: FutureRequest = {
    location,
    candidate,
    plan,
    plans,
    start_season: startSeason,
    seasons,
    priorities
  };
  return <FuturePlanSession key={JSON.stringify(request)} request={request} onChange={onChange} onReplay={onReplay} />;
}
function DateEditor({
  date,
  field,
  season,
  label,
  disabled,
  onSave
}: {
  date: string;
  field: string;
  season: number;
  label: string;
  disabled: boolean;
  onSave: (edit: FutureEdit) => void;
}) {
  const [draft, setDraft] = useState(date);
  return <form className="pl-date-editor pl-no-print" onSubmit={e => {
    e.preventDefault();
    if (draft && draft !== date) onSave({
      field,
      season,
      value: draft.slice(5)
    });
  }}><label><span className="pl-sr-only">Edit {label}, season {season}</span><input aria-label={`Edit ${label}, season ${season}`} type="date" min={`${date.slice(0, 4)}-01-01`} max={`${date.slice(0, 4)}-12-31`} value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} required /></label><button className="pl-button" type="submit" disabled={disabled || !draft || draft === date}>Update date</button></form>;
}
function SeasonTimeline({
  season,
  index,
  disabled,
  onEdit,
  onReplay
}: {
  season: FutureSeason;
  index: number;
  disabled: boolean;
  onEdit: (edit: FutureEdit) => void;
  onReplay?: (request: ReplayRequest) => void;
}) {
  const headingId = useId();
  return <article className="pl-card pl-season" aria-labelledby={headingId}>
    <header className="pl-season-heading"><div><span className="pl-muted">Season {index + 1}</span><h3 id={headingId}>{season.season}</h3></div>{season.status && <span className="pl-status">{readable(season.status)}</span>}</header>
    {season.plan && <p className="pl-season-crops">{readable(season.plan.previous_crop_id)} → {readable(season.plan.next_crop_id)}</p>}
    <h4>Planned windows</h4><ol className="pl-timeline">{season.windows.map((window, i) => <li key={`${window.kind}-${i}`} className={`pl-window pl-date-${window.origin}`} data-origin={window.origin}><div className="pl-window-heading"><strong>{window.label ?? readable(window.kind)}</strong><OriginBadge origin={window.origin} /></div><p className="pl-date-value"><time dateTime={window.start ?? undefined}>{window.start ?? "Not available"}</time>{window.end && window.end !== window.start && <> → <time dateTime={window.end}>{window.end}</time></>}</p><SourceLink source={window.source} />{window.field && window.start && (dateFields as readonly string[]).includes(window.field) && <DateEditor key={window.start} label={window.label ?? readable(window.kind)} date={window.start} field={window.field} season={index + 1} disabled={disabled} onSave={onEdit} />}</li>)}</ol>
    {!season.windows.length && <p className="pl-muted">No date windows available.</p>}
    <section className="pl-cover-schedule"><h4>Living cover schedule</h4>{season.cover_schedule ? <><p><strong>{readable(season.cover_schedule.crop_id)}</strong></p><div className="pl-cover-dates"><span className={`pl-date-${season.cover_schedule.origin.seed}`}><time dateTime={season.cover_schedule.seed}>{season.cover_schedule.seed}</time><OriginBadge origin={season.cover_schedule.origin.seed} /></span><span>→</span><span className={`pl-date-${season.cover_schedule.origin.terminate}`}><time dateTime={season.cover_schedule.terminate}>{season.cover_schedule.terminate}</time><OriginBadge origin={season.cover_schedule.origin.terminate} /></span></div>{season.cover_schedule.living_cover_days != null && <p>{season.cover_schedule.living_cover_days} planned days</p>}<p className="pl-muted">Establishment: {season.cover_schedule.establishment ?? "unknown"}</p></> : <p className="pl-muted">No living cover schedule returned.</p>}</section>
    <details open><summary>Milestones ({season.milestones.length})</summary><ul className="pl-milestones">{season.milestones.map((m, i) => <li key={i}><span className={`pl-date-${m.origin}`}><time dateTime={m.date}>{m.date}</time>{m.end_date && m.end_date !== m.date && <> → <time dateTime={m.end_date}>{m.end_date}</time></>}<OriginBadge origin={m.origin} /></span><p>{m.label}</p>{m.rule_origin && <small>Rule origin: <OriginBadge origin={m.rule_origin} /></small>}</li>)}</ul></details>
    <section className="pl-deadlines"><h4>Decision deadlines</h4>{season.decision_deadlines.length ? season.decision_deadlines.map((d, i) => <div className="pl-decision" key={i}><time className={`pl-date-${d.origin ?? "unknown"}`} dateTime={d.date}>{d.date}</time><OriginBadge origin={d.origin} /><p><strong>{d.decision}</strong></p>{d.switch_condition && <p>{d.switch_condition}</p>}{d.next_check_date && <p>Next check: <time dateTime={d.next_check_date}>{d.next_check_date}</time><OriginBadge origin={d.origin} /></p>}{d.assumptions?.map((a, n) => <p className="pl-muted" key={n}>{a}</p>)}</div>) : <p className="pl-muted">No decision deadline returned.</p>}</section>
    <details open><summary>Backup plan</summary>{season.backup ? <><p>Status: {readable(season.backup.status ?? "unknown")}</p>{season.backup.fallback_plan_id && <p>Fallback: {season.backup.fallback_plan_id}</p>}{season.backup.switch_condition && <p>{season.backup.switch_condition.text}</p>}{season.backup.assumptions?.map((a, i) => <p className="pl-muted" key={i}>{a}</p>)}{season.backup.notes?.map((n, i) => <p key={i}>{n}</p>)}</> : <p className="pl-muted">No backup plan available.</p>}</details>
    {season.warnings.length > 0 && <section className="pl-warning"><h4>Checks to resolve</h4><ul>{season.warnings.map((w, i) => <li key={i}>{typeof w === "string" ? w : <>{w.text}<OriginBadge origin={w.origin} /></>}</li>)}</ul></section>}
    {season.explanations.length > 0 && <details><summary>Guidance and sources</summary>{season.explanations.map((item, i) => <div key={i} className="pl-evidence"><p>{item.text}</p><OriginBadge origin={item.origin} /><SourceLink source={item.source} /></div>)}</details>}
    <details><summary>Historical vulnerabilities ({season.historical_vulnerabilities.length})</summary><Vulnerabilities items={season.historical_vulnerabilities} onReplay={onReplay} /></details>
    {season.notes.map((n, i) => <p className="pl-muted" key={i}>{n}</p>)}
  </article>;
}
function ReturnedDiff({
  result
}: {
  result: FutureResponse;
}) {
  if (!result.diff) return null;
  return <section className="pl-card pl-diff" aria-label="Returned plan changes" aria-live="polite"><h3>Changes from the original plan</h3>{!result.diff.changes.length && <p>No calendar changes returned.</p>}{result.diff.changes.map((change, i) => <div key={i}><h4>Season {change.season ?? i + 1}</h4><ul>{change.plan_edits?.map((e, j) => <li key={`edit-${j}`}>{readable(e.field)}: {formatValue(e.before)} → {formatValue(e.after)}</li>)}{change.changes?.map((c, j) => <li key={`action-${j}`}>{c.label_after ?? c.label ?? c.action_id ?? "Action"}: {c.date_before ?? c.date ?? "Not available"} → {c.date_after ?? c.change ?? "Not available"}{c.why?.map((why, k) => <p className="pl-muted" key={k}>{why}</p>)}</li>)}{change.window_changes?.map((w, j) => <li key={`window-${j}`}>{readable(w.kind)}: {w.before?.join(" → ") ?? "Not available"} → {w.after?.join(" → ") ?? "Not available"}</li>)}</ul>{change.decision_deadline && <p>Decision deadline: {change.decision_deadline.before ?? "Not available"} → {change.decision_deadline.after ?? "Not available"}<br />Next check: {change.decision_deadline.next_check_before ?? "Not available"} → {change.decision_deadline.next_check_after ?? "Not available"}</p>}</div>)}</section>;
}
function FuturePlanSession({
  request,
  onChange,
  onReplay
}: {
  request: FutureRequest;
  onChange?: (result: FutureResponse) => void;
  onReplay?: (request: ReplayRequest) => void;
}) {
  const [edits, setEdits] = useState<FutureEdit[]>([]);
  const [previous, setPrevious] = useState<FutureResponse>();
  const [resetVersion, setResetVersion] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const changeCallback = useRef(onChange);
  changeCallback.current = onChange;
  const body = {
    ...request,
    edits
  };
  const {
    data,
    error,
    loading,
    retry
  } = usePlanningRequest(JSON.stringify(body), signal => fetchFuturePlan(body, signal));
  useEffect(() => {
    if (data) {
      setPrevious(data);
      changeCallback.current?.(data);
    }
  }, [data]);
  useEffect(() => {
    let closed: HTMLDetailsElement[] = [];
    const before = () => {
      closed = Array.from(root.current?.querySelectorAll<HTMLDetailsElement>("details:not([open])") ?? []);
      closed.forEach(detail => {
        detail.open = true;
      });
    };
    const after = () => {
      closed.forEach(detail => {
        detail.open = false;
      });
      closed = [];
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  const result = data ?? previous;
  const onEdit = (edit: FutureEdit) => setEdits(current => [...current.filter(e => e.season !== edit.season || e.field !== edit.field), edit]);
  return <div className="pl pl-future" aria-busy={loading} ref={root}>
    <header className="pl-section-heading"><div><h2>Future field plan</h2><p className="pl-muted">{result?.note ?? "Planned dates. They cannot say what the weather in these seasons will bring."}</p></div><button className="pl-button pl-no-print" disabled={!result || loading || !!error} onClick={() => window.print()}>Print plan</button></header>
    <div className="pl-origin-legend" aria-label="Date origin legend">{(["verified_source", "dataset_estimate", "grower", "assumed"] as const).map(o => <OriginBadge key={o} origin={o} />)}</div>
    {loading && <p role="status">{previous ? "Updating dates and historical analysis…" : "Building the multi-season calendar…"}</p>}
    {error && <RequestError message={error} onRetry={retry} />}
    {edits.length > 0 && <button className="pl-text-button pl-no-print" disabled={loading} onClick={() => {
      setEdits([]);
      setResetVersion(v => v + 1);
    }}>Restore original dates</button>}
    {result && <>
      {result.status !== "complete" && <p className="pl-status">{readable(result.status)}{result.reason_text ? `: ${result.reason_text}` : ""}</p>}
      {result.gaps.length > 0 && <section className="pl-card"><h3>Evidence gaps</h3><ul>{result.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></section>}
      <ReturnedDiff result={result} />
      {result.recommendation_refresh && <section className="pl-card" aria-label="Updated historical analysis"><h3>Updated historical analysis</h3><p>Status: {readable(result.recommendation_refresh.status)}{result.recommendation_refresh.reason_text ? ` · ${result.recommendation_refresh.reason_text}` : ""}</p>{result.recommendation_refresh.indicators && <dl className="pl-refresh-indicators">{(result.recommendation_refresh.method?.indicators_used ?? Object.keys(result.recommendation_refresh.indicators)).map(id => <div key={id}><dt>{readable(id)}</dt><dd><IndicatorValue indicator={result.recommendation_refresh!.indicators![id]} /><OriginBadge origin={result.recommendation_refresh!.indicators![id]?.origin} /></dd></div>)}</dl>}</section>}
      <div className="pl-seasons">{result.seasons.map((season, i) => <SeasonTimeline season={season} index={i} key={`${season.season}-${i}-${resetVersion}`} disabled={loading} onEdit={onEdit} onReplay={onReplay} />)}</div>
      {!result.seasons.length && <p className="pl-card">No season calendar returned. Review the evidence gaps or plan manually.</p>}
    </>}
  </div>;
}
